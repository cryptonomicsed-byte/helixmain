/**
 * portfolio — aggregates all assets produced for a company into a single list.
 *
 * Reads from: contentPipeline (assets/PRDs), businessPlan (plans),
 *             siteGenerator (sites), sonicBranding (jingles), and the
 *             card files on disk (cards).
 */

import * as fs from "fs";
import * as path from "path";
import { assetStore, prdStore } from "./contentPipeline";
import { planStore, type BusinessPlan } from "./businessPlan";
import { getWebsite } from "./siteGenerator";
import { getJingle } from "./sonicBranding";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PortfolioAsset {
  id: string;
  companyId: string;
  type: "card" | "campaign_asset" | "plan" | "site" | "jingle";
  name: string;
  createdAt: string;
  previewText?: string;
  downloadUrl?: string;
}

// ---------------------------------------------------------------------------
// Paths — mirrors index.ts
// ---------------------------------------------------------------------------

const HELIX_COMPANIES = process.env.HELIX_CARD_ROOT || "/etc/helix/companies";
const ROOT = path.resolve(__dirname, "..", "..", "..");
const CARDS = path.join(ROOT, "api", "data", "cards");

// ---------------------------------------------------------------------------
// buildPortfolio
// ---------------------------------------------------------------------------

export function buildPortfolio(companyId: string): PortfolioAsset[] {
  const assets: PortfolioAsset[] = [];

  // -- Cards ----------------------------------------------------------------
  // 1. /etc/helix/companies/{companyId}/card.json
  const helixCardPath = path.join(HELIX_COMPANIES, companyId, "card.json");
  try {
    const raw = fs.readFileSync(helixCardPath, "utf8");
    const card = JSON.parse(raw);
    assets.push({
      id:          `card:helix:${companyId}`,
      companyId,
      type:        "card",
      name:        card?.identity?.name ?? card?.name?.value ?? companyId,
      createdAt:   card?.created_at ?? new Date().toISOString(),
      previewText: card?.identity?.tagline ?? card?.tagline ?? undefined,
    });
  } catch {
    // card may not exist at this path — try data/cards/ below
  }

  // 2. api/data/cards/ — any files starting with companyId
  try {
    const files = fs.readdirSync(CARDS);
    const hits = files.filter((f) => f.startsWith(companyId) && f.endsWith(".json")).sort();
    for (const f of hits) {
      try {
        const raw = fs.readFileSync(path.join(CARDS, f), "utf8");
        const card = JSON.parse(raw);
        const cardId = card?.id ?? card?.org_id ?? f.replace(/\.json$/, "");
        // avoid duplicate if already added from helix path
        if (!assets.find((a) => a.type === "card" && a.companyId === companyId)) {
          assets.push({
            id:          `card:extracted:${cardId}`,
            companyId,
            type:        "card",
            name:        card?.identity?.name ?? card?.name?.value ?? cardId,
            createdAt:   card?.created_at ?? new Date().toISOString(),
            previewText: card?.identity?.tagline ?? undefined,
          });
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // CARDS dir may not exist yet
  }

  // -- Campaign assets -------------------------------------------------------
  // Find all PRDs belonging to this company, then collect their assets.
  const companyPrdIds = new Set<string>();
  for (const [prdId, prd] of prdStore.entries()) {
    if (prd.companyId === companyId) companyPrdIds.add(prdId);
  }

  for (const [, asset] of assetStore.entries()) {
    if (!companyPrdIds.has(asset.campaignId)) continue;
    assets.push({
      id:          asset.id,
      companyId,
      type:        "campaign_asset",
      name:        `${asset.assetType} — ${asset.channel}`,
      createdAt:   asset.createdAt,
      previewText: asset.text.slice(0, 120) || undefined,
      downloadUrl: `/api/content/campaign/${asset.campaignId}/zip`,
    });
  }

  // -- Business plan ---------------------------------------------------------
  const plan: BusinessPlan | undefined = planStore.get(`latest:${companyId}`);
  if (plan) {
    assets.push({
      id:          `plan:${companyId}`,
      companyId,
      type:        "plan",
      name:        "Business Plan",
      createdAt:   plan.generatedAt,
      previewText: plan.sections.executiveSummary.slice(0, 120) || undefined,
      downloadUrl: `/api/plan/${companyId}/export`,
    });
  }

  // -- Site ------------------------------------------------------------------
  const site = getWebsite(companyId);
  if (site) {
    assets.push({
      id:          `site:${companyId}`,
      companyId,
      type:        "site",
      name:        "Landing Page",
      createdAt:   site.generatedAt,
      previewText: "Generated HTML landing page",
      downloadUrl: `/api/site/${companyId}`,
    });
  }

  // -- Jingle ----------------------------------------------------------------
  const jingle = getJingle(companyId);
  if (jingle) {
    assets.push({
      id:          `jingle:${companyId}`,
      companyId,
      type:        "jingle",
      name:        "Brand Jingle",
      createdAt:   jingle.generatedAt,
      previewText: jingle.voiceScript,
    });
  }

  return assets;
}
