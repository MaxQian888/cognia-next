//! Bounded de-duplication of inbound webhook event IDs (replay protection).
//!
//! Some platforms (notably Lark/Feishu) authenticate inbound events only with a
//! static verification token shared on every event — there is no per-request
//! HMAC over the body. A captured-and-replayed valid event would therefore be
//! re-accepted indefinitely, re-triggering the AI loop. Pairing a freshness
//! window (the platform's event timestamp must be recent) with this dedup of
//! recently-seen event IDs bounds the replay horizon.
//!
//! The guard is a process-global, fixed-capacity FIFO set keyed on
//! `"<platform>:<adapter_id>:<event_id>"`. FIFO eviction is acceptable here
//! because the freshness window is the primary bound: an event old enough to
//! have been evicted from this cache is already rejected by the timestamp
//! check. Mirrors the singleton style of `ws_terminal::WS_TERMINAL_REGISTRY`.

use std::collections::{HashSet, VecDeque};

use once_cell::sync::Lazy;
use parking_lot::Mutex;

/// Maximum number of recently-seen event IDs retained. Sized comfortably above
/// the number of distinct events expected within any freshness window.
const CAP: usize = 4096;

/// Process-global replay guard.
static GLOBAL: Lazy<ReplayGuard> = Lazy::new(ReplayGuard::new);

/// Accessor for the process-global replay guard.
pub fn global() -> &'static ReplayGuard {
    &GLOBAL
}

pub struct ReplayGuard {
    inner: Mutex<Inner>,
}

struct Inner {
    seen: HashSet<String>,
    order: VecDeque<String>,
}

impl ReplayGuard {
    fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                seen: HashSet::new(),
                order: VecDeque::new(),
            }),
        }
    }

    /// Record `key` as seen. Returns `true` if it is fresh (first time seen) and
    /// `false` if it is a replay (already recorded). The oldest entry is evicted
    /// once `CAP` is reached.
    pub fn check_and_record(&self, key: String) -> bool {
        let mut g = self.inner.lock();
        if g.seen.contains(&key) {
            return false;
        }
        if g.order.len() >= CAP {
            if let Some(old) = g.order.pop_front() {
                g.seen.remove(&old);
            }
        }
        g.seen.insert(key.clone());
        g.order.push_back(key);
        true
    }

    /// Test helper: number of retained keys.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.lock().order.len()
    }

    /// Test helper: whether no keys are retained.
    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.inner.lock().order.is_empty()
    }
}

impl Default for ReplayGuard {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_sight_is_fresh_second_is_replay() {
        let g = ReplayGuard::new();
        assert!(g.check_and_record("lark:a:evt-1".to_string()));
        assert!(!g.check_and_record("lark:a:evt-1".to_string()));
    }

    #[test]
    fn distinct_keys_are_all_fresh() {
        let g = ReplayGuard::new();
        assert!(g.check_and_record("lark:a:evt-1".to_string()));
        assert!(g.check_and_record("lark:a:evt-2".to_string()));
        assert!(g.check_and_record("lark:b:evt-1".to_string()));
        assert_eq!(g.len(), 3);
    }

    #[test]
    fn eviction_caps_retention_and_lets_evicted_key_reappear() {
        let g = ReplayGuard::new();
        for i in 0..CAP {
            assert!(g.check_and_record(format!("k:{i}")));
        }
        assert_eq!(g.len(), CAP);
        // One more insert evicts the oldest ("k:0").
        assert!(g.check_and_record("k:overflow".to_string()));
        assert_eq!(g.len(), CAP);
        // The evicted key is treated as fresh again — acceptable because the
        // freshness window is the primary replay bound.
        assert!(g.check_and_record("k:0".to_string()));
    }

    #[test]
    fn global_singleton_is_shared() {
        let key = "replay-guard-singleton-probe".to_string();
        // First record may be fresh or replay depending on prior tests touching
        // the same key; use a unique key and assert idempotent replay.
        let first = global().check_and_record(key.clone());
        let second = global().check_and_record(key.clone());
        // Whatever the first returned, the second must be a replay.
        let _ = first;
        assert!(!second);
    }
}
