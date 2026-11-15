defmodule Helix.Run do
  @moduledoc """
  One durable workflow run: a process that drives a workflow from its event log.

  **The log is the run.** Every state change is appended (and synced) before the
  process acts on it, so a run that crashes, or whose node dies, is rebuilt by
  replaying its log: steps already completed are not repeated, a step that
  was in flight is retried, and a run parked on a person's decision stays parked.
  The workflow definition itself is stored in the log's first event, so recovery
  needs nothing but the file.

  **One driver at a time.** A run holds a fenced lease (`Helix.Lease`). Its
  log appends carry the fencing token, so a driver that has lost its lease
  without noticing cannot write after its successor. A driver that finds its
  lease gone stops.

  **Waiting for a person is a state, not a blocked process.** When the kernel
  holds an authorization for a person's decision, the run records `awaiting`
  and polls the gateway (cheaply, on a timer). It survives restarts while it
  waits. Approval makes it collect the grant and go on; a denial, a withdrawal
  or an expiry ends the run, or lets it carry on if the step says
  `"on_deny" => "continue"`.

  **Failures.** A transport failure, 429, 502, 503 or 504 is retried with
  exponential backoff and jitter, up to `max_attempts`, each attempt logged.
  Anything else (a refusal, a validation error, an unresolved reference) fails
  the step and the run immediately: asking again would not change the answer.

  **Effects happen at most once.** `authorize` is at-least-once (a crash
  between sending and logging asks again, which at worst creates a second
  pending request for the person), but every effect goes through the kernel's
  `begin_execution`, which hands out one permit per idempotency key; see
  `Helix.Executor`.
  """
  use GenServer, restart: :transient

  alias Helix.{EventLog, Gateway, Lease, Workflow, Executor}

  # ── API ─────────────────────────────────────────────────────────────────────
  def start_link(args) do
    GenServer.start_link(__MODULE__, args, name: via(args.config.registry, args.id))
  end

  def via(registry, id), do: {:via, Registry, {registry, {:run, id}}}

  @doc "The current state of a run: from the live process if there is one, else from its log."
  @spec status(map, String.t()) :: {:ok, map} | {:error, :not_found | term}
  def status(config, id) do
    case lookup(config, id) do
      [{pid, _}] ->
        try do
          {:ok, GenServer.call(pid, :status, 5_000)}
        catch
          :exit, _ -> from_log(config, id)
        end

      [] ->
        from_log(config, id)
    end
  end

  # A run's log answers for it when no orchestrator is running (the registry may not even exist).
  defp lookup(config, id) do
    Registry.lookup(config.registry, {:run, id})
  rescue
    ArgumentError -> []
  end

  def cancel(config, id) do
    case lookup(config, id) do
      [{pid, _}] -> GenServer.call(pid, :cancel, 10_000)
      [] -> {:error, :not_running}
    end
  end

  @doc "Check an approval now instead of waiting for the next poll."
  def poke(config, id) do
    case lookup(config, id) do
      [{pid, _}] -> send(pid, :poll_now) && :ok
      [] -> {:error, :not_running}
    end
  end

  def log_path(config, id), do: Path.join(config.dir, id <> ".log")
  def lease_path(config, id), do: Path.join(config.dir, id <> ".lease")

  defp from_log(config, id) do
    path = log_path(config, id)

    with true <- File.exists?(path),
         {:ok, events, torn} <- EventLog.read(path) do
      case replay(events) do
        nil -> {:error, :not_found}
        st -> {:ok, public(st, torn)}
      end
    else
      false -> {:error, :not_found}
      {:error, e} -> {:error, e}
    end
  end

  # ── GenServer ───────────────────────────────────────────────────────────────
  @impl true
  def init(args) do
    config = args.config
    now = System.system_time(:millisecond)

    case Lease.acquire(lease_path(config, args.id), args.owner, config.lease_ttl_ms, now) do
      {:ok, lease} ->
        {:ok, log} = EventLog.open(log_path(config, args.id))
        {:ok, events, _torn} = EventLog.read(log.path)

        case replay(events) do
          nil -> fresh(args, log, lease)
          st -> {:ok, Map.merge(base(args, log, lease), st), {:continue, :advance}}
        end

      {:error, {:held, _}} ->
        {:stop, :lease_held}
    end
  end

  defp base(args, log, lease) do
    %{
      id: args.id,
      config: args.config,
      owner: args.owner,
      log: log,
      fence: lease.fence,
      task: nil,
      timer: nil,
      lease_timer: nil,
      polling: false
    }
  end

  defp fresh(args, log, lease) do
    case Workflow.validate(args.workflow) do
      {:ok, wf} ->
        st =
          base(args, log, lease)
          |> Map.merge(%{
            workflow: wf,
            inputs: args.inputs,
            vars: %{"inputs" => args.inputs},
            done: [],
            status: "running",
            awaiting: nil,
            attempts: %{},
            error: nil
          })

        case append(st, "run_started", %{"workflow" => wf, "inputs" => args.inputs}) do
          {:ok, st, _} -> {:ok, st, {:continue, :advance}}
          {:stop, reason} -> {:stop, reason}
        end

      {:error, errs} ->
        {:stop, {:invalid_workflow, errs}}
    end
  end

  # Rebuild state from the log. nil when the log is empty.
  defp replay([]), do: nil

  defp replay(events) do
    Enum.reduce(events, nil, fn %{"type" => type, "data" => d}, st ->
      case {type, st} do
        {"run_started", _} ->
          %{
            workflow: d["workflow"],
            inputs: d["inputs"],
            vars: %{"inputs" => d["inputs"]},
            done: [],
            status: "running",
            awaiting: nil,
            attempts: %{},
            error: nil
          }

        {"step_completed", st} ->
          %{st | vars: Map.merge(st.vars, d["vars"] || %{d["id"] => d["output"]}), done: st.done ++ [d["id"]], awaiting: nil}

        {"step_retry", st} ->
          %{st | attempts: Map.put(st.attempts, d["id"], d["attempt"])}

        {"awaiting", st} ->
          %{
            st
            | status: "awaiting",
              awaiting: %{step: d["id"], pending_id: d["pending_id"], kind: d["kind"], intent: d["intent"], deadline: d["deadline"]}
          }

        {"resumed", st} ->
          %{st | status: "running"}

        {"run_completed", st} ->
          %{st | status: "completed"}

        {"run_failed", st} ->
          %{st | status: "failed", error: d["reason"]}

        {"run_cancelled", st} ->
          %{st | status: "cancelled"}

        {_, st} ->
          st
      end
    end)
  end

  defp public(st, torn) do
    %{
      id: st[:id],
      status: st.status,
      done: st.done,
      vars: Map.delete(st.vars, "inputs"),
      awaiting: st.awaiting,
      error: st.error,
      workflow: st.workflow["id"],
      torn_tail: torn
    }
  end

  @impl true
  def handle_call(:status, _from, st), do: {:reply, public(st, false) |> Map.put(:id, st.id), st}

  def handle_call(:cancel, _from, st) do
    st = kill_task(st)

    case append(st, "run_cancelled", %{}) do
      {:ok, st, _} -> {:stop, :normal, :ok, %{st | status: "cancelled"}}
      {:stop, reason} -> {:stop, reason, {:error, reason}, st}
    end
  end

  @impl true
  def handle_continue(:advance, %{status: s} = st) when s in ["completed", "failed", "cancelled"], do: {:stop, :normal, st}

  def handle_continue(:advance, st) do
    st = schedule_lease_renewal(st)

    case st.awaiting do
      %{} -> {:noreply, poll_soon(st, 0)}
      nil -> advance(st)
    end
  end

  defp advance(st) do
    case Enum.find(st.workflow["steps"], fn s -> s["id"] not in st.done end) do
      nil ->
        case append(st, "run_completed", %{"vars" => Map.delete(st.vars, "inputs")}) do
          {:ok, st, _} -> {:stop, :normal, %{st | status: "completed"}}
          {:stop, reason} -> {:stop, reason, st}
        end

      step ->
        attempt = Map.get(st.attempts, step["id"], 0) + 1

        with {:ok, st, _} <- append(st, "step_started", %{"id" => step["id"], "attempt" => attempt}) do
          {:noreply, start_task(st, step, fn -> exec(step, st.vars, st) end)}
        else
          {:stop, reason} -> {:stop, reason, st}
        end
    end
  end

  defp start_task(st, step, fun) do
    t = Task.Supervisor.async_nolink(st.config.task_sup, fun)
    %{st | task: %{ref: t.ref, step: step}}
  end

  defp kill_task(%{task: %{ref: ref}} = st) do
    Process.demonitor(ref, [:flush])
    %{st | task: nil}
  end

  defp kill_task(st), do: st

  # a step's task finished
  @impl true
  def handle_info({ref, result}, %{task: %{ref: ref, step: step}} = st) do
    Process.demonitor(ref, [:flush])
    st = %{st | task: nil}

    case result do
      {:ok, vars_update, output} -> complete(st, step, vars_update, output)
      {:await, info} -> park(st, step, info)
      {:poll_result, outcome} -> after_poll(st, step, outcome)
      {:error, reason} -> failed_step(st, step, reason)
    end
  end

  # a step's task crashed: that is a bug in a step, not in the world. Retry a few times, then fail.
  def handle_info({:DOWN, ref, :process, _pid, reason}, %{task: %{ref: ref, step: step}} = st) do
    failed_step(%{st | task: nil}, step, {:step_crashed, inspect(reason)})
  end

  def handle_info({:retry, step_id}, st) do
    step = Enum.find(st.workflow["steps"], &(&1["id"] == step_id))
    if step && st.task == nil && step_id not in st.done, do: advance(st), else: {:noreply, st}
  end

  def handle_info(:poll_now, %{awaiting: %{}, task: nil} = st), do: do_poll(st)
  def handle_info(:poll, %{awaiting: %{}, task: nil} = st), do: do_poll(%{st | timer: nil})
  def handle_info(poll, st) when poll in [:poll, :poll_now], do: {:noreply, st}

  def handle_info(:renew_lease, st) do
    case Lease.renew(lease_path(st.config, st.id), st.owner, st.config.lease_ttl_ms, System.system_time(:millisecond)) do
      {:ok, _} -> {:noreply, schedule_lease_renewal(%{st | lease_timer: nil})}
      {:error, :lost} -> {:stop, {:shutdown, :lease_lost}, st}
    end
  end

  def handle_info(_other, st), do: {:noreply, st}

  @impl true
  def terminate(reason, st) when reason in [:normal, :shutdown] or (is_tuple(reason) and elem(reason, 0) == :shutdown) do
    if st[:status] in ["completed", "failed", "cancelled"], do: Lease.release(lease_path(st.config, st.id), st.owner)
    :ok
  end

  def terminate(_reason, _st), do: :ok

  # ── transitions ─────────────────────────────────────────────────────────────
  defp complete(st, step, vars_update, output) do
    case append(st, "step_completed", %{"id" => step["id"], "output" => output, "vars" => vars_update}) do
      {:ok, st, _} ->
        st = %{st | vars: Map.merge(st.vars, vars_update), done: st.done ++ [step["id"]], awaiting: nil, status: "running"}
        advance(st)

      {:stop, reason} ->
        {:stop, reason, st}
    end
  end

  defp park(st, step, info) do
    deadline = System.system_time(:millisecond) + (step["timeout_ms"] || 86_400_000)
    data = %{"id" => step["id"], "pending_id" => info.pending_id, "kind" => info.kind, "intent" => info.intent, "deadline" => deadline}

    case append(st, "awaiting", data) do
      {:ok, st, _} ->
        st = %{
          st
          | status: "awaiting",
            awaiting: %{step: step["id"], pending_id: info.pending_id, kind: info.kind, intent: info.intent, deadline: deadline}
        }

        {:noreply, poll_soon(st, st.config.poll_ms)}

      {:stop, reason} ->
        {:stop, reason, st}
    end
  end

  defp poll_soon(%{timer: t} = st, ms) do
    if t, do: Process.cancel_timer(t)
    %{st | timer: Process.send_after(self(), :poll, ms)}
  end

  defp do_poll(st) do
    a = st.awaiting
    step = Enum.find(st.workflow["steps"], &(&1["id"] == a.step))

    if System.system_time(:millisecond) > a.deadline do
      failed_step(st, step, {:approval_timeout, a.pending_id})
    else
      gw = st.config.gateway
      {:noreply, start_task(st, step, fn -> {:poll_result, Gateway.get_action(gw, a.pending_id)} end)}
    end
  end

  defp after_poll(st, step, outcome) do
    a = st.awaiting

    case outcome do
      {:ok, _, %{"state" => "approved", "grant" => %{} = grant}} ->
        out = %{"decision" => "allow", "grant" => grant, "intent" => a.intent, "pending_id" => a.pending_id}

        case append(st, "resumed", %{"id" => step["id"], "approved" => true}) do
          {:ok, st, _} -> complete(st, step, %{step["id"] => out}, out)
          {:stop, reason} -> {:stop, reason, st}
        end

      {:ok, _, %{"state" => "approved"}} ->
        # approved but the grant did not come back (the gateway or kernel is not letting this service collect it)
        failed_step(st, step, {:approved_but_no_grant, a.pending_id})

      {:ok, _, %{"state" => "pending"}} ->
        {:noreply, poll_soon(st, st.config.poll_ms)}

      {:ok, _, %{"state" => state}} when state in ["denied", "withdrawn", "expired"] ->
        denied(st, step, {:person_said_no, state})

      {:ok, _, other} ->
        failed_step(st, step, {:unexpected_state, other["state"]})

      {:error, e} ->
        if Gateway.retryable?(e), do: {:noreply, poll_soon(st, st.config.poll_ms)}, else: failed_step(st, step, e)
    end
  end

  defp denied(st, step, reason) do
    if step["on_deny"] == "continue" do
      out = %{"decision" => "deny", "reason" => inspect(reason), "intent" => st.awaiting && st.awaiting.intent}

      with {:ok, st, _} <- append(st, "resumed", %{"id" => step["id"], "approved" => false}) do
        complete(st, step, %{step["id"] => out}, out)
      else
        {:stop, r} -> {:stop, r, st}
      end
    else
      failed_step(st, step, reason)
    end
  end

  defp failed_step(st, step, reason) do
    attempt = Map.get(st.attempts, step["id"], 0) + 1
    retry? = retryable?(reason) and attempt < st.config.max_attempts

    if retry? do
      delay = backoff(st.config.backoff_ms, attempt)

      case append(st, "step_retry", %{"id" => step["id"], "attempt" => attempt, "reason" => describe(reason), "delay_ms" => delay}) do
        {:ok, st, _} ->
          Process.send_after(self(), {:retry, step["id"]}, delay)
          {:noreply, %{st | attempts: Map.put(st.attempts, step["id"], attempt)}}

        {:stop, r} ->
          {:stop, r, st}
      end
    else
      with {:ok, st, _} <- append(st, "step_failed", %{"id" => step["id"], "reason" => describe(reason), "attempts" => attempt}),
           {:ok, st, _} <- append(st, "run_failed", %{"step" => step["id"], "reason" => describe(reason)}) do
        {:stop, :normal, %{st | status: "failed", error: describe(reason)}}
      else
        {:stop, r} -> {:stop, r, st}
      end
    end
  end

  defp retryable?({:step_crashed, _}), do: true
  defp retryable?(:execution_in_progress), do: true
  defp retryable?(e), do: Gateway.retryable?(e)

  defp backoff(base, attempt) do
    d = min(base * Integer.pow(2, attempt - 1), 30_000)
    round(d * (0.8 + :rand.uniform() * 0.4))
  end

  defp describe({:http, status, code, message}), do: %{"kind" => "http", "status" => status, "code" => code, "message" => message}
  defp describe({:transport, reason}), do: %{"kind" => "transport", "reason" => inspect(reason)}
  defp describe({:unresolved, path}), do: %{"kind" => "unresolved_reference", "path" => path}
  defp describe(other), do: %{"kind" => "error", "detail" => inspect(other, limit: 20, printable_limit: 500)}

  # ── log ─────────────────────────────────────────────────────────────────────
  defp append(st, type, data) do
    case EventLog.append(st.log, type, data, st.fence) do
      {:ok, log, ev} -> {:ok, %{st | log: log}, ev}
      {:error, :stale_fence} -> {:stop, {:shutdown, :lease_lost}}
      {:error, e} -> {:stop, {:log_error, e}}
    end
  end

  defp schedule_lease_renewal(%{lease_timer: nil} = st) do
    %{st | lease_timer: Process.send_after(self(), :renew_lease, max(div(st.config.lease_ttl_ms, 3), 50))}
  end

  defp schedule_lease_renewal(st), do: st

  # ── step execution (runs in a Task) ─────────────────────────────────────────
  # Returns {:ok, vars_update, output} | {:await, info} | {:error, reason}
  defp exec(%{"kind" => "set"} = step, vars, _st) do
    with {:ok, v} <- Workflow.resolve(step["value"], vars), do: {:ok, %{step["id"] => %{"value" => v}}, %{"value" => v}}
  end

  defp exec(%{"kind" => "invoke_plugin"} = step, vars, st) do
    with {:ok, input} <- Workflow.resolve(step["input"], vars),
         {:ok, _, body} <- Gateway.invoke_plugin(st.config.gateway, step["plugin"], step["tool"], input, step["agent"]) do
      case body do
        %{"status" => "ok"} -> {:ok, %{step["id"] => body}, body}
        %{"status" => status} = b -> {:error, {:plugin_did_not_complete, status, b["limit"], b["error"]}}
      end
    end
  end

  defp exec(%{"kind" => "authorize"} = step, vars, st) do
    with {:ok, intent} <- build_intent(step, vars, st),
         {:ok, _, body} <- Gateway.authorize(st.config.gateway, intent) do
      case body["decision"] do
        "allow" ->
          out = %{"decision" => "allow", "grant" => body["grant"], "intent" => intent}
          {:ok, %{step["id"] => out}, out}

        d when d in ["require_user_confirmation", "require_human_review"] ->
          {:await, %{pending_id: body["pending_id"], kind: d, intent: intent}}

        "deny" ->
          if step["on_deny"] == "continue" do
            out = %{"decision" => "deny", "reasons" => body["reasons"], "intent" => intent}
            {:ok, %{step["id"] => out}, out}
          else
            {:error, {:authorization_denied, body["reasons"] || []}}
          end
      end
    end
  end

  defp exec(%{"kind" => "execute"} = step, vars, st) do
    with {:ok, auth} <- Workflow.fetch(vars, step["from"]),
         %{"grant" => %{} = grant, "intent" => %{} = intent} <- auth,
         {:ok, cfg} <- Map.fetch(st.config.executors, step["executor"]) |> or_error({:no_such_executor, step["executor"]}),
         {:ok, out} <- Executor.run(cfg, grant, intent) do
      {:ok, %{step["id"] => out}, out}
    else
      %{} -> {:error, {:nothing_to_execute, step["from"]}}
      other -> normalize(other)
    end
  end

  defp exec(%{"kind" => "parallel"} = step, vars, st) do
    results =
      step["branches"]
      |> Task.async_stream(fn branch -> run_branch(branch, vars, st) end,
        max_concurrency: 8,
        timeout: 120_000,
        ordered: true,
        on_timeout: :kill_task
      )
      |> Enum.map(fn
        {:ok, r} -> r
        {:exit, reason} -> {:error, {:branch_crashed, inspect(reason)}}
      end)

    case Enum.find(results, &match?({:error, _}, &1)) do
      nil ->
        merged = Enum.reduce(results, %{}, fn {:ok, v}, acc -> Map.merge(acc, v) end)
        {:ok, Map.put(merged, step["id"], %{"branches" => length(results)}), %{"branches" => length(results)}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp run_branch(steps, vars, st) do
    Enum.reduce_while(steps, {:ok, %{}}, fn step, {:ok, acc} ->
      case exec(step, Map.merge(vars, acc), st) do
        {:ok, update, _out} -> {:cont, {:ok, Map.merge(acc, update)}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp build_intent(step, vars, st) do
    base =
      case step do
        %{"intent" => intent} -> Workflow.resolve(intent, vars)
        %{"intent_from" => path} -> Workflow.fetch(vars, path)
      end

    with {:ok, base} when is_map(base) <- base,
         {:ok, extra} <- Workflow.resolve(step["intent_with"] || %{}, vars) do
      # The id and the idempotency key identify ONE intended effect, so they come from the run and the
      # step: asking again after a crash is the same request, and two runs never share a key.
      # A proposal that came from a plugin does not know the run, so these OVERRIDE what it suggested;
      # an intent the workflow's author wrote out in full keeps the id and key they chose.
      defaults = %{"id" => "wf_#{st.id}_#{step["id"]}", "idempotency_key" => "wfk_#{st.id}_#{step["id"]}"}
      merged = if Map.has_key?(step, "intent_from"), do: Map.merge(base, defaults), else: Map.merge(defaults, base)
      {:ok, Map.merge(merged, extra)}
    else
      {:ok, _} -> {:error, {:intent_is_not_an_object, step["id"]}}
      other -> other
    end
  end

  defp or_error({:ok, v}, _), do: {:ok, v}
  defp or_error(:error, e), do: {:error, e}
  defp normalize({:error, _} = e), do: e
  defp normalize(other), do: {:error, {:unexpected, inspect(other)}}
end
