"use strict";
/**
 * helix-mcp.test.js — proves the MCP surface, hermetically.
 *
 * A stub API records what the tools POST, and a real stdio JSON-RPC session
 * drives the real server. No network, no live API, no credits spent. What it
 * pins: the tools exist, the argument->endpoint mapping is exact, required-arg
 * and API-error answers surface as isError, and nothing is invented when the
 * API is missing.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");

/** Boot a stub API + the real MCP server wired at it. Returns a driver. */
async function setup(replies = {}, extraEnv = {}) {
  const calls = [];
  const api = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        /* leave null */
      }
      calls.push({ path: req.url, body: parsed, headers: req.headers, method: req.method });
      const r = replies[req.url] ?? { status: 200, body: { ok: true } };
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise((res) => api.listen(0, "127.0.0.1", res));
  const apiUrl = `http://127.0.0.1:${api.address().port}`;

  const proc = spawn(process.execPath, [path.join(__dirname, "helix-mcp.js")], {
    env: { ...process.env, HELIX_API_URL: apiUrl, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = [];
  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const next = pending.shift();
      if (next) next(msg);
    }
  });

  let seq = 0;
  const rpc = (method, params) => {
    const id = ++seq;
    const p = new Promise((res) => pending.push(res));
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  };

  const close = () =>
    new Promise((res) => {
      proc.stdin.end();
      proc.on("exit", () => api.close(() => res()));
    });

  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  return { rpc, calls, close, apiUrl };
}

test("tools/list exposes the platform, foundry, and hierarchy tools", async () => {
  const { rpc, close } = await setup();
  try {
    const { result } = await rpc("tools/list", {});
    assert.deepEqual(
      result.tools.map((t) => t.name).sort(),
      [
        "analytics_query",
        "billing_status",
        "content_generate",
        "crm_manage",
        "directory_search",
        "dna_compile",
        "dna_decide_proposal",
        "dna_diff",
        "dna_extract",
        "dna_get",
        "dna_propose_change",
        "dna_sense",
        "leads_discover",
        "site_publish",
        "voice_call",
      ]
    );
    for (const t of result.tools) {
      assert.equal(t.inputSchema.type, "object");
      assert.ok(Array.isArray(t.inputSchema.required));
    }
  } finally {
    await close();
  }
});

test("voice_call posts the message to /agent/session and returns the reply", async () => {
  const { rpc, calls, close } = await setup({
    "/agent/session": { status: 200, body: { ok: true, reply: "We open at 9." } },
  });
  try {
    const { result } = await rpc("tools/call", {
      name: "voice_call",
      arguments: { companyId: "demo-barber", message: "When do you open?" },
    });
    assert.equal(result.isError, false);
    assert.deepEqual(calls.map((c) => ({ path: c.path, body: c.body })), [
      { path: "/agent/session", body: { companyId: "demo-barber", message: "When do you open?" } },
    ]);
    assert.match(result.content[0].text, /We open at 9\./);
  } finally {
    await close();
  }
});

test("content_generate builds a PRD then assets when given goal + channels", async () => {
  const { rpc, calls, close } = await setup({
    "/content/prd": { status: 200, body: { ok: true, prd: { id: "prd_1", goal: "lunch" } } },
    "/content/generate": { status: 200, body: { ok: true, assets: [{ id: "a1" }] } },
  });
  try {
    const { result } = await rpc("tools/call", {
      name: "content_generate",
      arguments: { companyId: "cafe", goal: "fill lunch", channels: ["instagram", "email"] },
    });
    assert.equal(result.isError, false);
    assert.deepEqual(calls.map((c) => c.path), ["/content/prd", "/content/generate"]);
    // the real PRD from step 1 is what gets sent to step 2
    assert.deepEqual(calls[1].body.prd, { id: "prd_1", goal: "lunch" });
    assert.match(result.content[0].text, /"assets"/);
  } finally {
    await close();
  }
});

test("content_generate with a ready prd skips PRD generation", async () => {
  const { rpc, calls, close } = await setup({
    "/content/generate": { status: 200, body: { ok: true, assets: [] } },
  });
  try {
    const { result } = await rpc("tools/call", {
      name: "content_generate",
      arguments: { companyId: "cafe", prd: { id: "prd_x" } },
    });
    assert.equal(result.isError, false);
    assert.deepEqual(calls.map((c) => c.path), ["/content/generate"]);
  } finally {
    await close();
  }
});

test("content_generate with neither prd nor goal+channels fails without calling the API", async () => {
  const { rpc, calls, close } = await setup();
  try {
    const { result } = await rpc("tools/call", {
      name: "content_generate",
      arguments: { companyId: "cafe" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /needs either/);
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test("leads_discover routes by lat/lng: GPS path when present, Apollo path otherwise", async () => {
  const { rpc, calls, close } = await setup({
    "/sales/hunt/gps": { status: 200, body: { ok: true, leads: [{ id: "l1" }] } },
    "/sales/hunt": { status: 200, body: { ok: true, leads: [] } },
  });
  try {
    await rpc("tools/call", {
      name: "leads_discover",
      arguments: { companyId: "cafe", lat: 40.5, lng: -74.3, industry: "barbershop" },
    });
    await rpc("tools/call", {
      name: "leads_discover",
      arguments: { companyId: "cafe", industry: "barbershop", location: "Parlin, NJ" },
    });
    assert.deepEqual(calls.map((c) => c.path), ["/sales/hunt/gps", "/sales/hunt"]);
    assert.equal(calls[0].body.lat, 40.5);
    assert.equal(calls[1].body.filters.industry, "barbershop");
  } finally {
    await close();
  }
});

test("site_publish publishes and returns the real public URL", async () => {
  const { rpc, calls, close } = await setup({
    "/site/generate": {
      status: 200,
      body: { ok: true, published: true, companyId: "cafe", url: "https://helixmain.duckdns.org/b/cafe/", creditsCharged: 40 },
    },
  });
  try {
    const { result } = await rpc("tools/call", {
      name: "site_publish",
      arguments: { companyId: "cafe" },
    });
    assert.equal(result.isError, false);
    assert.deepEqual(calls.map((c) => ({ path: c.path, body: c.body })), [
      { path: "/site/generate", body: { companyId: "cafe" } },
    ]);
    // the API's real URL is surfaced verbatim — not a fabricated path
    assert.match(result.content[0].text, /https:\/\/helixmain\.duckdns\.org\/b\/cafe\//);
  } finally {
    await close();
  }
});

test("the machine caller presents the tenant key (HELIX_API_KEY override)", async () => {
  const { rpc, calls, close } = await setup(
    { "/agent/session": { status: 200, body: { ok: true, reply: "hi" } } },
    { HELIX_API_KEY: "hk_testkey_from_env" },
  );
  try {
    await rpc("tools/call", {
      name: "voice_call",
      arguments: { companyId: "demo-barber", message: "hello" },
    });
    // routes are authenticated (#1): without this the API answers 401
    assert.equal(calls[0].headers["x-api-key"], "hk_testkey_from_env");
  } finally {
    await close();
  }
});

test("with no env override the key is read from the company's own 0600 store", async () => {
  const os = require("node:os");
  const fsn = require("node:fs");
  const root = fsn.mkdtempSync(path.join(os.tmpdir(), "helix-keys-"));
  fsn.mkdirSync(path.join(root, "cafe"), { recursive: true });
  fsn.writeFileSync(
    path.join(root, "cafe", "api-keys.json"),
    JSON.stringify({ company: "hk_from_disk", owner: "hk_owner_x" }),
  );

  const { rpc, calls, close } = await setup(
    { "/site/generate": { status: 200, body: { ok: true, url: "u" } } },
    { HELIX_CARD_ROOT: root, HELIX_API_KEY: "" },
  );
  try {
    await rpc("tools/call", { name: "site_publish", arguments: { companyId: "cafe" } });
    assert.equal(calls[0].headers["x-api-key"], "hk_from_disk");
  } finally {
    await close();
    fsn.rmSync(root, { recursive: true, force: true });
  }
});

test("an API 402 surfaces as isError with the status, not a fabricated success", async () => {
  const { rpc, close } = await setup({
    "/site/generate": { status: 402, body: { error: "Monthly budget cap reached" } },
  });
  try {
    const { result } = await rpc("tools/call", {
      name: "site_publish",
      arguments: { companyId: "cafe" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /402/);
    assert.match(result.content[0].text, /budget cap reached/i);
  } finally {
    await close();
  }
});

test("a missing required argument fails before any API call", async () => {
  const { rpc, calls, close } = await setup();
  try {
    const { result } = await rpc("tools/call", {
      name: "voice_call",
      arguments: { companyId: "cafe" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /missing required: message/);
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test("an unknown tool is a JSON-RPC error, not a silently empty result", async () => {
  const { rpc, close } = await setup();
  try {
    const { error } = await rpc("tools/call", { name: "nope", arguments: {} });
    assert.equal(error.code, -32602);
  } finally {
    await close();
  }
});

test("an unreachable API is an error, never an invented answer", async () => {
  const proc = spawn(process.execPath, [path.join(__dirname, "helix-mcp.js")], {
    env: { ...process.env, HELIX_API_URL: "http://127.0.0.1:1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = [];
  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const next = pending.shift();
      if (next) next(JSON.parse(line));
    }
  });
  let seq = 0;
  const rpc = (method, params) => {
    const id = ++seq;
    const p = new Promise((res) => pending.push(res));
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  };
  try {
    await rpc("initialize", {});
    const { result } = await rpc("tools/call", {
      name: "site_publish",
      arguments: { companyId: "cafe" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /unreachable/i);
  } finally {
    proc.stdin.end();
    await new Promise((res) => proc.on("exit", res));
  }
});

// ── the read/compose tools added with the billing/analytics/crm routes ────────

test("analytics_query GETs /analytics/:id with the period and carries the key", async () => {
  const { rpc, calls, close } = await setup(
    { "/analytics/demo-barber?period=week": { status: 200, body: { ok: true, calls: 12 } } },
    { HELIX_API_KEY: "hk_test" }
  );
  try {
    const { result } = await rpc("tools/call", {
      name: "analytics_query",
      arguments: { companyId: "demo-barber" },
    });
    assert.equal(result.isError, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/analytics/demo-barber?period=week");
    assert.equal(calls[0].headers["x-api-key"], "hk_test");
    assert.match(result.content[0].text, /"calls":12/);
  } finally {
    await close();
  }
});

test("analytics_query rejects a bad period before any API call", async () => {
  const { rpc, calls, close } = await setup();
  try {
    const { result } = await rpc("tools/call", {
      name: "analytics_query",
      arguments: { companyId: "cafe", period: "fortnight" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /period must be day\|week\|month/);
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test("billing_status composes metering + plan + history; a missing plan is not an error", async () => {
  const { rpc, calls, close } = await setup({
    "/metering/demo-barber": { status: 200, body: { companyId: "demo-barber", balance: 60, tier: "free" } },
    "/plan/demo-barber": { status: 404, body: { ok: false, error: "no plan found for company" } },
    "/metering/demo-barber/history": { status: 200, body: { ok: true, total: 1, entries: [{ id: "u1" }] } },
  });
  try {
    const { result } = await rpc("tools/call", {
      name: "billing_status",
      arguments: { companyId: "demo-barber" },
    });
    assert.equal(result.isError, false);
    assert.deepEqual(calls.map((c) => c.path), [
      "/metering/demo-barber",
      "/plan/demo-barber",
      "/metering/demo-barber/history",
    ]);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.credits.balance, 60);
    assert.equal(payload.plan, null);
    assert.equal(payload.plan_http_status, 404);
    assert.deepEqual(payload.history, [{ id: "u1" }]);
  } finally {
    await close();
  }
});

test("billing_status config/checkout/portal map to the billing routes", async () => {
  const { rpc, calls, close } = await setup({
    "/billing/config": { status: 200, body: { tiers: { free: {} }, packs: [] } },
    "/billing/checkout": { status: 200, body: { ok: true, checkoutUrl: "https://checkout.stripe.com/x" } },
    "/billing/portal/demo-barber": { status: 200, body: { ok: false, error: "Stripe not configured" } },
  });
  try {
    const cfg = await rpc("tools/call", {
      name: "billing_status",
      arguments: { companyId: "demo-barber", action: "config" },
    });
    const co = await rpc("tools/call", {
      name: "billing_status",
      arguments: { companyId: "demo-barber", action: "checkout", priceId: "price_123" },
    });
    const po = await rpc("tools/call", {
      name: "billing_status",
      arguments: { companyId: "demo-barber", action: "portal" },
    });
    assert.equal(cfg.result.isError, false);
    assert.equal(co.result.isError, false);
    assert.deepEqual(calls.map((c) => c.path), [
      "/billing/config",
      "/billing/checkout",
      "/billing/portal/demo-barber",
    ]);
    // checkout posts the companyId + priceId — and NOTHING else. It must never
    // touch the top-up route; credits only ever arrive via Stripe's webhook.
    assert.deepEqual(calls[1].body, { companyId: "demo-barber", priceId: "price_123" });
    assert.equal(calls.some((c) => /topup/.test(c.path)), false);
    // a portal that answers "not configured" is the API's honest answer, passed through
    assert.equal(JSON.parse(po.result.content[0].text).ok, false);
  } finally {
    await close();
  }
});

test("billing_status checkout without a priceId fails without calling the API", async () => {
  const { rpc, calls, close } = await setup();
  try {
    const r = await rpc("tools/call", {
      name: "billing_status",
      arguments: { companyId: "demo-barber", action: "checkout" },
    });
    assert.equal(r.result.isError, true);
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test("crm_manage maps each action to its real endpoint", async () => {
  const { rpc, calls, close } = await setup({
    "/crm/contacts/demo-barber": { status: 200, body: [] },
    "/crm/summary/demo-barber": { status: 200, body: { total: 0 } },
    "/crm/contacts/demo-barber/stage/won": { status: 200, body: [] },
    "/crm/contacts": { status: 202, body: { ok: true, status: "pending", proposal: { id: "crp_1" } } },
    "/crm/contacts/c1": { status: 202, body: { ok: true, status: "pending", proposal: { id: "crp_2" } } },
  });
  try {
    await rpc("tools/call", { name: "crm_manage", arguments: { companyId: "demo-barber" } });
    await rpc("tools/call", { name: "crm_manage", arguments: { companyId: "demo-barber", action: "summary" } });
    await rpc("tools/call", { name: "crm_manage", arguments: { companyId: "demo-barber", action: "by_stage", stage: "won" } });
    await rpc("tools/call", { name: "crm_manage", arguments: { companyId: "demo-barber", action: "create", contact: { name: "Ada" } } });
    const upd = await rpc("tools/call", {
      name: "crm_manage",
      arguments: { companyId: "demo-barber", action: "update", contactId: "c1", stage: "won" },
    });
    assert.equal(upd.result.isError, false);
    assert.deepEqual(calls.map((c) => c.path), [
      "/crm/contacts/demo-barber",
      "/crm/summary/demo-barber",
      "/crm/contacts/demo-barber/stage/won",
      "/crm/contacts",
      "/crm/contacts/c1",
    ]);
    // create/update now PROPOSE: the contact arrives nested under `contact`, and
    // both land as a 202 (a pending proposal) — neither has created anything.
    assert.deepEqual(calls[3].body, { companyId: "demo-barber", contact: { name: "Ada" } });
    assert.deepEqual(calls[4].body, { companyId: "demo-barber", stage: "won" });
    assert.equal(JSON.parse(upd.result.content[0].text).status, "pending");
    // The verb matters as much as the path: the update route is PATCH, and the
    // tool defaulted to POST once — a 404 that the stub, ignoring verbs, hid.
    assert.deepEqual(calls.map((c) => c.method), ["GET", "GET", "GET", "POST", "PATCH"]);
  } finally {
    await close();
  }
});

test("a list-shaped API answer keeps its array shape (no numeric-key flattening)", async () => {
  const { rpc, close } = await setup({
    "/crm/contacts/demo-barber": { status: 200, body: [{ id: "c1" }, { id: "c2" }] },
  });
  try {
    const r = await rpc("tools/call", {
      name: "crm_manage",
      arguments: { companyId: "demo-barber", action: "list" },
    });
    assert.equal(r.result.isError, false);
    const payload = JSON.parse(r.result.content[0].text);
    // Spreading an array into the payload produced {"0":…,"1":…} and made an
    // empty result indistinguishable from no result. It stays an array.
    assert.deepEqual(payload.result, [{ id: "c1" }, { id: "c2" }]);
    assert.equal(payload["0"], undefined);
  } finally {
    await close();
  }
});

test("an empty list answer is an empty array, not a bare ok", async () => {
  const { rpc, close } = await setup({
    "/crm/contacts/demo-barber": { status: 200, body: [] },
  });
  try {
    const r = await rpc("tools/call", {
      name: "crm_manage",
      arguments: { companyId: "demo-barber", action: "list" },
    });
    const payload = JSON.parse(r.result.content[0].text);
    assert.deepEqual(payload.result, []);
  } finally {
    await close();
  }
});

test("crm_manage confirm/deny apply a proposal and carry the owner credential", async () => {
  const { rpc, calls, close } = await setup(
    {
      "/crm/proposals/demo-barber": { status: 200, body: { ok: true, proposals: [{ id: "crp_1" }] } },
      "/crm/proposals/crp_1/confirm": { status: 200, body: { ok: true, status: "applied", contact: { id: "c1" } } },
      "/crm/proposals/crp_2/deny": { status: 200, body: { ok: true, status: "denied" } },
    },
    { HELIX_API_KEY: "k_company", HELIX_OWNER_KEY: "k_owner" }
  );
  try {
    await rpc("tools/call", { name: "crm_manage", arguments: { companyId: "demo-barber", action: "proposals" } });
    const c = await rpc("tools/call", {
      name: "crm_manage",
      arguments: { companyId: "demo-barber", action: "confirm", proposalId: "crp_1" },
    });
    const d = await rpc("tools/call", {
      name: "crm_manage",
      arguments: { companyId: "demo-barber", action: "deny", proposalId: "crp_2" },
    });
    assert.equal(c.result.isError, false);
    assert.equal(d.result.isError, false);
    assert.deepEqual(calls.map((x) => x.path), [
      "/crm/proposals/demo-barber",
      "/crm/proposals/crp_1/confirm",
      "/crm/proposals/crp_2/deny",
    ]);
    // apply is owner-gated: BOTH keys ride along — the company key and the owner key
    assert.equal(calls[1].headers["x-api-key"], "k_company");
    assert.equal(calls[1].headers["x-owner-key"], "k_owner");
    // ...but the plain read carries no owner key; the elevated credential is only
    // presented on the apply.
    assert.equal(calls[0].headers["x-owner-key"], undefined);
  } finally {
    await close();
  }
});

test("crm_manage refuses an incomplete action without calling the API", async () => {
  const { rpc, calls, close } = await setup();
  try {
    const a = await rpc("tools/call", {
      name: "crm_manage",
      arguments: { companyId: "cafe", action: "by_stage" },
    });
    assert.equal(a.result.isError, true);
    const b = await rpc("tools/call", {
      name: "crm_manage",
      arguments: { companyId: "cafe", action: "update", contactId: "c1" },
    });
    assert.equal(b.result.isError, true);
    const c = await rpc("tools/call", {
      name: "crm_manage",
      arguments: { companyId: "cafe", action: "confirm" },
    });
    assert.equal(c.result.isError, true);
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test("every write tool uses the API route's real HTTP verb", async () => {
  const { rpc, calls, close } = await setup({
    "/agent/session": { status: 200, body: { ok: true } },
    "/content/prd": { status: 200, body: { ok: true, prd: { id: "p" } } },
    "/content/generate": { status: 200, body: { ok: true } },
    "/sales/hunt": { status: 200, body: { ok: true } },
    "/sales/hunt/gps": { status: 200, body: { ok: true } },
    "/site/generate": { status: 200, body: { ok: true, url: "u" } },
    "/crm/contacts": { status: 202, body: { ok: true, status: "pending", proposal: { id: "p1" } } },
    "/crm/contacts/c1": { status: 202, body: { ok: true, status: "pending", proposal: { id: "p2" } } },
    "/crm/proposals/p1/confirm": { status: 200, body: { ok: true, status: "applied" } },
    "/billing/checkout": { status: 200, body: { ok: true, checkoutUrl: "u" } },
  });
  try {
    await rpc("tools/call", { name: "voice_call", arguments: { companyId: "demo-barber", message: "hi" } });
    await rpc("tools/call", { name: "content_generate", arguments: { companyId: "demo-barber", goal: "g", channels: ["email"] } });
    await rpc("tools/call", { name: "leads_discover", arguments: { companyId: "demo-barber", industry: "x" } });
    await rpc("tools/call", { name: "leads_discover", arguments: { companyId: "demo-barber", lat: 1, lng: 2 } });
    await rpc("tools/call", { name: "site_publish", arguments: { companyId: "demo-barber" } });
    await rpc("tools/call", { name: "crm_manage", arguments: { companyId: "demo-barber", action: "create", contact: { name: "A" } } });
    await rpc("tools/call", { name: "crm_manage", arguments: { companyId: "demo-barber", action: "update", contactId: "c1", note: "n" } });
    await rpc("tools/call", { name: "crm_manage", arguments: { companyId: "demo-barber", action: "confirm", proposalId: "p1" } });
    await rpc("tools/call", { name: "billing_status", arguments: { companyId: "demo-barber", action: "checkout", priceId: "price_1" } });
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.path}`),
      [
        "POST /agent/session",
        "POST /content/prd",
        "POST /content/generate",
        "POST /sales/hunt",
        "POST /sales/hunt/gps",
        "POST /site/generate",
        "POST /crm/contacts",
        "PATCH /crm/contacts/c1",
        "POST /crm/proposals/p1/confirm",
        "POST /billing/checkout",
      ]
    );
  } finally {
    await close();
  }
});

test("every read tool uses GET", async () => {
  const { rpc, calls, close } = await setup({
    "/metering/demo-barber": { status: 200, body: { balance: 1 } },
    "/plan/demo-barber": { status: 200, body: { ok: true } },
    "/metering/demo-barber/history": { status: 200, body: { entries: [] } },
    "/analytics/demo-barber": { status: 200, body: { ok: true } },
    "/billing/config": { status: 200, body: { tiers: {} } },
    "/billing/portal/demo-barber": { status: 200, body: { ok: true } },
    "/crm/contacts/demo-barber": { status: 200, body: [] },
    "/crm/summary/demo-barber": { status: 200, body: { total: 0 } },
    "/crm/proposals/demo-barber": { status: 200, body: { ok: true, proposals: [] } },
  });
  try {
    await rpc("tools/call", { name: "billing_status", arguments: { companyId: "demo-barber" } });
    await rpc("tools/call", { name: "billing_status", arguments: { companyId: "demo-barber", action: "config" } });
    await rpc("tools/call", { name: "billing_status", arguments: { companyId: "demo-barber", action: "portal" } });
    await rpc("tools/call", { name: "analytics_query", arguments: { companyId: "demo-barber" } });
    await rpc("tools/call", { name: "crm_manage", arguments: { companyId: "demo-barber", action: "summary" } });
    await rpc("tools/call", { name: "crm_manage", arguments: { companyId: "demo-barber", action: "proposals" } });
    assert.ok(
      calls.every((c) => c.method === "GET"),
      `non-GET read: ${JSON.stringify(calls.map((c) => `${c.method} ${c.path}`))}`
    );
  } finally {
    await close();
  }
});

// ── the dna.* foundry tools: served locally, never via the API ────────────────

test("dna tools dispatch to the foundry handler, invent no http status, and never call the API", async () => {
  const { rpc, calls, close } = await setup();
  try {
    const { result } = await rpc("tools/call", {
      name: "dna_get",
      arguments: { card_id: "dna_definitely_not_a_real_card" },
    });
    assert.equal(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.tool, "dna_get");
    assert.equal(payload.ok, false);
    assert.match(payload.error, /card not found/);
    // It is a local call: no HTTP happened, so none is reported.
    assert.equal("http_status" in payload, false);
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test("dna_get on a real foundry fixture card returns the card body", async () => {
  const fs = require("node:fs");
  const cardsDir = path.join(__dirname, "..", "cards");
  const any = fs.existsSync(cardsDir)
    ? fs.readdirSync(cardsDir).find((f) => f.endsWith(".json"))
    : undefined;
  if (!any) {
    // No fixture tree (e.g. a bare checkout) — the honest skip.
    return;
  }
  const cardId = any.replace(/\.json$/, "");
  const { rpc, calls, close } = await setup();
  try {
    const { result } = await rpc("tools/call", {
      name: "dna_get",
      arguments: { card_id: cardId },
    });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true);
    assert.ok(payload.card && typeof payload.card === "object");
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});
