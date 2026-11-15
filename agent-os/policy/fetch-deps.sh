#!/usr/bin/env bash
# Download the four jars the policy service needs into lib/ and verify their
# SHA-256 against deps.sha256. Nothing is trusted until the hash matches.
# Maven Central rate-limits some networks; the Google mirror of Central is tried
# as a fallback.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p lib
declare -A PATHS=(
  [clojure-1.12.0.jar]=org/clojure/clojure/1.12.0
  [spec.alpha-0.5.238.jar]=org/clojure/spec.alpha/0.5.238
  [core.specs.alpha-0.4.74.jar]=org/clojure/core.specs.alpha/0.4.74
  [data.json-2.5.1.jar]=org/clojure/data.json/2.5.1
)
BASES=(https://repo1.maven.org/maven2 https://maven-central.storage-download.googleapis.com/maven2)
want() { grep " $1\$" deps.sha256 | cut -d' ' -f1; }
for jar in "${!PATHS[@]}"; do
  if [ -f "lib/$jar" ] && [ "$(sha256sum "lib/$jar" | cut -d' ' -f1)" = "$(want "$jar")" ]; then continue; fi
  ok=0
  for base in "${BASES[@]}"; do
    curl -fsS --max-time 120 -o "lib/$jar.part" "$base/${PATHS[$jar]}/$jar" 2>/dev/null || continue
    if [ "$(sha256sum "lib/$jar.part" | cut -d' ' -f1)" = "$(want "$jar")" ]; then mv "lib/$jar.part" "lib/$jar"; ok=1; break; fi
    rm -f "lib/$jar.part"
  done
  [ "$ok" = 1 ] || { echo "could not fetch a verified $jar" >&2; exit 1; }
done
echo "policy dependencies verified in $(pwd)/lib"
