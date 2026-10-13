/**
 * intelEngine — battle mode, brand simulator, trend pulse.
 *
 * ALL outputs are appendix-only: owner-facing planning tools, never quoted
 * to customers or included in any customer-visible card section.
 */

import { aiGateway } from "./aiGateway";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BattleReport {
  companyA: string;
  companyB: string;
  visual: { winner: string; score: number; analysis: string };
  messaging: { winner: string; score: number; analysis: string };
  positioning: { winner: string; score: number; analysis: string };
  overall: { winner: string; recommendation: string };
  gaps: string[];         // what companyA is missing vs companyB
  generatedAt: string;
  appendixOnly: true;     // always true — never expose to customers
}

export interface BrandSimulation {
  variant: "design" | "copy" | "audience";
  input: string;
  simulatedFeedback: string[];
  sentiment: "positive" | "neutral" | "negative";
  score: number;
  suggestions: string[];
  appendixOnly: true;
}

export interface TrendPulse {
  industry: string;
  trends: Array<{
    name: string;
    relevance: "high" | "medium" | "low";
    implication: string;
  }>;
  opportunities: string[];
  threats: string[];
  generatedAt: string;
  appendixOnly: true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJoin(arr: unknown[] | undefined, sep = ", "): string {
  if (!Array.isArray(arr)) return "";
  return arr.map((o: unknown) => {
    if (typeof o === "object" && o !== null && "name" in o) {
      return (o as Record<string, unknown>).name as string;
    }
    return String(o);
  }).join(sep);
}

function parseLlmJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Battle mode
// ---------------------------------------------------------------------------

export async function runBattleMode(cardA: any, cardB: any): Promise<BattleReport> {
  const nameA = cardA?.identity?.name ?? "Business A";
  const nameB = cardB?.identity?.name ?? "Business B";

  const prompt = `Compare two local businesses for competitive analysis. This is for internal owner planning only.
Business A: ${nameA} — ${cardA?.identity?.elevator_pitch ?? ""}
Voice: ${cardA?.voice?.tone ?? ""}, ${cardA?.voice?.personality ?? ""}
Offerings: ${safeJoin(cardA?.offerings)}
Positioning: ${cardA?.strategy?.positioning ?? ""}

Business B: ${nameB} — ${cardB?.identity?.elevator_pitch ?? ""}
Voice: ${cardB?.voice?.tone ?? ""}, ${cardB?.voice?.personality ?? ""}
Offerings: ${safeJoin(cardB?.offerings)}
Positioning: ${cardB?.strategy?.positioning ?? ""}

Score each dimension 1-10 and identify strategic gaps.
Return JSON: {"visual":{"winner":"","score":0,"analysis":""},"messaging":{"winner":"","score":0,"analysis":""},"positioning":{"winner":"","score":0,"analysis":""},"overall":{"winner":"","recommendation":""},"gaps":[]}`;

  const res = await aiGateway.call({
    prompt,
    systemPrompt: "You are a competitive brand strategist. Return only valid JSON.",
    jsonMode: true,
    temperature: 0.4,
    orgId: (cardA?.organizationId ?? cardA?.org_id) as string | undefined,
    operationType: "intel_battle",
  });

  type BattleRaw = {
    visual: { winner: string; score: number; analysis: string };
    messaging: { winner: string; score: number; analysis: string };
    positioning: { winner: string; score: number; analysis: string };
    overall: { winner: string; recommendation: string };
    gaps: string[];
  };

  const raw = parseLlmJson<BattleRaw>(res.text);

  return {
    companyA: nameA,
    companyB: nameB,
    visual: raw.visual,
    messaging: raw.messaging,
    positioning: raw.positioning,
    overall: raw.overall,
    gaps: Array.isArray(raw.gaps) ? raw.gaps : [],
    generatedAt: new Date().toISOString(),
    appendixOnly: true,
  };
}

// ---------------------------------------------------------------------------
// Brand simulator
// ---------------------------------------------------------------------------

export async function simulateBrand(
  card: any,
  variant: BrandSimulation["variant"],
  input: string,
): Promise<BrandSimulation> {
  const businessName = card?.identity?.name ?? "this business";
  const location = card?.identity?.location ?? "";
  const industry = card?.identity?.industry ?? "";

  let promptBody: string;
  switch (variant) {
    case "copy":
      promptBody = `Simulate how a local customer would react to this marketing copy for ${businessName} (${industry}, ${location}):\n\n"${input}"\n\nGenerate 4 realistic short customer reactions, a sentiment, a score 1-10, and 3 improvement suggestions.`;
      break;
    case "design":
      promptBody = `Simulate how a local customer would perceive this design concept for ${businessName} (${industry}, ${location}):\n\n"${input}"\n\nGenerate 4 realistic short customer impressions, a sentiment, a score 1-10, and 3 design improvement suggestions.`;
      break;
    case "audience":
      promptBody = `Simulate how this target audience segment would respond to ${businessName} (${industry}, ${location}):\n\nAudience description: "${input}"\n\nGenerate 4 realistic short audience reactions to the brand, a sentiment, a score 1-10, and 3 targeting suggestions.`;
      break;
  }

  const prompt = `${promptBody}

Return JSON: {"simulatedFeedback":["...","...","...","..."],"sentiment":"positive"|"neutral"|"negative","score":0,"suggestions":["...","...","..."]}`;

  const res = await aiGateway.call({
    prompt,
    systemPrompt: "You are a consumer research analyst. Return only valid JSON.",
    jsonMode: true,
    temperature: 0.6,
    orgId: (card?.organizationId ?? card?.org_id) as string | undefined,
    operationType: "intel_simulate",
  });

  type SimRaw = {
    simulatedFeedback: string[];
    sentiment: "positive" | "neutral" | "negative";
    score: number;
    suggestions: string[];
  };

  const raw = parseLlmJson<SimRaw>(res.text);
  const validSentiments = ["positive", "neutral", "negative"] as const;
  const sentiment: BrandSimulation["sentiment"] = validSentiments.includes(
    raw.sentiment as BrandSimulation["sentiment"],
  )
    ? (raw.sentiment as BrandSimulation["sentiment"])
    : "neutral";

  return {
    variant,
    input,
    simulatedFeedback: Array.isArray(raw.simulatedFeedback) ? raw.simulatedFeedback : [],
    sentiment,
    score: typeof raw.score === "number" ? raw.score : 5,
    suggestions: Array.isArray(raw.suggestions) ? raw.suggestions : [],
    appendixOnly: true,
  };
}

// ---------------------------------------------------------------------------
// Trend pulse
// ---------------------------------------------------------------------------

export async function getTrendPulse(card: any): Promise<TrendPulse> {
  const industry = card?.identity?.industry ?? "local business";
  const location = card?.identity?.location ?? "";
  const businessType = card?.identity?.type ?? "";

  const prompt = `Identify the top 5 current industry trends relevant to a ${businessType} ${industry} business${location ? ` in ${location}` : ""}.

For each trend include its relevance level (high/medium/low) and a one-sentence implication for the business.
Also list 3 strategic opportunities and 3 threats.

Return JSON: {"industry":"","trends":[{"name":"","relevance":"high"|"medium"|"low","implication":""}],"opportunities":["","",""],"threats":["","",""]}`;

  const res = await aiGateway.call({
    prompt,
    systemPrompt: "You are a market intelligence analyst. Return only valid JSON.",
    jsonMode: true,
    temperature: 0.5,
    orgId: (card?.organizationId ?? card?.org_id) as string | undefined,
    operationType: "intel_trends",
  });

  type TrendRaw = {
    industry: string;
    trends: Array<{ name: string; relevance: string; implication: string }>;
    opportunities: string[];
    threats: string[];
  };

  const raw = parseLlmJson<TrendRaw>(res.text);
  const validRelevance = ["high", "medium", "low"] as const;

  return {
    industry: raw.industry || industry,
    trends: Array.isArray(raw.trends)
      ? raw.trends.map((t) => ({
          name: t.name ?? "",
          relevance: validRelevance.includes(t.relevance as "high" | "medium" | "low")
            ? (t.relevance as "high" | "medium" | "low")
            : "medium",
          implication: t.implication ?? "",
        }))
      : [],
    opportunities: Array.isArray(raw.opportunities) ? raw.opportunities : [],
    threats: Array.isArray(raw.threats) ? raw.threats : [],
    generatedAt: new Date().toISOString(),
    appendixOnly: true,
  };
}
