defmodule Helix.A2A do
  @moduledoc """
  Agent-to-agent messages.

      {:ok, reply} = Helix.A2A.request(registry, "sid_barista", "sid_supplier", "quote.request", %{"sku" => "beans"})

  An envelope is `%{"id", "from", "to", "type", "body", "sent_at"}`: validated
  before delivery (sids, a dotted type, a JSON object body of at most 64 KiB).
  Pass the same `id:` when retrying and the receiver answers from its dedup
  memory instead of handling the message twice.

  A message carries data, never authority (see `Helix.Agent`).
  """

  @sid_re ~r/\Asid_[a-z0-9][a-z0-9-]{0,63}\z/
  @type_re ~r/\A[a-z][a-z0-9_.]{0,63}\z/
  @max_body 64 * 1024

  @spec request(atom | pid, String.t(), String.t(), String.t(), map, keyword) :: {:ok, map | nil} | {:error, term}
  def request(registry, from, to, type, body, opts \\ []) do
    timeout = Keyword.get(opts, :timeout, 5_000)

    with {:ok, env} <- envelope(from, to, type, body, Keyword.get(opts, :id)) do
      Helix.Agent.deliver(registry, to, env, timeout)
    end
  end

  @doc false
  def envelope(from, to, type, body, id \\ nil) do
    cond do
      not (is_binary(from) and Regex.match?(@sid_re, from)) ->
        {:error, :invalid_envelope}

      not (is_binary(to) and Regex.match?(@sid_re, to)) ->
        {:error, :invalid_envelope}

      not (is_binary(type) and Regex.match?(@type_re, type)) ->
        {:error, :invalid_envelope}

      not is_map(body) ->
        {:error, :invalid_envelope}

      not (is_nil(id) or (is_binary(id) and byte_size(id) in 8..128)) ->
        {:error, :invalid_envelope}

      true ->
        encoded =
          try do
            Helix.JSON.encode!(body)
          rescue
            _ -> nil
          end

        if encoded == nil or byte_size(encoded) > @max_body do
          {:error, :invalid_envelope}
        else
          {:ok,
           %{
             "id" => id || Base.encode16(:crypto.strong_rand_bytes(12), case: :lower),
             "from" => from,
             "to" => to,
             "type" => type,
             "body" => body,
             "sent_at" => DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()
           }}
        end
    end
  end
end
