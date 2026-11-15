# Deploying HELIX (VPS, systemd)

Four services behind each other, all on loopback by default:

```
internet ─ TLS (your proxy, or the gateway's own) ─▶ gateway :8080 ─ gRPC ─▶ kernel :50051 ─ HTTP ─▶ policy :8181
                                                     metrics :9101              (SQLite, signing key)     (EDN rules)
internet ─ TLS ─▶ resolver :8081 (metrics :9102)     holds no signing key; serves signed QR contact resolutions
```

The orchestrator (`../orchestrator`) is a library your services embed; it needs a gateway token with the `proposer` role.

## First install

```bash
# build
(cd kernel && cargo build --release)
(cd gateway && go build -o /tmp/helix-bin/helix-gateway ./cmd/helix-gateway && go build -o /tmp/helix-bin/helix-resolver ./cmd/helix-resolver)
cp kernel/target/release/helix-kernel /tmp/helix-bin/
# java 17+ and curl must be installed (the policy service is Clojure on the JVM; its four jars are downloaded and SHA-256 checked)

sudo HELIX_ORG=org_yourcompany deploy/bootstrap.sh --bin /tmp/helix-bin
```

`bootstrap.sh` creates the `helix` user and `/etc/helix`, `/opt/helix`, `/var/lib/helix`; generates the kernel's grant-signing
key (mode 0600, **never regenerated**) and a principal registry with three operator service tokens in `/etc/helix/first-tokens.txt`
(**move them into your secret manager and delete the file**); writes the env files; installs the systemd units. It is idempotent: it
never overwrites a key, a registry, a trust file or an env file that exists.

Then, by hand, because only you know them:

1. **Trust anchors** (`/etc/helix/trust.json`): the issuers whose signatures count (`{"issuers": {"issuer:you": {"keys": [{"kid": "k1", "alg": "ed25519", "public_key": "<hex>", "not_before": "2026-01-01T00:00:00Z"}]}}}`). It starts **empty**: with no issuer nothing verifies as trusted, so no agent can be registered and no plugin installed. That is the safe default.
2. **Policy** (`/etc/helix/policy.edn`): start from the shipped defaults, edit, and check with `java -cp 'lib/*:src' clojure.main -m helix.policy.main --check /etc/helix/policy.edn`. The service re-reads it when it changes; an invalid file makes it **deny everything** and report unhealthy rather than keep the older, looser rules.
3. **Gateway TLS**: put a reverse proxy in front on 443 and keep the gateway on loopback, or set `HELIX_GATEWAY_TLS_CERT` / `_KEY` in `gateway.env` (the gateway refuses to listen off loopback without them).
4. **Resolver** (`resolver.env`): set `HELIX_RESOLVER_ORIGIN` (its public https origin, which is part of what the QR issuer signs) and `HELIX_RESOLVER_PUBLISH_TOKEN_SHA256`.
5. Per-person and per-service tokens: `helix-gateway mint-token --id tok_alice --org org_yourcompany --principal user:alice --kind user` prints the token **once** and the registry entry to add. Revoking a token is deleting its entry (effective within a second). A registry that becomes invalid authenticates **nobody** until fixed.

```bash
sudo systemctl enable --now helix.target
deploy/smoke.sh --prefix ""          # what a running install must answer
```

## Operating it

| | |
|---|---|
| **Smoke test** | `deploy/smoke.sh`: health, readiness, 401s, role checks, the metrics that alerts depend on. |
| **Metrics** | Prometheus text on **loopback only**: gateway `127.0.0.1:9101/metrics`, resolver `127.0.0.1:9102/metrics` (kernel health is exported through the gateway; the orchestrator's `Helix.Orchestrator.metrics/1` returns text for your service to expose). Scrape through your own proxy or tunnel. |
| **Alerts** | `deploy/prometheus/helix-alerts.yml` (14 alerts: kernel down, policy unavailable, registry invalid, 5xx rate, auth-failure spikes, rate limiting, load shedding, resolver stale or rejected, failed runs, lost leases). `deploy/check-alerts.py` fails if an alert names a metric no source file exports. |
| **Backup** | `deploy/backup.sh --prefix "" --out /secure/helix-$(date +%F).tar.gz`: SQLite online backup (safe while running), the grant key, trust anchors, principals, policy, env files, resolver store, run logs, with a SHA-256 manifest. **It contains secrets: encrypt it before it leaves the host.** |
| **Restore** | stop the stack, `deploy/restore.sh --prefix "" --from FILE`: verifies every file against the manifest and the database's integrity *before writing anything*, refuses over a live stack, keeps what it replaces as `*.before-restore`. |
| **Update** | build, `bootstrap.sh --bin` again (it only replaces programs and the policy source), `systemctl restart helix.target`. Kernel databases migrate themselves on open (columns added by migration). Plugin manifests are re-verified at every kernel start. |
| **Rotate the grant key** | generate a new key, keep the old public key in `HELIX_KERNEL_PREVIOUS_PUBLIC_KEYS` until its grants have expired (5 minutes by default), restart the kernel. |

## What is verified

`deploy/selftest.sh` (the `deploy-drill` release gate) does all of this in a throwaway directory with no root and no systemd, in about 20 s:
build, bootstrap (twice: the second run keeps the signing key), start, smoke, register an agent, do real routine work (a grant is
issued), confirm the metric counted it, **back up, destroy the kernel database, restore, restart, and prove the audit chain has the
same length and head and that grants are still signed by the same key**, and that a tampered backup is refused before anything is
written. `deploy/check-units.sh` verifies the systemd units with `systemd-analyze`.

## Not verified / not done

- **The systemd units have not been run under a real systemd** (this was developed in a container): they are syntax-checked and mirror the commands `run-stack.sh` runs, but `systemctl enable --now helix.target` on a real host is the first real test.
- **No Dockerfiles or compose file**: there was no Docker daemon to build or test them.
- **No nginx/Caddy configuration**: no proxy was available to test one. TLS can be terminated by the gateway itself.
- **No log shipping, tracing or dashboards** beyond the metrics and alert rules; logs are JSON on stdout (journald).
- **No automated off-host backup schedule**; `backup.sh` is the primitive (cron it, encrypt it, copy it away).
- **Vulnerability scanning of dependencies** (`govulncheck`, `cargo audit`) could not run here (their databases are not reachable); the release gate tries and reports SKIPPED.
- The orchestrator has no service wrapper (it embeds in your application).
