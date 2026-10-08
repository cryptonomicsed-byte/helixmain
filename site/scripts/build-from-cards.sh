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
import json, sys

card_path, company_id, npub, caller_url, out_dir = sys.argv[1:]
card = json.load(open(card_path))

identity = card.get("identity", {})
offerings = card.get("offerings", [])
ops       = card.get("operations", {})

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
    "card_version": card.get("version", ""),
    "card_hash":    (card.get("hash", "") or "")[:16],
}
json.dump(out, open(f"{out_dir}/{company_id}.json", "w"), indent=2)
print(f"  built {company_id}: {out['name']}")
PYEOF

  # Generate QR for caller URL
  if [ -n "$caller_url" ]; then
    python3 - "$caller_url" "${QR_OUT}/${id}-talk.png" << 'PYEOF'
import sys, qrcode
url, out = sys.argv[1], sys.argv[2]
qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=8, border=3)
qr.add_data(url)
qr.make(fit=True)
img = qr.make_image(fill_color="#0f0f0f", back_color="#e2e2e2")
img.save(out)
print(f"  qr  {out.split('/')[-1]}")
PYEOF
  fi
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
