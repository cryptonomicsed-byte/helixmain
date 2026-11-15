defmodule Helix.Test.FakeKernel do
  @moduledoc false
  # An in-memory stand-in for the gateway's HTTP API, scriptable per route. The
  # end-to-end tests use the real gateway, kernel and policy service; this is
  # for what a real one will not do on command: fail, hang, or answer oddly.

  alias Helix.Test.FakeGateway

  def start(opts \\ []) do
    {:ok, st} =
      Agent.start_link(fn ->
        %{
          authorize: Keyword.get(opts, :authorize, :allow),
          pendings: %{},
          injected: %{},
          counts: %{},
          delay: %{},
          plugin: %{},
          executions: %{},
          log: []
        }
      end)

    gw = FakeGateway.start(fn method, path, req -> handle(st, method, path, req) end)
    %{gw: gw, st: st, url: gw.url}
  end

  def client(k, token \\ "hxg_test"), do: Helix.Gateway.new(k.url, token, timeout_ms: 3_000)

  # ── scripting ──
  def set_authorize(k, mode), do: Agent.update(k.st, &%{&1 | authorize: mode})
  def inject(k, route, responses), do: Agent.update(k.st, &put_in(&1.injected[route], responses))
  def delay(k, route, ms), do: Agent.update(k.st, &put_in(&1.delay[route], ms))
  def plugin_response(k, key, body), do: Agent.update(k.st, &put_in(&1.plugin[key], body))
  def count(k, route), do: Agent.get(k.st, &Map.get(&1.counts, route, 0))
  def calls(k), do: Agent.get(k.st, &Enum.reverse(&1.log))

  def approve(k, pending_id, grant \\ %{"id" => "grant_1", "signature" => "sig"}),
    do: Agent.update(k.st, &put_in(&1.pendings[pending_id], %{"state" => "approved", "grant" => grant}))

  def decide(k, pending_id, state), do: Agent.update(k.st, &put_in(&1.pendings[pending_id], %{"state" => state}))

  # ── the API ──
  defp handle(st, method, path, %{body: body, headers: headers}) do
    route = route(method, path)

    Agent.update(st, fn s ->
      %{s | counts: Map.update(s.counts, route, 1, &(&1 + 1)), log: [%{route: route, body: body, token: headers["authorization"]} | s.log]}
    end)

    case Agent.get_and_update(st, fn s ->
           case Map.get(s.injected, route, []) do
             [r | rest] -> {{:inject, r, s.delay[route]}, %{s | injected: Map.put(s.injected, route, rest)}}
             [] -> {{:normal, s.delay[route]}, s}
           end
         end) do
      {:inject, :close, _} ->
        :close

      {:inject, {status, body}, _} ->
        {status, body}

      {:normal, delay} ->
        if delay, do: :timer.sleep(delay)
        answer(st, route, path, body)
    end
  end

  defp route("POST", "/v1/actions/authorize"), do: "authorize"
  defp route("GET", "/v1/actions/" <> _), do: "get_action"

  defp route("POST", "/v1/plugins/" <> rest),
    do: "invoke:" <> (rest |> String.replace(~r{/tools/}, "/") |> String.replace_suffix("/invoke", ""))

  defp route("POST", "/v1/executions/begin"), do: "begin"
  defp route("POST", "/v1/executions/" <> _), do: "record"
  defp route(m, p), do: "#{m} #{p}"

  defp answer(st, "authorize", _path, %{"intent" => intent}) do
    mode = Agent.get(st, & &1.authorize)

    case mode do
      :allow ->
        {200, %{"decision" => "allow", "reasons" => [], "grant" => %{"id" => "grant_#{intent["id"]}", "signature" => "sig"}}}

      {:hold, kind} ->
        pid = "pending-#{map_size(Agent.get(st, & &1.pendings)) + 1}"
        Agent.update(st, &put_in(&1.pendings[pid], %{"state" => "pending"}))
        {200, %{"decision" => kind, "pending_id" => pid, "reasons" => ["held"]}}

      {:deny, reasons} ->
        {200, %{"decision" => "deny", "reasons" => reasons}}
    end
  end

  defp answer(st, "get_action", "/v1/actions/" <> id, _) do
    case Agent.get(st, &Map.get(&1.pendings, URI.decode(id))) do
      nil -> {404, %{"error" => %{"code" => "not_found", "message" => "no such request"}}}
      p -> {200, Map.merge(%{"pending_id" => id, "kind" => "user_confirmation"}, p)}
    end
  end

  defp answer(st, "invoke:" <> key, _, _) do
    case Agent.get(st, &Map.get(&1.plugin, key)) do
      nil -> {200, %{"status" => "ok", "result" => %{}, "proposed_intents" => []}}
      body -> {200, body}
    end
  end

  defp answer(st, "begin", _, %{"intent" => intent}) do
    key = intent["idempotency_key"]

    Agent.get_and_update(st, fn s ->
      case Map.get(s.executions, key) do
        nil ->
          {{200, %{"state" => "permitted", "execution_id" => "exec_#{key}", "reasons" => []}},
           put_in(s.executions[key], %{state: "started"})}

        %{state: "started"} ->
          {{200, %{"state" => "pending", "reasons" => []}}, s}

        %{state: "succeeded", result: r} ->
          {{200, %{"state" => "succeeded", "result" => r, "reasons" => []}}, s}

        %{state: "failed", result: r} ->
          {{200, %{"state" => "failed", "result" => r, "reasons" => []}}, s}
      end
    end)
  end

  defp answer(st, "record", "/v1/executions/" <> rest, %{"state" => state, "result" => result}) do
    "exec_" <> key = rest |> String.split("/") |> hd()
    Agent.update(st, &put_in(&1.executions[key], %{state: state, result: result}))
    {200, %{"state" => state, "receipt_hash" => "receipt_" <> key}}
  end

  defp answer(_, route, _, _), do: {404, %{"error" => %{"code" => "not_found", "message" => "fake has no #{route}"}}}
end
