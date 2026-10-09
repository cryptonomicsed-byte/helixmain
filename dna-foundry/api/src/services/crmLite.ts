// CRM Decision: build-thin for HelixMain's SMB target market.
// For larger clients needing full-record CRM (deal values, tasks, timelines,
// multi-entity records), evaluate Twenty CRM (github.com/twentyhq/twenty) —
// open-source, self-hostable, modern API. Migration path: export contacts
// via getContacts() and import into Twenty's REST API.

/**
 * crmLite — thin CRM extending salesPipeline.
 *
 * Scope: contacts with statuses, notes, and a lightweight activity timeline.
 * Stage names are validated against card.operations.pipeline_stages[].
 * In-memory only; no filesystem writes.
 */

import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContactNote {
  id: string;
  text: string;
  author: "owner" | "agent";
  timestamp: string;
}

export interface TimelineEvent {
  timestamp: string;
  type: "created" | "stage_change" | "note" | "call" | "email_sent" | "email_received" | "converted";
  detail: string;
}

export interface Contact {
  id: string;
  companyId: string;
  name: string;
  email: string;
  phone?: string;
  company?: string;
  website?: string;
  tags: string[];
  pipelineStage: string;        // maps to card.operations.pipeline_stages[]
  notes: ContactNote[];
  activityTimeline: TimelineEvent[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const contactStore = new Map<string, Contact>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}

function timelineEvent(
  type: TimelineEvent["type"],
  detail: string,
): TimelineEvent {
  return { timestamp: now(), type, detail };
}

function getPipelineStages(card: any): string[] {
  if (Array.isArray(card?.operations?.pipeline_stages)) {
    return card.operations.pipeline_stages as string[];
  }
  // Sensible defaults when card is not provided or stages not defined
  return ["prospect", "contacted", "qualified", "proposal", "converted", "lost"];
}

// ---------------------------------------------------------------------------
// createContact
// ---------------------------------------------------------------------------

export function createContact(companyId: string, data: Partial<Contact>): Contact {
  const contact: Contact = {
    id:              data.id          ?? randomUUID(),
    companyId,
    name:            data.name        ?? "Unknown",
    email:           data.email       ?? "",
    phone:           data.phone,
    company:         data.company,
    website:         data.website,
    tags:            data.tags        ?? [],
    pipelineStage:   data.pipelineStage ?? "prospect",
    notes:           data.notes       ?? [],
    activityTimeline: [
      timelineEvent("created", `Contact created — ${data.name ?? "Unknown"}`),
    ],
    createdAt:  now(),
    updatedAt:  now(),
  };

  contactStore.set(contact.id, contact);
  return contact;
}

// ---------------------------------------------------------------------------
// updateContact
// ---------------------------------------------------------------------------

export function updateContact(contactId: string, updates: Partial<Contact>): Contact {
  const existing = contactStore.get(contactId);
  if (!existing) throw new Error(`Contact not found: ${contactId}`);

  const updated: Contact = {
    ...existing,
    ...updates,
    // never overwrite these via generic update
    id:              existing.id,
    companyId:       existing.companyId,
    createdAt:       existing.createdAt,
    notes:           updates.notes           ?? existing.notes,
    activityTimeline: updates.activityTimeline ?? existing.activityTimeline,
    updatedAt:       now(),
  };

  contactStore.set(updated.id, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// moveStage
// ---------------------------------------------------------------------------

export function moveStage(contactId: string, stage: string, card: any): Contact {
  const existing = contactStore.get(contactId);
  if (!existing) throw new Error(`Contact not found: ${contactId}`);

  const validStages = getPipelineStages(card);
  if (!validStages.includes(stage)) {
    throw new Error(
      `Invalid stage "${stage}". Valid stages: ${validStages.join(", ")}`,
    );
  }

  const prevStage = existing.pipelineStage;
  const eventType: TimelineEvent["type"] =
    stage === "converted" ? "converted" : "stage_change";

  const event = timelineEvent(
    eventType,
    `Stage: ${prevStage} → ${stage}`,
  );

  const updated: Contact = {
    ...existing,
    pipelineStage:    stage,
    activityTimeline: [...existing.activityTimeline, event],
    updatedAt:        now(),
  };

  contactStore.set(updated.id, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// addContactNote
// ---------------------------------------------------------------------------

export function addContactNote(
  contactId: string,
  text: string,
  author: "owner" | "agent",
): Contact {
  const existing = contactStore.get(contactId);
  if (!existing) throw new Error(`Contact not found: ${contactId}`);

  const note: ContactNote = {
    id:        randomUUID(),
    text,
    author,
    timestamp: now(),
  };

  const event = timelineEvent("note", `Note by ${author}: ${text.slice(0, 100)}${text.length > 100 ? "…" : ""}`);

  const updated: Contact = {
    ...existing,
    notes:            [...existing.notes, note],
    activityTimeline: [...existing.activityTimeline, event],
    updatedAt:        now(),
  };

  contactStore.set(updated.id, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// getContacts / getContactsByStage
// ---------------------------------------------------------------------------

export function getContacts(companyId: string): Contact[] {
  const results: Contact[] = [];
  for (const contact of contactStore.values()) {
    if (contact.companyId === companyId) results.push(contact);
  }
  return results;
}

export function getContactsByStage(companyId: string, stage: string): Contact[] {
  return getContacts(companyId).filter((c) => c.pipelineStage === stage);
}

// ---------------------------------------------------------------------------
// crmSummary
// ---------------------------------------------------------------------------

export function crmSummary(
  companyId: string,
  card: any,
): {
  total: number;
  byStage: Record<string, number>;
  recentActivity: TimelineEvent[];
  pipelineStages: string[];
} {
  const contacts      = getContacts(companyId);
  const pipelineStages = getPipelineStages(card);

  const byStage: Record<string, number> = {};
  for (const stage of pipelineStages) {
    byStage[stage] = 0;
  }
  for (const contact of contacts) {
    const s = contact.pipelineStage;
    byStage[s] = (byStage[s] ?? 0) + 1;
  }

  // Collect all timeline events, sort by timestamp desc, take most recent 20
  const allEvents: TimelineEvent[] = [];
  for (const contact of contacts) {
    allEvents.push(...contact.activityTimeline);
  }
  allEvents.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const recentActivity = allEvents.slice(0, 20);

  return {
    total: contacts.length,
    byStage,
    recentActivity,
    pipelineStages,
  };
}

// Export store for route layer
export { contactStore };
