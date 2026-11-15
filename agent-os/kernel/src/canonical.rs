//! Canonical JSON and hashing — byte-identical with the card and sid
//! implementations in TypeScript and Python
//! (`json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)`
//! after pruning).
//!
//! 1. Empty arrays and empty objects are dropped when they are object VALUES,
//!    bottom-up.
//! 2. Keys are sorted.
//! 3. Separators are compact.
//! 4. Non-ASCII is escaped as `\uXXXX` (surrogate pairs above the BMP).
//!
//! Stricter than the other implementations in one way: a non-integral number
//! is an error. The languages disagree on how to print floats, and nothing
//! that gets signed here should contain one.

use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum CanonicalError {
    #[error("non-integral number in a signed document")]
    Float,
}

fn prune(v: &Value) -> Value {
    match v {
        Value::Array(items) => Value::Array(items.iter().map(prune).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, val) in map {
                let pruned = prune(val);
                let empty = match &pruned {
                    Value::Array(a) => a.is_empty(),
                    Value::Object(o) => o.is_empty(),
                    _ => false,
                };
                if !empty {
                    out.insert(k.clone(), pruned);
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            // Python's ensure_ascii escapes everything outside space..~, which
            // includes DEL (0x7f) as well as control characters.
            c if (c as u32) < 0x20 || (c as u32) == 0x7f => out.push_str(&format!("\\u{:04x}", c as u32)),
            c if (c as u32) < 0x80 => out.push(c),
            c => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    out.push_str(&format!("\\u{:04x}", unit));
                }
            }
        }
    }
    out.push('"');
}

fn write_value(v: &Value, out: &mut String) -> Result<(), CanonicalError> {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                out.push_str(&i.to_string());
            } else if let Some(u) = n.as_u64() {
                out.push_str(&u.to_string());
            } else {
                let f = n.as_f64().ok_or(CanonicalError::Float)?;
                if f.fract() != 0.0 || !f.is_finite() || f.abs() > 9.0e15 {
                    return Err(CanonicalError::Float);
                }
                out.push_str(&(f as i64).to_string());
            }
        }
        Value::String(s) => write_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            // Python and JavaScript sort keys by code unit; for the key sets
            // used here (ASCII) byte order is the same order.
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(k, out);
                out.push(':');
                write_value(&map[*k], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// Canonical JSON of a value.
pub fn canonical_json(v: &Value) -> Result<String, CanonicalError> {
    let mut out = String::new();
    write_value(&prune(v), &mut out)?;
    Ok(out)
}

pub fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// SHA-256 of the canonical JSON of `doc` without the named top-level keys and
/// without any key starting with "_".
pub fn hash_without(doc: &Value, excluded: &[&str]) -> Result<String, CanonicalError> {
    let mut body = serde_json::Map::new();
    if let Value::Object(map) = doc {
        for (k, v) in map {
            if !excluded.contains(&k.as_str()) && !k.starts_with('_') {
                body.insert(k.clone(), v.clone());
            }
        }
    }
    Ok(sha256_hex(&canonical_json(&Value::Object(body))?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The golden vectors are generated by Python's json.dumps and shared by
    /// every implementation (agent-os/contracts/conformance).
    #[test]
    fn reproduces_every_golden_vector_byte_for_byte() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../contracts/conformance/canonical-vectors.json");
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let vectors = doc["vectors"].as_array().unwrap();
        assert!(vectors.len() >= 12);
        for v in vectors {
            let name = v["name"].as_str().unwrap();
            let got = canonical_json(&v["input"]).unwrap();
            assert_eq!(got, v["canonical"].as_str().unwrap(), "{name}");
            assert_eq!(sha256_hex(&got), v["sha256"].as_str().unwrap(), "{name}");
        }
    }

    #[test]
    fn prunes_empty_object_values_bottom_up_but_keeps_array_elements() {
        let v = json!({"keep": 1, "gone": [], "nested": {"also": {}}, "list": [[], {}]});
        assert_eq!(canonical_json(&v).unwrap(), r#"{"keep":1,"list":[[],{}]}"#);
    }

    #[test]
    fn integral_floats_become_integers_and_other_floats_are_refused() {
        assert_eq!(canonical_json(&json!({"n": 4.0})).unwrap(), r#"{"n":4}"#);
        assert_eq!(canonical_json(&json!({"n": 4.5})), Err(CanonicalError::Float));
    }

    #[test]
    fn control_characters_use_python_escapes() {
        let v = json!("\u{08}\u{0c}\u{01}\u{7f}");
        assert_eq!(canonical_json(&v).unwrap(), "\"\\b\\f\\u0001\\u007f\"");
    }
}
