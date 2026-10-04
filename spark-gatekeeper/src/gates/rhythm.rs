/// ASCENSION gate — rate limits, cooldowns, receipt chain continuity.
use crate::types::{GateContext, Verdict};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use chrono::{DateTime, Duration, Utc};

/// Shared rate-limit state. In production this lives in the hold_queue store;
/// here we provide an in-process implementation for the gate to call.
pub trait RateLimitStore: Send + Sync {
    /// Returns the number of actions for (session_id, action_kind) in the window.
    fn count_in_window(&self, session_id: &str, kind: &str, window: Duration) -> u32;
    /// Record a new action attempt.
    fn record(&self, session_id: &str, kind: &str);
    /// Returns the last deny time for (session_id), if any.
    fn last_deny_at(&self, session_id: &str) -> Option<DateTime<Utc>>;
    /// Record a deny event.
    fn record_deny(&self, session_id: &str);
}

/// In-memory implementation for tests and local runs.
#[derive(Default)]
pub struct InMemoryRateLimitStore {
    actions: Mutex<Vec<(String, String, DateTime<Utc>)>>,
    denies: Mutex<HashMap<String, DateTime<Utc>>>,
}

impl RateLimitStore for InMemoryRateLimitStore {
    fn count_in_window(&self, session_id: &str, kind: &str, window: Duration) -> u32 {
        let cutoff = Utc::now() - window;
        self.actions
            .lock()
            .unwrap()
            .iter()
            .filter(|(s, k, t)| s == session_id && k == kind && *t > cutoff)
            .count() as u32
    }

    fn record(&self, session_id: &str, kind: &str) {
        self.actions
            .lock()
            .unwrap()
            .push((session_id.into(), kind.into(), Utc::now()));
    }

    fn last_deny_at(&self, session_id: &str) -> Option<DateTime<Utc>> {
        self.denies.lock().unwrap().get(session_id).copied()
    }

    fn record_deny(&self, session_id: &str) {
        self.denies
            .lock()
            .unwrap()
            .insert(session_id.into(), Utc::now());
    }
}

pub struct RhythmGate {
    store: Arc<dyn RateLimitStore>,
    /// Max actions per session per minute.
    pub max_per_minute: u32,
    /// Cooldown after a deny (seconds).
    pub deny_cooldown_secs: i64,
}

impl RhythmGate {
    pub fn new(store: Arc<dyn RateLimitStore>) -> Self {
        Self {
            store,
            max_per_minute: 60,
            deny_cooldown_secs: 5,
        }
    }

    pub fn principle(&self) -> &'static str {
        "rhythm"
    }

    pub fn check(&self, ctx: &GateContext) -> Verdict {
        let session_id = &ctx.action.session_id;
        let kind_str = format!("{:?}", ctx.action.kind);

        // Cooldown after deny: no retry storms.
        if let Some(last_deny) = self.store.last_deny_at(session_id) {
            let elapsed = Utc::now() - last_deny;
            if elapsed < Duration::seconds(self.deny_cooldown_secs) {
                return Verdict::Deny {
                    reason: format!(
                        "cooldown active: {}s remaining after last denial",
                        self.deny_cooldown_secs - elapsed.num_seconds()
                    ),
                };
            }
        }

        // Rate limit: max actions per minute per session.
        let count = self.store.count_in_window(session_id, &kind_str, Duration::minutes(1));
        if count >= self.max_per_minute {
            return Verdict::Escalate {
                reason: format!(
                    "rate limit: {count} {kind_str} actions in the last minute (max {})",
                    self.max_per_minute
                ),
            };
        }

        Verdict::Allow
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Action, ActionKind, Card, GateContext, PolicySeed, ToolAllowlist};
    use chrono::Utc;
    use std::sync::Arc;

    const SANTINOS_V4_CARD: &str =
        include_str!("../../tests/fixtures/dna_c1640d90_v4.json");
    const SANTINOS_V4_POLICY_SEED: &str =
        include_str!("../../tests/fixtures/policy_seed_v4.json");
    const SANTINOS_V4_TOOL_ALLOWLIST: &str =
        include_str!("../../tests/fixtures/tool_allowlist_v4.json");

    fn load() -> (Card, PolicySeed, ToolAllowlist) {
        (
            serde_json::from_str(SANTINOS_V4_CARD).unwrap(),
            serde_json::from_str(SANTINOS_V4_POLICY_SEED).unwrap(),
            serde_json::from_str(SANTINOS_V4_TOOL_ALLOWLIST).unwrap(),
        )
    }

    fn action(card: &Card) -> Action {
        Action {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: "sess_rhythm".into(),
            kind: ActionKind::Act,
            tool: Some("kb.search".into()),
            payload: serde_json::Value::Null,
            acting_hash: card.acting_hash.clone(),
            initiated_at: Utc::now(),
        }
    }

    #[test]
    fn normal_rate_allows() {
        let (card, seed, tools) = load();
        let store = Arc::new(InMemoryRateLimitStore::default());
        let gate = RhythmGate::new(store.clone());
        let act = action(&card);
        let ctx = GateContext {
            card, policy_seed: seed, tool_allowlist: tools, session: None, action: act,
        };
        assert!(matches!(gate.check(&ctx), Verdict::Allow));
    }

    #[test]
    fn cooldown_after_deny_blocks_retry() {
        let (card, seed, tools) = load();
        let store = Arc::new(InMemoryRateLimitStore::default());
        store.record_deny("sess_rhythm");
        let gate = RhythmGate::new(store);
        let act = action(&card);
        let ctx = GateContext {
            card, policy_seed: seed, tool_allowlist: tools, session: None, action: act,
        };
        assert!(matches!(gate.check(&ctx), Verdict::Deny { .. }));
    }
}
