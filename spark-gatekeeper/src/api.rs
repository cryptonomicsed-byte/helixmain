/// HTTP approval surface for the SparkGatekeeper hold queue.
///
/// Routes:
///   GET  /held                   — list pending held operations
///   GET  /held/:id               — single held operation
///   GET  /receipts/:id           — fetch a signed GovernanceReceipt by id
///   POST /setup/challenge        — begin approver passkey registration
///   POST /setup/finish           — complete registration and store passkey
///   POST /held/:id/challenge     — generate WebAuthn challenge for a specific hold
///   POST /held/:id/approve       — verify assertion + approve + mint receipt (atomic)
///   POST /held/:id/deny          — deny without ceremony (denial is safe; bypass is not)
///
/// No-bypass invariant: the approve route performs WebAuthn verification in Rust
/// before calling HoldQueue::approve(). Minting the receipt is atomic with approval.
/// Anyone who can POST to /held/:id/approve must first win a WebAuthn ceremony
/// against a registered passkey — there is no other code path to approval.
use crate::receipt_signer::ReceiptSigner;
use crate::sidecar::{self, SidecarResponse};
use crate::types::{Action, ActionRequest, Card, GateContext, PolicySeed, ToolAllowlist};
use crate::SparkGatekeeper;
use chrono::Utc;
use uuid::Uuid;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tower_http::cors::CorsLayer;
use url::Url;
use webauthn_rs::prelude::*;

// ── AppState ──────────────────────────────────────────────────────────────────

/// The card policy the gate engine judges against. Loaded once at startup so an
/// agent cannot supply its own policy on the request it is being judged for.
pub struct LoadedPolicy {
    pub card: Card,
    pub policy_seed: PolicySeed,
    pub tool_allowlist: ToolAllowlist,
}

pub struct AppState {
    pub gatekeeper: Arc<SparkGatekeeper>,
    pub webauthn: Arc<Webauthn>,
    /// Ed25519 signer for GovernanceReceipt minting.
    pub signer: ReceiptSigner,
    /// Card policy for POST /invoke. `None` = no policy configured; the approval
    /// surface still works, but /invoke answers 503 until a card is loaded.
    pub policy: Option<Arc<LoadedPolicy>>,
    /// MCP tool bus an `allow` verdict forwards to. Empty = no bus configured.
    pub tool_bus_url: String,
    /// Short-lived authentication states: hold_id → PasskeyAuthentication.
    /// Populated by /held/:id/challenge, consumed by /held/:id/approve.
    auth_states: Mutex<HashMap<String, PasskeyAuthentication>>,
    /// Short-lived registration states: user_id → PasskeyRegistration.
    /// Populated by /setup/challenge, consumed by /setup/finish.
    reg_states: Mutex<HashMap<String, PasskeyRegistration>>,
}

impl AppState {
    pub fn new(gatekeeper: Arc<SparkGatekeeper>, rp_id: &str, rp_origin: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let origin = Url::parse(rp_origin)?;
        let webauthn = WebauthnBuilder::new(rp_id, &origin)?
            .rp_name("SparkGatekeeper")
            .build()?;
        Ok(Self {
            gatekeeper,
            webauthn: Arc::new(webauthn),
            signer: ReceiptSigner::from_env_or_generate(),
            policy: None,
            tool_bus_url: String::new(),
            auth_states: Mutex::new(HashMap::new()),
            reg_states: Mutex::new(HashMap::new()),
        })
    }

    /// Like [`AppState::new`], but with a card policy loaded, enabling `/invoke`.
    pub fn with_policy(
        gatekeeper: Arc<SparkGatekeeper>,
        rp_id: &str,
        rp_origin: &str,
        policy: LoadedPolicy,
        tool_bus_url: String,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let mut state = Self::new(gatekeeper, rp_id, rp_origin)?;
        state.policy = Some(Arc::new(policy));
        state.tool_bus_url = tool_bus_url;
        Ok(state)
    }
}

// ── Error type ────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum ApiError {
    NotFound,
    NoChallengeForHold,
    NoPasskeyRegistered,
    WebAuthn(WebauthnError),
    Queue(rusqlite::Error),
    Json(serde_json::Error),
    BadRequest(String),
    NoPolicyLoaded,
}

impl From<WebauthnError> for ApiError {
    fn from(e: WebauthnError) -> Self { ApiError::WebAuthn(e) }
}

impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self { ApiError::Queue(e) }
}

impl From<serde_json::Error> for ApiError {
    fn from(e: serde_json::Error) -> Self { ApiError::Json(e) }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, body) = match self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            ApiError::NoChallengeForHold => (
                StatusCode::CONFLICT,
                "no challenge pending for this hold_id — call /held/:id/challenge first".to_string(),
            ),
            ApiError::NoPasskeyRegistered => (
                StatusCode::PRECONDITION_FAILED,
                "no approver passkey registered — call /setup/challenge and /setup/finish".to_string(),
            ),
            ApiError::WebAuthn(e) => (StatusCode::UNAUTHORIZED, format!("webauthn error: {e}")),
            ApiError::Queue(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("queue error: {e}")),
            ApiError::Json(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("json error: {e}")),
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            ApiError::NoPolicyLoaded => (
                StatusCode::SERVICE_UNAVAILABLE,
                "no card policy loaded — set SPARK_CARD / SPARK_POLICY_SEED / SPARK_TOOL_ALLOWLIST".to_string(),
            ),
        };
        (status, body).into_response()
    }
}

// ── Request / response bodies ─────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SetupChallengeRequest {
    pub user_id: String,
    pub display_name: String,
}

#[derive(Deserialize)]
pub struct SetupFinishRequest {
    pub user_id: String,
    pub credential: RegisterPublicKeyCredential,
}

#[derive(Deserialize)]
pub struct ApproveRequest {
    pub credential: PublicKeyCredential,
}

#[derive(Serialize)]
pub struct DenyResponse {
    pub denied: bool,
}

// ── Router ────────────────────────────────────────────────────────────────────

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/invoke", post(invoke))
        .route("/held", get(list_held))
        .route("/held/:id", get(get_held))
        .route("/receipts/:id", get(get_receipt))
        .route("/setup/challenge", post(setup_challenge))
        .route("/setup/finish", post(setup_finish))
        .route("/held/:id/challenge", post(held_challenge))
        .route("/held/:id/approve", post(held_approve))
        .route("/held/:id/deny", post(held_deny))
        .with_state(state)
        .layer(CorsLayer::permissive())
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/// Liveness probe. The old `spark-gatekeeper-server` served `/health`; the port to
/// the compiled-gates binary dropped it, which broke health checks that expect it.
async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "service": "spark-gatekeeper",
        "version": env!("CARGO_PKG_VERSION"),
        "signer_key": state.signer.verifying_key_hex,
    }))
}

/// POST /invoke — the sidecar contract described in `sidecar.rs`.
///
/// An agent submits an action; the 7 gates run; the answer is exactly one of:
///   200  allowed  — forwarded to the tool bus (if one is configured)
///   202  held     — `{"hold_id": ...}`; escalated, awaiting human approval
///   403  denied   — the denial receipt
///
/// The card, policy seed and tool allowlist come from server state, never from
/// the request — a caller must not be able to choose the policy judging it.
async fn invoke(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ActionRequest>,
) -> Result<Response, ApiError> {
    let policy = state.policy.as_ref().ok_or(ApiError::NoPolicyLoaded)?;

    let action = Action {
        id: req.action_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        session_id: req.session_id,
        kind: req.kind,
        tool: req.tool,
        payload: req.payload,
        acting_hash: req.acting_hash,
        initiated_at: Utc::now(),
    };
    let action_id = action.id.clone();

    let ctx = GateContext {
        card: policy.card.clone(),
        policy_seed: policy.policy_seed.clone(),
        tool_allowlist: policy.tool_allowlist.clone(),
        session: req.session,
        action,
    };

    match sidecar::dispatch(&state.gatekeeper, &ctx) {
        SidecarResponse::Forwarded { body } => {
            let outcome = forward_to_tool_bus(&state.tool_bus_url, &body).await;
            Ok((
                StatusCode::OK,
                Json(serde_json::json!({
                    "status": "allowed",
                    "action_id": action_id,
                    "tool_bus": state.tool_bus_url,
                    "forwarded": outcome.is_ok(),
                    "forward_error": outcome.err(),
                })),
            )
                .into_response())
        }
        SidecarResponse::Held { hold_id } => Ok((
            StatusCode::ACCEPTED,
            Json(serde_json::json!({
                "status": "held",
                "action_id": action_id,
                "hold_id": hold_id,
            })),
        )
            .into_response()),
        SidecarResponse::Denied { receipt_json } => {
            let receipt =
                serde_json::from_str(&receipt_json).unwrap_or(serde_json::Value::Null);
            Ok((
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "status": "denied",
                    "action_id": action_id,
                    "receipt": receipt,
                })),
            )
                .into_response())
        }
    }
}

/// Best-effort forward of an allowed action to the MCP tool bus.
///
/// An `allow` verdict stands even when the bus is unreachable — the forward
/// result is reported, never fatal. Empty `bus` means no bus is configured.
async fn forward_to_tool_bus(bus: &str, body: &str) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    if bus.is_empty() {
        return Err("no tool bus configured (TOOL_BUS_URL unset)".into());
    }
    let hostport = bus.trim_start_matches("http://").trim_end_matches('/');
    let mut stream = tokio::net::TcpStream::connect(hostport)
        .await
        .map_err(|e| format!("connect {hostport}: {e}"))?;
    let req = format!(
        "POST /invoke HTTP/1.1\r\nHost: {hostport}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|e| format!("write: {e}"))?;
    Ok(())
}

#[derive(Deserialize)]
pub struct HeldQuery {
    pub org: Option<String>,
}

async fn list_held(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HeldQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let pending = state.gatekeeper.hold_queue.pending(q.org.as_deref())?;
    Ok(Json(pending))
}

async fn get_held(
    State(state): State<Arc<AppState>>,
    Path(hold_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let all = state.gatekeeper.hold_queue.pending(None)?;
    let item = all
        .into_iter()
        .find(|h| h.id == hold_id)
        .ok_or(ApiError::NotFound)?;
    Ok(Json(item))
}

/// Begin approver passkey registration. Call once during initial setup.
async fn setup_challenge(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SetupChallengeRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let user_uuid = uuid::Uuid::new_v4();
    let (ccr, reg_state) = state.webauthn.start_passkey_registration(
        user_uuid,
        &body.user_id,
        &body.display_name,
        None,
    )?;
    state
        .reg_states
        .lock()
        .unwrap()
        .insert(body.user_id, reg_state);
    Ok(Json(ccr))
}

/// Complete registration and persist the passkey.
async fn setup_finish(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SetupFinishRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let reg_state = state
        .reg_states
        .lock()
        .unwrap()
        .remove(&body.user_id)
        .ok_or_else(|| ApiError::BadRequest("no pending registration for that user_id".into()))?;
    let passkey = state
        .webauthn
        .finish_passkey_registration(&body.credential, &reg_state)?;
    let passkey_json = serde_json::to_string(&passkey)?;
    state
        .gatekeeper
        .hold_queue
        .store_approver_passkey(&passkey_json)?;
    Ok(StatusCode::OK)
}

/// Generate a WebAuthn challenge for a specific held operation.
/// The challenge is bound to hold_id; /held/:id/approve consumes it.
async fn held_challenge(
    State(state): State<Arc<AppState>>,
    Path(hold_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    // Verify the hold exists and is still pending.
    let pending = state.gatekeeper.hold_queue.pending(None)?;
    if !pending.iter().any(|h| h.id == hold_id) {
        return Err(ApiError::NotFound);
    }
    let passkey_json = state
        .gatekeeper
        .hold_queue
        .load_approver_passkey()?
        .ok_or(ApiError::NoPasskeyRegistered)?;
    let passkey: Passkey = serde_json::from_str(&passkey_json)?;
    let (rcr, auth_state) = state.webauthn.start_passkey_authentication(&[passkey])?;
    state
        .auth_states
        .lock()
        .unwrap()
        .insert(hold_id, auth_state);
    Ok(Json(rcr))
}

/// Verify the WebAuthn assertion, then atomically approve + mint receipt.
/// This is the no-bypass point: minting only happens after Rust verifies the ceremony.
async fn held_approve(
    State(state): State<Arc<AppState>>,
    Path(hold_id): Path<String>,
    Json(body): Json<ApproveRequest>,
) -> Result<impl IntoResponse, ApiError> {
    // Consume the challenge — one-time use prevents replay.
    let auth_state = state
        .auth_states
        .lock()
        .unwrap()
        .remove(&hold_id)
        .ok_or(ApiError::NoChallengeForHold)?;

    // Verify the ceremony. WebauthnError returned here means the assertion is invalid.
    let auth_result = state
        .webauthn
        .finish_passkey_authentication(&body.credential, &auth_state)?;

    // Update the stored passkey sign counter (prevents sign-counter rollback attacks).
    if let Some(passkey_json) = state.gatekeeper.hold_queue.load_approver_passkey()? {
        let mut passkey: Passkey = serde_json::from_str(&passkey_json)?;
        passkey.update_credential(&auth_result);
        let updated_json = serde_json::to_string(&passkey)?;
        state
            .gatekeeper
            .hold_queue
            .store_approver_passkey(&updated_json)?;
    }

    // Derive parent hash from the last signed receipt in the DB — the chain is
    // server-controlled, not client-supplied, so the caller cannot forge a link.
    let parent = state.gatekeeper.hold_queue.latest_receipt_body_hash()?;
    let parent_receipt_hash = parent.as_ref().map(|(_, h)| h.clone());
    let previous_receipt_id = parent.map(|(id, _)| id);

    // Approve and mint the base receipt.
    let receipt = state
        .gatekeeper
        .hold_queue
        .approve(&hold_id, previous_receipt_id.clone())?
        .ok_or(ApiError::NotFound)?;

    // Sign to produce the GovernanceReceipt, then persist the signature fields.
    let governance_receipt = state.signer.sign(&receipt, parent_receipt_hash);
    let body_hash = ReceiptSigner::receipt_hash(&governance_receipt);
    state.gatekeeper.hold_queue.persist_receipt_signature(
        &governance_receipt.id,
        &governance_receipt.signer_key,
        &governance_receipt.signature,
        &body_hash,
        governance_receipt.parent_receipt_hash.as_deref(),
        previous_receipt_id.as_deref(),
    )?;

    Ok(Json(governance_receipt))
}

/// Fetch a signed GovernanceReceipt by id. Returns 404 if not found or unsigned.
/// The returned receipt is offline-verifiable: call ReceiptSigner::verify() with
/// signer_key=`signer_key` from /health or the known public key.
async fn get_receipt(
    State(state): State<Arc<AppState>>,
    Path(receipt_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let receipt = state
        .gatekeeper
        .hold_queue
        .fetch_governance_receipt(&receipt_id)?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(receipt))
}

/// Deny a held operation. No ceremony required — denying is the safe path.
async fn held_deny(
    State(state): State<Arc<AppState>>,
    Path(hold_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let denied = state.gatekeeper.hold_queue.deny(&hold_id)?;
    if denied {
        Ok(Json(DenyResponse { denied: true }))
    } else {
        Err(ApiError::NotFound)
    }
}
