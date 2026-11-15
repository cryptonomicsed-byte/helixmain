#!/usr/bin/env bash
# Rebuild the plugin components, then run the host's tests against THEM.
set -euo pipefail
cd "$(dirname "$0")"
./build.sh >/dev/null
cd ../kernel
cargo test --test plugins --test plugin_rpc
echo "plugins: all gates passed"
