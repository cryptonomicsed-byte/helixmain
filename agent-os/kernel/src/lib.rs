//! Helix kernel — the trusted boundary.
//!
//! Models, workers, merchants and plugins propose effects. The kernel decides
//! whether one may happen, records the decision, and gives the executor a
//! permit at most once.

pub mod canonical;
pub mod identity;
pub mod sigs;
