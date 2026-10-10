#!/bin/bash
# verify-nginx-sync — prove the repo's copy of the helixmain vhost matches LIVE.
#
# Source of truth is the RUNNING config on the host. The repo copy went stale
# once and the audit's "deploy the repo config" step would have deleted the
# deliberate /gk/ guards, so this check exists to make divergence loud:
# it exits non-zero and prints the diff. Run it after any nginx change.
#
# Usage: verify-nginx-sync.sh [repo-conf-path]
# Env:   HELIX_NGINX_HOST  ssh host holding the live config (default: hostinger)
#        HELIX_NGINX_LIVE  path to the live config (default: sites-enabled/helixmain)
set -euo pipefail

REPO_CONF="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/nginx-helixmain.conf}"
HOST="${HELIX_NGINX_HOST:-hostinger}"
LIVE_PATH="${HELIX_NGINX_LIVE:-/etc/nginx/sites-enabled/helixmain}"

if [ ! -f "$REPO_CONF" ]; then
  echo "verify-nginx-sync: no repo config at $REPO_CONF" >&2
  exit 2
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if ! ssh -o ConnectTimeout=15 -o BatchMode=yes "$HOST" "cat '$LIVE_PATH'" > "$work/live.conf" 2>"$work/ssh.err"; then
  echo "verify-nginx-sync: could not read $LIVE_PATH on $HOST:" >&2
  cat "$work/ssh.err" >&2
  exit 3
fi

# Drop the repo file's provenance header (through the BEGIN CONFIG sentinel) so
# what remains must be byte-identical to live.
sed '1,/== BEGIN CONFIG/d' "$REPO_CONF" > "$work/repo-body.conf"

status=0
if diff -u "$work/repo-body.conf" "$work/live.conf" > "$work/diff" 2>&1; then
  echo "IN SYNC: repo nginx config matches live ($HOST:$LIVE_PATH)"
else
  echo "OUT OF SYNC — repo copy differs from live ($HOST:$LIVE_PATH):" >&2
  cat "$work/diff" >&2
  echo "" >&2
  echo "Fix by syncing FROM live:  ssh $HOST \"cat $LIVE_PATH\" > $REPO_CONF  (then re-add the header)" >&2
  status=1
fi

# The deliberate guards must be present. If a future edit removes one, that is a
# security regression even if the two files still agree.
for guard in 'location ^~ /gk/setup { return 404; }' 'location = /gk/invoke { return 404; }'; do
  if grep -qF "$guard" "$work/live.conf"; then
    echo "GUARD PRESENT: $guard"
  else
    echo "GUARD MISSING ON LIVE (security regression): $guard" >&2
    status=1
  fi
done

exit $status
