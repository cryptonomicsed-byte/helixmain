#!/usr/bin/env node
/**
 * spark-gate-mcp — the SparkGatekeeper MCP shim.
 *
 * One tool: `invoke`. ZeroClaw namespaces it as `spark__invoke`
 * (server name "spark" + tool name "invoke").
 *
 * It decides nothing. It forwards an ActionRequest to the hold-queue sidecar
 * (POST /invoke) and returns the verdict verbatim:
 *   200 allowed | 202 held | 403 denied | 503 no policy (fail closed)
 *
 * The policy that judges the action lives in the sidecar, loaded from
 * SPARK_CARD / SPARK_POLICY_SEED / SPARK_TOOL_ALLOWLIST at ITS startup — never
 * from the request. This shim cannot widen a gate; it is one of the two
 * binaries granted egress to the hold queue by the compiled sandbox policy
 * (the other being the agent binary, which may also call /invoke directly).
 *
 * Env:
 *   SPARK_INVOKE_URL      default http://127.0.0.1:9100/invoke
 *   SPARK_CARD            card JSON or CARD.md. acting_hash is read from it and
 *                         used as the default for calls that omit one, so the
 *                         agent cannot silently act under a stale hash.
 *   SPARK_POLICY_SEED     context only — never sent; the sidecar owns policy
 *   SPARK_TOOL_ALLOWLIST  context only — surfaced in the tool description
 *
 * Transport: stdio MCP, newline-delimited JSON-RPC 2.0.
 */

"use strict";

const fs = require("fs");

const INVOKE_URL = process.env.SPARK_INVOKE_URL || "http://127.0.0.1:9100/invoke";
const SERVER_NAME = "spark-gate-mcp";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2024-11-05";

const ACTION_KINDS = ["birth", "think", "act", "deploy", "publish", "send", "mutate"];

/** Read the card's acting_hash. JSON cards carry bare hex; CARD.md frontmatter
 *  carries `sha256:<hex>`. The wire form is bare hex — the prefix is presentation. */
function readActingHash(cardPath) {
  if (!cardPath) return null;
  let raw;
  try {
    raw = fs.readFileSync(cardPath, "utf8");
  } catch (e) {
    process.stderr.write(`spark-gate-mcp: cannot read SPARK_CARD ${cardPath}: ${e.message}\n`);
    return null;
  }
  try {
    const j = JSON.parse(raw);
    if (typeof j.acting_hash === "string") return j.acting_hash.replace(/^sha256:/, "");
  } catch {
    /* not JSON — fall through to frontmatter */
  }
  const m = raw.match(/^acting_hash:\s*(?:sha256:)?([0-9a-f]{64})\s*$/m);
  return m ? m[1] : null;
}

const DEFAULT_ACTING_HASH = readActingHash(process.env.SPARK_CARD);

/** The card is exposed as an MCP resource so ZeroClaw can pin it into the system
 *  prompt as untrusted, server-origin context (McpServerConfig.pinned_resources). */
const CARD_RESOURCE = process.env.SPARK_CARD
  ? {
      uri: "card://local/current",
      name: "CARD.md",
      description: "The business card this gate enforces.",
      mimeType: process.env.SPARK_CARD.endsWith(".md") ? "text/markdown" : "application/json",
    }
  : null;

const TOOL = {
  name: "invoke",
  description:
    "Submit an action to the SparkGatekeeper hold queue and receive the verdict. " +
    "The 7 gates run against the card policy loaded in the sidecar; an allowed " +
    "action is forwarded to the tool bus, a held action returns a hold_id for " +
    "human approval, a denied action returns the denial receipt. This tool never " +
    "bypasses a gate — if the sidecar has no policy loaded it fails closed (503)." +
    (process.env.SPARK_TOOL_ALLOWLIST
      ? ` Policy seed: ${process.env.SPARK_POLICY_SEED || "(unset)"}; ` +
        `allowlist: ${process.env.SPARK_TOOL_ALLOWLIST}.`
      : ""),
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ACTION_KINDS,
        description: "Action class. deploy/publish/send require a live card and a session.",
      },
      tool: {
        type: "string",
        description: "Tool the action would invoke, e.g. mcp.vercel.deploy. Must be in the card allowlist.",
      },
      payload: {
        type: "object",
        description: "Action payload. Opaque to the gates; passed through to the tool bus on allow.",
      },
      acting_hash: {
        type: "string",
        description:
          "The acting_hash the caller believes it acts under. Defaults to the SPARK_CARD acting_hash.",
      },
      session_id: { type: "string", description: "Session the action runs under." },
      action_id: { type: "string", description: "Optional caller-supplied action id." },
      session: {
        type: "object",
        description: "Session object, when the caller was issued one (birth → think → act).",
      },
    },
    required: ["kind"],
  },
};

/** POST the action to the sidecar and normalise the verdict. Never throws on a
 *  non-2xx verdict — a 403 is a legitimate answer, not a transport failure. */
async function callSidecar(req) {
  let res;
  try {
    res = await fetch(INVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
  } catch (e) {
    return {
      isError: true,
      verdict: "unreachable",
      body: { error: `hold queue unreachable at ${INVOKE_URL}: ${e.message}` },
    };
  }

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  // 200 allowed, 202 held, 403 denied are verdicts. 503 (no policy) is fail-closed.
  const verdict =
    res.status === 200 ? "allowed" : res.status === 202 ? "held" : res.status === 403 ? "denied" : "error";

  return {
    // "held" and "denied" are normal outcomes of the gate, not tool failures;
    // "error"/"unreachable" (503, 5xx, transport) are failures.
    isError: verdict === "error" || verdict === "unreachable",
    verdict,
    body,
  };
}

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
        capabilities: { tools: {}, ...(CARD_RESOURCE ? { resources: {} } : {}) },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications take no reply

    case "ping":
      return rpcResult(id, {});

    case "resources/list":
      return rpcResult(id, { resources: CARD_RESOURCE ? [CARD_RESOURCE] : [] });

    case "resources/read": {
      if (!CARD_RESOURCE || params?.uri !== CARD_RESOURCE.uri) {
        return rpcError(id, -32602, `unknown resource: ${params?.uri}`);
      }
      try {
        const text = fs.readFileSync(process.env.SPARK_CARD, "utf8");
        return rpcResult(id, {
          contents: [{ uri: CARD_RESOURCE.uri, mimeType: CARD_RESOURCE.mimeType, text }],
        });
      } catch (e) {
        return rpcError(id, -32603, `cannot read card: ${e.message}`);
      }
    }

    case "tools/list":
      return rpcResult(id, { tools: [TOOL] });

    case "tools/call": {
      const name = params?.name;
      if (name !== TOOL.name) {
        return rpcError(id, -32602, `unknown tool: ${name}`);
      }
      const args = params?.arguments || {};
      if (!args.kind) {
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify({ error: "kind is required" }) }],
          isError: true,
        });
      }

      const req = {
        kind: args.kind,
        tool: args.tool ?? null,
        payload: args.payload ?? {},
        acting_hash: args.acting_hash || DEFAULT_ACTING_HASH || "",
        session_id: args.session_id || "",
        action_id: args.action_id,
        session: args.session ?? null,
      };
      // Drop null optionals the sidecar treats as absent rather than guess.
      if (req.action_id == null) delete req.action_id;

      const out = await callSidecar(req);
      return rpcResult(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({ verdict: out.verdict, ...out.body }),
          },
        ],
        isError: out.isError,
      });
    }

    default:
      if (id === undefined || id === null) return null; // unknown notification
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

// ── stdio loop: newline-delimited JSON-RPC ───────────────────────────────────
let buf = "";
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
    handle(msg)
      .then((out) => {
        if (out) process.stdout.write(out + "\n");
      })
      .catch((e) => {
        process.stdout.write(rpcError(msg.id ?? null, -32603, String(e.message || e)) + "\n");
      });
  }
});
process.stdin.on("end", () => process.exit(0));

if (process.env.SPARK_MCP_SELFTEST) {
  // Smoke-check the wiring without a sidecar: proves the tool surface loads.
  process.stderr.write(
    `spark-gate-mcp: invoke=${INVOKE_URL} card=${process.env.SPARK_CARD || "(unset)"} ` +
      `acting_hash=${DEFAULT_ACTING_HASH ? DEFAULT_ACTING_HASH.slice(0, 12) + "…" : "(none)"}\n`
  );
}
