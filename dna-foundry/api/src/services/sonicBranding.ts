/**
 * sonicBranding — AI-generated jingle briefs from a company card.
 *
 * Generates a JingleBrief (lyrics, BPM, mood, instruments, duration) and a
 * short voiceScript hook that can be synthesized via TTS.
 *
 * Stores results in-memory + persists to JINGLES_PATH on disk.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { aiGateway } from "./aiGateway";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface JingleBrief {
  lyrics: string;
  bpm: number;
  mood: string;
  instruments: string[];
  duration: string;
}

export interface JingleResult {
  companyId: string;
  brief: JingleBrief;
  voiceScript: string;   // text to synthesize as the jingle vocal hook
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const JINGLES_PATH = process.env.JINGLES_PATH ?? "/etc/helix/cache/jingles.json";

const jingleStore = new Map<string, JingleResult>();

/** Load jingle store from disk — called at startup. Never throws. */
export async function loadJingleStore(): Promise<void> {
  try {
    const raw = await fs.readFile(JINGLES_PATH, "utf8");
    const entries = JSON.parse(raw) as Array<[string, JingleResult]>;
    for (const [k, v] of entries) jingleStore.set(k, v);
  } catch {
    // File absent or malformed — start fresh
  }
}

async function saveJingleStore(): Promise<void> {
  try {
    await fs.mkdir(path.dirname(JINGLES_PATH), { recursive: true });
    const entries = Array.from(jingleStore.entries());
    await fs.writeFile(JINGLES_PATH, JSON.stringify(entries, null, 2), "utf8");
  } catch {
    // Disk write failure must never crash the request
  }
}

// ---------------------------------------------------------------------------
// BPM helper
// ---------------------------------------------------------------------------

function bpmForTones(tones: string[]): number {
  const lower = tones.map((t) => t.toLowerCase());
  if (lower.some((t) => ["bold", "energetic", "powerful", "dynamic", "intense"].includes(t))) {
    return 128;
  }
  if (lower.some((t) => ["playful", "fun", "cheerful", "upbeat"].includes(t))) {
    return 112;
  }
  if (lower.some((t) => ["warm", "calm", "gentle", "soft", "peaceful"].includes(t))) {
    return 88;
  }
  if (lower.some((t) => ["professional", "corporate", "formal", "authoritative"].includes(t))) {
    return 100;
  }
  return 104; // neutral default
}

// ---------------------------------------------------------------------------
// generateJingle
// ---------------------------------------------------------------------------

export async function generateJingle(card: Record<string, unknown>, companyId: string): Promise<JingleResult> {
  // Extract card fields
  const identity = (card.identity as Record<string, unknown> | undefined) ?? {};
  const voice = (card.voice as Record<string, unknown> | undefined) ?? {};
  const name = (identity.name as string | undefined) ?? companyId;
  const tagline = (identity.tagline as string | undefined) ?? (identity.elevator_pitch as string | undefined) ?? "";
  const tones: string[] = (voice.tone as string[] | undefined) ?? [];
  const personality = (voice.personality as string | undefined) ?? "friendly and approachable";

  const bpmHint = bpmForTones(tones);
  const toneStr = tones.length > 0 ? tones.join(", ") : "professional, warm";

  const prompt = `You are a sonic branding expert. Create a brand jingle brief for a company called "${name}".
Company tagline: "${tagline || "n/a"}"
Brand personality: ${personality}
Brand tones: ${toneStr}

Return ONLY a JSON object with these exact fields:
{
  "lyrics": "<4 to 8 lines of short, catchy lyrics that match the brand tone>",
  "bpm": <integer between 80 and 140, target near ${bpmHint} for this tone>,
  "mood": "<one short mood description, e.g. 'uplifting and warm'>",
  "instruments": ["<instrument 1>", "<instrument 2>"],
  "duration": "<either '15s' or '30s'>",
  "voiceScript": "<a single short phrase of 5 to 10 words to be spoken or sung as the hook>"
}

Rules:
- lyrics must feel authentic to the brand, not generic
- bpm must be a number, not a string
- instruments: exactly 2 to 3 items
- voiceScript: starts with the company name or a memorable hook phrase`;

  const aiResp = await aiGateway.call({
    prompt,
    jsonMode: true,
    temperature: 0.75,
    maxTokens: 512,
    cacheKey: `jingle:${companyId}:${name}:${toneStr}`,
  });

  // Parse and validate LLM output
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(aiResp.text) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  const brief: JingleBrief = {
    lyrics:      typeof parsed.lyrics      === "string"  ? parsed.lyrics      : `${name} — where every moment counts.`,
    bpm:         typeof parsed.bpm         === "number"  ? Math.round(parsed.bpm) : bpmHint,
    mood:        typeof parsed.mood        === "string"  ? parsed.mood        : toneStr,
    instruments: Array.isArray(parsed.instruments)
      ? (parsed.instruments as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 3)
      : ["piano", "acoustic guitar"],
    duration:    parsed.duration === "30s" ? "30s" : "15s",
  };

  const voiceScript: string =
    typeof parsed.voiceScript === "string" && parsed.voiceScript.trim().length > 0
      ? parsed.voiceScript.trim()
      : `${name} — ${tagline || "here for you"}`;

  const result: JingleResult = {
    companyId,
    brief,
    voiceScript,
    generatedAt: new Date().toISOString(),
  };

  jingleStore.set(companyId, result);
  await saveJingleStore();

  return result;
}

// ---------------------------------------------------------------------------
// getJingle
// ---------------------------------------------------------------------------

export function getJingle(companyId: string): JingleResult | undefined {
  return jingleStore.get(companyId);
}
