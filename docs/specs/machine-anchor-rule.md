# Machine Anchor Rule — CARD.md Spec

**Status:** Accepted  
**Applies to:** All CARD.md sections compiled from source material  
**Scope:** `dna-foundry/compiler`, `dna-foundry/parser`, card-protocol 0.x

---

## The Rule

> The anchor is the machine truth. The prose is the human view.  
> Any disagreement between them is surfaced, never smoothed over.

Every section the compiler produces from source material gets a machine anchor
comment inline with the human-readable text. The parser trusts the anchor on
every subsequent read; it never re-extracts from prose when an anchor is present.
Anchors are versioned so format changes are loud failures, not silent partial
parses.

---

## Anchor Syntax

```
<!-- machine:<section>@<version> <canonical-json> -->
```

- `section` — snake_case section name: `offering`, `policy`, `voice_dont`,
  `hour`, `channel`, `identity_value`, `knowledge_ref`, etc.
- `version` — integer starting at `1`; increment when the JSON schema gains or
  removes a field. The parser rejects unknown versions loudly.
- `canonical-json` — compact JSON (no whitespace), keys sorted, matching the
  section's TypeScript type exactly.

### Current versions

| section | version | required fields |
|---|---|---|
| `offering` | 1 | `name`, `kind`, `price`, `orderable`, `confidence` |
| `policy` | 1 | `topic`, `rule` |
| `voice_dont` | 1 | `text` |
| `hour` | 1 | `days`, `open`, `close` |
| `channel` | 1 | `name` |
| `identity_value` | 1 | `text` |
| `knowledge_ref` | 1 | `ref`, `kind`, `title`, `chunks` |

New sections start at `@1`. Any field addition or removal bumps the version.

---

## Three Read States

The parser classifies every section item into one of three states. This
classification is stored in `field_provenance` on the compiled card.

### 1. `anchored` — anchor present

```markdown
- Classic Cheese Pizza — hand-tossed, whole milk mozzarella
  <!-- machine:offering@1 {"name":"Classic Cheese Pizza","kind":"pizza","price":null,"orderable":true,"confidence":0.6} -->
```

Parser behaviour:
- Read the anchor JSON as authoritative.
- Ignore the prose above it for structured fields.
- Verify anchor version matches the current parser schema; reject unknown
  versions with a hard error (do not partial-parse).
- Set provenance `state: "anchored"`.

### 2. `anchor_missing` — anchor was previously present but is now gone

Detected when: a prior card version's `field_provenance` records an anchor for
this item, but the current file no longer contains it.

Parser behaviour:
- Do **not** silently fall back to prose re-extraction.
- Emit a compile error: `anchor_missing: <section>/<item-key>`.
- Surface to the operator UI: "An anchor was removed. Review and re-anchor
  before publishing."
- Block compilation until resolved. The operator either restores the anchor
  or explicitly marks the item as `inferred` (which queues it for owner
  confirmation).

This is a flagged degradation event, not a recoverable fallback.

### 3. `inferred` — prose present, no anchor ever existed

Detected when: the item appears in the markdown but has no anchor and no
prior-version provenance for it.

Parser behaviour:
- Parse from prose using the section's extraction heuristic.
- Assign `confidence` per extractor (typically 0.4–0.7).
- Set provenance `state: "inferred"`, `queued_for_confirmation: true`.
- On the **next compile** (after owner confirmation or extractor validation),
  write the anchor inline. The item becomes `anchored` from that point forward.

This is how new owner edits enter the system. Typing a new menu item into the
markdown is valid — it just doesn't become machine truth until it's anchored.

---

## Compiler Responsibilities

The compiler writes anchors; the owner never writes them manually.

1. **Initial extraction** — when compiling from source (website, PDF, etc.),
   produce every section item as `inferred` with extracted confidence.
2. **Anchor write** — after the owner confirms (or the extractor meets the
   confidence threshold), write the `<!-- machine:... -->` anchor inline below
   the human prose for that item. Commit the anchored card.
3. **Re-anchor on schema change** — when a section version bumps, the compiler
   rewrites all existing anchors to the new version during the next compile
   cycle. Old-version anchors are never left in place.
4. **Anchor delete detection** — on parse, compare current anchors against the
   previous card version's `field_provenance`. Any anchor present in v(n-1)
   but absent in v(n) is an `anchor_missing` error. The compiler does not
   write the new card hash until this is resolved.

The owner edits through a surface (operator UI or `dna mutate` flow) that
automatically re-anchors. Raw markdown editing is valid but anchor deletion
is a flagged event — the file tells you it is degraded instead of pretending
it is healthy.

---

## Provenance Record

Each anchored or inferred item adds an entry under `field_provenance` in the
compiled card JSON:

```json
"field_provenance": {
  "offerings[0]": {
    "state": "anchored",
    "anchor_version": 1,
    "sources": ["file:///tmp/demo-site/menu.html"],
    "confidence": 0.6,
    "extractor_agent": "extractor:website",
    "extracted_at": "2026-10-04T05:39:28Z"
  },
  "offerings[2]": {
    "state": "inferred",
    "queued_for_confirmation": true,
    "sources": ["operator:raw_edit"],
    "confidence": 0.5,
    "extracted_at": "2026-10-04T12:00:00Z"
  }
}
```

---

## Acceptance Criteria

- [ ] Parser accepts `anchored` items and ignores prose for structured fields.
- [ ] Parser rejects unknown anchor versions with a hard error — no partial
      parse, no silent skip.
- [ ] Parser emits `anchor_missing` error when an anchor present in the
      previous version is absent in the current file. Does not fall back to
      prose.
- [ ] Parser classifies prose-only items as `inferred`, sets
      `queued_for_confirmation: true`.
- [ ] Compiler writes anchors inline after confirmation; resulting card parses
      as `anchored`.
- [ ] Compiler detects anchor deletion (compares against previous
      `field_provenance`) and blocks hash computation until resolved.
- [ ] All 7 acting-hash sections (identity, voice, offerings, operations,
      policies, handoff, knowledge) have anchor coverage for their list items.
- [ ] `acting_hash` and `hash` are stable across round-trips when no
      human-readable prose changes (anchor rewrite does not change hash).

---

## Sections Not Covered

The following top-level fields are scalar or compiler-derived and do not need
anchors:

`id`, `version`, `hash`, `acting_hash`, `previous_hash`, `previous_version`,
`organization_id`, `status`, `created_at`

`strategy`, `customers`, `competitors`, `insights` — these are inference
outputs, not owner-confirmed fields. They carry confidence in `field_provenance`
but do not get anchors until owner confirmation surfaces are built.

---

## Known Bug: Phone/Source Duplication

The v4 Identity section emits Phone and Source twice — an emitter quirk in the
compiler's `identity` section builder. Fix: deduplicate by field key before
writing; last value wins. Target: next compiler patch release.
