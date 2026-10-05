/// Hold queue: durable SQLite store for escalated operations.
/// Approval surface is TypeScript (Human presents, never controls).
use crate::types::{GateContext, GateResult, Receipt, Verdict};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeldOperation {
    pub id: String,
    pub card_id: String,
    pub card_version: u32,
    pub acting_hash: String,
    pub action_id: String,
    pub action_json: String,
    pub trail_json: String,
    pub proposed_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub status: HoldStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HoldStatus {
    Pending,
    Approved,
    Denied,
    Expired,
}

pub struct HoldQueue {
    conn: Mutex<Connection>,
    /// How long a held operation stays open for approval (default: 24h).
    pub ttl: Duration,
}

impl HoldQueue {
    pub fn new(db_path: &str) -> rusqlite::Result<Self> {
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS held_operations (
                id           TEXT PRIMARY KEY,
                card_id      TEXT NOT NULL,
                card_version INTEGER NOT NULL,
                acting_hash  TEXT NOT NULL,
                action_id    TEXT NOT NULL,
                action_json  TEXT NOT NULL,
                trail_json   TEXT NOT NULL,
                proposed_at  TEXT NOT NULL,
                expires_at   TEXT NOT NULL,
                status       TEXT NOT NULL DEFAULT 'pending'
            );
            CREATE TABLE IF NOT EXISTS receipts (
                id                   TEXT PRIMARY KEY,
                card_id              TEXT NOT NULL,
                card_version         INTEGER NOT NULL,
                acting_hash          TEXT NOT NULL,
                action_id            TEXT NOT NULL,
                final_verdict_json   TEXT NOT NULL,
                trail_json           TEXT NOT NULL,
                previous_receipt_id  TEXT,
                minted_at            TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS webauthn_passkeys (
                user_id      TEXT PRIMARY KEY,
                passkey_json TEXT NOT NULL,
                updated_at   TEXT NOT NULL
            );",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
            ttl: Duration::hours(24),
        })
    }

    /// In-memory queue for tests.
    pub fn in_memory() -> rusqlite::Result<Self> {
        Self::new(":memory:")
    }

    /// Enqueue an escalated operation. Returns the held operation id.
    pub fn enqueue(&self, ctx: &GateContext, result: &GateResult) -> rusqlite::Result<String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let expires = now + self.ttl;
        let action_json = serde_json::to_string(&ctx.action).unwrap_or_default();
        let trail_json = serde_json::to_string(&result.trail).unwrap_or_default();

        self.conn.lock().unwrap().execute(
            "INSERT INTO held_operations
             (id, card_id, card_version, acting_hash, action_id, action_json, trail_json, proposed_at, expires_at, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending')",
            params![
                id,
                ctx.card.id,
                ctx.card.version,
                ctx.card.acting_hash,
                ctx.action.id,
                action_json,
                trail_json,
                now.to_rfc3339(),
                expires.to_rfc3339(),
            ],
        )?;
        Ok(id)
    }

    /// Approve a held operation (called after WebAuthn ceremony in the TS surface).
    /// Returns the minted receipt.
    pub fn approve(
        &self,
        hold_id: &str,
        previous_receipt_id: Option<String>,
    ) -> rusqlite::Result<Option<Receipt>> {
        let conn = self.conn.lock().unwrap();
        let rows: Option<(String, String, u32, String, String, String)> = conn
            .query_row(
                "SELECT id, card_id, card_version, acting_hash, action_id, trail_json
                 FROM held_operations WHERE id = ?1 AND status = 'pending'",
                params![hold_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .ok();

        let Some((id, card_id, card_version, acting_hash, action_id, trail_json)) = rows else {
            return Ok(None);
        };

        // Mark approved.
        conn.execute(
            "UPDATE held_operations SET status = 'approved' WHERE id = ?1",
            params![id],
        )?;

        let trail = serde_json::from_str(&trail_json).unwrap_or_default();
        let receipt_id = Uuid::new_v4().to_string();
        let now = Utc::now();

        conn.execute(
            "INSERT INTO receipts
             (id, card_id, card_version, acting_hash, action_id, final_verdict_json, trail_json, previous_receipt_id, minted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                receipt_id,
                card_id,
                card_version,
                acting_hash,
                action_id,
                r#"{"Allow":null}"#,
                trail_json,
                previous_receipt_id,
                now.to_rfc3339(),
            ],
        )?;

        Ok(Some(Receipt {
            id: receipt_id,
            card_id,
            card_version,
            acting_hash,
            action_id,
            final_verdict: Verdict::Allow,
            trail,
            previous_receipt_id: None,
            minted_at: now,
        }))
    }

    /// Deny a held operation (human denies or timeout expires).
    pub fn deny(&self, hold_id: &str) -> rusqlite::Result<bool> {
        let n = self.conn.lock().unwrap().execute(
            "UPDATE held_operations SET status = 'denied' WHERE id = ?1 AND status = 'pending'",
            params![hold_id],
        )?;
        Ok(n > 0)
    }

    /// Upsert the single registered approver passkey (serialized Passkey JSON).
    pub fn store_approver_passkey(&self, passkey_json: &str) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO webauthn_passkeys (user_id, passkey_json, updated_at)
             VALUES ('approver', ?1, ?2)
             ON CONFLICT(user_id) DO UPDATE SET passkey_json = ?1, updated_at = ?2",
            params![passkey_json, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Load the approver passkey JSON, if registered.
    pub fn load_approver_passkey(&self) -> rusqlite::Result<Option<String>> {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT passkey_json FROM webauthn_passkeys WHERE user_id = 'approver'",
                [],
                |row| row.get(0),
            )
            .ok()
            .map(Ok)
            .transpose()
    }

    /// Return all pending operations (for the TS approval surface to display).
    pub fn pending(&self) -> rusqlite::Result<Vec<HeldOperation>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, card_id, card_version, acting_hash, action_id, action_json, trail_json,
                    proposed_at, expires_at, status
             FROM held_operations WHERE status = 'pending' ORDER BY proposed_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(HeldOperation {
                id: row.get(0)?,
                card_id: row.get(1)?,
                card_version: row.get(2)?,
                acting_hash: row.get(3)?,
                action_id: row.get(4)?,
                action_json: row.get(5)?,
                trail_json: row.get(6)?,
                proposed_at: row.get::<_, String>(7)?.parse().unwrap_or_else(|_| Utc::now()),
                expires_at: row.get::<_, String>(8)?.parse().unwrap_or_else(|_| Utc::now()),
                status: serde_json::from_str(&format!(r#""{}""#, row.get::<_, String>(9)?))
                    .unwrap_or(HoldStatus::Pending),
            })
        })?;
        rows.collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Action, ActionKind, Card, GateResult, GateTrail, PolicySeed, ToolAllowlist};
    use chrono::Utc;

    const SANTINOS_V4_CARD: &str =
        include_str!("../tests/fixtures/dna_c1640d90_v4.json");
    const SANTINOS_V4_POLICY_SEED: &str =
        include_str!("../tests/fixtures/policy_seed_v4.json");
    const SANTINOS_V4_TOOL_ALLOWLIST: &str =
        include_str!("../tests/fixtures/tool_allowlist_v4.json");

    fn load() -> (Card, PolicySeed, ToolAllowlist) {
        (
            serde_json::from_str(SANTINOS_V4_CARD).unwrap(),
            serde_json::from_str(SANTINOS_V4_POLICY_SEED).unwrap(),
            serde_json::from_str(SANTINOS_V4_TOOL_ALLOWLIST).unwrap(),
        )
    }

    fn escalate_result(action_id: &str) -> GateResult {
        GateResult {
            action_id: action_id.into(),
            final_verdict: Verdict::Escalate { reason: "policy: approval_required".into() },
            trail: vec![GateTrail {
                principle: "polarity".to_string(),
                verdict: Verdict::Escalate { reason: "policy: approval_required".into() },
            }],
            receipt_id: Uuid::new_v4().to_string(),
            checked_at: Utc::now(),
        }
    }

    #[test]
    fn enqueue_and_approve_mints_receipt() {
        let (card, seed, tools) = load();
        let action = Action {
            id: "act_refund_test".into(),
            session_id: "sess".into(),
            kind: ActionKind::Act,
            tool: Some("refunds".into()),
            payload: serde_json::Value::Null,
            acting_hash: card.acting_hash.clone(),
            initiated_at: Utc::now(),
        };
        let ctx = GateContext { card, policy_seed: seed, tool_allowlist: tools, session: None, action };
        let result = escalate_result("act_refund_test");

        let queue = HoldQueue::in_memory().unwrap();
        let hold_id = queue.enqueue(&ctx, &result).unwrap();

        let pending = queue.pending().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].action_id, "act_refund_test");

        let receipt = queue.approve(&hold_id, None).unwrap();
        assert!(receipt.is_some(), "approve must return a receipt");
        assert!(matches!(receipt.unwrap().final_verdict, Verdict::Allow));

        // After approval, no longer pending.
        assert_eq!(queue.pending().unwrap().len(), 0);
    }

    #[test]
    fn deny_removes_from_pending() {
        let (card, seed, tools) = load();
        let action = Action {
            id: "act_deny_test".into(),
            session_id: "sess".into(),
            kind: ActionKind::Act,
            tool: Some("refunds".into()),
            payload: serde_json::Value::Null,
            acting_hash: card.acting_hash.clone(),
            initiated_at: Utc::now(),
        };
        let ctx = GateContext { card, policy_seed: seed, tool_allowlist: tools, session: None, action };
        let result = escalate_result("act_deny_test");

        let queue = HoldQueue::in_memory().unwrap();
        let hold_id = queue.enqueue(&ctx, &result).unwrap();
        queue.deny(&hold_id).unwrap();
        assert_eq!(queue.pending().unwrap().len(), 0);
    }
}
