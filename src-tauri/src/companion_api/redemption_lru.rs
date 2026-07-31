//! Single-use redemption tracker for pair JWTs.
//!
//! A pair JWT has a 5-minute TTL and must be usable only once — presenting
//! the same QR code twice must not pair a second device.  This module tracks
//! redeemed JTIs keyed by their token's expiry.
//!
//! # Design
//!
//! - `parking_lot::Mutex<HashMap<String, i64>>` (`jti` → token `exp`, Unix
//!   seconds) — the lock is held only for a prune + lookup + insert, well under
//!   1 µs.
//! - **Eviction never precedes expiry.** On every call we prune entries whose
//!   token has already expired (`exp <= now`); a JTI is therefore only ever
//!   dropped *after* the token it guards can no longer verify. This is what
//!   makes single-use sound under load — the old fixed-size FIFO ring could
//!   evict a still-valid JTI once 256 newer tokens were issued, letting a
//!   captured pair JWT be replayed within its TTL. Keying on expiry closes
//!   that window.
//! - A high safety cap (`MAX_ENTRIES`) bounds memory against a pathological
//!   flood of *simultaneously-valid* tokens; reaching it requires far more
//!   issuances inside one 5-minute TTL than any real (or realistically
//!   adversarial) desktop sees, and even then the soonest-to-expire entry is
//!   the one dropped.
//!
//! # Thread safety
//!
//! `RedemptionLru` is `Send + Sync`.  The `parking_lot::Mutex` ensures
//! exclusive access.  Callers may wrap it in `Arc` for shared ownership.

use parking_lot::Mutex;
use std::collections::HashMap;

/// Safety ceiling on simultaneously-valid tracked JTIs. Only reached under a
/// flood of >4096 pair issuances within a single 5-minute TTL window.
const MAX_ENTRIES: usize = 4096;

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

/// In-memory single-use tracker for pair JWT IDs (`jti`), keyed by expiry.
pub struct RedemptionLru {
    /// `jti` → token expiry (Unix seconds).
    inner: Mutex<HashMap<String, i64>>,
}

impl RedemptionLru {
    /// Construct an empty tracker.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Attempt to mark `jti` (expiring at `exp_unix_secs`) as redeemed, relative
    /// to `now_unix_secs`.
    ///
    /// Returns `true` if this is the **first** redemption (the caller should
    /// proceed with pairing). Returns `false` if `jti` is already present and
    /// not yet expired (replay attack — reject the request).
    pub fn mark_redeemed(&self, jti: &str, exp_unix_secs: i64, now_unix_secs: i64) -> bool {
        let mut map = self.inner.lock();
        // Drop entries whose token has already expired — only ever evicting a
        // JTI after it can no longer verify keeps single-use sound.
        map.retain(|_, &mut exp| exp > now_unix_secs);
        if map.contains_key(jti) {
            return false;
        }
        if map.len() >= MAX_ENTRIES {
            // Pathological flood of still-valid tokens: shed the soonest to
            // expire so memory stays bounded.
            if let Some(victim) = map
                .iter()
                .min_by_key(|(_, &exp)| exp)
                .map(|(k, _)| k.clone())
            {
                map.remove(&victim);
            }
        }
        map.insert(jti.to_string(), exp_unix_secs);
        true
    }

    /// Number of JTIs currently tracked.  Exposed for testing.
    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.lock().len()
    }
}

impl Default for RedemptionLru {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // A pair token expires 5 min out; pick a `now` well inside the window.
    const NOW: i64 = 1_700_000_000;
    const EXP: i64 = NOW + 300;

    #[test]
    fn first_redemption_returns_true() {
        let lru = RedemptionLru::new();
        assert!(lru.mark_redeemed("jti-1", EXP, NOW));
    }

    #[test]
    fn second_redemption_returns_false() {
        let lru = RedemptionLru::new();
        assert!(lru.mark_redeemed("jti-1", EXP, NOW));
        assert!(!lru.mark_redeemed("jti-1", EXP, NOW));
    }

    #[test]
    fn different_jtis_are_independent() {
        let lru = RedemptionLru::new();
        assert!(lru.mark_redeemed("jti-a", EXP, NOW));
        assert!(lru.mark_redeemed("jti-b", EXP, NOW));
        assert!(!lru.mark_redeemed("jti-a", EXP, NOW));
        assert!(!lru.mark_redeemed("jti-b", EXP, NOW));
    }

    #[test]
    fn high_load_does_not_evict_a_still_valid_jti() {
        // The core fix for the replay-via-eviction bug: even after far more
        // than the old 256-entry cap of *still-valid* tokens are redeemed, an
        // earlier valid JTI must still be remembered (cannot be replayed).
        let lru = RedemptionLru::new();
        assert!(lru.mark_redeemed("jti-target", EXP, NOW));
        for i in 0..1000 {
            assert!(lru.mark_redeemed(&format!("jti-{i}"), EXP, NOW));
        }
        // The target is still tracked → replay rejected.
        assert!(!lru.mark_redeemed("jti-target", EXP, NOW));
    }

    #[test]
    fn expired_entries_are_pruned_and_become_reusable() {
        let lru = RedemptionLru::new();
        assert!(lru.mark_redeemed("jti-old", NOW + 10, NOW));
        // Advance past the token's expiry → the entry is pruned. (A fresh
        // token would carry a new jti anyway; this just proves no leak.)
        let later = NOW + 11;
        assert!(lru.mark_redeemed("jti-old", later + 300, later));
    }

    #[test]
    fn safety_cap_bounds_memory_under_flood() {
        let lru = RedemptionLru::new();
        // Insert MAX_ENTRIES + extra simultaneously-valid tokens.
        for i in 0..(MAX_ENTRIES + 50) {
            assert!(lru.mark_redeemed(&format!("flood-{i}"), EXP, NOW));
        }
        assert!(lru.len() <= MAX_ENTRIES, "memory must stay bounded");
    }

    #[test]
    fn fresh_tracker_has_zero_entries() {
        let lru = RedemptionLru::new();
        assert_eq!(lru.len(), 0);
    }
}
