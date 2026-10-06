#!/usr/bin/env node
/** CLI: compile a DNA card JSON into artifacts, verify/parse CARD.md, patch sound. */
const fs = require("fs");
const path = require("path");
const { compileCard, diffCards, emitCardMd, parseCardMd, verifyCardMd, canonicalJson, confirmAnchors, compileOpenshellPolicy, emitOpenshellPolicyYaml } = require("./index");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

/**
 * OpenShell sandbox runtime config — the endpoints the sandboxed agent may reach.
 *
 * Frozen contract: hold queue is 127.0.0.1:9100, path /invoke (the SparkGatekeeper
 * sidecar). Pass `--runtime <runtime.json>` to override wholesale, or set the
 * OPEN_SHELL_* env vars. Endpoints left null emit no rule at all — the compiler
 * never invents a host, so an unset inference/pocketbase means no egress there.
 */
function openshellRuntime() {
  const p = arg("--runtime");
  if (p) return JSON.parse(fs.readFileSync(p, "utf8"));
  const host = process.env.OPEN_SHELL_HOLD_QUEUE_HOST || "127.0.0.1";
  const port = Number(process.env.OPEN_SHELL_HOLD_QUEUE_PORT || 9100);
  const ep = (h, p2, dflt) =>
    process.env[h] ? { host: process.env[h], port: Number(process.env[p2] || dflt) } : null;
  return {
    agentBinaryPath: process.env.OPEN_SHELL_AGENT_BINARY || "/usr/local/bin/zeroclaw",
    holdQueue: { host, port, path: "/invoke" },
    inference: ep("OPEN_SHELL_INFERENCE_HOST", "OPEN_SHELL_INFERENCE_PORT", 443),
    pocketbase: ep("OPEN_SHELL_POCKETBASE_HOST", "OPEN_SHELL_POCKETBASE_PORT", 8090),
  };
}

const cardPath = arg("--card");
const outDir = arg("--out");
const diffPath = arg("--diff");

const mdPath = arg("--md");
const changelogPath = arg("--changelog");
const patchPath = arg("--patch");
const changelogLine = arg("--changelog-line");

if (process.argv.includes("--verify-md")) {
  if (!mdPath) { console.error("usage: compile --verify-md --md <CARD.md>"); process.exit(1); }
  const v = verifyCardMd(fs.readFileSync(mdPath, "utf8"));
  console.log(v.ok ? "OK " + v.reason : "FAIL " + v.reason);
  process.exit(v.ok ? 0 : 2);
}

if (process.argv.includes("--parse-md")) {
  if (!mdPath) { console.error("usage: compile --parse-md --md <CARD.md>"); process.exit(1); }
  const v = verifyCardMd(fs.readFileSync(mdPath, "utf8"));
  if (!v.ok) { console.error("refusing to parse: " + v.reason); process.exit(2); }
  console.log(JSON.stringify(v.card, null, 2));
  process.exit(0);
}

if (process.argv.includes("--roundtrip")) {
  if (!cardPath) { console.error("usage: compile --roundtrip --card <card.json> [--changelog <cl.json>]"); process.exit(1); }
  const card = JSON.parse(fs.readFileSync(cardPath, "utf8"));
  const cl = changelogPath ? JSON.parse(fs.readFileSync(changelogPath, "utf8")) : [];
  const md = emitCardMd(card, cl);
  const v = verifyCardMd(md);
  const parsed = parseCardMd(md);
  const strip = (c) => { const b = {}; for (const k of Object.keys(c)) { if (k !== "hash" && !k.startsWith("_")) b[k] = c[k]; } return b; };
  const same = canonicalJson(strip(parsed.card)) === canonicalJson(strip(card)) && parsed.card.hash === card.hash;
  const out = { ok: v.ok && same, hash_verified: v.ok, fields_match: same,
    field_count: Object.keys(strip(card)).length, reason: v.reason };
  console.log(JSON.stringify(out, null, 2));
  process.exit(v.ok && same ? 0 : 2);
}

/**
 * patch-sound: surgical Sound-section mutation for the sonic-brand skill.
 * Parses CARD.md, applies a voice.sonic-shaped patch, bumps version,
 * chains previous_hash, recomputes hash + acting_hash, appends a changelog
 * line, and writes the file back in place. Touches nothing else.
 */
if (process.argv.includes("--patch-sound")) {
  if (!mdPath || !patchPath) {
    console.error("usage: compile --patch-sound --md <CARD.md> --patch <sound-patch.json> [--changelog-line <text>]");
    process.exit(1);
  }
  const raw = fs.readFileSync(mdPath, "utf8");
  const v = verifyCardMd(raw);
  if (!v.ok) { console.error("refusing to patch unverified card: " + v.reason); process.exit(2); }
  const { card, changelog, frontmatter } = parseCardMd(raw);
  const patch = JSON.parse(fs.readFileSync(patchPath, "utf8"));
  const oldHash = frontmatter.hash;

  // Restricted mutation: Sound only (voice.sonic). Identity and Voice may be
  // read to build briefs, but nothing else on the card may change here.
  card.voice = card.voice || {};
  const sonic = (card.voice.sonic = card.voice.sonic || {});
  for (const k of ["voice_logo", "sonic_logo", "ui_sounds"]) {
    if (patch[k] === undefined || patch[k] === null) continue;
    if (k === "ui_sounds") {
      const cur = Array.isArray(sonic.ui_sounds) ? sonic.ui_sounds : [];
      const incoming = Array.isArray(patch.ui_sounds)
        ? patch.ui_sounds
        : Object.entries(patch.ui_sounds || {}).map(([name, v]) => ({
            name, ...(typeof v === "string" ? { description: v } : v),
          }));
      for (const t of incoming) {
        const i = cur.findIndex((x) => x && x.name === t.name);
        if (i >= 0) cur[i] = { ...t }; else cur.push({ ...t });
      }
      sonic.ui_sounds = cur;
      continue;
    }
    sonic[k] = typeof patch[k] === "string" ? { brief: patch[k] } : { ...patch[k] };
  }
  if (patch.provenance) {
    card.field_provenance = card.field_provenance || {};
    card.field_provenance["voice.sonic"] = patch.provenance;
  }
  card.previous_version = card.version;
  card.version = (card.version || 0) + 1;
  card.previous_hash = oldHash.replace(/^sha256:/, "");
  const now = new Date().toISOString();
  const line = changelogLine || patch.changelog ||
    `**v${card.version}** (${now}): sound section patched (sonic-brand)`;
  const md = emitCardMd(card, changelog.concat([line]));
  const v2 = verifyCardMd(md);
  if (!v2.ok) { console.error("patch produced invalid card: " + v2.reason); process.exit(2); }
  fs.writeFileSync(mdPath, md);
  const newHash = md.match(/^hash: (sha256:[0-9a-f]+)$/m)[1];
  console.log(`patched ${card.id} -> v${card.version} (${oldHash.slice(7, 19)}... -> ${newHash.slice(7, 19)}...)`);
  process.exit(0);
}

/**
 * confirm-anchors: promote all inferred fields to anchored state.
 * Writes anchor comments inline; recomputes hash from the clean card object.
 * No version bump — data is unchanged, only the anchor provenance changes.
 * Refuses if anchor_missing errors are present (anchors were deleted).
 */
if (process.argv.includes("--confirm-anchors")) {
  if (!mdPath) {
    console.error("usage: compile --confirm-anchors --md <CARD.md>");
    process.exit(1);
  }
  const raw = fs.readFileSync(mdPath, "utf8");
  let result;
  try {
    result = confirmAnchors(raw);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const v = verifyCardMd(result.md);
  if (!v.ok) { console.error("confirm produced invalid card: " + v.reason); process.exit(2); }
  fs.writeFileSync(mdPath, result.md);
  if (result.promoted.length === 0) {
    console.log("no inferred fields found — card already fully anchored");
  } else {
    console.log(`confirmed ${result.promoted.length} field(s): ${result.promoted.join(", ")}`);
    console.log(`hash: ${result.oldHash.slice(7, 19)}... -> ${result.newHash.slice(7, 19)}...`);
  }
  process.exit(0);
}

if (!cardPath) {
  console.error("usage: compile --card <card.json> --out <dir> [--diff <other-card.json>] [--changelog <cl.json>]");
  console.error("       compile --verify-md --md <CARD.md>");
  console.error("       compile --parse-md --md <CARD.md>");
  console.error("       compile --roundtrip --card <card.json> [--changelog <cl.json>]");
  console.error("       compile --patch-sound --md <CARD.md> --patch <sound-patch.json> [--changelog-line <text>]");
  console.error("       compile --confirm-anchors --md <CARD.md>");
  process.exit(1);
}

const card = JSON.parse(fs.readFileSync(cardPath, "utf8"));

if (diffPath) {
  const other = JSON.parse(fs.readFileSync(diffPath, "utf8"));
  console.log(JSON.stringify(diffCards(card, other), null, 2));
  process.exit(0);
}

const cl = changelogPath ? JSON.parse(fs.readFileSync(changelogPath, "utf8")) : [];
const compiled = compileCard(card, new Date().toISOString(), cl, openshellRuntime());

if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "system-prompt.md"), compiled.systemPrompt);
  fs.writeFileSync(path.join(outDir, "policy-seed.json"), JSON.stringify(compiled.policySeed, null, 2));
  fs.writeFileSync(path.join(outDir, "tool-allowlist.json"), JSON.stringify(compiled.toolAllowlist, null, 2));
  fs.writeFileSync(path.join(outDir, "rag-manifest.json"), JSON.stringify(compiled.ragManifest, null, 2));
  fs.writeFileSync(path.join(outDir, "dna-fields-used.json"), JSON.stringify(compiled.dnaFieldsUsed, null, 2));
  fs.writeFileSync(path.join(outDir, "CARD.md"), compiled.cardMd);
  fs.writeFileSync(path.join(outDir, "CHANGELOG.json"), JSON.stringify(cl, null, 2));
  // card.compile_openshell_policy -> the sandbox egress/landlock policy OpenShell consumes.
  // The policy object came out of compileCard (one call, no double compute); the
  // CLI only serialises it. Deterministic: same card + runtime -> byte-identical YAML.
  fs.writeFileSync(
    path.join(outDir, "openshell-policy.yaml"),
    emitOpenshellPolicyYaml(compiled.openshellPolicy)
  );
  for (const [rel, content] of Object.entries(compiled.hugoSite)) {
    const full = path.join(outDir, "hugo", rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  console.log(`compiled ${card.id} v${card.version} -> ${outDir}`);
} else {
  console.log(compiled.systemPrompt);
}
