//! Single-use redemption tracker for pair JWTs.
//!
//! A pair JWT has a 5-minute TTL and must be usable only once — presenting
//! the same QR code twice must not pair a second device.  This module tracks
//! redeemed JTIs in a bounded, in-memory ring buffer.
//!
//! # Design
//!
//! - `parking_lot::Mutex<VecDeque<String>>` — no async overhead; the lock is
//!   held only for a linear scan + optional eviction, well under 1 µs.
//! - Cap of 256 entries covers the worst case: a burst of 256 pair attempts in
//!   the 5-minute TTL window (wildly over-provisioned for typical desktop use).
//! - Eviction is FIFO: when the deque is full, the oldest entry is dropped.
//!   Because pair tokens expire in 5 minutes, an evicted JTI can only be
//!   replayed if fewer than 256 newer tokens have been issued — practically
//!   impossible in normal operation.
//!
//! # Thread safety
//!
//! `RedemptionLru` is `Send + Sync`.  The `parking_lot::Mutex` ensures
//! exclusive access.  Callers may wrap it in `Arc` for shared ownership.

use parking_lot::Mutex;
use std::collections::VecDeque;

const CAP: usize = 256;

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

/// In-memory single-use tracker for pair JWT IDs (`jti`).
pub struct RedemptionLru {
    inner: Mutex<VecDeque<String>>,
}

impl RedemptionLru {
    /// Construct an empty tracker.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(VecDeque::with_capacity(CAP)),
        }
    }

    /// Attempt to mark `jti` as redeemed.
    ///
    /// Returns `true` if this is the **first** redemption (the caller should
    /// proceed with pairing).  Returns `false` if `jti` is already present
    /// (replay attack — reject the request).
    pub fn mark_redeemed(&self, jti: &str) -> bool {
        let mut deque = self.inner.lock();
        if deque.iter().any(|s| s == jti) {
            return false;
        }
        if deque.len() >= CAP {
            deque.pop_front();
        }
        deque.push_back(jti.to_string());
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

    #[test]
    fn first_redemption_returns_true() {
        let lru = RedemptionLru::new();
        assert!(lru.mark_redeemed("jti-1"));
    }

    #[test]
    fn second_redemption_returns_false() {
        let lru = RedemptionLru::new();
        assert!(lru.mark_redeemed("jti-1"));
        assert!(!lru.mark_redeemed("jti-1"));
    }

    #[test]
    fn different_jtis_are_independent() {
        let lru = RedemptionLru::new();
        assert!(lru.mark_redeemed("jti-a"));
        assert!(lru.mark_redeemed("jti-b"));
        // Both are now marked redeemed.
        assert!(!lru.mark_redeemed("jti-a"));
        assert!(!lru.mark_redeemed("jti-b"));
    }

    #[test]
    fn eviction_past_cap_allows_oldest_to_be_reinserted() {
        let lru = RedemptionLru::new();

        // Fill to capacity with jti-0 .. jti-255.
        for i in 0..CAP {
            assert!(lru.mark_redeemed(&format!("jti-{i}")));
        }
        assert_eq!(lru.len(), CAP);

        // Inserting one more evicts "jti-0" (oldest).
        assert!(lru.mark_redeemed("jti-overflow"));
        assert_eq!(lru.len(), CAP); // still at cap

        // "jti-0" was evicted so it can be re-inserted.
        assert!(
            lru.mark_redeemed("jti-0"),
            "evicted entry must be re-insertable"
        );
        // "jti-1" is still present (only the oldest was evicted).
        assert!(!lru.mark_redeemed("jti-1"));
    }

    #[test]
    fn cap_constant_is_256() {
        assert_eq!(CAP, 256);
    }

    #[test]
    fn fresh_tracker_has_zero_entries() {
        let lru = RedemptionLru::new();
        assert_eq!(lru.len(), 0);
    }
}
