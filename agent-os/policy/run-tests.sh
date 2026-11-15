#!/usr/bin/env bash
# Runs the policy service's tests on the JVM with the pinned jars (see fetch-deps.sh).
set -euo pipefail
cd "$(dirname "$0")"
./fetch-deps.sh >/dev/null
exec java -Dfile.encoding=UTF-8 -cp "lib/*:src:test" clojure.main -m runner "$@"
