# HELIX plugins (WebAssembly components, WIT)

A plugin is a **WebAssembly component** implementing the WIT world in
[`wit/helix-plugin.wit`](wit/helix-plugin.wit). The kernel's Wasm host
(`../kernel/src/plugins.rs`, Wasmtime) runs it. Models, merchants and third
parties can write plugins, so the host treats every one as hostile and gives it
nothing: **a plugin computes and it proposes; it cannot act.**

```
agent ─ POST /v1/plugins/{id}/tools/{tool}/invoke ─▶ gateway ─ InvokePlugin ─▶ kernel ─▶ Wasm sandbox
                                                                                    │
        result + PROPOSED intents ◀──────────────────────────────────────────────────┘
        each proposal still goes through AuthorizeAction → (person confirms money) → grant → executor
```

## What a plugin gets

| | |
|---|---|
| `host.log(level, message)` | bounded, rate-limited |
| `host.kv-get / kv-set` | its own storage in its own tenant; needs the `storage` permission; quota-limited; **writes commit only if the invocation succeeds** |
| a clock | **frozen** at the kernel's time for the call; monotonic time does not move and nothing can wait on it |
| randomness | seeded from the call, so a call is a pure function of (input, stored state, frozen clock) |
| network, filesystem, environment, args, processes, threads | **none.** A component that even *imports* `wasi:sockets` or `wasi:http` is refused at install, before any of its code runs |

Output: `result-json` (JSON, bounded) and `proposed-intents` (ActionIntent JSON). The host never runs an intent; it pins
`organization_id` and `agent_id` to the tenant and the invoking agent (a plugin that names anyone else has its whole output
refused), fills `id` and `idempotency_key`, and returns them. The caller completes them (it chooses the audience) and sends
each through the kernel's authorize / confirm / execute path, so a plugin that proposes spending money still needs a person.

## Signed manifests

A plugin installs only with a `helix-plugin/1` manifest signed (sid/0.2 scheme: hash of the canonical body, issuer proof)
by an issuer in the kernel's trust anchors:

```json
{ "format": "helix-plugin/1", "id": "acme.pricing", "version": "1.0.0",
  "component": { "sha256": "<of the exact .wasm>", "size": 109988 },
  "tools": [ {"name": "quote", "description": "…"}, {"name": "checkout", "description": "…"} ],
  "permissions": ["storage"],
  "limits": { "fuel": 50000000, "memory_bytes": 33554432, "timeout_ms": 2000, "max_input_bytes": 65536, "max_output_bytes": 65536, "storage_bytes": 262144 },
  "issuer": {"id": "…", "kid": "…"}, "issued_at": "…", "expires_at": "…", "hash": "…", "proof": {…} }
```

Refused: unsigned, tampered, wrong issuer, expired, not yet valid, a component that is not the one named, unknown fields,
unknown permissions, limits above the host's ceilings (a manifest may ask for *less*, never more), tools that differ from what
the component itself lists, imports the host does not offer, a version that is not newer than the installed one. Manifests are
**verified again on every kernel restart**; one that has expired is not loaded and says so in the audit chain.

## Limits (host ceilings; a manifest may lower them)

fuel 2 × 10⁹ instructions · wall-clock deadline 10 s (epoch interruption, independent of fuel) · memory 256 MiB · stack 512 KiB ·
input/output 1 MiB · storage 4 MiB (64 KiB per value, 1000 operations per call) · 16 proposed intents · 200 log lines ·
32 KiB of stdout/stderr · 8 concurrent invocations (more get `RESOURCE_EXHAUSTED`) · components ≤ 8 MiB. A fresh instance per
invocation: nothing leaks between calls.

## Building and testing

```bash
rustup target add wasm32-wasip2
./build.sh          # builds dist/*.wasm: pricing (a real example), conformance (misbehaves on purpose), conformance-net (imports sockets)
./test.sh           # rebuilds, then runs the host's tests against the freshly built components
```

`dist/` is committed so the kernel's tests need no wasm toolchain; `SHA256SUMS` lists them. Rust builds are not guaranteed
bit-reproducible, so `test.sh` checks that **rebuilt** components pass the same tests rather than comparing hashes.

The `conformance` plugin has one tool per way to misbehave: loop forever, allocate 200 MiB, recurse without end, panic, sleep
30 s, flood stdout, flood logs, return a huge or non-JSON result, propose 17 intents, propose for another tenant or agent, read
`/etc/passwd`, read the environment, write storage then panic, exceed the storage quota, use storage without the permission.
`../kernel/tests/plugins.rs` (29 tests) runs every one and asserts the sandbox held; breaking the signature check, the storage
permission, the tenant pinning or the no-sleep clock on purpose each fails tests.

## Writing a plugin

A Rust crate with `crate-type = ["cdylib"]`, `wit-bindgen`, and `wit_bindgen::generate!({ path: "…/wit", world: "plugin" })`;
implement `Guest::list_tools` and `Guest::invoke`; build for `wasm32-wasip2`. See `examples/pricing`. Any language with
component-model tooling (JavaScript via `jco`, Go via `componentize-go`, Python via `componentize-py`, C via `wit-bindgen`)
works the same way: the contract is the WIT file and the manifest, not Rust.

## Not done / limits

- **No plugin registry or marketplace**, no per-tenant approval workflow: a signed manifest installs through
  `POST /v1/plugins` (service with `plugin_admin`).
- **Issuer tooling** for signing manifests exists only as the test helpers (Rust and Go); no operator CLI yet.
- Memory is capped per store across memories, but Wasmtime's default guard regions mean each instance *reserves* address
  space well above its limit; under heavy concurrency size `max_concurrent` accordingly.
- Compilation of an untrusted component happens at install, bounded by the 8 MiB size ceiling but not by CPU time.
- Fuel is a count of Wasm instructions, not of host work (a tool that makes many storage calls is bounded by the 1000-operation cap).
- Plugin inputs and outputs are not logged; the audit chain records SHA-256s, the status, fuel and time.
