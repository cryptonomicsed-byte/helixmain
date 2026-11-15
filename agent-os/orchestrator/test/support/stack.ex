defmodule Helix.Test.Stack do
  @moduledoc false
  # The real thing, for the end-to-end tests: the Clojure policy service, the Rust
  # kernel (with its Wasm plugin host) and the Go gateway, each its own OS
  # process, with a registry of principals. Nothing here is a model.

  defstruct [:dir, :gateway_url, :tokens, :ports, :pids, :agent_sid, :fixtures]

  @agent_sid "sid_barista"
  @executor_principal "svc:merchant-adapter"
  def executor_principal, do: @executor_principal
  def agent_sid, do: @agent_sid

  def root, do: Path.expand("../../..", __DIR__)

  def start(dir) do
    File.mkdir_p!(dir)
    agent_dir = root()
    gateway_dir = Path.join(agent_dir, "gateway")

    # 0. build what is not built
    gateway_bin = Path.join(dir, "helix-gateway")
    sh!(gateway_dir, "go build -o #{gateway_bin} ./cmd/helix-gateway")
    sh!(Path.join(agent_dir, "kernel"), "cargo build --bin helix-kernel 2>&1 | tail -1")

    sh!(
      gateway_dir,
      "go run ./tools/mintfixtures -sid #{@agent_sid} -perms plugin.acme.pricing.checkout,merchant.order,kb.search -out #{dir}"
    )

    sh!(Path.join(agent_dir, "policy"), "./fetch-deps.sh")

    # 1. policy
    policy_file = Path.join(dir, "policy.edn")
    File.cp!(Path.join(agent_dir, "policy/policies/helix-default.edn"), policy_file)

    {policy_os_pid, policy_port} =
      spawn_proc(
        Path.join(agent_dir, "policy"),
        "java -Dfile.encoding=UTF-8 -cp 'lib/*:src' clojure.main -m helix.policy.main",
        [{"HELIX_POLICY_PORT", "0"}, {"HELIX_POLICY_FILE", policy_file}],
        Path.join(dir, "policy.log")
      )

    policy_addr = wait_line(Path.join(dir, "policy.log"), ~r/listening on (127\.0\.0\.1:\d+)/)

    # 2. kernel
    kbin = Path.join(agent_dir, "kernel/target/debug/helix-kernel")
    key = Path.join(dir, "grant.key")
    sh!(dir, "#{kbin} keygen #{key}")
    kport = free_port()

    {kernel_os_pid, _} =
      spawn_proc(
        dir,
        "#{kbin} serve",
        [
          {"HELIX_KERNEL_SIGNING_KEY_FILE", key},
          {"HELIX_KERNEL_TRUST_FILE", Path.join(agent_dir, "kernel/tests/fixtures/sid-0.2/trust.json")},
          {"HELIX_KERNEL_DB", Path.join(dir, "kernel.sqlite")},
          {"HELIX_KERNEL_LISTEN", "127.0.0.1:#{kport}"},
          {"HELIX_POLICY_URL", "http://" <> policy_addr},
          {"HELIX_KERNEL_PLUGINS", "on"}
        ],
        Path.join(dir, "kernel.log")
      )

    wait_line(Path.join(dir, "kernel.log"), ~r/listening on/)

    # 3. gateway, with a registry of who may do what
    tokens =
      for n <- ~w(reg deploy orch exec alice bob),
          into: %{},
          do: {n, "hxg_" <> Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)}

    entry = fn id, principal, kind, roles ->
      %{
        "id" => id,
        "sha256" => :crypto.hash(:sha256, tokens[id]) |> Base.encode16(case: :lower),
        "organization_id" => "org_a",
        "principal" => principal,
        "kind" => kind,
        "roles" => roles
      }
    end

    registry = %{
      "tokens" => [
        entry.("reg", "svc:registry", "service", ["registrar"]),
        entry.("deploy", "svc:deploy", "service", ["plugin_admin"]),
        entry.("orch", "svc:orchestrator", "service", ["proposer"]),
        entry.("exec", @executor_principal, "service", ["executor"]),
        entry.("alice", "user:alice", "user", []),
        entry.("bob", "user:bob", "user", [])
      ],
      "agents" => [%{"organization_id" => "org_a", "sid" => @agent_sid, "owners" => ["user:alice"]}]
    }

    File.write!(Path.join(dir, "principals.json"), Helix.JSON.encode!(registry))
    gport = free_port()

    {gateway_os_pid, _} =
      spawn_proc(
        dir,
        gateway_bin <> " serve",
        [
          {"HELIX_GATEWAY_PRINCIPALS", Path.join(dir, "principals.json")},
          {"HELIX_GATEWAY_LISTEN", "127.0.0.1:#{gport}"},
          {"HELIX_GATEWAY_KERNEL_ADDR", "127.0.0.1:#{kport}"}
        ],
        Path.join(dir, "gateway.log")
      )

    url = "http://127.0.0.1:#{gport}"
    wait_ready(url)
    _ = policy_port

    stack = %__MODULE__{
      dir: dir,
      gateway_url: url,
      tokens: tokens,
      ports: %{policy: policy_addr, kernel: kport, gateway: gport},
      pids: %{policy: policy_os_pid, kernel: kernel_os_pid, gateway: gateway_os_pid},
      agent_sid: @agent_sid,
      fixtures: dir
    }

    bootstrap(stack)
    stack
  end

  def client(stack, who), do: Helix.Gateway.new(stack.gateway_url, stack.tokens[who], timeout_ms: 10_000)

  # register the agent and install the plugin, as an operator would
  defp bootstrap(stack) do
    cert = stack.fixtures |> Path.join("agent-cert.json") |> File.read!() |> Helix.JSON.decode!()

    {:ok, 200, %{"registered" => true, "trusted" => true}} =
      Helix.Gateway.request(client(stack, "reg"), :post, "/v1/identities/verify", %{"certificate" => cert, "register" => true})

    manifest = stack.fixtures |> Path.join("pricing-manifest.json") |> File.read!() |> Helix.JSON.decode!()
    component = Path.join(root(), "plugins/dist/pricing.wasm") |> File.read!() |> Base.encode64()

    {:ok, 200, %{"installed" => true}} =
      Helix.Gateway.request(client(stack, "deploy"), :post, "/v1/plugins", %{"manifest" => manifest, "component_base64" => component})

    :ok
  end

  def stop(%__MODULE__{pids: pids}) do
    for {_, pid} <- pids, do: System.cmd("kill", ["-9", to_string(pid)], stderr_to_stdout: true)
    :ok
  end

  def kill(%__MODULE__{pids: pids}, which), do: System.cmd("kill", ["-9", to_string(pids[which])], stderr_to_stdout: true)

  # ── process plumbing ──
  defp spawn_proc(cd, command, env, log) do
    env_s = Enum.map_join(env, " ", fn {k, v} -> "#{k}=#{shell_quote(v)}" end)

    port =
      Port.open({:spawn_executable, "/bin/sh"}, [
        :binary,
        :exit_status,
        {:args, ["-c", "cd #{shell_quote(cd)} && #{env_s} exec #{command} > #{shell_quote(log)} 2>&1"]}
      ])

    {:os_pid, os_pid} = Port.info(port, :os_pid)
    {os_pid, port}
  end

  defp shell_quote(s), do: "'" <> String.replace(to_string(s), "'", "'\\''") <> "'"

  defp sh!(cd, command) do
    {out, code} = System.cmd("/bin/sh", ["-c", "cd #{shell_quote(cd)} && #{command}"], stderr_to_stdout: true)
    if code != 0, do: raise("#{command} failed (#{code}):\n#{out}")
    out
  end

  defp wait_line(path, regex, tries \\ 400) do
    case File.read(path) do
      {:ok, text} ->
        case Regex.run(regex, text) do
          [_, cap] -> cap
          [_] -> :ok
          nil -> retry(path, regex, tries)
        end

      _ ->
        retry(path, regex, tries)
    end
  end

  defp retry(_path, regex, 0), do: raise("never saw #{inspect(regex)}")
  defp retry(path, regex, tries), do: :timer.sleep(50) && wait_line(path, regex, tries - 1)

  defp wait_ready(url, tries \\ 200) do
    case Helix.Gateway.request(%Helix.Gateway{base_url: url, token: "x"}, :get, "/readyz") do
      {:ok, 200, _} -> :ok
      _ -> if tries == 0, do: raise("the gateway never became ready"), else: :timer.sleep(100) && wait_ready(url, tries - 1)
    end
  end

  defp free_port do
    {:ok, l} = :gen_tcp.listen(0, ip: {127, 0, 0, 1})
    {:ok, p} = :inet.port(l)
    :gen_tcp.close(l)
    p
  end
end
