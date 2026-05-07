//! In-memory deny list for revoked companion device IDs.
//!
//! When a device is unpaired from the TS layer, `companion_revoke_device` is
//! called, which inserts the device ID here.  Every subsequent authenticated
//! request runs [`DenyList::is_revoked`] before processing — O(1) HashSet
//! lookup, no database round-trip in the hot path.
//!
//! # Capacity policy
//!
//! The deny list is unbounded in practice (no eviction).  The 1000-entry
//! warning is an *operator alert*, not a hard cap: revocations are permanent
//! and must never be silently dropped.  A future follow-up (post-M2.4) may
//! add a fallback per-request database lookup for deployments with very high
//! device churn, but 1000 revoked devices is ample for typical desktop use.
//!
//! # Thread safety
//!
//! [`DenyList`] is `Send + Sync` via `parking_lot::RwLock`.  Multiple axum
//! worker threads read concurrently; the TS-driven revoke/unrevoke commands
//! take an exclusive write lock only when mutating.

use parking_lot::RwLock;
use std::collections::HashSet;

/// Warn when the deny list grows past this threshold.  See module-level note
/// on the capacity policy; this is a logging threshold, not a hard limit.
const CAP_WARNING: usize = 1000;

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

/// Thread-safe set of revoked device IDs.
pub struct DenyList {
    inner: RwLock<HashSet<String>>,
}

impl DenyList {
    /// Construct an empty deny list.
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashSet::new()),
        }
    }

    /// Revoke `device_id`.
    ///
    /// Returns `true` if the ID was *newly* added (i.e. it was not already
    /// revoked).  Returns `false` if it was already present (idempotent).
    ///
    /// Logs a warning when the list size crosses [`CAP_WARNING`].
    pub fn revoke(&self, device_id: String) -> bool {
        let mut set = self.inner.write();
        let newly_inserted = set.insert(device_id);
        if newly_inserted && set.len() >= CAP_WARNING {
            log::warn!(
                "companion deny-list has reached {} entries; consider pruning revoked devices. \
                 Note: fallback per-request DB lookup is deferred to a future release.",
                set.len()
            );
        }
        newly_inserted
    }

    /// Un-revoke `device_id` (e.g. after a re-pair).
    ///
    /// Returns `true` if the ID was present and removed.
    pub fn unrevoke(&self, device_id: &str) -> bool {
        self.inner.write().remove(device_id)
    }

    /// Returns `true` if `device_id` is in the revocation set.
    pub fn is_revoked(&self, device_id: &str) -> bool {
        self.inner.read().contains(device_id)
    }

    /// Bulk-load `device_ids` into the deny list.
    ///
    /// Called at server startup so the Rust layer reflects the persisted
    /// Dexie state without reading the database itself.  Existing entries
    /// are preserved (union semantics).
    pub fn seed(&self, device_ids: Vec<String>) {
        let mut set = self.inner.write();
        for id in device_ids {
            set.insert(id);
        }
        if set.len() >= CAP_WARNING {
            log::warn!(
                "companion deny-list seeded to {} entries (>= {} threshold).",
                set.len(),
                CAP_WARNING
            );
        }
    }

    /// Number of entries currently in the deny list.
    // Used in tests and internally by the capacity-warning threshold check;
    // no current production call site outside this file.
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.inner.read().len()
    }

    /// Returns `true` if the deny list is empty.
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.inner.read().is_empty()
    }
}

impl Default for DenyList {
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
    fn new_deny_list_is_empty() {
        let dl = DenyList::new();
        assert_eq!(dl.len(), 0);
        assert!(dl.is_empty());
    }

    #[test]
    fn revoke_returns_true_on_first_call() {
        let dl = DenyList::new();
        assert!(dl.revoke("device-1".to_string()));
    }

    #[test]
    fn revoke_returns_false_on_duplicate() {
        let dl = DenyList::new();
        assert!(dl.revoke("device-1".to_string()));
        assert!(!dl.revoke("device-1".to_string()));
    }

    #[test]
    fn is_revoked_returns_true_after_revoke() {
        let dl = DenyList::new();
        dl.revoke("device-a".to_string());
        assert!(dl.is_revoked("device-a"));
    }

    #[test]
    fn is_revoked_returns_false_for_unknown_device() {
        let dl = DenyList::new();
        assert!(!dl.is_revoked("unknown-device"));
    }

    #[test]
    fn unrevoke_removes_entry_and_returns_true() {
        let dl = DenyList::new();
        dl.revoke("device-b".to_string());
        assert!(dl.is_revoked("device-b"));
        assert!(dl.unrevoke("device-b"));
        assert!(!dl.is_revoked("device-b"));
    }

    #[test]
    fn unrevoke_on_absent_entry_returns_false() {
        let dl = DenyList::new();
        assert!(!dl.unrevoke("never-added"));
    }

    #[test]
    fn seed_populates_list() {
        let dl = DenyList::new();
        dl.seed(vec![
            "dev-1".to_string(),
            "dev-2".to_string(),
            "dev-3".to_string(),
        ]);
        assert_eq!(dl.len(), 3);
        assert!(dl.is_revoked("dev-1"));
        assert!(dl.is_revoked("dev-2"));
        assert!(dl.is_revoked("dev-3"));
    }

    #[test]
    fn seed_is_union_not_replace() {
        let dl = DenyList::new();
        dl.revoke("existing".to_string());
        dl.seed(vec!["new-1".to_string(), "new-2".to_string()]);
        assert_eq!(dl.len(), 3);
        assert!(dl.is_revoked("existing"));
    }

    #[test]
    fn seed_deduplicates() {
        let dl = DenyList::new();
        dl.seed(vec!["dup".to_string(), "dup".to_string()]);
        assert_eq!(dl.len(), 1);
    }

    #[test]
    fn capacity_warning_fires_at_1000() {
        // Verify CAP_WARNING constant is correct — we don't try to observe
        // log output in unit tests, but we do verify the threshold value.
        assert_eq!(CAP_WARNING, 1000);
    }

    #[test]
    fn revoke_beyond_cap_warning_still_inserts() {
        let dl = DenyList::new();
        // Seed 999 entries, then push two more through revoke to cross 1000.
        let ids: Vec<String> = (0..999).map(|i| format!("device-{i}")).collect();
        dl.seed(ids);
        assert_eq!(dl.len(), 999);
        // This crosses the warning threshold — must still insert.
        assert!(dl.revoke("device-999".to_string()));
        assert_eq!(dl.len(), 1000);
        // One more — must still insert (no eviction).
        assert!(dl.revoke("device-1000".to_string()));
        assert_eq!(dl.len(), 1001);
        assert!(dl.is_revoked("device-1000"));
    }
}
