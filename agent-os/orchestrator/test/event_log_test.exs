defmodule Helix.EventLogTest do
  use ExUnit.Case, async: true
  alias Helix.EventLog

  @moduletag :tmp_dir

  defp fresh(dir), do: Path.join(dir, "run.log")

  test "events are appended in order and read back verified", %{tmp_dir: dir} do
    {:ok, log} = EventLog.open(fresh(dir))
    {:ok, log, e1} = EventLog.append(log, "a", %{"n" => 1}, 1)
    {:ok, _log, e2} = EventLog.append(log, "b", %{"n" => 2}, 1)
    assert e1["seq"] == 1 and e2["seq"] == 2 and e2["prev"] == e1["hash"]

    assert {:ok, [x, y], false} = EventLog.read(fresh(dir))
    assert {x["type"], y["type"], y["data"]} == {"a", "b", %{"n" => 2}}
  end

  test "a log reopened later continues the same chain", %{tmp_dir: dir} do
    {:ok, log} = EventLog.open(fresh(dir))
    {:ok, _, _} = EventLog.append(log, "a", %{}, 1)
    {:ok, again} = EventLog.open(fresh(dir))
    assert again.seq == 1
    {:ok, _, e} = EventLog.append(again, "b", %{}, 1)
    assert e["seq"] == 2
    assert {:ok, [_, _], false} = EventLog.read(fresh(dir))
  end

  test "a stale handle cannot fork the log: append re-reads the head", %{tmp_dir: dir} do
    {:ok, a} = EventLog.open(fresh(dir))
    {:ok, b} = EventLog.open(fresh(dir))
    {:ok, _, _} = EventLog.append(a, "from-a", %{}, 1)
    {:ok, _, e} = EventLog.append(b, "from-b", %{}, 1)
    assert e["seq"] == 2
    assert {:ok, [_, _], false} = EventLog.read(fresh(dir))
  end

  test "a record cut short by a crash is a torn tail: dropped, the rest still reads", %{tmp_dir: dir} do
    {:ok, log} = EventLog.open(fresh(dir))
    {:ok, log, _} = EventLog.append(log, "a", %{}, 1)
    {:ok, _, _} = EventLog.append(log, "b", %{}, 1)
    bin = File.read!(fresh(dir))
    File.write!(fresh(dir), binary_part(bin, 0, byte_size(bin) - 7))
    assert {:ok, [only], true} = EventLog.read(fresh(dir))
    assert only["type"] == "a"
    # and appending continues from the last whole record
    {:ok, again} = EventLog.open(fresh(dir))
    assert again.seq == 1
  end

  test "a whole record that was altered is corruption, and says where", %{tmp_dir: dir} do
    {:ok, log} = EventLog.open(fresh(dir))
    {:ok, log, _} = EventLog.append(log, "a", %{"amount" => 100}, 1)
    {:ok, _, _} = EventLog.append(log, "b", %{}, 1)
    bin = File.read!(fresh(dir))
    File.write!(fresh(dir), String.replace(bin, "\"amount\":100", "\"amount\":999"))
    assert {:error, {:corrupt, 1, why}} = EventLog.read(fresh(dir))
    assert why =~ "hash"
  end

  test "a deleted record breaks the chain", %{tmp_dir: dir} do
    {:ok, log} = EventLog.open(fresh(dir))
    {:ok, log, _} = EventLog.append(log, "a", %{}, 1)
    {:ok, log, _} = EventLog.append(log, "b", %{}, 1)
    {:ok, _, _} = EventLog.append(log, "c", %{}, 1)
    <<l1::32, _r1::binary-size(l1), l2::32, _r2::binary-size(l2), rest::binary>> = File.read!(fresh(dir))
    first = binary_part(File.read!(fresh(dir)), 0, 4 + l1)
    File.write!(fresh(dir), first <> rest)
    assert {:error, {:corrupt, 2, _}} = EventLog.read(fresh(dir))
  end

  test "a writer holding an old fence is refused", %{tmp_dir: dir} do
    {:ok, log} = EventLog.open(fresh(dir))
    {:ok, log, _} = EventLog.append(log, "mine", %{}, 1)
    {:ok, log, _} = EventLog.append(log, "successor", %{}, 2)
    assert {:error, :stale_fence} = EventLog.append(log, "zombie", %{}, 1)
    assert {:ok, events, false} = EventLog.read(fresh(dir))
    assert Enum.map(events, & &1["type"]) == ["mine", "successor"]
    # the same fence may keep writing
    assert {:ok, _, _} = EventLog.append(log, "more", %{}, 2)
  end

  test "an empty or missing log is simply empty", %{tmp_dir: dir} do
    assert {:ok, [], false} = EventLog.read(fresh(dir))
    {:ok, log} = EventLog.open(fresh(dir))
    assert {log.seq, log.fence} == {0, 0}
  end
end
