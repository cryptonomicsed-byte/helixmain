# HelixMain — Blueprint to Finish the Company

**Status:** CANONICAL BUILD DOCUMENT · 2026-10-04
**For:** Claude Code (executing builder) · Justin (decisions)
**Supersedes:** the v2/v3 complete blueprints and the extraction blueprint for
build sequencing. Those remain valid as design references; this document is the
phased execution plan.

---

## 0. How to use this document

Each phase has: **goal**, **why now**, **inputs** (what must already exist),
**build order** (numbered, in dependency order), **exit criteria** (the phase is
done only when every criterion is demonstrated, not described), and **blocked
on** (what stops it).

Rules for the builder, non-negotiable:

1. **Nothing pasted is canonical.** Research, tables, and claims in chat are
   inspiration. Verify every load-bearing claim against the actual source
   (the repos, the OSS projects named) before adopting it. When you verify
   something, say what you checked.
2. **Standard of proof.** A test that asserts the shape you emitted is
   circular. Validate against the upstream source (like the OpenShell
   `deny_unknown_fields` check: the compiled policy was validated against a
   transcription of `crates/openshell-policy-schema/src/lib.rs`, not against
   the repo's own test). Exit proofs must cite the external source.
3. **Naming.** Universal words ONLY: SPARK, MIND, FOUNDATION, EMOTION, MATRIX,
   FIRE, ASCENSION. Never mythic names — not in code, docs, UI, or
   conversation. Gate modules use the principle names: mentalism,
   correspondence, cause_effect, vibration, gender, polarity, rhythm.
4. **Null stays null.** Never invent data to fill a gap. A null price is
   refused and handed off, never defaulted. Inferred fields are marked
   inferred and never overwrite owner-confirmed.
5. **The card is the product.** Every surface compiles from the card. The card
   travels; docs rot. Markings that matter live in the card, not beside it.
6. **Chain-agnostic.** No blockchain is required for a valid card or a working
   deployment. Sui/Walrus/Seal are opt-in Phase 4, never prerequisites.
7. **Publish/deploy/send are real or absent.** Never simulated. The hold queue
   is the one approval surface for card mutations, deploys, publishes, and
   sends alike.
8. **No commit/push without Justin's explicit word** — "commit" and "commit
   and push" are distinct authorizations. (You operate in Justin's session;
   his word there is the authority. Keep the distinction anyway.)

---

## 1. Where things stand (verified 2026-10-04)

### Done and pushed

| Piece | State | Evidence |
|---|---|---|
| CARD standard (`card-protocol` repo, private) | business-card/0.2 landed | `46b3298` spec annex, `1353d5f` schema, `136bb06` implementation. Exit proof in the commit message: `check_tier_parity.py` PASS — tier views byte-identical across TS and Python, tier hashes consistent. Remote main `136bb06`. |
| Card compiler (`helixmain/dna-foundry/compiler`) | Proven end-to-end | Santino's v4 → CARD.md, system prompt, policy seed, tool allowlist, RAG manifest, fields-used, OpenShell policy. The OpenShell policy was validated against the REAL schema transcribed from NVIDIA/OpenShell `crates/openshell-policy-schema/src/lib.rs` (deny_unknown_fields, u16 ports, snake_case landlock enum): PASS. |
| Demo fixtures | Migrated | All Nunzio's/Harbor & Bean fixtures → Santino's Pizza (verified public data). Suite 20/20 green. Committed `f76bcb6`, pushed. |
| Santino's demo card | v4, demonstration-marked in-card | `f8447c2`, pushed. Marking lives in the card's insights + changelog (proposal → gate → receipt → hash chain), status draft. |

### The five moat builds (what HelixMain owns; everything else is OSS)

1. **CARD standard** — DONE (0.2 pushed).
2. **Card compiler** — DONE (spike proven; needs hardening, not re-proof).
3. **SparkGatekeeper / hold queue** — BLANK. Only the contract
   (`agent-os/contracts/seven-powers.md`) and the Python `mutate.py` gate
   prototype exist. **This is Phase 2 of this blueprint, the unblocked path.**
4. **Agent registry** ("Yelp for agents", machine-queryable) — not started.
5. **Sui settlement/reputation** — not started, opt-in.

### Blocked (external gates, nothing to do until they open)

- **grokbot-box tunnel approval** — the first-tunnel-request approval never
  surfaces. Blocks the QR/voice deployment leg. Needs Justin watching for the
  prompt, or a different route.
- **VPS docker check** — `which docker && docker info` as the `agents` user
  on 2.25.70.156. This VM cannot SSH out (egress blocked since September).
  Needs Justin directly or Hermes. Blocks the OpenShell spike and the
  ZeroClaw/PocketBase boot.

### Awaiting Justin's decisions (not the builder's)

- Pricing structure: setup-plus-retainer vs pure monthly.
- Prospecting metro for the lead agent.
- Target date for $10k/month profit.
- `card-protocol` public vs private (recommendation: public eventually —
  standards win by adoption).
- helixmain.com purchase; legal formation (route to a professional).

---

## 2. Phase 1 — SparkGatekeeper: the 7 hermetic gates in Rust

**Goal:** the trust moat, as a hermetic Rust core. Every `birth` / `think` /
`act` flows through it; any gate rejects → the operation halts.

**Why now:** it is the only moat build with no external dependencies. The
compiler output it consumes exists and validates. The policy-seed format it
enforces is in the compiled output. No VPS, no tunnel, no sandbox needed —
it is pure logic plus a sidecar proxy, testable on any machine.

**Why Rust:** the contract binds SPARK to Rust, and the gatekeeper IS the
centralized enforcement point. Hermetic = no network, no ambient authority:
the gates are pure functions of (card, action, policy seed, session).
Deterministic, auditable, testable.

**Inputs:** `agent-os/contracts/seven-powers.md` (the binding contract),
`dna-foundry/swarm/mutate.py` (the Python gate prototype — port its
propose→gate→apply semantics, do not copy its code verbatim),
`/tmp`-spike policy-seed format (rules with topic/rule/risk/verdict +
defaults), `compileOpenshellPolicy` output shape.

### 2.1 What it is and is not

- It IS: the choke point. Card canonicalization, hash-chain verification,
  permission checks, the 7 principle-gates, the hold queue, receipt minting,
  and the sidecar proxy that makes bypass impossible.
- It is NOT: the MIND deliberation engine (Clojure comes later; escalated
  hard cases are logged with full context for future MIND), the Sui
  anchoring (receipts are hash-chained locally; on-chain is Phase 5), the
  registry (Phase 4), or a parallel queue beside Paperclip (it becomes
  policy *content* inside Paperclip's engine — expose a clean API for that).

### 2.2 Crate layout

New top-level dir in `helixmain` (it is build #3 of the company, it lives
with the company):

```
spark-gatekeeper/
  Cargo.toml
  src/
    lib.rs            # Gate trait, Verdict, GateContext, SparkGatekeeper runner
    types.rs          # Card, Operation, Action, PolicySeed, Receipt, Session
    gates/
      mentalism.rs    # SPARK: canonicalization, hash chain, acting_hash, session
      correspondence.rs # MIND principle: action↔card correspondence
      cause_effect.rs # FOUNDATION: no-bypass, causal attribution
      vibration.rs    # EMOTION: voice/values resonance, memory consistency
      gender.rs       # MATRIX: birth/think/act lifecycle
      polarity.rs     # FIRE: risk verdicts from the policy seed, draft-can't-ship
      rhythm.rs       # ASCENSION: rate limits, cooldowns, receipt chaining
    hold_queue.rs     # escalated operations: durable store, approval, release
    sidecar.rs        # HTTP proxy: the only path from agent to tool bus
  tests/
    gates.rs          # per-gate unit tests
    integration.rs    # deny halts; escalate→approve→receipt; no bypass
```

### 2.3 The gate contract (binding)

```rust
pub enum Verdict { Allow, Deny { reason: String }, Escalate { reason: String } }

pub trait Gate {
    fn principle(&self) -> &'static str;   // "mentalism", "correspondence", ...
    fn check(&self, ctx: &GateContext) -> Verdict;
}

pub struct SparkGatekeeper { gates: [Box<dyn Gate>; 7] }

impl SparkGatekeeper {
    /// Runs all 7 gates in code order (Spark→Ascension). Any Deny halts.
    /// Any Escalate (and no Deny) routes to the hold queue. Else Allow.
    /// Every run mints a receipt with the full per-gate trail.
    pub fn check(&self, ctx: &GateContext) -> GateResult;
}
```

**Aggregation rule (binding):** run ALL seven gates even after a deny, so the
receipt carries the complete trail. Deny anywhere → operation HALTED, no
human override. Escalate anywhere (no deny) → hold queue. All allow →
forward to the tool bus.

### 2.4 Gate semantics (each gate is a pure function)

1. **mentalism** (SPARK — the choke point). Recompute the card hash over
   canonical JSON; compare to `card.hash`. Verify the hash chain
   (`previous_hash` links). Recompute `acting_hash` from the seven acting
   keys (identity, voice, offerings, operations, policies, handoff,
   knowledge); the action must carry the current acting_hash — stale clients
   are rejected. Validate the session (bound to a birth receipt, not
   expired). *Every call in or out passes through here first.*

2. **correspondence** (MIND principle — the mechanical check, not the
   deliberator). The action must correspond to the card: it references real
   card sections (no phantom fields); deploy/publish actions reference a
   compiled artifact whose card_id + version + acting_hash match the current
   card; tool calls are in the card's tool allowlist; card mutations arrive
   via the propose→gate→apply protocol, never as direct edits.

3. **cause_effect** (FOUNDATION). No bypass: the action's effects flow
   through the approved tool bus (the sidecar) — direct tool access is
   denied. Every action has an attributable cause: a session, a prior
   receipt, or a human approval. Causality is the audit trail.

4. **vibration** (EMOTION). Resonance, as deterministic checks: generated
   content stays within the card's voice bounds (tone keywords from
   `card.voice`); no assertion the card marks null (null stays null — a
   price the card doesn't know is refused, not invented); no contradiction
   of owner-confirmed fields by inferred ones.

5. **gender** (MATRIX). Lifecycle: `birth` requires a verified card (one
   birth per card version per sandbox); `think` requires a live birth
   (session bound to a birth receipt); `act` requires the think context or
   explicit human approval. Transitions only move forward — halted operations
   are never resurrected.

6. **polarity** (FIRE). Risk and authority, driven by the policy seed: each
   rule carries risk (low/medium/high) and a verdict
   (allow/approval_required/escalate); the seed's defaults map
   low→allow, medium→approval_required, high→escalate. **Draft cards cannot
   deploy/publish/send — deny, no override.** Unknown actions escalate (fail
   closed; the gate never invents a verdict).

7. **rhythm** (ASCENSION). Timing and flow: per-operation rate limits per
   session (configurable); cooldown after a deny (no retry storms); every
   verdict appends to the hash-chained receipt log (continuity of the flow).

### 2.5 The hold queue

- **Store:** SQLite (per deployment). Each entry: the pending operation, the
  full per-gate trail, the proposed action, card id + version, acting_hash,
  proposed-at, expires-at.
- **Approval surface:** TypeScript. The Human presents; it never controls.
  WebAuthn ceremony, approve/deny, no bypass, no API shortcut around it.
- **On approve:** mint a receipt (hash-chained to the previous receipt),
  release the operation to the tool bus.
- **On deny or timeout:** halt, mint a denial receipt.
- **One queue for everything:** card mutations, deploys, publishes, sends —
  the same human confirmation surface Justin specified.

### 2.6 Enforcement by construction (the Hermes-audit answer)

The top structural risk was: what stops the agent bypassing the gatekeeper?
Answer, built not promised:

- The sandbox's egress allowlist (from `compileOpenshellPolicy`) grants the
  agent binary **only** the sidecar URL. There is no network path around it.
- The sidecar is a dumb pipe with one rule: every request goes through
  `SparkGatekeeper::check` before forwarding to the MCP servers.
- Demonstrate it in `tests/integration.rs`: an agent process with only the
  sidecar route cannot reach an MCP server directly (connection refused at
  the sandbox layer in the test harness).

### 2.7 Build order

1. Crate scaffold + `types.rs` (Card, Operation, Action, PolicySeed,
   Receipt, Session, Verdict, GateContext). Card types must accept the real
   compiler output — test against Santino's v4 policy-seed.json and the
   compiled card.
2. `gates/mentalism.rs` — canonicalization + hash chain + acting_hash +
   session. Unit tests with Santino's v4 (real hashes).
3. `gates/polarity.rs` — policy-seed verdicts + draft-can't-ship. Unit tests
   with the real policy seed (3 rules: refunds/high, allergens/low,
   large_orders/low).
4. `gates/correspondence.rs`, `cause_effect.rs`, `vibration.rs`,
   `gender.rs`, `rhythm.rs` — one at a time, each with unit tests.
5. `lib.rs` runner — aggregation rule, full-trail receipts.
6. `hold_queue.rs` — SQLite store, expiry, approve/deny, receipt minting.
7. Approval surface (TypeScript) — WebAuthn, no bypass.
8. `sidecar.rs` — HTTP proxy enforcing `check` on every request.
9. `tests/integration.rs` — the three demonstrations (deny halts,
   escalate→approve→release, no bypass).
10. Paperclip adapter surface — a clean API (HTTP or FFI) so the gatekeeper
    becomes policy *content* inside Paperclip's tool-action-review, not a
    parallel queue.

### 2.8 Exit criteria (ALL must be demonstrated)

- [ ] `cargo test` green: per-gate unit tests + integration tests.
- [ ] Santino's v4 (draft) attempts deploy → polarity denies
      (draft-can't-ship); denial receipt minted with the full 7-gate trail.
- [ ] A medium-risk action (e.g. refunds) → hold queue → WebAuthn approval
      → receipt minted → released to the tool bus.
- [ ] No-bypass demonstration: agent with only-sidecar egress cannot reach
      MCP servers directly.
- [ ] Verdicts are driven by the real compiler output (policy-seed.json,
      tool-allowlist.json, acting_hash) — nothing hardcoded.
- [ ] A null price in the card, when an action needs it → refused/escalated,
      never defaulted.

---

## 3. Phase 2 — Runtime leg (BLOCKED; exact unblock conditions)

**Goal:** the Phase 2 exit proof Justin set: Santino's draft card compiles to
a sandbox spec, boots ZeroClaw + PocketBase + hold-queue sidecar, a QR call is
answered by the card agent from the card, a null price is refused live, and
PicoClaw compiles from the same card (runtime stays a swappable driver).

**Static leg: DONE AND PROVEN** (compiler spike, §1). What remains is all
runtime, and all of it is behind two external gates:

1. **Tunnel approval surfaces** (grokbot-box first-tunnel-request) → unblocks
   the QR/voice deployment (mesh-voice install, Meshenger call path).
2. **`which docker && docker info` as the `agents` user on 2.25.70.156**
   (via Justin directly or Hermes) → unblocks the OpenShell spike and the
   ZeroClaw/PocketBase boot.

**Build order (when unblocked):**

1. Confirm Docker on the VPS; run the OpenShell spike procedure
   (`goals/build-helixmain-a-dna-profile-ai-services-company/hidden_files/openshell-spike/`).
   Measure ZeroClaw idle RSS at 18-card scale (still unmeasured — needed for
   the per-card economics).
2. Boot per-card sandbox for Santino's v4: ZeroClaw + PocketBase +
   SparkGatekeeper sidecar (Phase 1 output), policy from
   `compileOpenshellPolicy` applied to the real OpenShell supervisor.
3. Mint the Meshenger QR from the card's `networks.voice` entry; scan; call;
   the card agent answers from the card.
4. Live null-price refusal: ask for a price the card marks null → the agent
   refuses and hands off (vibration gate logic, live).
5. PicoClaw: compile the same card to a PicoClaw config; boot; same QR-call
   smoke test. Proves the runtime is a swappable driver.

**Exit criteria:**

- [ ] QR call answered by the card agent, grounded in Santino's v4.
- [ ] Null price refused live, with handoff.
- [ ] PicoClaw boots from the same card.
- [ ] 18-card idle-RSS measured and within per-card economics.

**Do NOT:** run the spike on the Hostinger VPS 2.25.70.156's current
oversubscribed state for performance claims (90.7% steal measured 2026-10-03
— measurements there are meaningless until the Hostinger ticket resolves).
Do not use the Contabo box at all (Justin has no access; not his asset).

---

## 4. Phase 3 — Agent registry MVP (build #4)

**Goal:** "Yelp for agents" — a machine-queryable registry where agents are
discovered by their public card tiers.

**Why this order:** the registry reads public tiers; the tiered card (0.2)
and the compiler both exist. It needs no sandbox and no chain.

**Build order:**

1. Registry data model: card id → public tier view + `tier_hashes.public` +
   endpoint (Meshenger voice address / HTTPS agent endpoint) + reputation
   stub. Only public-tier data, ever.
2. Ingest: a card publishes its public tier (signed by the card's identity
   key; the QR's public key IS the proof — reuse it).
3. Query API: by capability (offerings), by locality (delivery_fence),
   by voice availability. Machine-first (JSON), human-readable second.
4. Verification: the registry re-derives the public tier hash from the
   published view and checks it against `tier_hashes.public` — the
   self-verifying property from the 0.2 annex, enforced at ingest.

**Exit criteria:**

- [ ] Santino's public tier published; hash re-derived and verified at
      ingest.
- [ ] A machine client discovers the agent by capability + locality and
      opens a voice call via the registered address.
- [ ] No authorized/owner-tier field is retrievable through the registry
      (negative test).

---

## 5. Phase 4 — Sui settlement and reputation (build #5; OPT-IN)

**Goal:** the FIRE power made real — settlement, receipt anchoring, on-chain
reputation. Walrus = content-addressed card blobs, Seal = tiered access,
on-chain reputation.

**Why last and optional:** chain-agnosticism is a standing rule. Everything
before this works with no chain. Sui is where a ledger is needed (Phase 5
of the original sequencing), not a prerequisite.

**Build order:**

1. Receipt anchoring: SparkGatekeeper receipt-chain heads anchored on Sui
   (hash only — receipts stay off-chain).
2. Reputation: per-card on-chain reputation from anchored receipts
   (completed holds, denials, disputes).
3. Walrus: public-tier card blobs content-addressed.
4. Seal: authorized/owner tier decryption policies.

**Exit criteria:**

- [ ] A receipt chain head is anchored and independently verifiable.
- [ ] A card with no Sui footprint still fully works (chain-agnostic
      negative test).

---

## 6. Phase 5 — Business legs (Justin's decisions; builder prepares)

The builder does not decide these; it prepares the ground so each decision
is one sentence.

1. **Pricing structure** — setup-plus-retainer vs pure monthly. Draft exists
   (DNA Starter $750+$149, AI Front Desk $1,250+$549, Growth Partner
   $2,000+$1,100, 93–97% margins, ~$10.1k/mo at 18 clients). Builder: model
   both structures against the measured per-card cost (needs the 18-card
   RSS number from Phase 2) and present the margin math.
2. **Prospecting metro** — Justin names it. Builder: the lead agent design
   (Places search → footprint scoring → ranked list → outreach) is ready to
   implement once named.
3. **$10k/month target date** — Justin sets it. Builder: back-schedule from
   the date once set (client acquisition rate → delivery capacity).
4. **helixmain.com** — purchase at registrar (Justin's action; RDAP said
   available — verify at purchase).
5. **Legal formation** — route to a professional when Justin says go.
6. **card-protocol public vs private** — recommendation: public eventually;
   standards win by adoption. Justin's call.

---

## Appendix A — Verified facts (do not re-verify; verify NEW claims)

- OpenShell: NVIDIA/OpenShell, Apache-2.0, v0.1.2. Real schema: version,
  filesystem_policy, landlock, process, network_policies,
  network_middlewares. Kernel-enforced FS/network policy, endpoint-bound
  credential injection, live-updatable network_policies. Does NOT replace
  ZeroClaw, the hold queue, Paperclip, or Hermes.
- ZeroClaw: zeroclaw-labs/zeroclaw, MIT/Apache-2.0, ~3.4MB binary, DeepSeek
  provider config, MCP client stack, plugin egress ceremony, SecurityPolicy
  default Supervised. Primary per-card runtime.
- PicoClaw: sipeed/picoclaw, 30k stars, MIT, Go. Portability target; the
  runtime stays a swappable driver.
- Hermes ALWAYS = Nous Research Hermes Agent. Paperclip = company OS
  (paperclipai/paperclip, MIT) with a first-class Hermes adapter.
- PocketBase per-card operational state; minipae portable memory.
- Meshenger QR: contact JSON {name, public_key (hex ed25519), addresses[]};
  the public key IS the proof; private key never in the card; QR is a stable
  pointer across card mutations.
- Nostr is the default infrastructure profile; Sui/Seal/Walrus are opt-in.
- Santino's Pizza: 499 Ernston Rd, Parlin NJ 08859, (732) 721-3163,
  santinospizzanj.com, family owned since 1970, 4.1★/42 reviews. Demo card
  only, no affiliation, status draft.
- card-protocol 0.2: tier_hashes commit to canonical plaintext view bytes;
  acting hash = the seven keys (identity, voice, offerings, operations,
  policies, handoff, knowledge); envelope `card-envelope/0.2` with
  self-verifying view_hash; schemes nip44 / xchacha20poly1305 / seal-sui.

## Appendix B — Repo map

- `cryptonomicsed-byte/card-protocol` (private) — the standard. Remote main
  `136bb06`.
- `cryptonomicsed-byte/helixmain` (private) — the company. Remote main
  `f8447c2`. Local histories diverge (API-mirrored commits); working trees
  match remote. Never force-push.
- Key paths: `dna-foundry/compiler` (the compiler),
  `dna-foundry/swarm/mutate.py` (gate prototype),
  `agent-os/contracts/` (seven-powers.md, business-card spec),
  `spark-gatekeeper/` (to be created — Phase 1).

## Appendix C — Standing decisions log (for the builder's context)

- 2026-10-01: HelixMain named; card-is-the-product; null stays null.
- 2026-10-02: five moat builds locked; seven powers canonical (universal
  names only); harness OSS, build the five.
- 2026-10-03: OpenShell source-verified; ZeroClaw/PicoClaw selected;
  card-protocol repo created; 0.2 tier annex authorized.
- 2026-10-04: 0.2 pushed with exit proof in commit messages; fixtures
  migrated to Santino's; v4 minted with in-card demonstration marking;
  compiler spike proven against the real OpenShell schema; SparkGatekeeper
  is the unblocked path.
