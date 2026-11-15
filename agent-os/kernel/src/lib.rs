//! Helix kernel — the trusted boundary.
//!
//! Models, workers, merchants and plugins propose effects. The kernel decides
//! whether one may happen, records the decision, and gives the executor a
//! permit at most once.

pub mod canonical;
pub mod clock;
pub mod error;
pub mod grants;
pub mod identity;
pub mod kernel;
pub mod policy;
pub mod service;
pub mod sigs;
pub mod store;

/// Types generated from `agent-os/contracts/proto/helix/kernel/v1/kernel.proto`.
pub mod pb {
    tonic::include_proto!("helix.kernel.v1");
}
