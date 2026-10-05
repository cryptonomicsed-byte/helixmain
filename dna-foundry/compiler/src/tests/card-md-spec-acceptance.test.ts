export {};
/**
 * Spec acceptance tests — machine-anchor-rule.md
 *
 * One test per acceptance criterion. Criterion numbers match the spec exactly.
 * AC-5 is a todo — it covers the dna confirm CLI promotion path (not yet built).
 *
 * Spec: docs/specs/machine-anchor-rule.md
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { emitCardMd } = require("../card-md");
const { parseCardMd, verifyCardMd } = require("../card-md-parse");

const CARD = {
  id: "dna_spec_ac01",
  organization_id: "org_spec",
  version: 1,
  previous_version: null,
  status: "draft",
  created_at: "2026-10-01T00:00:00Z",
  identity: {
    name: "Spec Business",
    phone: "555-0100",
    location: "1 Spec Lane",
  },
  voice: {
    donts: ["Never evade"],
  },
  offerings: [
    { name: "Core Service", kind: "service", orderable: true, price: null, confidence: 0.8 },
  ],
  operations: {
    hours: "Mon–Fri 9am–5pm",
    channels: ["email"],
  },
  policies: [
    { topic: "refunds", rule: "30-day window" },
  ],
  knowledge: [
    { ref: "faq", kind: "faq", title: "FAQ", chunks: 3 },
  ],
};
const CHANGELOG: string[] = [];

// ── AC-1 ──────────────────────────────────────────────────────────────────────
// Parser accepts anchored items and ignores prose for structured fields.

test("[AC-1] anchored item: anchor JSON is authoritative, prose ignored", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  // Corrupt the prose bullet — anchor must still win
  const corrupted = md.replace(
    "**Name:** Spec Business",
    "**Name:** CORRUPTED PROSE",
  );
  const p = parseCardMd(corrupted);
  assert.equal(p.card.identity.name, "Spec Business", "anchor overrides corrupted prose");
  assert.equal(p.anchorProvenance?.["identity.name"]?.state, "anchored");
});

// ── AC-2 ──────────────────────────────────────────────────────────────────────
// Parser rejects unknown anchor versions with a hard error — no partial parse.

test("[AC-2] unknown anchor version: hard error, no partial parse", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  const future = md.replace(/machine:offering@1/g, "machine:offering@99");
  assert.throws(
    () => parseCardMd(future),
    /offering anchor version 99 is unknown/,
    "must throw, not silently skip",
  );
});

// ── AC-3 ──────────────────────────────────────────────────────────────────────
// Parser emits anchor_missing error when an anchor present in the previous
// version is absent in the current file. Does not fall back to prose.

test("[AC-3] anchor_missing: hard error, prose fallback suppressed", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  // Strip all offering anchors — the card now looks hand-edited
  const stripped = md.replace(/^<!-- machine:offering@1 \{.*\} -->$/gm, "");
  // Simulate previous version having anchored offerings
  const prevProvenance = { "offerings[0]": { state: "anchored", anchor_version: 1 } };
  const p = parseCardMd(stripped, { prevProvenance });
  assert.ok(p.anchorErrors && p.anchorErrors.length > 0, "anchorErrors must be set");
  assert.match(p.anchorErrors![0], /anchor_missing/, "error is anchor_missing not hash mismatch");
  // Items must NOT be re-extracted from prose
  assert.equal(p.card.offerings, undefined, "no silent prose fallback");
});

// ── AC-4 ──────────────────────────────────────────────────────────────────────
// Parser classifies prose-only items as inferred, sets queued_for_confirmation.

test("[AC-4] prose-only item: state=inferred, queued_for_confirmation=true", () => {
  const bare = [
    "---",
    "format: business-card/0.1",
    "id: dna_spec_ac04",
    "version: 1",
    "previous_hash: none",
    "hash: sha256:" + "0".repeat(64),
    "acting_hash: sha256:" + "0".repeat(64),
    "organization_id: org_spec",
    "status: draft",
    "updated: 2026-10-01T00:00:00Z",
    "---",
    "",
    "# Prose Business",
    "",
    "## Offer",
    "- **Hand-Written Item** · kind: service · price: null · confidence: 0.5",
    "",
  ].join("\n");
  const p = parseCardMd(bare);
  assert.equal(p.card.offerings?.[0]?.name, "Hand-Written Item");
  assert.equal(p.card.field_provenance?.["offerings[0]"]?.state, "inferred");
  assert.equal(p.card.field_provenance?.["offerings[0]"]?.queued_for_confirmation, true);
  assert.equal(p.anchorProvenance?.["offerings[0]"], undefined, "inferred is not in anchorProvenance");
});

// ── AC-5 ──────────────────────────────────────────────────────────────────────
// Compiler writes anchors inline after confirmation; resulting card parses as anchored.
// (dna confirm CLI — promotion path not yet implemented)

test.todo("[AC-5] anchor write-out after confirmation: card parses as anchored");

// ── AC-6 ──────────────────────────────────────────────────────────────────────
// Compiler detects anchor deletion and blocks hash computation until resolved.

test("[AC-6] anchor deletion: verifyCardMd blocks hashing, surfaces anchor_missing", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  const stripped = md.replace(/^<!-- machine:offering@1 \{.*\} -->$/gm, "");
  const prevProvenance = { "offerings[0]": { state: "anchored", anchor_version: 1 } };
  const v = verifyCardMd(stripped, { prevProvenance });
  assert.equal(v.ok, false);
  assert.match(v.reason, /anchor_missing/, "must be anchor_missing, not hash mismatch");
});

// ── AC-7 ──────────────────────────────────────────────────────────────────────
// All 7 acting-hash section types have versioned anchor coverage for list items.

test("[AC-7] all 7 list-section types emit versioned anchors", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  const EXPECTED_TAGS = [
    "identity_value",
    "voice_dont",
    "offering",
    "hour",
    "channel",
    "policy",
    "knowledge",
  ];
  for (const tag of EXPECTED_TAGS) {
    const re = new RegExp(`<!-- machine:${tag}@\\d+ \\{`);
    assert.match(md, re, `${tag} anchor missing from emitted CARD.md`);
  }
});

// ── AC-8 ──────────────────────────────────────────────────────────────────────
// acting_hash and hash are stable across round-trips — anchor lines live
// outside the card hash, so a re-emit of an already-anchored card produces
// the same hashes.

test("[AC-8] hash stability: anchor comments do not affect card hash", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  // Parse then re-emit — the card JSON should be identical, hashes unchanged
  const p = parseCardMd(md);
  const md2 = emitCardMd(p.card, p.changelog);
  const p2 = parseCardMd(md2);
  assert.equal(p.frontmatter.hash, p2.frontmatter.hash, "hash must be stable across re-emit");
  assert.equal(p.frontmatter.acting_hash, p2.frontmatter.acting_hash, "acting_hash must be stable");
  // Anchors must be present in the re-emitted card (not stripped)
  assert.match(md2, /<!-- machine:identity_value@1/, "anchors survive round-trip");
});
