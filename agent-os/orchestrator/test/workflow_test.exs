defmodule Helix.WorkflowTest do
  use ExUnit.Case, async: true
  alias Helix.Workflow

  defp wf(steps), do: %{"id" => "w", "steps" => steps}
  defp invoke(id, input \\ %{}), do: %{"id" => id, "kind" => "invoke_plugin", "plugin" => "p", "tool" => "t", "input" => input}

  test "a well-formed workflow validates" do
    steps = [
      invoke("quote", %{"basket" => %{"$ref" => "inputs.basket"}}),
      %{"id" => "auth", "kind" => "authorize", "intent_from" => "quote.proposed_intents.0", "intent_with" => %{"audience" => "svc:m"}},
      %{"id" => "buy", "kind" => "execute", "from" => "auth", "executor" => "merchant"},
      %{"id" => "note", "kind" => "set", "value" => %{"order" => %{"$ref" => "buy.result.order"}}}
    ]

    assert {:ok, _} = Workflow.validate(wf(steps))
  end

  test "everything unexpected is an error, with the step named" do
    cases = [
      {wf([]), "at least one step"},
      {%{"id" => "w"}, "a workflow is"},
      {%{"id" => "W", "steps" => [invoke("a")]}, "workflow id"},
      {%{"id" => "w", "steps" => [invoke("a")], "hooks" => []}, "unknown workflow field"},
      {wf([invoke("a"), invoke("a")]), "the id is used twice"},
      {wf([invoke("Bad Id")]), "id must match"},
      {wf([invoke("inputs")]), "reserved"},
      {wf([%{"id" => "a", "kind" => "teleport"}]), "unknown kind"},
      {wf([Map.put(invoke("a"), "shell", "rm -rf /")]), "unknown field(s) shell"},
      {wf([%{"id" => "a", "kind" => "invoke_plugin", "plugin" => "p", "tool" => "t"}]), "input is required"},
      {wf([Map.put(invoke("a"), "agent", "root")]), "agent must be a sid"},
      {wf([%{"id" => "a", "kind" => "authorize"}]), "exactly one of intent and intent_from"},
      {wf([%{"id" => "a", "kind" => "authorize", "intent" => %{}, "intent_from" => "x.y"}]), "exactly one of intent and intent_from"},
      {wf([%{"id" => "a", "kind" => "authorize", "intent_from" => "ghost.x"}]), "intent_from must be a path"},
      {wf([%{"id" => "a", "kind" => "authorize", "intent" => %{}, "on_deny" => "shrug"}]), "on_deny"},
      {wf([%{"id" => "a", "kind" => "execute", "from" => "ghost", "executor" => "m"}]), "not an earlier step"},
      {wf([invoke("a", %{"x" => %{"$ref" => "later.x"}}), invoke("later")]), "does not name an earlier step"},
      {wf([invoke("a", %{"x" => %{"$ref" => "a.x"}})]), "does not name an earlier step"},
      {wf([%{"id" => "a", "kind" => "set"}]), "value is required"},
      {wf([%{"id" => "a", "kind" => "parallel", "branches" => [[invoke("x")]]}]), "2 to 8"},
      {wf([%{"id" => "a", "kind" => "parallel", "branches" => [[invoke("x")], []]}]), "2 to 8"}
    ]

    for {definition, why} <- cases do
      assert {:error, errs} = Workflow.validate(definition)
      assert Enum.any?(errs, &(&1 =~ why)), "expected #{inspect(why)} in #{inspect(errs)}"
    end
  end

  test "parallel branches see what came before them, not each other" do
    ok =
      wf([
        invoke("first"),
        %{
          "id" => "par",
          "kind" => "parallel",
          "branches" => [[invoke("a", %{"x" => %{"$ref" => "first.r"}})], [invoke("b", %{"y" => %{"$ref" => "first.r"}})]]
        }
      ])

    assert {:ok, _} = Workflow.validate(ok)

    sibling = wf([%{"id" => "par", "kind" => "parallel", "branches" => [[invoke("a")], [invoke("b", %{"x" => %{"$ref" => "a.r"}})]]}])
    assert {:error, errs} = Workflow.validate(sibling)
    assert Enum.any?(errs, &(&1 =~ "does not name an earlier step"))

    within_branch =
      wf([%{"id" => "par", "kind" => "parallel", "branches" => [[invoke("a"), invoke("a2", %{"x" => %{"$ref" => "a.r"}})], [invoke("b")]]}])

    assert {:ok, _} = Workflow.validate(within_branch)

    dup = wf([%{"id" => "par", "kind" => "parallel", "branches" => [[invoke("a")], [invoke("a")]]}])
    assert {:error, errs} = Workflow.validate(dup)
    assert Enum.any?(errs, &(&1 =~ "used twice"))
  end

  test "only pure steps may run in parallel" do
    for kind <- [%{"kind" => "authorize", "intent" => %{}}, %{"kind" => "execute", "from" => "first", "executor" => "m"}] do
      step = Map.put(kind, "id", "x")

      assert {:error, errs} =
               Workflow.validate(wf([invoke("first"), %{"id" => "par", "kind" => "parallel", "branches" => [[step], [invoke("y")]]}]))

      assert Enum.any?(errs, &(&1 =~ "cannot run inside a parallel step")), inspect(errs)
    end
  end

  test "parallel nesting and size are bounded" do
    inner = fn -> %{"id" => "z", "kind" => "parallel", "branches" => [[invoke("p")], [invoke("q")]]} end

    deep =
      wf([
        %{
          "id" => "a",
          "kind" => "parallel",
          "branches" => [[%{"id" => "b", "kind" => "parallel", "branches" => [[inner.()], [invoke("r")]]}], [invoke("s")]]
        }
      ])

    assert {:error, errs} = Workflow.validate(deep)
    assert Enum.any?(errs, &(&1 =~ "nest at most"))

    many = wf(for i <- 1..201, do: invoke("s#{i}"))
    assert {:error, errs} = Workflow.validate(many)
    assert Enum.any?(errs, &(&1 =~ "at most 200"))
  end

  test "resolve replaces references and fails loudly on a missing one" do
    vars = %{
      "q" => %{"result" => %{"total" => 1350}, "proposed_intents" => [%{"capability" => "merchant.order"}]},
      "inputs" => %{"who" => "alice"}
    }

    assert {:ok, %{"amount" => 1350, "list" => ["alice", %{"capability" => "merchant.order"}], "plain" => 7}} =
             Workflow.resolve(
               %{
                 "amount" => %{"$ref" => "q.result.total"},
                 "list" => [%{"$ref" => "inputs.who"}, %{"$ref" => "q.proposed_intents.0"}],
                 "plain" => 7
               },
               vars
             )

    for path <- [
          "q.result.nope",
          "ghost.x",
          "q.proposed_intents.1",
          "q.proposed_intents.x",
          "q.proposed_intents.-1",
          "q.result.total.deeper"
        ] do
      assert {:error, {:unresolved, ^path}} = Workflow.resolve(%{"x" => %{"$ref" => path}}, vars)
    end
  end

  test "a map that merely contains the key $ref next to others is data, not a reference" do
    assert {:ok, %{"$ref" => "q.x", "other" => 1}} = Workflow.resolve(%{"$ref" => "q.x", "other" => 1}, %{"q" => %{"x" => 5}})
  end
end
