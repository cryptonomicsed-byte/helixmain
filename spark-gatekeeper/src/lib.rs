pub mod api;
pub mod gates;
pub mod hold_queue;
pub mod receipt_signer;
pub mod sidecar;
pub mod types;

use std::net::SocketAddr;
use std::sync::Arc;

/// Start the approval surface HTTP server.
///
/// `rp_id`     — WebAuthn relying-party domain, e.g. `"localhost"` or `"approve.helixmain.com"`
/// `rp_origin` — Browser origin, e.g. `"http://localhost:9100"`
pub async fn serve(
    addr: impl Into<SocketAddr>,
    gatekeeper: Arc<SparkGatekeeper>,
    rp_id: &str,
    rp_origin: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let state = Arc::new(api::AppState::new(gatekeeper, rp_id, rp_origin)?);
    let app = api::router(state);
    let listener = tokio::net::TcpListener::bind(addr.into()).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

use crate::gates::{
    cause_effect::CauseEffectGate, correspondence::CorrespondenceGate, gender::GenderGate,
    mentalism::MentalismGate, polarity::PolarityGate, rhythm::RhythmGate,
    vibration::VibrationGate,
};
use crate::hold_queue::HoldQueue;
use crate::types::{GateContext, GateResult, GateTrail, Receipt, Verdict};
use chrono::Utc;
use uuid::Uuid;

pub struct SparkGatekeeper {
    mentalism: MentalismGate,
    correspondence: CorrespondenceGate,
    cause_effect: CauseEffectGate,
    vibration: VibrationGate,
    gender: GenderGate,
    polarity: PolarityGate,
    rhythm: RhythmGate,
    pub hold_queue: Arc<HoldQueue>,
}

impl SparkGatekeeper {
    pub fn new(
        rhythm_gate: RhythmGate,
        hold_queue: Arc<HoldQueue>,
    ) -> Self {
        Self {
            mentalism: MentalismGate,
            correspondence: CorrespondenceGate,
            cause_effect: CauseEffectGate,
            vibration: VibrationGate,
            gender: GenderGate,
            polarity: PolarityGate,
            rhythm: rhythm_gate,
            hold_queue,
        }
    }

    /// Run all 7 gates in order (SPARK → ASCENSION).
    /// Aggregation rule: run ALL gates even after a deny, so the receipt
    /// carries the complete trail. Any deny → HALTED. Any escalate (no deny)
    /// → hold queue. All allow → forward to tool bus.
    pub fn check(&self, ctx: &GateContext) -> GateResult {
        let mut trail = Vec::with_capacity(7);
        let mut has_deny = false;
        let mut escalate_reason: Option<String> = None;

        macro_rules! run_gate {
            ($gate:expr) => {{
                let verdict = $gate.check(ctx);
                let principle = $gate.principle();
                if verdict.is_deny() {
                    has_deny = true;
                }
                if verdict.is_escalate() && escalate_reason.is_none() {
                    if let Verdict::Escalate { reason } = &verdict {
                        escalate_reason = Some(reason.clone());
                    }
                }
                trail.push(GateTrail { principle: principle.to_string(), verdict });
            }};
        }

        run_gate!(self.mentalism);
        run_gate!(self.correspondence);
        run_gate!(self.cause_effect);
        run_gate!(self.vibration);
        run_gate!(self.gender);
        run_gate!(self.polarity);
        run_gate!(self.rhythm);

        let final_verdict = if has_deny {
            // Find the first deny reason for the summary.
            let reason = trail
                .iter()
                .find_map(|t| {
                    if let Verdict::Deny { reason } = &t.verdict {
                        Some(reason.clone())
                    } else {
                        None
                    }
                })
                .unwrap_or_else(|| "denied".into());
            Verdict::Deny { reason }
        } else if let Some(reason) = escalate_reason {
            Verdict::Escalate { reason }
        } else {
            Verdict::Allow
        };

        let receipt_id = Uuid::new_v4().to_string();

        GateResult {
            action_id: ctx.action.id.clone(),
            final_verdict,
            trail,
            receipt_id,
            checked_at: Utc::now(),
        }
    }

    /// Mint a hash-chained receipt for the gate result.
    pub fn mint_receipt(
        &self,
        ctx: &GateContext,
        result: &GateResult,
        previous_receipt_id: Option<String>,
    ) -> Receipt {
        Receipt {
            id: result.receipt_id.clone(),
            card_id: ctx.card.id.clone(),
            card_version: ctx.card.version,
            acting_hash: ctx.card.acting_hash.clone(),
            action_id: ctx.action.id.clone(),
            final_verdict: result.final_verdict.clone(),
            trail: result.trail.clone(),
            previous_receipt_id,
            minted_at: Utc::now(),
        }
    }
}
