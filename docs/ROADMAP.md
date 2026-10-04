# HelixMain Roadmap

Updated: 2026-10-04

## Critical Path

The dependency order to first paying client: **1 → 2 → 3 → 5 → 6**, with 4 phased in by dependency.

| # | Workstream | Repo | Status |
| --- | --- | --- | --- |
| 1 | Anchor rollout | `helixmain/dna-foundry/compiler/` | 🟡 80% — voice\_dont + hours/channels/identity\_value remaining |
| 2 | SparkGatekeeper approval surface | `helixmain/spark-gatekeeper/` | 🔴 Not started |
| 3 | card-protocol 0.2 conformance | `card-protocol` | 🔴 Pushed but unproven |
| 4 | OSS adoptions | `helixmain` (phased) | 🔴 Queued by dependency |
| 5 | Runtime exit proof | `helixmain` + `mesh-voice` + VPS | 🔴 Blocked on external gates |
| 6 | Registry and Sui | `helixmain` (TBD) | 🔴 Post-revenue |

**Not on this path:** Hostinger ticket (drafted, awaiting your send); GMGN key rotation (separate security thread); seven-fold work (separate boundary).

**Static leg** (compiler + gatekeeper + card-protocol) active now. **Runtime leg** blocked until VPS Docker confirmed and tunnel approval surface live.

## 1. Anchor rollout — `cryptonomicsed-byte/helixmain`

All work in `dna-foundry/compiler/` (`src/card-md.ts` + `src/card-md-parse.ts`).

**Done (pushed `6af8587`):** offering@1, policy@1, knowledge@1 — 27/27 tests. `verifyCardMd` now surfaces `anchor_missing` before hash checks. `parse3StateSection` is generic — any future section is tag + prose-parser function, no copy-paste.

**Remaining:**

- `voice_dont` via `parse3StateSection` — trivial, same pattern as policy/knowledge
- Emitter anchor writes for `hours`, `channels`, `identity_value` — emitter must write before parser can enforce
- Parser 3-state for each of those (same `parse3StateSection`)
- Inferred → anchored promotion — **two code paths (settled 2026-10-04)**:
  - Pure promotion (data unchanged): `anchor_confirmation` hold-queue proposal → `dna confirm` CLI → compiler writes anchor inline. Hash-stable, no version bump — anchor lives in HTML comments outside the card hash.
  - Owner corrects during confirmation (data changed): existing `mutate.py` path, version bump, hash chain. Not an anchor write.
  - Auto-promotion without confirmation is ruled out — it would silently launder hand-edits into trusted anchors.
- Spec acceptance tests: `docs/specs/machine-anchor-rule.md` has 8 testable criteria that should exist as tests, not prose

**Exit:** every list section anchored; a hand-edited CARD.md with deleted anchors fails with `anchor_missing: <section>[N]`, never a hash mismatch.

## 2. SparkGatekeeper approval surface — `cryptonomicsed-byte/helixmain`

**Done:** 35/35 Rust gate tests. Canonicalization byte-identical to Python swarm. Hash-chained receipts. Hold queue.

**Remaining:**

- **TypeScript WebAuthn approval surface** — new area alongside `spark-gatekeeper/`. Publish, deploy, send, and card mutation sharing one human confirmation, no bypass. This is the piece Justin already locked in
- **Paperclip adapter** — Paperclip has real governance (tool-action-review, per-principal grants). SparkGatekeeper becomes policy *content* inside that engine (acting\_hash binding, draft-can't-ship, receipts), not a parallel queue. Adapter code in `helixmain`; Paperclip itself is external OSS (`paperclipai/paperclip`)
- **Receipt migration** to GovernanceReceipt format: Ed25519 over JCS canonical JSON, `parent_receipt_hash` chain — offline-verifiable. Work inside `helixmain/spark-gatekeeper/`

**Exit:** one hold queue for publish, deploy, send, and card mutation; verifiable receipts; no approval bypass.

## 3. card-protocol 0.2 conformance debt — `cryptonomicsed-byte/card-protocol`

0.2 is pushed but not honestly proven. The current fixture is missing required `hash`/`acting_hash` fields; parity runs against an invalid fixture. This is the unsexy one — it looks done until someone tests it against real data.

**Remaining:**

- Define the acyclic hash order (tier-view/full-hash cycle is still unresolved)
- Generate a schema-valid 0.2 fixture
- Re-run schema, TS, Python, parity, and hash checks against the valid fixture
- Audit `tierViews()` package version and export
- Public vs. private decision for the protocol repo

**Exit:** 0.2 conformance genuinely proven; public-vs-private decision made.

## 4. OSS adoptions — `cryptonomicsed-byte/helixmain` (phased)

In dependency order — each a small committable unit:

1. **`uv`** — foundry toolchain pin in `dna-foundry/swarm/`. Near-zero risk, foundational
2. **`python-json-patch`** — RFC 6902 diffs wired into `dna-foundry/swarm/mutate.py`. How the approval surface shows "what changed" in the hold queue
3. **`promptfoo`** — null-price refusal as a compile-time eval in the compiler's CI. Turns the honesty rule into a regression test
4. **`hugo`** — new card→site compiler target in `dna-foundry/compiler/`. First new artifact type from the card
5. **`kokoro`** — local TTS, replacing the cloud voice path in the sonic pipeline
6. **`conftest`** — CI policy checks

The two uncommitted repo-examination docs (`helixmain/docs/blueprint/`) land on your word.

## 5. Runtime exit proof — blocked on external gates

**Repos:** `helixmain` + `mesh-voice` + VPS (ZeroClaw + PocketBase + SparkGatekeeper sidecar)

**Gates still closed:** VPS Docker confirmed; tunnel approval surface live.

**Steps (in order, once gates open):**

1. Boot ZeroClaw + PocketBase + SparkGatekeeper sidecar; apply the real OpenShell policy from the Santino's card
2. Answer a Meshenger QR call from `mesh-voice` deployed on grokbot-box — fo tunnel needed for the deploy itself
3. Live null-price refusal and handoff demonstration
4. PicoClaw compiles from the same card — runtime stays a swappable driver
5. Idle RSS at 18-card scale

**Not on Hostinger** until the CPU steal issue is resolved — a measurement taken at 90% steal proves nothing.

## 6. Registry and Sui — post-revenue

**Location:** new area in `cryptonomicsed-byte/helixmain` (TBD — split repo on your call when we get there)

**Registry MVP:** machine-queryable agent registry — the "Yelp for agents" discovery layer over public card tiers. No code committed here yet.

**Sui/Walrus/Seal:** only where a ledger is actually needed — reputation, settlement. Chain-agnostic per Justin's call; Nostr by default. Sui for the cases that genuinely need it: immutable birth receipts, reputation scoring, settlement finality.

This workstream opens after the hold queue is live and at least one paying client is in.

## Decision Queue (Justin)

Batched as usual. None of these block workstreams 1–3, but some affect 5 and 6.

| Decision | Stakes | Blocks |
| --- | --- | --- |
| Pricing structure (per-card, per-call, or retainer) | Revenue model | First client conversation |
| Prospecting metro (local-first or remote-first) | Pipeline shape | Outreach |
| $10k target date | Sprint milestone | Planning |
| card-protocol public vs. private | OSS strategy | Workstream 3 exit |
| Lead-list source | Prospecting execution | Outreach |
| helixmain.com — claim it or operate under existing domain | Brand | First demo |
| Legal formation | Liability | Any paying client |
| Hostinger ticket — send or hold | Infrastructure | Not on critical path |
