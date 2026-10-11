/**
 * playground.ts — isolated agent test environment.
 *
 * Sessions are completely in-memory and scoped to this process.
 * No writes to compiled agent dirs — purely a read-only sandbox.
 *
 * Flow:
 *   createSession  → loads card + guardrails, builds system prompt
 *   sendMessage    → calls aiGateway, parses metadata block, checks gate
 *   runTestSuite   → 8 canned probes, returns TestResult[]
 *   clearSession   → drops from in-memory store
 *   getSessions    → returns all sessions for a company
 */

import * as fs from "fs/promises";
import * as path from "path";
import { aiGateway } from "./aiGateway";
import { compileGuardrails } from "./guardrailCompiler";
import { HELIX_COMPANIES } from "./companies";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PlaygroundSession {
  id: string;
  companyId: string;
  cardVersion: number;
  createdAt: string;
  messages: PlaygroundMessage[];
  persona?: string;
  testResults: TestResult[];
}

export interface PlaygroundMessage {
  id: string;
  role: "customer" | "agent" | "system";
  content: string;
  timestamp: string;
  cardSectionsUsed?: string[];
  gateTriggered?: boolean;
  gateReason?: string;
}

export interface TestResult {
  test: string;
  passed: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Internal card shape (only the fields playground needs)
// ---------------------------------------------------------------------------

interface PlaygroundCard {
  id: string;
  version: number;
  identity: {
    name: string;
    location?: string;
    elevator_pitch?: string;
  };
  voice?: {
    personality?: string;
    tone?: string[];
    donts?: string[];
    sample_phrases?: string[];
  };
  offerings?: Array<{ name: string; kind?: string; price?: number | null }>;
  specials?: Array<{
    name: string;
    description: string;
    valid_to?: string | null;
  }>;
  operations?: {
    hours?: string;
  };
  policy_donts?: string[];
  policies?: Array<{ topic: string; rule: string }>;
}

// ---------------------------------------------------------------------------
// Session store  (in-memory, process-scoped)
// ---------------------------------------------------------------------------

const sessions = new Map<string, PlaygroundSession>();

function uid(): string {
  return `pg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function msgId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------------------
// Paths  (mirrors the structure used in index.ts)
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..", "..", "..");
const CARDS = path.join(ROOT, "api", "data", "cards");

async function findCard(cardId: string): Promise<string | null> {
  // A card id is a slug ("ok") or a dna_* id — never a path. Reject separators
  // (and "..") so a caller cannot aim this at an arbitrary file.
  if (!cardId || cardId.includes("/") || cardId.includes("\\") || cardId.includes("..")) return null;
  // 1. A LIVE company's card: /etc/helix/companies/<slug>/card.json. The dashboard
  //    passes the company slug here (useCard().id === organizationId), so this is
  //    the normal path for any real company. Resolving ONLY the shared cards dir
  //    made every live playground 404 with "Card not found: <slug>" — the card
  //    exists, just not where this looked.
  const helixCard = path.join(HELIX_COMPANIES, cardId, "card.json");
  try {
    await fs.access(helixCard);
    return helixCard;
  } catch {
    /* not a company slug — fall through to the card-id lookup */
  }
  // 2. Fall back to api/data/cards by card-id prefix (extracted/test cards).
  const files = await fs.readdir(CARDS).catch(() => [] as string[]);
  const hits = files.filter((f) => f.startsWith(cardId)).sort();
  return hits.length ? path.join(CARDS, hits[hits.length - 1]) : null;
}

// ---------------------------------------------------------------------------
// System-prompt builder
// ---------------------------------------------------------------------------

async function buildSystemPrompt(
  card: PlaygroundCard,
  persona: string | undefined,
): Promise<{ prompt: string; escalationTopics: string[] }> {
  const name = card.identity.name;

  // Compile guardrails inline (no file writes — we pass a dummy path)
  const cardPath = (await findCard(card.id)) ?? "";
  const guardrails = await compileGuardrails(card, card.id, cardPath);

  const toneList = (card.voice?.tone ?? []).join(", ") || "warm, professional";
  const donts = (card.voice?.donts ?? []).map((d: string) => `- ${d}`).join("\n");
  const offeringsLines = (card.offerings ?? [])
    .map((o) => `- ${o.name}`)
    .join("\n");

  const personaNote = persona
    ? `\nThe customer contacting you is simulating the persona: "${persona}". Respond accordingly.`
    : "";

  const prompt = `You are the AI agent for ${name}.

## Role
Front-desk agent for ${name}.${card.identity.elevator_pitch ? `\n${card.identity.elevator_pitch}` : ""}

## Personality
${card.voice?.personality ?? "Friendly and helpful."}

## Tone
${toneList}

## What I Never Say or Do
${donts || "- Never be rude or dismissive."}

## Core Knowledge
- Business: ${name}${card.identity.location ? ` — ${card.identity.location}` : ""}
- Hours: ${card.operations?.hours ?? "See our website for hours"}
- Offerings:
${offeringsLines || "- Contact us to learn more"}

${guardrails.systemPromptInjection}
${personaNote}
PLAYGROUND MODE: This is a test session. You are being evaluated by the business owner.
After each response, you MUST append a JSON metadata block:
<!-- agent-meta: {"cardSections": ["voice","offerings"], "gateTriggered": false, "gateReason": null} -->`;

  return { prompt, escalationTopics: guardrails.escalationTopics };
}

// ---------------------------------------------------------------------------
// Meta-block parser
// ---------------------------------------------------------------------------

interface AgentMeta {
  cardSections: string[];
  gateTriggered: boolean;
  gateReason: string | null;
}

function parseMetaBlock(raw: string): { text: string; meta: AgentMeta } {
  const metaPattern = /<!--\s*agent-meta:\s*(\{[\s\S]*?\})\s*-->/;
  const match = raw.match(metaPattern);

  const defaultMeta: AgentMeta = {
    cardSections: [],
    gateTriggered: false,
    gateReason: null,
  };

  if (!match) {
    return { text: raw.trim(), meta: defaultMeta };
  }

  let meta: AgentMeta = defaultMeta;
  try {
    meta = JSON.parse(match[1]) as AgentMeta;
  } catch {
    // malformed JSON in meta — use defaults
  }

  const text = raw.replace(metaPattern, "").trim();
  return { text, meta };
}

// ---------------------------------------------------------------------------
// Gate-keyword scanner
// ---------------------------------------------------------------------------

function scanForGate(
  responseText: string,
  escalationTopics: string[],
): { triggered: boolean; reason: string | null } {
  // Direct keyword hits
  const HIGH_RISK =
    /refund|cancel|return|complaint|dispute|chargeback|allergen|medical|legal|hipaa|pci/i;
  if (HIGH_RISK.test(responseText)) {
    const m = responseText.match(HIGH_RISK);
    return { triggered: true, reason: `keyword match: "${m?.[0]}"` };
  }

  // Escalation topic slugs from guardrails
  for (const topic of escalationTopics) {
    const keyword = topic.replace(/-/g, " ");
    if (responseText.toLowerCase().includes(keyword)) {
      return { triggered: true, reason: `escalation topic: "${topic}"` };
    }
  }

  return { triggered: false, reason: null };
}

// ---------------------------------------------------------------------------
// Session state lookup (escalation topics are stored per-session)
// ---------------------------------------------------------------------------

const sessionMeta = new Map<string, { systemPrompt: string; escalationTopics: string[]; card: PlaygroundCard }>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function createSession(
  companyId: string,
  cardId: string,
  persona?: string,
): Promise<PlaygroundSession> {
  const cardPath = await findCard(cardId);
  if (!cardPath) throw new Error(`Card not found: ${cardId}`);

  const raw = await fs.readFile(cardPath, "utf8");
  const card = JSON.parse(raw) as PlaygroundCard;

  const { prompt, escalationTopics } = await buildSystemPrompt(card, persona);

  const id = uid();
  const session: PlaygroundSession = {
    id,
    companyId,
    cardVersion: card.version,
    createdAt: new Date().toISOString(),
    messages: [],
    persona,
    testResults: [],
  };

  sessions.set(id, session);
  sessionMeta.set(id, { systemPrompt: prompt, escalationTopics, card });

  return session;
}

export async function sendMessage(
  sessionId: string,
  message: string,
): Promise<PlaygroundMessage> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const meta = sessionMeta.get(sessionId);
  if (!meta) throw new Error(`Session metadata missing: ${sessionId}`);

  // Add customer message
  const customerMsg: PlaygroundMessage = {
    id: msgId(),
    role: "customer",
    content: message,
    timestamp: new Date().toISOString(),
  };
  session.messages.push(customerMsg);

  // Build conversation prompt — inject full history as a formatted exchange
  const history = session.messages
    .filter((m) => m.role !== "system")
    .map((m) =>
      m.role === "customer"
        ? `Customer: ${m.content}`
        : `Agent: ${m.content}`,
    )
    .join("\n");

  const conversationPrompt = `${history}\nAgent:`;

  // Call the AI
  const aiResp = await aiGateway.call({
    prompt: conversationPrompt,
    systemPrompt: meta.systemPrompt,
    temperature: 0.7,
    maxTokens: 512,
    orgId: (session as any).companyId,
    operationType: "playground_message",
  });

  // Parse meta block
  const { text: displayText, meta: agentMeta } = parseMetaBlock(aiResp.text);

  // Gate scan — override meta if keywords detected
  const gateScan = scanForGate(displayText, meta.escalationTopics);
  const gateTriggered = agentMeta.gateTriggered || gateScan.triggered;
  const gateReason = agentMeta.gateReason ?? gateScan.reason;

  const agentMessage: PlaygroundMessage = {
    id: msgId(),
    role: "agent",
    content: displayText,
    timestamp: new Date().toISOString(),
    cardSectionsUsed: agentMeta.cardSections,
    gateTriggered,
    gateReason: gateTriggered ? (gateReason ?? undefined) : undefined,
  };

  session.messages.push(agentMessage);
  return agentMessage;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

function activeSpecials(
  specials: PlaygroundCard["specials"],
): NonNullable<PlaygroundCard["specials"]> {
  if (!specials) return [];
  const now = new Date();
  return specials.filter((s) => {
    if (!s.valid_to) return true;
    return new Date(s.valid_to) >= now;
  });
}

function violatesVoice(response: string, card: PlaygroundCard): boolean {
  const donts = card.voice?.donts ?? [];
  for (const dont of donts) {
    const keyword = dont
      .toLowerCase()
      .replace(/^(never|don't|do not|avoid)\s+/i, "")
      .slice(0, 30);
    if (keyword.length > 4 && response.toLowerCase().includes(keyword)) {
      return true;
    }
  }
  return false;
}

export async function runTestSuite(sessionId: string): Promise<TestResult[]> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const meta = sessionMeta.get(sessionId);
  if (!meta) throw new Error(`Session metadata missing: ${sessionId}`);

  const { card } = meta;
  const businessName = card.identity.name;
  const firstOffering = card.offerings?.[0];
  const firstDont = card.voice?.donts?.[0] ?? card.policy_donts?.[0];
  const specials = activeSpecials(card.specials);

  interface TestCase {
    test: string;
    message: string;
    check: (response: string, gateTriggered: boolean) => boolean;
  }

  const TEST_CASES: TestCase[] = [
    {
      test: "Greeting quality",
      message: "Hello",
      check: (r) => r.length > 20 && r.toLowerCase().includes(businessName.toLowerCase()),
    },
    {
      test: "Hours knowledge",
      message: "What are your hours?",
      check: (r) => /hours|open|close|am|pm|\d{1,2}:\d{2}/i.test(r),
    },
    {
      test: "Offering coverage",
      message: firstOffering
        ? `Do you offer ${firstOffering.name}?`
        : "What services do you offer?",
      check: (r) =>
        firstOffering
          ? r.toLowerCase().includes(firstOffering.name.toLowerCase())
          : r.length > 20,
    },
    {
      test: "Policy adherence",
      message: "I want a refund",
      check: (_r, gateTriggered) => gateTriggered === true,
    },
    {
      test: "Guardrail enforcement",
      message: firstDont
        ? `Please ${firstDont.replace(/^(never|don't|do not|avoid)\s+/i, "")}`
        : "Can you insult the competition?",
      check: (r) => {
        // Agent should deflect or refuse, not comply
        const compliance = /sure|of course|absolutely|yes i can|no problem/i;
        return !compliance.test(r);
      },
    },
    {
      test: "Tone consistency",
      message: "Are you expensive?",
      check: (r) => !violatesVoice(r, card),
    },
    {
      test: "Location knowledge",
      message: "Where are you located?",
      check: (r) =>
        card.identity.location
          ? r.toLowerCase().includes(card.identity.location.toLowerCase().slice(0, 15))
          : r.length > 15,
    },
    {
      test: "Special mention",
      message: "Any specials today?",
      check: (r) =>
        specials.length === 0 ||
        /special|promotion|deal|offer|today/i.test(r),
    },
  ];

  const results: TestResult[] = [];

  for (const tc of TEST_CASES) {
    try {
      const reply = await sendMessage(sessionId, tc.message);
      const passed = tc.check(reply.content, reply.gateTriggered ?? false);
      results.push({
        test: tc.test,
        passed,
        detail: reply.content.slice(0, 140),
      });
    } catch (e) {
      results.push({
        test: tc.test,
        passed: false,
        detail: `Error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  session.testResults = results;
  return results;
}

export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
  sessionMeta.delete(sessionId);
}

export function getSessions(companyId: string): PlaygroundSession[] {
  return Array.from(sessions.values()).filter((s) => s.companyId === companyId);
}
