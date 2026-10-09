#!/bin/bash
set -euo pipefail
REPO_DIR="/root/helixmain"
SITE_DIR="${REPO_DIR}/site"
WEB_ROOT="/var/www/helixmain-site"

cd "$REPO_DIR"
git pull origin main 2>&1 | tail -3

cd "$SITE_DIR"
HELIX_CARD_ROOT=/etc/helix/companies bash scripts/build-from-cards.sh 2>&1

rsync -a --delete public/ "$WEB_ROOT/"

# Write build status
python3 -c "
import json, datetime
print(json.dumps({
  'last_build': datetime.datetime.utcnow().isoformat() + 'Z',
  'status': 'ok',
  'trigger': 'auto'
}))
" > "${WEB_ROOT}/build-status.json"

echo "==> Rebuild complete"
