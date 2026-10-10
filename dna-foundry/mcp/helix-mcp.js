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
 *
 * Env:
 *   HELIX_API_URL   default http://127.0.0.1:3101
 *   HELIX_API_KEY   optional override credential. When unset, the server reads
 *                   the target company's own company-level key from
 *                   <HELIX_CARD_ROOT>/<companyId>/api-keys.json — the presented
 *                   key IS the tenant identity, so we never hard-code one.
 *
 * Transport: stdio MCP, newline-delimited JSON-RPC 2.0.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const API_URL = (process.env.HELIX_API_URL || "http://127.0.0.1:3101").replace(/\/+$/, "");
const KEY_ROOT = process.env.HELIX_CARD_ROOT || "/etc/helix/companies";
const ENV_KEY = process.env.HELIX_API_KEY || "";
const SERVER_NAME = "helix-mcp";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2024-11-05";

/** Resolve the credential to present for a call against `companyId`.
 *
 *  All business routes are authenticated (hardening #1). The company-level key
 *  lives in the same 0600 store the API issues from, so a machine caller reads
 *  the tenant's own key rather than carrying a copy. HELIX_API_KEY overrides. */
function keyFor(companyId) {
  if (ENV_KEY) return ENV_KEY;
  if (!companyId) return null;
  try {
    const rec = JSON.parse(
      fs.readFileSync(path.join(KEY_ROOT, String(companyId), "api-keys.json"), "utf8"));
    return typeof rec.company === "string" && rec.company ? rec.company : null;
  } catch {
    return null; // no key on disk — the API will answer 401, which is honest
  }
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
];

/** POST a JSON body to the API and normalise the answer. Never throws on a
 *  non-2xx — a 402 (out of credits) or 404 (no card) is a legitimate answer,
 *  not a transport failure. Only an unreachable API is an error. */
async function api(pathname, body) {
  const url = API_URL + pathname;
  const headers = { "content-type": "application/json" };
  const key = keyFor(body && body.companyId);
  if (key) headers["x-api-key"] = key;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
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
      const ok = out.httpStatus === 200 && (!out.body || out.body.ok !== false);
      return rpcResult(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({ tool: name, http_status: out.httpStatus, ...(out.body ?? {}) }),
          },
        ],
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
