/**
 * aiGateway — multi-LLM gateway with:
 *   - neuralCache (SHA-256, 5-minute TTL, in-memory)
 *   - JSON repair (up to 2 attempts)
 *   - cost calculation + logging
 *   - fallback chain (primary → deepseek)
 *   - inference strategies: standard | cot | self_consistency
 *
 * No external LLM SDK dependencies — raw fetch only.
 * Keys come exclusively from process.env.
 */

import { createHash } from "crypto";
import { CostEntry, costLog } from "./costLog";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Provider = "deepseek" | "openai" | "anthropic" | "gemini" | "groq";
export type InferenceStrategy = "standard" | "cot" | "self_consistency";

export interface AiRequest {
  prompt: string;
  systemPrompt?: string;
  provider?: Provider;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  strategy?: InferenceStrategy;
  cacheKey?: string;
}

export interface AiResponse {
  text: string;
  provider: Provider;
  model: string;
  cached: boolean;
  fallbackTriggered: boolean;
  cost: CostEntry;
  repairAttempts: number;
}

// Re-export CostEntry so consumers can import it from here if convenient.
export type { CostEntry };

// ---------------------------------------------------------------------------
// Cost table — per-1M-tokens pricing
// ---------------------------------------------------------------------------

interface ModelPricing {
  inPer1M: number;
  outPer1M: number;
}

const COST_TABLE: Record<string, ModelPricing> = {
  "deepseek-chat":               { inPer1M: 0.14,  outPer1M: 0.28 },
  "gpt-4o-mini":                 { inPer1M: 0.15,  outPer1M: 0.60 },
  "gpt-4o":                      { inPer1M: 2.50,  outPer1M: 10.00 },
  "claude-haiku-4-5":            { inPer1M: 0.80,  outPer1M: 4.00 },
  "gemini-1.5-flash":            { inPer1M: 0.075, outPer1M: 0.30 },
  "llama-3.1-70b-versatile":     { inPer1M: 0.59,  outPer1M: 0.79 },
};
const DEFAULT_PRICING: ModelPricing = { inPer1M: 1.00, outPer1M: 3.00 };

function calcCost(
  provider: Provider,
  model: string,
  tokensIn: number,
  tokensOut: number,
  operationType: string,
): CostEntry {
  const pricing = COST_TABLE[model] ?? DEFAULT_PRICING;
  const costUsd =
    (tokensIn / 1_000_000) * pricing.inPer1M +
    (tokensOut / 1_000_000) * pricing.outPer1M;
  return {
    provider,
    model,
    operationType,
    tokensIn,
    tokensOut,
    costUsd,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// neuralCache
// ---------------------------------------------------------------------------

interface CacheEntry {
  response: AiResponse;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const neuralCache = new Map<string, CacheEntry>();

function cacheGet(key: string): AiResponse | null {
  const entry = neuralCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    neuralCache.delete(key);
    return null;
  }
  return entry.response;
}

function cacheSet(key: string, response: AiResponse): void {
  neuralCache.set(key, { response, expiresAt: Date.now() + CACHE_TTL_MS });
}

function makeCacheKey(req: AiRequest): string {
  const provider = req.provider ?? "deepseek";
  const model = req.model ?? "deepseek-chat";
  const raw = `${provider}:${model}:${req.prompt}:${req.systemPrompt ?? ""}`;
  return createHash("sha256").update(raw).digest("hex");
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

interface ProviderResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

// OpenAI-compatible shape (deepseek / openai / groq)
async function callOpenAICompat(
  url: string,
  apiKey: string,
  model: string,
  systemPrompt: string | undefined,
  userPrompt: string,
  temperature: number,
  maxTokens: number,
  jsonMode: boolean,
): Promise<ProviderResult> {
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: userPrompt });

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const text = json.choices?.[0]?.message?.content ?? "";
  const tokensIn = json.usage?.prompt_tokens ?? 0;
  const tokensOut = json.usage?.completion_tokens ?? 0;
  return { text, tokensIn, tokensOut };
}

// Anthropic
async function callAnthropic(
  apiKey: string,
  model: string,
  systemPrompt: string | undefined,
  userPrompt: string,
  temperature: number,
  maxTokens: number,
): Promise<ProviderResult> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: [{ role: "user", content: userPrompt }],
  };
  if (systemPrompt) body.system = systemPrompt;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from Anthropic: ${text.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const text =
    json.content?.find((b) => b.type === "text")?.text ?? "";
  const tokensIn = json.usage?.input_tokens ?? 0;
  const tokensOut = json.usage?.output_tokens ?? 0;
  return { text, tokensIn, tokensOut };
}

// Gemini
async function callGemini(
  apiKey: string,
  model: string,
  systemPrompt: string | undefined,
  userPrompt: string,
  temperature: number,
  maxTokens: number,
): Promise<ProviderResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  if (systemPrompt) {
    contents.push({ role: "user", parts: [{ text: systemPrompt }] });
    contents.push({ role: "model", parts: [{ text: "Understood." }] });
  }
  contents.push({ role: "user", parts: [{ text: userPrompt }] });

  const body = {
    contents,
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from Gemini: ${text.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
    };
  };

  const text =
    json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const tokensIn = json.usageMetadata?.promptTokenCount ?? 0;
  const tokensOut = json.usageMetadata?.candidatesTokenCount ?? 0;
  return { text, tokensIn, tokensOut };
}

// ---------------------------------------------------------------------------
// Route to provider
// ---------------------------------------------------------------------------

function getEnvKey(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing environment variable: ${name}`);
  return val;
}

async function callProvider(
  provider: Provider,
  model: string,
  systemPrompt: string | undefined,
  userPrompt: string,
  temperature: number,
  maxTokens: number,
  jsonMode: boolean,
): Promise<ProviderResult> {
  switch (provider) {
    case "deepseek":
      return callOpenAICompat(
        "https://api.deepseek.com/v1/chat/completions",
        getEnvKey("DEEPSEEK_API_KEY"),
        model,
        systemPrompt,
        userPrompt,
        temperature,
        maxTokens,
        jsonMode,
      );
    case "openai":
      return callOpenAICompat(
        "https://api.openai.com/v1/chat/completions",
        getEnvKey("OPENAI_API_KEY"),
        model,
        systemPrompt,
        userPrompt,
        temperature,
        maxTokens,
        jsonMode,
      );
    case "groq":
      return callOpenAICompat(
        "https://api.groq.com/openai/v1/chat/completions",
        getEnvKey("GROQ_API_KEY"),
        model,
        systemPrompt,
        userPrompt,
        temperature,
        maxTokens,
        jsonMode,
      );
    case "anthropic":
      return callAnthropic(
        getEnvKey("ANTHROPIC_API_KEY"),
        model,
        systemPrompt,
        userPrompt,
        temperature,
        maxTokens,
      );
    case "gemini":
      return callGemini(
        getEnvKey("GEMINI_API_KEY"),
        model,
        systemPrompt,
        userPrompt,
        temperature,
        maxTokens,
      );
    default: {
      // exhaustive check
      const _: never = provider;
      throw new Error(`Unknown provider: ${String(_)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// JSON repair
// ---------------------------------------------------------------------------

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonBlock(text: string): string | null {
  // Strip markdown code fences first
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) return fenceMatch[1].trim();

  // Extract first {...} or [...] block
  const objMatch = text.match(/(\{[\s\S]*\})/);
  if (objMatch) return objMatch[1];

  const arrMatch = text.match(/(\[[\s\S]*\])/);
  if (arrMatch) return arrMatch[1];

  return null;
}

async function repairJson(
  rawText: string,
  originalPrompt: string,
  provider: Provider,
  model: string,
  systemPrompt: string | undefined,
  temperature: number,
  maxTokens: number,
  attempt: number,
): Promise<{ text: string; attempts: number; extraTokensIn: number; extraTokensOut: number }> {
  let attempts = attempt;
  let extraTokensIn = 0;
  let extraTokensOut = 0;
  let text = rawText;

  // Step 1: direct parse
  if (tryParseJson(text) !== null) return { text, attempts, extraTokensIn, extraTokensOut };

  // Step 2: extract block
  const extracted = extractJsonBlock(text);
  if (extracted && tryParseJson(extracted) !== null) {
    return { text: extracted, attempts, extraTokensIn, extraTokensOut };
  }

  // Steps 3+4: retry with LLM (max 2 total repair attempts)
  while (attempts < 2) {
    attempts++;
    const repairPrompt = `Return ONLY valid JSON, no explanation: ${originalPrompt}`;
    const result = await callProvider(
      provider,
      model,
      systemPrompt,
      repairPrompt,
      temperature,
      maxTokens,
      true,
    );
    extraTokensIn += result.tokensIn;
    extraTokensOut += result.tokensOut;
    text = result.text;

    if (tryParseJson(text) !== null) {
      return { text, attempts, extraTokensIn, extraTokensOut };
    }
    const ex2 = extractJsonBlock(text);
    if (ex2 && tryParseJson(ex2) !== null) {
      return { text: ex2, attempts, extraTokensIn, extraTokensOut };
    }
  }

  throw new Error(
    `REPAIR_FAILED: could not coerce LLM response to valid JSON after ${attempts} repair attempt(s)`,
  );
}

// ---------------------------------------------------------------------------
// self_consistency: call 3x, pick most common answer
// ---------------------------------------------------------------------------

async function selfConsistency(
  provider: Provider,
  model: string,
  systemPrompt: string | undefined,
  userPrompt: string,
  maxTokens: number,
  jsonMode: boolean,
): Promise<{ text: string; totalIn: number; totalOut: number }> {
  const TEMP = 0.7;
  const calls = await Promise.all(
    [0, 1, 2].map(() =>
      callProvider(provider, model, systemPrompt, userPrompt, TEMP, maxTokens, jsonMode),
    ),
  );

  const totalIn = calls.reduce((s, c) => s + c.tokensIn, 0);
  const totalOut = calls.reduce((s, c) => s + c.tokensOut, 0);

  if (jsonMode) {
    // Return the first response that parses as valid JSON (majority not meaningful for structured data)
    for (const c of calls) {
      const extracted = extractJsonBlock(c.text) ?? c.text;
      if (tryParseJson(extracted) !== null) {
        return { text: extracted, totalIn, totalOut };
      }
    }
    // Fallback: first response
    return { text: calls[0].text, totalIn, totalOut };
  }

  // For text: pick the most common answer by exact match
  const freq = new Map<string, number>();
  for (const c of calls) {
    freq.set(c.text, (freq.get(c.text) ?? 0) + 1);
  }
  let best = calls[0].text;
  let bestCount = 0;
  for (const [txt, count] of freq) {
    if (count > bestCount) {
      best = txt;
      bestCount = count;
    }
  }
  return { text: best, totalIn, totalOut };
}

// ---------------------------------------------------------------------------
// AiGateway class
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDER: Provider = "deepseek";
const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_TEMP = 0.7;
const DEFAULT_MAX_TOKENS = 2048;

export class AiGateway {
  async call(req: AiRequest): Promise<AiResponse> {
    const provider: Provider = req.provider ?? DEFAULT_PROVIDER;
    const model = req.model ?? DEFAULT_MODEL;
    const temperature = req.temperature ?? DEFAULT_TEMP;
    const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
    const jsonMode = req.jsonMode ?? false;
    const strategy = req.strategy ?? "standard";

    // Apply CoT
    let systemPrompt = req.systemPrompt;
    if (strategy === "cot") {
      systemPrompt = systemPrompt
        ? `Think step by step. ${systemPrompt}`
        : "Think step by step.";
    }

    // neuralCache check
    const cacheKey = req.cacheKey ?? makeCacheKey({ ...req, provider, model });
    const cached = cacheGet(cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }

    // Dispatch call (with fallback)
    let fallbackTriggered = false;
    let tokensIn = 0;
    let tokensOut = 0;
    let text: string;

    const doCall = async (prov: Provider, mod: string): Promise<ProviderResult> => {
      if (strategy === "self_consistency") {
        const r = await selfConsistency(prov, mod, systemPrompt, req.prompt, maxTokens, jsonMode);
        return { text: r.text, tokensIn: r.totalIn, tokensOut: r.totalOut };
      }
      return callProvider(prov, mod, systemPrompt, req.prompt, temperature, maxTokens, jsonMode);
    };

    let result: ProviderResult;
    try {
      result = await doCall(provider, model);
    } catch (primaryErr) {
      if (provider === DEFAULT_PROVIDER) {
        // Already deepseek — nothing to fall back to
        throw primaryErr;
      }
      fallbackTriggered = true;
      result = await doCall(DEFAULT_PROVIDER, DEFAULT_MODEL);
    }

    text = result.text;
    tokensIn = result.tokensIn;
    tokensOut = result.tokensOut;

    // JSON repair
    let repairAttempts = 0;
    const effectiveProvider = fallbackTriggered ? DEFAULT_PROVIDER : provider;
    const effectiveModel = fallbackTriggered ? DEFAULT_MODEL : model;

    if (jsonMode) {
      const repaired = await repairJson(
        text,
        req.prompt,
        effectiveProvider,
        effectiveModel,
        systemPrompt,
        temperature,
        maxTokens,
        0,
      );
      text = repaired.text;
      repairAttempts = repaired.attempts;
      tokensIn += repaired.extraTokensIn;
      tokensOut += repaired.extraTokensOut;
    }

    // Cost
    const cost = calcCost(
      effectiveProvider,
      effectiveModel,
      tokensIn,
      tokensOut,
      "inference",
    );
    costLog.logCost(cost);

    const response: AiResponse = {
      text,
      provider: effectiveProvider,
      model: effectiveModel,
      cached: false,
      fallbackTriggered,
      cost,
      repairAttempts,
    };

    cacheSet(cacheKey, response);
    return response;
  }
}

export const aiGateway = new AiGateway();
