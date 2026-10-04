/// FIRE gate — risk verdicts from the policy seed, draft-can't-ship.
/// Fail closed: unknown actions escalate, never allow.
use crate::types::{ActionKind, CardStatus, GateContext, PolicyVerdict, RiskLevel, Verdict};

pub struct PolarityGate;

impl PolarityGate {
    pub fn principle(&self) -> &'static str {
        "polarity"
    }

    pub fn check(&self, ctx: &GateContext) -> Verdict {
        // Draft cards cannot deploy/publish/send — no override.
        if ctx.card.status == CardStatus::Draft && ctx.action.kind.requires_live_card() {
            return Verdict::Deny {
                reason: format!(
                    "draft card cannot {:?}: owner-confirmation required before publish/deploy/send",
                    ctx.action.kind
                ),
            };
        }

        // Tool actions: check against policy seed rules.
        if let Some(tool) = &ctx.action.tool {
            return self.check_tool_action(ctx, tool);
        }

        // Non-tool actions (birth/think/mutate): policy seed doesn't gate these.
        // Unknown high-risk action kinds escalate (fail closed).
        match ctx.action.kind {
            ActionKind::Birth | ActionKind::Think | ActionKind::Mutate => Verdict::Allow,
            ActionKind::Act => {
                // Act without a tool is unexpected — escalate.
                Verdict::Escalate {
                    reason: "act action has no tool specified".into(),
                }
            }
            ActionKind::Deploy | ActionKind::Publish | ActionKind::Send => {
                // Non-draft already passed above; these are allowed for live cards.
                Verdict::Allow
            }
        }
    }

    fn check_tool_action(&self, ctx: &GateContext, tool: &str) -> Verdict {
        // Find the matching policy rule by topic (topic matches tool name prefix).
        // If no explicit rule, apply the default for the inferred risk.
        for rule in &ctx.policy_seed.rules {
            if tool_matches_topic(tool, &rule.topic) {
                return verdict_from_policy(&rule.verdict);
            }
        }

        // No explicit rule: apply defaults based on inferred risk.
        // Inference: tools ending in known write suffixes are medium; reads are low.
        let risk = infer_risk(tool);
        let verdict = ctx.policy_seed.defaults.verdict_for(&risk);
        verdict_from_policy(verdict)
    }
}

fn tool_matches_topic(tool: &str, topic: &str) -> bool {
    // Simple prefix match: "refunds" matches "refund.*", "order.refund", etc.
    tool.contains(topic) || topic.contains(tool)
}

fn infer_risk(tool: &str) -> RiskLevel {
    let write_verbs = ["send", "create", "update", "delete", "publish", "deploy", "mutate"];
    if write_verbs.iter().any(|v| tool.contains(v)) {
        RiskLevel::Medium
    } else {
        RiskLevel::Low
    }
}

fn verdict_from_policy(v: &PolicyVerdict) -> Verdict {
    match v {
        PolicyVerdict::Allow => Verdict::Allow,
        PolicyVerdict::ApprovalRequired => Verdict::Escalate {
            reason: "policy: approval_required".into(),
        },
        PolicyVerdict::Escalate => Verdict::Escalate {
            reason: "policy: escalate".into(),
        },
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
        let card: Card = serde_json::from_str(SANTINOS_V4_CARD).unwrap();
        let seed: PolicySeed = serde_json::from_str(SANTINOS_V4_POLICY_SEED).unwrap();
        let tools: ToolAllowlist = serde_json::from_str(SANTINOS_V4_TOOL_ALLOWLIST).unwrap();
        (card, seed, tools)
    }

    fn action(card: &Card, kind: ActionKind, tool: Option<&str>) -> Action {
        Action {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: "sess_test".into(),
            kind,
            tool: tool.map(|s| s.to_string()),
            payload: serde_json::Value::Null,
            acting_hash: card.acting_hash.clone(),
            initiated_at: Utc::now(),
        }
    }

    fn ctx(card: Card, seed: PolicySeed, tools: ToolAllowlist, act: Action) -> GateContext {
        GateContext { card, policy_seed: seed, tool_allowlist: tools, session: None, action: act }
    }

    #[test]
    fn draft_deploy_is_denied() {
        let (card, seed, tools) = load();
        assert_eq!(card.status, CardStatus::Draft);
        let act = action(&card, ActionKind::Deploy, None);
        let verdict = PolarityGate.check(&ctx(card, seed, tools, act));
        assert!(
            matches!(verdict, Verdict::Deny { .. }),
            "draft deploy must deny, got {verdict:?}"
        );
    }

    #[test]
    fn draft_publish_is_denied() {
        let (card, seed, tools) = load();
        let act = action(&card, ActionKind::Publish, None);
        let verdict = PolarityGate.check(&ctx(card, seed, tools, act));
        assert!(matches!(verdict, Verdict::Deny { .. }));
    }

    #[test]
    fn low_risk_tool_allows() {
        let (card, seed, tools) = load();
        // "allergens" rule: risk=low, verdict=allow
        let act = action(&card, ActionKind::Act, Some("kb.search"));
        let verdict = PolarityGate.check(&ctx(card, seed, tools, act));
        assert!(matches!(verdict, Verdict::Allow), "low risk tool must allow, got {verdict:?}");
    }

    #[test]
    fn high_risk_topic_escalates() {
        let (card, seed, tools) = load();
        // "refunds" rule: risk=high, verdict=approval_required → escalate
        let act = action(&card, ActionKind::Act, Some("refunds"));
        let verdict = PolarityGate.check(&ctx(card, seed, tools, act));
        assert!(
            matches!(verdict, Verdict::Escalate { .. }),
            "high risk must escalate, got {verdict:?}"
        );
    }

    #[test]
    fn unknown_write_tool_escalates() {
        let (card, seed, tools) = load();
        // No rule for "payment.create" — inferred medium risk → approval_required → escalate
        let act = action(&card, ActionKind::Act, Some("payment.create"));
        let verdict = PolarityGate.check(&ctx(card, seed, tools, act));
        assert!(matches!(verdict, Verdict::Escalate { .. }));
    }

    #[test]
    fn birth_action_allows() {
        let (card, seed, tools) = load();
        let act = action(&card, ActionKind::Birth, None);
        let verdict = PolarityGate.check(&ctx(card, seed, tools, act));
        assert!(matches!(verdict, Verdict::Allow));
    }
}
