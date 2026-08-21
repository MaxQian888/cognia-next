//! Store-derived cache of companion devices that must be refused.
//!
//! # What this is, and what it is not
//!
//! The `SecurityStore` is the authority on a device's lifecycle. This is a
//! read cache in front of it, kept so the two hot paths that consult it — the
//! legacy bearer-JWT middleware and the WebRTC DataChannel dispatcher — do not
//! take a `Mutex<Connection>` round-trip per request.
//!
//! [`super::device_lifecycle::apply`] is the **only** writer. Nothing else may
//! call [`DenyList::revoke`] or [`DenyList::unrevoke`]: a cache with two
//! writers is how this drifted from the store in the first place.
//!
//! # Why it is keyed by tenant
//!
//! Entries are `(tenant_id, device_id)`. A bare device id was safe only while
//! every install shared one hardcoded tenant; now that a host resolves its
//! tenant from its account binding, a bare key would let one tenant's
//! revocation refuse another tenant's device that happens to carry the same id.
//! That direction fails closed, but it is still wrong, and the fix costs
//! nothing.
//!
//! [`DenyList::is_revoked_in_any_tenant`] exists for the one caller that has no
//! tenant yet; see its doc comment.
//!
//! # Persistence
//!
//! None. It is rebuilt from the store at startup by
//! [`DenyList::seed_from_store`]. It used to be seeded from the renderer's
//! Dexie mirror instead, which meant a revocation survived a restart only if
//! that mirror had the row — and under a real local account the mirror was
//! always empty, so every reboot un-revoked every device.
//!
//! # Thread safety
//!
//! `Send + Sync` via `parking_lot::RwLock`. Many axum workers read
//! concurrently; the lifecycle service takes the write lock only when a device
//! actually changed state.

use parking_lot::RwLock;
use std::collections::HashSet;

/// Warn when the deny list grows past this threshold. A logging threshold, not
/// a hard limit: revocations are permanent and must never be silently dropped.
const CAP_WARNING: usize = 1000;

/// One cache entry. Ordered `(tenant, device)` so the debug rendering reads the
/// way the store's primary key does.
type DeviceKey = (String, String);

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

/// Thread-safe set of devices whose lifecycle state is not `active`.
pub struct DenyList {
    inner: RwLock<HashSet<DeviceKey>>,
}

impl DenyList {
    /// Construct an empty deny list.
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashSet::new()),
        }
    }

    /// Refuse `device_id` within `tenant_id`.
    ///
    /// Returns `true` if the entry was *newly* added. Idempotent otherwise.
    ///
    /// Covers both suspension and revocation: this cache answers "may this
    /// device be served right now", and the answer is no in either state. What
    /// distinguishes them lives in the store, which is what every
    /// authorization decision reads.
    pub fn revoke(&self, tenant_id: &str, device_id: &str) -> bool {
        let mut set = self.inner.write();
        let newly_inserted = set.insert((tenant_id.to_string(), device_id.to_string()));
        if newly_inserted && set.len() >= CAP_WARNING {
            log::warn!(
                "companion deny-list has reached {} entries; consider pruning revoked devices.",
                set.len()
            );
        }
        newly_inserted
    }

    /// Serve `device_id` again, after a resume.
    ///
    /// Returns `true` if the entry was present and removed.
    pub fn unrevoke(&self, tenant_id: &str, device_id: &str) -> bool {
        self.inner
            .write()
            .remove(&(tenant_id.to_string(), device_id.to_string()))
    }

    /// Whether this exact `(tenant, device)` must be refused.
    pub fn is_revoked(&self, tenant_id: &str, device_id: &str) -> bool {
        self.inner
            .read()
            .contains(&(tenant_id.to_string(), device_id.to_string()))
    }

    /// Whether `device_id` is refused under *any* tenant.
    ///
    /// A deliberate over-approximation for the WebRTC DataChannel dispatcher,
    /// which reaches its revocation gate before it has resolved a tenant — it
    /// derives one immediately afterwards via `active_device_tenant`, and that
    /// lookup is strict, so a suspended or revoked device is refused there in
    /// any case. Erring toward refusal in the window before it is the
    /// fail-closed direction.
    ///
    /// Never use this where a tenant is in hand.
    pub fn is_revoked_in_any_tenant(&self, device_id: &str) -> bool {
        self.inner
            .read()
            .iter()
            .any(|(_, candidate)| candidate == device_id)
    }

    /// Rebuild the cache from the security store.
    ///
    /// Called once per server start. Union semantics, so a revocation issued
    /// between process start and this call is not lost.
    ///
    /// Returns the number of entries loaded, or `None` when no store is
    /// installed — the caller logs that, because an uninitialised store here
    /// means the process is serving requests with an empty cache.
    pub fn seed_from_store(&self) -> Option<usize> {
        let store = super::security_store::security_store()?;
        match store.list_inactive_devices() {
            Ok(devices) => {
                let loaded = devices.len();
                let mut set = self.inner.write();
                set.extend(devices);
                if set.len() >= CAP_WARNING {
                    log::warn!(
                        "companion deny-list seeded to {} entries (>= {} threshold).",
                        set.len(),
                        CAP_WARNING
                    );
                }
                Some(loaded)
            }
            Err(error) => {
                // Loud, and deliberately not fatal: the store stays
                // authoritative for every authorization decision, so an
                // unseeded cache costs the two hot paths their shortcut, not
                // their correctness.
                log::error!("companion deny-list could not be seeded from the store: {error}");
                None
            }
        }
    }

    /// Number of entries currently held.
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.inner.read().len()
    }

    /// Whether the cache holds nothing.
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

    const TENANT: &str = "tnt_alpha";

    /// Holds the store lock and leaves the process-global store empty again.
    ///
    /// `server::challenge_fails_closed_without_security_store_after_spawn`
    /// asserts the *absence* of an installed store and does not take this lock,
    /// so a suite that installs one and walks away breaks it depending on
    /// ordering.
    struct StoreScope(
        // Never read — held for its lifetime, which is the whole point.
        #[allow(dead_code)] std::sync::MutexGuard<'static, ()>,
    );

    impl Drop for StoreScope {
        fn drop(&mut self) {
            // Runs before the field, so the lock is still held here.
            super::super::security_store::install_security_store(None);
        }
    }

    fn store_scope() -> StoreScope {
        StoreScope(super::super::security_store::test_guard())
    }

    #[test]
    fn new_deny_list_is_empty() {
        let dl = DenyList::new();
        assert_eq!(dl.len(), 0);
        assert!(dl.is_empty());
    }

    #[test]
    fn revoke_returns_true_on_first_call() {
        let dl = DenyList::new();
        assert!(dl.revoke(TENANT, "device-1"));
    }

    #[test]
    fn revoke_returns_false_on_duplicate() {
        let dl = DenyList::new();
        assert!(dl.revoke(TENANT, "device-1"));
        assert!(!dl.revoke(TENANT, "device-1"));
    }

    #[test]
    fn is_revoked_returns_true_after_revoke() {
        let dl = DenyList::new();
        dl.revoke(TENANT, "device-a");
        assert!(dl.is_revoked(TENANT, "device-a"));
    }

    #[test]
    fn is_revoked_returns_false_for_unknown_device() {
        let dl = DenyList::new();
        assert!(!dl.is_revoked(TENANT, "unknown-device"));
    }

    #[test]
    fn unrevoke_removes_entry_and_returns_true() {
        let dl = DenyList::new();
        dl.revoke(TENANT, "device-b");
        assert!(dl.is_revoked(TENANT, "device-b"));
        assert!(dl.unrevoke(TENANT, "device-b"));
        assert!(!dl.is_revoked(TENANT, "device-b"));
    }

    #[test]
    fn unrevoke_on_absent_entry_returns_false() {
        let dl = DenyList::new();
        assert!(!dl.unrevoke(TENANT, "never-added"));
    }

    /// The reason the key carries a tenant.
    ///
    /// Device ids are only unique within a tenant. Before the host binding
    /// existed every install shared one hardcoded tenant, so a bare device id
    /// was accidentally sufficient; it is not any more.
    #[test]
    fn one_tenants_revocation_does_not_refuse_another_tenants_device() {
        let dl = DenyList::new();
        dl.revoke("tnt_alpha", "shared-id");
        assert!(dl.is_revoked("tnt_alpha", "shared-id"));
        assert!(!dl.is_revoked("tnt_beta", "shared-id"));
    }

    /// The DataChannel escape hatch, and its exact scope.
    #[test]
    fn the_tenant_agnostic_probe_sees_any_tenants_revocation() {
        let dl = DenyList::new();
        dl.revoke("tnt_alpha", "shared-id");
        assert!(dl.is_revoked_in_any_tenant("shared-id"));
        assert!(!dl.is_revoked_in_any_tenant("some-other-id"));
    }

    #[test]
    fn resuming_one_tenant_leaves_the_other_refused() {
        let dl = DenyList::new();
        dl.revoke("tnt_alpha", "shared-id");
        dl.revoke("tnt_beta", "shared-id");
        assert!(dl.unrevoke("tnt_alpha", "shared-id"));
        assert!(!dl.is_revoked("tnt_alpha", "shared-id"));
        assert!(dl.is_revoked("tnt_beta", "shared-id"));
    }

    #[test]
    fn capacity_warning_threshold_is_unchanged() {
        assert_eq!(CAP_WARNING, 1000);
    }

    #[test]
    fn revoke_beyond_cap_warning_still_inserts() {
        let dl = DenyList::new();
        for index in 0..999 {
            dl.revoke(TENANT, &format!("device-{index}"));
        }
        assert_eq!(dl.len(), 999);
        // Crossing the warning threshold must still insert — no eviction.
        assert!(dl.revoke(TENANT, "device-999"));
        assert_eq!(dl.len(), 1000);
        assert!(dl.revoke(TENANT, "device-1000"));
        assert_eq!(dl.len(), 1001);
        assert!(dl.is_revoked(TENANT, "device-1000"));
    }

    /// Seeding must not drop a revocation issued while the process was booting.
    #[test]
    fn seeding_is_a_union_with_what_is_already_held() {
        let _scope = store_scope();
        let store = super::super::security_store::SecurityStore::in_memory().expect("store");
        super::super::security_store::install_security_store(Some(store));

        let dl = DenyList::new();
        dl.revoke(TENANT, "revoked-during-boot");
        let loaded = dl.seed_from_store().expect("a store is installed");
        assert_eq!(loaded, 0, "a fresh store holds no inactive devices");
        assert!(dl.is_revoked(TENANT, "revoked-during-boot"));
    }

    /// A revocation must survive a restart. This is the whole point of seeding
    /// from the store rather than from the renderer's mirror.
    #[test]
    fn a_revoked_device_is_refused_again_after_a_restart() {
        let _scope = store_scope();
        let store = super::super::security_store::SecurityStore::in_memory().expect("store");
        super::super::security_store::install_security_store(Some(store.clone()));
        let tenant = "tnt_restart";
        let now = 1_700_000_000;

        // Two owners, so revoking one is not refused by the last-owner guard.
        for (device, thumb) in [("owner-keep", "thumb-keep"), ("owner-drop", "thumb-drop")] {
            let challenge = store.issue_challenge(tenant, now, 600).expect("challenge");
            let invitation = store
                .create_owner_invitation(tenant, "trust-root", now, 600)
                .expect("invitation");
            store
                .register_owner_device(
                    tenant,
                    &invitation,
                    &challenge.id,
                    &challenge.nonce,
                    device,
                    "Owner",
                    "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
                    thumb,
                    now,
                )
                .expect("register");
        }
        store
            .revoke_device(tenant, "owner-keep", "owner-drop", false, now)
            .expect("revoke");

        // A fresh process: brand-new cache, nothing carried over in memory.
        let restarted = DenyList::new();
        assert_eq!(restarted.seed_from_store(), Some(1));
        assert!(restarted.is_revoked(tenant, "owner-drop"));
        assert!(!restarted.is_revoked(tenant, "owner-keep"));
    }
}
