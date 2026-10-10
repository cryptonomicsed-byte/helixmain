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
