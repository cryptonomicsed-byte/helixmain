/// HTTP approval surface for the SparkGatekeeper hold queue.
///
/// Routes:
///   GET  /held                   — list pending held operations
///   GET  /held/:id               — single held operation
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
use crate::{receipt_signer::ReceiptSigner, SparkGatekeeper};
use axum::{
    extract::{Path, State},
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

pub struct AppState {
    pub gatekeeper: Arc<SparkGatekeeper>,
    pub webauthn: Arc<Webauthn>,
    /// Ed25519 signer for GovernanceReceipt minting.
    pub signer: ReceiptSigner,
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
            auth_states: Mutex::new(HashMap::new()),
            reg_states: Mutex::new(HashMap::new()),
        })
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
    /// SHA-256 hex of the JCS-canonical body of the previous GovernanceReceipt.
    /// None for the first approval in the chain.
    pub parent_receipt_hash: Option<String>,
}

#[derive(Serialize)]
pub struct DenyResponse {
    pub denied: bool,
}

// ── Router ────────────────────────────────────────────────────────────────────

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/held", get(list_held))
        .route("/held/:id", get(get_held))
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
async fn health() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "service": "spark-gatekeeper",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

async fn list_held(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let pending = state.gatekeeper.hold_queue.pending()?;
    Ok(Json(pending))
}

async fn get_held(
    State(state): State<Arc<AppState>>,
    Path(hold_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let all = state.gatekeeper.hold_queue.pending()?;
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
    let pending = state.gatekeeper.hold_queue.pending()?;
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

    // Atomically approve and mint the base receipt, then sign it as a GovernanceReceipt.
    // The two steps are sequential in the same request — there is no window where the
    // hold is approved but the receipt is unsigned.
    let receipt = state
        .gatekeeper
        .hold_queue
        .approve(&hold_id, None)?
        .ok_or(ApiError::NotFound)?;

    let governance_receipt = state.signer.sign(&receipt, body.parent_receipt_hash);

    Ok(Json(governance_receipt))
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
