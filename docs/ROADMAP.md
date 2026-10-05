# HelixMain Roadmap

Updated: 2026-10-06

## Critical Path

The dependency order to first paying client: **1 → 2 → 3 → 5 → 6**, with 4 phased in by dependency.

| # | Workstream | Repo | Status |
| --- | --- | --- | --- |
| 1 | Anchor rollout | `helixmain/dna-foundry/compiler/` | 🟢 Done — 35/35 tests, all sections anchored (`c500d9f`) |
| 2 | SparkGatekeeper approval surface | `helixmain/spark-gatekeeper/` | 🟢 Static leg done — 51/51 VPS confirmed (`c2a170a`); Paperclip adapter queued |
| 3 | card-protocol 0.2 conformance | `card-protocol` | 🟢 Done — 20/20 VPS confirmed (`27d693d`) |
| 4 | OSS adoptions | `helixmain` (phased) | 🔴 Queued by dependency |
| 5 | Runtime exit proof | `helixmain` + `mesh-voice` + VPS | 🔴 Blocked on external gates |
| 6 | Registry and Sui | `helixmain` (TBD) | 🔴 Post-revenue |

**Not on this path:** Hostinger ticket (drafted, awaiting your send); GMGN key rotation (separate security thread); seven-fold work (separate boundary).

**Static leg** (compiler + gatekeeper + card-protocol) active now. **Runtime leg** blocked until VPS Docker confirmed and tunnel approval surface live.

## 1. Anchor rollout — `cryptonomicsed-byte/helixmain`

All work in `dna-foundry/compiler/` (`src/card-md.ts` + `src/card-md-parse.ts`).

**Done (pushed `c500d9f`):** All sections anchored — offering@1, policy@1, knowledge@1, voice_dont@1, hour@1, channel@1, identity_value@1. 35/35 tests. `verifyCardMd` surfaces `anchor_missing` before hash checks. `parse3StateSection` is generic. `parseIdentityAnchors` handles the key-value identity section. Tamper detection now targets anchor values (anchors override prose in anchored sections).

**Inferred → anchored promotion — two code paths (settled 2026-10-04):**
- Pure promotion (data unchanged): `anchor_confirmation` hold-queue proposal → `dna confirm` CLI → compiler writes anchor inline. Hash-stable, no version bump — anchor lives in HTML comments outside the card hash.
- Owner corrects during confirmation (data changed): existing `mutate.py` path, version bump, hash chain. Not an anchor write.
- Auto-promotion without confirmation is ruled out — it would silently launder hand-edits into trusted anchors.

**Remaining:**
- `dna confirm` CLI (AC-5 `test.todo`) — inferred→anchored promotion path. Pure promotion writes anchor inline, hash-stable, no version bump.

**Exit:** ✅ Every section anchored; hand-edited CARD.md with deleted anchors fails with `anchor_missing`.

## 2. SparkGatekeeper approval surface — `cryptonomicsed-byte/helixmain`

**Done (VPS confirmed `c2a170a`, 51/51 green, zero warnings):**
- 35 gate unit tests (7 gates + hold queue + sidecar). Canonicalization byte-identical to Python swarm.
- Hold queue (SQLite, WebAuthn passkey table).
- Rust HTTP API (8/8 axum oneshot tests): `GET /held`, `GET /held/:id`, `POST /held/:id/challenge`, `POST /held/:id/approve`, `POST /held/:id/deny`, `/setup/challenge`, `/setup/finish`. No-bypass invariant: WebAuthn verification in Rust before `approve()`.
- GovernanceReceipt (4/4 unit tests): Ed25519/JCS-canonical/hash-chained. `GATEKEEPER_SIGNING_KEY` env → persistent key. Offline-verifiable.
- End-to-end integration (4/4): draft deploy denied, null-price refused (vibration gate, correct layer), refund escalates → approve → receipt, verdicts from real Santino's v4 policy seed.
- `spark-approval/` browser UI: Vite+TS, `@simplewebauthn/browser`, gate trail per hold, approve/deny, setup passkey form, 10s auto-refresh. Proxy → `:9100`.

**Remaining (non-blocking):**
- **Paperclip adapter** — SparkGatekeeper becomes policy *content* inside Paperclip's governance engine (acting\_hash binding, draft-can't-ship, receipts), not a parallel queue. Adapter code in `helixmain`; Paperclip itself is external OSS (`paperclipai/paperclip`). Queued after first client.

**Exit:** ✅ One hold queue for publish, deploy, send, and card mutation; verifiable receipts; no approval bypass; 51 tests confirmed on VPS.

## 3. card-protocol 0.2 conformance debt — `cryptonomicsed-byte/card-protocol`

**Done (VPS confirmed `27d693d`, 20/20 green):**
- Both open errata resolved: acting-layer key set locked to 7 JSON keys (identity, voice, offerings, operations, policies, handoff, knowledge); field names canonized to implementation keys throughout spec.
- `business-card/0.2` spec (`spec/business-card-spec.md`) rewritten — tier annex, field name table, acting_hash definition, sound-via-voice.sonic clarification.
- Schema bumped to `business-card/0.2`; `acting_hash` description corrected; `previous_version` property added.
- `tierViews()` TS + Python with tier_hashes, envelope format, monotonicity guarantees (`public ⊆ authorized ⊆ owner`).
- 2 AJV schema validation tests added: conformance fixture validates, minimal valid card validates.
- Format string `business-card/0.1` → `0.2`; parser accepts both (migration path).
- Package `@card-protocol/core` bumped to 0.2.0.

**Remaining (non-blocking):**
- Public vs. private decision for the protocol repo (Justin call)

**Exit:** ✅ 0.2 conformance proven; errata closed; 20/20 VPS green.

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
