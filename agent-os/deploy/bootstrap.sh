#!/usr/bin/env bash
# Lay out a HELIX install and generate what must exist before the services start.
# Idempotent: it never overwrites a key, a registry, a trust file or an env file that is already there.
#
#   sudo ./bootstrap.sh --bin DIR_WITH_BINARIES [--prefix /] [--port-base 8000] [--no-user]
#
# --bin      directory with helix-kernel, helix-gateway, helix-resolver (built with cargo / go build)
# --prefix   install root (default /). With another prefix nothing outside it is touched (used by selftest.sh)
# --no-user  do not create the `helix` system user (implied by a non-/ prefix)
set -euo pipefail

BIN=""; PREFIX="/"; PORT_BASE=""; MAKE_USER=1
while [ $# -gt 0 ]; do
  case "$1" in
    --bin) BIN="$2"; shift 2;;
    --prefix) PREFIX="$2"; shift 2;;
    --port-base) PORT_BASE="$2"; shift 2;;
    --no-user) MAKE_USER=0; shift;;
    *) echo "unknown argument $1" >&2; exit 2;;
  esac
done
[ -n "$BIN" ] || { echo "--bin is required" >&2; exit 2; }
for b in helix-kernel helix-gateway helix-resolver; do [ -x "$BIN/$b" ] || { echo "missing executable $BIN/$b" >&2; exit 2; }; done
[ "$PREFIX" = "/" ] || MAKE_USER=0
PREFIX="${PREFIX%/}"

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OPT="$PREFIX/opt/helix"; ETC="$PREFIX/etc/helix"; VAR="$PREFIX/var/lib/helix"
P_POLICY=${PORT_BASE:+$((PORT_BASE+1))}; P_POLICY=${P_POLICY:-8181}
P_KERNEL=${PORT_BASE:+$((PORT_BASE+2))};  P_KERNEL=${P_KERNEL:-50051}
P_GATEWAY=${PORT_BASE:+$((PORT_BASE+3))}; P_GATEWAY=${P_GATEWAY:-8080}
P_RESOLVER=${PORT_BASE:+$((PORT_BASE+4))}; P_RESOLVER=${P_RESOLVER:-8081}
P_GMETRICS=${PORT_BASE:+$((PORT_BASE+5))}; P_GMETRICS=${P_GMETRICS:-9101}
P_RMETRICS=${PORT_BASE:+$((PORT_BASE+6))}; P_RMETRICS=${P_RMETRICS:-9102}

if [ "$MAKE_USER" = 1 ] && ! id helix >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/helix --shell /usr/sbin/nologin helix
  echo "created system user helix"
fi

mkdir -p "$OPT/bin" "$OPT/policy" "$ETC" "$VAR/kernel" "$VAR/resolver" "$VAR/runs"
chmod 750 "$ETC"; chmod 700 "$VAR/kernel" "$VAR/resolver" "$VAR/runs"

# programs
for b in helix-kernel helix-gateway helix-resolver; do install -m 0755 "$BIN/$b" "$OPT/bin/$b"; done
# the policy service: source, default policy, jar fetcher (jars are downloaded and hash-checked, never committed)
mkdir -p "$OPT/policy/src" "$OPT/policy/policies"
cp -r "$ROOT/policy/src/." "$OPT/policy/src/"
cp "$ROOT/policy/fetch-deps.sh" "$ROOT/policy/deps.sha256" "$ROOT/policy/README.md" "$OPT/policy/"
cp "$ROOT/policy/policies/helix-default.edn" "$OPT/policy/policies/"
( cd "$OPT/policy" && ./fetch-deps.sh )

put_once() { # put_once FILE MODE  (content on stdin); keeps an existing file
  if [ -e "$1" ]; then cat >/dev/null; echo "kept   $1"; else cat >"$1"; chmod "$2" "$1"; echo "wrote  $1"; fi
}

# policy: a copy the operator owns and edits; the service re-reads it when it changes
[ -e "$ETC/policy.edn" ] || { cp "$ROOT/policy/policies/helix-default.edn" "$ETC/policy.edn"; chmod 0640 "$ETC/policy.edn"; echo "wrote  $ETC/policy.edn"; }

# trust anchors: NO issuers until the operator adds one. With none, nothing verifies as trusted, which is the safe default.
echo '{"issuers": {}}' | put_once "$ETC/trust.json" 0640

# the kernel's grant-signing key: generated once, mode 0600, never regenerated
if [ ! -e "$ETC/grant.key" ]; then
  "$OPT/bin/helix-kernel" keygen "$ETC/grant.key" | sed 's/^/        /'
else
  echo "kept   $ETC/grant.key"
fi

# the principal registry: starts with operator-held service tokens for registering agents, installing plugins and orchestrating
if [ ! -e "$ETC/principals.json" ]; then
  TOK="$ETC/first-tokens.txt"; : > "$TOK"; chmod 0600 "$TOK"
  entries=""
  for spec in "admin-registrar|svc:operator-registrar|registrar" "admin-plugins|svc:operator-plugins|plugin_admin" "orchestrator|svc:orchestrator|proposer"; do
    IFS='|' read -r id principal role <<<"$spec"
    out="$("$OPT/bin/helix-gateway" mint-token --id "$id" --org "${HELIX_ORG:-org_default}" --principal "$principal" --kind service --roles "$role" 2>"${TOK:?}.err")"
    grep -A1 '^TOKEN' "${TOK:?}.err" | tail -1 | sed "s/^/$id /" >>"$TOK"
    entries="${entries:+$entries,}$out"
  done
  rm -f "${TOK:?}.err"
  printf '{"tokens":[%s],"agents":[]}\n' "$entries" | put_once "$ETC/principals.json" 0640
  echo "wrote  $TOK  (one token per line. Move them into your secret manager and DELETE this file.)"
else
  echo "kept   $ETC/principals.json"
fi

# environment files (the systemd units and run-stack.sh both read these)
cat <<ENV | put_once "$ETC/policy.env" 0640
HELIX_POLICY_FILE=$ETC/policy.edn
HELIX_POLICY_HOST=127.0.0.1
HELIX_POLICY_PORT=$P_POLICY
ENV
cat <<ENV | put_once "$ETC/kernel.env" 0640
HELIX_KERNEL_SIGNING_KEY_FILE=$ETC/grant.key
HELIX_KERNEL_TRUST_FILE=$ETC/trust.json
HELIX_KERNEL_DB=$VAR/kernel/kernel.sqlite
HELIX_KERNEL_LISTEN=127.0.0.1:$P_KERNEL
HELIX_POLICY_URL=http://127.0.0.1:$P_POLICY
HELIX_KERNEL_PLUGINS=on
ENV
cat <<ENV | put_once "$ETC/gateway.env" 0640
HELIX_GATEWAY_PRINCIPALS=$ETC/principals.json
HELIX_GATEWAY_LISTEN=127.0.0.1:$P_GATEWAY
HELIX_GATEWAY_KERNEL_ADDR=127.0.0.1:$P_KERNEL
HELIX_GATEWAY_METRICS_LISTEN=127.0.0.1:$P_GMETRICS
# For a listener off loopback set HELIX_GATEWAY_TLS_CERT and HELIX_GATEWAY_TLS_KEY (or terminate TLS in front and stay on loopback).
ENV
cat <<ENV | put_once "$ETC/resolver.env" 0640
# Set the origin and the publish token hash before enabling helix-resolver.service.
HELIX_RESOLVER_ORIGIN=https://contact.example.invalid
HELIX_RESOLVER_TRUST_FILE=$ETC/trust.json
HELIX_RESOLVER_STORE_DIR=$VAR/resolver
HELIX_RESOLVER_LISTEN=127.0.0.1:$P_RESOLVER
HELIX_RESOLVER_METRICS_LISTEN=127.0.0.1:$P_RMETRICS
# HELIX_RESOLVER_PUBLISH_TOKEN_SHA256=<sha256 hex of the publisher's bearer token>
ENV

if [ "$MAKE_USER" = 1 ]; then
  chown -R root:helix "$ETC"; chmod 750 "$ETC"; chmod 640 "$ETC"/*.env "$ETC"/*.json "$ETC"/policy.edn 2>/dev/null || true
  chmod 600 "$ETC/grant.key" "$ETC/first-tokens.txt" 2>/dev/null || true; chown helix:helix "$ETC/grant.key"
  chown -R helix:helix "$VAR"
  install -m 0644 "$HERE"/systemd/*.service "$HERE"/systemd/*.target /etc/systemd/system/
  systemctl daemon-reload
  echo "installed the systemd units. Next: edit /etc/helix/*.env and trust.json, then: systemctl enable --now helix.target"
fi
echo "bootstrap done (prefix: ${PREFIX:-/})"
