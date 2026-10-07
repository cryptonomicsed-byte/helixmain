/// SPARK gate — canonicalization, hash chain, acting_hash, session validity.
/// Every call passes through here first. This is the choke point.
use crate::types::{ActionKind, GateContext, Verdict, ACTING_KEYS};
use sha2::{Digest, Sha256};

pub struct MentalismGate;

impl MentalismGate {
    pub fn principle(&self) -> &'static str {
        "mentalism"
    }

    pub fn check(&self, ctx: &GateContext) -> Verdict {
        // 1. Recompute and verify the card hash.
        if let Err(reason) = verify_card_hash(ctx) {
            return Verdict::Deny { reason };
        }

        // 2. Verify the hash chain (previous_hash must link).
        if let Err(reason) = verify_hash_chain(ctx) {
            return Verdict::Deny { reason };
        }

        // 3. Recompute and verify acting_hash.
        if let Err(reason) = verify_acting_hash(ctx) {
            return Verdict::Deny { reason };
        }

        // 4. The action must carry the current acting_hash.
        if ctx.action.acting_hash != ctx.card.acting_hash {
            return Verdict::Deny {
                reason: format!(
                    "stale acting_hash: action carries {}, card is {}",
                    ctx.action.acting_hash.get(..8).unwrap_or(&ctx.action.acting_hash),
                    ctx.card.acting_hash.get(..8).unwrap_or(&ctx.card.acting_hash)
                ),
            };
        }

        // 5. Session checks (required for think/act/deploy/publish/send).
        if ctx.action.kind != ActionKind::Birth {
            match &ctx.session {
                None => {
                    return Verdict::Deny {
                        reason: "no session: birth required before think/act".into(),
                    }
                }
                Some(session) => {
                    if session.is_expired() {
                        return Verdict::Deny {
                            reason: "session expired".into(),
                        };
                    }
                    if session.card_id != ctx.card.id {
                        return Verdict::Deny {
                            reason: "session bound to different card".into(),
                        };
                    }
                    if session.card_version != ctx.card.version {
                        return Verdict::Deny {
                            reason: format!(
                                "session bound to card v{}; current is v{}",
                                session.card_version, ctx.card.version
                            ),
                        };
                    }
                    if session.acting_hash != ctx.card.acting_hash {
                        return Verdict::Deny {
                            reason: "session acting_hash stale; re-birth required".into(),
                        };
                    }
                }
            }
        }

        Verdict::Allow
    }
}

/// Recompute SHA-256 over the canonical card JSON and compare to `card.hash`.
fn verify_card_hash(ctx: &GateContext) -> Result<(), String> {
    let canonical = canonical_card_json(&ctx.card)?;
    let computed = sha256_hex(canonical.as_bytes());
    if computed != ctx.card.hash {
        return Err(format!(
            "card hash mismatch: computed {}, stored {}",
            computed.get(..8).unwrap_or(&computed),
            ctx.card.hash.get(..8).unwrap_or(&ctx.card.hash)
        ));
    }
    Ok(())
}

/// The hash chain: if previous_hash is set, it must reference a real prior
/// version's hash. Here we verify the field is present for v > 1 and absent
/// for v1 (the genesis card). Full chain traversal is the responsibility of
/// the ingest layer; the gate verifies structural consistency only.
fn verify_hash_chain(ctx: &GateContext) -> Result<(), String> {
    if ctx.card.version == 1 && ctx.card.previous_hash.is_some() {
        return Err("v1 card must not have previous_hash".into());
    }
    if ctx.card.version > 1 && ctx.card.previous_hash.is_none() {
        return Err(format!(
            "v{} card missing previous_hash",
            ctx.card.version
        ));
    }
    Ok(())
}

/// Recompute acting_hash from the seven acting keys (sorted canonical JSON of
/// each section's value, concatenated in ACTING_KEYS order, then SHA-256'd).
fn verify_acting_hash(ctx: &GateContext) -> Result<(), String> {
    let card_value = serde_json::to_value(&ctx.card)
        .map_err(|e| format!("card serialization error: {e}"))?;
    let computed = compute_acting_hash(&card_value)?;
    if computed != ctx.card.acting_hash {
        return Err(format!(
            "acting_hash mismatch: computed {}, stored {}",
            computed.get(..8).unwrap_or(&computed),
            ctx.card.acting_hash.get(..8).unwrap_or(&ctx.card.acting_hash)
        ));
    }
    Ok(())
}

/// Produce the acting_hash from a serde_json::Value of the card.
/// Mirrors the TS actingHash(): build a sub-object of the acting keys that are
/// present (absent = omit, like undefined in JS), canonicalize the whole object,
/// then SHA-256. Public so the test harness can build valid fixtures.
pub fn compute_acting_hash(card: &serde_json::Value) -> Result<String, String> {
    let mut body = serde_json::Map::new();
    for key in ACTING_KEYS {
        if let Some(v) = card.get(key) {
            body.insert((*key).to_string(), v.clone());
        }
    }
    let mut body_value = serde_json::Value::Object(body);
    prune_empty_collections(&mut body_value);
    let sorted = to_sorted(&body_value);
    let raw = serde_json::to_string(&sorted).map_err(|e| e.to_string())?;
    Ok(sha256_hex(escape_non_ascii(&raw).as_bytes()))
}

/// Produce the canonical JSON for hash computation.
/// Rules (mirrors TS canonicalize() in business-md.ts):
///   - exclude `hash` and `_`-prefixed keys
///   - keep nulls; only prune empty arrays and empty objects
///   - sort keys recursively
///   - escape non-ASCII as \uXXXX (matches JSON.stringify / Python ensure_ascii=True)
pub fn canonical_card_json(card: &crate::types::Card) -> Result<String, String> {
    let mut value = serde_json::to_value(card)
        .map_err(|e| format!("serialization error: {e}"))?;
    // Remove hash (self-inclusion) and serde flatten extra bags.
    if let serde_json::Value::Object(ref mut map) = value {
        map.remove("hash");
        map.retain(|k, _| !k.starts_with('_') && k != "extra");
    }
    strip_underscore_extra(&mut value);
    prune_empty_collections(&mut value);
    let sorted = to_sorted(&value);
    let raw = serde_json::to_string(&sorted).map_err(|e| format!("canonical error: {e}"))?;
    Ok(escape_non_ascii(&raw))
}

/// Recursively strip `_`-prefixed keys and `extra` catch-alls from nested objects.
fn strip_underscore_extra(v: &mut serde_json::Value) {
    if let serde_json::Value::Object(map) = v {
        map.retain(|k, _| !k.starts_with('_') && k != "extra");
        for val in map.values_mut() {
            strip_underscore_extra(val);
        }
    } else if let serde_json::Value::Array(arr) = v {
        for item in arr.iter_mut() {
            strip_underscore_extra(item);
        }
    }
}

/// Prune empty arrays and empty objects only — nulls MUST survive.
fn prune_empty_collections(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::Object(map) => {
            for val in map.values_mut() {
                prune_empty_collections(val);
            }
            map.retain(|_, val| !is_empty_collection(val));
        }
        serde_json::Value::Array(arr) => {
            for item in arr.iter_mut() {
                prune_empty_collections(item);
            }
            arr.retain(|item| !is_empty_collection(item));
        }
        _ => {}
    }
}

fn is_empty_collection(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Array(a) => a.is_empty(),
        serde_json::Value::Object(m) => m.is_empty(),
        _ => false,
    }
}

fn to_sorted(v: &serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Object(map) => {
            let mut pairs: Vec<_> = map.iter().collect();
            pairs.sort_by_key(|(k, _)| k.as_str());
            let sorted: serde_json::Map<String, serde_json::Value> =
                pairs.into_iter().map(|(k, v)| (k.clone(), to_sorted(v))).collect();
            serde_json::Value::Object(sorted)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(to_sorted).collect())
        }
        other => other.clone(),
    }
}

/// Escape any non-ASCII codepoint as \uXXXX (BMP) or surrogate pair (SMP).
/// Matches JSON.stringify behaviour and Python json.dumps(ensure_ascii=True).
fn escape_non_ascii(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            let cp = c as u32;
            if cp <= 0xFFFF {
                out.push_str(&format!("\\u{cp:04x}"));
            } else {
                let cp = cp - 0x10000;
                let high = 0xD800 + (cp >> 10);
                let low = 0xDC00 + (cp & 0x3FF);
                out.push_str(&format!("\\u{high:04x}\\u{low:04x}"));
            }
        }
    }
    out
}

pub fn canonical_json_value(v: &serde_json::Value) -> String {
    let sorted = to_sorted(v);
    let raw = serde_json::to_string(&sorted).unwrap_or_default();
    escape_non_ascii(&raw)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
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

    fn load_fixtures() -> (Card, PolicySeed, ToolAllowlist) {
        let card: Card = serde_json::from_str(SANTINOS_V4_CARD).expect("card parse");
        let seed: PolicySeed =
            serde_json::from_str(SANTINOS_V4_POLICY_SEED).expect("policy seed parse");
        let tools: ToolAllowlist =
            serde_json::from_str(SANTINOS_V4_TOOL_ALLOWLIST).expect("tool allowlist parse");
        (card, seed, tools)
    }

    fn birth_action(card: &Card) -> Action {
        Action {
            id: "act_test_birth".into(),
            session_id: "".into(),
            kind: ActionKind::Birth,
            tool: None,
            payload: serde_json::Value::Null,
            acting_hash: card.acting_hash.clone(),
            initiated_at: Utc::now(),
        }
    }

    fn live_session(card: &Card) -> Session {
        Session {
            id: "sess_test".into(),
            card_id: card.id.clone(),
            card_version: card.version,
            acting_hash: card.acting_hash.clone(),
            birth_receipt_id: "rcpt_birth".into(),
            created_at: Utc::now(),
            expires_at: Utc::now() + Duration::hours(1),
        }
    }

    fn act_action(card: &Card, session: &Session) -> Action {
        Action {
            id: "act_test_act".into(),
            session_id: session.id.clone(),
            kind: ActionKind::Act,
            tool: Some("kb.search".into()),
            payload: serde_json::json!({"query": "hours"}),
            acting_hash: card.acting_hash.clone(),
            initiated_at: Utc::now(),
        }
    }

    #[test]
    fn birth_on_valid_card_allows() {
        let (card, seed, tools) = load_fixtures();
        let action = birth_action(&card);
        let ctx = GateContext {
            card,
            policy_seed: seed,
            tool_allowlist: tools,
            session: None,
            action,
        };
        let verdict = MentalismGate.check(&ctx);
        assert!(matches!(verdict, Verdict::Allow), "expected Allow, got {verdict:?}");
    }

    #[test]
    fn tampered_hash_is_denied() {
        let (mut card, seed, tools) = load_fixtures();
        card.hash = "deadbeef".repeat(8); // wrong hash
        let action = birth_action(&card);
        let ctx = GateContext {
            card,
            policy_seed: seed,
            tool_allowlist: tools,
            session: None,
            action,
        };
        let verdict = MentalismGate.check(&ctx);
        assert!(matches!(verdict, Verdict::Deny { .. }), "tampered hash must deny");
    }

    #[test]
    fn stale_acting_hash_in_action_is_denied() {
        let (card, seed, tools) = load_fixtures();
        let mut action = birth_action(&card);
        action.acting_hash = "stale0000".repeat(8);
        let ctx = GateContext {
            card,
            policy_seed: seed,
            tool_allowlist: tools,
            session: None,
            action,
        };
        let verdict = MentalismGate.check(&ctx);
        assert!(matches!(verdict, Verdict::Deny { .. }), "stale acting_hash must deny");
    }

    #[test]
    fn act_without_session_is_denied() {
        let (card, seed, tools) = load_fixtures();
        let action = Action {
            id: "act_no_session".into(),
            session_id: "".into(),
            kind: ActionKind::Act,
            tool: Some("kb.search".into()),
            payload: serde_json::Value::Null,
            acting_hash: card.acting_hash.clone(),
            initiated_at: Utc::now(),
        };
        let ctx = GateContext {
            card,
            policy_seed: seed,
            tool_allowlist: tools,
            session: None,
            action,
        };
        let verdict = MentalismGate.check(&ctx);
        assert!(matches!(verdict, Verdict::Deny { .. }), "act without session must deny");
    }

    #[test]
    fn act_with_valid_session_allows() {
        let (card, seed, tools) = load_fixtures();
        let session = live_session(&card);
        let action = act_action(&card, &session);
        let ctx = GateContext {
            card,
            policy_seed: seed,
            tool_allowlist: tools,
            session: Some(session),
            action,
        };
        let verdict = MentalismGate.check(&ctx);
        assert!(matches!(verdict, Verdict::Allow), "valid session+action must allow");
    }

    #[test]
    fn expired_session_is_denied() {
        let (card, seed, tools) = load_fixtures();
        let mut session = live_session(&card);
        session.expires_at = Utc::now() - Duration::seconds(1);
        let action = act_action(&card, &session);
        let ctx = GateContext {
            card,
            policy_seed: seed,
            tool_allowlist: tools,
            session: Some(session),
            action,
        };
        let verdict = MentalismGate.check(&ctx);
        assert!(matches!(verdict, Verdict::Deny { .. }), "expired session must deny");
    }
}
