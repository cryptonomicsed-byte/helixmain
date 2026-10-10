#!/usr/bin/env bash
# rotate-deepseek-key.sh — rotate the HelixMain stack's DeepSeek key.
#
# Prompts for the NEW key with hidden input (never echoes, never lands in argv,
# env, chat or shell history), stages it on the VPS as a 0600 file, replaces the
# old key everywhere the HelixMain stack uses it, redacts it from the stale
# zeroclaw config backups, then restarts helix-api and zeroclaw.
#
# The separate key used by the ARES / hermes-gateway units is left alone.
#
# Usage:  bash ~/rotate-deepseek-key.sh
#   1. Mint a new key at https://platform.deepseek.com/api_keys
#   2. Run this. Paste the new key at the hidden prompt.
#   3. Revoke the OLD key at the same page. That is the step that actually
#      neutralises the copy sitting in git history.
set -euo pipefail
VPS="${VPS:-hostinger}"
HERE="$(cd "$(dirname "$0")" && pwd)"

read -rsp "Paste the NEW DeepSeek key (hidden): " NEW; echo
if [ -z "$NEW" ]; then echo "refusing: empty key" >&2; exit 1; fi
case "$NEW" in sk-*) ;; *) echo "warning: does not start with 'sk-' — continuing" >&2 ;; esac

tmp="$(mktemp)"; chmod 600 "$tmp"
printf '%s' "$NEW" > "$tmp"
unset NEW
scp -q "$tmp" "$VPS:/root/.ds-new.part"
ssh "$VPS" 'chmod 600 /root/.ds-new.part && mv /root/.ds-new.part /root/.ds-new'
rm -f "$tmp"

echo "== rotating on $VPS =="
base64 -w0 "$HERE/rotate-deepseek-key.py" \
  | ssh "$VPS" 'base64 -d > /tmp/rotate-ds.py && python3 /tmp/rotate-ds.py && rm -f /tmp/rotate-ds.py'

echo "== restarting services =="
ssh "$VPS" 'systemctl restart helix-api && sleep 3 && echo "helix-api: $(systemctl is-active helix-api)"
systemctl restart zeroclaw && sleep 5 && echo "zeroclaw: $(systemctl is-active zeroclaw)"'

echo
echo "DONE. Now REVOKE the old key at https://platform.deepseek.com/api_keys"
echo "The copy in git history is harmless once the old key is revoked; a history"
echo "scrub (git filter-repo) is optional and would rewrite every commit SHA."
