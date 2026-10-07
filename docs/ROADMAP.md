# HelixMain Roadmap

Updated: 2026-10-06

## Critical Path

The dependency order to first paying client: **1 → 2 → 3 → 5 → 6**, with 4 phased in by dependency.

| # | Workstream | Repo | Status |
| --- | --- | --- | --- |
| 1 | Anchor rollout | `helixmain/dna-foundry/compiler/` | 🟢 Done — 43/43 tests, all sections anchored + `dna confirm` CLI (`a7cc29e`) |
| 2 | SparkGatekeeper approval surface | `helixmain/spark-gatekeeper/` | 🟢 Done — UI live at omokoda.duckdns.org/spark/ (`1a65062`); passkey enroll on first browser visit |
| 3 | card-protocol 0.2 conformance | `card-protocol` | 🟢 Done — 20/20 VPS confirmed (`dac16c3`) |
| 4 | OSS adoptions | `helixmain` (phased) | 🟢 Done — 6/6 items shipped |
| 5 | Runtime exit proof | `helixmain` + `mesh-voice` + VPS | 🟡 In progress — PASS=22 FAIL=0 GAP=3. Chain live (receipt 88c8ef96). Remaining: mesh-voice deploy to grokbot-box. |
| 6 | Registry and Sui | `helixmain` (TBD) | 🔴 Post-revenue |

**Not on this path:** Hostinger ticket (drafted, awaiting your send); GMGN key rotation (separate security thread); seven-fold work (separate boundary).

**Approval surface live** at `https://omokoda.duckdns.org/spark/` — enroll passkey once on first browser visit. **Runtime leg** (WS5) blocked until VPS Docker confirmed.

## 1. Anchor rollout — `cryptonomicsed-byte/helixmain`

All work in `dna-foundry/compiler/` (`src/card-md.ts` + `src/card-md-parse.ts`).

**Done (pushed `c500d9f`):** All sections anchored — offering@1, policy@1, knowledge@1, voice_dont@1, hour@1, channel@1, identity_value@1. 35/35 tests. `verifyCardMd` surfaces `anchor_missing` before hash checks. `parse3StateSection` is generic. `parseIdentityAnchors` handles the key-value identity section. Tamper detection now targets anchor values (anchors override prose in anchored sections).

**Inferred → anchored promotion — two code paths (settled 2026-10-04):**
- Pure promotion (data unchanged): `anchor_confirmation` hold-queue proposal → `dna confirm` CLI → compiler writes anchor inline. Hash-stable, no version bump — anchor lives in HTML comments outside the card hash.
- Owner corrects during confirmation (data changed): existing `mutate.py` path, version bump, hash chain. Not an anchor write.
- Auto-promotion without confirmation is ruled out — it would silently launder hand-edits into trusted anchors.

**Done (`a7cc29e`):** `dna confirm` CLI — `compile --confirm-anchors --md CARD.md`. Promotes all inferred fields to anchored state by re-emitting with machine anchor comments. Refuses on `anchor_missing`. No version bump — data unchanged. Idempotent: already-anchored card is a no-op.

**Exit:** ✅ Every section anchored; hand-edited CARD.md with deleted anchors fails with `anchor_missing`; 43/43 tests.

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

**Done (VPS confirmed `dac16c3`, 20/20 green):**
- Both open errata resolved via `tier-annex-0.2.md §15`: acting-layer key set locked to 7 JSON keys; field names canonized to implementation keys throughout spec.
- `business-card/0.2` spec rewritten — tier annex, field name table, acting_hash definition (7 keys, sound included via voice.sonic), hash prefix convention.
- Schema bumped to `business-card/0.2`; `acting_hash` description corrected; `previous_version` property added.
- `tierViews()` TS + Python: derives `public ⊆ authorized ⊆ owner` views on demand, returns tier_hashes alongside. **Hash cycle broken by construction** — `tier_hashes` was removed from the card schema, so the card hash cannot include it. Dependency is one-way: views include `card.hash`; nothing flows back. No cycle to manage.
- `minimal-card.json` conformance fixture carries real `hash` + `acting_hash`; `tiered-card.json` (tier-test fixture) also fixed with correct hashes — both now schema-valid.
- 20 tests: 10 round-trip/hash + 2 AJV schema validation + 8 tier (monotonicity, public/authorized/owner splits, null-price, no private-key leakage, tier-hash self-consistency).
- Format string `0.1` → `0.2`; parser accepts both. Package `@card-protocol/core` → 0.2.0.

**Remaining (non-blocking):**
- Public vs. private decision for the protocol repo (Justin call)

**Exit:** ✅ 0.2 conformance proven; errata closed; 20/20 VPS green.

## 4. OSS adoptions — `cryptonomicsed-byte/helixmain` (phased)

In dependency order — each a small committable unit:

1. **`uv`** ✅ — foundry toolchain pin in `dna-foundry/swarm/pyproject.toml` + `uv.lock`
2. **`python-json-patch`** ✅ — RFC 6902 diffs wired into `mutate.py`; diff stored on proposal for hold-queue approval surface
3. **`promptfoo`** ✅ — null-price refusal as a compile-time eval; 4/4 green, manually verified
4. **`hugo`** ✅ — new card→site compiler target emitting `config.toml` + 3 content pages; Appendix never leaks
5. **`kokoro`** ✅ — local ONNX TTS; provider chain: kokoro → CLI → TTSUnavailable; optional `[tts]` extra (no Android wheel)
6. **`conftest`** ✅ — `tests/test_policy.py`: ACTING_KEYS parity, 6-module importability, TTS fallback chain; 8/8 pass

The two uncommitted repo-examination docs (`helixmain/docs/blueprint/`) land on your word.

## 5. Runtime exit proof — blocked on external gates

**Repos:** `helixmain` + `mesh-voice` + VPS (ZeroClaw + PocketBase + SparkGatekeeper sidecar)

**Preflight:** `ws5-boot.sh` on VPS — 16 PASS, 9 GAP as of 2026-10-06. Script only prints
QR demo steps when FAIL=0 and GAP=0; otherwise prints exactly what's blocking.

**3 code jobs — all complete:**
1. `POST /invoke` + sidecar dispatch — 50/50 green (`3a2a88b`) ✅
2. `compile_openshell_policy` + `openshell-policy.yaml` emitted — 48/48 green (`35ab67b`, `d21f20f`) ✅
3. `spark-gate-mcp` MCP shim + ZeroClaw `[mcp]` binding + santinos agent config — 61/61 green (`ebf23df`, `8aaf919`) ✅

**Remaining before demo:**
- Deploy mesh-voice to grokbot-box (now online at 100.109.5.90)
- Run refund action to prove `/spark/` hold card UI (approval_required → escalate → hold)
- Optional: tool bus on :9200 (Allow-path only, not needed for deny/escalate demo); gVisor (preflight only)

**Demo sequence (once all gaps close):**
1. `ws5-boot.sh` prints READY — ZeroClaw + PocketBase + SparkGatekeeper all green
2. Meshenger QR call from mesh-voice on grokbot-box
3. Live null-price refusal routed through hold queue; approve in browser at /spark/
4. PicoClaw compiles from same card — runtime stays a swappable driver
5. Idle RSS at 18-card scale

**Not on Hostinger** for step 5 RSS measurement until CPU steal is resolved — a reading at 90% steal proves nothing.

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
