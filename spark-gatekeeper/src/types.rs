use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Card types (mirror the compiler output) ──────────────────────────────────

/// The seven acting-hash keys in canonical order.
pub const ACTING_KEYS: [&str; 7] = [
    "identity",
    "voice",
    "offerings",
    "operations",
    "policies",
    "handoff",
    "knowledge",
];

/// A policy as it appears on the card: the business's own words only.
///
/// The compiler derives risk/verdict into the *policy seed* separately —
/// `dna-foundry/compiler/src/index.ts` maps `card.policies` through
/// `riskForTopic()` to build `PolicyRule[]`. A card policy therefore never
/// carries a `risk` field, which is why this is a distinct type from
/// `PolicyRule` rather than a reuse of it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardPolicy {
    pub topic: String,
    pub rule: String,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Card {
    pub id: String,
    pub version: u32,
    pub hash: String,
    pub acting_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_version: Option<u32>,
    pub organization_id: String,
    pub status: CardStatus,
    pub created_at: String,
    pub identity: serde_json::Value,
    pub voice: serde_json::Value,
    pub offerings: Vec<serde_json::Value>,
    pub operations: serde_json::Value,
    pub policies: Vec<CardPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handoff: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub knowledge: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_provenance: Option<HashMap<String, serde_json::Value>>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CardStatus {
    Draft,
    OwnerConfirmed,
    Live,
}

// ── Policy seed (compiler output: policy-seed.json) ──────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicySeed {
    pub card_id: String,
    pub card_version: u32,
    pub generated_at: String,
    pub rules: Vec<PolicyRule>,
    pub defaults: PolicyDefaults,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyRule {
    pub topic: String,
    pub rule: String,
    pub risk: RiskLevel,
    pub verdict: PolicyVerdict,
    pub source_confidence: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyVerdict {
    Allow,
    ApprovalRequired,
    Escalate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyDefaults {
    pub low: PolicyVerdict,
    pub medium: PolicyVerdict,
    pub high: PolicyVerdict,
}

impl PolicyDefaults {
    pub fn verdict_for(&self, risk: &RiskLevel) -> &PolicyVerdict {
        match risk {
            RiskLevel::Low => &self.low,
            RiskLevel::Medium => &self.medium,
            RiskLevel::High => &self.high,
        }
    }
}

// ── Tool allowlist (compiler output: tool-allowlist.json) ────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolAllowlist {
    pub card_id: String,
    pub tools: Vec<AllowedTool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllowedTool {
    pub tool: String,
    pub reason: String,
}

impl ToolAllowlist {
    pub fn contains(&self, tool_name: &str) -> bool {
        self.tools.iter().any(|t| t.tool == tool_name)
    }
}

// ── Session ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub card_id: String,
    pub card_version: u32,
    /// acting_hash the session was born against. Stale = reject.
    pub acting_hash: String,
    pub birth_receipt_id: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

impl Session {
    pub fn is_expired(&self) -> bool {
        Utc::now() > self.expires_at
    }
}

// ── Operation / Action ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Action {
    pub id: String,
    pub session_id: String,
    pub kind: ActionKind,
    pub tool: Option<String>,
    pub payload: serde_json::Value,
    pub acting_hash: String,
    pub initiated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    Birth,
    Think,
    Act,
    Deploy,
    Publish,
    Send,
    Mutate,
}

impl ActionKind {
    pub fn requires_live_card(&self) -> bool {
        matches!(self, ActionKind::Deploy | ActionKind::Publish | ActionKind::Send)
    }
}

// ── Gate context (immutable, passed to every gate) ───────────────────────────

#[derive(Debug, Clone)]
pub struct GateContext {
    pub card: Card,
    pub policy_seed: PolicySeed,
    pub tool_allowlist: ToolAllowlist,
    pub session: Option<Session>,
    pub action: Action,
}

// ── Verdict and gate result ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Verdict {
    Allow,
    Deny { reason: String },
    Escalate { reason: String },
}

impl Verdict {
    pub fn is_deny(&self) -> bool {
        matches!(self, Verdict::Deny { .. })
    }
    pub fn is_escalate(&self) -> bool {
        matches!(self, Verdict::Escalate { .. })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GateTrail {
    pub principle: String,
    pub verdict: Verdict,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GateResult {
    pub action_id: String,
    pub final_verdict: Verdict,
    pub trail: Vec<GateTrail>,
    pub receipt_id: String,
    pub checked_at: DateTime<Utc>,
}

// ── Receipt (hash-chained) ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Receipt {
    pub id: String,
    pub card_id: String,
    pub card_version: u32,
    pub acting_hash: String,
    pub action_id: String,
    pub final_verdict: Verdict,
    pub trail: Vec<GateTrail>,
    pub previous_receipt_id: Option<String>,
    pub minted_at: DateTime<Utc>,
}
