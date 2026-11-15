defmodule Helix.RunTest do
  use ExUnit.Case, async: true
  alias Helix.{EventLog, Orchestrator, Run}
  alias Helix.Test.FakeKernel, as: K

  @moduletag :tmp_dir

  # ── fixtures ────────────────────────────────────────────────────────────────
  defp boot(ctx, kernel, opts \\ []) do
    name = :"orch_#{System.unique_integer([:positive])}"
    exec_gw = K.client(kernel, "hxg_executor")
    provider = Keyword.get(opts, :provider, fn _intent, _id -> {:ok, %{"order" => "o_1"}} end)

    base = [
      name: name,
      dir: ctx.tmp_dir,
      gateway: K.client(kernel, "hxg_orchestrator"),
      executors: %{"merchant" => %{gateway: exec_gw, provider: provider}},
      poll_ms: 20,
      backoff_ms: 5,
      lease_ttl_ms: Keyword.get(opts, :lease_ttl_ms, 5_000),
      max_attempts: 4,
      recover: false
    ]

    {:ok, sup} = Orchestrator.start_link(Keyword.merge(base, Keyword.drop(opts, [:provider, :lease_ttl_ms])))

    on_exit(fn ->
      try do
        Supervisor.stop(sup)
      catch
        :exit, _ -> :ok
      end
    end)

    name
  end

  defp kernel(opts \\ []) do
    k = K.start(opts)
    on_exit(fn -> Helix.Test.FakeGateway.stop(k.gw) end)
    k
  end

  defp inv(id, input \\ %{}),
    do: %{"id" => id, "kind" => "invoke_plugin", "plugin" => "acme.pricing", "tool" => "checkout", "input" => input}

  defp purchase do
    %{
      "id" => "buy-coffee",
      "steps" => [
        inv("co", %{"basket" => %{"$ref" => "inputs.basket"}}),
        %{
          "id" => "auth",
          "kind" => "authorize",
          "intent_from" => "co.proposed_intents.0",
          "intent_with" => %{"audience" => "svc:merchant", "task_id" => "t1"}
        },
        %{"id" => "buy", "kind" => "execute", "from" => "auth", "executor" => "merchant"}
      ]
    }
  end

  defp proposal(extra \\ %{}),
    do:
      Map.merge(
        %{"capability" => "merchant.order", "tool" => "merchant.checkout", "amount_minor" => 1350, "currency" => "USD", "risk" => "medium"},
        extra
      )

  defp with_pricing(k),
    do:
      K.plugin_response(k, "acme.pricing/checkout", %{
        "status" => "ok",
        "result" => %{"total_minor" => 1350},
        "proposed_intents" => [proposal()]
      })

  defp events(ctx, id) do
    {:ok, evs, _} = EventLog.read(Path.join(ctx.tmp_dir, id <> ".log"))
    Enum.map(evs, &{&1["type"], &1["data"]["id"]})
  end

  defp wait_until(fun, tries \\ 200) do
    cond do
      fun.() -> :ok
      tries == 0 -> flunk("condition never held")
      true -> :timer.sleep(10) && wait_until(fun, tries - 1)
    end
  end

  # ── the happy path ──────────────────────────────────────────────────────────
  test "an allowed purchase runs to the end, once", ctx do
    k = kernel()
    with_pricing(k)
    orch = boot(ctx, k)

    {:ok, _} = Orchestrator.start_run(orch, "r1", purchase(), %{"basket" => [%{"sku" => "latte"}]})
    assert {:ok, %{status: "completed", done: ["co", "auth", "buy"], vars: vars}} = Orchestrator.await(orch, "r1")

    assert vars["buy"]["result"] == %{"order" => "o_1"}
    assert vars["auth"]["decision"] == "allow"
    assert vars["auth"]["intent"]["audience"] == "svc:merchant"
    assert vars["auth"]["intent"]["id"] == "wf_r1_auth", "ids are derived from the run and the step, not from the plugin's suggestion"
    assert vars["auth"]["intent"]["idempotency_key"] == "wfk_r1_auth"
    # the orchestrator and the executor spoke as themselves
    tokens = k |> K.calls() |> Enum.map(&{&1.route, &1.token})
    assert {"authorize", "Bearer hxg_orchestrator"} in tokens
    assert {"begin", "Bearer hxg_executor"} in tokens
    assert {"record", "Bearer hxg_executor"} in tokens
    # the plugin saw the resolved input
    assert %{body: %{"input" => %{"basket" => [%{"sku" => "latte"}]}}} =
             Enum.find(K.calls(k), &(&1.route == "invoke:acme.pricing/checkout"))

    types = events(ctx, "r1") |> Enum.map(&elem(&1, 0))
    assert hd(types) == "run_started" and List.last(types) == "run_completed"
    assert Enum.count(types, &(&1 == "step_completed")) == 3
  end

  test "the idempotency key comes from the run and the step, not from what a plugin suggested", ctx do
    k = kernel()
    # every proposal the plugin makes carries the SAME suggested key: two runs must still not share one
    K.plugin_response(k, "acme.pricing/checkout", %{
      "status" => "ok",
      "result" => %{},
      "proposed_intents" => [proposal(%{"id" => "plint_same", "idempotency_key" => "plkey_same"})]
    })

    orch = boot(ctx, k)
    {:ok, _} = Orchestrator.start_run(orch, "keyrun-a", purchase(), %{"basket" => []})
    {:ok, _} = Orchestrator.start_run(orch, "keyrun-b", purchase(), %{"basket" => []})
    {:ok, a} = Orchestrator.await(orch, "keyrun-a")
    {:ok, b} = Orchestrator.await(orch, "keyrun-b")
    assert a.vars["auth"]["intent"]["idempotency_key"] == "wfk_keyrun-a_auth"
    assert b.vars["auth"]["intent"]["idempotency_key"] == "wfk_keyrun-b_auth"
    assert a.vars["auth"]["intent"]["id"] != b.vars["auth"]["intent"]["id"]

    # an intent the author wrote out in full keeps the id and key they chose
    wf = %{
      "id" => "w",
      "steps" => [
        %{
          "id" => "auth",
          "kind" => "authorize",
          "intent" => proposal(%{"id" => "my-id", "idempotency_key" => "my-key", "audience" => "a", "task_id" => "t"})
        }
      ]
    }

    {:ok, _} = Orchestrator.start_run(orch, "explicit", wf, %{})
    {:ok, c} = Orchestrator.await(orch, "explicit")
    assert c.vars["auth"]["intent"]["idempotency_key"] == "my-key"
  end

  test "an invalid workflow never starts, and a bad run id is refused", ctx do
    orch = boot(ctx, kernel())

    assert {:error, {:invalid_workflow, errs}} =
             Orchestrator.start_run(orch, "r", %{"id" => "w", "steps" => [%{"id" => "a", "kind" => "teleport"}]})

    assert Enum.any?(errs, &(&1 =~ "unknown kind"))
    refute File.exists?(Path.join(ctx.tmp_dir, "r.log")), "an invalid workflow leaves nothing behind"

    for bad <- ["", "../x", "a/b", "a b", String.duplicate("a", 65), "-x"],
        do: assert({:error, :bad_run_id} = Orchestrator.start_run(orch, bad, purchase()))
  end

  # ── waiting for a person ────────────────────────────────────────────────────
  test "money is held for a person: the run parks, then goes on when they approve", ctx do
    k = kernel(authorize: {:hold, "require_user_confirmation"})
    with_pricing(k)
    orch = boot(ctx, k)
    {:ok, _} = Orchestrator.start_run(orch, "r2", purchase(), %{"basket" => []})

    wait_until(fn -> match?({:ok, %{status: "awaiting"}}, Orchestrator.status(orch, "r2")) end)
    {:ok, st} = Orchestrator.status(orch, "r2")
    assert st.awaiting.pending_id == "pending-1" and st.awaiting.kind == "require_user_confirmation"
    assert st.done == ["co"]
    assert K.count(k, "begin") == 0, "nothing executes while a person has not answered"
    # it is polling, cheaply
    wait_until(fn -> K.count(k, "get_action") >= 3 end)

    K.approve(k, "pending-1")
    assert {:ok, %{status: "completed", vars: vars}} = Orchestrator.await(orch, "r2")
    assert vars["auth"]["grant"]["id"] == "grant_1", "the grant the person's approval produced is collected from the kernel"
    assert vars["buy"]["state"] == "succeeded"
    assert K.count(k, "authorize") == 1
  end

  test "a person saying no ends the run; nothing is executed", ctx do
    for state <- ["denied", "withdrawn", "expired"] do
      k = kernel(authorize: {:hold, "require_human_review"})
      with_pricing(k)
      orch = boot(ctx, k)
      id = "no-#{state}"
      {:ok, _} = Orchestrator.start_run(orch, id, purchase(), %{"basket" => []})
      wait_until(fn -> match?({:ok, %{status: "awaiting"}}, Orchestrator.status(orch, id)) end)
      K.decide(k, "pending-1", state)
      assert {:ok, %{status: "failed", error: %{"detail" => detail}}} = Orchestrator.await(orch, id)
      assert detail =~ state
      assert K.count(k, "begin") == 0
    end
  end

  test "on_deny continue lets the workflow carry on without a grant", ctx do
    k = kernel(authorize: {:deny, ["policy says no"]})
    with_pricing(k)
    orch = boot(ctx, k)

    wf = %{
      "id" => "soft",
      "steps" => [
        inv("co"),
        %{
          "id" => "auth",
          "kind" => "authorize",
          "intent_from" => "co.proposed_intents.0",
          "intent_with" => %{"audience" => "a", "task_id" => "t"},
          "on_deny" => "continue"
        },
        %{"id" => "report", "kind" => "set", "value" => %{"outcome" => %{"$ref" => "auth.decision"}, "why" => %{"$ref" => "auth.reasons"}}}
      ]
    }

    {:ok, _} = Orchestrator.start_run(orch, "soft1", wf)

    assert {:ok, %{status: "completed", vars: %{"report" => %{"value" => %{"outcome" => "deny", "why" => ["policy says no"]}}}}} =
             Orchestrator.await(orch, "soft1")
  end

  test "a denial fails the run by default, with the kernel's reasons", ctx do
    k = kernel(authorize: {:deny, ["money_requires_confirmation", "no"]})
    with_pricing(k)
    orch = boot(ctx, k)
    {:ok, _} = Orchestrator.start_run(orch, "deny1", purchase(), %{"basket" => []})
    assert {:ok, %{status: "failed", error: %{"detail" => d}}} = Orchestrator.await(orch, "deny1")
    assert d =~ "authorization_denied" and d =~ "money_requires_confirmation"
    assert K.count(k, "begin") == 0
  end

  test "an approval that never comes times out", ctx do
    k = kernel(authorize: {:hold, "require_user_confirmation"})
    with_pricing(k)
    orch = boot(ctx, k)
    wf = update_in(purchase(), ["steps"], fn [a, b, c] -> [a, Map.put(b, "timeout_ms", 100), c] end)
    {:ok, _} = Orchestrator.start_run(orch, "slow", wf, %{"basket" => []})
    assert {:ok, %{status: "failed", error: %{"detail" => d}}} = Orchestrator.await(orch, "slow")
    assert d =~ "approval_timeout"
  end

  # ── crashes and restarts ────────────────────────────────────────────────────
  test "a run that crashes while waiting is rebuilt from its log and does not ask again", ctx do
    k = kernel(authorize: {:hold, "require_user_confirmation"})
    with_pricing(k)
    orch = boot(ctx, k)
    {:ok, pid} = Orchestrator.start_run(orch, "crash1", purchase(), %{"basket" => []})
    wait_until(fn -> match?({:ok, %{status: "awaiting"}}, Orchestrator.status(orch, "crash1")) end)

    Process.exit(pid, :kill)
    # the supervisor restarts it; it replays the log and goes back to waiting for the SAME person's answer
    wait_until(fn -> match?([{p, _}] when p != pid, Registry.lookup(Orchestrator.config(orch).registry, {:run, "crash1"})) end)
    wait_until(fn -> match?({:ok, %{status: "awaiting", awaiting: %{pending_id: "pending-1"}}}, Orchestrator.status(orch, "crash1")) end)
    assert K.count(k, "authorize") == 1, "a restarted run must not re-authorize"
    assert K.count(k, "invoke:acme.pricing/checkout") == 1, "nor repeat a step it had completed"

    K.approve(k, "pending-1")
    assert {:ok, %{status: "completed"}} = Orchestrator.await(orch, "crash1")
    assert K.count(k, "begin") == 1
  end

  test "a whole node restart: a new orchestrator recovers the unfinished run from the log directory", ctx do
    k = kernel(authorize: {:hold, "require_user_confirmation"})
    with_pricing(k)
    orch1 = boot(ctx, k, lease_ttl_ms: 200)
    {:ok, _} = Orchestrator.start_run(orch1, "node1", purchase(), %{"basket" => []})
    wait_until(fn -> match?({:ok, %{status: "awaiting"}}, Orchestrator.status(orch1, "node1")) end)
    Supervisor.stop(Process.whereis(Module.concat(Helix.Orchestrator.Sup, orch1)))
    assert {:ok, %{status: "awaiting"}} = Run.status(Orchestrator.config(orch1), "node1"), "the log alone says where it stood"

    :timer.sleep(250)
    orch2 = boot(ctx, k, lease_ttl_ms: 5_000)
    assert Orchestrator.unfinished(orch2) == ["node1"]
    assert Orchestrator.recover(orch2) == ["node1"]
    K.approve(k, "pending-1")
    assert {:ok, %{status: "completed"}} = Orchestrator.await(orch2, "node1")
    assert K.count(k, "authorize") == 1
    {:ok, evs, _} = EventLog.read(Path.join(ctx.tmp_dir, "node1.log"))
    assert evs |> Enum.map(& &1["fence"]) |> Enum.uniq() == [1, 2], "the second driver wrote under a higher fence"
  end

  test "a finished run is not started again by recovery", ctx do
    k = kernel()
    with_pricing(k)
    orch = boot(ctx, k)
    {:ok, _} = Orchestrator.start_run(orch, "done1", purchase(), %{"basket" => []})
    {:ok, _} = Orchestrator.await(orch, "done1")
    assert Orchestrator.unfinished(orch) == []
    assert Orchestrator.recover(orch) == []
    assert K.count(k, "begin") == 1
  end

  # ── leases ──────────────────────────────────────────────────────────────────
  test "two orchestrators cannot drive the same run; the second is told so", ctx do
    k = kernel(authorize: {:hold, "require_user_confirmation"})
    with_pricing(k)
    a = boot(ctx, k)
    b = boot(ctx, k)
    {:ok, _} = Orchestrator.start_run(a, "lease1", purchase(), %{"basket" => []})
    wait_until(fn -> match?({:ok, %{status: "awaiting"}}, Orchestrator.status(a, "lease1")) end)
    assert {:error, :lease_held} = Orchestrator.start_run(b, "lease1", purchase(), %{"basket" => []})
    assert Orchestrator.recover(b) == [], "recovery leaves a run another orchestrator holds alone"
  end

  test "a driver that loses its lease stops, and cannot write after its successor", ctx do
    k = kernel(authorize: {:hold, "require_user_confirmation"})
    with_pricing(k)
    a = boot(ctx, k, lease_ttl_ms: 150)
    {:ok, pid} = Orchestrator.start_run(a, "zombie", purchase(), %{"basket" => []})
    wait_until(fn -> match?({:ok, %{status: "awaiting"}}, Orchestrator.status(a, "zombie")) end)

    # an intruder takes the lease the moment it lapses (we suspend the real driver so it cannot renew)
    :sys.suspend(pid)
    :timer.sleep(200)
    lease = Run.lease_path(Orchestrator.config(a), "zombie")
    assert {:ok, %{owner: "intruder", fence: 2}} = Helix.Lease.acquire(lease, "intruder", 60_000, System.system_time(:millisecond))
    {:ok, log} = EventLog.open(Run.log_path(Orchestrator.config(a), "zombie"))
    {:ok, _, _} = EventLog.append(log, "intruder_was_here", %{}, 2)

    ref = Process.monitor(pid)
    :sys.resume(pid)
    assert_receive {:DOWN, ^ref, :process, ^pid, {:shutdown, :lease_lost}}, 2_000
    {:ok, evs, _} = EventLog.read(Run.log_path(Orchestrator.config(a), "zombie"))
    assert List.last(evs)["type"] == "intruder_was_here", "the zombie wrote nothing after losing the lease"
  end

  # ── retries ─────────────────────────────────────────────────────────────────
  test "transient failures are retried with backoff and each attempt is logged", ctx do
    k = kernel()
    with_pricing(k)

    K.inject(k, "authorize", [
      {503, %{"error" => %{"code" => "overloaded", "message" => "busy"}}},
      :close,
      {429, %{"error" => %{"code" => "rate_limited", "message" => "slow"}}}
    ])

    orch = boot(ctx, k)
    {:ok, _} = Orchestrator.start_run(orch, "retry1", purchase(), %{"basket" => []})
    assert {:ok, %{status: "completed"}} = Orchestrator.await(orch, "retry1")
    assert K.count(k, "authorize") == 4
    {:ok, evs, _} = EventLog.read(Path.join(ctx.tmp_dir, "retry1.log"))
    retries = Enum.filter(evs, &(&1["type"] == "step_retry"))
    assert Enum.map(retries, & &1["data"]["attempt"]) == [1, 2, 3]
    assert Enum.all?(retries, &(&1["data"]["delay_ms"] > 0))
  end

  test "retries are bounded, then the run fails and says why", ctx do
    k = kernel()
    with_pricing(k)
    K.inject(k, "authorize", List.duplicate({503, %{"error" => %{"code" => "overloaded", "message" => "busy"}}}, 10))
    orch = boot(ctx, k)
    {:ok, _} = Orchestrator.start_run(orch, "retry2", purchase(), %{"basket" => []})
    assert {:ok, %{status: "failed", error: %{"kind" => "http", "status" => 503}}} = Orchestrator.await(orch, "retry2")
    assert K.count(k, "authorize") == 4, "max_attempts is 4"
  end

  test "a refusal is never retried", ctx do
    k = kernel()
    with_pricing(k)
    K.inject(k, "authorize", [{403, %{"error" => %{"code" => "forbidden", "message" => "an agent may only propose its own actions"}}}])
    orch = boot(ctx, k)
    {:ok, _} = Orchestrator.start_run(orch, "refused", purchase(), %{"basket" => []})
    assert {:ok, %{status: "failed", error: %{"status" => 403}}} = Orchestrator.await(orch, "refused")
    assert K.count(k, "authorize") == 1
  end

  test "an unresolved reference fails the step at once", ctx do
    k = kernel()
    orch = boot(ctx, k)
    wf = %{"id" => "w", "steps" => [inv("co", %{"x" => %{"$ref" => "inputs.missing"}})]}
    {:ok, _} = Orchestrator.start_run(orch, "badref", wf, %{})

    assert {:ok, %{status: "failed", error: %{"kind" => "unresolved_reference", "path" => "inputs.missing"}}} =
             Orchestrator.await(orch, "badref")

    assert K.count(k, "invoke:acme.pricing/checkout") == 0
  end

  test "a plugin that did not complete fails the run with the reason", ctx do
    k = kernel()

    K.plugin_response(k, "acme.pricing/checkout", %{
      "status" => "limit_exceeded",
      "limit" => "fuel",
      "error" => "the plugin ran out of fuel"
    })

    orch = boot(ctx, k)
    {:ok, _} = Orchestrator.start_run(orch, "limit1", %{"id" => "w", "steps" => [inv("co")]}, %{})
    assert {:ok, %{status: "failed", error: %{"detail" => d}}} = Orchestrator.await(orch, "limit1")
    assert d =~ "plugin_did_not_complete" and d =~ "fuel"
  end

  test "a status poll that hits a transient error keeps waiting instead of failing", ctx do
    k = kernel(authorize: {:hold, "require_user_confirmation"})
    with_pricing(k)
    orch = boot(ctx, k)
    {:ok, _} = Orchestrator.start_run(orch, "flaky", purchase(), %{"basket" => []})
    wait_until(fn -> match?({:ok, %{status: "awaiting"}}, Orchestrator.status(orch, "flaky")) end)

    K.inject(k, "get_action", [
      {503, %{"error" => %{"code" => "x", "message" => "y"}}},
      :close,
      {503, %{"error" => %{"code" => "x", "message" => "y"}}}
    ])

    :timer.sleep(150)
    assert {:ok, %{status: "awaiting"}} = Orchestrator.status(orch, "flaky")
    K.approve(k, "pending-1")
    assert {:ok, %{status: "completed"}} = Orchestrator.await(orch, "flaky")
  end

  # ── cancel and parallel ─────────────────────────────────────────────────────
  test "a waiting run can be cancelled and stays cancelled", ctx do
    k = kernel(authorize: {:hold, "require_user_confirmation"})
    with_pricing(k)
    orch = boot(ctx, k)
    {:ok, _} = Orchestrator.start_run(orch, "cancel1", purchase(), %{"basket" => []})
    wait_until(fn -> match?({:ok, %{status: "awaiting"}}, Orchestrator.status(orch, "cancel1")) end)
    assert :ok = Orchestrator.cancel(orch, "cancel1")
    assert {:ok, %{status: "cancelled"}} = Orchestrator.status(orch, "cancel1")
    K.approve(k, "pending-1")
    :timer.sleep(100)
    assert K.count(k, "begin") == 0
    assert Orchestrator.recover(orch) == []
  end

  test "parallel branches run at the same time and their results are all kept", ctx do
    k = kernel()
    K.plugin_response(k, "m1/quote", %{"status" => "ok", "result" => %{"price" => 10}, "proposed_intents" => []})
    K.plugin_response(k, "m2/quote", %{"status" => "ok", "result" => %{"price" => 12}, "proposed_intents" => []})
    K.delay(k, "invoke:m1/quote", 250)
    K.delay(k, "invoke:m2/quote", 250)
    orch = boot(ctx, k)

    q = fn id, plugin -> %{"id" => id, "kind" => "invoke_plugin", "plugin" => plugin, "tool" => "quote", "input" => %{}} end

    wf = %{
      "id" => "compare",
      "steps" => [
        %{"id" => "ask", "kind" => "parallel", "branches" => [[q.("a", "m1")], [q.("b", "m2")]]},
        %{"id" => "pick", "kind" => "set", "value" => %{"a" => %{"$ref" => "a.result.price"}, "b" => %{"$ref" => "b.result.price"}}}
      ]
    }

    t = System.monotonic_time(:millisecond)
    {:ok, _} = Orchestrator.start_run(orch, "par1", wf, %{})
    assert {:ok, %{status: "completed", vars: %{"pick" => %{"value" => %{"a" => 10, "b" => 12}}}}} = Orchestrator.await(orch, "par1")
    assert System.monotonic_time(:millisecond) - t < 450, "two 250 ms branches must overlap"
  end

  test "one failing branch fails the parallel step", ctx do
    k = kernel()
    K.plugin_response(k, "m1/quote", %{"status" => "ok", "result" => %{}, "proposed_intents" => []})
    K.inject(k, "invoke:m2/quote", List.duplicate({400, %{"error" => %{"code" => "invalid_request", "message" => "no"}}}, 5))
    orch = boot(ctx, k)
    q = fn id, plugin -> %{"id" => id, "kind" => "invoke_plugin", "plugin" => plugin, "tool" => "quote", "input" => %{}} end
    wf = %{"id" => "w", "steps" => [%{"id" => "ask", "kind" => "parallel", "branches" => [[q.("a", "m1")], [q.("b", "m2")]]}]}
    {:ok, _} = Orchestrator.start_run(orch, "par2", wf, %{})
    assert {:ok, %{status: "failed", error: %{"status" => 400}}} = Orchestrator.await(orch, "par2")
  end

  # ── executing ───────────────────────────────────────────────────────────────
  defp exec_run(ctx, provider) do
    k = kernel()
    with_pricing(k)
    orch = boot(ctx, k, provider: provider)
    {:ok, _} = Orchestrator.start_run(orch, "ex", purchase(), %{"basket" => []})
    {k, orch}
  end

  test "a provider that definitively fails is recorded as failed and the run fails", ctx do
    {k, orch} = exec_run(ctx, fn _, _ -> {:error, :card_declined} end)
    assert {:ok, %{status: "failed", error: %{"detail" => d}}} = Orchestrator.await(orch, "ex")
    assert d =~ "execution_failed" and d =~ "card_declined"
    assert [%{body: %{"state" => "failed"}}] = Enum.filter(K.calls(k), &(&1.route == "record"))
  end

  test "a provider that crashes or is unsure is NOT recorded as failed: the effect may have happened", ctx do
    for {label, provider} <- [
          {"raise", fn _, _ -> raise "connection reset by peer" end},
          {"ambiguous", fn _, _ -> {:ambiguous, :timeout_after_send} end},
          {"throw", fn _, _ -> throw(:boom) end},
          {"garbage", fn _, _ -> :whatever end}
        ] do
      File.rm_rf!(ctx.tmp_dir)
      File.mkdir_p!(ctx.tmp_dir)
      {k, orch} = exec_run(ctx, provider)
      assert {:ok, %{status: "failed", error: %{"detail" => d}}} = Orchestrator.await(orch, "ex"), label
      assert d =~ "execution_ambiguous", label
      assert K.count(k, "record") == 0, "#{label}: nothing may be recorded when the outcome is unknown"
    end
  end

  test "a restarted run that reaches an execution already done gets the recorded result, never a second permit", ctx do
    calls = :counters.new(1, [])
    provider = fn _, _ -> :counters.add(calls, 1, 1) && {:ok, %{"order" => "o_42"}} end
    k = kernel()
    with_pricing(k)
    orch = boot(ctx, k, provider: provider)
    {:ok, _} = Orchestrator.start_run(orch, "ex1", purchase(), %{"basket" => []})
    assert {:ok, %{status: "completed"}} = Orchestrator.await(orch, "ex1")
    assert :counters.get(calls, 1) == 1

    # the same workflow under another run id derives the same idempotency key only if the ids match;
    # here we replay the SAME run: drop its completion record so the execute step runs again
    path = Path.join(ctx.tmp_dir, "ex1.log")
    {:ok, evs, _} = EventLog.read(path)
    File.rm!(path)
    File.rm!(Path.join(ctx.tmp_dir, "ex1.lease"))
    {:ok, log} = EventLog.open(path)

    log =
      evs
      |> Enum.take_while(&(not (&1["type"] == "step_completed" and &1["data"]["id"] == "buy")))
      |> Enum.reduce(log, fn ev, l -> elem(Enum.at([EventLog.append(l, ev["type"], ev["data"], 1)], 0), 1) end)

    _ = log
    orch2 = boot(ctx, k, provider: provider)
    assert Orchestrator.recover(orch2) == ["ex1"]

    assert {:ok, %{status: "completed", vars: %{"buy" => %{"replayed" => true, "result" => %{"order" => "o_42"}}}}} =
             Orchestrator.await(orch2, "ex1")

    assert :counters.get(calls, 1) == 1, "the provider was not called again"
  end

  test "an execution another executor has started is retried, not duplicated", ctx do
    k = kernel()
    with_pricing(k)
    K.inject(k, "begin", [{200, %{"state" => "pending", "reasons" => []}}, {200, %{"state" => "pending", "reasons" => []}}])
    orch = boot(ctx, k)
    {:ok, _} = Orchestrator.start_run(orch, "inprog", purchase(), %{"basket" => []})
    assert {:ok, %{status: "completed"}} = Orchestrator.await(orch, "inprog")
    assert K.count(k, "begin") == 3
  end

  test "a refused permit fails the run", ctx do
    k = kernel()
    with_pricing(k)
    K.inject(k, "begin", [{200, %{"state" => "refused", "reasons" => ["grant has expired"]}}])
    orch = boot(ctx, k)
    {:ok, _} = Orchestrator.start_run(orch, "refusedx", purchase(), %{"basket" => []})
    assert {:ok, %{status: "failed", error: %{"detail" => d}}} = Orchestrator.await(orch, "refusedx")
    assert d =~ "execution_refused" and d =~ "grant has expired"
  end

  test "an execute step with nothing to execute fails clearly", ctx do
    k = kernel()
    K.plugin_response(k, "acme.pricing/checkout", %{"status" => "ok", "result" => %{}, "proposed_intents" => [proposal()]})
    K.set_authorize(k, {:deny, ["no"]})
    orch = boot(ctx, k)
    wf = update_in(purchase(), ["steps"], fn [a, b, c] -> [a, Map.put(b, "on_deny", "continue"), c] end)
    {:ok, _} = Orchestrator.start_run(orch, "nothing", wf, %{"basket" => []})
    assert {:ok, %{status: "failed", error: %{"detail" => d}}} = Orchestrator.await(orch, "nothing")
    assert d =~ "nothing_to_execute"
    assert K.count(k, "begin") == 0
  end
end
