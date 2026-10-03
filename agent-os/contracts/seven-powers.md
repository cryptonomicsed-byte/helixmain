# The Seven Powers — Canonical Lineup
Date: 2026-10-02 · Status: CANONICAL
Naming rule: universal words ONLY. No mythic names anywhere in the
working vocabulary — not in code, docs, UI, or conversation.
Derived from: `omokoda-agent` main HEAD — `omokoda-hermetic/src/seven/mod.rs`
(`SevenFunction`, positional principle mapping),
`omokoda-hermetic/src/seven/adapters.rs` (canonical cultural adapter),
`omokoda-core/src/gates/mod.rs` (gatekeeper). Verified against live code.

## The lineup

| # | Power | Language | Hermetic principle | Keywords | Role in HelixMain |
|---|-------|----------|--------------------|----------|-------------------|
| 1 | ⚡ SPARK | Rust | Mentalism | communication, choice, gateway, routing, permission | The gate. Card canonicalization, hash-chain verification, permission checks, dispatch, session management. Every call in or out passes through SPARK. |
| 2 | 🧠 MIND | Clojure | Correspondence | reason, clarity, ethics, wisdom | Reason as pattern recognition ("pattern recognition as rational clarity"). Symbolic evaluation of Policy; deliberation engine. |
| 3 | ⚒️ FOUNDATION | Python | Cause & Effect | will, labor, work, execution, embodiment | "Causality as the root of effective work." Tool execution, MCP tool bus, practical work. |
| 4 | 💧 EMOTION | Julia | Vibration | joy, fertility, relationship, value, memory | "Resonance frequency as emotional weight." Memory, fleet resonance, pattern-feeling across cards. |
| 5 | 🌐 MATRIX | Elixir | Gender | community, ancestry, home, creation, continuity | "Generative polarity as creative force." The swarm is birthed here: agent lifecycle, supervision trees, spawning, fault tolerance. |
| 6 | 🔥 FIRE | Move | Polarity | power, justice, consequence, authority, settlement | "Extremes of power as authority/justice." Settlement, receipt anchoring, on-chain accountability, reputation. |
| 7 | 🌪️ ASCENSION | Go | Rhythm | transformation, transition, spirit, flow | "Tidal flow as transformation." Networking, timing, cooldowns, inter-agent messaging, state transitions. |

The 8th element — the Human — is TypeScript: all user-facing interfaces.
It presents; it never controls.

## Architectural rules (binding)

1. **Seven gates, one choke point.** The 7 Hermetic principles exist as gate
   modules (mentalism, correspondence, vibration, polarity, rhythm, gender,
   cause_effect). Enforcement is CENTRALIZED: every `birth` / `think` / `act`
   flows through the SparkGatekeeper (SPARK/Rust), which runs all 7 gates as
   mandatory. Any gate rejects → operation halts. For HelixMain: the hold
   queue IS the SparkGatekeeper — card mutations AND deploy/publish/send
   flow through it.
2. **MIND deliberates; it does not gate.** MIND (Clojure) is the wisdom
   module — deliberation and consensus. It reasons with all 7 principles as
   *lenses* on escalated hard cases. Judgment is separated from enforcement.
3. **Per-power principle = governance nature.** Per the source module:
   principle → how the power must behave (governance); power → what it IS
   (ontology). A power does not get "its own gate"; it gets its nature.
4. **Strength profiles, not assignments.** Each agent's seven-power strength
   profile is derived deterministically from its seeded identity state — the
   same bytes as governance, two framings. Agents are not assigned to powers;
   they resonate with them.
5. **Adapters cannot redefine powers.** Cultural adapters may rename powers
   for their own tradition, but the computation (the 7 functions, their
   order, their principles) is stable and cannot be redefined. The universal
   words are the stable cross-context interface — use them everywhere.
6. **Vision order is cosmology, code order is ABI.** The tier-ladder doc
   (256→65536 and associated mappings) is vision. The computational order is
   Spark→Ascension per the function enum. Where they conflict, the code wins.

## Provenance

- Function enum + positional principle mapping + rationale comments:
  `omokoda-hermetic/src/seven/mod.rs`
- Canonical power↔tradition mapping:
  `omokoda-hermetic/src/seven/adapters.rs`
- Gate enforcement: `omokoda-core/src/gates/mod.rs`
  ("every birth/think/act flows through the gatekeeper; any gate can
  REJECT → operation HALTED")
- Clojure wisdom module present in tree; predecessor Lisp implementation
  retired to archive
- Independent confirmation of the gate concept:
  OSOVM `blockchain/consensus/src/work.rs`
  (`hermetic_gate_denied` work-lifecycle rejection state)
- NOT in code (do not treat as landed): a `tiers.rs` runtime module;
  tier-number ladder as executable logic.
