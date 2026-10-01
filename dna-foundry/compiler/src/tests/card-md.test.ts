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

const PY_HASH = "b106a05d0cccd45bfa836d58e29247ef082b4a6c974ddd26bd99b3d459f836bc";
const PY_ACTING_HASH = "38b4033a969612265050d866ebd83d32b327ee39ce68b89a4c4da8aba05ba3e7";

const CARD = {
  id: "dna_test0001",
  organization_id: "org_demo0001",
  version: 1,
  previous_version: null,
  status: "draft",
  created_at: "2026-10-01T00:00:00Z",
  identity: {
    name: "Harbor & Bean Coffee House",
    tagline: "A cozy neighborhood coffee house — small-batch roasts.",
    elevator_pitch: "Small-batch roasts on the harbor, poured by people who know your name.",
    location: "42 Harbor Lane, Seaside",
    phone: "(555) 010-2030",
    email: "hello@harborandbean.example",
    timezone: "America/New_York",
    website: "https://harborandbean.example",
  },
  voice: {
    tone: ["warm", "playful"],
    personality: "The barista who remembers your order.",
    sample_phrases: ["Your cozy corner on the harbor", "Small-batch, big welcome"],
    donts: ["No corporate speak"],
    lexicon_use: ["cozy", "small-batch"],
    lexicon_never: ["synergy", "leverage"],
  },
  offerings: [
    { name: "Espresso", kind: "drink", orderable: true, price: null, confidence: 0.8 },
    { name: "Pour over", kind: "drink", orderable: true, price: 4.5, confidence: 0.7 },
  ],
  operations: {
    hours: "Mon–Fri 7am–3pm",
    channels: ["phone", "email"],
    delivery_fence: "Seaside downtown",
    human_confirm: ["catering"],
  },
  policies: [{ topic: "Refunds", rule: "ask-human" }],
  handoff: {
    open_hours: "phone (555) 010-2030",
    channel: "phone",
    after_hours: "take a message",
  },
  knowledge: [{ title: "Menu", ref: "https://harborandbean.example/menu", kind: "page", chunks: 4 }],
  strategy: {
    positioning: "The third place on Harbor Lane",
    swot: { strengths: ["Regulars"], threats: ["Chain across the street"] },
  },
  customers: {
    personas: [{ name: "Mara R.", description: "Remote worker", inferred: true }],
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
  acting_hash: "38b4033a969612265050d866ebd83d32b327ee39ce68b89a4c4da8aba05ba3e7",
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
  const tampered = md.replace("**Name:** Harbor & Bean Coffee House", "**Name:** Harbor & Beans Coffee House");
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
  v2.operations.hours = "Mon–Fri 7am–5pm";
  const md = emitCardMd(v2, CHANGELOG.concat(["**v2** (2026-10-01T01:00:00Z): hours updated (receipt rcpt_x)"]));
  const p = parseCardMd(md);
  assert.equal(p.frontmatter.previous_version, "1");
  assert.equal(p.frontmatter.previous_hash, "sha256:" + PY_HASH);
  assert.equal(p.card.previous_version, 1);
  assert.equal(p.card.previous_hash, PY_HASH);
  assert.equal(p.card.operations.hours, "Mon–Fri 7am–5pm");
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
      script: "Welcome to Harbor and Bean Coffee House. Small-batch roasts in Seaside.",
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
  assert.match(md, /\*\*Espresso\*\* · kind: drink · orderable: yes · price: null · confidence: 0.8/);
  const p = parseCardMd(md);
  assert.equal(p.card.offerings[0].price, null);
  assert.equal(p.card.offerings[1].price, 4.5);
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
