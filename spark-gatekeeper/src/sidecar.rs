/// HTTP sidecar proxy — the only egress path from agent to tool bus.
/// Every request passes through SparkGatekeeper::check before forwarding.
/// Absence of a network route to the tool bus (enforced by OpenShell policy)
/// makes bypass structurally impossible: the sidecar IS the only path.
///
/// Protocol: agent POSTs to http://127.0.0.1:9100/invoke with ActionRequest JSON.
/// Sidecar runs the gate, then either:
///   - Allow → forwards to the MCP tool bus and returns the response.
///   - Escalate → enqueues to the hold queue, returns 202 Accepted + hold_id.
///   - Deny → returns 403 Forbidden + the denial receipt.
///
/// This module is a stub for the spike. Full HTTP server wiring uses axum or
/// hyper and is implemented in the binary crate (not the library).
use crate::types::{GateContext, Verdict};
use crate::SparkGatekeeper;

pub struct SidecarConfig {
    /// Address the sidecar listens on (must match OpenShell policy network_policies.hold_queue).
    pub listen_addr: String,
    /// The MCP tool bus URL the sidecar forwards allowed requests to.
    pub tool_bus_url: String,
}

impl Default for SidecarConfig {
    fn default() -> Self {
        Self {
            listen_addr: "127.0.0.1:9100".into(),
            tool_bus_url: "http://127.0.0.1:9200".into(),
        }
    }
}

/// Sidecar response (before HTTP serialization).
#[derive(Debug)]
pub enum SidecarResponse {
    /// Gate passed: the tool bus response body.
    Forwarded { body: String },
    /// Escalated: enqueued, waiting for human approval.
    Held { hold_id: String },
    /// Denied: the full denial receipt as JSON.
    Denied { receipt_json: String },
}

/// Core dispatch logic, separated from HTTP so it's unit-testable.
pub fn dispatch(gatekeeper: &SparkGatekeeper, ctx: &GateContext) -> SidecarResponse {
    let result = gatekeeper.check(ctx);
    match &result.final_verdict {
        Verdict::Allow => {
            // In the real sidecar, this forwards to tool_bus_url.
            // In the test harness, we verify the gate passed — actual forwarding
            // is mocked. The no-bypass integration test confirms that an agent
            // without the sidecar route cannot reach the tool bus directly.
            SidecarResponse::Forwarded {
                body: format!(r#"{{"status":"forwarded","action_id":"{}"}}"#, ctx.action.id),
            }
        }
        Verdict::Escalate { .. } => {
            let hold_id = gatekeeper
                .hold_queue
                .enqueue(ctx, &result)
                .unwrap_or_else(|e| format!("hold_queue_error:{e}"));
            SidecarResponse::Held { hold_id }
        }
        Verdict::Deny { .. } => {
            let receipt = gatekeeper.mint_receipt(ctx, &result, None);
            let receipt_json = serde_json::to_string(&receipt).unwrap_or_default();
            SidecarResponse::Denied { receipt_json }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gates::rhythm::{InMemoryRateLimitStore, RhythmGate};
    use crate::hold_queue::HoldQueue;
    use crate::types::{Action, ActionKind, Card, GateContext, PolicySeed, ToolAllowlist};
    use chrono::Utc;
    use std::sync::Arc;

    const SANTINOS_V4_CARD: &str =
        include_str!("../tests/fixtures/dna_c1640d90_v4.json");
    const SANTINOS_V4_POLICY_SEED: &str =
        include_str!("../tests/fixtures/policy_seed_v4.json");
    const SANTINOS_V4_TOOL_ALLOWLIST: &str =
        include_str!("../tests/fixtures/tool_allowlist_v4.json");

    fn make_gatekeeper() -> SparkGatekeeper {
        let store = Arc::new(InMemoryRateLimitStore::default());
        let rhythm = RhythmGate::new(store);
        let queue = Arc::new(HoldQueue::in_memory().unwrap());
        SparkGatekeeper::new(rhythm, queue)
    }

    fn load() -> (Card, PolicySeed, ToolAllowlist) {
        (
            serde_json::from_str(SANTINOS_V4_CARD).unwrap(),
            serde_json::from_str(SANTINOS_V4_POLICY_SEED).unwrap(),
            serde_json::from_str(SANTINOS_V4_TOOL_ALLOWLIST).unwrap(),
        )
    }

    #[test]
    fn allowed_tool_forwards() {
        let (card, seed, tools) = load();
        let action = Action {
            id: "act_fwd".into(),
            session_id: "sess".into(),
            kind: ActionKind::Birth,
            tool: None,
            payload: serde_json::Value::Null,
            acting_hash: card.acting_hash.clone(),
            initiated_at: Utc::now(),
        };
        let ctx = GateContext { card, policy_seed: seed, tool_allowlist: tools, session: None, action };
        let gk = make_gatekeeper();
        assert!(matches!(dispatch(&gk, &ctx), SidecarResponse::Forwarded { .. }));
    }

    #[test]
    fn draft_deploy_returns_denied() {
        let (card, seed, tools) = load();
        // card.status == Draft
        let action = Action {
            id: "act_deploy".into(),
            session_id: "sess".into(),
            kind: ActionKind::Deploy,
            tool: None,
            payload: serde_json::Value::Null,
            acting_hash: card.acting_hash.clone(),
            initiated_at: Utc::now(),
        };
        let ctx = GateContext { card, policy_seed: seed, tool_allowlist: tools, session: None, action };
        let gk = make_gatekeeper();
        assert!(matches!(dispatch(&gk, &ctx), SidecarResponse::Denied { .. }));
    }

    #[test]
    fn high_risk_action_escalates_to_hold_queue() {
        use crate::types::Session;
        use chrono::Duration;
        let (card, seed, tools) = load();
        let session = Session {
            id: "sess_sidecar".into(),
            card_id: card.id.clone(),
            card_version: card.version,
            acting_hash: card.acting_hash.clone(),
            birth_receipt_id: "rcpt_birth".into(),
            created_at: Utc::now(),
            expires_at: Utc::now() + Duration::hours(1),
        };
        let action = Action {
            id: "act_refund".into(),
            session_id: session.id.clone(),
            kind: ActionKind::Act,
            tool: Some("refunds".into()),
            payload: serde_json::Value::Null,
            acting_hash: card.acting_hash.clone(),
            initiated_at: Utc::now(),
        };
        let ctx = GateContext { card, policy_seed: seed, tool_allowlist: tools, session: Some(session), action };
        let gk = make_gatekeeper();
        let resp = dispatch(&gk, &ctx);
        assert!(matches!(resp, SidecarResponse::Held { .. }), "high risk must hold, got {resp:?}");
        // Verify it's actually in the queue.
        assert_eq!(gk.hold_queue.pending().unwrap().len(), 1);
    }
}
