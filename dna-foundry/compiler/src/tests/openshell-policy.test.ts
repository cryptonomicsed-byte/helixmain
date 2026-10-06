import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileOpenshellPolicy,
  actingHash,
  type SandboxRuntimeConfig,
} from "../index.js";

// Confirmed card: the same Santino's Pizza fixture the 14/14 suite compiles.
// Minimal shape the policy compiler reads: id, version, acting sections.
const CARD = {
  id: "dna_test0001",
  version: 1,
  identity: { name: "Santino's Pizza" },
  voice: { tone: ["warm"] },
  offerings: [{ name: "Classic Cheese Pizza" }],
  operations: { channels: ["phone"] },
  policies: [{ topic: "refunds", rule: "Ask for the manager on duty — handled case by case." }],
  knowledge: [],
  field_provenance: {},
};

const RUNTIME: SandboxRuntimeConfig = {
  agentBinaryPath: "/usr/local/bin/zeroclaw",
  holdQueue: { host: "127.0.0.1", port: 9100 },
  inference: { host: "openrouter.ai", port: 443, path: "/api/*" },
  pocketbase: { host: "127.0.0.1", port: 8090 },
};

test("policy binds card identity and acting hash", () => {
  const out = compileOpenshellPolicy(CARD, RUNTIME);
  assert.equal(out.card_id, "dna_test0001");
  assert.equal(out.card_version, 1);
  assert.equal(out.acting_hash, actingHash(CARD));
  assert.match(out.acting_hash, /^[0-9a-f]{64}$/);
});

test("policy matches the real OpenShell PolicyDocument schema", () => {
  const { policy } = compileOpenshellPolicy(CARD, RUNTIME);
  assert.equal(policy.version, 1);
  const topKeys = Object.keys(policy).sort();
  assert.deepEqual(topKeys, [
    "filesystem_policy",
    "landlock",
    "network_policies",
    "process",
    "version",
  ]);
  assert.equal(policy.landlock.compatibility, "hard_requirement");
  assert.equal(policy.process.run_as_user, "agent");
});

test("egress allowlist is exactly the declared endpoints", () => {
  const { policy } = compileOpenshellPolicy(CARD, RUNTIME);
  const keys = Object.keys(policy.network_policies).sort();
  assert.deepEqual(keys, ["hold_queue_sidecar", "inference", "pocketbase"]);
  const hq = policy.network_policies.hold_queue_sidecar;
  // Frozen contract: the SparkGatekeeper sidecar serves POST /invoke on 9100
  // (sidecar.rs), not an /mcp/* mount — the sidecar IS the path to the tool bus.
  assert.deepEqual(hq.endpoints, [{ host: "127.0.0.1", port: 9100, path: "/invoke" }]);
  assert.deepEqual(hq.binaries, [{ path: "/usr/local/bin/zeroclaw" }]);
});

test("null endpoint stays null — never invented", () => {
  const out = compileOpenshellPolicy(CARD, { ...RUNTIME, inference: null });
  assert.ok(!("inference" in out.policy.network_policies));
  assert.deepEqual(Object.keys(out.policy.network_policies).sort(), [
    "hold_queue_sidecar",
    "pocketbase",
  ]);
});

test("policy is deterministic", () => {
  const a = JSON.stringify(compileOpenshellPolicy(CARD, RUNTIME));
  const b = JSON.stringify(
    compileOpenshellPolicy(JSON.parse(JSON.stringify(CARD)), RUNTIME)
  );
  assert.equal(a, b);
});

test("missing card id or binary path throws", () => {
  assert.throws(() => compileOpenshellPolicy({}, RUNTIME), /card\.id is required/);
  assert.throws(
    () => compileOpenshellPolicy(CARD, { ...RUNTIME, agentBinaryPath: "" }),
    /agentBinaryPath is required/
  );
});
