//! Short-TTL idempotency cache for inbound command POSTs. Keyed by the
//! caller-supplied `Idempotency-Key` header; a replay within the TTL returns
//! the cached runId so cron/CI double-fires don't double-execute.
//!
//! The window is intentionally short (5 minutes) — long enough to absorb a
//! retry storm or a cron double-tick, short enough to bound memory. Stale
//! entries are pruned lazily on lookup (no background sweeper needed for a
//! loopback control plane that sees low request volume).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

const TTL: Duration = Duration::from_secs(300);

struct CachedRun {
    run_id: String,
    stored_at: Instant,
}

pub struct IdempotencyCache {
    inner: Mutex<HashMap<String, CachedRun>>,
}

impl IdempotencyCache {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Returns the cached runId if the key was seen within the TTL. Prunes the
    /// entry if it has expired.
    pub fn get(&self, key: &str) -> Option<String> {
        let mut map = self.inner.lock();
        match map.get(key) {
            Some(entry) if entry.stored_at.elapsed() < TTL => Some(entry.run_id.clone()),
            Some(_) => {
                map.remove(key);
                None
            }
            None => None,
        }
    }

    /// Record a fresh run under the key.
    pub fn put(&self, key: String, run_id: String) {
        self.inner.lock().insert(
            key,
            CachedRun {
                run_id,
                stored_at: Instant::now(),
            },
        );
    }
}

impl Default for IdempotencyCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_returns_put_value() {
        let c = IdempotencyCache::new();
        assert_eq!(c.get("k"), None);
        c.put("k".into(), "run_1".into());
        assert_eq!(c.get("k"), Some("run_1".into()));
    }

    #[test]
    fn distinct_keys_are_independent() {
        let c = IdempotencyCache::new();
        c.put("a".into(), "run_a".into());
        c.put("b".into(), "run_b".into());
        assert_eq!(c.get("a"), Some("run_a".into()));
        assert_eq!(c.get("b"), Some("run_b".into()));
    }
}
