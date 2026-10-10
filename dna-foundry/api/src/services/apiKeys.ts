/**
 * apiKeys.ts — API credentials, one set per onboarded company.
 *
 * Two levels:
 *   company — normal operations for that company.
 *   owner   — additionally allowed to mutate the card (PATCH /cards/:id).
 *
 * Stored per company at <HELIX_COMPANIES>/<id>/api-keys.json (0600), written by
 * onboarding. The KEY is the tenant identity: requireAuth derives the company from
 * the presented key, so a caller-supplied companyId is never trusted on its own.
 *
 * Lookup is constant-time over the whole set (no early exit), so a wrong key can't
 * be narrowed by timing.
 */
import * as fs from "fs";
import * as path from "path";
import { randomBytes, timingSafeEqual } from "crypto";
import { HELIX_COMPANIES, listProvisionedCompanies } from "./companies";

export type KeyLevel = "company" | "owner";
export interface KeyRecord {
  companyId: string;
  level: KeyLevel;
}

/** Human-recognisable prefix so a leaked key is identifiable in logs/greps. */
export function newKey(): string {
  return "hk_" + randomBytes(24).toString("hex");
}

function keysPath(companyId: string): string {
  return path.join(HELIX_COMPANIES, companyId, "api-keys.json");
}

/** Create keys for a company IF it has none. Idempotent — re-onboarding must not
 *  silently rotate a live credential out from under a deployed agent. */
export function ensureKeys(companyId: string): { company: string; owner: string } {
  const p = keysPath(companyId);
  if (fs.existsSync(p)) {
    const existing = JSON.parse(fs.readFileSync(p, "utf8"));
    if (existing.company && existing.owner) return existing;
  }
  const keys = { company: newKey(), owner: newKey() };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(keys, null, 2), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return keys;
}

/** Force new keys (rotation) — returns the new pair. */
export function rotateKeys(companyId: string): { company: string; owner: string } {
  try {
    fs.rmSync(keysPath(companyId));
  } catch {
    /* none to remove */
  }
  return ensureKeys(companyId);
}

const TTL_MS = 10_000;
let cache: { at: number; entries: Array<[string, KeyRecord]> } | null = null;

function build(): Array<[string, KeyRecord]> {
  const entries: Array<[string, KeyRecord]> = [];
  for (const id of listProvisionedCompanies()) {
    try {
      const raw = JSON.parse(fs.readFileSync(keysPath(id), "utf8"));
      if (typeof raw.company === "string" && raw.company)
        entries.push([raw.company, { companyId: id, level: "company" }]);
      if (typeof raw.owner === "string" && raw.owner)
        entries.push([raw.owner, { companyId: id, level: "owner" }]);
    } catch {
      /* company has no keys yet — it simply can't authenticate */
    }
  }
  return entries;
}

function entriesNow(): Array<[string, KeyRecord]> {
  const now = Date.now();
  if (!cache || now - cache.at > TTL_MS) cache = { at: now, entries: build() };
  return cache.entries;
}

/** Constant-time lookup — scans every entry, never returns early. */
export function lookupKey(presented: unknown): KeyRecord | null {
  if (typeof presented !== "string" || presented.length === 0) return null;
  const buf = Buffer.from(presented);
  let hit: KeyRecord | null = null;
  for (const [key, rec] of entriesNow()) {
    const kb = Buffer.from(key);
    if (kb.length === buf.length && timingSafeEqual(kb, buf)) hit = rec;
  }
  return hit;
}

/** Invalidate the cache (used by tests / after issuing keys). */
export function resetKeyCache(): void {
  cache = null;
}
