# OpenShell Sandbox Spike — VPS Runbook
## One card · one sandbox · kernel-enforced egress

**Target:** Hostinger VPS `2.25.70.156`, `agents` user  
**Card under test:** `dna_51aeb3da` v3 (Harbor & Bean Coffee House, demo fixture)  
**Goal:** Prove that a ZeroClaw instance inside an OpenShell-enforced sandbox (a) boots under 10ms, (b) idles under 5MB RAM, and (c) cannot reach any host outside its allowlist — verified at the kernel, not in userspace.  
**Extrapolation target:** 18 simultaneous card sandboxes fit the VPS within margin.

---

## Pre-flight checklist (run as `agents` user)

```bash
# 1. Confirm Docker availability
which docker && docker info 2>&1 | head -20
# Expected: daemon running, storage driver overlayfs or overlay2.
# If "permission denied": try `sudo docker info` or check if `herdr` wraps it.
# If not installed: see §A below.

# 2. Kernel version — Landlock requires ≥ 5.13
uname -r
# If < 5.13, Landlock is absent; flag to Justin before continuing.

# 3. gVisor (runsc) available?
which runsc || echo "gVisor not installed"
# Needed for full Docker+gVisor isolation. Without it, use --runtime=runc as fallback
# (still gets OpenShell enforcement; just loses gVisor's syscall filter layer).

# 4. Disk space — 18 sandboxes need headroom
df -h /var/lib/docker 2>/dev/null || df -h /

# 5. Check outbound connectivity from VPS to inference endpoint
curl -s --max-time 3 -o /dev/null -w "%{http_code}" https://api.deepseek.com/health || echo "blocked"
```

---

## §A — Install Docker (if absent)

```bash
# Debian/Ubuntu on Hostinger:
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker agents
# Re-login or: newgrp docker
docker info
```

---

## §B — Install OpenShell

OpenShell ships as a single Rust binary + kernel module loader. The binary enforces
Landlock filesystem rules and intercepts connect(2) via eBPF/LSM hook.

```bash
# Pull the release binary (check https://github.com/nvidia/open-shell/releases for latest)
OPENSHELL_VERSION="0.4.2"
curl -fsSL "https://github.com/nvidia/open-shell/releases/download/v${OPENSHELL_VERSION}/open-shell-x86_64-linux.tar.gz" \
  | tar -xz -C /usr/local/bin/
chmod +x /usr/local/bin/open-shell

# Verify
open-shell --version

# Load the LSM companion (requires CAP_SYS_ADMIN or sudo once at boot):
sudo open-shell load-lsm
# Confirm:
open-shell status
# Expected: "LSM hook: active, Landlock: available"
```

> **Note:** If `sudo` is unavailable to `agents` user, ask Justin to run `open-shell load-lsm` once
> and confirm via `open-shell status`. The enforcement layer persists until reboot.

---

## §C — Prepare card sandbox files

```bash
# Working directory on VPS
SANDBOX_ROOT="/home/agents/sandboxes"
CARD_ID="dna_51aeb3da"
mkdir -p "${SANDBOX_ROOT}/${CARD_ID}"/{data,minipae,tmp}

# Copy compiled outputs from local helixmain repo (via scp or gh-push.py surrogate):
#   dna-foundry/compiled/dna_51aeb3da_v3/openshell-policy.yaml → VPS

# Place policy
cp openshell-policy.yaml "${SANDBOX_ROOT}/${CARD_ID}/openshell-policy.yaml"

# Pull ZeroClaw image (< 3.4 MB, target < 5 MB idle)
docker pull ghcr.io/helixmain/zeroclaw:latest
docker images ghcr.io/helixmain/zeroclaw:latest --format "{{.Size}}"
# Expected: < 10MB compressed. Fail if > 20MB — image bloat means we need to rebuild.

# Pull PocketBase (ops store, runs as sidecar)
docker pull ghcr.io/helixmain/pocketbase-card:latest
```

---

## §D — Boot the sandbox

```bash
CARD_ID="dna_51aeb3da"
SANDBOX_ROOT="/home/agents/sandboxes"
POLICY="${SANDBOX_ROOT}/${CARD_ID}/openshell-policy.yaml"

# Boot hold-queue sidecar first (ZeroClaw connects to it on startup)
docker run -d \
  --name "hq-${CARD_ID}" \
  --network bridge \
  -p 127.0.0.1:9100:9100 \
  ghcr.io/helixmain/hold-queue-sidecar:latest

# Boot PocketBase ops store
docker run -d \
  --name "pb-${CARD_ID}" \
  --network bridge \
  -p 127.0.0.1:8090:8090 \
  -v "${SANDBOX_ROOT}/${CARD_ID}/data:/pb_data" \
  ghcr.io/helixmain/pocketbase-card:latest

# Boot ZeroClaw inside OpenShell enforcement
# open-shell exec wraps the container process with Landlock + connect hook
docker run -d \
  --name "zc-${CARD_ID}" \
  --runtime=runsc \
  --network bridge \
  --memory=256m \
  --cpu-shares=512 \
  -v "${SANDBOX_ROOT}/${CARD_ID}/data:/data/sandbox/${CARD_ID}" \
  -v "${SANDBOX_ROOT}/${CARD_ID}/minipae:/data/minipae/${CARD_ID}" \
  -v "${SANDBOX_ROOT}/${CARD_ID}/tmp:/tmp/sandbox-${CARD_ID}" \
  -e CARD_ID="${CARD_ID}" \
  -e HOLD_QUEUE_URL="http://127.0.0.1:9100" \
  -e POCKETBASE_URL="http://127.0.0.1:8090" \
  ghcr.io/helixmain/zeroclaw:latest \
  open-shell exec --policy="${POLICY}" -- zeroclaw serve

# Confirm all three are running
docker ps --filter "name=${CARD_ID}" --format "table {{.Names}}\t{{.Status}}"
```

---

## §E — Measure idle RAM

Wait 30s for ZeroClaw to finish startup, then:

```bash
CARD_ID="dna_51aeb3da"

# RSS of the ZeroClaw process (not Docker overhead)
docker exec "zc-${CARD_ID}" cat /proc/1/status | grep -E "^(VmRSS|VmPeak|VmSize)"

# Full container memory via Docker stats (one-shot)
docker stats --no-stream "zc-${CARD_ID}" "pb-${CARD_ID}" "hq-${CARD_ID}" \
  --format "table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}"
```

**Pass criteria:**
- `zc-` VmRSS ≤ 5 MB
- `pb-` + `hq-` combined ≤ 60 MB (PocketBase is the heavy sidecar)
- Full stack (all three containers) ≤ 80 MB resident

---

## §F — Verify egress denial at kernel

This is the proof step. OpenShell must drop the connection before `connect(2)` returns,
not after userspace rejects it.

```bash
CARD_ID="dna_51aeb3da"

# Attempt 1: allowed endpoint — must succeed
docker exec "zc-${CARD_ID}" \
  curl -s --max-time 3 -o /dev/null -w "ALLOWED:%{http_code}\n" \
  http://127.0.0.1:9100/health
# Expected: ALLOWED:200

# Attempt 2: blocked endpoint — must fail at kernel (ECONNREFUSED or EPERM, not timeout)
docker exec "zc-${CARD_ID}" \
  curl -v --max-time 3 http://8.8.8.8:80/ 2>&1 | tail -5
# Expected: "connect: Operation not permitted" (EPERM from LSM hook)
# Fail if: timeout (means hook isn't blocking, just slow) or if connection succeeds

# Attempt 3: inference endpoint subdomain substitution (must block non-allowlisted subdomains)
docker exec "zc-${CARD_ID}" \
  curl -v --max-time 3 https://exfil.attacker.com/ 2>&1 | tail -5
# Expected: EPERM

# Strace the blocked connect for the kernel audit trail:
docker exec "zc-${CARD_ID}" \
  strace -e connect curl --max-time 2 http://1.2.3.4/ 2>&1 | grep -E "connect|EPERM|refused"
```

**Pass criteria:**
- Allowed: HTTP 200 from hold-queue sidecar health endpoint
- Blocked: `EPERM` (not `ETIMEDOUT`) — proves kernel enforcement not firewall timeout
- No TCP SYN visible in `tcpdump` on the host for blocked destinations

```bash
# Confirm via tcpdump on host (run as root / with sudo):
sudo tcpdump -c 10 -i any dst host 1.2.3.4 2>&1
# Expected: zero packets captured — kernel dropped before network stack
```

---

## §G — Startup latency check

```bash
# Time from docker run to ZeroClaw ready (health endpoint responding)
time docker run --rm \
  --name "zc-latency-test" \
  --runtime=runsc \
  ghcr.io/helixmain/zeroclaw:latest \
  open-shell exec --policy="${POLICY}" -- zeroclaw serve --health-check-exit
# Expected: < 10s wall clock (gVisor adds ~1-2s; ZeroClaw startup target < 10ms)

# Isolate ZeroClaw startup time alone (without gVisor overhead):
docker run --rm \
  --name "zc-latency-runc" \
  --runtime=runc \
  ghcr.io/helixmain/zeroclaw:latest \
  open-shell exec --policy="${POLICY}" -- zeroclaw serve --health-check-exit
```

---

## §H — Extrapolation to 18 cards

With measurements from §E and §F in hand, fill in this table:

| Metric | 1 card (measured) | 18 cards (projected) | VPS headroom |
|--------|-------------------|----------------------|--------------|
| ZeroClaw RSS | ___ MB | ___ MB | 1GB RAM VPS |
| Full stack RSS | ___ MB | ___ MB | |
| Startup latency | ___ ms | parallel, so same | |
| Egress: EPERM confirmed | pass/fail | all must pass | |

**Projection formula:**
```
18_card_total_mb = (zeroclaw_rss_mb + pb_rss_mb + hq_rss_mb) * 18
                 + shared_base_mb   # kernel, Docker daemon, OpenShell LSM
```

**Acceptable range:** Total ≤ 700 MB resident (leaves 300 MB for OS + herdr runner on 1 GB VPS).  
If ZeroClaw idles at 3 MB and sidecars at 60 MB → (63 MB × 18) = 1,134 MB — **over budget**.  
Mitigation: share one PocketBase instance per 3–4 cards (separate schemas, one process).  
Shared-PocketBase projection: (3 MB ZeroClaw × 18) + (5 PocketBase × 15 MB) = 129 MB. **In budget.**

---

## §I — Teardown

```bash
CARD_ID="dna_51aeb3da"
docker stop "zc-${CARD_ID}" "pb-${CARD_ID}" "hq-${CARD_ID}"
docker rm   "zc-${CARD_ID}" "pb-${CARD_ID}" "hq-${CARD_ID}"
```

---

## Spike exit criteria

| # | Check | Evidence |
|---|-------|----------|
| 1 | Docker available on VPS | `docker info` output |
| 2 | Kernel ≥ 5.13 (Landlock) | `uname -r` output |
| 3 | OpenShell LSM active | `open-shell status` output |
| 4 | ZeroClaw boots < 10s | §G timing |
| 5 | ZeroClaw idle ≤ 5 MB RSS | §E `/proc/1/status` |
| 6 | Egress denied with EPERM | §F strace output |
| 7 | No SYN to blocked dest | §F tcpdump output |
| 8 | 18-card projection ≤ 700 MB | §H table |

All 8 green → OpenShell is production-ready for Phase 2. Record results in `SPIKE_REPORT.md`.

---

## Blocker: SSH access

Outbound SSH to `2.25.70.156:22` is currently blocked from the dev VM (egress proxy, blocked
since September). To run this runbook:

**Option A — Justin runs it directly** as `agents` user, pastes output back.  
**Option B — Hermes runs it** via its established gateway path from the F1–F5 work.  
**Option C — `herdr` runner** on the VPS executes it as a job if herdr has shell dispatch.

Start with the pre-flight (§B pre-flight checklist) and report back `docker info` output.
That single answer unblocks everything else.
