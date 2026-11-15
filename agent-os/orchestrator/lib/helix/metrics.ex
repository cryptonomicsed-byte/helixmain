defmodule Helix.Metrics do
  @moduledoc """
  Orchestrator metrics in Prometheus text format.

  Every event appended to a run's log is counted by type (`run_started`,
  `step_completed`, `step_retry`, `awaiting`, `run_completed`, `run_failed`, ...),
  so the counters reconcile with the logs. Gauges (runs and agents alive) are read at
  render time. `Helix.Orchestrator.metrics/1` returns the text; the embedding
  service decides how to expose it (loopback only, like the gateway's).
  """

  def table(name), do: Module.concat(Helix.Orchestrator.Metrics, name)

  def init(name), do: :ets.new(table(name), [:named_table, :public, :set, write_concurrency: true])

  @doc "Count one occurrence of `key` (a short atom or string chosen by code, never by a message)."
  def inc(name, key) do
    :ets.update_counter(table(name), key, 1, {key, 0})
    :ok
  rescue
    ArgumentError -> :ok
  end

  def render(name) do
    config = Helix.Orchestrator.config(name)

    events =
      :ets.tab2list(table(name))
      |> Enum.sort()
      |> Enum.map(fn {type, n} -> ~s(helix_orchestrator_events_total{type="#{type}"} #{n}\n) end)

    count = fn kind -> config.registry |> Registry.select([{{{kind, :_}, :_, :_}, [], [true]}]) |> length() end
    runs = count.(:run)
    agents = count.(:agent)

    IO.iodata_to_binary([
      "# HELP helix_orchestrator_events_total Events appended to run logs, by type.\n# TYPE helix_orchestrator_events_total counter\n",
      events,
      "# HELP helix_orchestrator_runs_active Runs being driven by this orchestrator.\n# TYPE helix_orchestrator_runs_active gauge\nhelix_orchestrator_runs_active #{runs}\n",
      "# HELP helix_orchestrator_agents Agent actors alive.\n# TYPE helix_orchestrator_agents gauge\nhelix_orchestrator_agents #{agents}\n"
    ])
  end
end
