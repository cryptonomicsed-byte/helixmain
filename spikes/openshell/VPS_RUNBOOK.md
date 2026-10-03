# OpenShell Sandbox Spike — VPS Runbook
## One card · one sandbox · kernel-enforced egress

**Target:** Hostinger VPS `2.25.70.156`, `agents` user  
**Card under test:** `dna_51aeb3da` v3 (Harbor & Bean Coffee House, demo fixture)  
**OpenShell version:** v0.1.2 (https://github.com/NVIDIA/OpenShell/releases/tag/v0.1.2)  
**Goal:** Prove that a ZeroClaw instance inside an OpenShell sandbox (a) starts within the gateway's default timeout, (b) idles at a measured RAM footprint, and (c) cannot reach any host outside its policy — verified via proxy deny log, not assumed.  
**Extrapolation target:** 18 simultaneous card sandboxes fit the VPS within margin.

---

## Architecture note (read before running)

OpenShell is **gateway + supervisor + container drivers**, not a wrapper binary around Docker.

- **Gateway** (`openshell-gateway`): control plane, runs on the host. Manages sandboxes, enforces policy, routes network through its proxy.
- **Sandbox**: a container (Docker driver on this VPS) launched by the gateway. ZeroClaw runs inside.
- **Policy**: YAML file passed to `openshell sandbox create`. Network enforcement is via the gateway's L4/L7 proxy — denied connections return HTTP 403 from the proxy, not kernel EPERM.
- **Credentials (Providers)**: registered separately at the gateway, not declared in the policy YAML. OpenShell injects them only to approved endpoints.

There is no `open-shell load-lsm` command. Landlock (filesystem) is applied at sandbox creation by the supervisor.

---

## Pre-flight checklist (run as `agents` user)

```bash
# 1. Kernel version — Landlock requires ≥ 5.13
uname -r
# If < 5.13, filesystem Landlock enforcement falls back to best_effort.
# Our policy uses hard_requirement — confirm kernel version before proceeding.

# 2. Docker available (compute driver for the gateway)
which docker && docker info 2>&1 | grep -E "^(Server Version|Storage Driver|Operating System)"
# If "permission denied": check if agents is in docker group, or if herdr wraps it.

# 3. OpenShell already installed?
which openshell && openshell --version
which openshell-gateway && openshell-gateway --version
# If not installed: proceed to §B.

# 4. Disk space
df -h /

# 5. Outbound connectivity from VPS to inference endpoint
curl -s --max-time 3 -o /dev/null -w "%{http_code}" https://openrouter.ai/api/v1/models || echo "blocked"
```

---

## §B — Install OpenShell

```bash
# Install CLI + gateway via the official installer
curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh

# Verify both components
openshell --version
openshell-gateway --version
# Expected: v0.1.2 for both
```

The installer places `openshell` and `openshell-gateway` in `~/.local/bin` or `/usr/local/bin` depending on privileges. If PATH doesn't pick them up:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

---

## §C — Start the gateway (Docker driver)

The gateway must be running before any sandbox commands work.

```bash
mkdir -p ~/.config/openshell

cat > ~/.config/openshell/gateway.toml << 'EOF'
[openshell]
version = 2

[openshell.gateway]
bind_address = "127.0.0.1:8080"
log_level = "info"
compute_driver = "docker"

[openshell.gateway.auth]
allow_unauthenticated_users = true

[openshell.drivers.docker]
default_image = "ubuntu:24.04"
image_pull_policy = "if_not_present"
sandbox_label = "helix-spike"
EOF

# Start the gateway (background)
openshell-gateway --config ~/.config/openshell/gateway.toml &
GATEWAY_PID=$!

# Confirm it's listening
sleep 2 && curl -sf http://127.0.0.1:8080/health && echo "gateway up"
```

---

## §D — Register the inference provider

Credentials are Providers, not policy fields. Register the OpenRouter key once:

```bash
# Reads key from env; do not inline secrets in shell history
OPENROUTER_KEY="<paste key here>"
openshell provider add \
  --name openrouter \
  --type bearer \
  --secret "$OPENROUTER_KEY" \
  --host openrouter.ai
unset OPENROUTER_KEY
```

OpenShell will inject this key only to requests bound for `openrouter.ai` — exactly the behaviour the policy file's `inference` network policy declares.

---

## §E — Create the sandbox

```bash
CARD_ID="dna_51aeb3da"
POLICY="spikes/openshell/openshell-policy.example.yaml"

openshell sandbox create \
  --name "zeroclaw-${CARD_ID}" \
  --policy "${POLICY}" \
  --image ubuntu:24.04
```

If the sandbox image needs ZeroClaw pre-installed, use a custom image or exec-install after creation. For the spike, the goal is verifying the policy enforcement layer — ZeroClaw startup can be stubbed with `curl` or `sleep` inside the sandbox.

```bash
# Confirm sandbox is running
openshell sandbox list
```

---

## §F — Measure idle RAM

With the sandbox running:

```bash
CARD_ID="dna_51aeb3da"

# Via Docker stats (OpenShell uses Docker as compute driver)
docker stats --no-stream "$(docker ps --filter label=helix-spike --filter name=${CARD_ID} -q)"
# Record: MEM USAGE column

# Via /proc inside the sandbox
openshell sandbox exec "zeroclaw-${CARD_ID}" -- cat /proc/1/status | grep -E "^(VmRSS|VmPeak|VmSize)"
```

**Pass criteria:** record the actual numbers. Do not compare against targets until measured.

---

## §G — Verify egress enforcement

Network enforcement goes through the gateway proxy. Denied connections return 403, not EPERM.

```bash
CARD_ID="dna_51aeb3da"
SBX="zeroclaw-${CARD_ID}"

# Connect to the sandbox shell
openshell sandbox connect "${SBX}"
```

Inside the sandbox:

```bash
# Attempt 1: allowed endpoint (inference) — must succeed
curl -s --max-time 5 -o /dev/null -w "ALLOWED: %{http_code}\n" https://openrouter.ai/api/v1/models
# Expected: ALLOWED: 200

# Attempt 2: blocked endpoint — must be denied by proxy
curl -v --max-time 5 https://8.8.8.8/ 2>&1 | grep -E "(403|policy_denied|refused|Failed)"
# Expected: HTTP 403 from proxy with {"error":"policy_denied",...}
# Fail if: connection succeeds, or times out without a 403 (means proxy isn't intercepting)

# Attempt 3: blocked endpoint, different host
curl -v --max-time 5 https://api.openai.com/ 2>&1 | grep -E "(403|policy_denied|refused)"
# Expected: HTTP 403

exit  # exit sandbox shell
```

Check the deny log from the host:

```bash
openshell logs "zeroclaw-${CARD_ID}" --since 5m --source sandbox
# Expected lines like:
# [timestamp] [sandbox] [OCSF] NET:OPEN [MED] DENIED /usr/bin/curl -> 8.8.8.8:443 [reason:network connections not allowed by policy]
```

**Pass criteria:**
- Allowed endpoint returns 200
- Blocked endpoints return 403 with `policy_denied` in body (not timeout, not connection refused)
- Every denied attempt appears in the sandbox log

---

## §H — Startup: connect latency

```bash
time openshell sandbox create \
  --name "zeroclaw-latency-test" \
  --policy "spikes/openshell/openshell-policy.example.yaml" \
  --image ubuntu:24.04 \
  --no-keep

# Note wall-clock time from command start to sandbox-ready.
# The sandbox is Docker-based; ZeroClaw startup is separate from container startup.
# Record both: container-ready time, and time until ZeroClaw health endpoint responds.
```

---

## §I — Extrapolation to 18 cards

Fill in after §F measurements:

| Metric | 1 card (measured) | 18 cards (projected) | VPS headroom |
|--------|-------------------|----------------------|--------------|
| ZeroClaw RSS | ___ MB | ___ MB | 1 GB RAM VPS |
| Full sandbox (container) | ___ MB | ___ MB | |
| Gateway overhead (shared) | ___ MB | shared, once | |
| Startup latency | ___ s | parallel, so same | |
| Egress 403 confirmed | pass/fail | all must pass | |

**Projection formula:**

```
18_card_total_mb = per_sandbox_mb * 18 + gateway_overhead_mb
```

**Acceptable range:** ≤ 700 MB resident (leaves 300 MB for OS + herdr runner on 1 GB VPS).  
Fill measured values above, then run the formula. Do not pre-claim a result.  
If over budget, evaluate shared PocketBase (one process, N schemas) as mitigation — measure that too.

---

## §J — Teardown

```bash
CARD_ID="dna_51aeb3da"
openshell sandbox delete "zeroclaw-${CARD_ID}"

# Stop gateway
kill $GATEWAY_PID 2>/dev/null || pkill openshell-gateway
```

---

## Spike exit criteria

| # | Check | Evidence |
|---|-------|----------|
| 1 | Kernel ≥ 5.13 (Landlock) | `uname -r` output |
| 2 | Gateway starts, health 200 | `curl http://127.0.0.1:8080/health` |
| 3 | Sandbox creates without error | `openshell sandbox list` |
| 4 | Allowed endpoint reachable | curl → 200 from inside sandbox |
| 5 | Blocked endpoint returns 403 | curl → 403 + `policy_denied` |
| 6 | Denied attempts in log | `openshell logs` output |
| 7 | RAM per sandbox measured | §F docker stats numbers |
| 8 | 18-card projection ≤ 700 MB | §I table filled |

All 8 green → OpenShell is production-ready for Phase 2. Record results in `SPIKE_REPORT.md`.

---

## Blocker: SSH access

Outbound SSH to `2.25.70.156:22` is blocked from the dev VM since September.  
To run this runbook: Justin runs it directly as `agents` user, or Hermes routes it via its established gateway path from the F1–F5 work.  
Start with the pre-flight — `uname -r` and `docker info` output unblocks everything else.
