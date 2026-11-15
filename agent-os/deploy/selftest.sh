#!/usr/bin/env bash
# A full deploy drill in a throwaway directory, no root and no systemd:
#   build -> bootstrap -> start -> smoke -> do real work -> backup -> destroy the kernel database -> restore -> start -> prove nothing was lost
# This is what "deployed, monitored and restored without manual workarounds" means for this repository.
# Needs: go, cargo (the kernel binary is built if missing), java, curl, python3.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/.." && pwd)"
T="$(mktemp -d)"; trap '"$HERE/run-stack.sh" stop --prefix "$T" >/dev/null 2>&1 || true; rm -rf -- "${T:?}"' EXIT
step() { echo; echo "== $*"; }
BASE=$((20000 + RANDOM % 20000))

step "build the binaries"
mkdir -p "$T/bin"
( cd "$ROOT/gateway" && go build -o "$T/bin/helix-gateway" ./cmd/helix-gateway && go build -o "$T/bin/helix-resolver" ./cmd/helix-resolver )
( cd "$ROOT/kernel" && cargo build --bin helix-kernel 2>&1 | tail -1 )
cp "$ROOT/kernel/target/debug/helix-kernel" "$T/bin/helix-kernel"

step "bootstrap into a throwaway prefix"
HELIX_ORG=org_default "$HERE/bootstrap.sh" --bin "$T/bin" --prefix "$T/root" --port-base "$BASE" | sed 's/^/  /'
ETC="$T/root/etc/helix"
test "$(stat -c %a "$ETC/grant.key")" = 600 || { echo "the signing key must be mode 600" >&2; exit 1; }
test "$(stat -c %a "$ETC/first-tokens.txt")" = 600 || { echo "the token file must be mode 600" >&2; exit 1; }
before_key="$(sha256sum "$ETC/grant.key")"
HELIX_ORG=org_default "$HERE/bootstrap.sh" --bin "$T/bin" --prefix "$T/root" --port-base "$BASE" | grep -c '^kept' | sed 's/^/  second run kept this many existing files: /'
test "$before_key" = "$(sha256sum "$ETC/grant.key")" || { echo "bootstrap must never regenerate the signing key" >&2; exit 1; }

step "for this drill only: trust the public TEST issuer, register an agent, give it a token"
cp "$ROOT/kernel/tests/fixtures/sid-0.2/trust.json" "$ETC/trust.json"
( cd "$ROOT/gateway" && go run ./tools/mintfixtures -sid sid_drill -perms kb.search -out "$T" >/dev/null )
AGENT_OUT="$("$T/bin/helix-gateway" mint-token --id agent-drill --org org_default --principal sid_drill --kind agent 2>"$T/agent.err")"
AGENT_TOKEN="$(grep -A1 '^TOKEN' "$T/agent.err" | tail -1)"
python3 - "$ETC/principals.json" "$AGENT_OUT" <<'PY'
import json, sys
p = json.load(open(sys.argv[1])); p["tokens"].append(json.loads(sys.argv[2])); json.dump(p, open(sys.argv[1], "w"))
PY
sleep 1.2   # the gateway notices registry changes within a second; the stack is not up yet, but keep the order honest

step "start"
"$HERE/run-stack.sh" start --prefix "$T/root"
sleep 1.2
step "smoke"
"$HERE/smoke.sh" --prefix "$T/root"

GW="http://$(. "$ETC/gateway.env"; echo "$HELIX_GATEWAY_LISTEN")"
REG="$(awk '$1=="admin-registrar"{print $2}' "$ETC/first-tokens.txt")"
call() { curl -fsS -H "Authorization: Bearer $1" -H 'Content-Type: application/json' "${@:2}"; }

step "real work: register the agent, let it do routine work"
CERT="$(python3 -c "import json;print(json.dumps({'certificate': json.load(open('$T/agent-cert.json')), 'register': True}))")"
call "$REG" -X POST "$GW/v1/identities/verify" -d "$CERT" | grep -q '"registered":true' && echo "  agent registered"
INTENT='{"intent":{"id":"drill-1","agent_id":"sid_drill","capability":"kb.search","tool":"kb.search","target":"kb:main","operation":"kb.search","risk":"low","idempotency_key":"drill-key-1","audience":"svc:drill"}}'
ANSWER="$(call "$AGENT_TOKEN" -X POST "$GW/v1/actions/authorize" -d "$INTENT")"
echo "$ANSWER" | grep -q '"decision":"allow"' && echo "  routine work was allowed, with a grant" || { echo "unexpected: $ANSWER" >&2; exit 1; }
KID_BEFORE="$(echo "$ANSWER" | python3 -c 'import json,sys;print(json.load(sys.stdin)["grant"]["issuer_kid"])')"
HEALTH_BEFORE="$(call "$REG" "$GW/v1/health")"
ENTRIES_BEFORE="$(echo "$HEALTH_BEFORE" | python3 -c 'import json,sys;print(json.load(sys.stdin)["audit_entries"])')"
HEAD_BEFORE="$(echo "$HEALTH_BEFORE" | python3 -c 'import json,sys;print(json.load(sys.stdin)["audit_head"])')"
echo "  audit chain: $ENTRIES_BEFORE entries, head $HEAD_BEFORE"
test "$ENTRIES_BEFORE" -ge 2

step "metrics saw it"
GM="http://$(. "$ETC/gateway.env"; echo "$HELIX_GATEWAY_METRICS_LISTEN")"
curl -fsS "$GM/metrics" | grep -E '^helix_gateway_decisions_total\{decision="allow",phase="authorize"\} 1$' >/dev/null && echo "  decisions_total{allow} = 1"
curl -fsS "$GM/metrics" | grep -E '^helix_kernel_audit_entries ' | sed 's/^/  /'

step "backup, then lose the kernel database"
"$HERE/backup.sh" --prefix "$T/root" --out "$T/backup.tar.gz" | sed 's/^/  /'
"$HERE/run-stack.sh" stop --prefix "$T/root" >/dev/null
rm -f -- "${T:?}"/root/var/lib/helix/kernel/kernel.sqlite*
test ! -e "$T/root/var/lib/helix/kernel/kernel.sqlite"
echo "  kernel database destroyed"

step "restore"
"$HERE/restore.sh" --prefix "$T/root" --from "$T/backup.tar.gz" | sed 's/^/  /'
"$HERE/run-stack.sh" start --prefix "$T/root"
sleep 1.2
"$HERE/smoke.sh" --prefix "$T/root" >/dev/null && echo "  smoke passes again"

step "prove nothing was lost"
HEALTH_AFTER="$(call "$REG" "$GW/v1/health")"
ENTRIES_AFTER="$(echo "$HEALTH_AFTER" | python3 -c 'import json,sys;print(json.load(sys.stdin)["audit_entries"])')"
HEAD_AFTER="$(echo "$HEALTH_AFTER" | python3 -c 'import json,sys;print(json.load(sys.stdin)["audit_head"])')"
test "$ENTRIES_BEFORE" = "$ENTRIES_AFTER" && test "$HEAD_BEFORE" = "$HEAD_AFTER" && echo "  the audit chain is intact: $ENTRIES_AFTER entries, same head"
ANSWER2="$(call "$AGENT_TOKEN" -X POST "$GW/v1/actions/authorize" -d "${INTENT/drill-1/drill-2}")"
KID_AFTER="$(echo "$ANSWER2" | python3 -c 'import json,sys;print(json.load(sys.stdin)["grant"]["issuer_kid"])')"
test "$KID_BEFORE" = "$KID_AFTER" && echo "  grants are still signed by the same key ($KID_AFTER): the agent registry and the key survived"

step "a tampered backup is refused before anything is written"
mkdir -p "$T/tamper"; tar -C "$T/tamper" -xzf "$T/backup.tar.gz"
printf 'x' >> "$T/tamper/etc/policy.edn"
tar -C "$T/tamper" -czf "$T/tampered.tar.gz" .
"$HERE/run-stack.sh" stop --prefix "$T/root" >/dev/null
if WHY="$("$HERE/restore.sh" --prefix "$T/root" --from "$T/tampered.tar.gz" 2>&1)"; then echo "a tampered archive was accepted" >&2; exit 1; fi
echo "$WHY" | grep -q "does not match its manifest" && echo "  refused: it does not match its manifest" || { echo "refused for the wrong reason: $WHY" >&2; exit 1; }

echo; echo "selftest: the deploy drill passed"
