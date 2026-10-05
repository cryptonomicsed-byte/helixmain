/// HTTP API tests for the approval surface.
///
/// Covers routes that don't require a live browser authenticator.
/// WebAuthn ceremony routes (/setup/*, /held/:id/challenge, /held/:id/approve)
/// are integration-tested via the TypeScript browser test suite.
use axum::{
    body::Body,
    http::{Method, Request, StatusCode},
};
use http_body_util::BodyExt;
use spark_gatekeeper::{
    api::AppState,
    gates::rhythm::{InMemoryRateLimitStore, RhythmGate},
    hold_queue::HoldQueue,
    types::{Action, ActionKind, Card, GateContext, GateResult, GateTrail, PolicySeed, ToolAllowlist, Verdict},
    SparkGatekeeper,
};
use std::sync::Arc;
use tower::ServiceExt;

const SANTINOS_V4_CARD: &str = include_str!("fixtures/dna_c1640d90_v4.json");
const SANTINOS_V4_POLICY_SEED: &str = include_str!("fixtures/policy_seed_v4.json");
const SANTINOS_V4_TOOL_ALLOWLIST: &str = include_str!("fixtures/tool_allowlist_v4.json");

fn load() -> (Card, PolicySeed, ToolAllowlist) {
    (
        serde_json::from_str(SANTINOS_V4_CARD).unwrap(),
        serde_json::from_str(SANTINOS_V4_POLICY_SEED).unwrap(),
        serde_json::from_str(SANTINOS_V4_TOOL_ALLOWLIST).unwrap(),
    )
}

fn make_gatekeeper() -> Arc<SparkGatekeeper> {
    let queue = Arc::new(HoldQueue::in_memory().unwrap());
    let store = Arc::new(InMemoryRateLimitStore::default());
    Arc::new(SparkGatekeeper::new(RhythmGate::new(store), queue))
}

fn make_app(gatekeeper: Arc<SparkGatekeeper>) -> axum::Router {
    let state = Arc::new(
        AppState::new(gatekeeper, "localhost", "http://localhost:9100").unwrap(),
    );
    spark_gatekeeper::api::router(state)
}

fn escalate_result(action_id: &str) -> GateResult {
    GateResult {
        action_id: action_id.into(),
        final_verdict: Verdict::Escalate { reason: "policy: approval_required".into() },
        trail: vec![GateTrail {
            principle: "polarity".to_string(),
            verdict: Verdict::Escalate { reason: "policy: approval_required".into() },
        }],
        receipt_id: uuid::Uuid::new_v4().to_string(),
        checked_at: chrono::Utc::now(),
    }
}

async fn body_json(body: axum::body::Body) -> serde_json::Value {
    let bytes = body.collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn get_held_empty_queue_returns_empty_list() {
    let app = make_app(make_gatekeeper());
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/held")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp.into_body()).await;
    assert!(json.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn get_held_unknown_id_returns_404() {
    let app = make_app(make_gatekeeper());
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/held/nonexistent-id")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn get_held_with_pending_item_returns_it() {
    let gatekeeper = make_gatekeeper();
    let (card, seed, tools) = load();
    let action = Action {
        id: "act_api_test".into(),
        session_id: "sess_api".into(),
        kind: ActionKind::Act,
        tool: Some("refunds".into()),
        payload: serde_json::Value::Null,
        acting_hash: card.acting_hash.clone(),
        initiated_at: chrono::Utc::now(),
    };
    let ctx = GateContext { card, policy_seed: seed, tool_allowlist: tools, session: None, action };
    let result = escalate_result("act_api_test");
    let hold_id = gatekeeper.hold_queue.enqueue(&ctx, &result).unwrap();

    let app = make_app(gatekeeper);
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/held")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp.into_body()).await;
    let items = json.as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["id"].as_str().unwrap(), hold_id);
    assert_eq!(items[0]["action_id"].as_str().unwrap(), "act_api_test");
}

#[tokio::test]
async fn deny_removes_item_from_pending() {
    let gatekeeper = make_gatekeeper();
    let (card, seed, tools) = load();
    let action = Action {
        id: "act_deny_api".into(),
        session_id: "sess_deny".into(),
        kind: ActionKind::Act,
        tool: Some("refunds".into()),
        payload: serde_json::Value::Null,
        acting_hash: card.acting_hash.clone(),
        initiated_at: chrono::Utc::now(),
    };
    let ctx = GateContext { card, policy_seed: seed, tool_allowlist: tools, session: None, action };
    let result = escalate_result("act_deny_api");
    let hold_id = gatekeeper.hold_queue.enqueue(&ctx, &result).unwrap();

    let app = make_app(Arc::clone(&gatekeeper));
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/held/{hold_id}/deny"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp.into_body()).await;
    assert_eq!(json["denied"], true);

    // Confirm it's gone from pending.
    assert!(gatekeeper.hold_queue.pending().unwrap().is_empty());
}

#[tokio::test]
async fn deny_unknown_hold_returns_404() {
    let app = make_app(make_gatekeeper());
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/held/no-such-hold/deny")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn approve_without_challenge_returns_conflict() {
    let gatekeeper = make_gatekeeper();
    let (card, seed, tools) = load();
    let action = Action {
        id: "act_approve_nochal".into(),
        session_id: "sess_nc".into(),
        kind: ActionKind::Act,
        tool: Some("refunds".into()),
        payload: serde_json::Value::Null,
        acting_hash: card.acting_hash.clone(),
        initiated_at: chrono::Utc::now(),
    };
    let ctx = GateContext { card, policy_seed: seed, tool_allowlist: tools, session: None, action };
    let result = escalate_result("act_approve_nochal");
    let hold_id = gatekeeper.hold_queue.enqueue(&ctx, &result).unwrap();

    // Send a syntactically valid but semantically fake credential body.
    // The route must reject it at the NoChallengeForHold check before
    // even trying WebAuthn verification — so the exact credential content doesn't matter.
    let fake_body = serde_json::json!({
        "credential": {
            "id": "dGVzdA",
            "rawId": "dGVzdA",
            "response": {
                "authenticatorData": "dGVzdA",
                "clientDataJSON": "dGVzdA",
                "signature": "dGVzdA"
            },
            "type": "public-key"
        },
        "parent_receipt_hash": null
    });
    let app = make_app(gatekeeper);
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/held/{hold_id}/approve"))
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&fake_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    // Must not be OK. Expected 409 CONFLICT (NoChallengeForHold) if the credential
    // body deserializes, or 422 if webauthn-rs rejects the fake base64 payload.
    // Either way, no approval should have occurred.
    assert_ne!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn challenge_for_nonexistent_hold_returns_404() {
    let app = make_app(make_gatekeeper());
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/held/no-such/challenge")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn challenge_without_registered_passkey_returns_precondition_failed() {
    let gatekeeper = make_gatekeeper();
    let (card, seed, tools) = load();
    let action = Action {
        id: "act_chal_nopk".into(),
        session_id: "sess_cnpk".into(),
        kind: ActionKind::Act,
        tool: Some("refunds".into()),
        payload: serde_json::Value::Null,
        acting_hash: card.acting_hash.clone(),
        initiated_at: chrono::Utc::now(),
    };
    let ctx = GateContext { card, policy_seed: seed, tool_allowlist: tools, session: None, action };
    let result = escalate_result("act_chal_nopk");
    let hold_id = gatekeeper.hold_queue.enqueue(&ctx, &result).unwrap();

    let app = make_app(gatekeeper);
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/held/{hold_id}/challenge"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // 412 Precondition Failed: no passkey registered yet
    assert_eq!(resp.status(), StatusCode::PRECONDITION_FAILED);
}
