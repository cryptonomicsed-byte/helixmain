/**
 * greetingCompiler — assembles the per-call intro that agent-voice reads at call start.
 *
 * Given a card.json, produces a dynamic CompiledGreeting with:
 *   - Time-aware salutation variants (morning / afternoon / evening / afterHours)
 *   - Business name
 *   - Active special (if any)
 *   - Tone-matched closer
 *   - {timeOfDay} placeholder in `.text` for agent-voice runtime substitution
 *
 * voice.sonic is optional (future WS5 data) — falls back gracefully when absent.
 */

import * as fs from "fs/promises";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GreetingRequest {
  cardPath: string;
  role?: "front-desk" | "sales"; // defaults to front-desk
  includeSpecials?: boolean;      // defaults to true
}

export interface CompiledGreeting {
  text: string;         // runtime greeting — {timeOfDay} placeholder for agent-voice
  voiceProfile: string; // from card voice.sonic.voice_logo.voice_profile or default
  tone: string[];       // card voice.tone
  variants: {           // time-aware variants fully expanded
    morning: string;
    afternoon: string;
    evening: string;
    afterHours: string; // "We're currently closed" variant
  };
  activeSpecials: Array<{ name: string; description: string; price: number | null }>;
  responseSla: string;
}

// ---------------------------------------------------------------------------
// Internal card shape (minimal — only what greetingCompiler needs)
// ---------------------------------------------------------------------------

interface CardSpecial {
  name: string;
  description: string;
  price: number | null;
  valid_from: string | null;
  valid_to: string | null;
}

interface CardJson {
  identity: {
    name: string;
    location?: string;
  };
  voice: {
    tone?: string[];
    sonic?: {
      voice_logo?: {
        script?: string;
        voice_profile?: string;
      };
    };
  };
  operations?: {
    hours?: string;
    response_sla?: string;
  };
  specials?: CardSpecial[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Filter specials to those active as of now. */
function filterActiveSpecials(specials: CardSpecial[] | undefined): CardSpecial[] {
  if (!specials) return [];
  const now = new Date();
  return specials.filter((s) => {
    if (!s.valid_to) return true; // no expiry = always active
    return new Date(s.valid_to) >= now;
  });
}

/**
 * Derive the tone-based closer (call to action) from card tone keywords.
 *
 * Mapping:
 *   warm / familial / welcoming  → "How can we help you today?"
 *   professional / corporate     → "How may I direct your call?"
 *   casual / friendly            → "What can we do for you?"
 *   energetic / exciting         → "How can we help?"
 *   default                      → "How can I help you today?"
 */
function toneCloser(tone: string[]): string {
  const t = tone.map((s) => s.toLowerCase());
  if (t.some((s) => ["warm", "familial", "welcoming"].includes(s))) {
    return "How can we help you today?";
  }
  if (t.some((s) => ["professional", "corporate"].includes(s))) {
    return "How may I direct your call?";
  }
  if (t.some((s) => ["casual", "friendly"].includes(s))) {
    return "What can we do for you?";
  }
  if (t.some((s) => ["energetic", "exciting"].includes(s))) {
    return "How can we help?";
  }
  return "How can I help you today?";
}

/**
 * Full tone-mapped greeting template (name already substituted).
 * Used as the `closer` section that follows the salutation + special.
 *
 * Maps to the spec's greeting style sentences:
 *   warm/familial/welcoming → "Thank you for calling {name}! How can we help you today?"
 *   professional/corporate  → "Thank you for contacting {name}. How may I direct your call?"
 *   casual/friendly         → "Hey, thanks for calling {name}! What can we do for you?"
 *   energetic/exciting      → "Thanks for calling {name} — great to hear from you! How can we help?"
 *   default                 → "Thank you for calling {name}. How can I help you today?"
 */
function toneIntro(name: string, tone: string[]): { prefix: string; closer: string } {
  const t = tone.map((s) => s.toLowerCase());
  if (t.some((s) => ["warm", "familial", "welcoming"].includes(s))) {
    return { prefix: `thank you for calling ${name}!`, closer: "How can we help you today?" };
  }
  if (t.some((s) => ["professional", "corporate"].includes(s))) {
    return { prefix: `thank you for contacting ${name}.`, closer: "How may I direct your call?" };
  }
  if (t.some((s) => ["casual", "friendly"].includes(s))) {
    return { prefix: `hey, thanks for calling ${name}!`, closer: "What can we do for you?" };
  }
  if (t.some((s) => ["energetic", "exciting"].includes(s))) {
    return {
      prefix: `thanks for calling ${name} — great to hear from you!`,
      closer: "How can we help?",
    };
  }
  return { prefix: `thank you for calling ${name}.`, closer: "How can I help you today?" };
}

/** Capitalise first letter. */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Build the optional special line.
 * Returns an empty string when no active special or includeSpecials=false.
 */
function buildSpecialLine(specials: CardSpecial[], include: boolean): string {
  if (!include || specials.length === 0) return "";
  const s = specials[0];
  return `Today's special is ${s.name} — ${s.description}. `;
}

// ---------------------------------------------------------------------------
// Core compiler
// ---------------------------------------------------------------------------

/**
 * Compile a greeting from a card path.
 */
export async function compileGreeting(req: GreetingRequest): Promise<CompiledGreeting> {
  const includeSpecials = req.includeSpecials !== false; // default true

  const raw = await fs.readFile(req.cardPath, "utf8");
  const card = JSON.parse(raw) as CardJson;

  const name = card.identity.name;
  const tone = card.voice.tone ?? [];
  const voiceProfile =
    card.voice?.sonic?.voice_logo?.voice_profile ?? "default";
  const hours = card.operations?.hours ?? "during business hours";
  const responseSla = card.operations?.response_sla ?? "as soon as possible";

  const active = filterActiveSpecials(card.specials);
  const specialLine = buildSpecialLine(active, includeSpecials);

  const { prefix, closer } = toneIntro(name, tone);

  // Check if card has an explicit voice_logo script — use it as base if present,
  // otherwise build from tone rules.
  const scriptBase = card.voice?.sonic?.voice_logo?.script;

  // {text} — placeholder form for agent-voice runtime substitution
  const text = scriptBase
    ? augmentScript(scriptBase, specialLine, closer)
    : `Good {timeOfDay}, ${prefix} ${specialLine}${closer}`;

  // Four fully-expanded variants
  const variants = {
    morning: `Good morning, ${prefix} ${specialLine}${closer}`,
    afternoon: `Good afternoon, ${prefix} ${specialLine}${closer}`,
    evening: `Good evening, ${prefix} ${specialLine}${closer}`,
    afterHours: buildAfterHours(name, hours, responseSla),
  };

  const activeSpecials = active.map((s) => ({
    name: s.name,
    description: s.description,
    price: s.price,
  }));

  return {
    text,
    voiceProfile,
    tone,
    variants,
    activeSpecials,
    responseSla,
  };
}

/**
 * If the card has a pre-written voice_logo script, augment it rather than replace it.
 * We ensure the special line is woven in before the last sentence, and the closer appended
 * if not already present.
 */
function augmentScript(script: string, specialLine: string, closer: string): string {
  let result = script.trim();
  if (specialLine) {
    // Insert special line before the last sentence (if script ends with a full-stop sentence).
    const lastPeriod = result.lastIndexOf(".");
    if (lastPeriod > 0 && lastPeriod < result.length - 1) {
      result =
        result.slice(0, lastPeriod + 1) +
        " " +
        cap(specialLine.trim()) +
        " " +
        result.slice(lastPeriod + 1).trim();
    } else {
      result += " " + cap(specialLine.trim());
    }
  }
  // Replace any existing time placeholder or prepend one
  if (!result.includes("{timeOfDay}")) {
    result = "Good {timeOfDay}, " + result.charAt(0).toLowerCase() + result.slice(1);
  }
  return result;
}

/**
 * Build the after-hours variant.
 * Format: "Thank you for calling {name}. Our hours are {hours}.
 *          Please call back during business hours or leave a message
 *          and we'll get back to you {sla}."
 */
function buildAfterHours(name: string, hours: string, sla: string): string {
  return (
    `Thank you for calling ${name}. Our hours are ${hours}. ` +
    `Please call back during business hours or leave a message and we'll get back to you ${sla}.`
  );
}

export const greetingCompiler = { compileGreeting };
