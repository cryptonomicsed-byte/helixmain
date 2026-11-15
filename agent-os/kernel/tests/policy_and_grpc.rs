//! The policy client against a real HTTP server, and the kernel over real gRPC
//! including mutual TLS.

mod common;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::time::Duration;

use common::*;
use helix_kernel::pb::{self, kernel_client::KernelClient, Decision, ExecutionState as ES};
use helix_kernel::policy::{HttpPolicy, PolicyClient};
use helix_kernel::service::KernelService;
use serde_json::json;
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Identity, Server, ServerTlsConfig};

/// A one-route HTTP server that answers every request with `body` after `delay`.
fn http_server(status: u16, body: &'static str, delay: Duration) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let mut stream = stream;
                let mut buf = [0u8; 8192];
                let mut seen = Vec::new();
                loop {
                    let n = stream.read(&mut buf).unwrap_or(0);
                    if n == 0 { break; }
                    seen.extend_from_slice(&buf[..n]);
                    if let Some(end) = seen.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&seen[..end]).to_lowercase();
                        let want = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(0);
                        if seen.len() >= end + 4 + want { break; }
                    }
                }
                std::thread::sleep(delay);
                let _ = write!(stream, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            });
        }
    });
    url
}

fn decide(base: &str) -> Result<helix_kernel::policy::PolicyAnswer, String> {
    HttpPolicy::new(base, Duration::from_millis(400)).decide(&json!({"format": "helix-policy-request/1"}))
}

#[test]
fn a_well_formed_policy_answer_is_understood() {
    let url = http_server(200, r#"{"decision":"require_human_review","matched_rule":"r7","reason_codes":["big_spend"],"reason":"over limit","policy_version":"2026-11-15.1"}"#, Duration::ZERO);
    let a = decide(&url).unwrap();
    assert_eq!(a.decision, Decision::RequireHumanReview);
    assert_eq!((a.matched_rule.as_str(), a.policy_version.as_str()), ("r7", "2026-11-15.1"));
    assert_eq!(a.reason_codes, ["big_spend"]);
}

#[test]
fn every_way_a_policy_service_can_fail_is_an_error_the_kernel_turns_into_deny() {
    // nothing listening
    assert!(decide("http://127.0.0.1:1").is_err());
    // an error status
    assert!(decide(&http_server(500, r#"{"decision":"allow"}"#, Duration::ZERO)).is_err());
    // not JSON
    assert!(decide(&http_server(200, "<html>oops</html>", Duration::ZERO)).is_err());
    // JSON without a decision, or with one the kernel does not know
    assert!(decide(&http_server(200, "{}", Duration::ZERO)).is_err());
    assert!(decide(&http_server(200, r#"{"decision":"maybe"}"#, Duration::ZERO)).is_err());
    assert!(decide(&http_server(200, r#"{"decision":"ALLOW"}"#, Duration::ZERO)).is_err(), "decisions are exact, lowercase");
    assert!(decide(&http_server(200, r#"{"decision":true}"#, Duration::ZERO)).is_err());
    // too slow
    assert!(decide(&http_server(200, r#"{"decision":"allow"}"#, Duration::from_secs(2))).is_err());
}

#[test]
fn the_kernel_denies_when_the_real_policy_service_misbehaves() {
    use helix_kernel::clock::ManualClock;
    use helix_kernel::grants::GrantSigner;
    use helix_kernel::kernel::{Kernel, KernelConfig};
    use helix_kernel::store::Store;
    // nothing listening, and an answer that arrives after the kernel's deadline
    for url in ["http://127.0.0.1:1".to_string(), http_server(200, r#"{"decision":"allow"}"#, Duration::from_secs(2))] {
        let k = Kernel::new(Store::in_memory().unwrap(), GrantSigner::from_secret_hex(SIGNER_SECRET).unwrap(), &[], trust(),
            Arc::new(HttpPolicy::new(&url, Duration::from_millis(300))), Arc::new(ManualClock::at(NOW)), KernelConfig::default()).unwrap();
        let cert = cert(AGENT, &["kb.search"], "live", None);
        k.verify_identity(&pb::VerifyIdentityRequest { context: svc(ORG), certificate_json: cert.to_string(), register: true, ..Default::default() }).unwrap();
        let r = k.authorize_action(&pb::AuthorizeActionRequest { context: agent(ORG, AGENT), intent: Some(intent(ORG, "kb.search")) }).unwrap();
        assert_eq!(decision(&r), Decision::Deny, "against {url}");
        assert!(r.grant.is_none());
    }
}

// ── gRPC ─────────────────────────────────────────────────────────────────────

async fn serve_plain(e: &Env) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let service = KernelService::new(e.kernel.clone()).into_server();
    tokio::spawn(async move {
        Server::builder().add_service(service).serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener)).await.unwrap();
    });
    format!("http://{addr}")
}

#[tokio::test]
async fn a_full_purchase_over_grpc() {
    let e = env();
    let url = serve_plain(&e).await;
    let mut c = KernelClient::connect(url).await.unwrap();

    let cert = cert(AGENT, &["merchant.order"], "live", None);
    let reg = c.verify_identity(pb::VerifyIdentityRequest { context: svc(ORG), certificate_json: cert.to_string(), register: true, ..Default::default() }).await.unwrap().into_inner();
    assert!(reg.registered && reg.trusted);

    let i = order(ORG);
    let pending = c.authorize_action(pb::AuthorizeActionRequest { context: agent(ORG, AGENT), intent: Some(i.clone()) }).await.unwrap().into_inner();
    assert_eq!(pending.decision, Decision::RequireUserConfirmation as i32);

    // an agent confirming its own purchase is refused at the boundary
    let own = c.confirm_action(pb::ConfirmActionRequest { context: agent(ORG, AGENT), pending_id: pending.pending_id.clone(), approve: true }).await.unwrap_err();
    assert_eq!(own.code(), tonic::Code::PermissionDenied);

    let yes = c.confirm_action(pb::ConfirmActionRequest { context: user(ORG), pending_id: pending.pending_id, approve: true }).await.unwrap().into_inner();
    let grant = yes.grant.unwrap();
    let begun = c.begin_execution(pb::BeginExecutionRequest { context: svc(ORG), grant: Some(grant.clone()), intent: Some(i.clone()) }).await.unwrap().into_inner();
    assert_eq!(begun.state, ES::Permitted as i32);
    let again = c.begin_execution(pb::BeginExecutionRequest { context: svc(ORG), grant: Some(grant), intent: Some(i) }).await.unwrap().into_inner();
    assert_eq!(again.state, ES::Pending as i32);
    let done = c.record_result(pb::RecordResultRequest { context: svc(ORG), execution_id: begun.execution_id, state: ES::Succeeded as i32, result_json: r#"{"order":"o_9","status":"confirmed"}"#.into() }).await.unwrap().into_inner();
    assert!(!done.receipt_hash.is_empty());

    let health = c.health(pb::HealthRequest {}).await.unwrap().into_inner();
    assert_eq!(health.status, "ok");
    assert!(health.audit_entries >= 6);
}

#[tokio::test]
async fn grpc_error_codes_do_not_leak_internals() {
    let e = env();
    let url = serve_plain(&e).await;
    let mut c = KernelClient::connect(url).await.unwrap();
    let no_ctx = c.authorize_action(pb::AuthorizeActionRequest { context: None, intent: Some(intent(ORG, "kb.search")) }).await.unwrap_err();
    assert_eq!(no_ctx.code(), tonic::Code::PermissionDenied);
    let bad = c.authorize_action(pb::AuthorizeActionRequest { context: agent(ORG, AGENT), intent: None }).await.unwrap_err();
    assert_eq!(bad.code(), tonic::Code::InvalidArgument);
    let missing = c.record_result(pb::RecordResultRequest { context: svc(ORG), execution_id: "exec_nope".into(), state: ES::Succeeded as i32, result_json: "{}".into() }).await.unwrap_err();
    assert_eq!(missing.code(), tonic::Code::NotFound);
}

struct Pki {
    ca_pem: String,
    server: (String, String),
    client: (String, String),
}

fn pki(ca_name: &str) -> Pki {
    use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, KeyPair};
    let ca_key = KeyPair::generate().unwrap();
    let mut ca_params = CertificateParams::new(vec![]).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.distinguished_name.push(DnType::CommonName, ca_name);
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let leaf = |name: &str| {
        let key = KeyPair::generate().unwrap();
        let cert = CertificateParams::new(vec![name.to_string()]).unwrap().signed_by(&key, &ca, &ca_key).unwrap();
        (cert.pem(), key.serialize_pem())
    };
    Pki { ca_pem: ca.pem(), server: leaf("localhost"), client: leaf("gateway") }
}

async fn serve_tls(e: &Env, server_pki: &Pki) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let tls = ServerTlsConfig::new()
        .identity(Identity::from_pem(&server_pki.server.0, &server_pki.server.1))
        .client_ca_root(Certificate::from_pem(&server_pki.ca_pem));
    let service = KernelService::new(e.kernel.clone()).into_server();
    tokio::spawn(async move {
        Server::builder().tls_config(tls).unwrap().add_service(service)
            .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener)).await.unwrap();
    });
    port
}

async fn tls_client(port: u16, trust_ca: &str, identity: Option<(&str, &str)>) -> Result<Channel, tonic::transport::Error> {
    let mut tls = ClientTlsConfig::new().ca_certificate(Certificate::from_pem(trust_ca)).domain_name("localhost");
    if let Some((cert, key)) = identity {
        tls = tls.identity(Identity::from_pem(cert, key));
    }
    Channel::from_shared(format!("https://localhost:{port}")).unwrap().tls_config(tls).unwrap()
        .connect_timeout(Duration::from_secs(5)).connect().await
}

#[tokio::test]
async fn the_kernel_serves_only_clients_that_present_a_certificate_from_the_trusted_ca() {
    let server_pki = pki("kernel-test-ca");
    let e = env();
    let port = serve_tls(&e, &server_pki).await;

    // a client with a certificate from the right CA gets through
    let ok = tls_client(port, &server_pki.ca_pem, Some((&server_pki.client.0, &server_pki.client.1))).await.unwrap();
    assert_eq!(KernelClient::new(ok).health(pb::HealthRequest {}).await.unwrap().into_inner().status, "ok");

    // no client certificate
    let anon = tls_client(port, &server_pki.ca_pem, None).await;
    let denied = match anon {
        Err(_) => true,
        Ok(ch) => KernelClient::new(ch).health(pb::HealthRequest {}).await.is_err(),
    };
    assert!(denied, "a client without a certificate was served");

    // a certificate from a different CA
    let intruder = pki("someone-elses-ca");
    let wrong = tls_client(port, &server_pki.ca_pem, Some((&intruder.client.0, &intruder.client.1))).await;
    let denied = match wrong {
        Err(_) => true,
        Ok(ch) => KernelClient::new(ch).health(pb::HealthRequest {}).await.is_err(),
    };
    assert!(denied, "a client certificate from an untrusted CA was served");
}
