/// Integration tests — the three demonstrations required by the exit criteria:
/// 1. Draft-can't-ship: Santino's v4 (draft) Deploy → polarity denies; full 7-gate trail in receipt.
/// 2. Escalate → approve → receipt: refund action → hold queue → approve → receipt minted.
/// 3. Null-price refusal: action asserting a price on a null-price card → vibration denies.
///
/// No-bypass is demonstrated structurally: the sidecar dispatch tests verify that
/// the gate runs on every request. Full network-level bypass proof requires the
/// OpenShell sandbox (Phase 2 runtime leg, currently blocked on VPS docker check).

use spark_gatekeeper::{
    gates::rhythm::{InMemoryRateLimitStore, RhythmGate},
    hold_queue::HoldQueue,
    sidecar::{dispatch, SidecarResponse},
    types::{Action, ActionKind, Card, GateContext, PolicySeed, Session, Verdict, ToolAllowlist},
    SparkGatekeeper,
};
use chrono::{Duration, Utc};
use std::sync::Arc;

const SANTINOS_V4_CARD: &str =
    include_str!("fixtures/dna_c1640d90_v4.json");
const SANTINOS_V4_POLICY_SEED: &str =
    include_str!("fixtures/policy_seed_v4.json");
const SANTINOS_V4_TOOL_ALLOWLIST: &str =
    include_str!("fixtures/tool_allowlist_v4.json");

fn load() -> (Card, PolicySeed, ToolAllowlist) {
    (
        serde_json::from_str(SANTINOS_V4_CARD).expect("card fixture"),
        serde_json::from_str(SANTINOS_V4_POLICY_SEED).expect("policy seed fixture"),
        serde_json::from_str(SANTINOS_V4_TOOL_ALLOWLIST).expect("tool allowlist fixture"),
    )
}

fn make_gatekeeper() -> SparkGatekeeper {
    let store = Arc::new(InMemoryRateLimitStore::default());
    let rhythm = RhythmGate::new(store);
    let queue = Arc::new(HoldQueue::in_memory().expect("hold queue"));
    SparkGatekeeper::new(rhythm, queue)
}

// ── Demo 1: Draft-can't-ship ──────────────────────────────────────────────────

#[test]
fn draft_deploy_denied_with_full_trail() {
    let (card, seed, tools) = load();
    assert_eq!(card.status, spark_gatekeeper::types::CardStatus::Draft,
               "fixture must be draft status");

    let action = Action {
        id: "act_draft_deploy".into(),
        session_id: "sess_test".into(),
        kind: ActionKind::Deploy,
        tool: None,
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

    let gk = make_gatekeeper();
    let result = gk.check(&ctx);

    // Final verdict must be Deny.
    assert!(
        matches!(result.final_verdict, Verdict::Deny { .. }),
        "draft deploy must deny, got {:?}", result.final_verdict
    );

    // All 7 gates must have run (full trail, even after deny).
    assert_eq!(result.trail.len(), 7, "trail must have 7 entries; got {}", result.trail.len());

    // The denial must come from polarity (draft-can't-ship).
    let polarity_entry = result.trail.iter().find(|t| t.principle == "polarity");
    assert!(polarity_entry.is_some(), "polarity must be in the trail");
    assert!(
        matches!(polarity_entry.unwrap().verdict, Verdict::Deny { .. }),
        "polarity must deny draft deploy"
    );

    // Receipt must be minted with the trail.
    let receipt = gk.mint_receipt(&ctx, &result, None);
    assert_eq!(receipt.trail.len(), 7);
    assert_eq!(receipt.card_id, "dna_c1640d90");
    assert!(matches!(receipt.final_verdict, Verdict::Deny { .. }));
}

// ── Demo 2: Escalate → hold queue → approve → receipt ────────────────────────

#[test]
fn refund_escalates_approve_releases_with_receipt() {
    let (card, seed, tools) = load();

    let session = Session {
        id: "sess_refund".into(),
        card_id: card.id.clone(),
        card_version: card.version,
        acting_hash: card.acting_hash.clone(),
        birth_receipt_id: "rcpt_birth".into(),
        created_at: Utc::now(),
        expires_at: Utc::now() + Duration::hours(1),
    };

    // "refunds" maps to the high-risk rule in the policy seed → escalate.
    let action = Action {
        id: "act_refund_integration".into(),
        session_id: session.id.clone(),
        kind: ActionKind::Act,
        tool: Some("refunds".into()),
        payload: serde_json::Value::Null,
        acting_hash: card.acting_hash.clone(),
        initiated_at: Utc::now(),
    };
    let ctx = GateContext {
        card,
        policy_seed: seed,
        tool_allowlist: tools,
        session: Some(session),
        action,
    };

    let gk = make_gatekeeper();
    let resp = dispatch(&gk, &ctx);

    // Must land in the hold queue.
    let hold_id = match resp {
        SidecarResponse::Held { hold_id } => hold_id,
        other => panic!("expected Held, got {other:?}"),
    };

    // Hold queue must have exactly one pending entry.
    let pending = gk.hold_queue.pending().expect("pending");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].action_id, "act_refund_integration");

    // Approve (simulates WebAuthn ceremony in the TS surface).
    let receipt = gk
        .hold_queue
        .approve(&hold_id, None)
        .expect("approve db")
        .expect("receipt must be Some after approve");

    assert!(matches!(receipt.final_verdict, Verdict::Allow),
            "approved receipt must be Allow");
    assert!(!receipt.id.is_empty(), "receipt id must be set");

    // After approval, queue is empty.
    assert_eq!(gk.hold_queue.pending().unwrap().len(), 0);
}

// ── Demo 3: Null-price refusal ────────────────────────────────────────────────

#[test]
fn null_price_assertion_refused() {
    let (card, seed, tools) = load();

    // Santino's v4 has offerings with price = null. An action asserting a price
    // must be refused by the vibration gate.
    let action = Action {
        id: "act_price_assert".into(),
        session_id: "sess_test".into(),
        kind: ActionKind::Act,
        tool: Some("kb.search".into()),
        payload: serde_json::json!({
            "price": 14.99,
            "item": "pepperoni pizza"
        }),
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

    let gk = make_gatekeeper();
    let result = gk.check(&ctx);

    assert!(
        matches!(result.final_verdict, Verdict::Deny { .. }),
        "null price assertion must deny, got {:?}", result.final_verdict
    );

    // Vibration gate must be in the trail with a deny.
    let vib = result.trail.iter().find(|t| t.principle == "vibration")
        .expect("vibration must be in trail");
    assert!(matches!(vib.verdict, Verdict::Deny { .. }),
            "vibration must deny null-price assertion");
}

// ── Policy verdicts driven by real compiler output ────────────────────────────

#[test]
fn verdicts_driven_by_real_policy_seed() {
    let (card, seed, tools) = load();
    let gk = make_gatekeeper();

    // Low-risk topic (allergens) → allow.
    let allergen_action = Action {
        id: "act_allergen".into(),
        session_id: "sess".into(),
        kind: ActionKind::Birth,
        tool: None,
        payload: serde_json::json!({"topic": "allergens"}),
        acting_hash: card.acting_hash.clone(),
        initiated_at: Utc::now(),
    };
    let ctx = GateContext {
        card: card.clone(), policy_seed: seed.clone(),
        tool_allowlist: tools.clone(), session: None,
        action: allergen_action,
    };
    let result = gk.check(&ctx);
    // Birth action passes mentalism and all others; final verdict Allow.
    assert!(matches!(result.final_verdict, Verdict::Allow));

    // Verify policy seed card_id matches the fixture.
    assert_eq!(seed.card_id, "dna_c1640d90");
    assert_eq!(seed.card_version, 4);
    assert_eq!(seed.rules.len(), 3);
    assert_eq!(seed.rules[0].topic, "refunds");
    assert_eq!(seed.rules[1].topic, "allergens");
    assert_eq!(seed.rules[2].topic, "large_orders");
}
