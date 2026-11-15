defmodule Helix.EventLog do
  @moduledoc """
  A durable, append-only, hash-chained log: one file per workflow run.

  Each record is `<<length::32, json::binary>>`; the JSON carries `seq`, `ts`,
  `type`, `data`, `fence`, `prev` and `hash`, where `hash` is the SHA-256 of
  `prev` and the canonical JSON of the rest. Every append is written to the file
  and synced before it returns, so an acknowledged event survives a crash.

  Reading verifies the chain. A record cut short by a crash (a length prefix
  with fewer bytes behind it) is a torn tail: it is dropped and the log is
  readable up to the last whole record. A record that is whole but wrong (a
  broken hash, a gap or a repeat in `seq`) is corruption: the read fails and
  says where, because silently skipping it would let a run continue from state
  nobody wrote.

  **Fencing.** Every append carries the fencing token of the lease its writer
  holds. A token lower than the highest one in the log is refused
  (`{:error, :stale_fence}`): a runner that lost its lease and does not know it
  cannot write after its successor has.
  """

  @genesis "genesis"

  defstruct [:path, :seq, :prev, :fence]

  @type t :: %__MODULE__{path: Path.t(), seq: non_neg_integer, prev: String.t(), fence: non_neg_integer}

  @doc "Open (creating if needed) the log at `path`, reading its current head."
  @spec open(Path.t()) :: {:ok, t} | {:error, term}
  def open(path) do
    File.mkdir_p!(Path.dirname(path))
    File.touch!(path)

    with {:ok, events, _torn} <- read(path) do
      {seq, prev, fence} =
        case List.last(events) do
          nil -> {0, @genesis, 0}
          last -> {last["seq"], last["hash"], events |> Enum.map(& &1["fence"]) |> Enum.max()}
        end

      {:ok, %__MODULE__{path: path, seq: seq, prev: prev, fence: fence}}
    end
  end

  @doc "Append an event. Returns the updated log handle and the stored event."
  @spec append(t, String.t(), map, non_neg_integer) :: {:ok, t, map} | {:error, :stale_fence | term}
  def append(%__MODULE__{} = log, type, data, fence) when is_binary(type) and is_map(data) and is_integer(fence) do
    # Another writer may have appended since this handle was opened: re-read the head.
    with {:ok, head} <- open(log.path) do
      if fence < head.fence do
        {:error, :stale_fence}
      else
        body = %{"seq" => head.seq + 1, "ts" => now(), "type" => type, "data" => data, "fence" => fence}
        hash = hash(head.prev, body)
        event = Map.merge(body, %{"prev" => head.prev, "hash" => hash})
        json = Helix.JSON.encode!(event)

        with {:ok, io} <- File.open(log.path, [:append, :binary, :raw, :sync]),
             :ok <- :file.write(io, <<byte_size(json)::32, json::binary>>),
             :ok <- :file.sync(io),
             :ok <- File.close(io) do
          {:ok, %{head | seq: head.seq + 1, prev: hash, fence: fence}, event}
        end
      end
    end
  end

  @doc "Read and verify the whole log: `{:ok, events, torn_tail?}` or `{:error, {:corrupt, seq, why}}`."
  @spec read(Path.t()) :: {:ok, [map], boolean} | {:error, term}
  def read(path) do
    case File.read(path) do
      {:ok, bin} -> parse(bin, [], @genesis, 0, 0)
      {:error, :enoent} -> {:ok, [], false}
      {:error, e} -> {:error, e}
    end
  end

  defp parse(<<>>, acc, _prev, _seq, _fence), do: {:ok, Enum.reverse(acc), false}

  defp parse(<<len::32, rest::binary>>, acc, prev, seq, fence) when byte_size(rest) >= len do
    <<json::binary-size(len), tail::binary>> = rest

    with {:ok, ev} when is_map(ev) <- Helix.JSON.decode(json),
         :ok <- check(ev, prev, seq + 1, fence) do
      parse(tail, [ev | acc], ev["hash"], seq + 1, max(fence, ev["fence"]))
    else
      {:error, why} -> {:error, {:corrupt, seq + 1, why}}
      _ -> {:error, {:corrupt, seq + 1, "not a JSON object"}}
    end
  end

  # fewer bytes behind the length prefix than it promises (or fewer than 4 for the prefix): a torn tail
  defp parse(_torn, acc, _prev, _seq, _fence), do: {:ok, Enum.reverse(acc), true}

  defp check(ev, prev, seq, max_fence) do
    body = Map.drop(ev, ["hash", "prev"])

    cond do
      ev["seq"] != seq -> {:error, "sequence is #{inspect(ev["seq"])}, expected #{seq}"}
      ev["prev"] != prev -> {:error, "the chain is broken"}
      ev["hash"] != hash(prev, body) -> {:error, "the hash does not match the record"}
      not is_integer(ev["fence"]) or ev["fence"] < max_fence -> {:error, "a record was written under a stale fence"}
      true -> :ok
    end
  end

  defp hash(prev, body), do: :crypto.hash(:sha256, [prev, "\n", Helix.JSON.encode!(body)]) |> Base.encode16(case: :lower)

  defp now, do: DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()
end
