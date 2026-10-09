#!/bin/bash
# Watches /etc/helix/companies/ for card.json changes, debounces, triggers rebuild
WATCH_DIR="/etc/helix/companies"
REBUILD_SCRIPT="/opt/helix/helix-rebuild.sh"
LOCK_FILE="/tmp/helix-rebuild.lock"
DEBOUNCE_SECS=5

echo "HelixMain watcher started — watching ${WATCH_DIR}"

while true; do
  # Wait for any change in the watch dir
  changed=$(inotifywait -r -e modify,create,delete --format '%f' --quiet \
    "$WATCH_DIR" 2>/dev/null)

  # Only trigger on card.json or CARD.md changes
  if [[ "$changed" == *card.json* ]] || [[ "$changed" == *CARD.md* ]]; then
    echo "[$(date -u +%H:%M:%SZ)] Change detected: $changed — waiting ${DEBOUNCE_SECS}s..."
    sleep "$DEBOUNCE_SECS"

    # Acquire lock (prevent concurrent rebuilds)
    if ( set -o noclobber; echo $$ > "$LOCK_FILE" ) 2>/dev/null; then
      trap 'rm -f "$LOCK_FILE"' EXIT
      echo "[$(date -u +%H:%M:%SZ)] Triggering rebuild..."
      bash "$REBUILD_SCRIPT" && echo "[$(date -u +%H:%M:%SZ)] Rebuild OK" \
        || echo "[$(date -u +%H:%M:%SZ)] Rebuild FAILED"
      rm -f "$LOCK_FILE"
    else
      echo "[$(date -u +%H:%M:%SZ)] Rebuild already running, skipping"
    fi
  fi
done
