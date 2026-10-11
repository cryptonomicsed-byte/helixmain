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
import {
  loadSettings, saveSettings, getSettings, publicSettings, PROVIDERS,
  loadAllCompanyAi, saveCompanyAi, publicCompanyAi, getCompanyAi,
  ASPECTS,
  type CompanyAiSettings,
} from "./services/settings";
import { agentCompiler, AgentRole } from "./services/agentCompiler";
import { compileGreeting } from "./services/greetingCompiler";
import {
  resolveVoice,
  getVoiceCatalog,
  getVoiceCatalogAsync,
  synthesizeSample,
  getElevenLabsVoices,
} from "./services/voiceResolver";
import {
  generateJingle,
  getJingle,
  loadJingleStore,
} from "./services/sonicBranding";
import { aiGateway } from "./services/aiGateway";
import { loadChangelog, verifyChain, changelogToMarkdown, appendChange, diffCards } from "./services/changelog";
import { scoreCard } from "./services/cardHealth";
import {
  generateCampaignPRD,
  generateCampaignAssets,
  generateVariants,
  compareVariants,
  submitForApproval,
  scheduleAsset,
  getScheduledAssets,
  cancelSchedule,
  getDueAssets,
  prdStore,
  assetStore,
  loadContentStores,
  type Channel,
  type CampaignPRD,
} from "./services/contentPipeline";
import {
  huntLeadsApollo,
  huntLeadsHunter,
  huntLeadsOSM,
  qualifyLead,
  bulkQualify,
  reviewDeal,
  generateOutreach,
  generateClosingScript,
  submitOutreachForApproval,
  updateLeadStatus,
  addNote,
  getLeadsByCompany,
  getPipelineSummary,
  loadLeadStore,
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
  logEvent,
  type CallLog,
  type EventEntry,
} from "./services/analytics";
import { getCacheStats } from "./services/aiGateway";
import { costLog } from "./services/costLog";
import { buildPortfolio } from "./services/portfolio";
import {
  initAccount,
  getCreditSummary,
  checkQuota,
  deductCredits,
  refundCredits,
  topUpCredits,
  loadAccountStore,
  getAccountStoreSize,
  QuotaExceeded,
  type UsageEntry,
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
  generateWebsite,
  getWebsite,
  listSites,
  loadSiteStore,
} from "./services/siteGenerator";
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
import {
  PRICE_TO_CREDITS,
  TIER_PRICES,
  CREDIT_PACKS,
  TIER_LIMITS,
  CREDIT_COSTS,
  upgradeTier,
} from "./services/metering";
import {
  generateReferralCode,
  recordReferral,
  getAffiliateStats,
  loadAffiliateStore,
} from "./services/affiliate";
import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { type FastifyRequest, type FastifyReply } from "fastify";
import { lookupKey, type KeyRecord } from "./services/apiKeys";
import {
  SESSION_COOKIE,
  CHALLENGE_COOKIE,
  SESSION_TTL_MS,
  CHALLENGE_TTL_MS,
  mintSession,
  readSession,
  signJson,
  verifyJson,
  parseCookies,
  setCookie,
  clearCookie,
} from "./services/session";
import {
  addCredential,
  consumeEnrollToken,
  credsFor,
  findCompanyByCredentialId,
  issueEnrollToken,
  resolveEnrollToken,
  updateCounter,
} from "./services/passkeys";
import {
  registrationOptions,
  verifyRegistration,
  authenticationOptions,
  verifyAuthentication,
  RP_ORIGIN,
} from "./services/webauthn";
import { isOnboardedCompany, isProvisionedCompany, listProvisionedCompanies, slugify, uniqueSlug } from "./services/companies";
import {
  savePending,
  loadPending,
  clearPending,
  pendingSlugs,
  provisionCompany,
  findByGoogleSub,
  readAccount,
} from "./services/signup";

const app = Fastify({ logger: true });

// Keep the RAW request body for the one route that needs the true bytes: the
// Stripe webhook verifies an HMAC over exactly what Stripe signed. Re-serialising
// the parsed object (JSON.stringify(req.body)) can NOT reproduce those bytes, so
// the old signature check could never pass — and it "processed anyway". This
// parser is behaviour-identical to Fastify's default JSON parser and additionally
// stashes the raw buffer on req.rawBody.
app.addContentTypeParser(
  "application/json",
  { parseAs: "buffer" },
  (req, body, done) => {
    (req as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer;
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch (e) {
      done(e as Error, undefined);
    }
  },
);
const ROOT = path.resolve(__dirname, "..", "..");
const DATA = path.join(ROOT, "api", "data");
const CARDS = path.join(DATA, "cards");
const HELIX_COMPANIES = process.env.HELIX_CARD_ROOT || "/etc/helix/companies";
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
  // A card id is a slug ("ok") or a dna_* id — never a path. Reject separators
  // (and "..") so a caller cannot aim this at an arbitrary file.
  if (!cardId || cardId.includes("/") || cardId.includes("\\") || cardId.includes("..")) return null;
  // 1. Check /etc/helix/companies/{id}/card.json first (live onboarded companies)
  const helixCard = path.join(HELIX_COMPANIES, cardId, "card.json");
  try { await fs.access(helixCard); return helixCard; } catch {}
  // 2. Fall back to dna-foundry/api/data/cards/ (extracted/test cards)
  const files = await fs.readdir(CARDS).catch(() => []);
  const hits = files.filter((f) => f.startsWith(cardId)).sort();
  return hits.length ? path.join(CARDS, hits[hits.length - 1]) : null;
}

// ---------------------------------------------------------------------------
// Auth. Every business route is gated; the presented key IS the tenant identity,
// so a caller-supplied companyId is never trusted on its own. /health stays open
// (liveness probes) and returns nothing but {ok, service}.
// ---------------------------------------------------------------------------

interface AuthCarrier {
  auth?: KeyRecord;
}

// Fields a caller might use to name a company. Values are CHECKED against the
// authenticated company — never trusted.
const COMPANY_HINTS = new Set([
  "companyId", "company_id", "orgId", "org_id", "organizationId", "organization_id",
  "cardId", "card_id", "id", "card",
]);

function namedCompanyIds(req: FastifyRequest): string[] {
  const out: string[] = [];
  const scan = (obj: unknown) => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (COMPANY_HINTS.has(k) && typeof v === "string" && v) out.push(v);
    }
  };
  scan(req.params);
  scan(req.query);
  scan(req.body);
  return out;
}

async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Machine callers present a per-company key; the browser presents a session
  // cookie minted by a passkey login. Either way the SERVER decides the tenant —
  // a caller-supplied companyId is never trusted on its own.
  let rec: KeyRecord | null = lookupKey(req.headers["x-api-key"]);
  if (!rec) {
    const sess = readSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (sess) rec = { companyId: sess.company, level: sess.role === "owner" ? "owner" : "company" };
  }
  if (!rec) {
    await reply.code(401).send({ ok: false, error: "missing or invalid credentials" });
    return;
  }
  (req as AuthCarrier).auth = rec;
  // An operator credential is the ONE deliberate cross-company grant (the
  // dashboard switcher): it may name other companies. Everyone else is bound to
  // their own tenant — naming a DIFFERENT onboarded company is 403, never a silent
  // cross-tenant read/write. Ids that are not onboarded companies (e.g. test cards
  // under api/data/cards) are left to the route's own lookup.
  if (rec.level === "operator") return;
  for (const named of namedCompanyIds(req)) {
    if (named !== rec.companyId && isOnboardedCompany(named)) {
      await reply.code(403).send({ ok: false, error: "key does not belong to that company" });
      return;
    }
  }
}

/** Owner level — card mutation needs the owner credential, not just a company key. */
async function requireOwner(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const rec = lookupKey(req.headers["x-owner-key"]);
  const auth = (req as AuthCarrier).auth;
  // An owner-level SESSION (a passkey login) is itself the owner credential —
  // that is the point of the session. The key path still needs the owner key.
  const viaKey = !!rec && rec.level === "owner" && rec.companyId === auth?.companyId;
  const viaSession = auth?.level === "owner";
  if (!viaKey && !viaSession) {
    await reply.code(403).send({ ok: false, error: "owner credential required" });
  }
}

app.get("/health", async () => ({ ok: true, service: "dna-foundry" }));

// ---------------------------------------------------------------------------
// Runtime settings — provider / model / API keys set from the dashboard.
// Secrets are never returned; GET exposes only presence + a short hint.
// ---------------------------------------------------------------------------
app.get("/settings", { preHandler: requireAuth }, async () => publicSettings());

app.put("/settings", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as {
    provider?: string; model?: string; keys?: Record<string, string>;
  };
  const cur = getSettings();
  const next = { ...cur } as typeof cur;

  if (body.provider) {
    if (!PROVIDERS.includes(body.provider as (typeof PROVIDERS)[number])) {
      return reply.code(400).send({ ok: false, error: `unknown provider: ${body.provider}` });
    }
    next.provider = body.provider as (typeof PROVIDERS)[number];
  }
  if (typeof body.model === "string") next.model = body.model;

  if (body.keys && typeof body.keys === "object") {
    const keys: Record<string, string> = { ...(cur.keys ?? {}) };
    for (const [p, v] of Object.entries(body.keys)) {
      if (!PROVIDERS.includes(p as (typeof PROVIDERS)[number])) continue;
      if (!v) delete keys[p];        // empty string clears the key
      else keys[p] = v;
    }
    next.keys = keys as typeof cur.keys;
  }

  await saveSettings(next);
  return publicSettings();
});

// ---------------------------------------------------------------------------
// Per-business AI settings — which provider/model each aspect of THIS business
// uses, plus optional per-business keys. Resolution: aspect → business →
// account → built-in; keys: business → account → env.
// ---------------------------------------------------------------------------

const VALID_ASPECTS = ASPECTS.map((a) => a.key);

app.get("/settings/:orgId", { preHandler: requireAuth }, async (req) => {
  const { orgId } = req.params as { orgId: string };
  return publicCompanyAi(orgId);
});

app.put("/settings/:orgId", { preHandler: requireAuth }, async (req, reply) => {
  const { orgId } = req.params as { orgId: string };
  const body = (req.body ?? {}) as {
    provider?: string | null;
    model?: string | null;
    scopes?: Record<string, { provider?: string | null; model?: string | null }>;
    keys?: Record<string, string>;
    budgetCredits?: number | null;
  };

  const cur = getCompanyAi(orgId);
  const next: CompanyAiSettings = { ...cur, scopes: { ...(cur.scopes ?? {}) }, keys: { ...(cur.keys ?? {}) } };

  if (body.provider !== undefined) {
    if (body.provider === null || body.provider === "") delete next.provider;
    else if (!PROVIDERS.includes(body.provider as (typeof PROVIDERS)[number])) {
      return reply.code(400).send({ ok: false, error: `unknown provider: ${body.provider}` });
    } else next.provider = body.provider as (typeof PROVIDERS)[number];
  }
  if (body.model !== undefined) {
    if (body.model === null || body.model === "") delete next.model;
    else next.model = String(body.model);
  }

  if (body.scopes && typeof body.scopes === "object") {
    for (const [aspect, choice] of Object.entries(body.scopes)) {
      if (!VALID_ASPECTS.includes(aspect)) continue;
      const scope: { provider?: CompanyAiSettings["provider"]; model?: string } = { ...(next.scopes?.[aspect] ?? {}) };
      if (choice?.provider !== undefined) {
        if (choice.provider === null || choice.provider === "") delete scope.provider;
        else if (!PROVIDERS.includes(choice.provider as (typeof PROVIDERS)[number])) {
          return reply.code(400).send({ ok: false, error: `unknown provider for ${aspect}: ${choice.provider}` });
        } else scope.provider = choice.provider as (typeof PROVIDERS)[number];
      }
      if (choice?.model !== undefined) {
        if (choice.model === null || choice.model === "") delete scope.model;
        else scope.model = String(choice.model);
      }
      // an empty override means "inherit" — drop it entirely
      if (!scope.provider && !scope.model) delete next.scopes![aspect];
      else next.scopes![aspect] = scope;
    }
  }

  if (body.keys && typeof body.keys === "object") {
    const keys: Record<string, string> = { ...(next.keys ?? {}) };
    for (const [p, v] of Object.entries(body.keys)) {
      if (!PROVIDERS.includes(p as (typeof PROVIDERS)[number])) continue;
      if (!v) delete keys[p];                       // empty clears
      else keys[p] = v;
    }
    next.keys = keys as CompanyAiSettings["keys"];
  }

  if (body.budgetCredits !== undefined) {
    const n = Number(body.budgetCredits);
    if (body.budgetCredits === null || !Number.isFinite(n) || n <= 0) delete next.budgetCredits;
    else next.budgetCredits = Math.floor(n);
  }

  await saveCompanyAi(orgId, next);
  return publicCompanyAi(orgId);
});

/** Extraction ceiling per account per day. Extraction runs a crawl AND an LLM
 *  call, so a free grant has to be bounded in COMPUTE, not just in credits.
 *
 *  A FLAT 25 was a lie on the tier that matters: the free tier grants 100 credits
 *  and caps daily spend at 75, and an extraction costs 5 — so the credit meter
 *  bound at 15/day and the cap never fired. Derive it from the tier's daily
 *  credit budget so the number is reachable, and keep an absolute ceiling. */
const EXTRACTIONS_PER_DAY_CAP = 25;
function extractionsPerDay(tier: string): number {
  const limits = TIER_LIMITS[tier as keyof typeof TIER_LIMITS] ?? TIER_LIMITS.free;
  const opCost = CREDIT_COSTS.extraction ?? 5;
  if (opCost <= 0) return EXTRACTIONS_PER_DAY_CAP;
  return Math.max(1, Math.min(EXTRACTIONS_PER_DAY_CAP, Math.floor(limits.daily / opCost)));
}

app.post("/extract", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as { url?: string; orgId?: string; companyId?: string };
  if (!body.url) return reply.code(400).send({ ok: false, error: "url required" });

  // THE TENANT IS THE AUTHENTICATED COMPANY — never a caller-supplied id. This
  // route writes <tenant>/card.json, so trusting body.orgId let any valid key drop
  // a card into any name it chose: a directory-creation primitive. requireAuth
  // already 403s a body that NAMES another provisioned company; it does NOT stop a
  // name that belongs to nobody, which is exactly the name an attacker would pick.
  //
  // The body MAY carry an orgId, but only one that resolves to a REAL company:
  // your own, or — for an operator — a company that is ALREADY provisioned (the
  // agency path, onboarding a client). It never creates a directory for an
  // arbitrary name.
  const auth = (req as AuthCarrier).auth;
  const companyId = auth?.companyId ?? "";
  const isOperator = auth?.level === "operator";
  let target = companyId;
  if (body.orgId && body.orgId !== companyId) {
    if (!isOperator)
      return reply.code(403).send({ ok: false, error: "orgId must be your own company" });
    if (!isProvisionedCompany(body.orgId))
      return reply.code(403).send({ ok: false, error: "no such company to extract into" });
    target = body.orgId;
  }
  if (!target || !isProvisionedCompany(target))
    return reply.code(403).send({ ok: false, error: "this company is not provisioned" });

  // Per-account daily ceiling — see EXTRACTIONS_PER_DAY.
  const acct = getCreditSummary(target);
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const usedToday = (acct.usageLog ?? []).filter(
    (u) => u.operationType === "extraction" && Date.parse(u.timestamp) >= dayStart.getTime()
  ).length;
  const cap = extractionsPerDay(acct.tier);
  if (usedToday >= cap) {
    return reply.code(429).send({
      ok: false,
      error: "extraction_daily_cap",
      message: `Daily limit of ${cap} extractions reached for the ${acct.tier} tier. Resets 00:00 UTC.`,
      usedToday,
      limit: cap,
    });
  }

  let usageEntry: UsageEntry | null = null;
  try {
    usageEntry = await deductCredits(target, "extraction");
  } catch (e) {
    if (e instanceof QuotaExceeded) return reply.code(402).send({ error: e.message });
    throw e;
  }

  try {
    const card = await extractor.extractCard({ url: body.url, orgId: target });
    // A fallback card means the crawl/LLM produced nothing — never charge for that.
    const failed =
      typeof card.identity?.elevatorPitch === "string" &&
      card.identity.elevatorPitch.startsWith("Could not extract data automatically");
    if (failed) {
      if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
      return reply.code(422).send({
        ok: false,
        error: "extraction_failed",
        message:
          "Could not extract data from that URL. Check the site is public and reachable, and that the API has an LLM key configured.",
        url: extractor.normalizeUrl(body.url),
      });
    }
    await ensureDirs();
    const cardFile = path.join(CARDS, `${card.id}.json`);
    await fs.writeFile(cardFile, JSON.stringify(card, null, 2));

    // And under the company dir. This write is what turns a PROVISIONED company
    // into an ONBOARDED one, so it is no longer swallowed — a card the company
    // cannot see is a charge for nothing.
    try {
      const companyDir = path.join(HELIX_COMPANIES, target);
      await fs.mkdir(companyDir, { recursive: true });
      await fs.writeFile(path.join(companyDir, "card.json"), JSON.stringify(card, null, 2));
    } catch (e) {
      if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ ok: false, error: `card could not be stored: ${msg}` });
    }
    return reply.code(200).send(card);
  } catch (e) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    throw e;
  }
});

app.post("/jobs", { preHandler: requireAuth }, async (req, reply) => {
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

app.get("/jobs/:id", { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    return JSON.parse(await fs.readFile(path.join(JOBS, `${id}.json`), "utf8"));
  } catch {
    return reply.code(404).send({ ok: false, error: "job not found" });
  }
});

app.get("/cards/:id", { preHandler: requireAuth }, async (req, reply) => {
  const p = await findCard((req.params as { id: string }).id);
  if (!p) return reply.code(404).send({ ok: false, error: "card not found" });
  return JSON.parse(await fs.readFile(p, "utf8"));
});

// ---------------------------------------------------------------------------
// Card mutation — propose -> confirm -> apply.
//
// The card is the source of truth, so it is never edited directly. A change is
// recorded as a PROPOSAL first, then a separate confirm step applies it, bumping
// the version and appending the hash-chained changelog entry. PATCH stays as the
// propose entry point so existing callers keep working — but it returns 202 and
// mutates nothing.
// ---------------------------------------------------------------------------

interface CardPatchBody {
  patch?: Record<string, unknown>;
  confirm?: string[];
  author?: string;
  summary?: string;
}

function proposalsDir(cardId: string): string {
  return path.join(HELIX_COMPANIES, cardId, "proposals");
}

/** Apply a patch: merge sections, mark owner-confirmed provenance, bump version,
 *  write, append the changelog. Returns the changed card, or {error, code}. */
async function applyCardPatch(
  cardId: string,
  body: CardPatchBody
): Promise<
  | { ok: true; card: Record<string, any>; fieldsChanged: string[] }
  | { ok: false; error: string; code: number }
> {
  if (!body.patch || typeof body.patch !== "object")
    return { ok: false, error: "patch object required", code: 400 };

  const p = await findCard(cardId);
  if (!p) return { ok: false, error: "card not found", code: 404 };

  let card: Record<string, any>;
  try {
    card = JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return { ok: false, error: "card is unreadable", code: 500 };
  }

  const before = JSON.parse(JSON.stringify(card));
  const now = new Date().toISOString();

  // Shallow-merge top-level sections; replace scalars/arrays outright.
  for (const [k, v] of Object.entries(body.patch)) {
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      card[k] && typeof card[k] === "object" && !Array.isArray(card[k])
    ) {
      card[k] = { ...card[k], ...(v as Record<string, unknown>) };
    } else {
      card[k] = v;
    }
  }

  // Owner-confirmed provenance: an owner edit is the strongest signal we have.
  const confirmed = Array.isArray(body.confirm) ? body.confirm : [];
  if (confirmed.length > 0) {
    card.field_provenance = card.field_provenance ?? {};
    for (const key of confirmed) {
      const prev = card.field_provenance[key] ?? {};
      card.field_provenance[key] = {
        ...prev,
        sources: ["owner"],
        confidence: 1,
        extractorAgent: "owner",
        extractedAt: now,
        inferred: false,
      };
    }
  }

  card.version = (card.version ?? 1) + 1;
  card.updated_at = now;

  const fieldsChanged = diffCards(before, card);

  try {
    await fs.writeFile(p, JSON.stringify(card, null, 2));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `could not write card: ${msg}`, code: 500 };
  }

  // The ledger lives beside the card, keyed by the slug the routes already
  // address (`findCard(cardId)` resolved this card at HELIX_COMPANIES/<cardId>/).
  // This used to key off card.organizationId (e.g. "org_demo_barber") — a
  // DIFFERENT directory than GET /changelog/:companyId reads and than
  // helix-onboard.sh writes, so API edits landed in an orphan ledger. One
  // company, one file.
  const companyId = cardId;
  const changelogPath = path.join(HELIX_COMPANIES, companyId, "changelog.json");
  try {
    await appendChange(
      changelogPath,
      card.id ?? cardId,
      companyId,
      fieldsChanged.length > 0 ? fieldsChanged : ["*"],
      "owner-confirmed",
      body.author ?? "owner",
      body.summary ?? "Card edited",
    );
  } catch {
    /* a changelog failure must not lose the edit */
  }

  return { ok: true, card, fieldsChanged };
}

/** Record a proposal. Writes nothing to the card. */
async function createProposal(
  cardId: string,
  body: CardPatchBody
): Promise<
  | { ok: true; proposal: Record<string, any> }
  | { ok: false; error: string; code: number }
> {
  if (!body.patch || typeof body.patch !== "object")
    return { ok: false, error: "patch object required", code: 400 };
  if (!(await findCard(cardId))) return { ok: false, error: "card not found", code: 404 };

  const id = "prp_" + randomUUID().slice(0, 8);
  const proposal = {
    id,
    cardId,
    patch: body.patch,
    confirm: Array.isArray(body.confirm) ? body.confirm : [],
    author: body.author ?? "owner",
    summary: body.summary ?? "Card edited",
    status: "pending" as const,
    createdAt: new Date().toISOString(),
    appliedAt: null as string | null,
  };
  const dir = proposalsDir(cardId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(proposal, null, 2));
  return { ok: true, proposal };
}

// PATCH /cards/:id — propose a change (owner). Records a proposal, returns 202;
// it does NOT mutate the card. Confirm applies it.
app.patch("/cards/:id", { preHandler: [requireAuth, requireOwner] }, async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const made = await createProposal(id, (req.body ?? {}) as CardPatchBody);
  if (!made.ok) return reply.code(made.code).send({ ok: false, error: made.error });
  return reply.code(202).send({ ok: true, status: "pending", proposal: made.proposal });
});

// POST /cards/:id/propose — the same thing, named explicitly.
app.post("/cards/:id/propose", { preHandler: [requireAuth, requireOwner] }, async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const made = await createProposal(id, (req.body ?? {}) as CardPatchBody);
  if (!made.ok) return reply.code(made.code).send({ ok: false, error: made.error });
  return reply.code(202).send({ ok: true, status: "pending", proposal: made.proposal });
});

// POST /cards/:id/proposals/:pid/confirm — step 2: apply a pending proposal.
app.post(
  "/cards/:id/proposals/:pid/confirm",
  { preHandler: [requireAuth, requireOwner] },
  async (req, reply) => {
    const { id, pid } = req.params as { id: string; pid: string };
    if (!/^prp_[A-Za-z0-9]+$/.test(pid))
      return reply.code(400).send({ ok: false, error: "bad proposal id" });

    const file = path.join(proposalsDir(id), `${pid}.json`);
    let proposal: any;
    try {
      proposal = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return reply.code(404).send({ ok: false, error: "proposal not found" });
    }
    if (proposal.status !== "pending")
      return reply.code(409).send({ ok: false, error: `proposal is ${proposal.status}` });

    const applied = await applyCardPatch(id, {
      patch: proposal.patch,
      confirm: proposal.confirm,
      author: proposal.author,
      summary: proposal.summary,
    });
    if (!applied.ok)
      return reply.code(applied.code).send({ ok: false, error: applied.error });

    proposal.status = "applied";
    proposal.appliedAt = new Date().toISOString();
    await fs.writeFile(file, JSON.stringify(proposal, null, 2)).catch(() => {});

    return reply.code(200).send({
      ok: true,
      status: "applied",
      proposalId: pid,
      card: applied.card,
      fieldsChanged: applied.fieldsChanged,
    });
  }
);

// GET /cards/:id/proposals — proposal history for a card (owner).
app.get("/cards/:id/proposals", { preHandler: [requireAuth, requireOwner] }, async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const dir = proposalsDir(id);
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const out: any[] = [];
  for (const f of files.filter((n) => n.endsWith(".json"))) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir, f), "utf8")));
    } catch {
      /* skip unreadable */
    }
  }
  return reply.code(200).send({ ok: true, proposals: out });
});

// GET /companies — list helix companies + any extracted cards in CARDS dir
app.get("/companies", { preHandler: requireAuth }, async (req, reply) => {
  await ensureDirs();

  // TENANT ISOLATION — this used to return EVERY company on the box to any caller
  // holding a valid key: the entire client list, by name, to any stranger who
  // signed up. It was also why a fresh signup's dashboard logged a wall of 403s —
  // the company switcher enumerated all of them and then could not read any.
  //
  // You see YOUR company. Seeing others is a deliberate grant (multi-company
  // membership), never the default. There is no card or account for anyone else
  // in this response to leak.
  const auth = (req as AuthCarrier).auth;
  const mine = auth?.companyId ?? "";
  const isOperator = auth?.level === "operator";
  if (!mine && !isOperator) return reply.code(403).send({ ok: false, error: "no company for this credential" });

  // One company's dashboard entry — the card if it exists, else the signup
  // record (so a brand-new company sees itself rather than an empty list).
  const entryFor = async (id: string): Promise<object | null> => {
    try {
      const card = JSON.parse(await fs.readFile(path.join(HELIX_COMPANIES, id, "card.json"), "utf8"));
      return {
        id,
        name: card.identity?.name ?? id,
        cardVersion: card.version ?? 1,
        lastUpdated: card.created_at ?? "",
        source: "helix",
      };
    } catch {
      const acct = readAccount(id);
      return acct
        ? {
            id,
            name: acct.business ?? id,
            cardVersion: 0,
            lastUpdated: acct.createdAt ?? "",
            source: "signup",
            hasCard: false,
          }
        : null;
    }
  };

  // An operator sees every company (that IS the switcher grant); a normal key
  // sees only its own.
  const ids = isOperator ? listProvisionedCompanies() : [mine];
  const results: object[] = [];
  for (const id of ids) {
    const e = await entryFor(id);
    if (e) results.push(e);
  }

  return reply.code(200).send(results);
});

app.post("/cards/:id/compile", { preHandler: requireAuth }, async (req, reply) => {
  const p = await findCard((req.params as { id: string }).id);
  if (!p) return reply.code(404).send({ ok: false, error: "card not found" });
  const card = JSON.parse(await fs.readFile(p, "utf8"));
  const out = path.join(COMPILED, `${card.id}_v${card.version}`);
  const { code, err } = await run("node", [COMPILER_CLI, "--card", p, "--out", out]);
  if (code !== 0) return reply.code(500).send({ ok: false, error: err.slice(-2000) });
  return { ok: true, card_id: card.id, version: card.version, out_dir: out };
});

app.post("/compile", { preHandler: requireAuth }, async (req, reply) => {
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

    // Also emit CARD.md via the deterministic compiler CLI into the company dir.
    // This is the canonical human-readable + hash-stable representation of the card.
    if (COMPILER_CLI) {
      const companyDir = path.join(HELIX_COMPANIES, body.companyId);
      await fs.mkdir(companyDir, { recursive: true });
      const { code: cliCode, err: cliErr } = await run("node", [
        COMPILER_CLI, "--card", cardPath, "--out", companyDir,
      ]);
      if (cliCode !== 0) {
        req.log.warn({ companyId: body.companyId, err: cliErr.slice(-500) }, "CARD.md emit failed");
      }
    }

    return reply.code(200).send({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

app.get("/cards/:a/diff/:b", { preHandler: requireAuth }, async (req, reply) => {
  const { a, b } = req.params as { a: string; b: string };
  const pa = await findCard(a);
  const pb = await findCard(b);
  if (!pa || !pb) return reply.code(404).send({ ok: false, error: "card not found" });
  const { code, out, err } = await run("node", [COMPILER_CLI, "--card", pa, "--diff", pb]);
  if (code !== 0) return reply.code(500).send({ ok: false, error: err.slice(-2000) });
  return JSON.parse(out);
});

app.post("/greeting", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as { cardId?: string; companyId?: string };
  if (!body.cardId)    return reply.code(400).send({ ok: false, error: "cardId required" });
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });

  const companyId = body.companyId;
  let usageEntry: UsageEntry | null = null;
  try {
    usageEntry = await deductCredits(companyId, "greeting_compile");
  } catch (e) {
    if (e instanceof QuotaExceeded) return reply.code(402).send({ error: e.message });
    throw e;
  }

  const cardPath = await findCard(body.cardId);
  if (!cardPath) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    return reply.code(404).send({ ok: false, error: "card not found" });
  }

  try {
    const greeting = await compileGreeting({ cardPath, role: "front-desk" });
    return reply.code(200).send(greeting);
  } catch (e) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// ---------------------------------------------------------------------------
// Build status route
// ---------------------------------------------------------------------------

// GET /build-status — proxy the build-status.json written by helix-rebuild.sh
app.get("/build-status", { preHandler: requireAuth }, async (_req, reply) => {
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
app.get("/voices", { preHandler: requireAuth }, async () => getVoiceCatalog());

// POST /voices/resolve — resolve a voice_profile string against a stored card
app.post("/voices/resolve", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as { voiceProfile?: string; cardId?: string };
  if (!body.cardId) return reply.code(400).send({ ok: false, error: "cardId required" });

  const cardPath = await findCard(body.cardId);
  if (!cardPath) return reply.code(404).send({ ok: false, error: "card not found" });

  const card = JSON.parse(await fs.readFile(cardPath, "utf8"));
  const resolved = resolveVoice(body.voiceProfile ?? "", card);
  return reply.code(200).send(resolved);
});

// POST /voices/sample — synthesise a short TTS preview clip
app.post("/voices/sample", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as { voiceProfile?: string; text?: string };
  if (!body.voiceProfile) return reply.code(400).send({ ok: false, error: "voiceProfile required" });
  if (!body.text)         return reply.code(400).send({ ok: false, error: "text required" });

  // resolveVoice with an empty card object — we only need provider/endpoint from the profile string
  const resolved = resolveVoice(body.voiceProfile, {});
  const result = await synthesizeSample(resolved, body.text);
  return reply.code(200).send(result);
});

// GET /voices — async version that appends live ElevenLabs voices when key is set
// (override the earlier sync route)
app.get("/voices/catalog", { preHandler: requireAuth }, async () => getVoiceCatalogAsync());

// GET /voices/elevenlabs — live ElevenLabs voice list
app.get("/voices/elevenlabs", { preHandler: requireAuth }, async (_req, reply) => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return reply.code(503).send({ ok: false, error: "ELEVENLABS_API_KEY not configured" });
  }
  try {
    const voices = await getElevenLabsVoices();
    return reply.code(200).send(voices);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(503).send({ ok: false, error: msg });
  }
});

// ---------------------------------------------------------------------------
// Voice jingle routes
// ---------------------------------------------------------------------------

// POST /voice/jingle — generate (or regenerate) a brand jingle for a company
app.post("/voice/jingle", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as { companyId?: string };
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });

  const companyId = body.companyId;
  let usageEntry: UsageEntry | null = null;
  try {
    usageEntry = await deductCredits(companyId, "voice_jingle");
  } catch (e) {
    if (e instanceof QuotaExceeded) return reply.code(402).send({ error: (e as Error).message });
    throw e;
  }

  const cardPath = await findCard(companyId);
  if (!cardPath) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    return reply.code(404).send({ ok: false, error: "card not found" });
  }

  try {
    const card   = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const jingle = await generateJingle(card, companyId);
    return reply.code(200).send({ ok: true, jingle });
  } catch (e) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// GET /voice/jingle/:companyId — fetch stored jingle
app.get("/voice/jingle/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const jingle = getJingle(companyId);
  if (!jingle) return reply.code(404).send({ ok: false, error: "no jingle found for company" });
  return reply.code(200).send(jingle);
});

// ---------------------------------------------------------------------------
// Agent routes  (@fastify/websocket not available — using POST session instead)
// ---------------------------------------------------------------------------

// POST /agent/session — stateless agent turn: compile role config + call AI
app.post("/agent/session", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as {
    companyId?: string;
    cardId?: string;
    role?: string;
    message?: string;
  };
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });
  if (!body.message)   return reply.code(400).send({ ok: false, error: "message required" });

  const companyId = body.companyId;
  let usageEntry: UsageEntry | null = null;
  try {
    usageEntry = await deductCredits(companyId, "playground_message");
  } catch (e) {
    if (e instanceof QuotaExceeded) return reply.code(402).send({ error: (e as Error).message });
    throw e;
  }

  const cardId   = body.cardId ?? companyId;
  const cardPath = await findCard(cardId);
  if (!cardPath) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    return reply.code(404).send({ ok: false, error: "card not found" });
  }

  try {
    const card = JSON.parse(await fs.readFile(cardPath, "utf8"));

    // Derive soul/system-prompt for the requested role by compiling the card in-memory
    const VALID_ROLES: AgentRole[] = ["front-desk", "sales", "content", "owner-manager"];
    const role: AgentRole = VALID_ROLES.includes(body.role as AgentRole)
      ? (body.role as AgentRole)
      : "front-desk";

    // Build a lightweight agent config without writing to disk
    const companyName  = card?.identity?.name ?? companyId;
    const personality  = card?.voice?.personality ?? "Friendly and helpful.";
    const tone         = (card?.voice?.tone as string[] | undefined ?? []).join(", ");
    const systemPrompt =
      `You are the ${role} agent for ${companyName}. ${personality}` +
      (tone ? ` Tone: ${tone}.` : "") +
      " Answer only based on the company information you know. Be concise.";

    const agentConfig = {
      role,
      companyId,
      companyName,
      systemPrompt,
      personality,
      tone,
    };

    const sessionId = `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

    const aiResp = await aiGateway.call({
      prompt: body.message,
      systemPrompt,
      temperature: 0.65,
      maxTokens: 512,
      cacheKey: `agent:${companyId}:${role}:${body.message.slice(0, 80)}`,
    });

    return reply.code(200).send({
      ok: true,
      sessionId,
      response: aiResp.text,
      role,
      agentConfig,
    });
  } catch (e) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// GET /agent/config/:companyId — compile + return agent config map for all roles (debug)
app.get("/agent/config/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const cardPath = await findCard(companyId);
  if (!cardPath) return reply.code(404).send({ ok: false, error: "card not found" });

  try {
    const card = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const ALL_ROLES: AgentRole[] = ["front-desk", "sales", "content", "owner-manager"];
    const companyName = card?.identity?.name ?? companyId;
    const personality = card?.voice?.personality ?? "Friendly and helpful.";
    const tone        = (card?.voice?.tone as string[] | undefined ?? []).join(", ");

    const configs: Record<string, object> = {};
    for (const role of ALL_ROLES) {
      configs[role] = {
        role,
        companyId,
        companyName,
        personality,
        tone,
        systemPrompt:
          `You are the ${role} agent for ${companyName}. ${personality}` +
          (tone ? ` Tone: ${tone}.` : ""),
      };
    }
    return reply.code(200).send({ ok: true, companyId, configs });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// ---------------------------------------------------------------------------
// Changelog routes
// ---------------------------------------------------------------------------

// GET /changelog/:companyId — full changelog JSON
app.get("/changelog/:companyId", { preHandler: requireAuth }, async (req, reply) => {
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
app.get("/changelog/:companyId/verify", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const changelogPath = path.join(HELIX_COMPANIES, companyId, "changelog.json");
  const result = await verifyChain(changelogPath);
  return reply.code(200).send(result);
});

// GET /changelog/:companyId/markdown — human-readable history
app.get("/changelog/:companyId/markdown", { preHandler: requireAuth }, async (req, reply) => {
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
app.get("/health/:companyId", { preHandler: requireAuth }, async (req, reply) => {
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
app.post("/content/prd", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as { cardId?: string; goal?: string; channels?: string[]; companyId?: string };
  if (!body.cardId)   return reply.code(400).send({ ok: false, error: "cardId required" });
  if (!body.goal)     return reply.code(400).send({ ok: false, error: "goal required" });
  if (!Array.isArray(body.channels) || body.channels.length === 0)
    return reply.code(400).send({ ok: false, error: "channels[] required" });

  const companyId = body.companyId ?? "default";
  let usageEntry: UsageEntry | null = null;
  try {
    usageEntry = await deductCredits(companyId, "campaign_prd");
  } catch (e) {
    if (e instanceof QuotaExceeded) return reply.code(402).send({ error: e.message });
    throw e;
  }

  const cardPath = await findCard(body.cardId);
  if (!cardPath) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    return reply.code(404).send({ ok: false, error: "card not found" });
  }

  try {
    const card = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const prd  = await generateCampaignPRD(card, body.goal, body.channels as Channel[]);
    return reply.code(200).send({ ok: true, prd });
  } catch (e) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// POST /content/generate — generate assets for all user stories in a PRD
app.post("/content/generate", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as { cardId?: string; prd?: CampaignPRD; companyId?: string };
  if (!body.cardId) return reply.code(400).send({ ok: false, error: "cardId required" });
  if (!body.prd)    return reply.code(400).send({ ok: false, error: "prd required" });

  const companyId = body.companyId ?? "default";
  let usageEntry: UsageEntry | null = null;
  try {
    usageEntry = await deductCredits(companyId, "campaign_assets");
  } catch (e) {
    if (e instanceof QuotaExceeded) return reply.code(402).send({ error: e.message });
    throw e;
  }

  const cardPath = await findCard(body.cardId);
  if (!cardPath) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    return reply.code(404).send({ ok: false, error: "card not found" });
  }

  try {
    const card   = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const assets = await generateCampaignAssets(body.prd, card);
    return reply.code(200).send({ ok: true, assets });
  } catch (e) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// POST /content/approve/:assetId — submit an asset to SparkGatekeeper hold queue
app.post("/content/approve/:assetId", { preHandler: requireAuth }, async (req, reply) => {
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

// GET /content/assets/:assetId — fetch a single asset by id
app.get("/content/assets/:assetId", { preHandler: requireAuth }, async (req, reply) => {
  const { assetId } = req.params as { assetId: string };
  const asset = assetStore.get(assetId);
  if (!asset) return reply.code(404).send({ ok: false, error: "asset not found" });
  return reply.code(200).send(asset);
});

// POST /content/schedule/:assetId — schedule an asset for future publishing
app.post("/content/schedule/:assetId", { preHandler: requireAuth }, async (req, reply) => {
  const { assetId } = req.params as { assetId: string };
  const body = (req.body ?? {}) as { companyId?: string; publishAt?: string };
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });
  if (!body.publishAt) return reply.code(400).send({ ok: false, error: "publishAt required" });

  const asset = assetStore.get(assetId);
  if (!asset) return reply.code(404).send({ ok: false, error: "asset not found" });

  const entry = scheduleAsset(assetId, body.companyId, body.publishAt);
  return reply.code(200).send({ ok: true, scheduled: entry });
});

// GET /content/schedule/:companyId — list all scheduled assets for a company
app.get("/content/schedule/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const scheduled = getScheduledAssets(companyId);
  return reply.code(200).send({ ok: true, scheduled });
});

// DELETE /content/schedule/:assetId — cancel a scheduled asset
app.delete("/content/schedule/:assetId", { preHandler: requireAuth }, async (req, reply) => {
  const { assetId } = req.params as { assetId: string };
  const removed = cancelSchedule(assetId);
  if (!removed) return reply.code(404).send({ ok: false, error: "no schedule found for asset" });
  return reply.code(200).send({ ok: true });
});

// GET /content/campaign/:campaignId/zip — export campaign assets as JSON bundle download
app.get("/content/campaign/:campaignId/zip", { preHandler: requireAuth }, async (req, reply) => {
  const { campaignId } = req.params as { campaignId: string };
  const prd = prdStore.get(campaignId);
  if (!prd) return reply.code(404).send({ ok: false, error: "campaign not found" });

  const assets = Array.from(assetStore.values()).filter(
    (a) => a.campaignId === campaignId,
  );

  const bundle = { campaignId, prd, assets };
  return reply
    .code(200)
    .header("Content-Type", "application/json")
    .header("Content-Disposition", `attachment; filename="campaign-${campaignId}.json"`)
    .send(JSON.stringify(bundle, null, 2));
});

// ---------------------------------------------------------------------------
// Sales pipeline routes  (outreach H-gated via SparkGatekeeper)
// ---------------------------------------------------------------------------

// POST /sales/hunt — Apollo.io lead hunting for a company's target profile
app.post("/sales/hunt", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as {
    cardId?: string;
    companyId?: string;
    filters?: { industry?: string; location?: string; size?: string; keywords?: string[] };
  };
  if (!body.cardId)    return reply.code(400).send({ ok: false, error: "cardId required" });
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });

  const companyId = body.companyId;
  let usageEntry: UsageEntry | null = null;
  try {
    usageEntry = await deductCredits(companyId, "sales_lead_hunt");
  } catch (e) {
    if (e instanceof QuotaExceeded) return reply.code(402).send({ error: e.message });
    throw e;
  }

  const cardPath = await findCard(body.cardId);
  if (!cardPath) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    return reply.code(404).send({ ok: false, error: "card not found" });
  }

  try {
    const card  = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const leads = await huntLeadsApollo(body.companyId, card, body.filters ?? {});
    return reply.code(200).send({ ok: true, leads });
  } catch (e) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// POST /sales/hunt/gps — OSM/Overpass lead hunting by GPS coordinates
app.post("/sales/hunt/gps", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as {
    lat?: unknown;
    lng?: unknown;
    industry?: unknown;
    radiusMeters?: unknown;
    companyId?: string;
  };

  if (typeof body.lat !== "number")
    return reply.code(400).send({ ok: false, error: "lat must be a number" });
  if (typeof body.lng !== "number")
    return reply.code(400).send({ ok: false, error: "lng must be a number" });
  if (typeof body.industry !== "string" || body.industry.trim() === "")
    return reply.code(400).send({ ok: false, error: "industry must be a non-empty string" });
  if (!body.companyId)
    return reply.code(400).send({ ok: false, error: "companyId required" });

  const radiusMeters =
    typeof body.radiusMeters === "number" && body.radiusMeters > 0
      ? body.radiusMeters
      : 5000;

  try {
    const leads = await huntLeadsOSM({
      lat:          body.lat,
      lng:          body.lng,
      industry:     body.industry.trim(),
      radiusMeters,
      companyId:    body.companyId,
    });
    return reply.code(200).send({ ok: true, leads, count: leads.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// POST /sales/qualify/:leadId — score + qualify a lead against the company card
app.post("/sales/qualify/:leadId", { preHandler: requireAuth }, async (req, reply) => {
  const { leadId } = req.params as { leadId: string };
  const body = (req.body ?? {}) as { cardId?: string; companyId?: string };
  if (!body.cardId) return reply.code(400).send({ ok: false, error: "cardId required" });

  const lead = leadStore.get(leadId);
  if (!lead) return reply.code(404).send({ ok: false, error: "lead not found" });

  const companyId = body.companyId ?? lead.companyId ?? "default";
  let usageEntry: UsageEntry | null = null;
  try {
    usageEntry = await deductCredits(companyId, "sales_qualify");
  } catch (e) {
    if (e instanceof QuotaExceeded) return reply.code(402).send({ error: e.message });
    throw e;
  }

  const cardPath = await findCard(body.cardId);
  if (!cardPath) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    return reply.code(404).send({ ok: false, error: "card not found" });
  }

  try {
    const card    = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const updated = await qualifyLead(lead, card);
    return reply.code(200).send({ ok: true, lead: updated });
  } catch (e) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// POST /sales/qualify/bulk/:companyId — qualify every lead for a company in one pass
app.post("/sales/qualify/bulk/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const body = (req.body ?? {}) as { cardId?: string };
  if (!body.cardId) return reply.code(400).send({ ok: false, error: "cardId required" });

  let usageEntry: UsageEntry | null = null;
  try {
    usageEntry = await deductCredits(companyId, "sales_qualify_bulk");
  } catch (e) {
    if (e instanceof QuotaExceeded) return reply.code(402).send({ error: e.message });
    throw e;
  }

  const cardPath = await findCard(body.cardId);
  if (!cardPath) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    return reply.code(404).send({ ok: false, error: "card not found" });
  }

  const leads = getLeadsByCompany(companyId);
  if (leads.length === 0) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    return reply.code(200).send({ ok: true, leads: [], count: 0 });
  }

  try {
    const card    = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const updated = await bulkQualify(leads, card);
    return reply.code(200).send({ ok: true, leads: updated, count: updated.length });
  } catch (e) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// POST /sales/outreach/:leadId — generate personalized outreach draft
app.post("/sales/outreach/:leadId", { preHandler: requireAuth }, async (req, reply) => {
  const { leadId } = req.params as { leadId: string };
  const body = (req.body ?? {}) as { cardId?: string; companyId?: string };
  if (!body.cardId) return reply.code(400).send({ ok: false, error: "cardId required" });

  const lead = leadStore.get(leadId);
  if (!lead) return reply.code(404).send({ ok: false, error: "lead not found" });

  const companyId = body.companyId ?? lead.companyId ?? "default";
  let usageEntry: UsageEntry | null = null;
  try {
    usageEntry = await deductCredits(companyId, "sales_outreach");
  } catch (e) {
    if (e instanceof QuotaExceeded) return reply.code(402).send({ error: e.message });
    throw e;
  }

  const cardPath = await findCard(body.cardId);
  if (!cardPath) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    return reply.code(404).send({ ok: false, error: "card not found" });
  }

  try {
    const card  = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const draft = await generateOutreach(lead, card);
    return reply.code(200).send({ ok: true, draft });
  } catch (e) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// POST /sales/review/:leadId — sales-manager deal health review
app.post("/sales/review/:leadId", { preHandler: requireAuth }, async (req, reply) => {
  const { leadId } = req.params as { leadId: string };
  const body = (req.body ?? {}) as { cardId?: string; companyId?: string };
  if (!body.cardId) return reply.code(400).send({ ok: false, error: "cardId required" });

  const lead = leadStore.get(leadId);
  if (!lead) return reply.code(404).send({ ok: false, error: "lead not found" });

  const companyId = body.companyId ?? lead.companyId ?? "default";
  let usageEntry: UsageEntry | null = null;
  try {
    usageEntry = await deductCredits(companyId, "sales_review");
  } catch (e) {
    if (e instanceof QuotaExceeded) return reply.code(402).send({ error: e.message });
    throw e;
  }

  const cardPath = await findCard(body.cardId);
  if (!cardPath) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    return reply.code(404).send({ ok: false, error: "card not found" });
  }

  try {
    const card   = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const review = await reviewDeal(lead, card);
    return reply.code(200).send({ ok: true, review });
  } catch (e) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// POST /sales/close/:leadId — generate full closing script + proposal tiers
app.post("/sales/close/:leadId", { preHandler: requireAuth }, async (req, reply) => {
  const { leadId } = req.params as { leadId: string };
  const body = (req.body ?? {}) as { cardId?: string; companyId?: string };
  if (!body.cardId) return reply.code(400).send({ ok: false, error: "cardId required" });

  const lead = leadStore.get(leadId);
  if (!lead) return reply.code(404).send({ ok: false, error: "lead not found" });

  const companyId = body.companyId ?? lead.companyId ?? "default";
  let usageEntry: UsageEntry | null = null;
  try {
    usageEntry = await deductCredits(companyId, "sales_close");
  } catch (e) {
    if (e instanceof QuotaExceeded) return reply.code(402).send({ error: e.message });
    throw e;
  }

  const cardPath = await findCard(body.cardId);
  if (!cardPath) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    return reply.code(404).send({ ok: false, error: "card not found" });
  }

  try {
    const card   = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const result = await generateClosingScript(lead, card);
    return reply.code(200).send({ ok: true, ...result });
  } catch (e) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// POST /sales/submit/:leadId — submit outreach draft to SparkGatekeeper hold queue
app.post("/sales/submit/:leadId", { preHandler: requireAuth }, async (req, reply) => {
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
      linkedinMessage: string;
      callScript: string;
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
app.get("/sales/pipeline/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const summary = getPipelineSummary(companyId);
  return reply.code(200).send({ ok: true, companyId, ...summary });
});

// GET /sales/leads/:companyId — all leads for a company
app.get("/sales/leads/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const leads = getLeadsByCompany(companyId);
  return reply.code(200).send({ ok: true, leads });
});

// GET /sales/leads/:leadId/activity — activity log for a single lead
app.get("/sales/leads/:leadId/activity", { preHandler: requireAuth }, async (req, reply) => {
  const { leadId } = req.params as { leadId: string };
  const lead = leadStore.get(leadId);
  if (!lead) return reply.code(404).send({ ok: false, error: "lead not found" });
  return reply.code(200).send({ ok: true, leadId, activityLog: lead.activityLog });
});

// PATCH /sales/leads/:leadId — update status and/or add a note
app.patch("/sales/leads/:leadId", { preHandler: requireAuth }, async (req, reply) => {
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
app.get("/channels/:companyId", { preHandler: requireAuth }, async (req, reply) => {
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
app.post("/channels/email", { preHandler: requireAuth }, async (req, reply) => {
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
app.post("/channels/social", { preHandler: requireAuth }, async (req, reply) => {
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
app.post("/images/generate", { preHandler: requireAuth }, async (req, reply) => {
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
app.get("/images/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const images = getCompanyImages(companyId);
  return reply.code(200).send(images);
});

// ---------------------------------------------------------------------------
// Intel routes  (appendix-only — owner planning, never customer-visible)
// ---------------------------------------------------------------------------

// POST /intel/battle — compare two BrandDNA cards head-to-head
app.post("/intel/battle", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as { cardIdA?: string; cardIdB?: string; companyId?: string };
  if (!body.cardIdA) return reply.code(400).send({ ok: false, error: "cardIdA required" });
  if (!body.cardIdB) return reply.code(400).send({ ok: false, error: "cardIdB required" });

  const companyId = body.companyId ?? "default";
  let usageEntry: UsageEntry | null = null;
  try {
    usageEntry = await deductCredits(companyId, "intel_battle");
  } catch (e) {
    if (e instanceof QuotaExceeded) return reply.code(402).send({ error: e.message });
    throw e;
  }

  const [pathA, pathB] = await Promise.all([findCard(body.cardIdA), findCard(body.cardIdB)]);
  if (!pathA) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    return reply.code(404).send({ ok: false, error: `card not found: ${body.cardIdA}` });
  }
  if (!pathB) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    return reply.code(404).send({ ok: false, error: `card not found: ${body.cardIdB}` });
  }

  try {
    const [cardA, cardB] = await Promise.all([
      fs.readFile(pathA, "utf8").then(JSON.parse),
      fs.readFile(pathB, "utf8").then(JSON.parse),
    ]);
    const report = await runBattleMode(cardA, cardB);
    return reply.code(200).send(report);
  } catch (e) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// POST /intel/simulate — test a brand variant and get simulated audience feedback
app.post("/intel/simulate", { preHandler: requireAuth }, async (req, reply) => {
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
app.post("/intel/trends", { preHandler: requireAuth }, async (req, reply) => {
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
app.post("/analytics/call", { preHandler: requireAuth }, async (req, reply) => {
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
app.get("/analytics/:companyId", { preHandler: requireAuth }, async (req, reply) => {
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
app.get("/metering/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  return reply.code(200).send(getCreditSummary(companyId));
});

// POST /metering/init/:companyId — initialize a free-tier account
app.post("/metering/init/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  // initAccount now refuses unknown companies (it used to mint 100 free credits
  // for any id). Surface that as a 404, not a 500.
  try {
    return reply.code(200).send(initAccount(companyId));
  } catch {
    return reply.code(404).send({ ok: false, error: "unknown company" });
  }
});

// GET /metering/:companyId/history — usage log with optional from/to filters
app.get("/metering/:companyId/history", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const { from, to } = req.query as { from?: string; to?: string };

  const account = getCreditSummary(companyId);
  let log = account.usageLog;

  if (from) {
    const fromDate = new Date(from);
    log = log.filter((e) => new Date(e.timestamp) >= fromDate);
  }
  if (to) {
    const toDate = new Date(to);
    log = log.filter((e) => new Date(e.timestamp) <= toDate);
  }

  return reply.code(200).send({ ok: true, companyId, total: log.length, entries: log });
});

// POST /metering/topup/:companyId — admin top-up credits
app.post("/metering/topup/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const body = (req.body ?? {}) as { credits?: number; reason?: string };

  if (typeof body.credits !== "number" || body.credits <= 0)
    return reply.code(400).send({ ok: false, error: "credits (positive number) required" });

  try {
    const entry = await topUpCredits(companyId, body.credits, body.reason ?? "admin_topup");
    return reply.code(200).send({ ok: true, entry });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// ---------------------------------------------------------------------------
// Playground routes  (isolated test environment — no writes to live agent dirs)
// ---------------------------------------------------------------------------

// POST /playground/session — create a new playground session
app.post("/playground/session", { preHandler: requireAuth }, async (req, reply) => {
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
app.post("/playground/message", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as { sessionId?: string; message?: string; companyId?: string };
  if (!body.sessionId) return reply.code(400).send({ ok: false, error: "sessionId required" });
  if (!body.message)   return reply.code(400).send({ ok: false, error: "message required" });

  const companyId = body.companyId ?? "default";
  let usageEntry: UsageEntry | null = null;
  try {
    usageEntry = await deductCredits(companyId, "playground_message");
  } catch (e) {
    if (e instanceof QuotaExceeded) return reply.code(402).send({ error: e.message });
    throw e;
  }

  try {
    const msg = await sendMessage(body.sessionId, body.message);
    return reply.code(200).send(msg);
  } catch (e) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    const code = msg.includes("not found") ? 404 : 500;
    return reply.code(code).send({ ok: false, error: msg });
  }
});

// POST /playground/test — run automated test suite against a session
app.post("/playground/test", { preHandler: requireAuth }, async (req, reply) => {
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
app.delete("/playground/session/:sessionId", { preHandler: requireAuth }, async (req, reply) => {
  const { sessionId } = req.params as { sessionId: string };
  clearSession(sessionId);
  return reply.code(200).send({ ok: true });
});

// GET /playground/sessions/:companyId — list all sessions for a company
app.get("/playground/sessions/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const list = getSessions(companyId);
  return reply.code(200).send(list);
});

// ---------------------------------------------------------------------------
// Business plan routes
// ---------------------------------------------------------------------------

// POST /plan/generate — generate a business plan draft from a card
app.post("/plan/generate", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as { cardId?: string; companyId?: string };
  if (!body.cardId)    return reply.code(400).send({ ok: false, error: "cardId required" });
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });

  const companyId = body.companyId;
  let usageEntry: UsageEntry | null = null;
  try {
    usageEntry = await deductCredits(companyId, "plan_generate");
  } catch (e) {
    if (e instanceof QuotaExceeded) return reply.code(402).send({ error: e.message });
    throw e;
  }

  const cardPath = await findCard(body.cardId);
  if (!cardPath) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    return reply.code(404).send({ ok: false, error: "card not found" });
  }

  try {
    const card = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const plan = await generateBusinessPlan(body.cardId, card);
    return reply.code(200).send(plan);
  } catch (e) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// GET /plan/:companyId — most recent plan for a company
app.get("/plan/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const plan = planStore.get(`latest:${companyId}`);
  if (!plan) return reply.code(404).send({ ok: false, error: "no plan found for company" });
  return reply.code(200).send(plan);
});

// GET /plan/:companyId/export — download plan as JSON attachment
app.get("/plan/:companyId/export", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const plan = planStore.get(`latest:${companyId}`);
  if (!plan) return reply.code(404).send({ ok: false, error: "no plan found for company" });
  return reply
    .code(200)
    .header("Content-Type", "application/json")
    .header("Content-Disposition", `attachment; filename="plan-${companyId}.json"`)
    .send(JSON.stringify(plan, null, 2));
});

// GET /plan/:companyId/html — HTML string for print-to-PDF
app.get("/plan/:companyId/html", { preHandler: requireAuth }, async (req, reply) => {
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
// Site routes (hardening #3)
//
// Two deliberately distinct flows:
//   PUBLISH  POST /site/generate — rebuild from cards via Hugo + rsync to the
//            web root, return the REAL public URL. Credits charged ONLY after
//            a successful build+deploy.
//   PREVIEW  POST /site/preview  — LLM single-file HTML held in memory for
//            review. Never public, never charged. (Formerly /site/generate.)
// ---------------------------------------------------------------------------

const PUBLIC_SITE_BASE =
  process.env.HELIX_PUBLIC_SITE || "https://helixmain.duckdns.org";
const PUBLISH_SCRIPT =
  process.env.HELIX_PUBLISH_SCRIPT || "/root/helixmain/infra/site-publish.sh";

function runPublish(companyId: string, timeoutMs = 180_000) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const p = spawn("/bin/bash", [PUBLISH_SCRIPT, companyId], {
      cwd: ROOT,
      env: { ...process.env, HELIX_CARD_ROOT: HELIX_COMPANIES },
    });
    let out = "", err = "";
    const timer = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch {}
      err += "\n[site-publish timed out]";
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out, err }); });
    p.on("error", (e) => { clearTimeout(timer); resolve({ code: 1, out, err: err + String(e) }); });
  });
}

// POST /site/generate — publish the company's page to the public site.
app.post("/site/generate", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as { companyId?: string };
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });
  const companyId = body.companyId;

  const cardPath = await findCard(companyId);
  if (!cardPath) return reply.code(404).send({ ok: false, error: "card not found" });

  // Refuse before doing the work; charge only AFTER success (below).
  const quota = checkQuota(companyId);
  if (!quota.allowed) {
    return reply.code(402).send({
      ok: false,
      error: `Quota exceeded for company ${companyId}. Remaining: ${quota.remaining}. Resets at: ${quota.resetAt}`,
    });
  }

  const started = Date.now();
  const build = await runPublish(companyId);
  if (build.code !== 0) {
    return reply.code(502).send({
      ok: false,
      published: false,
      error: `site build failed (exit ${build.code})`,
      stderr: build.err.slice(-2000),
    });
  }

  // Published. NOW charge — credits follow a real, publicly reachable page.
  let usage: UsageEntry;
  try {
    usage = await deductCredits(companyId, "site_generate");
  } catch (e) {
    if (e instanceof QuotaExceeded) return reply.code(402).send({ ok: false, error: (e as Error).message });
    throw e;
  }

  const url = `${PUBLIC_SITE_BASE}/b/${companyId}/`;
  return reply.code(200).send({
    ok: true,
    published: true,
    companyId,
    url,
    buildMs: Date.now() - started,
    creditsCharged: usage.creditsDeducted,
    generatedAt: new Date().toISOString(),
  });
});

// POST /site/preview — LLM single-file HTML preview (never public, never charged).
app.post("/site/preview", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as { companyId?: string };
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });

  const cardPath = await findCard(body.companyId);
  if (!cardPath) return reply.code(404).send({ ok: false, error: "card not found" });

  try {
    const card = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const result = await generateWebsite(card, body.companyId);
    return reply.code(200).send({
      ok: true,
      preview: true,
      companyId: body.companyId,
      previewUrl: `/api/site/${body.companyId}`,
      generatedAt: result.generatedAt,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// GET /site/:companyId — serve the PREVIEW HTML (not the public site).
app.get("/site/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const site = getWebsite(companyId);
  if (!site) return reply.code(404).send({ ok: false, error: "no preview generated for company" });
  return reply
    .code(200)
    .header("Content-Type", "text/html; charset=utf-8")
    .send(site.html);
});

// GET /sites — list all company IDs that have a generated site
app.get("/sites", { preHandler: requireAuth }, async (_req, reply) => {
  return reply.code(200).send({ ok: true, companies: listSites() });
});

// ---------------------------------------------------------------------------
// CRM routes
//
// Mutations are PROPOSED, then CONFIRMED — the same two-step the card routes
// use. crm.manage is reachable by any agent holding a company key, and a CRM
// write changes a business record an owner is accountable for; so the write
// routes below only ever RECORD a proposal (202, nothing touched), and a
// separate confirm route applies it under the owner credential.
//
// NOTE: crmLite is in-memory (no filesystem writes). The proposals ARE durable
// on disk, so a proposal can outlive the contact it targets: confirming an
// update whose contact vanished on an API restart is an honest 404, never a
// silent no-op.
// ---------------------------------------------------------------------------

function crmProposalsDir(companyId: string): string {
  return path.join(HELIX_COMPANIES, companyId, "crm-proposals");
}

interface CrmProposalBody {
  companyId?: string;
  op?: "create" | "update";
  contactId?: string;
  contact?: Record<string, unknown>;
  stage?: string;
  note?: string;
  updates?: Record<string, unknown>;
  cardId?: string;
  author?: string;
  summary?: string;
}

/** Apply a recorded CRM proposal to the in-memory store. */
async function applyCrmProposal(
  p: Record<string, any>
): Promise<{ ok: true; op: string; contact: any } | { ok: false; error: string; code: number }> {
  try {
    if (p.op === "create") {
      return { ok: true, op: "create", contact: createContact(p.companyId, (p.contact ?? {}) as any) };
    }
    if (p.op !== "update") return { ok: false, error: `unknown op: ${p.op}`, code: 400 };

    const existing = contactStore.get(p.contactId);
    if (!existing) return { ok: false, error: "contact not found", code: 404 };
    // Tenant scope: the proposal names a company; the contact must belong to it.
    const owner = (existing as { companyId?: string }).companyId;
    if (owner && p.companyId && owner !== p.companyId) {
      return { ok: false, error: "contact belongs to another company", code: 403 };
    }

    let contact = existing;
    if (p.stage) {
      // Stage move requires a card for validation; load it if cardId provided
      let card: any = {};
      if (p.cardId) {
        const cardPath = await findCard(p.cardId);
        if (cardPath) card = JSON.parse(await fs.readFile(cardPath, "utf8"));
      }
      contact = moveStage(p.contactId, p.stage, card);
    }
    if (p.note) contact = addContactNote(p.contactId, p.note, "owner");
    if (p.updates && typeof p.updates === "object") {
      contact = updateContact(p.contactId, p.updates as any);
    }
    return { ok: true, op: "update", contact };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = msg.includes("not found") ? 404 : msg.includes("Invalid stage") ? 400 : 500;
    return { ok: false, error: msg, code };
  }
}

/** Record a CRM proposal. Writes nothing to any contact. */
async function createCrmProposal(
  companyId: string,
  body: CrmProposalBody
): Promise<
  | { ok: true; proposal: Record<string, any> }
  | { ok: false; error: string; code: number }
> {
  const op = body.op;
  if (op !== "create" && op !== "update")
    return { ok: false, error: "op must be create|update", code: 400 };
  if (op === "create" && (!body.contact || typeof body.contact !== "object"))
    return { ok: false, error: "op=create needs a `contact` object", code: 400 };
  if (op === "update") {
    if (!body.contactId) return { ok: false, error: "op=update needs `contactId`", code: 400 };
    if (!body.stage && !body.note && !body.updates)
      return { ok: false, error: "op=update needs one of stage/note/updates", code: 400 };
    // This route carries no company in its path, so requireAuth has nothing to
    // bind to — without an explicit check a valid key for company A could draft
    // a change to company B's contact by id alone. (Same shape as the PATCH bug.)
    const existing = contactStore.get(body.contactId);
    if (!existing) return { ok: false, error: "contact not found", code: 404 };
    const owner = (existing as { companyId?: string }).companyId;
    if (owner && owner !== companyId)
      return { ok: false, error: "contact belongs to another company", code: 403 };
  }

  const id = "crp_" + randomUUID().slice(0, 8);
  const proposal = {
    id,
    companyId,
    op,
    contactId: body.contactId ?? null,
    contact: body.contact ?? null,
    stage: body.stage ?? null,
    note: body.note ?? null,
    updates: body.updates ?? null,
    cardId: body.cardId ?? null,
    author: body.author ?? "owner",
    summary: body.summary ?? (op === "create" ? "Create contact" : "Update contact"),
    status: "pending" as const,
    createdAt: new Date().toISOString(),
    appliedAt: null as string | null,
  };
  const dir = crmProposalsDir(companyId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(proposal, null, 2));
  return { ok: true, proposal };
}

// POST /crm/contacts — PROPOSE a new contact. Records a proposal, returns 202;
// it does NOT create the contact. Confirm applies it.
app.post("/crm/contacts", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as CrmProposalBody;
  const companyId = body.companyId ?? (req as AuthCarrier).auth?.companyId;
  if (!companyId) return reply.code(400).send({ ok: false, error: "companyId required" });
  const made = await createCrmProposal(companyId, { ...body, op: "create" });
  if (!made.ok) return reply.code(made.code).send({ ok: false, error: made.error });
  return reply.code(202).send({ ok: true, status: "pending", proposal: made.proposal });
});

// GET /crm/contacts/:companyId — all contacts for a company
app.get("/crm/contacts/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const contacts = getContacts(companyId);
  return reply.code(200).send(contacts);
});

// GET /crm/contacts/:companyId/stage/:stage — contacts filtered by pipeline stage
app.get("/crm/contacts/:companyId/stage/:stage", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId, stage } = req.params as { companyId: string; stage: string };
  const contacts = getContactsByStage(companyId, stage);
  return reply.code(200).send(contacts);
});

// PATCH /crm/contacts/:contactId — PROPOSE a stage move / note / field update.
// Records a proposal, returns 202; it does NOT mutate the contact.
app.patch("/crm/contacts/:contactId", { preHandler: requireAuth }, async (req, reply) => {
  const { contactId } = req.params as { contactId: string };
  const body = (req.body ?? {}) as CrmProposalBody;
  const companyId = body.companyId ?? (req as AuthCarrier).auth?.companyId;
  if (!companyId) return reply.code(400).send({ ok: false, error: "companyId required" });
  const made = await createCrmProposal(companyId, { ...body, op: "update", contactId });
  if (!made.ok) return reply.code(made.code).send({ ok: false, error: made.error });
  return reply.code(202).send({ ok: true, status: "pending", proposal: made.proposal });
});

// GET /crm/proposals/:companyId — proposal history for a company
app.get("/crm/proposals/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const dir = crmProposalsDir(companyId);
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const out: any[] = [];
  for (const f of files.filter((n) => n.endsWith(".json"))) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir, f), "utf8")));
    } catch { /* skip unreadable */ }
  }
  return reply.code(200).send({ ok: true, proposals: out });
});

// POST /crm/proposals/:pid/confirm — step 2: apply a pending CRM proposal.
// Owner credential: proposing is cheap, applying a business-record change is not.
app.post(
  "/crm/proposals/:pid/confirm",
  { preHandler: [requireAuth, requireOwner] },
  async (req, reply) => {
    const { pid } = req.params as { pid: string };
    if (!/^crp_[A-Za-z0-9]+$/.test(pid))
      return reply.code(400).send({ ok: false, error: "bad proposal id" });

    // Proposals live under the CALLER's own company dir — requireAuth already
    // fixed the tenant, so there is no cross-company pid to guess.
    const companyId = (req as AuthCarrier).auth?.companyId;
    if (!companyId) return reply.code(400).send({ ok: false, error: "companyId required" });
    const file = path.join(crmProposalsDir(companyId), `${pid}.json`);

    let proposal: any;
    try {
      proposal = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return reply.code(404).send({ ok: false, error: "proposal not found" });
    }
    if (proposal.status !== "pending")
      return reply.code(409).send({ ok: false, error: `proposal is ${proposal.status}` });

    const applied = await applyCrmProposal(proposal);
    if (!applied.ok) return reply.code(applied.code).send({ ok: false, error: applied.error });

    proposal.status = "applied";
    proposal.appliedAt = new Date().toISOString();
    await fs.writeFile(file, JSON.stringify(proposal, null, 2)).catch(() => {});

    return reply.code(200).send({
      ok: true,
      status: "applied",
      proposalId: pid,
      op: applied.op,
      contact: applied.contact,
    });
  }
);

// POST /crm/proposals/:pid/deny — discard a pending CRM proposal. Nothing is applied.
app.post(
  "/crm/proposals/:pid/deny",
  { preHandler: [requireAuth, requireOwner] },
  async (req, reply) => {
    const { pid } = req.params as { pid: string };
    if (!/^crp_[A-Za-z0-9]+$/.test(pid))
      return reply.code(400).send({ ok: false, error: "bad proposal id" });
    const companyId = (req as AuthCarrier).auth?.companyId;
    if (!companyId) return reply.code(400).send({ ok: false, error: "companyId required" });
    const file = path.join(crmProposalsDir(companyId), `${pid}.json`);
    let proposal: any;
    try {
      proposal = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return reply.code(404).send({ ok: false, error: "proposal not found" });
    }
    if (proposal.status !== "pending")
      return reply.code(409).send({ ok: false, error: `proposal is ${proposal.status}` });
    proposal.status = "denied";
    proposal.appliedAt = new Date().toISOString();
    await fs.writeFile(file, JSON.stringify(proposal, null, 2)).catch(() => {});
    return reply.code(200).send({ ok: true, status: "denied", proposalId: pid });
  }
);

// GET /crm/summary/:companyId — CRM summary with stage counts and recent activity
app.get("/crm/summary/:companyId", { preHandler: requireAuth }, async (req, reply) => {
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

// ---------------------------------------------------------------------------
// Analytics — enriched summary, event log, cache-stats
// ---------------------------------------------------------------------------

// GET /analytics/:companyId — enriched with cross-store fields
app.get("/analytics/:companyId/enriched", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const { period = "week" } = req.query as { period?: string };

  const VALID_PERIODS = ["day", "week", "month"] as const;
  if (!VALID_PERIODS.includes(period as "day" | "week" | "month")) {
    return reply.code(400).send({ ok: false, error: "period must be day|week|month" });
  }

  try {
    const summary = await getAnalytics(companyId, period as "day" | "week" | "month");

    // Enrich — count approved/published campaign assets for this company
    const companyPrdIds = new Set<string>();
    for (const [prdId, prd] of prdStore.entries()) {
      if (prd.companyId === companyId) companyPrdIds.add(prdId);
    }
    let campaignsSent = 0;
    for (const asset of assetStore.values()) {
      if (companyPrdIds.has(asset.campaignId) &&
          (asset.status === "approved" || asset.status === "published")) {
        campaignsSent++;
      }
    }

    // Leads (all companies — system total)
    let leadsTotal = 0;
    let leadsConverted = 0;
    for (const lead of leadStore.values()) {
      leadsTotal++;
      if (lead.status === "converted") leadsConverted++;
    }

    // Credits used from account usage log
    const account = getCreditSummary(companyId);
    const creditsUsed = account.usageLog
      .filter((e) => !e.refunded && e.creditsDeducted > 0)
      .reduce((sum, e) => sum + e.creditsDeducted, 0);

    // Sites generated
    const sitesGenerated = listSites().length;

    return reply.code(200).send({
      ...summary,
      campaignsSent,
      leadsTotal,
      leadsConverted,
      creditsUsed,
      sitesGenerated,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// POST /analytics/event — log a generic event
app.post("/analytics/event", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as Partial<EventEntry>;
  if (!body.companyId)  return reply.code(400).send({ ok: false, error: "companyId required" });
  if (!body.eventType)  return reply.code(400).send({ ok: false, error: "eventType required" });

  const entry: EventEntry = {
    companyId: body.companyId,
    eventType: body.eventType,
    assetId:   body.assetId,
    leadId:    body.leadId,
    metadata:  body.metadata,
    timestamp: new Date().toISOString(),
  };
  logEvent(entry);
  return reply.code(200).send({ ok: true });
});

// GET /analytics/cache-stats — neural cache stats + cost log
app.get("/analytics/cache-stats", { preHandler: requireAuth }, async (_req, reply) => {
  const cacheStats = getCacheStats();
  const costSummary = costLog.getCostSummary();
  return reply.code(200).send({
    neuralCacheSize: cacheStats.size,
    costLog: {
      totalUsd:   Math.round(costSummary.totalUsd * 10000) / 10000,
      byProvider: Object.fromEntries(
        Object.entries(costSummary.byProvider).map(([k, v]) => [k, Math.round(v * 10000) / 10000]),
      ),
    },
  });
});

// ---------------------------------------------------------------------------
// Content — A/B variant routes
// ---------------------------------------------------------------------------

// POST /content/variants — generate A/B variants for a single user story
app.post("/content/variants", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as {
    prdId?: string;
    storyId?: string;
    companyId?: string;
    cardId?: string;
    count?: number;
  };
  if (!body.prdId)     return reply.code(400).send({ ok: false, error: "prdId required" });
  if (!body.storyId)   return reply.code(400).send({ ok: false, error: "storyId required" });
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });
  if (!body.cardId)    return reply.code(400).send({ ok: false, error: "cardId required" });

  const prd = prdStore.get(body.prdId);
  if (!prd) return reply.code(404).send({ ok: false, error: "PRD not found" });

  const companyId = body.companyId;
  let usageEntry: UsageEntry | null = null;
  try {
    usageEntry = await deductCredits(companyId, "campaign_assets");
  } catch (e) {
    if (e instanceof QuotaExceeded) return reply.code(402).send({ error: e.message });
    throw e;
  }

  const cardPath = await findCard(body.cardId);
  if (!cardPath) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    return reply.code(404).send({ ok: false, error: "card not found" });
  }

  try {
    const card     = JSON.parse(await fs.readFile(cardPath, "utf8"));
    const count    = typeof body.count === "number" && body.count > 0 ? Math.min(body.count, 4) : 2;
    const variants = await generateVariants(prd, card, body.storyId, count);
    return reply.code(200).send({ ok: true, variants });
  } catch (e) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// POST /content/variants/compare — compare a set of variant asset ids
app.post("/content/variants/compare", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as { variantIds?: string[] };
  if (!Array.isArray(body.variantIds) || body.variantIds.length === 0) {
    return reply.code(400).send({ ok: false, error: "variantIds[] required" });
  }
  const result = compareVariants(body.variantIds);
  return reply.code(200).send({ ok: true, ...result });
});

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

// GET /portfolio/:companyId — all assets produced for a company
app.get("/portfolio/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  try {
    const items = buildPortfolio(companyId);
    return reply.code(200).send(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// ---------------------------------------------------------------------------
// Billing config (no Stripe required)
// ---------------------------------------------------------------------------

// GET /billing/config — tier + pack pricing for the dashboard
app.get("/billing/config", { preHandler: requireAuth }, async (_req, reply) => {
  return reply.code(200).send({ tiers: TIER_PRICES, packs: CREDIT_PACKS });
});

// ---------------------------------------------------------------------------
// Stripe checkout + webhook + portal
// ---------------------------------------------------------------------------

// POST /billing/checkout — create a Stripe Checkout session
app.post("/billing/checkout", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as { companyId?: string; priceId?: string };
  if (!body.companyId) return reply.code(400).send({ ok: false, error: "companyId required" });
  if (!body.priceId)   return reply.code(400).send({ ok: false, error: "priceId required" });

  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_KEY) {
    return reply.code(200).send({
      ok: false,
      error: "Stripe not configured",
      mockUrl: "https://buy.stripe.com/test",
    });
  }

  // Determine mode: subscription for tiers, payment for packs
  const isTier = Object.values(TIER_PRICES).some((t) => t.priceId === body.priceId);
  const mode   = isTier ? "subscription" : "payment";

  const params = new URLSearchParams({
    mode,
    "line_items[0][price]":    body.priceId,
    "line_items[0][quantity]": "1",
    "metadata[companyId]":     body.companyId,
    success_url: `https://helixmain.duckdns.org/dashboard/billing?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `https://helixmain.duckdns.org/dashboard/billing`,
  });

  try {
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${Buffer.from(STRIPE_KEY + ":").toString("base64")}`,
        "Content-Type":  "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const err = await res.text();
      return reply.code(502).send({ ok: false, error: `Stripe error: ${err.slice(0, 500)}` });
    }

    const session = await res.json() as { url: string };
    return reply.code(200).send({ ok: true, checkoutUrl: session.url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(502).send({ ok: false, error: msg });
  }
});

// POST /billing/webhook — Stripe webhook handler
app.post("/billing/webhook", async (req, reply) => {
  const sig    = req.headers["stripe-signature"] as string | undefined;
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  // FAIL CLOSED. Credits enter the ledger through exactly one door — a VERIFIED
  // Stripe event — so an unverifiable body must never mint any. This route is
  // deliberately NOT behind requireAuth: Stripe cannot present our API key; its
  // signature IS the authentication. The previous version re-stringified the
  // parsed body (which can never reproduce Stripe's signed bytes, so the check
  // always failed) and then "processed anyway" — i.e. any POST minted credits.
  if (!secret) {
    req.log.warn("Stripe webhook hit but STRIPE_WEBHOOK_SECRET is unset — refusing");
    return reply.code(503).send({ ok: false, error: "webhook not configured" });
  }
  if (!sig) return reply.code(400).send({ ok: false, error: "missing stripe-signature" });

  const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
  if (!raw) return reply.code(400).send({ ok: false, error: "no raw body to verify" });

  // sig format: t=<timestamp>,v1=<hmac>,...
  const parts = sig.split(",").reduce<Record<string, string>>((acc, part) => {
    const [k, v] = part.split("=");
    if (k && v) acc[k] = v;
    return acc;
  }, {});
  const t  = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return reply.code(400).send({ ok: false, error: "malformed signature" });

  // Replay window — Stripe's own guidance is 5 minutes.
  const ageSec = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(ageSec) || ageSec > 300)
    return reply.code(400).send({ ok: false, error: "signature timestamp outside tolerance" });

  const expected = createHmac("sha256", secret)
    .update(`${t}.${raw.toString("utf8")}`)
    .digest("hex");
  const got = Buffer.from(v1, "utf8");
  const exp = Buffer.from(expected, "utf8");
  if (got.length !== exp.length || !timingSafeEqual(got, exp)) {
    req.log.warn("Stripe webhook signature verification FAILED");
    return reply.code(400).send({ ok: false, error: "signature verification failed" });
  }

  try {
    const event = req.body as {
      type: string;
      data: {
        object: {
          metadata?: { companyId?: string };
          line_items?: { data: Array<{ price: { id: string } }> };
          lines?: { data: Array<{ price: { id: string } }> };
        };
      };
    };

    if (
      event.type === "checkout.session.completed" ||
      event.type === "invoice.payment_succeeded"
    ) {
      const obj        = event.data.object;
      const companyId  = obj.metadata?.companyId;
      const priceId    =
        obj.line_items?.data?.[0]?.price?.id ??
        obj.lines?.data?.[0]?.price?.id;

      if (companyId && priceId) {
        const entry = PRICE_TO_CREDITS[priceId];
        if (entry) {
          await topUpCredits(companyId, entry.credits, "stripe_payment");
          if (entry.tier) {
            upgradeTier(companyId, entry.tier);
          }
        }
      }
    }
  } catch (e) {
    app.log.error(`Webhook processing error: ${e}`);
  }

  return reply.code(200).send({ received: true });
});

// GET /billing/portal/:companyId — Stripe customer portal
app.get("/billing/portal/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  // Tenant binding, stated where the route lives rather than leaning on the
  // blanket check: the portal is scoped to the caller's OWN company. (requireAuth
  // already 403s naming another ONBOARDED company; this also covers a company
  // that is provisioned but not yet onboarded, and survives any future refactor of
  // the blanket check.)
  const auth = (req as AuthCarrier).auth;
  if (auth && auth.level !== "operator" && auth.companyId !== companyId)
    return reply.code(403).send({ ok: false, error: "not your company" });
  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_KEY) {
    return reply.code(200).send({ ok: false, error: "Stripe not configured" });
  }

  // Stub: customer ID lookup not yet implemented
  // In a full implementation this would load customerId from a customer store
  const customerId: string | null = null;
  if (!customerId) {
    return reply.code(200).send({ ok: false, error: "No Stripe customer found" });
  }

  try {
    const params = new URLSearchParams({
      customer:   customerId,
      return_url: `https://helixmain.duckdns.org/dashboard/billing`,
    });

    const res = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${Buffer.from(STRIPE_KEY + ":").toString("base64")}`,
        "Content-Type":  "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const err = await res.text();
      return reply.code(502).send({ ok: false, error: `Stripe error: ${err.slice(0, 500)}` });
    }

    const session = await res.json() as { url: string };
    return reply.code(200).send({ ok: true, portalUrl: session.url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(502).send({ ok: false, error: msg });
  }
});

// ---------------------------------------------------------------------------
// Affiliate routes
// ---------------------------------------------------------------------------

// POST /affiliate/init/:companyId — generate referral code
app.post("/affiliate/init/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const account = generateReferralCode(companyId);
  return reply.code(200).send({ ok: true, account });
});

// GET /affiliate/:companyId — affiliate stats
app.get("/affiliate/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const stats = getAffiliateStats(companyId);
  return reply.code(200).send({ ok: true, ...stats });
});

// POST /affiliate/refer — record a referral
app.post("/affiliate/refer", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as { code?: string; newCompanyId?: string };
  if (!body.code)          return reply.code(400).send({ ok: false, error: "code required" });
  if (!body.newCompanyId)  return reply.code(400).send({ ok: false, error: "newCompanyId required" });

  const recorded = recordReferral(body.code, body.newCompanyId);
  if (!recorded) {
    return reply.code(404).send({ ok: false, error: "Referral code not found or invalid" });
  }
  return reply.code(200).send({ ok: true });
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

// GET /admin/health — system health snapshot (no auth — PIN enforced client-side)
app.get("/admin/health", { preHandler: requireAuth }, async (_req, reply) => {
  const cacheStats = getCacheStats();
  return reply.code(200).send({
    api: {
      status: "ok",
      uptime: process.uptime(),
    },
    stores: {
      leads:    leadStore.size,
      assets:   assetStore.size,
      prds:     prdStore.size,
      accounts: getAccountStoreSize(),
    },
    cache: {
      neural: cacheStats.size,
    },
  });
});

// GET /admin/sessions — all playground sessions across all companies
app.get("/admin/sessions", { preHandler: requireAuth }, async (_req, reply) => {
  // getSessions filters by companyId — use empty string to get all
  // Instead, call it without filter by gathering from all known companies
  const companyIds = Array.from(
    new Set([
      ...Array.from(leadStore.values()).map((l) => l.companyId),
      ...Array.from(assetStore.values()).map((a) => {
        const prd = prdStore.get(a.campaignId);
        return prd?.companyId ?? "";
      }),
    ].filter(Boolean)),
  );

  const allSessions: ReturnType<typeof getSessions> = [];
  const seen = new Set<string>();
  for (const cid of companyIds) {
    for (const s of getSessions(cid)) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        allSessions.push(s);
      }
    }
  }

  return reply.code(200).send({ ok: true, sessions: allSessions, total: allSessions.length });
});

// ---------------------------------------------------------------------------
// Auth — ONE credential. The owner logs in with a passkey (or a one-time
// enrollment link) and the server maps that to their company. The per-company
// API key stays server-side; it is never typed into a browser.
//
// NOTE: these routes are DELIBERATELY unauthenticated — they ARE the login. Any
// future route-gating sweep must EXCLUDE the `/auth/` prefix or it will lock the
// dashboard out of itself.
// ---------------------------------------------------------------------------

function readChallenge(
  req: FastifyRequest,
): { challenge?: string; company?: string; kind?: string; state?: string } | null {
  const raw = parseCookies(req.headers.cookie)[CHALLENGE_COOKIE];
  return verifyJson<{
    exp: number;
    challenge?: string;
    company?: string;
    kind?: string;
    state?: string; // OAuth round-trip nonce
  }>(raw);
}

// Step 1 of enrollment: an operator-issued token buys the registration options.
app.post("/auth/register/options", async (req, reply) => {
  const body = (req.body ?? {}) as { token?: string };
  const company = resolveEnrollToken(body.token ?? "");
  if (!company) {
    return reply.code(403).send({ ok: false, error: "invalid or expired enrollment token" });
  }
  const options = await registrationOptions(company, credsFor(company));
  reply.header(
    "Set-Cookie",
    setCookie(
      CHALLENGE_COOKIE,
      signJson({
        challenge: String(options.challenge),
        company,
        kind: "reg",
        exp: Date.now() + CHALLENGE_TTL_MS,
      }),
      300,
    ),
  );
  return { ok: true, company, options };
});

// Step 2 of enrollment: store the passkey, burn the token, start a session.
app.post("/auth/register/verify", async (req, reply) => {
  const body = (req.body ?? {}) as { token?: string; response?: unknown };
  const company = resolveEnrollToken(body.token ?? "");
  if (!company) {
    return reply.code(403).send({ ok: false, error: "invalid or expired enrollment token" });
  }
  const chal = readChallenge(req);
  if (!chal || chal.kind !== "reg" || chal.company !== company || !chal.challenge) {
    return reply.code(400).send({ ok: false, error: "no pending registration for this browser" });
  }
  let outcome;
  try {
    outcome = await verifyRegistration(body.response, chal.challenge);
  } catch (e) {
    return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : "registration failed" });
  }
  addCredential(company, {
    id: outcome.id,
    publicKey: outcome.publicKey,
    counter: outcome.counter,
    transports: outcome.transports,
    createdAt: new Date().toISOString(),
  });
  consumeEnrollToken(company);
  reply.header("Set-Cookie", [
    setCookie(SESSION_COOKIE, mintSession(company, "owner"), Math.floor(SESSION_TTL_MS / 1000)),
    clearCookie(CHALLENGE_COOKIE),
  ]);
  return { ok: true, company, role: "owner" };
});

// Login step 1: usernameless — the authenticator offers its resident credential.
app.post("/auth/login/options", async (_req, reply) => {
  const options = await authenticationOptions();
  reply.header(
    "Set-Cookie",
    setCookie(
      CHALLENGE_COOKIE,
      signJson({ challenge: String(options.challenge), kind: "auth", exp: Date.now() + CHALLENGE_TTL_MS }),
      300,
    ),
  );
  return { ok: true, options };
});

// Login step 2: verify against the stored credential, start a session.
app.post("/auth/login/verify", async (req, reply) => {
  const body = (req.body ?? {}) as { response?: { id?: string; rawId?: string } };
  const id = body.response?.id ?? body.response?.rawId;
  if (!id) return reply.code(400).send({ ok: false, error: "credential id required" });
  const found = findCompanyByCredentialId(id);
  if (!found) {
    return reply.code(404).send({ ok: false, error: "unknown passkey — enroll this device first" });
  }
  const chal = readChallenge(req);
  if (!chal || chal.kind !== "auth" || !chal.challenge) {
    return reply.code(400).send({ ok: false, error: "no pending login for this browser" });
  }
  let outcome;
  try {
    outcome = await verifyAuthentication(body.response, chal.challenge, found.cred);
  } catch (e) {
    return reply.code(401).send({ ok: false, error: e instanceof Error ? e.message : "authentication failed" });
  }
  updateCounter(found.company, id, outcome.newCounter);
  reply.header("Set-Cookie", [
    setCookie(SESSION_COOKIE, mintSession(found.company, "owner"), Math.floor(SESSION_TTL_MS / 1000)),
    clearCookie(CHALLENGE_COOKIE),
  ]);
  return { ok: true, company: found.company, role: "owner" };
});

app.get("/auth/me", async (req, reply) => {
  const sess = readSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  if (!sess) return reply.code(401).send({ ok: false });
  return { ok: true, company: sess.company, role: sess.role };
});

app.post("/auth/logout", async (_req, reply) => {
  reply.header("Set-Cookie", clearCookie(SESSION_COOKIE));
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Signup rate limiting
//
// The legacy POST /auth/signup — "record a request, an operator reviews it" —
// was RETIRED when the self-serve passkey flow landed. It forced an email the
// new flow made optional, wrote a second record shape into the same directory,
// and shared this counter with a different threshold, so the two endpoints ate
// each other's budget. Its replacement is /auth/signup/options below. Existing
// pending records (if any) are still reviewable with infra/approve-signup.py.
// ---------------------------------------------------------------------------

/** Best-effort flood friction, in-memory. NOT a security boundary — the real
 *  abuse bound is the bounded credit grant, which no unauthenticated route can
 *  mint more of. Keyed on the client address, so it is genuinely per-IP only if
 *  the stream layer forwards the real one (nginx SNI router + PROXY protocol);
 *  otherwise every caller collapses into one shared bucket. */
const signupHits = new Map<string, number[]>();

app.post("/auth/signup", async (_req, reply) => {
  // RETIRED — the self-serve flow below (/auth/signup/options → /verify) replaced
  // it. Kept as an explicit 410 so any stale client learns the door moved rather
  // than seeing a confusing 404.
  return reply.code(410).send({
    ok: false,
    error: "gone",
    message: "This endpoint is retired. Sign up with a passkey at /auth/signup/options.",
  });
});

// ---------------------------------------------------------------------------
// Self-serve signup — the front door.
//
// A stranger becomes a company in ONE passkey ceremony: no operator, no email,
// no invite token. The gate that used to sit here was solving ABUSE, and abuse is
// better solved by guardrails — a bounded free-tier grant, a per-IP signup limit,
// and a per-account daily extraction cap (see /extract). Making a human approve
// every signup solved the abuse problem by making the product unusable.
//
// Step 1 reserves a slug and stashes a pending record. Step 2 verifies the
// attestation and provisions the company. The ceremony challenge rides in the
// same signed cookie the enrollment flow uses.
// ---------------------------------------------------------------------------

const SIGNUPS_PER_IP_PER_HOUR = 3;

app.post("/auth/signup/options", async (req, reply) => {
  const body = (req.body ?? {}) as { business?: string; email?: string; website?: string };
  const business = String(body.business ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const website = String(body.website ?? "").trim();

  if (business.length < 2 || business.length > 120)
    return reply.code(400).send({ ok: false, error: "a business name is required" });
  if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)))
    return reply.code(400).send({ ok: false, error: "that email doesn't look right" });
  if (website.length > 300)
    return reply.code(400).send({ ok: false, error: "that website is too long" });

  const ip = (req.headers["x-real-ip"] as string) || req.ip || "unknown";
  const now = Date.now();
  const recent = (signupHits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= SIGNUPS_PER_IP_PER_HOUR)
    return reply.code(429).send({ ok: false, error: "too many signups from here — try again later" });
  recent.push(now);
  signupHits.set(ip, recent);

  // Reserve the slug now, and treat other PENDING signups as taken too, so two
  // people signing up at the same moment cannot both be handed the same name.
  const slug = uniqueSlug(slugify(business), pendingSlugs());
  await savePending({ slug, business, email: email || null, website: website || null });

  const options = await registrationOptions(slug, []);
  reply.header(
    "Set-Cookie",
    setCookie(
      CHALLENGE_COOKIE,
      signJson({
        challenge: String(options.challenge),
        company: slug,
        kind: "reg",
        exp: Date.now() + CHALLENGE_TTL_MS,
      }),
      300,
    ),
  );
  return { ok: true, slug, options };
});

app.post("/auth/signup/verify", async (req, reply) => {
  const body = (req.body ?? {}) as { response?: unknown };
  if (!body.response) return reply.code(400).send({ ok: false, error: "response required" });

  const chal = readChallenge(req);
  if (!chal || chal.kind !== "reg" || !chal.company || !chal.challenge)
    return reply.code(400).send({ ok: false, error: "no pending signup for this browser" });

  const slug = String(chal.company);
  const pending = await loadPending(slug);
  if (!pending)
    return reply.code(410).send({ ok: false, error: "that signup expired — please start again" });

  let outcome;
  try {
    outcome = await verifyRegistration(body.response, chal.challenge);
  } catch (e) {
    return reply
      .code(400)
      .send({ ok: false, error: e instanceof Error ? e.message : "registration failed" });
  }

  const account = await provisionCompany({
    slug,
    business: pending.business,
    email: pending.email,
    website: pending.website,
    provider: "passkey",
    credential: {
      id: outcome.id,
      publicKey: outcome.publicKey,
      counter: outcome.counter,
      transports: outcome.transports,
      createdAt: new Date().toISOString(),
    },
  });
  await clearPending(slug);

  reply.header("Set-Cookie", [
    setCookie(SESSION_COOKIE, mintSession(slug, "owner"), Math.floor(SESSION_TTL_MS / 1000)),
    clearCookie(CHALLENGE_COOKIE),
  ]);
  return { ok: true, company: slug, business: account.business, role: "owner" };
});

/** Which sign-in methods THIS deployment offers. The landing shows the Google
 *  button only when it is actually configured — never a button that 503s. */
app.get("/auth/providers", async () => ({
  ok: true,
  passkey: true,
  google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
}));

// ---------------------------------------------------------------------------
// Google OAuth — the familiar button, offered ALONGSIDE passkeys, not instead.
//
// Google proves who someone is; it is not the durable credential. Signing in
// with Google provisions the company and starts a session, and the dashboard
// nudges the owner to add a passkey so their login stops depending on Google.
//
// Dormant unless GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are set — and
// /auth/providers reports that, so the button hides rather than fails.
// ---------------------------------------------------------------------------

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

function googleRedirectUri(): string {
  return process.env.HELIX_GOOGLE_REDIRECT || `${RP_ORIGIN}/api/auth/google/callback`;
}

app.get("/auth/google/start", async (req, reply) => {
  const id = process.env.GOOGLE_CLIENT_ID;
  if (!id || !process.env.GOOGLE_CLIENT_SECRET)
    return reply.code(503).send({ ok: false, error: "Google sign-in is not configured" });

  const state = randomUUID();
  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  reply.header(
    "Set-Cookie",
    setCookie(
      CHALLENGE_COOKIE,
      signJson({ kind: "oauth", state, exp: Date.now() + CHALLENGE_TTL_MS }),
      600,
    ),
  );
  return reply.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
});

app.get("/auth/google/callback", async (req, reply) => {
  const q = req.query as { code?: string; state?: string; error?: string };
  if (q.error) return reply.redirect("/?google=denied");

  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret)
    return reply.code(503).send({ ok: false, error: "Google sign-in is not configured" });

  const chal = readChallenge(req);
  if (!chal || chal.kind !== "oauth" || !chal.state || chal.state !== q.state)
    return reply.redirect("/?google=badstate");
  if (!q.code) return reply.redirect("/?google=nocode");

  let profile: { sub?: string; email?: string; name?: string };
  try {
    const tok = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: q.code,
        client_id: id,
        client_secret: secret,
        redirect_uri: googleRedirectUri(),
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!tok.ok) throw new Error(`token exchange failed (${tok.status})`);
    const t = (await tok.json()) as { access_token?: string };
    if (!t.access_token) throw new Error("no access token");

    const me = await fetch(GOOGLE_USERINFO_URL, {
      headers: { authorization: `Bearer ${t.access_token}` },
    });
    if (!me.ok) throw new Error(`userinfo failed (${me.status})`);
    profile = (await me.json()) as typeof profile;
  } catch (e) {
    app.log.error(`google oauth: ${e instanceof Error ? e.message : String(e)}`);
    return reply.redirect("/?google=failed");
  }

  const sub = String(profile.sub ?? "");
  if (!sub) return reply.redirect("/?google=failed");

  // A returning Google user gets the company they already own; a new one is
  // provisioned here, exactly as a passkey signup would be.
  let company = findByGoogleSub(sub);
  if (!company) {
    const name = (profile.name || (profile.email ?? "").split("@")[0] || "business").trim();
    const slug = uniqueSlug(slugify(name), pendingSlugs());
    await provisionCompany({
      slug,
      business: profile.name || name,
      email: profile.email ?? null,
      provider: "google",
      googleSub: sub,
    });
    company = slug;
  }

  reply.header("Set-Cookie", [
    setCookie(SESSION_COOKIE, mintSession(company, "owner"), Math.floor(SESSION_TTL_MS / 1000)),
    clearCookie(CHALLENGE_COOKIE),
  ]);
  return reply.redirect("/dashboard/");
});

// Mint a fresh one-time enrollment link. Owner-gated: issuing a token is the same
// authority as holding a session, so it is not a way back in without one.
app.post("/auth/enroll/token", { preHandler: [requireAuth, requireOwner] }, async (req, reply) => {
  const body = (req.body ?? {}) as { companyId?: string; ttlHours?: number };
  const company = body.companyId ?? (req as AuthCarrier).auth?.companyId;
  if (!company || !isOnboardedCompany(company)) {
    return reply.code(404).send({ ok: false, error: "unknown company" });
  }
  const ttlHours = Math.min(Math.max(body.ttlHours ?? 24, 1), 168);
  const token = issueEnrollToken(company, ttlHours * 3600_000);
  return { ok: true, company, enrollUrl: `/dashboard/?enroll=${token}`, expiresInHours: ttlHours };
});

async function main() {
  await ensureDirs();
  await loadAccountStore();
  await loadLeadStore();
  await loadContentStores();
  await loadSiteStore();
  await loadJingleStore();
  await loadAffiliateStore();

  // Scheduler loop — check for due assets every 60s and submit to SparkGatekeeper
  setInterval(async () => {
    const due = getDueAssets();
    for (const s of due) {
      const asset = assetStore.get(s.assetId);
      if (!asset) continue;
      try {
        await submitForApproval(asset, s.companyId);
        cancelSchedule(s.assetId);
      } catch {
        // GK unreachable — keep in schedule, try next interval
      }
    }
  }, 60_000);

  await loadSettings();
  await loadAllCompanyAi();
  await app.listen({ port: 3101, host: "127.0.0.1" });
}

main().catch((e) => {
  app.log.error(e);
  process.exit(1);
});
