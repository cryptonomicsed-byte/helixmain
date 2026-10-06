#!/usr/bin/env bash
# WS5 end-to-end DM proof — run as root on the VPS.
#
# Proves the whole loop, not just its parts:
#   throwaway sender --NIP-04 DM--> santinos agent --spark__invoke--> POST /invoke
#     --> SparkGatekeeper 7 gates --> hold queue (/held) --> visible at /spark/
#
# Steps:
#   1. generate a throwaway sender keypair (reuse if already present)
#   2. grant its pubkey in [peer_groups.santinos_trusted].external_peers (idempotent)
#   3. restart zeroclaw so the grant takes effect (bundle/peer grants resolve at
#      session construction time — a live session would not see the change)
#   4. send the DM: a kind=deploy action addressed to santinos over NIP-04
#   5. show /held and the gate trail
#
# Dependency-free crypto: secp256k1 + bech32 in pure Python stdlib. nak does the
# NIP-04 encryption and the relay publish.
set -euo pipefail

CONFIG=/etc/zeroclaw/config.toml
KEYFILE=/root/santinos-keys.env
SENDER_FILE=/root/santinos-dm-sender.env
RELAY=wss://omokoda.duckdns.org:3443

[ -f "$KEYFILE" ] || { echo "missing $KEYFILE — run ws5-job3-apply.sh first"; exit 1; }
# shellcheck disable=SC1090
. "$KEYFILE"

echo "==> santinos pubkey: $SANTINOS_PK_HEX"

# ── 1. throwaway sender keypair ──────────────────────────────────────────────
if [ -f "$SENDER_FILE" ]; then
  # shellcheck disable=SC1090
  . "$SENDER_FILE"
  echo "==> reusing existing sender: $SENDER_PK_HEX"
else
  echo "==> generating throwaway sender keypair"
  eval "$(python3 - <<'PYEOF'
import secrets

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
    # NIP-19 npub: NO leading version byte (see ws5-job3-apply.sh).
    data = _cb(pk32)
    pm = _pm([ord(c) >> 5 for c in "npub"] + [0] + [ord(c) & 31 for c in "npub"] + data + [0] * 6) ^ 1
    return "npub1" + "".join(CH[d] for d in data) + "".join(CH[(pm >> 5 * (5 - i)) & 31] for i in range(6))

sk = secrets.token_bytes(32).hex()
px, _ = _mul(int(sk, 16) % N, (Gx, Gy))
pk32 = px.to_bytes(32, "big")
print(f"SENDER_SK_HEX={sk}")
print(f"SENDER_PK_HEX={pk32.hex()}")
print(f"SENDER_NPUB={npub_of(pk32)}")
PYEOF
)"
  umask 077
  printf 'SENDER_SK_HEX=%s\nSENDER_PK_HEX=%s\nSENDER_NPUB=%s\n' \
    "$SENDER_SK_HEX" "$SENDER_PK_HEX" "$SENDER_NPUB" > "$SENDER_FILE"
  chmod 600 "$SENDER_FILE"
fi
echo "    sender npub: $SENDER_NPUB"
echo "    saved: $SENDER_FILE (0600)"

# ── 2. grant the sender in the peer group (idempotent) ───────────────────────
echo "==> granting sender in [peer_groups.santinos_trusted].external_peers"
ZC_CONFIG="$CONFIG" ZC_PEER="$SENDER_PK_HEX" python3 - <<'PYEOF'
import os, re

path = os.environ["ZC_CONFIG"]
peer = os.environ["ZC_PEER"]
lines = open(path).read().splitlines(keepends=True)
out, in_group, done = [], False, False

for i, ln in enumerate(lines):
    stripped = ln.strip()
    if stripped.startswith("["):
        # leaving the peer-group table
        if in_group and not done:
            out.append('external_peers = ["%s"]\n' % peer)
            done = True
        in_group = stripped == "[peer_groups.santinos_trusted]"
        out.append(ln)
        continue
    if in_group and stripped.startswith("external_peers"):
        cur = re.findall(r'[0-9a-fA-F]{64}', ln)          # keep any existing peers
        if peer not in cur:
            cur.append(peer)
        out.append('external_peers = [%s]\n' % ", ".join('"%s"' % p for p in cur))
        done = True
        continue
    out.append(ln)

if in_group and not done:
    out.append('external_peers = ["%s"]\n' % peer)
    done = True
if not done:
    raise SystemExit("peer_groups.santinos_trusted not found")

open(path, "w").writelines(out)
print("  external_peers updated")
PYEOF

# ── 3. restart so the grant resolves ─────────────────────────────────────────
echo "==> restarting zeroclaw"
systemctl restart zeroclaw
sleep 6
systemctl is-active zeroclaw

# ── 4. send the DM ───────────────────────────────────────────────────────────
TS=$(date +%s)
ACTION="{\"kind\":\"deploy\",\"tool\":\"mcp.vercel.deploy\",\"payload\":{\"env\":\"production\"},\"session_id\":\"ws5-proof-$TS\"}"
MSG="Deploy the site to production now. Use the spark__invoke tool with this action: $ACTION"

echo "==> encrypting (NIP-04)"
CIPHER=$(nak encrypt --nip04 --sec "$SENDER_SK_HEX" -p "$SANTINOS_PK_HEX" "$MSG")
echo "    ciphertext: ${CIPHER:0:32}…"

echo "==> publishing kind=4 DM to $RELAY"
nak event --kind 4 --sec "$SENDER_SK_HEX" -t "p=$SANTINOS_PK_HEX" -c "$CIPHER" "$RELAY" 2>&1 | tail -3

echo "==> waiting for the agent to answer the DM (up to 90s)…"
for i in $(seq 1 30); do
  HELD=$(curl -s -m 5 http://127.0.0.1:9100/held || echo "[]")
  if [ "$HELD" != "[]" ] && [ -n "$HELD" ]; then
    echo "==> /held has an item after ${i}x3s"
    break
  fi
  sleep 3
done

# ── 5. report ────────────────────────────────────────────────────────────────
echo ""
echo "==> /held"
curl -s -m 8 http://127.0.0.1:9100/held | python3 -m json.tool 2>/dev/null || echo "  (unreadable)"

echo ""
echo "==> /spark/ (public surface)"
curl -s -o /dev/null -m 10 -w "  https://omokoda.duckdns.org/spark/ -> HTTP %{http_code}\n" https://omokoda.duckdns.org/spark/

echo ""
echo "==> SUMMARY"
echo "  sender   : $SENDER_PK_HEX"
echo "  santinos : $SANTINOS_PK_HEX"
echo "  action   : $ACTION"
