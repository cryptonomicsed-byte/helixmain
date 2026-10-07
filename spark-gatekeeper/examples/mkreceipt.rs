//! Self-test helper: sign a sample receipt so `verify` can be proven end to end.
use chrono::Utc;
use spark_gatekeeper::receipt_signer::ReceiptSigner;
use spark_gatekeeper::types::{GateTrail, Receipt, Verdict};

fn main() {
    let signer = ReceiptSigner::from_env_or_generate();
    let r = Receipt {
        id: "rcpt_selftest".into(),
        card_id: "dna_selftest".into(),
        card_version: 1,
        acting_hash: "deadbeef".into(),
        action_id: "act_selftest".into(),
        final_verdict: Verdict::Allow,
        trail: vec![GateTrail { principle: "polarity".into(), verdict: Verdict::Allow }],
        previous_receipt_id: None,
        minted_at: Utc::now(),
    };
    let g = signer.sign(&r, None);
    println!("{}", serde_json::to_string(&g).unwrap());
}
