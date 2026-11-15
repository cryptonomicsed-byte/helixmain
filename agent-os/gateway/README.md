# helix-gateway: the REST front of the kernel (Go)

Agents, apps and executors talk to this; this talks to the kernel
(`agent-os/kernel`, Rust) over gRPC. It does four things and nothing else:

1. **Authenticate** the caller from a bearer token.
2. **Decide whether that caller may use the endpoint**: roles, and who owns which agent.
3. **Translate** REST/JSON to the kernel's gRPC contract (`contracts/proto/helix/kernel/v1/kernel.proto`, the same file the kernel builds from) and back.
4. **Shed** abuse: size/shape limits, per-principal rate limit, in-flight cap.

Why Go: net/http and gRPC are first-class, concurrency is cheap, one static binary.

```
app / agent / executor ─ HTTPS+bearer ─▶ gateway ─ gRPC (mutual TLS) ─▶ kernel ─ HTTP ─▶ policy (Clojure)
```

## The rule that matters most

**The caller's identity reaches the kernel only as the `RequestContext` this
gateway builds from the authenticated token.** Nothing in a body or a header can set it:

- a `context` (or any unknown field) in a body is a **400**; an `organization_id` naming another tenant is a **403**, not silently rewritten;
- `X-Helix-*`, `X-Org-Id`, `X-User`, `X-Forwarded-User`, `X-Roles`, `X-Correlation-Id`, … are **removed** before any handler runs, and are not read anyway;
- the correlation id is the gateway's own (`req_…`, returned as `X-Request-Id`); a client-supplied one is ignored.

## Endpoints

All `/v1/*` need `Authorization: Bearer hxg_…`. Bodies are exactly one JSON document, `Content-Type: application/json`, ≤ 1 MiB, no unknown fields.

| | who | |
|---|---|---|
| `POST /v1/actions/authorize` | an **agent** (only for itself) or a **service** with `proposer` | propose an intent; answer is `allow` (+ `grant`), `deny`, `require_user_confirmation` or `require_human_review` (+ `pending_id`) |
| `GET /v1/actions/{pending_id}` | the agent's **owner**, a **reviewer**, a `proposer` service | what is held, why, until when |
| `POST /v1/actions/{pending_id}/confirm` `{"approve": bool}` | a **user**: the agent's **owner** for a user confirmation, a **reviewer** for a human review; either may decline | answer a held action |
| `POST /v1/executions/begin` `{grant, intent}` | a service with `executor` | the one permit per idempotency key |
| `POST /v1/executions/{id}/result` `{state: succeeded\|failed, result}` | `executor` | record the provider's verified outcome |
| `POST /v1/grants/{id}/revoke` `{reason}` | `grant_admin` | revoke |
| `POST /v1/identities/verify` `{certificate, runtime?, register?}` | anyone to verify; `register: true` needs a service with `registrar` | sid/0.2 verification and registration |
| `GET /v1/plugins` | anyone authenticated | the tenant's installed Wasm plugins and their tools |
| `POST /v1/plugins` `{manifest, component_base64}` | a service with `plugin_admin` | install or upgrade a signed plugin; the kernel verifies everything; a refusal is a 200 with `installed: false` and the reasons; bodies up to 12 MiB |
| `DELETE /v1/plugins/{id}` | `plugin_admin` | remove it and its storage |
| `POST /v1/plugins/{id}/tools/{tool}/invoke` `{input, agent_id?}` | an agent (as itself) or a `proposer` service (for the named agent) | run a tool: `result` and `proposed_intents` (proposals, not decisions: each still goes through `/v1/actions/authorize`) |
| `GET /v1/health` | anyone authenticated | kernel status, policy availability, audit head |
| `GET /healthz`, `GET /readyz` | no auth | process up / can authenticate and reach the kernel (no details) |

Errors are `{"error": {"code", "message"}}`: 400 invalid, 401 no/bad token (`WWW-Authenticate`), 403 not allowed, 404 not found (also used for "exists but is not yours"), 409 already answered, 413, 415, 429 (`Retry-After`), 503 (auth registry unavailable / kernel unavailable / overloaded), 504, 502. The kernel's own 4xx messages are passed through; anything about the gateway-to-kernel connection is generic and only logged.

A grant is returned **only** with `allow`. It is handed to the executor unchanged; every signed field round-trips (tested against the real kernel, including that a tampered grant is refused).

## Who may answer a held action

The kernel only knows that an answer comes from a *user*. Which user is decided here, from the registry:

- **user confirmation** ("the user this agent acts for must confirm"): only an **owner** of that agent. Another user in the same tenant, or a reviewer who is not an owner, gets 404/403 and the kernel is never asked.
- **human review**: only a user with the **reviewer** role. The owner alone cannot review.
- Declining is allowed to anyone who could have answered.
- To everyone else a held action is reported as *not found*.

## The principal registry

`HELIX_GATEWAY_PRINCIPALS` points at a JSON file the operator owns. Only SHA-256s of tokens are stored, so the file cannot be used to log in.

```json
{"tokens": [
   {"id": "tok_alice", "sha256": "…", "organization_id": "org_a", "principal": "user:alice", "kind": "user", "roles": [], "expires_at": "2027-01-01T00:00:00Z"},
   {"id": "tok_rita",  "sha256": "…", "organization_id": "org_a", "principal": "user:rita",  "kind": "user", "roles": ["reviewer"]},
   {"id": "tok_exec",  "sha256": "…", "organization_id": "org_a", "principal": "svc:merchant-adapter", "kind": "service", "roles": ["executor"]},
   {"id": "tok_agent", "sha256": "…", "organization_id": "org_a", "principal": "sid_front-desk", "kind": "agent", "roles": []}],
 "agents": [{"organization_id": "org_a", "sid": "sid_front-desk", "owners": ["user:alice"]}]}
```

Roles by kind: user `reviewer`, `grant_admin`; service `proposer`, `executor`, `registrar`, `grant_admin`, `plugin_admin`; agent none. One bad entry rejects the whole file.

```bash
helix-gateway mint-token --id tok_alice --org org_a --principal user:alice --kind user   # token to stderr once, entry to stdout
```

The file is re-read when it changes (checked once a second). **Revoking a token is deleting its entry.** If the file becomes invalid (or disappears) the gateway **authenticates nobody** (503 `auth_unavailable`, `/readyz` 503) until it is fixed: it does not keep honouring tokens an operator may have just tried to revoke.

## Running it

```bash
(cd ../kernel && cargo build --release && target/release/helix-kernel keygen /etc/helix/grant.key)
(cd ../policy && ./fetch-deps.sh && java -cp 'lib/*:src' clojure.main -m helix.policy.main) &
HELIX_KERNEL_SIGNING_KEY_FILE=/etc/helix/grant.key HELIX_KERNEL_TRUST_FILE=… HELIX_POLICY_URL=http://127.0.0.1:8181 ../kernel/target/release/helix-kernel serve &
HELIX_GATEWAY_PRINCIPALS=/etc/helix/principals.json go run ./cmd/helix-gateway serve
```

| env | default | |
|---|---|---|
| `HELIX_GATEWAY_PRINCIPALS` | (required) | the registry |
| `HELIX_GATEWAY_LISTEN` | `127.0.0.1:8080` | off loopback it **refuses to start without TLS** |
| `HELIX_GATEWAY_TLS_CERT` / `_KEY` | | serve HTTPS (TLS ≥ 1.2); or terminate TLS in front and stay on loopback |
| `HELIX_GATEWAY_KERNEL_ADDR` | `127.0.0.1:50051` | |
| `HELIX_GATEWAY_KERNEL_TLS_CA` / `_CERT` / `_KEY` | | mutual TLS to the kernel; **required** unless the kernel is on loopback |

Limits: 1 MiB bodies; 20 requests/s (burst 40) per principal; 256 requests in flight (excess is shed with 503, not queued); 10 s per kernel call; read-header 5 s, read 15 s, write 30 s. Logs are JSON on stdout: request id, route, org, principal, status, duration. Never tokens, bodies or arguments.

## Verified

`./test.sh` runs three gates:

1. **No drift**: `gen/` (Go stubs) is regenerated from the proto **without `protoc`** (`tools/protogen`: protocompile + the standard `protoc-gen-go` / `protoc-gen-go-grpc` plugins, pinned) and must match what is committed.
2. **Unit tests, race detector on**, against a fake kernel that records the `RequestContext` it receives: identity from token only (spoofed headers/body), the role matrix for every endpoint, who may answer a held action (13 cases), unauthenticated/expired/revoked tokens, broken registry fails closed, body hygiene (16 cases), gRPC→HTTP mapping with no leakage, a grant never forwarded with a non-allow verdict, rate limit, load shedding, panic → generic 500. Plus the Go canonical-JSON package against the shared golden vectors (the fourth implementation after Python, TypeScript and Rust).
3. **End to end, three real processes**: this gateway → the Rust kernel binary → the Clojure policy service. Routine work allowed and executed exactly once; money held and released only by the owner; review by a reviewer; declining; injected text and forged headers change nothing; a revoked and a tampered grant refused; the policy service killed ⇒ privileged actions denied. Plus **Go↔Rust mutual TLS**: a client from the trusted CA connects; a client certificate from another CA, a client that does not trust the kernel's CA, and plaintext are refused.

Breaking the ownership check on purpose fails both the unit and the end-to-end tests.

## The QR contact resolver (`helix-resolver`)

A second, **public** binary in this module, separate from the authenticated gateway: it serves signed QR contact
resolutions (`helix-qr/1`, spec in the `sid` repo `spec/helix-qr-1.md`). It holds **no signing key and is untrusted for
content**: it stores resolutions the issuer signed and serves them only after verifying them; clients verify again. A
compromised resolver can withhold or serve stale data (clients reject stale by `fresh_until`), not forge a contact.

| | |
|---|---|
| `GET /q/{payload}` | the reference must verify under the trust anchors, name *this* resolver, and have been requested at *this* host (421 otherwise); expired is 410; an unknown issuer, or a key outside its window, is 404; then the stored resolution is re-verified (answers this reference, signed by its issuer, current) before it is served byte-for-byte as signed. A stored document that does not verify is **never** served (503). A revoked/suspended/superseded contact is 410 with the signed document so the client can say why, `no-store`. |
| `PUT /v1/publish` `{reference, resolution}` | a bearer token **and** a valid issuer signature. Resolutions only move forward in time; revocation wins a tie; a revoked or superseded contact **never becomes active again**. |

Config: `HELIX_RESOLVER_ORIGIN`, `_TRUST_FILE` (sid/0.2 trust anchors), `_STORE_DIR`, `_PUBLISH_TOKEN_SHA256`, `_LISTEN`
(off loopback it refuses to start without TLS), `_TLS_CERT`/`_KEY`. Per-address rate limit (`X-Forwarded-For` is a claim, not a fact).

`internal/qr` is the Go implementation: it passes the shared conformance vectors for references (57 of 59) and resolution
envelopes (24 of 24), vendored with a pinned hash; it lists by name what it does not run (the `resolution` vectors need
sid/0.2 certificate verification, which a resolver deliberately does not do; one vector needs a BIP-340 issuer, which
this verifier reports as untrusted, never trusted). Mutation checks: no Host check, a revocable revocation, serving
unverified stored documents, and an unchecked publish token each fail the tests.

## Not done / limits

- **Static bearer tokens in a file.** No OIDC/JWT/SSO, no token scopes beyond roles, no per-token network binding. Fine for services and agents; a staff or customer login needs an identity provider in front.
- **No four-eyes rule**: a user who is both the owner and a reviewer can review their own agent's action.
- **No "list the hold queue" endpoint.** The kernel has no list RPC yet; a reviewer needs the `pending_id`. The operator app needs `ListPending` (additive to the proto).
- The rate limiter is in memory, per process.
- **Metrics are loopback only** (`HELIX_GATEWAY_METRICS_LISTEN`, `HELIX_RESOLVER_METRICS_LISTEN`; Prometheus text via `internal/metrics`, no client library). Counters are per process; there is no tracing. The alert rules in `../deploy/prometheus/helix-alerts.yml` are checked against the exported names by `deploy/check-alerts.py`.
- **The resolver has no issuer tooling yet** (an operator CLI that signs references and resolutions and calls `PUT /v1/publish`; the Python and TypeScript `make_reference` / `make_resolution` do the signing), **no camera scanner** (HLX3-05-07) and no LAN/offline contact advertisement.
- The HTTP side's own TLS is optional by design; production should terminate TLS at the ingress or set the cert and key.
