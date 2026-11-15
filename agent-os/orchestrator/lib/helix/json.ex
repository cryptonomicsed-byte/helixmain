defmodule Helix.JSON do
  @moduledoc """
  A strict JSON codec with no dependencies (OTP 25 has none).

  `decode/2` accepts exactly one JSON document: valid UTF-8, bounded depth and
  size, no trailing content, no NaN or Infinity, numbers kept exact (integers
  stay integers). Objects become maps with string keys, arrays lists.

  `encode!/1` is deterministic: object keys are sorted, so the same data always
  encodes to the same bytes (the event log's hash chain depends on it).
  """

  @max_depth 64
  @max_bytes 16 * 1024 * 1024

  @type t :: nil | boolean | number | String.t() | [t] | %{optional(String.t()) => t}

  # ── encode ──────────────────────────────────────────────────────────────────
  @spec encode!(term) :: binary
  def encode!(term), do: IO.iodata_to_binary(enc(term))

  defp enc(nil), do: "null"
  defp enc(true), do: "true"
  defp enc(false), do: "false"
  defp enc(n) when is_integer(n), do: Integer.to_string(n)

  defp enc(f) when is_float(f) do
    if f == Float.floor(f) and abs(f) < 1.0e15, do: Integer.to_string(trunc(f)), else: Float.to_string(f)
  end

  defp enc(a) when is_atom(a), do: enc(Atom.to_string(a))
  defp enc(s) when is_binary(s), do: [?", escape(s, []), ?"]
  defp enc(list) when is_list(list), do: [?[, list |> Enum.map(&enc/1) |> Enum.intersperse(?,), ?]]

  defp enc(map) when is_map(map) do
    body =
      map
      |> Enum.map(fn {k, v} -> {to_key(k), v} end)
      |> Enum.sort_by(&elem(&1, 0))
      |> Enum.map(fn {k, v} -> [enc(k), ?:, enc(v)] end)
      |> Enum.intersperse(?,)

    [?{, body, ?}]
  end

  defp to_key(k) when is_binary(k), do: k
  defp to_key(k) when is_atom(k), do: Atom.to_string(k)
  defp to_key(k) when is_integer(k), do: Integer.to_string(k)

  defp escape(<<>>, acc), do: Enum.reverse(acc)
  defp escape(<<?", r::binary>>, acc), do: escape(r, ["\\\"" | acc])
  defp escape(<<?\\, r::binary>>, acc), do: escape(r, ["\\\\" | acc])
  defp escape(<<?\n, r::binary>>, acc), do: escape(r, ["\\n" | acc])
  defp escape(<<?\r, r::binary>>, acc), do: escape(r, ["\\r" | acc])
  defp escape(<<?\t, r::binary>>, acc), do: escape(r, ["\\t" | acc])
  defp escape(<<c, r::binary>>, acc) when c < 0x20 or c == 0x7F, do: escape(r, [:io_lib.format("\\u~4.16.0b", [c]) | acc])
  defp escape(<<c::utf8, r::binary>>, acc), do: escape(r, [<<c::utf8>> | acc])

  # ── decode ──────────────────────────────────────────────────────────────────
  @spec decode(binary, keyword) :: {:ok, t} | {:error, String.t()}
  def decode(bin, opts \\ []) when is_binary(bin) do
    max = Keyword.get(opts, :max_bytes, @max_bytes)

    cond do
      byte_size(bin) > max -> {:error, "document is larger than #{max} bytes"}
      not String.valid?(bin) -> {:error, "not valid UTF-8"}
      true -> parse_document(bin)
    end
  end

  @spec decode!(binary) :: t
  def decode!(bin) do
    case decode(bin) do
      {:ok, v} -> v
      {:error, why} -> raise ArgumentError, "invalid JSON: #{why}"
    end
  end

  defp parse_document(bin) do
    {v, rest} = value(skip_ws(bin), 0)

    case skip_ws(rest) do
      "" -> {:ok, v}
      _ -> {:error, "unexpected content after the JSON document"}
    end
  catch
    {:json_error, why} -> {:error, why}
  end

  defp value(_bin, depth) when depth > @max_depth, do: throw({:json_error, "nested deeper than #{@max_depth}"})
  defp value("null" <> r, _), do: {nil, r}
  defp value("true" <> r, _), do: {true, r}
  defp value("false" <> r, _), do: {false, r}
  defp value(<<?", r::binary>>, _), do: string(r, [])
  defp value(<<?[, r::binary>>, d), do: array(skip_ws(r), d + 1, [])
  defp value(<<?{, r::binary>>, d), do: object(skip_ws(r), d + 1, %{})
  defp value(<<c, _::binary>> = bin, _) when c == ?- or c in ?0..?9, do: number(bin)
  defp value("", _), do: throw({:json_error, "unexpected end of input"})
  defp value(<<c::utf8, _::binary>>, _), do: throw({:json_error, "unexpected character #{inspect(<<c::utf8>>)}"})

  defp skip_ws(<<c, r::binary>>) when c in [?\s, ?\t, ?\n, ?\r], do: skip_ws(r)
  defp skip_ws(bin), do: bin

  defp array(<<?], r::binary>>, _d, []), do: {[], r}

  defp array(bin, d, acc) do
    {v, r} = value(bin, d)

    case skip_ws(r) do
      <<?,, r2::binary>> -> array(skip_ws(r2), d, [v | acc])
      <<?], r2::binary>> -> {Enum.reverse([v | acc]), r2}
      _ -> throw({:json_error, "expected , or ] in an array"})
    end
  end

  defp object(<<?}, r::binary>>, _d, acc) when map_size(acc) == 0, do: {%{}, r}

  defp object(<<?", r::binary>>, d, acc) do
    {k, r1} = string(r, [])

    case skip_ws(r1) do
      <<?:, r2::binary>> ->
        {v, r3} = value(skip_ws(r2), d)
        acc = Map.put(acc, k, v)

        case skip_ws(r3) do
          <<?,, r4::binary>> -> object(skip_ws(r4), d, acc)
          <<?}, r4::binary>> -> {acc, r4}
          _ -> throw({:json_error, "expected , or } in an object"})
        end

      _ ->
        throw({:json_error, "expected : after an object key"})
    end
  end

  defp object(_, _, _), do: throw({:json_error, "expected a string key"})

  defp string(<<?", r::binary>>, acc), do: {acc |> Enum.reverse() |> IO.iodata_to_binary(), r}
  defp string(<<?\\, ?", r::binary>>, acc), do: string(r, ["\"" | acc])
  defp string(<<?\\, ?\\, r::binary>>, acc), do: string(r, ["\\" | acc])
  defp string(<<?\\, ?/, r::binary>>, acc), do: string(r, ["/" | acc])
  defp string(<<?\\, ?b, r::binary>>, acc), do: string(r, ["\b" | acc])
  defp string(<<?\\, ?f, r::binary>>, acc), do: string(r, ["\f" | acc])
  defp string(<<?\\, ?n, r::binary>>, acc), do: string(r, ["\n" | acc])
  defp string(<<?\\, ?r, r::binary>>, acc), do: string(r, ["\r" | acc])
  defp string(<<?\\, ?t, r::binary>>, acc), do: string(r, ["\t" | acc])

  defp string(<<?\\, ?u, h::binary-size(4), r::binary>>, acc) do
    hi = hex4(h)

    cond do
      hi in 0xD800..0xDBFF ->
        case r do
          <<?\\, ?u, l::binary-size(4), r2::binary>> ->
            lo = hex4(l)

            if lo in 0xDC00..0xDFFF do
              cp = 0x10000 + (hi - 0xD800) * 0x400 + (lo - 0xDC00)
              string(r2, [<<cp::utf8>> | acc])
            else
              throw({:json_error, "a high surrogate must be followed by a low surrogate"})
            end

          _ ->
            throw({:json_error, "a lone surrogate in a string"})
        end

      hi in 0xDC00..0xDFFF ->
        throw({:json_error, "a lone surrogate in a string"})

      true ->
        string(r, [<<hi::utf8>> | acc])
    end
  end

  defp string(<<?\\, _::binary>>, _), do: throw({:json_error, "bad escape in a string"})
  defp string(<<c, _::binary>>, _) when c < 0x20, do: throw({:json_error, "a control character in a string"})
  defp string(<<c::utf8, r::binary>>, acc), do: string(r, [<<c::utf8>> | acc])
  defp string("", _), do: throw({:json_error, "unterminated string"})

  defp hex4(h) do
    case Integer.parse(h, 16) do
      {n, ""} when byte_size(h) == 4 -> n
      _ -> throw({:json_error, "bad \\u escape"})
    end
  end

  defp number(bin) do
    case Regex.run(~r/\A-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/, bin) do
      [text] ->
        rest = binary_part(bin, byte_size(text), byte_size(bin) - byte_size(text))

        cond do
          Regex.match?(~r/\A-?(?:0|[1-9][0-9]*)\z/, text) -> {String.to_integer(text), rest}
          true -> {to_float(text), rest}
        end

      _ ->
        throw({:json_error, "bad number"})
    end
  end

  defp to_float(text) do
    # "1e5" has no dot: Elixir's parser wants one
    text = if String.contains?(text, "."), do: text, else: String.replace(text, ~r/[eE]/, ".0e", global: false)

    case Float.parse(text) do
      {f, ""} when f == f and abs(f) < 1.0e308 -> f
      _ -> throw({:json_error, "number out of range"})
    end
  rescue
    ArgumentError -> throw({:json_error, "number out of range"})
  end
end
