import { canonicalJson, cardHash } from "./business-md";
import { emitCardMd, actingHash, ACTING_KEYS } from "./card-md";
import { parseCardMd, verifyCardMd } from "./card-md-parse";

export { canonicalJson, cardHash, emitCardMd, actingHash, ACTING_KEYS, parseCardMd, verifyCardMd };

/**
 * Helix DNA Foundry — deterministic compiler.
 *
 * card -> { systemPrompt, policySeed, toolAllowlist, ragManifest, dnaFieldsUsed }
 *
 * Pure functions only: no I/O, no network, no LLM. Given the same card the
 * output is byte-identical. Agents never hand-write prompts; they compile them.
 */

export interface PolicyRule {
  topic: string;
  rule: string; // the business's own words, quoted from the card
  risk: "low" | "medium" | "high";
  verdict: "allow" | "approval_required" | "escalate";
  source_confidence: number;
}

export interface PolicySeed {
  card_id: string;
  card_version: number;
  generated_at: string;
  rules: PolicyRule[];
  defaults: {
    // risk verdicts for actions with no card-specific rule (mirrors the CS risk table)
    low: "allow";
    medium: "approval_required";
    high: "escalate";
  };
}

export interface ToolAllowlist {
  card_id: string;
  tools: { tool: string; reason: string }[];
}

export interface RagManifest {
  card_id: string;
  corpora: { ref: string; kind: string; title: string; chunks: number }[];
}

export interface CompiledOutputs {
  cardMd: string;
  systemPrompt: string;
  policySeed: PolicySeed;
  toolAllowlist: ToolAllowlist;
  ragManifest: RagManifest;
  dnaFieldsUsed: string[];
}

/** Map a card policy topic onto the risk/verdict taxonomy. */
function riskForTopic(topic: string): Pick<PolicyRule, "risk" | "verdict"> {
  const t = topic.toLowerCase();
  if (/(refund|return|cancel|payment|billing|charge)/.test(t))
    return { risk: "high", verdict: "approval_required" };
  if (/(escalat|complaint|dispute|legal|security)/.test(t))
    return { risk: "high", verdict: "escalate" };
  if (/(privacy|data)/.test(t)) return { risk: "medium", verdict: "approval_required" };
  return { risk: "low", verdict: "allow" };
}

function prov(card: any, path: string): string {
  const p = card.field_provenance?.[path];
  if (!p) return "unsourced";
  const conf = typeof p.confidence === "number" ? p.confidence.toFixed(2) : "?";
  const src = (p.sources ?? []).join(", ") || "unknown source";
  return `${src} (confidence ${conf}, ${p.extractor_agent ?? "?"})`;
}

export function compilePolicySeed(card: any, now = new Date().toISOString()): PolicySeed {
  const rules: PolicyRule[] = (card.policies ?? []).map((p: any) => {
    const { risk, verdict } = riskForTopic(p.topic ?? "");
    return {
      topic: p.topic,
      rule: p.rule,
      risk,
      verdict,
      source_confidence: card.field_provenance?.["policies"]?.confidence ?? 0,
    };
  });
  return {
    card_id: card.id,
    card_version: card.version,
    generated_at: now,
    rules,
    defaults: { low: "allow", medium: "approval_required", high: "escalate" },
  };
}

const CHANNEL_TOOLS: Record<string, { tool: string; reason: string }[]> = {
  web_chat: [{ tool: "chat.send_reply", reason: "web_chat channel present" }],
  phone: [{ tool: "telephony.place_call", reason: "phone channel present" }],
  email: [{ tool: "email.send", reason: "email channel present" }],
  social: [{ tool: "social.post", reason: "social channel present" }],
  in_person: [],
};

export function compileToolAllowlist(card: any): ToolAllowlist {
  const tools: { tool: string; reason: string }[] = [
    { tool: "kb.search", reason: "answer from approved knowledge base" },
    { tool: "customer.lookup", reason: "read-only customer retrieval" },
    { tool: "order.lookup", reason: "read-only order retrieval" },
    { tool: "ticket.create", reason: "ticket creation is low-risk" },
    { tool: "ticket.update", reason: "ticket updates are low-risk" },
    { tool: "conversation.summarize", reason: "summaries are read-only" },
  ];
  for (const ch of card.operations?.channels ?? []) {
    for (const t of CHANNEL_TOOLS[ch] ?? []) tools.push(t);
  }
  for (const sys of card.operations?.systems ?? []) {
    tools.push({ tool: `integration.${sys}.read`, reason: `system '${sys}' declared on card` });
  }
  // De-dupe by tool name, keep first reason.
  const seen = new Set<string>();
  const deduped = tools.filter((t) => (seen.has(t.tool) ? false : (seen.add(t.tool), true)));
  return { card_id: card.id, tools: deduped };
}

export function compileRagManifest(card: any): RagManifest {
  return {
    card_id: card.id,
    corpora: (card.knowledge ?? []).map((k: any) => ({
      ref: k.ref,
      kind: k.kind,
      title: k.title,
      chunks: k.chunks ?? 0,
    })),
  };
}

export function dnaFieldsUsed(card: any): string[] {
  return Object.keys(card.field_provenance ?? {}).sort();
}

export function compileSystemPrompt(card: any): string {
  const id = card.identity ?? {};
  const voice = card.voice ?? {};
  const ops = card.operations ?? {};
  const L: string[] = [];
  L.push(`# System prompt — compiled from Business DNA card ${card.id} (v${card.version})`);
  L.push(`<!-- DO NOT HAND-EDIT. Re-extract and recompile; agents must never drift on stale prompts. -->`);
  L.push("");
  L.push(`You are the AI employee of **${id.name ?? "this business"}**.`);
  if (id.tagline) L.push(`Tagline: "${id.tagline}"`);
  if (id.elevator_pitch) L.push(`In one sentence: ${id.elevator_pitch}`);
  if (id.mission) L.push(`Mission: ${id.mission}`);
  if (id.values?.length) L.push(`Values: ${id.values.join("; ")}`);
  if (id.location) L.push(`Location: ${id.location}`);
  L.push("");
  L.push("## Voice");
  if (voice.tone?.length) L.push(`Tone: ${voice.tone.join(", ")}.`);
  if (voice.personality) L.push(`Personality: ${voice.personality}`);
  if (voice.description) L.push(voice.description);
  if (voice.sample_phrases?.length) {
    L.push("Speak the way the business speaks. Real phrases from their own site:");
    for (const p of voice.sample_phrases) L.push(`- "${p}"`);
  }
  if (voice.donts?.length) L.push(`Never: ${voice.donts.join("; ")}`);
  const sonic = voice.sonic ?? {};
  if (sonic.voice_type || sonic.music_genre)
    L.push(`Sonic identity: ${[sonic.voice_type, sonic.music_genre].filter(Boolean).join(" · ")}`);
  L.push("");
  if (card.offerings?.length) {
    L.push("## What the business offers");
    for (const o of card.offerings)
      L.push(`- ${o.name}${o.description ? ` — ${o.description}` : ""}${o.price_hint ? ` (${o.price_hint})` : ""}`);
    L.push("");
  }
  const strat = card.strategy ?? {};
  if (strat.positioning || strat.key_messaging?.length || strat.swot) {
    L.push("## Strategy");
    if (strat.positioning) L.push(`Positioning: ${strat.positioning}`);
    if (strat.key_messaging?.length) L.push(`Key messages: ${strat.key_messaging.join("; ")}`);
    const sw = strat.swot ?? {};
    for (const [label, key] of [["Strengths", "strengths"], ["Weaknesses", "weaknesses"], ["Opportunities", "opportunities"], ["Threats", "threats"]] as const) {
      if (sw[key]?.length) L.push(`${label}: ${sw[key].join("; ")}`);
    }
    L.push("");
  }
  const cust = card.customers ?? {};
  if (cust.personas?.length) {
    L.push("## Who you serve");
    for (const p of cust.personas) {
      let line = `- ${p.name}`;
      if (p.role) line += ` (${p.role})`;
      if (p.description) line += `: ${p.description}`;
      if (p.pain_points?.length) line += ` — cares about: ${p.pain_points.join("; ")}`;
      L.push(line);
    }
    L.push("");
  }
  const vis = card.visual ?? {};
  if (vis.primary_color || vis.font_pairing || vis.style_keywords?.length) {
    L.push("## Visual identity");
    if (vis.primary_color) L.push(`Colors: ${vis.primary_color}${vis.secondary_color ? ` / ${vis.secondary_color}` : ""}`);
    if (vis.font_pairing) L.push(`Fonts: ${vis.font_pairing}`);
    if (vis.style_keywords?.length) L.push(`Style: ${vis.style_keywords.join(", ")}`);
    L.push("");
  }
  if (ops.hours) L.push(`## Hours\n${ops.hours}\n`);
  if (card.policies?.length) {
    L.push("## Policies (binding — these become policy-engine rules)");
    for (const p of card.policies) L.push(`- **${p.topic}**: ${p.rule}`);
    L.push("");
  }
  if (card.insights?.length) {
    L.push("## What the data noticed (insights the owner may not have seen)");
    for (const i of card.insights) L.push(`- **${i.title}**: ${i.detail}`);
    L.push("");
  }
  L.push("## Provenance");
  L.push("Every section above traces to card fields. Field provenance:");
  for (const f of dnaFieldsUsed(card)) L.push(`- \`${f}\`: ${prov(card, f)}`);
  L.push("");
  L.push("If a customer asks about something not grounded in this card, say so and offer to escalate.");
  return L.join("\n");
}

export function compileCard(card: any, now = new Date().toISOString(), changelog: string[] = []): CompiledOutputs {
  return {
    cardMd: emitCardMd(card, changelog),
    systemPrompt: compileSystemPrompt(card),
    policySeed: compilePolicySeed(card, now),
    toolAllowlist: compileToolAllowlist(card),
    ragManifest: compileRagManifest(card),
    dnaFieldsUsed: dnaFieldsUsed(card),
  };
}

/** Field-level diff between two card versions. Paths use dotted notation. */
export interface CardDiff {
  from_version: number;
  to_version: number;
  added: string[];
  removed: string[];
  changed: { path: string; from: unknown; to: unknown }[];
}

function flatten(obj: any, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = obj;
  }
  return out;
}

const META = new Set(["id", "hash", "version", "created_at", "previous_version", "field_provenance"]);

export function diffCards(a: any, b: any): CardDiff {
  const fa = flatten(a);
  const fb = flatten(b);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: CardDiff["changed"] = [];
  const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  for (const k of [...keys].sort()) {
    const top = k.split(".")[0].split("[")[0];
    if (META.has(top) || top.startsWith("_")) continue; // _-prefixed keys are ephemeral chain links, not business data
    const va = fa[k];
    const vb = fb[k];
    const sa = JSON.stringify(va);
    const sb = JSON.stringify(vb);
    if (sa === sb) continue;
    if (va === undefined) added.push(k);
    else if (vb === undefined) removed.push(k);
    else changed.push({ path: k, from: va, to: vb });
  }
  return { from_version: a.version, to_version: b.version, added, removed, changed };
}
