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
import {
  runBattleMode,
  simulateBrand,
  getTrendPulse,
  type BrandSimulation,
} from "./services/intelEngine";
import {
  logCall,
  getAnalytics,
  type CallLog,
} from "./services/analytics";
import {
  initAccount,
  getCreditSummary,
} from "./services/metering";
import {
  createSession,
  sendMessage,
  runTestSuite,
  clearSession,
  getSessions,
} from "./services/playground";
import {
  generateBusinessPlan,
  exportToPdf,
  planStore,
} from "./services/businessPlan";
import {
  createContact,
  updateContact,
  moveStage,
  addContactNote,
  getContacts,
  getContactsByStage,
  crmSummary,
  contactStore,
} from "./services/crmLite";

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

// ---------------------------------------------------------------------------
// Intel routes  (appendix-only — owner planning, never customer-visible)
// ---------------------------------------------------------------------------

// POST /intel/battle — compare two BrandDNA cards head-to-head
app.post("/intel/battle", async (req, reply) => {
  const body = (req.body ?? {}) as { cardIdA?: string; cardIdB?: string };
  if (!body.cardIdA) return reply.code(400).send({ ok: false, error: "cardIdA required" });
  if (!body.cardIdB) return reply.code(400).send({ ok: false, error: "cardIdB required" });

  const [pathA, pathB] = await Promise.all([findCard(body.cardIdA), findCard(body.cardIdB)]);
  if (!pathA) return reply.code(404).send({ ok: false, error: `card not found: ${body.cardIdA}` });
  if (!pathB) return reply.code(404).send({ ok: false, error: `card not found: ${body.cardIdB}` });

  try {
    const [cardA, cardB] = await Promise.all([
      fs.readFile(pathA, "utf8").then(JSON.parse),
      fs.readFile(pathB, "utf8").then(JSON.parse),
    ]);
    const report = await runBattleMode(cardA, cardB);
    return reply.code(200).send(report);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// POST /intel/simulate — test a brand variant and get simulated audience feedback
app.post("/intel/simulate", async (req, reply) => {
  const body = (req.body ?? {}) as {
    cardId?: string;
    variant?: BrandSimulation["variant"];
    input?: string;
  };
  if (!body.cardId)  return reply.code(400).send({ ok: false, error: "cardId required" });
  if (!body.variant) return reply.code(400).send({ ok: false, error: "variant required" });
  if (!body.input)   return reply.code(400).send({ ok: false, error: "input required" });

  const VALID_VARIANTS: BrandSimulation["variant"][] = ["design", "copy", "audience"];
  if (!VALID_VARIANTS.includes(body.variant)) {
    return reply.code(400).send({ ok: false, error: `invalid variant: ${body.variant}` });
  }

  const cardPath = await findCard(body.cardId);
  if (!cardPath) return reply.code(404).send({ ok: false, error: "card not found" });

  try {
    const card = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const result = await simulateBrand(card, body.variant, body.input);
    return reply.code(200).send(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// POST /intel/trends — industry trend pulse for the business
app.post("/intel/trends", async (req, reply) => {
  const body = (req.body ?? {}) as { cardId?: string };
  if (!body.cardId) return reply.code(400).send({ ok: false, error: "cardId required" });

  const cardPath = await findCard(body.cardId);
  if (!cardPath) return reply.code(404).send({ ok: false, error: "card not found" });

  try {
    const card = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const pulse = await getTrendPulse(card);
    return reply.code(200).send(pulse);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// ---------------------------------------------------------------------------
// Analytics routes
// ---------------------------------------------------------------------------

// POST /analytics/call — log a call event
app.post("/analytics/call", async (req, reply) => {
  const body = (req.body ?? {}) as Partial<CallLog>;
  if (!body.id)        return reply.code(400).send({ ok: false, error: "id required" });
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });
  if (!body.timestamp) return reply.code(400).send({ ok: false, error: "timestamp required" });

  const VALID_OUTCOMES: CallLog["outcome"][] = ["answered", "transferred", "voicemail", "abandoned"];
  if (!body.outcome || !VALID_OUTCOMES.includes(body.outcome)) {
    return reply.code(400).send({ ok: false, error: "valid outcome required" });
  }

  const log: CallLog = {
    id:                body.id,
    companyId:         body.companyId,
    timestamp:         body.timestamp,
    durationSeconds:   typeof body.durationSeconds === "number" ? body.durationSeconds : 0,
    outcome:           body.outcome,
    gateTriggered:     body.gateTriggered === true,
    transcriptSummary: body.transcriptSummary,
    topicTags:         Array.isArray(body.topicTags) ? body.topicTags : [],
    converted:         body.converted === true,
  };

  logCall(log);
  return reply.code(200).send({ ok: true });
});

// GET /analytics/:companyId — analytics summary for a period
app.get("/analytics/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const { period = "week" } = req.query as { period?: string };

  const VALID_PERIODS = ["day", "week", "month"] as const;
  if (!VALID_PERIODS.includes(period as "day" | "week" | "month")) {
    return reply.code(400).send({ ok: false, error: "period must be day|week|month" });
  }

  try {
    const summary = await getAnalytics(companyId, period as "day" | "week" | "month");
    return reply.code(200).send(summary);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// ---------------------------------------------------------------------------
// Metering routes
// ---------------------------------------------------------------------------

// GET /metering/:companyId — credit account summary
app.get("/metering/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  return reply.code(200).send(getCreditSummary(companyId));
});

// POST /metering/init/:companyId — initialize a free-tier account
app.post("/metering/init/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const account = initAccount(companyId);
  return reply.code(200).send(account);
});

// ---------------------------------------------------------------------------
// Playground routes  (isolated test environment — no writes to live agent dirs)
// ---------------------------------------------------------------------------

// POST /playground/session — create a new playground session
app.post("/playground/session", async (req, reply) => {
  const body = (req.body ?? {}) as { companyId?: string; cardId?: string; persona?: string };
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });
  if (!body.cardId)    return reply.code(400).send({ ok: false, error: "cardId required" });

  try {
    const session = await createSession(body.companyId, body.cardId, body.persona);
    return reply.code(200).send(session);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(404).send({ ok: false, error: msg });
  }
});

// POST /playground/message — send a message in an existing session
app.post("/playground/message", async (req, reply) => {
  const body = (req.body ?? {}) as { sessionId?: string; message?: string };
  if (!body.sessionId) return reply.code(400).send({ ok: false, error: "sessionId required" });
  if (!body.message)   return reply.code(400).send({ ok: false, error: "message required" });

  try {
    const msg = await sendMessage(body.sessionId, body.message);
    return reply.code(200).send(msg);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = msg.includes("not found") ? 404 : 500;
    return reply.code(code).send({ ok: false, error: msg });
  }
});

// POST /playground/test — run automated test suite against a session
app.post("/playground/test", async (req, reply) => {
  const body = (req.body ?? {}) as { sessionId?: string };
  if (!body.sessionId) return reply.code(400).send({ ok: false, error: "sessionId required" });

  try {
    const results = await runTestSuite(body.sessionId);
    return reply.code(200).send({ ok: true, results });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = msg.includes("not found") ? 404 : 500;
    return reply.code(code).send({ ok: false, error: msg });
  }
});

// DELETE /playground/session/:sessionId — clear a session without affecting live agent
app.delete("/playground/session/:sessionId", async (req, reply) => {
  const { sessionId } = req.params as { sessionId: string };
  clearSession(sessionId);
  return reply.code(200).send({ ok: true });
});

// GET /playground/sessions/:companyId — list all sessions for a company
app.get("/playground/sessions/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const list = getSessions(companyId);
  return reply.code(200).send(list);
});

// ---------------------------------------------------------------------------
// Business plan routes
// ---------------------------------------------------------------------------

// POST /plan/generate — generate a business plan draft from a card
app.post("/plan/generate", async (req, reply) => {
  const body = (req.body ?? {}) as { cardId?: string; companyId?: string };
  if (!body.cardId)    return reply.code(400).send({ ok: false, error: "cardId required" });
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });

  const cardPath = await findCard(body.cardId);
  if (!cardPath) return reply.code(404).send({ ok: false, error: "card not found" });

  try {
    const card = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const plan = await generateBusinessPlan(body.cardId, card);
    return reply.code(200).send(plan);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// GET /plan/:companyId — most recent plan for a company
app.get("/plan/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const plan = planStore.get(`latest:${companyId}`);
  if (!plan) return reply.code(404).send({ ok: false, error: "no plan found for company" });
  return reply.code(200).send(plan);
});

// GET /plan/:companyId/html — HTML string for print-to-PDF
app.get("/plan/:companyId/html", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const plan = planStore.get(`latest:${companyId}`);
  if (!plan) return reply.code(404).send({ ok: false, error: "no plan found for company" });

  // Try to resolve the business name from the stored card
  let businessName: string | undefined;
  const cardPath = await findCard(companyId);
  if (cardPath) {
    try {
      const card = JSON.parse(await fs.readFile(cardPath, "utf8"));
      businessName = card?.identity?.name ?? card?.name?.value ?? undefined;
    } catch { /* leave undefined */ }
  }

  const html = exportToPdf(plan, businessName);
  return reply
    .code(200)
    .header("Content-Type", "text/html; charset=utf-8")
    .send(html);
});

// ---------------------------------------------------------------------------
// CRM routes
// ---------------------------------------------------------------------------

// POST /crm/contacts — create a new contact
app.post("/crm/contacts", async (req, reply) => {
  const body = (req.body ?? {}) as { companyId?: string } & Record<string, unknown>;
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });

  try {
    const contact = createContact(body.companyId, body as any);
    return reply.code(201).send(contact);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// GET /crm/contacts/:companyId — all contacts for a company
app.get("/crm/contacts/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const contacts = getContacts(companyId);
  return reply.code(200).send(contacts);
});

// GET /crm/contacts/:companyId/stage/:stage — contacts filtered by pipeline stage
app.get("/crm/contacts/:companyId/stage/:stage", async (req, reply) => {
  const { companyId, stage } = req.params as { companyId: string; stage: string };
  const contacts = getContactsByStage(companyId, stage);
  return reply.code(200).send(contacts);
});

// PATCH /crm/contacts/:contactId — update stage, add note, or apply field updates
app.patch("/crm/contacts/:contactId", async (req, reply) => {
  const { contactId } = req.params as { contactId: string };
  const body = (req.body ?? {}) as {
    stage?: string;
    note?: string;
    cardId?: string;
    updates?: Record<string, unknown>;
  };

  const existing = contactStore.get(contactId);
  if (!existing) return reply.code(404).send({ ok: false, error: "contact not found" });

  try {
    let contact = existing;

    if (body.stage) {
      // Stage move requires a card for validation; load it if cardId provided
      let card: any = {};
      if (body.cardId) {
        const cardPath = await findCard(body.cardId);
        if (cardPath) card = JSON.parse(await fs.readFile(cardPath, "utf8"));
      }
      contact = moveStage(contactId, body.stage, card);
    }

    if (body.note) {
      contact = addContactNote(contactId, body.note, "owner");
    }

    if (body.updates && typeof body.updates === "object") {
      contact = updateContact(contactId, body.updates as any);
    }

    return reply.code(200).send(contact);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = msg.includes("not found") ? 404 : msg.includes("Invalid stage") ? 400 : 500;
    return reply.code(code).send({ ok: false, error: msg });
  }
});

// GET /crm/summary/:companyId — CRM summary with stage counts and recent activity
app.get("/crm/summary/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };

  // Load card if available so stage list comes from card.operations.pipeline_stages
  let card: any = {};
  const cardPath = await findCard(companyId);
  if (cardPath) {
    try {
      card = JSON.parse(await fs.readFile(cardPath, "utf8"));
    } catch { /* use empty card — crmSummary has sensible defaults */ }
  }

  const summary = crmSummary(companyId, card);
  return reply.code(200).send(summary);
});

async function main() {
  await ensureDirs();
  await app.listen({ port: 3101, host: "127.0.0.1" });
}

main().catch((e) => {
  app.log.error(e);
  process.exit(1);
});
