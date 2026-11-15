//! Shared harness: a kernel on an in-memory store, a manual clock, a scripted
//! policy, and helpers that mint properly signed sid/0.2 certificates with the
//! public test keys from the shared conformance fixtures.
#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use helix_kernel::clock::ManualClock;
use helix_kernel::grants::GrantSigner;
use helix_kernel::identity::{acting_hash, issue_message, sid_hash};
use helix_kernel::kernel::{Kernel, KernelConfig};
use helix_kernel::pb;
use helix_kernel::policy::{PolicyAnswer, PolicyClient};
use helix_kernel::sigs;
use helix_kernel::store::Store;
use serde_json::{json, Value};

pub const NOW: &str = "2026-11-20T12:00:00Z";
pub const ORG: &str = "org_a";
pub const OTHER_ORG: &str = "org_b";
pub const AGENT: &str = "sid_front-desk";
pub const EXECUTOR: &str = "svc:merchant-adapter";
pub const USER: &str = "user:alice";

pub fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/sid-0.2/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

pub fn issuer_secret() -> String {
    fixture("test-keys.json")["keys"]["issuer-root"]["secret"].as_str().unwrap().to_string()
}

pub fn trust() -> Value {
    fixture("trust.json")
}

pub fn sign_doc(mut doc: Value, secret: &str) -> Value {
    if doc["format"] == "sid/0.2" {
        if doc["version"] == 1 {
            doc["previous_version"] = Value::Null;
            doc["previous_hash"] = json!("none");
        }
        doc["acting_hash"] = json!(acting_hash(&doc));
    }
    doc["hash"] = json!(sid_hash(&doc));
    let message = issue_message(doc["format"].as_str().unwrap(), doc["hash"].as_str().unwrap());
    doc["proof"] = json!({"alg": "ed25519", "signature": sigs::sign("ed25519", secret, &message).unwrap()});
    doc
}

/// A signed certificate. `prev` makes it the next version in a chain.
pub fn cert(sid: &str, permissions: &[&str], status: &str, prev: Option<&Value>) -> Value {
    let version = prev.map_or(1, |p| p["version"].as_i64().unwrap() + 1);
    let updated = if version == 1 { "2026-11-12T09:00:00Z".to_string() } else { format!("2026-11-1{}T09:00:00Z", 2 + version.min(7)) };
    let mut history = prev.map_or(vec![json!({"state": "cast", "at": "2026-11-12T09:00:00Z"})], |p| p["lifecycle"]["history"].as_array().unwrap().clone());
    history.push(json!({"state": status, "at": updated}));
    let mut doc = json!({
        "format": "sid/0.2", "id": sid, "version": version, "status": status,
        "born_at": "2026-11-12T09:00:00Z", "updated": updated,
        "issuer": {"id": "issuer:helix-test-root", "kid": "root-1"},
        "identity": {"name": "Test agent", "type": "agent"},
        "capabilities": {"permissions": permissions},
        "lifecycle": {"state": status, "history": history},
    });
    if let Some(p) = prev {
        doc["previous_version"] = p["version"].clone();
        doc["previous_hash"] = p["hash"].clone();
    }
    sign_doc(doc, &issuer_secret())
}

pub struct ScriptedPolicy {
    pub answer: Mutex<Result<PolicyAnswer, String>>,
    pub requests: Mutex<Vec<Value>>,
}

impl ScriptedPolicy {
    pub fn new(decision: pb::Decision) -> Arc<Self> {
        Arc::new(Self { answer: Mutex::new(Ok(answer(decision))), requests: Mutex::new(vec![]) })
    }
    pub fn set(&self, decision: pb::Decision) {
        *self.answer.lock().unwrap() = Ok(answer(decision));
    }
    pub fn fail(&self, why: &str) {
        *self.answer.lock().unwrap() = Err(why.to_string());
    }
}

pub fn answer(decision: pb::Decision) -> PolicyAnswer {
    PolicyAnswer {
        decision,
        matched_rule: "rule-1".into(),
        reason_codes: vec!["test".into()],
        reason: "scripted".into(),
        policy_version: "v1".into(),
    }
}

impl PolicyClient for ScriptedPolicy {
    fn decide(&self, request: &Value) -> Result<PolicyAnswer, String> {
        self.requests.lock().unwrap().push(request.clone());
        self.answer.lock().unwrap().clone()
    }
    fn available(&self) -> bool {
        self.answer.lock().unwrap().is_ok()
    }
}

pub struct Env {
    pub kernel: Arc<Kernel>,
    pub clock: ManualClock,
    pub policy: Arc<ScriptedPolicy>,
    pub signer_secret: String,
}

pub const SIGNER_SECRET: &str = "4242424242424242424242424242424242424242424242424242424242424242";

pub fn env() -> Env {
    env_with(KernelConfig::default(), Store::in_memory().unwrap(), SIGNER_SECRET, &[])
}

pub fn env_with(cfg: KernelConfig, store: Store, signer_secret: &str, previous_keys: &[String]) -> Env {
    let clock = ManualClock::at(NOW);
    let policy = ScriptedPolicy::new(pb::Decision::Allow);
    let kernel = Kernel::new(
        store,
        GrantSigner::from_secret_hex(signer_secret).unwrap(),
        previous_keys,
        trust(),
        policy.clone(),
        Arc::new(clock.clone()),
        cfg,
    )
    .unwrap();
    Env { kernel: Arc::new(kernel), clock, policy, signer_secret: signer_secret.to_string() }
}

pub fn ctx(org: &str, principal: &str, kind: pb::PrincipalKind) -> Option<pb::RequestContext> {
    Some(pb::RequestContext { correlation_id: "corr-1".into(), organization_id: org.into(), principal: principal.into(), principal_kind: kind as i32 })
}

pub fn svc(org: &str) -> Option<pb::RequestContext> {
    ctx(org, EXECUTOR, pb::PrincipalKind::Service)
}

pub fn user(org: &str) -> Option<pb::RequestContext> {
    ctx(org, USER, pb::PrincipalKind::User)
}

pub fn agent(org: &str, sid: &str) -> Option<pb::RequestContext> {
    ctx(org, sid, pb::PrincipalKind::Agent)
}

static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub fn unique(prefix: &str) -> String {
    format!("{prefix}-{}", COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst))
}

/// A low-risk, no-money intent for `AGENT` exercising `kb.search`.
pub fn intent(org: &str, capability: &str) -> pb::ActionIntent {
    pb::ActionIntent {
        id: unique("intent"),
        organization_id: org.into(),
        agent_id: AGENT.into(),
        task_id: "task-1".into(),
        capability: capability.into(),
        tool: "kb.search".into(),
        target: "kb:main".into(),
        operation: "kb.search".into(),
        risk: pb::Risk::Low as i32,
        arguments_json: r#"{"q":"opening hours"}"#.into(),
        amount_minor: 0,
        currency: String::new(),
        idempotency_key: unique("key"),
        audience: EXECUTOR.into(),
    }
}

/// An order costing 12.00 USD.
pub fn order(org: &str) -> pb::ActionIntent {
    pb::ActionIntent {
        capability: "merchant.order".into(),
        tool: "merchant.checkout".into(),
        target: "merchant:m_123".into(),
        operation: "order.create".into(),
        risk: pb::Risk::Medium as i32,
        arguments_json: r#"{"quote_ref":"q_1","items":[{"sku":"latte","qty":1}]}"#.into(),
        amount_minor: 1200,
        currency: "USD".into(),
        ..intent(org, "merchant.order")
    }
}

pub fn register(env: &Env, org: &str, cert: &Value) -> pb::VerifyIdentityResponse {
    env.kernel
        .verify_identity(&pb::VerifyIdentityRequest {
            context: svc(org),
            certificate_json: cert.to_string(),
            runtime_json: String::new(),
            register: true,
        })
        .unwrap()
}

/// Register `AGENT` under `org` with the usual capabilities and return its certificate.
pub fn registered_agent(env: &Env, org: &str) -> Value {
    let c = cert(AGENT, &["kb.search", "merchant.order"], "live", None);
    let r = register(env, org, &c);
    assert!(r.registered, "registration failed: {:?}", r.errors);
    c
}

pub fn authorize(env: &Env, org: &str, intent: &pb::ActionIntent) -> pb::AuthorizeActionResponse {
    env.kernel
        .authorize_action(&pb::AuthorizeActionRequest { context: agent(org, &intent.agent_id), intent: Some(intent.clone()) })
        .unwrap()
}

pub fn begin(env: &Env, org: &str, grant: &pb::Grant, intent: &pb::ActionIntent) -> pb::BeginExecutionResponse {
    env.kernel
        .begin_execution(&pb::BeginExecutionRequest { context: svc(org), grant: Some(grant.clone()), intent: Some(intent.clone()) })
        .unwrap()
}

pub fn state(r: &pb::BeginExecutionResponse) -> pb::ExecutionState {
    pb::ExecutionState::try_from(r.state).unwrap()
}

pub fn decision(r: &pb::AuthorizeActionResponse) -> pb::Decision {
    pb::Decision::try_from(r.decision).unwrap()
}
