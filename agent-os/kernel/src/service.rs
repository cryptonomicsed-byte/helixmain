//! gRPC front for the kernel. Every call runs the (synchronous, SQLite-backed)
//! kernel on a blocking thread so a slow policy call cannot stall the runtime.

use std::sync::Arc;

use tonic::{Request, Response, Status};

use crate::kernel::Kernel;
use crate::pb;
use crate::pb::kernel_server::Kernel as KernelApi;

pub struct KernelService {
    kernel: Arc<Kernel>,
}

impl KernelService {
    pub fn new(kernel: Arc<Kernel>) -> Self {
        Self { kernel }
    }

    pub fn into_server(self) -> pb::kernel_server::KernelServer<Self> {
        pb::kernel_server::KernelServer::new(self)
    }
}

macro_rules! blocking {
    ($self:ident, $request:ident, $method:ident) => {{
        let kernel = $self.kernel.clone();
        let req = $request.into_inner();
        let out = tokio::task::spawn_blocking(move || kernel.$method(&req))
            .await
            .map_err(|_| Status::internal("internal error"))??;
        Ok(Response::new(out))
    }};
}

#[tonic::async_trait]
impl KernelApi for KernelService {
    async fn authorize_action(&self, request: Request<pb::AuthorizeActionRequest>) -> Result<Response<pb::AuthorizeActionResponse>, Status> {
        blocking!(self, request, authorize_action)
    }
    async fn confirm_action(&self, request: Request<pb::ConfirmActionRequest>) -> Result<Response<pb::AuthorizeActionResponse>, Status> {
        blocking!(self, request, confirm_action)
    }
    async fn begin_execution(&self, request: Request<pb::BeginExecutionRequest>) -> Result<Response<pb::BeginExecutionResponse>, Status> {
        blocking!(self, request, begin_execution)
    }
    async fn record_result(&self, request: Request<pb::RecordResultRequest>) -> Result<Response<pb::RecordResultResponse>, Status> {
        blocking!(self, request, record_result)
    }
    async fn revoke_grant(&self, request: Request<pb::RevokeGrantRequest>) -> Result<Response<pb::RevokeGrantResponse>, Status> {
        blocking!(self, request, revoke_grant)
    }
    async fn verify_identity(&self, request: Request<pb::VerifyIdentityRequest>) -> Result<Response<pb::VerifyIdentityResponse>, Status> {
        blocking!(self, request, verify_identity)
    }
    async fn health(&self, _request: Request<pb::HealthRequest>) -> Result<Response<pb::HealthResponse>, Status> {
        let kernel = self.kernel.clone();
        let out = tokio::task::spawn_blocking(move || kernel.health())
            .await
            .map_err(|_| Status::internal("internal error"))?;
        Ok(Response::new(out))
    }
}
