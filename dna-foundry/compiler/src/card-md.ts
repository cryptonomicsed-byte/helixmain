/**
 * CARD.md — business-card/0.1 emitter.
 *
 * The card is the product: a markdown file any agent can read cold.
 * Sections, in order: Identity, Voice, Sound, Offer, Operations, Policy,
 * Handoff, Knowledge, Provenance, Changelog, Appendix (optional, not quotable).
 *
 * Acting layer = identity, voice, offerings, operations, policies, handoff,
 * knowledge. acting_hash covers exactly those card fields (canonical JSON),
 * so consumers can pin the quotable surface and reload when it changes.
 * Appendix (strategy, customers, competitors, insights, visual) is for humans
 * and planners: never quoted in replies, never part of acting_hash.
 *
 * Mirror image of card-md-parse — every line written here is read back there.
 */
import { createHash } from "crypto";
import { canonicalJson, cardHash } from "./business-md";

/** Card-level keys that form the acting (quotable) layer. */
export const ACTING_KEYS = [
  "identity",
  "voice",
  "offerings",
  "operations",
  "policies",
  "handoff",
  "knowledge",
] as const;

/** SHA-256 hex of the canonical JSON of the acting layer only. */
export function actingHash(card: any): string {
  const body: any = {};
  for (const k of ACTING_KEYS) if (card[k] !== undefined) body[k] = card[k];
  return createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
}

const EM = "—";
const MID = "·";

function bl(s: string): string {
  return "- " + s;
}

/**
 * Join list values, escaping the separator character inside values so the
 * parser can split the line back into exactly the original items.
 */
function joinList(vals: string[], sep: string): string {
  const c = sep.trim(); // ";" or ","
  return vals.map((v) => String(v).split(c).join("\\" + c)).join(sep);
}

/**
 * Machine anchor: the exact JSON of a list entry, authoritative for
 * round-trip parsing. Human bullets above it stay the readable surface;
 * the parser trusts the anchor when present (hand-written cards without
 * anchors fall back to parsing the bullets). The anchor's content feeds
 * the parsed card, so tampering with it breaks the frontmatter hash.
 */
function machine(tag: string, obj: any): string {
  return `<!-- machine:${tag} ${JSON.stringify(obj)} -->`;
}

/** Versioned machine anchor: <!-- machine:tag@version {...} --> */
function machineV(tag: string, version: number, obj: any): string {
  return `<!-- machine:${tag}@${version} ${JSON.stringify(obj)} -->`;
}

function present(parts: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const p of parts) if (p) out.push(p);
  return out;
}

const esc = (s: string) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const jstr = (s: string) => '"' + esc(s) + '"';

function ownerPrompt(topic: string): string {
  return `> _To be completed with the owner — ${topic}_`;
}

/** Fixed-shape YAML for the Sound section. Values are JSON-quoted so the
 *  tiny line parser in card-md-parse can read them back losslessly.
 *  Keys are written only when present in the card ("asset_ref" in obj),
 *  so explicit nulls round-trip as nulls and absent keys stay absent. */
function emitSoundYaml(sonic: any): string[] {
  const L: string[] = ["```yaml", "sound:"];
  const pairs = (list: Array<[string, string]>) =>
    "{" + list.map(([k, v]) => `${k}: ${v}`).join(", ") + "}";
  const stateOf = (a: any) => (a && a.asset_ref ? "ready" : "staged");

  const logo = sonic.sonic_logo || {};
  const lp: Array<[string, string]> = [["state", stateOf(logo)]];
  if ("description" in logo) lp.push(["brief", jstr(logo.description)]);
  if ("asset_ref" in logo) lp.push(["asset", logo.asset_ref ? jstr(logo.asset_ref) : "null"]);
  if ("duration_s" in logo) lp.push(["seconds", String(logo.duration_s)]);
  L.push("  logo: " + pairs(lp));

  const vlogo = sonic.voice_logo || {};
  const vp: Array<[string, string]> = [["state", stateOf(vlogo)]];
  if ("script" in vlogo) vp.push(["line", jstr(vlogo.script)]);
  if ("voice_profile" in vlogo) vp.push(["voice", jstr(vlogo.voice_profile)]);
  if ("asset_ref" in vlogo) vp.push(["asset", vlogo.asset_ref ? jstr(vlogo.asset_ref) : "null"]);
  L.push("  voice_logo: " + pairs(vp));

  L.push("  ui:");
  const ui: any[] = sonic.ui_sounds || [];
  for (const u of ["notification", "success", "error"]) {
    const found = ui.find((x: any) => x.name === u) || {};
    const up: Array<[string, string]> = [["state", stateOf(found)]];
    if ("description" in found) up.push(["brief", jstr(found.description)]);
    if ("asset_ref" in found) up.push(["asset", found.asset_ref ? jstr(found.asset_ref) : "null"]);
    L.push(`    ${u}: ` + pairs(up));
  }
  L.push("```");
  return L;
}

function hasSonic(sonic: any): boolean {
  if (!sonic) return false;
  const sl = sonic.sonic_logo || {};
  const vl = sonic.voice_logo || {};
  return (
    "description" in sl || "asset_ref" in sl || "duration_s" in sl ||
    "script" in vl || "voice_profile" in vl || "asset_ref" in vl ||
    (Array.isArray(sonic.ui_sounds) && sonic.ui_sounds.length > 0)
  );
}

export function emitCardMd(card: any, changelog: string[]): string {
  const id = card.identity || {};
  const voice = card.voice || {};
  const ops = card.operations || {};
  const cust = card.customers || {};
  // acting_hash is a stored card field covered by the full hash: compute it
  // first so cardHash() sees the same bytes the parser will restore
  const ahash = actingHash(card);
  const hash = cardHash({ ...card, acting_hash: ahash });

  const fm: Array<[string, string]> = [
    ["format", "business-card/0.1"],
    ["id", card.id],
    ["version", String(card.version)],
  ];
  if (card.previous_version !== undefined && card.previous_version !== null)
    fm.push(["previous_version", String(card.previous_version)]);
  fm.push(["previous_hash", card.previous_hash ? "sha256:" + String(card.previous_hash).replace(/^sha256:/, "") : "none"]);
  fm.push(["hash", "sha256:" + hash]);
  fm.push(["acting_hash", "sha256:" + ahash]);
  fm.push(["organization_id", card.organization_id]);
  fm.push(["status", card.status || "draft"]);
  // Omit `updated` entirely when the card carries no timestamp. Writing the
  // literal string "undefined" here (the old behaviour) put that string straight
  // back into the card on parse — a card with no created_at could never verify.
  const updatedTs = card.updated_at || card.created_at;
  if (updatedTs) fm.push(["updated", updatedTs]);

  const L: string[] = [];
  L.push("---");
  for (const pair of fm) L.push(pair[0] + ": " + pair[1]);
  L.push("---", "");
  L.push("# " + (id.name || "Unnamed Business"), "");
  if (id.tagline) L.push("> " + id.tagline, "");

  // 1. Identity
  L.push("## Identity");
  const idEntries: Array<[string, string, string | null | undefined]> = [
    ["name", "Name", id.name],
    ["elevator_pitch", "Pitch", id.elevator_pitch],
    ["mission", "Mission", id.mission],
    ["founded", "Founded", id.founded],
    ["values", "Values", id.values && id.values.length ? joinList(id.values, "; ") : null],
    ["location", "Address", id.address || id.location],
    ["phone", "Phone", id.phone],
    ["email", "Email", id.email],
    ["timezone", "Timezone", id.timezone],
    ["website", "Source", id.source_url || id.website],
  ];
  for (const [key, label, val] of idEntries) {
    if (val) {
      L.push(bl("**" + label + ":** " + val));
      L.push(machineV("identity_value", 1, { key, text: val }));
    }
  }
  // Extra identity scalars the schema permits (identity is additionalProperties:
  // true — extractor supplies review_url, type, etc.). Emitted generically so the
  // parser's key-addressed identity_value reader round-trips them instead of
  // silently dropping them (a dropped field = a card that cannot verify).
  const FIXED_ID_KEYS = new Set([
    "name", "elevator_pitch", "mission", "founded", "values", "tagline",
    "location", "address", "phone", "email", "timezone", "website", "source_url",
    "socials",
  ]);
  const labelFor = (k: string) =>
    k.split("_").map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
  for (const key of Object.keys(id).sort()) {
    if (FIXED_ID_KEYS.has(key)) continue;
    const val = id[key];
    if ((typeof val !== "string" && typeof val !== "number") || val === "") continue;
    L.push(bl("**" + labelFor(key) + ":** " + val));
    L.push(machineV("identity_value", 1, { key, text: val }));
  }
  // Socials — platform -> handle map; one anchor per platform so the parser
  // rebuilds identity.socials exactly (extractor + agentCompiler both read it).
  const socialMap = id.socials;
  if (socialMap && typeof socialMap === "object" && !Array.isArray(socialMap)) {
    for (const platform of Object.keys(socialMap).sort()) {
      const handle = (socialMap as Record<string, any>)[platform];
      if (!handle) continue;
      L.push(bl("**" + labelFor(platform) + ":** " + handle));
      L.push(machineV("social", 1, { platform, handle }));
    }
  }
  L.push("");

  // 2. Voice
  L.push("## Voice");
  L.push.apply(L, present([
    voice.tone && voice.tone.length ? bl("**Tone:** " + joinList(voice.tone, ", ")) : null,
    voice.personality ? bl("**Personality:** " + voice.personality) : null,
    voice.description ? bl("**Description:** " + voice.description) : null,
    voice.sample_phrases && voice.sample_phrases.length
      ? bl("**Samples:** " + voice.sample_phrases.map((p: string) => '"' + esc(p) + '"').join(" " + MID + " "))
      : null,
  ]));
  for (const d of voice.donts || []) {
    L.push(bl("**Don't:** " + d));
    L.push(machineV("voice_dont", 1, { text: d }));
  }
  L.push.apply(L, present([
    voice.lexicon_use && voice.lexicon_use.length ? bl("**Use:** " + joinList(voice.lexicon_use, ", ")) : null,
    voice.lexicon_never && voice.lexicon_never.length ? bl("**Never:** " + joinList(voice.lexicon_never, ", ")) : null,
  ]));
  L.push("");

  // 3. Sound
  L.push("## Sound");
  const sonic = voice.sonic || {};
  if (hasSonic(sonic)) {
    L.push.apply(L, emitSoundYaml(sonic));
  } else {
    L.push(ownerPrompt("no sonic brief yet — run the sonic-brand skill."));
  }
  L.push("");

  // 4. Offer
  L.push("## Offer");
  const offerings = card.offerings || [];
  if (offerings.length) {
    for (const o of offerings) {
      const pairs: string[] = [];
      if (o.kind) pairs.push("kind: " + o.kind);
      if (o.description) pairs.push("note: " + o.description);
      if (o.orderable === true) pairs.push("orderable: yes");
      else if (o.orderable === false) pairs.push("orderable: no");
      pairs.push("price: " + (o.price === undefined || o.price === null ? "null" : String(o.price)));
      if (o.confidence !== undefined && o.confidence !== null) pairs.push("confidence: " + String(o.confidence));
      L.push(bl("**" + o.name + "**" + (pairs.length ? " " + MID + " " + pairs.join(" " + MID + " ") : "")));
      L.push(machineV("offering", 1, o));
    }
  } else {
    L.push(ownerPrompt("the offer list lives here — name, price or null, confidence."));
  }
  // Specials live in their own subsection so the Offer prose fallback (which
  // only ever sees offering bullets) can never mistake them for offerings.
  const specials = card.specials || [];
  if (specials.length) {
    L.push("");
    L.push("### Specials");
    for (const s of specials) {
      const bits: string[] = [];
      if (s.description) bits.push(s.description);
      if (s.price !== undefined) bits.push("price: " + (s.price === null ? "null" : String(s.price)));
      if (s.valid_from) bits.push("from: " + s.valid_from);
      if (s.valid_to) bits.push("to: " + s.valid_to);
      L.push(bl("**" + (s.name || s.title || "Special") + "**" +
        (bits.length ? " " + MID + " " + bits.join(" " + MID + " ") : "")));
      L.push(machineV("special", 1, s));
    }
  }
  L.push("");

  // 5. Operations
  L.push("## Operations");
  if (ops.hours) {
    L.push(bl("**Hours:** " + ops.hours));
    L.push(machineV("hour", 1, { text: ops.hours }));
  }
  for (const c of ops.channels || []) {
    L.push(bl("**Channel:** " + c));
    L.push(machineV("channel", 1, { name: c }));
  }
  L.push.apply(L, present([
    ops.delivery_fence ? bl("**Delivery:** " + ops.delivery_fence) : null,
    ops.catering ? bl("**Catering:** " + ops.catering) : null,
    ops.human_confirm && ops.human_confirm.length ? bl("**Human confirm:** " + joinList(ops.human_confirm, "; ")) : null,
    ops.response_sla ? bl("**Response SLA:** " + ops.response_sla) : null,
    ops.pipeline_stages && ops.pipeline_stages.length ? bl("**Pipeline:** " + joinList(ops.pipeline_stages, "; ")) : null,
    ops.systems && ops.systems.length ? bl("**Systems:** " + joinList(ops.systems, ", ")) : null,
    ops.notes ? bl("**Notes:** " + ops.notes) : null,
  ]));
  if (!ops.hours && !(ops.channels || []).length) L.push(ownerPrompt("hours and channels live here."));
  L.push("");

  // 6. Policy
  L.push("## Policy");
  if ((card.policies || []).length) {
    for (const pl of card.policies || []) {
      L.push(bl("**" + pl.topic + ":** " + pl.rule));
      L.push(machineV("policy", 1, pl));
    }
  } else {
    L.push(ownerPrompt("refunds, cancellations, allergens, house rules — the agent hands off what isn't written here."));
  }
  // policy_donts — the guardrail compiler's hard "never" list. Own subsection so
  // they can never be parsed back as policies (they carry no topic).
  const policyDonts = card.policy_donts || [];
  if (policyDonts.length) {
    L.push("");
    L.push("### Don'ts");
    for (const d of policyDonts) {
      L.push(bl("**Never:** " + d));
      L.push(machineV("policy_dont", 1, { text: d }));
    }
  }
  L.push("");

  // 7. Handoff
  L.push("## Handoff");
  const ho = card.handoff || {};
  if (ho.open_hours || ho.channel || ho.after_hours || (ho.to_human || []).length || ho.contact) {
    L.push.apply(L, present([
      ho.open_hours ? bl("**Open hours:** " + ho.open_hours) : null,
      ho.channel ? bl("**Channel:** " + ho.channel) : null,
      ho.after_hours ? bl("**After hours:** " + ho.after_hours) : null,
      ho.to_human && ho.to_human.length ? bl("**To human:** " + joinList(ho.to_human, "; ")) : null,
      ho.contact ? bl("**Contact:** " + ho.contact) : null,
    ]));
  } else {
    L.push(ownerPrompt("when the agent hands off to a human, and what happens after hours."));
  }
  L.push("");

  // 8. Knowledge
  L.push("## Knowledge");
  if ((card.knowledge || []).length) {
    for (const k of card.knowledge || []) {
      L.push(bl("[" + k.title + "](" + k.ref + ") " + MID + " " + k.kind + " " + MID + " " + (k.chunks || 0) + " chunks"));
      L.push(machineV("knowledge", 1, k));
    }
  } else {
    L.push(ownerPrompt("menus, price lists, FAQs, documents the agent should be grounded in."));
  }
  L.push("");

  // 9. Provenance
  L.push("## Provenance");
  const fields = Object.keys(card.field_provenance || {}).sort();
  if (fields.length) {
    for (const f of fields) {
      const pr = card.field_provenance[f];
      const conf = typeof pr.confidence === "number" ? JSON.stringify(pr.confidence) : pr.confidence;
      const srcs = (pr.sources || []).join(", ");
      L.push(bl("`" + f + "` " + EM + " sources: [" + srcs + "], confidence " + conf +
        ", extractor: " + (pr.extractor_agent || "unknown") + ", " + (pr.extracted_at || "unknown")));
    }
  } else {
    L.push(ownerPrompt("field-level sources and confidence land here."));
  }
  L.push("");

  // 10. Changelog
  L.push("## Changelog");
  for (const entry of changelog) L.push(bl(entry));
  L.push("");

  // 11. Appendix — not quotable
  const strat = card.strategy || {};
  const swot = strat.swot || {};
  const hasSwot = ["strengths", "weaknesses", "opportunities", "threats"].some(
    (k) => (swot[k] || []).length);
  const hasAppendix =
    strat.positioning || (strat.key_messaging || []).length || hasSwot ||
    (cust.personas || []).length || (cust.touchpoints || []).length ||
    (card.competitors || []).length || (card.insights || []).length ||
    (card.visual && Object.keys(card.visual).length);
  if (hasAppendix) {
    L.push("## Appendix");
    L.push("> Not quotable. For humans and planners only — never speak these in replies.", "");
    if (strat.positioning || (strat.key_messaging || []).length || hasSwot) {
      L.push("### Strategy");
      L.push.apply(L, present([
        strat.positioning ? bl("**Positioning:** " + strat.positioning) : null,
        strat.key_messaging && strat.key_messaging.length
          ? bl("**Key messaging:** " + joinList(strat.key_messaging, "; ")) : null,
      ]));
      if (hasSwot) {
        L.push(bl("**SWOT:**"));
        for (const [label, key] of [["Strengths", "strengths"], ["Weaknesses", "weaknesses"],
                                   ["Opportunities", "opportunities"], ["Threats", "threats"]] as Array<[string, string]>) {
          const vals: string[] = swot[key] || [];
          if (vals.length) L.push("  " + bl("**" + label + ":** " + joinList(vals, "; ")));
        }
      }
      L.push("");
    }
    if ((cust.personas || []).length || (cust.touchpoints || []).length) {
      L.push("### Customers");
      for (const p of cust.personas || []) {
        let line = "**Persona: " + p.name + "**";
        const bits: string[] = [];
        if (p.description) bits.push(p.description);
        if (p.role) bits.push("role: " + p.role);
        if (p.pain_points && p.pain_points.length) bits.push("pain points: " + joinList(p.pain_points, "; "));
        if (p.confidence !== undefined && p.confidence !== null) bits.push("confidence: " + String(p.confidence));
        if (p.source) bits.push("source: " + p.source);
        if (p.inferred) bits.push("inferred — confirm with owner");
        if (bits.length) line += " " + EM + " " + bits.join(" " + MID + " ");
        L.push(bl(line));
      }
      if (cust.touchpoints && cust.touchpoints.length) L.push(bl("**Touchpoints:** " + joinList(cust.touchpoints, ", ")));
      L.push("");
    }
    if ((card.competitors || []).length) {
      L.push("### Competitors");
      for (const c of card.competitors || []) {
        let line = "**" + c.name + "**";
        if (c.positioning) line += " " + EM + " " + c.positioning;
        if (c.note) line += " " + EM + " " + c.note;
        if (c.inferred) line += " (inferred — confirm with owner)";
        L.push(bl(line));
        L.push(machine("competitor", c));
      }
      L.push("");
    }
    if ((card.insights || []).length) {
      L.push("### Insights");
      for (const i of card.insights || []) {
        const ev = i.evidence && i.evidence.length ? " (evidence: " + joinList(i.evidence, "; ") + ")" : "";
        L.push(bl("**" + i.title + "** " + EM + " " + i.detail + ev));
        L.push(machine("insight", i));
      }
      L.push("");
    }
    const vis = card.visual || {};
    if (Object.keys(vis).length) {
      L.push("### Visual");
      L.push.apply(L, present([
        vis.primary_color ? bl("**Primary color:** " + vis.primary_color) : null,
        vis.secondary_color ? bl("**Secondary color:** " + vis.secondary_color) : null,
        vis.font_pairing ? bl("**Font pairing:** " + vis.font_pairing) : null,
        vis.style_keywords && vis.style_keywords.length ? bl("**Style keywords:** " + joinList(vis.style_keywords, ", ")) : null,
        vis.design_system ? bl("**Design system:** " + vis.design_system) : null,
        vis.image_style ? bl("**Image style:** " + vis.image_style) : null,
      ]));
      L.push("");
    }
  }

  return L.join("\n");
}
