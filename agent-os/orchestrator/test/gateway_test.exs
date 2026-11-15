defmodule Helix.GatewayTest do
  use ExUnit.Case, async: true
  alias Helix.{Gateway, Test.FakeGateway}

  defp serve(handler), do: FakeGateway.start(handler)

  test "the token goes out as a bearer header and never appears in what a caller can print" do
    srv = serve(fn _, _, _ -> {200, %{"status" => "ok"}} end)
    gw = Gateway.new(srv.url, "hxg_secret-token-value")
    assert {:ok, 200, %{"status" => "ok"}} = Gateway.health(gw)
    [req] = FakeGateway.requests(srv)
    assert req.headers["authorization"] == "Bearer hxg_secret-token-value"
    assert req.path == "/v1/health"
    refute inspect(gw) =~ "secret-token-value"
    refute inspect({:error, gw}) =~ "secret-token-value"
  end

  test "bodies are JSON, and ids in paths are escaped" do
    srv = serve(fn _, _, _ -> {200, %{"decision" => "allow"}} end)
    gw = Gateway.new(srv.url, "t")
    assert {:ok, _, _} = Gateway.authorize(gw, %{"id" => "i1", "arguments" => %{"q" => "é"}})
    assert {:ok, _, _} = Gateway.get_action(gw, "pending/../x y")
    [a, b] = FakeGateway.requests(srv)
    assert a.method == "POST" and a.body == %{"intent" => %{"id" => "i1", "arguments" => %{"q" => "é"}}}
    assert b.path == "/v1/actions/pending%2F..%2Fx%20y"
  end

  test "the gateway's error answers become {:http, ...} and only the transient ones are retryable" do
    for {status, code, retry?} <- [
          {400, "invalid_request", false},
          {401, "unauthenticated", false},
          {403, "forbidden", false},
          {404, "not_found", false},
          {409, "conflict", false},
          {429, "rate_limited", true},
          {502, "upstream_error", true},
          {503, "overloaded", true},
          {504, "upstream_timeout", true}
        ] do
      srv = serve(fn _, _, _ -> {status, %{"error" => %{"code" => code, "message" => "m"}}} end)
      assert {:error, {:http, ^status, ^code, "m"} = err} = Gateway.health(Gateway.new(srv.url, "t"))
      assert Gateway.retryable?(err) == retry?, "#{status}"
    end
  end

  test "no answer is a transport error, and retryable" do
    srv = serve(fn _, _, _ -> :close end)
    assert {:error, {:transport, _} = e} = Gateway.health(Gateway.new(srv.url, "t"))
    assert Gateway.retryable?(e)
    # nothing listening at all
    {:ok, l} = :gen_tcp.listen(0, ip: {127, 0, 0, 1})
    {:ok, port} = :inet.port(l)
    :gen_tcp.close(l)
    assert {:error, {:transport, _} = e} = Gateway.health(Gateway.new("http://127.0.0.1:#{port}", "t", timeout_ms: 500))
    assert Gateway.retryable?(e)
  end

  test "a slow gateway times out" do
    srv = serve(fn _, _, _ -> {:sleep, 2000} end)
    t = System.monotonic_time(:millisecond)
    assert {:error, {:transport, :timeout}} = Gateway.health(Gateway.new(srv.url, "t", timeout_ms: 300))
    assert System.monotonic_time(:millisecond) - t < 1500
  end

  test "an answer that is not JSON is a transport error, not a crash" do
    for body <- ["<html>", "[1]", "not json", "{\"a\":"] do
      srv = serve(fn _, _, _ -> {200, :raw_body, body} end)
      assert {:error, {:transport, :bad_json_from_gateway}} = Gateway.health(Gateway.new(srv.url, "t"))
    end

    srv = serve(fn _, _, _ -> {500, :raw_body, "boom"} end)
    assert {:error, {:http, 500, "unknown", _}} = Gateway.health(Gateway.new(srv.url, "t"))
  end

  test "redirects are not followed" do
    srv =
      serve(fn _, _, _ ->
        {:raw, "HTTP/1.1 302 Found\r\nlocation: http://127.0.0.1:1/steal\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"}
      end)

    assert {:error, {:http, 302, _, _}} = Gateway.health(Gateway.new(srv.url, "t"))
  end

  test "plain http is refused off loopback, https is required" do
    for bad <- ["http://example.com", "http://10.0.0.5:8080", "ftp://127.0.0.1", "127.0.0.1:8080", "https://"] do
      assert_raise ArgumentError, fn -> Gateway.new(bad, "t") end
    end

    assert %Gateway{} = Gateway.new("https://gateway.example", "t")
    assert %Gateway{} = Gateway.new("http://127.0.0.1:8080", "t")
    assert_raise ArgumentError, fn -> Gateway.new("https://gateway.example", "") end
  end
end
