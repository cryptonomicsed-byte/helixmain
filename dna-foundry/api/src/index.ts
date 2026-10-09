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
import { resolveVoice, getVoiceCatalog, synthesizeSample } from "./services/voiceResolver";
import { loadChangelog, verifyChain, changelogToMarkdown } from "./services/changelog";
import { scoreCard } from "./services/cardHealth";
import {
  generateCampaignPRD,
  generateCampaignAssets,
  submitForApproval,
  prdStore,
  assetStore,
  type Channel,
  type CampaignPRD,
} from "./services/contentPipeline";
import {
  huntLeadsApollo,
  huntLeadsHunter,
  qualifyLead,
  generateOutreach,
  submitOutreachForApproval,
  updateLeadStatus,
  addNote,
  getLeadsByCompany,
  getPipelineSummary,
  leadStore,
  type LeadStatus,
} from "./services/salesPipeline";
import {
  deriveChannelGrants,
  sendEmail,
  postToSocial,
  ChannelNotGranted,
} from "./services/channelGrants";
import { generateImage, getCompanyImages } from "./services/imageGenerator";

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

// GET /companies — scan CARDS dir, return summary list for the dashboard
app.get("/companies", async (_req, reply) => {
  await ensureDirs();
  const files = await fs.readdir(CARDS).catch(() => [] as string[]);
  // Group by base card id (strip version suffix), keep latest version per id
  const byId: Record<string, string> = {};
  for (const f of files.filter((f) => f.endsWith(".json"))) {
    const base = f.replace(/\.json$/, "").split("_v")[0];
    if (!byId[base] || f > byId[base]) byId[base] = f;
  }
  const companies = await Promise.all(
    Object.entries(byId).map(async ([, filename]) => {
      try {
        const raw = await fs.readFile(path.join(CARDS, filename), "utf8");
        const card = JSON.parse(raw);
        return {
          id:          card.org_id ?? card.id,
          name:        card.name?.value ?? card.org_id ?? card.id,
          cardVersion: card.version ?? 1,
          lastUpdated: card.updated_at ?? card.extracted_at ?? "",
        };
      } catch {
        return null;
      }
    })
  );
  return reply.code(200).send(companies.filter(Boolean));
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

// ---------------------------------------------------------------------------
// Build status route
// ---------------------------------------------------------------------------

// GET /build-status — proxy the build-status.json written by helix-rebuild.sh
app.get("/build-status", async (_req, reply) => {
  const BUILD_STATUS_URL = "https://helixmain.duckdns.org/build-status.json";
  try {
    const res = await fetch(BUILD_STATUS_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return reply.code(200).send({ status: "unknown", reason: `upstream ${res.status}` });
    const json = await res.json();
    return reply.code(200).send(json);
  } catch {
    return reply.code(200).send({ status: "unknown" });
  }
});

// ---------------------------------------------------------------------------
// Voice routes
// ---------------------------------------------------------------------------

// GET /voices — full catalog, Kokoro first then ElevenLabs
app.get("/voices", async () => getVoiceCatalog());

// POST /voices/resolve — resolve a voice_profile string against a stored card
app.post("/voices/resolve", async (req, reply) => {
  const body = (req.body ?? {}) as { voiceProfile?: string; cardId?: string };
  if (!body.cardId) return reply.code(400).send({ ok: false, error: "cardId required" });

  const cardPath = await findCard(body.cardId);
  if (!cardPath) return reply.code(404).send({ ok: false, error: "card not found" });

  const card = JSON.parse(await fs.readFile(cardPath, "utf8"));
  const resolved = resolveVoice(body.voiceProfile ?? "", card);
  return reply.code(200).send(resolved);
});

// POST /voices/sample — synthesise a short TTS preview clip
app.post("/voices/sample", async (req, reply) => {
  const body = (req.body ?? {}) as { voiceProfile?: string; text?: string };
  if (!body.voiceProfile) return reply.code(400).send({ ok: false, error: "voiceProfile required" });
  if (!body.text)         return reply.code(400).send({ ok: false, error: "text required" });

  // resolveVoice with an empty card object — we only need provider/endpoint from the profile string
  const resolved = resolveVoice(body.voiceProfile, {});
  const result = await synthesizeSample(resolved, body.text);
  return reply.code(200).send(result);
});

// ---------------------------------------------------------------------------
// Changelog routes
// ---------------------------------------------------------------------------

const HELIX_COMPANIES = process.env.HELIX_CARD_ROOT ?? "/etc/helix/companies";

// GET /changelog/:companyId — full changelog JSON
app.get("/changelog/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const changelogPath = path.join(HELIX_COMPANIES, companyId, "changelog.json");
  try {
    const log = await loadChangelog(changelogPath, "", companyId);
    return reply.code(200).send(log);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// GET /changelog/:companyId/verify — tamper check
app.get("/changelog/:companyId/verify", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const changelogPath = path.join(HELIX_COMPANIES, companyId, "changelog.json");
  const result = await verifyChain(changelogPath);
  return reply.code(200).send(result);
});

// GET /changelog/:companyId/markdown — human-readable history
app.get("/changelog/:companyId/markdown", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const changelogPath = path.join(HELIX_COMPANIES, companyId, "changelog.json");
  try {
    const log = await loadChangelog(changelogPath, "", companyId);
    const md = changelogToMarkdown(log);
    return reply
      .code(200)
      .header("Content-Type", "text/plain; charset=utf-8")
      .send(md);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// ---------------------------------------------------------------------------
// Card health route
// ---------------------------------------------------------------------------

// GET /health/:companyId — completeness score for a stored card
app.get("/health/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const p = await findCard(companyId);
  if (!p) return reply.code(404).send({ ok: false, error: "card not found" });
  try {
    const card = JSON.parse(await fs.readFile(p, "utf8"));
    const result = scoreCard(card);
    return reply.code(200).send({ ok: true, companyId, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// ---------------------------------------------------------------------------
// Content pipeline routes  (H-gated via SparkGatekeeper)
// ---------------------------------------------------------------------------

// POST /content/prd — generate a campaign PRD from a card + goal
app.post("/content/prd", async (req, reply) => {
  const body = (req.body ?? {}) as { cardId?: string; goal?: string; channels?: string[] };
  if (!body.cardId)   return reply.code(400).send({ ok: false, error: "cardId required" });
  if (!body.goal)     return reply.code(400).send({ ok: false, error: "goal required" });
  if (!Array.isArray(body.channels) || body.channels.length === 0)
    return reply.code(400).send({ ok: false, error: "channels[] required" });

  const cardPath = await findCard(body.cardId);
  if (!cardPath) return reply.code(404).send({ ok: false, error: "card not found" });

  try {
    const card = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const prd  = await generateCampaignPRD(card, body.goal, body.channels as Channel[]);
    return reply.code(200).send({ ok: true, prd });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// POST /content/generate — generate assets for all user stories in a PRD
app.post("/content/generate", async (req, reply) => {
  const body = (req.body ?? {}) as { cardId?: string; prd?: CampaignPRD };
  if (!body.cardId) return reply.code(400).send({ ok: false, error: "cardId required" });
  if (!body.prd)    return reply.code(400).send({ ok: false, error: "prd required" });

  const cardPath = await findCard(body.cardId);
  if (!cardPath) return reply.code(404).send({ ok: false, error: "card not found" });

  try {
    const card   = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const assets = await generateCampaignAssets(body.prd, card);
    return reply.code(200).send({ ok: true, assets });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// POST /content/approve/:assetId — submit an asset to SparkGatekeeper hold queue
app.post("/content/approve/:assetId", async (req, reply) => {
  const { assetId } = req.params as { assetId: string };
  const body = (req.body ?? {}) as { companyId?: string };
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });

  const asset = assetStore.get(assetId);
  if (!asset) return reply.code(404).send({ ok: false, error: "asset not found" });

  try {
    const holdQueueId = await submitForApproval(asset, body.companyId);
    return reply.code(200).send({ ok: true, holdQueueId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 503 signals upstream gatekeeper failure — never silently drop
    return reply.code(503).send({ ok: false, error: msg });
  }
});

// ---------------------------------------------------------------------------
// Sales pipeline routes  (outreach H-gated via SparkGatekeeper)
// ---------------------------------------------------------------------------

// POST /sales/hunt — Apollo.io lead hunting for a company's target profile
app.post("/sales/hunt", async (req, reply) => {
  const body = (req.body ?? {}) as {
    cardId?: string;
    companyId?: string;
    filters?: { industry?: string; location?: string; size?: string; keywords?: string[] };
  };
  if (!body.cardId)    return reply.code(400).send({ ok: false, error: "cardId required" });
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });

  const cardPath = await findCard(body.cardId);
  if (!cardPath) return reply.code(404).send({ ok: false, error: "card not found" });

  try {
    const card  = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const leads = await huntLeadsApollo(body.companyId, card, body.filters ?? {});
    return reply.code(200).send({ ok: true, leads });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// POST /sales/qualify/:leadId — score + qualify a lead against the company card
app.post("/sales/qualify/:leadId", async (req, reply) => {
  const { leadId } = req.params as { leadId: string };
  const body = (req.body ?? {}) as { cardId?: string };
  if (!body.cardId) return reply.code(400).send({ ok: false, error: "cardId required" });

  const lead = leadStore.get(leadId);
  if (!lead) return reply.code(404).send({ ok: false, error: "lead not found" });

  const cardPath = await findCard(body.cardId);
  if (!cardPath) return reply.code(404).send({ ok: false, error: "card not found" });

  try {
    const card    = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const updated = await qualifyLead(lead, card);
    return reply.code(200).send({ ok: true, lead: updated });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// POST /sales/outreach/:leadId — generate personalized outreach draft
app.post("/sales/outreach/:leadId", async (req, reply) => {
  const { leadId } = req.params as { leadId: string };
  const body = (req.body ?? {}) as { cardId?: string };
  if (!body.cardId) return reply.code(400).send({ ok: false, error: "cardId required" });

  const lead = leadStore.get(leadId);
  if (!lead) return reply.code(404).send({ ok: false, error: "lead not found" });

  const cardPath = await findCard(body.cardId);
  if (!cardPath) return reply.code(404).send({ ok: false, error: "card not found" });

  try {
    const card  = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const draft = await generateOutreach(lead, card);
    return reply.code(200).send({ ok: true, draft });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// POST /sales/submit/:leadId — submit outreach draft to SparkGatekeeper hold queue
app.post("/sales/submit/:leadId", async (req, reply) => {
  const { leadId } = req.params as { leadId: string };
  const body = (req.body ?? {}) as {
    companyId?: string;
    draft?: {
      leadId: string;
      subjectLine: string;
      emailBody: string;
      closingScript: string;
      objectionRebuttals: Record<string, string>;
      followUpSequence: string[];
      holdQueueId?: string;
    };
  };
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });
  if (!body.draft)     return reply.code(400).send({ ok: false, error: "draft required" });

  const lead = leadStore.get(leadId);
  if (!lead) return reply.code(404).send({ ok: false, error: "lead not found" });

  try {
    const holdQueueId = await submitOutreachForApproval(body.draft, lead, body.companyId);
    return reply.code(200).send({ ok: true, holdQueueId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(503).send({ ok: false, error: msg });
  }
});

// GET /sales/pipeline/:companyId — CRM pipeline summary
app.get("/sales/pipeline/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const summary = getPipelineSummary(companyId);
  return reply.code(200).send({ ok: true, companyId, ...summary });
});

// GET /sales/leads/:companyId — all leads for a company
app.get("/sales/leads/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const leads = getLeadsByCompany(companyId);
  return reply.code(200).send({ ok: true, leads });
});

// PATCH /sales/leads/:leadId — update status and/or add a note
app.patch("/sales/leads/:leadId", async (req, reply) => {
  const { leadId } = req.params as { leadId: string };
  const body = (req.body ?? {}) as { status?: string; note?: string };

  let lead = leadStore.get(leadId);
  if (!lead) return reply.code(404).send({ ok: false, error: "lead not found" });

  const VALID_STATUSES: LeadStatus[] = ["new", "contacted", "qualified", "converted", "lost"];

  if (body.status) {
    if (!VALID_STATUSES.includes(body.status as LeadStatus)) {
      return reply.code(400).send({ ok: false, error: `invalid status: ${body.status}` });
    }
    lead = updateLeadStatus(lead, body.status as LeadStatus, body.note);
  } else if (body.note) {
    lead = addNote(lead, body.note);
  }

  return reply.code(200).send({ ok: true, lead });
});

// ---------------------------------------------------------------------------
// Channel grant routes  (MCP scoped by operations.channels[], H-gated sends)
// ---------------------------------------------------------------------------

// GET /channels/:companyId — derive channel grants from stored card
app.get("/channels/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const p = await findCard(companyId);
  if (!p) return reply.code(404).send({ ok: false, error: "card not found" });
  try {
    const card = JSON.parse(await fs.readFile(p, "utf8"));
    const grants = deriveChannelGrants(card);
    return reply.code(200).send(grants);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// POST /channels/email — H-gated email send via SparkGatekeeper
app.post("/channels/email", async (req, reply) => {
  const body = (req.body ?? {}) as {
    companyId?: string;
    cardId?: string;
    to?: string;
    subject?: string;
    body?: string;
  };
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });
  if (!body.cardId)    return reply.code(400).send({ ok: false, error: "cardId required" });
  if (!body.to)        return reply.code(400).send({ ok: false, error: "to required" });
  if (!body.subject)   return reply.code(400).send({ ok: false, error: "subject required" });
  if (!body.body)      return reply.code(400).send({ ok: false, error: "body required" });

  const cardPath = await findCard(body.cardId);
  if (!cardPath) return reply.code(404).send({ ok: false, error: "card not found" });

  try {
    const card = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const result = await sendEmail(body.companyId, body.to, body.subject, body.body, card);
    return reply.code(200).send({ ok: true, ...result });
  } catch (e) {
    if (e instanceof ChannelNotGranted) {
      return reply.code(403).send({ ok: false, error: e.message });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(503).send({ ok: false, error: msg });
  }
});

// POST /channels/social — H-gated social post via SparkGatekeeper
app.post("/channels/social", async (req, reply) => {
  const body = (req.body ?? {}) as {
    companyId?: string;
    cardId?: string;
    channel?: "instagram" | "facebook" | "x" | "linkedin";
    content?: string;
    mediaUrl?: string;
  };
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });
  if (!body.cardId)    return reply.code(400).send({ ok: false, error: "cardId required" });
  if (!body.channel)   return reply.code(400).send({ ok: false, error: "channel required" });
  if (!body.content)   return reply.code(400).send({ ok: false, error: "content required" });

  const VALID_SOCIAL = ["instagram", "facebook", "x", "linkedin"];
  if (!VALID_SOCIAL.includes(body.channel)) {
    return reply.code(400).send({ ok: false, error: `invalid channel: ${body.channel}` });
  }

  const cardPath = await findCard(body.cardId);
  if (!cardPath) return reply.code(404).send({ ok: false, error: "card not found" });

  try {
    const card = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const result = await postToSocial(body.companyId, body.channel, body.content, body.mediaUrl, card);
    return reply.code(200).send({ ok: true, ...result });
  } catch (e) {
    if (e instanceof ChannelNotGranted) {
      return reply.code(403).send({ ok: false, error: e.message });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(503).send({ ok: false, error: msg });
  }
});

// ---------------------------------------------------------------------------
// Image generation routes  (multi-provider, content-addressed cache)
// ---------------------------------------------------------------------------

// POST /images/generate — generate an image via provider cascade
app.post("/images/generate", async (req, reply) => {
  const body = (req.body ?? {}) as {
    companyId?: string;
    prompt?: string;
    style?: string;
    size?: "1024x1024" | "1792x1024" | "1024x1792";
    assetType?: "product" | "hero" | "social" | "logo_concept" | "background";
  };
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });
  if (!body.prompt)    return reply.code(400).send({ ok: false, error: "prompt required" });
  if (!body.assetType) return reply.code(400).send({ ok: false, error: "assetType required" });

  const VALID_SIZES = ["1024x1024", "1792x1024", "1024x1792"];
  if (body.size && !VALID_SIZES.includes(body.size)) {
    return reply.code(400).send({ ok: false, error: `invalid size: ${body.size}` });
  }

  const VALID_ASSET_TYPES = ["product", "hero", "social", "logo_concept", "background"];
  if (!VALID_ASSET_TYPES.includes(body.assetType)) {
    return reply.code(400).send({ ok: false, error: `invalid assetType: ${body.assetType}` });
  }

  try {
    const image = await generateImage({
      companyId: body.companyId,
      prompt:    body.prompt,
      style:     body.style,
      size:      body.size,
      assetType: body.assetType,
    });
    return reply.code(200).send(image);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = msg.startsWith("ALL_PROVIDERS_FAILED") ? 502 : 500;
    return reply.code(code).send({ ok: false, error: msg });
  }
});

// GET /images/:companyId — all cached images for a company
app.get("/images/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const images = getCompanyImages(companyId);
  return reply.code(200).send(images);
});

async function main() {
  await ensureDirs();
  await app.listen({ port: 3101, host: "127.0.0.1" });
}

main().catch((e) => {
  app.log.error(e);
  process.exit(1);
});
