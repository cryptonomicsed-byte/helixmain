#!/usr/bin/env python3
"""VPS-side DeepSeek key rotation for the HelixMain key.

Key-DRIVEN, not path-driven: it discovers every file on the host that carries the
CURRENT key (by `grep -F` on the live value, so a file nobody remembered — e.g.
/root/mesh-voice/.env — can't be silently missed and give false confidence) and
replaces it. Config *backups* that hold the key are redacted rather than
re-pointed, so a stale restore can't resurrect a retired secret.

The separate key used by /opt/ares and hermes-gateway (a different key) is never
matched, because only the live HelixMain key is searched for.

Staging: the NEW key arrives at /root/.ds-new (0600), written by
rotate-deepseek-key.sh with hidden input — never via argv, env, chat or history.
"""
import os
import re
import subprocess
import sys

STAGE = "/root/.ds-new"
API = "/etc/helix/api.env"
PLACEHOLDER = "<rotated-out-20261010>"

if not os.path.exists(STAGE):
    sys.exit("no key staged at " + STAGE)
NEW = open(STAGE).read().strip()
if not NEW:
    sys.exit("staged key is empty")
m = re.search(r"sk-[A-Za-z0-9]{20,}", open(API).read())
if not m:
    sys.exit("cannot read the current key from " + API)
OLD = m.group(0)
if OLD == NEW:
    sys.exit("new key equals old; nothing to do")

OLD_B, NEW_B, PH_B = OLD.encode(), NEW.encode(), PLACEHOLDER.encode()

# Discover every file carrying the OLD key. grep -F is exact and fast.
roots = [p for p in ("/etc", "/root", "/opt", "/srv", "/home") if os.path.isdir(p)]
cmd = ["grep", "-rlF", "--binary-files=without-match",
       "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=venv",
       "--exclude-dir=.venv", "--exclude-dir=__pycache__", "--exclude-dir=target",
       "--exclude-dir=.cache", OLD, *roots]
try:
    proc = subprocess.run(cmd, capture_output=True, timeout=180)
except subprocess.TimeoutExpired:
    sys.exit("discovery timed out — rerun, or narrow the search roots")
files = [f for f in proc.stdout.decode(errors="replace").splitlines() if f.strip()]

changed, redacted, failed = [], [], []
for f in files:
    if not os.path.isfile(f):
        continue
    try:
        data = open(f, "rb").read()
    except Exception as e:
        failed.append((f, str(e)))
        continue
    if OLD_B not in data:
        continue
    n = data.count(OLD_B)
    is_backup = any(s in os.path.basename(f) for s in (".bak", ".backup", ".old", ".orig"))
    try:
        open(f, "wb").write(data.replace(OLD_B, PH_B if is_backup else NEW_B))
        (redacted if is_backup else changed).append((f, n))
    except Exception as e:
        failed.append((f, str(e)))

os.remove(STAGE)
for f, n in changed:
    print(f"  updated   {f}  ({n})")
for f, n in redacted:
    print(f"  redacted  {f}  ({n})")
for f, e in failed:
    print(f"  FAILED    {f}  ({e})")
print(f"\nupdated {len(changed)}, redacted {len(redacted)}, failed {len(failed)}")
if not changed and not failed:
    print("WARNING: no live file carried the old key — verify by hand")
