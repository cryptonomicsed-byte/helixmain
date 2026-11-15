defmodule Helix.Orchestrator do
  @moduledoc """
  The supervision tree and the public API of the orchestrator.

      {:ok, _} =
        Helix.Orchestrator.start_link(
          name: :shop,
          dir: "/var/lib/helix/runs",
          gateway: Helix.Gateway.new("https://gateway.example", orchestrator_token),
          executors: %{"merchant" => %{gateway: Helix.Gateway.new(url, executor_token), provider: &MyShop.place_order/2}}
        )

      {:ok, run} = Helix.Orchestrator.start_run(:shop, "run-001", workflow, %{"basket" => basket})
      Helix.Orchestrator.status(:shop, "run-001")

  Runs are supervised: one that crashes is restarted and rebuilt from its log.
  `recover/1` starts every unfinished run found in the log directory, which is
  what a freshly started node does (`start_link` does it by default).

  Several orchestrators may share a log directory; each run is driven by
  whichever holds its lease (`Helix.Lease`), and the others get
  `{:error, :lease_held}`.
  """
  use Supervisor

  alias Helix.{EventLog, Run, Workflow}

  @defaults %{lease_ttl_ms: 15_000, poll_ms: 1_000, max_attempts: 5, backoff_ms: 200, executors: %{}, recover: true}

  def start_link(opts) do
    name = Keyword.fetch!(opts, :name)
    Supervisor.start_link(__MODULE__, opts, name: sup_name(name))
  end

  def child_spec(opts), do: %{id: Keyword.fetch!(opts, :name), start: {__MODULE__, :start_link, [opts]}, type: :supervisor}

  def config(name), do: :persistent_term.get({__MODULE__, name})

  @impl true
  def init(opts) do
    name = Keyword.fetch!(opts, :name)
    dir = Keyword.fetch!(opts, :dir)
    File.mkdir_p!(dir)

    config =
      @defaults
      |> Map.merge(Map.new(Keyword.drop(opts, [:name, :recover])))
      |> Map.merge(%{
        name: name,
        registry: reg(name),
        task_sup: tasks(name),
        run_sup: runs(name),
        agent_sup: agents(name),
        recover: Keyword.get(opts, :recover, true)
      })

    unless match?(%Helix.Gateway{}, config[:gateway]), do: raise(ArgumentError, "a :gateway (Helix.Gateway) is required")
    :persistent_term.put({__MODULE__, name}, config)
    Helix.Metrics.init(name)

    children = [
      {Registry, keys: :unique, name: config.registry},
      {Task.Supervisor, name: config.task_sup},
      {DynamicSupervisor, name: config.run_sup, strategy: :one_for_one, max_restarts: 10, max_seconds: 10},
      {DynamicSupervisor, name: config.agent_sup, strategy: :one_for_one, max_restarts: 10, max_seconds: 10},
      # recovery runs once the tree below it is up
      %{id: :recovery, start: {Task, :start_link, [fn -> if config.recover, do: recover(name) end]}, restart: :temporary}
    ]

    Supervisor.init(children, strategy: :rest_for_one)
  end

  defp sup_name(n), do: Module.concat(Helix.Orchestrator.Sup, n)
  defp reg(n), do: Module.concat(Helix.Orchestrator.Registry, n)
  defp tasks(n), do: Module.concat(Helix.Orchestrator.Tasks, n)
  defp runs(n), do: Module.concat(Helix.Orchestrator.Runs, n)
  defp agents(n), do: Module.concat(Helix.Orchestrator.Agents, n)

  # ── API ─────────────────────────────────────────────────────────────────────

  @doc """
  Start a run. `run_id` names it durably (letters, digits, `_`, `-`); starting an id
  that already exists resumes it. Returns `{:ok, pid}`, `{:error, {:invalid_workflow, errors}}`,
  or `{:error, :lease_held}` when another orchestrator is driving it.
  """
  @spec start_run(atom, String.t(), map, map) :: {:ok, pid} | {:error, term}
  def start_run(name, run_id, workflow, inputs \\ %{}) do
    cond do
      not Regex.match?(~r/\A[A-Za-z0-9][A-Za-z0-9_-]{0,63}\z/, run_id) -> {:error, :bad_run_id}
      not is_map(inputs) -> {:error, :inputs_must_be_an_object}
      true -> start(name, run_id, workflow, inputs)
    end
  end

  defp start(name, run_id, workflow, inputs) do
    config = config(name)

    case Workflow.validate(workflow) do
      {:error, errs} ->
        {:error, {:invalid_workflow, errs}}

      {:ok, wf} ->
        spec = {Run, %{id: run_id, workflow: wf, inputs: inputs, config: config, owner: owner(name)}}

        case DynamicSupervisor.start_child(config.run_sup, spec) do
          {:ok, pid} -> {:ok, pid}
          {:error, {:already_started, pid}} -> {:ok, pid}
          {:error, :lease_held} -> {:error, :lease_held}
          {:error, {:invalid_workflow, _} = e} -> {:error, e}
          {:error, other} -> {:error, other}
        end
    end
  end

  defp owner(name), do: "#{node()}/#{name}"

  @doc """
  Start an agent actor under the orchestrator. `handler` is `fn message, profile -> {:reply, map} | :noreply end`.
  """
  def start_agent(name, sid, profile, handler, opts \\ []) when is_function(handler, 2) do
    config = config(name)
    args = %{sid: sid, profile: profile, handler: handler, registry: config.registry, task_sup: config.task_sup} |> Map.merge(Map.new(opts))

    case DynamicSupervisor.start_child(config.agent_sup, {Helix.Agent, args}) do
      {:ok, pid} -> {:ok, pid}
      {:error, {:already_started, _}} -> {:error, :already_started}
      {:error, {%ArgumentError{message: m}, _}} -> {:error, {:invalid_agent, m}}
      {:error, other} -> {:error, other}
    end
  end

  @doc "Ask another agent something and wait for the answer. See `Helix.A2A`."
  def ask(name, from, to, type, body, opts \\ []), do: Helix.A2A.request(config(name).registry, from, to, type, body, opts)

  def agent_profile(name, sid), do: Helix.Agent.profile(config(name).registry, sid)
  def agent_stats(name, sid), do: Helix.Agent.stats(config(name).registry, sid)

  @doc "Prometheus text for this orchestrator (see `Helix.Metrics`)."
  def metrics(name), do: Helix.Metrics.render(name)

  def status(name, run_id), do: Run.status(config(name), run_id)
  def cancel(name, run_id), do: Run.cancel(config(name), run_id)
  def poke(name, run_id), do: Run.poke(config(name), run_id)

  @doc "Wait until a run reaches a final state (completed, failed, cancelled). For tests and scripts."
  @spec await(atom, String.t(), pos_integer) :: {:ok, map} | {:error, :timeout | term}
  def await(name, run_id, timeout_ms \\ 30_000) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    do_await(name, run_id, deadline)
  end

  defp do_await(name, run_id, deadline) do
    case status(name, run_id) do
      {:ok, %{status: s} = st} when s in ["completed", "failed", "cancelled"] ->
        {:ok, st}

      {:ok, _} ->
        if System.monotonic_time(:millisecond) > deadline,
          do: {:error, :timeout},
          else: :timer.sleep(20) && do_await(name, run_id, deadline)

      {:error, _} = e ->
        e
    end
  end

  @doc "Every run in the log directory that has not finished."
  def unfinished(name) do
    config = config(name)

    config.dir
    |> Path.join("*.log")
    |> Path.wildcard()
    |> Enum.map(&Path.basename(&1, ".log"))
    |> Enum.filter(fn id ->
      case Run.status(config, id) do
        {:ok, %{status: s}} -> s in ["running", "awaiting"]
        _ -> false
      end
    end)
  end

  @doc "Start every unfinished run in the log directory (those another orchestrator holds are left alone). Returns the ids resumed."
  def recover(name) do
    config = config(name)

    for id <- unfinished(name),
        match?([], Registry.lookup(config.registry, {:run, id})),
        {:ok, events, _} = EventLog.read(Run.log_path(config, id)),
        started = Enum.find(events, &(&1["type"] == "run_started")),
        started != nil,
        {:ok, _pid} <- [start_recovered(name, config, id, started)] do
      id
    end
  end

  defp start_recovered(name, config, id, started) do
    wf = started["data"]["workflow"]
    spec = {Run, %{id: id, workflow: wf, inputs: started["data"]["inputs"], config: config, owner: owner(name)}}

    case DynamicSupervisor.start_child(config.run_sup, spec) do
      {:ok, pid} -> {:ok, pid}
      {:error, _} -> :skip
    end
  end
end
