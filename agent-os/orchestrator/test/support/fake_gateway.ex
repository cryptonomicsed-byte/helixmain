defmodule Helix.Test.FakeGateway do
  @moduledoc false
  # A tiny HTTP/1.1 server for tests that need the gateway to misbehave on
  # command: errors, hangs, dropped connections, malformed answers. It is not a
  # model of the gateway; the end-to-end tests use the real one.

  def start(handler) when is_function(handler, 3) do
    {:ok, listen} = :gen_tcp.listen(0, [:binary, packet: :raw, active: false, reuseaddr: true, ip: {127, 0, 0, 1}])
    {:ok, port} = :inet.port(listen)
    {:ok, log} = Agent.start_link(fn -> [] end)
    pid = spawn_link(fn -> accept(listen, handler, log) end)
    %{port: port, url: "http://127.0.0.1:#{port}", listen: listen, log: log, pid: pid}
  end

  def requests(%{log: log}), do: Agent.get(log, & &1) |> Enum.reverse()

  def stop(%{listen: l, pid: pid}) do
    :gen_tcp.close(l)
    Process.unlink(pid)
    Process.exit(pid, :kill)
    :ok
  end

  defp accept(listen, handler, log) do
    case :gen_tcp.accept(listen) do
      {:ok, sock} ->
        spawn(fn -> serve(sock, handler, log) end)
        accept(listen, handler, log)

      _ ->
        :ok
    end
  end

  defp serve(sock, handler, log) do
    with {:ok, {method, path, headers, body}} <- read_request(sock, <<>>) do
      parsed = if body == "", do: nil, else: elem(Helix.JSON.decode(body), 1)
      Agent.update(log, &([%{method: method, path: path, headers: headers, body: parsed}] ++ &1))

      case handler.(method, path, %{headers: headers, body: parsed}) do
        :close -> :gen_tcp.close(sock)
        {:sleep, ms} -> :timer.sleep(ms) && :gen_tcp.close(sock)
        {:raw, bytes} -> :gen_tcp.send(sock, bytes) && :gen_tcp.close(sock)
        {status, map} -> respond(sock, status, Helix.JSON.encode!(map))
        {status, :raw_body, body} -> respond(sock, status, body)
      end
    else
      _ -> :gen_tcp.close(sock)
    end
  end

  defp respond(sock, status, body) do
    :gen_tcp.send(
      sock,
      "HTTP/1.1 #{status} X\r\ncontent-type: application/json\r\ncontent-length: #{byte_size(body)}\r\nconnection: close\r\n\r\n#{body}"
    )

    :gen_tcp.close(sock)
  end

  defp read_request(sock, buf) do
    case :binary.split(buf, "\r\n\r\n") do
      [head, rest] ->
        [line | hdrs] = String.split(head, "\r\n")
        [method, path | _] = String.split(line, " ")

        headers =
          Map.new(hdrs, fn h ->
            [k, v] = String.split(h, ":", parts: 2)
            {String.downcase(k), String.trim(v)}
          end)

        len = String.to_integer(headers["content-length"] || "0")
        read_body(sock, rest, len, method, path, headers)

      [_] ->
        case :gen_tcp.recv(sock, 0, 2000) do
          {:ok, data} -> read_request(sock, buf <> data)
          err -> err
        end
    end
  end

  defp read_body(_sock, body, len, m, p, h) when byte_size(body) >= len, do: {:ok, {m, p, h, binary_part(body, 0, len)}}

  defp read_body(sock, body, len, m, p, h) do
    case :gen_tcp.recv(sock, 0, 2000) do
      {:ok, data} -> read_body(sock, body <> data, len, m, p, h)
      err -> err
    end
  end
end
