#!/usr/bin/env bash
# ws5-boot.sh — stage the WS5 runtime exit proof.
#
# Boots/verifies the three sidecars and preflights every external gate, then
# reports the WIRING GAPS that would silently break the live demo. Idempotent
# and non-destructive: it starts things, it never deletes or reconfigures.
#
# Run ON THE VPS (hostinger 2.25.70.156):
#   scp ws5-boot.sh hostinger:/opt/helixmain/ && ssh hostinger 'bash /opt/helixmain/ws5-boot.sh'
#
# Card under test: dna_c1640d90 (Santino's Pizza) v4
# Spec: docs/ROADMAP.md §5 · spikes/openshell/VPS_RUNBOOK.md
set -uo pipefail

CARD_ID="dna_c1640d90"
REPO="/opt/helixmain"
FIXT="$REPO/spark-gatekeeper/tests/fixtures"
GATEKEEPER="127.0.0.1:9100"
POCKETBASE="127.0.0.1:8090"
TOOLBUS="127.0.0.1:9200"
OS_GATEWAY="127.0.0.1:8080"

PASS=0; FAIL=0; GAP=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAIL=$((FAIL+1)); }
gap()  { printf '  \033[33mGAP \033[0m  %s\n' "$*"; GAP=$((GAP+1)); }
hdr()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
code() { curl -s -o /dev/null -m 5 -w '%{http_code}' "$@" 2>/dev/null || echo 000; }

hdr "A. Host preflight"
if systemctl is-active --quiet docker; then ok "docker daemon active"
else bad "docker daemon not active"; fi
if timeout 40 docker run --rm alpine:latest true >/dev/null 2>&1; then ok "docker can run a container"
else bad "docker cannot run a container"; fi
KVER=$(uname -r); case "$KVER" in 5.[1-9][3-9]*|5.[2-9][0-9]*|[6-9].*) ok "kernel $KVER (>=5.13, Landlock hard-requirement OK)";; *) bad "kernel $KVER < 5.13 (Landlock falls back to best_effort)";; esac
command -v runsc >/dev/null && ok "gVisor runsc present ($(runsc --version 2>/dev/null | head -1))" || gap "gVisor runsc not installed (runbook preflight asks for it)"
FREE=$(df -h / | awk 'NR==2{print $4}'); ok "disk free: $FREE"
curl -s -m 3 -o /dev/null -w '' https://openrouter.ai/api/v1/models && ok "VPS egress to openrouter.ai" || gap "VPS cannot reach openrouter.ai (runbook §D inference provider)"

hdr "B. Sidecars"
# ZeroClaw (Helix)
if systemctl is-active --quiet zeroclaw; then ok "zeroclaw active ($(systemctl show zeroclaw -p MainPID --value))"
else bad "zeroclaw not active — run: systemctl start zeroclaw"; fi
# SparkGatekeeper
if systemctl is-active --quiet spark-gatekeeper; then ok "spark-gatekeeper active (exe=$(readlink /proc/$(systemctl show spark-gatekeeper -p MainPID --value)/exe 2>/dev/null))"
else bad "spark-gatekeeper not active — run: systemctl start spark-gatekeeper"; fi
# PocketBase (docker)
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^pocketbase-santinos$'; then ok "pocketbase-santinos container up"
else
  if docker ps -a --format '{{.Names}}' | grep -q '^pocketbase-santinos$'; then docker start pocketbase-santinos >/dev/null 2>&1 && ok "pocketbase-santinos started" || bad "pocketbase-santinos failed to start"
  else bad "pocketbase-santinos container missing entirely"; fi
fi

hdr "C. Listener / endpoint checks"
for pair in "gatekeeper:$GATEKEEPER/held" "pocketbase:$POCKETBASE/api/health"; do
  name=${pair%%:*}; url=${pair#*:}
  c=$(code "http://$url")
  case "$name:$c" in
    gatekeeper:200) ok "gatekeeper /held -> 200";;
    gatekeeper:*)   bad "gatekeeper /held -> $c (expected 200)";;
    pocketbase:*)   ok "pocketbase reachable (HTTP $c) — any code means the port answers";;
  esac
done

hdr "D. Card policy artifacts"
for f in "dna_${CARD_ID#dna_}_v4.json:card" "policy_seed_v4.json:policy seed" "tool_allowlist_v4.json:tool allowlist"; do
  fn=${f%%:*}; label=${f#*:}
  [ -f "$FIXT/$fn" ] && ok "$label present ($(wc -c <"$FIXT/$fn") bytes)" || bad "$label MISSING ($FIXT/$fn)"
done
if [ -f "$REPO/dna-foundry/compiled/${CARD_ID}_v4/openshell-policy.yaml" ]; then ok "compiled OpenShell policy present"
else gap "compiled/<card>_v4/openshell-policy.yaml NOT generated — card.compile_openshell_policy is 'NOT YET IMPLEMENTED'; only the hand-authored example exists"; fi
[ -f /etc/spark-gatekeeper.env ] && ok "gatekeeper signing key present (persistent)" || gap "GATEKEEPER_SIGNING_KEY file missing — receipts won't verify across restarts"

hdr "E. WIRING — the load-bearing checks (these gate a live demo)"
# E1: can anything submit an action into the gate engine?
c=$(code -X POST -H 'Content-Type: application/json' -d '{}' "http://$GATEKEEPER/invoke")
if [ "$c" = "404" ] || [ "$c" = "405" ]; then
  gap "gatekeeper has NO /invoke route (got $c). sidecar.rs documents the contract but dispatch() is unused and the binary never wires it — NOTHING can enqueue an action or run the 7 gates on a real request"
else ok "/invoke responds ($c) — sidecar contract is wired"; fi
# E2: the tool bus an Allow verdict would forward to
if ss -tln 2>/dev/null | grep -q "$TOOLBUS"; then ok "tool bus listening on $TOOLBUS"
else gap "no tool bus on $TOOLBUS — an 'Allow' verdict has nowhere to forward (sidecar.rs SidecarConfig.tool_bus_url default)"; fi
# E3: is ZeroClaw bound to the card or the gatekeeper at all?
if grep -qiE "dna_c1640d90|policy.seed|9100|gatekeeper|hold" /etc/zeroclaw/config.toml 2>/dev/null; then
  ok "zeroclaw config references the card/gatekeeper"
else
  gap "zeroclaw config references NEITHER the card NOR the gatekeeper — agents.helix.system_prompt is generic; nothing routes Helix's actions to the hold queue"
fi
# E4: passkey enrolled (approval surface usable)
PK=$(python3 - <<'PY' 2>/dev/null || echo "?"
import sqlite3;print(sqlite3.connect("/var/lib/spark-gatekeeper/queue.db").execute("SELECT COUNT(*) FROM webauthn_passkeys").fetchone()[0])
PY
)
[ "$PK" = "1" ] && ok "approver passkey enrolled" || gap "passkey rows = $PK (expected 1)"

hdr "F. External dependencies for steps 2-5"
if command -v openshell >/dev/null; then ok "openshell installed ($(openshell --version 2>/dev/null))"
else gap "openshell NOT installed — runbook §B: curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh"; fi
code "http://$OS_GATEWAY/health" | grep -q 200 && ok "openshell gateway up on $OS_GATEWAY" || gap "openshell gateway not running on $OS_GATEWAY (runbook §C)"
timeout 8 tailscale status 2>/dev/null | grep -q 'grokbot-box.*offline' && gap "grokbot-box OFFLINE — WS5 step 2 (Meshenger QR call) cannot run" || ok "grokbot-box reachable via tailnet"
[ -d "$HOME/mesh-voice" ] || [ -d /opt/mesh-voice ] && ok "mesh-voice present on this host" || gap "mesh-voice not found on this host (WS5 step 2)"

hdr "SUMMARY"
printf '  PASS=%d  FAIL=%d  GAP=%d\n' "$PASS" "$FAIL" "$GAP"
if [ "$GAP" -gt 0 ]; then
  printf '\n  \033[33mBoot is staged, but %d wiring/external gap(s) will block a live demo.\033[0m\n' "$GAP"
  printf '  The components run; the CONNECTIONS between them do not yet exist.\n'
fi
exit 0
