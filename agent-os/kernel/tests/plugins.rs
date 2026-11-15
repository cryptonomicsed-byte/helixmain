//! The Wasm plugin host, against REAL compiled components (agent-os/plugins/dist),
//! signed manifests, and the real Wasmtime sandbox. Nothing here is mocked.
mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use helix_kernel::clock::ManualClock;
use helix_kernel::plugins::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const ORG_B: &str = "org_b";

fn dist(name: &str) -> Vec<u8> {
    let p = format!("{}/../plugins/dist/{name}.wasm", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("{p}: {e}; build the plugins with agent-os/plugins/build.sh"))
}

fn sha(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

const PRICING_TOOLS: &[(&str, &str)] = &[("quote", "Price a basket"), ("checkout", "Quote a basket and propose the order")];

fn conformance_tools() -> Vec<(String, String)> {
    // the tool list is whatever the component says it has; the manifest must match it
    let names = [
        "echo", "spin", "alloc", "recurse", "panic", "big_output", "many_intents", "read_file", "env", "time", "kv_roundtrip", "kv_big", "kv_fill",
        "kv_write_then_panic", "kv_read", "log_flood", "forge_intent", "forge_agent", "intent_not_json", "bad_result", "sleep", "stdout_flood", "random", "counter",
    ];
    names.iter().map(|n| (n.to_string(), format!("conformance tool {n}"))).collect()
}

struct M<'a> {
    id: &'a str,
    version: &'a str,
    component: &'a [u8],
    tools: Vec<(String, String)>,
    permissions: Vec<&'a str>,
    limits: Value,
    issued: &'a str,
    expires: &'a str,
}

impl<'a> M<'a> {
    fn new(id: &'a str, component: &'a [u8], tools: Vec<(String, String)>) -> Self {
        Self { id, version: "1.0.0", component, tools, permissions: vec![], limits: json!({}), issued: "2026-11-10T00:00:00Z", expires: "2027-11-10T00:00:00Z" }
    }
    fn doc(&self) -> Value {
        let mut d = json!({
            "format": "helix-plugin/1", "id": self.id, "version": self.version,
            "component": {"sha256": sha(self.component), "size": self.component.len()},
            "tools": self.tools.iter().map(|(n, d)| json!({"name": n, "description": d})).collect::<Vec<_>>(),
            "permissions": self.permissions,
            "issuer": {"id": "issuer:helix-test-root", "kid": "root-1"},
            "issued_at": self.issued, "expires_at": self.expires,
        });
        if self.limits.as_object().map_or(false, |l| !l.is_empty()) {
            d["limits"] = self.limits.clone();
        }
        d
    }
    fn signed(&self) -> Value {
        sign_doc(self.doc(), &issuer_secret())
    }
}

struct Env {
    host: PluginHost,
    storage: Arc<MemoryStorage>,
    clock: ManualClock,
}

fn env_with(ceilings: Ceilings) -> Env {
    let storage = Arc::new(MemoryStorage::default());
    let clock = ManualClock::at(NOW);
    let host = PluginHost::new(storage.clone(), trust(), Arc::new(clock.clone()), ceilings).unwrap();
    Env { host, storage, clock }
}

fn env() -> Env {
    env_with(Ceilings::default())
}

impl Env {
    fn install(&self, org: &str, m: &Value, comp: &[u8]) -> Result<InstalledSummary, PluginError> {
        self.host.install(org, &m.to_string(), comp)
    }
    fn conformance(&self, org: &str, permissions: Vec<&str>, limits: Value) {
        let comp = dist("conformance");
        let mut m = M::new("test.conformance", &comp, conformance_tools());
        m.permissions = permissions;
        m.limits = limits;
        self.install(org, &m.signed(), &comp).unwrap_or_else(|e| panic!("install: {e:?}"));
    }
    fn call(&self, plugin: &str, tool: &str, input: Value) -> Invocation {
        self.host.invoke(ORG, AGENT, plugin, tool, &input.to_string()).unwrap_or_else(|e| panic!("invoke {tool}: {e:?}"))
    }
    fn run(&self, tool: &str, input: Value) -> Invocation {
        self.call("test.conformance", tool, input)
    }
}

fn refused(r: Result<InstalledSummary, PluginError>) -> String {
    match r {
        Err(PluginError::Refused(p)) => p.join(" | "),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

// ── a real plugin does real work ─────────────────────────────────────────────

fn install_pricing(e: &Env, org: &str) {
    let comp = dist("pricing");
    let mut m = M::new("acme.pricing", &comp, PRICING_TOOLS.iter().map(|(n, d)| (n.to_string(), d.to_string())).collect());
    m.permissions = vec!["storage"];
    e.install(org, &m.signed(), &comp).unwrap_or_else(|e| panic!("{e:?}"));
}

#[test]
fn a_signed_component_installs_and_prices_a_basket() {
    let e = env();
    install_pricing(&e, ORG);
    let list = e.host.list(ORG);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, "acme.pricing");
    assert_eq!(list[0].component_sha256, sha(&dist("pricing")));
    assert_eq!(list[0].permissions, vec!["storage".to_string()]);

    let r = e.call("acme.pricing", "quote", json!({"currency": "USD", "items": [
        {"sku": "latte", "qty": 2, "unit_price_minor": 450},
        {"sku": "beans", "qty": 10, "unit_price_minor": 1200},
        {"sku": "mug", "qty": 50, "unit_price_minor": 800}]}));
    assert_eq!(r.status, Status::Ok, "{r:?}");
    let q: Value = serde_json::from_str(&r.result_json).unwrap();
    // latte 900, beans 12000 (5% = 600), mug 40000 (10% = 4000)
    assert_eq!(q["subtotal_minor"], 52900);
    assert_eq!(q["discount_minor"], 4600);
    assert_eq!(q["total_minor"], 48300);
    assert!(r.proposed_intents.is_empty());
    assert!(r.fuel_used > 0 && r.logs.iter().any(|l| l.contains("quoted")), "{r:?}");
}

#[test]
fn a_tool_that_proposes_an_order_cannot_place_it() {
    let e = env();
    install_pricing(&e, ORG);
    let r = e.call("acme.pricing", "checkout", json!({"currency": "USD", "items": [{"sku": "latte", "qty": 3, "unit_price_minor": 450}]}));
    assert_eq!(r.status, Status::Ok, "{r:?}");
    assert_eq!(r.proposed_intents.len(), 1);
    let i = &r.proposed_intents[0];
    // the host pins the tenant and the invoking agent, and fills the ids the kernel needs
    assert_eq!(i["organization_id"], ORG);
    assert_eq!(i["agent_id"], AGENT);
    assert_eq!(i["capability"], "merchant.order");
    assert_eq!(i["amount_minor"], 1350);
    assert_eq!(i["currency"], "USD");
    assert!(i["id"].as_str().unwrap().starts_with("plint_"));
    assert!(i["idempotency_key"].as_str().unwrap().starts_with("plkey_"));
    // it is only a proposal: it still has to be authorized, and money still needs a person
    assert_eq!(e.storage.get(ORG, "acme.pricing", "last_total").unwrap().as_deref(), Some("1350"), "storage writes commit on success");
}

#[test]
fn a_tool_error_is_the_tools_own_answer() {
    let e = env();
    install_pricing(&e, ORG);
    let r = e.call("acme.pricing", "quote", json!({"currency": "usd", "items": []}));
    assert_eq!(r.status, Status::ToolError);
    assert!(r.error.contains("currency"), "{}", r.error);
    assert!(r.result_json.is_empty() && r.proposed_intents.is_empty());
}

// ── installing: only what was signed ─────────────────────────────────────────

#[test]
fn only_a_correctly_signed_manifest_for_exactly_this_component_installs() {
    let e = env();
    let comp = dist("pricing");
    let tools: Vec<(String, String)> = PRICING_TOOLS.iter().map(|(n, d)| (n.to_string(), d.to_string())).collect();
    let good = M::new("acme.pricing", &comp, tools.clone());

    // the signature
    let mut unsigned = good.doc();
    assert!(refused(e.install(ORG, &unsigned, &comp)).contains("hash does not match"));
    unsigned["hash"] = json!(helix_kernel::identity::sid_hash(&unsigned));
    assert!(refused(e.install(ORG, &unsigned, &comp)).contains("proof must be"));
    let mut tampered = good.signed();
    tampered["version"] = json!("9.9.9");
    assert!(refused(e.install(ORG, &tampered, &comp)).contains("hash does not match"));
    let mut rehashed = tampered.clone();
    rehashed["hash"] = json!(helix_kernel::identity::sid_hash(&rehashed));
    assert!(refused(e.install(ORG, &rehashed, &comp)).contains("issuer signature does not verify"));
    let attacker = fixture("test-keys.json")["keys"]["attacker"]["secret"].as_str().unwrap().to_string();
    assert!(refused(e.install(ORG, &sign_doc(good.doc(), &attacker), &comp)).contains("issuer signature does not verify"));
    let mut stranger = good.doc();
    stranger["issuer"] = json!({"id": "issuer:nobody", "kid": "x"});
    assert!(refused(e.install(ORG, &sign_doc(stranger, &issuer_secret()), &comp)).contains("not trusted"));

    // the component
    let other = dist("conformance");
    assert!(refused(e.install(ORG, &good.signed(), &other)).contains("not the one the manifest names"));
    let mut padded = comp.clone();
    padded.push(0);
    assert!(refused(e.install(ORG, &good.signed(), &padded)).contains("not the one the manifest names"));

    // the window
    let mut expired = M::new("acme.pricing", &comp, tools.clone());
    expired.expires = "2026-11-19T00:00:00Z";
    assert!(refused(e.install(ORG, &expired.signed(), &comp)).contains("expired"));
    let mut early = M::new("acme.pricing", &comp, tools.clone());
    early.issued = "2026-12-01T00:00:00Z";
    early.expires = "2027-01-01T00:00:00Z";
    assert!(refused(e.install(ORG, &early.signed(), &comp)).contains("not valid yet"));

    // nothing was installed by any of that
    assert!(e.host.list(ORG).is_empty());
    assert!(e.install(ORG, &good.signed(), &comp).is_ok());
}

#[test]
fn the_manifest_is_strict() {
    let e = env();
    let comp = dist("pricing");
    let tools: Vec<(String, String)> = PRICING_TOOLS.iter().map(|(n, d)| (n.to_string(), d.to_string())).collect();
    let signed = |f: &dyn Fn(&mut Value)| {
        let mut d = M::new("acme.pricing", &comp, tools.clone()).doc();
        f(&mut d);
        sign_doc(d, &issuer_secret())
    };
    for (name, why, edit) in [
        ("an extra field", "unknown field", Box::new(|d: &mut Value| d["backdoor"] = json!(true)) as Box<dyn Fn(&mut Value)>),
        ("a bad id", "id must be", Box::new(|d: &mut Value| d["id"] = json!("Acme Pricing!"))),
        ("a bad version", "MAJOR.MINOR.PATCH", Box::new(|d: &mut Value| d["version"] = json!("1.0"))),
        ("a leading zero version", "MAJOR.MINOR.PATCH", Box::new(|d: &mut Value| d["version"] = json!("01.0.0"))),
        ("an unknown permission", "unknown permission", Box::new(|d: &mut Value| d["permissions"] = json!(["network"]))),
        ("a limit above the host's ceiling", "ceiling", Box::new(|d: &mut Value| d["limits"] = json!({"fuel": 4_000_000_000u64}))),
        ("a zero limit", "limits.timeout_ms", Box::new(|d: &mut Value| d["limits"] = json!({"timeout_ms": 0}))),
        ("an unknown limit", "unknown limit", Box::new(|d: &mut Value| d["limits"] = json!({"threads": 8}))),
        ("no tools", "tools must list", Box::new(|d: &mut Value| d["tools"] = json!([]))),
        ("a duplicate tool", "is not valid", Box::new(|d: &mut Value| d["tools"] = json!([{"name": "quote", "description": ""}, {"name": "quote", "description": ""}]))),
        ("a tool with a dotted name", "is not valid", Box::new(|d: &mut Value| d["tools"] = json!([{"name": "a.b", "description": ""}]))),
        ("a component with extra keys", "component must be", Box::new(|d: &mut Value| d["component"]["url"] = json!("https://evil.example/x.wasm"))),
        ("the wrong format", "format must be", Box::new(|d: &mut Value| d["format"] = json!("helix-plugin/2"))),
    ] {
        let r = refused(e.install(ORG, &signed(&*edit), &comp));
        assert!(r.contains(why), "{name}: {r}");
    }
    assert!(matches!(e.host.install(ORG, "not json", &comp), Err(PluginError::Invalid(_))));
    match e.host.install(ORG, "[]", &comp) {
        Err(PluginError::Refused(p)) => assert!(p.join(" ").contains("must be a JSON object"), "{p:?}"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_tools_the_component_has_must_be_the_tools_that_were_signed() {
    let e = env();
    let comp = dist("pricing");
    let m = M::new("acme.pricing", &comp, vec![("quote".into(), "".into()), ("steal".into(), "".into())]);
    assert!(refused(e.install(ORG, &m.signed(), &comp)).contains("are not the manifest's"));
    let m = M::new("acme.pricing", &comp, vec![("quote".into(), "".into())]);
    assert!(refused(e.install(ORG, &m.signed(), &comp)).contains("are not the manifest's"));
}

#[test]
fn a_component_that_imports_the_network_is_refused_before_any_of_its_code_runs() {
    let e = env();
    let comp = dist("conformance-net");
    let m = M::new("evil.net", &comp, vec![("connect".into(), "open a TCP connection".into())]);
    let why = refused(e.install(ORG, &m.signed(), &comp));
    assert!(why.contains("wasi:sockets"), "{why}");
    assert!(e.host.list(ORG).is_empty());
}

#[test]
fn garbage_and_oversized_components_are_refused() {
    let e = env();
    let garbage = b"\0asm\x01\x00\x00\x00not really".to_vec();
    let m = M::new("x.y", &garbage, vec![("t".into(), "".into())]);
    assert!(refused(e.install(ORG, &m.signed(), &garbage)).contains("not a valid WebAssembly component"));
    let text = b"(component)".to_vec();
    let m = M::new("x.y", &text, vec![("t".into(), "".into())]);
    assert!(refused(e.install(ORG, &m.signed(), &text)).contains("not a valid WebAssembly component"), "text format must not be accepted");

    let small = env_with(Ceilings { max_component_bytes: 1000, ..Ceilings::default() });
    let comp = dist("pricing");
    let m = M::new("acme.pricing", &comp, PRICING_TOOLS.iter().map(|(n, d)| (n.to_string(), d.to_string())).collect());
    assert!(refused(small.install(ORG, &m.signed(), &comp)).contains("larger than"));
}

#[test]
fn versions_only_move_forward() {
    let e = env();
    let comp = dist("pricing");
    let tools: Vec<(String, String)> = PRICING_TOOLS.iter().map(|(n, d)| (n.to_string(), d.to_string())).collect();
    let v = |ver: &'static str, desc: &str| {
        let mut m = M::new("acme.pricing", &comp, tools.clone());
        m.version = ver;
        let mut d = m.doc();
        d["description"] = json!(desc);
        sign_doc(d, &issuer_secret())
    };
    assert!(!e.install(ORG, &v("1.0.0", "a"), &comp).unwrap().replaced);
    // the same signed manifest again is a no-op
    assert!(!e.install(ORG, &v("1.0.0", "a"), &comp).unwrap().replaced);
    assert!(refused(e.install(ORG, &v("1.0.0", "different"), &comp)).contains("not newer"), "a re-signed copy of the same version");
    assert!(e.install(ORG, &v("1.1.0", "b"), &comp).unwrap().replaced);
    assert!(refused(e.install(ORG, &v("1.0.5", "c"), &comp)).contains("not newer"), "a downgrade");
    assert_eq!(e.host.list(ORG)[0].version, "1.1.0");
}

#[test]
fn installs_are_per_tenant() {
    let e = env();
    install_pricing(&e, ORG);
    assert_eq!(e.host.list(ORG).len(), 1);
    assert!(e.host.list(ORG_B).is_empty());
    assert!(matches!(e.host.invoke(ORG_B, AGENT, "acme.pricing", "quote", "{}"), Err(PluginError::NotFound)));
    assert!(e.host.remove(ORG, "acme.pricing"));
    assert!(matches!(e.host.invoke(ORG, AGENT, "acme.pricing", "quote", "{}"), Err(PluginError::NotFound)));
}

// ── invoking: bad requests ───────────────────────────────────────────────────

#[test]
fn bad_invocations_are_refused_before_any_code_runs() {
    let e = env();
    e.conformance(ORG, vec![], json!({"max_input_bytes": 100}));
    assert!(matches!(e.host.invoke(ORG, AGENT, "nope", "echo", "{}"), Err(PluginError::NotFound)));
    assert!(matches!(e.host.invoke(ORG, AGENT, "test.conformance", "nope", "{}"), Err(PluginError::Invalid(_))));
    assert!(matches!(e.host.invoke(ORG, AGENT, "test.conformance", "echo", "not json"), Err(PluginError::Invalid(_))));
    assert!(matches!(e.host.invoke(ORG, AGENT, "test.conformance", "echo", &format!("\"{}\"", "a".repeat(200))), Err(PluginError::Invalid(_))));
    assert_eq!(e.run("echo", json!({"hello": "world"})).result_json, r#"{"hello":"world"}"#);
}

#[test]
fn a_plugin_stops_working_when_its_manifest_expires() {
    let e = env();
    e.conformance(ORG, vec![], json!({}));
    assert_eq!(e.run("echo", json!(1)).status, Status::Ok);
    e.clock.advance(400 * 24 * 3600);
    assert!(matches!(e.host.invoke(ORG, AGENT, "test.conformance", "echo", "1"), Err(PluginError::Unavailable(_))));
}

// ── invoking: the sandbox and the limits ─────────────────────────────────────

#[test]
fn an_endless_loop_runs_out_of_fuel() {
    let e = env();
    e.conformance(ORG, vec![], json!({"fuel": 5_000_000}));
    let t = Instant::now();
    let r = e.run("spin", json!({}));
    assert_eq!(r.status, Status::LimitExceeded("fuel".into()), "{r:?}");
    assert!(r.fuel_used >= 5_000_000 - 1000);
    assert!(t.elapsed() < Duration::from_secs(5));
    // and the host is fine afterwards
    assert_eq!(e.run("echo", json!(1)).status, Status::Ok);
}

#[test]
fn a_plugin_with_plenty_of_fuel_still_hits_its_wall_clock_deadline() {
    let e = env();
    // 2 billion instructions take roughly a quarter of a second, so a 100 ms deadline is the one that bites
    e.conformance(ORG, vec![], json!({"fuel": 2_000_000_000u64, "timeout_ms": 100}));
    let t = Instant::now();
    let r = e.run("spin", json!({}));
    assert_eq!(r.status, Status::LimitExceeded("time".into()), "{r:?}");
    let took = t.elapsed();
    assert!(took >= Duration::from_millis(80) && took < Duration::from_secs(3), "{took:?}");
}

#[test]
fn a_plugin_cannot_sleep_the_host() {
    let e = env();
    e.conformance(ORG, vec![], json!({"timeout_ms": 500}));
    let t = Instant::now();
    let r = e.run("sleep", json!({}));
    assert!(matches!(r.status, Status::Trapped | Status::LimitExceeded(_)), "{r:?}");
    assert!(t.elapsed() < Duration::from_secs(3), "the host must not be held for the plugin's 30 s: {:?}", t.elapsed());
}

#[test]
fn memory_is_capped() {
    let e = env();
    e.conformance(ORG, vec![], json!({"memory_bytes": 16 << 20}));
    let r = e.run("alloc", json!({"mib": 200}));
    assert_eq!(r.status, Status::LimitExceeded("memory".into()), "{r:?}");
    assert_eq!(e.run("alloc", json!({"mib": 4})).status, Status::Ok, "a modest allocation is fine");
}

#[test]
fn runaway_recursion_hits_the_stack_limit() {
    let e = env();
    e.conformance(ORG, vec![], json!({}));
    let r = e.run("recurse", json!({}));
    assert!(matches!(r.status, Status::LimitExceeded(ref l) if l == "stack" || l == "fuel"), "{r:?}");
}

#[test]
fn a_panic_is_a_trap_and_its_message_is_not_forwarded() {
    let e = env();
    e.conformance(ORG, vec![], json!({}));
    let r = e.run("panic", json!({}));
    assert_eq!(r.status, Status::Trapped, "{r:?}");
    assert!(!r.error.contains("deliberate panic"), "{}", r.error);
    assert!(r.result_json.is_empty());
    assert_eq!(e.run("echo", json!(1)).status, Status::Ok);
}

#[test]
fn output_is_bounded_and_checked() {
    let e = env();
    e.conformance(ORG, vec![], json!({"max_output_bytes": 1000}));
    assert_eq!(e.run("big_output", json!({"bytes": 100})).status, Status::Ok);
    let r = e.run("big_output", json!({"bytes": 5000}));
    assert_eq!(r.status, Status::InvalidOutput, "{r:?}");
    assert!(r.result_json.is_empty());
    let r = e.run("bad_result", json!({}));
    assert_eq!(r.status, Status::InvalidOutput);
    assert!(r.error.contains("not JSON"));
    let r = e.run("stdout_flood", json!({}));
    assert_eq!(r.status, Status::LimitExceeded("output".into()), "{r:?}");
}

#[test]
fn a_plugin_cannot_propose_an_action_for_someone_else() {
    let e = env();
    e.conformance(ORG, vec![], json!({}));
    for (tool, why) in [("forge_intent", "another organization"), ("forge_agent", "another agent"), ("intent_not_json", "not a JSON object")] {
        let r = e.run(tool, json!({}));
        assert_eq!(r.status, Status::InvalidOutput, "{tool}: {r:?}");
        assert!(r.error.contains(why), "{tool}: {}", r.error);
        assert!(r.proposed_intents.is_empty(), "nothing is forwarded when any of it is refused");
    }
    let r = e.run("many_intents", json!({"n": 16}));
    assert_eq!(r.status, Status::Ok);
    assert_eq!(r.proposed_intents.len(), 16);
    let r = e.run("many_intents", json!({"n": 17}));
    assert_eq!(r.status, Status::InvalidOutput);
    assert!(r.error.contains("limit is 16"));
}

#[test]
fn the_plugin_has_no_filesystem_no_environment_and_no_real_clock() {
    let e = env();
    e.conformance(ORG, vec![], json!({}));
    let r = e.run("read_file", json!({"path": "/etc/passwd"}));
    assert_eq!(r.status, Status::Ok, "{r:?}");
    let v: Value = serde_json::from_str(&r.result_json).unwrap();
    assert!(v["read"].is_null(), "a plugin read the host's /etc/passwd: {v}");

    let v: Value = serde_json::from_str(&e.run("env", json!({})).result_json).unwrap();
    assert_eq!(v["vars"], 0, "{v}");

    // the clock is the kernel's, frozen at the start of the call
    let v: Value = serde_json::from_str(&e.run("time", json!({})).result_json).unwrap();
    let now = helix_kernel::clock::parse(NOW).unwrap().timestamp();
    assert_eq!(v["unix"], now, "{v}");
    assert_eq!(v["same_after_work"], true, "{v}");
    assert_eq!(v["elapsed_ns"], 0, "{v}");
}

#[test]
fn a_call_is_a_pure_function_of_its_input() {
    let e = env();
    e.conformance(ORG, vec![], json!({}));
    let a = e.run("random", json!({"x": 1}));
    let b = e.run("random", json!({"x": 1}));
    assert_eq!(a.status, Status::Ok);
    assert_eq!(a.result_json, b.result_json, "no real randomness reaches the plugin");
    // and no state leaks from one invocation to the next
    for _ in 0..3 {
        assert_eq!(e.run("counter", json!({})).result_json, r#"{"n":1}"#);
    }
}

#[test]
fn logs_are_bounded() {
    let e = env_with(Ceilings { max_log_lines: 50, ..Ceilings::default() });
    e.conformance(ORG, vec![], json!({}));
    let r = e.run("log_flood", json!({"n": 3000}));
    assert_eq!(r.status, Status::Ok, "{:?}", r.error);
    assert!(r.logs.len() <= 50 + 2, "{}", r.logs.len());
}

#[test]
fn only_so_many_invocations_run_at_once() {
    let e = Arc::new(env_with(Ceilings { max_concurrent: 2, ..Ceilings::default() }));
    e.conformance(ORG, vec![], json!({"fuel": 2_000_000_000u64, "timeout_ms": 5000}));
    let handles: Vec<_> = (0..5)
        .map(|_| {
            let e = e.clone();
            std::thread::spawn(move || e.host.invoke(ORG, AGENT, "test.conformance", "spin", "{}"))
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let busy = results.iter().filter(|r| matches!(r, Err(PluginError::Busy))).count();
    let ran = results.iter().filter(|r| matches!(r, Ok(i) if i.status == Status::LimitExceeded("fuel".into()))).count();
    assert!(busy >= 1 && ran >= 2, "busy={busy} ran={ran}: {results:?}");
    // permits are returned
    assert_eq!(e.run("echo", json!(1)).status, Status::Ok);
}

// ── storage ──────────────────────────────────────────────────────────────────

#[test]
fn storage_needs_the_permission_and_a_denied_call_ends_the_invocation() {
    let e = env();
    e.conformance(ORG, vec![], json!({}));
    let r = e.run("kv_read", json!({"key": "k"}));
    assert_eq!(r.status, Status::Trapped, "{r:?}");
    assert!(r.error.contains("permission denied") && r.error.contains("storage"), "{}", r.error);
}

#[test]
fn storage_is_per_tenant_and_per_plugin_and_survives_between_calls() {
    let e = env();
    e.conformance(ORG, vec!["storage"], json!({}));
    e.conformance(ORG_B, vec!["storage"], json!({}));
    let r = e.run("kv_roundtrip", json!({"key": "greeting", "value": "hello"}));
    assert_eq!(r.result_json, r#"{"read":"hello"}"#, "{r:?}");
    assert_eq!(e.run("kv_read", json!({"key": "greeting"})).result_json, r#"{"value":"hello"}"#, "visible to the next call");
    // org_b's copy of the same plugin has its own, empty, storage
    let b = e.host.invoke(ORG_B, AGENT, "test.conformance", "kv_read", r#"{"key":"greeting"}"#).unwrap();
    assert_eq!(b.result_json, r#"{"value":null}"#, "{b:?}");
    assert_eq!(e.storage.get(ORG_B, "test.conformance", "greeting").unwrap(), None);
}

#[test]
fn a_failed_invocation_leaves_no_trace_in_storage() {
    let e = env();
    e.conformance(ORG, vec!["storage"], json!({}));
    let r = e.run("kv_write_then_panic", json!({}));
    assert_eq!(r.status, Status::Trapped);
    assert_eq!(e.storage.get(ORG, "test.conformance", "ghost").unwrap(), None, "a trapped invocation must not have written");
}

#[test]
fn storage_is_bounded() {
    let e = env();
    e.conformance(ORG, vec!["storage"], json!({"storage_bytes": 10_000}));
    let r = e.run("kv_big", json!({"bytes": 70_000}));
    assert_eq!(r.status, Status::ToolError, "{r:?}");
    assert!(r.error.contains("64 KiB"));
    let r = e.run("kv_fill", json!({"n": 50}));
    assert_eq!(r.status, Status::ToolError, "{r:?}");
    assert!(r.error.contains("quota"), "{}", r.error);
    assert_eq!(e.storage.usage(ORG, "test.conformance").unwrap(), 0, "the invocation that hit the quota wrote nothing");
    assert_eq!(e.run("kv_fill", json!({"n": 5})).status, Status::Ok);
    assert!(e.storage.usage(ORG, "test.conformance").unwrap() > 5000);
}
