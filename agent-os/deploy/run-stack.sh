#!/usr/bin/env bash
# Start (or stop) the stack WITHOUT systemd, from the env files bootstrap.sh wrote.
# Used by selftest.sh and for development; production uses the units in systemd/.
#
#   ./run-stack.sh start --prefix DIR [--resolver]    start policy, kernel, gateway (and the resolver) in the background
#   ./run-stack.sh stop  --prefix DIR                 stop them
set -euo pipefail
CMD="${1:-}"; shift || true
PREFIX="/"; WITH_RESOLVER=0
while [ $# -gt 0 ]; do case "$1" in --prefix) PREFIX="$2"; shift 2;; --resolver) WITH_RESOLVER=1; shift;; *) echo "unknown argument $1" >&2; exit 2;; esac; done
PREFIX="${PREFIX%/}"; OPT="$PREFIX/opt/helix"; ETC="$PREFIX/etc/helix"; RUN="$PREFIX/var/lib/helix/run"
mkdir -p "$RUN"

launch() { # launch NAME ENVFILE DIR COMMAND...
  local name="$1" envf="$2" dir="$3"; shift 3
  ( set -a; . "$envf"; set +a; cd "$dir"; exec "$@" ) >"$RUN/$name.log" 2>&1 &
  echo $! >"$RUN/$name.pid"
}
wait_http() { for _ in $(seq 1 200); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 0.1; done; echo "never came up: $1" >&2; return 1; }
port_of() { ( set -a; . "$1"; set +a; eval "echo \${$2##*:}" ); }

case "$CMD" in
  start)
    launch policy "$ETC/policy.env" "$OPT/policy" java -Xmx256m -Dfile.encoding=UTF-8 -cp 'lib/*:src' clojure.main -m helix.policy.main
    wait_http "http://127.0.0.1:$(port_of "$ETC/policy.env" HELIX_POLICY_PORT)/health"
    launch kernel "$ETC/kernel.env" "$PREFIX/var/lib/helix/kernel" "$OPT/bin/helix-kernel" serve
    for _ in $(seq 1 100); do grep -q "listening on" "$RUN/kernel.log" 2>/dev/null && break; sleep 0.1; done
    launch gateway "$ETC/gateway.env" "$PREFIX/var/lib/helix" "$OPT/bin/helix-gateway" serve
    wait_http "http://127.0.0.1:$(port_of "$ETC/gateway.env" HELIX_GATEWAY_LISTEN)/readyz"
    if [ "$WITH_RESOLVER" = 1 ]; then
      launch resolver "$ETC/resolver.env" "$PREFIX/var/lib/helix/resolver" "$OPT/bin/helix-resolver"
      wait_http "http://127.0.0.1:$(port_of "$ETC/resolver.env" HELIX_RESOLVER_LISTEN)/healthz"
    fi
    echo "stack is up (logs in $RUN)";;
  stop)
    for n in resolver gateway kernel policy; do
      if [ -f "${RUN:?}/$n.pid" ]; then
        pid="$(cat "${RUN:?}/$n.pid")"
        kill "$pid" 2>/dev/null || true
        for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done   # wait for it to really exit
        if kill -0 "$pid" 2>/dev/null; then echo "$n (pid $pid) did not stop in 10 s" >&2; kill -9 "$pid" 2>/dev/null || true; fi
      fi
    done
    echo "stack stopped";;
  *) echo "usage: run-stack.sh start|stop --prefix DIR" >&2; exit 2;;
esac
