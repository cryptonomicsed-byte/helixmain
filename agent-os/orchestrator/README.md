# helix-orchestrator: durable workflows, leases and agent actors (Elixir / OTP)

The orchestration layer of Agent OS. Elixir because this is the part that has to
keep many long-running, failure-prone, mostly-waiting things alive: supervised
processes, message passing, "let it crash" with state rebuilt from a log. It has **no
dependencies** (OTP and the standard library only; Hex was not reachable when this was
written, and a strict JSON codec is 150 lines).

```
                      ┌─────────────── Helix.Orchestrator (supervision tree) ───────────────┐
workflow (data) ───▶  │  Helix.Run  ── event log (hash-chained, fsync) ── fenced lease      │
                      │     │ steps: invoke_plugin · authorize · execute · parallel · set    │
                      │     ▼                                                              │
                      │  Helix.Gateway ──HTTP+bearer──▶ Go gateway ─▶ Rust kernel ─▶ policy │
                      │  Helix.Executor (begin → provider → record, at most once)           │
                      │  Helix.Agent / Helix.A2A  (actors with profiles and mailboxes)      │
                      └─────────────────────────────────────────────────────────────────────┘
```

## What it guarantees

| | |
|---|---|
| **The log is the run.** | Every state change is appended and `fsync`ed before the process acts on it. A run that crashes (or whose node dies) is rebuilt by replaying its log: finished steps are not repeated, an interrupted step is retried, a run waiting for a person keeps waiting. The workflow definition is the log's first event, so recovery needs only the file. Tests kill a run mid-wait and restart a whole orchestrator, against fakes and against the real stack. |
| **Tamper-evident.** | Records are hash-chained. A torn tail (crash mid-write) is dropped; an altered, deleted or reordered record is reported as corruption with its position, never skipped. |
| **One driver at a time.** | A run holds a **fenced lease** (`Helix.Lease`). Log appends carry the fence; a driver that lost its lease without noticing cannot write after its successor, and stops when it finds the lease gone. |
| **Waiting for a person is a state.** | When the kernel holds an action for a person, the run records `awaiting` and polls (cheaply) for the answer. It survives restarts while it waits. Approval makes it collect the grant (the kernel hands it to the proposing service only) and go on; no/withdrawn/expired ends the run, or lets it continue with `"on_deny": "continue"`. |
| **Money moves at most once.** | Every effect goes through the kernel's `begin_execution` (one permit per idempotency key). The key comes from the run and the step, so a restarted run asks again for the *same* permit and gets the recorded result, never a second one. A provider that crashes, times out or is unsure is **not** recorded as failed (that would invite a double spend): the run stops with `execution_ambiguous` for reconciliation. |
| **Bounded retries.** | Transport errors, 429, 502, 503, 504: exponential backoff with jitter, each attempt logged, up to `max_attempts`. A refusal or validation error (4xx) is never retried. |
| **Strict workflows.** | Plain data (so an agent can author one as JSON), validated before anything runs: unknown kinds and fields, duplicate ids, references to later steps, `parallel` branches that see each other, effectful steps inside `parallel`, oversized or too-deeply nested definitions. A reference to something that does not exist fails the step; it never becomes `nil`. |
| **Agents are actors.** | `Helix.Agent`: a supervised process with a profile (sid, goals, preferences, memory namespace) and a bounded mailbox. `Helix.A2A`: validated envelopes, request/response with deadlines, dedup by message id (a retry returns the same answer without running the handler again), crash isolation (a bad handler costs the sender an error, not the agent). **A message carries data, never authority**: effects still go through the gateway and kernel. |
| **No secrets leak.** | A `Helix.Gateway` value is one principal's token; it prints as `token: ***`, is not in error terms, redirects are not followed, plain HTTP is accepted only for loopback. |

## Using it

```elixir
{:ok, _} =
  Helix.Orchestrator.start_link(
    name: :shop,
    dir: "/var/lib/helix/runs",
    gateway: Helix.Gateway.new("https://gateway.example", orchestrator_token),   # a service with the proposer role
    executors: %{"merchant" => %{gateway: Helix.Gateway.new(url, executor_token), provider: &MyShop.place_order/2}}
  )

workflow = %{
  "id" => "buy-coffee",
  "steps" => [
    %{"id" => "co", "kind" => "invoke_plugin", "plugin" => "acme.pricing", "tool" => "checkout", "agent" => "sid_barista",
      "input" => %{"currency" => "USD", "items" => %{"$ref" => "inputs.items"}}},
    %{"id" => "auth", "kind" => "authorize", "intent_from" => "co.proposed_intents.0",
      "intent_with" => %{"audience" => "svc:merchant-adapter", "task_id" => "task-1"}},
    %{"id" => "buy", "kind" => "execute", "from" => "auth", "executor" => "merchant"}
  ]
}

{:ok, _pid} = Helix.Orchestrator.start_run(:shop, "coffee-001", workflow, %{"items" => items})
Helix.Orchestrator.status(:shop, "coffee-001")   # => %{status: "awaiting", awaiting: %{pending_id: ..., kind: "require_user_confirmation"}, ...}
```

`start_link` also recovers every unfinished run in `dir` (several orchestrators may share it; a run another one holds is left alone).

Step kinds: `invoke_plugin` (a plugin tool; pure, may *propose* intents), `authorize` (the kernel decides; `intent` or `intent_from`+`intent_with`, `on_deny`, `timeout_ms`), `execute` (hand the grant and intent to a named executor), `parallel` (2 to 8 branches of `invoke_plugin`/`set` steps, run concurrently), `set`. The intent's `id` and `idempotency_key` are derived from the run and the step (they override a plugin's suggestion; an intent written out in full keeps its own).

## Verified

`./test.sh` (format check, warnings as errors, then the tests):

- **82 unit tests** (async): JSON codec (strict parsing, depth/size, surrogates, deterministic output), event log (ordering, torn tail, corruption, deleted record, fencing), leases (races between 20 processes, expiry, fence increments, stale lock, unreadable file), gateway client (token hygiene, every error class and whether it retries, timeouts, bad JSON, redirects, URL rules), workflow validation and references, **29 durable-run tests** against a scriptable fake gateway (happy path, parking and approval, declines, timeouts, crash-and-recover, whole-node restart, lease contention and a zombie driver, retries and their bounds, parallel overlap, every executor outcome including the ambiguous ones), 14 A2A tests, and the metrics counters (every appended log event counted by type, so the counters reconcile with the logs).
- **7 end-to-end tests against the real stack**: this orchestrator driving the Go gateway, the Rust kernel with its Wasm plugin host, and the Clojure policy service, each a separate OS process (`mix test --include e2e`): a priced purchase held for the owner and released by them (another user cannot even see it), a crash while waiting that does not ask the person twice, a decline, a tool the agent never declared (403, no retry), a capability it never declared (denied), routine work that needs no person, and the policy service killed (denied, not allowed).
- Breaking the code on purpose (recording an unsure provider as failed, ignoring fencing in the log, not replaying `awaiting`) fails tests in each case. The end-to-end test found a real bug: a plugin host that derived idempotency keys from content and time made two identical baskets bought in the same second share a key, so the second purchase was refused as a replay. Keys now come from the run and the step.

## Metrics

`Helix.Orchestrator.metrics/1` returns Prometheus text (`helix_orchestrator_events_total{type=...}`, runs active, agents alive). The orchestrator is a library, so the embedding service decides where to expose it; keep it on loopback like the gateway's.

## Not done / limits

- **Leases are single-host** (an exclusive lock file + atomic rename). Across machines you need a real lock service (etcd, a database row); `Helix.Lease` is the contract.
- **The log holds grants and intents in plaintext.** Grants are short-lived (5 minutes by default), single-use, and bound to one executor and one exact intent, but protect the log directory like any credential store. No encryption at rest, no retention or compaction.
- **Approvals are polled** (the kernel has no push). Latency is `poll_ms`.
- **A2A is in-VM.** Mailboxes and dedup memory live in the actor and do not survive its restart; no distributed-Erlang transport or signed envelopes yet (cross-process agents go through the gateway).
- **No timers/cron steps, conditionals, compensation (saga) steps, or workflow versioning.** `parallel` is limited to pure steps on purpose: anything with an effect or a wait must be sequential and durable.
- No HTTP/gRPC API of its own and no UI: it is a library for the services and the operator app to embed.
- `authorize` is at-least-once (a crash between sending and logging can create a second pending request for the person); effects remain at-most-once.
- Elixir 1.14 / OTP 25 (from the distro). No Hex dependencies.
