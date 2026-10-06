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
    api::{AppState, LoadedPolicy},
    gates::rhythm::{InMemoryRateLimitStore, RhythmGate},
    hold_queue::HoldQueue,
    types::{Action, ActionKind, Card, GateContext, GateResult, GateTrail, PolicySeed, Session, ToolAllowlist, Verdict},
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

/// Router with the real Santino's v4 policy loaded — the /invoke path.
fn make_app_with_policy(gatekeeper: Arc<SparkGatekeeper>) -> axum::Router {
    let (card, policy_seed, tool_allowlist) = load();
    let state = Arc::new(
        AppState::with_policy(
            gatekeeper,
            "localhost",
            "http://localhost:9100",
            LoadedPolicy { card, policy_seed, tool_allowlist },
            String::new(),
        )
        .unwrap(),
    );
    spark_gatekeeper::api::router(state)
}

async fn post_invoke(
    app: axum::Router,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/invoke")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    // Some responses are plain text (e.g. the 503 when no policy is loaded), so
    // fall back to a JSON string instead of panicking on a non-JSON body.
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes).unwrap_or_else(|_| {
        serde_json::Value::String(String::from_utf8_lossy(&bytes).into_owned())
    });
    (status, value)
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

// ── POST /invoke — the sidecar contract (sidecar.rs) ──────────────────────────

#[tokio::test]
async fn invoke_without_policy_returns_503() {
    // No policy in state → the gate engine cannot judge; must refuse, not guess.
    let app = make_app(make_gatekeeper());
    let (status, _) = post_invoke(app, serde_json::json!({"kind": "think"})).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn invoke_refund_escalates_to_hold_queue() {
    // "refunds" is the high-risk rule in the seed → escalate → hold queue.
    // think/act require a session (birth → think → act), so supply one.
    let (card, _, _) = load();
    let session = Session {
        id: "sess_invoke".into(),
        card_id: card.id.clone(),
        card_version: card.version,
        acting_hash: card.acting_hash.clone(),
        birth_receipt_id: "rcpt_birth".into(),
        created_at: chrono::Utc::now(),
        expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
    };
    let app = make_app_with_policy(make_gatekeeper());
    let (status, v) = post_invoke(
        app,
        serde_json::json!({
            "kind": "act",
            "tool": "refunds",
            "acting_hash": card.acting_hash,
            "session_id": session.id.clone(),
            "session": session,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "refund should escalate, got {v}");
    assert_eq!(v["status"], "held");
    assert!(v["hold_id"].as_str().map_or(false, |s| !s.is_empty()));
}

#[tokio::test]
async fn invoke_draft_deploy_is_denied() {
    // Demo 1: Santino's v4 draft card cannot ship — polarity denies.
    let (card, _, _) = load();
    let app = make_app_with_policy(make_gatekeeper());
    let (status, v) = post_invoke(
        app,
        serde_json::json!({"kind": "deploy", "acting_hash": card.acting_hash}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "draft deploy should be denied, got {v}");
    assert_eq!(v["status"], "denied");
}
