//! Offline GovernanceReceipt verifier.
//!
//!   curl -s http://127.0.0.1:9100/receipts/<id> | cargo run -q --example verify
//!
//! Needs only the receipt JSON: no DB, no network, no running gatekeeper.
//! Exits 0 and prints VALID on a good Ed25519 signature, else non-zero + INVALID.

use std::io::Read;
use spark_gatekeeper::receipt_signer::ReceiptSigner;
use spark_gatekeeper::types::GovernanceReceipt;

fn main() {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).expect("read stdin");
    let r: GovernanceReceipt = match serde_json::from_str(&raw) {
        Ok(r) => r,
        Err(e) => { eprintln!("PARSE ERROR: {e}"); std::process::exit(2); }
    };
    match ReceiptSigner::verify(&r) {
        Ok(()) => {
            println!("VALID");
            println!("  receipt_id  : {}", r.id);
            println!("  card        : {} v{}", r.card_id, r.card_version);
            println!("  action_id   : {}", r.action_id);
            println!("  acting_hash : {}", r.acting_hash);
            println!("  signer_key  : {}", r.signer_key);
            println!("  signature   : {}...", &r.signature[..16.min(r.signature.len())]);
            println!("  parent_hash : {:?}", r.parent_receipt_hash);
            println!("  minted_at   : {}", r.minted_at);
        }
        Err(e) => { eprintln!("INVALID: {e}"); std::process::exit(1); }
    }
}
