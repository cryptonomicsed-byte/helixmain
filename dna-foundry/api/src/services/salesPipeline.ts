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
 *   - places / manual — caller-supplied leads
 */

import { randomUUID } from "crypto";
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
  source: "apollo" | "hunter" | "places" | "manual";
  status: LeadStatus;
  score: number;              // 0-100
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

  const updated: Lead = {
    ...lead,
    score: typeof parsed.score === "number" ? parsed.score : lead.score,
    signals: Array.isArray(parsed.signals) ? parsed.signals : lead.signals,
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
  return updated;
}

// ---------------------------------------------------------------------------
// Closer portfolio — generate personalized outreach draft
// ---------------------------------------------------------------------------

export async function generateOutreach(
  lead: Lead,
  card: any,
): Promise<OutreachDraft> {
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

  return draft;
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
