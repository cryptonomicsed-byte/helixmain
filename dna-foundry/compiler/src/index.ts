import { canonicalJson, cardHash } from "./business-md";
import { emitCardMd, actingHash, ACTING_KEYS } from "./card-md";
import { parseCardMd, verifyCardMd } from "./card-md-parse";

export { canonicalJson, cardHash, emitCardMd, actingHash, ACTING_KEYS, parseCardMd, verifyCardMd };
export {
  compileOpenshellPolicy,
  type SandboxEndpoint,
  type SandboxRuntimeConfig,
  type OpenshellPolicyDocument,
  type CompiledOpenshellPolicy,
} from "./openshell-policy";

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
  hugoSite: Record<string, string>;
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
    const nullPriceNames: string[] = [];
    for (const o of card.offerings) {
      let line = `- ${o.name}`;
      if (o.description) line += ` — ${o.description}`;
      if (o.price != null) {
        line += ` (${o.price_hint ?? "$" + o.price})`;
      } else {
        line += ` (price: not on record)`;
        nullPriceNames.push(o.name);
      }
      L.push(line);
    }
    if (nullPriceNames.length) {
      L.push(`**Do not invent prices.** If asked about the price of ${nullPriceNames.join(" or ")}, say it is not on record and offer to connect the customer with a team member.`);
    }
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

function hugoEsc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Compile a card into Hugo content files. Returns a map of relative path → content.
 *  Reads from the Acting layer only — Appendix data (SWOT, personas, competitors)
 *  never appears on the public site. */
export function compileHugoSite(card: any): Record<string, string> {
  const id = card.identity ?? {};
  const ops = card.operations ?? {};
  const files: Record<string, string> = {};

  // config.toml — site-level metadata
  const cfg: string[] = [
    `baseURL = "${hugoEsc(id.website ?? "/")}"`,
    `languageCode = "en-us"`,
    `title = "${hugoEsc(id.name ?? "Business")}"`,
    "",
    "[params]",
    `  card_id = "${card.id}"`,
    `  card_version = ${card.version}`,
  ];
  if (id.tagline) cfg.push(`  tagline = "${hugoEsc(id.tagline)}"`);
  if (id.elevator_pitch) cfg.push(`  description = "${hugoEsc(id.elevator_pitch)}"`);
  if (id.phone) cfg.push(`  phone = "${hugoEsc(id.phone)}"`);
  if (id.email) cfg.push(`  email = "${hugoEsc(id.email)}"`);
  if (id.location) cfg.push(`  location = "${hugoEsc(id.location)}"`);
  if (ops.hours) cfg.push(`  hours = "${hugoEsc(ops.hours)}"`);
  files["config.toml"] = cfg.join("\n") + "\n";

  // content/_index.md — homepage
  const home: string[] = ["---", `title: "${hugoEsc(id.name ?? "Home")}"`];
  if (id.tagline) home.push(`tagline: "${hugoEsc(id.tagline)}"`);
  if (id.elevator_pitch) home.push(`description: "${hugoEsc(id.elevator_pitch)}"`);
  home.push("---", "");
  if (id.elevator_pitch) home.push(id.elevator_pitch, "");
  else if (id.tagline) home.push(id.tagline, "");
  files["content/_index.md"] = home.join("\n");

  // content/menu.md — offerings (only quotable prices shown; null omitted)
  if (card.offerings?.length) {
    const menu: string[] = ["---", `title: "Menu"`, "---", ""];
    for (const o of card.offerings) {
      let line = `- **${o.name}**`;
      if (o.description) line += ` — ${o.description}`;
      if (o.price != null) line += ` ($${o.price})`;
      menu.push(line);
    }
    files["content/menu.md"] = menu.join("\n") + "\n";
  }

  // content/contact.md — hours, channels, location
  const contact: string[] = ["---", `title: "Contact"`, "---", ""];
  if (ops.hours) contact.push(`**Hours:** ${ops.hours}`, "");
  if (id.phone) contact.push(`**Phone:** ${id.phone}`, "");
  if (id.email) contact.push(`**Email:** ${id.email}`, "");
  if (id.location) contact.push(`**Location:** ${id.location}`, "");
  if (id.website) contact.push(`**Website:** ${id.website}`, "");
  const channels = (ops.channels ?? []).filter((c: string) => c !== "in_person");
  if (channels.length) contact.push(`**Reach us:** ${channels.join(", ")}`, "");
  files["content/contact.md"] = contact.join("\n");

  return files;
}

export function compileCard(card: any, now = new Date().toISOString(), changelog: string[] = []): CompiledOutputs {
  return {
    cardMd: emitCardMd(card, changelog),
    systemPrompt: compileSystemPrompt(card),
    policySeed: compilePolicySeed(card, now),
    toolAllowlist: compileToolAllowlist(card),
    ragManifest: compileRagManifest(card),
    dnaFieldsUsed: dnaFieldsUsed(card),
    hugoSite: compileHugoSite(card),
  };
}

/** Result of confirming inferred fields — promotes them to anchored state. */
export interface ConfirmAnchorsResult {
  md: string;
  promoted: string[];
  oldHash: string;
  newHash: string;
}

/**
 * Promote inferred fields to anchored state by writing machine anchor comments.
 *
 * Algorithm:
 *   1. Parse the CARD.md (does not require a valid hash — draft cards accepted).
 *   2. Collect all inferred fields (queued_for_confirmation: true).
 *   3. Strip those inferred entries from card.field_provenance so the re-emitted
 *      hash reflects the card *without* the inferred provenance flag.
 *   4. Re-emit with emitCardMd — anchors are written for all fields, hash is
 *      recomputed from the clean card object.
 *
 * Hash stability: for a card that was already compiler-created (no inferred
 * provenance), this is a no-op — the hash is unchanged (AC-8 property).
 * For a draft/hand-written card, the hash changes from the draft value to the
 * canonical hash; no version bump is issued because no data changed.
 *
 * Refuses if the card has anchor_missing errors (anchors were deleted).
 */
export function confirmAnchors(raw: string): ConfirmAnchorsResult {
  const parsed = parseCardMd(raw);
  if (parsed.anchorErrors && parsed.anchorErrors.length > 0)
    throw new Error("refusing to confirm: " + parsed.anchorErrors[0]);

  const { card, changelog, frontmatter: fm } = parsed;
  const oldHash = fm.hash || "none";

  const promoted: string[] = [];
  if (card.field_provenance) {
    for (const [key, val] of Object.entries(card.field_provenance as Record<string, any>)) {
      if (val && val.queued_for_confirmation) promoted.push(key);
    }
    for (const key of promoted) delete (card.field_provenance as any)[key];
    if (Object.keys(card.field_provenance).length === 0) delete card.field_provenance;
  }

  const md = emitCardMd(card, changelog);
  const newHashMatch = md.match(/^hash: (sha256:[0-9a-f]+)$/m);
  const newHash = newHashMatch ? newHashMatch[1] : "unknown";
  return { md, promoted, oldHash, newHash };
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
