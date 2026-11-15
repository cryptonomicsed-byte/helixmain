#!/usr/bin/env bash
# Builds the example and test plugins into dist/ as WebAssembly components
# (target wasm32-wasip2). Needs: rustup target add wasm32-wasip2
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release --target wasm32-wasip2 --locked 2>/dev/null || cargo build --release --target wasm32-wasip2
mkdir -p dist
for pair in helix_plugin_pricing:pricing helix_plugin_conformance:conformance helix_plugin_conformance_net:conformance-net; do
  cp "target/wasm32-wasip2/release/${pair%%:*}.wasm" "dist/${pair##*:}.wasm"
done
( cd dist && sha256sum *.wasm > SHA256SUMS && cat SHA256SUMS && ls -l *.wasm )
