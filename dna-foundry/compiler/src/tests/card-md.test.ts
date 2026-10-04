/**
 * CARD.md (business-card/0.1) round-trip tests. Run: npm test
 *
 * PY_HASH / PY_ACTING_HASH were computed by the Python swarm's own
 * canonicalizer (json.dumps(sort_keys=True, separators=(",",":")), ensure_ascii).
 * If the cross-language tests pass, the TS compiler and the Python
 * extractor agree byte-for-byte on both hashes.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { canonicalJson, cardHash } = require("../business-md");
const { emitCardMd, actingHash } = require("../card-md");
const { parseCardMd, verifyCardMd } = require("../card-md-parse");

const PY_HASH = "5d53266858479ad4e423354b109601b3d47ae26c7db5bc47d80e3ae74819b20d";
const PY_ACTING_HASH = "bc4c496a5b5cb1b47c92aeb317950ab91d167a174156b8f3d2760e032bbbd0ac";

const CARD = {
  id: "dna_test0001",
  organization_id: "org_demo0001",
  version: 1,
  previous_version: null,
  status: "draft",
  created_at: "2026-10-01T00:00:00Z",
  identity: {
    name: "Santino's Pizza",
    tagline: "Family owned and operated since 1970.",
    elevator_pitch: "Family owned and operated since 1970 — hand-tossed pies in Parlin, NJ.",
    location: "499 Ernston Rd, Parlin, NJ 08859",
    phone: "(732) 721-3163",
    timezone: "America/New_York",
    website: "https://santinospizzanj.com",
  },
  voice: {
    tone: ["warm", "familial"],
    personality: "The pizzeria that treats you like family.",
    sample_phrases: ["Family owned since 1970", "Mangia! There's plenty."],
    donts: ["No corporate speak"],
    lexicon_use: ["family", "hand-tossed"],
    lexicon_never: ["synergy", "leverage"],
  },
  offerings: [
    { name: "Classic Cheese Pizza", kind: "pizza", orderable: true, price: null, confidence: 0.8 },
    { name: "Pepperoni Pizza", kind: "pizza", orderable: true, price: null, confidence: 0.7 },
  ],
  operations: {
    hours: "Mon–Fri 11am–9pm",
    channels: ["phone"],
    human_confirm: ["large orders"],
  },
  policies: [{ topic: "Refunds", rule: "ask-human" }],
  handoff: {
    open_hours: "phone (732) 721-3163",
    channel: "phone",
    after_hours: "take a message",
  },
  knowledge: [{ title: "Menu", ref: "https://santinospizzanj.com/menu", kind: "page", chunks: 4 }],
  strategy: {
    positioning: "Parlin's family pizzeria since 1970",
    swot: { strengths: ["Regulars"], threats: ["Chain across the street"] },
  },
  customers: {
    personas: [{ name: "Parlin regular", description: "Friday pizza night family", inferred: true }],
  },
  competitors: [{ name: "Big Chain", inferred: true, positioning: "cheaper, faster" }],
  field_provenance: {
    "identity.name": {
      sources: ["index"],
      confidence: 0.85,
      extracted_at: "2026-10-01T00:00:00Z",
      extractor_agent: "extractor:website",
    },
  },
  acting_hash: "bc4c496a5b5cb1b47c92aeb317950ab91d167a174156b8f3d2760e032bbbd0ac",
};

const CHANGELOG = ["**v1** (2026-10-01T00:00:00Z): initial extraction — 12 findings"];

function stripMeta(c: any): any {
  const b: any = {};
  for (const k of Object.keys(c)) { if (k !== "hash" && !k.startsWith("_")) b[k] = c[k]; }
  return b;
}

test("cardHash matches the Python swarm canonicalizer", () => {
  assert.equal(cardHash(CARD), PY_HASH);
});

test("actingHash matches the Python swarm canonicalizer", () => {
  assert.equal(actingHash(CARD), PY_ACTING_HASH);
});

test("round-trip: md -> JSON equals the card, both hashes verified", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  const v = verifyCardMd(md);
  assert.equal(v.ok, true, v.reason);
  const p = parseCardMd(md);
  assert.equal(canonicalJson(stripMeta(p.card)), canonicalJson(stripMeta(CARD)));
  assert.deepEqual(p.changelog, CHANGELOG);
  assert.equal(p.frontmatter.format, "business-card/0.1");
  assert.equal(p.frontmatter.previous_hash, "none");
  assert.equal(p.frontmatter.hash, "sha256:" + PY_HASH);
  assert.equal(p.frontmatter.acting_hash, "sha256:" + PY_ACTING_HASH);
  assert.equal(p.card.previous_version, null);
});

test("appendix is present but excluded from acting_hash", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  assert.match(md, /## Appendix/);
  assert.match(md, /Not quotable/);
  const before = actingHash(CARD);
  const c2 = JSON.parse(JSON.stringify(CARD));
  c2.competitors.push({ name: "Another Chain", inferred: true });
  c2.strategy.swot.threats.push("rent hike");
  assert.equal(actingHash(c2), before, "appendix edits must not move acting_hash");
  assert.notEqual(cardHash(c2), cardHash(CARD), "full hash must move");
});

test("tampering with the body is detected", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  const tampered = md.replace("**Name:** Santino's Pizza", "**Name:** Santino's Pizzas");
  assert.notEqual(tampered, md);
  const v = verifyCardMd(tampered);
  assert.equal(v.ok, false);
  assert.match(v.reason, /hash mismatch/);
});

test("tampering with acting_hash is detected", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  const tampered = md.replace(
    /^acting_hash: sha256:[0-9a-f]+$/m, "acting_hash: sha256:" + "0".repeat(64));
  const v = verifyCardMd(tampered);
  assert.equal(v.ok, false);
  assert.match(v.reason, /acting_hash mismatch/);
});

test("version chain (previous_version / previous_hash) survives a bump", () => {
  const v2 = JSON.parse(JSON.stringify(CARD));
  v2.id = "dna_test0002";
  v2.version = 2;
  v2.previous_version = 1;
  v2.previous_hash = PY_HASH;
  v2.operations.hours = "Mon–Fri 11am–10pm";
  const md = emitCardMd(v2, CHANGELOG.concat(["**v2** (2026-10-01T01:00:00Z): hours updated (receipt rcpt_x)"]));
  const p = parseCardMd(md);
  assert.equal(p.frontmatter.previous_version, "1");
  assert.equal(p.frontmatter.previous_hash, "sha256:" + PY_HASH);
  assert.equal(p.card.previous_version, 1);
  assert.equal(p.card.previous_hash, PY_HASH);
  assert.equal(p.card.operations.hours, "Mon–Fri 11am–10pm");
  assert.equal(verifyCardMd(md).ok, true);
});

test("round-trip: sound section (assets + staged briefs) survives", () => {
  const c = JSON.parse(JSON.stringify(CARD));
  c.voice.sonic = {
    sonic_logo: {
      description: "Wooden knock, then a warm muted tone",
      asset_ref: null,
      duration_s: 4,
    },
    voice_logo: {
      script: "Welcome to Santino's Pizza. Family owned and operated since 1970.",
      voice_profile: "avocado_v2:MAI_03",
      asset_ref: "sha256:" + "b".repeat(64),
    },
    ui_sounds: [
      { name: "notification", description: "Soft wooden knock", asset_ref: null },
      { name: "success", description: "Two rising notes", asset_ref: "sha256:" + "c".repeat(64) },
      { name: "error", description: "One low rounded tone", asset_ref: null },
    ],
  };
  const md = emitCardMd(c, CHANGELOG);
  assert.match(md, /```yaml/);
  assert.match(md, /voice_logo: \{state: ready/);
  assert.match(md, /logo: \{state: staged/);
  const v = verifyCardMd(md);
  assert.equal(v.ok, true, v.reason);
  const p = parseCardMd(md);
  assert.deepEqual(p.card.voice.sonic, c.voice.sonic);
});

test("round-trip: null price stays null, never invented", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  assert.match(md, /\*\*Classic Cheese Pizza\*\* · kind: pizza · orderable: yes · price: null · confidence: 0.8/);
  assert.match(md, /\*\*Pepperoni Pizza\*\* · kind: pizza · orderable: yes · price: null · confidence: 0.7/);
  const p = parseCardMd(md);
  assert.equal(p.card.offerings[0].price, null);
  assert.equal(p.card.offerings[1].price, null);
});

test("sound states follow asset existence", () => {
  const c = JSON.parse(JSON.stringify(CARD));
  c.voice.sonic = {
    voice_logo: { script: "Welcome.", voice_profile: "v1", asset_ref: "sha256:" + "d".repeat(64) },
  };
  const md = emitCardMd(c, CHANGELOG);
  assert.match(md, /voice_logo: \{state: ready/);
  assert.match(md, /logo: \{state: staged\}/);
});

// ── Anchor 3-state tests ──────────────────────────────────────────────────────

test("anchor state: offering@1 is accepted and trusted over prose", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  // Emitter must write versioned anchors.
  assert.match(md, /<!-- machine:offering@1 \{/);
  // Parser must read them back into the correct fields.
  const p = parseCardMd(md);
  assert.equal(p.card.offerings[0].name, "Classic Cheese Pizza");
  assert.equal(p.card.offerings[0].price, null);
  // Anchor parse state lives on anchorProvenance, NOT card.field_provenance (would change hash).
  assert.equal(p.anchorProvenance?.["offerings[0]"]?.state, "anchored");
  assert.equal(p.anchorProvenance?.["offerings[0]"]?.anchor_version, 1);
  assert.equal(p.anchorErrors, undefined);
});

test("anchor state: unknown offering version is a hard error", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  const future = md.replace(/machine:offering@1/g, "machine:offering@99");
  assert.throws(
    () => parseCardMd(future),
    /offering anchor version 99 is unknown/,
    "unknown version must throw, not silently degrade"
  );
});

test("anchor state: anchor_missing triggers hard error when prev version had anchors", () => {
  // Simulate a file where all offering anchors have been deleted.
  const md = emitCardMd(CARD, CHANGELOG);
  const stripped = md.replace(/^<!-- machine:offering@\d+ .*-->$/gm, "");
  // Previous provenance records anchored offerings.
  const prevProvenance: Record<string, any> = {
    "offerings[0]": { state: "anchored", anchor_version: 1 },
    "offerings[1]": { state: "anchored", anchor_version: 1 },
  };
  const result = parseCardMd(stripped, { prevProvenance });
  assert.ok(result.anchorErrors && result.anchorErrors.length > 0,
    "anchor_missing must surface as anchorErrors");
  assert.match(result.anchorErrors![0], /anchor_missing: offerings\[0\]/);
});

test("anchor state: prose-only offering is inferred with queued_for_confirmation", () => {
  // A hand-written card with no anchors and no previous provenance.
  const bare = [
    "---",
    "format: business-card/0.1",
    "id: dna_hand001",
    "version: 1",
    "previous_hash: none",
    "hash: sha256:" + "0".repeat(64),
    "acting_hash: sha256:" + "0".repeat(64),
    "organization_id: org_x",
    "status: draft",
    "updated: 2026-10-04T00:00:00Z",
    "---",
    "",
    "# Hand Written",
    "",
    "## Offer",
    "- **Wood-Fired Margherita** · kind: pizza · price: null · confidence: 0.5",
    "",
  ].join("\n");
  const p = parseCardMd(bare);
  assert.equal(p.card.offerings?.[0]?.name, "Wood-Fired Margherita");
  assert.equal(p.card.field_provenance?.["offerings[0]"]?.state, "inferred");
  assert.equal(p.card.field_provenance?.["offerings[0]"]?.queued_for_confirmation, true);
});

// ── voice_dont 3-state tests ─────────────────────────────────────────────────

test("anchor state: voice_dont@1 is accepted and trusted over prose", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  assert.match(md, /<!-- machine:voice_dont@1 \{/);
  const p = parseCardMd(md);
  assert.equal(p.card.voice.donts[0], "No corporate speak");
  assert.equal(p.anchorProvenance?.["voice.donts[0]"]?.state, "anchored");
  assert.equal(p.anchorProvenance?.["voice.donts[0]"]?.anchor_version, 1);
  assert.equal(p.anchorErrors, undefined);
});

test("anchor state: unknown voice_dont version is a hard error", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  const future = md.replace(/machine:voice_dont@1/g, "machine:voice_dont@99");
  assert.throws(
    () => parseCardMd(future),
    /voice_dont anchor version 99 is unknown/,
  );
});

// ── Policy 3-state tests ──────────────────────────────────────────────────────

test("anchor state: policy@1 is accepted and trusted over prose", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  assert.match(md, /<!-- machine:policy@1 \{/);
  const p = parseCardMd(md);
  assert.equal(p.card.policies[0].topic, "Refunds");
  assert.equal(p.card.policies[0].rule, "ask-human");
  assert.equal(p.anchorProvenance?.["policies[0]"]?.state, "anchored");
  assert.equal(p.anchorProvenance?.["policies[0]"]?.anchor_version, 1);
  assert.equal(p.anchorErrors, undefined);
});

test("anchor state: unknown policy version is a hard error", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  const future = md.replace(/machine:policy@1/g, "machine:policy@99");
  assert.throws(
    () => parseCardMd(future),
    /policy anchor version 99 is unknown/,
  );
});

// ── hour + channel 3-state tests ─────────────────────────────────────────────

test("anchor state: hour@1 is accepted and trusted over prose", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  assert.match(md, /<!-- machine:hour@1 \{/);
  const p = parseCardMd(md);
  assert.equal(p.card.operations.hours, "Mon–Fri 11am–9pm");
  assert.equal(p.anchorProvenance?.["operations.hours[0]"]?.state, "anchored");
  assert.equal(p.anchorProvenance?.["operations.hours[0]"]?.anchor_version, 1);
  assert.equal(p.anchorErrors, undefined);
});

test("anchor state: unknown hour version is a hard error", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  const future = md.replace(/machine:hour@1/g, "machine:hour@99");
  assert.throws(
    () => parseCardMd(future),
    /hour anchor version 99 is unknown/,
  );
});

test("anchor state: channel@1 is accepted and trusted over prose", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  assert.match(md, /<!-- machine:channel@1 \{/);
  const p = parseCardMd(md);
  assert.equal(p.card.operations.channels[0], "phone");
  assert.equal(p.anchorProvenance?.["operations.channels[0]"]?.state, "anchored");
  assert.equal(p.anchorProvenance?.["operations.channels[0]"]?.anchor_version, 1);
  assert.equal(p.anchorErrors, undefined);
});

test("anchor state: unknown channel version is a hard error", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  const future = md.replace(/machine:channel@1/g, "machine:channel@99");
  assert.throws(
    () => parseCardMd(future),
    /channel anchor version 99 is unknown/,
  );
});

// ── Knowledge 3-state tests ───────────────────────────────────────────────────

test("anchor state: knowledge@1 is accepted and trusted over prose", () => {
  const md = emitCardMd(CARD, CHANGELOG);
  assert.match(md, /<!-- machine:knowledge@1 \{/);
  const p = parseCardMd(md);
  assert.equal(p.card.knowledge[0].title, "Menu");
  assert.equal(p.card.knowledge[0].ref, "https://santinospizzanj.com/menu");
  assert.equal(p.anchorProvenance?.["knowledge[0]"]?.state, "anchored");
  assert.equal(p.anchorProvenance?.["knowledge[0]"]?.anchor_version, 1);
  assert.equal(p.anchorErrors, undefined);
});
