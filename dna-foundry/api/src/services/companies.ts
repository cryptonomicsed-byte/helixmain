/**
 * companies.ts — the ONE place that decides what counts as an onboarded company.
 *
 * A company is onboarded iff its card exists on disk (<HELIX_COMPANIES>/<id>/card.json).
 * Everything that must never act on an arbitrary, caller-supplied id — API auth and
 * credit accounts — asks here instead of trusting the request body.
 */
import * as fs from "fs";
import * as path from "path";

export const HELIX_COMPANIES = process.env.HELIX_CARD_ROOT || "/etc/helix/companies";

/** Company ids are slugs — keep the same rule onboarding enforces. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isOnboardedCompany(companyId: unknown): boolean {
  if (typeof companyId !== "string" || !SLUG.test(companyId)) return false;
  return fs.existsSync(path.join(HELIX_COMPANIES, companyId, "card.json"));
}

export function companyCardPath(companyId: string): string {
  return path.join(HELIX_COMPANIES, companyId, "card.json");
}

export function companyKeysPath(companyId: string): string {
  return path.join(HELIX_COMPANIES, companyId, "api-keys.json");
}

/**
 * PROVISIONED vs ONBOARDED — and why the distinction had to exist.
 *
 * onboarded  = <id>/card.json exists. The card is the product.
 * provisioned = <id>/api-keys.json exists: the company has an identity and
 *              credentials, whether or not a card has been made yet.
 *
 * Self-serve signup creates exactly the provisioned state. Before this, key
 * lookup and credit accounts keyed off `card.json`, which meant a person who had
 * just signed up could not authenticate and could not hold credits until a card
 * existed — and creating the card is the thing they sign up TO DO. The flow was
 * circular by construction.
 *
 * Provisioned is a strict superset of onboarded, so treating it as the trust
 * boundary is only ever stricter than before: every company that used to be
 * recognised still is.
 */
export function isProvisionedCompany(companyId: unknown): boolean {
  if (typeof companyId !== "string" || !SLUG.test(companyId)) return false;
  return fs.existsSync(companyKeysPath(companyId));
}

export function listProvisionedCompanies(): string[] {
  try {
    return fs
      .readdirSync(HELIX_COMPANIES, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(companyKeysPath(e.name)))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Business name -> slug, using the same rule onboarding enforces (SLUG above).
 * Deliberately conservative: self-serve slugs become directory names, WebAuthn
 * user handles, and URL path segments, so anything outside [a-z0-9-] is dropped
 * rather than escaped.
 */
export function slugify(name: string): string {
  const base = (name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents: "Café" -> "Cafe"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return /^[a-z0-9]/.test(base) ? base : `biz-${base}`.slice(0, 48);
}

/** First free slug: base, then base-2, base-3... Never collides with a taken
 *  directory OR a pending (unverified) signup, so two people signing up at once
 *  cannot both be handed the same slug. */
export function uniqueSlug(base: string, alsoReserved: Iterable<string> = []): string {
  const taken = new Set<string>([...listProvisionedCompanies(), ...alsoReserved]);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n++) {
    const cand = `${base}-${n}`.slice(0, 63);
    if (!taken.has(cand)) return cand;
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 63);
}

export function listOnboardedCompanies(): string[] {
  try {
    return fs
      .readdirSync(HELIX_COMPANIES, { withFileTypes: true })
      .filter(
        (e) => e.isDirectory() && fs.existsSync(path.join(HELIX_COMPANIES, e.name, "card.json"))
      )
      .map((e) => e.name);
  } catch {
    return [];
  }
}
