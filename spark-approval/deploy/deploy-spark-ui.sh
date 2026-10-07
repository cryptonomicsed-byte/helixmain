#!/usr/bin/env bash
# Deploy the compiled spark-approval Vite dist to /var/www/spark/ on the VPS.
# Run from the helixmain repo root or spark-approval/ directory.
# Requires: npm run build already done; SSH alias `hostinger` configured.
set -euo pipefail

DIST="$(dirname "$0")/../dist"
VPS="hostinger"
REMOTE_DIR="/var/www/spark"

if [ ! -f "$DIST/index.html" ]; then
  echo "ERROR: dist/index.html not found. Run: cd spark-approval && npm run build"
  exit 1
fi

echo "==> uploading dist to $VPS:$REMOTE_DIR"
scp -r "$DIST/." "$VPS:$REMOTE_DIR/"

echo "==> fixing permissions (nginx runs as www-data)"
ssh "$VPS" "chmod -R a+rX $REMOTE_DIR"

echo "==> verifying"
HTTP=$(ssh "$VPS" "curl -s -o /dev/null -w '%{http_code}' https://omokoda.duckdns.org/spark/")
if [ "$HTTP" = "200" ]; then
  echo "  OK — https://omokoda.duckdns.org/spark/ → 200"
else
  echo "  WARN — got HTTP $HTTP (check nginx config)"
fi
