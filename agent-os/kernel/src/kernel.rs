//! The kernel: authorize and execute are separate steps, and only the kernel
//! moves an action from one to the other.
//!
//!   AuthorizeAction   an agent proposes an intent. The kernel checks who is
//!                     asking and for which tenant, re-verifies the agent's
//!                     identity, asks policy, applies its own invariants, and
//!                     answers ALLOW (with a signed grant), DENY, or a request
//!                     for a person to confirm or review.
//!   ConfirmAction     a PERSON answers such a request. An agent, worker or
//!                     service can never confirm its own action.
//!   BeginExecution    the executor presents the grant immediately before the
//!                     effect. The kernel gives AT MOST ONE permit per
//!                     idempotency key and re-checks the agent at that moment,
//!                     so a suspension or revocation takes effect at the next
//!                     effect boundary.
//!   RecordResult      the executor reports the provider's verified outcome.
//!
//! Refusals are answers, not errors. Errors are malformed requests, callers
//! of the wrong kind, and failures of the kernel itself.

use std::sync::Arc;

use rand::RngCore;
use serde_json::{json, Value};

use crate::clock::{self, Clock};
use crate::error::KernelError;
use crate::grants::{self, GrantSigner, GrantVerifier};
use crate::identity::{self, Verdict, VerifyOptions};
use crate::pb;
use crate::policy::{self, PolicyAnswer, PolicyClient};
use crate::store::{AgentRow, GrantRow, PendingRow, Permit, Store};

#[derive(Debug, Clone)]
pub struct KernelConfig {
    /// How long a grant is good for once issued.
    pub grant_ttl_secs: i64,
    /// How long a person has to answer a confirmation or review request.
    pub pending_ttl_secs: i64,
    /// An intent moving more than this (minor units) is never allowed without a
    /// person confirming it, whatever policy says. 0 means any money needs one.
    pub auto_allow_max_amount_minor: i64,
}

impl Default for KernelConfig {
    fn default() -> Self {
        Self { grant_ttl_secs: 300, pending_ttl_secs: 3600, auto_allow_max_amount_minor: 0 }
    }
}

pub struct Kernel {
    store: Store,
    signer: GrantSigner,
    verifier: GrantVerifier,
    trust: Value,
    policy: Arc<dyn PolicyClient>,
    clock: Arc<dyn Clock>,
    cfg: KernelConfig,
}

fn new_id(prefix: &str) -> String {
    let mut bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    format!("{prefix}_{}", hex::encode(bytes))
}

fn clean(s: &str, what: &str, max: usize) -> Result<(), KernelError> {
    if s.is_empty() {
        return Err(KernelError::Invalid(format!("{what} is required")));
    }
    if s.chars().count() > max || s.chars().any(|c| c.is_control()) {
        return Err(KernelError::Invalid(format!("{what} is not valid")));
    }
    Ok(())
}

fn is_sid(s: &str) -> bool {
    s.len() <= 96
        && s.strip_prefix("sid_").map_or(false, |rest| {
            let mut chars = rest.chars();
            chars.next().map_or(false, |c| c.is_ascii_lowercase() || c.is_ascii_digit())
                && rest.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        })
}

fn kind_of(ctx: &pb::RequestContext) -> pb::PrincipalKind {
    pb::PrincipalKind::try_from(ctx.principal_kind).unwrap_or(pb::PrincipalKind::Unspecified)
}

fn intent_to_json(i: &pb::ActionIntent) -> Value {
    json!({
        "id": i.id, "organization_id": i.organization_id, "agent_id": i.agent_id, "task_id": i.task_id,
        "capability": i.capability, "tool": i.tool, "target": i.target, "operation": i.operation,
        "risk": i.risk, "arguments_json": i.arguments_json, "amount_minor": i.amount_minor,
        "currency": i.currency, "idempotency_key": i.idempotency_key, "audience": i.audience,
    })
}

fn intent_from_json(v: &Value) -> pb::ActionIntent {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    pb::ActionIntent {
        id: s("id"), organization_id: s("organization_id"), agent_id: s("agent_id"), task_id: s("task_id"),
        capability: s("capability"), tool: s("tool"), target: s("target"), operation: s("operation"),
        risk: v.get("risk").and_then(Value::as_i64).unwrap_or(0) as i32,
        arguments_json: s("arguments_json"),
        amount_minor: v.get("amount_minor").and_then(Value::as_i64).unwrap_or(0),
        currency: s("currency"), idempotency_key: s("idempotency_key"), audience: s("audience"),
    }
}

/// Untrusted reasons that only say the agent is not `live` — these may be
/// registered (a suspension is how an agent is stopped), anything else may not.
fn only_status_untrusted(v: &Verdict) -> bool {
    v.untrusted.iter().all(|u| u.starts_with("status is "))
}

impl Kernel {
    pub fn new(
        store: Store,
        signer: GrantSigner,
        previous_verifying_keys_hex: &[String],
        trust: Value,
        policy: Arc<dyn PolicyClient>,
        clock: Arc<dyn Clock>,
        cfg: KernelConfig,
    ) -> Result<Self, String> {
        let mut keys = vec![signer.public_hex()];
        keys.extend(previous_verifying_keys_hex.iter().cloned());
        let verifier = GrantVerifier::new(&keys)?;
        Ok(Self { store, signer, verifier, trust, policy, clock, cfg })
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    fn now(&self) -> String {
        clock::fmt(self.clock.now())
    }

    fn ctx<'a>(&self, ctx: &'a Option<pb::RequestContext>) -> Result<&'a pb::RequestContext, KernelError> {
        let ctx = ctx.as_ref().ok_or_else(|| KernelError::Forbidden("request has no authenticated context".into()))?;
        clean(&ctx.organization_id, "context.organization_id", 128)?;
        clean(&ctx.principal, "context.principal", 128)?;
        if kind_of(ctx) == pb::PrincipalKind::Unspecified {
            return Err(KernelError::Forbidden("context.principal_kind is required".into()));
        }
        Ok(ctx)
    }

    /// Structural checks on an intent, and its hash. Never trusts a tenant or
    /// agent id the client supplied: the tenant must be the authenticated one,
    /// and an agent principal may only act as itself.
    fn validate_intent(&self, ctx: &pb::RequestContext, i: &pb::ActionIntent) -> Result<String, KernelError> {
        clean(&i.id, "intent.id", 128)?;
        clean(&i.organization_id, "intent.organization_id", 128)?;
        if i.organization_id != ctx.organization_id {
            return Err(KernelError::Forbidden("intent belongs to another tenant".into()));
        }
        if !is_sid(&i.agent_id) {
            return Err(KernelError::Invalid("intent.agent_id must be a sid_<slug>".into()));
        }
        if kind_of(ctx) == pb::PrincipalKind::Agent && ctx.principal != i.agent_id {
            return Err(KernelError::Forbidden("an agent can only act as itself".into()));
        }
        for (v, what) in [(&i.capability, "capability"), (&i.tool, "tool"), (&i.target, "target"), (&i.operation, "operation")] {
            clean(v, &format!("intent.{what}"), 256)?;
        }
        clean(&i.audience, "intent.audience", 128)?;
        clean(&i.idempotency_key, "intent.idempotency_key", 128)?;
        if !matches!(pb::Risk::try_from(i.risk), Ok(pb::Risk::Low | pb::Risk::Medium | pb::Risk::High)) {
            return Err(KernelError::Invalid("intent.risk is required".into()));
        }
        if i.amount_minor < 0 {
            return Err(KernelError::Invalid("intent.amount_minor cannot be negative".into()));
        }
        if i.amount_minor > 0 && !(i.currency.len() == 3 && i.currency.chars().all(|c| c.is_ascii_uppercase())) {
            return Err(KernelError::Invalid("intent.currency must be a 3-letter ISO code when money moves".into()));
        }
        if i.arguments_json.len() > 64 * 1024 {
            return Err(KernelError::Invalid("intent.arguments_json is too large".into()));
        }
        grants::intent_hash(i).map_err(KernelError::Invalid)
    }

    /// Re-verifies an agent's stored identity against the trust anchors NOW and
    /// returns the capabilities it may exercise, or the reasons it may not act.
    fn agent_check(&self, org: &str, sid: &str, capability: Option<&str>, now: &str) -> Result<(AgentRow, Vec<String>), Vec<String>> {
        let row = match self.store.agent(org, sid) {
            Ok(Some(row)) => row,
            Ok(None) => return Err(vec!["agent is not registered for this tenant".into()]),
            Err(e) => return Err(vec![format!("identity registry unavailable: {e}")]),
        };
        let verdict = identity::verify_sid(&row.cert, &VerifyOptions { trust: Some(&self.trust), ..Default::default() });
        if !verdict.ok {
            return Err(vec![format!("stored identity no longer verifies: {}", verdict.errors.join("; "))]);
        }
        if !verdict.trusted {
            return Err(verdict.untrusted.iter().map(|u| format!("identity is not trusted: {u}")).collect());
        }
        let mut allowed: Vec<String> = row.cert["capabilities"]["permissions"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
            .unwrap_or_default();
        if let Some(runtime) = &row.runtime {
            let rv = identity::verify_runtime(runtime, &row.cert, Some(&self.trust), Some(now), None);
            if !rv.trusted {
                let why = rv.errors.iter().chain(rv.untrusted.iter()).cloned().collect::<Vec<_>>().join("; ");
                return Err(vec![format!("runtime statement is not valid: {why}")]);
            }
            allowed = runtime["capabilities"]
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
                .unwrap_or_default();
        }
        if let Some(cap) = capability {
            if !allowed.iter().any(|c| c == cap) {
                return Err(vec![format!("agent does not declare capability {cap}")]);
            }
        }
        Ok((row, allowed))
    }

    fn decision_record(&self, org: &str, action_id: &str, decision: pb::Decision, a: &PolicyAnswer, extra: &[String], now: &str) -> pb::PolicyDecision {
        let mut codes = a.reason_codes.clone();
        codes.extend(extra.iter().cloned());
        pb::PolicyDecision {
            id: new_id("pd"),
            organization_id: org.to_string(),
            action_id: action_id.to_string(),
            decision: decision as i32,
            matched_rule: a.matched_rule.clone(),
            reason_codes: codes,
            reason: a.reason.clone(),
            policy_version: a.policy_version.clone(),
            decided_at: now.to_string(),
        }
    }

    /// The kernel's own rules, applied after policy. They can only make a
    /// decision stricter: DENY stays DENY, and a request for a person to
    /// confirm is never turned into ALLOW.
    fn invariants(&self, decision: pb::Decision, i: &pb::ActionIntent) -> (pb::Decision, Vec<String>) {
        if decision != pb::Decision::Allow {
            return (decision, vec![]);
        }
        if i.amount_minor > self.cfg.auto_allow_max_amount_minor {
            return (pb::Decision::RequireUserConfirmation, vec!["kernel:money_requires_confirmation".into()]);
        }
        if i.risk == pb::Risk::High as i32 {
            return (pb::Decision::RequireUserConfirmation, vec!["kernel:high_risk_requires_confirmation".into()]);
        }
        (decision, vec![])
    }

    fn issue_grant(&self, org: &str, i: &pb::ActionIntent, ihash: &str, now: chrono::DateTime<chrono::Utc>) -> Result<pb::Grant, KernelError> {
        let expires = clock::fmt(now + chrono::Duration::seconds(self.cfg.grant_ttl_secs));
        let grant = self.signer.sign(pb::Grant {
            id: new_id("grant"),
            organization_id: org.to_string(),
            subject: i.agent_id.clone(),
            audience: i.audience.clone(),
            operation: i.operation.clone(),
            target: i.target.clone(),
            max_amount_minor: i.amount_minor,
            currency: i.currency.clone(),
            intent_hash: ihash.to_string(),
            not_before: clock::fmt(now),
            expires_at: expires.clone(),
            single_use: true,
            ..Default::default()
        });
        self.store.put_grant(
            &clock::fmt(now),
            &GrantRow { id: grant.id.clone(), org: org.to_string(), subject: i.agent_id.clone(), expires_at: expires, single_use: true, used: false, revoked: false },
            ihash,
        )?;
        Ok(grant)
    }

    // ── AuthorizeAction ─────────────────────────────────────────────────────
    pub fn authorize_action(&self, req: &pb::AuthorizeActionRequest) -> Result<pb::AuthorizeActionResponse, KernelError> {
        let ctx = self.ctx(&req.context)?;
        let intent = req.intent.as_ref().ok_or_else(|| KernelError::Invalid("intent is required".into()))?;
        let ihash = self.validate_intent(ctx, intent)?;
        let now_t = self.clock.now();
        let now = clock::fmt(now_t);
        let org = &ctx.organization_id;

        let (answer, status) = match self.agent_check(org, &intent.agent_id, Some(&intent.capability), &now) {
            Err(reasons) => (PolicyAnswer::deny("identity", &reasons.join("; ")), "unknown".to_string()),
            Ok((row, caps)) => {
                let answer = match policy::request_for(ctx, intent, &row.status, &caps, &now) {
                    Err(e) => PolicyAnswer::deny("bad_request", &e),
                    Ok(request) => self.policy.decide(&request).unwrap_or_else(|e| PolicyAnswer::deny("policy_unavailable", &e)),
                };
                (answer, row.status)
            }
        };
        let (decision, extra) = self.invariants(answer.decision, intent);
        let record = self.decision_record(org, &intent.id, decision, &answer, &extra, &now);
        self.store.audit(&now, org, "intent.decided", &intent.id, &json!({
            "decision": format!("{decision:?}"), "intent_hash": ihash, "agent": intent.agent_id, "agent_status": status,
            "reason_codes": record.reason_codes, "policy_version": record.policy_version, "principal": ctx.principal,
        }))?;

        // Callers get the codes and, when there is one, the sentence that says why.
        let mut reasons = record.reason_codes.clone();
        if !record.reason.is_empty() {
            reasons.push(record.reason.clone());
        }
        let mut response = pb::AuthorizeActionResponse {
            decision: decision as i32,
            policy: Some(record.clone()),
            reasons,
            ..Default::default()
        };
        match decision {
            pb::Decision::Allow => response.grant = Some(self.issue_grant(org, intent, &ihash, now_t)?),
            pb::Decision::RequireUserConfirmation | pb::Decision::RequireHumanReview => {
                let id = new_id("pending");
                self.store.put_pending(&now, &PendingRow {
                    id: id.clone(), org: org.clone(),
                    kind: if decision == pb::Decision::RequireUserConfirmation { "user_confirmation" } else { "human_review" }.into(),
                    intent: intent_to_json(intent), intent_hash: ihash,
                    state: "pending".into(), created_at: now.clone(),
                    expires_at: clock::fmt(now_t + chrono::Duration::seconds(self.cfg.pending_ttl_secs)),
                    policy: json!({"matched_rule": record.matched_rule, "reason_codes": record.reason_codes}),
                })?;
                response.pending_id = id;
            }
            _ => {}
        }
        Ok(response)
    }

    // ── ConfirmAction ───────────────────────────────────────────────────────
    pub fn confirm_action(&self, req: &pb::ConfirmActionRequest) -> Result<pb::AuthorizeActionResponse, KernelError> {
        let ctx = self.ctx(&req.context)?;
        if kind_of(ctx) != pb::PrincipalKind::User {
            return Err(KernelError::Forbidden("only a person can confirm an action".into()));
        }
        clean(&req.pending_id, "pending_id", 128)?;
        let org = &ctx.organization_id;
        let now_t = self.clock.now();
        let now = clock::fmt(now_t);
        let pending = self.store.pending(org, &req.pending_id)?.ok_or(KernelError::NotFound)?;
        if pending.state != "pending" {
            return Err(KernelError::Precondition("this request has already been answered".into()));
        }
        let intent = intent_from_json(&pending.intent);
        let denied = |why: &str, state: &str| -> Result<pb::AuthorizeActionResponse, KernelError> {
            self.store.resolve_pending(&now, org, &pending.id, state, &ctx.principal)?;
            let answer = PolicyAnswer::deny("confirmation", why);
            Ok(pb::AuthorizeActionResponse {
                decision: pb::Decision::Deny as i32,
                policy: Some(self.decision_record(org, &intent.id, pb::Decision::Deny, &answer, &[], &now)),
                reasons: vec![why.to_string()],
                ..Default::default()
            })
        };
        if pending.expires_at.as_str() <= now.as_str() {
            return denied("the request expired before it was answered", "denied");
        }
        if !req.approve {
            return denied(&format!("declined by {}", ctx.principal), "withdrawn");
        }
        // The person's yes is not enough on its own: the agent must still be
        // trusted and live, and policy must not now say no.
        let (row, caps) = match self.agent_check(org, &intent.agent_id, Some(&intent.capability), &now) {
            Ok(ok) => ok,
            Err(reasons) => return denied(&reasons.join("; "), "denied"),
        };
        let confirm_ctx = pb::RequestContext { organization_id: org.clone(), principal: ctx.principal.clone(), principal_kind: ctx.principal_kind, correlation_id: ctx.correlation_id.clone() };
        let mut request = policy::request_for(&confirm_ctx, &intent, &row.status, &caps, &now).map_err(KernelError::Invalid)?;
        request["confirmation"] = json!({"by": ctx.principal, "kind": pending.kind});
        let answer = self.policy.decide(&request).unwrap_or_else(|e| PolicyAnswer::deny("policy_unavailable", &e));
        if answer.decision == pb::Decision::Deny {
            return denied(&format!("policy denies this action: {}", answer.reason_codes.join(", ")), "denied");
        }
        if !self.store.resolve_pending(&now, org, &pending.id, "approved", &ctx.principal)? {
            return Err(KernelError::Precondition("this request has already been answered".into()));
        }
        let grant = self.issue_grant(org, &intent, &pending.intent_hash, now_t)?;
        let mut record = self.decision_record(org, &intent.id, pb::Decision::Allow, &answer, &[], &now);
        record.reason_codes.push(format!("confirmed_by:{}", ctx.principal));
        Ok(pb::AuthorizeActionResponse {
            decision: pb::Decision::Allow as i32,
            reasons: record.reason_codes.clone(),
            policy: Some(record),
            grant: Some(grant),
            ..Default::default()
        })
    }

    // ── BeginExecution ──────────────────────────────────────────────────────
    pub fn begin_execution(&self, req: &pb::BeginExecutionRequest) -> Result<pb::BeginExecutionResponse, KernelError> {
        let ctx = self.ctx(&req.context)?;
        if kind_of(ctx) != pb::PrincipalKind::Service {
            return Err(KernelError::Forbidden("only an executor service may begin an execution".into()));
        }
        let grant = req.grant.as_ref().ok_or_else(|| KernelError::Invalid("grant is required".into()))?;
        let intent = req.intent.as_ref().ok_or_else(|| KernelError::Invalid("intent is required".into()))?;
        let ihash = self.validate_intent(ctx, intent)?;
        let org = &ctx.organization_id;
        let now_t = self.clock.now();
        let now = clock::fmt(now_t);

        let refuse = |why: Vec<String>| -> Result<pb::BeginExecutionResponse, KernelError> {
            self.store.audit(&now, org, "execution.refused", &grant.id, &json!({"why": why, "intent_hash": ihash, "executor": ctx.principal}))?;
            Ok(pb::BeginExecutionResponse { state: pb::ExecutionState::Refused as i32, reasons: why, ..Default::default() })
        };

        if let Err(e) = self.verifier.verify_signature(grant) {
            return refuse(vec![e]);
        }
        // A grant that is genuinely ours but for another tenant, agent or
        // executor is refused here, before anything about the key is revealed.
        let mut why: Vec<String> = grants::check(grant, intent, org, &ctx.principal, &now)
            .into_iter()
            .filter(|m| !matches!(m.as_str(), "grant has expired" | "grant is not valid yet"))
            .collect();
        if !why.is_empty() {
            return refuse(why);
        }
        // A retry of an execution that already began gets its recorded state,
        // even after the grant has expired: the executor must be able to learn
        // the outcome, and nothing is permitted a second time.
        if let Some(existing) = self.store.execution_by_key(org, &intent.idempotency_key)? {
            if existing.intent_hash == ihash && existing.grant_id == grant.id {
                return Ok(Self::existing_state(&existing));
            }
            return refuse(vec!["idempotency key was already used for a different action".into()]);
        }
        why = grants::check(grant, intent, org, &ctx.principal, &now);
        if self.store.grant(org, &grant.id)?.is_none() {
            why.push("grant was not issued by this kernel".into());
        }
        // The agent is checked again NOW: suspension and revocation apply at the next effect.
        if let Err(reasons) = self.agent_check(org, &intent.agent_id, Some(&intent.capability), &now) {
            why.extend(reasons);
        }
        if !why.is_empty() {
            return refuse(why);
        }
        let exec_id = new_id("exec");
        match self.store.begin_execution(&now, org, &exec_id, &grant.id, &ihash, &intent.idempotency_key, &ctx.principal)? {
            Permit::New(id) => Ok(pb::BeginExecutionResponse { state: pb::ExecutionState::Permitted as i32, execution_id: id, ..Default::default() }),
            Permit::Existing(existing) => Ok(Self::existing_state(&existing)),
            Permit::Refused(m) => Ok(pb::BeginExecutionResponse { state: pb::ExecutionState::Refused as i32, reasons: vec![m], ..Default::default() }),
        }
    }

    fn existing_state(e: &crate::store::ExecutionRow) -> pb::BeginExecutionResponse {
        let state = match e.state.as_str() {
            "succeeded" => pb::ExecutionState::Succeeded,
            "failed" => pb::ExecutionState::Failed,
            _ => pb::ExecutionState::Pending,
        };
        pb::BeginExecutionResponse { state: state as i32, execution_id: e.id.clone(), result_json: e.result.clone().unwrap_or_default(), reasons: vec![] }
    }

    // ── RecordResult ────────────────────────────────────────────────────────
    pub fn record_result(&self, req: &pb::RecordResultRequest) -> Result<pb::RecordResultResponse, KernelError> {
        let ctx = self.ctx(&req.context)?;
        if kind_of(ctx) != pb::PrincipalKind::Service {
            return Err(KernelError::Forbidden("only an executor service may record a result".into()));
        }
        let state = match pb::ExecutionState::try_from(req.state) {
            Ok(pb::ExecutionState::Succeeded) => "succeeded",
            Ok(pb::ExecutionState::Failed) => "failed",
            _ => return Err(KernelError::Invalid(
                "only SUCCEEDED or FAILED can be recorded; an ambiguous provider answer leaves the execution PENDING until it is reconciled".into())),
        };
        if req.result_json.len() > 64 * 1024 || serde_json::from_str::<Value>(&req.result_json).is_err() {
            return Err(KernelError::Invalid("result_json must be JSON and at most 64 KiB".into()));
        }
        clean(&req.execution_id, "execution_id", 128)?;
        let org = &ctx.organization_id;
        let row = self.store.execution(org, &req.execution_id)?.ok_or(KernelError::NotFound)?;
        if row.executor != ctx.principal {
            return Err(KernelError::Forbidden("only the executor that began this execution may record its result".into()));
        }
        let now = self.now();
        if row.state != "pending" {
            // A retry of the same report is accepted; a different one is not.
            if row.state == state && row.result.as_deref() == Some(req.result_json.as_str()) {
                let hash = self.store.audit_entries(Some(org))?.iter().rev()
                    .find(|e| e.kind == "execution.recorded" && e.subject == row.id).map(|e| e.hash.clone()).unwrap_or_default();
                return Ok(pb::RecordResultResponse { state: req.state, receipt_hash: hash });
            }
            return Err(KernelError::Precondition("this execution already has a recorded outcome".into()));
        }
        let receipt_hash = self.store.finish_execution(&now, org, &row.id, state, &req.result_json)?;
        Ok(pb::RecordResultResponse { state: req.state, receipt_hash })
    }

    // ── GetPending ──────────────────────────────────────────────────────────
    pub fn get_pending(&self, req: &pb::GetPendingRequest) -> Result<pb::GetPendingResponse, KernelError> {
        let ctx = self.ctx(&req.context)?;
        if kind_of(ctx) == pb::PrincipalKind::Agent {
            return Err(KernelError::Forbidden("an agent cannot read held decisions".into()));
        }
        clean(&req.pending_id, "pending_id", 128)?;
        let p = self.store.pending(&ctx.organization_id, &req.pending_id)?.ok_or(KernelError::NotFound)?;
        let now = self.now();
        let state = if p.state == "pending" && p.expires_at.as_str() <= now.as_str() { "expired".to_string() } else { p.state.clone() };
        let reason_codes = p.policy.get("reason_codes").and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default();
        Ok(pb::GetPendingResponse {
            pending_id: p.id, kind: p.kind, state,
            intent: Some(intent_from_json(&p.intent)),
            created_at: p.created_at, expires_at: p.expires_at, reason_codes,
        })
    }

    // ── RevokeGrant ─────────────────────────────────────────────────────────
    pub fn revoke_grant(&self, req: &pb::RevokeGrantRequest) -> Result<pb::RevokeGrantResponse, KernelError> {
        let ctx = self.ctx(&req.context)?;
        if kind_of(ctx) == pb::PrincipalKind::Agent {
            return Err(KernelError::Forbidden("an agent cannot revoke grants".into()));
        }
        clean(&req.grant_id, "grant_id", 128)?;
        let revoked = self.store.revoke_grant(&self.now(), &ctx.organization_id, &req.grant_id, &req.reason, &ctx.principal)?;
        Ok(pb::RevokeGrantResponse { revoked })
    }

    // ── VerifyIdentity ──────────────────────────────────────────────────────
    pub fn verify_identity(&self, req: &pb::VerifyIdentityRequest) -> Result<pb::VerifyIdentityResponse, KernelError> {
        let ctx = self.ctx(&req.context)?;
        let cert: Value = serde_json::from_str(&req.certificate_json).map_err(|e| KernelError::Invalid(format!("certificate_json: {e}")))?;
        let runtime: Option<Value> = if req.runtime_json.is_empty() { None } else {
            Some(serde_json::from_str(&req.runtime_json).map_err(|e| KernelError::Invalid(format!("runtime_json: {e}")))?)
        };
        let org = &ctx.organization_id;
        let now = self.now();
        let existing = self.store.agent(org, cert.get("id").and_then(Value::as_str).unwrap_or(""))?;
        let verdict = identity::verify_sid(&cert, &VerifyOptions { trust: Some(&self.trust), previous: existing.as_ref().map(|e| &e.cert), ..Default::default() });
        let mut errors = verdict.errors.clone();
        let mut untrusted = verdict.untrusted.clone();
        let mut ok = verdict.ok;
        let mut trusted = verdict.trusted;
        if let Some(rt) = &runtime {
            let rv = identity::verify_runtime(rt, &cert, Some(&self.trust), Some(&now), None);
            ok &= rv.ok;
            trusted &= rv.trusted;
            errors.extend(rv.errors);
            untrusted.extend(rv.untrusted);
        }
        let mut response = pb::VerifyIdentityResponse {
            ok, trusted, errors, untrusted,
            sid: cert.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
            acting_hash: cert.get("acting_hash").and_then(Value::as_str).unwrap_or("").to_string(),
            registered: false,
        };
        if !req.register {
            return Ok(response);
        }
        if kind_of(ctx) != pb::PrincipalKind::Service {
            return Err(KernelError::Forbidden("only a service may register an identity".into()));
        }
        let version = cert.get("version").and_then(Value::as_i64).unwrap_or(0);
        if let Some(e) = &existing {
            if version <= e.version {
                response.errors.push(format!("version {version} is not newer than the registered version {}", e.version));
                return Ok(response);
            }
        }
        let runtime_ok = runtime.as_ref().map_or(true, |rt| identity::verify_runtime(rt, &cert, Some(&self.trust), Some(&now), None).trusted);
        if !(verdict.ok && only_status_untrusted(&verdict) && runtime_ok && response.errors.is_empty()) {
            response.errors.push("identity was not registered: it must verify under a trust anchor".into());
            return Ok(response);
        }
        self.store.put_agent(&now, &AgentRow {
            org: org.clone(),
            sid: response.sid.clone(),
            version,
            hash: cert.get("hash").and_then(Value::as_str).unwrap_or("").to_string(),
            status: cert.get("status").and_then(Value::as_str).unwrap_or("").to_string(),
            cert, runtime,
        }, &ctx.principal)?;
        response.registered = true;
        Ok(response)
    }

    // ── Health ──────────────────────────────────────────────────────────────
    pub fn health(&self) -> pb::HealthResponse {
        let policy_available = self.policy.available();
        match self.store.verify_audit() {
            Ok((entries, head)) => pb::HealthResponse {
                status: if policy_available { "ok".into() } else { "degraded: policy service unreachable; privileged actions are denied".into() },
                version: env!("CARGO_PKG_VERSION").into(),
                policy_available, audit_entries: entries, audit_head: head,
            },
            Err(e) => pb::HealthResponse {
                status: format!("failing: {e}"), version: env!("CARGO_PKG_VERSION").into(),
                policy_available, audit_entries: 0, audit_head: String::new(),
            },
        }
    }
}
