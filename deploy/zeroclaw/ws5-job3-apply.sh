#!/usr/bin/env bash
# WS5 job 3 completion — run as root on the VPS.
#
# Applies: santinos Nostr channel keypair, system_prompt from the compiled card,
#          stray default-dir config cleanup; then validates, restarts ZeroClaw,
#          runs doctor, and reports the queue.
#
# Idempotent — safe to re-run: sections are appended only if absent, an existing
# sk is reused (the keypair does not churn), and stale agent keys are replaced.
# Dependency-free — no tomlkit and no minipae: pip is PEP-668 blocked on this
# host, so secp256k1 + bech32 npub are done in pure Python stdlib.
set -euo pipefail

ZEROCLAW_CONFIG=/etc/zeroclaw/config.toml
POLICY_DIR=/opt/helixmain/dna-foundry/compiled/dna_c1640d90_v4
KEYFILE=/root/santinos-keys.env
ZC=/usr/local/bin/zeroclaw
BACKUP=/etc/zeroclaw/config.toml.bak-job3c-$(date +%Y%m%d%H%M%S)

echo "==> backing up config"
cp "$ZEROCLAW_CONFIG" "$BACKUP"

# ── (c) clean stray default-dir config ───────────────────────────────────────
if [ -f /root/.zeroclaw/config.toml ]; then
  echo "==> removing stray /root/.zeroclaw/config.toml"
  rm /root/.zeroclaw/config.toml
fi

# ── santinos Nostr keypair (reuse an existing key so reruns are stable) ──────
echo "==> santinos keypair"
EXISTING_SK=$(sed -n '/^\[channels\.nostr\.santinos\]/,/^\[/p' "$ZEROCLAW_CONFIG" 2>/dev/null \
  | grep -oE 'private_key *= *"[0-9a-f]{64}"' | grep -oE '[0-9a-f]{64}' | head -1 || true)

KEYPAIR_JSON=$(python3 - "${EXISTING_SK:-}" <<'PYEOF'
import json, secrets, sys

P  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8

def _add(p, q):
    if p is None: return q
    if q is None: return p
    if p[0] == q[0] and (p[1] + q[1]) % P == 0: return None
    lam = ((3 * p[0] * p[0] * pow(2 * p[1], P - 2, P)) if p == q
           else ((q[1] - p[1]) * pow(q[0] - p[0], P - 2, P))) % P
    x = (lam * lam - p[0] - q[0]) % P
    return (x, (lam * (p[0] - x) - p[1]) % P)

def _mul(k, pt):
    r = None
    while k:
        if k & 1: r = _add(r, pt)
        pt = _add(pt, pt)
        k >>= 1
    return r

CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

def _pm(v):
    gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    c = 1
    for x in v:
        b = c >> 25
        c = ((c & 0x1ffffff) << 5) ^ x
        for i in range(5):
            c ^= gen[i] if ((b >> i) & 1) else 0
    return c

def _cb(d):
    acc = bits = 0
    out = []
    for x in d:
        acc = ((acc << 8) | x) & 0xFFFFFF
        bits += 8
        while bits >= 5:
            bits -= 5
            out.append((acc >> bits) & 31)
    if bits:
        out.append((acc << (5 - bits)) & 31)
    return out

def npub_of(pk32):
    data = [0] + _cb(pk32)
    pm = _pm([ord(c) >> 5 for c in "npub"] + [0] + [ord(c) & 31 for c in "npub"] + data + [0] * 6) ^ 1
    return "npub1" + "".join(CH[d] for d in data) + "".join(CH[(pm >> 5 * (5 - i)) & 31] for i in range(6))

existing = sys.argv[1].strip() if len(sys.argv) > 1 else ""
sk_hex = existing if existing else secrets.token_bytes(32).hex()
px, _ = _mul(int(sk_hex, 16) % N, (Gx, Gy))
pk32 = px.to_bytes(32, "big")          # nostr pubkeys are x-only
print(json.dumps({"sk_hex": sk_hex, "pk_hex": pk32.hex(),
                  "npub": npub_of(pk32), "reused": bool(existing)}))
PYEOF
)

SK_HEX=$(printf '%s' "$KEYPAIR_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['sk_hex'])")
PK_HEX=$(printf '%s' "$KEYPAIR_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['pk_hex'])")
NPUB=$(printf '%s' "$KEYPAIR_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['npub'])")
REUSED=$(printf '%s' "$KEYPAIR_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['reused'])")

echo "  sk_hex : $SK_HEX"
echo "  pk_hex : $PK_HEX"
echo "  npub   : $NPUB"
echo "  reused : $REUSED"

echo "==> saving keys to $KEYFILE"
umask 077
{
  echo "# santinos Nostr identity — ZeroClaw agent channel (nostr.santinos)"
  echo "# generated $(date -Is)"
  echo "SANTINOS_SK_HEX=$SK_HEX"
  echo "SANTINOS_PK_HEX=$PK_HEX"
  echo "SANTINOS_NPUB=$NPUB"
  echo "SANTINOS_CHANNEL=nostr.santinos"
  echo "SANTINOS_RELAY=wss://omokoda.duckdns.org:3443"
} > "$KEYFILE"
chmod 600 "$KEYFILE"

# ── (a) patch config.toml — channel + peer group (append once) ───────────────
echo "==> patching config.toml"
if grep -q '^\[channels\.nostr\.santinos\]' "$ZEROCLAW_CONFIG"; then
  echo "  channel section already present — leaving it (key reused above)"
else
  cat >> "$ZEROCLAW_CONFIG" <<TOMLEOF


[channels.nostr.santinos]
enabled = true
private_key = "${SK_HEX}"
relays = ["wss://omokoda.duckdns.org:3443"]

[peer_groups.santinos_trusted]
channel = "nostr.santinos"
agents = ["santinos"]
external_peers = []

TOMLEOF
  echo "  channel + peer group appended"
fi

if grep -q '^\[peer_groups\.santinos_trusted\]' "$ZEROCLAW_CONFIG"; then :; else
  cat >> "$ZEROCLAW_CONFIG" <<'TOMLEOF'
[peer_groups.santinos_trusted]
channel = "nostr.santinos"
agents = ["santinos"]
external_peers = []
TOMLEOF
fi

# ── system_prompt + channels on agents.santinos (stdlib text patch) ──────────
# tomlkit is absent and pip is PEP-668 blocked, so edit the file directly.
# json.dumps gives a valid TOML basic string (JSON escapes are TOML-compatible).
PROMPT_FILE=$(mktemp)
trap 'rm -f "$PROMPT_FILE"' EXIT
python3 - "$POLICY_DIR/system-prompt.md" > "$PROMPT_FILE" <<'PYEOF'
import re, sys
with open(sys.argv[1]) as f:
    content = f.read()
content = re.sub(r'\n## Provenance\n.*', '', content, flags=re.DOTALL)
print(content.strip(), end="")
PYEOF

ZC_CONFIG="$ZEROCLAW_CONFIG" ZC_PROMPT="$PROMPT_FILE" python3 - <<'PYEOF'
import json, os, re

cfg_path = os.environ["ZC_CONFIG"]
with open(os.environ["ZC_PROMPT"]) as f:
    system_prompt = f.read().strip()

lines = open(cfg_path).read().splitlines(keepends=True)
out, inserted, in_santinos = [], False, False

def emit():
    out.append('channels = ["nostr.santinos"]\n')
    out.append("system_prompt = " + json.dumps(system_prompt) + "\n")

for ln in lines:
    stripped = ln.strip()
    if stripped.startswith("["):
        if in_santinos and not inserted:
            emit()
            inserted = True
        in_santinos = stripped == "[agents.santinos]"
        out.append(ln)
        continue
    # drop stale keys inside the table so a rerun is idempotent
    if in_santinos and re.match(r'^\s*(channels|system_prompt)\s*=', ln):
        continue
    out.append(ln)

if in_santinos and not inserted:
    emit()
    inserted = True

if not inserted:
    raise SystemExit("agents.santinos table not found in " + cfg_path)

open(cfg_path, "w").writelines(out)
print("  agents.santinos patched (channels + system_prompt)")
PYEOF

# ── validate + restart ───────────────────────────────────────────────────────
echo "==> validating config"
# `zeroclaw config validate` does not exist (schema/list/get/set/init/migrate/patch/docs/generate).
python3 -c "import tomllib; tomllib.load(open('$ZEROCLAW_CONFIG','rb')); print('  TOML OK')"
"$ZC" --config-dir /etc/zeroclaw config get agents.santinos.channels
"$ZC" --config-dir /etc/zeroclaw config get agents.santinos.mcp_bundles

echo "==> restarting zeroclaw"
systemctl restart zeroclaw
sleep 4
systemctl is-active zeroclaw

echo "==> doctor check"
"$ZC" --config-dir /etc/zeroclaw doctor 2>&1 | tail -12

# ── queue state ──────────────────────────────────────────────────────────────
echo ""
echo "==> Polling /held (current queue):"
curl -s http://127.0.0.1:9100/held | python3 -c "
import json,sys
try:
    items = json.load(sys.stdin)
except Exception:
    print('  (could not read /held)'); raise SystemExit(0)
if not items:
    print('  [] — queue empty (expected before a real action is sent)')
else:
    for item in items:
        print('  hold_id: %s  status: %s  action: %s' % (item.get('id'), item.get('status'), item.get('action_id')))
"

echo ""
echo "==> SUMMARY"
echo "  santinos channel : nostr.santinos (relays: omokoda.duckdns.org:3443)"
echo "  system_prompt    : set from $POLICY_DIR/system-prompt.md"
echo "  stray config     : /root/.zeroclaw/config.toml removed"
echo "  mcp_bundles      : card_agent_tools -> spark -> spark__invoke -> 127.0.0.1:9100/invoke"
echo "  keys file        : $KEYFILE (0600)"
echo ""
echo "  SAVE THESE KEYS:"
echo "    SANTINOS_SK_HEX=$SK_HEX"
echo "    SANTINOS_PK_HEX=$PK_HEX"
echo "    SANTINOS_NPUB=$NPUB"
echo ""
echo "  Next: DM santinos from a known pubkey to trigger spark__invoke; confirm the"
echo "        hold lands in /held and is visible at /spark/"
