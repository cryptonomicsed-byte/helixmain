/**
 * analytics — call volume, top queries, conversion tracking.
 *
 * In-memory store keyed by companyId. All LLM-generated insights
 * are derived from aggregated call data, not raw transcripts.
 */

import { aiGateway } from "./aiGateway";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CallLog {
  id: string;
  companyId: string;
  timestamp: string;
  durationSeconds: number;
  outcome: "answered" | "transferred" | "voicemail" | "abandoned";
  gateTriggered: boolean;
  transcriptSummary?: string;
  topicTags: string[];
  converted: boolean; // owner-tagged
}

export interface AnalyticsSummary {
  companyId: string;
  period: "day" | "week" | "month";
  callVolume: number;
  avgDuration: number;
  outcomeBreakdown: Record<CallLog["outcome"], number>;
  gateTriggeredRate: number; // % of calls that triggered a gate
  conversionRate: number;
  topTopics: Array<{ topic: string; count: number }>;
  insights: string[]; // LLM-generated insights from the data
  // Enrichment fields — populated by route handler from other stores
  campaignsSent?: number;
  leadsTotal?: number;
  leadsConverted?: number;
  creditsUsed?: number;
  sitesGenerated?: number;
}

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

const callStore = new Map<string, CallLog[]>();

export interface EventEntry {
  companyId: string;
  eventType: string;
  assetId?: string;
  leadId?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

const eventStore = new Map<string, EventEntry[]>();

export function logEvent(entry: EventEntry): void {
  const list = eventStore.get(entry.companyId) ?? [];
  list.push(entry);
  eventStore.set(entry.companyId, list);
}

export function getEvents(companyId: string): EventEntry[] {
  return eventStore.get(companyId) ?? [];
}

function getCompanyLogs(companyId: string): CallLog[] {
  if (!callStore.has(companyId)) callStore.set(companyId, []);
  return callStore.get(companyId)!;
}

// ---------------------------------------------------------------------------
// Period filter
// ---------------------------------------------------------------------------

const PERIOD_MS: Record<"day" | "week" | "month", number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

function filterByPeriod(logs: CallLog[], period: "day" | "week" | "month"): CallLog[] {
  const cutoff = Date.now() - PERIOD_MS[period];
  return logs.filter((l) => new Date(l.timestamp).getTime() >= cutoff);
}

// ---------------------------------------------------------------------------
// Topic aggregation
// ---------------------------------------------------------------------------

function aggregateTopics(logs: CallLog[]): Array<{ topic: string; count: number }> {
  const counts = new Map<string, number>();
  for (const log of logs) {
    for (const tag of log.topicTags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

export function logCall(log: CallLog): void {
  getCompanyLogs(log.companyId).push(log);
}

export async function getAnalytics(
  companyId: string,
  period: "day" | "week" | "month",
): Promise<AnalyticsSummary> {
  const all = getCompanyLogs(companyId);
  const logs = filterByPeriod(all, period);

  const callVolume = logs.length;
  const avgDuration =
    callVolume > 0
      ? logs.reduce((sum, l) => sum + l.durationSeconds, 0) / callVolume
      : 0;

  const outcomeBreakdown: Record<CallLog["outcome"], number> = {
    answered: 0,
    transferred: 0,
    voicemail: 0,
    abandoned: 0,
  };
  let gateCount = 0;
  let convertedCount = 0;
  for (const l of logs) {
    outcomeBreakdown[l.outcome] = (outcomeBreakdown[l.outcome] ?? 0) + 1;
    if (l.gateTriggered) gateCount++;
    if (l.converted) convertedCount++;
  }

  const gateTriggeredRate = callVolume > 0 ? (gateCount / callVolume) * 100 : 0;
  const conversionRate = callVolume > 0 ? (convertedCount / callVolume) * 100 : 0;
  const topTopics = aggregateTopics(logs);

  // Fetch company name from first log's card field if available (best-effort)
  const insights = await generateInsights(logs, { companyId });

  return {
    companyId,
    period,
    callVolume,
    avgDuration: Math.round(avgDuration * 10) / 10,
    outcomeBreakdown,
    gateTriggeredRate: Math.round(gateTriggeredRate * 10) / 10,
    conversionRate: Math.round(conversionRate * 10) / 10,
    topTopics,
    insights,
  };
}

export async function extractTopics(transcript: string): Promise<string[]> {
  const prompt = `Extract 3-5 concise topic tags from this call transcript summary. Return JSON: {"topics":["tag1","tag2",...]}

Transcript: ${transcript.slice(0, 1000)}`;

  const res = await aiGateway.call({
    prompt,
    systemPrompt: "You are a call analytics engine. Return only valid JSON.",
    jsonMode: true,
    temperature: 0.3,
    operationType: "analytics_topics",
  });

  type TopicsRaw = { topics: string[] };
  const raw = JSON.parse(res.text) as TopicsRaw;
  return Array.isArray(raw.topics) ? raw.topics : [];
}

export async function generateInsights(logs: CallLog[], card: any): Promise<string[]> {
  if (logs.length === 0) {
    return ["No call data available for the selected period."];
  }

  const businessName =
    card?.identity?.name ?? card?.companyId ?? card?.companyId ?? "this business";
  const topTopics = aggregateTopics(logs);
  const topTopicsStr = topTopics
    .slice(0, 5)
    .map((t) => `${t.topic} (${t.count})`)
    .join(", ");
  const callVolume = logs.length;
  const convertedCount = logs.filter((l) => l.converted).length;
  const conversionRate =
    callVolume > 0 ? Math.round((convertedCount / callVolume) * 1000) / 10 : 0;
  const gateCount = logs.filter((l) => l.gateTriggered).length;
  const gateRate =
    callVolume > 0 ? Math.round((gateCount / callVolume) * 1000) / 10 : 0;

  const prompt = `Analyze these ${callVolume} call logs for ${businessName} and generate 3 actionable insights.
Top topics: ${topTopicsStr || "none"}
Conversion rate: ${conversionRate}%
Gate triggered rate: ${gateRate}%
Return JSON: {"insights":["insight 1","insight 2","insight 3"]}`;

  const res = await aiGateway.call({
    prompt,
    systemPrompt:
      "You are a business analytics consultant. Return only valid JSON with exactly 3 concise, actionable insights.",
    jsonMode: true,
    temperature: 0.5,
    orgId: (card?.companyId ?? card?.organizationId ?? card?.org_id) as string | undefined,
    operationType: "analytics_insights",
  });

  type InsightsRaw = { insights: string[] };
  const raw = JSON.parse(res.text) as InsightsRaw;
  return Array.isArray(raw.insights) ? raw.insights : [];
}
