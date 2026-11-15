defmodule Helix.Gateway do
  @moduledoc """
  A client for the HELIX gateway (`agent-os/gateway`, Go).

  One value is one identity: a base URL and the bearer token of ONE principal
  (the orchestrator, an executor, a person's app). The token is never logged or
  included in an error. Plain `http://` is accepted only for loopback; anything
  else must be `https://` with the certificate verified.

  Results are `{:ok, status, body}` for 2xx, `{:error, {:http, status, code,
  message}}` for the gateway's own error answers, and `{:error, {:transport,
  reason}}` when no answer came. `retryable?/1` says which failures are worth
  trying again: transport errors, 429, 502, 503, 504. A 4xx (a refusal, a
  validation error) is never retried: asking again does not change the answer.
  """

  @enforce_keys [:base_url, :token]
  defstruct [:base_url, :token, timeout_ms: 10_000]

  @type t :: %__MODULE__{base_url: String.t(), token: String.t(), timeout_ms: pos_integer}
  @type error :: {:transport, term} | {:http, pos_integer, String.t(), String.t()}

  @max_body 12 * 1024 * 1024

  @spec new(String.t(), String.t(), keyword) :: t
  def new(base_url, token, opts \\ []) when is_binary(base_url) and is_binary(token) do
    uri = URI.parse(base_url)

    cond do
      uri.scheme == "https" and uri.host not in [nil, ""] -> :ok
      uri.scheme == "http" and uri.host in ["127.0.0.1", "localhost", "::1"] -> :ok
      true -> raise ArgumentError, "the gateway must be https, or http on loopback: #{base_url}"
    end

    if token == "", do: raise(ArgumentError, "a token is required")
    %__MODULE__{base_url: String.trim_trailing(base_url, "/"), token: token, timeout_ms: Keyword.get(opts, :timeout_ms, 10_000)}
  end

  # Never print the token, whatever a caller does with the struct.
  defimpl Inspect do
    def inspect(gw, _opts), do: "#Helix.Gateway<#{gw.base_url}, token: ***>"
  end

  @spec request(t, :get | :post | :put | :delete, String.t(), map | nil) :: {:ok, pos_integer, map} | {:error, error}
  def request(%__MODULE__{} = gw, method, path, body \\ nil) do
    url = String.to_charlist(gw.base_url <> path)
    headers = [{~c"authorization", String.to_charlist("Bearer " <> gw.token)}, {~c"accept", ~c"application/json"}]

    req =
      if body == nil and method in [:get, :delete],
        do: {url, headers},
        else: {url, headers, ~c"application/json", Helix.JSON.encode!(body || %{})}

    http_opts =
      [timeout: gw.timeout_ms, connect_timeout: min(gw.timeout_ms, 5_000), autoredirect: false] ++
        if(String.starts_with?(gw.base_url, "https://"),
          do: [
            ssl: [
              verify: :verify_peer,
              cacerts: :public_key.cacerts_get(),
              customize_hostname_check: [match_fun: :public_key.pkix_verify_hostname_match_fun(:https)]
            ]
          ],
          else: []
        )

    case :httpc.request(method, req, http_opts, body_format: :binary) do
      {:ok, {{_, status, _}, _headers, resp}} when byte_size(resp) <= @max_body -> answer(status, resp)
      {:ok, {{_, _status, _}, _headers, _resp}} -> {:error, {:transport, :response_too_large}}
      {:error, reason} -> {:error, {:transport, scrub(reason)}}
    end
  end

  defp answer(status, resp) do
    decoded = if resp == "", do: {:ok, %{}}, else: Helix.JSON.decode(resp)

    case {status, decoded} do
      {s, {:ok, %{} = b}} when s in 200..299 -> {:ok, s, b}
      {s, {:ok, %{"error" => %{"code" => c, "message" => m}}}} -> {:error, {:http, s, to_string(c), to_string(m)}}
      {s, _} when s in 200..299 -> {:error, {:transport, :bad_json_from_gateway}}
      {s, _} -> {:error, {:http, s, "unknown", "the gateway answered #{s}"}}
    end
  end

  # an error term must never carry a request (and so a header) back to a caller
  defp scrub({:failed_connect, parts}),
    do:
      {:failed_connect,
       Enum.map(parts, fn
         {kind, _where, why} -> {kind, why}
         other -> other
       end)}

  defp scrub(other), do: other

  @spec retryable?(error) :: boolean
  def retryable?({:transport, _}), do: true
  def retryable?({:http, s, _, _}) when s in [429, 502, 503, 504], do: true
  def retryable?(_), do: false

  # ── the endpoints an orchestrator uses ─────────────────────────────────────
  def health(gw), do: request(gw, :get, "/v1/health")
  def authorize(gw, intent), do: request(gw, :post, "/v1/actions/authorize", %{"intent" => intent})
  def get_action(gw, id), do: request(gw, :get, "/v1/actions/" <> URI.encode(id, &URI.char_unreserved?/1))

  def confirm(gw, id, approve?),
    do: request(gw, :post, "/v1/actions/" <> URI.encode(id, &URI.char_unreserved?/1) <> "/confirm", %{"approve" => approve?})

  def invoke_plugin(gw, plugin, tool, input, agent_id \\ nil) do
    body = if agent_id, do: %{"input" => input, "agent_id" => agent_id}, else: %{"input" => input}
    request(gw, :post, "/v1/plugins/#{enc(plugin)}/tools/#{enc(tool)}/invoke", body)
  end

  def begin_execution(gw, grant, intent), do: request(gw, :post, "/v1/executions/begin", %{"grant" => grant, "intent" => intent})

  def record_result(gw, execution_id, state, result),
    do: request(gw, :post, "/v1/executions/#{enc(execution_id)}/result", %{"state" => state, "result" => result})

  defp enc(s), do: URI.encode(s, &URI.char_unreserved?/1)
end
