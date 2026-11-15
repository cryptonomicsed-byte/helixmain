//! The policy decision point.
//!
//! The kernel asks a policy service (Clojure, `agent-os/policy`) what should
//! happen to an intent, then applies its own invariants on top. This module is
//! the asking, and it fails closed: if the service cannot be reached, times
//! out, or answers with anything the kernel does not recognise, the answer is
//! DENY. A policy outage blocks privileged operations; it never opens them.

use std::time::Duration;

use serde_json::{json, Value};

use crate::pb;

#[derive(Debug, Clone, PartialEq)]
pub struct PolicyAnswer {
    pub decision: pb::Decision,
    pub matched_rule: String,
    pub reason_codes: Vec<String>,
    pub reason: String,
    pub policy_version: String,
}

impl PolicyAnswer {
    pub fn deny(code: &str, reason: &str) -> Self {
        Self {
            decision: pb::Decision::Deny,
            matched_rule: String::new(),
            reason_codes: vec![code.to_string()],
            reason: reason.to_string(),
            policy_version: String::new(),
        }
    }
}

pub trait PolicyClient: Send + Sync {
    /// `request` follows `helix-policy-request/1` (see the policy service README).
    /// Must not panic. Errors are returned as `Err` and treated as DENY.
    fn decide(&self, request: &Value) -> Result<PolicyAnswer, String>;
    /// Whether the service answered its last health probe.
    fn available(&self) -> bool;
}

pub fn decision_from_str(s: &str) -> Option<pb::Decision> {
    match s {
        "allow" => Some(pb::Decision::Allow),
        "deny" => Some(pb::Decision::Deny),
        "require_user_confirmation" => Some(pb::Decision::RequireUserConfirmation),
        "require_human_review" => Some(pb::Decision::RequireHumanReview),
        _ => None,
    }
}

pub fn parse_answer(v: &Value) -> Result<PolicyAnswer, String> {
    let decision = v
        .get("decision")
        .and_then(Value::as_str)
        .and_then(decision_from_str)
        .ok_or("policy answered with an unknown decision")?;
    let strs = |k: &str| -> Vec<String> {
        v.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default()
    };
    Ok(PolicyAnswer {
        decision,
        matched_rule: v.get("matched_rule").and_then(Value::as_str).unwrap_or("").to_string(),
        reason_codes: strs("reason_codes"),
        reason: v.get("reason").and_then(Value::as_str).unwrap_or("").to_string(),
        policy_version: v.get("policy_version").and_then(Value::as_str).unwrap_or("").to_string(),
    })
}

/// Blocking HTTP client for the policy service.
pub struct HttpPolicy {
    base: String,
    agent: ureq::Agent,
}

impl HttpPolicy {
    pub fn new(base_url: &str, timeout: Duration) -> Self {
        Self {
            base: base_url.trim_end_matches('/').to_string(),
            agent: ureq::AgentBuilder::new().timeout(timeout).build(),
        }
    }
}

impl PolicyClient for HttpPolicy {
    fn decide(&self, request: &Value) -> Result<PolicyAnswer, String> {
        let response = self
            .agent
            .post(&format!("{}/v1/decide", self.base))
            .send_json(request)
            .map_err(|e| format!("policy service unreachable: {e}"))?;
        let body: Value = response.into_json().map_err(|e| format!("policy answer is not JSON: {e}"))?;
        parse_answer(&body)
    }

    fn available(&self) -> bool {
        self.agent.get(&format!("{}/health", self.base)).call().is_ok()
    }
}

/// Always answers the same way. For tests and for running without a policy
/// service in development (with `deny` it is the safe default).
pub struct FixedPolicy(pub PolicyAnswer);

impl PolicyClient for FixedPolicy {
    fn decide(&self, _: &Value) -> Result<PolicyAnswer, String> {
        Ok(self.0.clone())
    }
    fn available(&self) -> bool {
        true
    }
}

/// Builds the request the policy service receives.
pub fn request_for(ctx: &pb::RequestContext, intent: &pb::ActionIntent, agent_status: &str, capabilities: &[String], now: &str) -> Result<Value, String> {
    let args: Value = if intent.arguments_json.is_empty() { json!({}) } else {
        serde_json::from_str(&intent.arguments_json).map_err(|e| e.to_string())?
    };
    let risk = match pb::Risk::try_from(intent.risk) {
        Ok(pb::Risk::Low) => "low",
        Ok(pb::Risk::Medium) => "medium",
        Ok(pb::Risk::High) => "high",
        _ => "unspecified",
    };
    let kind = match pb::PrincipalKind::try_from(ctx.principal_kind) {
        Ok(pb::PrincipalKind::User) => "user",
        Ok(pb::PrincipalKind::Service) => "service",
        Ok(pb::PrincipalKind::Agent) => "agent",
        _ => "unspecified",
    };
    Ok(json!({
        "format": "helix-policy-request/1",
        "now": now,
        "organization_id": ctx.organization_id,
        "principal": {"id": ctx.principal, "kind": kind},
        "agent": {"sid": intent.agent_id, "status": agent_status, "capabilities": capabilities},
        "intent": {
            "id": intent.id,
            "capability": intent.capability,
            "tool": intent.tool,
            "target": intent.target,
            "operation": intent.operation,
            "risk": risk,
            "amount_minor": intent.amount_minor,
            "currency": intent.currency,
            "audience": intent.audience,
            "arguments": args,
        },
    }))
}
