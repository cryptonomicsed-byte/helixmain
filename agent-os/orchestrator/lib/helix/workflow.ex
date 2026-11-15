defmodule Helix.Workflow do
  @moduledoc """
  Workflow definitions: plain data (so an agent can author one as JSON), checked
  strictly before anything runs.

      %{"id" => "buy-coffee",
        "steps" => [
          %{"id" => "co",   "kind" => "invoke_plugin", "plugin" => "acme.pricing", "tool" => "checkout", "agent" => "sid_barista",
            "input" => %{"currency" => "USD", "items" => [%{"$ref" => "inputs.basket"}]}},
          %{"id" => "auth", "kind" => "authorize", "intent_from" => "co.proposed_intents.0", "intent_with" => %{"audience" => "svc:merchant"}},
          %{"id" => "buy",  "kind" => "execute", "from" => "auth", "executor" => "merchant"}]}

  Step kinds:

    * `invoke_plugin`: run a plugin tool (a pure computation that may PROPOSE intents).
    * `authorize`: send an intent to the kernel. Allowed: carries on with the grant.
      Held for a person: the run parks (`awaiting`), durably, until they answer.
      Denied: the run fails, or carries on if `"on_deny" => "continue"`.
    * `execute`: hand an authorized intent and its grant to a named executor.
    * `parallel`: branches that run at the same time; all must succeed.
    * `set`: compute a value from earlier results.

  A value of the form `%{"$ref" => "step.field.0.sub"}` is replaced by an earlier
  step's output (or by `inputs.<field>`); a reference to something that does
  not exist fails the step rather than becoming `nil`. References may only name
  steps that come EARLIER (checked when the workflow is validated), and a step
  inside a `parallel` branch cannot see its siblings.
  """

  @id_re ~r/\A[a-z][a-z0-9_]{0,31}\z/
  @wf_id_re ~r/\A[a-z][a-z0-9_-]{0,63}\z/
  @sid_re ~r/\Asid_[a-z0-9][a-z0-9-]{0,63}\z/
  @max_steps 200
  @max_depth 3

  @common ~w(id kind)
  @allowed %{
    "invoke_plugin" => @common ++ ~w(plugin tool input agent),
    "authorize" => @common ++ ~w(intent intent_from intent_with on_deny timeout_ms),
    "execute" => @common ++ ~w(from executor),
    "parallel" => @common ++ ~w(branches),
    "set" => @common ++ ~w(value)
  }

  @spec validate(term) :: {:ok, map} | {:error, [String.t()]}
  def validate(%{"id" => id, "steps" => steps} = wf) when is_list(steps) do
    extra = Map.keys(wf) -- ["id", "steps"]

    errors =
      [
        if(extra != [], do: "unknown workflow field(s): #{Enum.join(extra, ", ")}"),
        if(not (is_binary(id) and Regex.match?(@wf_id_re, id)), do: "workflow id must match #{inspect(Regex.source(@wf_id_re))}"),
        if(steps == [], do: "a workflow needs at least one step"),
        if(count(steps) > @max_steps, do: "at most #{@max_steps} steps")
      ]
      |> Enum.reject(&is_nil/1)

    {step_errors, _seen} = check_steps(steps, MapSet.new(["inputs"]), MapSet.new(), 1)
    all = errors ++ step_errors
    if all == [], do: {:ok, wf}, else: {:error, all}
  end

  def validate(_), do: {:error, ["a workflow is %{\"id\" => ..., \"steps\" => [...]}"]}

  defp count(steps),
    do:
      Enum.reduce(steps, 0, fn s, n ->
        n + 1 + if(is_map(s) and is_list(s["branches"]), do: s["branches"] |> List.flatten() |> count(), else: 0)
      end)

  # `visible` = ids a reference may name here; `declared` = every id used so far (they must be unique across the whole workflow)
  defp check_steps(steps, visible, declared, depth) do
    Enum.reduce(steps, {[], declared}, fn step, {errs, declared_acc} ->
      {e, d} = check_step(step, visible_for(visible, declared_acc, errs), declared_acc, depth)
      {errs ++ e, d}
    end)
  end

  # outer steps declared so far are visible to later steps
  defp visible_for(base, declared, _), do: MapSet.union(base, declared)

  defp check_step(%{"id" => id, "kind" => kind} = step, visible, declared, depth) when is_binary(id) and is_binary(kind) do
    base =
      cond do
        not Regex.match?(@id_re, id) -> ["step #{inspect(id)}: id must match #{inspect(Regex.source(@id_re))}"]
        id == "inputs" -> ["step id \"inputs\" is reserved"]
        MapSet.member?(declared, id) -> ["step #{id}: the id is used twice"]
        true -> []
      end

    case Map.fetch(@allowed, kind) do
      :error ->
        {base ++ ["step #{id}: unknown kind #{inspect(kind)}"], MapSet.put(declared, id)}

      {:ok, allowed} ->
        unknown = Map.keys(step) -- allowed
        base = base ++ if(unknown != [], do: ["step #{id}: unknown field(s) #{Enum.join(unknown, ", ")}"], else: [])
        {errs, declared} = check_kind(kind, id, step, visible, MapSet.put(declared, id), depth)
        {base ++ errs, declared}
    end
  end

  defp check_step(other, _visible, declared, _depth), do: {["a step needs an id and a kind: #{inspect(other, limit: 3)}"], declared}

  defp check_kind("invoke_plugin", id, s, vis, declared, _d) do
    errs =
      [
        req_string(s, "plugin", id),
        req_string(s, "tool", id),
        if(Map.has_key?(s, "agent") and not (is_binary(s["agent"]) and Regex.match?(@sid_re, s["agent"])),
          do: "step #{id}: agent must be a sid_<slug>"
        ),
        if(not Map.has_key?(s, "input"), do: "step #{id}: input is required")
      ]
      |> Enum.reject(&is_nil/1)

    {errs ++ refs_in(s["input"], vis, id), declared}
  end

  defp check_kind("authorize", id, s, vis, declared, _d) do
    has_intent = Map.has_key?(s, "intent")
    has_from = Map.has_key?(s, "intent_from")

    errs =
      [
        if(has_intent == has_from, do: "step #{id}: give exactly one of intent and intent_from"),
        if(has_intent and not is_map(s["intent"]), do: "step #{id}: intent must be an object"),
        if(has_from and not valid_path?(s["intent_from"], vis), do: "step #{id}: intent_from must be a path into an earlier step"),
        if(Map.has_key?(s, "intent_with") and not is_map(s["intent_with"]), do: "step #{id}: intent_with must be an object"),
        if(Map.get(s, "on_deny", "fail") not in ["fail", "continue"], do: "step #{id}: on_deny must be fail or continue"),
        if(Map.has_key?(s, "timeout_ms") and not (is_integer(s["timeout_ms"]) and s["timeout_ms"] in 1..604_800_000),
          do: "step #{id}: timeout_ms must be 1..604800000"
        )
      ]
      |> Enum.reject(&is_nil/1)

    {errs ++ refs_in(s["intent"], vis, id) ++ refs_in(s["intent_with"], vis, id), declared}
  end

  defp check_kind("execute", id, s, vis, declared, _d) do
    errs =
      [
        req_string(s, "from", id),
        req_string(s, "executor", id),
        if(is_binary(s["from"]) and not MapSet.member?(vis, s["from"]),
          do: "step #{id}: from names #{inspect(s["from"])}, which is not an earlier step"
        )
      ]
      |> Enum.reject(&is_nil/1)

    {errs, declared}
  end

  defp check_kind("set", id, s, vis, declared, _d) do
    errs = if Map.has_key?(s, "value"), do: [], else: ["step #{id}: value is required"]
    {errs ++ refs_in(s["value"], vis, id), declared}
  end

  defp check_kind("parallel", id, s, vis, declared, depth) do
    branches = s["branches"]

    cond do
      depth >= @max_depth ->
        {["step #{id}: parallel steps nest at most #{@max_depth - 1} deep"], declared}

      not (is_list(branches) and length(branches) in 2..8 and Enum.all?(branches, &(is_list(&1) and &1 != []))) ->
        {["step #{id}: branches must be 2 to 8 non-empty lists of steps"], declared}

      true ->
        # every branch sees only what was visible BEFORE the parallel step; ids must still be unique overall
        Enum.reduce(branches, {[], declared}, fn branch, {errs, decl} ->
          {e, decl2} = check_steps_in_branch(branch, vis, decl, depth + 1)
          {errs ++ e, decl2}
        end)
    end
  end

  defp check_steps_in_branch(steps, outer_visible, declared, depth) do
    # inside one branch, earlier siblings in the SAME branch are visible; other branches' steps are not
    Enum.reduce(steps, {[], declared, outer_visible}, fn step, {errs, decl, vis} ->
      {e, decl2} = check_step(step, vis, decl, depth)

      e =
        if is_map(step) and step["kind"] in ["authorize", "execute"] do
          [
            "step #{step["id"]}: authorize and execute cannot run inside a parallel step (anything with an effect or a wait must be sequential and durable)"
            | e
          ]
        else
          e
        end

      new_vis = if is_map(step) and is_binary(step["id"]), do: MapSet.put(vis, step["id"]), else: vis
      {errs ++ e, decl2, new_vis}
    end)
    |> then(fn {errs, decl, _} -> {errs, decl} end)
  end

  defp req_string(s, key, id) do
    v = s[key]
    if is_binary(v) and v != "", do: nil, else: "step #{id}: #{key} is required"
  end

  defp valid_path?(path, vis) when is_binary(path) do
    case String.split(path, ".") do
      [first | _] -> MapSet.member?(vis, first)
      _ -> false
    end
  end

  defp valid_path?(_, _), do: false

  defp refs_in(value, vis, id) do
    value
    |> collect_refs([])
    |> Enum.flat_map(fn path ->
      if valid_path?(path, vis), do: [], else: ["step #{id}: the reference #{inspect(path)} does not name an earlier step"]
    end)
  end

  defp collect_refs(%{"$ref" => path} = m, acc) when map_size(m) == 1, do: [path | acc]
  defp collect_refs(m, acc) when is_map(m), do: Enum.reduce(m, acc, fn {_k, v}, a -> collect_refs(v, a) end)
  defp collect_refs(l, acc) when is_list(l), do: Enum.reduce(l, acc, &collect_refs/2)
  defp collect_refs(_, acc), do: acc

  # ── resolution (at run time) ───────────────────────────────────────────────
  @doc "Replace every `%{\"$ref\" => path}` in `value` with what `vars` holds at that path."
  @spec resolve(term, map) :: {:ok, term} | {:error, {:unresolved, String.t()}}
  def resolve(%{"$ref" => path} = m, vars) when map_size(m) == 1, do: fetch(vars, path)

  def resolve(m, vars) when is_map(m) do
    Enum.reduce_while(m, {:ok, %{}}, fn {k, v}, {:ok, acc} ->
      case resolve(v, vars) do
        {:ok, r} -> {:cont, {:ok, Map.put(acc, k, r)}}
        err -> {:halt, err}
      end
    end)
  end

  def resolve(l, vars) when is_list(l) do
    l
    |> Enum.reduce_while({:ok, []}, fn v, {:ok, acc} ->
      case resolve(v, vars) do
        {:ok, r} -> {:cont, {:ok, [r | acc]}}
        err -> {:halt, err}
      end
    end)
    |> then(fn
      {:ok, acc} -> {:ok, Enum.reverse(acc)}
      err -> err
    end)
  end

  def resolve(v, _vars), do: {:ok, v}

  @doc "The value at a dotted path (`\"co.proposed_intents.0.amount_minor\"`), or `{:error, {:unresolved, path}}`."
  @spec fetch(map, String.t()) :: {:ok, term} | {:error, {:unresolved, String.t()}}
  def fetch(vars, path) when is_binary(path) do
    path
    |> String.split(".")
    |> Enum.reduce_while({:ok, vars}, fn seg, {:ok, cur} ->
      case step_into(cur, seg) do
        {:ok, v} -> {:cont, {:ok, v}}
        :error -> {:halt, {:error, {:unresolved, path}}}
      end
    end)
  end

  defp step_into(m, seg) when is_map(m), do: Map.fetch(m, seg)

  defp step_into(l, seg) when is_list(l) do
    case Integer.parse(seg) do
      {i, ""} when i >= 0 and i < length(l) -> {:ok, Enum.at(l, i)}
      _ -> :error
    end
  end

  defp step_into(_, _), do: :error
end
