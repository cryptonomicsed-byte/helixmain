#!/bin/bash
# rotate-llm-key.sh — swap the LLM API key everywhere it is carried, at once.
#
# Why this exists: the DeepSeek key was printed in cleartext during a recon dump,
# and it is still live. A key that is rotated in one file but left in another is
# not rotated at all, so this touches every carrier and then PROVES the new key
# works before it declares success.
#
# The key is never passed as an argument (argv is visible in `ps`) and never
# echoed. Read it from a 0600 file, or type it at a no-echo prompt.
#
#   rotate-llm-key.sh                 prompt (no echo) for the new key
#   rotate-llm-key.sh /path/to/new.key  read it from a file (trailing newline ok)
#
# Carriers, in the order they are updated (all-or-nothing via a staged copy):
#   /etc/zeroclaw/config.toml      providers.models.openai.deepseek.api_key
#   /etc/helix/api.env             DEEPSEEK_API_KEY / OPENAI_API_KEY / any sk- value
#   /etc/zeroclaw/config.toml.bak* its own backups — a leaked key in a backup is
#                                  still a leaked key
set -euo pipefail

CONFIG=${ZEROCLAW_CONFIG:-/etc/zeroclaw/config.toml}
ENVF=${HELIX_API_ENV:-/etc/helix/api.env}
PROVIDER=${LLM_PROVIDER_URL:-https://api.deepseek.com/v1}
STAMP=$(date +%Y%m%d-%H%M%S)

die() { echo "error: $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "run as root (the config and env files are 0600 root)"
[ -f "$CONFIG" ] || die "no config at $CONFIG"

# ── read the new key, without putting it in argv or the terminal ─────────────
if [ $# -ge 1 ]; then
  NEW=$(tr -d '[:space:]' < "$1")
else
  printf 'New DeepSeek API key (input hidden): ' >&2
  IFS= read -rs NEW
  printf '\n' >&2
fi

case "$NEW" in
  sk-*) ;;
  "") die "empty key" ;;
  *) die "that does not look like a key (expected an sk-... value)" ;;
esac
[ "${#NEW}" -ge 20 ] || die "key is implausibly short (${#NEW} chars)"

OLD=$(python3 - "$CONFIG" <<'PY'
import re, sys
m = re.search(r'api_key = "(sk-[0-9a-fA-F]+)"', open(sys.argv[1]).read())
print(m.group(1) if m else "")
PY
)
[ -n "$OLD" ] || die "no sk- key found in $CONFIG to rotate"
[ "$OLD" = "$NEW" ] && die "the new key is identical to the current one — nothing to rotate"

echo "current key ends …${OLD: -4}  ->  new key ends …${NEW: -4}"

# ── stage everything first, apply only if every write succeeds ───────────────
python3 - "$CONFIG" "$ENVF" "$OLD" "$NEW" "$STAMP" <<'PY'
import glob, os, re, shutil, stat, sys

config, envf, old, new, stamp = sys.argv[1:6]
staged = []

def stage(path, text):
    tmp = f"{path}.rotate-{os.getpid()}"
    mode = stat.S_IMODE(os.stat(path).st_mode)
    with open(tmp, "w") as fh:
        fh.write(text)
    os.chmod(tmp, mode)
    staged.append((tmp, path))

# 1. the zeroclaw provider key
s = open(config).read()
if old not in s:
    sys.exit(f"{config} no longer carries the old key")
stage(config, s.replace(old, new))

# 2. the API's env file — every line that carries a sk- value
if os.path.isfile(envf):
    e = open(envf).read()
    if re.search(r"sk-[0-9a-fA-F]{16,}", e):
        stage(envf, re.sub(r"sk-[0-9a-fA-F]{16,}", new, e))

# 3. the config's own backups — a backup is a carrier
for b in sorted(glob.glob(config + ".bak*")):
    try:
        t = open(b).read()
    except OSError:
        continue
    if old in t:
        try:
            stage(b, t.replace(old, new))
        except OSError:
            pass  # a backup we cannot write is one to delete, not to fail on

for tmp, path in staged:
    shutil.copy2(path, f"{path}.pre-rotate-{stamp}")
    os.replace(tmp, path)
    print(f"  updated {path}")
print(f"  {len(staged)} file(s) staged and applied")
PY

# ── prove the new key works BEFORE restarting anything on it ────────────────
echo "verifying the new key…"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $NEW" "$PROVIDER/models" || echo 000)
if [ "$CODE" != "200" ]; then
  echo "error: the new key did not authenticate (HTTP $CODE). Rolling back." >&2
  for f in "$CONFIG" "$ENVF"; do
    [ -f "$f.pre-rotate-$STAMP" ] && cp -p "$f.pre-rotate-$STAMP" "$f" && echo "  restored $f" >&2
  done
  exit 1
fi
echo "  new key authenticates (HTTP 200)"

systemctl restart zeroclaw 2>/dev/null || true
systemctl restart helix-api 2>/dev/null || true
sleep 8
echo
echo "zeroclaw: $(systemctl is-active zeroclaw)  helix-api: $(systemctl is-active helix-api)"
echo
echo "next: confirm the old key is gone from the carriers (snapshots aside)"
for f in "$CONFIG" "$ENVF" "$CONFIG".bak*; do
  [ -f "$f" ] || continue
  if grep -q -- "$OLD" "$f" 2>/dev/null; then echo "  STILL CARRIES IT: $f"; fi
done
echo "  (no STILL CARRIES IT lines above = the old key is gone)"
