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
      role: string;
      pain_points: string[];
      source: string;
    }>;
  };
  competitors: Array<{ name: string; positioning: string }>;
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
  persona_name: string | null;
  persona_role: string | null;
  persona_pain_points: string[];
  competitors: string[];
  confidence: number;
}

// ---------------------------------------------------------------------------
// 1. fetchPage
// ---------------------------------------------------------------------------

interface FetchResult {
  html: string;
  finalUrl: string;
  statusCode: number;
}

async function fetchPage(url: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, {
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
      finalUrl: res.url ?? url,
      statusCode: res.status,
    };
  } catch {
    return { html: "", finalUrl: url, statusCode: 0 };
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

function parseDom(html: string): ParsedDom {
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
  "tone": ["tone1", "tone2", "tone3"],
  "personality": "one sentence personality description",
  "donts": ["never do 1", "never do 2"],
  "hours": "hours string",
  "offerings": [{"name":"...", "kind":"product|service|food", "price":null, "orderable":true}],
  "policies": [{"topic":"...", "rule":"..."}],
  "positioning": "positioning statement",
  "key_messaging": ["msg1", "msg2"],
  "strengths": ["..."],
  "weaknesses": ["..."],
  "persona_name": "typical customer persona name",
  "persona_role": "persona description",
  "persona_pain_points": ["pain point 1"],
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

    return {
      name: parsed.name ?? null,
      elevator_pitch: parsed.elevator_pitch ?? null,
      tagline: parsed.tagline ?? null,
      location: parsed.location ?? null,
      phone: parsed.phone ?? null,
      values: Array.isArray(parsed.values) ? parsed.values : [],
      tone: Array.isArray(parsed.tone) ? parsed.tone : [],
      personality: parsed.personality ?? null,
      donts: Array.isArray(parsed.donts) ? parsed.donts : [],
      hours: parsed.hours ?? null,
      offerings: Array.isArray(parsed.offerings) ? parsed.offerings : [],
      policies: Array.isArray(parsed.policies) ? parsed.policies : [],
      positioning: parsed.positioning ?? null,
      key_messaging: Array.isArray(parsed.key_messaging) ? parsed.key_messaging : [],
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
      weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [],
      persona_name: parsed.persona_name ?? null,
      persona_role: parsed.persona_role ?? null,
      persona_pain_points: Array.isArray(parsed.persona_pain_points)
        ? parsed.persona_pain_points
        : [],
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
  const dom = parseDom(fetched.html);
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

  // Persona
  const personas =
    llm.persona_name
      ? [
          {
            name: llm.persona_name,
            role: llm.persona_role ?? "",
            pain_points: llm.persona_pain_points,
            source: `category:inference — confirm with owner`,
          },
        ]
      : [];

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
        strengths: llm.strengths,
        weaknesses: llm.weaknesses,
      },
      positioning: llm.positioning ?? "",
      key_messaging: llm.key_messaging,
    },
    customers: { personas },
    competitors,
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

export const extractor = { extractCard };
