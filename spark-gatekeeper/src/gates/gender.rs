/// MATRIX gate — lifecycle: birth→think→act transitions only forward.
use crate::types::{ActionKind, GateContext, Verdict};

pub struct GenderGate;

impl GenderGate {
    pub fn principle(&self) -> &'static str {
        "gender"
    }

    pub fn check(&self, ctx: &GateContext) -> Verdict {
        match ctx.action.kind {
            ActionKind::Birth => {
                // Birth requires a valid card. No session needed (this creates it).
                // One birth per card version per sandbox is enforced at the hold_queue level.
                Verdict::Allow
            }
            ActionKind::Think => {
                // Think requires a live session (born).
                if ctx.session.is_none() {
                    return Verdict::Deny {
                        reason: "think requires a live session: birth first".into(),
                    };
                }
                Verdict::Allow
            }
            ActionKind::Act => {
                // Act requires a live session.
                if ctx.session.is_none() {
                    return Verdict::Deny {
                        reason: "act requires a live session: birth → think → act".into(),
                    };
                }
                Verdict::Allow
            }
            ActionKind::Deploy | ActionKind::Publish | ActionKind::Send => {
                // These require a live session and a live (non-draft) card.
                // Draft check is handled by polarity; here we only check session.
                if ctx.session.is_none() {
                    return Verdict::Deny {
                        reason: format!("{:?} requires a live session", ctx.action.kind),
                    };
                }
                Verdict::Allow
            }
            ActionKind::Mutate => {
                // Mutations require a live session.
                if ctx.session.is_none() {
                    return Verdict::Deny {
                        reason: "mutate requires a live session".into(),
                    };
                }
                Verdict::Allow
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Action, ActionKind, Card, GateContext, PolicySeed, Session, ToolAllowlist};
    use chrono::{Duration, Utc};

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

    fn live_session(card: &Card) -> Session {
        Session {
            id: "sess".into(),
            card_id: card.id.clone(),
            card_version: card.version,
            acting_hash: card.acting_hash.clone(),
            birth_receipt_id: "rcpt_birth".into(),
            created_at: Utc::now(),
            expires_at: Utc::now() + Duration::hours(1),
        }
    }

    #[test]
    fn birth_without_session_allows() {
        let (card, seed, tools) = load();
        let action = Action {
            id: "a".into(), session_id: "".into(), kind: ActionKind::Birth,
            tool: None, payload: serde_json::Value::Null,
            acting_hash: card.acting_hash.clone(), initiated_at: Utc::now(),
        };
        let ctx = GateContext { card, policy_seed: seed, tool_allowlist: tools, session: None, action };
        assert!(matches!(GenderGate.check(&ctx), Verdict::Allow));
    }

    #[test]
    fn think_without_session_denied() {
        let (card, seed, tools) = load();
        let action = Action {
            id: "a".into(), session_id: "".into(), kind: ActionKind::Think,
            tool: None, payload: serde_json::Value::Null,
            acting_hash: card.acting_hash.clone(), initiated_at: Utc::now(),
        };
        let ctx = GateContext { card, policy_seed: seed, tool_allowlist: tools, session: None, action };
        assert!(matches!(GenderGate.check(&ctx), Verdict::Deny { .. }));
    }

    #[test]
    fn act_with_session_allows() {
        let (card, seed, tools) = load();
        let session = live_session(&card);
        let action = Action {
            id: "a".into(), session_id: session.id.clone(), kind: ActionKind::Act,
            tool: Some("kb.search".into()), payload: serde_json::Value::Null,
            acting_hash: card.acting_hash.clone(), initiated_at: Utc::now(),
        };
        let ctx = GateContext { card, policy_seed: seed, tool_allowlist: tools, session: Some(session), action };
        assert!(matches!(GenderGate.check(&ctx), Verdict::Allow));
    }
}
