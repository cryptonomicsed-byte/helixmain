# HelixMain

**DNA for Main Street.** An AI services company for local small businesses.

The product loop:

1. **Extract** a versioned Business DNA profile card from a client's website and assets.
2. **Maintain** the card as the living, agent-readable source of truth.
3. **Spawn** card-grounded specialist agents from it.
4. **Bind** reusable role packs to the card instead of generic personas.

## The card is the product

`CARD.md` — format [`business-card/0.1`](agent-os/contracts/business-card-spec.md) — is the file any agent reads cold. It carries identity, voice, sound, offer, operations, policy, handoff, knowledge, and provenance, plus a hash-chained mutation history. SWOT, inferred competitors, and personas live in a non-quotable Appendix.

## Layout

- `dna-foundry/` — the extraction → compile → mutate → sense pipeline
  - `swarm/` — extraction skills, canonicalization (`canonical.py`), sonic-brand skill
  - `compiler/` — TypeScript CARD.md emitter, parser/verifier (`npm run build && npm test`)
- `agent-os/` — contracts, including the `business-card/0.1` spec of record

## Status

Standard locked 2026-10-01. Implementation in progress.
