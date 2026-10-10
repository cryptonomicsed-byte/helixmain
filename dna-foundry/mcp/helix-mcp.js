#!/usr/bin/env node
/**
 * helix-mcp — the HelixMain platform MCP surface.
 *
 * Every capability the platform owns is exposed as an MCP tool so any agent
 * (Claude Code, opencode, the onboarding agent, the dashboard) can drive the
 * platform over ONE contract instead of screen-scraping the dashboard. This is
 * the agent-native half the audit found missing: the DNA foundry declared 7
 * `dna.*` tools but nothing served them, and voice/content/leads/site were not
 * invocable at all.
 *
 * Each tool is a THIN client of the local API (dna-foundry/api, 127.0.0.1:3101).
 * The API owns the work — extraction, metering, approval handoff, generation.
 * This server owns only the agent-facing shape. It decides nothing, duplicates
 * no logic, and returns the API's answer verbatim (status + body). Nothing here
 * fabricates a result: if the API is down, the tool reports it as an error.
 *
 * Tools:
 *   voice.call        one turn of a company's card-grounded voice agent
 *   content.generate  campaign PRD -> channel assets for a company
 *   leads.discover    hunt leads (Apollo text filters, or OSM/Overpass by GPS)
 *   site.publish      generate the company's landing site from its card
 *   billing.status    credits/plan/usage + tier&pack prices; action=checkout creates
 *                     a real Stripe session (the only write; still mints no credits)
 *   analytics.query   a company's analytics for a period (READ-ONLY — no charge)
 *   crm.manage        list/summary/by_stage/proposals (reads) plus propose->confirm
 *                     for contacts — create/update only RECORD a proposal, nothing
 *                     is written until an owner confirms
 *
 *   dna.extract         run the extractor swarm against a URL -> a DNA card
 *   dna.get             fetch a card by id
 *   dna.compile         compile a card into prompt/policy/allowlist/rag
 *   dna.diff            field-level diff between two card versions
 *   dna.propose_change  propose a governed card mutation
 *   dna.decide_proposal approve/deny a pending proposal
 *   dna.sense           tiered re-crawl (change detection -> targeted extraction)
 *
 * TWO WORLDS, TWO TRUST LEVELS — do not conflate them:
 *   The API tools (voice/content/leads/site/billing/analytics/crm) are thin clients
 *   of the platform API and carry a per-company key; they resolve
 *   /etc/helix/companies/<slug>. The dna.* tools run the FOUNDRY's own swarm and
 *   compiler locally (handlers.py) against dna-foundry/cards + api/data/cards, and
 *   carry no tenant key. A foundry card is not a platform company.
 *
 * Cost note: only voice.call, content.generate, leads.discover and site.publish
 * spend credits, because only their API routes call deductCredits. The read tools
 * above wrap routes that do not charge, so they charge nothing — that is the
 * API's behaviour passed through, not a decision made here. dna.* never reach the
 * API, so they cost nothing either. Credits enter ONLY through Stripe's webhook
 * after a real payment; no tool here can mint them, and the API's top-up route is
 * deliberately not exposed.
 *
 * Write note: the only tools that change platform state are site.publish (a real
 * build), billing.status action=checkout (a Stripe session), and crm.manage's
 * propose->confirm pair. crm.manage create/update are PROPOSALS — they record an
 * intent and return 202; an owner credential applies it via confirm/deny.
 *
 * Env:
 *   HELIX_API_URL   default http://127.0.0.1:3101
 *   HELIX_API_KEY   optional override credential. When unset, the server reads
 *                   the target company's own company-level key from
 *                   <HELIX_CARD_ROOT>/<companyId>/api-keys.json — the presented
 *                   key IS the tenant identity, so we never hard-code one.
 *   HELIX_OWNER_KEY optional override for owner-gated routes (crm.manage confirm/
 *                   deny). When unset, the owner key is read from the same file.
 *
 * Transport: stdio MCP, newline-delimited JSON-RPC 2.0.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const API_URL = (process.env.HELIX_API_URL || "http://127.0.0.1:3101").replace(/\/+$/, "");
const KEY_ROOT = process.env.HELIX_CARD_ROOT || "/etc/helix/companies";
const ENV_KEY = process.env.HELIX_API_KEY || "";
const ENV_OWNER_KEY = process.env.HELIX_OWNER_KEY || "";
const SERVER_NAME = "helix-mcp";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2024-11-05";

/** Read the target company's own key file. Values are NEVER hard-coded here. */
function keyRec(companyId) {
  if (!companyId) return null;
  try {
    return JSON.parse(
      fs.readFileSync(path.join(KEY_ROOT, String(companyId), "api-keys.json"), "utf8"));
  } catch {
    return null; // no key on disk — the API will answer 401, which is honest
  }
}

/** Resolve the credential to present for a call against `companyId`.
 *
 *  All business routes are authenticated (hardening #1). The company-level key
 *  lives in the same 0600 store the API issues from, so a machine caller reads
 *  the tenant's own key rather than carrying a copy. HELIX_API_KEY overrides. */
function keyFor(companyId) {
  if (ENV_KEY) return ENV_KEY;
  const rec = keyRec(companyId);
  return rec && typeof rec.company === "string" && rec.company ? rec.company : null;
}

/** The owner key for `companyId` — for owner-gated routes (proposal confirm/deny).
 *  requireOwner reads `x-owner-key`; the company key cannot stand in for it. */
function ownerKeyFor(companyId) {
  if (ENV_OWNER_KEY) return ENV_OWNER_KEY;
  const rec = keyRec(companyId);
  return rec && typeof rec.owner === "string" && rec.owner ? rec.owner : null;
}

const ROLES = ["front-desk", "sales", "content", "owner-manager"];

const TOOLS = [
  {
    name: "voice.call",
    description:
      "Run one turn of a company's card-grounded voice agent: send what the caller " +
      "said, get the agent's reply. The agent is compiled from the company's DNA card " +
      "(identity, voice, policies) — it answers only from that card. This is the same " +
      "turn the AI front desk runs; it does not place a PSTN call.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "Company/card slug, e.g. demo-barber" },
        message: { type: "string", description: "What the caller said" },
        role: {
          type: "string",
          enum: ROLES,
          description: "Which agent role answers (default front-desk)",
        },
        cardId: { type: "string", description: "Card id, if it differs from companyId" },
      },
      required: ["companyId", "message"],
    },
  },
  {
    name: "content.generate",
    description:
      "Generate a marketing campaign for a company, grounded in its card. Supply " +
      "either a ready `prd`, or a `goal` plus non-empty `channels[]` (the tool builds " +
      "the PRD first). Returns the generated per-channel assets. This costs credits " +
      "(PRD + asset generation).",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "Company slug (metering + card lookup)" },
        cardId: { type: "string", description: "Card id, if it differs from companyId" },
        goal: { type: "string", description: "Campaign goal, e.g. 'fill weekday lunch slots'" },
        channels: {
          type: "array",
          items: { type: "string" },
          description: "Channels to generate for, e.g. ['instagram','email']",
        },
        prd: { type: "object", description: "A ready PRD — skips PRD generation when supplied" },
      },
      required: ["companyId"],
    },
  },
  {
    name: "leads.discover",
    description:
      "Hunt leads for a company. With lat/lng, uses the OSM/Overpass path (real " +
      "nearby businesses); with text filters (industry/location/keywords), uses the " +
      "Apollo path. Returns the discovered leads. Costs credits per hunt.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "Company slug (metering + card lookup)" },
        cardId: { type: "string", description: "Card id, if it differs from companyId" },
        industry: { type: "string", description: "Target industry, e.g. 'barbershop'" },
        location: { type: "string", description: "Target location text, e.g. 'Parlin, NJ'" },
        size: { type: "string", description: "Company size band, if the backend supports it" },
        keywords: { type: "array", items: { type: "string" }, description: "Extra keywords" },
        lat: { type: "number", description: "Latitude — switches to the OSM path" },
        lng: { type: "number", description: "Longitude — switches to the OSM path" },
        radiusMeters: { type: "number", description: "OSM search radius in meters" },
      },
      required: ["companyId"],
    },
  },
  {
    name: "site.publish",
    description:
      "Publish the company's landing page to the public site and return its real " +
      "URL (https://helixmain.duckdns.org/b/{companyId}/). The page is built " +
      "deterministically from the card — the card stays the source of truth — and " +
      "deployed to the web root. Credits are charged only after a successful " +
      "publish, so a failed build costs nothing.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "Company slug whose card drives the site" },
      },
      required: ["companyId"],
    },
  },
  {
    name: "billing.status",
    description:
      "A company's billing surface. `action=status` (default) is READ-ONLY: credit " +
      "balance + tier, latest plan, usage history — it spends no credits. " +
      "`action=config` lists tier/pack prices. `action=checkout` CREATES a real Stripe " +
      "Checkout session for a `priceId` and returns the API's checkoutUrl verbatim " +
      "(the one write here); `action=portal` opens the customer portal. No action can " +
      "mint credits — credits are added ONLY by Stripe's webhook after a real payment, " +
      "so the API's top-up route is deliberately not exposed.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "Company slug" },
        action: {
          type: "string",
          enum: ["status", "config", "checkout", "portal"],
          description: "status (default) | config | checkout | portal",
        },
        priceId: {
          type: "string",
          description: "Stripe price id — required for action=checkout (see action=config)",
        },
        from: { type: "string", description: "Optional ISO date — usage history lower bound" },
        to: { type: "string", description: "Optional ISO date — usage history upper bound" },
      },
      required: ["companyId"],
    },
  },
  {
    name: "analytics.query",
    description:
      "Read a company's analytics for a period. READ-ONLY — spends no credits. With " +
      "`enriched`, adds campaign/lead roll-ups; note the API computes the enriched " +
      "lead totals system-wide (all companies), so treat those two numbers as platform " +
      "totals, not this company's.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "Company slug" },
        period: {
          type: "string",
          enum: ["day", "week", "month"],
          description: "Reporting period (default week)",
        },
        enriched: { type: "boolean", description: "Include the enriched roll-up" },
      },
      required: ["companyId"],
    },
  },
  {
    name: "crm.manage",
    description:
      "Work a company's CRM. Reads (list/summary/by_stage) and `proposals` are free. " +
      "`create`/`update` do NOT write — they RECORD a pending proposal (202) and change " +
      "nothing; `confirm`/`deny` APPLY or discard a proposal and require the owner " +
      "credential. This is propose → confirm, the same two-step as card edits: an agent " +
      "drafts, an owner applies. (The CRM store is in-memory, so a proposal can outlive " +
      "the contact it targets — confirming a vanished contact is an honest 404.)",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "Company slug" },
        action: {
          type: "string",
          enum: ["list", "summary", "by_stage", "create", "update", "proposals", "confirm", "deny"],
          description: "What to do (default list)",
        },
        stage: { type: "string", description: "Pipeline stage — for action=by_stage" },
        contactId: { type: "string", description: "Contact id — for action=update" },
        contact: { type: "object", description: "Contact fields — for action=create" },
        note: { type: "string", description: "Append a note — for action=update" },
        updates: { type: "object", description: "Field updates — for action=update" },
        cardId: { type: "string", description: "Card to validate a stage move — for action=update" },
        proposalId: { type: "string", description: "Proposal id (crp_…) — for action=confirm|deny" },
        summary: { type: "string", description: "Human summary recorded on the proposal" },
      },
      required: ["companyId"],
    },
  },

  // ── the seven DNA foundry tools. Names + schemas mirror dna-foundry/mcp/tools.json
  //    exactly; the implementation is the existing handlers.py (see dnaRun). ──────
  {
    name: "dna.extract",
    description:
      "Run the extractor swarm against a business URL (or file:// fixture) and emit a " +
      "validated, versioned DNA card. Drives the foundry's own swarm.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Business website URL, or file:// path for fixtures" },
        organization_id: { type: "string", description: "Organization contract id, e.g. org_demo0001" },
      },
      required: ["url"],
    },
  },
  {
    name: "dna.get",
    description: "Fetch a DNA card by id from the foundry card tree.",
    inputSchema: {
      type: "object",
      properties: { card_id: { type: "string", description: "Card id, e.g. dna_80a09ce4" } },
      required: ["card_id"],
    },
  },
  {
    name: "dna.compile",
    description:
      "Deterministically compile a DNA card into system prompt, policy seed, tool " +
      "allowlist, and RAG manifest.",
    inputSchema: {
      type: "object",
      properties: { card_id: { type: "string", description: "Card id to compile" } },
      required: ["card_id"],
    },
  },
  {
    name: "dna.diff",
    description: "Field-level diff between two card versions.",
    inputSchema: {
      type: "object",
      properties: {
        card_a: { type: "string", description: "Older card id" },
        card_b: { type: "string", description: "Newer card id" },
      },
      required: ["card_a", "card_b"],
    },
  },
  {
    name: "dna.propose_change",
    description:
      "Propose a governed mutation to a DNA card (field, old, new, evidence, confidence). " +
      "Low-risk factual updates mint a new version with hash chain + changelog + receipt; " +
      "identity/voice/policy/competitor changes await approval.",
    inputSchema: {
      type: "object",
      properties: {
        card_id: { type: "string", description: "Card id, e.g. dna_80a09ce4" },
        field: { type: "string", description: "Dotted field path, e.g. operations.hours" },
        old: { description: "Current value the proposer saw" },
        new: { description: "Proposed new value" },
        evidence: { type: "string", description: "Source for the change, e.g. google_listing" },
        confidence: { type: "number", description: "0-1, default 0.7" },
      },
      required: ["card_id", "field", "old", "new"],
    },
  },
  {
    name: "dna.decide_proposal",
    description: "Approve or deny a pending proposal. Approval mints the new card version.",
    inputSchema: {
      type: "object",
      properties: {
        proposal_id: { type: "string" },
        decision: { type: "string", enum: ["approve", "deny"] },
        decided_by: { type: "string", description: "default: operator" },
      },
      required: ["proposal_id", "decision"],
    },
  },
  {
    name: "dna.sense",
    description:
      "Tiered, cost-efficient re-crawl: Tier-0 change detection, Tier-1 heuristic triage, " +
      "Tier-2 targeted extraction emitting dna.propose_change proposals, Tier-3 full " +
      "re-extract on redesign. Adaptive per-site cadence from the volatility sidecar.",
    inputSchema: {
      type: "object",
      properties: {
        organization_id: { type: "string" },
        force: { type: "boolean", description: "ignore adaptive cadence" },
      },
      required: ["organization_id"],
    },
  },
];

/** POST a JSON body to the API and normalise the answer. Never throws on a
 *  non-2xx — a 402 (out of credits) or 404 (no card) is a legitimate answer,
 *  not a transport failure. Only an unreachable API is an error. */
async function api(pathname, body, opts) {
  const { method = "POST", companyId = null, owner = false } = opts || {};
  const url = API_URL + pathname;
  const headers = { "content-type": "application/json" };
  // The tenant key comes from the path/args for reads (which carry no body) and
  // from the body for writes. Either way it is the target company's OWN key.
  const tenant = companyId || (body && body.companyId);
  const key = keyFor(tenant);
  if (key) headers["x-api-key"] = key;
  // Owner-gated routes (proposal confirm/deny) need BOTH: requireAuth reads
  // x-api-key, requireOwner reads x-owner-key. Both come from the same tenant's
  // own key file — this tool never holds a shared or elevated credential.
  if (owner) {
    const ok = ownerKeyFor(tenant);
    if (ok) headers["x-owner-key"] = ok;
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
  } catch (e) {
    return { httpStatus: 0, body: { ok: false, error: `API unreachable at ${url}: ${e.message}` } };
  }
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 4000) };
  }
  return { httpStatus: res.status, body: parsed };
}

/**
 * The seven `dna.*` tools predate the platform API. Their implementation already
 * exists as `dna-foundry/mcp/handlers.py` — a dispatcher that drives the foundry's
 * own swarm + compiler. Nothing served it, so those tools "existed but went
 * nowhere". We SERVE that implementation rather than re-implement it against the
 * API: there is no API route for dna.sense, and fabricating one would be exactly
 * the fiction this is meant to remove.
 *
 * What this preserves, and you should know it:
 *   - dna.* operate on the FOUNDRY tree (dna-foundry/cards, api/data/cards) and run
 *     locally as the host user. The other tools are thin clients of the platform
 *     API and carry a tenant key, resolving /etc/helix/companies/<slug>.
 *   - So they are two different card WORLDS and two different trust levels. See README.
 *
 * Results are marked `local` so the caller sees no invented HTTP status.
 */
function dnaRun(tool, args) {
  const python = process.env.HELIX_PYTHON || "python3";
  const script = path.join(__dirname, "handlers.py");
  if (!fs.existsSync(script)) {
    return { local: true, body: { ok: false, error: `handlers.py not found at ${script}` } };
  }
  const r = spawnSync(python, [script, tool, JSON.stringify(args)], {
    encoding: "utf8",
    timeout: Number(process.env.HELIX_DNA_TIMEOUT_MS || 120000),
    maxBuffer: 8 * 1024 * 1024,
    cwd: __dirname,
  });
  const out = (r.stdout || "").trim();
  if (!out) {
    const why = r.error ? r.error.message : `exit ${r.status}`;
    const tail = r.stderr ? String(r.stderr).slice(-500) : "";
    return { local: true, body: { ok: false, error: `dna handler produced no output (${why})${tail ? `: ${tail}` : ""}` } };
  }
  try {
    return { local: true, body: JSON.parse(out) };
  } catch {
    return { local: true, body: { ok: true, output: out.slice(-4000) } };
  }
}

const HANDLERS = {
  "voice.call": (a) =>
    api("/agent/session", {
      companyId: a.companyId,
      cardId: a.cardId,
      role: a.role,
      message: a.message,
    }),

  "content.generate": async (a) => {
    let prd = a.prd;
    if (!prd) {
      if (!a.goal || !Array.isArray(a.channels) || a.channels.length === 0) {
        return {
          httpStatus: 0,
          body: {
            ok: false,
            error: "content.generate needs either `prd`, or `goal` + a non-empty `channels[]`",
          },
        };
      }
      const p = await api("/content/prd", {
        companyId: a.companyId,
        cardId: a.cardId ?? a.companyId,
        goal: a.goal,
        channels: a.channels,
      });
      if (p.httpStatus !== 200 || !p.body || !p.body.prd) return p;
      prd = p.body.prd;
    }
    const g = await api("/content/generate", {
      companyId: a.companyId,
      cardId: a.cardId ?? a.companyId,
      prd,
    });
    // Surface the PRD alongside the assets so the caller sees what was targeted.
    if (g.body && typeof g.body === "object" && !Array.isArray(g.body)) {
      g.body = { ...g.body, prd };
    }
    return g;
  },

  "leads.discover": (a) => {
    if (typeof a.lat === "number" && typeof a.lng === "number") {
      return api("/sales/hunt/gps", {
        companyId: a.companyId,
        lat: a.lat,
        lng: a.lng,
        industry: a.industry,
        radiusMeters: a.radiusMeters,
      });
    }
    return api("/sales/hunt", {
      companyId: a.companyId,
      cardId: a.cardId ?? a.companyId,
      filters: {
        industry: a.industry,
        location: a.location,
        size: a.size,
        keywords: a.keywords,
      },
    });
  },

  "site.publish": async (a) => {
    // The API now publishes via the Hugo pipeline and returns the real public
    // URL in `url`; we surface it verbatim rather than inventing a path.
    return api("/site/generate", { companyId: a.companyId });
  },

  // Compose the billing picture from the API's own endpoints. Each part is the
  // API's answer; nothing is derived here. None of these routes charge credits.
  "billing.status": async (a) => {
    const q = encodeURIComponent(a.companyId);
    const action = a.action || "status";

    if (action === "config") {
      // Tier + pack prices, straight from the API.
      return api("/billing/config", null, { method: "GET", companyId: a.companyId });
    }
    if (action === "portal") {
      return api(`/billing/portal/${q}`, null, { method: "GET", companyId: a.companyId });
    }
    if (action === "checkout") {
      if (!a.priceId) {
        return {
          httpStatus: 0,
          body: { ok: false, error: "action=checkout needs `priceId` (see action=config)" },
        };
      }
      // The one write in this tool: create a Stripe Checkout session. It adds NO
      // credits — only Stripe's webhook does that, after a real payment. We never
      // call the API's top-up route; that would be a money printer.
      return api(
        "/billing/checkout",
        { companyId: a.companyId, priceId: a.priceId },
        { companyId: a.companyId }
      );
    }
    if (action !== "status") {
      return { httpStatus: 0, body: { ok: false, error: `unknown action: ${action}` } };
    }

    const credits = await api(`/metering/${q}`, null, { method: "GET", companyId: a.companyId });
    if (credits.httpStatus !== 200) return credits; // 401/404 is the honest answer
    const plan = await api(`/plan/${q}`, null, { method: "GET", companyId: a.companyId });
    const qs = [];
    if (a.from) qs.push(`from=${encodeURIComponent(a.from)}`);
    if (a.to) qs.push(`to=${encodeURIComponent(a.to)}`);
    const history = await api(
      `/metering/${q}/history${qs.length ? `?${qs.join("&")}` : ""}`,
      null,
      { method: "GET", companyId: a.companyId }
    );
    const entries =
      history.httpStatus === 200 && history.body && Array.isArray(history.body.entries)
        ? history.body.entries
        : history.httpStatus === 200
          ? history.body
          : null;
    return {
      httpStatus: 200,
      body: {
        ok: true,
        companyId: a.companyId,
        credits: credits.body,
        // A 404 on the plan means "none generated yet" — a real answer, not an error.
        plan: plan.httpStatus === 200 ? plan.body : null,
        plan_http_status: plan.httpStatus,
        history: entries,
      },
    };
  },

  "analytics.query": (a) => {
    const period = a.period || "week";
    if (!["day", "week", "month"].includes(period)) {
      return { httpStatus: 0, body: { ok: false, error: "period must be day|week|month" } };
    }
    const q = encodeURIComponent(a.companyId);
    const path = a.enriched
      ? `/analytics/${q}/enriched?period=${period}`
      : `/analytics/${q}?period=${period}`;
    return api(path, null, { method: "GET", companyId: a.companyId });
  },

  "crm.manage": (a) => {
    const q = encodeURIComponent(a.companyId);
    switch (a.action || "list") {
      case "list":
        return api(`/crm/contacts/${q}`, null, { method: "GET", companyId: a.companyId });
      case "summary":
        return api(`/crm/summary/${q}`, null, { method: "GET", companyId: a.companyId });
      case "by_stage":
        if (!a.stage) {
          return { httpStatus: 0, body: { ok: false, error: "action=by_stage needs `stage`" } };
        }
        return api(`/crm/contacts/${q}/stage/${encodeURIComponent(a.stage)}`, null, {
          method: "GET",
          companyId: a.companyId,
        });
      case "proposals":
        return api(`/crm/proposals/${q}`, null, { method: "GET", companyId: a.companyId });
      case "create":
        if (!a.contact || typeof a.contact !== "object") {
          return { httpStatus: 0, body: { ok: false, error: "action=create needs `contact`" } };
        }
        // PROPOSE: records a pending proposal (202). No contact exists yet —
        // action=confirm applies it.
        return api(
          "/crm/contacts",
          { companyId: a.companyId, contact: a.contact, summary: a.summary },
          { companyId: a.companyId }
        );
      case "update": {
        if (!a.contactId) {
          return { httpStatus: 0, body: { ok: false, error: "action=update needs `contactId`" } };
        }
        if (!a.stage && !a.note && !a.updates) {
          return { httpStatus: 0, body: { ok: false, error: "action=update needs one of stage/note/updates" } };
        }
        const body = { companyId: a.companyId };
        if (a.stage) body.stage = a.stage;
        if (a.note) body.note = a.note;
        if (a.updates) body.updates = a.updates;
        if (a.cardId) body.cardId = a.cardId;
        if (a.summary) body.summary = a.summary;
        // PROPOSE: records a pending proposal (202), mutating nothing. companyId
        // rides along so the API records it under the right tenant.
        // NB: this route is PATCH — the default verb here is POST, which 404s.
        return api(`/crm/contacts/${encodeURIComponent(a.contactId)}`, body, {
          method: "PATCH",
          companyId: a.companyId,
        });
      }
      case "confirm": {
        if (!a.proposalId) {
          return { httpStatus: 0, body: { ok: false, error: "action=confirm needs `proposalId`" } };
        }
        // APPLY: owner credential required — propose is company-level, apply is not.
        return api(
          `/crm/proposals/${encodeURIComponent(a.proposalId)}/confirm`,
          {},
          { method: "POST", companyId: a.companyId, owner: true }
        );
      }
      case "deny": {
        if (!a.proposalId) {
          return { httpStatus: 0, body: { ok: false, error: "action=deny needs `proposalId`" } };
        }
        return api(
          `/crm/proposals/${encodeURIComponent(a.proposalId)}/deny`,
          {},
          { method: "POST", companyId: a.companyId, owner: true }
        );
      }
      default:
        return { httpStatus: 0, body: { ok: false, error: `unknown action: ${a.action}` } };
    }
  },

  // ── DNA foundry tools: dispatch to the existing handlers.py (see dnaRun) ───
  "dna.extract": (a) => dnaRun("dna.extract", { url: a.url, organization_id: a.organization_id }),
  "dna.get": (a) => dnaRun("dna.get", { card_id: a.card_id }),
  "dna.compile": (a) => dnaRun("dna.compile", { card_id: a.card_id }),
  "dna.diff": (a) => dnaRun("dna.diff", { card_a: a.card_a, card_b: a.card_b }),
  "dna.propose_change": (a) =>
    dnaRun("dna.propose_change", {
      card_id: a.card_id,
      field: a.field,
      old: a.old,
      new: a.new,
      evidence: a.evidence,
      confidence: a.confidence,
    }),
  "dna.decide_proposal": (a) =>
    dnaRun("dna.decide_proposal", {
      proposal_id: a.proposal_id,
      decision: a.decision,
      decided_by: a.decided_by,
    }),
  "dna.sense": (a) =>
    dnaRun("dna.sense", { organization_id: a.organization_id, force: a.force }),
};

function rpcResult(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function rpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications take no reply

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: TOOLS });

    case "tools/call": {
      const name = params?.name;
      const handler = HANDLERS[name];
      if (!handler) return rpcError(id, -32602, `unknown tool: ${name}`);

      const missing = (TOOLS.find((t) => t.name === name).inputSchema.required || []).filter(
        (k) => params?.arguments?.[k] === undefined
      );
      if (missing.length) {
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify({ error: `missing required: ${missing.join(", ")}` }) }],
          isError: true,
        });
      }

      const out = await handler(params?.arguments || {});
      // Local tools (dna.*) never touch HTTP, so they carry no http_status and we
      // do not invent one. Their success is the handler's own `ok`.
      // NB: any 2xx is success — a proposal is a 202 ("recorded, not applied") and
      // a created record is a 201. Only treating 200 as success made a legitimate
      // 2xx look like an error. The exact status still travels in http_status.
      const ok = out.local
        ? !!out.body && out.body.ok !== false
        : out.httpStatus >= 200 && out.httpStatus < 300 && (!out.body || out.body.ok !== false);
      const payload = out.local
        ? (Array.isArray(out.body)
            ? { tool: name, result: out.body }
            : { tool: name, ...(out.body ?? {}) })
        : (Array.isArray(out.body)
            ? { tool: name, http_status: out.httpStatus, result: out.body }
            : { tool: name, http_status: out.httpStatus, ...(out.body ?? {}) });
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        isError: !ok,
      });
    }

    default:
      if (id === undefined || id === null) return null; // unknown notification
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

// ── stdio loop: newline-delimited JSON-RPC ───────────────────────────────────
let buf = "";
let inflight = 0;
let stdinEnded = false;

/** Exit only once every in-flight request has answered and stdout has flushed.
 *  A bare process.exit() on stdin end drops a pending tools/call — the exact
 *  hang a real client sees when it half-closes the pipe right after requesting. */
function exitWhenDrained() {
  if (!stdinEnded || inflight > 0) return;
  process.stdout.write("", () => process.exit(0));
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(rpcError(null, -32700, "parse error") + "\n");
      continue;
    }
    inflight++;
    handle(msg)
      .then((out) => {
        if (out) process.stdout.write(out + "\n");
      })
      .catch((e) => {
        process.stdout.write(rpcError(msg.id ?? null, -32603, String(e.message || e)) + "\n");
      })
      .finally(() => {
        inflight--;
        exitWhenDrained();
      });
  }
});
process.stdin.on("end", () => {
  stdinEnded = true;
  exitWhenDrained();
});

if (process.env.HELIX_MCP_SELFTEST) {
  process.stderr.write(
    `helix-mcp: api=${API_URL} tools=[${TOOLS.map((t) => t.name).join(", ")}]\n`
  );
}
