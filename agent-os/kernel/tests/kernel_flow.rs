//! The kernel's authorize / confirm / execute boundary, end to end in process.

mod common;

use common::*;
use helix_kernel::kernel::KernelConfig;
use helix_kernel::pb::{self, Decision, ExecutionState as ES, PrincipalKind};
use helix_kernel::store::Store;
use serde_json::json;

fn allowed_grant(env: &Env, org: &str, i: &pb::ActionIntent) -> pb::Grant {
    let r = authorize(env, org, i);
    assert_eq!(decision(&r), Decision::Allow, "reasons: {:?}", r.reasons);
    r.grant.expect("an allowed intent carries a grant")
}

/// A confirmed order: the person says yes, and the grant comes back.
fn confirmed_order(env: &Env, org: &str) -> (pb::ActionIntent, pb::Grant) {
    let i = order(org);
    let r = authorize(env, org, &i);
    assert_eq!(decision(&r), Decision::RequireUserConfirmation);
    let confirmed = env.kernel.confirm_action(&pb::ConfirmActionRequest { context: user(org), pending_id: r.pending_id, approve: true }).unwrap();
    assert_eq!(decision(&confirmed), Decision::Allow, "{:?}", confirmed.reasons);
    (i, confirmed.grant.unwrap())
}

// ── identity registry ────────────────────────────────────────────────────────

#[test]
fn an_unregistered_agent_is_denied() {
    let e = env();
    let r = authorize(&e, ORG, &intent(ORG, "kb.search"));
    assert_eq!(decision(&r), Decision::Deny);
    assert!(r.reasons.iter().any(|x| x.contains("identity")));
    assert!(r.grant.is_none());
}

#[test]
fn only_an_identity_trusted_by_an_anchor_can_be_registered() {
    let e = env();
    let mut forged = cert(AGENT, &["kb.search"], "live", None);
    forged["issuer"]["id"] = json!("issuer:someone-else");
    let forged = sign_doc({ let mut d = forged; d.as_object_mut().unwrap().remove("proof"); d }, &issuer_secret());
    let r = register(&e, ORG, &forged);
    assert!(!r.registered);
    assert!(!r.errors.is_empty());
    assert_eq!(decision(&authorize(&e, ORG, &intent(ORG, "kb.search"))), Decision::Deny);
}

#[test]
fn registration_needs_a_service_and_only_moves_forward() {
    let e = env();
    let v1 = cert(AGENT, &["kb.search"], "live", None);
    let by_user = e.kernel.verify_identity(&pb::VerifyIdentityRequest { context: user(ORG), certificate_json: v1.to_string(), register: true, ..Default::default() });
    assert!(by_user.is_err(), "a user must not register identities");
    assert!(register(&e, ORG, &v1).registered);
    let again = register(&e, ORG, &v1);
    assert!(!again.registered);
    assert!(again.errors.iter().any(|m| m.contains("not newer")));
    let v2 = cert(AGENT, &["kb.search"], "live", Some(&v1));
    assert!(register(&e, ORG, &v2).registered);
    assert!(!register(&e, ORG, &v1).registered, "an older version cannot replace a newer one");
}

#[test]
fn an_agent_registered_for_one_tenant_does_not_exist_in_another() {
    let e = env();
    registered_agent(&e, ORG);
    let r = authorize(&e, OTHER_ORG, &intent(OTHER_ORG, "kb.search"));
    assert_eq!(decision(&r), Decision::Deny);
}

// ── authorize ────────────────────────────────────────────────────────────────

#[test]
fn a_low_risk_no_money_action_is_allowed_with_a_scoped_signed_grant() {
    let e = env();
    registered_agent(&e, ORG);
    let i = intent(ORG, "kb.search");
    let g = allowed_grant(&e, ORG, &i);
    assert_eq!((g.organization_id.as_str(), g.subject.as_str(), g.audience.as_str()), (ORG, AGENT, EXECUTOR));
    assert_eq!((g.operation.as_str(), g.target.as_str(), g.max_amount_minor), ("kb.search", "kb:main", 0));
    assert!(g.single_use && !g.signature.is_empty() && g.not_before == NOW);
    assert_eq!(g.expires_at, "2026-11-20T12:05:00Z");
    // the policy service was told who, for which tenant and what
    let seen = e.policy.requests.lock().unwrap().last().cloned().unwrap();
    assert_eq!(seen["organization_id"], ORG);
    assert_eq!(seen["agent"]["sid"], AGENT);
    assert_eq!(seen["agent"]["status"], "live");
    assert_eq!(seen["principal"]["kind"], "agent");
    assert_eq!(seen["intent"]["arguments"]["q"], "opening hours");
}

#[test]
fn an_agent_cannot_act_beyond_the_capabilities_its_identity_declares() {
    let e = env();
    registered_agent(&e, ORG);
    let mut i = intent(ORG, "payment.charge");
    i.operation = "payment.charge".into();
    let r = authorize(&e, ORG, &i);
    assert_eq!(decision(&r), Decision::Deny);
    assert!(r.reasons.iter().any(|m| m.contains("does not declare capability")), "{:?}", r.reasons);
}

#[test]
fn policy_deny_is_final() {
    let e = env();
    registered_agent(&e, ORG);
    e.policy.set(Decision::Deny);
    let r = authorize(&e, ORG, &intent(ORG, "kb.search"));
    assert_eq!(decision(&r), Decision::Deny);
    assert!(r.grant.is_none() && r.pending_id.is_empty());
}

#[test]
fn when_policy_cannot_answer_the_answer_is_deny() {
    let e = env();
    registered_agent(&e, ORG);
    e.policy.fail("connection refused");
    let r = authorize(&e, ORG, &intent(ORG, "kb.search"));
    assert_eq!(decision(&r), Decision::Deny);
    assert!(r.reasons.iter().any(|m| m == "policy_unavailable"));
    assert!(r.grant.is_none());
    assert!(!e.kernel.health().policy_available);
}

#[test]
fn the_kernel_refuses_to_let_policy_allow_money_to_move_unconfirmed() {
    let e = env();
    registered_agent(&e, ORG);
    e.policy.set(Decision::Allow);
    let r = authorize(&e, ORG, &order(ORG));
    assert_eq!(decision(&r), Decision::RequireUserConfirmation);
    assert!(r.grant.is_none());
    assert!(!r.pending_id.is_empty());
    assert!(r.reasons.iter().any(|m| m == "kernel:money_requires_confirmation"));
}

#[test]
fn the_auto_allow_limit_is_configurable_but_high_risk_still_needs_a_person() {
    let e = env_with(KernelConfig { auto_allow_max_amount_minor: 2000, ..Default::default() }, Store::in_memory().unwrap(), SIGNER_SECRET, &[]);
    registered_agent(&e, ORG);
    let small = order(ORG);
    assert_eq!(decision(&authorize(&e, ORG, &small)), Decision::Allow, "12.00 is under the 20.00 limit");
    let mut big = order(ORG);
    big.amount_minor = 2001;
    assert_eq!(decision(&authorize(&e, ORG, &big)), Decision::RequireUserConfirmation);
    let mut risky = order(ORG);
    risky.risk = pb::Risk::High as i32;
    let r = authorize(&e, ORG, &risky);
    assert_eq!(decision(&r), Decision::RequireUserConfirmation);
    assert!(r.reasons.iter().any(|m| m == "kernel:high_risk_requires_confirmation"));
}

#[test]
fn an_invariant_never_loosens_a_decision() {
    let e = env();
    registered_agent(&e, ORG);
    e.policy.set(Decision::RequireHumanReview);
    assert_eq!(decision(&authorize(&e, ORG, &intent(ORG, "kb.search"))), Decision::RequireHumanReview);
}

#[test]
fn malformed_intents_are_rejected_not_decided() {
    let e = env();
    registered_agent(&e, ORG);
    let bad = |f: &dyn Fn(&mut pb::ActionIntent)| {
        let mut i = intent(ORG, "kb.search");
        f(&mut i);
        e.kernel.authorize_action(&pb::AuthorizeActionRequest { context: agent(ORG, AGENT), intent: Some(i) })
    };
    assert!(bad(&|i| i.arguments_json = "not json".into()).is_err());
    assert!(bad(&|i| i.arguments_json = "[1]".into()).is_err());
    assert!(bad(&|i| i.arguments_json = r#"{"x": 1.5}"#.into()).is_err(), "a float cannot be canonicalized");
    assert!(bad(&|i| i.amount_minor = -1).is_err());
    assert!(bad(&|i| { i.amount_minor = 5; i.currency = String::new(); }).is_err());
    assert!(bad(&|i| i.idempotency_key = String::new()).is_err());
    assert!(bad(&|i| i.risk = 0).is_err());
    assert!(bad(&|i| i.agent_id = "someone".into()).is_err());
    assert!(bad(&|i| i.operation = "x\u{0}y".into()).is_err());
}

// ── tenants and principals ───────────────────────────────────────────────────

#[test]
fn a_client_supplied_tenant_never_overrides_the_authenticated_one() {
    let e = env();
    registered_agent(&e, ORG);
    registered_agent(&e, OTHER_ORG);
    let mut i = intent(OTHER_ORG, "kb.search");
    i.organization_id = OTHER_ORG.into();
    let r = e.kernel.authorize_action(&pb::AuthorizeActionRequest { context: agent(ORG, AGENT), intent: Some(i) });
    assert!(r.is_err(), "an org-a principal asked to act in org-b");
}

#[test]
fn an_agent_can_only_act_as_itself() {
    let e = env();
    registered_agent(&e, ORG);
    let i = intent(ORG, "kb.search");
    let r = e.kernel.authorize_action(&pb::AuthorizeActionRequest { context: agent(ORG, "sid_other-agent"), intent: Some(i) });
    assert!(r.is_err());
}

#[test]
fn a_request_without_an_authenticated_context_is_refused() {
    let e = env();
    let r = e.kernel.authorize_action(&pb::AuthorizeActionRequest { context: None, intent: Some(intent(ORG, "kb.search")) });
    assert!(r.is_err());
    let anon = ctx(ORG, "x", PrincipalKind::Unspecified);
    assert!(e.kernel.authorize_action(&pb::AuthorizeActionRequest { context: anon, intent: Some(intent(ORG, "kb.search")) }).is_err());
}

// ── confirmation ─────────────────────────────────────────────────────────────

#[test]
fn a_person_confirms_and_a_grant_is_issued_for_exactly_that_action() {
    let e = env();
    registered_agent(&e, ORG);
    let (i, g) = confirmed_order(&e, ORG);
    assert_eq!((g.max_amount_minor, g.currency.as_str(), g.operation.as_str()), (1200, "USD", "order.create"));
    assert_eq!(state(&begin(&e, ORG, &g, &i)), ES::Permitted);
}

#[test]
fn nothing_but_a_person_can_confirm() {
    let e = env();
    registered_agent(&e, ORG);
    let r = authorize(&e, ORG, &order(ORG));
    for who in [agent(ORG, AGENT), svc(ORG)] {
        let attempt = e.kernel.confirm_action(&pb::ConfirmActionRequest { context: who, pending_id: r.pending_id.clone(), approve: true });
        assert!(attempt.is_err(), "an agent or worker confirmed its own action");
    }
    assert!(e.kernel.confirm_action(&pb::ConfirmActionRequest { context: user(ORG), pending_id: r.pending_id.clone(), approve: true }).is_ok());
}

#[test]
fn a_pending_request_cannot_be_answered_twice_or_from_another_tenant() {
    let e = env();
    registered_agent(&e, ORG);
    let r = authorize(&e, ORG, &order(ORG));
    let from_b = e.kernel.confirm_action(&pb::ConfirmActionRequest { context: user(OTHER_ORG), pending_id: r.pending_id.clone(), approve: true });
    assert!(matches!(from_b, Err(helix_kernel::error::KernelError::NotFound)));
    let ask = || e.kernel.confirm_action(&pb::ConfirmActionRequest { context: user(ORG), pending_id: r.pending_id.clone(), approve: true });
    assert!(ask().is_ok());
    assert!(ask().is_err(), "second answer");
}

#[test]
fn declining_and_expiry_both_end_in_deny_with_no_grant() {
    let e = env();
    registered_agent(&e, ORG);
    let r = authorize(&e, ORG, &order(ORG));
    let no = e.kernel.confirm_action(&pb::ConfirmActionRequest { context: user(ORG), pending_id: r.pending_id, approve: false }).unwrap();
    assert_eq!(decision(&no), Decision::Deny);
    assert!(no.grant.is_none());

    let late = authorize(&e, ORG, &order(ORG));
    e.clock.advance(3601);
    let yes = e.kernel.confirm_action(&pb::ConfirmActionRequest { context: user(ORG), pending_id: late.pending_id, approve: true }).unwrap();
    assert_eq!(decision(&yes), Decision::Deny);
    assert!(yes.reasons.iter().any(|m| m.contains("expired")));
}

#[test]
fn a_yes_does_not_survive_the_agent_being_suspended_or_policy_changing_its_mind() {
    let e = env();
    let v1 = registered_agent(&e, ORG);
    let r = authorize(&e, ORG, &order(ORG));
    let v2 = cert(AGENT, &["kb.search", "merchant.order"], "suspended", Some(&v1));
    assert!(register(&e, ORG, &v2).registered, "a suspension must be registrable");
    let yes = e.kernel.confirm_action(&pb::ConfirmActionRequest { context: user(ORG), pending_id: r.pending_id, approve: true }).unwrap();
    assert_eq!(decision(&yes), Decision::Deny);

    let e2 = env();
    registered_agent(&e2, ORG);
    let r2 = authorize(&e2, ORG, &order(ORG));
    e2.policy.set(Decision::Deny);
    let yes2 = e2.kernel.confirm_action(&pb::ConfirmActionRequest { context: user(ORG), pending_id: r2.pending_id, approve: true }).unwrap();
    assert_eq!(decision(&yes2), Decision::Deny);
}

// ── execution: one permit, bound to the action ───────────────────────────────

#[test]
fn the_first_begin_is_permitted_and_every_retry_is_not() {
    let e = env();
    registered_agent(&e, ORG);
    let i = intent(ORG, "kb.search");
    let g = allowed_grant(&e, ORG, &i);
    let first = begin(&e, ORG, &g, &i);
    assert_eq!(state(&first), ES::Permitted);
    let retry = begin(&e, ORG, &g, &i);
    assert_eq!(state(&retry), ES::Pending, "a retry must never be permitted a second time");
    assert_eq!(retry.execution_id, first.execution_id);
}

#[test]
fn concurrent_begins_with_one_key_produce_exactly_one_permit() {
    let e = env();
    registered_agent(&e, ORG);
    let i = intent(ORG, "kb.search");
    let g = allowed_grant(&e, ORG, &i);
    let handles: Vec<_> = (0..16).map(|_| {
        let (k, g, i) = (e.kernel.clone(), g.clone(), i.clone());
        std::thread::spawn(move || {
            k.begin_execution(&pb::BeginExecutionRequest { context: svc(ORG), grant: Some(g), intent: Some(i) }).unwrap().state
        })
    }).collect();
    let states: Vec<i32> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let permitted = states.iter().filter(|s| **s == ES::Permitted as i32).count();
    assert_eq!(permitted, 1, "states: {states:?}");
    assert!(states.iter().all(|s| *s == ES::Permitted as i32 || *s == ES::Pending as i32));
}

#[test]
fn a_single_use_grant_cannot_cover_a_second_idempotency_key() {
    let e = env();
    registered_agent(&e, ORG);
    let i = intent(ORG, "kb.search");
    let g = allowed_grant(&e, ORG, &i);
    assert_eq!(state(&begin(&e, ORG, &g, &i)), ES::Permitted);
    let mut again = i.clone();
    again.idempotency_key = unique("other");
    // different key means a different intent hash, so the grant itself no longer matches
    assert_eq!(state(&begin(&e, ORG, &g, &again)), ES::Refused);
}

#[test]
fn the_recorded_outcome_is_returned_to_later_callers_and_cannot_be_rewritten() {
    let e = env();
    registered_agent(&e, ORG);
    let i = intent(ORG, "kb.search");
    let g = allowed_grant(&e, ORG, &i);
    let exec = begin(&e, ORG, &g, &i).execution_id;
    let record = |state: ES, result: &str| e.kernel.record_result(&pb::RecordResultRequest { context: svc(ORG), execution_id: exec.clone(), state: state as i32, result_json: result.into() });
    let done = record(ES::Succeeded, r#"{"confirmation":"abc"}"#).unwrap();
    assert!(!done.receipt_hash.is_empty());
    let again = begin(&e, ORG, &g, &i);
    assert_eq!(state(&again), ES::Succeeded);
    assert_eq!(again.result_json, r#"{"confirmation":"abc"}"#);
    assert_eq!(record(ES::Succeeded, r#"{"confirmation":"abc"}"#).unwrap().receipt_hash, done.receipt_hash, "an identical retry is accepted");
    assert!(record(ES::Failed, r#"{"error":"x"}"#).is_err(), "a recorded outcome is final");
}

#[test]
fn an_ambiguous_provider_answer_cannot_be_recorded_as_an_outcome() {
    let e = env();
    registered_agent(&e, ORG);
    let i = intent(ORG, "kb.search");
    let g = allowed_grant(&e, ORG, &i);
    let exec = begin(&e, ORG, &g, &i).execution_id;
    for s in [ES::Pending, ES::Permitted, ES::Refused, ES::Unspecified] {
        let r = e.kernel.record_result(&pb::RecordResultRequest { context: svc(ORG), execution_id: exec.clone(), state: s as i32, result_json: "{}".into() });
        assert!(r.is_err(), "{s:?} must not be recordable");
    }
    let bad_json = e.kernel.record_result(&pb::RecordResultRequest { context: svc(ORG), execution_id: exec.clone(), state: ES::Succeeded as i32, result_json: "nope".into() });
    assert!(bad_json.is_err());
    assert_eq!(state(&begin(&e, ORG, &g, &i)), ES::Pending, "still pending until reconciled");
}

#[test]
fn only_the_executor_that_began_an_execution_can_record_it_and_only_in_its_tenant() {
    let e = env();
    registered_agent(&e, ORG);
    let i = intent(ORG, "kb.search");
    let g = allowed_grant(&e, ORG, &i);
    let exec = begin(&e, ORG, &g, &i).execution_id;
    let rec = |context| e.kernel.record_result(&pb::RecordResultRequest { context, execution_id: exec.clone(), state: ES::Succeeded as i32, result_json: "{}".into() });
    assert!(rec(ctx(ORG, "svc:someone-else", PrincipalKind::Service)).is_err());
    assert!(rec(user(ORG)).is_err());
    assert!(matches!(rec(svc(OTHER_ORG)), Err(helix_kernel::error::KernelError::NotFound)));
    assert!(rec(svc(ORG)).is_ok());
}

#[test]
fn begin_is_for_executor_services_only() {
    let e = env();
    registered_agent(&e, ORG);
    let i = intent(ORG, "kb.search");
    let g = allowed_grant(&e, ORG, &i);
    for who in [agent(ORG, AGENT), user(ORG)] {
        let r = e.kernel.begin_execution(&pb::BeginExecutionRequest { context: who, grant: Some(g.clone()), intent: Some(i.clone()) });
        assert!(r.is_err());
    }
}

// ── the grant must match the action it was issued for ────────────────────────

#[test]
fn changing_anything_about_the_action_after_authorization_is_refused() {
    let e = env();
    registered_agent(&e, ORG);
    let (i, g) = confirmed_order(&e, ORG);
    let tamper: Vec<(&str, Box<dyn Fn(&mut pb::ActionIntent)>)> = vec![
        ("amount", Box::new(|i| i.amount_minor = 1201)),
        ("quote", Box::new(|i| i.arguments_json = r#"{"quote_ref":"q_2","items":[{"sku":"latte","qty":1}]}"#.into())),
        ("items", Box::new(|i| i.arguments_json = r#"{"quote_ref":"q_1","items":[{"sku":"latte","qty":9}]}"#.into())),
        ("target", Box::new(|i| i.target = "merchant:other".into())),
        ("operation", Box::new(|i| i.operation = "order.refund".into())),
        ("currency", Box::new(|i| i.currency = "EUR".into())),
        ("tool", Box::new(|i| i.tool = "merchant.other".into())),
    ];
    for (what, f) in tamper {
        let mut t = i.clone();
        f(&mut t);
        let r = begin(&e, ORG, &g, &t);
        assert_eq!(state(&r), ES::Refused, "{what} was accepted");
    }
    assert_eq!(state(&begin(&e, ORG, &g, &i)), ES::Permitted, "the real action still goes");
}

#[test]
fn a_grant_for_one_agent_executor_or_tenant_is_not_good_for_another() {
    let e = env();
    registered_agent(&e, ORG);
    registered_agent(&e, OTHER_ORG);
    let i = intent(ORG, "kb.search");
    let g = allowed_grant(&e, ORG, &i);
    // another executor
    let other_exec = e.kernel.begin_execution(&pb::BeginExecutionRequest {
        context: ctx(ORG, "svc:another", PrincipalKind::Service), grant: Some(g.clone()), intent: Some(i.clone()) }).unwrap();
    assert_eq!(state(&other_exec), ES::Refused);
    // another tenant, presenting org-a's grant against an org-b intent
    let mut theirs = intent(OTHER_ORG, "kb.search");
    theirs.idempotency_key = i.idempotency_key.clone();
    assert_eq!(state(&begin(&e, OTHER_ORG, &g, &theirs)), ES::Refused);
    // a tenant-mismatched call is an error, not an answer: org-b's context cannot name org-a's intent
    let mismatched = e.kernel.begin_execution(&pb::BeginExecutionRequest { context: svc(OTHER_ORG), grant: Some(g.clone()), intent: Some(i.clone()) });
    assert!(mismatched.is_err());
}

#[test]
fn a_forged_edited_or_foreign_signed_grant_is_refused() {
    let e = env();
    registered_agent(&e, ORG);
    let i = intent(ORG, "kb.search");
    let g = allowed_grant(&e, ORG, &i);

    let mut edited = g.clone();
    edited.max_amount_minor = 999_999;
    assert_eq!(state(&begin(&e, ORG, &edited, &i)), ES::Refused);

    let mut unsigned = g.clone();
    unsigned.signature = String::new();
    assert_eq!(state(&begin(&e, ORG, &unsigned, &i)), ES::Refused);

    // signed by some other key, with every field correct
    let stranger = helix_kernel::grants::GrantSigner::from_secret_hex(&"07".repeat(32)).unwrap();
    let forged = stranger.sign(pb::Grant { signature: String::new(), ..g.clone() });
    let r = begin(&e, ORG, &forged, &i);
    assert_eq!(state(&r), ES::Refused);
    assert!(r.reasons.iter().any(|m| m.contains("unknown key")), "{:?}", r.reasons);
}

#[test]
fn grants_expire_and_can_be_revoked() {
    let e = env();
    registered_agent(&e, ORG);
    let i = intent(ORG, "kb.search");
    let g = allowed_grant(&e, ORG, &i);
    e.clock.advance(301);
    let r = begin(&e, ORG, &g, &i);
    assert_eq!(state(&r), ES::Refused);
    assert!(r.reasons.iter().any(|m| m.contains("expired")));

    let i2 = intent(ORG, "kb.search");
    let g2 = allowed_grant(&e, ORG, &i2);
    let revoke = |ctx| e.kernel.revoke_grant(&pb::RevokeGrantRequest { context: ctx, grant_id: g2.id.clone(), reason: "customer cancelled".into() });
    assert!(revoke(agent(ORG, AGENT)).is_err(), "an agent cannot revoke");
    assert!(!revoke(user(OTHER_ORG)).unwrap().revoked, "another tenant cannot revoke");
    assert!(revoke(user(ORG)).unwrap().revoked);
    let r2 = begin(&e, ORG, &g2, &i2);
    assert_eq!(state(&r2), ES::Refused);
    assert!(r2.reasons.iter().any(|m| m.contains("revoked")));
}

#[test]
fn a_retry_after_the_grant_expired_still_learns_the_outcome_but_gets_no_new_permit() {
    let e = env();
    registered_agent(&e, ORG);
    let i = intent(ORG, "kb.search");
    let g = allowed_grant(&e, ORG, &i);
    let exec = begin(&e, ORG, &g, &i).execution_id;
    e.kernel.record_result(&pb::RecordResultRequest { context: svc(ORG), execution_id: exec, state: ES::Succeeded as i32, result_json: r#"{"ok":true}"#.into() }).unwrap();
    e.clock.advance(3600);
    let late = begin(&e, ORG, &g, &i);
    assert_eq!(state(&late), ES::Succeeded);
    assert_eq!(late.result_json, r#"{"ok":true}"#);
}

#[test]
fn rotating_the_signing_key_keeps_old_grants_until_the_old_key_is_removed() {
    let old_secret = "11".repeat(32);
    let old_public = helix_kernel::grants::GrantSigner::from_secret_hex(&old_secret).unwrap().public_hex();
    let old = env_with(KernelConfig::default(), Store::in_memory().unwrap(), &old_secret, &[]);
    registered_agent(&old, ORG);
    let i = intent(ORG, "kb.search");
    let g = allowed_grant(&old, ORG, &i);

    // a new kernel that still honours the old key
    let dir = std::env::temp_dir().join(format!("helix-kernel-rotation-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("k.sqlite");
    let _ = std::fs::remove_file(&path);
    let with_old = env_with(KernelConfig::default(), Store::open(&path).unwrap(), SIGNER_SECRET, &[old_public.clone()]);
    registered_agent(&with_old, ORG);
    // the grant row must exist in this kernel's store for it to be honoured: issue in `old`'s db is separate,
    // so the rotated kernel only verifies the SIGNATURE of an old grant; it refuses it as not its own issue.
    let r = begin(&with_old, ORG, &g, &i);
    assert_eq!(state(&r), ES::Refused);
    assert!(!r.reasons.iter().any(|m| m.contains("unknown key")), "the old key should still verify: {:?}", r.reasons);
    // without the old key the same grant is refused for its signature
    let without = env_with(KernelConfig::default(), Store::in_memory().unwrap(), SIGNER_SECRET, &[]);
    registered_agent(&without, ORG);
    let r2 = begin(&without, ORG, &g, &i);
    assert!(r2.reasons.iter().any(|m| m.contains("unknown key")), "{:?}", r2.reasons);
}

// ── suspension takes effect at the next effect boundary ─────────────────────

#[test]
fn suspending_an_agent_stops_a_grant_it_already_holds() {
    let e = env();
    let v1 = registered_agent(&e, ORG);
    let i = intent(ORG, "kb.search");
    let g = allowed_grant(&e, ORG, &i);
    let v2 = cert(AGENT, &["kb.search", "merchant.order"], "suspended", Some(&v1));
    assert!(register(&e, ORG, &v2).registered);
    let r = begin(&e, ORG, &g, &i);
    assert_eq!(state(&r), ES::Refused);
    assert!(r.reasons.iter().any(|m| m.contains("not trusted") || m.contains("suspended")), "{:?}", r.reasons);
}

#[test]
fn an_agent_whose_issuer_key_is_later_marked_compromised_stops_acting() {
    // Trust anchors are re-applied at every effect boundary. The operator marks
    // the issuer's key compromised and restarts the kernel on the same database:
    // the agent, registered earlier, can no longer act and holds no usable grant.
    let dir = std::env::temp_dir().join(format!("helix-kernel-compromise-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("k.sqlite");
    let _ = std::fs::remove_file(&path);
    let i = intent(ORG, "kb.search");
    let g;
    {
        let e = env_with(KernelConfig::default(), Store::open(&path).unwrap(), SIGNER_SECRET, &[]);
        registered_agent(&e, ORG);
        g = allowed_grant(&e, ORG, &i);
    }
    let mut burned = trust();
    burned["issuers"]["issuer:helix-test-root"]["keys"][0]["compromised"] = json!(true);
    let k = helix_kernel::kernel::Kernel::new(
        Store::open(&path).unwrap(),
        helix_kernel::grants::GrantSigner::from_secret_hex(SIGNER_SECRET).unwrap(), &[], burned,
        ScriptedPolicy::new(Decision::Allow), std::sync::Arc::new(helix_kernel::clock::ManualClock::at(NOW)), KernelConfig::default()).unwrap();
    let began = k.begin_execution(&pb::BeginExecutionRequest { context: svc(ORG), grant: Some(g), intent: Some(i.clone()) }).unwrap();
    assert_eq!(state(&began), ES::Refused);
    assert!(began.reasons.iter().any(|m| m.contains("compromised")), "{:?}", began.reasons);
    let again = k.authorize_action(&pb::AuthorizeActionRequest { context: agent(ORG, AGENT), intent: Some(intent(ORG, "kb.search")) }).unwrap();
    assert_eq!(decision(&again), Decision::Deny);
}

// ── audit ────────────────────────────────────────────────────────────────────

#[test]
fn every_decision_and_effect_is_recorded_in_a_verifiable_chain() {
    let e = env();
    registered_agent(&e, ORG);
    let i = intent(ORG, "kb.search");
    let g = allowed_grant(&e, ORG, &i);
    let exec = begin(&e, ORG, &g, &i).execution_id;
    e.kernel.record_result(&pb::RecordResultRequest { context: svc(ORG), execution_id: exec, state: ES::Succeeded as i32, result_json: "{}".into() }).unwrap();
    let kinds: Vec<String> = e.kernel.store().audit_entries(Some(ORG)).unwrap().into_iter().map(|x| x.kind).collect();
    assert_eq!(kinds, ["identity.registered", "intent.decided", "grant.issued", "execution.permitted", "execution.recorded"]);
    let h = e.kernel.health();
    assert_eq!(h.status, "ok");
    assert_eq!(h.audit_entries, 5);
    assert_eq!(h.audit_head, e.kernel.store().verify_audit().unwrap().1);
}

#[test]
fn the_audit_log_never_holds_arguments_or_signatures() {
    let e = env();
    registered_agent(&e, ORG);
    let (_i, g) = confirmed_order(&e, ORG);
    let dump: String = e.kernel.store().audit_entries(None).unwrap().iter().map(|x| x.data.to_string()).collect();
    assert!(!dump.contains("quote_ref") && !dump.contains("latte"), "tool arguments leaked into the audit log");
    assert!(!dump.contains(&g.signature), "a grant signature leaked into the audit log");
}

#[test]
fn editing_deleting_or_reordering_audit_entries_is_detected() {
    let dir = std::env::temp_dir().join(format!("helix-kernel-audit-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mutate = |name: &str, sql: &str| {
        let path = dir.join(name);
        let _ = std::fs::remove_file(&path);
        let e = env_with(KernelConfig::default(), Store::open(&path).unwrap(), SIGNER_SECRET, &[]);
        registered_agent(&e, ORG);
        let i = intent(ORG, "kb.search");
        allowed_grant(&e, ORG, &i);
        assert!(e.kernel.store().verify_audit().is_ok());
        rusqlite::Connection::open(&path).unwrap().execute_batch(sql).unwrap();
        e.kernel.store().verify_audit()
    };
    assert!(mutate("edit.sqlite", "UPDATE audit SET data='{\"decision\":\"Allow\",\"x\":1}' WHERE seq=2;").is_err());
    assert!(mutate("delete.sqlite", "DELETE FROM audit WHERE seq=2;").is_err());
    assert!(mutate("reorder.sqlite", "UPDATE audit SET seq=99 WHERE seq=1; UPDATE audit SET seq=1 WHERE seq=2; UPDATE audit SET seq=2 WHERE seq=99;").is_err());
    assert!(mutate("truncate-tail-ok.sqlite", "SELECT 1;").is_ok());
}

#[test]
fn state_survives_a_restart_and_a_used_grant_stays_used() {
    let dir = std::env::temp_dir().join(format!("helix-kernel-restart-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("k.sqlite");
    let _ = std::fs::remove_file(&path);
    let i = intent(ORG, "kb.search");
    let g;
    {
        let e = env_with(KernelConfig::default(), Store::open(&path).unwrap(), SIGNER_SECRET, &[]);
        registered_agent(&e, ORG);
        g = allowed_grant(&e, ORG, &i);
        assert_eq!(state(&begin(&e, ORG, &g, &i)), ES::Permitted);
    }
    let e2 = env_with(KernelConfig::default(), Store::open(&path).unwrap(), SIGNER_SECRET, &[]);
    assert_eq!(state(&begin(&e2, ORG, &g, &i)), ES::Pending, "the restart must not hand out a second permit");
    assert!(e2.kernel.store().verify_audit().is_ok());
}

// ── GetPending ───────────────────────────────────────────────────────────────

#[test]
fn a_held_decision_can_be_read_by_its_tenant_but_not_by_agents_or_other_tenants() {
    let e = env();
    registered_agent(&e, ORG);
    e.policy.set(Decision::RequireUserConfirmation);
    let i = order(ORG);
    let held = authorize(&e, ORG, &i);
    assert_eq!(decision(&held), Decision::RequireUserConfirmation);

    let get = |ctx: Option<pb::RequestContext>, id: &str| e.kernel.get_pending(&pb::GetPendingRequest { context: ctx, pending_id: id.to_string() });

    let p = get(user(ORG), &held.pending_id).unwrap();
    assert_eq!(p.kind, "user_confirmation");
    assert_eq!(p.state, "pending");
    assert_eq!(p.intent.as_ref().unwrap().agent_id, AGENT);
    assert_eq!(p.intent.as_ref().unwrap().amount_minor, 1200);
    assert_eq!(p.reason_codes, vec!["test".to_string()]);
    assert!(get(svc(ORG), &held.pending_id).is_ok());

    // an agent cannot read what is held about it (or anyone)
    assert!(matches!(get(agent(ORG, AGENT), &held.pending_id), Err(helix_kernel::error::KernelError::Forbidden(_))));
    // another tenant cannot tell it exists
    assert!(matches!(get(user(OTHER_ORG), &held.pending_id), Err(helix_kernel::error::KernelError::NotFound)));
    assert!(matches!(get(user(ORG), "pending-nope"), Err(helix_kernel::error::KernelError::NotFound)));

    // the state follows the decision's life
    e.clock.advance(7200);
    assert_eq!(get(user(ORG), &held.pending_id).unwrap().state, "expired");
}

#[test]
fn an_answered_decision_reads_as_answered() {
    let e = env();
    registered_agent(&e, ORG);
    e.policy.set(Decision::RequireHumanReview);
    let held = authorize(&e, ORG, &order(ORG));
    assert_eq!(decision(&held), Decision::RequireHumanReview);
    let get = || e.kernel.get_pending(&pb::GetPendingRequest { context: user(ORG), pending_id: held.pending_id.clone() }).unwrap();
    assert_eq!(get().kind, "human_review");
    e.policy.set(Decision::Allow);
    e.kernel.confirm_action(&pb::ConfirmActionRequest { context: user(ORG), pending_id: held.pending_id.clone(), approve: true }).unwrap();
    assert_eq!(get().state, "approved");
}
