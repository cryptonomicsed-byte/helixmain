# BUSINESS.md — the Business Card standard (v0.1)

> **SUPERSEDED 2026-10-01** by `business-card-0.1.md` (`CARD.md`).
> The BUSINESS.md emitter has been retired; one card format. This document
> is kept for history only.

## The idea

`AGENTS.md` became a standard because it answered one question: *how does any
agent know how to work in this repo?* `BUSINESS.md` answers the parallel
question: *how does any agent know how to work for this company?*

Any agent — Claude, Hermes, a Grok Bot, a future runtime that doesn't exist
yet — dropped into a directory containing a `BUSINESS.md` can read it cold and
start producing work: answering as the business, writing in its voice,
following its policies, escalating where it must. No SDK, no API key, no
integration. The file **is** the onboarding.

## The product, stated plainly

**HelixMain creates and maintains a business's BUSINESS.md.** The card is the
product. Everything else — the support agent, the content engine, the
competitor research — is a consumer of the card.

## Format

One markdown file. YAML frontmatter is the machine envelope; the body is the
agent-readable card with **fixed section headings** (the standard). Parsers
may be strict about headings and lenient about prose.

```markdown
---
format: business-card/0.1
id: dna_9f3k2mqa
version: 3
previous_hash: 4b8f...c1
hash: sha256:9d2a...e7
organization_id: org_77xq1abc
updated: 2026-10-01T07:40:00Z
status: approved   # draft | in_review | approved | retired
---

# Business Card: Santino's Pizza

> Small-batch roastery and café on Main Street. We remember your order.

## Identity
- **Mission:** ...
- **Values:** ...
- **Elevator pitch:** one sentence — what the business does and for whom.
- **Founded:** ... | **Location:** ...

## Voice
- **Tone:** warm, unhurried, plain-spoken
- **Personality:** the knowledgeable regular (concise sketch)
- **Description:** concise description of how the business sounds.
- **Do:** ...
- **Don't:** ...
- **Sounds like:** "..."
- **Sonic:** voice type / music genre / sound keywords — how the brand sounds beyond words.
### Sonic brand
The brief above becomes audio. Asset refs are content hashes (`sha256:<hex>`);
the files live at `foundry/assets/<hex>.mp3`, immutable and versioned with the
card — a regenerated asset mints a new hash on the new card version. A listed
asset with no `asset:` ref is a staged brief (provider not yet configured);
its structured generation prompt is staged at
`foundry/assets/prompts/<card-id>-sonic-prompts.json` so flipping the key
produces audio with no code changes.
- **Brief:** voice type · music genre — keywords: ... (restates the Sonic brief)
- **Sonic logo:** "description" — asset: `sha256:...` (4.0s) — the 3–5s brand mnemonic
- **Voice logo:** "spoken script" — voice `profile-id` — asset: `sha256:...`
- **UI sounds:** notification ("description") — asset: `sha256:...`; success ("...") — asset: `sha256:...`; error ("...") — asset: `sha256:...`
Omit any asset line whose brief was never produced. Never invent an asset ref.

## Offerings
- **Name** — description... (price hint where observed)

## Strategy
- **Positioning:** one line on how the business stands against alternatives.
- **Key messaging:** the 3 messages the business repeats everywhere.
- **SWOT:**
  - Strengths: ...
  - Weaknesses: ...
  - Opportunities: ...
  - Threats: ...

## Customers
- **Persona: Name** — description; role: ...; pain points: ...
- **Touchpoints:** web chat, phone, in person...

## Visual
- **Primary color:** measured from real CSS, never guessed.
- **Secondary color:** ...
- **Font pairing:** observed font families.
- **Style keywords:** ...
- **Design system:** LLM-interpreted style read (colors/fonts stay measured).

## Operations
- **Hours:** ...
- **Channels:** ...
- **Systems:** square, gmail...

## Policies
<!-- Owner-curated. Empty until the owner fills it in with the agent;
     the emitter renders an explicit "to be completed with the owner" prompt. -->
- **Refunds:** ...
- **Escalation:** ...

## Knowledge
<!-- Owner-curated: menus, price lists, FAQs, documents the agent grounds in. -->
- [FAQ](ref://kb/faq) · [Return policy](ref://kb/policy-returns) ...

## Competitors
<!-- Evidence first (outbound links, vs-mentions). When the site names none,
     the competitor_inference skill falls back to obvious category chains plus
     a local-independents stub — every inferred entry is marked
     "(inferred from category — confirm with owner)", confidence 0.4. -->

## Insights
<!-- Patterns the swarm found that the owner may not have noticed. -->
- **Title** — detail (evidence: ...)

## Provenance
<!-- Field -> sources, confidence, extractor, date. Agents cite this. -->
- `voice.tone` — sources: [homepage, 40 reviews], confidence 0.9,
  extractor: extractor:website, 2026-10-01

## Changelog
- **v3** (2026-10-01): hours updated from Google listing (receipt rcpt_...)
- **v2** (2026-09-28): added catering offering
```

## The card is dynamic: the mutation protocol

The card mutates with the company. Mutation is not editing a wiki — it is a
governed loop:

1. **Sense.** Extractor agents re-crawl sources on a schedule (website, reviews,
   listings) and diff against the current card.
2. **Propose.** Each change becomes a structured proposal: field, old value,
   new value, evidence, confidence.
3. **Gate.** Low-risk factual updates (hours, new menu item) auto-apply;
   identity/voice/policy changes require human approval. Every mutation is an
   action through the policy engine.
4. **Mint.** Approved proposals bump `version`, recompute the hash chain,
   append to Changelog, and mint a receipt. The card's history is auditable
   from the file itself.

## Two views, one truth

- `BUSINESS.md` is the **primary surface**: authored, read, and diffed by
  agents and humans.
- The JSON schema (`contracts/dna-card.json`) is the **compiled machine view**:
  validators, the policy engine, and Paperclip sync consume it.
- The compiler round-trips both directions, and the `hash` in frontmatter
  covers the canonical JSON — tampering with either view is detectable.

## Canonicalization rules (hash identity)

The card hash must be byte-identical whether computed in Python (swarm,
skills) or TypeScript (compiler). Both sides implement the same rules,
in this order:

1. Strip the `hash` field and any `_`-prefixed ephemeral fields.
2. Normalize integral floats to integers (`4.0` → `4`), because Python's
   `json.dumps` writes `4.0` while `JSON.stringify` writes `4`.
3. **Prune empty values bottom-up**: an empty array or empty object as an
   object value is identical to a missing key (`"threats": []` ≡ no
   `threats`). This keeps the md↔JSON round-trip lossless when the
   Markdown omits empty sections.
4. Sort object keys; serialize with `(",", ":")` separators.

The `hash` field itself is stored `sha256:`-prefixed (`sha256:<hex>`);
the parser preserves that convention so parsed cards compare equal to
the JSON they were compiled from.

Separator safety: the Markdown emitter joins persona bits with ` · `,
and field values may legitimately contain ` · ` (e.g. a role of
"Parlin regular · Friday pizza night loyalist"). The parser treats
unlabeled segments *after* a labeled field as continuations of that
field, not as a description — only unlabeled segments before the first
label become `description`.

## Extraction hygiene

- HTML entities in `<title>`/meta are unescaped before brand-name
  parsing (`Santino&#x27;s Pizza` → `Santino's Pizza`).
- Headings that read as sentences (end with `.`/`!`/`?`, contain `". "`)
  or look like markup-concatenation artifacts (`TakeoutReady`,
  `Delivery30`) are never offerings — menu items are noun phrases.
- Competitor extraction ignores the business's own sales-channel links:
  ordering/delivery platforms (Bringdat, Toast, Slice, DoorDash, …) and
  pure call-to-action labels ("Order Online", "Get directions") are
  vendors, not rivals.

## Discovery

A business publishes its card where agents can find it:
`https://example.com/BUSINESS.md`, `/.well-known/business-card`, or shipped
inside the agent's working directory at handoff. Private fields stay in the
platform copy; the public file carries a `visibility` marker per section in
later versions.
