/**
 * guardrailCompiler — converts card policy fields into compiled guardrails.
 *
 * Sources (in priority order):
 *   1. policy-seed.json  (pre-classified risk from helix-onboard.sh compile_card)
 *   2. policy_donts[]    (top-level card — always `role: all`)
 *   3. voice.donts[]     (voice-level — `role: front-desk`, caller-facing)
 *   4. policies[]        (topic/rule pairs — risk inferred from topic keywords)
 */

import * as fs from "fs/promises";
import * as path from "path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GuardrailType =
  | "never_do"
  | "always_escalate"
  | "require_confirm"
  | "topic_block";

export type GuardrailRisk = "low" | "medium" | "high";

export type GuardrailRole =
  | "all"
  | "front-desk"
  | "sales"
  | "content"
  | "owner-manager";

export interface GuardrailRule {
  id: string;
  type: GuardrailType;
  text: string;
  source: "policy_donts" | "voice_donts" | "policies" | "inference";
  riskLevel: GuardrailRisk;
  role: GuardrailRole;
}

export interface CompiledGuardrails {
  companyId: string;
  cardVersion: number;
  rules: GuardrailRule[];
  systemPromptInjection: string;
  gatedActions: string[];
  escalationTopics: string[];
}

// ---------------------------------------------------------------------------
// Policy-seed shape (subset we care about)
// ---------------------------------------------------------------------------

interface PolicySeedRule {
  topic: string;
  rule: string;
  risk: "low" | "medium" | "high";
  verdict: "allow" | "approval_required" | "escalate";
  source_confidence?: number;
}

interface PolicySeed {
  card_id?: string;
  card_version?: number;
  rules?: PolicySeedRule[];
  defaults?: { low: string; medium: string; high: string };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Slugify a string to kebab-case id */
function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

const HIGH_RISK_PATTERN =
  /refund|cancel|return|complaint|dispute|chargeback|allergen|medical|legal|hipaa|pci/i;

const BOOKING_PATTERN = /book|appointment|reservation|order|schedul/i;
const REFUND_PATTERN = /refund|cancel|discount|chargeback/i;
const SEND_PATTERN = /send|email|sms|message|post|social|publish|broadcast/i;

/** Infer risk level from raw text when no policy-seed entry is available */
function inferRisk(text: string): GuardrailRisk {
  if (HIGH_RISK_PATTERN.test(text)) return "high";
  return "medium";
}

/** Derive guardrail type given risk level and intended default */
function typeFromRisk(
  risk: GuardrailRisk,
  defaultType: GuardrailType = "never_do",
): GuardrailType {
  if (risk === "high") return "always_escalate";
  if (risk === "low") return defaultType;
  return "never_do"; // medium
}

/** Build the gated actions list from compiled rules */
function deriveGatedActions(rules: GuardrailRule[]): string[] {
  const actions = new Set<string>();

  for (const rule of rules) {
    if (rule.type === "always_escalate") {
      actions.add("escalation.trigger");
    }
    if (BOOKING_PATTERN.test(rule.text)) {
      actions.add("booking.create");
      actions.add("order.place");
    }
    if (REFUND_PATTERN.test(rule.text)) {
      actions.add("refund.process");
      actions.add("discount.apply");
    }
    if (SEND_PATTERN.test(rule.text)) {
      actions.add("email.send");
      actions.add("sms.send");
      actions.add("social.post");
    }
  }

  return Array.from(actions).sort();
}

/** Build the system-prompt injection block */
function buildSystemPromptInjection(rules: GuardrailRule[]): string {
  const neverDo = rules.filter((r) => r.type === "never_do");
  const escalate = rules.filter((r) => r.type === "always_escalate");
  const confirm = rules.filter((r) => r.type === "require_confirm");

  const lines: string[] = ["## Behavioral Constraints", ""];

  if (neverDo.length > 0) {
    lines.push("Never do:");
    for (const r of neverDo) {
      lines.push(`- ${r.text}`);
    }
    lines.push("");
  }

  if (escalate.length > 0) {
    lines.push("Always escalate to owner for:");
    for (const r of escalate) {
      lines.push(`- ${r.text}`);
    }
    lines.push("");
  }

  if (confirm.length > 0) {
    lines.push("Require owner confirmation before:");
    for (const r of confirm) {
      lines.push(`- ${r.text}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// Main compiler
// ---------------------------------------------------------------------------

/**
 * Attempt to load a policy-seed.json file adjacent to the card.
 * Returns null if not found or unparseable — callers fall back to inference.
 */
async function loadPolicySeed(
  companyId: string,
  cardVersion: number,
  cardPath: string,
): Promise<PolicySeed | null> {
  // Convention: same directory as card.json
  const cardDir = path.dirname(cardPath);
  const seedPath = path.join(cardDir, "policy-seed.json");

  try {
    const raw = await fs.readFile(seedPath, "utf8");
    return JSON.parse(raw) as PolicySeed;
  } catch {
    // Not found or parse error — not fatal
    return null;
  }
}

/**
 * Compile guardrails from a parsed card object.
 *
 * @param card        The raw card JSON (any shape — we access known fields safely)
 * @param companyId   Company / card identifier
 * @param cardPath    Absolute path to card.json on disk (used to resolve policy-seed)
 */
export async function compileGuardrails(
  card: any,
  companyId: string,
  cardPath: string,
): Promise<CompiledGuardrails> {
  const cardVersion: number = card.version ?? 1;

  // Load policy-seed if available
  const seed = await loadPolicySeed(companyId, cardVersion, cardPath);
  const seedByTopic = new Map<string, PolicySeedRule>();
  for (const sr of seed?.rules ?? []) {
    seedByTopic.set(sr.topic.toLowerCase(), sr);
  }

  const rules: GuardrailRule[] = [];

  // -------------------------------------------------------------------------
  // 1. policy_donts[] — top-level, role: all
  // -------------------------------------------------------------------------
  const policyDonts: string[] = card.policy_donts ?? [];
  for (const text of policyDonts) {
    const risk = inferRisk(text);
    const type: GuardrailType =
      risk === "high" ? "always_escalate" : "never_do";

    rules.push({
      id: toSlug(text),
      type,
      text,
      source: "policy_donts",
      riskLevel: risk,
      role: "all",
    });
  }

  // -------------------------------------------------------------------------
  // 2. voice.donts[] — voice-level, role: front-desk
  // -------------------------------------------------------------------------
  const voiceDonts: string[] = card.voice?.donts ?? [];
  for (const text of voiceDonts) {
    // Skip exact duplicates already captured from policy_donts
    if (policyDonts.includes(text)) continue;

    rules.push({
      id: `voice-${toSlug(text)}`,
      type: "never_do",
      text,
      source: "voice_donts",
      riskLevel: "low",
      role: "front-desk",
    });
  }

  // -------------------------------------------------------------------------
  // 3. policies[] — topic/rule pairs, risk from seed or inference
  // -------------------------------------------------------------------------
  const policies: Array<{ topic: string; rule: string }> = card.policies ?? [];
  for (const policy of policies) {
    const seedEntry = seedByTopic.get(policy.topic.toLowerCase());

    let risk: GuardrailRisk;
    let type: GuardrailType;

    if (seedEntry) {
      risk = seedEntry.risk;
      if (seedEntry.verdict === "escalate") {
        type = "always_escalate";
      } else if (seedEntry.verdict === "approval_required") {
        type = "require_confirm";
      } else {
        // verdict = allow — still emit as low-risk require_confirm so it's
        // visible but not blocking
        type = "require_confirm";
        risk = "low";
      }
    } else {
      // Fall back to keyword inference
      risk = inferRisk(`${policy.topic} ${policy.rule}`);
      type = risk === "high" ? "always_escalate" : "require_confirm";
    }

    rules.push({
      id: `policy-${toSlug(policy.topic)}`,
      type,
      text: `${policy.topic}: ${policy.rule}`,
      source: "policies",
      riskLevel: risk,
      role: "all",
    });
  }

  // -------------------------------------------------------------------------
  // Build derived outputs
  // -------------------------------------------------------------------------
  const gatedActions = deriveGatedActions(rules);
  const escalationTopics = rules
    .filter((r) => r.type === "always_escalate")
    .map((r) => r.id);
  const systemPromptInjection = buildSystemPromptInjection(rules);

  return {
    companyId,
    cardVersion,
    rules,
    systemPromptInjection,
    gatedActions,
    escalationTopics,
  };
}
