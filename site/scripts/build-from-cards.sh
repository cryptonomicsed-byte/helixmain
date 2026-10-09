#!/bin/bash
# Reads each company's card.json + identity file → data/companies/{id}.json
# Then generates content/b/{id}.md stubs → hugo build
# Run from the site/ directory.
set -euo pipefail

CARD_ROOT="${HELIX_CARD_ROOT:-/etc/helix/companies}"
SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${SITE_DIR}/data/companies"
CONTENT_B="${SITE_DIR}/content/b"
QR_OUT="${SITE_DIR}/static/qr"

mkdir -p "$OUT" "$CONTENT_B" "$QR_OUT"

RELAY="${HELIX_RELAY:-wss://omokoda.duckdns.org:3443}"
CALLER_BASE="${HELIX_CALLER_BASE:-https://omokoda.duckdns.org/caller/}"

echo "==> Building company data from ${CARD_ROOT}"

for dir in "${CARD_ROOT}"/*/; do
  id=$(basename "$dir")
  card="${dir}/card.json"
  identity="${dir}/identity"
  [ -f "$card" ] || continue

  # Read npub from identity file (3rd line: sk, pk, npub)
  npub=""
  if [ -f "$identity" ]; then
    npub=$(sed -n '3p' "$identity")
  fi

  caller_url=""
  if [ -n "$npub" ]; then
    encoded_relay=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$RELAY")
    name=$(python3 -c "import json; print(json.load(open('${card}'))['identity'].get('name',''))")
    encoded_name=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$name")
    caller_url="${CALLER_BASE}?npub=${npub}&relay=${encoded_relay}&name=${encoded_name}"
  fi

  python3 - "$card" "$id" "$npub" "$caller_url" "$OUT" << 'PYEOF'
import json, sys, datetime

card_path, company_id, npub, caller_url, out_dir = sys.argv[1:]
card = json.load(open(card_path))

identity = card.get("identity", {})
offerings = card.get("offerings", [])
ops       = card.get("operations", {})

# Specials — only active ones (valid_to null or >= today)
today = datetime.date.today().isoformat()
all_specials = card.get("specials", [])
active_specials = [s for s in all_specials if not s.get("valid_to") or s.get("valid_to", "") >= today]

# Socials
socials = identity.get("socials", {})

# Response SLA
response_sla = ops.get("response_sla", "")

# Card health score — simple completeness calculation
def card_health(c):
    checks = [
        bool(c.get("identity", {}).get("name")),
        bool(c.get("identity", {}).get("elevator_pitch")),
        bool(c.get("identity", {}).get("phone")),
        bool(c.get("identity", {}).get("location")),
        bool(c.get("identity", {}).get("website")),
        bool(c.get("voice", {}).get("tone")),
        bool(c.get("voice", {}).get("personality")),
        bool(c.get("offerings")),
        bool(c.get("operations", {}).get("hours")),
        bool(c.get("identity", {}).get("review_url")),
        bool(c.get("identity", {}).get("socials")),
        bool(c.get("specials")),
        len(c.get("offerings", [])) >= 3,
        len(c.get("policies", [])) >= 1,
        bool(c.get("operations", {}).get("response_sla")),
    ]
    return round(sum(checks) / len(checks) * 100)

health_score = card_health(card)
health_label = "excellent" if health_score >= 85 else "good" if health_score >= 65 else "needs work"

out = {
    "id":           company_id,
    "name":         identity.get("name", ""),
    "tagline":      identity.get("elevator_pitch", ""),
    "phone":        identity.get("phone", ""),
    "address":      identity.get("location", ""),
    "hours":        ops.get("hours", ""),
    "offerings":    offerings,
    "voice_tone":   card.get("voice", {}).get("tone", ""),
    "npub":         npub,
    "caller_url":   caller_url,
    "review_url":   identity.get("review_url", ""),
    "card_version": card.get("version", 1),
    "card_hash":    (card.get("hash", "") or "")[:16],
    "specials":     active_specials,
    "socials":      socials,
    "response_sla": response_sla,
    "health_score": health_score,
    "health_label": health_label,
    "last_updated": card.get("created_at", ""),
}
json.dump(out, open(f"{out_dir}/{company_id}.json", "w"), indent=2)
print(f"  built {company_id}: {out['name']}")
PYEOF

  # Generate talk + review QR images
  python3 - "$card" "$id" "$caller_url" "$QR_OUT" << 'PYEOF'
import sys, json, qrcode

card_path, company_id, caller_url, qr_dir = sys.argv[1:]
card = json.load(open(card_path))
review_url = card.get("identity", {}).get("review_url", "")

def make_qr(url, path):
    if not url:
        return
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=8, border=3)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#0f0f0f", back_color="#e2e2e2")
    img.save(path)
    print(f"  qr  {path.split('/')[-1]}")

make_qr(caller_url,  f"{qr_dir}/{company_id}-talk.png")
make_qr(review_url,  f"{qr_dir}/{company_id}-review.png")
PYEOF
done

echo "==> Generating content stubs"
for f in "${OUT}"/*.json; do
  id=$(basename "$f" .json)
  name=$(python3 -c "import json; print(json.load(open('${f}'))['name'])")
  cat > "${CONTENT_B}/${id}.md" << EOF
---
title: "${name}"
layout: company
type: company
company_id: "${id}"
---
EOF
  echo "  stub ${id}"
done

echo "==> Running hugo"
cd "$SITE_DIR"
hugo --minify
echo "==> Done — output in site/public/"
