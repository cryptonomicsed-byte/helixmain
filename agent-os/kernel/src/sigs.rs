//! Signature suites shared with sid/0.2 (hex on the wire, 32-byte keys,
//! 64-byte signatures):
//!
//!   ed25519   RFC 8032 Ed25519 over the message bytes
//!   bip340    BIP-340 Schnorr (secp256k1, x-only key) over sha256(message)
//!
//! `verify` returns false for anything malformed or unsupported; it never
//! panics and never skips a check.

use ed25519_dalek::{Signer, Verifier};
use sha2::{Digest, Sha256};

pub const ALGS: [&str; 2] = ["ed25519", "bip340"];

fn bytes<const N: usize>(hex_str: &str) -> Option<[u8; N]> {
    if hex_str.len() != N * 2 || !hex_str.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    hex::decode(hex_str).ok()?.try_into().ok()
}

pub fn verify(alg: &str, public_hex: &str, message: &str, signature_hex: &str) -> bool {
    let (Some(public), Some(signature)) = (bytes::<32>(public_hex), bytes::<64>(signature_hex)) else {
        return false;
    };
    match alg {
        "ed25519" => {
            let Ok(key) = ed25519_dalek::VerifyingKey::from_bytes(&public) else { return false };
            key.verify(message.as_bytes(), &ed25519_dalek::Signature::from_bytes(&signature)).is_ok()
        }
        "bip340" => {
            let Ok(key) = k256::schnorr::VerifyingKey::from_bytes(&public) else { return false };
            let Ok(sig) = k256::schnorr::Signature::try_from(&signature[..]) else { return false };
            key.verify_raw(&Sha256::digest(message.as_bytes()), &sig).is_ok()
        }
        _ => false,
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SignError {
    #[error("secret key must be 64 lowercase hex characters")]
    BadKey,
    #[error("unsupported signature suite {0}")]
    Unsupported(String),
}

pub fn public_key(alg: &str, secret_hex: &str) -> Result<String, SignError> {
    let secret = bytes::<32>(secret_hex).ok_or(SignError::BadKey)?;
    match alg {
        "ed25519" => Ok(hex::encode(ed25519_dalek::SigningKey::from_bytes(&secret).verifying_key().to_bytes())),
        "bip340" => {
            let key = k256::schnorr::SigningKey::from_bytes(&secret).map_err(|_| SignError::BadKey)?;
            Ok(hex::encode(key.verifying_key().to_bytes()))
        }
        other => Err(SignError::Unsupported(other.to_string())),
    }
}

/// Deterministic in both suites (BIP-340 is signed with zero auxiliary
/// randomness), so every implementation produces the same signature.
pub fn sign(alg: &str, secret_hex: &str, message: &str) -> Result<String, SignError> {
    let secret = bytes::<32>(secret_hex).ok_or(SignError::BadKey)?;
    match alg {
        "ed25519" => Ok(hex::encode(
            ed25519_dalek::SigningKey::from_bytes(&secret).sign(message.as_bytes()).to_bytes(),
        )),
        "bip340" => {
            let key = k256::schnorr::SigningKey::from_bytes(&secret).map_err(|_| SignError::BadKey)?;
            let sig = key
                .sign_raw(&Sha256::digest(message.as_bytes()), &[0u8; 32])
                .map_err(|_| SignError::BadKey)?;
            Ok(hex::encode(sig.to_bytes()))
        }
        other => Err(SignError::Unsupported(other.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn garbage_never_verifies_and_never_panics() {
        for alg in ["ed25519", "bip340", "rsa", ""] {
            assert!(!verify(alg, "zz", "m", "zz"));
            assert!(!verify(alg, &"00".repeat(32), "m", &"00".repeat(64)));
            assert!(!verify(alg, &"AB".repeat(32), "m", &"00".repeat(64)));
        }
    }

    #[test]
    fn sign_then_verify_round_trips_and_rejects_another_message() {
        let secret = "11".repeat(32);
        for alg in ALGS {
            let public = public_key(alg, &secret).unwrap();
            let sig = sign(alg, &secret, "hello").unwrap();
            assert!(verify(alg, &public, "hello", &sig));
            assert!(!verify(alg, &public, "hellp", &sig));
        }
    }
}
