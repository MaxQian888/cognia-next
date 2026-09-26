//! Bounded in-memory replay cache for short-lived signed assertions.
//!
//! Entries are retained until their assertion expires, so a replay cannot be
//! accepted merely because newer assertions arrived. Regular inserts do not
//! scan the cache for expired entries; the capacity check does that work only
//! when the cache fills, keeping cleanup off the request hot path. If every
//! retained assertion is still valid, the cache fails closed and rejects the
//! new assertion rather than weakening replay protection.

use parking_lot::Mutex;
use std::collections::HashMap;

const MAX_ENTRIES: usize = 4096;

pub struct ReplayCache {
    inner: Mutex<HashMap<String, i64>>,
}

impl ReplayCache {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Returns `true` only when `assertion_id` has not already been observed
    /// during its validity window.
    pub fn mark_redeemed(&self, assertion_id: &str, expires_at: i64, now: i64) -> bool {
        let mut entries = self.inner.lock();
        if let Some(existing_expiry) = entries.get(assertion_id).copied() {
            if existing_expiry > now {
                return false;
            }
            entries.remove(assertion_id);
        }
        if entries.len() >= MAX_ENTRIES {
            entries.retain(|_, expiry| *expiry > now);
            if entries.len() >= MAX_ENTRIES {
                return false;
            }
        }
        entries.insert(assertion_id.to_string(), expires_at);
        true
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.lock().len()
    }
}

impl Default for ReplayCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000;
    const EXPIRY: i64 = NOW + 300;

    #[test]
    fn rejects_replay_during_the_validity_window() {
        let cache = ReplayCache::new();
        assert!(cache.mark_redeemed("assertion-1", EXPIRY, NOW));
        assert!(!cache.mark_redeemed("assertion-1", EXPIRY, NOW));
    }

    #[test]
    fn prunes_expired_entries() {
        let cache = ReplayCache::new();
        assert!(cache.mark_redeemed("assertion-1", NOW + 1, NOW));
        assert!(cache.mark_redeemed("assertion-1", EXPIRY + 1, NOW + 2));
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn regular_insert_does_not_scan_unrelated_expired_entries() {
        let cache = ReplayCache::new();
        assert!(cache.mark_redeemed("expired", NOW + 1, NOW));
        assert!(cache.mark_redeemed("fresh", EXPIRY, NOW + 2));
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn rejects_new_assertions_when_all_entries_are_still_valid() {
        let cache = ReplayCache::new();
        for index in 0..MAX_ENTRIES {
            assert!(cache.mark_redeemed(&format!("assertion-{index}"), EXPIRY, NOW));
        }
        assert!(!cache.mark_redeemed("overflow", EXPIRY, NOW));
        assert!(!cache.mark_redeemed("assertion-0", EXPIRY, NOW));
        assert_eq!(cache.len(), MAX_ENTRIES);
    }

    #[test]
    fn prunes_expired_entries_at_capacity_before_accepting_a_new_assertion() {
        let cache = ReplayCache::new();
        assert!(cache.mark_redeemed("expired", NOW + 1, NOW));
        for index in 1..MAX_ENTRIES {
            assert!(cache.mark_redeemed(&format!("assertion-{index}"), EXPIRY, NOW));
        }

        assert!(cache.mark_redeemed("replacement", EXPIRY + 1, NOW + 2));
        assert_eq!(cache.len(), MAX_ENTRIES);
    }
}
