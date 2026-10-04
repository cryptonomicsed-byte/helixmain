/** Snapshot tests for the deterministic compiler. Run: npm test */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { compileCard, diffCards } = require("../index");
import type { PolicyRule, CardDiff } from "../index";

const FIXTURE = {
  id: "dna_test0001",
  organization_id: "org_demo0001",
  version: 1,
  previous_version: null,
  status: "draft",
  created_at: "2026-10-01T00:00:00Z",
  hash: "0".repeat(64),
  identity: {
    name: "Santino's Pizza",
    tagline: "Family owned and operated since 1970.",
    mission: "Feed our neighbors like family.",
    values: ["family first", "hand-tossed, never rushed"],
    location: "499 Ernston Rd, Parlin, NJ 08859",
    phone: "(732) 721-3163",
  },
  voice: {
    tone: ["warm", "familial"],
    sample_phrases: ["Family owned since 1970"],
    donts: ["Never sound corporate."],
  },
  offerings: [{ name: "Classic Cheese Pizza" }, { name: "Pepperoni Pizza" }],
  operations: { hours: "Mon–Fri 11am–9pm", channels: ["phone"] },
  policies: [
    { topic: "refunds", rule: "Ask for the manager on duty — handled case by case." },
    { topic: "privacy", rule: "We never sell your personal information." },
  ],
  insights: [{ title: "Review themes", detail: "Service and coziness dominate.", evidence: [] }],
  knowledge: [{ ref: "faq", kind: "faq", title: "FAQ", chunks: 2 }],
  competitors: [],
  field_provenance: {
    "identity.name": { sources: ["index"], confidence: 0.85, extracted_at: "2026-10-01T00:00:00Z", extractor_agent: "extractor:website" },
    policies: { sources: ["policies"], confidence: 0.65, extracted_at: "2026-10-01T00:00:00Z", extractor_agent: "extractor:documents" },
  },
};

const SNAP_DIR = path.join(__dirname, "__snapshots__");

test("compile is deterministic and matches snapshot", () => {
  const a = compileCard(FIXTURE, "2026-10-01T00:00:00.000Z");
  const b = compileCard(JSON.parse(JSON.stringify(FIXTURE)), "2026-10-01T00:00:00.000Z");
  assert.equal(JSON.stringify(a), JSON.stringify(b), "same card must compile byte-identically");
  // policy seed must not depend on wall-clock for rule content
  const snapFile = path.join(SNAP_DIR, "compile.json");
  const snap = JSON.stringify(a, null, 2);
  if (process.env.UPDATE_SNAPSHOTS) fs.writeFileSync(snapFile, snap);
  assert.equal(snap, fs.readFileSync(snapFile, "utf8"), "snapshot mismatch");
});

test("refund policy maps to approval_required", () => {
  const { policySeed } = compileCard(FIXTURE);
  const refund = policySeed.rules.find((r: PolicyRule) => r.topic === "refunds");
  assert.equal(refund.verdict, "approval_required");
  assert.equal(refund.risk, "high");
});

test("tool allowlist follows declared channels", () => {
  const { toolAllowlist } = compileCard(FIXTURE);
  const tools = toolAllowlist.tools.map((t: { tool: string }) => t.tool);
  assert.ok(tools.includes("telephony.place_call"), "phone channel -> telephony tool");
  assert.ok(!tools.includes("email.send"), "no email channel -> no email tool");
  assert.ok(tools.includes("kb.search"), "kb.search always present");
  assert.ok(!tools.includes("social.post"), "no social channel -> no social tool");
});

test("diff detects field-level changes", () => {
  const v2 = JSON.parse(JSON.stringify(FIXTURE));
  v2.version = 2;
  v2.operations.hours = "Mon–Fri 8am–4pm";
  v2.offerings.push({ name: "New Pastry" });
  const d = diffCards(FIXTURE, v2);
  assert.equal(d.from_version, 1);
  assert.equal(d.to_version, 2);
  assert.ok(d.changed.some((c: CardDiff["changed"][number]) => c.path === "operations.hours"));
  assert.ok(d.added.some((p: string) => p.startsWith("offerings[2]")));
});
