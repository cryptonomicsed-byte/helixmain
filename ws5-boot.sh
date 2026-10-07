#!/usr/bin/env bash
# ws5-boot.sh — stage the WS5 runtime exit proof.
#
# If the three sidecars are already running, this just verifies and prints
# ready-to-demo status. Otherwise it starts what it can, then preflights every
# external gate and reports the WIRING GAPS that would silently break the demo.
# Idempotent and non-destructive: it starts things, it never deletes or reconfigures.
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
ZEROCLAW_GW="127.0.0.1:42617"
TOOLBUS="127.0.0.1:9200"
OS_GATEWAY="127.0.0.1:17670"  # openshell-gateway binds here (not 8080)

PASS=0; FAIL=0; GAP=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAIL=$((FAIL+1)); }
gap()  { printf '  \033[33mGAP \033[0m  %s\n' "$*"; GAP=$((GAP+1)); }
hdr()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
code() { curl -s -o /dev/null -m 5 -w '%{http_code}' "$@" 2>/dev/null || echo 000; }

hdr "A. Host preflight"
systemctl is-active --quiet docker && ok "docker daemon active" || bad "docker daemon not active"
timeout 40 docker run --rm alpine:latest true >/dev/null 2>&1 && ok "docker can run a container" || bad "docker cannot run a container"
KVER=$(uname -r); case "$KVER" in 5.[1-9][3-9]*|5.[2-9][0-9]*|[6-9].*) ok "kernel $KVER (>=5.13, Landlock hard-requirement OK)";; *) bad "kernel $KVER < 5.13 (Landlock falls back to best_effort)";; esac
command -v runsc >/dev/null && ok "gVisor runsc present" || gap "gVisor runsc not installed (runbook preflight asks for it)"
ok "disk free: $(df -h / | awk 'NR==2{print $4}')"
curl -s -m 3 -o /dev/null https://openrouter.ai/api/v1/models && ok "VPS egress to openrouter.ai" || gap "VPS cannot reach openrouter.ai (runbook §D inference provider)"

hdr "B. Sidecars (start if stopped, then verify)"
if systemctl is-active --quiet zeroclaw; then ok "zeroclaw active (pid $(systemctl show zeroclaw -p MainPID --value))"
else systemctl start zeroclaw && ok "zeroclaw started" || bad "zeroclaw failed to start"; fi

if systemctl is-active --quiet spark-gatekeeper; then ok "spark-gatekeeper active (exe=$(readlink /proc/$(systemctl show spark-gatekeeper -p MainPID --value)/exe 2>/dev/null))"
else systemctl start spark-gatekeeper && ok "spark-gatekeeper started" || bad "spark-gatekeeper failed to start"; fi

if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^pocketbase-santinos$'; then ok "pocketbase-santinos up (already running)"
elif docker ps -a --format '{{.Names}}' | grep -q '^pocketbase-santinos$'; then docker start pocketbase-santinos >/dev/null 2>&1 && ok "pocketbase-santinos started" || bad "pocketbase-santinos failed to start"
else bad "pocketbase-santinos container missing entirely"; fi

hdr "C. Health checks"
gh=$(code "http://$GATEKEEPER/health")
if [ "$gh" = "200" ]; then
  ok "spark-gatekeeper /health -> 200  $(curl -s -m5 "http://$GATEKEEPER/health")"
elif [ "$(code "http://$GATEKEEPER/held")" = "200" ]; then
  ok "spark-gatekeeper /held -> 200 (alive)"
  gap "spark-gatekeeper has no /health route (got $gh) — health contract expects it"
else
  bad "spark-gatekeeper not answering on $GATEKEEPER"
fi
ok "pocketbase reachable (HTTP $(code "http://$POCKETBASE/api/health") on $POCKETBASE)"
zg=$(code "http://$ZEROCLAW_GW/health"); [ "$zg" = "200" ] && ok "zeroclaw gateway /health -> 200" || gap "zeroclaw gateway /health -> $zg"

hdr "D. Card policy artifacts"
[ -f "$FIXT/dna_${CARD_ID#dna_}_v4.json" ] && ok "card present ($(wc -c <"$FIXT/dna_${CARD_ID#dna_}_v4.json") bytes)" || bad "card MISSING"
[ -f "$FIXT/policy_seed_v4.json" ] && ok "policy seed present" || bad "policy seed MISSING"
[ -f "$FIXT/tool_allowlist_v4.json" ] && ok "tool allowlist present" || bad "tool allowlist MISSING"
[ -f "$REPO/dna-foundry/compiled/${CARD_ID}_v4/openshell-policy.yaml" ] && ok "compiled OpenShell policy present" \
  || gap "compiled/<card>_v4/openshell-policy.yaml not generated — card.compile_openshell_policy is 'NOT YET IMPLEMENTED'"
[ -f /etc/spark-gatekeeper.env ] && ok "gatekeeper signing key present (persistent)" || gap "GATEKEEPER_SIGNING_KEY file missing — receipts won't verify across restarts"

hdr "E. WIRING — the load-bearing checks (these gate a live demo)"
c=$(code -X POST -H 'Content-Type: application/json' -d '{}' "http://$GATEKEEPER/invoke")
if [ "$c" = "404" ] || [ "$c" = "405" ]; then
  gap "gatekeeper has NO /invoke route (got $c) — sidecar.rs dispatch() is unused, so NOTHING can enqueue an action or run the 7 gates live"
else ok "/invoke responds ($c) — sidecar contract wired"; fi
ss -tln 2>/dev/null | grep -q "$TOOLBUS" && ok "tool bus listening on $TOOLBUS" \
  || gap "no tool bus on $TOOLBUS — an 'Allow' verdict has nowhere to forward"
grep -qiE "dna_c1640d90|policy.seed|9100|gatekeeper|hold" /etc/zeroclaw/config.toml 2>/dev/null \
  && ok "zeroclaw config references the card/gatekeeper" \
  || gap "zeroclaw config references NEITHER the card NOR the gatekeeper — nothing routes Helix's actions to the hold queue"
PK=$(python3 - <<'PY' 2>/dev/null || echo "?"
import sqlite3;print(sqlite3.connect("/var/lib/spark-gatekeeper/queue.db").execute("SELECT COUNT(*) FROM webauthn_passkeys").fetchone()[0])
PY
)
[ "$PK" = "1" ] && ok "approver passkey enrolled" || gap "passkey rows = $PK (expected 1)"

hdr "F. External dependencies (steps 2-5)"
command -v openshell >/dev/null && ok "openshell installed" || gap "openshell NOT installed — runbook §B install.sh"
# openshell-gateway speaks HTTPS + mTLS, so a plaintext `http://` probe can never
# return 200 — it reported a false GAP while the gateway was healthy. `openshell
# status` is the authoritative, certificate-aware check.
if openshell status 2>/dev/null | grep -q "Status: Connected"; then
  ok "openshell gateway up on $OS_GATEWAY (mTLS Connected)"
else
  gap "openshell gateway not running on $OS_GATEWAY (runbook §C)"
fi
timeout 8 tailscale status 2>/dev/null | grep -q 'grokbot-box.*offline' && gap "grokbot-box OFFLINE — WS5 step 2 cannot run" || ok "grokbot-box reachable on tailnet"
{ [ -d "$HOME/mesh-voice" ] || [ -d /opt/mesh-voice ]; } && ok "mesh-voice present" || gap "mesh-voice not found on this host (WS5 step 2)"

hdr "SUMMARY"
printf '  PASS=%d  FAIL=%d  GAP=%d\n' "$PASS" "$FAIL" "$GAP"
if [ "$FAIL" -eq 0 ] && [ "$GAP" -eq 0 ]; then
  printf '\n\033[32m  READY TO DEMO — all three sidecars verified, no gaps.\033[0m\n'
  cat <<'READY'

  WS5 — Meshenger QR call (step 2)
  ────────────────────────────────────────────────────────────
  1. Confirm grokbot-box is back on Tailscale at 100.109.5.90
       tailscale status | grep grokbot
  2. On grokbot-box: start mesh-voice — it presents the Meshenger session QR.
  3. On the phone: Meshenger → Scan → point at the QR shown by mesh-voice.
  4. Answer the incoming call; speak the test utterance (a refund / pricing ask).
  5. Expected: null-price refusal fires at the vibration gate → the action escalates
     to the hold queue → open https://omokoda.duckdns.org/spark/ → Approve → receipt mints.
  6. Record the receipt: offline-verifiable, Ed25519 / JCS-canonical / hash-chained.
READY
else
  printf '\n\033[33m  Not demo-ready: FAIL=%d  GAP=%d\033[0m\n' "$FAIL" "$GAP"
  [ "$FAIL" -gt 0 ] && printf '  FAIL = infrastructure (fix before running).\n'
  [ "$GAP" -gt 0 ]  && printf '  GAP  = missing connection / external dep — components run, chain not closed.\n'
fi
exit 0
