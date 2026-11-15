defmodule Helix.JSONTest do
  use ExUnit.Case, async: true
  alias Helix.JSON

  test "round trips what it encodes" do
    doc = %{"a" => [1, 2.5, "x", nil, true, false, %{"b" => []}], "é" => "ü 😀 \u007f \u0001 \" \\ \n"}
    assert {:ok, ^doc} = doc |> JSON.encode!() |> JSON.decode()
  end

  test "encoding is deterministic: keys are sorted" do
    assert JSON.encode!(%{"b" => 1, "a" => 2, c: 3}) == ~s({"a":2,"b":1,"c":3})
    assert JSON.encode!(%{"z" => %{"y" => 1, "x" => 2}}) == ~s({"z":{"x":2,"y":1}})
  end

  test "integers stay integers and big ones stay exact" do
    assert {:ok, 9_007_199_254_740_993} = JSON.decode("9007199254740993")
    assert {:ok, [1, -1, 0]} = JSON.decode("[1,-1,0]")
    assert {:ok, 1.5} = JSON.decode("1.5")
    assert {:ok, 1.0e5} = JSON.decode("1e5")
    assert {:ok, 0.25} = JSON.decode("25E-2")
  end

  test "unicode escapes, surrogate pairs" do
    assert {:ok, "é😀"} = JSON.decode(~s("\\u00e9\\ud83d\\ude00"))
    assert {:error, _} = JSON.decode(~s("\\ud83d"))
    assert {:error, _} = JSON.decode(~s("\\ude00"))
    assert {:error, _} = JSON.decode(~s("\\ud83dx"))
  end

  test "refuses everything that is not exactly one valid document" do
    for bad <- [
          "",
          " ",
          "{",
          "[1,]",
          "{\"a\":1,}",
          "{'a':1}",
          "[1 2]",
          "{\"a\" 1}",
          "nul",
          "NaN",
          "Infinity",
          "-",
          "01",
          "1.",
          ".5",
          "+1",
          "1e",
          "\"abc",
          "\"a\nb\"",
          "\"\\x\"",
          "[1]x",
          "[1][2]",
          "{}{}",
          "{\"a\":1}\u0000",
          <<0xFF, 0xFE>>,
          "\"\\u12\"",
          "[\"a\" \"b\"]",
          "{1:2}",
          "1e999"
        ] do
      assert {:error, _} = JSON.decode(bad), "should refuse #{inspect(bad)}"
    end
  end

  test "bounded depth and size" do
    deep = String.duplicate("[", 200) <> String.duplicate("]", 200)
    assert {:error, msg} = JSON.decode(deep)
    assert msg =~ "deeper"
    assert {:error, msg} = JSON.decode("[" <> String.duplicate("1,", 100) <> "1]", max_bytes: 50)
    assert msg =~ "larger"
    ok = String.duplicate("[", 60) <> String.duplicate("]", 60)
    assert {:ok, _} = JSON.decode(ok)
  end

  test "whitespace around the document is fine" do
    assert {:ok, %{"a" => 1}} = JSON.decode(" \n\t{ \"a\" : 1 }\r\n ")
  end

  test "duplicate keys: the last one wins, consistently" do
    assert {:ok, %{"a" => 2}} = JSON.decode(~s({"a":1,"a":2}))
  end

  test "control characters and DEL are escaped on the way out" do
    assert JSON.encode!("\u0001\u007f") == ~s("\\u0001\\u007f")
  end
end
