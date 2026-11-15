//! Capability grants.
//!
//! A grant is permission for ONE kind of effect: to one agent, for one
//! operation on one target, up to one amount, until one time, honoured by one
//! executor. It is signed by the kernel, so an executor (or anyone) can verify
//! it, and bound to the exact intent by hash, so the parameters cannot change
//! between authorization and execution.
//!
//! Canonical signed form: the canonical JSON (see `canonical`) of every field
//! except `signature`, hashed with SHA-256; the kernel signs
//! `"helix-grant/1\nissue\n<hash>"` with Ed25519.

use std::collections::HashMap;

use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::canonical::{canonical_json, sha256_hex};
use crate::pb;

pub const GRANT_FORMAT: &str = "helix-grant/1";

/// Why a grant cannot be honoured. Reported as strings to callers.
pub type Refusals = Vec<String>;

pub fn kid_of(public: &[u8; 32]) -> String {
    hex::encode(&Sha256::digest(public)[..8])
}

/// The decision-relevant content of an intent, canonicalized. Two intents with
/// the same hash are the same action. Excludes `id` and `task_id` (labels).
pub fn intent_value(intent: &pb::ActionIntent) -> Result<Value, String> {
    let args: Value = if intent.arguments_json.is_empty() {
        json!({})
    } else {
        serde_json::from_str(&intent.arguments_json).map_err(|e| format!("arguments_json is not JSON: {e}"))?
    };
    if !args.is_object() {
        return Err("arguments_json must be a JSON object".into());
    }
    Ok(json!({
        "organization_id": intent.organization_id,
        "agent_id": intent.agent_id,
        "capability": intent.capability,
        "tool": intent.tool,
        "target": intent.target,
        "operation": intent.operation,
        "risk": intent.risk,
        "arguments": args,
        "amount_minor": intent.amount_minor,
        "currency": intent.currency,
        "idempotency_key": intent.idempotency_key,
        "audience": intent.audience,
    }))
}

pub fn intent_hash(intent: &pb::ActionIntent) -> Result<String, String> {
    let value = intent_value(intent)?;
    let text = canonical_json(&value).map_err(|e| format!("intent cannot be canonicalized: {e}"))?;
    Ok(sha256_hex(&text))
}

fn body(grant: &pb::Grant) -> Value {
    json!({
        "format": grant.format,
        "id": grant.id,
        "issuer_kid": grant.issuer_kid,
        "organization_id": grant.organization_id,
        "subject": grant.subject,
        "audience": grant.audience,
        "operation": grant.operation,
        "target": grant.target,
        "max_amount_minor": grant.max_amount_minor,
        "currency": grant.currency,
        "intent_hash": grant.intent_hash,
        "not_before": grant.not_before,
        "expires_at": grant.expires_at,
        "single_use": grant.single_use,
        "parent_id": grant.parent_id,
    })
}

/// The hash a grant's signature covers.
pub fn grant_hash(grant: &pb::Grant) -> String {
    sha256_hex(&canonical_json(&body(grant)).unwrap_or_default())
}

fn message(hash: &str) -> String {
    format!("{GRANT_FORMAT}\nissue\n{hash}")
}

/// Holds the kernel's signing key. The key never leaves this struct: nothing
/// here exposes the secret, and `Debug` is deliberately not derived.
pub struct GrantSigner {
    key: SigningKey,
    kid: String,
}

impl GrantSigner {
    pub fn from_secret_hex(secret_hex: &str) -> Result<Self, String> {
        let bytes = hex::decode(secret_hex.trim()).map_err(|_| "signing key is not hex".to_string())?;
        let secret: [u8; 32] = bytes.try_into().map_err(|_| "signing key must be 32 bytes (64 hex characters)".to_string())?;
        let key = SigningKey::from_bytes(&secret);
        let kid = kid_of(&key.verifying_key().to_bytes());
        Ok(Self { key, kid })
    }

    pub fn kid(&self) -> &str {
        &self.kid
    }

    pub fn public_hex(&self) -> String {
        hex::encode(self.key.verifying_key().to_bytes())
    }

    /// Fill `format`, `issuer_kid` and `signature`.
    pub fn sign(&self, mut grant: pb::Grant) -> pb::Grant {
        grant.format = GRANT_FORMAT.to_string();
        grant.issuer_kid = self.kid.clone();
        grant.signature = String::new();
        let hash = grant_hash(&grant);
        grant.signature = hex::encode(self.key.sign(message(&hash).as_bytes()).to_bytes());
        grant
    }
}

/// Verifies grants against the kernel's current key and any previous keys that
/// are still honoured (rotation). Removing a key from this set revokes every
/// grant it signed.
pub struct GrantVerifier {
    keys: HashMap<String, VerifyingKey>,
}

impl GrantVerifier {
    pub fn new(public_keys_hex: &[String]) -> Result<Self, String> {
        let mut keys = HashMap::new();
        for h in public_keys_hex {
            let bytes: [u8; 32] = hex::decode(h.trim())
                .ok()
                .and_then(|b| b.try_into().ok())
                .ok_or_else(|| format!("bad verifying key {h}"))?;
            let key = VerifyingKey::from_bytes(&bytes).map_err(|_| format!("bad verifying key {h}"))?;
            keys.insert(kid_of(&bytes), key);
        }
        Ok(Self { keys })
    }

    /// Signature and format only — not the content rules (see `check`).
    pub fn verify_signature(&self, grant: &pb::Grant) -> Result<(), String> {
        if grant.format != GRANT_FORMAT {
            return Err(format!("grant format must be {GRANT_FORMAT}"));
        }
        let key = self.keys.get(&grant.issuer_kid).ok_or_else(|| format!("grant was signed by unknown key {}", grant.issuer_kid))?;
        let sig_bytes: [u8; 64] = hex::decode(&grant.signature)
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or("grant signature is malformed")?;
        let sig = ed25519_dalek::Signature::from_bytes(&sig_bytes);
        key.verify(message(&grant_hash(grant)).as_bytes(), &sig)
            .map_err(|_| "grant signature does not verify".to_string())
    }
}

/// Everything a grant must satisfy before an effect may proceed, other than
/// "has it been revoked or used" (which needs the store).
///
/// `executor` is the authenticated principal presenting the grant.
pub fn check(grant: &pb::Grant, intent: &pb::ActionIntent, org: &str, executor: &str, now: &str) -> Refusals {
    let mut why = vec![];
    if grant.organization_id != org {
        why.push("grant belongs to another tenant".to_string());
    }
    if intent.organization_id != org {
        why.push("intent belongs to another tenant".to_string());
    }
    if grant.subject != intent.agent_id {
        why.push("grant was issued to a different agent".to_string());
    }
    if grant.audience != intent.audience || grant.audience != executor {
        why.push("grant was issued for a different executor".to_string());
    }
    if grant.operation != intent.operation {
        why.push("grant is for a different operation".to_string());
    }
    if grant.target != intent.target {
        why.push("grant is for a different target".to_string());
    }
    if intent.amount_minor > grant.max_amount_minor {
        why.push("amount exceeds what the grant allows".to_string());
    }
    if intent.amount_minor > 0 && grant.currency != intent.currency {
        why.push("currency differs from the grant".to_string());
    }
    if grant.not_before.as_str() > now {
        why.push("grant is not valid yet".to_string());
    }
    if grant.expires_at.as_str() <= now {
        why.push("grant has expired".to_string());
    }
    match intent_hash(intent) {
        Ok(h) if !grant.intent_hash.is_empty() && h != grant.intent_hash => {
            why.push("the action differs from the one that was authorized".to_string());
        }
        Ok(_) if grant.intent_hash.is_empty() => why.push("grant is not bound to an action".to_string()),
        Ok(_) => {}
        Err(e) => why.push(e),
    }
    why
}
