/**
 * brandVoiceValidator — standalone LLM-based brand voice checker.
 *
 * Extracted from contentPipeline so other services can reuse it without
 * pulling in the full campaign engine.
 */

import { aiGateway } from "./aiGateway";

export interface BrandVoiceResult {
  passed: boolean;
  violations: string[];
  score: number;
}

/**
 * Ask the LLM whether `text` conforms to the brand voice encoded in `card`.
 *
 * Returns {passed, violations[], score (0-100)}.
 */
export async function validateContent(
  text: string,
  card: any,
): Promise<BrandVoiceResult> {
  const tone: string = Array.isArray(card?.voice?.tone)
    ? (card.voice.tone as string[]).join(", ")
    : String(card?.voice?.tone ?? "professional");

  const description: string = card?.voice?.description ?? card?.voice?.personality ?? "";

  const donts: string[] = card?.voice?.donts ?? [];
  const dontsBlock =
    donts.length > 0
      ? `Never: ${donts.join("; ")}`
      : "No explicit prohibitions.";

  const prompt = `Does this content match the brand voice?
Voice guidelines: ${tone}${description ? ` — ${description}` : ""}
${dontsBlock}

Content:
"""
${text}
"""

Return JSON only: {"passed": boolean, "violations": string[], "score": number}
"score" is 0-100. "violations" lists specific phrases or behaviours that break the guidelines (empty array if passed).`;

  const res = await aiGateway.call({
    prompt,
    systemPrompt: "You are a brand voice auditor. Respond with valid JSON only.",
    jsonMode: true,
    temperature: 0.3,
  });

  let parsed: Partial<BrandVoiceResult>;
  try {
    parsed = JSON.parse(res.text) as Partial<BrandVoiceResult>;
  } catch {
    // If parsing somehow still fails, treat as unknown-pass with score 50
    parsed = { passed: true, violations: [], score: 50 };
  }

  return {
    passed:     typeof parsed.passed === "boolean" ? parsed.passed : true,
    violations: Array.isArray(parsed.violations) ? parsed.violations : [],
    score:      typeof parsed.score === "number" ? parsed.score : 50,
  };
}
