#!/usr/bin/env bash
# Helix DNA Foundry — end-to-end proof.
#
# "HelixMain creates and maintains a business's CARD.md.
#  The card is the product; every agent is a consumer."
#
# Flow:
#   1. extract v1 (swarm) -> compile -> CARD.md v1 (the product)
#   2. sonic brand patches the Sound section of CARD.md -> v2
#      (voice logo: real TTS audio, content-addressed; version bumped,
#      previous_hash chained, changelog appended; JSON synced from CARD.md)
#   3. round-trip validation: CARD.md -> JSON == card, hashes verified
#   4. sense Tier 0: site unchanged -> stop, cost ~$0.0001
#   5. the business updates its site (hours) -> sense detects, triages,
#      targeted-extracts -> dna.propose_change -> policy gate auto-applies
#      (low-risk) -> v3 minted: hash chain + changelog + receipt
#   6. the gate HOLDS on a voice change -> awaiting_approval
#   7. diff v1 -> v3, print CARD.md v3 + compiled system prompt
#
# Usage: ./demo.sh [organization_id]   (offline fixture by default; no keys)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
ORG="${1:-org_demo0001}"
SITE="/tmp/demo-site"

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }
card_id() { python3 -c "import json; print(json.load(open('$1'))['id'])"; }

say "deps"
python3 -c "import jsonschema" 2>/dev/null || pip install -q -r "$ROOT/swarm/requirements.txt"
if [ ! -d "$ROOT/compiler/node_modules" ]; then
  (cd "$ROOT/compiler" && npm install --no-audit --no-fund >/dev/null 2>&1)
fi
(cd "$ROOT/compiler" && npm run build >/dev/null 2>&1)
CLI="node $ROOT/compiler/dist/cli.js"

say "decider status — Jev is the decider, heuristics are the fallback until early access"
python3 -c "
import sys; sys.path.insert(0, '$ROOT/swarm')
from model_gateway import jev_status
s = jev_status()
print(f\"provider: {s['provider']} | {s['note']}\")"

say "clean slate (deterministic demo)"
rm -rf "$ROOT/cards" "$ROOT/compiled" "$ROOT/proposals" "$ROOT/receipts" "$ROOT/swarm/sense-state" "$ROOT/assets" "$SITE"
mkdir -p "$ROOT/cards" "$ROOT/compiled" "$ROOT/assets"
cp -r "$ROOT/swarm/fixtures/acme-cafe" "$SITE"

say "1. extract — the swarm reads the business, mints card v1"
CARD1="$(python3 "$ROOT/swarm/orchestrator.py" extract --url "file://$SITE/index.html" --org "$ORG" --out "$ROOT/cards" | tail -1)"
ID1="$(card_id "$CARD1")"
echo "card v1: $ID1"

say "1b. compile v1 — CARD.md is the product, JSON is the machine view"
CREATED="$(python3 -c "import json; print(json.load(open('$CARD1'))['created_at'])")"
FINDINGS="$(python3 -c "import json; print(len(json.load(open('$CARD1'))['field_provenance']))")"
echo "[\"**v1** ($CREATED): initial extraction — $FINDINGS provenance fields\"]" > /tmp/cl1.json
$CLI --card "$CARD1" --out "$ROOT/compiled/${ID1}_v1" --changelog /tmp/cl1.json | tail -1
cp "$ROOT/compiled/${ID1}_v1/CARD.md" "$ROOT/apps/operator/CARD-v1.md"

say "1c. sonic brand — patches the Sound section of CARD.md only -> v2 (hash chain + changelog)"
python3 "$ROOT/swarm/skills/sonic_brand/cli.py" --card "$CARD1" \
  --md "$ROOT/compiled/${ID1}_v1/CARD.md" --assets-dir "$ROOT/assets" --only voice_logo
CARD2="$(ls "$ROOT/cards/${ID1}_${ORG}_v2.json")"
echo "card v2: $(card_id "$CARD2")"
VL_HASH="$(python3 -c "import json; print((json.load(open('$CARD2'))['voice']['sonic']['voice_logo']['asset_ref'] or 'sha256:none').split(':')[1])")"
if [ "$VL_HASH" != "none" ]; then
  echo "voice logo: $ROOT/assets/$VL_HASH.mp3 ($(stat -c%s "$ROOT/assets/$VL_HASH.mp3") bytes)"
fi

say "2. round-trip validation — CARD.md v2 parses back to the identical card"
$CLI --verify-md --md "$ROOT/compiled/${ID1}_v1/CARD.md"

sense_report() { python3 -c "
import json,sys
r = json.load(sys.stdin)
for s in r['sites'][:1]:
    print(f\"tier reached: {s['tier_reached']} | {s.get('tier0')} | outcome: {s.get('outcome')} | cost: \" + chr(36) + str(round(s['cost_usd'],4)))
    for t in s.get('decision_trail', []):
        print(f\"  triage: provider={t['provider']} decision={t['decision']} confidence={t['confidence']}\")
print('total: ' + chr(36) + str(round(r['total_cost_usd'], 4)))"; }

say "4a. sense — first run establishes the baseline (Tier 0 -> 2, no drift found)"
python3 "$ROOT/swarm/sense.py" --org "$ORG" --force | sense_report

say "4b. sense again — Tier 0 change detection (nothing changed: stop, ~\$0.0001)"
python3 "$ROOT/swarm/sense.py" --org "$ORG" --force | sense_report

say "5. the business updates its site — Friday hours extend to 5pm"
sed -i 's/Mon–Fri 7am–3pm/Mon–Fri 7am–5pm/' "$SITE/index.html"
grep -o 'Mon–Fri 7am–5pm' "$SITE/index.html" | head -1

say "6. sense again — detect -> triage -> targeted extract -> propose -> gate auto-applies -> v3 minted"
SENSE_JSON="$(python3 "$ROOT/swarm/sense.py" --org "$ORG" --force)"
echo "$SENSE_JSON" | python3 -c "
import json,sys
r = json.load(sys.stdin)
s = r['sites'][0]
print(f\"tiers: 0 -> {s['tier_reached']} | {s.get('tier1')} | outcome: {s.get('outcome')} | cost: \" + chr(36) + str(round(s['cost_usd'],4)))
for p in s.get('proposals', []):
    print(f\"proposal {p['proposal']}: gate={p['gate']} status={p['status']} receipt={p.get('receipt')}\")
    for t in p.get('decision_trail', []):
        print(f\"  {t['question']}: provider={t['provider']} decision={t['decision']} confidence={t['confidence']}\")"
ID3="$(echo "$SENSE_JSON" | python3 -c "
import json,sys
r = json.load(sys.stdin)
props = r['sites'][0].get('proposals', [])
print(props[0]['card_id'] if props else '')")"
if [ -z "$ID3" ]; then echo "ERROR: sense produced no v3 card"; exit 1; fi
CARD3="$(ls "$ROOT/cards/${ID3}_${ORG}_v3.json")"
echo "card v3: $ID3"
cp "$ROOT/compiled/${ID3}_v3/CARD.md" "$ROOT/apps/operator/CARD-v3.md"

say "7. the policy gate HOLDS on identity/voice/policy changes"
TONE="$(python3 -c "import json; print(json.dumps(json.load(open('$CARD3'))['voice']['tone']))")"
python3 "$ROOT/swarm/mutate.py" propose --card "$ID3" --field voice.tone \
  --old "$TONE" --new '["corporate", "formal"]' --evidence "demo: rebrand attempt" \
  | python3 -c "import json,sys; r=json.load(sys.stdin); print(f\"gate={r['gate']} status={r['status']}\"); print('reason:', r['reason'])"

say "8. diff v1 -> v3 (what the business changed, governed)"
$CLI --card "$CARD1" --diff "$CARD3" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(f\"v{d['from_version']} -> v{d['to_version']}: {len(d['changed'])} changed\")
for c in d['changed'][:8]:
    print(f\"  ~ {c['path']}: {json.dumps(c['from'])[:60]} -> {json.dumps(c['to'])[:60]}\")"

say "9. round-trip validation — v3 CARD.md"
$CLI --verify-md --md "$ROOT/compiled/${ID3}_v3/CARD.md"

say "operator samples"
cp "$CARD1" "$ROOT/apps/operator/sample-card.json"
cp "$CARD3" "$ROOT/apps/operator/sample-card-v3.json"
mkdir -p "$ROOT/apps/operator/assets"
if [ "${VL_HASH:-none}" != "none" ]; then
  cp "$ROOT/assets/$VL_HASH.mp3" "$ROOT/apps/operator/assets/"
  echo "operator audio: apps/operator/assets/$VL_HASH.mp3 (plays in the Sonic brand section)"
fi
echo "open $ROOT/apps/operator/index.html"

say "HEADLINE ARTIFACT — CARD.md (v3): the product. Every agent is a consumer."
cat "$ROOT/compiled/${ID3}_v3/CARD.md"

say "compiled system prompt (v3) — derived from the same card"
cat "$ROOT/compiled/${ID3}_v3/system-prompt.md"
