/**
 * zeroclaw.ts — client for the ZeroClaw agent daemon.
 *
 * The daemon owns /etc/zeroclaw and exposes, on 127.0.0.1:42617:
 *   WS  /ws/chat?agent=<alias>   streaming chat
 *   GET /api/status              liveness + per-channel health
 *
 * Frames observed live (2026-10-11):
 *   <- {"type":"session_start","session_id":"…"}
 *   -> {"type":"message","content":"…"}
 *   <- {"type":"chunk","content":"…"}                     (many)
 *   <- {"type":"…","full_response":"…","output_tokens":N,"model":"…"}   (final)
 *   <- {"type":"error","code":"…","message":"…"}
 *
 * AUTH: a pairing-derived bearer token (default /etc/helix/zeroclaw.token, 0600).
 * It is passed as `?token=` rather than a header because Node's global WebSocket
 * cannot set request headers; the daemon accepts both.
 *
 * The agent for a company is the alias named after it: `[agents.<companyId>]`.
 */
import * as fs from "fs";

const ZC_HTTP = process.env.ZEROCLAW_HTTP_URL || "http://127.0.0.1:42617";
const ZC_WS = process.env.ZEROCLAW_WS_URL || "ws://127.0.0.1:42617";
const TOKEN_PATH = process.env.ZEROCLAW_TOKEN || "/etc/helix/zeroclaw.token";

/** Node 22 ships a global WebSocket; @types/node 20 doesn't describe it. */
interface ZcSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, cb: (ev: { data?: unknown; message?: string }) => void): void;
}
declare const WebSocket: { new (url: string): ZcSocket };

export interface AgentFrame {
  type?: string;
  content?: string;
  session_id?: string;
  full_response?: string;
  message?: string;
  code?: string;
  output_tokens?: number;
  [k: string]: unknown;
}

export function agentToken(): string {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

/** The ZeroClaw alias for a company is the company id itself. */
export function agentNameFor(companyId: string): string {
  return companyId;
}

export interface AgentStatus {
  ok: boolean;
  channels: Record<string, boolean>;
}

/** Daemon liveness + per-channel health. Never throws. */
export async function agentStatus(): Promise<AgentStatus> {
  try {
    const r = await fetch(`${ZC_HTTP}/api/status`, {
      headers: { Authorization: `Bearer ${agentToken()}` },
    });
    if (!r.ok) return { ok: false, channels: {} };
    const j = (await r.json()) as { channels?: Record<string, boolean> };
    return { ok: true, channels: j.channels ?? {} };
  } catch {
    return { ok: false, channels: {} };
  }
}

export class AgentOffline extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AgentOffline";
  }
}

/**
 * Run ONE turn against an agent, streaming frames to `onFrame`.
 * Resolves with the full reply text. Rejects on connect failure (→ offline),
 * on an explicit agent error frame, or on timeout.
 */
export function chatStream(
  agent: string,
  message: string,
  onFrame: (f: AgentFrame) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const token = agentToken();
    if (!token) {
      return reject(new AgentOffline(`no ZeroClaw token at ${TOKEN_PATH}`));
    }
    const url = `${ZC_WS}/ws/chat?agent=${encodeURIComponent(agent)}&token=${encodeURIComponent(token)}`;

    let ws: ZcSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      return reject(new AgentOffline(e instanceof Error ? e.message : String(e)));
    }

    let full = "";
    let opened = false;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        try { ws.close(); } catch { /* already gone */ }
        reject(new Error("agent timed out after 120s"));
      });
    }, 120_000);

    if (signal) {
      signal.addEventListener("abort", () =>
        finish(() => {
          try { ws.close(); } catch { /* already gone */ }
          reject(new Error("client disconnected"));
        }),
      );
    }

    ws.addEventListener("open", () => {
      opened = true;
      try {
        ws.send(JSON.stringify({ type: "message", content: message }));
      } catch (e) {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    });

    ws.addEventListener("message", (ev) => {
      let f: AgentFrame;
      try {
        f = JSON.parse(String(ev.data)) as AgentFrame;
      } catch {
        return; // heartbeats / non-JSON are not part of the protocol
      }
      if (f.type === "chunk" && typeof f.content === "string") full += f.content;
      if (typeof f.full_response === "string" && f.full_response) full = f.full_response;
      if (f.type === "error") {
        return finish(() =>
          reject(new Error(String(f.message || f.code || "agent error"))),
        );
      }
      try { onFrame(f); } catch { /* a throwing consumer must not kill the turn */ }
    });

    ws.addEventListener("error", () =>
      finish(() =>
        reject(
          opened
            ? new Error("agent stream interrupted")
            : new AgentOffline(`the ${agent} agent is not reachable`),
        ),
      ),
    );

    ws.addEventListener("close", () => finish(() => resolve(full)));
  });
}
