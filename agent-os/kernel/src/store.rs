//! Durable state: the agent registry, pending decisions, grants, executions
//! and the audit chain.
//!
//! Every read and write is scoped by tenant. An id from another tenant does
//! not exist as far as a caller can tell.
//!
//! The audit log is append-only and hash-chained: each entry commits to the
//! one before it, so an edit, deletion or reordering is detectable by
//! `verify_audit`. It records ids, hashes, decisions and reasons. It never
//! records tool arguments, grants' signatures or any secret.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};

use crate::canonical::{canonical_json, sha256_hex};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("storage failure: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("audit chain is broken at entry {0}: {1}")]
    AuditBroken(i64, String),
    #[error("{0}")]
    Invalid(String),
}

pub struct Store {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone)]
pub struct AgentRow {
    pub org: String,
    pub sid: String,
    pub version: i64,
    pub hash: String,
    pub status: String,
    pub cert: Value,
    pub runtime: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct PendingRow {
    pub id: String,
    pub org: String,
    pub kind: String, // "user_confirmation" | "human_review"
    pub intent: Value,
    pub intent_hash: String,
    pub state: String, // pending | approved | denied | withdrawn
    pub created_at: String,
    pub expires_at: String,
    pub policy: Value,
}

#[derive(Debug, Clone)]
pub struct GrantRow {
    pub id: String,
    pub org: String,
    pub subject: String,
    pub expires_at: String,
    pub single_use: bool,
    pub used: bool,
    pub revoked: bool,
}

#[derive(Debug, Clone)]
pub struct ExecutionRow {
    pub id: String,
    pub org: String,
    pub idempotency_key: String,
    pub intent_hash: String,
    pub grant_id: String,
    pub executor: String,
    pub state: String, // pending | succeeded | failed
    pub result: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AuditEntry {
    pub seq: i64,
    pub ts: String,
    pub org: String,
    pub kind: String,
    pub subject: String,
    pub data: Value,
    pub prev_hash: String,
    pub hash: String,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS agents (
    org TEXT NOT NULL, sid TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL,
    status TEXT NOT NULL, cert TEXT NOT NULL, runtime TEXT, updated TEXT NOT NULL,
    PRIMARY KEY (org, sid)
);
CREATE TABLE IF NOT EXISTS pending (
    id TEXT PRIMARY KEY, org TEXT NOT NULL, kind TEXT NOT NULL, intent TEXT NOT NULL,
    intent_hash TEXT NOT NULL, policy TEXT NOT NULL, state TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, resolved_by TEXT, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS grants (
    id TEXT PRIMARY KEY, org TEXT NOT NULL, subject TEXT NOT NULL, issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL, single_use INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0, revoked_reason TEXT
);
CREATE TABLE IF NOT EXISTS executions (
    id TEXT PRIMARY KEY, org TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    intent_hash TEXT NOT NULL, grant_id TEXT NOT NULL, executor TEXT NOT NULL,
    state TEXT NOT NULL, result TEXT, started_at TEXT NOT NULL, finished_at TEXT,
    UNIQUE (org, idempotency_key)
);
CREATE TABLE IF NOT EXISTS audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, org TEXT NOT NULL,
    kind TEXT NOT NULL, subject TEXT NOT NULL, data TEXT NOT NULL,
    prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
"#;

pub const GENESIS: &str = "genesis";

fn entry_hash(prev: &str, ts: &str, org: &str, kind: &str, subject: &str, data: &Value) -> String {
    let body = json!({"ts": ts, "org": org, "kind": kind, "subject": subject, "data": data});
    sha256_hex(&format!("{prev}\n{}", canonical_json(&body).unwrap_or_default()))
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T, StoreError>) -> Result<T, StoreError> {
        let mut conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        f(&mut conn)
    }

    // ── audit (always called inside the caller's transaction) ───────────────
    fn append_audit(tx: &rusqlite::Transaction, ts: &str, org: &str, kind: &str, subject: &str, data: &Value) -> Result<String, StoreError> {
        let prev: String = tx
            .query_row("SELECT hash FROM audit ORDER BY seq DESC LIMIT 1", [], |r| r.get(0))
            .optional()?
            .unwrap_or_else(|| GENESIS.to_string());
        let hash = entry_hash(&prev, ts, org, kind, subject, data);
        tx.execute(
            "INSERT INTO audit (ts, org, kind, subject, data, prev_hash, hash) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![ts, org, kind, subject, canonical_json(data).unwrap_or_default(), prev, hash],
        )?;
        Ok(hash)
    }

    /// Record an event that has no other state change.
    pub fn audit(&self, ts: &str, org: &str, kind: &str, subject: &str, data: &Value) -> Result<String, StoreError> {
        self.with(|c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let h = Self::append_audit(&tx, ts, org, kind, subject, data)?;
            tx.commit()?;
            Ok(h)
        })
    }

    pub fn audit_entries(&self, org: Option<&str>) -> Result<Vec<AuditEntry>, StoreError> {
        self.with(|c| {
            let mut stmt = c.prepare("SELECT seq, ts, org, kind, subject, data, prev_hash, hash FROM audit ORDER BY seq")?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?, r.get::<_, String>(5)?, r.get::<_, String>(6)?, r.get::<_, String>(7)?))
            })?;
            let mut out = vec![];
            for row in rows {
                let (seq, ts, entry_org, kind, subject, data, prev_hash, hash) = row?;
                if org.map_or(true, |o| o == entry_org) {
                    out.push(AuditEntry { seq, ts, org: entry_org, kind, subject,
                        data: serde_json::from_str(&data).unwrap_or(Value::Null), prev_hash, hash });
                }
            }
            Ok(out)
        })
    }

    /// Recompute the whole chain. Returns the entry count and the head hash.
    pub fn verify_audit(&self) -> Result<(i64, String), StoreError> {
        let entries = self.audit_entries(None)?;
        let mut prev = GENESIS.to_string();
        for e in &entries {
            if e.prev_hash != prev {
                return Err(StoreError::AuditBroken(e.seq, "previous hash does not match".into()));
            }
            if entry_hash(&e.prev_hash, &e.ts, &e.org, &e.kind, &e.subject, &e.data) != e.hash {
                return Err(StoreError::AuditBroken(e.seq, "entry was altered".into()));
            }
            prev = e.hash.clone();
        }
        Ok((entries.len() as i64, prev))
    }

    // ── agents ──────────────────────────────────────────────────────────────
    pub fn agent(&self, org: &str, sid: &str) -> Result<Option<AgentRow>, StoreError> {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT org, sid, version, hash, status, cert, runtime FROM agents WHERE org=?1 AND sid=?2",
                params![org, sid],
                |r| {
                    Ok(AgentRow {
                        org: r.get(0)?, sid: r.get(1)?, version: r.get(2)?, hash: r.get(3)?, status: r.get(4)?,
                        cert: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or(Value::Null),
                        runtime: r.get::<_, Option<String>>(6)?.and_then(|s| serde_json::from_str(&s).ok()),
                    })
                },
            ).optional()?)
        })
    }

    pub fn put_agent(&self, ts: &str, row: &AgentRow, actor: &str) -> Result<(), StoreError> {
        self.with(|c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute(
                "INSERT INTO agents (org, sid, version, hash, status, cert, runtime, updated) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
                 ON CONFLICT(org, sid) DO UPDATE SET version=?3, hash=?4, status=?5, cert=?6, runtime=?7, updated=?8",
                params![row.org, row.sid, row.version, row.hash, row.status, row.cert.to_string(),
                        row.runtime.as_ref().map(Value::to_string), ts],
            )?;
            Self::append_audit(&tx, ts, &row.org, "identity.registered", &row.sid,
                &json!({"version": row.version, "hash": row.hash, "status": row.status, "by": actor}))?;
            tx.commit()?;
            Ok(())
        })
    }

    // ── pending decisions ───────────────────────────────────────────────────
    pub fn put_pending(&self, ts: &str, p: &PendingRow) -> Result<(), StoreError> {
        self.with(|c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute(
                "INSERT INTO pending (id, org, kind, intent, intent_hash, policy, state, created_at, expires_at) VALUES (?1,?2,?3,?4,?5,?6,'pending',?7,?8)",
                params![p.id, p.org, p.kind, p.intent.to_string(), p.intent_hash, p.policy.to_string(), p.created_at, p.expires_at],
            )?;
            Self::append_audit(&tx, ts, &p.org, "decision.pending", &p.id,
                &json!({"kind": p.kind, "intent_hash": p.intent_hash}))?;
            tx.commit()?;
            Ok(())
        })
    }

    pub fn pending(&self, org: &str, id: &str) -> Result<Option<PendingRow>, StoreError> {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT id, org, kind, intent, intent_hash, state, created_at, expires_at, policy FROM pending WHERE id=?1 AND org=?2",
                params![id, org],
                |r| {
                    Ok(PendingRow {
                        id: r.get(0)?, org: r.get(1)?, kind: r.get(2)?,
                        intent: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or(Value::Null),
                        intent_hash: r.get(4)?, state: r.get(5)?, created_at: r.get(6)?, expires_at: r.get(7)?,
                        policy: serde_json::from_str(&r.get::<_, String>(8)?).unwrap_or(Value::Null),
                    })
                },
            ).optional()?)
        })
    }

    /// Move a pending decision out of `pending`. Returns false if it was not pending.
    pub fn resolve_pending(&self, ts: &str, org: &str, id: &str, state: &str, by: &str) -> Result<bool, StoreError> {
        self.with(|c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let n = tx.execute(
                "UPDATE pending SET state=?1, resolved_by=?2, resolved_at=?3 WHERE id=?4 AND org=?5 AND state='pending'",
                params![state, by, ts, id, org],
            )?;
            if n == 1 {
                Self::append_audit(&tx, ts, org, "decision.resolved", id, &json!({"state": state, "by": by}))?;
            }
            tx.commit()?;
            Ok(n == 1)
        })
    }

    // ── grants ──────────────────────────────────────────────────────────────
    pub fn put_grant(&self, ts: &str, g: &GrantRow, intent_hash: &str) -> Result<(), StoreError> {
        self.with(|c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute(
                "INSERT INTO grants (id, org, subject, issued_at, expires_at, single_use) VALUES (?1,?2,?3,?4,?5,?6)",
                params![g.id, g.org, g.subject, ts, g.expires_at, g.single_use as i64],
            )?;
            Self::append_audit(&tx, ts, &g.org, "grant.issued", &g.id,
                &json!({"subject": g.subject, "expires_at": g.expires_at, "intent_hash": intent_hash}))?;
            tx.commit()?;
            Ok(())
        })
    }

    pub fn grant(&self, org: &str, id: &str) -> Result<Option<GrantRow>, StoreError> {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT id, org, subject, expires_at, single_use, used, revoked FROM grants WHERE id=?1 AND org=?2",
                params![id, org],
                |r| Ok(GrantRow { id: r.get(0)?, org: r.get(1)?, subject: r.get(2)?, expires_at: r.get(3)?,
                    single_use: r.get::<_, i64>(4)? != 0, used: r.get::<_, i64>(5)? != 0, revoked: r.get::<_, i64>(6)? != 0 }),
            ).optional()?)
        })
    }

    pub fn revoke_grant(&self, ts: &str, org: &str, id: &str, reason: &str, by: &str) -> Result<bool, StoreError> {
        self.with(|c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let n = tx.execute(
                "UPDATE grants SET revoked=1, revoked_reason=?1 WHERE id=?2 AND org=?3 AND revoked=0",
                params![reason, id, org],
            )?;
            if n == 1 {
                Self::append_audit(&tx, ts, org, "grant.revoked", id, &json!({"reason": reason, "by": by}))?;
            }
            tx.commit()?;
            Ok(n == 1)
        })
    }

    // ── executions ──────────────────────────────────────────────────────────
    pub fn execution_by_key(&self, org: &str, key: &str) -> Result<Option<ExecutionRow>, StoreError> {
        self.with(|c| Self::exec_by_key(c, org, key))
    }

    fn exec_by_key(c: &Connection, org: &str, key: &str) -> Result<Option<ExecutionRow>, StoreError> {
        Ok(c.query_row(
            "SELECT id, org, idempotency_key, intent_hash, grant_id, executor, state, result FROM executions WHERE org=?1 AND idempotency_key=?2",
            params![org, key],
            |r| Ok(ExecutionRow { id: r.get(0)?, org: r.get(1)?, idempotency_key: r.get(2)?, intent_hash: r.get(3)?,
                grant_id: r.get(4)?, executor: r.get(5)?, state: r.get(6)?, result: r.get(7)? }),
        ).optional()?)
    }

    pub fn execution(&self, org: &str, id: &str) -> Result<Option<ExecutionRow>, StoreError> {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT id, org, idempotency_key, intent_hash, grant_id, executor, state, result FROM executions WHERE id=?1 AND org=?2",
                params![id, org],
                |r| Ok(ExecutionRow { id: r.get(0)?, org: r.get(1)?, idempotency_key: r.get(2)?, intent_hash: r.get(3)?,
                    grant_id: r.get(4)?, executor: r.get(5)?, state: r.get(6)?, result: r.get(7)? }),
            ).optional()?)
        })
    }

    /// Atomically decide whether this call is the one permitted to execute.
    ///
    /// Returns `Permit::New` for the first call with an idempotency key (and
    /// consumes a single-use grant in the same transaction), `Permit::Existing`
    /// for any later call with the same key, and `Permit::Refused` for a
    /// revoked or already used grant, or a key reused for a different action.
    pub fn begin_execution(&self, ts: &str, org: &str, exec_id: &str, grant_id: &str, intent_hash: &str,
                           key: &str, executor: &str) -> Result<Permit, StoreError> {
        self.with(|c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some(existing) = Self::exec_by_key(&tx, org, key)? {
                tx.commit()?;
                if existing.intent_hash != intent_hash {
                    return Ok(Permit::Refused("idempotency key was already used for a different action".into()));
                }
                return Ok(Permit::Existing(existing));
            }
            let row: Option<(i64, i64, i64)> = tx
                .query_row("SELECT single_use, used, revoked FROM grants WHERE id=?1 AND org=?2", params![grant_id, org],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .optional()?;
            let Some((single_use, used, revoked)) = row else {
                return Ok(Permit::Refused("grant was not issued by this kernel".into()));
            };
            if revoked != 0 {
                Self::append_audit(&tx, ts, org, "execution.refused", grant_id, &json!({"why": "revoked", "key": key}))?;
                tx.commit()?;
                return Ok(Permit::Refused("grant has been revoked".into()));
            }
            if single_use != 0 && used != 0 {
                Self::append_audit(&tx, ts, org, "execution.refused", grant_id, &json!({"why": "already used", "key": key}))?;
                tx.commit()?;
                return Ok(Permit::Refused("grant has already been used".into()));
            }
            if single_use != 0 {
                tx.execute("UPDATE grants SET used=1 WHERE id=?1 AND org=?2", params![grant_id, org])?;
            }
            tx.execute(
                "INSERT INTO executions (id, org, idempotency_key, intent_hash, grant_id, executor, state, started_at) VALUES (?1,?2,?3,?4,?5,?6,'pending',?7)",
                params![exec_id, org, key, intent_hash, grant_id, executor, ts],
            )?;
            Self::append_audit(&tx, ts, org, "execution.permitted", exec_id,
                &json!({"grant": grant_id, "intent_hash": intent_hash, "executor": executor}))?;
            tx.commit()?;
            Ok(Permit::New(exec_id.to_string()))
        })
    }

    /// Move a pending execution to a terminal state. Returns the audit hash, or
    /// `Err(Invalid)` if it was not pending.
    pub fn finish_execution(&self, ts: &str, org: &str, id: &str, state: &str, result: &str) -> Result<String, StoreError> {
        self.with(|c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let n = tx.execute(
                "UPDATE executions SET state=?1, result=?2, finished_at=?3 WHERE id=?4 AND org=?5 AND state='pending'",
                params![state, result, ts, id, org],
            )?;
            if n != 1 {
                return Err(StoreError::Invalid("execution is not pending".into()));
            }
            let hash = Self::append_audit(&tx, ts, org, "execution.recorded", id,
                &json!({"state": state, "result_hash": sha256_hex(result)}))?;
            tx.commit()?;
            Ok(hash)
        })
    }
}

#[derive(Debug)]
pub enum Permit {
    New(String),
    Existing(ExecutionRow),
    Refused(String),
}
