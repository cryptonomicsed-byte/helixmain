defmodule Helix.E2ETest do
  @moduledoc """
  The orchestrator against the REAL stack: the Go gateway, the Rust kernel with
  its Wasm plugin host, and the Clojure policy service, each a separate OS
  process. Run with `mix test --include e2e` (needs cargo, go and a JVM).
  """
  use ExUnit.Case, async: false
  alias Helix.{Gateway, Orchestrator}
  alias Helix.Test.Stack

  @moduletag :e2e
  @moduletag :capture_log
  @moduletag timeout: 300_000

  setup_all do
    dir = Path.join(System.tmp_dir!(), "helix-orch-e2e-#{System.unique_integer([:positive])}")
    stack = Stack.start(dir)

    on_exit(fn ->
      Stack.stop(stack)
      File.rm_rf(dir)
    end)

    {:ok, stack: stack}
  end

  setup %{stack: stack} = ctx do
    name = :"e2e_#{System.unique_integer([:positive])}"
    runs = Path.join(stack.dir, "runs-#{name}")
    provider_calls = :counters.new(1, [])

    provider = fn intent, _execution_id ->
      :counters.add(provider_calls, 1, 1)
      {:ok, %{"order" => "o_#{intent["amount_minor"]}", "paid" => intent["amount_minor"], "currency" => intent["currency"]}}
    end

    {:ok, sup} =
      Orchestrator.start_link(
        name: name,
        dir: runs,
        gateway: Stack.client(stack, "orch"),
        executors: %{"merchant" => %{gateway: Stack.client(stack, "exec"), provider: provider}},
        poll_ms: 100,
        recover: false
      )

    on_exit(fn ->
      try do
        Supervisor.stop(sup)
      catch
        :exit, _ -> :ok
      end
    end)

    {:ok, Map.merge(ctx, %{orch: name, provider_calls: provider_calls, runs: runs})}
  end

  defp workflow do
    %{
      "id" => "buy-coffee",
      "steps" => [
        %{
          "id" => "co",
          "kind" => "invoke_plugin",
          "plugin" => "acme.pricing",
          "tool" => "checkout",
          "agent" => Stack.agent_sid(),
          "input" => %{"currency" => "USD", "items" => %{"$ref" => "inputs.items"}}
        },
        %{
          "id" => "auth",
          "kind" => "authorize",
          "intent_from" => "co.proposed_intents.0",
          "intent_with" => %{"audience" => Stack.executor_principal(), "task_id" => "task-1"}
        },
        %{"id" => "buy", "kind" => "execute", "from" => "auth", "executor" => "merchant"}
      ]
    }
  end

  @items [%{"sku" => "latte", "qty" => 3, "unit_price_minor" => 450}]

  defp wait_for(fun, tries \\ 300) do
    cond do
      r = fun.() -> r
      tries == 0 -> flunk("condition never held")
      true -> :timer.sleep(100) && wait_for(fun, tries - 1)
    end
  end

  defp awaiting(orch, id) do
    wait_for(fn ->
      case Orchestrator.status(orch, id) do
        {:ok, %{status: "awaiting", awaiting: a}} -> a
        _ -> false
      end
    end)
  end

  test "a purchase: a plugin prices it, the kernel and policy hold it for the owner, the owner approves, the executor buys once", %{
    stack: stack,
    orch: orch,
    provider_calls: calls
  } do
    {:ok, _} = Orchestrator.start_run(orch, "coffee-1", workflow(), %{"items" => @items})

    a = awaiting(orch, "coffee-1")
    assert a.kind == "require_user_confirmation"
    assert a.intent["amount_minor"] == 1350 and a.intent["agent_id"] == Stack.agent_sid(), "the kernel pinned the agent"
    assert :counters.get(calls, 1) == 0, "nothing is bought while a person has not answered"

    # who may answer is decided by the gateway: another user in the tenant cannot even see it
    assert {:error, {:http, 404, _, _}} = Gateway.get_action(Stack.client(stack, "bob"), a.pending_id)
    assert {:error, {:http, 404, _, _}} = Gateway.confirm(Stack.client(stack, "bob"), a.pending_id, true)

    assert {:ok, 200, %{"state" => "pending", "kind" => "user_confirmation"}} =
             Gateway.get_action(Stack.client(stack, "alice"), a.pending_id)

    assert {:ok, 200, %{"decision" => "allow"}} = Gateway.confirm(Stack.client(stack, "alice"), a.pending_id, true)
    assert {:ok, %{status: "completed", vars: vars}} = Orchestrator.await(orch, "coffee-1", 60_000)

    assert vars["buy"]["state"] == "succeeded"
    assert vars["buy"]["result"] == %{"order" => "o_1350", "paid" => 1350, "currency" => "USD"}
    assert is_binary(vars["buy"]["receipt_hash"]) and byte_size(vars["buy"]["receipt_hash"]) > 10
    assert vars["auth"]["grant"]["subject"] == Stack.agent_sid()
    assert :counters.get(calls, 1) == 1, "the provider ran exactly once"
  end

  test "the run survives a crash while the person decides, and does not ask them twice", %{stack: stack, orch: orch, provider_calls: calls} do
    {:ok, pid} = Orchestrator.start_run(orch, "coffee-crash", workflow(), %{"items" => @items})
    a = awaiting(orch, "coffee-crash")

    Process.exit(pid, :kill)
    a2 = awaiting(orch, "coffee-crash")
    assert a2.pending_id == a.pending_id, "the restarted run waits for the SAME request"
    assert "coffee-crash" in Orchestrator.unfinished(orch)

    assert {:ok, 200, %{"decision" => "allow"}} = Gateway.confirm(Stack.client(stack, "alice"), a.pending_id, true)
    assert {:ok, %{status: "completed"}} = Orchestrator.await(orch, "coffee-crash", 60_000)
    assert :counters.get(calls, 1) == 1
  end

  test "a person declining ends the run and nothing is bought", %{stack: stack, orch: orch, provider_calls: calls} do
    {:ok, _} = Orchestrator.start_run(orch, "coffee-no", workflow(), %{"items" => @items})
    a = awaiting(orch, "coffee-no")
    assert {:ok, 200, %{"decision" => "deny"}} = Gateway.confirm(Stack.client(stack, "alice"), a.pending_id, false)
    assert {:ok, %{status: "failed", error: %{"detail" => d}}} = Orchestrator.await(orch, "coffee-no", 60_000)
    assert d =~ "person_said_no"
    assert :counters.get(calls, 1) == 0
  end

  test "a plugin's tool the agent never declared is refused by the kernel, and the run fails without a retry", %{orch: orch} do
    wf = %{
      "id" => "w",
      "steps" => [
        %{
          "id" => "q",
          "kind" => "invoke_plugin",
          "plugin" => "acme.pricing",
          "tool" => "quote",
          "agent" => Stack.agent_sid(),
          "input" => %{"currency" => "USD", "items" => @items}
        }
      ]
    }

    {:ok, _} = Orchestrator.start_run(orch, "undeclared", wf, %{})

    assert {:ok, %{status: "failed", error: %{"kind" => "http", "status" => 403, "message" => m}}} =
             Orchestrator.await(orch, "undeclared", 30_000)

    assert m =~ "does not declare capability"
  end

  test "an intent for a capability the agent never declared is denied by the kernel", %{orch: orch, provider_calls: calls} do
    intent = %{
      "capability" => "payments.wire",
      "agent_id" => Stack.agent_sid(),
      "tool" => "bank.wire",
      "target" => "bank:x",
      "operation" => "wire",
      "risk" => "high",
      "audience" => Stack.executor_principal(),
      "task_id" => "t"
    }

    wf = %{"id" => "w", "steps" => [%{"id" => "auth", "kind" => "authorize", "intent" => intent}]}
    {:ok, _} = Orchestrator.start_run(orch, "wire", wf, %{})
    assert {:ok, %{status: "failed", error: %{"detail" => d}}} = Orchestrator.await(orch, "wire", 30_000)
    assert d =~ "authorization_denied" and d =~ "does not declare capability"
    assert :counters.get(calls, 1) == 0
  end

  test "routine work needs no person: the policy allows it and the run completes by itself", %{orch: orch} do
    intent = %{
      "capability" => "kb.search",
      "agent_id" => Stack.agent_sid(),
      "tool" => "kb.search",
      "target" => "kb:main",
      "operation" => "kb.search",
      "risk" => "low",
      "audience" => Stack.executor_principal(),
      "task_id" => "t",
      "arguments" => %{"q" => "opening hours"}
    }

    wf = %{
      "id" => "w",
      "steps" => [
        %{"id" => "auth", "kind" => "authorize", "intent" => intent},
        %{"id" => "look", "kind" => "execute", "from" => "auth", "executor" => "merchant"}
      ]
    }

    {:ok, _} = Orchestrator.start_run(orch, "routine", wf, %{})
    assert {:ok, %{status: "completed", vars: %{"auth" => %{"decision" => "allow"}}}} = Orchestrator.await(orch, "routine", 30_000)
  end
end
