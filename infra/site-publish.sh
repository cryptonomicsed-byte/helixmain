#!/bin/bash
# site-publish — rebuild the public Hugo site from cards and deploy it.
#
# Called by POST /site/generate (Flow A). Exits non-zero on ANY failure so the
# API can refuse to charge credits for a page that did not actually publish.
# This is the ONLY flow that produces a public URL; the LLM single-file
# generator is a preview (POST /site/preview) and never touches the web root.
#
# Usage: site-publish.sh <company-id>
set -euo pipefail

COMPANY_ID="${1:-}"
REPO_DIR="${HELIX_REPO_DIR:-/root/helixmain}"
SITE_DIR="${REPO_DIR}/site"
WEB_ROOT="${HELIX_WEB_ROOT:-/var/www/helixmain-site}"
CARD_ROOT="${HELIX_CARD_ROOT:-/etc/helix/companies}"

if [ -z "$COMPANY_ID" ]; then
  echo "site-publish: company id required" >&2
  exit 64
fi

# 1. The card must exist — publishing an unknown company is a no-op we refuse.
if [ ! -f "${CARD_ROOT}/${COMPANY_ID}/card.json" ]; then
  echo "site-publish: no card for '${COMPANY_ID}' under ${CARD_ROOT}" >&2
  exit 2
fi

# 2. Build the site data + Hugo output (data/companies/*.json, content/b/*.md).
cd "$SITE_DIR"
HELIX_CARD_ROOT="$CARD_ROOT" bash scripts/build-from-cards.sh

# 3. The target page must exist, or we published nothing.
PAGE="${SITE_DIR}/public/b/${COMPANY_ID}/index.html"
if [ ! -f "$PAGE" ]; then
  echo "site-publish: build produced no page at b/${COMPANY_ID}/index.html" >&2
  exit 3
fi

# 4. Deploy.
#    --exclude=/l is load-bearing: landing pages live in the web root's /l tree
#    (written by the API), NOT in the Hugo build. Without the exclude, --delete
#    would erase every landing page on every card publish.
rsync -a --delete --exclude=/l "${SITE_DIR}/public/" "${WEB_ROOT}/"

# 5. Record the build.
python3 - "$WEB_ROOT" "$COMPANY_ID" <<'PY'
import datetime, json, sys
web_root, company_id = sys.argv[1], sys.argv[2]
with open(f"{web_root}/build-status.json", "w") as f:
    json.dump({
        "last_build": datetime.datetime.utcnow().isoformat() + "Z",
        "status": "ok",
        "trigger": "api",
        "company_id": company_id,
    }, f)
PY

echo "published ${COMPANY_ID} -> /b/${COMPANY_ID}/"
