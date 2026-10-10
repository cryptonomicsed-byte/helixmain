/**
 * cli-changelog.test.ts — the compiler owns the version changelog.
 *
 * An empty CHANGELOG.json beside a real previous_hash is half a chain. These
 * tests drive the real CLI: compile v1, then v2 into the SAME --out dir, and
 * assert the changelog carries forward with a line for the new version, that the
 * hash chain links, that CARD.md still verifies, and that re-compiling the SAME
 * version does not invent a second entry.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CLI = path.join(__dirname, "..", "cli.js");

function run(args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cli-changelog-"));
}

function card(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "test0001",
    version: 1,
    organization_id: "org_test",
    status: "draft",
    // created_at + previous_version are part of the card contract: the parser
    // materialises both, so the hashed view and the parsed view only agree when
    // the card carries them (previous_version is explicitly null on v1).
    created_at: "2026-10-01T00:00:00Z",
    previous_version: null,
    identity: { name: "Test Shop", type: "service" },
    voice: { tone: ["warm"], personality: "Friendly and helpful." },
    offerings: [{ name: "Haircut", kind: "service", orderable: true, price: null, confidence: 0.6 }],
    operations: { channels: ["phone"], pipeline_stages: ["new", "contacted", "converted"] },
    policies: [{ topic: "refunds", rule: "Ask the manager." }],
    knowledge: [{ title: "About Test Shop", ref: "", kind: "general", chunks: 1 }],
    ...over,
  };
}

function hashOf(dir: string): string {
  const md = fs.readFileSync(path.join(dir, "CARD.md"), "utf8");
  return md.match(/^hash: sha256:([0-9a-f]{64})$/m)![1];
}

test("a first compile writes an empty changelog and verifies", () => {
  const dir = tmpDir();
  const v1 = path.join(dir, "v1.json");
  fs.writeFileSync(v1, JSON.stringify(card()));
  run(["--card", v1, "--out", dir]);

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "CHANGELOG.json"), "utf8")), []);
  assert.match(run(["--verify-md", "--md", path.join(dir, "CARD.md")]), /^OK /);
});

test("a version bump appends exactly one changelog line and chains the hash", () => {
  const dir = tmpDir();
  const v1 = path.join(dir, "v1.json");
  fs.writeFileSync(v1, JSON.stringify(card()));
  run(["--card", v1, "--out", dir]);
  const v1hash = hashOf(dir);

  const v2 = path.join(dir, "v2.json");
  fs.writeFileSync(
    v2,
    JSON.stringify(card({ version: 2, previous_version: 1, previous_hash: v1hash, identity: { name: "Test Shop & Co", type: "service" } }))
  );
  run(["--card", v2, "--out", dir]);

  const cl = JSON.parse(fs.readFileSync(path.join(dir, "CHANGELOG.json"), "utf8"));
  assert.equal(cl.length, 1);
  assert.match(cl[0], /\*\*v2\*\*/);

  const md = fs.readFileSync(path.join(dir, "CARD.md"), "utf8");
  assert.match(md, new RegExp("previous_hash: sha256:" + v1hash));
  assert.match(md, /\*\*v2\*\*/); // the line reaches CARD.md, not just the JSON
  assert.match(run(["--verify-md", "--md", path.join(dir, "CARD.md")]), /^OK /);
});

test("re-compiling the same version does not invent a changelog entry", () => {
  const dir = tmpDir();
  const v1 = path.join(dir, "v1.json");
  fs.writeFileSync(v1, JSON.stringify(card()));
  run(["--card", v1, "--out", dir]);
  run(["--card", v1, "--out", dir]); // same version again

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "CHANGELOG.json"), "utf8")), []);
});

test("a caller-supplied changelog is carried, not discarded", () => {
  const dir = tmpDir();
  const clPath = path.join(dir, "given.json");
  fs.writeFileSync(clPath, JSON.stringify(["**v1** (seed): imported"]));
  const v1 = path.join(dir, "v1.json");
  fs.writeFileSync(v1, JSON.stringify(card()));
  run(["--card", v1, "--out", dir, "--changelog", clPath]);

  const cl = JSON.parse(fs.readFileSync(path.join(dir, "CHANGELOG.json"), "utf8"));
  assert.deepEqual(cl, ["**v1** (seed): imported"]);
});

test("a card with no timestamp round-trips — 'undefined' is never written", () => {
  const dir = tmpDir();
  const v1 = path.join(dir, "v1.json");
  const c = card();
  delete (c as Record<string, unknown>).created_at; // no timestamp at all
  fs.writeFileSync(v1, JSON.stringify(c));
  run(["--card", v1, "--out", dir]);

  const md = fs.readFileSync(path.join(dir, "CARD.md"), "utf8");
  // the old emitter wrote `updated: undefined`, which parsed back as the string
  assert.doesNotMatch(md, /^updated: undefined$/m);
  assert.match(run(["--verify-md", "--md", path.join(dir, "CARD.md")]), /^OK /);
});
