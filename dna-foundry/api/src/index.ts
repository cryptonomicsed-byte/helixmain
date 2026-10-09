/**
 * Helix DNA Foundry API (Fastify).
 *
 * Thin orchestration over the real workers:
 *  - extraction jobs spawn the Python swarm (swarm/orchestrator.py)
 *  - compile/diff shell to the deterministic TS compiler
 *
 * The API owns no extraction or compilation logic — it schedules and serves.
 */
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import Fastify from "fastify";
import { extractor } from "./services/extractor";
import { agentCompiler, AgentRole } from "./services/agentCompiler";
import { compileGreeting } from "./services/greetingCompiler";

const app = Fastify({ logger: true });
const ROOT = path.resolve(__dirname, "..", "..");
const DATA = path.join(ROOT, "api", "data");
const CARDS = path.join(DATA, "cards");
const JOBS = path.join(DATA, "jobs");
const COMPILED = path.join(ROOT, "compiled");
const COMPILER_CLI = path.join(ROOT, "compiler", "dist", "cli.js");
const ORCHESTRATOR = path.join(ROOT, "swarm", "orchestrator.py");

async function ensureDirs() {
  for (const d of [CARDS, JOBS, COMPILED]) await fs.mkdir(d, { recursive: true });
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

async function findCard(cardId: string): Promise<string | null> {
  const files = await fs.readdir(CARDS).catch(() => []);
  const hits = files.filter((f) => f.startsWith(cardId)).sort();
  return hits.length ? path.join(CARDS, hits[hits.length - 1]) : null;
}

app.get("/health", async () => ({ ok: true, service: "dna-foundry" }));

app.post("/extract", async (req, reply) => {
  const body = (req.body ?? {}) as { url?: string; orgId?: string };
  if (!body.url) return reply.code(400).send({ ok: false, error: "url required" });
  if (!body.orgId) return reply.code(400).send({ ok: false, error: "orgId required" });

  const card = await extractor.extractCard({ url: body.url, orgId: body.orgId });

  await ensureDirs();
  const cardFile = path.join(CARDS, `${card.id}.json`);
  await fs.writeFile(cardFile, JSON.stringify(card, null, 2));

  return reply.code(200).send(card);
});

app.post("/jobs", async (req, reply) => {
  const body = (req.body ?? {}) as { url?: string; organization_id?: string };
  if (!body.url) return reply.code(400).send({ ok: false, error: "url required" });
  const org = body.organization_id ?? "org_demo0001";
  const jobId = `job_${Date.now().toString(36)}`;
  const jobFile = path.join(JOBS, `${jobId}.json`);
  const job = { id: jobId, status: "running", url: body.url, organization_id: org, card_id: null as string | null };
  await fs.writeFile(jobFile, JSON.stringify(job));
  // fire-and-forget: the swarm does the work, the job record tracks it
  run("python3", [ORCHESTRATOR, "extract", "--url", body.url, "--org", org, "--out", CARDS])
    .then(async ({ code, out, err }) => {
      const done = code === 0;
      const cardPath = done ? out.trim().split("\n").pop()! : null;
      let cardId: string | null = null;
      if (cardPath) {
        try {
          cardId = JSON.parse(await fs.readFile(cardPath, "utf8")).id;
        } catch { /* leave null */ }
      }
      await fs.writeFile(jobFile, JSON.stringify({
        ...job, status: done ? "completed" : "failed",
        card_id: cardId, error: done ? null : err.slice(-2000),
      }));
    });
  return reply.code(202).send({ ok: true, job_id: jobId });
});

app.get("/jobs/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    return JSON.parse(await fs.readFile(path.join(JOBS, `${id}.json`), "utf8"));
  } catch {
    return reply.code(404).send({ ok: false, error: "job not found" });
  }
});

app.get("/cards/:id", async (req, reply) => {
  const p = await findCard((req.params as { id: string }).id);
  if (!p) return reply.code(404).send({ ok: false, error: "card not found" });
  return JSON.parse(await fs.readFile(p, "utf8"));
});

app.post("/cards/:id/compile", async (req, reply) => {
  const p = await findCard((req.params as { id: string }).id);
  if (!p) return reply.code(404).send({ ok: false, error: "card not found" });
  const card = JSON.parse(await fs.readFile(p, "utf8"));
  const out = path.join(COMPILED, `${card.id}_v${card.version}`);
  const { code, err } = await run("node", [COMPILER_CLI, "--card", p, "--out", out]);
  if (code !== 0) return reply.code(500).send({ ok: false, error: err.slice(-2000) });
  return { ok: true, card_id: card.id, version: card.version, out_dir: out };
});

app.post("/compile", async (req, reply) => {
  const body = (req.body ?? {}) as { cardId?: string; companyId?: string; roles?: string[] };
  if (!body.cardId)    return reply.code(400).send({ ok: false, error: "cardId required" });
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });

  const cardPath = await findCard(body.cardId);
  if (!cardPath) return reply.code(404).send({ ok: false, error: "card not found" });

  const VALID_ROLES: AgentRole[] = ["front-desk", "sales", "content", "owner-manager"];
  let roles: AgentRole[] | undefined;
  if (body.roles) {
    const invalid = body.roles.filter((r) => !VALID_ROLES.includes(r as AgentRole));
    if (invalid.length) {
      return reply.code(400).send({ ok: false, error: `invalid roles: ${invalid.join(", ")}` });
    }
    roles = body.roles as AgentRole[];
  }

  try {
    const result = await agentCompiler.compileCard({
      cardPath,
      companyId: body.companyId,
      outputDir: COMPILED,
      roles,
    });
    return reply.code(200).send({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

app.get("/cards/:a/diff/:b", async (req, reply) => {
  const { a, b } = req.params as { a: string; b: string };
  const pa = await findCard(a);
  const pb = await findCard(b);
  if (!pa || !pb) return reply.code(404).send({ ok: false, error: "card not found" });
  const { code, out, err } = await run("node", [COMPILER_CLI, "--card", pa, "--diff", pb]);
  if (code !== 0) return reply.code(500).send({ ok: false, error: err.slice(-2000) });
  return JSON.parse(out);
});

app.post("/greeting", async (req, reply) => {
  const body = (req.body ?? {}) as { cardId?: string; companyId?: string };
  if (!body.cardId)    return reply.code(400).send({ ok: false, error: "cardId required" });
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });

  const cardPath = await findCard(body.cardId);
  if (!cardPath) return reply.code(404).send({ ok: false, error: "card not found" });

  try {
    const greeting = await compileGreeting({ cardPath, role: "front-desk" });
    return reply.code(200).send(greeting);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

async function main() {
  await ensureDirs();
  await app.listen({ port: 3101, host: "127.0.0.1" });
}

main().catch((e) => {
  app.log.error(e);
  process.exit(1);
});
