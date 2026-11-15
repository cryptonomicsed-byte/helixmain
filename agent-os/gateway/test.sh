#!/usr/bin/env bash
# The gateway's gates, in order:
#   1. the generated stubs match the proto (no drift)
#   2. unit tests, race detector on
#   3. the end-to-end chain: this gateway -> the Rust kernel binary -> the Clojure policy service
# (3) needs cargo, a JVM and network access to fetch the policy jars once (hash-checked).
set -euo pipefail
cd "$(dirname "$0")"

echo "== generated code is current"
./gen.sh >/dev/null
if ! git diff --quiet -- gen; then
  echo "gen/ differs from the proto: run ./gen.sh and commit the result" >&2
  git --no-pager diff --stat -- gen >&2
  exit 1
fi

echo "== unit tests (race detector)"
go vet ./...
go test -race -count=1 ./...

echo "== end to end: gateway -> kernel -> policy"
(cd ../kernel && cargo build --offline --bin helix-kernel 2>/dev/null || cargo build --bin helix-kernel)
go test -tags e2e -count=1 ./internal/e2e
echo "gateway: all gates passed"
