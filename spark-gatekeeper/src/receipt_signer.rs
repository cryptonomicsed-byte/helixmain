/// GovernanceReceipt signer.
///
/// The signer holds an Ed25519 keypair. `sign()` takes a `Receipt` and a
/// `parent_receipt_hash`, builds the JCS-canonical body, signs it, and returns a
/// `GovernanceReceipt`. `verify()` reconstructs the body from a receipt and checks
/// the signature — works offline with no database access.
///
/// Key loading order:
///   1. `GATEKEEPER_SIGNING_KEY` env var (64 hex chars = 32-byte seed). Use in production.
///   2. Fresh random key (ephemeral, fine for development).
///
/// To generate a persistent key for production:
///   openssl rand -hex 32  →  set GATEKEEPER_SIGNING_KEY=<output>
use crate::types::{GovernanceReceipt, Receipt, Verdict};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};

pub struct ReceiptSigner {
    signing_key: SigningKey,
    pub verifying_key_hex: String,
}

impl ReceiptSigner {
    /// Load from `GATEKEEPER_SIGNING_KEY` env var or generate a random key.
    pub fn from_env_or_generate() -> Self {
        if let Ok(hex_str) = std::env::var("GATEKEEPER_SIGNING_KEY") {
            if let Ok(bytes) = hex::decode(hex_str.trim()) {
                if let Ok(arr) = bytes.try_into() as Result<[u8; 32], _> {
                    let sk = SigningKey::from_bytes(&arr);
                    let vk_hex = hex::encode(sk.verifying_key().to_bytes());
                    return Self { signing_key: sk, verifying_key_hex: vk_hex };
                }
            }
            eprintln!("WARNING: GATEKEEPER_SIGNING_KEY is set but invalid — using random key");
        }
        let sk = SigningKey::generate(&mut OsRng);
        let vk_hex = hex::encode(sk.verifying_key().to_bytes());
        eprintln!(
            "INFO: no GATEKEEPER_SIGNING_KEY — generated ephemeral key. \
             GovernanceReceipts from this run cannot be verified after restart.\n\
             Set GATEKEEPER_SIGNING_KEY={} for a persistent key.",
            hex::encode(sk.to_bytes())
        );
        Self { signing_key: sk, verifying_key_hex: vk_hex }
    }

    /// Sign a `Receipt`, producing a `GovernanceReceipt`.
    ///
    /// The signed body is the JCS-canonical JSON of all GovernanceReceipt fields
    /// except `signer_key` and `signature`. This allows offline verification by
    /// anyone who has the receipt.
    pub fn sign(
        &self,
        receipt: &Receipt,
        parent_receipt_hash: Option<String>,
    ) -> GovernanceReceipt {
        let body_value = build_body(receipt, &parent_receipt_hash, &self.verifying_key_hex);
        let body_json = canonical_json(&body_value);
        let sig: Signature = self.signing_key.sign(body_json.as_bytes());

        GovernanceReceipt {
            id: receipt.id.clone(),
            card_id: receipt.card_id.clone(),
            card_version: receipt.card_version,
            acting_hash: receipt.acting_hash.clone(),
            action_id: receipt.action_id.clone(),
            final_verdict: receipt.final_verdict.clone(),
            trail: receipt.trail.clone(),
            parent_receipt_hash,
            minted_at: receipt.minted_at,
            signer_key: self.verifying_key_hex.clone(),
            signature: hex::encode(sig.to_bytes()),
        }
    }

    /// Verify a `GovernanceReceipt` without any database access.
    ///
    /// Reconstructs the signed body from the receipt fields, decodes the embedded
    /// public key, and verifies the Ed25519 signature. Returns Ok(()) if valid.
    pub fn verify(receipt: &GovernanceReceipt) -> Result<(), String> {
        let vk_bytes: [u8; 32] = hex::decode(&receipt.signer_key)
            .map_err(|e| format!("signer_key decode: {e}"))?
            .try_into()
            .map_err(|_| "signer_key must be 32 bytes".to_string())?;
        let vk = VerifyingKey::from_bytes(&vk_bytes)
            .map_err(|e| format!("invalid signer_key: {e}"))?;

        let sig_bytes: [u8; 64] = hex::decode(&receipt.signature)
            .map_err(|e| format!("signature decode: {e}"))?
            .try_into()
            .map_err(|_| "signature must be 64 bytes".to_string())?;
        let sig = Signature::from_bytes(&sig_bytes);

        // Reconstruct the same body that was signed.
        let synthetic_receipt = Receipt {
            id: receipt.id.clone(),
            card_id: receipt.card_id.clone(),
            card_version: receipt.card_version,
            acting_hash: receipt.acting_hash.clone(),
            action_id: receipt.action_id.clone(),
            final_verdict: receipt.final_verdict.clone(),
            trail: receipt.trail.clone(),
            previous_receipt_id: None, // unused in body construction
            minted_at: receipt.minted_at,
        };
        let body_value = build_body(&synthetic_receipt, &receipt.parent_receipt_hash, &receipt.signer_key);
        let body_json = canonical_json(&body_value);

        vk.verify(body_json.as_bytes(), &sig)
            .map_err(|e| format!("signature invalid: {e}"))
    }

    /// Compute the SHA-256 of the JCS-canonical body of a `GovernanceReceipt`.
    /// Use this as the `parent_receipt_hash` when chaining receipts.
    pub fn receipt_hash(receipt: &GovernanceReceipt) -> String {
        let synthetic = Receipt {
            id: receipt.id.clone(),
            card_id: receipt.card_id.clone(),
            card_version: receipt.card_version,
            acting_hash: receipt.acting_hash.clone(),
            action_id: receipt.action_id.clone(),
            final_verdict: receipt.final_verdict.clone(),
            trail: receipt.trail.clone(),
            previous_receipt_id: None,
            minted_at: receipt.minted_at,
        };
        let body_value = build_body(&synthetic, &receipt.parent_receipt_hash, &receipt.signer_key);
        let body_json = canonical_json(&body_value);
        let mut hasher = Sha256::new();
        hasher.update(body_json.as_bytes());
        hex::encode(hasher.finalize())
    }
}

// ── Canonical body construction ───────────────────────────────────────────────

/// Build the serde_json::Value that represents the signed portion of a GovernanceReceipt.
/// Excludes `signer_key` and `signature` (they can't be part of what they sign).
fn build_body(
    receipt: &Receipt,
    parent_receipt_hash: &Option<String>,
    signer_key: &str,
) -> serde_json::Value {
    let trail_json: Vec<serde_json::Value> = receipt
        .trail
        .iter()
        .map(|t| {
            serde_json::json!({
                "principle": t.principle,
                "verdict": verdict_to_value(&t.verdict),
            })
        })
        .collect();

    let mut body = serde_json::json!({
        "id": receipt.id,
        "card_id": receipt.card_id,
        "card_version": receipt.card_version,
        "acting_hash": receipt.acting_hash,
        "action_id": receipt.action_id,
        "final_verdict": verdict_to_value(&receipt.final_verdict),
        "trail": trail_json,
        "minted_at": receipt.minted_at.to_rfc3339(),
        "signer_key": signer_key,
    });

    if let Some(hash) = parent_receipt_hash {
        body["parent_receipt_hash"] = serde_json::Value::String(hash.clone());
    } else {
        body["parent_receipt_hash"] = serde_json::Value::Null;
    }

    body
}

fn verdict_to_value(v: &Verdict) -> serde_json::Value {
    match v {
        Verdict::Allow => serde_json::Value::String("Allow".into()),
        Verdict::Deny { reason } => serde_json::json!({ "Deny": { "reason": reason } }),
        Verdict::Escalate { reason } => serde_json::json!({ "Escalate": { "reason": reason } }),
    }
}

/// JCS-compatible canonical JSON: sort all object keys recursively, compact output,
/// escape non-ASCII as \uXXXX. Receipt data contains no floats so numeric
/// formatting is not a concern.
fn canonical_json(v: &serde_json::Value) -> String {
    let sorted = sort_keys(v);
    let raw = serde_json::to_string(&sorted).expect("receipt body serialization cannot fail");
    escape_non_ascii(&raw)
}

fn sort_keys(v: &serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Object(map) => {
            let mut pairs: Vec<_> = map.iter().collect();
            pairs.sort_by_key(|(k, _)| k.as_str());
            let sorted: serde_json::Map<String, serde_json::Value> =
                pairs.into_iter().map(|(k, v)| (k.clone(), sort_keys(v))).collect();
            serde_json::Value::Object(sorted)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(sort_keys).collect())
        }
        other => other.clone(),
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{GateTrail, Verdict};
    use chrono::Utc;

    fn test_receipt() -> Receipt {
        Receipt {
            id: "rcpt_test01".into(),
            card_id: "dna_test".into(),
            card_version: 1,
            acting_hash: "abc123".into(),
            action_id: "act_test01".into(),
            final_verdict: Verdict::Allow,
            trail: vec![GateTrail {
                principle: "polarity".into(),
                verdict: Verdict::Allow,
            }],
            previous_receipt_id: None,
            minted_at: Utc::now(),
        }
    }

    #[test]
    fn sign_and_verify_roundtrip() {
        let signer = ReceiptSigner::from_env_or_generate();
        let receipt = test_receipt();
        let gov = signer.sign(&receipt, None);
        assert_eq!(gov.id, receipt.id);
        assert_eq!(gov.card_id, receipt.card_id);
        assert!(!gov.signature.is_empty());
        assert!(!gov.signer_key.is_empty());
        ReceiptSigner::verify(&gov).expect("signature must be valid after sign");
    }

    #[test]
    fn tampered_field_fails_verification() {
        let signer = ReceiptSigner::from_env_or_generate();
        let receipt = test_receipt();
        let mut gov = signer.sign(&receipt, None);
        gov.card_id = "TAMPERED".into();
        assert!(
            ReceiptSigner::verify(&gov).is_err(),
            "tampered field must fail verification"
        );
    }

    #[test]
    fn hash_chain_is_stable() {
        let signer = ReceiptSigner::from_env_or_generate();
        let first = signer.sign(&test_receipt(), None);
        let hash1 = ReceiptSigner::receipt_hash(&first);
        let hash2 = ReceiptSigner::receipt_hash(&first);
        assert_eq!(hash1, hash2, "hash must be deterministic");
        assert_eq!(hash1.len(), 64, "hash must be SHA-256 hex (64 chars)");

        // Second receipt in chain references hash of first.
        let mut r2 = test_receipt();
        r2.id = "rcpt_test02".into();
        let second = signer.sign(&r2, Some(hash1.clone()));
        assert_eq!(second.parent_receipt_hash, Some(hash1));
        ReceiptSigner::verify(&second).expect("chained receipt must verify");
    }

    #[test]
    fn deny_verdict_round_trips() {
        let signer = ReceiptSigner::from_env_or_generate();
        let mut receipt = test_receipt();
        receipt.final_verdict = Verdict::Deny { reason: "draft card".into() };
        receipt.trail[0].verdict = Verdict::Deny { reason: "draft card".into() };
        let gov = signer.sign(&receipt, None);
        ReceiptSigner::verify(&gov).expect("deny receipt must verify");
        assert!(matches!(gov.final_verdict, Verdict::Deny { .. }));
    }
}
