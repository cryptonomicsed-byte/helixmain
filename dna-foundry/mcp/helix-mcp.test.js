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
      calls.push({ path: req.url, body: parsed, headers: req.headers });
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

test("tools/list exposes exactly the 7 platform tools", async () => {
  const { rpc, close } = await setup();
  try {
    const { result } = await rpc("tools/list", {});
    assert.deepEqual(
      result.tools.map((t) => t.name).sort(),
      [
        "analytics.query",
        "billing.status",
        "content.generate",
        "crm.manage",
        "leads.discover",
        "site.publish",
        "voice.call",
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

test("voice.call posts the message to /agent/session and returns the reply", async () => {
  const { rpc, calls, close } = await setup({
    "/agent/session": { status: 200, body: { ok: true, reply: "We open at 9." } },
  });
  try {
    const { result } = await rpc("tools/call", {
      name: "voice.call",
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

test("content.generate builds a PRD then assets when given goal + channels", async () => {
  const { rpc, calls, close } = await setup({
    "/content/prd": { status: 200, body: { ok: true, prd: { id: "prd_1", goal: "lunch" } } },
    "/content/generate": { status: 200, body: { ok: true, assets: [{ id: "a1" }] } },
  });
  try {
    const { result } = await rpc("tools/call", {
      name: "content.generate",
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

test("content.generate with a ready prd skips PRD generation", async () => {
  const { rpc, calls, close } = await setup({
    "/content/generate": { status: 200, body: { ok: true, assets: [] } },
  });
  try {
    const { result } = await rpc("tools/call", {
      name: "content.generate",
      arguments: { companyId: "cafe", prd: { id: "prd_x" } },
    });
    assert.equal(result.isError, false);
    assert.deepEqual(calls.map((c) => c.path), ["/content/generate"]);
  } finally {
    await close();
  }
});

test("content.generate with neither prd nor goal+channels fails without calling the API", async () => {
  const { rpc, calls, close } = await setup();
  try {
    const { result } = await rpc("tools/call", {
      name: "content.generate",
      arguments: { companyId: "cafe" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /needs either/);
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test("leads.discover routes by lat/lng: GPS path when present, Apollo path otherwise", async () => {
  const { rpc, calls, close } = await setup({
    "/sales/hunt/gps": { status: 200, body: { ok: true, leads: [{ id: "l1" }] } },
    "/sales/hunt": { status: 200, body: { ok: true, leads: [] } },
  });
  try {
    await rpc("tools/call", {
      name: "leads.discover",
      arguments: { companyId: "cafe", lat: 40.5, lng: -74.3, industry: "barbershop" },
    });
    await rpc("tools/call", {
      name: "leads.discover",
      arguments: { companyId: "cafe", industry: "barbershop", location: "Parlin, NJ" },
    });
    assert.deepEqual(calls.map((c) => c.path), ["/sales/hunt/gps", "/sales/hunt"]);
    assert.equal(calls[0].body.lat, 40.5);
    assert.equal(calls[1].body.filters.industry, "barbershop");
  } finally {
    await close();
  }
});

test("site.publish publishes and returns the real public URL", async () => {
  const { rpc, calls, close } = await setup({
    "/site/generate": {
      status: 200,
      body: { ok: true, published: true, companyId: "cafe", url: "https://helixmain.duckdns.org/b/cafe/", creditsCharged: 40 },
    },
  });
  try {
    const { result } = await rpc("tools/call", {
      name: "site.publish",
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
      name: "voice.call",
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
    await rpc("tools/call", { name: "site.publish", arguments: { companyId: "cafe" } });
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
      name: "site.publish",
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
      name: "voice.call",
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
      name: "site.publish",
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

test("analytics.query GETs /analytics/:id with the period and carries the key", async () => {
  const { rpc, calls, close } = await setup(
    { "/analytics/demo-barber?period=week": { status: 200, body: { ok: true, calls: 12 } } },
    { HELIX_API_KEY: "hk_test" }
  );
  try {
    const { result } = await rpc("tools/call", {
      name: "analytics.query",
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

test("analytics.query rejects a bad period before any API call", async () => {
  const { rpc, calls, close } = await setup();
  try {
    const { result } = await rpc("tools/call", {
      name: "analytics.query",
      arguments: { companyId: "cafe", period: "fortnight" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /period must be day\|week\|month/);
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test("billing.status composes metering + plan + history; a missing plan is not an error", async () => {
  const { rpc, calls, close } = await setup({
    "/metering/demo-barber": { status: 200, body: { companyId: "demo-barber", balance: 60, tier: "free" } },
    "/plan/demo-barber": { status: 404, body: { ok: false, error: "no plan found for company" } },
    "/metering/demo-barber/history": { status: 200, body: { ok: true, total: 1, entries: [{ id: "u1" }] } },
  });
  try {
    const { result } = await rpc("tools/call", {
      name: "billing.status",
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

test("crm.manage maps each action to its real endpoint", async () => {
  const { rpc, calls, close } = await setup({
    "/crm/contacts/demo-barber": { status: 200, body: [] },
    "/crm/summary/demo-barber": { status: 200, body: { total: 0 } },
    "/crm/contacts/demo-barber/stage/won": { status: 200, body: [] },
    "/crm/contacts": { status: 201, body: { id: "c1", companyId: "demo-barber" } },
    "/crm/contacts/c1": { status: 200, body: { id: "c1", stage: "won" } },
  });
  try {
    await rpc("tools/call", { name: "crm.manage", arguments: { companyId: "demo-barber" } });
    await rpc("tools/call", { name: "crm.manage", arguments: { companyId: "demo-barber", action: "summary" } });
    await rpc("tools/call", { name: "crm.manage", arguments: { companyId: "demo-barber", action: "by_stage", stage: "won" } });
    await rpc("tools/call", { name: "crm.manage", arguments: { companyId: "demo-barber", action: "create", contact: { name: "Ada" } } });
    const upd = await rpc("tools/call", {
      name: "crm.manage",
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
    assert.deepEqual(calls[3].body, { companyId: "demo-barber", name: "Ada" });
    assert.deepEqual(calls[4].body, { companyId: "demo-barber", stage: "won" });
  } finally {
    await close();
  }
});

test("crm.manage refuses an incomplete action without calling the API", async () => {
  const { rpc, calls, close } = await setup();
  try {
    const a = await rpc("tools/call", {
      name: "crm.manage",
      arguments: { companyId: "cafe", action: "by_stage" },
    });
    assert.equal(a.result.isError, true);
    const b = await rpc("tools/call", {
      name: "crm.manage",
      arguments: { companyId: "cafe", action: "update", contactId: "c1" },
    });
    assert.equal(b.result.isError, true);
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});
