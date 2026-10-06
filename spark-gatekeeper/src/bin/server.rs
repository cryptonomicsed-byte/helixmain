/// SparkGatekeeper approval surface server.
///
/// Environment variables:
///   BIND_ADDR             — listen address (default: 127.0.0.1:9100)
///   DB_PATH               — SQLite path      (default: ./spark_queue.db)
///   RP_ID                 — WebAuthn RP ID   (default: localhost)
///   RP_ORIGIN             — WebAuthn origin  (default: http://localhost:9100)
///   SPARK_CARD            — card JSON            } loaded once at startup to
///   SPARK_POLICY_SEED     — policy-seed.json     } enable POST /invoke. Unset →
///   SPARK_TOOL_ALLOWLIST  — tool-allowlist.json  } /invoke answers 503.
///   TOOL_BUS_URL          — MCP tool bus an `allow` verdict forwards to (optional)
use spark_gatekeeper::{
    api::LoadedPolicy,
    gates::rhythm::{InMemoryRateLimitStore, RhythmGate},
    hold_queue::HoldQueue,
    types::{Card, PolicySeed, ToolAllowlist},
    SparkGatekeeper,
};
use std::sync::Arc;

/// Load the card policy the gate engine judges against. Env is read once here,
/// never per request — a caller must not choose the policy that judges it.
fn load_policy() -> Option<LoadedPolicy> {
    let (card_p, seed_p, tool_p) = match (
        std::env::var("SPARK_CARD").ok(),
        std::env::var("SPARK_POLICY_SEED").ok(),
        std::env::var("SPARK_TOOL_ALLOWLIST").ok(),
    ) {
        (Some(a), Some(b), Some(c)) => (a, b, c),
        _ => {
            eprintln!("  Policy:      none loaded — POST /invoke will return 503");
            eprintln!("               set SPARK_CARD / SPARK_POLICY_SEED / SPARK_TOOL_ALLOWLIST");
            return None;
        }
    };

    fn read_json<T: serde::de::DeserializeOwned>(path: &str, what: &str) -> Option<T> {
        let raw = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("  Policy:      {what} unreadable ({path}: {e})");
                return None;
            }
        };
        match serde_json::from_str(&raw) {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!("  Policy:      {what} did not parse ({path}: {e})");
                None
            }
        }
    }

    let card: Card = read_json(&card_p, "card")?;
    let policy_seed: PolicySeed = read_json(&seed_p, "policy seed")?;
    let tool_allowlist: ToolAllowlist = read_json(&tool_p, "tool allowlist")?;

    eprintln!(
        "  Policy:      {} v{} loaded ({} rules, {} tools)",
        card.id,
        card.version,
        policy_seed.rules.len(),
        tool_allowlist.tools.len()
    );
    Some(LoadedPolicy { card, policy_seed, tool_allowlist })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:9100".into());
    let db_path = std::env::var("DB_PATH").unwrap_or_else(|_| "./spark_queue.db".into());
    let rp_id = std::env::var("RP_ID").unwrap_or_else(|_| "localhost".into());
    let rp_origin = std::env::var("RP_ORIGIN").unwrap_or_else(|_| "http://localhost:9100".into());
    let tool_bus_url = std::env::var("TOOL_BUS_URL").unwrap_or_default();

    let queue = Arc::new(HoldQueue::new(&db_path)?);
    let rate_store = Arc::new(InMemoryRateLimitStore::default());
    let rhythm = RhythmGate::new(rate_store);
    let gatekeeper = Arc::new(SparkGatekeeper::new(rhythm, queue));

    eprintln!("SparkGatekeeper approval surface listening on {bind_addr}");
    eprintln!("  WebAuthn RP: {rp_id} ({rp_origin})");
    eprintln!("  Queue DB:    {db_path}");
    eprintln!("  Setup:       POST /setup/challenge  →  POST /setup/finish");
    eprintln!("  Approve:     POST /held/:id/challenge  →  POST /held/:id/approve");
    eprintln!(
        "  Tool bus:    {}",
        if tool_bus_url.is_empty() { "(none configured)".to_string() } else { tool_bus_url.clone() }
    );

    let policy = load_policy();
    let addr: std::net::SocketAddr = bind_addr.parse()?;

    match policy {
        Some(policy) => {
            spark_gatekeeper::serve_with_policy(addr, gatekeeper, &rp_id, &rp_origin, policy, tool_bus_url)
                .await
        }
        None => spark_gatekeeper::serve(addr, gatekeeper, &rp_id, &rp_origin).await,
    }
}
