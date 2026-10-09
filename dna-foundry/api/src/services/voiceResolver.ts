/**
 * voiceResolver — resolves a card's voice.sonic.voice_logo.voice_profile
 * to a concrete TTS provider + voice ID.
 *
 * voice_profile format: "provider:voiceId"
 *   e.g. "kokoro:af_bella", "avocado_v2:MAI_03" (legacy Kokoro alias), "elevenlabs:21m00Tcm4TlvDq8ikWAM"
 *
 * Primary TTS:  Kokoro   (deployed on Hostinger, port 8880)
 * Fallback TTS: ElevenLabs (premium, cloud)
 *
 * Never embeds keys — callers read process.env[apiKeyEnvVar] themselves.
 */

import https from "https";
import http from "http";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TtsProvider = "kokoro" | "elevenlabs" | "openai-tts" | "browser";

export interface ResolvedVoice {
  provider: TtsProvider;
  voiceId: string;
  voiceName: string;
  language: string;
  gender: "male" | "female" | "neutral";
  style: string;         // warm, professional, casual, etc.
  endpoint: string;      // full TTS API URL
  apiKeyEnvVar: string;  // env var that holds the key — never the value
  sampleText: string;    // greeting text for preview
}

export interface VoicePickerOption {
  id: string;            // "kokoro:af_bella"
  provider: TtsProvider;
  voiceName: string;
  language: string;
  gender: "male" | "female" | "neutral";
  style: string;
  available: boolean;    // can we currently reach this provider?
}

// ---------------------------------------------------------------------------
// Voice catalogs
// ---------------------------------------------------------------------------

const KOKORO_VOICES: VoicePickerOption[] = [
  { id: "kokoro:af_bella",   provider: "kokoro", voiceName: "Bella",   language: "en-US", gender: "female", style: "warm",         available: true },
  { id: "kokoro:af_sarah",   provider: "kokoro", voiceName: "Sarah",   language: "en-US", gender: "female", style: "professional", available: true },
  { id: "kokoro:am_adam",    provider: "kokoro", voiceName: "Adam",    language: "en-US", gender: "male",   style: "casual",       available: true },
  { id: "kokoro:am_michael", provider: "kokoro", voiceName: "Michael", language: "en-US", gender: "male",   style: "professional", available: true },
  { id: "kokoro:bf_emma",    provider: "kokoro", voiceName: "Emma",    language: "en-GB", gender: "female", style: "warm",         available: true },
  { id: "kokoro:bm_george",  provider: "kokoro", voiceName: "George",  language: "en-GB", gender: "male",   style: "professional", available: true },
];

const ELEVENLABS_VOICES: VoicePickerOption[] = [
  { id: "elevenlabs:21m00Tcm4TlvDq8ikWAM", provider: "elevenlabs", voiceName: "Rachel",  language: "en-US", gender: "female", style: "warm",         available: true },
  { id: "elevenlabs:AZnzlk1XvdvUeBnXmlld", provider: "elevenlabs", voiceName: "Domi",    language: "en-US", gender: "female", style: "casual",       available: true },
  { id: "elevenlabs:EXAVITQu4vr4xnSDxMaL", provider: "elevenlabs", voiceName: "Bella",   language: "en-US", gender: "female", style: "professional", available: true },
  { id: "elevenlabs:ErXwobaYiN019PkySvjV",  provider: "elevenlabs", voiceName: "Antoni",  language: "en-US", gender: "male",   style: "warm",         available: true },
  { id: "elevenlabs:VR6AewLTigWG4xSOukaG",  provider: "elevenlabs", voiceName: "Arnold",  language: "en-US", gender: "male",   style: "professional", available: true },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Kokoro base URL — falls back to localhost dev default */
function kokoroBase(): string {
  return (process.env.KOKORO_BASE_URL ?? "http://localhost:8880").replace(/\/$/, "");
}

/** Build Kokoro speech endpoint */
function kokoroEndpoint(): string {
  return `${kokoroBase()}/v1/audio/speech`;
}

/** Build ElevenLabs endpoint for a specific voiceId */
function elevenLabsEndpoint(voiceId: string): string {
  return `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
}

/** Find a voice option by full "provider:voiceId" id across both catalogs */
function findVoiceOption(id: string): VoicePickerOption | undefined {
  return [...KOKORO_VOICES, ...ELEVENLABS_VOICES].find((v) => v.id === id);
}

/**
 * Estimate audio duration from character count.
 * Rough: average TTS speed ~15 chars/second, minimum 1 s.
 */
function estimateDurationMs(text: string): number {
  return Math.max(1000, Math.round((text.length / 15) * 1000));
}

// ---------------------------------------------------------------------------
// resolveVoice
// ---------------------------------------------------------------------------

/**
 * Resolve a voice_profile string + card to a concrete ResolvedVoice.
 *
 * @param voiceProfile  "provider:voiceId" — e.g. "kokoro:af_bella", "avocado_v2:MAI_03"
 * @param card          Raw card JSON — used for fallback tone-matching and sample text
 */
export function resolveVoice(voiceProfile: string, card: Record<string, unknown>): ResolvedVoice {
  // Extract greeting text for sampleText (use front-desk greeting.txt content if available,
  // else build a minimal preview sentence from card identity).
  const identity = (card.identity as Record<string, unknown> | undefined) ?? {};
  const companyName = (identity.name as string | undefined) ?? "us";
  const sampleText = `Good morning, thank you for calling ${companyName}. How can I help you today?`;

  // Parse "provider:voiceId" — handle empty string and missing colon gracefully
  const colonIdx = voiceProfile.indexOf(":");
  const rawProvider = colonIdx > 0 ? voiceProfile.slice(0, colonIdx) : "";
  const rawVoiceId  = colonIdx > 0 ? voiceProfile.slice(colonIdx + 1) : voiceProfile;

  // Normalise legacy alias "avocado_v2" → "kokoro"
  const provider = rawProvider === "avocado_v2" ? "kokoro" : rawProvider;

  // --- Attempt direct catalog lookup first ---
  if (provider === "kokoro" && rawVoiceId) {
    const catalogId = `kokoro:${rawVoiceId}`;
    const opt = findVoiceOption(catalogId);
    if (opt) {
      return {
        provider: "kokoro",
        voiceId: rawVoiceId,
        voiceName: opt.voiceName,
        language: opt.language,
        gender: opt.gender,
        style: opt.style,
        endpoint: kokoroEndpoint(),
        apiKeyEnvVar: "KOKORO_API_KEY",
        sampleText,
      };
    }
  }

  if (provider === "elevenlabs" && rawVoiceId) {
    const catalogId = `elevenlabs:${rawVoiceId}`;
    const opt = findVoiceOption(catalogId);
    if (opt) {
      return {
        provider: "elevenlabs",
        voiceId: rawVoiceId,
        voiceName: opt.voiceName,
        language: opt.language,
        gender: opt.gender,
        style: opt.style,
        endpoint: elevenLabsEndpoint(rawVoiceId),
        apiKeyEnvVar: "ELEVENLABS_API_KEY",
        sampleText,
      };
    }
  }

  // --- Fallback: auto-select from card tone ---
  const voiceSection = (card.voice as Record<string, unknown> | undefined) ?? {};
  const tone: string[] = ((voiceSection.tone as string[] | undefined) ?? []).map((t) => t.toLowerCase());

  let fallbackId: string;
  if (tone.some((t) => ["warm", "familial", "welcoming"].includes(t))) {
    fallbackId = "kokoro:af_bella";
  } else if (tone.some((t) => ["professional", "corporate", "formal"].includes(t))) {
    fallbackId = "kokoro:af_sarah";
  } else if (tone.some((t) => ["casual", "friendly", "energetic"].includes(t))) {
    fallbackId = "kokoro:am_adam";
  } else {
    fallbackId = "kokoro:af_bella"; // default
  }

  const fallbackOpt = findVoiceOption(fallbackId)!;
  const fallbackVoiceId = fallbackId.split(":")[1];

  return {
    provider: "kokoro",
    voiceId: fallbackVoiceId,
    voiceName: fallbackOpt.voiceName,
    language: fallbackOpt.language,
    gender: fallbackOpt.gender,
    style: fallbackOpt.style,
    endpoint: kokoroEndpoint(),
    apiKeyEnvVar: "KOKORO_API_KEY",
    sampleText,
  };
}

// ---------------------------------------------------------------------------
// getVoiceCatalog
// ---------------------------------------------------------------------------

/**
 * Returns all voices: Kokoro first (primary), ElevenLabs second (fallback/premium).
 */
export function getVoiceCatalog(): VoicePickerOption[] {
  return [...KOKORO_VOICES, ...ELEVENLABS_VOICES];
}

// ---------------------------------------------------------------------------
// synthesizeSample
// ---------------------------------------------------------------------------

/** Minimal HTTP POST helper — returns body as Buffer. Throws on non-2xx. */
function httpPost(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(buf);
          } else {
            reject(new Error(`TTS HTTP ${res.statusCode}: ${buf.toString("utf8").slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Synthesise a TTS sample for a resolved voice.
 *
 * Returns `{audioUrl: "data:audio/mp3;base64,...", durationMs}`.
 * If the provider is unreachable returns `{audioUrl: "", durationMs: 0}` — never throws.
 */
export async function synthesizeSample(
  voice: ResolvedVoice,
  text: string,
): Promise<{ audioUrl: string; durationMs: number }> {
  const EMPTY = { audioUrl: "", durationMs: 0 };

  try {
    let audioBuf: Buffer;

    if (voice.provider === "kokoro") {
      const bodyObj = {
        model: "kokoro",
        input: text,
        voice: voice.voiceId,
        response_format: "mp3",
      };
      const apiKey = process.env[voice.apiKeyEnvVar] ?? "";
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      };
      audioBuf = await httpPost(voice.endpoint, headers, JSON.stringify(bodyObj));
    } else if (voice.provider === "elevenlabs") {
      const apiKey = process.env[voice.apiKeyEnvVar] ?? "";
      if (!apiKey) return EMPTY; // ElevenLabs always requires a key
      const bodyObj = {
        text,
        model_id: "eleven_monolingual_v1",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      };
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      };
      audioBuf = await httpPost(voice.endpoint, headers, JSON.stringify(bodyObj));
    } else {
      // openai-tts / browser — not implemented as server-side synthesis
      return EMPTY;
    }

    const audioUrl = `data:audio/mp3;base64,${audioBuf.toString("base64")}`;
    const durationMs = estimateDurationMs(text);
    return { audioUrl, durationMs };
  } catch {
    // Provider unreachable or returned an error — fail open
    return EMPTY;
  }
}
