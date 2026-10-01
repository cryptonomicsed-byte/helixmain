# Business Card — `business-card/0.1`

**Status:** draft standard · 2026-10-01
**Supersedes:** the `BUSINESS.md` / `dna-card` contract (`business-card-md-standard.md`), whose emitter has been retired. One card format. `CARD.md` is the product.

## The product

The card is the product. `CARD.md` is the file any agent reads cold — the way a soul file is the person. It mutates with the company. It is not a brochure.

File: `CARD.md` at the company root. Agents also accept `business-card.md`.

## Read rules

1. Read the frontmatter first. If `status` is `draft`, treat every field without `owner-confirmed` as untrusted. Do not invent the missing ones.
2. Quote only the Acting layer. The Appendix is for humans and planners. Never speak SWOT, competitor guesses, personas, or staged audio in a reply.
3. If a field is absent or `null`, refuse that act and hand off. Do not fill it from memory. A null price stays null.
4. Cite `provenance` when a guest or owner asks why you said something.
5. A mutation writes a new version. Do not edit a live hash in place.

## File shape

```yaml
---
format: business-card/0.1
id: dna_<id>
version: 2
previous_hash: sha256:<hex>   # or "none" for v1
hash: sha256:<hex>            # over the full canonical JSON; never "pending"
acting_hash: sha256:<hex>     # over the Acting sections only
organization_id: org_<id>
status: draft                 # draft | owner-confirmed | live
updated: 2026-10-01T00:00:00Z
---
```

Sections, in order:

1. Identity
2. Voice
3. Sound
4. Offer
5. Operations
6. Policy
7. Handoff
8. Knowledge
9. Provenance
10. Changelog
11. Appendix (optional — not quotable, not in `acting_hash`)

The Acting layer is sections 1–9. The Appendix holds personas, inferred competitors, SWOT, and strategy notes: useful to planners, never quoted to guests.

## Acting fields

### Identity
name, pitch (one sentence), address, phone, email, timezone, source_url. `elevator_pitch`, `mission`, `founded`, and `values` may also appear.

### Voice
tone, personality, samples (3–5), donts, lexicon.use, lexicon.never.

### Sound
A company has a boot sound, the way a machine does. Three assets, each with a state machine: `staged` → `ready` → `retired`.

- `logo` — the mark you hear once, under 4 seconds. Netflix dum-dum, console power-on.
- `voice_logo` — one spoken line: the name plus one welcome sentence. Under 6 seconds.
- `ui` — notification, success, error. Each under 1.2 seconds. Error is round and quiet, never a buzz.

```yaml
sound:
  logo: { state: staged, brief: "wooden knock, then a warm muted tone", asset: null, seconds: 4 }
  voice_logo: { state: ready, line: "Welcome to …", voice: "<voice-id>", asset: "sha256:<hex>" }
  ui:
    notification: { state: staged, brief: "single gentle wooden knock" }
    success: { state: staged, brief: "two rising soft notes" }
    error: { state: staged, brief: "one low rounded tone, no buzz" }
```

Rules:

- A state becomes `ready` only when the asset file exists. A brief is not an asset.
- `asset` is a content hash (`sha256:<hex>`), never a bare filename. Filenames are not content-addressed.
- A voice agent may play `ready` assets only. It must never play `staged` ones.
- `draft` status does not block rendering, but machine-rendered audio is not owner confirmation: the owner confirms the *line*, and confirmation is recorded in Provenance before `status` leaves `draft`.

### Offer
A list. Each row: name, kind, orderable, price (number or null), confidence. Null price is allowed. A made-up price is not — the agent refuses and hands off.

### Operations
hours, channels, delivery fence, catering lead time, and what requires a human confirm.

### Policy
refunds, cancellations, allergens, alcohol, promises the agent must not make. Empty means hand off, not guess.

### Handoff
when, channel, after-hours behavior.

### Knowledge
Pointers to menus, PDFs, FAQs. Not the documents themselves.

### Provenance
field, sources, confidence, extractor, at. Every acting-layer claim an agent might quote traces here.

## Canonicalization (hash identity)

The hash chain is only as real as its canonicalization. Every implementation — Python, TypeScript, or otherwise — must produce byte-identical canonical JSON:

1. Strip the `hash` field and any `_`-prefixed ephemeral fields.
2. Normalize integral floats to integers (`4.0` → `4`). Python's `json.dumps` writes `4.0`; `JSON.stringify` writes `4`.
3. Prune bottom-up: an empty array or empty object as an object value is identical to a missing key (`"threats": []` ≡ no `threats`). This keeps the Markdown↔JSON round-trip lossless where Markdown omits empty sections.
4. Sort object keys; serialize with `(",", ":")` separators, no whitespace.

`hash` = SHA-256 of the canonical full card, stored `sha256:`-prefixed.
`acting_hash` = SHA-256 of the canonical JSON of the Acting sections (1–9) only. Acting-layer changes recompute it; agents bound to the old `acting_hash` must reload before quoting the card again. (Reload mechanism: poll `acting_hash` on each session start; subscriptions later.)

## Mutation

The card mutates. The company is not a snapshot.

Triggers: owner edit, new menu, hour change, review import, tool result that contradicts a field, expired confidence.

Rules:

- A mutation bumps `version`, sets `previous_hash`, recomputes `hash` (and `acting_hash` when the Acting layer changed).
- Inferred fields never overwrite `owner-confirmed` fields.
- A contradiction opens a question for the owner. It does not silently win.
- Changelog gets one line: version, time, what changed, who (owner or extractor).

## What any agent may produce from a card

| Agent | Reads | May do | May not |
|---|---|---|---|
| Front desk | voice, offer, hours, policy, handoff | answer, book within rules | price if null, refund, allergen promise |
| Sales | voice, offer, appendix customers | draft outreach | send, invent proof |
| Content | voice, lexicon, offer | draft pages and posts | publish, use appendix as copy |
| Sound | sound briefs, voice samples | write a jingle brief, call the sonic skill | play staged assets |
| Policy | policy, handoff | allow / deny / ask | widen a gate |

## Skill: sonic-brand

Name: `sonic-brand`
Input: a `business-card/0.1` file.
Output: patches the Sound section only. Never touches Offer, Voice, or Policy.

1. Load Identity and Voice. **Refusal:** if `identity.name` or `voice.tone` is missing, stop and ask. Do not score a jingle for a company you cannot name.
2. Logo brief, under 4 seconds, matched to temperament. A family pizzeria gets a wooden knock and a warm tone, not a synth hit. State: `staged`.
3. Voice-logo line: the name plus one welcome sentence from the pitch. No hype words from `voice` donts/never lists.
4. UI briefs: notification, success, error. Error is round and quiet.
5. Speak the voice logo. Record the content hash on `sound.voice_logo.asset`. State becomes `ready` only after the file exists.
6. Leave the musical logo and UI tones `staged` until an audio renderer produces them.
7. Write the patch into the Sound section. Bump version, chain the hash, append a changelog line (`sonic-brand`).

## Conformance

A file claiming `format: business-card/0.1` must:

- carry a real `hash` and `acting_hash` (no placeholders);
- keep the section order above;
- record sound assets as content hashes with honest states;
- round-trip Markdown↔JSON without loss under the canonicalization rules;
- never place Appendix content (personas, inferred competitors, SWOT) where an agent could quote it as fact.
