#!/usr/bin/env bash
# The orchestrator's gates: formatting, compile warnings as errors, the unit
# suite, then the end-to-end suite against the REAL gateway, kernel and policy
# service (needs go, cargo and a JVM; builds what is missing).
set -euo pipefail
cd "$(dirname "$0")"
mix format --check-formatted
mix compile --force --warnings-as-errors
mix test --include e2e
echo "orchestrator: all gates passed"
