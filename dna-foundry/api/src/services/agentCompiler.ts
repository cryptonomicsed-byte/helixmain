/**
 * agentCompiler — CARD→agent-config compiler.
 *
 * Reads a card.json and emits four role-specific directories:
 *   {outputDir}/{companyId}/{role}/
 *     soul.md           — personality + behavioural constraints
 *     memory.md         — knowledge base
 *     tool-grants.json  — MCP tool allowlist scoped by role
 *     greeting.txt      — compiled call-open greeting (runtime fills {timeOfDay})
 *     greeting-full.json — full CompiledGreeting object (variants, specials, voiceProfile)
 *
 * Roles: front-desk | sales | content | owner-manager
 */

import * as fs from "fs/promises";
import * as path from "path";
import { compileGuardrails, CompiledGuardrails } from "./guardrailCompiler";
import { compileGreeting } from "./greetingCompiler";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AgentRole = "front-desk" | "sales" | "content" | "owner-manager";

export interface CompileRequest {
  cardPath: string;    // absolute path to card.json
  companyId: string;
  outputDir: string;   // root dir; role dirs created under {outputDir}/{companyId}/{role}/
  roles?: AgentRole[]; // defaults to all four
}

export interface RoleOutputPaths {
  soul: string;
  memory: string;
  toolGrants: string;
  greeting: string;
  greetingFull: string;
}

export interface CompileResult {
  companyId: string;
  cardVersion: number;
  rolesCompiled: AgentRole[];
  outputPaths: Record<AgentRole, RoleOutputPaths>;
  guardrailsPath: string;
  escalationTopics: string[];
  gatedActionCount: number;
}

// ---------------------------------------------------------------------------
// Raw card shape (JSON on disk — snake_case from the Python extractor)
// ---------------------------------------------------------------------------

interface CardOffering {
  name: string;
  kind: string;
  price: number | null;
  orderable: boolean;
  confidence?: number;
}

interface CardSpecial {
  name: string;
  description: string;
  price: number | null;
  valid_from: string | null;
  valid_to: string | null;
}

interface CardPolicy {
  topic: string;
  rule: string;
}

interface CardPersona {
  name: string;
  role: string;
  pain_points: string[];
  source?: string;
}

interface CardCompetitor {
  name: string;
  positioning: string;
}

interface CardInsight {
  title: string;
  detail: string;
}

interface CardJson {
  id: string;
  version: number;
  hash?: string;
  organization_id?: string;
  identity: {
    name: string;
    elevator_pitch?: string;
    tagline?: string;
    location?: string;
    phone?: string;
    website?: string;
    socials?: Record<string, string>;
    values?: string[];
  };
  voice: {
    tone?: string[];
    personality?: string;
    description?: string;
    donts?: string[];
    sample_phrases?: string[];
  };
  offerings?: CardOffering[];
  specials?: CardSpecial[];
  operations?: {
    hours?: string;
    channels?: Array<string | { type: string; handle: string }>;
    response_sla?: string;
  };
  policies?: CardPolicy[];
  policy_donts?: string[];
  strategy?: {
    swot?: {
      strengths?: string[];
      weaknesses?: string[];
      opportunities?: string[];
      threats?: string[];
    };
    positioning?: string;
    key_messaging?: string[];
  };
  customers?: {
    personas?: CardPersona[];
  };
  competitors?: CardCompetitor[];
  insights?: CardInsight[];
}

// ---------------------------------------------------------------------------
// Tool-grant definitions per role
// ---------------------------------------------------------------------------

interface ToolGrant {
  tool: string;
  reason: string;
  gate?: "approval_required";
}

interface ToolGrantsFile {
  role: AgentRole;
  companyId: string;
  cardVersion: number;
  tools: ToolGrant[];
}

const FRONT_DESK_TOOLS: ToolGrant[] = [
  { tool: "kb.search", reason: "answer from knowledge base" },
  { tool: "booking.check_availability", reason: "front-desk can check slots" },
  { tool: "booking.create", reason: "front-desk can book", gate: "approval_required" },
  { tool: "ticket.create", reason: "log customer issues" },
  { tool: "conversation.summarize", reason: "summarise call for handoff" },
];

const SALES_TOOLS: ToolGrant[] = [
  ...FRONT_DESK_TOOLS,
  { tool: "lead.create", reason: "capture new leads" },
  { tool: "lead.qualify", reason: "score and qualify inbound leads" },
  { tool: "lead.update", reason: "update lead record after contact" },
  { tool: "outreach.draft", reason: "draft outreach messages", gate: "approval_required" },
  { tool: "pipeline.view", reason: "read pipeline state for context" },
];

const CONTENT_TOOLS: ToolGrant[] = [
  { tool: "kb.search", reason: "pull brand facts for copy" },
  { tool: "content.draft", reason: "draft campaign assets and social posts" },
  { tool: "content.validate_voice", reason: "check copy against brand voice" },
  { tool: "asset.generate", reason: "generate visual assets", gate: "approval_required" },
  { tool: "social.schedule", reason: "schedule social posts", gate: "approval_required" },
];

// owner-manager gets every tool, no gates
const ALL_TOOLS: ToolGrant[] = [
  { tool: "kb.search", reason: "full knowledge base access" },
  { tool: "booking.check_availability", reason: "check appointment slots" },
  { tool: "booking.create", reason: "create bookings" },
  { tool: "ticket.create", reason: "create support tickets" },
  { tool: "ticket.resolve", reason: "resolve support tickets" },
  { tool: "conversation.summarize", reason: "summarise any conversation" },
  { tool: "lead.create", reason: "capture leads" },
  { tool: "lead.qualify", reason: "qualify leads" },
  { tool: "lead.update", reason: "update leads" },
  { tool: "outreach.draft", reason: "draft outreach" },
  { tool: "pipeline.view", reason: "view pipeline" },
  { tool: "pipeline.edit", reason: "edit pipeline stages" },
  { tool: "content.draft", reason: "draft content" },
  { tool: "content.validate_voice", reason: "validate brand voice" },
  { tool: "asset.generate", reason: "generate assets" },
  { tool: "social.schedule", reason: "schedule social posts" },
  { tool: "card.edit", reason: "edit company card" },
  { tool: "intel.view", reason: "view competitive intelligence" },
  { tool: "report.generate", reason: "generate business reports" },
  { tool: "analytics.view", reason: "view analytics dashboard" },
];

function toolsForRole(role: AgentRole): ToolGrant[] {
  switch (role) {
    case "front-desk":    return FRONT_DESK_TOOLS;
    case "sales":         return SALES_TOOLS;
    case "content":       return CONTENT_TOOLS;
    case "owner-manager": return ALL_TOOLS;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function channelStrings(
  channels: Array<string | { type: string; handle: string }> | undefined,
): string[] {
  if (!channels) return [];
  return channels.map((c) => (typeof c === "string" ? c : `${c.type}: ${c.handle}`));
}

function activeSpecials(specials: CardSpecial[] | undefined): CardSpecial[] {
  if (!specials) return [];
  const now = new Date();
  return specials.filter((s) => {
    if (!s.valid_to) return true; // no expiry = always active
    return new Date(s.valid_to) >= now;
  });
}

function priceDisplay(price: number | null): string {
  return price !== null ? `$${price}` : "Contact for pricing";
}

function yesNo(b: boolean): string {
  return b ? "yes" : "no";
}

/** Simple FAQ inference from offerings + policies */
function inferFaqs(card: CardJson): string[] {
  const name = card.identity.name;
  const faqs: string[] = [];

  if (card.operations?.hours) {
    faqs.push(`**What are your hours?** — ${card.operations.hours}`);
  }
  if (card.identity.location) {
    faqs.push(`**Where are you located?** — ${card.identity.location}`);
  }
  if (card.identity.phone) {
    faqs.push(`**How do I contact you?** — Call us at ${card.identity.phone}`);
  }

  const refundPolicy = card.policies?.find((p) => p.topic === "refunds");
  if (refundPolicy) {
    faqs.push(`**What is your refund/complaint policy?** — ${refundPolicy.rule}`);
  }

  const allergenPolicy = card.policies?.find((p) => p.topic === "allergens");
  if (allergenPolicy) {
    faqs.push(`**Do you accommodate food allergies?** — ${allergenPolicy.rule}`);
  }

  if (faqs.length < 5 && card.offerings && card.offerings.length > 0) {
    const sample = card.offerings.slice(0, 3).map((o) => o.name).join(", ");
    faqs.push(`**What do you offer?** — ${name} offers ${sample}${card.offerings.length > 3 ? " and more" : ""}.`);
  }

  if (faqs.length < 5 && card.operations?.channels) {
    const ch = channelStrings(card.operations.channels).join(", ");
    if (ch) faqs.push(`**How can I reach you?** — You can reach us via: ${ch}`);
  }

  // Trim or pad to exactly 5
  return faqs.slice(0, 5);
}

function roleLabel(role: AgentRole): string {
  switch (role) {
    case "front-desk":    return "Front Desk Agent";
    case "sales":         return "Sales Agent";
    case "content":       return "Content Agent";
    case "owner-manager": return "Owner / Manager Agent";
  }
}

// ---------------------------------------------------------------------------
// soul.md builders
// ---------------------------------------------------------------------------

function buildSoul(role: AgentRole, card: CardJson): string {
  const name = card.identity.name;
  const hashSnip = card.hash ? card.hash.slice(0, 16) : "unknown";
  const toneList = (card.voice.tone ?? []).join(", ");
  const voiceDonts = (card.voice.donts ?? []).map((d) => `- ${d}`).join("\n");
  const policyDonts = (card.policy_donts ?? [])
    .filter((d) => !(card.voice.donts ?? []).includes(d)) // deduplicate
    .map((d) => `- ${d}`)
    .join("\n");
  const allDonts = [voiceDonts, policyDonts].filter(Boolean).join("\n");

  const offeringsLines = (card.offerings ?? [])
    .map((o) => `- I can help with: ${o.name}`)
    .join("\n");

  const frontDeskBase = `---
role: ${role}
company: ${name}
version: ${card.version}
card_hash: ${hashSnip}
---

# ${name} — ${roleLabel(role)}

## Personality
${card.voice.personality ?? "Friendly and helpful."}

## Tone
${toneList || "warm, professional"}

## How I Sound
${card.voice.description ?? "Clear, helpful, and approachable."}

## What I Never Say or Do
${allDonts || "- Never be rude or dismissive."}

## My Greeting
Good {timeOfDay}, thank you for calling ${name}. How can I help you today?

## Core Knowledge
- I represent ${name}${card.identity.location ? ` located at ${card.identity.location}` : ""}
- Hours: ${card.operations?.hours ?? "See our website for hours"}
- Phone: ${card.identity.phone ?? "See our website for contact details"}
${offeringsLines}

## Hard Rules
- Never quote inferred data (competitors, SWOT, personas) to customers
- For refund/complaint/dispute topics: always escalate to owner
- For allergen/medical questions: always defer to staff
- Never promise something not in my card`;

  if (role === "front-desk") {
    return frontDeskBase;
  }

  if (role === "sales") {
    const swot = card.strategy?.swot;
    const strengthLines = (swot?.strengths ?? []).map((s) => `- ${s}`).join("\n");
    const weaknessLines = (swot?.weaknesses ?? []).map((w) => `- ${w}`).join("\n");
    const personaLines = (card.customers?.personas ?? [])
      .map((p) => `- **${p.name}** (${p.role}): ${p.pain_points.join("; ")}`)
      .join("\n");
    const competitorLines = (card.competitors ?? [])
      .map((c) => `- ${c.name}: ${c.positioning}`)
      .join("\n");

    return `${frontDeskBase}

## Sales Context (Owner-Visible Only)

### Positioning
${card.strategy?.positioning ?? "Not specified."}

### Key Messaging
${(card.strategy?.key_messaging ?? []).map((m) => `- ${m}`).join("\n") || "- See card for details"}

### SWOT
**Strengths:**
${strengthLines || "- See card for details"}

**Weaknesses:**
${weaknessLines || "- See card for details"}

### Customer Personas
${personaLines || "- Not yet defined — confirm with owner"}

### Competitors (Inferred — Confirm with Owner)
${competitorLines || "- Not yet identified"}

### Outreach Capability
I can draft personalised outreach messages and qualify inbound leads. All outreach drafts require owner approval before sending.`;
  }

  if (role === "content") {
    const keyMsg = (card.strategy?.key_messaging ?? []).map((m) => `- ${m}`).join("\n");
    const samplePhrases = (card.voice.sample_phrases ?? []).map((p) => `- "${p}"`).join("\n");

    return `${frontDeskBase}

## Brand Voice & Content Guidelines

### Key Messaging
${keyMsg || "- See card for details"}

### Approved Sample Phrases
${samplePhrases || "- See voice section of card"}

### Positioning Statement
${card.strategy?.positioning ?? "Not specified."}

### Campaign Guidelines
- All content must reflect the tone: ${toneList || "warm, professional"}
- Never use language that contradicts the \`What I Never Say or Do\` section
- Every asset must be reviewed by the owner before publishing
- Cite only confirmed card data — never inferred competitors or SWOT in public copy`;
  }

  // owner-manager — full access, no restrictions on Appendix data
  const swot = card.strategy?.swot;
  const insightLines = (card.insights ?? [])
    .map((i) => `### ${i.title}\n${i.detail}`)
    .join("\n\n");

  return `${frontDeskBase}

## Extended Access (Owner / Manager)

### Strategy
**Positioning:** ${card.strategy?.positioning ?? "Not specified."}
**Key Messaging:** ${(card.strategy?.key_messaging ?? []).join(" | ") || "See card"}

### SWOT
**Strengths:** ${(swot?.strengths ?? []).join("; ") || "See card"}
**Weaknesses:** ${(swot?.weaknesses ?? []).join("; ") || "See card"}
**Opportunities:** ${(swot?.opportunities ?? []).join("; ") || "Not specified"}
**Threats:** ${(swot?.threats ?? []).join("; ") || "Not specified"}

### Personas
${(card.customers?.personas ?? []).map((p) => `- **${p.name}**: ${p.role}`).join("\n") || "- Not yet defined"}

### Competitors
${(card.competitors ?? []).map((c) => `- ${c.name}: ${c.positioning}`).join("\n") || "- Not yet identified"}

### Intelligence & Insights
${insightLines || "No insights recorded."}

## Privileges
- Full card editing access
- Access to all intel, analytics, and reports
- No topic restrictions`;
}

// ---------------------------------------------------------------------------
// memory.md builder
// ---------------------------------------------------------------------------

function buildMemory(role: AgentRole, card: CardJson): string {
  const name = card.identity.name;

  const offeringsSection = (card.offerings ?? [])
    .map((o) => `### ${o.name}\n- Kind: ${o.kind}\n- Price: ${priceDisplay(o.price)}\n- Orderable: ${yesNo(o.orderable)}`)
    .join("\n\n");

  const active = activeSpecials(card.specials);
  const specialsSection = active.length
    ? active
        .map((s) => `- **${s.name}**: ${s.description}${s.price !== null ? ` — ${priceDisplay(s.price)}` : ""}`)
        .join("\n")
    : "_No active specials at this time._";

  const channelList = channelStrings(card.operations?.channels).join(", ") || "phone";

  const policiesSection = (card.policies ?? [])
    .map((p) => `### ${p.topic}\n${p.rule}`)
    .join("\n\n");

  const faqSection = inferFaqs(card)
    .map((q) => `- ${q}`)
    .join("\n");

  const socialsLines = card.identity.socials
    ? Object.entries(card.identity.socials)
        .map(([platform, handle]) => `- ${platform}: ${handle}`)
        .join("\n")
    : "";

  return `---
role: ${role}
company: ${name}
---

# Knowledge Base: ${name}

## Offerings
${offeringsSection || "_No offerings recorded._"}

## Specials (Active)
${specialsSection}

## Operations
**Hours:** ${card.operations?.hours ?? "See website"}
**Channels:** ${channelList}
**Response SLA:** ${card.operations?.response_sla ?? "We aim to respond promptly."}

## Policies
${policiesSection || "_No policies recorded._"}

## FAQs (inferred)
${faqSection || "_No FAQs inferred._"}

## Location & Contact
- **Address:** ${card.identity.location ?? "See website"}
- **Phone:** ${card.identity.phone ?? "See website"}
- **Website:** ${card.identity.website ?? ""}
${socialsLines}`;
}

// ---------------------------------------------------------------------------
// tool-grants.json builder
// ---------------------------------------------------------------------------

function buildToolGrants(role: AgentRole, companyId: string, cardVersion: number): ToolGrantsFile {
  return {
    role,
    companyId,
    cardVersion,
    tools: toolsForRole(role),
  };
}

// ---------------------------------------------------------------------------
// greeting.txt builder
// ---------------------------------------------------------------------------

function buildGreeting(role: AgentRole, card: CardJson): string {
  const name = card.identity.name;
  const active = activeSpecials(card.specials);

  let specialLine = "";
  if (active.length > 0) {
    const s = active[0];
    specialLine = ` Today we have ${s.name} — ${s.description}.`;
  }

  // Closer adapts to personality tone
  const tone = (card.voice.tone ?? []).map((t) => t.toLowerCase());
  let closer: string;
  if (tone.some((t) => ["warm", "familial", "friendly"].includes(t))) {
    closer = "What can I do for you today?";
  } else if (tone.some((t) => ["professional", "formal"].includes(t))) {
    closer = "How may I assist you?";
  } else {
    closer = "How can I help you today?";
  }

  // front-desk and sales handle calls; content/owner get a generic opener
  if (role === "content") {
    return `Hello! I'm the content assistant for ${name}.${specialLine} ${closer}`;
  }
  if (role === "owner-manager") {
    return `Hello! I'm your owner dashboard assistant for ${name}.${specialLine} ${closer}`;
  }

  return `Good {timeOfDay}, thank you for calling ${name}!${specialLine} ${closer}`;
}

// ---------------------------------------------------------------------------
// Main compiler
// ---------------------------------------------------------------------------

const ALL_ROLES: AgentRole[] = ["front-desk", "sales", "content", "owner-manager"];

export async function compileCard(req: CompileRequest): Promise<CompileResult> {
  const roles: AgentRole[] = req.roles ?? ALL_ROLES;

  // Load card
  const raw = await fs.readFile(req.cardPath, "utf8");
  const card = JSON.parse(raw) as CardJson;

  // Compile guardrails (reads policy-seed.json from cardPath's directory if present)
  const guardrails: CompiledGuardrails = await compileGuardrails(
    card,
    req.companyId,
    req.cardPath,
  );

  // Write guardrails.json to the company root dir
  const companyDir = path.join(req.outputDir, req.companyId);
  await fs.mkdir(companyDir, { recursive: true });
  const guardrailsPath = path.join(companyDir, "guardrails.json");
  await fs.writeFile(guardrailsPath, JSON.stringify(guardrails, null, 2), "utf8");

  // Build a set of gated action names for fast lookup
  const gatedActionSet = new Set(guardrails.gatedActions);

  const outputPaths = {} as Record<AgentRole, RoleOutputPaths>;

  for (const role of roles) {
    const roleDir = path.join(companyDir, role);
    await fs.mkdir(roleDir, { recursive: true });

    const soulPath          = path.join(roleDir, "soul.md");
    const memoryPath        = path.join(roleDir, "memory.md");
    const toolGrantPath     = path.join(roleDir, "tool-grants.json");
    const greetingPath      = path.join(roleDir, "greeting.txt");
    const greetingFullPath  = path.join(roleDir, "greeting-full.json");

    // soul.md — append behavioral constraints section from guardrails
    const soulBase = buildSoul(role, card);
    const soulFull = `${soulBase}\n\n${guardrails.systemPromptInjection}`;
    await fs.writeFile(soulPath, soulFull, "utf8");

    await fs.writeFile(memoryPath, buildMemory(role, card), "utf8");

    // tool-grants.json — mark any tool whose name is in gatedActions
    const grants = buildToolGrants(role, req.companyId, card.version);
    if (gatedActionSet.size > 0) {
      grants.tools = grants.tools.map((t) => {
        if (gatedActionSet.has(t.tool) && t.gate !== "approval_required") {
          return { ...t, gate: "approval_required" as const };
        }
        return t;
      });
    }
    await fs.writeFile(toolGrantPath, JSON.stringify(grants, null, 2), "utf8");

    // greeting — use greetingCompiler for call/sales roles; fall back to basic for internal roles
    if (role === "front-desk" || role === "sales") {
      const compiled = await compileGreeting({ cardPath: req.cardPath, role });
      await fs.writeFile(greetingPath, compiled.text, "utf8");
      await fs.writeFile(greetingFullPath, JSON.stringify(compiled, null, 2), "utf8");
    } else {
      // content / owner-manager: use legacy basic greeting, no greeting-full.json
      await fs.writeFile(greetingPath, buildGreeting(role, card), "utf8");
      await fs.writeFile(greetingFullPath, JSON.stringify({ text: buildGreeting(role, card), voiceProfile: "default", tone: card.voice?.tone ?? [], variants: {}, activeSpecials: [], responseSla: card.operations?.response_sla ?? "as soon as possible" }, null, 2), "utf8");
    }

    outputPaths[role] = {
      soul:         soulPath,
      memory:       memoryPath,
      toolGrants:   toolGrantPath,
      greeting:     greetingPath,
      greetingFull: greetingFullPath,
    };
  }

  return {
    companyId:        req.companyId,
    cardVersion:      card.version,
    rolesCompiled:    roles,
    outputPaths,
    guardrailsPath,
    escalationTopics: guardrails.escalationTopics,
    gatedActionCount: guardrails.gatedActions.length,
  };
}

export const agentCompiler = { compileCard };
