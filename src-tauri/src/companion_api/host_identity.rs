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

use cognia_tenant_auth::{OrgId, UserId};

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
    #[error("{0}")]
    MalformedId(String),
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

/// Which person a profile belongs to, if anyone has signed in on it.
///
/// A named struct rather than a tuple: a tuple crosses the Tauri boundary as a
/// positional JSON array, which is unreadable at the call site and silently
/// re-orders when a field is added.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPerson {
    pub local_account_namespace: String,
    pub user_id: Option<String>,
    pub org_id: Option<String>,
}

/// Record the person a profile belongs to after a completed sign-in (ADR-0149).
///
/// Deliberately NOT part of [`bind_local_account`]. That path is reached by a
/// verified password unlock and proves a profile; this one asserts a person the
/// renderer resolved from a Logto token. Keeping them apart means signing in
/// never looks like it re-proved the profile, and a renderer-supplied user id
/// never travels on the same path as the verifier pin.
pub fn bind_person(
    local_account_namespace: &str,
    user_id: &str,
    org_id: Option<&str>,
) -> Result<(), HostIdentityError> {
    if local_account_namespace.trim().is_empty() {
        return Err(HostIdentityError::Unbound);
    }
    // Validated before the store is even looked up: a malformed id is a caller
    // bug, and reporting it as "no security database here" on a host that has
    // none would hide it on exactly the machines hardest to debug.
    let user_id = UserId::parse(user_id)
        .map_err(|error| HostIdentityError::MalformedId(format!("user id: {error}")))?;
    let org_id = org_id
        .map(|value| {
            OrgId::parse(value)
                .map_err(|error| HostIdentityError::MalformedId(format!("org id: {error}")))
        })
        .transpose()?;

    let store = security_store().ok_or(HostIdentityError::StoreUnavailable)?;
    store
        .bind_host_person(
            local_account_namespace,
            user_id.as_str(),
            org_id.as_ref().map(OrgId::as_str),
            unix_time_secs(),
        )
        .map_err(|error| match error {
            super::security_store::SecurityStoreError::HostBindingMismatch => {
                HostIdentityError::BindingMismatch
            }
            other => HostIdentityError::Store(other.to_string()),
        })
}

/// Attribute this profile's unowned devices to the person bound to it.
///
/// ADR-0149 §5, step one. Separate from [`bind_person`] so the binding stays a
/// single fact and this stays a single, reversible act — and so a caller that
/// only wants to record who signed in does not silently rewrite device rows.
///
/// Returns how many devices were adopted. Zero is the normal answer on every
/// sign-in after the first.
pub fn adopt_unowned_devices(local_account_namespace: &str) -> Result<usize, HostIdentityError> {
    let store = security_store().ok_or(HostIdentityError::StoreUnavailable)?;
    let binding = store
        .host_binding(local_account_namespace)
        .map_err(|error| HostIdentityError::Store(error.to_string()))?
        .ok_or(HostIdentityError::Unbound)?;
    // Nothing to attribute devices to. Not an error: a profile can be unlocked
    // without anybody signing in, and its devices simply stay unowned.
    let Some(user_id) = binding.user_id else {
        return Ok(0);
    };
    store
        .adopt_unowned_devices(&binding.tenant_id, &user_id, unix_time_secs())
        .map_err(|error| HostIdentityError::Store(error.to_string()))
}

/// Forget the person on a profile (sign-out). The profile binding survives —
/// signing out is not un-owning a tenant, exactly as locking is not.
///
/// Devices keep their owner too. Signing out is not disowning your machines,
/// and clearing them would make the next sign-in re-adopt devices that were
/// deliberately assigned to somebody else.
pub fn unbind_person(local_account_namespace: &str) -> Result<(), HostIdentityError> {
    let store = security_store().ok_or(HostIdentityError::StoreUnavailable)?;
    store
        .clear_host_person(local_account_namespace, unix_time_secs())
        .map_err(|error| HostIdentityError::Store(error.to_string()))
}

/// Read the person recorded for a profile. `user_id` is `None` for a profile
/// that has only ever been unlocked locally, which stays a supported state.
pub fn person(local_account_namespace: &str) -> Result<HostPerson, HostIdentityError> {
    let store = security_store().ok_or(HostIdentityError::StoreUnavailable)?;
    let binding = store
        .host_binding(local_account_namespace)
        .map_err(|error| HostIdentityError::Store(error.to_string()))?
        .ok_or(HostIdentityError::Unbound)?;
    Ok(HostPerson {
        local_account_namespace: binding.local_account_namespace,
        user_id: binding.user_id,
        org_id: binding.org_id,
    })
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
    fn a_profile_with_nobody_signed_in_reports_no_person() {
        let _scope = store_scope();
        install();
        bind_local_account("acct_deadbeef", "digest-a").unwrap();

        let found = person("acct_deadbeef").unwrap();
        assert_eq!(found.local_account_namespace, "acct_deadbeef");
        assert_eq!(found.user_id, None, "unlocking a profile asserts no person");
        assert_eq!(found.org_id, None);
    }

    #[test]
    fn signing_in_records_the_person_without_touching_the_tenant() {
        let _scope = store_scope();
        install();
        let before = bind_local_account("acct_deadbeef", "digest-a").unwrap();

        bind_person("acct_deadbeef", "usr_ada", Some("org_acme")).unwrap();

        let found = person("acct_deadbeef").unwrap();
        assert_eq!(found.user_id.as_deref(), Some("usr_ada"));
        assert_eq!(found.org_id.as_deref(), Some("org_acme"));
        // The tenant every paired device is filed under must not move.
        assert_eq!(current().unwrap().remote_tenant_id, before.remote_tenant_id);
    }

    #[test]
    fn a_person_may_have_no_organisation() {
        let _scope = store_scope();
        install();
        bind_local_account("acct_deadbeef", "digest-a").unwrap();

        bind_person("acct_deadbeef", "usr_ada", None).unwrap();
        let found = person("acct_deadbeef").unwrap();
        assert_eq!(found.user_id.as_deref(), Some("usr_ada"));
        assert_eq!(found.org_id, None);
    }

    #[test]
    fn signing_out_forgets_the_person_and_keeps_the_profile_binding() {
        let _scope = store_scope();
        install();
        let bound = bind_local_account("acct_deadbeef", "digest-a").unwrap();
        bind_person("acct_deadbeef", "usr_ada", Some("org_acme")).unwrap();

        unbind_person("acct_deadbeef").unwrap();

        let found = person("acct_deadbeef").unwrap();
        assert_eq!(found.user_id, None);
        assert_eq!(found.org_id, None);
        // Signing out is not un-owning a tenant.
        assert_eq!(current().unwrap().remote_tenant_id, bound.remote_tenant_id);
    }

    #[test]
    fn a_person_cannot_be_attached_to_a_profile_this_host_never_saw() {
        let _scope = store_scope();
        install();

        let error = bind_person("acct_never_unlocked", "usr_ada", None).unwrap_err();
        assert!(matches!(error, HostIdentityError::BindingMismatch));
        assert!(matches!(
            person("acct_never_unlocked").unwrap_err(),
            HostIdentityError::Unbound
        ));
    }

    #[test]
    fn an_empty_namespace_or_user_is_refused_rather_than_written() {
        let _scope = store_scope();
        install();
        bind_local_account("acct_deadbeef", "digest-a").unwrap();

        assert!(matches!(
            bind_person("", "usr_ada", None).unwrap_err(),
            HostIdentityError::Unbound
        ));
        assert!(matches!(
            bind_person("acct_deadbeef", "   ", None).unwrap_err(),
            HostIdentityError::MalformedId(_)
        ));
        assert_eq!(person("acct_deadbeef").unwrap().user_id, None);
    }

    #[test]
    fn signing_in_attributes_the_profile_s_unowned_devices() {
        let _scope = store_scope();
        install();
        let bound = bind_local_account("acct_deadbeef", "digest-a").unwrap();
        let store = crate::companion_api::security_store::security_store().unwrap();

        // A device enrolled before anybody signed in.
        let challenge = store
            .issue_challenge(&bound.remote_tenant_id, 100, 60)
            .unwrap();
        let invitation = store
            .create_owner_invitation(&bound.remote_tenant_id, "local-trust-root", 100, 60)
            .unwrap();
        store
            .register_owner_device(
                &bound.remote_tenant_id,
                &invitation,
                &challenge.id,
                &challenge.nonce,
                "device-a",
                "Phone",
                "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
                "thumb-a",
                100,
            )
            .unwrap();
        assert_eq!(
            store
                .device_user(&bound.remote_tenant_id, "device-a")
                .unwrap(),
            None
        );

        bind_person("acct_deadbeef", "usr_ada", None).unwrap();
        assert_eq!(adopt_unowned_devices("acct_deadbeef").unwrap(), 1);
        assert_eq!(
            store
                .device_user(&bound.remote_tenant_id, "device-a")
                .unwrap()
                .as_deref(),
            Some("usr_ada")
        );
    }

    #[test]
    fn adopting_on_a_profile_with_nobody_signed_in_claims_nothing() {
        // A profile can be unlocked without anybody signing in, and its devices
        // simply stay unowned. Not an error.
        let _scope = store_scope();
        install();
        bind_local_account("acct_deadbeef", "digest-a").unwrap();
        assert_eq!(adopt_unowned_devices("acct_deadbeef").unwrap(), 0);
    }

    #[test]
    fn signing_out_leaves_devices_with_their_owner() {
        // Signing out is not disowning your machines. Clearing them would make
        // the next sign-in re-adopt devices deliberately assigned elsewhere.
        let _scope = store_scope();
        install();
        let bound = bind_local_account("acct_deadbeef", "digest-a").unwrap();
        let store = crate::companion_api::security_store::security_store().unwrap();
        let challenge = store
            .issue_challenge(&bound.remote_tenant_id, 100, 60)
            .unwrap();
        let invitation = store
            .create_owner_invitation(&bound.remote_tenant_id, "local-trust-root", 100, 60)
            .unwrap();
        store
            .register_owner_device(
                &bound.remote_tenant_id,
                &invitation,
                &challenge.id,
                &challenge.nonce,
                "device-a",
                "Phone",
                "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
                "thumb-a",
                100,
            )
            .unwrap();
        bind_person("acct_deadbeef", "usr_ada", None).unwrap();
        adopt_unowned_devices("acct_deadbeef").unwrap();

        unbind_person("acct_deadbeef").unwrap();

        assert_eq!(
            store
                .device_user(&bound.remote_tenant_id, "device-a")
                .unwrap()
                .as_deref(),
            Some("usr_ada")
        );
    }

    #[test]
    fn a_malformed_id_is_refused_before_it_reaches_the_security_database() {
        // The trust boundary in this module's header says Rust cannot prove a
        // renderer-supplied id is *genuine*. It can still refuse one that is
        // not an id at all, which is what stops a renderer bug from writing
        // `undefined` into a column every later grant decision reads.
        let _scope = store_scope();
        install();
        bind_local_account("acct_deadbeef", "digest-a").unwrap();

        for junk in ["undefined", "null", "acct_deadbeef", "usr_", "{}"] {
            assert!(
                matches!(
                    bind_person("acct_deadbeef", junk, None),
                    Err(HostIdentityError::MalformedId(_))
                ),
                "accepted user id {junk:?}"
            );
        }
        // An org id in the user slot is a wiring bug, not a coercible value.
        assert!(matches!(
            bind_person("acct_deadbeef", "org_acme", None),
            Err(HostIdentityError::MalformedId(_))
        ));
        // And the same standard applies to the org slot.
        assert!(matches!(
            bind_person("acct_deadbeef", "usr_ada", Some("acme")),
            Err(HostIdentityError::MalformedId(_))
        ));

        assert_eq!(person("acct_deadbeef").unwrap().user_id, None);
    }

    #[test]
    fn a_malformed_id_is_reported_even_on_a_host_with_no_security_database() {
        // `account_bind_person` maps `StoreUnavailable` to success, because a
        // desktop that never ran a companion server is a normal state. If
        // validation ran after the store lookup, a malformed id would be
        // silently swallowed on exactly those machines.
        let _scope = store_scope();
        install_security_store(None);

        assert!(matches!(
            bind_person("acct_deadbeef", "nonsense", None),
            Err(HostIdentityError::MalformedId(_))
        ));
    }

    #[test]
    fn re_signing_in_as_someone_else_overwrites_rather_than_duplicating() {
        let _scope = store_scope();
        install();
        bind_local_account("acct_deadbeef", "digest-a").unwrap();

        // The renderer owns the refusal (a profile bound to another person is
        // a `UserBindingError` there); the host records whatever survived it.
        bind_person("acct_deadbeef", "usr_ada", Some("org_acme")).unwrap();
        bind_person("acct_deadbeef", "usr_bob", None).unwrap();

        let found = person("acct_deadbeef").unwrap();
        assert_eq!(found.user_id.as_deref(), Some("usr_bob"));
        assert_eq!(found.org_id, None, "the new sign-in's org replaces the old");
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
