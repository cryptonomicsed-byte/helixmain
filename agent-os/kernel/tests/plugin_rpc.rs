//! The plugin host as the kernel exposes it: who may install, who may run what,
//! what is audited, what survives a restart, and how a plugin's proposal reaches
//! the authorize path. Real components, real signed manifests, real SQLite.
mod common;

use std::sync::Arc;

use common::*;
use helix_kernel::clock::ManualClock;
use helix_kernel::error::KernelError;
use helix_kernel::grants::GrantSigner;
use helix_kernel::kernel::{Kernel, KernelConfig};
use helix_kernel::pb::{self, Decision, PrincipalKind};
use helix_kernel::plugins::Ceilings;
use helix_kernel::store::Store;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const ORG_B: &str = "org_b";

fn dist(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/../plugins/dist/{name}.wasm", env!("CARGO_MANIFEST_DIR"))).expect("build the plugins with agent-os/plugins/build.sh")
}

fn manifest(id: &str, version: &str, component: &[u8], tools: &[&str], permissions: &[&str], expires: &str) -> Value {
    sign_doc(
        json!({
            "format": "helix-plugin/1", "id": id, "version": version,
            "component": {"sha256": hex::encode(Sha256::digest(component)), "size": component.len()},
            "tools": tools.iter().map(|t| json!({"name": t, "description": format!("tool {t}")})).collect::<Vec<_>>(),
            "permissions": permissions,
            "issuer": {"id": "issuer:helix-test-root", "kid": "root-1"},
            "issued_at": "2026-11-10T00:00:00Z", "expires_at": expires,
        }),
        &issuer_secret(),
    )
}

fn pricing_manifest(expires: &str) -> (Value, Vec<u8>) {
    let c = dist("pricing");
    (manifest("acme.pricing", "1.0.0", &c, &["quote", "checkout"], &["storage"], expires), c)
}

fn kernel_on(store: Store, clock: &ManualClock) -> Kernel {
    let mut k = Kernel::new(
        store,
        GrantSigner::from_secret_hex(SIGNER_SECRET).unwrap(),
        &[],
        trust(),
        ScriptedPolicy::new(Decision::RequireUserConfirmation),
        Arc::new(clock.clone()),
        KernelConfig::default(),
    )
    .unwrap();
    k.enable_plugins(Ceilings::default()).unwrap();
    k
}

fn register(k: &Kernel, org: &str, perms: &[&str], status: &str) {
    let c = cert(AGENT, perms, status, None);
    let r = k.verify_identity(&pb::VerifyIdentityRequest { context: svc(org), certificate_json: c.to_string(), register: true, ..Default::default() }).unwrap();
    assert!(r.registered, "{:?}", r.errors);
}

fn install(k: &Kernel, org: &str, m: &Value, c: &[u8]) -> Result<pb::InstallPluginResponse, KernelError> {
    k.install_plugin(&pb::InstallPluginRequest { context: svc(org), manifest_json: m.to_string(), component: c.to_vec() })
}

fn invoke(k: &Kernel, ctx: Option<pb::RequestContext>, plugin: &str, tool: &str, input: Value, agent: &str) -> Result<pb::InvokePluginResponse, KernelError> {
    k.invoke_plugin(&pb::InvokePluginRequest { context: ctx, plugin_id: plugin.into(), tool: tool.into(), input_json: input.to_string(), agent_id: agent.into() })
}

const BASKET: &str = r#"{"currency":"USD","items":[{"sku":"latte","qty":3,"unit_price_minor":450}]}"#;

fn basket() -> Value {
    serde_json::from_str(BASKET).unwrap()
}

#[test]
fn only_a_service_installs_and_a_refused_install_is_recorded() {
    let clock = ManualClock::at(NOW);
    let k = kernel_on(Store::in_memory().unwrap(), &clock);
    let (m, c) = pricing_manifest("2027-11-10T00:00:00Z");
    for ctx in [agent(ORG, AGENT), user(ORG), None] {
        let r = k.install_plugin(&pb::InstallPluginRequest { context: ctx, manifest_json: m.to_string(), component: c.clone() });
        assert!(matches!(r, Err(KernelError::Forbidden(_)) | Err(KernelError::Invalid(_))), "{r:?}");
    }
    assert!(k.list_plugins(&pb::ListPluginsRequest { context: user(ORG) }).unwrap().plugins.is_empty());

    // refused: a normal answer with reasons, and an audit entry
    let mut bad = m.clone();
    bad["version"] = json!("9.9.9");
    let r = install(&k, ORG, &bad, &c).unwrap();
    assert!(!r.installed && r.problems.iter().any(|p| p.contains("hash does not match")), "{r:?}");
    assert!(k.store().audit_entries(Some(ORG)).unwrap().iter().any(|e| e.kind == "plugin.install_refused"));
    assert!(k.list_plugins(&pb::ListPluginsRequest { context: user(ORG) }).unwrap().plugins.is_empty());

    let ok = install(&k, ORG, &m, &c).unwrap();
    assert!(ok.installed && !ok.replaced);
    assert_eq!(ok.plugin.as_ref().unwrap().tools.len(), 2);
    let listed = k.list_plugins(&pb::ListPluginsRequest { context: agent(ORG, AGENT) }).unwrap();
    assert_eq!(listed.plugins[0].id, "acme.pricing");
    assert!(k.list_plugins(&pb::ListPluginsRequest { context: user(ORG_B) }).unwrap().plugins.is_empty(), "another tenant sees nothing");
}

#[test]
fn running_a_tool_needs_a_live_agent_that_declared_it() {
    let clock = ManualClock::at(NOW);
    let k = kernel_on(Store::in_memory().unwrap(), &clock);
    let (m, c) = pricing_manifest("2027-11-10T00:00:00Z");
    install(&k, ORG, &m, &c).unwrap();

    // not registered at all
    assert!(matches!(invoke(&k, agent(ORG, AGENT), "acme.pricing", "quote", basket(), ""), Err(KernelError::Forbidden(_))));

    register(&k, ORG, &["plugin.acme.pricing.quote"], "live");
    let r = invoke(&k, agent(ORG, AGENT), "acme.pricing", "quote", basket(), "").unwrap();
    assert_eq!(r.status, "ok", "{r:?}");
    assert!(r.result_json.contains("\"total_minor\":1350") || r.result_json.contains("\"total_minor\": 1350"), "{}", r.result_json);
    assert!(r.fuel_used > 0 && !r.plugin_hash.is_empty());

    // declared quote, not checkout
    assert!(matches!(invoke(&k, agent(ORG, AGENT), "acme.pricing", "checkout", basket(), ""), Err(KernelError::Forbidden(m)) if m.contains("does not declare")));
    // an agent cannot run a tool as someone else
    assert!(matches!(invoke(&k, agent(ORG, AGENT), "acme.pricing", "quote", basket(), "sid_someone-else"), Err(KernelError::Forbidden(_))));
    // a person cannot run one at all
    assert!(matches!(invoke(&k, user(ORG), "acme.pricing", "quote", basket(), AGENT), Err(KernelError::Forbidden(_))));
    // a service can, for a named agent
    assert_eq!(invoke(&k, svc(ORG), "acme.pricing", "quote", basket(), AGENT).unwrap().status, "ok");
    assert!(matches!(invoke(&k, svc(ORG), "acme.pricing", "quote", basket(), ""), Err(KernelError::Invalid(_))));
    // not found, wrong tenant, bad tool, bad input
    assert!(matches!(invoke(&k, agent(ORG, AGENT), "nope", "quote", basket(), ""), Err(KernelError::NotFound) | Err(KernelError::Forbidden(_))));
    assert!(matches!(invoke(&k, agent(ORG_B, AGENT), "acme.pricing", "quote", basket(), ""), Err(KernelError::Forbidden(_))));
}

#[test]
fn suspending_an_agent_stops_its_tools_at_once() {
    let clock = ManualClock::at(NOW);
    let k = kernel_on(Store::in_memory().unwrap(), &clock);
    let (m, c) = pricing_manifest("2027-11-10T00:00:00Z");
    install(&k, ORG, &m, &c).unwrap();
    let live = cert(AGENT, &["plugin.acme.pricing.quote"], "live", None);
    k.verify_identity(&pb::VerifyIdentityRequest { context: svc(ORG), certificate_json: live.to_string(), register: true, ..Default::default() }).unwrap();
    assert_eq!(invoke(&k, agent(ORG, AGENT), "acme.pricing", "quote", basket(), "").unwrap().status, "ok");
    let suspended = cert(AGENT, &["plugin.acme.pricing.quote"], "suspended", Some(&live));
    k.verify_identity(&pb::VerifyIdentityRequest { context: svc(ORG), certificate_json: suspended.to_string(), register: true, ..Default::default() }).unwrap();
    assert!(matches!(invoke(&k, agent(ORG, AGENT), "acme.pricing", "quote", basket(), ""), Err(KernelError::Forbidden(_))));
}

#[test]
fn a_proposal_from_a_plugin_goes_through_authorize_like_any_other_intent() {
    let clock = ManualClock::at(NOW);
    let k = kernel_on(Store::in_memory().unwrap(), &clock);
    let (m, c) = pricing_manifest("2027-11-10T00:00:00Z");
    install(&k, ORG, &m, &c).unwrap();
    register(&k, ORG, &["plugin.acme.pricing.checkout", "merchant.order"], "live");

    let r = invoke(&k, agent(ORG, AGENT), "acme.pricing", "checkout", basket(), "").unwrap();
    assert_eq!(r.status, "ok", "{r:?}");
    assert_eq!(r.proposed_intents_json.len(), 1);
    let p: Value = serde_json::from_str(&r.proposed_intents_json[0]).unwrap();
    assert_eq!((p["organization_id"].as_str(), p["agent_id"].as_str()), (Some(ORG), Some(AGENT)));

    // Nothing has happened yet. Turning the proposal into an ActionIntent and authorizing it is what the caller does.
    let intent = pb::ActionIntent {
        id: p["id"].as_str().unwrap().into(), organization_id: ORG.into(), agent_id: AGENT.into(), task_id: "t".into(),
        capability: p["capability"].as_str().unwrap().into(), tool: p["tool"].as_str().unwrap().into(), target: p["target"].as_str().unwrap().into(),
        operation: p["operation"].as_str().unwrap().into(), risk: pb::Risk::Medium as i32, arguments_json: p["arguments"].to_string(),
        amount_minor: p["amount_minor"].as_i64().unwrap(), currency: p["currency"].as_str().unwrap().into(),
        idempotency_key: p["idempotency_key"].as_str().unwrap().into(), audience: EXECUTOR.into(),
    };
    let a = k.authorize_action(&pb::AuthorizeActionRequest { context: agent(ORG, AGENT), intent: Some(intent) }).unwrap();
    assert_eq!(a.decision, Decision::RequireUserConfirmation as i32, "money moved by a plugin's proposal still needs a person: {a:?}");
    assert!(a.grant.is_none());
}

#[test]
fn invocations_are_audited_as_hashes_never_content() {
    let clock = ManualClock::at(NOW);
    let k = kernel_on(Store::in_memory().unwrap(), &clock);
    let (m, c) = pricing_manifest("2027-11-10T00:00:00Z");
    install(&k, ORG, &m, &c).unwrap();
    register(&k, ORG, &["plugin.acme.pricing.quote"], "live");
    invoke(&k, agent(ORG, AGENT), "acme.pricing", "quote", basket(), "").unwrap();
    let _ = invoke(&k, agent(ORG, AGENT), "acme.pricing", "checkout", basket(), ""); // refused: not declared

    let entries = k.store().audit_entries(Some(ORG)).unwrap();
    let kinds: Vec<&str> = entries.iter().map(|e| e.kind.as_str()).collect();
    assert!(kinds.contains(&"plugin.installed") && kinds.contains(&"plugin.invoked") && kinds.contains(&"plugin.refused"), "{kinds:?}");
    let inv = entries.iter().find(|e| e.kind == "plugin.invoked").unwrap();
    assert_eq!(inv.data["status"], "ok");
    assert_eq!(inv.data["input_sha256"].as_str().unwrap().len(), 64);
    assert!(!inv.data.to_string().contains("latte"), "the audit chain must not carry what the agent asked about: {}", inv.data);
    let (n, _) = k.store().verify_audit().unwrap();
    assert!(n >= 4, "the chain still verifies");
}

#[test]
fn plugins_and_their_storage_survive_a_restart_and_are_verified_again() {
    let dir = std::env::temp_dir().join(format!("helix-plugin-rpc-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("kernel.sqlite");
    let _ = std::fs::remove_file(&db);
    let clock = ManualClock::at(NOW);
    {
        let k = kernel_on(Store::open(&db).unwrap(), &clock);
        let (m, c) = pricing_manifest("2027-11-10T00:00:00Z");
        install(&k, ORG, &m, &c).unwrap();
        register(&k, ORG, &["plugin.acme.pricing.checkout"], "live");
        assert_eq!(invoke(&k, agent(ORG, AGENT), "acme.pricing", "checkout", basket(), "").unwrap().status, "ok");
        assert_eq!(k.store().kv_get(ORG, "acme.pricing", "last_total").unwrap().as_deref(), Some("1350"));
    }
    // a new process: the plugin comes back, still verified, with its state
    {
        let mut k = Kernel::new(Store::open(&db).unwrap(), GrantSigner::from_secret_hex(SIGNER_SECRET).unwrap(), &[], trust(),
            ScriptedPolicy::new(Decision::Allow), Arc::new(clock.clone()), KernelConfig::default()).unwrap();
        assert_eq!(k.enable_plugins(Ceilings::default()).unwrap(), 1);
        assert_eq!(k.list_plugins(&pb::ListPluginsRequest { context: user(ORG) }).unwrap().plugins.len(), 1);
        assert_eq!(invoke(&k, agent(ORG, AGENT), "acme.pricing", "checkout", basket(), "").unwrap().status, "ok");
    }
    // and when its manifest has expired by the time the kernel comes back, it does NOT come back
    clock.advance(400 * 24 * 3600);
    {
        let mut k = Kernel::new(Store::open(&db).unwrap(), GrantSigner::from_secret_hex(SIGNER_SECRET).unwrap(), &[], trust(),
            ScriptedPolicy::new(Decision::Allow), Arc::new(clock.clone()), KernelConfig::default()).unwrap();
        assert_eq!(k.enable_plugins(Ceilings::default()).unwrap(), 0);
        assert!(k.list_plugins(&pb::ListPluginsRequest { context: user(ORG) }).unwrap().plugins.is_empty());
        let failed: Vec<_> = k.store().audit_entries(Some(ORG)).unwrap().into_iter().filter(|e| e.kind == "plugin.load_failed").collect();
        assert_eq!(failed.len(), 1, "an expired plugin is reported, not silently dropped");
        assert!(failed[0].data.to_string().contains("expired"));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn removing_a_plugin_removes_its_state_and_each_tenant_has_its_own() {
    let clock = ManualClock::at(NOW);
    let k = kernel_on(Store::in_memory().unwrap(), &clock);
    let (m, c) = pricing_manifest("2027-11-10T00:00:00Z");
    install(&k, ORG, &m, &c).unwrap();
    install(&k, ORG_B, &m, &c).unwrap();
    register(&k, ORG, &["plugin.acme.pricing.checkout"], "live");
    invoke(&k, agent(ORG, AGENT), "acme.pricing", "checkout", basket(), "").unwrap();
    assert!(k.store().kv_get(ORG, "acme.pricing", "last_total").unwrap().is_some());
    assert!(k.store().kv_get(ORG_B, "acme.pricing", "last_total").unwrap().is_none(), "org_b's plugin has its own storage");

    assert!(matches!(k.remove_plugin(&pb::RemovePluginRequest { context: user(ORG), plugin_id: "acme.pricing".into() }), Err(KernelError::Forbidden(_))));
    assert!(k.remove_plugin(&pb::RemovePluginRequest { context: svc(ORG), plugin_id: "acme.pricing".into() }).unwrap().removed);
    assert!(k.store().kv_get(ORG, "acme.pricing", "last_total").unwrap().is_none());
    assert!(k.list_plugins(&pb::ListPluginsRequest { context: user(ORG) }).unwrap().plugins.is_empty());
    assert_eq!(k.list_plugins(&pb::ListPluginsRequest { context: user(ORG_B) }).unwrap().plugins.len(), 1, "the other tenant is untouched");
}

#[test]
fn a_kernel_without_the_host_says_so() {
    let k = Kernel::new(Store::in_memory().unwrap(), GrantSigner::from_secret_hex(SIGNER_SECRET).unwrap(), &[], trust(),
        ScriptedPolicy::new(Decision::Allow), Arc::new(ManualClock::at(NOW)), KernelConfig::default()).unwrap();
    assert!(matches!(k.list_plugins(&pb::ListPluginsRequest { context: user(ORG) }), Err(KernelError::Precondition(_))));
}

#[tokio::test]
async fn the_plugin_rpcs_work_over_grpc() {
    use helix_kernel::pb::kernel_client::KernelClient;
    use helix_kernel::service::KernelService;
    use tonic::transport::Server;

    let clock = ManualClock::at(NOW);
    let k = Arc::new(kernel_on(Store::in_memory().unwrap(), &clock));
    register(&k, ORG, &["plugin.acme.pricing.quote"], "live");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let service = KernelService::new(k).into_server();
    tokio::spawn(async move {
        Server::builder().add_service(service).serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener)).await.unwrap();
    });
    let mut c = KernelClient::connect(format!("http://{addr}")).await.unwrap();

    let (m, comp) = pricing_manifest("2027-11-10T00:00:00Z");
    let installed = c.install_plugin(pb::InstallPluginRequest { context: svc(ORG), manifest_json: m.to_string(), component: comp.clone() }).await.unwrap().into_inner();
    assert!(installed.installed, "{installed:?}");
    let denied = c.install_plugin(pb::InstallPluginRequest { context: agent(ORG, AGENT), manifest_json: m.to_string(), component: comp }).await.unwrap_err();
    assert_eq!(denied.code(), tonic::Code::PermissionDenied);

    let ran = c.invoke_plugin(pb::InvokePluginRequest { context: agent(ORG, AGENT), plugin_id: "acme.pricing".into(), tool: "quote".into(), input_json: BASKET.into(), agent_id: String::new() })
        .await.unwrap().into_inner();
    assert_eq!(ran.status, "ok", "{ran:?}");
    let missing = c.invoke_plugin(pb::InvokePluginRequest { context: agent(ORG, AGENT), plugin_id: "nope".into(), tool: "quote".into(), input_json: "{}".into(), agent_id: String::new() })
        .await.unwrap_err();
    assert!(matches!(missing.code(), tonic::Code::NotFound | tonic::Code::PermissionDenied));
    // a large component crosses the wire (it is then refused on its merits, not by the transport)
    let big = vec![0u8; 5 << 20];
    let big_manifest = manifest("big.one", "1.0.0", &big, &["t"], &[], "2027-11-10T00:00:00Z");
    let r = c.install_plugin(pb::InstallPluginRequest { context: svc(ORG), manifest_json: big_manifest.to_string(), component: big }).await.unwrap().into_inner();
    assert!(!r.installed && r.problems.iter().any(|p| p.contains("not a valid WebAssembly component")), "{r:?}");
    let _ = PrincipalKind::User;
}
