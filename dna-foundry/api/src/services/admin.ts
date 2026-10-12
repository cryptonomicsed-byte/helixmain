/**
 * admin.ts — who is allowed to run the platform itself.
 *
 * This is the ONE account with unlimited credits and sight of platform-wide data.
 * Two rules make it safe, and both matter more than the feature:
 *
 *  1. It is an ALLOWLIST ON DISK, not a flag in a request. Nothing a caller sends
 *     can make them an admin — not a header, not a body field, not a company id.
 *     A privilege that a request can claim is not a privilege.
 *
 *  2. It is gated on the PASSKEY SESSION specifically (see requireAdmin). A
 *     per-company API key is a bearer string that ends up in config files, shell
 *     history and logs; it must never be sufficient to administer the platform.
 *     The passkey is a physical ceremony the owner performs.
 *
 * The file lives at /etc/helix/admin.json (0600, root) and is deliberately NOT in
 * the repo, so reading the source does not reveal which account to attack, and a
 * clone does not carry the production privilege with it.
 */
import * as fs from "fs";
import * as path from "path";

const ADMIN_FILE = process.env.HELIX_ADMIN_FILE || "/etc/helix/admin.json";

export interface AdminConfig {
  /** Company ids that hold the admin grant. In practice: exactly one. */
  companies?: string[];
  /** Free-form note, for whoever finds this file later. */
  note?: string;
}

let cached: AdminConfig | null = null;
let cacheAt = 0;
/** Short TTL so a revoke takes effect promptly without a restart. */
const TTL_MS = 10_000;

export function loadAdmin(): AdminConfig {
  const now = Date.now();
  if (cached && now - cacheAt < TTL_MS) return cached;
  try {
    const raw = JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8")) as AdminConfig;
    cached = { companies: Array.isArray(raw.companies) ? raw.companies : [], note: raw.note };
  } catch {
    // No file, unreadable, or malformed => NOBODY is admin. Fail closed: an
    // admin subsystem that cannot read its allowlist must not invent one.
    cached = { companies: [] };
  }
  cacheAt = now;
  return cached;
}

export function isAdminCompany(companyId?: string | null): boolean {
  if (!companyId) return false;
  return (loadAdmin().companies ?? []).includes(companyId);
}

export function listAdminCompanies(): string[] {
  return [...(loadAdmin().companies ?? [])];
}

/** Create or rewrite the allowlist. Used by infra/make-admin.py. */
export function writeAdmin(cfg: AdminConfig): void {
  fs.mkdirSync(path.dirname(ADMIN_FILE), { recursive: true });
  fs.writeFileSync(ADMIN_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(ADMIN_FILE, 0o600);
  cached = cfg;
  cacheAt = Date.now();
}

export const ADMIN_FILE_PATH = ADMIN_FILE;
