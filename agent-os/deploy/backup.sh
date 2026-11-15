#!/usr/bin/env bash
# A consistent backup of everything a HELIX install cannot recreate:
#   the kernel database (SQLite online backup, safe while the kernel runs), the grant-signing key,
#   the trust anchors, principals, policy, env files, the resolver's stored resolutions, and the orchestrator's run logs.
# The archive contains SECRETS (the signing key, token hashes). It is written mode 0600; encrypt it before it leaves the host.
#   ./backup.sh --prefix DIR --out FILE.tar.gz
set -euo pipefail
PREFIX="/"; OUT=""
while [ $# -gt 0 ]; do case "$1" in --prefix) PREFIX="$2"; shift 2;; --out) OUT="$2"; shift 2;; *) echo "unknown argument $1" >&2; exit 2;; esac; done
[ -n "$OUT" ] || { echo "--out is required" >&2; exit 2; }
PREFIX="${PREFIX%/}"; ETC="$PREFIX/etc/helix"; VAR="$PREFIX/var/lib/helix"
STAGE="$(mktemp -d)"; trap 'rm -rf -- "${STAGE:?}"' EXIT
mkdir -p "$STAGE/etc" "$STAGE/var/kernel" "$STAGE/var/resolver" "$STAGE/var/runs"

python3 - "$VAR/kernel/kernel.sqlite" "$STAGE/var/kernel/kernel.sqlite" <<'PY'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
a = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
b = sqlite3.connect(dst)
a.backup(b)                      # SQLite's online backup API: a consistent snapshot while the kernel keeps writing
ok = b.execute("PRAGMA integrity_check").fetchone()[0]
b.close(); a.close()
if ok != "ok":
    sys.exit(f"backup failed its integrity check: {ok}")
PY
for f in "$ETC"/*; do case "$(basename "$f")" in first-tokens.txt) ;; *) [ -f "$f" ] && cp -p "$f" "$STAGE/etc/";; esac; done
[ -d "$VAR/resolver" ] && cp -pr "$VAR/resolver/." "$STAGE/var/resolver/" 2>/dev/null || true
[ -d "$VAR/runs" ] && cp -pr "$VAR/runs/." "$STAGE/var/runs/" 2>/dev/null || true

python3 - "$STAGE" <<'PY'
import hashlib, json, os, sys, time
root = sys.argv[1]
files = {}
for d, _, names in os.walk(root):
    for n in names:
        p = os.path.join(d, n)
        if n == "MANIFEST.json": continue
        files[os.path.relpath(p, root)] = hashlib.sha256(open(p, "rb").read()).hexdigest()
json.dump({"format": "helix-backup/1", "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "files": files}, open(os.path.join(root, "MANIFEST.json"), "w"), indent=1, sort_keys=True)
PY
umask 077
tar -C "$STAGE" -czf "$OUT" .
chmod 600 "$OUT"
echo "backup written: $OUT ($(wc -c <"$OUT") bytes, $(python3 -c "import json,sys;print(len(json.load(open('$STAGE/MANIFEST.json'))['files']))") files). It contains secrets: encrypt it."
