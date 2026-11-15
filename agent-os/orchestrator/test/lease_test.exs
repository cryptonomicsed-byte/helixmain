defmodule Helix.LeaseTest do
  use ExUnit.Case, async: true
  alias Helix.Lease

  @moduletag :tmp_dir

  defp path(dir), do: Path.join(dir, "run.lease")

  test "the first taker gets fence 1; a second owner is refused while it is live", %{tmp_dir: dir} do
    assert {:ok, %{owner: "a", fence: 1}} = Lease.acquire(path(dir), "a", 1000, 0)
    assert {:error, {:held, %{owner: "a"}}} = Lease.acquire(path(dir), "b", 1000, 500)
    assert {:ok, %{fence: 1}} = Lease.acquire(path(dir), "a", 1000, 600), "the owner re-acquiring keeps its fence"
  end

  test "after expiry another owner takes over with a higher fence", %{tmp_dir: dir} do
    {:ok, _} = Lease.acquire(path(dir), "a", 1000, 0)
    assert {:ok, %{owner: "b", fence: 2}} = Lease.acquire(path(dir), "b", 1000, 1000)
    # and the old owner cannot renew what it lost
    assert {:error, :lost} = Lease.renew(path(dir), "a", 1000, 1001)
    assert {:ok, %{fence: 2}} = Lease.renew(path(dir), "b", 1000, 1500)
  end

  test "renewing keeps a live lease alive past its first expiry", %{tmp_dir: dir} do
    {:ok, _} = Lease.acquire(path(dir), "a", 1000, 0)
    {:ok, _} = Lease.renew(path(dir), "a", 1000, 900)
    assert {:error, {:held, _}} = Lease.acquire(path(dir), "b", 1000, 1500)
  end

  test "releasing makes it available at once, with a higher fence for the next owner", %{tmp_dir: dir} do
    {:ok, _} = Lease.acquire(path(dir), "a", 60_000, 0)
    assert :ok = Lease.release(path(dir), "b"), "only the owner can release"
    assert {:error, {:held, _}} = Lease.acquire(path(dir), "b", 1000, 10)
    assert :ok = Lease.release(path(dir), "a")
    assert {:ok, %{owner: "b", fence: 2}} = Lease.acquire(path(dir), "b", 1000, 20)
  end

  test "of many processes racing for a free lease exactly one wins", %{tmp_dir: dir} do
    results =
      1..20
      |> Task.async_stream(fn i -> Lease.acquire(path(dir), "owner-#{i}", 60_000, 0) end, max_concurrency: 20)
      |> Enum.map(fn {:ok, r} -> r end)

    assert Enum.count(results, &match?({:ok, _}, &1)) == 1
    assert Enum.count(results, &match?({:error, {:held, _}}, &1)) == 19
  end

  test "a lock left by a crashed holder does not block forever", %{tmp_dir: dir} do
    File.write!(path(dir) <> ".lock", "")
    old = System.os_time(:second) - 60
    File.touch!(path(dir) <> ".lock", old)
    assert {:ok, %{fence: 1}} = Lease.acquire(path(dir), "a", 1000, 0)
  end

  test "an unreadable lease file is treated as free, not as a crash", %{tmp_dir: dir} do
    File.write!(path(dir), "garbage")
    assert {:ok, %{fence: 1}} = Lease.acquire(path(dir), "a", 1000, 0)
  end
end
