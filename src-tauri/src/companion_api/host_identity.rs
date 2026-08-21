//! Authoritative resolution of *which* identity a companion request belongs to.
//!
//! Three id spaces meet on this host and were previously conflated into the one
//! hardcoded string `local_acct_a`:
//!
//! - **local account namespace** — the renderer's Dexie account id (`acct_…`),
//!   or [`LOCAL_NAMESPACE_UNBOUND`] before anyone has unlocked;
//! - **remote tenant id** — the `SecurityStore`/OIDC tenant every device row,
//!   grant and audit event is filed under;
//! - **host id** — this host's own identifier on the wire.
//!
//! The client credential book already models the first two correctly
//! (`CompanionHostRecord.accountNamespace` vs `.tenantId`); this is the missing
//! server-side half.
//!
//! # Trust boundary — read this before extending
//!
//! The local account registry lives in IndexedDB, so Rust **cannot** prove that
//! a renderer-supplied account id is genuine. What it can do is pin an account
//! namespace to the password verifier it was first seen with, and refuse any
//! later bind that presents a different one. The residual exposure is bounded
//! and worth stating plainly: a compromised renderer can mint a *new* namespace
//! (which receives a fresh tenant with zero devices and zero grants), but it
//! can never re-point an established namespace at a verifier of its choosing,
//! and therefore never reach another account's paired devices.
//!
//! Closing that last gap requires moving the account registry into Rust, which
//! is a separate project.

use once_cell::sync::Lazy;
use parking_lot::RwLock;
use sha2::{Digest, Sha256};

use super::deployment::{deployment_mode, DeploymentMode};
use super::security_store::{security_store, unix_time_secs, LOCAL_NAMESPACE_UNBOUND};

#[derive(Debug, thiserror::Error)]
pub enum HostIdentityError {
    #[error("the security database is unavailable")]
    StoreUnavailable,
    #[error("this host has no tenant binding")]
    Unbound,
    #[error("the local account does not match this host's recorded binding")]
    BindingMismatch,
    #[error("security database error: {0}")]
    Store(String),
}

/// Who a companion request is being served as.
///
/// Deliberately carries only the two ids that callers read today. A host id is
/// derived three different ways in this crate and none of those call sites goes
/// through here yet; a device id is per-request and already lives on
/// `DeviceContext`. Materializing either here before something reads it would
/// just be a field that drifts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostTenantContext {
    pub local_account_namespace: String,
    pub remote_tenant_id: String,
}

/// The local account this host is currently serving, set by a verified unlock.
static BOUND_ACCOUNT: Lazy<RwLock<Option<String>>> = Lazy::new(|| RwLock::new(None));

/// Stable digest of a password verifier, used as the binding pin.
///
/// Covers the algorithm and both binary fields, so swapping any of them counts
/// as a different verifier.
pub fn verifier_digest(algorithm: &str, salt: &str, hash: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(algorithm.as_bytes());
    hasher.update([0]);
    hasher.update(salt.as_bytes());
    hasher.update([0]);
    hasher.update(hash.as_bytes());
    hex::encode(hasher.finalize())
}

/// Bind this host to a local account after a **verified** password unlock.
///
/// Callers must only reach this on a successful verification — the digest pin
/// is what bounds a lie, not this function.
pub fn bind_local_account(
    local_account_namespace: &str,
    verifier_digest: &str,
) -> Result<HostTenantContext, HostIdentityError> {
    bind_internal(local_account_namespace, Some(verifier_digest))
}

/// Bind from an operator-supplied account id (headless `cognia-server`).
///
/// A separate entry point on purpose: a command line is a legitimate trust root
/// for that deployment shape, and keeping it distinct means the WebView path can
/// never reach the no-digest branch.
pub fn bind_local_account_from_operator(
    local_account_namespace: &str,
) -> Result<HostTenantContext, HostIdentityError> {
    bind_internal(local_account_namespace, None)
}

fn bind_internal(
    local_account_namespace: &str,
    digest: Option<&str>,
) -> Result<HostTenantContext, HostIdentityError> {
    if local_account_namespace.trim().is_empty() {
        return Err(HostIdentityError::Unbound);
    }
    let store = security_store().ok_or(HostIdentityError::StoreUnavailable)?;
    let binding = store
        .bind_host_account(local_account_namespace, digest, unix_time_secs())
        .map_err(|error| match error {
            super::security_store::SecurityStoreError::HostBindingMismatch => {
                HostIdentityError::BindingMismatch
            }
            other => HostIdentityError::Store(other.to_string()),
        })?;
    *BOUND_ACCOUNT.write() = Some(binding.local_account_namespace.clone());
    Ok(HostTenantContext {
        local_account_namespace: binding.local_account_namespace,
        remote_tenant_id: binding.tenant_id,
    })
}

/// Re-pin the binding to a new verifier, for a password rotation.
pub fn rebind_verifier(
    local_account_namespace: &str,
    verifier_digest: &str,
) -> Result<(), HostIdentityError> {
    let store = security_store().ok_or(HostIdentityError::StoreUnavailable)?;
    store
        .rebind_host_verifier(local_account_namespace, verifier_digest, unix_time_secs())
        .map_err(|error| HostIdentityError::Store(error.to_string()))
}

/// Drop the in-process binding. The `host_bindings` row is left alone — locking
/// an account does not un-own its tenant.
pub fn unbind_local_account() {
    *BOUND_ACCOUNT.write() = None;
}

/// Resolve the identity this host serves right now.
///
/// Multi-tenant deployments never consult the process binding: their tenant
/// comes from the authenticated principal's OIDC claim. See
/// [`for_principal`].
pub fn current() -> Result<HostTenantContext, HostIdentityError> {
    if deployment_mode() == DeploymentMode::MultiTenant {
        return Err(HostIdentityError::Unbound);
    }
    let store = security_store().ok_or(HostIdentityError::StoreUnavailable)?;
    let bound = BOUND_ACCOUNT.read().clone();

    if let Some(namespace) = bound {
        if let Some(binding) = store
            .host_binding(&namespace)
            .map_err(|error| HostIdentityError::Store(error.to_string()))?
        {
            return Ok(HostTenantContext {
                local_account_namespace: binding.local_account_namespace,
                remote_tenant_id: binding.tenant_id,
            });
        }
    }

    // Nobody has unlocked yet. The companion server can be running already and
    // devices paired before there was an account still have to authenticate, so
    // fall back to the unclaimed bucket rather than refusing.
    let tenant = store
        .unbound_host_tenant()
        .map_err(|error| HostIdentityError::Store(error.to_string()))?;
    match tenant {
        Some(tenant_id) => Ok(HostTenantContext {
            local_account_namespace: LOCAL_NAMESPACE_UNBOUND.to_string(),
            remote_tenant_id: tenant_id,
        }),
        None => {
            // First ever boot: claim the sentinel bucket so the tenant this host
            // serves is stable from here on.
            let binding = store
                .bind_host_account(LOCAL_NAMESPACE_UNBOUND, None, unix_time_secs())
                .map_err(|error| HostIdentityError::Store(error.to_string()))?;
            Ok(HostTenantContext {
                local_account_namespace: LOCAL_NAMESPACE_UNBOUND.to_string(),
                remote_tenant_id: binding.tenant_id,
            })
        }
    }
}

/// The tenant to serve, for callers that cannot fail.
///
/// Used on paths that historically substituted the `local_acct_a` literal and
/// have no error channel.
pub fn current_tenant_or_unbound() -> String {
    current()
        .map(|context| context.remote_tenant_id)
        .unwrap_or_else(|_| LOCAL_NAMESPACE_UNBOUND.to_string())
}

/// Translate a store tenant back into the local account namespace that owns it.
///
/// This is the fix for the event/sync mismatch: Rust used to stamp a **tenant**
/// into `account_id` on `companion://device-paired` and on sync pulls, while the
/// renderer compared that field against its **local account id**. Two id spaces,
/// so with a real `acct_…` account the comparison could never succeed and no
/// paired-device row was ever written.
pub fn namespace_for_tenant(tenant_id: &str) -> Option<String> {
    let store = security_store()?;
    store
        .host_namespace_for_tenant(tenant_id)
        .ok()
        .flatten()
        .filter(|namespace| namespace != LOCAL_NAMESPACE_UNBOUND)
}

/// The namespace to stamp on an outbound event for `tenant_id`.
///
/// Falls back to the sentinel, which the renderer accepts and adopts, rather
/// than to the tenant — stamping a tenant here is the original bug.
pub fn event_namespace_for_tenant(tenant_id: &str) -> String {
    namespace_for_tenant(tenant_id).unwrap_or_else(|| LOCAL_NAMESPACE_UNBOUND.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_api::security_store::{install_security_store, test_guard, SecurityStore};

    /// Holds the store lock and leaves the process-global store empty again.
    ///
    /// `server::challenge_fails_closed_without_security_store_after_spawn`
    /// asserts the *absence* of an installed store and does not take this lock,
    /// so a suite that installs one and walks away breaks it depending on test
    /// ordering.
    struct StoreScope(
        // Never read — held for its lifetime, which is the whole point.
        #[allow(dead_code)] std::sync::MutexGuard<'static, ()>,
    );

    impl Drop for StoreScope {
        fn drop(&mut self) {
            // Runs before the field, so the lock is still held here.
            install_security_store(None);
        }
    }

    fn store_scope() -> StoreScope {
        StoreScope(test_guard())
    }

    fn install() -> std::sync::Arc<SecurityStore> {
        let store = SecurityStore::in_memory().unwrap();
        install_security_store(Some(store.clone()));
        unbind_local_account();
        store
    }

    #[test]
    fn an_unbound_host_serves_the_sentinel_namespace() {
        let _scope = store_scope();
        install();

        let context = current().unwrap();
        assert_eq!(context.local_account_namespace, LOCAL_NAMESPACE_UNBOUND);
        // A tenant is still resolved, so a host whose account is locked keeps
        // authenticating the devices that were paired before it.
        assert!(!context.remote_tenant_id.is_empty());
    }

    #[test]
    fn the_first_bind_adopts_the_unclaimed_bucket_and_keeps_its_tenant() {
        let _scope = store_scope();
        install();

        let unbound = current().unwrap().remote_tenant_id;
        let bound = bind_local_account("acct_deadbeef", "digest-a").unwrap();

        assert_eq!(bound.local_account_namespace, "acct_deadbeef");
        assert_eq!(
            bound.remote_tenant_id, unbound,
            "adoption must keep the tenant, or every existing pairing breaks"
        );
    }

    #[test]
    fn a_second_account_receives_a_distinct_tenant() {
        let _scope = store_scope();
        install();

        let first = bind_local_account("acct_one", "digest-one").unwrap();
        let second = bind_local_account("acct_two", "digest-two").unwrap();

        assert_ne!(first.remote_tenant_id, second.remote_tenant_id);
        assert!(second.remote_tenant_id.starts_with("tnt_"));
    }

    #[test]
    fn rebinding_with_a_different_verifier_digest_is_refused() {
        let _scope = store_scope();
        install();
        bind_local_account("acct_one", "digest-one").unwrap();

        assert!(matches!(
            bind_local_account("acct_one", "attacker-digest"),
            Err(HostIdentityError::BindingMismatch)
        ));

        // The deliberate rotation path still works.
        rebind_verifier("acct_one", "digest-two").unwrap();
        assert!(bind_local_account("acct_one", "digest-two").is_ok());
    }

    #[test]
    fn an_operator_bind_records_no_digest_and_arms_it_on_first_verified_unlock() {
        let _scope = store_scope();
        let store = install();

        bind_local_account_from_operator("acct_headless").unwrap();
        assert_eq!(
            store
                .host_binding("acct_headless")
                .unwrap()
                .unwrap()
                .verifier_digest,
            None
        );

        bind_local_account("acct_headless", "digest-a").unwrap();
        assert_eq!(
            store
                .host_binding("acct_headless")
                .unwrap()
                .unwrap()
                .verifier_digest
                .as_deref(),
            Some("digest-a")
        );
        // ...and from then on the pin is armed.
        assert!(matches!(
            bind_local_account("acct_headless", "digest-b"),
            Err(HostIdentityError::BindingMismatch)
        ));
    }

    #[test]
    fn binding_does_not_prove_the_account_id_is_genuine() {
        // This test exists to keep the limitation honest rather than to assert a
        // guarantee. Rust cannot check a namespace it has never seen against a
        // registry that lives in the renderer's IndexedDB, so an unknown id is
        // accepted — and lands on a fresh, empty tenant, which is what bounds
        // the damage. If this ever starts failing, the trust root moved and the
        // module doc above needs rewriting.
        let _scope = store_scope();
        let store = install();

        let forged = bind_local_account("acct_never_seen_before", "whatever").unwrap();
        assert_eq!(forged.local_account_namespace, "acct_never_seen_before");
        assert!(store
            .list_devices(&forged.remote_tenant_id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn unbinding_returns_the_host_to_the_sentinel_without_dropping_the_row() {
        let _scope = store_scope();
        let store = install();
        let bound = bind_local_account("acct_one", "digest-one").unwrap();

        unbind_local_account();
        assert_eq!(
            current().unwrap().local_account_namespace,
            LOCAL_NAMESPACE_UNBOUND
        );
        // Locking an account does not un-own its tenant.
        assert_eq!(
            store.host_binding("acct_one").unwrap().unwrap().tenant_id,
            bound.remote_tenant_id
        );
    }

    #[test]
    fn a_tenant_resolves_back_to_the_namespace_that_owns_it() {
        let _scope = store_scope();
        install();
        let bound = bind_local_account("acct_one", "digest-one").unwrap();

        assert_eq!(
            namespace_for_tenant(&bound.remote_tenant_id).as_deref(),
            Some("acct_one")
        );
        assert_eq!(namespace_for_tenant("tnt_nothing"), None);
        // The event stamp never falls back to the tenant itself — that was the
        // original bug.
        assert_eq!(
            event_namespace_for_tenant("tnt_nothing"),
            LOCAL_NAMESPACE_UNBOUND
        );
    }

    #[test]
    fn multi_tenant_deployments_never_read_the_process_binding() {
        let _scope = store_scope();
        install();
        bind_local_account("acct_one", "digest-one").unwrap();

        temp_env_var("COGNIA_DEPLOYMENT_MODE", "multi-tenant", || {
            assert!(matches!(current(), Err(HostIdentityError::Unbound)));
        });
    }

    fn temp_env_var(key: &str, value: &str, body: impl FnOnce()) {
        let previous = std::env::var(key).ok();
        // SAFETY: `test_guard()` serializes every test that touches process
        // globals, and this restores the previous value before releasing it.
        unsafe { std::env::set_var(key, value) };
        body();
        match previous {
            Some(restored) => unsafe { std::env::set_var(key, restored) },
            None => unsafe { std::env::remove_var(key) },
        }
    }
}
