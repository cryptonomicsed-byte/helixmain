/**
 * salesPipeline — lead hunting, qualification, closer portfolio, CRM-lite.
 *
 * All outreach sends are H-gated through SparkGatekeeper:
 *   submitOutreachForApproval() POSTs to localhost:9100/hold and returns a holdQueueId.
 *   Email is NEVER sent directly from this service.
 *
 * Sources:
 *   - Apollo.io (POST /api/v1/mixed_companies/search)
 *   - hunter.io  (GET /v2/domain-search) — requires HUNTER_API_KEY
 *   - OSM/Overpass  (POST https://overpass-api.de/api/interpreter)
 *   - places / manual — caller-supplied leads
 */

import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { aiGateway } from "./aiGateway";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LeadStatus = "new" | "contacted" | "qualified" | "converted" | "lost";

export interface Lead {
  id: string;
  companyId: string;          // which HelixMain company this lead belongs to
  name: string;
  email: string;
  phone?: string;
  company?: string;
  website?: string;
  source: "apollo" | "hunter" | "places" | "manual" | "osm";
  status: LeadStatus;
  score: number;              // 0-100
  tier?: "hot" | "warm" | "cold" | "disqualified";
  signals: string[];          // qualification signals
  notes: string[];
  activityLog: ActivityEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface ActivityEntry {
  timestamp: string;
  type: "created" | "status_change" | "note" | "outreach_draft" | "email_sent" | "call";
  detail: string;
}

export interface OutreachDraft {
  leadId: string;
  subjectLine: string;
  emailBody: string;
  closingScript: string;
  objectionRebuttals: Record<string, string>; // objection → rebuttal
  followUpSequence: string[];                 // 3 follow-up messages
  holdQueueId?: string;                       // set when submitted to SparkGatekeeper
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const leadStore = new Map<string, Lead>();

// ---------------------------------------------------------------------------
// Disk persistence
// ---------------------------------------------------------------------------

const LEADS_PATH = process.env.HELIX_LEADS_PATH ?? "/etc/helix/data/leads.json";

export async function loadLeadStore(): Promise<void> {
  try {
    const raw = await fs.readFile(LEADS_PATH, "utf8");
    const data = JSON.parse(raw) as Array<[string, Lead]>;
    for (const [id, lead] of data) {
      leadStore.set(id, lead);
    }
  } catch {
    // file may not exist on first run — silently skip
  }
}

async function saveLeadStore(): Promise<void> {
  try {
    const dir = path.dirname(LEADS_PATH);
    await fs.mkdir(dir, { recursive: true });
    const data = Array.from(leadStore.entries());
    await fs.writeFile(LEADS_PATH, JSON.stringify(data, null, 2));
  } catch {
    // never throw to caller
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}

function makeActivity(
  type: ActivityEntry["type"],
  detail: string,
): ActivityEntry {
  return { timestamp: now(), type, detail };
}

// ---------------------------------------------------------------------------
// Lead hunting — Apollo.io
// ---------------------------------------------------------------------------

export async function huntLeadsApollo(
  companyId: string,
  card: any,
  filters: {
    industry?: string;
    location?: string;
    size?: string;
    keywords?: string[];
  },
): Promise<Lead[]> {
  const apiKey = process.env.APOLLO_API_KEY ?? "";
  if (!apiKey) {
    console.warn("[salesPipeline] APOLLO_API_KEY not set — skipping Apollo hunt");
    return [];
  }

  let raw: any;
  try {
    const res = await fetch("https://api.apollo.io/api/v1/mixed_companies/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify({
        q_organization_keywords: filters.keywords ?? [card?.identity?.name ?? ""],
        organization_locations: filters.location ? [filters.location] : [],
        num_page: 1,
        per_page: 10,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[salesPipeline] Apollo API ${res.status}: ${text.slice(0, 300)}`);
      return [];
    }

    raw = await res.json();
  } catch (err) {
    console.warn("[salesPipeline] Apollo fetch error:", err);
    return [];
  }

  const orgs: any[] = raw?.organizations ?? [];

  const leads: Lead[] = orgs.map((org: any) => {
    const contact = org?.contact_emails?.[0] ?? {};
    const lead: Lead = {
      id: randomUUID(),
      companyId,
      name: org.name ?? org.primary_domain ?? "Unknown",
      email: contact.email ?? org.email ?? "",
      phone: org.phone ?? undefined,
      company: org.name ?? undefined,
      website: org.website_url ?? org.primary_domain ?? undefined,
      source: "apollo",
      status: "new",
      score: 0,
      signals: [],
      notes: [],
      activityLog: [makeActivity("created", `Hunted via Apollo.io — org: ${org.name ?? ""}`)],
      createdAt: now(),
      updatedAt: now(),
    };
    leadStore.set(lead.id, lead);
    saveLeadStore().catch(() => {});
    return lead;
  });

  return leads;
}

// ---------------------------------------------------------------------------
// Lead hunting — hunter.io (bonus source, H-gate safe, read-only)
// ---------------------------------------------------------------------------

export async function huntLeadsHunter(
  companyId: string,
  domain: string,
): Promise<Lead[]> {
  const apiKey = process.env.HUNTER_API_KEY ?? "";
  if (!apiKey) {
    console.warn("[salesPipeline] HUNTER_API_KEY not set — skipping hunter.io hunt");
    return [];
  }

  let raw: any;
  try {
    const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${encodeURIComponent(apiKey)}&limit=10`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[salesPipeline] Hunter API ${res.status}: ${text.slice(0, 300)}`);
      return [];
    }
    raw = await res.json();
  } catch (err) {
    console.warn("[salesPipeline] Hunter fetch error:", err);
    return [];
  }

  const emails: any[] = raw?.data?.emails ?? [];

  const leads: Lead[] = emails.map((e: any) => {
    const lead: Lead = {
      id: randomUUID(),
      companyId,
      name: [e.first_name, e.last_name].filter(Boolean).join(" ") || e.value,
      email: e.value ?? "",
      company: raw?.data?.organization ?? domain,
      website: `https://${domain}`,
      source: "hunter",
      status: "new",
      score: 0,
      signals: [],
      notes: [],
      activityLog: [
        makeActivity("created", `Hunted via hunter.io — domain: ${domain}`),
      ],
      createdAt: now(),
      updatedAt: now(),
    };
    leadStore.set(lead.id, lead);
    saveLeadStore().catch(() => {});
    return lead;
  });

  return leads;
}

// ---------------------------------------------------------------------------
// Lead hunting — OpenStreetMap / Overpass API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// OSM industry → Overpass tag map
// ---------------------------------------------------------------------------

const OSM_TAG_MAP: Record<string, string[]> = {
  barber:      ["shop=hairdresser", "shop=barber"],
  hair:        ["shop=hairdresser"],
  restaurant:  ["amenity=restaurant", "amenity=fast_food"],
  cafe:        ["amenity=cafe"],
  coffee:      ["amenity=cafe"],
  pizza:       ["amenity=restaurant", "amenity=fast_food"],
  bar:         ["amenity=bar", "amenity=pub"],
  gym:         ["leisure=fitness_centre", "amenity=gym"],
  dentist:     ["amenity=dentist"],
  doctor:      ["amenity=doctors"],
  pharmacy:    ["amenity=pharmacy"],
  hotel:       ["tourism=hotel"],
  shop:        ["shop=*"],
  retail:      ["shop=*"],
  salon:       ["shop=beauty"],
  nail:        ["shop=nail_salon"],
  laundry:     ["shop=laundry", "shop=dry_cleaning"],
  auto:        ["shop=car_repair", "amenity=car_wash"],
  plumber:     ["craft=plumber"],
  electrician: ["craft=electrician"],
  florist:     ["shop=florist"],
  bakery:      ["shop=bakery"],
};

export interface OsmFilters {
  lat: number;
  lng: number;
  industry: string;
  radiusMeters?: number;
  companyId: string;
}

async function scoreDigitalFootprint(website: string): Promise<number> {
  try {
    const headRes = await fetch(website, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    if (!headRes.ok) return 30;
    try {
      const getRes = await fetch(website, {
        method: "GET",
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "HelixMain/1.0" },
      });
      if (!getRes.ok) return 60;
      const html = await getRes.text();
      const hasSocial =
        /instagram\.com|facebook\.com|twitter\.com|x\.com|tiktok\.com|linkedin\.com/i.test(html);
      return hasSocial ? 100 : 60;
    } catch {
      return 60; // HEAD ok but GET failed — site is live, just no social detected
    }
  } catch {
    return 30;
  }
}

export async function huntLeadsOSM(filters: OsmFilters): Promise<Lead[]> {
  const radiusMeters = filters.radiusMeters ?? 5000;
  const { lat, lng, industry, companyId } = filters;

  // Convert radius to approximate degree offset for Nominatim bounding box
  // 1 degree lat ≈ 111km, 1 degree lon ≈ 111km * cos(lat)
  const latDelta = radiusMeters / 111_000;
  const lngDelta = radiusMeters / (111_000 * Math.cos((lat * Math.PI) / 180));
  const viewbox = `${lng - lngDelta},${lat + latDelta},${lng + lngDelta},${lat - latDelta}`;

  // Map industry to OSM amenity/shop tags for Nominatim
  const key = industry.toLowerCase();
  const osmTags = OSM_TAG_MAP[key] ?? [];

  // Extract unique amenity/shop values to query Nominatim
  const amenityValues = osmTags
    .filter((t) => t.startsWith("amenity="))
    .map((t) => t.split("=")[1])
    .filter((v) => v && v !== "*");
  const shopValues = osmTags
    .filter((t) => t.startsWith("shop="))
    .map((t) => t.split("=")[1])
    .filter((v) => v && v !== "*");
  const leisureValues = osmTags
    .filter((t) => t.startsWith("leisure="))
    .map((t) => t.split("=")[1])
    .filter((v) => v && v !== "*");
  const craftValues = osmTags
    .filter((t) => t.startsWith("craft="))
    .map((t) => t.split("=")[1])
    .filter((v) => v && v !== "*");

  // Build Nominatim queries — one per tag type, collect all results
  interface NominatimResult {
    place_id: number;
    display_name: string;
    lat: string;
    lon: string;
    type: string;
    class: string;
    address?: Record<string, string>;
    extratags?: Record<string, string>;
  }

  const allResults: NominatimResult[] = [];

  const nominatimFetch = async (params: string): Promise<NominatimResult[]> => {
    const url = `https://nominatim.openstreetmap.org/search?${params}&format=json&limit=20&bounded=1&viewbox=${viewbox}&addressdetails=1&extratags=1`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "HelixMain/1.0 (helixmain.duckdns.org)" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];
      return (await res.json()) as NominatimResult[];
    } catch {
      return [];
    }
  };

  // Fire queries in parallel
  const queries: Promise<NominatimResult[]>[] = [];

  if (amenityValues.length > 0) {
    for (const v of amenityValues) queries.push(nominatimFetch(`amenity=${encodeURIComponent(v)}`));
  }
  if (shopValues.length > 0) {
    for (const v of shopValues) queries.push(nominatimFetch(`shop=${encodeURIComponent(v)}`));
  }
  if (leisureValues.length > 0) {
    for (const v of leisureValues) queries.push(nominatimFetch(`leisure=${encodeURIComponent(v)}`));
  }
  if (craftValues.length > 0) {
    for (const v of craftValues) queries.push(nominatimFetch(`craft=${encodeURIComponent(v)}`));
  }
  // Always also do a keyword search as fallback
  queries.push(nominatimFetch(`q=${encodeURIComponent(industry)}`));

  const batchResults = await Promise.allSettled(queries);
  const seen = new Set<number>();
  for (const r of batchResults) {
    if (r.status === "fulfilled") {
      for (const item of r.value) {
        if (!seen.has(item.place_id)) {
          seen.add(item.place_id);
          allResults.push(item);
        }
      }
    }
  }

  // Build stub leads first, then score footprints in parallel
  type StubElement = {
    name: string;
    website: string | undefined;
    phone: string | undefined;
    email: string;
    address: string;
  };

  const stubs: StubElement[] = allResults.map((r) => {
    const addr = r.address ?? {};
    const addressStr = [addr.road, addr.house_number, addr.city ?? addr.town ?? addr.village, addr.state]
      .filter(Boolean).join(", ");
    const tags = r.extratags ?? {};
    // Extract display name (first segment before first comma is usually the business name)
    const namePart = r.display_name.split(",")[0].trim();
    return {
      name:    namePart || `${industry} at ${r.lat},${r.lon}`,
      website: tags.website ?? tags["contact:website"] ?? undefined,
      phone:   tags.phone ?? tags["contact:phone"] ?? undefined,
      email:   tags.email ?? tags["contact:email"] ?? "",
      address: addressStr,
    };
  });

  // Score all footprints in parallel
  const scoreResults = await Promise.allSettled(
    stubs.map((s) => s.website ? scoreDigitalFootprint(s.website) : Promise.resolve(0)),
  );

  const leads: Lead[] = stubs.map((s, i) => {
    const scoreResult = scoreResults[i];
    const digitalFootprintScore =
      scoreResult.status === "fulfilled" ? scoreResult.value : 0;

    const lead: Lead = {
      id: randomUUID(),
      companyId,
      name:    s.name,
      email:   s.email,
      phone:   s.phone,
      company: s.name,
      website: s.website,
      source:  "osm",
      status:  "new",
      score:   0,
      signals: [`digitalFootprintScore:${digitalFootprintScore}`],
      notes:   [],
      activityLog: [
        makeActivity(
          "created",
          `Hunted via OSM/Overpass — industry: ${industry}, lat: ${lat}, lng: ${lng}`,
        ),
      ],
      createdAt: now(),
      updatedAt: now(),
    };

    leadStore.set(lead.id, lead);
    saveLeadStore().catch(() => {});
    return lead;
  });

  return leads;
}

// ---------------------------------------------------------------------------
// Lead qualification
// ---------------------------------------------------------------------------

export async function qualifyLead(lead: Lead, card: any): Promise<Lead> {
  const name     = card?.identity?.name ?? "the business";
  const pitch    = card?.identity?.elevator_pitch ?? "";
  const offerings: string =
    Array.isArray(card?.offerings)
      ? (card.offerings as any[]).map((o: any) => o.name).join(", ")
      : "";

  const prompt = `You are qualifying a sales lead for a local business.
Business: ${name} — ${pitch}
Offerings: ${offerings}
Lead: ${lead.name}, ${lead.company ?? "unknown company"}, ${lead.website ?? "no website"}

Score this lead 0-100 and identify qualification signals.
Return JSON: {"score": <number>, "signals": [<string>,...], "tier": "hot"|"warm"|"cold"}`;

  const resp = await aiGateway.call({ prompt, jsonMode: true });

  let parsed: { score?: number; signals?: string[]; tier?: string } = {};
  try {
    parsed = JSON.parse(resp.text) as typeof parsed;
  } catch {
    console.warn("[salesPipeline] qualifyLead JSON parse failed:", resp.text.slice(0, 200));
  }

  const VALID_TIERS = ["hot", "warm", "cold", "disqualified"] as const;
  type Tier = typeof VALID_TIERS[number];

  const updated: Lead = {
    ...lead,
    score: typeof parsed.score === "number" ? parsed.score : lead.score,
    signals: Array.isArray(parsed.signals) ? parsed.signals : lead.signals,
    tier: (VALID_TIERS as readonly string[]).includes(parsed.tier ?? "")
      ? (parsed.tier as Tier)
      : lead.tier,
    updatedAt: now(),
    activityLog: [
      ...lead.activityLog,
      makeActivity(
        "status_change",
        `Qualified — score: ${parsed.score ?? "?"}, tier: ${parsed.tier ?? "?"}`,
      ),
    ],
  };

  leadStore.set(updated.id, updated);
  saveLeadStore().catch(() => {});
  return updated;
}

// ---------------------------------------------------------------------------
// Lead contact enrichment — crawl website for mailto/tel if email is empty
// ---------------------------------------------------------------------------

export async function enrichLeadContact(lead: Lead): Promise<Lead> {
  if (lead.email) return lead;
  if (!lead.website) return lead;

  let html = "";
  try {
    const res = await fetch(lead.website, {
      method: "GET",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "HelixMain/1.0" },
    });
    if (!res.ok) return lead;
    html = await res.text();
  } catch {
    return lead;
  }

  const emailMatch = html.match(/mailto:([^\s"'?><]+)/i);
  const telMatch   = html.match(/tel:([+\d\s\-().]{7,20})/i);

  if (!emailMatch && !telMatch) return lead;

  const updated: Lead = {
    ...lead,
    email: emailMatch ? emailMatch[1].toLowerCase() : lead.email,
    phone: telMatch   ? telMatch[1].trim()          : lead.phone,
    updatedAt: now(),
  };
  leadStore.set(updated.id, updated);
  saveLeadStore().catch(() => {});
  return updated;
}

// ---------------------------------------------------------------------------
// Closer portfolio — generate personalized outreach draft
// ---------------------------------------------------------------------------

export async function generateOutreach(
  lead: Lead,
  card: any,
): Promise<OutreachDraft> {
  // Enrich contact info from website if email is missing
  lead = await enrichLeadContact(lead);
  const name        = card?.identity?.name ?? "the business";
  const pitch       = card?.identity?.elevator_pitch ?? "";
  const tone        = card?.voice?.tone ?? "professional";
  const personality = card?.voice?.personality ?? "helpful";

  const prompt = `You are a sales closer writing outreach for a local business.
Business: ${name}, ${pitch}, voice: ${tone}, ${personality}
Lead: ${lead.name} at ${lead.company ?? "their company"}

Write personalized outreach. Return JSON: {
  "subjectLine": "<string>",
  "emailBody": "<string>",
  "closingScript": "<string>",
  "objectionRebuttals": {
    "price objection": "<string>",
    "not interested": "<string>",
    "bad timing": "<string>"
  },
  "followUpSequence": ["<day 3 message>", "<day 7 message>", "<day 14 message>"]
}`;

  const resp = await aiGateway.call({ prompt, jsonMode: true, maxTokens: 2048 });

  let parsed: {
    subjectLine?: string;
    emailBody?: string;
    closingScript?: string;
    objectionRebuttals?: Record<string, string>;
    followUpSequence?: string[];
  } = {};

  try {
    parsed = JSON.parse(resp.text) as typeof parsed;
  } catch {
    console.warn("[salesPipeline] generateOutreach JSON parse failed:", resp.text.slice(0, 200));
  }

  const draft: OutreachDraft = {
    leadId: lead.id,
    subjectLine:        parsed.subjectLine        ?? `Introduction from ${name}`,
    emailBody:          parsed.emailBody           ?? "",
    closingScript:      parsed.closingScript       ?? "",
    objectionRebuttals: parsed.objectionRebuttals  ?? {},
    followUpSequence:   Array.isArray(parsed.followUpSequence) ? parsed.followUpSequence : [],
  };

  // Log activity on lead
  const updated: Lead = {
    ...lead,
    updatedAt: now(),
    activityLog: [
      ...lead.activityLog,
      makeActivity("outreach_draft", `Outreach drafted — subject: "${draft.subjectLine}"`),
    ],
  };
  leadStore.set(updated.id, updated);
  saveLeadStore().catch(() => {});

  return draft;
}

// ---------------------------------------------------------------------------
// Closing script generator
// ---------------------------------------------------------------------------

export interface ClosingScriptResult {
  closingScript: string;
  objectionHandlers: Record<string, string>;
  urgencyTriggers: string[];
  proposalTiers: {
    starter: { name: string; price: string; features: string[] };
    growth:  { name: string; price: string; features: string[] };
    dominate: { name: string; price: string; features: string[] };
  };
}

export async function generateClosingScript(
  lead: Lead,
  card: any,
): Promise<ClosingScriptResult> {
  const businessName = card?.identity?.name ?? "the business";
  const pitch        = card?.identity?.elevator_pitch ?? "";
  const offerings: string = Array.isArray(card?.offerings)
    ? (card.offerings as any[]).map((o: any) => o.name).join(", ")
    : "";

  const prompt = `You are a master sales closer. Generate a full closing package for this lead.
Business: ${businessName} — ${pitch}
Offerings: ${offerings}
Lead: ${lead.name}, ${lead.company ?? "unknown"}, score: ${lead.score}, signals: ${lead.signals.join(", ")}

Return JSON:
{
  "closingScript": "<full phone/meeting closing script>",
  "objectionHandlers": {
    "too expensive": "<rebuttal>",
    "not the right time": "<rebuttal>",
    "need to think about it": "<rebuttal>",
    "already have a solution": "<rebuttal>"
  },
  "urgencyTriggers": ["<trigger 1>", "<trigger 2>", "<trigger 3>"],
  "proposalTiers": {
    "starter": { "name": "<tier name>", "price": "<price string>", "features": ["<feature>"] },
    "growth":  { "name": "<tier name>", "price": "<price string>", "features": ["<feature>"] },
    "dominate": { "name": "<tier name>", "price": "<price string>", "features": ["<feature>"] }
  }
}`;

  const resp = await aiGateway.call({ prompt, jsonMode: true, maxTokens: 2048 });

  let parsed: Partial<ClosingScriptResult> = {};
  try {
    parsed = JSON.parse(resp.text) as Partial<ClosingScriptResult>;
  } catch {
    console.warn("[salesPipeline] generateClosingScript JSON parse failed:", resp.text.slice(0, 200));
  }

  const defaultTier = { name: "", price: "", features: [] };

  return {
    closingScript:    parsed.closingScript    ?? "",
    objectionHandlers: parsed.objectionHandlers ?? {},
    urgencyTriggers:  Array.isArray(parsed.urgencyTriggers) ? parsed.urgencyTriggers : [],
    proposalTiers: {
      starter:  parsed.proposalTiers?.starter  ?? defaultTier,
      growth:   parsed.proposalTiers?.growth   ?? defaultTier,
      dominate: parsed.proposalTiers?.dominate ?? defaultTier,
    },
  };
}

// ---------------------------------------------------------------------------
// Submit to SparkGatekeeper (H-gate) — NEVER send directly
// ---------------------------------------------------------------------------

export async function submitOutreachForApproval(
  draft: OutreachDraft,
  lead: Lead,
  companyId: string,
): Promise<string> {
  const res = await fetch("http://localhost:9100/hold", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      companyId,
      action: "sales.send_email",
      risk: "high",
      payload: {
        to:      lead.email,
        subject: draft.subjectLine,
        body:    draft.emailBody,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SparkGatekeeper error ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as { holdQueueId?: string; id?: string };
  const holdQueueId = json.holdQueueId ?? json.id ?? randomUUID();

  // Persist on draft reference — callers should re-assign
  draft.holdQueueId = holdQueueId;

  // Log activity on lead
  const stored = leadStore.get(lead.id);
  if (stored) {
    stored.updatedAt = now();
    stored.activityLog.push(
      makeActivity("outreach_draft", `Submitted to hold queue — id: ${holdQueueId}`),
    );
    leadStore.set(stored.id, stored);
    saveLeadStore().catch(() => {});
  }

  return holdQueueId;
}

// ---------------------------------------------------------------------------
// CRM pipeline helpers
// ---------------------------------------------------------------------------

export function updateLeadStatus(
  lead: Lead,
  status: LeadStatus,
  note?: string,
): Lead {
  const updated: Lead = {
    ...lead,
    status,
    updatedAt: now(),
    activityLog: [
      ...lead.activityLog,
      makeActivity("status_change", `Status → ${status}${note ? ` — ${note}` : ""}`),
    ],
    notes: note ? [...lead.notes, note] : lead.notes,
  };
  leadStore.set(updated.id, updated);
  saveLeadStore().catch(() => {});
  return updated;
}

export function addNote(lead: Lead, note: string): Lead {
  const updated: Lead = {
    ...lead,
    notes: [...lead.notes, note],
    updatedAt: now(),
    activityLog: [
      ...lead.activityLog,
      makeActivity("note", note),
    ],
  };
  leadStore.set(updated.id, updated);
  saveLeadStore().catch(() => {});
  return updated;
}

export function getLeadsByCompany(companyId: string): Lead[] {
  const results: Lead[] = [];
  for (const lead of leadStore.values()) {
    if (lead.companyId === companyId) results.push(lead);
  }
  return results;
}

export function getPipelineSummary(companyId: string): {
  total: number;
  byStatus: Record<LeadStatus, number>;
  avgScore: number;
  hotLeads: Lead[];
} {
  const leads = getLeadsByCompany(companyId);

  const byStatus: Record<LeadStatus, number> = {
    new:       0,
    contacted: 0,
    qualified: 0,
    converted: 0,
    lost:      0,
  };

  let scoreSum = 0;
  for (const l of leads) {
    byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;
    scoreSum += l.score;
  }

  const avgScore = leads.length > 0 ? scoreSum / leads.length : 0;
  const hotLeads = leads.filter((l) => l.score >= 70).sort((a, b) => b.score - a.score);

  return { total: leads.length, byStatus, avgScore, hotLeads };
}

// Export store for route layer
export { leadStore };
