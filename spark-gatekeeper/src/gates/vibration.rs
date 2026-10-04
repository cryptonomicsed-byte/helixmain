/// EMOTION gate — voice/values resonance, null-stays-null, no inferred-overwrite.
use crate::types::{GateContext, Verdict};

pub struct VibrationGate;

impl VibrationGate {
    pub fn principle(&self) -> &'static str {
        "vibration"
    }

    pub fn check(&self, ctx: &GateContext) -> Verdict {
        let payload = &ctx.action.payload;

        // Null-stays-null: if the action asserts a value for a field the card marks null,
        // refuse it. Check price fields specifically (the canonical null case).
        if let Some(price) = payload.get("price") {
            if card_price_is_null(ctx) && !price.is_null() {
                return Verdict::Deny {
                    reason: "null price in card: price assertion refused — hand off to owner".into(),
                };
            }
        }

        // No inferred-overwrite: owner-confirmed fields must not be overwritten
        // by inferred values. Check via field_provenance: if a field has provenance
        // from `owner` or `extractor:owner`, it is confirmed and cannot be
        // overridden by an action whose source is inferred.
        if let Some(field) = payload.get("field").and_then(|v| v.as_str()) {
            if is_owner_confirmed(ctx, field) {
                if let Some(source) = payload.get("source").and_then(|v| v.as_str()) {
                    if source != "owner" && source != "extractor:owner" {
                        return Verdict::Deny {
                            reason: format!(
                                "field '{field}' is owner-confirmed: inferred values cannot overwrite"
                            ),
                        };
                    }
                }
            }
        }

        // Voice resonance: generated content must not use tones the card prohibits.
        // The card's `voice.donts` lists prohibited patterns.
        if let Some(content) = payload.get("content").and_then(|v| v.as_str()) {
            if let Some(reason) = check_voice_donts(ctx, content) {
                return Verdict::Escalate { reason };
            }
        }

        Verdict::Allow
    }
}

/// Returns true if any offering in the card has price = null.
/// This is the canonical null-stays-null case for the demo fixture.
fn card_price_is_null(ctx: &GateContext) -> bool {
    ctx.card.offerings.iter().any(|o| {
        o.get("price").map(|v| v.is_null()).unwrap_or(true)
    })
}

/// Check field_provenance for owner-confirmation.
fn is_owner_confirmed(ctx: &GateContext, field: &str) -> bool {
    if let Some(provenance) = &ctx.card.field_provenance {
        if let Some(entry) = provenance.get(field) {
            if let Some(source) = entry.get("source").and_then(|v| v.as_str()) {
                return source.contains("owner");
            }
        }
    }
    false
}

/// Check generated content against the card's voice.donts.
fn check_voice_donts(ctx: &GateContext, content: &str) -> Option<String> {
    let donts = ctx.card.voice.get("donts")
        .or_else(|| ctx.card.voice.get("dont"))
        .or_else(|| ctx.card.voice.get("prohibitions"));

    if let Some(donts) = donts {
        let prohibited: Vec<String> = match donts {
            serde_json::Value::Array(arr) => {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_lowercase()))
                    .collect()
            }
            serde_json::Value::String(s) => vec![s.to_lowercase()],
            _ => vec![],
        };

        let content_lower = content.to_lowercase();
        for prohibited_term in &prohibited {
            // Only flag exact phrase matches to avoid over-triggering.
            if content_lower.contains(prohibited_term.as_str()) {
                return Some(format!(
                    "content contains prohibited voice pattern: '{prohibited_term}'"
                ));
            }
        }
    }
    None
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

    fn action(card: &Card, payload: serde_json::Value) -> Action {
        Action {
            id: "act_vib".into(),
            session_id: "sess".into(),
            kind: ActionKind::Act,
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
    fn null_price_assertion_denied() {
        let (card, seed, tools) = load();
        // The Santino's v4 card has offerings with null prices.
        let act = action(&card, serde_json::json!({"price": 12.99}));
        let verdict = VibrationGate.check(&ctx(card, seed, tools, act));
        assert!(
            matches!(verdict, Verdict::Deny { .. }),
            "null price assertion must deny, got {verdict:?}"
        );
    }

    #[test]
    fn normal_payload_allows() {
        let (card, seed, tools) = load();
        let act = action(&card, serde_json::json!({"query": "what are your hours?"}));
        let verdict = VibrationGate.check(&ctx(card, seed, tools, act));
        assert!(matches!(verdict, Verdict::Allow), "normal payload must allow");
    }
}
