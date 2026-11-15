//! sid/0.2 identity verification — the kernel's own implementation.
//!
//! The third implementation of the verifier (after Python and TypeScript in
//! github.com/cryptonomicsed-byte/sid), kept rule for rule with
//! `spec/sid-0.2.md` there and tested against the same shared vectors. The
//! kernel never takes another component's word that an identity is trusted:
//! it re-verifies.
//!
//! Two verdicts. `ok` means well formed and internally consistent; `trusted`
//! additionally means the issuer's signature verified under a trust anchor the
//! kernel was configured with, the agent is `live`, and (when the caller knows
//! the newest version) this is that version. The kernel acts only on
//! `trusted`.

use std::collections::HashSet;

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::canonical::{canonical_json, hash_without, sha256_hex};
use crate::sigs;

pub const FORMAT: &str = "sid/0.2";
pub const RUNTIME_FORMAT: &str = "sid-runtime/0.2";
pub const LEGACY_FORMAT: &str = "sid/0.1";
const ACTING_KEYS: [&str; 6] = ["identity", "bindings", "capabilities", "memory", "lifecycle", "status"];
const LEGACY_ACTING_KEYS: [&str; 5] = ["identity", "capabilities", "memory", "lifecycle", "status"];
const STATUSES: [&str; 4] = ["cast", "live", "suspended", "retired"];
const UNHASHED: [&str; 2] = ["hash", "proof"];
const ENDPOINT_TYPES: [&str; 6] = ["nostr", "meshenger-lan", "sip", "a2a", "mcp", "https"];
const SECRET_KEYS: [&str; 6] = ["seed", "mnemonic", "private_key", "nsec", "secret", "secret_key"];

fn binding_alg(kind: &str) -> Option<&'static str> {
    match kind {
        "nostr" => Some("bip340"),
        "meshenger" => Some("ed25519"),
        _ => None,
    }
}

fn endpoint_binding(kind: &str) -> Option<&'static str> {
    match kind {
        "nostr" => Some("nostr"),
        "meshenger-lan" => Some("meshenger"),
        _ => None,
    }
}

struct Patterns {
    hex64: Regex,
    hex128: Regex,
    id: Regex,
    slug: Regex,
    ns: Regex,
    time: Regex,
}

fn patterns() -> &'static Patterns {
    use std::sync::OnceLock;
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| Patterns {
        hex64: Regex::new(r"^[0-9a-f]{64}$").unwrap(),
        hex128: Regex::new(r"^[0-9a-f]{128}$").unwrap(),
        id: Regex::new(r"^sid_[a-z0-9][a-z0-9-]*$").unwrap(),
        slug: Regex::new(r"^[a-z0-9][a-z0-9-]*$").unwrap(),
        ns: Regex::new(r"^[a-z0-9][a-z0-9_.-]*$").unwrap(),
        time: Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$").unwrap(),
    })
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Verdict {
    pub ok: bool,
    pub trusted: bool,
    pub errors: Vec<String>,
    pub untrusted: Vec<String>,
    /// "verified" | "unchecked" | None
    pub migration: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct VerifyOptions<'a> {
    /// Trust anchors: `{"issuers": {id: {"keys": [...]}}}`. Never read from a certificate.
    pub trust: Option<&'a Value>,
    pub previous: Option<&'a Value>,
    /// `{"version", "hash"}` of the newest version the caller knows.
    pub head: Option<&'a Value>,
    pub legacy: Option<&'a Value>,
}

// ── small JSON helpers ───────────────────────────────────────────────────────
fn get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_object().and_then(|m| m.get(key))
}
fn gstr<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    get(v, key).and_then(Value::as_str)
}
fn is_int(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Number(n)) if n.is_i64() || n.is_u64())
}
fn int(v: Option<&Value>) -> Option<i64> {
    v.and_then(Value::as_i64)
}
fn is_time(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).map_or(false, |s| patterns().time.is_match(s))
}
fn is_obj(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_)))
}
fn is_hex64(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).map_or(false, |s| patterns().hex64.is_match(s))
}
fn nonempty_str(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).map_or(false, |s| !s.is_empty())
}
/// Python's `cert.get(k) == value` for strings and null.
fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    a.unwrap_or(&Value::Null) == b.unwrap_or(&Value::Null)
}

fn body(doc: &Value) -> Value {
    let mut out = Map::new();
    if let Some(m) = doc.as_object() {
        for (k, v) in m {
            if !UNHASHED.contains(&k.as_str()) && !k.starts_with('_') {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    Value::Object(out)
}

pub fn acting_hash(cert: &Value) -> String {
    let mut acting = Map::new();
    for k in ACTING_KEYS {
        if let Some(v) = get(cert, k) {
            acting.insert(k.to_string(), v.clone());
        }
    }
    sha256_hex(&canonical_json(&Value::Object(acting)).unwrap_or_default())
}

/// Hash of a certificate or runtime statement: everything except hash, proof and "_" keys.
pub fn sid_hash(doc: &Value) -> String {
    hash_without(doc, &UNHASHED).unwrap_or_default()
}

pub fn issue_message(format: &str, doc_hash: &str) -> String {
    format!("{format}\nissue\n{doc_hash}")
}

pub fn bind_message(sid_id: &str, binding: &Value) -> String {
    let field = |k: &str| match get(binding, k) {
        None | Some(Value::Null) => "None".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    };
    format!("{FORMAT}\nbind\n{sid_id}\n{}\n{}\n{}", field("id"), field("alg"), field("public_key"))
}

fn find_secrets(node: &Value, path: &str, out: &mut Vec<String>) {
    match node {
        Value::Object(map) => {
            for (k, v) in map {
                let here = if path.is_empty() { k.clone() } else { format!("{path}.{k}") };
                if SECRET_KEYS.contains(&k.as_str()) {
                    out.push(here.clone());
                }
                find_secrets(v, &here, out);
            }
        }
        Value::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                find_secrets(v, &format!("{path}[{i}]"), out);
            }
        }
        _ => {}
    }
}

// ── issuer authority ─────────────────────────────────────────────────────────
struct IssuerCheck {
    errors: Vec<String>,
    untrusted: Vec<String>,
    verified: bool,
}

fn issuer_check(doc: &Value, trust: Option<&Value>, signed_at: Option<&Value>) -> IssuerCheck {
    let mut r = IssuerCheck { errors: vec![], untrusted: vec![], verified: false };
    let p = patterns();
    let issuer = get(doc, "issuer");
    let proof = get(doc, "proof");
    let issuer_ok = issuer.map_or(false, |i| is_obj(Some(i)) && nonempty_str(get(i, "id")) && nonempty_str(get(i, "kid")));
    if !issuer_ok {
        r.errors.push("issuer must be {id, kid}".into());
        return r;
    }
    let issuer = issuer.unwrap();
    let proof_ok = proof.map_or(false, |pf| {
        is_obj(Some(pf))
            && gstr(pf, "alg").map_or(false, |a| sigs::ALGS.contains(&a))
            && gstr(pf, "signature").map_or(false, |s| p.hex128.is_match(s))
    });
    if !proof_ok {
        r.errors.push("proof must be {alg, signature} with a supported alg and a 128-hex signature".into());
        return r;
    }
    let proof = proof.unwrap();
    let issuers = trust.and_then(|t| get(t, "issuers")).filter(|i| i.is_object());
    let Some(issuers) = issuers else {
        r.untrusted.push("no trust anchors supplied".into());
        return r;
    };
    let issuer_id = gstr(issuer, "id").unwrap();
    let kid = gstr(issuer, "kid").unwrap();
    let Some(anchor) = issuers.get(issuer_id).filter(|a| a.is_object()) else {
        r.untrusted.push(format!("issuer {issuer_id} is not a trust anchor"));
        return r;
    };
    let key = get(anchor, "keys")
        .and_then(Value::as_array)
        .and_then(|keys| keys.iter().find(|k| gstr(k, "kid") == Some(kid)));
    let Some(key) = key else {
        r.untrusted.push(format!("issuer {issuer_id} has no key {kid}"));
        return r;
    };
    if gstr(key, "alg") != gstr(proof, "alg") {
        r.errors.push("proof.alg does not match the issuer key".into());
        return r;
    }
    let message = issue_message(gstr(doc, "format").unwrap_or("None"), gstr(doc, "hash").unwrap_or("None"));
    if !sigs::verify(
        gstr(proof, "alg").unwrap(),
        gstr(key, "public_key").unwrap_or(""),
        &message,
        gstr(proof, "signature").unwrap(),
    ) {
        r.errors.push("issuer signature does not verify".into());
        return r;
    }
    // The signature is genuine; is the key allowed to have made it?
    if get(key, "compromised") == Some(&Value::Bool(true)) {
        r.untrusted.push(format!("issuer key {kid} is marked compromised"));
        return r;
    }
    if let Some(at) = signed_at.and_then(Value::as_str).filter(|_| is_time(signed_at)) {
        let bound = |name: &str| get(key, name).filter(|v| is_time(Some(v))).and_then(Value::as_str);
        if bound("not_before").map_or(false, |b| at < b) {
            r.untrusted.push(format!("signed before issuer key {kid} was valid"));
            return r;
        }
        if bound("not_after").map_or(false, |b| at >= b) {
            r.untrusted.push(format!("signed after issuer key {kid} expired"));
            return r;
        }
        if bound("revoked_at").map_or(false, |b| at >= b) {
            r.untrusted.push(format!("signed after issuer key {kid} was revoked"));
            return r;
        }
    }
    r.verified = true;
    r
}

/// The outcome of checking a signed document that is not a certificate.
pub struct SignedCheck {
    pub errors: Vec<String>,
    pub untrusted: Vec<String>,
}

/// Check any document that follows the sid signing scheme (a `hash` over the
/// canonical body without `hash`/`proof`, and an issuer `proof` over
/// `<format>\nissue\n<hash>`) against the trust anchors, at the document's own
/// `issued_at`. Used for plugin manifests. Errors mean tampered or malformed;
/// `untrusted` means well formed but not anchored, or anchored under a key that
/// was not valid when it was signed.
pub fn check_signed_document(doc: &Value, trust: Option<&Value>) -> SignedCheck {
    let mut out = SignedCheck { errors: vec![], untrusted: vec![] };
    if gstr(doc, "hash") != Some(sid_hash(doc).as_str()) {
        out.errors.push("hash does not match the document".into());
        return out;
    }
    let r = issuer_check(doc, trust, get(doc, "issued_at"));
    out.errors = r.errors;
    out.untrusted = r.untrusted;
    out
}

// ── the certificate ──────────────────────────────────────────────────────────
pub fn verify_sid(cert: &Value, opts: &VerifyOptions) -> Verdict {
    let mut errors: Vec<String> = vec![];
    let mut untrusted: Vec<String> = vec![];
    let mut migration: Option<String> = None;
    let p = patterns();
    macro_rules! add {
        ($($arg:tt)*) => { errors.push(format!($($arg)*)) };
    }
    if !cert.is_object() {
        return Verdict { errors: vec!["not an object".into()], ..Default::default() };
    }

    if gstr(cert, "format") != Some(FORMAT) {
        add!("format must be {FORMAT}");
    }
    let sid_id = gstr(cert, "id");
    if !sid_id.map_or(false, |s| p.id.is_match(s) && s.chars().count() <= 96) {
        add!("id must match sid_<slug>");
    }
    let version = int(get(cert, "version"));
    if !is_int(get(cert, "version")) || version.map_or(true, |v| v < 1) {
        add!("version must be an integer >= 1");
    }
    if !gstr(cert, "status").map_or(false, |s| STATUSES.contains(&s)) {
        add!("status must be cast|live|suspended|retired");
    }
    if !is_time(get(cert, "born_at")) {
        add!("born_at must be RFC 3339 UTC (YYYY-MM-DDTHH:MM:SSZ)");
    }
    if !is_time(get(cert, "updated")) {
        add!("updated must be RFC 3339 UTC (YYYY-MM-DDTHH:MM:SSZ)");
    } else if is_time(get(cert, "born_at")) && gstr(cert, "updated") < gstr(cert, "born_at") {
        add!("updated must not be before born_at");
    }

    match get(cert, "identity") {
        Some(ident) if ident.is_object() => {
            if !nonempty_str(get(ident, "name")) {
                add!("identity.name is required");
            }
            if gstr(ident, "type") != Some("agent") {
                add!("identity.type must be \"agent\"");
            }
            if let Some(parent) = get(ident, "parent").filter(|v| !v.is_null()) {
                if !parent.as_str().map_or(false, |s| p.id.is_match(s)) {
                    add!("identity.parent must be a sid id or null");
                }
            }
        }
        _ => add!("identity is required"),
    }

    // bindings: typed public keys, each proving possession of its key
    let sid_text = sid_id.unwrap_or("None");
    let empty = vec![];
    let bindings: &Vec<Value> = match get(cert, "bindings") {
        None => &empty,
        Some(Value::Array(a)) => a,
        Some(_) => {
            add!("bindings must be an array");
            &empty
        }
    };
    let mut seen: HashSet<String> = HashSet::new();
    for (i, b) in bindings.iter().enumerate() {
        let w = format!("bindings[{i}]");
        if !b.is_object() {
            add!("{w} must be an object");
            continue;
        }
        match gstr(b, "id").filter(|s| p.slug.is_match(s)) {
            None => add!("{w}.id must be a slug"),
            Some(id) => {
                if !seen.insert(id.to_string()) {
                    add!("{w}.id {id} is used twice");
                }
            }
        }
        let btype = gstr(b, "type");
        if !btype.map_or(false, |s| p.slug.is_match(s)) {
            add!("{w}.type must be a slug");
        }
        let alg = gstr(b, "alg").filter(|a| sigs::ALGS.contains(a));
        match alg {
            None => add!("{w}.alg must be one of {}", sigs::ALGS.join("|")),
            Some(a) => {
                if let Some(required) = btype.and_then(binding_alg) {
                    if required != a {
                        add!("{w}: a {} binding must use {required}", btype.unwrap());
                    }
                }
            }
        }
        if !is_hex64(get(b, "public_key")) {
            add!("{w}.public_key must be 64-hex");
        }
        if !is_time(get(b, "added_at")) {
            add!("{w}.added_at must be RFC 3339 UTC");
        }
        match gstr(b, "proof").filter(|s| p.hex128.is_match(s)) {
            None => add!("{w}.proof must be a 128-hex signature"),
            Some(proof) => {
                let alg_text = gstr(b, "alg").unwrap_or("None");
                let key_text = gstr(b, "public_key").unwrap_or("None");
                if !sigs::verify(alg_text, key_text, &bind_message(sid_text, b), proof) {
                    add!("{w}: proof of possession does not verify");
                }
            }
        }
    }

    match get(cert, "extensions") {
        None | Some(Value::Null) => {}
        Some(Value::Object(ext)) => {
            for (ns, val) in ext {
                if !p.ns.is_match(ns) || !val.is_object() {
                    add!("extensions.{ns} must be a namespaced object");
                }
            }
        }
        Some(_) => add!("extensions must be an object"),
    }

    match gstr(cert, "hash") {
        Some(h) if p.hex64.is_match(h) => {
            if sid_hash(cert) != h {
                add!("hash does not match the canonical body");
            }
        }
        _ => add!("hash must be 64-hex"),
    }
    match gstr(cert, "acting_hash") {
        Some(a) if p.hex64.is_match(a) => {
            if acting_hash(cert) != a {
                add!("acting_hash does not match the acting keys");
            }
        }
        _ => add!("acting_hash must be 64-hex"),
    }

    if version == Some(1) {
        if get(cert, "previous_version").map_or(false, |v| !v.is_null()) {
            add!("v1 must have previous_version = null");
        }
        if !matches!(get(cert, "previous_hash"), None | Some(Value::Null)) && gstr(cert, "previous_hash") != Some("none") {
            add!("v1 must have previous_hash = \"none\"");
        }
    } else if let Some(v) = version {
        if int(get(cert, "previous_version")) != Some(v - 1) {
            add!("previous_version must be version - 1");
        }
        if !gstr(cert, "previous_hash").map_or(false, |h| p.hex64.is_match(h)) {
            add!("previous_hash must be 64-hex for v>1");
        }
    }

    let mut history: Vec<Value> = vec![];
    match get(cert, "lifecycle") {
        Some(life) if life.is_object() => {
            if gstr(life, "state") != gstr(cert, "status") {
                add!("lifecycle.state must equal status");
            }
            match get(life, "history") {
                None => {}
                Some(Value::Array(h)) => {
                    let valid = h.iter().all(|e| {
                        e.is_object()
                            && gstr(e, "state").map_or(false, |s| STATUSES.contains(&s))
                            && is_time(get(e, "at"))
                    });
                    if valid {
                        history = h.clone();
                    } else {
                        add!("lifecycle.history must be an array of {{state, at}}");
                    }
                }
                Some(_) => add!("lifecycle.history must be an array of {{state, at}}"),
            }
        }
        _ => add!("lifecycle is required"),
    }

    if let Some(prev) = opts.previous.filter(|v| v.is_object()) {
        if !same(get(cert, "previous_hash"), get(prev, "hash")) {
            add!("previous_hash does not match the hash of the supplied previous version");
        }
        if version != Some(int(get(prev, "version")).unwrap_or(0) + 1) {
            add!("version is not previous.version + 1");
        }
        if !same(get(cert, "id"), get(prev, "id")) {
            add!("id differs from the previous version");
        }
        if !same(get(cert, "born_at"), get(prev, "born_at")) {
            add!("born_at differs from the previous version");
        }
        let issuer_of = |d: &Value| get(d, "issuer").and_then(|i| get(i, "id")).cloned();
        if issuer_of(cert) != issuer_of(prev) {
            add!("issuer.id differs from the previous version");
        }
        if gstr(prev, "status") == Some("retired") {
            add!("the previous version is retired; no further versions are allowed");
        }
        if is_time(get(cert, "updated")) && is_time(get(prev, "updated")) && gstr(cert, "updated") < gstr(prev, "updated") {
            add!("updated is earlier than the previous version");
        }
        if let Some(prev_history) = get(prev, "lifecycle").and_then(|l| get(l, "history")).and_then(Value::as_array) {
            if history.len() < prev_history.len() || history[..prev_history.len()] != prev_history[..] {
                add!("lifecycle.history does not extend the previous version's history");
            }
        }
    }

    let mut secrets = vec![];
    find_secrets(&body(cert), "", &mut secrets);
    for path in secrets {
        add!("{path} must not be present: certificates carry no secrets");
    }

    let issuer = issuer_check(cert, opts.trust, get(cert, "updated"));
    errors.extend(issuer.errors);
    untrusted.extend(issuer.untrusted);

    if let Some(migrated) = get(cert, "provenance").and_then(|p| get(p, "migrated_from")).filter(|v| !v.is_null()) {
        let well_formed = migrated.is_object()
            && gstr(migrated, "format") == Some(LEGACY_FORMAT)
            && get(migrated, "id").map_or(false, Value::is_string)
            && is_int(get(migrated, "version"))
            && is_hex64(get(migrated, "hash"));
        if !well_formed {
            add!("provenance.migrated_from must be {{format: sid/0.1, id, version, hash}}");
        } else if let Some(legacy) = opts.legacy.filter(|v| !v.is_null()) {
            let old = verify_legacy(legacy, None);
            if !old.ok {
                let first: Vec<&str> = old.errors.iter().take(2).map(String::as_str).collect();
                add!("the supplied sid/0.1 certificate does not verify: {}", first.join("; "));
            } else if !(same(get(legacy, "id"), get(migrated, "id"))
                && same(get(legacy, "version"), get(migrated, "version"))
                && same(get(legacy, "hash"), get(migrated, "hash")))
            {
                add!("provenance.migrated_from does not match the supplied sid/0.1 certificate");
            } else {
                migration = Some("verified".into());
            }
        } else {
            migration = Some("unchecked".into());
        }
    }

    if gstr(cert, "status") != Some("live") {
        untrusted.push(format!("status is {}, not live", gstr(cert, "status").unwrap_or("None")));
    }
    if let Some(head) = opts.head.filter(|h| h.is_object()) {
        if !(same(get(head, "version"), get(cert, "version")) && same(get(head, "hash"), get(cert, "hash"))) {
            untrusted.push("a newer version of this certificate is known".into());
        }
    }

    let ok = errors.is_empty();
    let trusted = ok && issuer.verified && untrusted.is_empty();
    Verdict { ok, trusted, errors, untrusted, migration }
}

// ── runtime statement ────────────────────────────────────────────────────────
pub fn verify_runtime(stmt: &Value, cert: &Value, trust: Option<&Value>, now: Option<&str>, head: Option<&Value>) -> Verdict {
    let mut errors: Vec<String> = vec![];
    let mut untrusted: Vec<String> = vec![];
    let p = patterns();
    macro_rules! add {
        ($($arg:tt)*) => { errors.push(format!($($arg)*)) };
    }
    if !stmt.is_object() {
        return Verdict { errors: vec!["not an object".into()], ..Default::default() };
    }
    let cert_result = verify_sid(cert, &VerifyOptions { trust, head, ..Default::default() });
    if !cert_result.ok {
        let first: Vec<&str> = cert_result.errors.iter().take(2).map(String::as_str).collect();
        return Verdict { errors: vec![format!("the certificate does not verify: {}", first.join("; "))], ..Default::default() };
    }
    untrusted.extend(cert_result.untrusted);

    if gstr(stmt, "format") != Some(RUNTIME_FORMAT) {
        add!("format must be {RUNTIME_FORMAT}");
    }
    if !same(get(stmt, "sid"), get(cert, "id")) {
        add!("sid does not name this certificate");
    }
    if !gstr(stmt, "runtime_id").map_or(false, |s| p.slug.is_match(s)) {
        add!("runtime_id must be a slug");
    }
    if !get(stmt, "adapter").map_or(false, |a| a.is_object() && nonempty_str(get(a, "kind"))) {
        add!("adapter must be {{kind, version?}}");
    }
    if !is_time(get(stmt, "issued_at")) || !is_time(get(stmt, "expires_at")) {
        add!("issued_at and expires_at must be RFC 3339 UTC");
    } else if gstr(stmt, "expires_at") <= gstr(stmt, "issued_at") {
        add!("expires_at must be after issued_at");
    }
    let issuer_of = |d: &Value| get(d, "issuer").and_then(|i| get(i, "id")).cloned();
    if issuer_of(stmt) != issuer_of(cert) {
        add!("a runtime statement must be signed by the certificate's issuer");
    }

    let by_id: std::collections::HashMap<&str, &Value> = get(cert, "bindings")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|b| gstr(b, "id").map(|id| (id, b))).collect())
        .unwrap_or_default();
    let endpoints = get(stmt, "endpoints").and_then(Value::as_array).filter(|a| !a.is_empty());
    match endpoints {
        None => add!("endpoints must be a non-empty array"),
        Some(eps) => {
            for (i, ep) in eps.iter().enumerate() {
                let w = format!("endpoints[{i}]");
                let etype = gstr(ep, "type").filter(|t| ENDPOINT_TYPES.contains(t));
                if !(ep.is_object() && etype.is_some() && nonempty_str(get(ep, "address"))) {
                    add!("{w} must be {{type, address}} with a known type");
                    continue;
                }
                let etype = etype.unwrap();
                let reference = get(ep, "binding").filter(|v| !v.is_null());
                let needs = endpoint_binding(etype);
                if let (Some(n), None) = (needs, reference) {
                    add!("{w}: a {etype} endpoint must name a {n} binding");
                }
                if let Some(r) = reference {
                    let rname = r.as_str().unwrap_or("");
                    match by_id.get(rname) {
                        None => add!("{w}: binding {} is not in the certificate", r.as_str().map(String::from).unwrap_or_else(|| r.to_string())),
                        Some(bound) => {
                            if let Some(n) = needs {
                                if gstr(bound, "type") != Some(n) {
                                    add!("{w}: a {etype} endpoint cannot use a {} binding", gstr(bound, "type").unwrap_or("None"));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let declared: HashSet<&str> = get(cert, "capabilities")
        .and_then(|c| get(c, "permissions"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    match get(stmt, "capabilities") {
        None => {}
        Some(Value::Array(caps)) if caps.iter().all(Value::is_string) => {
            let mut extra: Vec<&str> = caps.iter().filter_map(Value::as_str).filter(|c| !declared.contains(c)).collect();
            extra.sort();
            extra.dedup();
            if !extra.is_empty() {
                add!("capabilities exceed the certificate's permissions: {}", extra.join(", "));
            }
        }
        Some(_) => add!("capabilities must be an array of strings"),
    }

    match gstr(stmt, "hash") {
        Some(h) if p.hex64.is_match(h) => {
            if sid_hash(stmt) != h {
                add!("hash does not match the canonical body");
            }
        }
        _ => add!("hash must be 64-hex"),
    }
    let mut secrets = vec![];
    find_secrets(&body(stmt), "", &mut secrets);
    for path in secrets {
        add!("{path} must not be present: statements carry no secrets");
    }

    let issuer = issuer_check(stmt, trust, get(stmt, "issued_at"));
    errors.extend(issuer.errors);
    untrusted.extend(issuer.untrusted);

    match now {
        None => untrusted.push("no current time supplied; expiry not checked".into()),
        Some(n) if !patterns().time.is_match(n) => add!("now must be RFC 3339 UTC"),
        Some(n) => {
            if is_time(get(stmt, "issued_at")) && is_time(get(stmt, "expires_at")) {
                if n < gstr(stmt, "issued_at").unwrap() {
                    untrusted.push("the statement is not valid yet".into());
                } else if n >= gstr(stmt, "expires_at").unwrap() {
                    untrusted.push("the statement has expired".into());
                }
            }
        }
    }

    let ok = errors.is_empty();
    let trusted = ok && issuer.verified && untrusted.is_empty();
    Verdict { ok, trusted, errors, untrusted, migration: None }
}

// ── sid/0.1 (legacy) ─────────────────────────────────────────────────────────
fn legacy_acting_hash(cert: &Value) -> String {
    let mut acting = Map::new();
    for k in LEGACY_ACTING_KEYS {
        if let Some(v) = get(cert, k) {
            acting.insert(k.to_string(), v.clone());
        }
    }
    sha256_hex(&canonical_json(&Value::Object(acting)).unwrap_or_default())
}

/// sid/0.1 verification, used only to check the source of a migration. sid/0.1
/// carries no issuer signature, so nothing here ever makes a document trusted.
pub fn verify_legacy(cert: &Value, previous: Option<&Value>) -> Verdict {
    let mut errors: Vec<String> = vec![];
    let p = patterns();
    macro_rules! add {
        ($($arg:tt)*) => { errors.push(format!($($arg)*)) };
    }
    if !cert.is_object() {
        return Verdict { errors: vec!["not an object".into()], ..Default::default() };
    }
    if gstr(cert, "format") != Some(LEGACY_FORMAT) {
        add!("format must be {LEGACY_FORMAT}");
    }
    if !gstr(cert, "id").map_or(false, |s| p.id.is_match(s)) {
        add!("id must match sid_<slug>");
    }
    let version = int(get(cert, "version"));
    if !is_int(get(cert, "version")) || version.map_or(true, |v| v < 1) {
        add!("version must be an integer >= 1");
    }
    if !gstr(cert, "status").map_or(false, |s| STATUSES.contains(&s)) {
        add!("status must be cast|live|suspended|retired");
    }
    if !nonempty_str(get(cert, "born_at")) {
        add!("born_at is required");
    }

    match get(cert, "identity") {
        Some(ident) if ident.is_object() => {
            if gstr(ident, "type") != Some("agent") {
                add!("identity.type must be \"agent\"");
            }
            let primary = int(get(ident, "odu_primary"));
            let secondary = int(get(ident, "odu_secondary"));
            let in_range = |v: Option<i64>| v.map_or(false, |n| (0..=255).contains(&n));
            if !in_range(primary) {
                add!("identity.odu_primary must be 0-255");
            }
            if !in_range(secondary) {
                add!("identity.odu_secondary must be 0-255");
            }
            if let (Some(a), Some(b)) = (primary, secondary) {
                let expected = (a << 8) | b;
                if int(get(ident, "odu_link")) != Some(expected) {
                    add!("identity.odu_link does not match (odu_primary<<8|odu_secondary) {expected}");
                }
            }
            if let Some(cal) = get(ident, "calabash").filter(|v| !v.is_null()) {
                if !cal.is_object() {
                    add!("identity.calabash must be an object");
                } else {
                    let ints = ["id", "top", "bottom"].iter().all(|k| is_int(get(cal, k)));
                    if !ints {
                        add!("identity.calabash id/top/bottom must be integers");
                    } else if (int(get(cal, "id")), int(get(cal, "top")), int(get(cal, "bottom")))
                        != (int(get(ident, "odu_link")), primary, secondary)
                    {
                        add!("identity.calabash disagrees with the Odu fields");
                    }
                    if !nonempty_str(get(cal, "vessel")) {
                        add!("identity.calabash.vessel must name one of the 16 Action Vessels");
                    }
                }
            }
        }
        _ => add!("identity is required"),
    }

    match gstr(cert, "hash") {
        Some(h) if p.hex64.is_match(h) => {
            if hash_without(cert, &["hash"]).unwrap_or_default() != h {
                add!("hash does not match the canonical body");
            }
        }
        _ => add!("hash must be 64-hex"),
    }
    match gstr(cert, "acting_hash") {
        Some(a) if p.hex64.is_match(a) => {
            if legacy_acting_hash(cert) != a {
                add!("acting_hash does not match the acting keys");
            }
        }
        _ => add!("acting_hash must be 64-hex"),
    }

    if version == Some(1) {
        if get(cert, "previous_version").map_or(false, |v| !v.is_null()) {
            add!("v1 must have previous_version = null");
        }
        if !matches!(get(cert, "previous_hash"), None | Some(Value::Null)) && gstr(cert, "previous_hash") != Some("none") {
            add!("v1 must have previous_hash = \"none\"");
        }
    } else if let Some(v) = version {
        if int(get(cert, "previous_version")) != Some(v - 1) {
            add!("previous_version must be version - 1");
        }
        if !gstr(cert, "previous_hash").map_or(false, |h| p.hex64.is_match(h)) {
            add!("previous_hash must be 64-hex for v>1");
        }
    }
    if let Some(prev) = previous {
        if !same(get(cert, "previous_hash"), get(prev, "hash")) {
            add!("previous_hash does not match the hash of the supplied previous version");
        }
        if version != Some(int(get(prev, "version")).unwrap_or(0) + 1) {
            add!("version is not previous.version + 1");
        }
    }
    if let Some(life) = get(cert, "lifecycle").filter(|l| l.is_object()) {
        if let Some(state) = get(life, "state").filter(|s| !s.is_null()) {
            if Some(state) != get(cert, "status") {
                add!("lifecycle.state must equal status");
            }
        }
    }
    if let Some(t) = get(cert, "time").filter(|t| t.is_object()) {
        if get(t, "anchored") == Some(&Value::Bool(true)) {
            let proof_present = get(t, "ots_proof").map_or(false, |v| v.as_str().map_or(!v.is_null(), |s| !s.is_empty()));
            if !proof_present {
                add!("time.anchored = true requires time.ots_proof");
            }
            if gstr(t, "ots_status") != Some("complete") {
                add!("time.anchored = true requires time.ots_status = \"complete\"");
            }
            if gstr(t, "clock_source") != Some("okf") {
                add!("time.anchored = true requires time.clock_source = \"okf\"");
            }
        }
        if let Some(cal) = get(t, "calendar").filter(|v| !v.is_null()) {
            if !cal.is_object() {
                add!("time.calendar must be an object");
            } else {
                for k in ["epoch", "cycle", "phase"] {
                    if !int(get(cal, k)).map_or(false, |n| n >= 0) {
                        add!("time.calendar.{k} must be a non-negative integer");
                    }
                }
            }
        }
    }
    for forbidden in SECRET_KEYS.iter().take(5) {
        for section in ["genesis", "identity"] {
            if get(cert, section).map_or(false, |s| s.as_object().map_or(false, |m| m.contains_key(*forbidden))) {
                add!("{section} must not carry {forbidden}");
            }
        }
    }
    let ok = errors.is_empty();
    // sid/0.1 has no issuer signature: never trusted.
    Verdict { ok, trusted: false, errors, untrusted: vec![], migration: None }
}

/// A fixed example used by documentation and tests.
pub fn example_trust(issuer_id: &str, kid: &str, alg: &str, public_key: &str) -> Value {
    json!({"issuers": {issuer_id: {"keys": [{"kid": kid, "alg": alg, "public_key": public_key}]}}})
}
