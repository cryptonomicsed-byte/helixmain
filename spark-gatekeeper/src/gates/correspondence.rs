/// MIND principle gate — action must correspond to the card.
/// No phantom fields, no out-of-scope tools, mutations via protocol only.
use crate::types::{ActionKind, GateContext, Verdict};

pub struct CorrespondenceGate;

impl CorrespondenceGate {
    pub fn principle(&self) -> &'static str {
        "correspondence"
    }

    pub fn check(&self, ctx: &GateContext) -> Verdict {
        // Tool actions must be in the card's tool allowlist.
        if let Some(tool) = &ctx.action.tool {
            if !ctx.tool_allowlist.contains(tool) {
                return Verdict::Deny {
                    reason: format!("tool '{tool}' not in card's tool allowlist"),
                };
            }
        }

        // Deploy/publish must reference an artifact whose card_id matches.
        if matches!(ctx.action.kind, ActionKind::Deploy | ActionKind::Publish) {
            if let Some(card_id) = ctx.action.payload.get("card_id").and_then(|v| v.as_str()) {
                if card_id != ctx.card.id {
                    return Verdict::Deny {
                        reason: format!(
                            "deploy/publish references card '{}' but session is for '{}'",
                            card_id, ctx.card.id
                        ),
                    };
                }
            }
        }

        // Mutations must arrive via the propose→gate→apply protocol:
        // payload must carry a proposal_id, never a direct field edit.
        if ctx.action.kind == ActionKind::Mutate {
            if ctx.action.payload.get("proposal_id").is_none() {
                return Verdict::Deny {
                    reason: "mutate action missing proposal_id: direct edits not allowed".into(),
                };
            }
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

    fn act(card: &Card, kind: ActionKind, tool: Option<&str>, payload: serde_json::Value) -> Action {
        Action {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: "sess".into(),
            kind,
            tool: tool.map(|s| s.into()),
            payload,
            acting_hash: card.acting_hash.clone(),
            initiated_at: Utc::now(),
        }
    }

    fn ctx(card: Card, seed: PolicySeed, tools: ToolAllowlist, action: Action) -> GateContext {
        GateContext { card, policy_seed: seed, tool_allowlist: tools, session: None, action }
    }

    #[test]
    fn allowed_tool_passes() {
        let (card, seed, tools) = load();
        let action = act(&card, ActionKind::Act, Some("kb.search"), serde_json::Value::Null);
        assert!(matches!(CorrespondenceGate.check(&ctx(card, seed, tools, action)), Verdict::Allow));
    }

    #[test]
    fn unlisted_tool_denied() {
        let (card, seed, tools) = load();
        let action = act(&card, ActionKind::Act, Some("admin.delete_card"), serde_json::Value::Null);
        assert!(matches!(
            CorrespondenceGate.check(&ctx(card, seed, tools, action)),
            Verdict::Deny { .. }
        ));
    }

    #[test]
    fn mutate_without_proposal_id_denied() {
        let (card, seed, tools) = load();
        let action = act(&card, ActionKind::Mutate, None, serde_json::json!({"field": "voice.tone", "value": "aggressive"}));
        assert!(matches!(
            CorrespondenceGate.check(&ctx(card, seed, tools, action)),
            Verdict::Deny { .. }
        ));
    }

    #[test]
    fn mutate_with_proposal_id_allows() {
        let (card, seed, tools) = load();
        let action = act(&card, ActionKind::Mutate, None, serde_json::json!({"proposal_id": "prop_abc123"}));
        assert!(matches!(CorrespondenceGate.check(&ctx(card, seed, tools, action)), Verdict::Allow));
    }
}
