#!/usr/bin/env bash
# What a running install must answer. Exits non-zero on the first thing that does not.
#   ./smoke.sh --prefix DIR [--resolver]
set -euo pipefail
PREFIX="/"; WITH_RESOLVER=0
while [ $# -gt 0 ]; do case "$1" in --prefix) PREFIX="$2"; shift 2;; --resolver) WITH_RESOLVER=1; shift;; *) echo "unknown argument $1" >&2; exit 2;; esac; done
PREFIX="${PREFIX%/}"; ETC="$PREFIX/etc/helix"
val() { ( set -a; . "$1"; set +a; eval "echo \${$2}" ); }
GW="http://$(val "$ETC/gateway.env" HELIX_GATEWAY_LISTEN)"; GM="http://$(val "$ETC/gateway.env" HELIX_GATEWAY_METRICS_LISTEN)"
POL="http://127.0.0.1:$(val "$ETC/policy.env" HELIX_POLICY_PORT)"
ok() { echo "ok   $1"; }
fail() { echo "FAIL $1" >&2; exit 1; }

curl -fsS "$POL/health" | grep -q '"status":"ok"' && ok "policy is healthy and has a valid policy loaded" || fail "policy health"
curl -fsS "$GW/healthz" | grep -q ok && ok "gateway process is up" || fail "gateway healthz"
curl -fsS "$GW/readyz" | grep -q ready && ok "gateway can authenticate callers and reach the kernel" || fail "gateway readyz"

code=$(curl -s -o /dev/null -w '%{http_code}' "$GW/v1/health"); [ "$code" = 401 ] && ok "an unauthenticated call is refused (401)" || fail "unauthenticated health returned $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer hxg_notarealtoken' "$GW/v1/health"); [ "$code" = 401 ] && ok "a made-up token is refused (401)" || fail "bad token returned $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$GW/v1/actions/authorize"); [ "$code" = 401 ] && ok "an unauthenticated authorize is refused (401)" || fail "authorize returned $code"

TOKFILE="$ETC/first-tokens.txt"
if [ -r "$TOKFILE" ]; then
  tok="$(awk '$1=="admin-registrar"{print $2}' "$TOKFILE")"
  body=$(curl -fsS -H "Authorization: Bearer $tok" "$GW/v1/health") && echo "$body" | grep -q '"policy_available":true' && ok "kernel is up and sees the policy service" || fail "kernel health: ${body:-none}"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' -d '{"intent":{}}' "$GW/v1/actions/authorize"); [ "$code" = 403 ] && ok "a service cannot propose actions without the proposer role (403)" || fail "role check returned $code"
fi

metrics="$(curl -fsS "$GM/metrics")"
for m in helix_gateway_requests_total helix_gateway_auth_failures_total helix_kernel_up helix_kernel_policy_available helix_gateway_registry_ok; do
  echo "$metrics" | grep -q "^$m" && ok "metric $m is exported" || fail "metric $m missing"
done
echo "$metrics" | grep -q '^helix_kernel_up 1' && ok "kernel_up is 1" || fail "kernel_up is not 1"

if [ "$WITH_RESOLVER" = 1 ]; then
  RS="http://$(val "$ETC/resolver.env" HELIX_RESOLVER_LISTEN)"; RM="http://$(val "$ETC/resolver.env" HELIX_RESOLVER_METRICS_LISTEN)"
  curl -fsS "$RS/healthz" | grep -q ok && ok "resolver is up" || fail "resolver healthz"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$RS/q/aaaa"); [ "$code" = 421 ] && ok "the resolver refuses requests addressed to another host (421)" || fail "misdirected returned $code"
  curl -fsS "$RM/metrics" | grep -q helix_resolver_lookups_total && ok "resolver metrics are exported" || fail "resolver metrics"
fi
echo "smoke: all checks passed"
