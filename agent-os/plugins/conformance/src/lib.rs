//! A plugin that misbehaves on purpose, one tool per way. The host's tests run
//! each and assert that the sandbox, the limits and the output checks hold.
//! Never install this anywhere but a test.

wit_bindgen::generate!({ path: "../wit", world: "plugin" });

use exports::helix::plugin::tool::{Guest, Output, ToolInfo};
use helix::plugin::host;
use serde_json::{json, Value};

struct Conformance;

const TOOLS: &[(&str, &str)] = &[
    ("echo", "return the input"),
    ("spin", "loop forever"),
    ("alloc", "allocate input.mib MiB and touch it"),
    ("recurse", "recurse without end"),
    ("panic", "panic"),
    ("big_output", "return input.bytes bytes"),
    ("many_intents", "propose input.n intents"),
    ("read_file", "try to read input.path"),
    ("env", "report the environment and arguments"),
    ("time", "report the clock and whether it moves"),
    ("kv_roundtrip", "kv-set then kv-get input.key/value"),
    ("kv_big", "kv-set input.bytes bytes"),
    ("kv_fill", "kv-set input.n distinct keys"),
    ("kv_write_then_panic", "kv-set then panic"),
    ("kv_read", "kv-get input.key"),
    ("log_flood", "log input.n lines"),
    ("forge_intent", "propose an intent for another organization"),
    ("forge_agent", "propose an intent for another agent"),
    ("intent_not_json", "propose something that is not an intent"),
    ("bad_result", "return a result that is not JSON"),
    ("sleep", "sleep for 30 seconds"),
    ("stdout_flood", "write 100 KB to standard output"),
    ("random", "report what the hasher's random state yields"),
    ("counter", "increment a global and report it"),
];

static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn recurse(n: u64) -> u64 {
    let pad = [n as u8; 64];
    if n == u64::MAX { return pad[0] as u64; }
    recurse(n + 1).wrapping_add(pad[(n % 64) as usize] as u64)
}

fn intent(extra: Value) -> String {
    let mut i = json!({"capability": "kb.search", "tool": "kb.search", "target": "kb:main", "operation": "kb.search", "risk": "low", "arguments": {}});
    if let (Some(o), Some(e)) = (i.as_object_mut(), extra.as_object()) {
        for (k, v) in e { o.insert(k.clone(), v.clone()); }
    }
    i.to_string()
}

fn ok(v: Value) -> Result<Output, String> {
    Ok(Output { result_json: v.to_string(), proposed_intents: vec![] })
}

impl Guest for Conformance {
    fn list_tools() -> Vec<ToolInfo> {
        TOOLS.iter().map(|(n, d)| ToolInfo { name: n.to_string(), description: d.to_string() }).collect()
    }

    fn invoke(tool: String, input_json: String) -> Result<Output, String> {
        let input: Value = serde_json::from_str(&input_json).unwrap_or(Value::Null);
        let num = |k: &str| input[k].as_u64().unwrap_or(0) as usize;
        match tool.as_str() {
            "echo" => ok(input),
            "spin" => { let mut x = 0u64; loop { x = x.wrapping_add(1); std::hint::black_box(x); } }
            "alloc" => {
                let mut v = vec![0u8; num("mib") * 1024 * 1024];
                for i in (0..v.len()).step_by(4096) { v[i] = 1; }
                ok(json!({"allocated": v.len()}))
            }
            "recurse" => ok(json!({"depth": recurse(0)})),
            "panic" => panic!("deliberate panic"),
            "big_output" => ok(json!({"data": "x".repeat(num("bytes"))})),
            "many_intents" => Ok(Output { result_json: "{}".into(), proposed_intents: (0..num("n")).map(|_| intent(json!({}))).collect() }),
            "read_file" => {
                let path = input["path"].as_str().unwrap_or("/etc/passwd");
                match std::fs::read_to_string(path) {
                    Ok(s) => ok(json!({"read": s.len()})),
                    Err(e) => ok(json!({"read": null, "error": e.to_string()})),
                }
            }
            "env" => ok(json!({"vars": std::env::vars().count(), "args": std::env::args().count()})),
            "time" => {
                let a = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                let t0 = std::time::Instant::now();
                let mut x = 0u64;
                for i in 0..200_000u64 { x = x.wrapping_add(i); std::hint::black_box(x); }
                let b = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                ok(json!({"unix": a, "same_after_work": a == b, "elapsed_ns": t0.elapsed().as_nanos() as u64}))
            }
            "kv_roundtrip" => {
                let (k, v) = (input["key"].as_str().unwrap_or("k"), input["value"].as_str().unwrap_or("v"));
                host::kv_set(k, v)?;
                ok(json!({"read": host::kv_get(k)}))
            }
            "kv_big" => { host::kv_set("big", &"y".repeat(num("bytes")))?; ok(json!({"stored": true})) }
            "kv_fill" => {
                for i in 0..num("n") { host::kv_set(&format!("key-{i}"), &"z".repeat(1000))?; }
                ok(json!({"stored": num("n")}))
            }
            "kv_write_then_panic" => { let _ = host::kv_set("ghost", "boo"); panic!("after writing") }
            "kv_read" => ok(json!({"value": host::kv_get(input["key"].as_str().unwrap_or("k"))})),
            "log_flood" => { for i in 0..num("n") { host::log("info", &format!("line {i}")); } ok(json!({"logged": num("n")})) }
            "forge_intent" => Ok(Output { result_json: "{}".into(), proposed_intents: vec![intent(json!({"organization_id": "org_victim"}))] }),
            "forge_agent" => Ok(Output { result_json: "{}".into(), proposed_intents: vec![intent(json!({"agent_id": "sid_someone-else"}))] }),
            "intent_not_json" => Ok(Output { result_json: "{}".into(), proposed_intents: vec!["buy everything".into()] }),
            "sleep" => { std::thread::sleep(std::time::Duration::from_secs(30)); ok(json!({"slept": true})) }
            "stdout_flood" => { for _ in 0..1000 { println!("{}", "x".repeat(100)); } ok(json!({"printed": true})) }
            "random" => {
                use std::hash::{BuildHasher, Hash, Hasher};
                let mut h = std::collections::hash_map::RandomState::new().build_hasher();
                42u32.hash(&mut h);
                ok(json!({"hash": h.finish().to_string()}))
            }
            "counter" => ok(json!({"n": COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1})),
            "bad_result" => Ok(Output { result_json: "not json".into(), proposed_intents: vec![] }),
            other => Err(format!("no such tool: {other}")),
        }
    }
}

export!(Conformance);
