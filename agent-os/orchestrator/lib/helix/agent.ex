defmodule Helix.Agent do
  @moduledoc """
  An agent as an actor: a supervised process with a persistent-shaped profile
  (sid, name, goals, preferences, memory namespace) and a mailbox, addressed by its SID.

  Agents talk to each other with `Helix.A2A`. A message carries **data, never
  authority**. The handler decides what to do with it, but anything with an
  effect still has to go through the gateway and the kernel as an intent, so
  a message cannot make an agent spend money or touch another tenant's
  memory, whoever sent it and whatever it says.

  The handler `fn message, profile -> {:reply, map} | :noreply end` runs in its
  own supervised task: if it crashes or runs too long, the sender gets an error and the agent
  carries on with the next message. Messages are handled one at a time, in order.
  A bounded mailbox pushes back (`{:error, :mailbox_full}`) instead of growing without limit.
  Delivery is **at-most-once per process lifetime with dedup by message id**: a retry of
  a message the agent already handled returns the same reply without running the
  handler again; if the agent process itself restarts, its dedup memory and queue
  restart empty (handlers should be idempotent).
  """
  use GenServer, restart: :permanent

  @sid_re ~r/\Asid_[a-z0-9][a-z0-9-]{0,63}\z/

  def start_link(args) do
    GenServer.start_link(__MODULE__, args, name: via(args.registry, args.sid))
  end

  def via(registry, sid), do: {:via, Registry, {registry, {:agent, sid}}}

  def profile(registry, sid), do: call(registry, sid, :profile)
  def stats(registry, sid), do: call(registry, sid, :stats)

  defp call(registry, sid, msg) do
    GenServer.call(via(registry, sid), msg, 5_000)
  catch
    :exit, {:noproc, _} -> {:error, :unknown_agent}
    :exit, _ -> {:error, :unavailable}
  end

  @doc false
  def deliver(registry, sid, envelope, timeout) do
    GenServer.call(via(registry, sid), {:deliver, envelope, timeout}, timeout + 1_000)
  catch
    :exit, {:noproc, _} -> {:error, :unknown_agent}
    :exit, {:timeout, _} -> {:error, :timeout}
    :exit, reason -> {:error, {:unavailable, inspect(reason)}}
  end

  # ── server ──────────────────────────────────────────────────────────────────
  @impl true
  def init(args) do
    unless is_binary(args.sid) and Regex.match?(@sid_re, args.sid), do: raise(ArgumentError, "an agent needs a sid_<slug> identifier")

    {:ok,
     %{
       sid: args.sid,
       profile: Map.put(args.profile, "sid", args.sid),
       handler: args.handler,
       task_sup: args.task_sup,
       mailbox_limit: Map.get(args, :mailbox_limit, 100),
       dedup_limit: Map.get(args, :dedup_limit, 1_000),
       queue: :queue.new(),
       busy: nil,
       seen: %{},
       seen_order: :queue.new(),
       handled: 0,
       crashed: 0
     }}
  end

  @impl true
  def handle_call(:profile, _from, st), do: {:reply, st.profile, st}

  def handle_call(:stats, _from, st),
    do: {:reply, %{queued: :queue.len(st.queue), handled: st.handled, crashed: st.crashed, busy: st.busy != nil}, st}

  def handle_call({:deliver, env, timeout}, from, st) do
    case Map.get(st.seen, env["id"]) do
      {:done, reply} ->
        {:reply, reply, st}

      :in_flight ->
        # a retry of a message still being handled: it will get the answer from the first delivery
        {:noreply, enqueue_waiter(st, env, from, timeout)}

      nil ->
        if :queue.len(st.queue) >= st.mailbox_limit do
          {:reply, {:error, :mailbox_full}, st}
        else
          st = %{st | seen: Map.put(st.seen, env["id"], :in_flight)}
          {:noreply, pump(%{st | queue: :queue.in({env, [from], timeout}, st.queue)})}
        end
    end
  end

  defp enqueue_waiter(st, env, from, _timeout) do
    # attach the retrying caller to the queued or running delivery of the same id
    queue =
      :queue.to_list(st.queue)
      |> Enum.map(fn {e, froms, t} -> if e["id"] == env["id"], do: {e, [from | froms], t}, else: {e, froms, t} end)
      |> :queue.from_list()

    busy_id = st.busy && st.busy.env["id"]

    if busy_id == env["id"],
      do: %{st | queue: queue, busy: %{st.busy | froms: [from | st.busy.froms]}},
      else: %{st | queue: queue}
  end

  defp pump(%{busy: nil} = st) do
    case :queue.out(st.queue) do
      {:empty, _} ->
        st

      {{:value, {env, froms, timeout}}, rest} ->
        handler = st.handler
        profile = st.profile
        t = Task.Supervisor.async_nolink(st.task_sup, fn -> handler.(env, profile) end)
        timer = Process.send_after(self(), {:handler_timeout, t.ref}, timeout)
        %{st | queue: rest, busy: %{ref: t.ref, pid: t.pid, env: env, froms: froms, timer: timer}}
    end
  end

  defp pump(st), do: st

  @impl true
  def handle_info({ref, result}, %{busy: %{ref: ref}} = st) do
    Process.demonitor(ref, [:flush])

    reply =
      case result do
        {:reply, %{} = body} -> {:ok, body}
        :noreply -> {:ok, nil}
        other -> {:error, {:bad_handler_result, inspect(other, limit: 5)}}
      end

    {:noreply, finish(st, reply, if(match?({:error, _}, reply), do: :crashed, else: :handled))}
  end

  def handle_info({:DOWN, ref, :process, _, reason}, %{busy: %{ref: ref}} = st),
    do: {:noreply, finish(st, {:error, {:handler_crashed, inspect(reason, limit: 5)}}, :crashed)}

  def handle_info({:handler_timeout, ref}, %{busy: %{ref: ref, pid: pid}} = st) do
    Task.Supervisor.terminate_child(st.task_sup, pid)
    {:noreply, finish(st, {:error, :handler_timeout}, :crashed)}
  end

  def handle_info(_, st), do: {:noreply, st}

  defp finish(%{busy: %{ref: ref, env: env, froms: froms, timer: timer}} = st, reply, kind) do
    Process.cancel_timer(timer)
    Process.demonitor(ref, [:flush])
    for f <- froms, do: GenServer.reply(f, reply)

    st = remember(st, env["id"], reply)
    st = %{st | busy: nil, handled: st.handled + 1, crashed: st.crashed + if(kind == :crashed, do: 1, else: 0)}
    pump(st)
  end

  defp remember(st, id, reply) do
    seen = Map.put(st.seen, id, {:done, reply})
    order = :queue.in(id, st.seen_order)

    if :queue.len(order) > st.dedup_limit do
      {{:value, old}, order} = :queue.out(order)
      %{st | seen: Map.delete(seen, old), seen_order: order}
    else
      %{st | seen: seen, seen_order: order}
    end
  end
end
