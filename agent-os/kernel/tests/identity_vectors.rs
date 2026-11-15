//! The kernel's identity verifier against the shared sid/0.2 conformance
//! vectors — the same 54 cases the Python and TypeScript implementations pass.

use helix_kernel::identity::{verify_runtime, verify_sid, VerifyOptions};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn load(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/sid-0.2/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

#[test]
fn vendored_vectors_are_the_ones_we_think_they_are() {
    let path = format!("{}/tests/fixtures/sid-0.2/vectors.json", env!("CARGO_MANIFEST_DIR"));
    let digest = hex::encode(Sha256::digest(std::fs::read(&path).unwrap()));
    let recorded = std::fs::read_to_string(format!("{}/tests/fixtures/sid-0.2/SOURCE_SHA256", env!("CARGO_MANIFEST_DIR"))).unwrap();
    assert_eq!(digest, recorded.trim(), "vectors.json changed: refresh from the sid repository and update SOURCE_SHA256");
}

#[test]
fn agrees_with_every_shared_vector() {
    let trust = load("trust.json");
    let vectors = load("vectors.json");
    let vectors = vectors["vectors"].as_array().unwrap();
    assert_eq!(vectors.len(), 54);
    let mut failures = vec![];
    for v in vectors {
        let name = v["name"].as_str().unwrap();
        let anchors: Option<&Value> = match &v["trust"] {
            Value::Bool(true) => Some(&trust),
            Value::Bool(false) => None,
            other => Some(other),
        };
        let opt = |k: &str| v.get(k).filter(|x| !x.is_null());
        let result = if v["kind"] == "sid" {
            verify_sid(
                &v["cert"],
                &VerifyOptions { trust: anchors, previous: opt("previous"), head: opt("head"), legacy: opt("legacy") },
            )
        } else {
            verify_runtime(&v["stmt"], &v["cert"], anchors, opt("now").and_then(Value::as_str), opt("head"))
        };
        let e = &v["expect"];
        let mut problems = vec![];
        if result.ok != e["ok"].as_bool().unwrap() {
            problems.push(format!("ok={} want {}", result.ok, e["ok"]));
        }
        if result.trusted != e["trusted"].as_bool().unwrap() {
            problems.push(format!("trusted={} want {}", result.trusted, e["trusted"]));
        }
        if let Some(want) = e.get("error").and_then(Value::as_str) {
            if !result.errors.iter().any(|x| x.contains(want)) {
                problems.push(format!("no error containing {want:?}; have {:?}", result.errors));
            }
        }
        if let Some(want) = e.get("untrusted").and_then(Value::as_str) {
            if !result.untrusted.iter().any(|x| x.contains(want)) {
                problems.push(format!("no untrusted reason containing {want:?}; have {:?}", result.untrusted));
            }
        }
        if let Some(want) = e.get("migration").and_then(Value::as_str) {
            if result.migration.as_deref() != Some(want) {
                problems.push(format!("migration {:?} want {want}", result.migration));
            }
        }
        if !problems.is_empty() {
            failures.push(format!("{name}: {}", problems.join("; ")));
        }
    }
    assert!(failures.is_empty(), "{} vector(s) disagree:\n{}", failures.len(), failures.join("\n"));
}
