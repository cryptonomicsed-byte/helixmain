#!/usr/bin/env bash
# Verify the systemd units. The only complaint tolerated is that the programs are not installed on THIS machine.
set -uo pipefail
cd "$(dirname "$0")"
out="$(systemd-analyze verify --man=no "$PWD"/systemd/*.service "$PWD"/systemd/*.target 2>&1)"
real="$(echo "$out" | grep -v 'is not executable' | grep -v '^$' || true)"
if [ -n "$real" ]; then echo "$real" >&2; exit 1; fi
echo "$(ls systemd | wc -l) unit files verified"
