defmodule Helix.Lease do
  @moduledoc """
  Workflow leases: at most one runner owns a workflow run at a time.

  A lease is a small file `{owner, fence, expires_at_ms}`. `acquire/4` takes it
  if it is free, expired, or already the caller's; `renew/4` extends it for its
  owner; `release/3` gives it up. Each hand-over to a new owner (or after
  expiry) increases the **fence**, a number that only goes up. The event log
  refuses writes under a lower fence than it has seen, so a runner that is
  paused, partitioned, or simply slow, and that loses its lease without
  noticing, cannot corrupt the run its successor is now driving.

  The read-decide-write is done under an exclusive lock file, so it is safe
  between processes on one host (and on a shared filesystem with working
  exclusive create). **A lease between machines needs a real lock service**
  (etcd, Postgres advisory locks, a database row): this module is the contract
  and the single-host implementation.
  """

  @lock_stale_ms 10_000

  @type lease :: %{owner: String.t(), fence: pos_integer, expires_at: integer}

  @spec acquire(Path.t(), String.t(), pos_integer, integer) :: {:ok, lease} | {:error, {:held, lease}}
  def acquire(path, owner, ttl_ms, now_ms) do
    locked(path, fn ->
      case read(path) do
        nil ->
          write(path, %{owner: owner, fence: 1, expires_at: now_ms + ttl_ms})

        %{owner: ^owner} = l ->
          # still mine: extend, same fence
          write(path, %{l | expires_at: now_ms + ttl_ms})

        %{expires_at: exp} = l when exp <= now_ms ->
          write(path, %{owner: owner, fence: l.fence + 1, expires_at: now_ms + ttl_ms})

        l ->
          {:error, {:held, l}}
      end
    end)
  end

  @spec renew(Path.t(), String.t(), pos_integer, integer) :: {:ok, lease} | {:error, :lost}
  def renew(path, owner, ttl_ms, now_ms) do
    locked(path, fn ->
      case read(path) do
        %{owner: ^owner} = l -> write(path, %{l | expires_at: now_ms + ttl_ms})
        _ -> {:error, :lost}
      end
    end)
  end

  @spec release(Path.t(), String.t()) :: :ok
  def release(path, owner) do
    locked(path, fn ->
      case read(path) do
        %{owner: ^owner} = l -> write(path, %{l | expires_at: 0}) && :ok
        _ -> :ok
      end
    end)
  end

  @spec current(Path.t()) :: lease | nil
  def current(path), do: read(path)

  defp read(path) do
    with {:ok, bin} <- File.read(path),
         {:ok, %{"owner" => o, "fence" => f, "expires_at" => e}} when is_binary(o) and is_integer(f) and is_integer(e) <-
           Helix.JSON.decode(bin) do
      %{owner: o, fence: f, expires_at: e}
    else
      _ -> nil
    end
  end

  defp write(path, %{owner: o, fence: f, expires_at: e} = lease) do
    tmp = path <> ".tmp"
    File.write!(tmp, Helix.JSON.encode!(%{"owner" => o, "fence" => f, "expires_at" => e}), [:sync])
    File.rename!(tmp, path)
    {:ok, lease}
  end

  # An exclusive lock file around the read-decide-write.
  defp locked(path, fun) do
    File.mkdir_p!(Path.dirname(path))
    lock = path <> ".lock"
    take(lock, 200)

    try do
      fun.()
    after
      File.rm(lock)
    end
  end

  defp take(_lock, 0), do: raise("could not take the lease lock")

  defp take(lock, tries) do
    case File.open(lock, [:write, :exclusive]) do
      {:ok, io} ->
        File.close(io)

      {:error, :eexist} ->
        # a crashed holder must not block the lease forever
        stale? =
          case File.stat(lock, time: :posix) do
            {:ok, %{mtime: m}} -> System.os_time(:second) - m > div(@lock_stale_ms, 1000)
            _ -> false
          end

        if stale?, do: File.rm(lock), else: :timer.sleep(5)

        take(lock, tries - 1)

      {:error, e} ->
        raise "lease lock: #{inspect(e)}"
    end
  end
end
