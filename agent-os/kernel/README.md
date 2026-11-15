# helix-kernel

The trusted boundary. Models, workers, merchants and plugins **propose**
effects; the kernel **decides** whether one may happen, records the decision,
and gives the executor a permit **at most once**.

```
agent ── AuthorizeAction ──▶ kernel ── helix-policy-request/1 ──▶ policy service
  ▲                            │   ◀── decision ──────────────────────┘
  │ ALLOW + signed grant,      │  kernel invariants applied on top (never looser)
  │ or DENY, or "ask a person" │
  │                            ▼
person ── ConfirmAction ───▶ grant issued for exactly that action
executor ── BeginExecution(grant, intent) ──▶ PERMITTED (once) / PENDING / refused
executor ── RecordResult(SUCCEEDED | FAILED, provider evidence) ──▶ receipt hash
```

Contract: `../contracts/proto/helix/kernel/v1/kernel.proto`. Everything is
audited in a hash chain; see *Audit*.

## What it enforces

| Rule | Where it is tested |
|---|---|
| An agent acts only if its **sid/0.2 identity verifies under a trust anchor the kernel was configured with**, is `live`, and **declares the capability** (the runtime statement can narrow it). Re-checked at *every* effect boundary, so a suspension, an expired runtime, or a compromised issuer key stops the agent at once. | `kernel_flow.rs` |
| The kernel's own implementation of the identity verifier agrees with the Python and TypeScript ones on **all 54 shared vectors**. | `identity_vectors.rs` |
| A **client-supplied tenant never overrides the authenticated one**; an agent principal can act only as itself; an id from another tenant does not exist. | `kernel_flow.rs` |
| **Policy is asked, then the kernel applies its own invariants**, which can only make a decision stricter: money above `auto_allow_max_amount_minor` (default 0) and high-risk actions always need a person, whatever policy says. | `kernel_flow.rs` |
| **Fail closed:** policy unreachable, slow, erroring, non-JSON, or answering with an unknown decision ⇒ DENY. | `policy_and_grpc.rs` |
| **A held decision can be read** (`GetPending`) by users and services of its own tenant, never by agents; another tenant cannot tell it exists. The gateway uses it to decide *which* user may answer. | `kernel_flow.rs` |
| **Only a person confirms.** An agent, worker or service can never confirm its own action. A yes is re-checked against the agent and policy, expires, and cannot be answered twice. | `kernel_flow.rs` |
| A **grant** is signed, scoped to one agent, executor, operation, target, amount and time, **bound by hash to the exact intent** (amount, quote, items, target...), and single-use. Changing anything after authorization is refused. | `kernel_flow.rs` |
| **At most one permit per idempotency key**, under 16 concurrent callers, across restarts. Retries get the recorded state. A lost response is safe (the retry sees `PENDING`), never a double execution. | `kernel_flow.rs` |
| An **ambiguous provider answer cannot be recorded** as an outcome. The execution stays `PENDING` until it is reconciled. A recorded outcome is final. | `kernel_flow.rs` |
| **Key rotation:** old grants verify until their key is removed from the verifying set. Removing it revokes everything it signed. | `kernel_flow.rs` |
| **Audit chain** detects edits, deletions and reordering; it never holds tool arguments or signatures. | `kernel_flow.rs` |
| The server needs **mutual TLS** off loopback; clients with no certificate or one from another CA are refused. | `policy_and_grpc.rs` |

## Run

```bash
cargo test                               # 46 tests; no protoc, no services needed
helix-kernel keygen /etc/helix/kernel.key        # mode 0600; refuses to overwrite
HELIX_KERNEL_SIGNING_KEY_FILE=/etc/helix/kernel.key \
HELIX_KERNEL_TRUST_FILE=/etc/helix/sid-trust.json \
HELIX_KERNEL_DB=/var/lib/helix/kernel.sqlite \
HELIX_POLICY_URL=http://127.0.0.1:8200 \
helix-kernel serve
```

| Variable | Meaning |
|---|---|
| `HELIX_KERNEL_SIGNING_KEY_FILE` | Ed25519 grant-signing key, 64 hex chars. Required. Must be mode 0600. The kernel never generates one itself. |
| `HELIX_KERNEL_PREVIOUS_PUBLIC_KEYS` | Comma-separated public keys of earlier signing keys still honoured (rotation). |
| `HELIX_KERNEL_TRUST_FILE` | sid trust anchors (`{"issuers": {id: {"keys": [...]}}}`, see `sid/spec/sid-0.2.md` §7). Required. |
| `HELIX_POLICY_URL` | Policy service. If unset, every privileged action is denied. |
| `HELIX_KERNEL_LISTEN` | Default `127.0.0.1:50051`. A non-loopback address requires TLS. |
| `HELIX_KERNEL_TLS_CERT`, `_KEY`, `_CLIENT_CA` | Set all three for mutual TLS. |
| `HELIX_KERNEL_GRANT_TTL_SECS` / `_PENDING_TTL_SECS` | Defaults 300 / 3600. |
| `HELIX_KERNEL_AUTO_ALLOW_MAX_AMOUNT_MINOR` | Default 0: any money needs a person. |

## Limits you should know about

- **Peers are trusted to say who is calling.** mTLS proves the caller is a
  trusted peer (the gateway, an executor); the `RequestContext` it sends
  (organisation, principal, kind) is then believed. A compromised gateway can
  lie about it. Mapping each certificate to the principals it may assert is not
  done yet.
- **Users are not mapped to roles.** The kernel enforces *kind* (only a
  `USER` confirms) but not which user may confirm which request, nor that a
  reviewer is not the requester. The policy service (`agent-os/policy`) cannot
  decide it either until the request carries roles and the original requester,
  so the gateway enforces it for now.
- **Signing keys are in a file**, not a KMS or HSM. File permissions are
  checked; nothing more.
- **Arguments cannot contain floating-point numbers** (the languages disagree on
  how to print them). Money is integer minor units.
- **The audit chain is tamper-evident, not tamper-proof**: someone with write
  access to the database can rewrite the whole chain. Anchor the head hash
  (`Health.audit_head`) somewhere they cannot reach to close that gap.
- SQLite is a single-node store. Running several kernels needs a different store.
- The sid reference signers used by tests are not constant-time; production
  issuer keys must sign in hardened code.

## Wasm plugins

`HELIX_KERNEL_PLUGINS=on` turns on the plugin host (`src/plugins.rs`, Wasmtime, WIT; see `../plugins/README.md`).
A plugin is a signed WebAssembly component that **computes and proposes; it cannot act**: no network, filesystem,
environment, real clock or real randomness, no way to wait; fuel, wall-clock, memory, stack, output and storage limits;
a fresh instance per call; storage writes commit only if the call succeeds. Installing needs a manifest signed by a trust
anchor naming the exact component. Running a tool needs a live agent that declared `plugin.<id>.<tool>`; a proposed intent
comes back with tenant and agent pinned by the kernel and still goes through `AuthorizeAction`. Installs are re-verified at
every restart. Tests: `tests/plugins.rs` (28, real components) and `tests/plugin_rpc.rs` (9).

## Against the real policy service

`cargo test --test policy_clojure -- --ignored --test-threads=1` starts the Clojure
service (`agent-os/policy`, needs a JVM; `fetch-deps.sh` fetches and hash-checks its
jars) and drives this kernel against it over real HTTP: routine allow, money held
and released by a person, review, large amounts, injected text in arguments, the
service killed, and its policy file broken and fixed. It is `#[ignore]`d so a plain
`cargo test` needs no JVM; the release gate runs it.
