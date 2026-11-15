//! Errors a caller can act on. A refusal to authorize is NOT an error: it is a
//! normal answer (`Decision::Deny`, `ExecutionState::Refused`). Errors are for
//! malformed requests and failures of the kernel itself.

use crate::store::StoreError;

#[derive(Debug, thiserror::Error)]
pub enum KernelError {
    #[error("invalid request: {0}")]
    Invalid(String),
    #[error("not permitted: {0}")]
    Forbidden(String),
    #[error("not found")]
    NotFound,
    #[error("failed precondition: {0}")]
    Precondition(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl From<StoreError> for KernelError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::Invalid(m) => KernelError::Precondition(m),
            other => KernelError::Internal(other.to_string()),
        }
    }
}

impl From<KernelError> for tonic::Status {
    fn from(e: KernelError) -> Self {
        match e {
            KernelError::Invalid(m) => tonic::Status::invalid_argument(m),
            KernelError::Forbidden(m) => tonic::Status::permission_denied(m),
            KernelError::NotFound => tonic::Status::not_found("not found"),
            KernelError::Precondition(m) => tonic::Status::failed_precondition(m),
            // Internal detail stays in the log, not on the wire.
            KernelError::Internal(m) => {
                eprintln!("kernel internal error: {m}");
                tonic::Status::internal("internal error")
            }
        }
    }
}
