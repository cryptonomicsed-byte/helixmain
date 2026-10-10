/**
 * extractor — URL→card extraction pipeline with per-field provenance.
 *
 * Steps:
 *   1. fetchPage    – raw fetch with 10s timeout, follow redirects
 *   2. parseDom     – regex/string extraction (no jsdom)
 *   3. extractSocials – map hrefs to platform handles
 *   4. LLM pass    – aiGateway.call() with jsonMode + cot strategy
 *   5. assemble    – build ExtractedCard with ProvenanceEntry per field
 *
 * No external dependencies beyond built-in node fetch and aiGateway.
 */

import { createHash } from "crypto";
import * as path from "path";
import { aiGateway } from "./aiGateway";
import { appendChange, diffCards } from "./changelog";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExtractionRequest {
  url: string;
  orgId: string;
  cardId?: string;       // if updating an existing card
  changelogDir?: string; // defaults to /etc/helix/companies
}

export interface ProvenanceEntry {
  sources: string[];
  confidence: number; // 0.0–1.0
  extractorAgent: string;
  extractedAt: string;
}

export interface ExtractedCard {
  id: string;
  version: number;
  organizationId: string;
  status: "draft";
  createdAt: string;
  identity: {
    name: string;
    elevatorPitch: string;
    tagline: string;
    location: string;
    phone: string;
    website: string;
    values: string[];
    socials: Record<string, string>;
  };
  voice: {
    tone: string[];
    personality: string;
    description: string;
    donts: string[];
  };
  offerings: Array<{
    name: string;
    kind: string;
    price: number | null;
    orderable: boolean;
    confidence: number;
  }>;
  specials: Array<{
    name: string;
    description: string;
    price: number | null;
    valid_from: string | null;
    valid_to: string | null;
  }>;
  operations: {
    hours: string;
    channels: Array<{ type: string; handle: string; verified: boolean }>;
    pipeline_stages: string[];
    response_sla: string;
  };
  policies: Array<{ topic: string; rule: string }>;
  policy_donts: string[];
  knowledge: Array<{ ref: string; kind: string; title: string; chunks: number }>;
  strategy: {
    swot: {
      strengths: string[];
      weaknesses: string[];
      opportunities?: string[];
      threats?: string[];
    };
    positioning: string;
    key_messaging: string[];
  };
  customers: {
    personas: Array<{
      name: string;
      age_range?: string;
      role: string;
      pain_points: string[];
      channels?: string[];
      source: string;
    }>;
  };
  competitors: Array<{ name: string; positioning: string }>;
  // Visual identity — scraped from the site's real CSS/HTML, not inferred by the LLM.
  visual: {
    colors: Array<{ hex: string; name: string; usage: string }>;
    fonts: Array<{ family: string; usage: string }>;
    logoUrl: string;
    ogImage: string;
    ctas: string[];
  };
  field_provenance: Record<string, ProvenanceEntry>;
  confidenceScore: number; // 0–100
}

// ---------------------------------------------------------------------------
// Internal DOM parsed result
// ---------------------------------------------------------------------------

interface ParsedDom {
  title: string;
  metaDesc: string;
  h1s: string[];
  h2s: string[];
  bodyText: string;
  phone: string;
  address: string;
  emails: string[];
  socialLinks: string[];
  hours: string;
  schemaOrg: string;
  visual: VisualExtraction;
}

/** Real visual identity pulled straight from the page's CSS/HTML. */
interface VisualExtraction {
  colors: string[];   // hex, frequency-ordered (brand palette)
  fonts: string[];    // font families, first-in-stack
  ctas: string[];     // button / CTA anchor text
  ogImage: string;
  ogTitle: string;
  logoUrl: string;
  heroImages: string[];
  cssVariables: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Internal LLM extraction shape
// ---------------------------------------------------------------------------

interface LlmExtraction {
  name: string | null;
  elevator_pitch: string | null;
  tagline: string | null;
  location: string | null;
  phone: string | null;
  values: string[];
  tone: string[];
  personality: string | null;
  donts: string[];
  hours: string | null;
  offerings: Array<{
    name: string;
    kind: string;
    price: number | null;
    orderable: boolean;
  }>;
  policies: Array<{ topic: string; rule: string }>;
  positioning: string | null;
  key_messaging: string[];
  strengths: string[];
  weaknesses: string[];
  opportunities: string[];
  threats: string[];
  personas: Array<{
    name: string;
    age_range: string;
    role: string;
    pain_points: string[];
    channels: string[];
  }>;
  competitors: string[];
  confidence: number;
}

const VALID_TONES = [
  "bold", "warm", "playful", "authoritative", "minimal",
  "urgent", "calm", "luxurious", "friendly", "technical",
] as const;

// ---------------------------------------------------------------------------
// 1. fetchPage
// ---------------------------------------------------------------------------

interface FetchResult {
  html: string;
  finalUrl: string;
  statusCode: number;
}

/** Accept a bare domain or brand word ("walmart") and turn it into a fetchable URL. */
export function normalizeUrl(input: string): string {
  let u = (input ?? "").trim();
  if (!u) return u;
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  try {
    const p = new URL(u);
    // A bare single-label host ("walmart") is not resolvable → try .com
    if (!p.hostname.includes(".")) p.hostname = `${p.hostname}.com`;
    return p.toString();
  } catch {
    return u;
  }
}

async function fetchPage(url: string): Promise<FetchResult> {
  const target = normalizeUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(target, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Cache-Control": "no-cache",
      },
    });

    const html = await res.text();
    return {
      html,
      finalUrl: res.url ?? target,
      statusCode: res.status,
    };
  } catch {
    return { html: "", finalUrl: target, statusCode: 0 };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// 2. parseDom — pure regex/string, no jsdom
// ---------------------------------------------------------------------------

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTagText(html: string, tag: string): string[] {
  const results: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = stripTags(m[1]).trim();
    if (text) results.push(text);
  }
  return results;
}

// ---------------------------------------------------------------------------
// 2b. Visual identity extraction
//     Absorbed (reimplemented natively) from the reference family's scraper:
//     real CSS colour palette, font stacks, CTAs, OG image and logo — read
//     straight from the page, never inferred by the LLM. Regex-based so it
//     needs no DOM dependency, matching this file's existing parse style.
// ---------------------------------------------------------------------------

const NAMED_COLORS: Record<string, string> = {
  "#000000": "black", "#FFFFFF": "white", "#FF0000": "red", "#00FF00": "green",
  "#0000FF": "blue", "#FFFF00": "yellow", "#FFA500": "orange", "#800080": "purple",
  "#808080": "gray", "#FFC0CB": "pink", "#00FFFF": "cyan", "#A52A2A": "brown",
};

export function colorName(hex: string): string {
  return NAMED_COLORS[hex.toUpperCase()] ?? hex.toUpperCase();
}

function rgbToHex(rgb: string): string {
  const m = rgb.match(/\d+/g);
  if (!m || m.length < 3) return "#000000";
  return (
    "#" +
    m.slice(0, 3).map((n) => parseInt(n, 10).toString(16).padStart(2, "0")).join("").toUpperCase()
  );
}

/** Expand a 3-digit hex (#abc) to 6-digit form. */
function expand3(hex: string): string {
  const h = hex.slice(1).toUpperCase();
  return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
}

function resolveUrl(src: string, baseUrl: string): string {
  if (!src) return "";
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith("//")) return `https:${src}`;
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return src;
  }
}

/**
 * Fetch up to `limit` same-origin external stylesheets so the colour/font scan
 * can see CSS that modern sites ship in linked files rather than inline <style>.
 * Fail-safe: any error or non-200 is simply skipped.
 */
async function fetchStyleSheets(html: string, baseUrl: string, limit = 2): Promise<string> {
  // Any http(s) stylesheet the page links, minus well-known font/utility CDNs.
  const BLOCK = /fonts\.googleapis|fonts\.gstatic|cdnjs\.cloudflare|jsdelivr|unpkg|bootstrapcdn|fontawesome|typekit/i;
  const hrefs = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)]
    .map((m) => m[0].match(/href=["']([^"']+)["']/i)?.[1] ?? "")
    .map((h) => resolveUrl(h, baseUrl))
    .filter((u) => /^https?:\/\//i.test(u) && !BLOCK.test(u));

  const parts: string[] = [];
  for (const u of [...new Set(hrefs)].slice(0, limit)) {
    try {
      const res = await fetch(u, {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "HelixMain/1.0" },
      });
      if (res.ok) parts.push((await res.text()).slice(0, 200_000));
    } catch {
      // never fatal
    }
  }
  return parts.join("\n");
}

export function extractVisual(html: string, baseUrl = "", externalCss = ""): VisualExtraction {
  // CSS custom properties (inline + external)
  const cssVariables: Record<string, string> = {};
  for (const m of html.matchAll(/(--[\w-]+)\s*:\s*([^;"'}]+)/g)) {
    cssVariables[m[1]] = m[2].trim();
  }
  for (const m of externalCss.matchAll(/(--[\w-]+)\s*:\s*([^;"'}]+)/g)) {
    if (!(m[1] in cssVariables)) cssVariables[m[1]] = m[2].trim();
  }

  // Colour frequency across <style> blocks, inline styles, CSS vars and any
  // external stylesheet text we managed to fetch.
  const freq = new Map<string, number>();
  const bump = (hex: string) => freq.set(hex, (freq.get(hex) ?? 0) + 1);

  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const inlineStyles = [...html.matchAll(/style=["']([^"']*)["']/gi)].map((m) => m[1]);
  for (const css of [...styleBlocks, ...inlineStyles, ...Object.values(cssVariables), externalCss]) {
    for (const m of css.matchAll(/#[0-9A-Fa-f]{6}\b/g)) bump(m[0].toUpperCase());
    for (const m of css.matchAll(/#[0-9A-Fa-f]{3}\b/g)) bump(expand3(m[0]));
  }
  for (const css of [...inlineStyles, externalCss]) {
    for (const m of css.matchAll(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/gi)) bump(rgbToHex(m[0]));
  }

  let colors = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex);
  // Drop default ink/paper when a real palette remains
  const noNeutral = colors.filter((h) => h !== "#FFFFFF" && h !== "#000000");
  if (noNeutral.length >= 3) colors = noNeutral;
  colors = colors.slice(0, 6);

  // Fonts — first family in each stack, minus generic keywords; resolve var()
  const fontSource = externalCss ? `${html}\n${externalCss}` : html;
  const GENERIC = /^(inherit|initial|unset|revert|sans-serif|serif|monospace|cursive|fantasy|system-ui|ui-[\w-]+|emoji|math)$/i;
  const resolveVar = (v: string): string => {
    const m = v.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/);
    if (!m) return v;
    const resolved = cssVariables[m[1]] ?? m[2] ?? "";
    return resolved.split(",")[0].replace(/['"]/g, "").trim();
  };
  const fonts = [...new Set(
    [...fontSource.matchAll(/font-family\s*:\s*([^;"'}]+)/gi)]
      .map((m) => resolveVar(m[1].split(",")[0].replace(/['"]/g, "").trim()))
      .filter((f) => f && !GENERIC.test(f) && f.length < 60 && !f.startsWith("var(")),
  )].slice(0, 3);

  // CTAs — button text + button/cta-styled anchor text
  const ctas: string[] = [];
  for (const m of html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi)) {
    const t = stripTags(m[1]).trim();
    if (t.length > 1 && t.length <= 40) ctas.push(t);
  }
  for (const m of html.matchAll(/<a[^>]+class=["'][^"']*(?:btn|button|cta)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const t = stripTags(m[1]).trim();
    if (t.length > 1 && t.length <= 40) ctas.push(t);
  }

  const meta = (prop: string) =>
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, "i"))?.[1] ??
    "";

  const ogImage = resolveUrl(meta("og:image"), baseUrl);
  const ogTitle = meta("og:title");

  const logoUrl = resolveUrl(
    html.match(/<img[^>]+(?:src|data-src)=["']([^"']*(?:logo|brand)[^"']*)["']/i)?.[1] ?? "",
    baseUrl,
  );

  const heroImages = [...new Set(
    [...html.matchAll(/<img[^>]+(?:src|data-src)=["']([^"']+)["']/gi)]
      .map((m) => m[1])
      .filter((src) => /hero|banner|cover/i.test(src)),
  )].slice(0, 3).map((s) => resolveUrl(s, baseUrl));

  return {
    colors,
    fonts,
    ctas: [...new Set(ctas)].slice(0, 6),
    ogImage,
    ogTitle,
    logoUrl,
    heroImages,
    cssVariables,
  };
}

function parseDom(html: string, baseUrl = ""): ParsedDom {
  // title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]).trim() : "";

  // meta description
  const metaDescMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*?)["']/i,
  ) ?? html.match(
    /<meta[^>]+content=["']([^"']*?)["'][^>]+name=["']description["']/i,
  );
  const metaDesc = metaDescMatch ? metaDescMatch[1].trim() : "";

  // headings
  const h1s = extractTagText(html, "h1");
  const h2s = extractTagText(html, "h2");

  // body text (strip scripts/styles first, then all tags)
  const bodyText = stripTags(html).slice(0, 3000);

  // phone — (XXX) XXX-XXXX or XXX.XXX.XXXX or XXX-XXX-XXXX
  const phoneMatch = bodyText.match(/(\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4})/);
  const phone = phoneMatch ? phoneMatch[1].trim() : "";

  // street address — number + street name pattern
  const addrMatch = bodyText.match(
    /\d{1,6}\s+[A-Za-z0-9\s.,#-]{5,60},\s*[A-Za-z\s]{2,30},?\s*[A-Z]{2}\s*\d{5}/,
  );
  const address = addrMatch ? addrMatch[0].trim() : "";

  // emails
  const emailMatches = bodyText.matchAll(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g);
  const emails = [...new Set([...emailMatches].map((m) => m[0]))];

  // social links from <a href="...">
  const hrefMatches = html.matchAll(/href=["']([^"']*(?:instagram\.com|facebook\.com|twitter\.com|x\.com|tiktok\.com|linkedin\.com)[^"']*)["']/gi);
  const socialLinks = [...new Set([...hrefMatches].map((m) => m[1]))];

  // hours patterns
  const hoursPatterns = [
    /(?:hours?|open|hours of operation)[:\s]*([\w\s,\-–:apmAPM]+?)(?:\.|<|$)/i,
    /(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*[\s\-–]+(?:mon|tue|wed|thu|fri|sat|sun|sun)[a-z]*\s*[\d:apmAPM\s\-–]+/i,
    /\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*[\-–]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)/i,
  ];
  let hours = "";
  for (const pat of hoursPatterns) {
    const m = bodyText.match(pat);
    if (m) {
      hours = m[0].trim().slice(0, 120);
      break;
    }
  }

  // schema.org JSON-LD
  const schemaMatch = html.match(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  const schemaOrg = schemaMatch ? schemaMatch[1].trim() : "";

  return {
    title,
    metaDesc,
    h1s,
    h2s,
    bodyText,
    phone,
    address,
    emails,
    socialLinks,
    hours,
    schemaOrg,
    visual: extractVisual(html, baseUrl),
  };
}

// ---------------------------------------------------------------------------
// 3. extractSocials
// ---------------------------------------------------------------------------

type SocialMap = Record<string, string>;

function extractHandle(href: string): string {
  // Strip trailing slashes, query params, then take last path segment
  const clean = href.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const parts = clean.split("/");
  return parts[parts.length - 1] ?? "";
}

function extractSocials(socialLinks: string[]): SocialMap {
  const socials: SocialMap = {};
  for (const href of socialLinks) {
    const lower = href.toLowerCase();
    if (lower.includes("instagram.com")) {
      socials.instagram = extractHandle(href);
    } else if (lower.includes("facebook.com")) {
      socials.facebook = extractHandle(href);
    } else if (lower.includes("twitter.com")) {
      socials.x = extractHandle(href);
    } else if (lower.includes("x.com")) {
      socials.x = extractHandle(href);
    } else if (lower.includes("tiktok.com")) {
      socials.tiktok = extractHandle(href);
    } else if (lower.includes("linkedin.com")) {
      socials.linkedin = extractHandle(href);
    }
  }
  return socials;
}

// ---------------------------------------------------------------------------
// 4. LLM extraction
// ---------------------------------------------------------------------------

function buildExtractionPrompt(
  url: string,
  dom: ParsedDom,
): string {
  const headings = [...dom.h1s, ...dom.h2s].join(" | ").slice(0, 500);
  return `You are extracting structured business data from a scraped website.
Website URL: ${url}
Page title: ${dom.title}
Meta description: ${dom.metaDesc}
Headings: ${headings}
Page text (first 3000 chars): ${dom.bodyText}
Detected CSS colors: ${dom.visual.colors.join(", ") || "(none)"}
Detected fonts: ${dom.visual.fonts.join(", ") || "(none)"}
Button / CTA text on page: ${dom.visual.ctas.join(" | ") || "(none)"}
${dom.schemaOrg ? `Schema.org JSON-LD: ${dom.schemaOrg.slice(0, 1000)}` : ""}

Extract the following as JSON. If a field cannot be determined from the page, use null or empty array.
Return ONLY this JSON structure:
{
  "name": "business name",
  "elevator_pitch": "1-2 sentence description",
  "tagline": "short tagline if present",
  "location": "full address",
  "phone": "phone number",
  "values": ["value1", "value2"],
  "tone": ["exactly 5 tones from this list only: bold, warm, playful, authoritative, minimal, urgent, calm, luxurious, friendly, technical — ranked by fit, most fitting first"],
  "personality": "one sentence personality description",
  "donts": ["never do 1", "never do 2"],
  "hours": "hours string",
  "offerings": [{"name":"...", "kind":"product|service|food", "price":null, "orderable":true}],
  "policies": [{"topic":"...", "rule":"..."}],
  "positioning": "positioning statement",
  "key_messaging": ["msg1", "msg2"],
  "strengths": ["..."],
  "weaknesses": ["..."],
  "opportunities": ["market opportunities"],
  "threats": ["competitive threats"],
  "personas": [
    {"name": "persona name", "age_range": "25-35", "role": "description", "pain_points": ["..."], "channels": ["instagram","google","word_of_mouth"]},
    {"name": "second persona", "age_range": "35-50", "role": "description", "pain_points": ["..."], "channels": ["facebook","email"]}
  ],
  "competitors": ["competitor name 1", "competitor name 2"],
  "confidence": 0.7
}`;
}

async function callLlm(url: string, dom: ParsedDom): Promise<LlmExtraction | null> {
  const prompt = buildExtractionPrompt(url, dom);
  try {
    const res = await aiGateway.call({
      prompt,
      jsonMode: true,
      strategy: "cot",
      maxTokens: 2048,
    });

    const parsed = JSON.parse(res.text) as Partial<LlmExtraction>;

    // Normalize tone: filter to valid list, pad to 5, slice to 5
    const rawTone = Array.isArray(parsed.tone) ? parsed.tone : [];
    const filteredTone = rawTone.filter((t) =>
      VALID_TONES.includes(t as typeof VALID_TONES[number]),
    );
    while (filteredTone.length < 5) {
      const fallback = VALID_TONES.find((t) => !filteredTone.includes(t));
      if (!fallback) break;
      filteredTone.push(fallback);
    }
    const normalizedTone = filteredTone.slice(0, 5);

    // Normalize personas array
    const rawPersonas = Array.isArray(parsed.personas) ? parsed.personas : [];
    const personas = rawPersonas.map((p: any) => ({
      name:        String(p.name ?? ""),
      age_range:   String(p.age_range ?? ""),
      role:        String(p.role ?? ""),
      pain_points: Array.isArray(p.pain_points) ? p.pain_points.map(String) : [],
      channels:    Array.isArray(p.channels) ? p.channels.map(String) : [],
    }));

    return {
      name: parsed.name ?? null,
      elevator_pitch: parsed.elevator_pitch ?? null,
      tagline: parsed.tagline ?? null,
      location: parsed.location ?? null,
      phone: parsed.phone ?? null,
      values: Array.isArray(parsed.values) ? parsed.values : [],
      tone: normalizedTone,
      personality: parsed.personality ?? null,
      donts: Array.isArray(parsed.donts) ? parsed.donts : [],
      hours: parsed.hours ?? null,
      offerings: Array.isArray(parsed.offerings) ? parsed.offerings : [],
      policies: Array.isArray(parsed.policies) ? parsed.policies : [],
      positioning: parsed.positioning ?? null,
      key_messaging: Array.isArray(parsed.key_messaging) ? parsed.key_messaging : [],
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
      weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [],
      opportunities: Array.isArray(parsed.opportunities) ? parsed.opportunities : [],
      threats: Array.isArray(parsed.threats) ? parsed.threats : [],
      personas,
      competitors: Array.isArray(parsed.competitors) ? parsed.competitors : [],
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 5. Provenance helpers
// ---------------------------------------------------------------------------

const EXTRACTOR_AGENT = "extractor:website";

function prov(
  sources: string[],
  confidence: number,
  extractedAt: string,
): ProvenanceEntry {
  return {
    sources,
    confidence: Math.min(1.0, confidence),
    extractorAgent: EXTRACTOR_AGENT,
    extractedAt,
  };
}

/** Cap inferred/strategy fields at 0.55 and append confirm note */
function inferredProv(
  sources: string[],
  baseConfidence: number,
  extractedAt: string,
): ProvenanceEntry {
  return prov(
    sources.map((s) => `${s} — confirm with owner`),
    Math.min(0.55, baseConfidence),
    extractedAt,
  );
}

// ---------------------------------------------------------------------------
// 6. Card ID generation
// ---------------------------------------------------------------------------

function makeCardId(orgId: string): string {
  const hash = createHash("sha256")
    .update(`${orgId}:${Date.now()}`)
    .digest("hex")
    .slice(0, 8);
  return `dna_${hash}`;
}

// ---------------------------------------------------------------------------
// 7. Fallback card
// ---------------------------------------------------------------------------

function fallbackCard(req: ExtractionRequest): ExtractedCard {
  const now = new Date().toISOString();
  const id = req.cardId ?? makeCardId(req.orgId);
  return {
    id,
    version: 1,
    organizationId: req.orgId,
    status: "draft",
    createdAt: now,
    identity: {
      name: "",
      elevatorPitch:
        "Could not extract data automatically. Please fill in your business details.",
      tagline: "",
      location: "",
      phone: "",
      website: req.url,
      values: [],
      socials: {},
    },
    voice: {
      tone: [],
      personality: "",
      description: "",
      donts: [],
    },
    offerings: [],
    specials: [],
    operations: {
      hours: "",
      channels: [],
      pipeline_stages: [],
      response_sla: "",
    },
    policies: [],
    policy_donts: [],
    knowledge: [],
    strategy: {
      swot: { strengths: [], weaknesses: [] },
      positioning: "",
      key_messaging: [],
    },
    customers: { personas: [] },
    competitors: [],
    visual: { colors: [], fonts: [], logoUrl: "", ogImage: "", ctas: [] },
    field_provenance: {
      "identity.website": prov([req.url], 1.0, now),
    },
    confidenceScore: 40,
  };
}

// ---------------------------------------------------------------------------
// 8. Main assembly
// ---------------------------------------------------------------------------

export async function extractCard(req: ExtractionRequest): Promise<ExtractedCard> {
  const now = new Date().toISOString();
  const id = req.cardId ?? makeCardId(req.orgId);
  const changelogDir = req.changelogDir ?? "/etc/helix/companies";

  // ---- fetch ----
  const fetched = await fetchPage(req.url);
  if (fetched.statusCode === 0) {
    return fallbackCard(req);
  }

  const finalUrl = fetched.finalUrl;

  // ---- DOM parse ----
  const dom = parseDom(fetched.html, finalUrl);
  // Enrich palette/fonts from same-origin stylesheets — modern sites ship CSS
  // in linked files, not inline <style>, so the inline scan alone is thin.
  const externalCss = await fetchStyleSheets(fetched.html, finalUrl).catch(() => "");
  if (externalCss) dom.visual = extractVisual(fetched.html, finalUrl, externalCss);
  const socials = extractSocials(dom.socialLinks);

  // ---- LLM extraction ----
  const llm = await callLlm(finalUrl, dom);
  if (!llm) {
    return { ...fallbackCard(req), id };
  }

  const baseConf = llm.confidence;

  // DOM confidence multiplier: fields confirmed in raw HTML get ×1.2 boost
  const domPhone = dom.phone || llm.phone || "";
  const domAddress = dom.address || llm.location || "";
  const phoneFromDom = Boolean(dom.phone);
  const addressFromDom = Boolean(dom.address);

  // Provenance entries
  const fp: Record<string, ProvenanceEntry> = {};

  fp["identity.name"] = prov([finalUrl], baseConf, now);
  fp["identity.elevatorPitch"] = prov([finalUrl], baseConf, now);
  fp["identity.tagline"] = prov([finalUrl], baseConf * 0.9, now);
  fp["identity.location"] = prov(
    [finalUrl],
    addressFromDom ? Math.min(1.0, baseConf * 1.2) : baseConf,
    now,
  );
  fp["identity.phone"] = prov(
    [finalUrl],
    phoneFromDom ? Math.min(1.0, baseConf * 1.2) : baseConf,
    now,
  );
  fp["identity.website"] = prov([finalUrl], 1.0, now);
  fp["identity.values"] = prov([finalUrl], baseConf * 0.9, now);
  fp["identity.socials"] = prov(
    [finalUrl],
    Object.keys(socials).length > 0 ? Math.min(1.0, baseConf * 1.2) : baseConf * 0.7,
    now,
  );

  fp["voice.tone"] = prov([finalUrl], baseConf, now);
  fp["voice.personality"] = prov([finalUrl], baseConf, now);
  fp["voice.description"] = prov([finalUrl], baseConf * 0.9, now);
  fp["voice.donts"] = prov([finalUrl], baseConf * 0.85, now);

  fp["offerings"] = prov([finalUrl], baseConf * 0.9, now);
  fp["operations.hours"] = prov(
    [finalUrl],
    dom.hours ? Math.min(1.0, baseConf * 1.2) : baseConf * 0.8,
    now,
  );
  fp["operations.channels"] = prov([finalUrl], baseConf * 0.85, now);
  fp["policies"] = prov([finalUrl], baseConf * 0.8, now);

  // Inferred/strategy fields capped at 0.55
  fp["strategy.positioning"] = inferredProv([finalUrl], baseConf, now);
  fp["strategy.key_messaging"] = inferredProv([finalUrl], baseConf, now);
  fp["strategy.swot"] = inferredProv([finalUrl], baseConf * 0.9, now);
  fp["customers.personas"] = inferredProv([finalUrl], baseConf * 0.85, now);
  fp["competitors"] = inferredProv(["category:inference"], 0.4, now);

  // Visual identity — scraped from real CSS/HTML, so high confidence
  if (dom.visual.colors.length > 0) fp["visual.colors"] = prov([finalUrl], 0.9, now);
  if (dom.visual.fonts.length > 0)  fp["visual.fonts"]  = prov([finalUrl], 0.85, now);
  if (dom.visual.logoUrl)           fp["visual.logoUrl"] = prov([finalUrl], 0.95, now);
  if (dom.visual.ogImage)           fp["visual.ogImage"] = prov([finalUrl], 0.95, now);
  if (dom.visual.ctas.length > 0)   fp["visual.ctas"]   = prov([finalUrl], 0.85, now);

  // Overall confidence score 0–100
  const fieldConfs = Object.values(fp).map((p) => p.confidence);
  const avgConf = fieldConfs.reduce((s, c) => s + c, 0) / fieldConfs.length;
  const confidenceScore = Math.round(avgConf * 100);

  // Build channels list from socials + emails
  const channels: Array<{ type: string; handle: string; verified: boolean }> = [];
  for (const [platform, handle] of Object.entries(socials)) {
    if (handle) channels.push({ type: platform, handle, verified: false });
  }
  for (const email of dom.emails) {
    channels.push({ type: "email", handle: email, verified: false });
  }
  if (domPhone) {
    channels.push({ type: "phone", handle: domPhone, verified: false });
  }

  // Offerings — use LLM result, fill confidence
  const offerings = llm.offerings.map((o) => ({
    name: o.name ?? "",
    kind: o.kind ?? "service",
    price: o.price ?? null,
    orderable: o.orderable ?? false,
    confidence: baseConf * 0.9,
  }));

  // Competitors with inferred note
  const competitors = llm.competitors.map((name) => ({
    name: typeof name === "string" ? name : String(name),
    positioning: `inferred from category — confirm with owner`,
  }));

  // Personas — map multi-persona array from LLM
  const personas = llm.personas.map((p) => ({
    name:        p.name,
    age_range:   p.age_range,
    role:        p.role,
    pain_points: p.pain_points,
    channels:    p.channels,
    source:      `category:inference — confirm with owner`,
  }));

  const card: ExtractedCard = {
    id,
    version: 1,
    organizationId: req.orgId,
    status: "draft",
    createdAt: now,
    identity: {
      name: llm.name ?? dom.title,
      elevatorPitch: llm.elevator_pitch ?? dom.metaDesc ?? "",
      tagline: llm.tagline ?? "",
      location: domAddress || llm.location || "",
      phone: domPhone,
      website: finalUrl,
      values: llm.values,
      socials,
    },
    voice: {
      tone: llm.tone,
      personality: llm.personality ?? "",
      description: llm.personality ?? "",
      donts: llm.donts,
    },
    offerings,
    specials: [],
    operations: {
      hours: dom.hours || llm.hours || "",
      channels,
      pipeline_stages: [],
      response_sla: "",
    },
    policies: llm.policies,
    policy_donts: llm.donts,
    knowledge: [
      {
        ref: finalUrl,
        kind: "website",
        title: dom.title || finalUrl,
        chunks: 1,
      },
    ],
    strategy: {
      swot: {
        strengths:     llm.strengths,
        weaknesses:    llm.weaknesses,
        opportunities: llm.opportunities,
        threats:       llm.threats,
      },
      positioning: llm.positioning ?? "",
      key_messaging: llm.key_messaging,
    },
    customers: { personas },
    competitors,
    visual: {
      colors: dom.visual.colors.map((hex) => ({ hex, name: colorName(hex), usage: "" })),
      fonts: dom.visual.fonts.map((family) => ({ family, usage: "" })),
      logoUrl: dom.visual.logoUrl,
      ogImage: dom.visual.ogImage,
      ctas: dom.visual.ctas,
    },
    field_provenance: fp,
    confidenceScore,
  };

  // Append changelog entry — fire-and-forget, never throws
  (async () => {
    try {
      const changelogPath = path.join(changelogDir, req.orgId, "changelog.json");
      const fieldsChanged = diffCards({}, card as unknown as Record<string, unknown>);
      await appendChange(
        changelogPath,
        card.id,
        req.orgId,
        fieldsChanged.length > 0 ? fieldsChanged : ["*"],
        "inferred",
        "extractor",
        `Extracted from ${req.url}`,
      );
    } catch {
      // changelog write failure must never break extraction
    }
  })();

  return card;
}

export const extractor = { extractCard, normalizeUrl };
