/**
 * session.ts — signed, expiring browser sessions for the owner dashboard.
 *
 * The dashboard login (a passkey assertion, or a one-time enrollment link) yields
 * a session cookie. The session carries {company, role, exp} and is signed with
 * HMAC-SHA256 using a secret kept OUTSIDE git (/etc/helix/session-secret, 0600).
 *
 * requireAuth accepts EITHER an `x-api-key` (machine callers — unchanged) OR this
 * cookie (the browser). The per-company API key never reaches the browser; the
 * server maps the session to the company. That is the whole point: the owner logs
 * in with one credential and never sees an internal key.
 *
 * The same signer is reused for WebAuthn challenge state, so nothing is kept in
 * server memory that a restart would lose.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export const SESSION_COOKIE = "helix_session";
export const CHALLENGE_COOKIE = "helix_chal";

/** 12h — long enough for a working day, short enough to age out unattended. */
export const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
/** WebAuthn ceremonies are interactive; 5 minutes is generous. */
export const CHALLENGE_TTL_MS = 1000 * 60 * 5;

const SECRET_PATH =
  process.env.HELIX_SESSION_SECRET_FILE || "/etc/helix/session-secret";

let cachedSecret: Buffer | null = null;

function secret(): Buffer {
  if (cachedSecret) return cachedSecret;
  try {
    const hex = fs.readFileSync(SECRET_PATH, "utf8").trim();
    if (hex.length >= 64) {
      cachedSecret = Buffer.from(hex, "hex");
      return cachedSecret;
    }
  } catch {
    /* mint below */
  }
  const buf = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
  fs.writeFileSync(SECRET_PATH, buf.toString("hex") + "\n", { mode: 0o600 });
  fs.chmodSync(SECRET_PATH, 0o600);
  cachedSecret = buf;
  return cachedSecret;
}

function mac(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Sign an arbitrary JSON object into `base64url(body).hmac`. */
export function signJson(obj: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  return `${payload}.${mac(payload)}`;
}

/** Verify a signed blob and enforce its `exp` (ms epoch). Returns null on any doubt. */
export function verifyJson<T extends { exp: number }>(token: string | undefined): T | null {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const idx = token.lastIndexOf(".");
  const payload = token.slice(0, idx);
  const given = token.slice(idx + 1);
  const expected = mac(payload);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let parsed: T;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
  return parsed;
}

// ---------------------------------------------------------------------------
// Sessions

export interface Session {
  company: string;
  role: "owner" | "company";
  exp: number;
}

export function mintSession(company: string, role: "owner" | "company" = "owner"): string {
  return signJson({ company, role, exp: Date.now() + SESSION_TTL_MS } as unknown as Record<string, unknown>);
}

export function readSession(token: string | undefined): Session | null {
  const s = verifyJson<Session>(token);
  if (!s || typeof s.company !== "string" || !s.company) return null;
  return s;
}

// ---------------------------------------------------------------------------
// Cookies (parsed by hand — one dep fewer than pulling in @fastify/cookie)

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
  }
  return out;
}

/** Set-Cookie value for a HttpOnly, Secure, SameSite=Lax cookie. */
export function setCookie(name: string, value: string, maxAgeSec: number): string {
  const flags = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSec}`];
  // Secure on HTTPS; the API is reached over https via nginx in production, but
  // local http tests would drop a Secure cookie, so gate it on explicit opt-out.
  if (process.env.HELIX_INSECURE_COOKIES !== "1") flags.push("Secure");
  return `${name}=${encodeURIComponent(value)}; ${flags.join("; ")}`;
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
