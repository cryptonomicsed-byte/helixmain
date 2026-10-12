/**
 * accounts.ts — an ACCOUNT owns companies.
 *
 * The historical model collapsed two things into one slug: whoever signed up WAS
 * the company, and the company WAS the one card. That is a structural ceiling —
 * one account can hold exactly one card, so a multi-client dashboard, an agency
 * view, or a demo portfolio all have to work around it.
 *
 * This module is the layer that lifts the ceiling. An ACCOUNT is the principal
 * that logs in; it owns zero or more COMPANIES (company slugs). Each company is
 * still the unit that owns a card, a voice identity, a directory entry and a
 * landing page — none of that changes. What changes is that "which companies may
 * this principal touch" is answered HERE, in one place, instead of by every route.
 *
 * Backward compatible by construction: an existing 1:1 account (signup slug ==
 * company slug) migrates to `owned: [slug]`, so accountOwning(<slug>) returns an
 * account that owns exactly the company it always did. Sessions are unchanged.
 *
 * Stored at /etc/helix/accounts/<id>.json (0600).
 */
import * as fs from "fs";
import * as path from "path";

export const ACCOUNTS_DIR = process.env.HELIX_ACCOUNTS_DIR || "/etc/helix/accounts";

/** Same slug rule onboarding enforces (companies.ts). */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface AccountRecord {
  id: string;
  business: string | null;
  email: string | null;
  website: string | null;
  provider: string | null;
  googleSub: string | null;
  createdAt: string;
  status: string;
  /** Company slugs this account controls. The account's own id MAY be one of
   *  them (the historical 1:1 case); it need not be. */
  owned: string[];
}

function pathFor(id: string): string {
  return path.join(ACCOUNTS_DIR, `${id}.json`);
}

export function isAccountId(id: unknown): id is string {
  return typeof id === "string" && SLUG.test(id);
}

export function readAccountRecord(id: string): AccountRecord | null {
  if (!isAccountId(id)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(pathFor(id), "utf8")) as Partial<AccountRecord>;
    return {
      id,
      business: raw.business ?? null,
      email: raw.email ?? null,
      website: raw.website ?? null,
      provider: raw.provider ?? null,
      googleSub: raw.googleSub ?? null,
      createdAt: raw.createdAt ?? "",
      status: raw.status ?? "active",
      owned: Array.isArray(raw.owned) ? raw.owned.filter((c): c is string => typeof c === "string") : [],
    };
  } catch {
    return null;
  }
}

export function writeAccountRecord(rec: AccountRecord): void {
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
  const p = pathFor(rec.id);
  fs.writeFileSync(p, JSON.stringify(rec, null, 2), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  resetAccountCache();
}

export function ensureAccount(id: string, seed: Partial<AccountRecord> = {}): AccountRecord {
  const existing = readAccountRecord(id);
  if (existing) return existing;
  const rec: AccountRecord = {
    id,
    business: seed.business ?? null,
    email: seed.email ?? null,
    website: seed.website ?? null,
    provider: seed.provider ?? null,
    googleSub: seed.googleSub ?? null,
    createdAt: seed.createdAt ?? new Date().toISOString(),
    status: seed.status ?? "active",
    owned: seed.owned ?? [],
  };
  writeAccountRecord(rec);
  return rec;
}

/** Append a company to an account's portfolio. Idempotent. Creates the account
 *  if it does not exist yet (so a company created before its account record —
 *  every company on the box today — is adopted rather than orphaned). */
export function addOwnedCompany(accountId: string, company: string): AccountRecord {
  const rec = ensureAccount(accountId);
  if (!rec.owned.includes(company)) {
    rec.owned.push(company);
    writeAccountRecord(rec);
  }
  return rec;
}

export function removeOwnedCompany(accountId: string, company: string): AccountRecord | null {
  const rec = readAccountRecord(accountId);
  if (!rec) return null;
  if (rec.owned.includes(company)) {
    rec.owned = rec.owned.filter((c) => c !== company);
    writeAccountRecord(rec);
  }
  return rec;
}

// ── lookup (cached, like apiKeys: sessions authenticate on every request) ─────

const TTL_MS = 10_000;
let cache: { at: number; all: AccountRecord[] } | null = null;

export function listAccounts(): AccountRecord[] {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.all;
  let all: AccountRecord[] = [];
  try {
    all = fs
      .readdirSync(ACCOUNTS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readAccountRecord(f.replace(/\.json$/, "")))
      .filter((r): r is AccountRecord => !!r);
  } catch {
    all = [];
  }
  cache = { at: now, all };
  return all;
}

export function resetAccountCache(): void {
  cache = null;
}

/** The account that owns a company, or null. This is what widens a session from
 *  "one company" to "every company this account controls". */
export function accountOwning(company: string): AccountRecord | null {
  if (!company) return null;
  // Fast path: the historical 1:1 account whose id IS the company.
  const self = readAccountRecord(company);
  if (self && self.owned.includes(company)) return self;
  for (const a of listAccounts()) {
    if (a.owned.includes(company)) return a;
  }
  return null;
}

export function accountOwns(accountId: string, company: string): boolean {
  const a = readAccountRecord(accountId);
  return !!a && a.owned.includes(company);
}

export function companiesForAccount(accountId: string): string[] {
  return readAccountRecord(accountId)?.owned ?? [];
}
