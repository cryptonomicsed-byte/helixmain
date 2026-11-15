//! helix-kernel: serve the kernel over gRPC.
//!
//!   helix-kernel serve               run the service (default)
//!   helix-kernel keygen <path>       write a new grant-signing key (mode 0600)
//!
//! Configuration is by environment; see agent-os/kernel/README.md. The kernel
//! never generates a signing key on its own: a key that changes on restart
//! would silently invalidate every grant, and a key nobody can find is a key
//! nobody can rotate.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use helix_kernel::clock::SystemClock;
use helix_kernel::grants::GrantSigner;
use helix_kernel::kernel::{Kernel, KernelConfig};
use helix_kernel::policy::{FixedPolicy, HttpPolicy, PolicyAnswer, PolicyClient};
use helix_kernel::service::KernelService;
use helix_kernel::store::Store;
use tonic::transport::{Certificate, Identity, Server, ServerTlsConfig};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn fail(msg: &str) -> ! {
    eprintln!("helix-kernel: {msg}");
    std::process::exit(2);
}

#[cfg(unix)]
fn check_private(path: &str) {
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(path).unwrap_or_else(|e| fail(&format!("cannot read {path}: {e}"))).permissions().mode();
    if mode & 0o077 != 0 {
        fail(&format!("{path} is readable by others (mode {:o}); run chmod 600", mode & 0o777));
    }
}
#[cfg(not(unix))]
fn check_private(_: &str) {}

fn keygen(path: &str) {
    use rand::RngCore;
    use std::io::Write;
    let mut secret = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut secret);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).unwrap_or_else(|e| fail(&format!("cannot create {path} (it must not exist): {e}")));
    writeln!(file, "{}", hex::encode(secret)).unwrap_or_else(|e| fail(&e.to_string()));
    let signer = GrantSigner::from_secret_hex(&hex::encode(secret)).unwrap();
    println!("wrote {path}\nkid:        {}\npublic key: {}", signer.kid(), signer.public_hex());
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("keygen") => return keygen(args.get(2).unwrap_or_else(|| fail("usage: helix-kernel keygen <path>"))),
        None | Some("serve") => {}
        Some(other) => fail(&format!("unknown command {other}")),
    }

    let key_path = env("HELIX_KERNEL_SIGNING_KEY_FILE").unwrap_or_else(|| fail("HELIX_KERNEL_SIGNING_KEY_FILE is required (create one with `helix-kernel keygen`)"));
    check_private(&key_path);
    let signer = GrantSigner::from_secret_hex(&std::fs::read_to_string(&key_path).unwrap_or_else(|e| fail(&format!("cannot read {key_path}: {e}"))))
        .unwrap_or_else(|e| fail(&e));
    let previous: Vec<String> = env("HELIX_KERNEL_PREVIOUS_PUBLIC_KEYS")
        .map(|s| s.split(',').map(|k| k.trim().to_string()).filter(|k| !k.is_empty()).collect())
        .unwrap_or_default();

    let trust_path = env("HELIX_KERNEL_TRUST_FILE").unwrap_or_else(|| fail("HELIX_KERNEL_TRUST_FILE is required (the sid trust anchors)"));
    let trust: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&trust_path).unwrap_or_else(|e| fail(&format!("cannot read {trust_path}: {e}"))))
        .unwrap_or_else(|e| fail(&format!("{trust_path} is not JSON: {e}")));

    let db = env("HELIX_KERNEL_DB").unwrap_or_else(|| "helix-kernel.sqlite".into());
    let store = Store::open(&db).unwrap_or_else(|e| fail(&format!("cannot open {db}: {e}")));

    let policy: Arc<dyn PolicyClient> = match env("HELIX_POLICY_URL") {
        Some(url) => Arc::new(HttpPolicy::new(&url, Duration::from_secs(2))),
        None => {
            eprintln!("helix-kernel: WARNING: HELIX_POLICY_URL is not set; every privileged action will be DENIED");
            Arc::new(FixedPolicy(PolicyAnswer::deny("no_policy", "no policy service is configured")))
        }
    };
    let num = |name: &str, default: i64| env(name).map(|v| v.parse::<i64>().unwrap_or_else(|_| fail(&format!("{name} must be an integer")))).unwrap_or(default);
    let cfg = KernelConfig {
        grant_ttl_secs: num("HELIX_KERNEL_GRANT_TTL_SECS", 300),
        pending_ttl_secs: num("HELIX_KERNEL_PENDING_TTL_SECS", 3600),
        auto_allow_max_amount_minor: num("HELIX_KERNEL_AUTO_ALLOW_MAX_AMOUNT_MINOR", 0),
    };
    eprintln!("helix-kernel: grant key {} ({} previous key(s) honoured)", signer.kid(), previous.len());
    let mut kernel = Kernel::new(store, signer, &previous, trust, policy, Arc::new(SystemClock), cfg).unwrap_or_else(|e| fail(&e));
    if env("HELIX_KERNEL_PLUGINS").map_or(false, |v| v == "on") {
        let loaded = kernel.enable_plugins(helix_kernel::plugins::Ceilings::default()).unwrap_or_else(|e| fail(&format!("plugin host: {e}")));
        eprintln!("helix-kernel: wasm plugin host on ({loaded} plugin(s) loaded)");
    }
    let kernel = Arc::new(kernel);

    let listen: SocketAddr = env("HELIX_KERNEL_LISTEN").unwrap_or_else(|| "127.0.0.1:50051".into()).parse().unwrap_or_else(|_| fail("HELIX_KERNEL_LISTEN must be host:port"));
    let mut server = Server::builder();
    match (env("HELIX_KERNEL_TLS_CERT"), env("HELIX_KERNEL_TLS_KEY"), env("HELIX_KERNEL_TLS_CLIENT_CA")) {
        (Some(cert), Some(key), Some(ca)) => {
            let read = |p: &str| std::fs::read(p).unwrap_or_else(|e| fail(&format!("cannot read {p}: {e}")));
            check_private(&key);
            let tls = ServerTlsConfig::new().identity(Identity::from_pem(read(&cert), read(&key))).client_ca_root(Certificate::from_pem(read(&ca)));
            server = server.tls_config(tls).unwrap_or_else(|e| fail(&format!("TLS configuration: {e}")));
            eprintln!("helix-kernel: mutual TLS required of every client");
        }
        (None, None, None) => {
            if !listen.ip().is_loopback() {
                fail("refusing to listen on a non-loopback address without TLS; set HELIX_KERNEL_TLS_CERT, _KEY and _CLIENT_CA");
            }
            eprintln!("helix-kernel: WARNING: no TLS; accepting loopback connections only");
        }
        _ => fail("HELIX_KERNEL_TLS_CERT, _KEY and _CLIENT_CA must all be set together"),
    }
    eprintln!("helix-kernel: listening on {listen}");
    let shutdown = async { let _ = tokio::signal::ctrl_c().await; };
    server
        .add_service(KernelService::new(kernel).into_server())
        .serve_with_shutdown(listen, shutdown)
        .await
        .unwrap_or_else(|e| fail(&format!("server error: {e}")));
}
