/**
 * passkeys.ts — WebAuthn credentials and one-time enrollment tokens.
 *
 * CREDENTIALS live at <HELIX_COMPANIES>/<company>/passkeys.json (0600):
 *   [{ id, publicKey, counter, transports, createdAt, label }]
 * `id` is the base64url credential id — globally unique — so a login can find the
 * owning company by scanning the onboarded set. We request RESIDENT keys, so the
 * authenticator offers the passkey with no username typed: a true one-button login.
 *
 * ENROLLMENT is bootstrapped by a one-time token, so the (unauthenticated by
 * necessity) /auth/register/* routes can only be used by someone the operator
 * handed a link to. The token is stored HASHED at <company>/enroll-token.json with
 * a TTL and deleted on first successful registration. This is the same shape as
 * the gatekeeper's enrollment window: there is no permanent open enrollment door.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { HELIX_COMPANIES, listProvisionedCompanies } from "./companies";

export interface StoredCredential {
  id: string; // base64url credential id
  publicKey: string; // base64url COSE public key
  counter: number;
  transports?: string[];
  createdAt: string;
  label?: string;
}

function credsPath(company: string): string {
  return path.join(HELIX_COMPANIES, company, "passkeys.json");
}

export function loadCreds(company: string): StoredCredential[] {
  try {
    const raw = fs.readFileSync(credsPath(company), "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as StoredCredential[]) : [];
  } catch {
    return [];
  }
}

function saveCreds(company: string, creds: StoredCredential[]): void {
  const p = credsPath(company);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}

export function addCredential(company: string, cred: StoredCredential): void {
  const creds = loadCreds(company).filter((c) => c.id !== cred.id);
  creds.push(cred);
  saveCreds(company, creds);
}

export function updateCounter(company: string, id: string, counter: number): void {
  const creds = loadCreds(company);
  const c = creds.find((x) => x.id === id);
  if (!c) return;
  c.counter = counter;
  saveCreds(company, creds);
}

/** Find which onboarded company owns a credential id (discoverable-key login). */
export function findCompanyByCredentialId(
  id: string,
): { company: string; cred: StoredCredential } | null {
  for (const company of listProvisionedCompanies()) {
    const c = loadCreds(company).find((x) => x.id === id);
    if (c) return { company, cred: c };
  }
  return null;
}

export function credsFor(company: string): StoredCredential[] {
  return loadCreds(company);
}

// ---------------------------------------------------------------------------
// One-time enrollment tokens

interface EnrollTokenFile {
  token_sha256: string;
  exp: number; // ms epoch
  created_at: string;
  label?: string;
}

function tokenPath(company: string): string {
  return path.join(HELIX_COMPANIES, company, "enroll-token.json");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** Issue (or replace) a company's enrollment token. Returns the PLAINTEXT once. */
export function issueEnrollToken(company: string, ttlMs: number, label?: string): string {
  const token = crypto.randomBytes(24).toString("hex");
  const file: EnrollTokenFile = {
    token_sha256: hashToken(token),
    exp: Date.now() + ttlMs,
    created_at: new Date().toISOString(),
    ...(label ? { label } : {}),
  };
  const p = tokenPath(company);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(file, null, 2), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return token;
}

/**
 * Resolve a presented token to its company, or null. Does NOT consume — so the
 * register/options and register/verify steps can both be gated by the same token.
 * Consume explicitly on success (see consumeEnrollToken).
 */
export function resolveEnrollToken(token: string): string | null {
  if (!token) return null;
  const want = hashToken(token);
  for (const company of listProvisionedCompanies()) {
    try {
      const f = JSON.parse(fs.readFileSync(tokenPath(company), "utf8")) as EnrollTokenFile;
      if (f.exp < Date.now()) continue;
      const a = Buffer.from(f.token_sha256);
      const b = Buffer.from(want);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return company;
    } catch {
      /* no token for this company */
    }
  }
  return null;
}

/** Delete a company's enrollment token — one-time use. */
export function consumeEnrollToken(company: string): void {
  try {
    fs.rmSync(tokenPath(company));
  } catch {
    /* already gone */
  }
}
