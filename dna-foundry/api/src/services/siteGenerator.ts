/**
 * siteGenerator — generates a single-file HTML landing page from a BrandDNA card.
 * The HTML is stored in memory and persisted to disk for serving via GET /site/:companyId.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { aiGateway } from "./aiGateway";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SiteGenerateResult {
  companyId: string;
  html: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const siteStore = new Map<string, SiteGenerateResult>();

// ---------------------------------------------------------------------------
// Disk persistence
// ---------------------------------------------------------------------------

const SITES_PATH = process.env.HELIX_SITES_PATH ?? "/etc/helix/data/sites.json";

export async function loadSiteStore(): Promise<void> {
  try {
    const raw = await fs.readFile(SITES_PATH, "utf8");
    const entries = JSON.parse(raw) as Array<[string, SiteGenerateResult]>;
    for (const [id, site] of entries) siteStore.set(id, site);
  } catch {
    // file may not exist on first run — silently skip
  }
}

async function saveSiteStore(): Promise<void> {
  try {
    const dir = path.dirname(SITES_PATH);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(SITES_PATH, JSON.stringify(Array.from(siteStore.entries()), null, 2));
  } catch {
    // never throw to caller
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cardName(card: any): string {
  return card?.identity?.name ?? card?.name?.value ?? "Our Business";
}

function cardTagline(card: any): string {
  return card?.identity?.tagline ?? card?.tagline ?? "";
}

function cardElevatorPitch(card: any): string {
  return card?.identity?.elevatorPitch ?? card?.elevator_pitch ?? card?.description ?? "";
}

function cardPhone(card: any): string {
  return card?.phone?.value ?? card?.phone ?? "";
}

function cardAddress(card: any): string {
  return card?.address?.value ?? card?.address ?? "";
}

function cardHours(card: any): string {
  return card?.hours?.value ?? card?.hours ?? "";
}

function cardTone(card: any): string {
  const tone = card?.voice?.tone;
  if (Array.isArray(tone)) return tone.join(", ");
  return String(tone ?? "professional and welcoming");
}

function cardOfferings(card: any): Array<{ name: string; description: string }> {
  const raw: any[] = card?.offerings ?? [];
  return raw.map((o: any) => ({
    name:        String(o.name ?? o ?? ""),
    description: String(o.description ?? o.detail ?? ""),
  }));
}

// ---------------------------------------------------------------------------
// generateWebsite
// ---------------------------------------------------------------------------

export async function generateWebsite(
  card: any,
  companyId: string,
): Promise<SiteGenerateResult> {
  const name        = cardName(card);
  const tagline     = cardTagline(card);
  const pitch       = cardElevatorPitch(card);
  const phone       = cardPhone(card);
  const address     = cardAddress(card);
  const hours       = cardHours(card);
  const tone        = cardTone(card);
  const offerings   = cardOfferings(card);

  const offeringsList = offerings.length
    ? offerings.map((o) => `- ${o.name}${o.description ? `: ${o.description}` : ""}`).join("\n")
    : "- Our services";

  const prompt = `You are a professional web designer. Generate a complete, modern, single-file HTML landing page for this business.

Business Details:
- Name: ${name}
- Tagline: ${tagline || "Excellence in every interaction"}
- About: ${pitch || "We are dedicated to serving our community with quality and care."}
- Phone: ${phone || "Contact us for details"}
- Address: ${address || ""}
- Hours: ${hours || ""}
- Voice / tone: ${tone}
- Offerings:
${offeringsList}

Requirements:
1. Hero section: large business name, tagline, and a "Contact Us" CTA button
2. Offerings grid: display each offering as a card with name and description
3. Contact block: phone, address, and hours in a clean layout
4. Full inline CSS (no external stylesheets, no CDN links)
5. Responsive design using CSS flexbox/grid
6. Color scheme and typography should match the voice tone: "${tone}"
7. No JavaScript required — pure HTML + CSS only
8. Include a <meta viewport> tag and a <title> tag

Return ONLY the complete HTML document starting with <!DOCTYPE html>. No markdown, no code fences, no explanation.`;

  const res = await aiGateway.call({
    prompt,
    systemPrompt:
      "You are a professional web designer. Return ONLY a complete HTML document. No markdown, no code fences, no explanation whatsoever.",
    jsonMode: false,
    temperature: 0.6,
    maxTokens: 4000,
  });

  // Strip any accidental markdown fences the LLM might add
  let html = res.text.trim();
  if (html.startsWith("```")) {
    html = html.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim();
  }

  // Ensure it starts with a doctype (fallback wrapper if LLM returns partial)
  if (!html.toLowerCase().startsWith("<!doctype")) {
    html = `<!DOCTYPE html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title></head><body>${html}</body></html>`;
  }

  const result: SiteGenerateResult = {
    companyId,
    html,
    generatedAt: new Date().toISOString(),
  };

  siteStore.set(companyId, result);
  saveSiteStore().catch(() => {});
  return result;
}

// ---------------------------------------------------------------------------
// getWebsite / listSites
// ---------------------------------------------------------------------------

export function getWebsite(companyId: string): SiteGenerateResult | null {
  return siteStore.get(companyId) ?? null;
}

export function listSites(): string[] {
  return Array.from(siteStore.keys());
}
