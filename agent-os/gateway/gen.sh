#!/usr/bin/env bash
# Regenerates gen/ from ../contracts/proto without protoc (see tools/protogen).
# Pinned plugin versions are installed into a throwaway GOBIN.
set -euo pipefail
cd "$(dirname "$0")"
BIN="$(mktemp -d)"
trap 'rm -rf "$BIN"' EXIT
GOBIN="$BIN" go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.11
(cd "$BIN" && GOBIN="$BIN" go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.6.1)
PATH="$BIN:$PATH" go run ./tools/protogen -proto ../contracts/proto -out gen helix/kernel/v1/kernel.proto
