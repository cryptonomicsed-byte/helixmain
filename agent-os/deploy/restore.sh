#!/usr/bin/env bash
# Restore a backup made by backup.sh. Verifies every file against the manifest BEFORE writing anything,
# refuses to run over a live stack, and keeps whatever it replaces as *.before-restore.
#   ./restore.sh --prefix DIR --from FILE.tar.gz
set -euo pipefail
PREFIX="/"; FROM=""
while [ $# -gt 0 ]; do case "$1" in --prefix) PREFIX="$2"; shift 2;; --from) FROM="$2"; shift 2;; *) echo "unknown argument $1" >&2; exit 2;; esac; done
[ -f "$FROM" ] || { echo "--from FILE is required" >&2; exit 2; }
PREFIX="${PREFIX%/}"; ETC="$PREFIX/etc/helix"; VAR="$PREFIX/var/lib/helix"; RUN="$VAR/run"

# not over a live stack
for n in kernel gateway; do
  if [ -f "$RUN/$n.pid" ] && kill -0 "$(cat "$RUN/$n.pid")" 2>/dev/null; then echo "the $n is running: stop the stack first" >&2; exit 1; fi
done
if [ "$PREFIX" = "" ] && command -v systemctl >/dev/null && systemctl is-active --quiet helix-kernel.service; then echo "helix-kernel.service is active: stop it first" >&2; exit 1; fi

STAGE="$(mktemp -d)"; trap 'rm -rf -- "${STAGE:?}"' EXIT
tar -C "$STAGE" -xzf "$FROM"
python3 - "$STAGE" <<'PY'
import hashlib, json, os, sys
root = sys.argv[1]
m = json.load(open(os.path.join(root, "MANIFEST.json")))
if m.get("format") != "helix-backup/1": sys.exit("not a helix-backup/1 archive")
bad = [p for p, h in m["files"].items() if not os.path.exists(os.path.join(root, p)) or hashlib.sha256(open(os.path.join(root, p), "rb").read()).hexdigest() != h]
extra = [os.path.relpath(os.path.join(d, n), root) for d, _, ns in os.walk(root) for n in ns if n != "MANIFEST.json" and os.path.relpath(os.path.join(d, n), root) not in m["files"]]
if bad or extra: sys.exit(f"the archive does not match its manifest: changed or missing {bad}, unlisted {extra}")
import sqlite3
db = os.path.join(root, "var/kernel/kernel.sqlite")
r = sqlite3.connect(db).execute("PRAGMA integrity_check").fetchone()[0]
if r != "ok": sys.exit(f"the kernel database fails its integrity check: {r}")
print("manifest verified;", len(m["files"]), "files; kernel database intact")
PY

mkdir -p "$ETC" "$VAR/kernel" "$VAR/resolver" "$VAR/runs"
keep() { [ -e "$1" ] && mv "$1" "$1.before-restore" || true; }
keep "$VAR/kernel/kernel.sqlite"; rm -f "${VAR:?}/kernel/kernel.sqlite-wal" "${VAR:?}/kernel/kernel.sqlite-shm"
cp -p "$STAGE/var/kernel/kernel.sqlite" "$VAR/kernel/kernel.sqlite"
for f in "$STAGE"/etc/*; do [ -f "$f" ] || continue; keep "$ETC/$(basename "$f")"; cp -p "$f" "$ETC/"; done
cp -pr "$STAGE/var/resolver/." "$VAR/resolver/" 2>/dev/null || true
cp -pr "$STAGE/var/runs/." "$VAR/runs/" 2>/dev/null || true
chmod 600 "$ETC/grant.key" 2>/dev/null || true
echo "restored into ${PREFIX:-/}. Start the stack and run smoke.sh."
