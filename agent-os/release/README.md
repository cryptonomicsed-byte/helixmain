# Release gates

```bash
python3 release/gates.py                  # run everything
python3 release/gates.py --list           # what the gates are
python3 release/gates.py --only kernel,gateway
python3 release/gates.py --require-all    # before a release: a SKIPPED gate counts as a failure
```

Each gate is a real command with a timeout; the outcome is PASS, FAIL, or SKIPPED with the reason (a missing toolchain, an
unreachable database): **a skip is printed and counted, never silent, and is not a pass**. Evidence (commit, whether the tree
was dirty, toolchain versions, every result with timing and the tail of its output) is written to
`release/evidence-<commit>.json` (git-ignored: it describes a specific commit).

| gate | proves |
|---|---|
| `secrets` | no private key, Nostr secret, HELIX token, or API key is committed (the public conformance test keys are allowlisted by path) |
| `contracts` | the canonical-JSON golden vectors are reproducible byte for byte |
| `policy` | the Clojure policy service (32 tests) |
| `kernel` | the Rust kernel and its Wasm plugin host (`cargo test --locked`) |
| `kernel-with-policy` | the kernel against the real Clojure service over HTTP |
| `plugins` | the plugin components are rebuilt and the host's tests pass against them |
| `gateway` | generated gRPC stubs match the proto; unit tests with the race detector; gateway → kernel → policy end to end; Go↔Rust mutual TLS |
| `orchestrator` | format, no warnings, unit tests, and end to end against the real stack |
| `alerts`, `systemd-units` | the alert rules only use exported metrics; the unit files are valid |
| `deploy-drill` | bootstrap → run → smoke → real work → backup → destroy → restore → nothing lost; a tampered backup is refused |
| `go-vulnerabilities` | known vulnerabilities in Go dependencies (SKIPPED where the database is unreachable) |
| `sid-vectors`, `sid-typescript` | the shared identity and QR conformance suites, in the sibling `sid` repository when present |

## Not covered by any gate

Nothing here has run against a live host, a real WhatsApp/SIP/Nostr network, a real payment provider, or a real browser or phone; there is
no CI on these repositories (the gates are a script you or a CI job runs); dependency vulnerability scans for Rust and Elixir are not run;
the customer, business, staff and operator applications, video and avatar rendering, agent-to-agent commerce, and the Julia and Move
components do not exist yet. A passing run of these gates means *the parts that exist behave as tested*, not that the HELIX v3 release
criteria are met.
