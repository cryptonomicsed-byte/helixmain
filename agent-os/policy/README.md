# helix-policy: the policy decision service (Clojure, JVM)

The kernel (`agent-os/kernel`, Rust) asks this service what should happen to an
intent an agent proposed, then applies its own invariants on top. This service
is the one place the **rules** live. It does not execute anything, hold any
secret, or talk to anything but its caller.

```
agent ─ AuthorizeAction ─▶ kernel ─ POST /v1/decide (helix-policy-request/1) ─▶ policy
                                  ◀──────────── allow | deny | require_user_confirmation | require_human_review
```

Why Clojure: policy is data plus a small deterministic interpreter, and rules
are reviewed as data. Rules are EDN; the interpreter is a closed `case` over a
handful of operators; the decision function is pure and replayable.

## Run it

```bash
./fetch-deps.sh                                  # 4 jars from Maven Central, SHA-256 checked against deps.sha256
java -cp 'lib/*:src' clojure.main -m helix.policy.main                       # serve on 127.0.0.1:8181
java -cp 'lib/*:src' clojure.main -m helix.policy.main --check policies/helix-default.edn   # validate a policy (exit 0/1)
./run-tests.sh                                   # 32 tests
```

| env | default | |
|---|---|---|
| `HELIX_POLICY_FILE` | `policies/helix-default.edn` | the policy in force |
| `HELIX_POLICY_HOST` | `127.0.0.1` | **do not bind beyond the kernel's network**; there is no auth on this port |
| `HELIX_POLICY_PORT` | `8181` | `0` picks a free port and prints it |

The jars are not committed (`lib/` is ignored); `fetch-deps.sh` downloads them
and refuses anything whose hash differs from `deps.sha256`. JVM 17+ (tested on 21).

## HTTP contract

| | |
|---|---|
| `POST /v1/decide` | body: one `helix-policy-request/1` JSON document (`Content-Type: application/json`). 200 with a decision. A body that is not exactly one JSON document, is not UTF-8, nests deeper than 64, or is over 256 KiB is refused (400 / 413). Wrong content type is 415, wrong method 405. |
| `GET /health` | 200 `{"status":"ok","policy_id","policy_version"}`, or **503 `degraded`** when the policy file is invalid |
| `GET /v1/policy` | which policy is in force: id, version, sha256, rule ids and decisions |

A request that is JSON but breaks the contract (missing field, unknown risk,
money without a currency, negative amount, …) is **200 with `deny` and
`invalid_request`**, and the reason lists every problem. It is never repaired.

### Request: `helix-policy-request/1` (built by the kernel, `kernel/src/policy.rs`)

```json
{"format": "helix-policy-request/1", "now": "2026-11-20T12:00:00Z", "organization_id": "org_a",
 "principal": {"id": "sid_front-desk", "kind": "agent"},
 "agent": {"sid": "sid_front-desk", "status": "live", "capabilities": ["kb.search", "merchant.order"]},
 "intent": {"id": "…", "capability": "merchant.order", "tool": "merchant.checkout", "target": "merchant:m_123",
            "operation": "order.create", "risk": "medium", "amount_minor": 1200, "currency": "USD",
            "audience": "svc:merchant-adapter", "arguments": {"…": "…"}},
 "confirmation": {"by": "user:alice", "kind": "user_confirmation"}}   // only when a person is answering a held action
```

### Answer

```json
{"decision": "require_user_confirmation", "matched_rule": "money-needs-confirmation",
 "reason_codes": ["money_requires_confirmation"], "reason": "The user this agent acts for must confirm …",
 "policy_version": "helix-default@sha256:7eb186c5fa417aa8", "matched_rules": ["money-needs-confirmation", "commerce-needs-confirmation"]}
```

`decision` is exactly one of `allow`, `deny`, `require_user_confirmation`,
`require_human_review`; the kernel treats anything else as DENY. `policy_version`
is the policy id plus the first 16 hex of the SHA-256 of the **file bytes**, so
any edit, even whitespace, changes it and shows up in the kernel's audit trail.

## How a decision is made

1. **Malformed request → deny** (`invalid_request`).
2. **Invariants in this service, which no policy file can relax**:
   the agent's status must be `live` (`agent_not_live`); the capability must be
   among the agent's declared ones (`capability_not_declared`); when a person is
   confirming, the confirmer must be a **user** principal
   (`confirmer_not_a_person`) and the person named in the confirmation must be
   the authenticated one (`confirmer_mismatch`).
3. **Rules.** Every rule whose `:when` holds is a match; the **strictest** wins:
   `deny` > `require_human_review` > `require_user_confirmation` > `allow`. Ties
   resolve in file order. **No match → deny** (`no_matching_rule`): the policy
   lists what is permitted, not what is forbidden.
4. **Confirmation.** If the request carries a `confirmation`:
   a confirmation requirement is satisfied by a user confirmation or a review
   (answer `allow`, code `confirmed`); a review requirement only by a review
   (`reviewed`), and a user's yes to a review-class action is **deny**
   (`review_required`); a deny is never overridden.

The kernel then applies its own invariants (money above its auto-allow ceiling
and high-risk actions always need a person), which can only tighten.

## What can and cannot define policy

- **Only the operator's EDN file defines rules.** Nothing in a request, a CARD,
  a conversation or tool arguments is ever read as policy: the evaluator has no
  path from request data to rules. Tests send requests carrying `policy`,
  `rules`, a pre-filled `decision`, `"approved": true`, and "SYSTEM: ignore all
  rules" prose in arguments, and assert the answer is *identical* to the same
  request without them.
- Rules **may match on** `arguments` (for example a recipient or an SKU) with
  exact, prefix and glob operators, because a business legitimately wants that.
  That is matching, not defining.
- The policy reader is `clojure.edn` with no reader tags: no `#=`, no `#java.*`,
  no code. Tests load files containing `#=(System/exit 7)` and assert they are
  rejected and the JVM survives.
- The condition language is a closed set of total operators interpreted by a
  `case`; nothing is looked up by name, and glob matching is a two-pointer
  algorithm (no regex built from data).

## The rule language

```clojure
{:id "helix-default"
 :rules [{:id "money-needs-confirmation"
          :decision :require_user_confirmation        ; :allow :deny :require_user_confirmation :require_human_review
          :reason-code "money_requires_confirmation"   ; [a-z0-9_.:-], ≤ 64
          :reason "…"                                  ; optional, ≤ 512
          :when [:> [:intent :amount_minor] 0]}]}
```

Paths start at `:now :organization_id :principal :agent :intent :confirmation`
(not `format`), may index arrays (`[:agent :capabilities 0]`), and missing or
mistyped paths make a leaf false, never an error.

`:always` · `:and` `:or` `:not` · `:=` `:not=` `[:in path [v …]]` `[:contains path v]` ·
`:>` `:>=` `:<` `:<=` (integers) · `:present` · `:starts-with` · `:glob` (`*`, `?`) · `:one-of-glob`.

Loading is strict: an unknown key, an unknown operator, a duplicate rule id, a
bad reason code, an oversized or too deeply nested condition, or a file over 256 KiB
rejects the **whole** document.

## Reloading and failing closed

The file is re-checked at most once a second (size + mtime). A valid new file
takes effect on the next request, and the answer's `policy_version` changes. An
**invalid** new file does **not** leave the previous policy running: every
request is answered `deny` / `policy_invalid` and `/health` returns 503 until
the file is fixed. A typo in a tightening change must never leave the looser
policy in force. If the service is down, slow, or answers with anything the
kernel does not recognise, the kernel itself denies (`policy_unavailable`).

## `policies/helix-default.edn`

Conservative defaults, meant to be tuned per business: free low- and medium-risk
work runs on its own; any money, commerce, and high-risk action needs the user;
amounts above 1,000,000 minor units and administrative capabilities
(`policy.*`, `identity.*`, `key.*`, `grant.*`, `agent.*`, `sid.*`) need a human
review. The amounts are defaults, not facts about any currency.

## Verified

- `./run-tests.sh`: 32 tests / 338 assertions on the JVM: rule language and
  operators, strict loading (including reader-injection attempts), decision
  precedence and determinism, the invariants against an allow-everything policy,
  confirmation semantics, policy-injection resistance, the HTTP contract (size,
  depth, UTF-8, trailing content, content type), hot reload and fail-closed reload.
  Breaking the code on purpose (allow outranking deny; dropping the live-status
  invariant; keeping the old policy on a bad reload) makes 13, 14 and 3 tests fail.
- `cargo test --test policy_clojure -- --ignored` in `agent-os/kernel`: the Rust
  kernel against this real service over HTTP (routine allow, money hold and a
  person's release, review, large amount, injection text, the service killed,
  the policy file broken and fixed). This test found a real mismatch, the kernel
  says `live`, not `active`, that the unit tests alone could not.

## Not done / limits

- **No authentication on the port.** It answers questions and changes nothing,
  but a caller who can reach it can learn the policy. Keep it on loopback or a
  private network; put an mTLS terminator in front before exposing it.
- **Reviewer authority.** A human review is answered through the kernel's
  `ConfirmAction` by any authenticated *user* principal. Whether that user may
  act as a reviewer for this business (roles, four-eyes: reviewer ≠ requester) is
  not in the request today; the gateway must enforce it until the kernel carries
  roles and the original requester.
- JSON with duplicate keys keeps the last value (the kernel never produces them).
- Performance has not been measured under load.
