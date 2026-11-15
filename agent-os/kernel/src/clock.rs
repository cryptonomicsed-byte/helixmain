//! Time source. The kernel never reads the wall clock directly, so expiry
//! behaviour is testable and a manipulated clock is a single place to harden.

use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, SecondsFormat, TimeZone, Utc};

pub trait Clock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

/// A clock tests move by hand.
#[derive(Clone)]
pub struct ManualClock(Arc<Mutex<DateTime<Utc>>>);

impl ManualClock {
    pub fn at(rfc3339: &str) -> Self {
        Self(Arc::new(Mutex::new(parse(rfc3339).expect("valid test time"))))
    }
    pub fn advance(&self, seconds: i64) {
        let mut t = self.0.lock().unwrap();
        *t += Duration::seconds(seconds);
    }
}

impl Clock for ManualClock {
    fn now(&self) -> DateTime<Utc> {
        *self.0.lock().unwrap()
    }
}

/// `YYYY-MM-DDTHH:MM:SSZ` — the one spelling used on the wire, so string
/// comparison is time comparison.
pub fn fmt(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub fn parse(s: &str) -> Option<DateTime<Utc>> {
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%SZ")
        .ok()
        .map(|n| Utc.from_utc_datetime(&n))
}
