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
async function setup(replies = {}) {
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
      calls.push({ path: req.url, body: parsed });
      const r = replies[req.url] ?? { status: 200, body: { ok: true } };
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise((res) => api.listen(0, "127.0.0.1", res));
  const apiUrl = `http://127.0.0.1:${api.address().port}`;

  const proc = spawn(process.execPath, [path.join(__dirname, "helix-mcp.js")], {
    env: { ...process.env, HELIX_API_URL: apiUrl },
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

test("tools/list exposes exactly the 4 platform tools", async () => {
  const { rpc, close } = await setup();
  try {
    const { result } = await rpc("tools/list", {});
    assert.deepEqual(
      result.tools.map((t) => t.name).sort(),
      ["content.generate", "leads.discover", "site.publish", "voice.call"]
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
    assert.deepEqual(calls, [
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

test("site.publish generates the site and returns where it is served", async () => {
  const { rpc, calls, close } = await setup({
    "/site/generate": { status: 200, body: { ok: true, companyId: "cafe", generatedAt: "t" } },
  });
  try {
    const { result } = await rpc("tools/call", {
      name: "site.publish",
      arguments: { companyId: "cafe" },
    });
    assert.equal(result.isError, false);
    assert.deepEqual(calls, [{ path: "/site/generate", body: { companyId: "cafe" } }]);
    assert.match(result.content[0].text, /"sitePath":"\/site\/cafe"/);
  } finally {
    await close();
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
