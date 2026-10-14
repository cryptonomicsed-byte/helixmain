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
  setStripeCustomerId,
  getStripeCustomerId,
  loadAccountStore,
  getAccountStoreSize,
  flushAccountStore,
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
import { createHmac, randomUUID, randomBytes, timingSafeEqual } from "crypto";
import { type FastifyRequest, type FastifyReply } from "fastify";
import { lookupKey, ensureKeys, resetKeyCache, type KeyRecord } from "./services/apiKeys";
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
import {
  agentStatus,
  agentNameFor,
  ACCOUNT_AGENT,
  chatStream,
  type AgentFrame,
} from "./services/zeroclaw";
import { isAdminCompany, listAdminCompanies } from "./services/admin";
import {
  accountOwning,
  ensureAccount,
  addOwnedCompany,
  companiesForAccount,
} from "./services/accounts";
import {
  listLandings,
  saveLanding,
  deleteLanding,
  uniqueLandingSlug,
  slugifyTitle,
} from "./services/landings";

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
/** infra/ sits beside dna-foundry/, not inside it. */
const PROVISION_AGENT = path.resolve(__dirname, "..", "..", "..", "infra", "provision-agent.py");
const SYNC_AGENT_PROVIDER = path.resolve(__dirname, "..", "..", "..", "infra", "sync-agent-provider.py");
const PROVISION_VOICE = path.resolve(__dirname, "..", "..", "..", "infra", "provision-voice.py");

/** Fire-and-forget: run one of the infra/*.py scripts against the agent runtime.
 *  Detached and cheap to call — both scripts no-op when there is nothing to do —
 *  because the caller's real job (storing a card, saving a setting) is already
 *  done by the time this runs, and neither must ever fail or delay a response. */
function runInfraScript(script: string, args: string[], tag: string): void {
  try {
    const p = spawn("python3", [script, ...args], { detached: true, stdio: "ignore" });
    p.on("error", (e) => console.error(`${tag}: ${e.message}`));
    p.unref();
  } catch (e) {
    console.error(`${tag}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** An onboarded company gets its Card Agent without anyone remembering to run
 *  infra/provision-agent.py by hand. The card IS what an agent grounds on, so
 *  this is the moment the company becomes able to have one. A company with no
 *  agent is a company the Account Agent cannot hand work to. */
function provisionCardAgent(companyId: string): void {
  runInfraScript(PROVISION_AGENT, [companyId], `provision-agent ${companyId}`);
}

/** Give a company its sovereign VOICE endpoint (its own npub + systemd unit).
 *
 *  Separate from the ZeroClaw card agent above: a card agent talks over nostr
 *  chat, the voice endpoint answers the /call page. Every card is supposed to
 *  come with one, so this fires wherever a company becomes card-bearing. It is
 *  idempotent (provision-voice.py no-ops on an already-wired company) and
 *  fire-and-forget — a slow whisper/piper cold start must never block /extract. */
function provisionVoice(companyId: string): void {
  runInfraScript(PROVISION_VOICE, [companyId], `provision-voice ${companyId}`);
}

/** The chat agents read /etc/zeroclaw/config.toml, NOT the Settings page. Without
 *  this, a user saves a provider key, sees Settings confirm it, and every reply
 *  still comes from the old provider — which reads as "it's hardcoded". */
function syncAgentProvider(): void {
  runInfraScript(SYNC_AGENT_PROVIDER, [], "sync-agent-provider");
}

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

/**
 * The business's sovereign voice identity.
 *
 * A business's agent-voice endpoint (one systemd unit per business,
 * agent-voice-<slug>.service) is addressed by npub, not by slug: a caller
 * gift-wraps an offer to the npub and the matching endpoint answers it.
 * <company>/identity is written by the provisioner as
 *   line 1: seckey    (secret — must never leave the server)
 *   line 2: pubkey hex
 *   line 3: npub
 * Only the public halves are returned, so the page can reach the agent without
 * being able to impersonate it.
 */
async function readVoiceIdentity(
  companyId: string,
): Promise<{ npub: string; pubkey: string } | null> {
  if (!companyId || companyId.includes("/") || companyId.includes("\\") || companyId.includes("..")) {
    return null;
  }
  try {
    const raw = await fs.readFile(path.join(HELIX_COMPANIES, companyId, "identity"), "utf8");
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    const npub = lines.find((l) => l.startsWith("npub1")) ?? "";
    // lines[0] is the seckey, and it is also 64 hex chars — exclude it.
    const secret = lines[0] ?? "";
    const pubkey = lines.find((l) => /^[0-9a-f]{64}$/i.test(l) && l !== secret) ?? "";
    if (!npub) return null;
    return { npub, pubkey };
  } catch {
    return null;
  }
}

/** The relays a business's endpoint subscribes to (its env), else the platform default. */
async function readVoiceRelays(companyId: string): Promise<string[]> {
  const fallback = [process.env.HELIX_VOICE_RELAY || "wss://omokoda.duckdns.org:3443"];
  try {
    const env = await fs.readFile(path.join(HELIX_COMPANIES, companyId, "env"), "utf8");
    const m = env.match(/^AGENT_VOICE_RELAYS=(.*)$/m);
    if (m) {
      const list = m[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (list.length) return list;
    }
  } catch { /* no env file — use the platform default */ }
  return fallback;
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

/** The host of a URL, for deriving a new company's slug before extraction knows
 *  the business name. Deterministic, so orgId/changelog/slug all agree. */
function hostOf(url: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

/** The tenant a RESOLVED card path belongs to, or null when it has none.
 *
 *  A live card lives at HELIX_COMPANIES/<slug>/card.json → tenant <slug>.
 *  A legacy extraction under api/data/cards/ belongs to nobody: that directory
 *  is a pile of artifacts from finished tests and pruned companies, so a
 *  company key must never be able to reach into it. */
function cardTenant(p: string): string | null {
  const rel = path.relative(HELIX_COMPANIES, p);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const seg = rel.split(path.sep);
  return seg.length > 1 ? seg[0] : null;
}

/** May this credential read the card at `p`?
 *
 *  Operator: any card (that is the one deliberate cross-company grant).
 *  Company key: only its own — by the directory it lives in, or (for a legacy
 *  card that has no owning directory) by the organizationId it carries.
 *
 *  The PATH check comes first and is authoritative: naming another live
 *  company's card is blocked by the directory it resolves to, whatever the
 *  card's own organizationId field claims. */
async function mayReadCard(auth: KeyRecord | undefined, p: string): Promise<boolean> {
  if (auth?.level === "operator") return true;
  const t = cardTenant(p);
  if (t) return mayActOnCompany(auth, t);
  try {
    const c = JSON.parse(await fs.readFile(p, "utf8")) as { organizationId?: string };
    return !!c?.organizationId && mayActOnCompany(auth, c.organizationId);
  } catch {
    return false;
  }
}


/** Keep the card that is about to be REPLACED.
 *
 *  /extract overwrites <tenant>/card.json, and a silent overwrite is how a curated
 *  card dies — it happened once and had to be recovered by hand from CARD.md. Every
 *  replacement now leaves the previous file beside it as
 *  `card.json.pre-extract-<stamp>`, bounded to the newest few so a busy company
 *  cannot fill its own directory. */
async function snapshotCompanyCard(companyId: string, cardPath: string): Promise<void> {
  try {
    const prior = await fs.readFile(cardPath, "utf8");
    const dir = path.join(HELIX_COMPANIES, companyId);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    await fs.writeFile(path.join(dir, `card.json.pre-extract-${stamp}`), prior, { mode: 0o600 });
    const snaps = (await fs.readdir(dir))
      .filter((f) => f.startsWith("card.json.pre-extract-"))
      .sort();
    for (const f of snaps.slice(0, Math.max(0, snaps.length - 5))) {
      await fs.rm(path.join(dir, f)).catch(() => {});
    }
  } catch {
    /* no prior card — nothing to keep */
  }
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

/** Companies this credential may act on BEYOND its own tenant.
 *
 *  operator → handled separately (sees every company).
 *  session  → every company the caller's ACCOUNT owns (its portfolio).
 *  key      → none: a per-company bearer stays bound to its own company.
 *
 *  ONE definition, so auth (requireAuth), card reads (mayReadCard) and any future
 *  gate all widen together instead of each drifting. */
function portfolio(auth: KeyRecord | undefined): string[] {
  if (!auth) return [];
  if (auth.level === "operator") return [];
  if (auth.via === "session") return accountOwning(auth.companyId)?.owned ?? [];
  return [];
}

/** May this credential act on `company`? Its own tenant, an operator, or any
 *  company in its account's portfolio. */
function mayActOnCompany(auth: KeyRecord | undefined, company: string): boolean {
  if (!auth || !company) return false;
  if (auth.level === "operator") return true;
  if (company === auth.companyId) return true;
  return portfolio(auth).includes(company);
}

async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Machine callers present a per-company key; the browser presents a session
  // cookie minted by a passkey login. Either way the SERVER decides the tenant —
  // a caller-supplied companyId is never trusted on its own.
  let rec: KeyRecord | null = lookupKey(req.headers["x-api-key"]);
  if (rec) rec.via = "key";
  if (!rec) {
    const sess = readSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (sess) {
      rec = {
        companyId: sess.company,
        level: sess.role === "owner" ? "owner" : "company",
        via: "session",
      };
    }
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
  // An account owns companies. A browser session belongs to the ACCOUNT, so it
  // may name any company the account controls — not only the one it logged in
  // through. A per-company KEY stays bound to its own company: a bearer string
  // that leaks must not widen into a portfolio, so this is session-only.
  const allowed = new Set<string>([rec.companyId, ...portfolio(rec)]);
  for (const named of namedCompanyIds(req)) {
    if (!allowed.has(named) && isOnboardedCompany(named)) {
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

/**
 * Admin — the platform operator. The ONE account with unlimited credits and sight
 * of platform-wide data.
 *
 * Gated on the PASSKEY SESSION, deliberately:
 *   - `via === "session"` means a passkey ceremony produced this request. A
 *     per-company API key is a bearer string that ends up in config files, shell
 *     history, logs and bug reports; it must never be enough to administer the
 *     platform.
 *   - `level === "owner"` means the session is not a downgraded one.
 *   - `isAdminCompany` is an ALLOWLIST READ FROM DISK. Nothing in the request can
 *     influence it — that is the whole point. If the allowlist file is missing or
 *     unreadable the list is empty and every admin action is refused (fail closed).
 *
 * Mounted with requireAuth first, so `auth` is guaranteed non-null here.
 */
async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = (req as AuthCarrier).auth;
  if (!auth || auth.via !== "session" || auth.level !== "owner") {
    req.log.warn(
      { company: auth?.companyId, via: auth?.via, level: auth?.level, url: req.url },
      "admin route refused: not an owner passkey session",
    );
    await reply.code(403).send({
      ok: false,
      error: "admin requires a passkey sign-in — a company API key is never enough",
    });
    return;
  }
  if (!isAdminCompany(auth.companyId)) {
    req.log.warn({ company: auth.companyId, url: req.url }, "admin route refused: not an admin account");
    await reply.code(403).send({ ok: false, error: "this account is not an admin" });
    return;
  }
  // Admin actions are always attributable. Unlimited credits and platform-wide
  // reads should never happen silently.
  req.log.warn({ company: auth.companyId, url: req.url, method: req.method }, "ADMIN action");
}

app.get("/health", async () => ({ ok: true, service: "dna-foundry" }));

/**
 * Rate limiter for the ANONYMOUS LLM endpoints (the public call page, the
 * directory concierge).
 *
 * These answer anyone on the internet using the account-level provider key, and
 * nobody is charged — so they are the platform's OWN money at risk. Without a
 * limit, one client can point a script at /call-message/<any slug> and use the
 * deployment as a free LLM proxy until the credit card notices.
 *
 * Per-IP window plus a global ceiling, because a per-IP limit alone is defeated by
 * a botnet and a global one alone lets one visitor starve everyone.
 */
const anonLlmHits = new Map<string, number[]>();
let anonLlmGlobal: number[] = [];

function anonLlmAllow(ip: string, perIp = 20, global = 600, windowMs = 60_000): boolean {
  const now = Date.now();
  const recent = (anonLlmHits.get(ip) ?? []).filter((t) => now - t < windowMs);
  anonLlmGlobal = anonLlmGlobal.filter((t) => now - t < windowMs);

  if (recent.length >= perIp || anonLlmGlobal.length >= global) {
    anonLlmHits.set(ip, recent);
    return false;
  }
  recent.push(now);
  anonLlmGlobal.push(now);
  anonLlmHits.set(ip, recent);

  // Keep the map from growing without bound: a new IP every request would
  // otherwise be a memory leak dressed as a rate limiter.
  if (anonLlmHits.size > 10_000) {
    for (const [k, v] of anonLlmHits) {
      if (!v.some((t) => now - t < windowMs)) anonLlmHits.delete(k);
    }
  }
  return true;
}

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
  if (typeof body.model === "string") next.model = body.model || undefined;

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
  // The chat agents run on their own config, so a key saved here is inert until
  // it is pushed into the runtime. Detached: the save is already committed.
  syncAgentProvider();
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
  // A card's own provider/model/key must reach its chat agent too, not just the
  // API. Detached and idempotent: the save is already committed.
  syncAgentProvider();
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
  const body = (req.body ?? {}) as { url?: string; orgId?: string; companyId?: string; replace?: boolean };
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
  const accountId = auth?.companyId ?? "";
  const isOperator = auth?.level === "operator";

  // Resolve the TARGET company.
  //   - An explicit companyId/orgId → re-extract INTO that existing card (it must
  //     be one this principal may act on; the clobber guard below still applies).
  //   - Nothing named → a NEW card, which is a NEW company under the account.
  //     Each card is its own company: own dir, own npub, own voice endpoint.
  let target: string;
  let isNew = false;
  const requested = body.companyId || body.orgId;
  if (requested) {
    if (requested !== accountId && !mayActOnCompany(auth, requested))
      return reply.code(403).send({ ok: false, error: "companyId must be a company you own" });
    if (!isProvisionedCompany(requested))
      return reply.code(403).send({ ok: false, error: "no such company to extract into" });
    target = requested;
  } else {
    // Prefer the account's card-less "home" company (so a brand-new signup's
    // account becomes its first card instead of leaving an orphan), else mint a
    // new company slug from the URL host.
    const acct = accountOwning(accountId) ?? ensureAccount(accountId);
    const cardless = acct.owned.find((c) => isProvisionedCompany(c) && !isOnboardedCompany(c));
    if (cardless) {
      target = cardless;
    } else {
      target = uniqueSlug(slugify(hostOf(body.url)) || "site", pendingSlugs());
      isNew = true;
    }
  }

  // The ACCOUNT pays for the extraction, not the company the card lands in — a
  // brand-new company has no credit account yet, so billing `target` would 402
  // every new card. An operator (companyId "*") has no account of its own, so it
  // bills the company it named.
  const billing = accountId && accountId !== "*" ? accountId : target;

  // CLOBBER GUARD. This route REPLACES <tenant>/card.json wholesale, so extracting
  // over a company that already has a card destroys whatever was curated there —
  // silently. Refuse unless the caller says `replace: true`, and name what is at
  // stake so the client can show a real confirmation. Checked BEFORE any credit is
  // spent, so a refused overwrite costs nothing.
  const existingCardPath = path.join(HELIX_COMPANIES, target, "card.json");
  let existingCard: Record<string, unknown> | null = null;
  try {
    existingCard = JSON.parse(await fs.readFile(existingCardPath, "utf8"));
  } catch {
    existingCard = null; // no card yet — a first extraction, proceed
  }
  if (existingCard && !body.replace) {
    const ident = (existingCard.identity ?? {}) as { name?: string };
    return reply.code(409).send({
      ok: false,
      error: "card_exists",
      message:
        `This company already has a card (${ident.name ?? target}, ` +
        `v${existingCard.version ?? 1}). Extracting again REPLACES it.`,
      current: {
        name: ident.name ?? target,
        version: existingCard.version ?? 1,
        updated: existingCard.created_at ?? existingCard.createdAt ?? null,
      },
      hint: 'resend with {"replace": true} to replace it — the current card is snapshotted first',
    });
  }

  // Per-account daily ceiling — see EXTRACTIONS_PER_DAY.
  const acct = getCreditSummary(billing);
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
    usageEntry = await deductCredits(billing, "extraction");
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
      // A NEW card is a new company: mint its identity key and register it in the
      // account's portfolio so the /call page and every owned-company route can
      // reach it. An existing company already has these — never rotate them.
      if (isNew) {
        const skPath = path.join(companyDir, "seckey");
        const hasKey = await fs.access(skPath).then(() => true).catch(() => false);
        if (!hasKey) {
          await fs.writeFile(skPath, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
        }
        ensureKeys(target);
        resetKeyCache();
        const acct = accountOwning(accountId) ?? ensureAccount(accountId);
        addOwnedCompany(acct.id, target);
      }
      await snapshotCompanyCard(target, path.join(companyDir, "card.json"));
      await fs.writeFile(path.join(companyDir, "card.json"), JSON.stringify(card, null, 2));
    } catch (e) {
      if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ ok: false, error: `card could not be stored: ${msg}` });
    }
    // The card is what an agent grounds on, so this is the moment the company
    // becomes able to have one — both agents, chat and voice. Idempotent; never
    // blocks or fails the response.
    provisionCardAgent(target);
    provisionVoice(target);
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
  if (!(await mayReadCard((req as AuthCarrier).auth, p)))
    return reply.code(403).send({ ok: false, error: "key does not belong to that company" });
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

  // An operator sees every company (that IS the switcher grant). A browser session
  // sees every company its ACCOUNT owns. A bare per-company key sees only its own.
  let ids: string[];
  if (isOperator) {
    ids = listProvisionedCompanies();
  } else if (auth?.via === "session") {
    ids = Array.from(new Set<string>([mine, ...companiesForAccount(mine)]));
  } else {
    ids = [mine];
  }
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
  const auth = (req as AuthCarrier).auth;
  if (!(await mayReadCard(auth, pa)) || !(await mayReadCard(auth, pb)))
    return reply.code(403).send({ ok: false, error: "key does not belong to that company" });
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
  if (!(await mayReadCard((req as AuthCarrier).auth, cardPath))) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    return reply.code(403).send({ ok: false, error: "key does not belong to that company" });
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
  if (!(await mayReadCard((req as AuthCarrier).auth, cardPath))) {
    if (usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    return reply.code(403).send({ ok: false, error: "key does not belong to that company" });
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
      orgId: companyId,
      operationType: "agent_session",
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

// POST /metering/topup/:companyId — ADMIN ONLY.
//
// This used to be `requireAuth`, which meant ANY company key could mint itself an
// unlimited number of credits — a total bypass of the payment system wearing the
// label "admin top-up". Credits may now enter an account in exactly two ways:
// Stripe's signature-verified webhook, and this route behind the admin passkey.
app.post("/metering/topup/:companyId", { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const body = (req.body ?? {}) as { credits?: number; reason?: string };

  if (typeof body.credits !== "number" || !Number.isFinite(body.credits) || body.credits <= 0)
    return reply.code(400).send({ ok: false, error: "credits (positive number) required" });
  // A single call cannot mint an unbounded balance. A fat-fingered extra zero on a
  // manual grant is not recoverable by any ledger logic, so refuse it up front.
  if (body.credits > 100_000)
    return reply.code(400).send({ ok: false, error: "refusing a single grant above 100000 credits" });

  try {
    const entry = await topUpCredits(companyId, body.credits, `admin:${body.reason ?? "topup"}`);
    req.log.warn({ actor: (req as AuthCarrier).auth?.companyId, companyId, credits: body.credits },
      "ADMIN grant: credits added");
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
// GET /sites — what the dashboard's Landing page tab needs to know.
//
// Two different things were being conflated here, which is what produced
// `no preview generated for company` in the card's iframe:
//   * a PREVIEW is LLM single-file HTML held in memory (siteStore) — private,
//     never charged, and only exists if /site/preview was called
//   * a PUBLISHED site is the Hugo page actually served at /b/<id>/
// The tab iframed the preview endpoint while the button PUBLISHED, so a
// successfully published page still rendered as an error.
//
// `published` is read from the web root, so it reflects what a visitor can
// actually load — not what some in-memory map remembers.
const PUBLIC_SITE_ROOT =
  process.env.HELIX_SITE_ROOT || "/var/www/helixmain-site";

async function publishedSites(): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(PUBLIC_SITE_ROOT, "b"), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

app.get("/sites", { preHandler: requireAuth }, async (req, reply) => {
  const auth = (req as AuthCarrier).auth;
  const isOperator = auth?.level === "operator";
  const mine = auth?.companyId ?? "";
  // Same rule as every other list: a caller sees the companies it may act on
  // (its account's portfolio), an operator sees all.
  const scope = (ids: string[]) => (isOperator ? ids : ids.filter((i) => mayActOnCompany(auth, i)));
  const published = await publishedSites();
  return reply.code(200).send({
    ok: true,
    companies: scope(listSites()),
    published: scope(published),
    publicBase: PUBLIC_SITE_BASE,
  });
});

// ---------------------------------------------------------------------------
// Landing pages — ADDITIVE. The card's directory page lives at /b/<id>/ and is
// rebuilt from the card; it is never written here. Each landing page is its own
// artifact at /l/<id>/<slug>/, shown as a tab + QR next to the directory page.
// Creating one cannot replace the directory entry: different route, store, tree.
// ---------------------------------------------------------------------------

app.get("/landings/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const auth = (req as AuthCarrier).auth;
  if (!mayActOnCompany(auth, companyId))
    return reply.code(403).send({ ok: false, error: "not your company" });
  return reply.code(200).send({ ok: true, base: PUBLIC_SITE_BASE, landings: listLandings(companyId) });
});

app.post("/landing/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const auth = (req as AuthCarrier).auth;
  if (!mayActOnCompany(auth, companyId))
    return reply.code(403).send({ ok: false, error: "not your company" });
  const cardPath = await findCard(companyId);
  if (!cardPath) return reply.code(404).send({ ok: false, error: "card not found" });
  const body = (req.body ?? {}) as { title?: string };
  try {
    const card = JSON.parse(await fs.readFile(cardPath, "utf8")) as { identity?: { name?: string } };
    const gen = await generateWebsite(card, companyId);
    const base = slugifyTitle(body.title || card?.identity?.name || companyId) || "landing";
    const slug = uniqueLandingSlug(base, listLandings(companyId).map((l) => l.slug));
    const landing = saveLanding(companyId, slug, body.title || base, gen.html);
    return reply.code(200).send({ ok: true, landing, url: `${PUBLIC_SITE_BASE}${landing.url}` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(500).send({ ok: false, error: msg });
  }
});

app.delete("/landing/:companyId/:slug", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId, slug } = req.params as { companyId: string; slug: string };
  const auth = (req as AuthCarrier).auth;
  if (!mayActOnCompany(auth, companyId))
    return reply.code(403).send({ ok: false, error: "not your company" });
  const ok = deleteLanding(companyId, slug);
  return reply.code(ok ? 200 : 404).send({ ok });
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

// Processed Stripe event ids — idempotency for a route that MINTS CREDITS.
//
// Stripe retries deliveries, and a captured signed body stays valid for the whole
// 300s replay tolerance, so without this the same logical payment can be applied
// more than once. (Measured: replaying one correctly-signed
// `checkout.session.completed` granted its credits a second time.) In-memory is
// enough: the replay window is 300s and Stripe's own retry window is hours, both
// far inside this TTL.
const processedStripeEvents = new Map<string, number>();
const STRIPE_EVENT_TTL_MS = 24 * 60 * 60 * 1000;

function pruneProcessedEvents(): void {
  const cutoff = Date.now() - STRIPE_EVENT_TTL_MS;
  for (const [id, at] of processedStripeEvents) {
    if (at < cutoff) processedStripeEvents.delete(id);
  }
}

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

  // Idempotency — AFTER the signature is proven, never before. Deduping first would
  // let an unauthenticated caller register an event id and suppress the real event.
  const eventId = ((req.body ?? {}) as { id?: string }).id;
  if (eventId) {
    pruneProcessedEvents();
    if (processedStripeEvents.has(eventId)) {
      req.log.info({ eventId }, "Stripe webhook duplicate — already applied");
      return reply.code(200).send({ received: true, duplicate: true });
    }
  }

  try {
    const event = req.body as {
      type: string;
      data: {
        object: {
          customer?: string;
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

      // Persist Stripe customer ID for portal access
      if (companyId && obj.customer) {
        setStripeCustomerId(companyId, obj.customer);
      }

      if (companyId && priceId) {
        const entry = PRICE_TO_CREDITS[priceId];
        if (entry) {
          // A SUBSCRIPTION grant upgrades the tier, and that tier already raises the
          // monthly cap — so record it as "stripe_subscription" and do NOT count it
          // as extra (which would double the allowance). A one-off PACK has no tier
          // change, so its credits MUST raise the cap by themselves, or buying them
          // would leave the customer blocked with a balance they cannot spend.
          await topUpCredits(
            companyId,
            entry.credits,
            entry.tier ? "stripe_subscription" : "stripe_pack",
          );
          if (entry.tier) {
            upgradeTier(companyId, entry.tier);
          }
        }
      }
    }
  } catch (e) {
    app.log.error(`Webhook processing error: ${e}`);
  }

  // Record the event (so a replay is a no-op) and do not answer Stripe until the
  // grant has actually reached disk — the mutation helpers save fire-and-forget.
  if (eventId) processedStripeEvents.set(eventId, Date.now());
  await flushAccountStore();

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

  const customerId = getStripeCustomerId(companyId);
  if (!customerId) {
    return reply.code(200).send({ ok: false, error: "No Stripe customer found — complete a purchase first." });
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

// POST /affiliate/refer — record a referral.
//
// `newCompanyId` is the company BEING referred, and it used to be taken straight
// from the body with no ownership check — so any authenticated user could attach
// any company (a real paying customer, found by slug) to their own referral code
// and collect commission credits on that customer's payments. Referral hijacking,
// on the money path.
//
// The only honest caller is the new company itself, at signup: "I signed up with
// this code". So the referred company must BE the authenticated company. Nothing
// else is a referral.
app.post("/affiliate/refer", { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as { code?: string; newCompanyId?: string };
  if (!body.code)          return reply.code(400).send({ ok: false, error: "code required" });
  if (!body.newCompanyId)  return reply.code(400).send({ ok: false, error: "newCompanyId required" });

  const auth = (req as AuthCarrier).auth;
  if (body.newCompanyId !== auth?.companyId) {
    req.log.warn(
      { actor: auth?.companyId, tried: body.newCompanyId },
      "referral refused: cannot refer a company that is not yours",
    );
    return reply.code(403).send({
      ok: false,
      error: "you may only record a referral for your own company",
    });
  }

  const recorded = recordReferral(body.code, body.newCompanyId);
  if (!recorded) {
    return reply.code(404).send({ ok: false, error: "Referral code not found or invalid" });
  }
  return reply.code(200).send({ ok: true });
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

// GET /admin/health — platform health. ADMIN ONLY.
// (The old comment claimed "no auth — PIN enforced client-side" while the route
// actually ran requireAuth, which was wrong twice: a client-side check is not a
// check, and requireAuth let ANY company key read platform-wide state.)
app.get("/admin/health", { preHandler: [requireAuth, requireAdmin] }, async (_req, reply) => {
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
app.get("/admin/sessions", { preHandler: [requireAuth, requireAdmin] }, async (_req, reply) => {
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
  // `admin` is decided HERE, from the on-disk allowlist — the client only ever
  // reports what the server told it. A dashboard that decides for itself whether
  // to show admin controls is a dashboard that can be told otherwise.
  return {
    ok: true,
    company: sess.company,
    role: sess.role,
    admin: sess.role === "owner" && isAdminCompany(sess.company),
  };
});

app.post("/auth/logout", async (_req, reply) => {
  reply.header("Set-Cookie", clearCookie(SESSION_COOKIE));
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Agent chat + registry.
//
// The owner talks to their company's agent from the card page. Transport is
// ZeroClaw's WebSocket chat (services/zeroclaw.ts); this route bridges it to SSE
// so a browser can render the reply as it streams. The tenant is the
// AUTHENTICATED company — `:companyId` is checked, never trusted.
// ---------------------------------------------------------------------------

/** The agent the public directory page talks to. Read-only by tool grant. */
const DIRECTORY_AGENT = "helix-directory";

/** What the model actually receives. The Account Agent is shared across
 *  companies, so it is told which account this conversation belongs to; a card
 *  agent already knows its own company from its card. */
function turnMessage(agent: string, companyId: string, message: string): string {
  return agent === ACCOUNT_AGENT
    ? `[dashboard chat — account "${companyId}"] ${message}`
    : message;
}

/** Run one agent turn and stream it to the client as SSE.
 *
 *  The response is hijacked: from here the route writes frames by hand. A turn
 *  that produced nothing refunds its credit entry — the same rule as /extract. */
async function streamAgentTurn(
  reply: FastifyReply,
  agent: string,
  message: string,
  usageEntry: UsageEntry | null,
): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (obj: unknown) => {
    try {
      reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      /* client went away */
    }
  };

  let chunks = 0;
  try {
    const full = await chatStream(agent, message, (f: AgentFrame) => {
      if (f.type === "chunk") chunks++;
      send(f);
    });
    send({ type: "done", full_response: full });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (chunks === 0 && usageEntry) await refundCredits(usageEntry.id).catch(() => {});
    send({ type: "error", message: msg });
  } finally {
    try {
      reply.raw.end();
    } catch {
      /* already closed */
    }
  }
}

app.post("/agent/chat/:companyId", { preHandler: requireAuth }, async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const auth = (req as AuthCarrier).auth;
  if (auth && auth.level !== "operator" && auth.companyId !== companyId)
    return reply.code(403).send({ ok: false, error: "not your company" });

  const body = (req.body ?? {}) as { message?: string; cardId?: string };
  const message = String(body.message ?? "").trim();
  if (!message) return reply.code(400).send({ ok: false, error: "message required" });
  if (message.length > 4000)
    return reply.code(400).send({ ok: false, error: "message too long (4000 chars max)" });

  // The Account Agent runs the account by default and delegates business-specific
  // work to the card agent, returning one unified answer. When the dashboard has a
  // specific card in view it names it, and we route straight to that card's agent.
  let agent = ACCOUNT_AGENT;
  const cardId = String(body.cardId ?? "").trim();
  if (cardId) {
    if (auth && auth.level !== "operator" && cardId !== companyId)
      return reply.code(403).send({ ok: false, error: "not your card" });
    agent = agentNameFor(cardId);
  }

  // OFFLINE must be a clean error, never a spinner that never ends.
  const st = await agentStatus();
  if (!st.ok)
    return reply.code(503).send({
      ok: false,
      error: "agent_runtime_offline",
      message: "The agent runtime is unreachable.",
    });
  if (st.channels[`nostr.${agent}`] === false)
    return reply.code(503).send({
      ok: false,
      error: "agent_offline",
      message: `The ${agent} agent is not running.`,
    });

  // Credits BEFORE the turn, refunded if the turn produces nothing — same rule
  // as /extract. playground_message is the reference cost.
  let usageEntry: UsageEntry | null = null;
  try {
    usageEntry = await deductCredits(companyId, "playground_message");
  } catch (e) {
    if (e instanceof QuotaExceeded) return reply.code(402).send({ ok: false, error: e.message });
    throw e;
  }

  // Take the response over: everything from here is SSE we write by hand.
  await streamAgentTurn(reply, agent, turnMessage(agent, companyId, message), usageEntry);
});

// POST /directory/chat — the public concierge on the directory page.
//
// The directory is anonymous, so this cannot sit behind requireAuth. It is
// bounded instead: a fixed per-IP hourly budget, a short message, and ONE target
// agent (helix-directory) whose tools are read-only by grant. It spends platform
// tokens rather than a company's credits, so that budget IS the cost control —
// and it is genuinely per-IP only because the stream layer now forwards the real
// address (nginx SNI router + PROXY protocol). Before that it would have been
// one shared bucket for the entire internet.
const DIRECTORY_CHAT_PER_IP_PER_HOUR = 20;
const directoryHits = new Map<string, number[]>();

app.post("/directory/chat", async (req, reply) => {
  const body = (req.body ?? {}) as { message?: string };
  const message = String(body.message ?? "").trim();
  if (!message) return reply.code(400).send({ ok: false, error: "message required" });
  if (message.length > 500)
    return reply.code(400).send({ ok: false, error: "message too long (500 chars max)" });

  const ip = (req.headers["x-real-ip"] as string) || req.ip || "unknown";
  const now = Date.now();
  const recent = (directoryHits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= DIRECTORY_CHAT_PER_IP_PER_HOUR)
    return reply.code(429).send({
      ok: false,
      error: "too many messages from this address — try again later",
    });
  recent.push(now);
  directoryHits.set(ip, recent);

  const st = await agentStatus();
  if (!st.ok || st.channels[`nostr.${DIRECTORY_AGENT}`] === false)
    return reply.code(503).send({
      ok: false,
      error: "agent_offline",
      message: "The directory concierge is not available right now.",
    });

  await streamAgentTurn(reply, DIRECTORY_AGENT, message, null);
});

// GET /agents — the agent registry: {id, type, company, status, capabilities}.
// An operator sees every agent; a company sees the shared agents plus its own.
app.get("/agents", { preHandler: requireAuth }, async (req, reply) => {
  const auth = (req as AuthCarrier).auth;
  const isOperator = auth?.level === "operator";
  const mine = auth?.companyId ?? "";
  const st = await agentStatus();
  const statusOf = (alias: string) =>
    st.channels[`nostr.${alias}`] === true ? "online" : st.ok ? "offline" : "unknown";

  const agents: object[] = [
    {
      id: "helix",
      type: "account",
      company: null,
      status: statusOf("helix"),
      capabilities: ["cross-company", "delegate", "all-tools"],
      description: "Account Agent — runs the account and delegates business-specific work.",
    },
  ];
  // The Directory Agent only exists once it is configured; report it when it is.
  if (st.channels["nostr.helix-directory"] !== undefined) {
    agents.push({
      id: "helix-directory",
      type: "directory",
      company: null,
      status: statusOf("helix-directory"),
      capabilities: ["read-cards", "discover"],
      description: "Directory Agent — helps visitors find businesses. Read-only.",
    });
  }
  const companies = isOperator ? listProvisionedCompanies() : mine ? [mine] : [];
  for (const c of companies) {
    agents.push({
      id: c,
      type: "card",
      company: c,
      status: statusOf(c),
      capabilities: ["own-card", "voice", "content", "leads", "site", "billing", "crm"],
      description: `Card Agent for ${c}.`,
    });
  }
  return reply.code(200).send({
    ok: true,
    runtime: { reachable: st.ok },
    agents,
  });
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

  // The ACCOUNT is the principal; the company just provisioned is its first
  // entry. A historical 1:1 account (id == company) migrates to owned: [slug].
  ensureAccount(slug, {
    business: account.business,
    email: account.email,
    website: account.website,
    provider: "passkey",
  });
  addOwnedCompany(slug, slug);

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

  // Keep the account layer in step for Google-created and returning accounts.
  ensureAccount(company, {
    business: profile.name || company,
    email: profile.email ?? null,
    provider: "google",
    googleSub: sub,
  });
  addOwnedCompany(company, company);

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

// ---------------------------------------------------------------------------
// Public Voice Agent Call Page routes
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Voice Agent Call Page  (public — NO auth required)
// ---------------------------------------------------------------------------

/** Build the voice-agent call page HTML from card data.
 *
 * Single file, no build step, one CDN import (nostr-tools) which the head guard
 * covers. The rule for this page: everything the caller sees is driven by REAL
 * signal — the two AnalyserNodes (caller mic, remote track), the
 * RTCPeerConnection's own getStats(), and the connection state machine. There
 * are no decorative controls and no invented states; if something animates,
 * something is actually happening.
 *
 * Harness contract (infra/call_e2e.py) — do not rename:
 *   #remoteAudio        .srcObject bound to the inbound track
 *   #orb                className CONTAINS 'listening' / 'speaking'
 *   #transcript .msg    message nodes
 *   .bar                level bars
 *   #btnStart           stays hidden when the call auto-starts
 */
function buildCallPageHtml(opts: {
  companyId: string;
  companyName: string;
  tagline: string;
  agentName: string;
  /** The business's sovereign voice identity (its agent-voice endpoint). */
  voice: { enabled: boolean; npub: string; relays: string[] };
  /** Same-origin path that mints ephemeral TURN credentials. */
  turnCredsUrl: string;
  /** Card details, so the page shows WHAT the business is, not just an orb. */
  card?: { hours?: string; phone?: string; offerings?: string[]; accent?: string };
}): string {
  const { companyId, companyName, tagline, agentName, voice, turnCredsUrl } = opts;
  const card = opts.card ?? {};
  const offers = (card.offerings ?? []).filter(Boolean).slice(0, 8);
  const hours = card.hours ?? "";
  const phone = card.phone ?? "";
  // Normalise to a 6-digit hex: the translucent variant is built as `${accent}22`,
  // which is only a valid colour when the accent is exactly 6 digits. The old
  // {3,8} test accepted lengths that produced invalid CSS (e.g. '#abc' -> '#abc22').
  const rawAccent = (card.accent ?? "").replace(/^#/, "");
  const accentHex = /^[0-9a-fA-F]{3}$/.test(rawAccent)
    ? rawAccent.split("").map((c) => c + c).join("")
    : /^[0-9a-fA-F]{6}$/.test(rawAccent) ? rawAccent
    : /^[0-9a-fA-F]{8}$/.test(rawAccent) ? rawAccent.slice(0, 6) : "";
  const accent = accentHex ? "#" + accentHex : "";
  const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  const apiBase = process.env.HELIX_API_BASE || "/api";
  // Monogram for the core + header mark. The orb used to carry a robot emoji,
  // which is the single most "off-the-shelf robot" tell on the page.
  const mono = (companyName.trim()[0] || "H").toUpperCase();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="description" content="Talk to the AI agent for ${esc(companyName)}">
<meta name="theme-color" content="#05070d">
<title>Talk to ${esc(agentName)} — ${esc(companyName)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    color-scheme: dark;                      /* native controls/scrollbars render dark */
    --bg: #05070d;
    --bg-2: #080d18;
    --surface: #0d1420;
    --surface-2: #131c2b;
    --line: rgba(255,255,255,.08);
    --line-2: rgba(255,255,255,.04);
    --text: #e8eefb;
    --muted: #5b7196;
    --muted-2: #7f93b4;
    --primary: #4a9eff;
    --primary-dim: rgba(74,158,255,.15);
    --green: #22c55e;
    --amber: #f59e0b;
    --red: #ef4444;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }

  html, body {
    min-height: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    overflow-x: hidden;
  }
  body { position: relative; }

  /* ---- Ambient background: aurora + grid, both cheap (no JS) ---- */
  .aurora {
    position: fixed; inset: 0; z-index: 0; pointer-events: none;
    background:
      radial-gradient(60% 45% at 50% 0%,   var(--primary-dim) 0%, transparent 60%),
      radial-gradient(45% 35% at 88% 18%,  rgba(124,106,255,.10) 0%, transparent 65%),
      radial-gradient(45% 40% at 8% 30%,   rgba(34,197,94,.06) 0%, transparent 65%),
      linear-gradient(180deg, var(--bg) 0%, var(--bg-2) 55%, var(--bg) 100%);
  }
  .grid-overlay {
    position: fixed; inset: 0; z-index: 0; pointer-events: none;
    background-image:
      linear-gradient(var(--line-2) 1px, transparent 1px),
      linear-gradient(90deg, var(--line-2) 1px, transparent 1px);
    background-size: 46px 46px;
    mask-image: radial-gradient(75% 60% at 50% 38%, #000 0%, transparent 78%);
    -webkit-mask-image: radial-gradient(75% 60% at 50% 38%, #000 0%, transparent 78%);
  }

  /* ---- Layout ---- */
  .app {
    position: relative; z-index: 1;
    width: min(620px, 100%);
    margin: 0 auto;
    min-height: 100dvh;
    display: flex; flex-direction: column;
    gap: 1.05rem;
    padding: max(1.1rem, env(safe-area-inset-top)) 1rem max(1.4rem, env(safe-area-inset-bottom));
  }

  /* ---- Header ---- */
  .hdr { display: flex; align-items: center; gap: .75rem; }
  .brand { display: flex; align-items: center; gap: .7rem; min-width: 0; flex: 1; }
  .brand-mark {
    flex-shrink: 0;
    width: 40px; height: 40px; border-radius: 12px;
    display: grid; place-items: center;
    font-weight: 700; font-size: 1.05rem; letter-spacing: -.02em;
    color: var(--text);
    background: linear-gradient(145deg, var(--primary-dim), rgba(255,255,255,.03));
    border: 1px solid var(--line);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 8px 22px -12px var(--primary);
  }
  .brand-txt { min-width: 0; }
  .brand-txt h1 {
    font-size: clamp(1.05rem, 3.6vw, 1.3rem);
    font-weight: 650; letter-spacing: -.02em; line-height: 1.15;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .brand-txt p {
    font-size: .82rem; color: var(--muted-2); margin-top: .12rem;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  /* Live pill — connection state, always truthful */
  .live-pill {
    flex-shrink: 0;
    display: inline-flex; align-items: center; gap: .42rem;
    padding: .34rem .62rem; border-radius: 999px;
    border: 1px solid var(--line);
    background: rgba(255,255,255,.02);
    font-size: .7rem; letter-spacing: .09em; text-transform: uppercase;
    color: var(--muted-2); font-weight: 650;
    white-space: nowrap;
  }
  .live-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--muted); flex-shrink: 0;
  }
  .live-pill[data-live="connecting"] { color: var(--primary); border-color: var(--primary-dim); }
  .live-pill[data-live="connecting"] .live-dot { background: var(--primary); animation: blink 1s steps(2,end) infinite; }
  .live-pill[data-live="on"] { color: var(--green); border-color: rgba(34,197,94,.25); }
  .live-pill[data-live="on"] .live-dot { background: var(--green); box-shadow: 0 0 9px var(--green); }
  .live-pill[data-live="talk"] { color: var(--primary); border-color: var(--primary-dim); }
  .live-pill[data-live="talk"] .live-dot { background: var(--primary); box-shadow: 0 0 9px var(--primary); animation: pulseDot 1.1s ease-in-out infinite; }
  .live-pill[data-live="err"] { color: var(--red); border-color: rgba(239,68,68,.3); }
  .live-pill[data-live="err"] .live-dot { background: var(--red); }
  @keyframes blink { 50% { opacity: .25 } }
  @keyframes pulseDot { 0%,100% { transform: scale(1); opacity: 1 } 50% { transform: scale(1.5); opacity: .5 } }

  /* ---- Stage: canvas + orb ---- */
  .stage {
    position: relative;
    display: grid; place-items: center;
    padding: .4rem 0 .1rem;
    min-height: 268px;
  }
  #fx {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    pointer-events: none; z-index: 0;
  }
  .orb-wrapper {
    position: relative; z-index: 1;
    width: 208px; height: 208px;
    display: grid; place-items: center;
    flex-shrink: 0;
  }
  .orb {
    position: relative;
    width: 100%; height: 100%;
    border-radius: 50%;
    display: grid; place-items: center;
    cursor: pointer;
    transition: transform .35s cubic-bezier(.2,.8,.2,1);
    will-change: transform;
  }
  .orb:hover { transform: scale(1.03); }
  .orb-core {
    position: absolute; inset: 12px;
    border-radius: 50%;
    overflow: hidden;
    background:
      radial-gradient(circle at 34% 30%, rgba(255,255,255,.16) 0%, transparent 42%),
      radial-gradient(circle at 50% 50%, var(--primary-dim) 0%, rgba(8,11,20,.92) 62%, rgba(5,7,13,.98) 100%);
    border: 1px solid var(--line);
    box-shadow:
      inset 0 0 40px -8px var(--primary-dim),
      0 22px 60px -28px var(--primary);
    transition: background .6s ease, border-color .6s ease, box-shadow .6s ease;
  }
  /* glass sheen sweeping the core — pure CSS, compositor-only */
  .orb-core::after {
    content: ""; position: absolute; inset: -40%;
    background: conic-gradient(from 0deg, transparent 0deg, rgba(255,255,255,.10) 42deg, transparent 92deg);
    animation: sheen 7s linear infinite;
  }
  @keyframes sheen { to { transform: rotate(360deg) } }
  .orb-mono {
    position: relative; z-index: 2;
    font-size: 2.5rem; font-weight: 700; letter-spacing: -.03em;
    color: rgba(255,255,255,.14);
    user-select: none; pointer-events: none;
    transition: color .5s ease, opacity .5s ease;
  }
  .ring-spin {
    position: absolute; inset: -6px; border-radius: 50%;
    border: 1.5px solid transparent;
    border-top-color: var(--primary); border-right-color: var(--primary);
    opacity: 0; transition: opacity .4s ease;
  }
  .trace {
    position: absolute; inset: -14px; border-radius: 50%;
    border: 1px solid var(--line); opacity: .5;
  }
  .trace.t2 { inset: -26px; opacity: .25; }

  /* ---- Caption under the orb ---- */
  .caption { text-align: center; display: flex; flex-direction: column; gap: .3rem; align-items: center; }
  .status-text {
    font-size: .97rem; color: var(--muted-2);
    letter-spacing: .01em; min-height: 1.35rem;
    transition: color .3s ease;
  }
  .status-text.active { color: var(--text); }
  .sub-status {
    font-family: var(--mono); font-size: .7rem; letter-spacing: .1em;
    text-transform: uppercase; color: var(--muted); min-height: .9rem;
  }
  .call-timer {
    display: none; font-family: var(--mono); font-variant-numeric: tabular-nums;
    font-size: .74rem; letter-spacing: .12em; color: var(--muted);
  }
  .call-timer.live { display: block; }

  .barge {
    align-self: center;
    display: none;
    font-family: var(--mono); font-size: .66rem; letter-spacing: .12em;
    text-transform: uppercase; color: var(--amber);
    border: 1px solid rgba(245,158,11,.3); background: rgba(245,158,11,.08);
    padding: .22rem .55rem; border-radius: 999px;
  }
  .barge.on { display: inline-block; }

  /* ---- Dual meters: caller vs agent, real RMS ---- */
  .meters {
    display: grid; grid-template-columns: 1fr 1fr; gap: .55rem;
    width: 100%;
  }
  .meter {
    background: linear-gradient(180deg, rgba(255,255,255,.022), transparent);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: .55rem .65rem;
    transition: border-color .35s ease, background .35s ease;
  }
  .meter.act { border-color: var(--primary-dim); background: rgba(74,158,255,.05); }
  .meter-top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: .4rem; }
  .meter-label { font-size: .68rem; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); font-weight: 650; }
  .meter-val { font-family: var(--mono); font-size: .66rem; color: var(--muted-2); font-variant-numeric: tabular-nums; }
  .meter-track { height: 4px; border-radius: 3px; background: rgba(255,255,255,.05); overflow: hidden; }
  .meter-fill {
    height: 100%; width: 0%; border-radius: 3px;
    background: var(--primary);
    transition: width .08s linear, background .3s ease;
  }
  #meterYou.act .meter-fill { background: var(--green); }
  #meterAgent.act .meter-fill { background: var(--primary); }

  /* ---- Phase rail ---- */
  .phases {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: .3rem;
    width: 100%;
    padding: .5rem .35rem;
    border: 1px solid var(--line); border-radius: 12px;
    background: rgba(255,255,255,.014);
  }
  .phase {
    display: flex; flex-direction: column; align-items: center; gap: .3rem;
    font-size: .62rem; letter-spacing: .1em; text-transform: uppercase;
    color: var(--muted); font-weight: 650;
    opacity: .5; transition: opacity .3s ease, color .3s ease;
  }
  .phase svg { width: 15px; height: 15px; display: block; }
  .phase.on { opacity: 1; color: var(--primary); }
  .phase.on[data-phase="listen"] { color: var(--green); }
  .phase.on[data-phase="think"] { color: var(--amber); }
  .phase-dot { width: 100%; height: 2px; border-radius: 2px; background: currentColor; opacity: .3; }
  .phase.on .phase-dot { opacity: 1; box-shadow: 0 0 10px currentColor; }

  /* ---- Link HUD: real getStats() telemetry ---- */
  .link-hud {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: .4rem;
    width: 100%;
  }
  .stat {
    border: 1px solid var(--line); border-radius: 10px;
    padding: .42rem .5rem;
    background: rgba(255,255,255,.014);
    display: flex; flex-direction: column; gap: .12rem;
    min-width: 0;
  }
  .stat-k { font-size: .58rem; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); font-weight: 650; }
  .stat-v { font-family: var(--mono); font-size: .78rem; color: var(--text); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stat-v.warn { color: var(--amber); }
  .stat-v.bad { color: var(--red); }

  /* ---- Level strips (harness reads .bar) ---- */
  .wave-bars {
    display: flex; gap: 4px; align-items: flex-end; justify-content: space-between;
    height: 34px; width: 100%; opacity: 0; transition: opacity .35s ease;
  }
  .wave-bars.on { opacity: .9; }
  .bar {
    flex: 1 1 0; max-width: 22px; min-height: 3px; border-radius: 3px;
    background: var(--primary); opacity: .5;
    transition: height .12s linear, background .3s ease;
  }
  .thinking .bar { background: var(--amber); }
  .listening .bar { background: var(--green); }

  /* ---- Text fallback ---- */
  .input-area {
    display: none; gap: .5rem; width: 100%;
  }
  .input-area.visible { display: flex; }
  .msg-input {
    flex: 1; min-width: 0;
    padding: .7rem .9rem; border-radius: 11px;
    border: 1px solid var(--line); background: var(--surface);
    color: var(--text); font-size: .92rem; font-family: inherit; outline: none;
    transition: border-color .2s ease, box-shadow .2s ease;
  }
  .msg-input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-dim); }
  .msg-input::placeholder { color: var(--muted); }
  .btn-send {
    padding: .7rem 1.1rem; border-radius: 11px; border: none;
    background: var(--primary); color: #041020;
    font-size: .88rem; font-weight: 700; cursor: pointer; font-family: inherit;
    transition: filter .2s ease, transform .15s ease;
  }
  .btn-send:hover { filter: brightness(1.1); }
  .btn-send:active { transform: scale(.97); }

  .transcript {
    width: 100%; max-height: 220px; overflow-y: auto;
    display: flex; flex-direction: column; gap: .45rem;
    padding-right: .2rem; scroll-behavior: smooth;
  }
  .transcript:empty { display: none; }
  .transcript::-webkit-scrollbar { width: 3px; }
  .transcript::-webkit-scrollbar-track { background: transparent; }
  .transcript::-webkit-scrollbar-thumb { background: var(--line); border-radius: 3px; }
  .msg {
    padding: .55rem .8rem; border-radius: 10px;
    font-size: .85rem; line-height: 1.5; max-width: 92%;
    animation: fadeUp .28s cubic-bezier(.2,.8,.2,1);
    border: 1px solid transparent;
  }
  .msg.user   { background: rgba(74,158,255,.10); border-color: rgba(74,158,255,.20);
                align-self: flex-end; color: var(--text); }
  .msg.agent  { background: var(--surface); border-color: var(--line);
                align-self: flex-start; color: var(--text); }
  .msg.system { background: rgba(255,255,255,.03); border-color: var(--line);
                align-self: center; color: var(--muted-2); font-size: .75rem;
                font-family: var(--mono); max-width: 100%; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(7px) } to { opacity: 1; transform: none } }

  /* ---- Business card chips ---- */
  .biz-panel {
    width: 100%;
    border: 1px solid var(--line); border-radius: 12px;
    padding: .8rem .85rem;
    display: flex; flex-direction: column; gap: .55rem;
    background: rgba(255,255,255,.014);
  }
  .biz-label {
    font-size: .6rem; text-transform: uppercase; letter-spacing: .14em;
    color: var(--muted); font-weight: 700;
  }
  .biz-row { display: flex; flex-wrap: wrap; gap: .38rem; }
  .biz-chip {
    font-size: .76rem; color: var(--muted-2);
    background: var(--surface); border: 1px solid var(--line);
    border-radius: 999px; padding: .3rem .66rem;
    display: inline-flex; gap: .35rem; align-items: center;
  }
  .biz-chip svg { width: 12px; height: 12px; opacity: .7; }

  /* ---- Controls ---- */
  .controls { display: flex; justify-content: center; margin-top: auto; padding-top: .3rem; }
  .btn-start {
    padding: .8rem 2.2rem; border-radius: 999px; border: none;
    background: linear-gradient(135deg, var(--primary) 0%, #7c6aff 100%);
    color: #041020; font-size: 1rem; font-weight: 700; cursor: pointer;
    font-family: inherit; letter-spacing: .01em;
    box-shadow: 0 12px 34px -12px var(--primary);
    transition: transform .2s ease, box-shadow .2s ease;
  }
  .btn-start:hover { transform: translateY(-2px); box-shadow: 0 16px 40px -12px var(--primary); }
  .btn-start:active { transform: scale(.97); }
  .btn-start.hidden { display: none; }
  .btn-end {
    padding: .62rem 1.5rem; border-radius: 999px;
    border: 1px solid rgba(239,68,68,.35); background: rgba(239,68,68,.06);
    color: #f87171; font-size: .84rem; font-weight: 650; cursor: pointer;
    font-family: inherit; letter-spacing: .02em;
    display: none;
    transition: background .2s ease, border-color .2s ease;
  }
  .btn-end.visible { display: inline-block; }
  .btn-end:hover { background: rgba(239,68,68,.13); border-color: rgba(239,68,68,.5); }

  .foot {
    text-align: center; font-family: var(--mono); font-size: .62rem;
    letter-spacing: .1em; text-transform: uppercase; color: #2c3a52;
  }

  /* ---- State-driven orb colour ---- */
  .orb.listening .orb-core {
    background:
      radial-gradient(circle at 34% 30%, rgba(255,255,255,.16) 0%, transparent 42%),
      radial-gradient(circle at 50% 50%, rgba(34,197,94,.18) 0%, rgba(8,20,14,.92) 62%, rgba(5,7,13,.98) 100%);
    border-color: rgba(34,197,94,.32);
    box-shadow: inset 0 0 46px -8px rgba(34,197,94,.28), 0 22px 60px -28px var(--green);
  }
  .orb.listening .orb-mono { color: rgba(34,197,94,.22); }
  .orb.thinking .orb-core {
    background:
      radial-gradient(circle at 34% 30%, rgba(255,255,255,.16) 0%, transparent 42%),
      radial-gradient(circle at 50% 50%, rgba(245,158,11,.18) 0%, rgba(22,16,6,.92) 62%, rgba(5,7,13,.98) 100%);
    border-color: rgba(245,158,11,.32);
    box-shadow: inset 0 0 46px -8px rgba(245,158,11,.28), 0 22px 60px -28px var(--amber);
  }
  .orb.thinking .orb-mono { color: rgba(245,158,11,.22); }
  .orb.thinking .orb-core::after { animation-duration: 1.6s; }
  .orb.speaking .orb-core {
    background:
      radial-gradient(circle at 34% 30%, rgba(255,255,255,.18) 0%, transparent 42%),
      radial-gradient(circle at 50% 50%, rgba(74,158,255,.22) 0%, rgba(8,16,34,.92) 62%, rgba(5,7,13,.98) 100%);
    border-color: rgba(74,158,255,.38);
    box-shadow: inset 0 0 50px -8px var(--primary-dim), 0 22px 64px -26px var(--primary);
  }
  .orb.connecting .orb-core { animation: breathe 1.5s ease-in-out infinite; }
  .orb.idle .orb-core { animation: breathe 3.4s ease-in-out infinite; }
  .orb.error .orb-core { border-color: rgba(239,68,68,.35); }
  .orb.error .orb-mono { color: rgba(239,68,68,.25); }
  @keyframes breathe { 0%,100% { transform: scale(1) } 50% { transform: scale(1.028) } }
  .connecting .ring-spin { opacity: 1; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg) } }
  .stale .trace { opacity: 0; }

  @media (max-width: 430px) {
    .orb-wrapper { width: 174px; height: 174px; }
    .orb-mono { font-size: 2.1rem; }
    .stage { min-height: 228px; }
    .link-hud { grid-template-columns: repeat(2, 1fr); }
    .phase { font-size: .56rem; letter-spacing: .06em; }
  }

  @media (prefers-reduced-motion: reduce) {
    .orb-core::after, .ring-spin, .orb-core, .live-dot { animation: none !important; }
    .msg { animation: none !important; }
  }
</style>
</head>
<body>
<div class="aurora"></div>
<div class="grid-overlay"></div>

<div class="app" id="app">

  <header class="hdr">
    <div class="brand">
      <div class="brand-mark" aria-hidden="true">${esc(mono)}</div>
      <div class="brand-txt">
        <h1>${esc(companyName)}</h1>
        <p>${esc(tagline || "AI voice agent — available 24/7")}</p>
      </div>
    </div>
    <div class="live-pill" id="livePill" data-live="idle">
      <span class="live-dot" aria-hidden="true"></span><span id="liveText">Standby</span>
    </div>
  </header>

  <section class="stage" id="stage">
    <canvas id="fx" aria-hidden="true"></canvas>
    <div class="orb-wrapper" id="orbWrapper">
      <div class="trace t1" aria-hidden="true"></div>
      <div class="trace t2" aria-hidden="true"></div>
      <div class="ring-spin" aria-hidden="true"></div>
      <div class="orb idle" id="orb" role="img" aria-label="Voice agent status">
        <div class="orb-core"></div>
        <div class="orb-mono" aria-hidden="true">${esc(mono)}</div>
      </div>
    </div>
  </section>

  <div class="caption">
    <div class="status-text" id="statusText" aria-live="polite">Ready to connect</div>
    <div class="sub-status" id="subStatus"></div>
    <div class="call-timer" id="callTimer">00:00</div>
  </div>

  <div class="barge" id="bargeBadge">Interrupting</div>

  <section class="meters" aria-label="Audio levels">
    <div class="meter" id="meterYou">
      <div class="meter-top"><span class="meter-label">You</span><span class="meter-val" id="valYou">idle</span></div>
      <div class="meter-track"><div class="meter-fill" id="fillYou"></div></div>
    </div>
    <div class="meter" id="meterAgent">
      <div class="meter-top"><span class="meter-label">${esc(agentName)}</span><span class="meter-val" id="valAgent">idle</span></div>
      <div class="meter-track"><div class="meter-fill" id="fillAgent"></div></div>
    </div>
  </section>

  <section class="phases" id="phases" aria-label="Call phase">
    <div class="phase" data-phase="connect">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v6"/><path d="M6.5 6.5a8 8 0 1 0 11 0"/></svg>
      <span>Link</span><span class="phase-dot"></span>
    </div>
    <div class="phase" data-phase="listen">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>
      <span>Listen</span><span class="phase-dot"></span>
    </div>
    <div class="phase" data-phase="think">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg>
      <span>Think</span><span class="phase-dot"></span>
    </div>
    <div class="phase" data-phase="speak">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/></svg>
      <span>Speak</span><span class="phase-dot"></span>
    </div>
  </section>

  <section class="link-hud" id="linkHud" aria-label="Link telemetry">
    <div class="stat"><span class="stat-k">RTT</span><span class="stat-v" id="statRtt">--</span></div>
    <div class="stat"><span class="stat-k">Jitter</span><span class="stat-v" id="statJitter">--</span></div>
    <div class="stat"><span class="stat-k">Loss</span><span class="stat-v" id="statLoss">--</span></div>
    <div class="stat"><span class="stat-k">Codec</span><span class="stat-v" id="statCodec">--</span></div>
  </section>

  <div class="wave-bars" id="waveBars">
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
    <div class="bar" style="height:4px"></div>
  </div>

  <div class="input-area" id="inputArea">
    <input class="msg-input" id="msgInput" type="text" placeholder="Type your message…" maxlength="500"
      onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMessage()}" />
    <button class="btn-send" id="btnSend" onclick="sendMessage()">Send</button>
  </div>

  <div class="transcript" id="transcript"></div>

  ${(hours || phone || offers.length) ? `<section class="biz-panel" id="bizPanel">
    ${(hours || phone) ? `<div class="biz-row">
      ${hours ? `<span class="biz-chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>${esc(hours)}</span>` : ""}
      ${phone ? `<span class="biz-chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h3l2 5-2 1a12 12 0 0 0 6 6l1-2 5 2v3a2 2 0 0 1-2 2A17 17 0 0 1 4 5a2 2 0 0 1 2-2z"/></svg>${esc(phone)}</span>` : ""}
    </div>` : ""}
    ${offers.length ? `<div>
      <div class="biz-label">What we can help with</div>
      <div class="biz-row" style="margin-top:.4rem">${offers.map((o) => `<span class="biz-chip">${esc(o)}</span>`).join("")}</div>
    </div>` : ""}
  </section>` : ""}

  <div class="controls">
    <button class="btn-start hidden" id="btnStart" onclick="startCall()">Start call</button>
    <button class="btn-end" id="btnEnd" onclick="endCall()">End call</button>
  </div>

  <div class="foot">Encrypted relay · no recording</div>
</div>

<audio id="remoteAudio" autoplay playsinline></audio>

<script type="importmap">
{ "imports": { "nostr-tools": "https://cdn.jsdelivr.net/npm/nostr-tools@2.10.4/+esm" } }
</script>
<script>
// If the module below never runs -- a blocked CDN, an offline phone -- nothing
// on this page works. Say so, rather than leaving a live-looking button that
// can never do anything. A classic script, no imports, so it runs regardless.
window.__callBooted = false;
setTimeout(function () {
  if (window.__callBooted) return;
  var s = document.getElementById('statusText');
  if (s) { s.textContent = 'Could not load the call agent. Check your connection and reload.'; s.className = 'status-text active'; }
  var p = document.getElementById('livePill');
  if (p) { p.setAttribute('data-live', 'err'); }
  var lt = document.getElementById('liveText');
  if (lt) { lt.textContent = 'Offline'; }
}, 6000);
</script>
<script type="module">
import { generateSecretKey, getPublicKey, finalizeEvent, nip19, nip44, SimplePool } from 'nostr-tools';
window.__callBooted = true;

// ---------------------------------------------------------------------------
// A real call, not a rendering of one.
//
// The business's agent-voice endpoint listens on the relay for a gift-wrapped
// offer addressed to its npub. We wrap an offer the way /caller/index.html
// does; the audio that comes back is the agent actually speaking.
//
// The UI is a readout of that call: two AnalyserNodes (the caller's mic and the
// remote track) drive the meters, the orb and the canvas; getStats() drives the
// link HUD; the connection state machine drives the phase rail. Nothing here
// animates on a timer to look busy.
// ---------------------------------------------------------------------------
const COMPANY_ID = ${JSON.stringify(companyId)};
const AGENT_NAME = ${JSON.stringify(agentName)};
const VOICE      = ${JSON.stringify(voice)};
const TURN_URL   = ${JSON.stringify(turnCredsUrl)};

const orb        = document.getElementById('orb');
const wrapper    = document.getElementById('orbWrapper');
const stage      = document.getElementById('stage');
const fx         = document.getElementById('fx');
const statusEl   = document.getElementById('statusText');
const subEl      = document.getElementById('subStatus');
const startBtn   = document.getElementById('btnStart');
const inputArea  = document.getElementById('inputArea');
const transcript = document.getElementById('transcript');
const endBtn     = document.getElementById('btnEnd');
const waveBars   = document.getElementById('waveBars');
const bars       = Array.from(document.querySelectorAll('.bar'));
const remoteAudio = document.getElementById('remoteAudio');
const livePill   = document.getElementById('livePill');
const liveText   = document.getElementById('liveText');
const bargeBadge = document.getElementById('bargeBadge');
const fillYou    = document.getElementById('fillYou');
const fillAgent  = document.getElementById('fillAgent');
const valYou     = document.getElementById('valYou');
const valAgent   = document.getElementById('valAgent');
const meterYou   = document.getElementById('meterYou');
const meterAgent = document.getElementById('meterAgent');
const statRtt    = document.getElementById('statRtt');
const statJitter = document.getElementById('statJitter');
const statLoss   = document.getElementById('statLoss');
const statCodec  = document.getElementById('statCodec');
const phases     = Array.from(document.querySelectorAll('.phase'));

let state = null, pc = null, sub = null, audioCtx = null;
let playbackBlocked = false;
let starting = false;
let autoStartTimer = null;
let ringTimeout = null;
let bootOk = false;
let everConnected = false;
let micStream = null, micAn = null, remoteAn = null;
let callId = null, pool = null, mySeckey = null, myPubkey = null, agentPubkey = null;
let micLevel = 0, agentLevel = 0, lastSpeech = 0, statsInt = null;

const STATUS = {
  idle:       'Ready to connect',
  connecting: 'Connecting…',
  listening:  'Connected — go ahead and talk',
  thinking:   AGENT_NAME + ' is thinking…',
  speaking:   AGENT_NAME + ' is speaking…',
  error:      'Voice is unavailable right now'
};
// Short mono label for the live pill (never invent a state that is not real).
const PILL = {
  idle: 'Standby', connecting: 'Linking', listening: 'Live',
  thinking: 'Thinking', speaking: 'Speaking', error: 'Offline'
};
const PILL_MODE = {
  idle: 'idle', connecting: 'connecting', listening: 'on',
  thinking: 'talk', speaking: 'talk', error: 'err'
};
const PHASE = { idle: null, connecting: 'connect', listening: 'listen', thinking: 'think', speaking: 'speak', error: null };
const PAL = {
  idle: '#4a9eff', connecting: '#4a9eff', listening: '#22c55e',
  thinking: '#f59e0b', speaking: '#4a9eff', error: '#ef4444'
};

function setState(s) {
  if (s === state) return;              // the rAF loop calls this every frame
  state = s;
  if (s === 'listening' || s === 'thinking' || s === 'speaking') startTimer();
  orb.className = 'orb ' + s;
  wrapper.className = 'orb-wrapper ' + (s === 'idle' ? 'idle stale' : s);
  livePill.setAttribute('data-live', PILL_MODE[s] || 'idle');
  liveText.textContent = PILL[s] || '';
  statusEl.textContent = playbackBlocked ? ('Tap anywhere to hear ' + AGENT_NAME) : (STATUS[s] || '');
  statusEl.className = 'status-text' + (s !== 'idle' ? ' active' : '');
  waveBars.className = 'wave-bars' + ((s === 'listening' || s === 'speaking' || s === 'thinking') ? ' on' : '');
  var ph = PHASE[s];
  phases.forEach(function (p) { p.classList.toggle('on', p.getAttribute('data-phase') === ph); });
  if (s === 'idle') { endBtn.classList.remove('visible'); stopStats(); }
  else { endBtn.classList.add('visible'); }
}

function log(text, kind) {
  const d = document.createElement('div');
  d.className = 'msg ' + (kind || 'agent');
  d.textContent = text;
  transcript.appendChild(d);
  transcript.scrollTop = transcript.scrollHeight;
}

// ---- Real audio levels (replaces the Math.random() waveform) ----
function analyserFor(stream) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const an = audioCtx.createAnalyser();
  an.fftSize = 512;
  an.smoothingTimeConstant = 0.72;
  audioCtx.createMediaStreamSource(stream).connect(an);
  return an;
}
const timeBuf = new Uint8Array(512);
const freqBuf = new Uint8Array(256);
function loudness(an) {
  if (!an) return 0;
  an.getByteTimeDomainData(timeBuf);
  let sum = 0;
  for (let i = 0; i < timeBuf.length; i++) { const v = (timeBuf[i] - 128) / 128; sum += v * v; }
  return Math.sqrt(sum / timeBuf.length);
}
function drawBars(an) {
  if (!an) return;
  an.getByteFrequencyData(freqBuf);
  const n = bars.length, span = Math.floor(freqBuf.length * 0.45 / n) || 1;
  for (let i = 0; i < n; i++) {
    let peak = 0;
    for (let q = 0; q < span; q++) peak = Math.max(peak, freqBuf[i * span + q] || 0);
    bars[i].style.height = (3 + (peak / 255) * 22) + 'px';
  }
}

// ---- Canvas: particle field + radial spectrum + dual activity arcs ----
// 2D context on purpose: no WebGL dependency, so this renders identically on a
// cheap Android, an iPhone and a desktop. Cheap by construction — ~44 particles,
// no per-frame allocation, and it stops drawing entirely when reduced-motion is on.
const ctx = fx ? fx.getContext('2d') : null;
const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let W = 0, H = 0, DPR = Math.min(2, window.devicePixelRatio || 1);
let parts = [];
function seedParts() {
  parts = [];
  const n = reduce ? 0 : 44;
  for (let i = 0; i < n; i++) {
    parts.push({ a: Math.random() * Math.PI * 2, r: 78 + Math.random() * 120,
                 s: (Math.random() * 0.5 + 0.12) * (Math.random() < 0.5 ? -1 : 1),
                 z: Math.random() * 0.7 + 0.3 });
  }
}
function sizeFx() {
  if (!fx || !stage) return;
  const r = stage.getBoundingClientRect();
  W = r.width; H = r.height;
  fx.width = Math.max(1, W * DPR); fx.height = Math.max(1, H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
function drawFx() {
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2;
  const base = Math.max(84, wrapper.getBoundingClientRect().width / 2 + 6);
  const col = PAL[state] || PAL.idle;

  // particle field — drifts on a ring, pushed outward by whichever channel is hot
  const energy = Math.max(micLevel, agentLevel);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    p.a += p.s * 0.0032;
    const rr = p.r + energy * 34 * p.z;
    const x = cx + Math.cos(p.a) * rr, y = cy + Math.sin(p.a) * rr;
    const sz = 0.7 + p.z * 1.5;
    ctx.globalAlpha = (0.10 + p.z * 0.30) * (0.5 + energy * 2.4);
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(x, y, sz, 0, 6.2832); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // radial spectrum — real frequency bins, wrapped SYMMETRICALLY around the orb.
  // The mirroring is load-bearing: speech energy sits in the low bins, so sweeping
  // 0..2pi linearly lights only a ~90-degree wedge and reads as a broken arc. Folding
  // the bins to either side of the vertical axis fills the ring and looks intended.
  if (freqBuf && state && state !== 'idle') {
    const N = 48, span = Math.floor(freqBuf.length / N) || 1;
    ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = col;
    const r0 = base + 11;
    for (let i = 0; i < N; i++) {
      let peak = 0;
      for (let q = 0; q < span; q++) peak = Math.max(peak, freqBuf[i * span + q] || 0);
      const mag = peak / 255;
      if (mag < 0.02) continue;
      const a = (i / N) * Math.PI - Math.PI / 2;   // top -> right -> bottom
      const len = 3 + mag * 34;
      ctx.globalAlpha = 0.18 + mag * 0.6;
      for (let m = 0; m < 2; m++) {
        const ang = m ? (-Math.PI - a) : a;         // fold onto the left half
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
        ctx.lineTo(cx + Math.cos(ang) * (r0 + len), cy + Math.sin(ang) * (r0 + len));
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  // dual activity arcs — inner = you (mic), outer = the agent (remote)
  arc(cx, cy, base - 4, micLevel, '#22c55e', 2);
  arc(cx, cy, base + 6, agentLevel, '#4a9eff', 2);
}
function arc(cx, cy, r, level, colour, lw) {
  if (!level || level < 0.012) return;
  const sweep = Math.min(1, level * 3.2) * Math.PI * 1.5;
  ctx.globalAlpha = 0.75;
  ctx.strokeStyle = colour;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + sweep);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function loop() {
  requestAnimationFrame(loop);
  if (!pc) { drawFx(); return; }
  micLevel = loudness(micAn);
  agentLevel = loudness(remoteAn);
  drawBars(remoteAn || micAn);

  const now = Date.now();
  if (micLevel > 0.035) lastSpeech = now;

  // Phase inference. The server does not send a "thinking" event, but the
  // pipeline genuinely IS thinking between the caller stopping and the reply
  // starting — so infer it from the two levels rather than leaving the amber
  // thinking styling unreachable (which is what it used to be: styled, dead).
  let next;
  if (pc.connectionState !== 'connected') next = 'connecting';
  else if (agentLevel > 0.035) next = 'speaking';
  else if (micLevel > 0.035) next = 'listening';
  else if (now - lastSpeech < 1700) next = 'thinking';
  else next = 'listening';
  setState(next);

  // Real meters + the barge-in affordance (the caller talking over the agent).
  const pct = function (v) { return Math.min(100, Math.round(v * 320)) + '%'; };
  fillYou.style.width = pct(micLevel);
  fillAgent.style.width = pct(agentLevel);
  valYou.textContent = micLevel > 0.035 ? 'speaking' : 'idle';
  valAgent.textContent = agentLevel > 0.035 ? 'speaking' : 'idle';
  meterYou.classList.toggle('act', micLevel > 0.035);
  meterAgent.classList.toggle('act', agentLevel > 0.035);
  var both = micLevel > 0.035 && agentLevel > 0.035;
  bargeBadge.classList.toggle('on', both);
  if (both && !bargeBadge.__n) { log('You spoke over the agent — it will stop and listen.', 'system'); bargeBadge.__n = 1; }
  if (!both) bargeBadge.__n = 0;

  drawFx();
}

// ---- Link telemetry: the connection's own numbers, not guesses ----
function startStats() { if (!statsInt) statsInt = setInterval(pollStats, 1000); }
function stopStats() { if (statsInt) { clearInterval(statsInt); statsInt = null; } }
function pollStats() {
  if (!pc || !pc.getStats) return;
  let p;
  try { p = pc.getStats(); } catch (e) { return; }
  p.then(function (rep) {
    var rtt = null, jit = null, loss = null;
    rep.forEach(function (s) {
      if (s.type === 'candidate-pair' && (s.nominated || s.state === 'succeeded') && s.currentRoundTripTime != null) rtt = s.currentRoundTripTime;
      if (s.type === 'remote-inbound-rtp' && s.kind === 'audio') {
        if (s.jitter != null) jit = s.jitter;
        if (s.packetsLost != null) loss = s.packetsLost;
      }
      if (s.type === 'inbound-rtp' && s.kind === 'audio' && jit == null && s.jitter != null) jit = s.jitter;
    });
    if (rtt != null) { statRtt.textContent = Math.round(rtt * 1000) + ' ms'; statRtt.className = 'stat-v' + (rtt > 0.3 ? ' warn' : rtt > 0.15 ? '' : ''); }
    if (jit != null) { statJitter.textContent = (jit * 1000).toFixed(1) + ' ms'; statJitter.className = 'stat-v' + (jit > 0.05 ? ' warn' : ''); }
    if (loss != null) { statLoss.textContent = loss + (loss === 1 ? ' pkt' : ' pkts'); statLoss.className = 'stat-v' + (loss > 5 ? ' bad' : loss > 0 ? ' warn' : ''); }
  }).catch(function () {});
}
function readCodec() {
  try {
    const sdp = (pc.localDescription && pc.localDescription.sdp) || '';
    // NOTE: this regex lives inside a TypeScript template literal, so every
    // backslash must be doubled — a single \d is consumed by TS (-> "d") and a
    // single \/ becomes a real "/" that terminates the regex literal early,
    // which ships a page whose module throws "Unexpected token ')'" and never boots.
    const m = /a=rtpmap:\\d+\\s+([A-Za-z0-9]+)\\/(\\d+)/.exec(sdp);
    if (m) { statCodec.textContent = m[1].toUpperCase() + ' ' + Math.round(Number(m[2]) / 1000) + 'k'; }
  } catch (e) {}
}

// ---- Signaling: gift-wrapped events over the relay (NIP-44 / kind:1059) ----
function giftWrap(obj) {
  const key = nip44.v2.utils.getConversationKey(mySeckey, agentPubkey);
  return finalizeEvent({
    kind: 1059,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', agentPubkey]],
    content: nip44.v2.encrypt(JSON.stringify(obj), key)
  }, mySeckey);
}
async function sendSignal(type, extra) {
  const ev = giftWrap(Object.assign({ type: type, call_id: callId }, extra || {}));
  await Promise.allSettled(pool.publish(VOICE.relays, ev));
}
function subscribeAnswer() {
  var pendingIce = [];   // candidates that arrived before the answer was applied
  sub = pool.subscribeMany(
    VOICE.relays,
    [{ kinds: [1059], '#p': [myPubkey], since: Math.floor(Date.now() / 1000) - 5 }],
    { onevent(ev) {
        let sig;
        try {
          const key = nip44.v2.utils.getConversationKey(mySeckey, ev.pubkey);
          sig = JSON.parse(nip44.v2.decrypt(ev.content, key));
        } catch (e) { return; }
        if (!sig || sig.call_id !== callId) return;
        if (sig.type === 'answer') {
          if (ringTimeout) { clearTimeout(ringTimeout); ringTimeout = null; }
          if (pc && pc.signalingState !== 'stable') {
            pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp })
              .then(function () {
                readCodec();
                while (pc && pendingIce.length) {
                  pc.addIceCandidate(new RTCIceCandidate(pendingIce.shift())).catch(function () {});
                }
              })
              .catch(function (e) { log('Answer rejected: ' + e.message, 'system'); });
          }
        } else if (sig.type === 'ice' && sig.candidate) {
          // addIceCandidate rejects -- and the candidate is silently lost -- if no
          // remote description is applied yet. The agent sends its answer and its
          // candidates back to back, so a candidate can arrive before the SDP lands.
          // Buffer until setRemoteDescription resolves, then flush there.
          if (pc && pc.remoteDescription) pc.addIceCandidate(new RTCIceCandidate(sig.candidate)).catch(function () {});
          else pendingIce.push(sig.candidate);
        } else if (sig.type === 'hangup') {
          log('The agent ended the call.', 'system');
          endCall();
        }
      } });
}

let callStartTs = null, timerInt = null;
function startTimer() {
  if (timerInt) return;
  callStartTs = Date.now();
  var el = document.getElementById('callTimer');
  if (!el) return;
  el.classList.add('live');
  timerInt = setInterval(function () {
    var s = Math.floor((Date.now() - callStartTs) / 1000);
    el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }, 500);
}
function stopTimer() {
  if (timerInt) { clearInterval(timerInt); timerInt = null; }
  var el = document.getElementById('callTimer');
  if (el) el.classList.remove('live');
  callStartTs = null;
}

window.startCall = async function () {
  if (!VOICE.enabled) { log('Voice is not enabled for this business yet.'); return; }
  // Retrying a failed auto-start fires this twice: the window pointerdown _unlock
  // and the button's own onclick are the same gesture. Run it once.
  if (starting) return;
  starting = true;
  setState('connecting');
  startBtn.classList.add('hidden');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    micAn = analyserFor(micStream);
    // Obtaining the mic is a user activation on Chromium, and a page holding a live
    // capture stream is exempt from the autoplay block there -- resuming the context
    // here is what unlocks the agent's audio on desktop Chrome / Android. On WebKit
    // this is a no-op; the first-gesture fallback below is what recovers sound there.
    try { if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume(); } catch (e) {}

    callId = Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');

    mySeckey = generateSecretKey();
    myPubkey = getPublicKey(mySeckey);
    pool = new SimplePool();

    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    try {
      const c = await (await fetch(TURN_URL, { cache: 'no-store' })).json();
      (Array.isArray(c.urls) ? c.urls : [c.urls]).forEach(function (u) {
        iceServers.push({ urls: u, username: c.username, credential: c.credential });
      });
    } catch (e) { log('No relay credentials — trying a direct path.', 'system'); }

    // Relay-only ICE. The default policy also gathers host + srflx candidates,
    // which from a NAT'd caller mostly fail — and the srflx gather waits on a
    // public STUN server, which is seconds of dead air before media starts. The
    // call is relayed via our own coturn anyway, so gather ONLY relay candidates:
    // ICE has one working path to find and connects far sooner.
    pc = new RTCPeerConnection({ iceServers: iceServers, iceTransportPolicy: 'relay' });
    micStream.getTracks().forEach(function (t) { pc.addTrack(t, micStream); });
    pc.ontrack = function (e) {
      remoteAudio.srcObject = e.streams[0];
      remoteAn = analyserFor(e.streams[0]);
      // The analyser reads the MediaStream, not the <audio> element, so the orb can
      // animate "speaking" while the caller still hears nothing (WebKit keeps audio
      // blocked until a real gesture). Try to play; if refused, say so instead of
      // showing a silently-broken call. The first tap recovers it via _unlock.
      var p = remoteAudio.play();
      if (p && p.catch) p.catch(function () { playbackBlocked = true; statusEl.textContent = 'Tap anywhere to hear ' + AGENT_NAME; });
    };
    pc.onicecandidate = function (e) {
      if (e.candidate) { sendSignal('ice', { candidate: e.candidate.toJSON() }).catch(function () {}); }
    };
    pc.onconnectionstatechange = function () {
      if (!pc) return;                       // a teardown below nulls pc
      const s = pc.connectionState;
      if (s === 'connected') {
        everConnected = true;
        setState('listening');
        readCodec();
        startStats();
        return;
      }
      if (s === 'failed' || s === 'closed') {
        // Terminal: release the mic, the PC and the pool rather than leaving them
        // open behind an error state -- otherwise a failed call keeps the mic hot
        // and its relay socket open until the page is reloaded.
        cleanup();
        setState('error');
        startBtn.classList.remove('hidden');
      } else if (s === 'disconnected') {
        // Often recovers (ICE retries); keep the session so 'connected' can follow.
        setState('error');
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sendSignal('offer', { sdp: offer.sdp });
    subscribeAnswer();
    sizeFx();
    requestAnimationFrame(loop);
    // A business can not answer two ways: no endpoint at all (the no-voice branch
    // below), or an endpoint that exists but is down. The first is handled at boot;
    // this is the second -- if no answer arrives, stop leaving the caller ringing
    // and hand them the text assistant that branch offers.
    ringTimeout = setTimeout(function () {
      ringTimeout = null;
      if (pc && pc.connectionState === 'connected') return;
      log('Nobody picked up just yet — you can type instead.', 'system');
      setState('error');
      inputArea.classList.add('visible');
      startBtn.classList.remove('hidden');
    }, 25000);
  } catch (e) {
    setState('error');
    log('Could not start the call: ' + (e && e.message ? e.message : e), 'system');
    startBtn.classList.remove('hidden');
    cleanup();
  } finally {
    starting = false;
  }
};

window.endCall = function () {
  try { if (pc) sendSignal('hangup', { reason: 'caller hangup' }); } catch (e) {}
  cleanup();
  setState('idle');
  startBtn.classList.remove('hidden');
  log('Call ended.', 'system');
};

function cleanup() {
  if (autoStartTimer) { clearTimeout(autoStartTimer); autoStartTimer = null; }
  if (ringTimeout) { clearTimeout(ringTimeout); ringTimeout = null; }
  stopTimer();
  stopStats();
  if (sub) { try { sub.close(); } catch (e) {} sub = null; }
  if (pc) { try { pc.close(); } catch (e) {} pc = null; }
  // The pool owns a WebSocket per relay and is created fresh on every startCall.
  // Leaving it open leaked one connection per call -- and the retry paths
  // (ring timeout, error, end then start again) repeat that within one visit.
  if (pool) {
    try { if (pool.close) pool.close(VOICE.relays); else if (pool.destroy) pool.destroy(); } catch (e) {}
    pool = null;
  }
  if (micStream) {
    try { micStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    micStream = null;
  }
  if (remoteAudio.srcObject) remoteAudio.srcObject = null;
  micAn = null; remoteAn = null;
  micLevel = 0; agentLevel = 0; lastSpeech = 0;
  fillYou.style.width = '0%'; fillAgent.style.width = '0%';
  valYou.textContent = 'idle'; valAgent.textContent = 'idle';
  meterYou.classList.remove('act'); meterAgent.classList.remove('act');
  bargeBadge.classList.remove('on');
  statRtt.textContent = '--'; statJitter.textContent = '--';
  statLoss.textContent = '--'; statCodec.textContent = '--';
  statRtt.className = 'stat-v'; statJitter.className = 'stat-v'; statLoss.className = 'stat-v';
  if (waveBars) waveBars.className = 'wave-bars';
  playbackBlocked = false;
  callId = null; mySeckey = null; myPubkey = null;
  agentPubkey = VOICE.enabled ? agentPubkey : null;
  drawFx();
}

// ---- Text assistant: only for a business with no voice endpoint ----
window.sendMessage = async function () {
  const box = document.getElementById('msgInput');
  const text = (box.value || '').trim();
  if (!text) return;
  box.value = '';
  log(text, 'user');
  try {
    const r = await fetch('${apiBase}/call-message/' + COMPANY_ID, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, companyId: COMPANY_ID })
    });
    const data = r.ok ? await r.json() : {};
    log(data.reply || data.text || data.message || 'I could not answer that just now.', 'agent');
  } catch (e) {
    log('I lost connection for a moment. Please try again.', 'agent');
  }
};

// ---- Boot ----
// Wrapped so a throw inside boot reports itself. A failure to load the
// signalling library happens before this runs, so the guard in the document
// head catches that instead (and stops a dead button being shown).
try {
  if (fx) { seedParts(); sizeFx(); window.addEventListener('resize', sizeFx); drawFx(); }
  if (VOICE.enabled) {
    agentPubkey = nip19.decode(VOICE.npub).data;
    // Entering the page IS the intent to call — no redundant button. Start the
    // call immediately. The browser prompts for the mic once; on Chromium that
    // grant also unlocks playback (a page holding a live capture stream is exempt
    // from the autoplay block), but WebKit still needs a real gesture — which is
    // what the first-tap _unlock fallback below is for.
    startBtn.classList.add('hidden');
    setState('connecting');
  } else {
    // No voice endpoint provisioned for this business (no npub): keep the text
    // assistant instead of offering a button that could only ever ring forever.
    // A business whose endpoint exists but is down gets the same fallback from
    // the ring timeout in startCall.
    startBtn.classList.add('hidden');
    setState('idle');
    inputArea.classList.add('visible');
    statusEl.textContent = 'Text assistant (voice not enabled for this business yet)';
    statusEl.className = 'status-text active';
    log('Voice is not enabled for this business yet — you can still type.', 'system');
  }
  bootOk = true;
} catch (e) {
  setState('error');
  startBtn.classList.add('hidden');
  inputArea.classList.add('visible');
  log('The voice line could not start: ' + (e && e.message ? e.message : e), 'system');
}

if (VOICE.enabled && bootOk) {
  log('Connecting you to ' + AGENT_NAME + '…', 'system');
  autoStartTimer = setTimeout(function () { autoStartTimer = null; startCall().catch(function () {}); }, 250);
  // Some browsers gate playback until the first gesture. The first tap anywhere
  // resumes audio and, if the auto-start was blocked, (re)starts the call.
  var _unlock = function () {
    playbackBlocked = false;
    try { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) {}
    try { if (remoteAudio.play) remoteAudio.play().catch(function () {}); } catch (e) {}
    // Only restart if the call never got going. 'idle' alone is ambiguous -- it
    // is also the state after a call ends -- so without everConnected the caller's
    // first tap after a finished call would silently re-dial.
    if (!everConnected && (state === 'error' || state === 'idle' || !state)) { startCall().catch(function () {}); }
    else { statusEl.textContent = STATUS[state] || ''; }
  };
  window.addEventListener('pointerdown', _unlock, { once: true });
  window.addEventListener('keydown', _unlock, { once: true });
}

window.addEventListener('beforeunload', function () {
  try { if (pc) sendSignal('hangup', { reason: 'page close' }); } catch (e) {}
});
</script>
</body>
</html>`;
}

// GET /call/:companyId — public animated voice agent call page (NO auth)
app.get("/call/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  // A company id is a slug. A charset whitelist is what makes it safe to
  // interpolate into the page at all -- into HTML and into the inline script.
  if (!companyId || !/^[A-Za-z0-9._-]{1,64}$/.test(companyId) || companyId.includes("..")) {
    return reply.code(400).send("invalid companyId");
  }

  let companyName = "Helix Agent";
  let tagline = "Talk to our AI voice agent";

  // Try to load card for company branding — also scan data/cards/ by organizationId
  // for directory companies that have no card.json in HELIX_COMPANIES
  let cardPath = await findCard(companyId);
  if (!cardPath) {
    const files = await fs.readdir(CARDS).catch(() => [] as string[]);
    for (const f of files) {
      try {
        const raw = JSON.parse(await fs.readFile(path.join(CARDS, f), "utf8"));
        if (raw?.organizationId === companyId || raw?.organization_id === companyId) {
          cardPath = path.join(CARDS, f);
          break;
        }
      } catch { /* skip malformed */ }
    }
  }
  let cardDetails: { hours?: string; phone?: string; offerings?: string[]; accent?: string } = {};
  if (cardPath) {
    try {
      const card = JSON.parse(await fs.readFile(cardPath, "utf8"));
      companyName = card?.identity?.name ?? card?.name?.value ?? companyName;
      tagline = card?.identity?.tagline ?? card?.tagline ?? tagline;
      cardDetails = {
        hours: card?.operations?.hours ?? "",
        phone: card?.identity?.phone ?? "",
        offerings: Array.isArray(card?.offerings)
          ? card.offerings.map((o: { name?: string }) => o?.name).filter((n: unknown): n is string => typeof n === "string" && n.length > 0)
          : [],
        accent: card?.visual?.colors?.[0]?.hex ?? "",
      };
    } catch {
      // fall through to defaults
    }
  }

  // The business's voice endpoint is addressed by npub, not by slug. Only the
  // public half leaves the server, so the page can call the agent but cannot
  // impersonate it.
  const ident = await readVoiceIdentity(companyId);
  const voice = {
    enabled: Boolean(ident?.npub),
    npub: ident?.npub ?? "",
    relays: await readVoiceRelays(companyId),
  };

  const html = buildCallPageHtml({
    companyId,
    companyName,
    tagline,
    agentName: "Helix AI",
    voice,
    turnCredsUrl: process.env.HELIX_TURN_CREDS_PATH || "/turn-creds",
    card: cardDetails,
  });

  return reply
    .code(200)
    .header("Content-Type", "text/html; charset=utf-8")
    .send(html);
});

// In-memory store for public call page sessions (not metered, keyed by sessionId)
const callSessionStore = new Map<string, { companyId: string; history: string[]; createdAt: number }>();

// POST /call-session/:companyId — create a lightweight public call session
app.post("/call-session/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  if (!companyId) return reply.code(400).send({ ok: false, error: "companyId required" });

  const sessionId = `call-${companyId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  callSessionStore.set(sessionId, { companyId, history: [], createdAt: Date.now() });

  // Prune sessions older than 2 hours to avoid unbounded growth
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, s] of callSessionStore) {
    if (s.createdAt < cutoff) callSessionStore.delete(id);
  }

  return reply.code(200).send({ ok: true, sessionId });
});

// POST /call-message/:companyId — public: a visitor talks to the business's agent.
//
// UNAUTHENTICATED and LLM-backed, so it is the platform's own spend at risk, not
// the company's — nothing deducts credits here. It shipped with no limiter and no
// length cap at all, which made it a free, unmetered LLM proxy on the account key.
app.post("/call-message/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const body = (req.body ?? {}) as { sessionId?: string; message?: string };

  // FIRST, before any parsing, lookup or LLM work: the limiter must count every
  // attempt, not only well-formed ones. A limiter that runs after validation is a
  // limiter an abuser steps around by sending junk.
  const ip = (req.headers["x-real-ip"] as string) || req.ip || "unknown";
  if (!anonLlmAllow(ip)) {
    return reply.code(429).send({ ok: false, error: "too many messages — please slow down" });
  }

  if (!body.message) return reply.code(400).send({ ok: false, error: "message required" });
  if (String(body.message).length > 1000)
    return reply.code(400).send({ ok: false, error: "message too long (1000 chars max)" });

  const cardPath = await findCard(companyId);
  let agentContext = `You are a helpful AI assistant for a business. Be friendly, concise, and helpful.`;
  if (cardPath) {
    try {
      const card = JSON.parse(await fs.readFile(cardPath, "utf8"));
      const name = card?.identity?.name ?? "this business";
      const pitch = card?.identity?.elevatorPitch ?? "";
      agentContext = `You are Helix AI, the virtual assistant for ${name}. ${pitch} Be friendly, helpful, and concise. Answer questions about the business and help customers.`;
    } catch { /* use default */ }
  }

  try {
    const res = await aiGateway.call({
      prompt: body.message,
      systemPrompt: agentContext,
      jsonMode: false,
      temperature: 0.7,
      maxTokens: 300,
      orgId: companyId,
      operationType: "call_message",
    });
    return reply.code(200).send({ ok: true, reply: res.text.trim() });
  } catch {
    return reply.code(200).send({ ok: true, reply: "I'm here to help! Could you please repeat that?" });
  }
});

// POST /api/contact/:companyId — receive and persist contact form submissions
app.post("/contact/:companyId", async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  if (!companyId || companyId.includes("/") || companyId.includes(".."))
    return reply.code(400).send({ ok: false, error: "invalid companyId" });

  const body = (req.body ?? {}) as { name?: string; email?: string; phone?: string; message?: string };
  const submission = {
    id: `contact-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    receivedAt: new Date().toISOString(),
    name: String(body.name ?? "").slice(0, 200),
    email: String(body.email ?? "").slice(0, 200),
    phone: String(body.phone ?? "").slice(0, 50),
    message: String(body.message ?? "").slice(0, 2000),
  };

  try {
    const dir = path.join(HELIX_COMPANIES, companyId, "contacts");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${submission.id}.json`), JSON.stringify(submission, null, 2));
    app.log.info({ contact: { companyId, id: submission.id, email: submission.email } }, "contact form saved");
  } catch (e) {
    app.log.warn({ err: e }, "contact form: failed to persist submission");
  }

  return reply.code(200).send({ ok: true, message: "Thank you! We'll be in touch soon." });
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
