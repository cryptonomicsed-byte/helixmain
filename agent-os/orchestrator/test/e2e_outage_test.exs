defmodule Helix.E2EOutageTest do
  @moduledoc """
  What the real stack does when a part of it dies, in its own stack so the other
  end-to-end tests keep theirs. `mix test --include e2e`.
  """
  use ExUnit.Case, async: false
  alias Helix.Orchestrator
  alias Helix.Test.Stack

  @moduletag :e2e
  @moduletag :capture_log
  @moduletag timeout: 300_000

  setup_all do
    dir = Path.join(System.tmp_dir!(), "helix-orch-e2e-outage-#{System.unique_integer([:positive])}")
    stack = Stack.start(dir)

    on_exit(fn ->
      Stack.stop(stack)
      File.rm_rf(dir)
    end)

    {:ok, stack: stack}
  end

  test "when the policy service dies the run is denied, not allowed", %{stack: stack} do
    name = :"outage_#{System.unique_integer([:positive])}"

    {:ok, sup} =
      Orchestrator.start_link(
        name: name,
        dir: Path.join(stack.dir, "runs"),
        gateway: Stack.client(stack, "orch"),
        recover: false,
        poll_ms: 100
      )

    on_exit(fn ->
      try do
        Supervisor.stop(sup)
      catch
        :exit, _ -> :ok
      end
    end)

    orch = name

    intent = %{
      "capability" => "kb.search",
      "agent_id" => Stack.agent_sid(),
      "tool" => "kb.search",
      "target" => "kb:main",
      "operation" => "kb.search",
      "risk" => "low",
      "audience" => Stack.executor_principal(),
      "task_id" => "t"
    }

    wf = %{"id" => "w", "steps" => [%{"id" => "auth", "kind" => "authorize", "intent" => intent}]}
    Stack.kill(stack, :policy)
    :timer.sleep(300)
    {:ok, _} = Orchestrator.start_run(orch, "no-policy", wf, %{})
    assert {:ok, %{status: "failed", error: %{"detail" => d}}} = Orchestrator.await(orch, "no-policy", 30_000)
    assert d =~ "authorization_denied" and d =~ "policy_unavailable"
  end
end
