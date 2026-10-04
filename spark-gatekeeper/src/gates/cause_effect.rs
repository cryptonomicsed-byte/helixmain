/// FOUNDATION gate — no bypass, causal attribution.
/// Every action must have an attributable cause and flow through the sidecar.
use crate::types::{ActionKind, GateContext, Verdict};

pub struct CauseEffectGate;

impl CauseEffectGate {
    pub fn principle(&self) -> &'static str {
        "cause_effect"
    }

    pub fn check(&self, ctx: &GateContext) -> Verdict {
        // Every non-birth action requires a session (causal chain from birth).
        if ctx.action.kind != ActionKind::Birth && ctx.session.is_none() {
            return Verdict::Deny {
                reason: "no causal chain: session required (was birth invoked?)".into(),
            };
        }

        // Every action must have an attributable cause:
        // - birth: no prior receipt needed (it IS the first cause)
        // - think/act/deploy/publish/send/mutate: session_id must be set
        if ctx.action.kind != ActionKind::Birth && ctx.action.session_id.is_empty() {
            return Verdict::Deny {
                reason: "action missing session_id: causal attribution required".into(),
            };
        }

        // Direct tool access bypass check: actions must not carry a
        // `bypass_sidecar` marker. The sidecar sets the opposite marker;
        // absence is fine. Presence of bypass = explicit bypass attempt.
        if ctx.action.payload.get("bypass_sidecar").is_some() {
            return Verdict::Deny {
                reason: "bypass_sidecar marker detected: direct tool access is not permitted".into(),
            };
        }

        Verdict::Allow
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Action, ActionKind, Card, GateContext, PolicySeed, ToolAllowlist};
    use chrono::Utc;

    const SANTINOS_V4_CARD: &str =
        include_str!("../../tests/fixtures/dna_c1640d90_v4.json");
    const SANTINOS_V4_POLICY_SEED: &str =
        include_str!("../../tests/fixtures/policy_seed_v4.json");
    const SANTINOS_V4_TOOL_ALLOWLIST: &str =
        include_str!("../../tests/fixtures/tool_allowlist_v4.json");

    fn load() -> (Card, PolicySeed, ToolAllowlist) {
        (
            serde_json::from_str(SANTINOS_V4_CARD).unwrap(),
            serde_json::from_str(SANTINOS_V4_POLICY_SEED).unwrap(),
            serde_json::from_str(SANTINOS_V4_TOOL_ALLOWLIST).unwrap(),
        )
    }

    fn action(card: &Card, kind: ActionKind, payload: serde_json::Value) -> Action {
        Action {
            id: "act_test".into(),
            session_id: if kind == ActionKind::Birth { "".into() } else { "sess_test".into() },
            kind,
            tool: None,
            payload,
            acting_hash: card.acting_hash.clone(),
            initiated_at: Utc::now(),
        }
    }

    fn ctx(card: Card, seed: PolicySeed, tools: ToolAllowlist, act: Action) -> GateContext {
        GateContext { card, policy_seed: seed, tool_allowlist: tools, session: None, action: act }
    }

    #[test]
    fn normal_action_allows() {
        let (card, seed, tools) = load();
        let act = action(&card, ActionKind::Birth, serde_json::Value::Null);
        assert!(matches!(CauseEffectGate.check(&ctx(card, seed, tools, act)), Verdict::Allow));
    }

    #[test]
    fn bypass_marker_denied() {
        let (card, seed, tools) = load();
        let act = action(&card, ActionKind::Act, serde_json::json!({"bypass_sidecar": true}));
        assert!(matches!(
            CauseEffectGate.check(&ctx(card, seed, tools, act)),
            Verdict::Deny { .. }
        ));
    }

    #[test]
    fn act_missing_session_id_denied() {
        let (card, seed, tools) = load();
        let mut act = action(&card, ActionKind::Act, serde_json::Value::Null);
        act.session_id = "".into();
        assert!(matches!(
            CauseEffectGate.check(&ctx(card, seed, tools, act)),
            Verdict::Deny { .. }
        ));
    }
}
