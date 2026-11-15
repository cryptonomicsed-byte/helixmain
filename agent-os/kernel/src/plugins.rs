//! The Wasm plugin host.
//!
//! A plugin is a WebAssembly COMPONENT (WIT world `helix:plugin/plugin`, see
//! `agent-os/plugins/wit`). Models, merchants and third parties can write
//! plugins, so the host treats every one as hostile code and gives it nothing:
//!
//! * **No effects.** The host offers `log`, and `kv-get`/`kv-set` for the
//!   plugin's own storage. There is no network, no filesystem, no environment,
//!   no process, no real clock, no real randomness, and no way to wait. A
//!   component that even IMPORTS sockets or http is refused at install.
//!   A tool's only way to affect the world is to PROPOSE an action intent in its
//!   output; the host never runs one and the caller still sends it through
//!   authorize / confirm / execute.
//! * **Signed.** A plugin installs only with a manifest signed by an issuer in
//!   the kernel's trust anchors, naming the SHA-256 of the exact component, its
//!   tools, its permissions and its limits. Unsigned, expired, tampered,
//!   untrusted: refused.
//! * **Bounded.** Fuel (instructions), wall-clock deadline (epoch), linear
//!   memory, table size, stack, input, output, stdout, intents, log lines,
//!   storage quota, concurrent invocations. A manifest may ask for less than the
//!   host's ceilings, never more.
//! * **Stateless between calls.** A fresh instance per invocation. Storage writes
//!   are buffered and committed only if the invocation succeeds.
//! * **Deterministic.** Wall clock is frozen at the kernel's time for the call;
//!   randomness is seeded from the call; monotonic time does not move.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use wasmtime::component::{Component, HasData, HasSelf, Linker, Resource, ResourceTable};
use wasmtime::{Config, Engine, ResourceLimiter, Store, Trap};
use wasmtime_wasi::p2::pipe::MemoryOutputPipe;
use wasmtime_wasi::p2::DynPollable;
use wasmtime_wasi::{Deterministic, HostWallClock, WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

use crate::clock::{self, Clock};
use crate::identity::check_signed_document;

wasmtime::component::bindgen!({
    path: "../plugins/wit",
    world: "plugin",
    imports: { default: trappable },
});

pub const MANIFEST_FORMAT: &str = "helix-plugin/1";
const EPOCH_MS: u64 = 10;
const STDIO_CAP: usize = 32 << 10;

/// What a plugin may ask for in its manifest, and the most the host will ever grant.
#[derive(Clone, Debug)]
pub struct Limits {
    pub fuel: u64,
    pub memory_bytes: usize,
    pub timeout_ms: u64,
    pub max_input: usize,
    pub max_output: usize,
    pub storage_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self { fuel: 50_000_000, memory_bytes: 32 << 20, timeout_ms: 2_000, max_input: 64 << 10, max_output: 64 << 10, storage_bytes: 256 << 10 }
    }
}

#[derive(Clone, Debug)]
pub struct Ceilings {
    pub limits: Limits,
    pub max_component_bytes: usize,
    pub max_tools: usize,
    pub max_intents: usize,
    pub max_log_lines: usize,
    pub max_concurrent: usize,
}

impl Default for Ceilings {
    fn default() -> Self {
        Self {
            limits: Limits { fuel: 2_000_000_000, memory_bytes: 256 << 20, timeout_ms: 10_000, max_input: 1 << 20, max_output: 1 << 20, storage_bytes: 4 << 20 },
            max_component_bytes: 8 << 20,
            max_tools: 64,
            max_intents: 16,
            max_log_lines: 200,
            max_concurrent: 8,
        }
    }
}

#[derive(Debug)]
pub enum PluginError {
    /// The request is malformed.
    Invalid(String),
    /// Install refused, and why. A normal answer, not a fault.
    Refused(Vec<String>),
    NotFound,
    /// Too many invocations at once.
    Busy,
    /// Known but not usable now (expired, no longer verifies).
    Unavailable(String),
}

/// How an invocation ended.
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Ok,
    /// The tool ran and returned an error of its own.
    ToolError,
    /// A limit stopped it: "fuel", "time", "memory", "stack", "output".
    LimitExceeded(String),
    /// The plugin trapped (panic, bad memory access, exit).
    Trapped,
    /// It returned something the host will not pass on (bad JSON, a forged intent, too large).
    InvalidOutput,
}

#[derive(Clone, Debug)]
pub struct Invocation {
    pub status: Status,
    pub result_json: String,
    pub proposed_intents: Vec<Value>,
    pub error: String,
    pub fuel_used: u64,
    pub millis: u64,
    pub plugin_hash: String,
    pub logs: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug)]
pub struct InstalledSummary {
    pub id: String,
    pub version: String,
    pub component_sha256: String,
    pub tools: Vec<ToolInfo>,
    pub permissions: Vec<String>,
    pub expires_at: String,
    pub replaced: bool,
}

/// Per-tenant, per-plugin key/value storage.
pub trait PluginStorage: Send + Sync {
    fn get(&self, org: &str, plugin: &str, key: &str) -> Result<Option<String>, String>;
    /// Bytes in use (keys + values).
    fn usage(&self, org: &str, plugin: &str) -> Result<usize, String>;
    /// Apply writes atomically; refuse if the result would exceed `max_bytes`.
    fn apply(&self, org: &str, plugin: &str, writes: &[(String, String)], max_bytes: usize) -> Result<(), String>;
}

#[derive(Default)]
pub struct MemoryStorage(Mutex<HashMap<(String, String), HashMap<String, String>>>);

impl PluginStorage for MemoryStorage {
    fn get(&self, org: &str, plugin: &str, key: &str) -> Result<Option<String>, String> {
        let g = self.0.lock().unwrap();
        Ok(g.get(&(org.into(), plugin.into())).and_then(|m| m.get(key).cloned()))
    }
    fn usage(&self, org: &str, plugin: &str) -> Result<usize, String> {
        let g = self.0.lock().unwrap();
        Ok(g.get(&(org.into(), plugin.into())).map_or(0, |m| m.iter().map(|(k, v)| k.len() + v.len()).sum()))
    }
    fn apply(&self, org: &str, plugin: &str, writes: &[(String, String)], max_bytes: usize) -> Result<(), String> {
        let mut g = self.0.lock().unwrap();
        let mut next = g.get(&(org.into(), plugin.into())).cloned().unwrap_or_default();
        for (k, v) in writes {
            next.insert(k.clone(), v.clone());
        }
        let total: usize = next.iter().map(|(k, v)| k.len() + v.len()).sum();
        if total > max_bytes {
            return Err("storage quota exceeded".into());
        }
        g.insert((org.into(), plugin.into()), next);
        Ok(())
    }
}

impl PluginStorage for crate::store::Store {
    fn get(&self, org: &str, plugin: &str, key: &str) -> Result<Option<String>, String> {
        self.kv_get(org, plugin, key).map_err(|e| e.to_string())
    }
    fn usage(&self, org: &str, plugin: &str) -> Result<usize, String> {
        self.kv_usage(org, plugin).map_err(|e| e.to_string())
    }
    fn apply(&self, org: &str, plugin: &str, writes: &[(String, String)], max_bytes: usize) -> Result<(), String> {
        self.kv_apply(org, plugin, writes, max_bytes).map_err(|e| e.to_string())
    }
}

// ── the manifest ─────────────────────────────────────────────────────────────

const MANIFEST_KEYS: &[&str] = &[
    "format", "id", "version", "name", "description", "component", "tools", "permissions", "limits", "issuer", "issued_at", "expires_at", "hash", "proof",
];
const LIMIT_KEYS: &[&str] = &["fuel", "memory_bytes", "timeout_ms", "max_input_bytes", "max_output_bytes", "storage_bytes"];
const PERMISSIONS: &[&str] = &["storage"];
const MAX_LOGGED: usize = 512;

fn tool_name_ok(s: &str) -> bool {
    s.len() <= 64 && s.chars().next().map_or(false, |c| c.is_ascii_lowercase()) && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

struct Manifest {
    id: String,
    version: String,
    sha256: String,
    tools: Vec<ToolInfo>,
    permissions: HashSet<String>,
    limits: Limits,
    expires_at: String,
    hash: String,
}

fn semver(v: &str) -> Option<(u64, u64, u64)> {
    let mut it = v.split('.');
    let (a, b, c) = (it.next()?, it.next()?, it.next()?);
    if it.next().is_some() || [a, b, c].iter().any(|p| p.is_empty() || p.len() > 9 || !p.chars().all(|c| c.is_ascii_digit()) || (p.len() > 1 && p.starts_with('0'))) {
        return None;
    }
    Some((a.parse().ok()?, b.parse().ok()?, c.parse().ok()?))
}

fn is_plugin_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().next().map_or(false, |c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-')
        && !s.ends_with('.')
}

fn is_time(s: &str) -> bool {
    clock::parse(s).is_some()
}

fn verify_manifest(raw: &Value, component: &[u8], trust: &Value, now: &str, c: &Ceilings) -> Result<Manifest, Vec<String>> {
    let mut problems: Vec<String> = vec![];
    let Some(obj) = raw.as_object() else { return Err(vec!["the manifest must be a JSON object".into()]) };
    let unknown: Vec<&str> = obj.keys().map(String::as_str).filter(|k| !MANIFEST_KEYS.contains(k)).collect();
    if !unknown.is_empty() {
        problems.push(format!("unknown field(s): {}", unknown.join(", ")));
    }
    if obj.get("format").and_then(Value::as_str) != Some(MANIFEST_FORMAT) {
        problems.push(format!("format must be {MANIFEST_FORMAT}"));
    }
    let id = obj.get("id").and_then(Value::as_str).unwrap_or("");
    if !is_plugin_id(id) {
        problems.push("id must be lowercase letters, digits, '.', '_' or '-' (at most 64)".into());
    }
    let version = obj.get("version").and_then(Value::as_str).unwrap_or("");
    if semver(version).is_none() {
        problems.push("version must be MAJOR.MINOR.PATCH".into());
    }
    let (issued, expires) = (obj.get("issued_at").and_then(Value::as_str).unwrap_or(""), obj.get("expires_at").and_then(Value::as_str).unwrap_or(""));
    if !is_time(issued) || !is_time(expires) {
        problems.push("issued_at and expires_at must be RFC 3339 UTC".into());
    } else if expires <= issued {
        problems.push("expires_at must be after issued_at".into());
    }
    // the component it names
    let comp = obj.get("component").and_then(Value::as_object);
    let sha = comp.and_then(|m| m.get("sha256")).and_then(Value::as_str).unwrap_or("");
    let size = comp.and_then(|m| m.get("size")).and_then(Value::as_u64);
    if comp.map_or(true, |m| m.len() != 2) || sha.len() != 64 || !sha.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) || size.is_none() {
        problems.push("component must be {sha256, size}".into());
    }
    // tools
    let mut tools = vec![];
    match obj.get("tools").and_then(Value::as_array) {
        Some(list) if !list.is_empty() && list.len() <= c.max_tools => {
            let mut seen = HashSet::new();
            for t in list {
                let name = t.get("name").and_then(Value::as_str).unwrap_or("");
                let desc = t.get("description").and_then(Value::as_str).unwrap_or("");
                if t.as_object().map_or(true, |m| m.keys().any(|k| k != "name" && k != "description")) || !tool_name_ok(name) || desc.len() > 512 || !seen.insert(name.to_string()) {
                    problems.push(format!("tool {name:?} is not valid (name [a-z][a-z0-9_]*, unique; description at most 512 characters)"));
                } else {
                    tools.push(ToolInfo { name: name.into(), description: desc.into() });
                }
            }
        }
        _ => problems.push(format!("tools must list between 1 and {} tools", c.max_tools)),
    }
    // permissions
    let mut permissions = HashSet::new();
    for p in obj.get("permissions").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        match p.as_str() {
            Some(s) if PERMISSIONS.contains(&s) => {
                permissions.insert(s.to_string());
            }
            _ => problems.push(format!("unknown permission {p}; the host offers only: {}", PERMISSIONS.join(", "))),
        }
    }
    if obj.get("permissions").map_or(false, |p| !p.is_array()) {
        problems.push("permissions must be a list".into());
    }
    // limits: ask for less, never more
    let mut limits = Limits::default();
    if let Some(l) = obj.get("limits") {
        match l.as_object() {
            None => problems.push("limits must be an object".into()),
            Some(m) => {
                for k in m.keys() {
                    if !LIMIT_KEYS.contains(&k.as_str()) {
                        problems.push(format!("unknown limit {k}"));
                    }
                }
                let ask = |k: &str, ceiling: u64, problems: &mut Vec<String>| -> Option<u64> {
                    let v = m.get(k)?;
                    match v.as_u64() {
                        Some(n) if (1..=ceiling).contains(&n) => Some(n),
                        _ => {
                            problems.push(format!("limits.{k} must be an integer from 1 to {ceiling} (the host's ceiling)"));
                            None
                        }
                    }
                };
                let ceil = &c.limits;
                if let Some(v) = ask("fuel", ceil.fuel, &mut problems) { limits.fuel = v; }
                if let Some(v) = ask("memory_bytes", ceil.memory_bytes as u64, &mut problems) { limits.memory_bytes = v as usize; }
                if let Some(v) = ask("timeout_ms", ceil.timeout_ms, &mut problems) { limits.timeout_ms = v; }
                if let Some(v) = ask("max_input_bytes", ceil.max_input as u64, &mut problems) { limits.max_input = v as usize; }
                if let Some(v) = ask("max_output_bytes", ceil.max_output as u64, &mut problems) { limits.max_output = v as usize; }
                if let Some(v) = ask("storage_bytes", ceil.storage_bytes as u64, &mut problems) { limits.storage_bytes = v as usize; }
            }
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }

    // the component is exactly the one that was signed
    if component.len() as u64 != size.unwrap() || sha256_hex_bytes(component) != sha {
        return Err(vec!["the component is not the one the manifest names (size or SHA-256 differs)".into()]);
    }
    // signature, issuer, window
    let check = check_signed_document(raw, Some(trust));
    problems.extend(check.errors);
    problems.extend(check.untrusted.into_iter().map(|u| format!("not trusted: {u}")));
    if problems.is_empty() {
        if now >= expires {
            problems.push("the manifest has expired".into());
        } else if clock::parse(issued).zip(clock::parse(now)).map_or(true, |(i, n)| i > n + chrono::Duration::minutes(5)) {
            problems.push("the manifest is not valid yet".into());
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    Ok(Manifest {
        id: id.into(), version: version.into(), sha256: sha.into(), tools, permissions, limits,
        expires_at: expires.into(), hash: obj.get("hash").and_then(Value::as_str).unwrap_or("").into(),
    })
}

fn sha256_hex_bytes(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

// ── the sandbox ──────────────────────────────────────────────────────────────

/// Linear memory, table and instance limits. When one is hit it says which, so
/// the failure is reported as a limit and not as an unexplained trap.
struct Limiter {
    memory_cap: usize,
    total: usize,
    hit: Option<&'static str>,
}

impl ResourceLimiter for Limiter {
    fn memory_growing(&mut self, current: usize, desired: usize, _max: Option<usize>) -> wasmtime::Result<bool> {
        let next = self.total.saturating_sub(current).saturating_add(desired);
        if next > self.memory_cap {
            self.hit = Some("memory");
            return Err(wasmtime::format_err!("memory limit exceeded"));
        }
        self.total = next;
        Ok(true)
    }
    fn table_growing(&mut self, _current: usize, desired: usize, _max: Option<usize>) -> wasmtime::Result<bool> {
        if desired > 100_000 {
            self.hit = Some("memory");
            return Err(wasmtime::format_err!("table limit exceeded"));
        }
        Ok(true)
    }
    fn instances(&self) -> usize { 64 }
    fn tables(&self) -> usize { 64 }
    fn memories(&self) -> usize { 16 }
}

struct FrozenWall(Duration);

impl HostWallClock for FrozenWall {
    fn resolution(&self) -> Duration {
        Duration::from_secs(1)
    }
    fn now(&self) -> Duration {
        self.0
    }
}

/// `wasi:clocks/monotonic-clock`, replaced: time does not move and nothing can
/// wait on it. (The stock implementation really sleeps, and a sleeping host call
/// is a call no deadline can interrupt.)
struct NoWait;
struct NoWaitView;

impl HasData for NoWait {
    type Data<'a> = NoWaitView;
}

impl wasmtime_wasi::p2::bindings::clocks::monotonic_clock::Host for NoWaitView {
    fn now(&mut self) -> wasmtime::Result<u64> {
        Ok(0)
    }
    fn resolution(&mut self) -> wasmtime::Result<u64> {
        Ok(1_000_000_000)
    }
    fn subscribe_instant(&mut self, _when: u64) -> wasmtime::Result<Resource<DynPollable>> {
        Err(wasmtime::format_err!("a plugin may not wait on time"))
    }
    fn subscribe_duration(&mut self, _d: u64) -> wasmtime::Result<Resource<DynPollable>> {
        Err(wasmtime::format_err!("a plugin may not wait on time"))
    }
}

struct State {
    wasi: WasiCtx,
    table: ResourceTable,
    limiter: Limiter,
    org: String,
    plugin: String,
    storage_permitted: bool,
    storage: Arc<dyn PluginStorage>,
    max_storage: usize,
    base_usage: usize,
    writes: Vec<(String, String)>,
    overlay: HashMap<String, String>,
    written: usize,
    ops: usize,
    logs: Vec<String>,
    log_bytes: usize,
    max_log_lines: usize,
}

impl WasiView for State {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView { ctx: &mut self.wasi, table: &mut self.table }
    }
}

impl State {
    fn deny(&self, what: &str) -> wasmtime::Error {
        wasmtime::format_err!("permission denied: {what} needs the `storage` permission in the manifest")
    }
}

impl helix::plugin::host::Host for State {
    fn log(&mut self, level: String, message: String) -> wasmtime::Result<()> {
        // Bounded: a flood is dropped, never an error and never memory.
        if self.logs.len() < self.max_log_lines && self.log_bytes < 32 << 10 {
            let level: String = level.chars().filter(|c| c.is_ascii_alphabetic()).take(8).collect();
            let message: String = message.chars().filter(|c| !c.is_control()).take(MAX_LOGGED).collect();
            self.log_bytes += message.len();
            self.logs.push(format!("{level}: {message}"));
        }
        Ok(())
    }

    fn kv_get(&mut self, key: String) -> wasmtime::Result<Option<String>> {
        if !self.storage_permitted {
            return Err(self.deny("kv-get"));
        }
        self.ops += 1;
        if self.ops > 1000 {
            return Err(wasmtime::format_err!("too many storage operations in one invocation"));
        }
        if let Some(v) = self.overlay.get(&key) {
            return Ok(Some(v.clone()));
        }
        self.storage.get(&self.org, &self.plugin, &key).map_err(|e| wasmtime::format_err!("storage: {e}"))
    }

    fn kv_set(&mut self, key: String, value: String) -> wasmtime::Result<Result<(), String>> {
        if !self.storage_permitted {
            return Err(self.deny("kv-set"));
        }
        self.ops += 1;
        if self.ops > 1000 {
            return Err(wasmtime::format_err!("too many storage operations in one invocation"));
        }
        if key.is_empty() || key.len() > 128 || !key.chars().all(|c| c.is_ascii_graphic()) {
            return Ok(Err("key must be 1 to 128 visible ASCII characters".into()));
        }
        if value.len() > 64 << 10 {
            return Ok(Err("value is larger than 64 KiB".into()));
        }
        let added = key.len() + value.len();
        if self.base_usage + self.written + added > self.max_storage {
            return Ok(Err("storage quota exceeded".into()));
        }
        self.written += added;
        self.overlay.insert(key.clone(), value.clone());
        self.writes.push((key, value));
        Ok(Ok(()))
    }
}

fn add_wasi(linker: &mut Linker<State>) -> wasmtime::Result<()> {
    use wasmtime_wasi::cli::{WasiCli, WasiCliView};
    use wasmtime_wasi::filesystem::{WasiFilesystem, WasiFilesystemView};
    use wasmtime_wasi::p2::bindings::{cli, clocks, filesystem, random, sync};
    use wasmtime_wasi::random::{WasiRandom, WasiRandomView};

    // What a Rust or C component built for WASI 0.2 asks for at start-up, and
    // nothing else: no sockets, no http, no instance-network.
    wasmtime_wasi::p2::add_to_linker_proxy_interfaces_sync(linker)?; // io, wall clock, random, stdio
    // Its monotonic clock really sleeps; ours does not move and cannot wait.
    linker.allow_shadowing(true);
    clocks::monotonic_clock::add_to_linker::<State, NoWait>(linker, |_| NoWaitView)?;
    linker.allow_shadowing(false);
    random::insecure::add_to_linker::<State, WasiRandom>(linker, <State as WasiRandomView>::random)?;
    random::insecure_seed::add_to_linker::<State, WasiRandom>(linker, <State as WasiRandomView>::random)?;
    filesystem::preopens::add_to_linker::<State, WasiFilesystem>(linker, <State as WasiFilesystemView>::filesystem)?;
    sync::filesystem::types::add_to_linker::<State, WasiFilesystem>(linker, <State as WasiFilesystemView>::filesystem)?;
    cli::exit::add_to_linker::<State, WasiCli>(linker, <State as WasiCliView>::cli)?;
    cli::environment::add_to_linker::<State, WasiCli>(linker, <State as WasiCliView>::cli)?;
    cli::terminal_input::add_to_linker::<State, WasiCli>(linker, <State as WasiCliView>::cli)?;
    cli::terminal_output::add_to_linker::<State, WasiCli>(linker, <State as WasiCliView>::cli)?;
    cli::terminal_stdin::add_to_linker::<State, WasiCli>(linker, <State as WasiCliView>::cli)?;
    cli::terminal_stdout::add_to_linker::<State, WasiCli>(linker, <State as WasiCliView>::cli)?;
    cli::terminal_stderr::add_to_linker::<State, WasiCli>(linker, <State as WasiCliView>::cli)?;
    Ok(())
}

// ── the host ─────────────────────────────────────────────────────────────────

struct Installed {
    manifest: Manifest,
    component: Component,
}

struct Ticker {
    stop: Arc<AtomicBool>,
}

impl Drop for Ticker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

pub struct PluginHost {
    engine: Engine,
    linker: Linker<State>,
    trust: Value,
    clock: Arc<dyn Clock>,
    ceilings: Ceilings,
    storage: Arc<dyn PluginStorage>,
    installed: RwLock<HashMap<(String, String), Arc<Installed>>>,
    running: Arc<AtomicUsize>,
    _ticker: Ticker,
}

struct Permit(Arc<AtomicUsize>);

impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn component_imports_ok(engine: &Engine, component: &Component) -> Result<(), Vec<String>> {
    const ALLOWED_PREFIXES: &[&str] = &["wasi:cli/", "wasi:io/", "wasi:clocks/", "wasi:random/", "wasi:filesystem/"];
    let mut bad = vec![];
    for (name, _) in component.component_type().imports(engine) {
        let host = name == "helix:plugin/host" || name.starts_with("helix:plugin/host@");
        if !host && !ALLOWED_PREFIXES.iter().any(|p| name.starts_with(p)) {
            bad.push(format!("the component imports {name}, which the host does not offer"));
        }
    }
    if bad.is_empty() { Ok(()) } else { Err(bad) }
}

impl PluginHost {
    pub fn new(storage: Arc<dyn PluginStorage>, trust: Value, clock: Arc<dyn Clock>, ceilings: Ceilings) -> Result<Self, String> {
        let mut cfg = Config::new();
        cfg.consume_fuel(true)
            .epoch_interruption(true)
            .wasm_component_model(true)
            .max_wasm_stack(512 << 10);
        let engine = Engine::new(&cfg).map_err(|e| format!("wasm engine: {e}"))?;
        let mut linker = Linker::<State>::new(&engine);
        add_wasi(&mut linker).map_err(|e| format!("wasi: {e}"))?;
        Plugin::add_to_linker::<State, HasSelf<State>>(&mut linker, |s| s).map_err(|e| format!("host: {e}"))?;

        // One thread advances the engine's epoch; every invocation sets its own deadline.
        let stop = Arc::new(AtomicBool::new(false));
        let (e, s) = (engine.clone(), stop.clone());
        std::thread::Builder::new()
            .name("helix-plugin-epoch".into())
            .spawn(move || {
                while !s.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(EPOCH_MS));
                    e.increment_epoch();
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            engine, linker, trust, clock, ceilings, storage,
            installed: RwLock::new(HashMap::new()), running: Arc::new(AtomicUsize::new(0)), _ticker: Ticker { stop },
        })
    }

    pub fn ceilings(&self) -> &Ceilings {
        &self.ceilings
    }

    fn now(&self) -> String {
        clock::fmt(self.clock.now())
    }

    /// Install (or upgrade) a plugin for a tenant. Everything is checked before
    /// any plugin code runs, and the plugin's `list-tools` (the first code that
    /// does run) is itself under limits.
    pub fn install(&self, org: &str, manifest_json: &str, component: &[u8]) -> Result<InstalledSummary, PluginError> {
        if component.len() > self.ceilings.max_component_bytes {
            return Err(PluginError::Refused(vec![format!("the component is larger than {} bytes", self.ceilings.max_component_bytes)]));
        }
        let raw: Value = serde_json::from_str(manifest_json).map_err(|e| PluginError::Invalid(format!("manifest_json: {e}")))?;
        let manifest = verify_manifest(&raw, component, &self.trust, &self.now(), &self.ceilings).map_err(PluginError::Refused)?;
        let key = (org.to_string(), manifest.id.clone());
        let replaced = {
            let installed = self.installed.read().unwrap_or_else(|p| p.into_inner());
            match installed.get(&key) {
                None => false,
                Some(old) if old.manifest.hash == manifest.hash => return Ok(summary(&old.manifest, false)),
                Some(old) => {
                    let (o, n) = (semver(&old.manifest.version).unwrap(), semver(&manifest.version).unwrap());
                    if n <= o {
                        return Err(PluginError::Refused(vec![format!(
                            "version {} is not newer than the installed {}: downgrades and re-signed copies of the same version are refused", manifest.version, old.manifest.version
                        )]));
                    }
                    true
                }
            }
        };

        let comp = Component::new(&self.engine, component).map_err(|e| PluginError::Refused(vec![format!("not a valid WebAssembly component: {}", first_line(&e))]))?;
        component_imports_ok(&self.engine, &comp).map_err(PluginError::Refused)?;

        // The tools the component says it has must be the tools the manifest signed.
        let probe = Limits { fuel: 20_000_000, memory_bytes: 32 << 20, timeout_ms: 1_000, max_input: 0, max_output: 0, storage_bytes: 0 };
        let listed = self.run(org, &manifest.id, &comp, &probe, false, "", &Run::ListTools)
            .map_err(|e| PluginError::Refused(vec![format!("the component could not list its tools: {e}")]))?;
        let Ran::Tools(mut names) = listed.0 else { unreachable!() };
        names.sort();
        let mut signed: Vec<String> = manifest.tools.iter().map(|t| t.name.clone()).collect();
        signed.sort();
        if names != signed {
            return Err(PluginError::Refused(vec![format!("the component's tools ({}) are not the manifest's ({})", names.join(", "), signed.join(", "))]));
        }

        let out = summary(&manifest, replaced);
        self.installed.write().unwrap_or_else(|p| p.into_inner()).insert(key, Arc::new(Installed { manifest, component: comp }));
        Ok(out)
    }

    pub fn list(&self, org: &str) -> Vec<InstalledSummary> {
        let installed = self.installed.read().unwrap_or_else(|p| p.into_inner());
        let mut out: Vec<_> = installed.iter().filter(|((o, _), _)| o == org).map(|(_, i)| summary(&i.manifest, false)).collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    pub fn remove(&self, org: &str, id: &str) -> bool {
        self.installed.write().unwrap_or_else(|p| p.into_inner()).remove(&(org.to_string(), id.to_string())).is_some()
    }

    /// Run one tool for `agent` in `org`.
    pub fn invoke(&self, org: &str, agent: &str, plugin: &str, tool: &str, input_json: &str) -> Result<Invocation, PluginError> {
        let installed = self.installed.read().unwrap_or_else(|p| p.into_inner()).get(&(org.to_string(), plugin.to_string())).cloned().ok_or(PluginError::NotFound)?;
        let m = &installed.manifest;
        if self.now().as_str() >= m.expires_at.as_str() {
            return Err(PluginError::Unavailable("the plugin's manifest has expired".into()));
        }
        if !m.tools.iter().any(|t| t.name == tool) {
            return Err(PluginError::Invalid(format!("{plugin} has no tool {tool}")));
        }
        if input_json.len() > m.limits.max_input {
            return Err(PluginError::Invalid(format!("input is larger than the plugin's limit of {} bytes", m.limits.max_input)));
        }
        if serde_json::from_str::<Value>(input_json).is_err() {
            return Err(PluginError::Invalid("input must be JSON".into()));
        }
        if self.running.fetch_add(1, Ordering::SeqCst) >= self.ceilings.max_concurrent {
            self.running.fetch_sub(1, Ordering::SeqCst);
            return Err(PluginError::Busy);
        }
        let _permit = Permit(self.running.clone());

        let nonce = sha256_hex_bytes(format!("{org}\n{agent}\n{plugin}\n{tool}\n{input_json}\n{}", self.now()).as_bytes());
        let started = Instant::now();
        let ran = self.run(org, plugin, &installed.component, &m.limits, m.permissions.contains("storage"), &nonce, &Run::Invoke { tool, input: input_json });
        let millis = started.elapsed().as_millis() as u64;

        let mut inv = Invocation {
            status: Status::Ok, result_json: String::new(), proposed_intents: vec![], error: String::new(),
            fuel_used: 0, millis, plugin_hash: m.hash.clone(), logs: vec![],
        };
        match ran {
            Err(f) => {
                inv.status = f.status;
                inv.error = f.message;
                inv.fuel_used = f.fuel_used;
                inv.logs = f.logs;
            }
            Ok((Ran::Tools(_), _)) => unreachable!(),
            Ok((Ran::Output(result, intents, tool_err), report)) => {
                inv.fuel_used = report.fuel_used;
                inv.logs = report.logs;
                if let Some(e) = tool_err {
                    inv.status = Status::ToolError;
                    inv.error = e;
                } else {
                    match self.check_output(org, agent, &nonce, &m.limits, &result, &intents) {
                        Ok(checked) => {
                            inv.result_json = result;
                            inv.proposed_intents = checked;
                            // Storage writes take effect only now that the invocation has succeeded and its output was accepted.
                            if !report.writes.is_empty() {
                                if let Err(e) = self.storage.apply(org, plugin, &report.writes, m.limits.storage_bytes) {
                                    inv.status = Status::LimitExceeded("storage".into());
                                    inv.error = e;
                                    inv.result_json.clear();
                                    inv.proposed_intents.clear();
                                }
                            }
                        }
                        Err(why) => {
                            inv.status = Status::InvalidOutput;
                            inv.error = why;
                        }
                    }
                }
            }
        }
        Ok(inv)
    }

    /// The host's checks on what a plugin returned. It never forwards anything it
    /// has not read: the result is JSON and bounded, and every proposed intent is
    /// a JSON object with known fields that names THIS tenant and THIS agent.
    fn check_output(&self, org: &str, agent: &str, nonce: &str, limits: &Limits, result: &str, intents: &[String]) -> Result<Vec<Value>, String> {
        const INTENT_KEYS: &[&str] = &[
            "id", "organization_id", "agent_id", "task_id", "capability", "tool", "target", "operation", "risk", "arguments", "amount_minor", "currency",
            "idempotency_key", "audience",
        ];
        if result.len() > limits.max_output {
            return Err(format!("the result is larger than the plugin's limit of {} bytes", limits.max_output));
        }
        if serde_json::from_str::<Value>(result).is_err() {
            return Err("the result is not JSON".into());
        }
        if intents.len() > self.ceilings.max_intents {
            return Err(format!("the plugin proposed {} intents; the limit is {}", intents.len(), self.ceilings.max_intents));
        }
        let mut out = vec![];
        let mut total = 0usize;
        for (i, text) in intents.iter().enumerate() {
            total += text.len();
            if total > limits.max_output {
                return Err("the proposed intents are larger than the plugin's output limit".into());
            }
            let Ok(Value::Object(mut m)) = serde_json::from_str::<Value>(text) else {
                return Err(format!("proposed intent {i} is not a JSON object"));
            };
            if let Some(k) = m.keys().find(|k| !INTENT_KEYS.contains(&k.as_str())) {
                return Err(format!("proposed intent {i} has an unknown field {k:?}"));
            }
            if m.get("capability").and_then(Value::as_str).map_or(true, str::is_empty) {
                return Err(format!("proposed intent {i} has no capability"));
            }
            // A plugin acts for the agent that invoked it, in the tenant it is installed for. It cannot name anyone else.
            match m.get("organization_id") {
                None => {}
                Some(v) if v.as_str() == Some(org) => {}
                Some(_) => return Err(format!("proposed intent {i} names another organization")),
            }
            match m.get("agent_id") {
                None => {}
                Some(v) if v.as_str() == Some(agent) => {}
                Some(_) => return Err(format!("proposed intent {i} names another agent")),
            }
            m.insert("organization_id".into(), json!(org));
            m.insert("agent_id".into(), json!(agent));
            m.entry("id").or_insert_with(|| json!(format!("plint_{}_{i}", &nonce[..16])));
            m.entry("idempotency_key").or_insert_with(|| json!(format!("plkey_{}_{i}", &nonce[..24])));
            out.push(Value::Object(m));
        }
        Ok(out)
    }

    fn run(&self, org: &str, plugin: &str, component: &Component, limits: &Limits, storage: bool, nonce: &str, what: &Run) -> Result<(Ran, Report), Failure> {
        let stdout = MemoryOutputPipe::new(STDIO_CAP);
        let stderr = MemoryOutputPipe::new(STDIO_CAP);
        let seed = Sha256::digest(nonce.as_bytes()).to_vec();
        let now = clock::parse(&self.now()).map(|t| Duration::from_secs(t.timestamp().max(0) as u64)).unwrap_or_default();
        let mut wasi = WasiCtxBuilder::new();
        wasi.stdout(stdout.clone())
            .stderr(stderr.clone())
            .wall_clock(FrozenWall(now))
            .secure_random(Deterministic::new(seed.clone()))
            .insecure_random(Deterministic::new(seed.clone()))
            .insecure_random_seed(u128::from_le_bytes(seed[..16].try_into().unwrap()));
        let state = State {
            wasi: wasi.build(), table: ResourceTable::new(),
            limiter: Limiter { memory_cap: limits.memory_bytes, total: 0, hit: None },
            org: org.into(), plugin: plugin.into(), storage_permitted: storage, storage: self.storage.clone(),
            max_storage: limits.storage_bytes,
            base_usage: if storage { self.storage.usage(org, plugin).unwrap_or(usize::MAX / 2) } else { 0 },
            writes: vec![], overlay: HashMap::new(), written: 0, ops: 0, logs: vec![], log_bytes: 0, max_log_lines: self.ceilings.max_log_lines,
        };
        let mut store = Store::new(&self.engine, state);
        store.limiter(|s| &mut s.limiter);
        let fail = |status: Status, message: String, store: &Store<State>| Failure {
            status, message, fuel_used: limits.fuel.saturating_sub(store.get_fuel().unwrap_or(0)), logs: store.data().logs.clone(),
        };
        if store.set_fuel(limits.fuel).is_err() {
            return Err(fail(Status::Trapped, "could not set fuel".into(), &store));
        }
        store.set_epoch_deadline((limits.timeout_ms / EPOCH_MS).max(1));
        store.epoch_deadline_trap();

        let outcome: wasmtime::Result<Ran> = (|| {
            let instance = Plugin::instantiate(&mut store, component, &self.linker)?;
            let tool = instance.helix_plugin_tool();
            match what {
                Run::ListTools => Ok(Ran::Tools(tool.call_list_tools(&mut store)?.into_iter().map(|t| t.name).collect())),
                Run::Invoke { tool: name, input } => Ok(match tool.call_invoke(&mut store, name, input)? {
                    Ok(out) => Ran::Output(out.result_json, out.proposed_intents, None),
                    Err(e) => Ran::Output(String::new(), vec![], Some(e.chars().filter(|c| !c.is_control()).take(1024).collect())),
                }),
            }
        })();

        let fuel_used = limits.fuel.saturating_sub(store.get_fuel().unwrap_or(0));
        let mut logs = store.data().logs.clone();
        for (label, pipe) in [("stdout", &stdout), ("stderr", &stderr)] {
            let text = String::from_utf8_lossy(&pipe.contents()).to_string();
            for line in text.lines().take(20) {
                logs.push(format!("{label}: {}", line.chars().filter(|c| !c.is_control()).take(MAX_LOGGED).collect::<String>()));
            }
        }
        match outcome {
            Ok(ran) => {
                let writes = std::mem::take(&mut store.data_mut().writes);
                Ok((ran, Report { fuel_used, logs, writes }))
            }
            Err(e) => {
                let (mut status, mut message) = classify(&e, store.data().limiter.hit);
                // A full stdout or stderr pipe fails the guest's own write; it panics and traps. Say which limit it was.
                let full = |p: &MemoryOutputPipe| p.contents().len() + 512 >= STDIO_CAP;
                if status == Status::Trapped && (full(&stdout) || full(&stderr)) {
                    status = Status::LimitExceeded("output".into());
                    message = "the plugin wrote too much to its standard output".into();
                }
                Err(Failure { status, message, fuel_used, logs })
            }
        }
    }
}

enum Run<'a> {
    ListTools,
    Invoke { tool: &'a str, input: &'a str },
}

enum Ran {
    Tools(Vec<String>),
    /// result_json, proposed intents, and the tool's own error if it returned one
    Output(String, Vec<String>, Option<String>),
}

struct Report {
    fuel_used: u64,
    logs: Vec<String>,
    writes: Vec<(String, String)>,
}

struct Failure {
    status: Status,
    message: String,
    fuel_used: u64,
    logs: Vec<String>,
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

fn first_line(e: &wasmtime::Error) -> String {
    e.to_string().lines().next().unwrap_or("").chars().take(200).collect()
}

/// Turn a trap into a status the caller can act on. The guest's own panic
/// message is not forwarded (it may name internals); the limit that was hit is.
fn classify(e: &wasmtime::Error, limiter_hit: Option<&'static str>) -> (Status, String) {
    if let Some(trap) = e.downcast_ref::<Trap>() {
        match trap {
            Trap::OutOfFuel => return (Status::LimitExceeded("fuel".into()), "the plugin ran out of fuel".into()),
            Trap::Interrupt => return (Status::LimitExceeded("time".into()), "the plugin ran past its deadline".into()),
            Trap::StackOverflow => return (Status::LimitExceeded("stack".into()), "the plugin overflowed its stack".into()),
            _ => {}
        }
    }
    if let Some(l) = limiter_hit {
        return (Status::LimitExceeded(l.into()), format!("the plugin exceeded its {l} limit"));
    }
    let text = format!("{e:#}");
    if text.contains("write beyond capacity") {
        return (Status::LimitExceeded("output".into()), "the plugin wrote too much to its standard output".into());
    }
    if text.contains("permission denied") {
        return (Status::Trapped, text.lines().find(|l| l.contains("permission denied")).unwrap_or("permission denied").trim().to_string());
    }
    (Status::Trapped, "the plugin trapped".into())
}

fn summary(m: &Manifest, replaced: bool) -> InstalledSummary {
    let mut permissions: Vec<String> = m.permissions.iter().cloned().collect();
    permissions.sort();
    InstalledSummary {
        id: m.id.clone(), version: m.version.clone(), component_sha256: m.sha256.clone(), tools: m.tools.clone(), permissions,
        expires_at: m.expires_at.clone(), replaced,
    }
}
