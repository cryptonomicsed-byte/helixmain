/**
 * businessPlan — structured business plan generator from a BrandDNA card.
 *
 * Key design decisions:
 *  - Status is always 'draft' — owner must review before any external use.
 *  - Financial projections are qualitative only; no invented numbers.
 *  - Appendix data (SWOT, personas, competitors) is sourced from card.appendix
 *    and labelled as inferred — never presented as verified.
 *  - One large jsonMode LLM call (sections) + one sync pass for
 *    financials / appendix assembly.
 *  - Plans stored in-memory; keyed by companyId for GET /plan/:companyId.
 */

import { randomUUID } from "crypto";
import { aiGateway } from "./aiGateway";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BusinessPlan {
  id: string;
  companyId: string;
  cardVersion: number;
  generatedAt: string;
  status: "draft";
  sections: {
    executiveSummary: string;
    businessDescription: string;
    marketAnalysis: string;
    competitiveAnalysis: string;
    productsAndServices: string;
    marketingStrategy: string;
    operationsPlan: string;
    revenueModel: string;
    growthRoadmap: string;
    riskMitigation: string;
  };
  financialProjections: {
    year1Revenue: string;   // qualitative — e.g. "Low, based on 3 offerings at avg price"
    breakEvenNote: string;
    growthDriver: string;
  };
  appendixData: {           // sourced from card.appendix — labelled as inferred
    swot: any;
    personas: any[];
    competitors: any[];
    positioning: string;
  };
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

export const planStore = new Map<string, BusinessPlan>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}

function formatOfferings(offerings: any[]): string {
  if (!Array.isArray(offerings) || offerings.length === 0) return "Not specified";
  return offerings
    .map((o: any) => {
      const kind = o.kind ?? o.type ?? "offering";
      const name = o.name ?? o.title ?? "Unnamed";
      const price = o.price ? ` (${o.price})` : "";
      return `- ${name} [${kind}]${price}`;
    })
    .join("\n");
}

function buildSectionsPrompt(card: any): string {
  const name       = card?.identity?.name ?? card?.name?.value ?? "the business";
  const pitch      = card?.identity?.elevator_pitch ?? "";
  const location   = card?.location?.city ?? card?.location?.address ?? "location not specified";
  const phone      = card?.contact?.phone ?? card?.phone ?? "not listed";
  const hours      = card?.operations?.hours ?? "not specified";
  const offerings  = formatOfferings(card?.offerings ?? []);
  const tone       = card?.voice?.tone ?? "professional";
  const personality = card?.voice?.personality ?? "helpful";
  const values     = Array.isArray(card?.identity?.values)
    ? card.identity.values.join(", ")
    : (card?.identity?.values ?? "not specified");
  const positioning   = card?.strategy?.positioning ?? card?.appendix?.positioning ?? "not specified";
  const keyMessages   = Array.isArray(card?.strategy?.key_messaging)
    ? card.strategy.key_messaging.join("; ")
    : (card?.strategy?.key_messaging ?? "not specified");
  const strengths  = Array.isArray(card?.strategy?.swot?.strengths)
    ? card.strategy.swot.strengths.join("; ")
    : (card?.appendix?.swot?.strengths ?? "not specified");
  const weaknesses = Array.isArray(card?.strategy?.swot?.weaknesses)
    ? card.strategy.swot.weaknesses.join("; ")
    : (card?.appendix?.swot?.weaknesses ?? "not specified");

  return `You are writing a business plan for a local business. All data comes from their business card.
This is a DRAFT for owner review only — do not present as final or investor-ready.

Business: ${name}
Description: ${pitch}
Location: ${location}
Phone: ${phone}
Hours: ${hours}
Offerings:
${offerings}
Tone/Voice: ${personality}
Values: ${values}
Positioning: ${positioning}
Key Messages: ${keyMessages}
Strengths: ${strengths}
Weaknesses: ${weaknesses}

Write a structured business plan. Be concrete and grounded in the data provided.
Do not invent financial figures — describe revenue model qualitatively.
Return JSON with exactly these 9 keys as string values:
{
  "executiveSummary": "...",
  "businessDescription": "...",
  "marketAnalysis": "...",
  "competitiveAnalysis": "...",
  "productsAndServices": "...",
  "marketingStrategy": "...",
  "operationsPlan": "...",
  "revenueModel": "...",
  "growthRoadmap": "...",
  "riskMitigation": "..."
}`;
}

// ---------------------------------------------------------------------------
// generateBusinessPlan
// ---------------------------------------------------------------------------

export async function generateBusinessPlan(
  cardId: string,
  card: any,
): Promise<BusinessPlan> {
  const companyId   = card?.org_id ?? card?.id ?? cardId;
  const cardVersion = typeof card?.version === "number" ? card.version : 1;

  // One large structured LLM call for all 9 sections
  const prompt = buildSectionsPrompt(card);
  const resp = await aiGateway.call({
    prompt,
    jsonMode: true,
    maxTokens: 4096,
    orgId: companyId,
    operationType: "business_plan",
  });

  let sections: BusinessPlan["sections"] = {
    executiveSummary:    "",
    businessDescription: "",
    marketAnalysis:      "",
    competitiveAnalysis: "",
    productsAndServices: "",
    marketingStrategy:   "",
    operationsPlan:      "",
    revenueModel:        "",
    growthRoadmap:       "",
    riskMitigation:      "",
  };

  try {
    const parsed = JSON.parse(resp.text) as Partial<BusinessPlan["sections"]>;
    sections = {
      executiveSummary:    parsed.executiveSummary    ?? "",
      businessDescription: parsed.businessDescription ?? "",
      marketAnalysis:      parsed.marketAnalysis      ?? "",
      competitiveAnalysis: parsed.competitiveAnalysis ?? "",
      productsAndServices: parsed.productsAndServices ?? "",
      marketingStrategy:   parsed.marketingStrategy   ?? "",
      operationsPlan:      parsed.operationsPlan       ?? "",
      revenueModel:        parsed.revenueModel         ?? "",
      growthRoadmap:       parsed.growthRoadmap        ?? "",
      riskMitigation:      parsed.riskMitigation       ?? "",
    };
  } catch {
    console.warn("[businessPlan] sections JSON parse failed:", resp.text.slice(0, 200));
  }

  // Qualitative financial projections assembled from card data
  const offeringsArr: any[] = Array.isArray(card?.offerings) ? card.offerings : [];
  const offeringCount = offeringsArr.length;
  const year1Revenue = `Low to moderate, based on ${offeringCount > 0 ? offeringCount : "multiple"} offering${offeringCount !== 1 ? "s" : ""} at average local market pricing. Actual figures require owner input.`;
  const breakEvenNote = "Break-even timeline depends on owner-provided cost structure. Recommend completing a detailed cost analysis before any external presentation.";
  const growthDriver = sections.growthRoadmap
    ? "Growth driven by roadmap milestones identified above. Owner should validate timelines."
    : "Growth driver not yet specified — owner review recommended.";

  // Appendix sourced from card.appendix or card.strategy.swot
  const appendixData: BusinessPlan["appendixData"] = {
    swot:        card?.appendix?.swot       ?? card?.strategy?.swot       ?? {},
    personas:    card?.appendix?.personas   ?? card?.target_market?.personas ?? [],
    competitors: card?.appendix?.competitors ?? card?.strategy?.competitors ?? [],
    positioning: card?.appendix?.positioning ?? card?.strategy?.positioning ?? "",
  };

  const plan: BusinessPlan = {
    id:            randomUUID(),
    companyId,
    cardVersion,
    generatedAt:   now(),
    status:        "draft",
    sections,
    financialProjections: {
      year1Revenue,
      breakEvenNote,
      growthDriver,
    },
    appendixData,
  };

  // Store by both plan.id and companyId (latest wins for GET /plan/:companyId)
  planStore.set(plan.id, plan);
  planStore.set(`latest:${companyId}`, plan);

  return plan;
}

// ---------------------------------------------------------------------------
// exportToPdf — returns HTML string (dashboard prints via window.print())
// ---------------------------------------------------------------------------

const SECTION_LABELS: Record<keyof BusinessPlan["sections"], string> = {
  executiveSummary:    "Executive Summary",
  businessDescription: "Business Description",
  marketAnalysis:      "Market Analysis",
  competitiveAnalysis: "Competitive Analysis",
  productsAndServices: "Products & Services",
  marketingStrategy:   "Marketing Strategy",
  operationsPlan:      "Operations Plan",
  revenueModel:        "Revenue Model",
  growthRoadmap:       "Growth Roadmap",
  riskMitigation:      "Risk Mitigation",
};

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function exportToPdf(plan: BusinessPlan, businessName?: string): string {
  const name    = escHtml(businessName ?? plan.companyId);
  const date    = new Date(plan.generatedAt).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
  const version = plan.cardVersion;

  const sectionHtml = (Object.keys(SECTION_LABELS) as Array<keyof BusinessPlan["sections"]>)
    .map((key) => {
      const label   = SECTION_LABELS[key];
      const content = escHtml(plan.sections[key] || "Not available.");
      return `  <h2>${label}</h2>\n  <p>${content}</p>`;
    })
    .join("\n");

  // Financial projections block
  const fp = plan.financialProjections;
  const financialHtml = `
  <h2>Financial Projections (Qualitative)</h2>
  <p><strong>Year 1 Revenue Estimate:</strong> ${escHtml(fp.year1Revenue)}</p>
  <p><strong>Break-Even:</strong> ${escHtml(fp.breakEvenNote)}</p>
  <p><strong>Primary Growth Driver:</strong> ${escHtml(fp.growthDriver)}</p>`;

  // Appendix block
  const ap = plan.appendixData;
  const swotHtml = ap.swot && typeof ap.swot === "object"
    ? `<pre>${escHtml(JSON.stringify(ap.swot, null, 2))}</pre>`
    : "<p>No SWOT data available.</p>";

  const personasHtml = Array.isArray(ap.personas) && ap.personas.length > 0
    ? `<ul>${ap.personas.map((p: any) =>
        `<li>${escHtml(typeof p === "string" ? p : JSON.stringify(p))}</li>`
      ).join("")}</ul>`
    : "<p>No personas defined.</p>";

  const competitorsHtml = Array.isArray(ap.competitors) && ap.competitors.length > 0
    ? `<ul>${ap.competitors.map((c: any) =>
        `<li>${escHtml(typeof c === "string" ? c : JSON.stringify(c))}</li>`
      ).join("")}</ul>`
    : "<p>No competitors listed.</p>";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body{font-family:Georgia,serif;max-width:800px;margin:40px auto;color:#111;line-height:1.7}
  h1{font-size:2rem;border-bottom:2px solid #111;padding-bottom:.5rem}
  h2{font-size:1.2rem;margin-top:2rem;color:#333}
  .draft-banner{background:#fef3c7;border:1px solid #f59e0b;padding:.75rem 1rem;border-radius:4px;margin-bottom:2rem;font-size:.9rem}
  .appendix{border-top:1px solid #ccc;margin-top:3rem;padding-top:1.5rem;color:#555;font-size:.85rem}
  pre{background:#f5f5f5;padding:.75rem;border-radius:4px;white-space:pre-wrap;font-size:.8rem}
  @media print{.draft-banner{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body>
  <div class="draft-banner">&#9888;&#65039; DRAFT &mdash; For owner review only. Not investor-ready.</div>
  <h1>${name} &mdash; Business Plan</h1>
  <p>Generated: ${escHtml(date)} &middot; Card v${version}</p>
${sectionHtml}
${financialHtml}
  <div class="appendix">
    <h2>Appendix: Strategic Data (Inferred)</h2>
    <p>The following data was inferred from your website and is provided for context only.
       Confirm with owner before using in any external document.</p>
    <h3>SWOT Analysis</h3>
    ${swotHtml}
    <h3>Target Personas</h3>
    ${personasHtml}
    <h3>Competitor Overview</h3>
    ${competitorsHtml}
  </div>
</body>
</html>`;
}
