defmodule Helix.Executor do
  @moduledoc """
  The executor side of the kernel's authorize / execute split.

  An executor is a SERVICE principal (its own gateway token). It never decides
  whether something may happen: it holds a grant, and before it does anything it
  asks the kernel for the one permit per idempotency key (`begin_execution`).
  Only a `permitted` answer lets it act; then it records what the provider
  really said.

      config = %{gateway: Helix.Gateway.new(url, executor_token),
                 provider: fn intent, execution_id -> {:ok, %{"order" => "o_1"}} end}

  `provider` returns:

    * `{:ok, result}`: the provider confirmed. Recorded as `succeeded`.
    * `{:error, reason}`: the provider definitively refused or failed (nothing happened). Recorded as `failed`.
    * `{:ambiguous, why}`, **or any crash, timeout or raise**: we do not know whether the effect happened.
      It is NOT recorded: the execution stays `pending` for reconciliation, and the run stops with
      `{:execution_ambiguous, ...}`. Recording `failed` here would let a retry spend the money twice.

  Asking again for an execution that already has an outcome returns that
  outcome (`replayed: true`) and never a second permit, which is what makes a
  restarted workflow safe.
  """

  alias Helix.Gateway

  @type config :: %{required(:gateway) => Gateway.t(), required(:provider) => (map, String.t() -> term)}

  @spec run(config, map, map) :: {:ok, map} | {:error, term}
  def run(%{gateway: gw, provider: provider}, grant, intent) when is_function(provider, 2) do
    case Gateway.begin_execution(gw, grant, intent) do
      {:ok, _, %{"state" => "permitted", "execution_id" => id}} -> act(gw, provider, id, intent)
      {:ok, _, %{"state" => "succeeded"} = b} -> {:ok, %{"state" => "succeeded", "result" => b["result"], "replayed" => true}}
      {:ok, _, %{"state" => "failed"} = b} -> {:error, {:execution_failed, b["result"]}}
      {:ok, _, %{"state" => "pending"}} -> {:error, :execution_in_progress}
      {:ok, _, %{"state" => "refused"} = b} -> {:error, {:execution_refused, b["reasons"] || []}}
      {:ok, _, other} -> {:error, {:unexpected_answer, other}}
      {:error, e} -> {:error, e}
    end
  end

  defp act(gw, provider, execution_id, intent) do
    outcome =
      try do
        provider.(intent, execution_id)
      rescue
        e -> {:ambiguous, {:raised, Exception.message(e)}}
      catch
        kind, reason -> {:ambiguous, {kind, reason}}
      end

    case outcome do
      {:ok, result} when is_map(result) ->
        record(gw, execution_id, "succeeded", result, fn receipt ->
          %{"state" => "succeeded", "result" => result, "receipt_hash" => receipt}
        end)

      {:error, reason} ->
        case record(gw, execution_id, "failed", %{"error" => inspect(reason)}, fn receipt -> %{"receipt_hash" => receipt} end) do
          {:ok, _} -> {:error, {:execution_failed, reason}}
          err -> err
        end

      {:ambiguous, why} ->
        {:error, {:execution_ambiguous, execution_id, why}}

      other ->
        {:error, {:execution_ambiguous, execution_id, {:provider_returned, other}}}
    end
  end

  # The provider's outcome is already real. If recording it fails, say so loudly: the effect HAPPENED.
  defp record(gw, execution_id, state, result, ok) do
    case Gateway.record_result(gw, execution_id, state, result) do
      {:ok, _, %{"receipt_hash" => r}} -> {:ok, ok.(r)}
      {:ok, _, other} -> {:error, {:execution_unrecorded, execution_id, {:unexpected_answer, other}}}
      {:error, e} -> {:error, {:execution_unrecorded, execution_id, e}}
    end
  end
end
