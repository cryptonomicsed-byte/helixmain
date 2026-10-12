/**
 * landings.ts — per-card LANDING PAGES, additive.
 *
 * A card already has ONE page in the public directory: the Hugo page at
 * /b/<id>/, derived from the card and rebuilt whenever the card changes. That
 * page IS the directory entry.
 *
 * A landing page is a SEPARATE, additive artifact. The owner can create many.
 * Each is served at /l/<id>/<slug>/ and shows up as its own tab + QR beside the
 * rest. Creating one NEVER touches the directory page — the two live in
 * different trees (b/ vs l/) and different stores, so a landing that goes wrong
 * cannot take the directory entry with it. That separation is the whole point.
 *
 * CRITICAL: infra/site-publish.sh rsyncs public/ -> the web root with --delete,
 * so the web root's /l tree must be EXCLUDED there or every card publish would
 * erase every landing page. That exclude is part of this feature, not a detail.
 */
import * as fs from "fs";
import * as path from "path";

export const COMPANIES = process.env.HELIX_CARD_ROOT || "/etc/helix/companies";
export const WEB_ROOT = process.env.HELIX_SITE_ROOT || "/var/www/helixmain-site";

export interface LandingPage {
  slug: string;
  title: string;
  /** Public path, e.g. /l/demo-barber/summer-menu/ */
  url: string;
  createdAt: string;
}

function storeDir(companyId: string): string {
  return path.join(COMPANIES, companyId, "landings");
}

function safe(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug);
}

export function listLandings(companyId: string): LandingPage[] {
  try {
    return fs
      .readdirSync(storeDir(companyId))
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const r = JSON.parse(fs.readFileSync(path.join(storeDir(companyId), f), "utf8")) as LandingPage;
        return { slug: r.slug, title: r.title, url: r.url, createdAt: r.createdAt };
      })
      .filter((l) => safe(l.slug))
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  } catch {
    return [];
  }
}

/** First free slug: base, base-2, base-3 … against the ones already present. */
export function uniqueLandingSlug(base: string, taken: string[]): string {
  const root = safe(base) ? base : "landing";
  const set = new Set(taken);
  if (!set.has(root)) return root;
  for (let n = 2; n < 500; n++) {
    const cand = `${root}-${n}`.slice(0, 63);
    if (!set.has(cand)) return cand;
  }
  return `${root}-${Date.now().toString(36)}`.slice(0, 63);
}

export function slugifyTitle(title: string): string {
  return (title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function saveLanding(
  companyId: string,
  slug: string,
  title: string,
  html: string,
): LandingPage {
  if (!safe(slug)) throw new Error("bad landing slug");
  const store = storeDir(companyId);
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  // The served file — its own tree, untouched by the site build.
  const served = path.join(WEB_ROOT, "l", companyId, slug);
  fs.mkdirSync(served, { recursive: true });
  fs.writeFileSync(path.join(served, "index.html"), html);
  const rec: LandingPage = {
    slug,
    title,
    url: `/l/${companyId}/${slug}/`,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(store, `${slug}.json`), JSON.stringify(rec, null, 2), { mode: 0o600 });
  return rec;
}

export function deleteLanding(companyId: string, slug: string): boolean {
  if (!safe(slug)) return false;
  let ok = false;
  try {
    fs.rmSync(path.join(storeDir(companyId), `${slug}.json`));
    ok = true;
  } catch {
    /* not in the store */
  }
  try {
    fs.rmSync(path.join(WEB_ROOT, "l", companyId, slug), { recursive: true, force: true });
  } catch {
    /* nothing served */
  }
  return ok;
}
