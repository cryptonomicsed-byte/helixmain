"use strict";
/**
 * Tests for spark-gate-mcp — the stdio MCP shim in front of the hold queue.
 *
 * A real mock sidecar runs on an ephemeral port; the shim is spawned as a real
 * child process and driven over stdio with newline-delimited JSON-RPC. Nothing
 * is stubbed inside the shim: if the process wiring is wrong, these fail.
 *
 * Run: node --test dna-foundry/mcp/spark-gate-mcp.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");

const SHIM = path.join(__dirname, "spark-gate-mcp.js");

/** Start a mock /invoke that answers with a fixed status+body, capturing the
 *  last ActionRequest it received. Returns {url, last, close}. */
function mockSidecar(status, body) {
  const state = { last: null };
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        state.last = JSON.parse(data);
      } catch {
        state.last = { _unparsed: data };
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/invoke`,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Spawn the shim, send `messages`, resolve with their responses (by id). */
function driveShim(env, messages) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SHIM], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = [];
    let buf = "";
    proc.stdout.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) out.push(JSON.parse(line));
        if (out.length === messages.length) {
          proc.kill();
          resolve(out);
        }
      }
    });
    proc.on("error", reject);
    setTimeout(() => {
      proc.kill();
      resolve(out);
    }, 8000);
    for (const m of messages) proc.stdin.write(JSON.stringify(m) + "\n");
  });
}

test("initialize advertises the tools capability", async () => {
  const [res] = await driveShim({}, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  ]);
  assert.equal(res.id, 1);
  assert.equal(res.result.serverInfo.name, "spark-gate-mcp");
  assert.ok(res.result.capabilities.tools, "declares a tools capability");
  assert.match(res.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
});

test("tools/list exposes exactly one tool: invoke, requiring kind", async () => {
  const [res] = await driveShim({}, [{ jsonrpc: "2.0", id: 2, method: "tools/list" }]);
  const tools = res.result.tools;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "invoke");
  assert.deepEqual(tools[0].inputSchema.required, ["kind"]);
  assert.ok(tools[0].inputSchema.properties.kind.enum.includes("deploy"));
});

test("tools/call without kind fails closed and never reaches the sidecar", async () => {
  const side = await mockSidecar(200, { status: "allowed" });
  const [res] = await driveShim({ SPARK_INVOKE_URL: side.url }, [
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "invoke", arguments: {} } },
  ]);
  assert.equal(res.result.isError, true);
  assert.equal(side.state.last, null, "no HTTP call for a malformed action");
  await side.close();
});

test("403 from the sidecar surfaces as verdict=denied, NOT a tool error", async () => {
  const side = await mockSidecar(403, {
    status: "denied",
    action_id: "a1",
    receipt: { reason: "no session: birth required before think/act" },
  });
  const [res] = await driveShim({ SPARK_INVOKE_URL: side.url }, [
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "invoke", arguments: { kind: "deploy", tool: "mcp.vercel.deploy" } },
    },
  ]);
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.verdict, "denied");
  assert.equal(res.result.isError, false, "a denial is a verdict, not a failure");
  assert.equal(side.state.last.kind, "deploy");
  assert.equal(side.state.last.tool, "mcp.vercel.deploy");
  await side.close();
});

test("202 surfaces as verdict=held with the hold_id passthrough", async () => {
  const side = await mockSidecar(202, { status: "held", action_id: "a2", hold_id: "hold-xyz" });
  const [res] = await driveShim({ SPARK_INVOKE_URL: side.url }, [
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "invoke", arguments: { kind: "mutate" } },
    },
  ]);
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.verdict, "held");
  assert.equal(payload.hold_id, "hold-xyz");
  assert.equal(res.result.isError, false);
  await side.close();
});

test("200 surfaces as verdict=allowed", async () => {
  const side = await mockSidecar(200, { status: "allowed", action_id: "a3", forwarded: true });
  const [res] = await driveShim({ SPARK_INVOKE_URL: side.url }, [
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "invoke", arguments: { kind: "think" } },
    },
  ]);
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.verdict, "allowed");
  assert.equal(res.result.isError, false);
  await side.close();
});

test("503 (no policy loaded) is a hard failure — fail closed, isError true", async () => {
  const side = await mockSidecar(503, { error: "no policy loaded" });
  const [res] = await driveShim({ SPARK_INVOKE_URL: side.url }, [
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "invoke", arguments: { kind: "act" } },
    },
  ]);
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.verdict, "error");
  assert.equal(res.result.isError, true);
  await side.close();
});

test("acting_hash defaults from SPARK_CARD when the caller omits it", async () => {
  const cardPath = path.join(os.tmpdir(), `card-${process.pid}.md`);
  const hex = "a".repeat(64);
  fs.writeFileSync(cardPath, `---\nformat: business-card/0.1\nid: dna_x\nacting_hash: sha256:${hex}\n---\n`);
  const side = await mockSidecar(200, { status: "allowed" });
  const [res] = await driveShim({ SPARK_INVOKE_URL: side.url, SPARK_CARD: cardPath }, [
    {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "invoke", arguments: { kind: "think" } },
    },
  ]);
  assert.equal(res.result.isError, false);
  assert.equal(side.state.last.acting_hash, hex, "bare hex, sha256: prefix stripped");
  await side.close();
  fs.unlinkSync(cardPath);
});

test("unknown method returns JSON-RPC -32601", async () => {
  const [res] = await driveShim({}, [{ jsonrpc: "2.0", id: 9, method: "bogus/method" }]);
  assert.equal(res.error.code, -32601);
});

test("unknown tool name is rejected", async () => {
  const [res] = await driveShim({}, [
    { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "delete_everything", arguments: {} } },
  ]);
  assert.equal(res.error.code, -32602);
});

/** Like driveShim, but half-closes stdin right after writing — the client pattern
 *  that must not drop an in-flight tools/call. Resolves on process exit. */
function driveShimThenClose(env, messages) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SHIM], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = [];
    let buf = "";
    proc.stdout.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) out.push(JSON.parse(line));
      }
    });
    proc.on("error", reject);
    proc.on("exit", () => resolve(out));
    for (const m of messages) proc.stdin.write(JSON.stringify(m) + "\n");
    proc.stdin.end();
    setTimeout(() => {
      proc.kill();
      resolve(out);
    }, 8000);
  });
}

test("an in-flight tools/call survives stdin half-close (drain before exit)", async () => {
  const mock = await mockSidecar(200, { status: "allowed", action_id: "a1" });
  const out = await driveShimThenClose({ SPARK_INVOKE_URL: mock.url }, [
    { jsonrpc: "2.0", id: 90, method: "tools/call", params: { name: "invoke", arguments: { kind: "act" } } },
  ]);
  assert.equal(out.length, 1, "the response must arrive despite stdin closing");
  assert.equal(out[0].id, 90);
  assert.equal(out[0].result.content[0].type, "text");
  await mock.close();
});

test("with SPARK_CARD set, the card is exposed as a resource (for pinned_resources)", async () => {
  const cardPath = path.join(os.tmpdir(), `card-res-${process.pid}.md`);
  fs.writeFileSync(cardPath, `---\nid: dna_res\nacting_hash: sha256:${"b".repeat(64)}\n---\n\n# Santino's Pizza\n`);
  const [init, list, read] = await driveShim({ SPARK_CARD: cardPath }, [
    { jsonrpc: "2.0", id: 11, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 12, method: "resources/list" },
    { jsonrpc: "2.0", id: 13, method: "resources/read", params: { uri: "card://local/current" } },
  ]);
  assert.ok(init.result.capabilities.resources, "declares a resources capability");
  assert.equal(list.result.resources.length, 1);
  assert.equal(list.result.resources[0].uri, "card://local/current");
  assert.match(read.result.contents[0].text, /Santino's Pizza/);
  fs.unlinkSync(cardPath);
});

test("without SPARK_CARD, no resources are advertised and reads 400", async () => {
  const [init, list, read] = await driveShim({}, [
    { jsonrpc: "2.0", id: 14, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 15, method: "resources/list" },
    { jsonrpc: "2.0", id: 16, method: "resources/read", params: { uri: "card://local/current" } },
  ]);
  assert.equal(init.result.capabilities.resources, undefined);
  assert.deepEqual(list.result.resources, []);
  assert.equal(read.error.code, -32602);
});
