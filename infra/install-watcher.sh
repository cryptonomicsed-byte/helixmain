#!/bin/bash
# Run from Termux: bash infra/install-watcher.sh
VPS="root@omokoda.duckdns.org"
REPO_DIR="/data/data/com.termux/files/home/helixmain"

echo "==> Installing HelixMain watcher on VPS..."

# Copy scripts
ssh "$VPS" "mkdir -p /opt/helix"
scp "${REPO_DIR}/infra/helix-rebuild.sh" "${VPS}:/opt/helix/helix-rebuild.sh"
scp "${REPO_DIR}/infra/helix-watcher.sh" "${VPS}:/opt/helix/helix-watcher.sh"
ssh "$VPS" "chmod +x /opt/helix/helix-rebuild.sh /opt/helix/helix-watcher.sh"

# Install systemd unit
scp "${REPO_DIR}/infra/helix-watcher.service" "${VPS}:/etc/systemd/system/helix-watcher.service"
ssh "$VPS" "systemctl daemon-reload && systemctl enable helix-watcher && systemctl restart helix-watcher"

# Check status
ssh "$VPS" "systemctl is-active helix-watcher"
echo "==> Done"
