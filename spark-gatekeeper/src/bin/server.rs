/// SparkGatekeeper approval surface server.
///
/// Environment variables:
///   BIND_ADDR   — listen address (default: 127.0.0.1:9100)
///   DB_PATH     — SQLite path      (default: ./spark_queue.db)
///   RP_ID       — WebAuthn RP ID   (default: localhost)
///   RP_ORIGIN   — WebAuthn origin  (default: http://localhost:9100)
use spark_gatekeeper::{
    gates::rhythm::{InMemoryRateLimitStore, RhythmGate},
    hold_queue::HoldQueue,
    SparkGatekeeper,
};
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:9100".into());
    let db_path = std::env::var("DB_PATH").unwrap_or_else(|_| "./spark_queue.db".into());
    let rp_id = std::env::var("RP_ID").unwrap_or_else(|_| "localhost".into());
    let rp_origin = std::env::var("RP_ORIGIN").unwrap_or_else(|_| "http://localhost:9100".into());

    let queue = Arc::new(HoldQueue::new(&db_path)?);
    let rate_store = Arc::new(InMemoryRateLimitStore::default());
    let rhythm = RhythmGate::new(rate_store);
    let gatekeeper = Arc::new(SparkGatekeeper::new(rhythm, queue));

    eprintln!("SparkGatekeeper approval surface listening on {bind_addr}");
    eprintln!("  WebAuthn RP: {rp_id} ({rp_origin})");
    eprintln!("  Queue DB:    {db_path}");
    eprintln!("  Setup:       POST /setup/challenge  →  POST /setup/finish");
    eprintln!("  Approve:     POST /held/:id/challenge  →  POST /held/:id/approve");

    let addr: std::net::SocketAddr = bind_addr.parse()?;
    spark_gatekeeper::serve(addr, gatekeeper, &rp_id, &rp_origin).await
}
