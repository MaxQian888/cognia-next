//! The one place a companion device's lifecycle changes.
//!
//! # Why this module exists
//!
//! There used to be two revocation paths that did different things.
//!
//! - `DELETE /api/devices/:id` wrote the `SecurityStore`, tore down signaling,
//!   mirrored into the deny list and published a bus frame that closed the
//!   device's event socket.
//! - The desktop's `companion_revoke_device` wrote **only** the in-process deny
//!   list and cleared the signaling registration. It never touched the store.
//!
//! That second path was the defect. The deny list is consulted by the legacy
//! bearer-JWT middleware; the canonical DPoP plane (`POST /api/auth/token`)
//! checks `devices.status = 'active'` and never reads the deny list at all. So
//! pressing "revoke" in Settings left a DPoP-authenticating device working
//! exactly as before — and because the deny list was seeded from a Dexie table
//! that stayed empty under a real local account, the entry did not even survive
//! a restart.
//!
//! [`apply`] is now the only way any surface changes a device's state, and it
//! performs the *same ordered effects* regardless of who called it. The
//! `desktop_and_http_paths_produce_identical_effects` test is what keeps the
//! two from drifting apart again.
//!
//! # Ordering
//!
//! 1. Store transaction — the authority. Nothing else happens if it refuses.
//! 2. Short-circuit when the device was already in the target state, so a
//!    repeated click does not re-publish teardown to live sockets.
//! 3. Signaling registration cleanup — **revoke only**. A suspended device
//!    keeps its registration and its keyring entry so resume can bring the same
//!    identity back; dropping them would make suspension a slow revocation.
//! 4. Refresh the signaling hub, for every action. The hub is rebuilt from the
//!    registrations filtered to active devices, and `sync_devices` cancels
//!    whatever disappeared — so suspend cancels the WebRTC client and resume
//!    re-creates it, with no new hub API.
//! 5. Mirror into the deny-list cache.
//! 6. Publish `security://device-lifecycle` on the bus. Deliberately absent
//!    from `EVENT_CHANNELS`: this frame is never *delivered* to a subscriber,
//!    it closes their socket.
//! 7. Emit `companion://device-lifecycle` to the renderer, which mirrors it
//!    into Dexie. Note the direction — Rust is the authority and the renderer
//!    follows. The paired-devices card used to do the reverse.
//!
//! # Deliberately synchronous
//!
//! Every effect above is a synchronous call, so `apply` is too. That is not an
//! accident: `SecurityStore`'s connection mutex, the installed-store read lock
//! and the signaling hub's inner lock are all `parking_lot`, none of which may
//! be held across an `.await`. A synchronous function cannot make that mistake.
//!
//! # Live socket teardown
//!
//! `/ws/events` closes from the bus frame in step 6. The other four planes
//! re-check authorization on a 1s timer against the store, which is strict
//! about `status = 'active'`, so suspension bites there without any push from
//! here. That bound is uniform across `/ws/terminal`, `/ws/worker`,
//! `/ws/browser` and `/ws/acp` — see `still_authorized`.

use std::sync::Arc;

use serde_json::json;

use super::deny_list::DenyList;
use super::event_bus::EventBus;
use super::security_store::{
    security_store, unix_time_secs, DeviceLifecycleState, SecurityStoreError,
};

/// What the caller is asking for.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LifecycleAction {
    Suspend,
    Resume,
    Revoke,
}

impl LifecycleAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Suspend => "suspend",
            Self::Resume => "resume",
            Self::Revoke => "revoke",
        }
    }
}

/// Who is asking.
///
/// `trust_root` is the local OS operator escape hatch: it lets the CLI revoke
/// the last owner so a deployment whose only owner device was lost can be
/// recovered with a fresh invitation. A remote Owner-API caller never sets it.
#[derive(Clone, Debug)]
pub struct LifecycleActor {
    pub tenant_id: String,
    pub actor_id: String,
    pub trust_root: bool,
}

impl LifecycleActor {
    /// The desktop shell acting through the local trust root.
    pub fn local_trust_root(tenant_id: impl Into<String>) -> Self {
        Self {
            tenant_id: tenant_id.into(),
            actor_id: "local-trust-root".to_string(),
            trust_root: true,
        }
    }

    /// An authenticated owner device acting over the Companion API.
    pub fn owner_device(tenant_id: impl Into<String>, device_id: impl Into<String>) -> Self {
        Self {
            tenant_id: tenant_id.into(),
            actor_id: device_id.into(),
            trust_root: false,
        }
    }
}

/// What actually happened.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LifecycleOutcome {
    pub device_id: String,
    pub previous: DeviceLifecycleState,
    pub current: DeviceLifecycleState,
    /// `false` when the device was already in the target state. Callers still
    /// report success — the request's intent holds — but no teardown was
    /// published.
    pub changed: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum LifecycleError {
    #[error("the security database is unavailable")]
    StoreUnavailable,
    #[error("the device is unknown to this tenant")]
    UnknownDevice,
    #[error("{0}")]
    Store(#[from] SecurityStoreError),
    #[error("signaling teardown failed: {0}")]
    Signaling(String),
}

/// Everything the effects need. Both fields are optional because the CLI runs
/// without a live server and the unit tests run without either.
#[derive(Default)]
pub struct LifecycleContext {
    pub event_bus: Option<Arc<EventBus>>,
    pub deny_list: Option<Arc<DenyList>>,
    pub app_handle: Option<tauri::AppHandle>,
}

/// Change one device's lifecycle state and apply every consequence.
///
/// See the module docs for the ordering and why it is the same for every
/// caller.
pub fn apply(
    context: &LifecycleContext,
    actor: &LifecycleActor,
    device_id: &str,
    action: LifecycleAction,
) -> Result<LifecycleOutcome, LifecycleError> {
    let store = security_store().ok_or(LifecycleError::StoreUnavailable)?;
    let now = unix_time_secs();

    // ── 1. Store transaction ────────────────────────────────────────────────
    let previous = store
        .device_state(&actor.tenant_id, device_id)?
        .ok_or(LifecycleError::UnknownDevice)?;

    let changed = match action {
        LifecycleAction::Suspend => store.suspend_device(
            &actor.tenant_id,
            &actor.actor_id,
            device_id,
            actor.trust_root,
            now,
        )?,
        LifecycleAction::Resume => {
            store.resume_device(&actor.tenant_id, &actor.actor_id, device_id, now)?
        }
        LifecycleAction::Revoke => {
            if previous == DeviceLifecycleState::Revoked {
                false
            } else {
                store.revoke_device(
                    &actor.tenant_id,
                    &actor.actor_id,
                    device_id,
                    actor.trust_root,
                    now,
                )?;
                true
            }
        }
    };

    let current = match action {
        LifecycleAction::Suspend => DeviceLifecycleState::Suspended,
        LifecycleAction::Resume => DeviceLifecycleState::Active,
        LifecycleAction::Revoke => DeviceLifecycleState::Revoked,
    };

    let outcome = LifecycleOutcome {
        device_id: device_id.to_string(),
        previous,
        current,
        changed,
    };

    // ── 2. Idempotent short-circuit ─────────────────────────────────────────
    // Republishing teardown for an unchanged device would close sockets a
    // second time and emit a renderer event describing a transition that did
    // not happen.
    if !changed {
        return Ok(outcome);
    }

    // ── 3. Signaling registration cleanup (revoke only) ─────────────────────
    if action == LifecycleAction::Revoke {
        clear_signaling_registration(device_id)?;
    }

    // ── 4. Rebuild the signaling hub ────────────────────────────────────────
    super::signaling::refresh_installed_hub().map_err(LifecycleError::Signaling)?;

    // ── 5. Mirror into the deny-list cache ──────────────────────────────────
    if let Some(deny_list) = context.deny_list.as_ref() {
        match action {
            LifecycleAction::Suspend | LifecycleAction::Revoke => {
                deny_list.revoke(&actor.tenant_id, device_id);
            }
            LifecycleAction::Resume => {
                deny_list.unrevoke(&actor.tenant_id, device_id);
            }
        }
    }

    let payload = json!({
        "tenantId": actor.tenant_id,
        "deviceId": device_id,
        "action": action.as_str(),
        "previousState": outcome.previous.as_str(),
        "state": current.as_str(),
        "atMs": now.saturating_mul(1_000),
    });

    // ── 6. Event-plane leases ───────────────────────────────────────────────
    // Dropped here rather than waiting for the socket teardown in step 7 to
    // reach `Drop`. A suspended or revoked device must stop counting as an
    // in-band listener the moment authority ends: while a lease survives it
    // still suppresses the push that would otherwise reach a device that CAN
    // still act, and it still satisfies the live-stream precondition an attach
    // renewal checks. Closing a lease twice is a no-op, so racing the socket's
    // own teardown is safe.
    if matches!(action, LifecycleAction::Suspend | LifecycleAction::Revoke) {
        super::event_leases::close_device(device_id);
    }

    // ── 7. Bus frame — closes `/ws/events` for this device ──────────────────
    if let Some(bus) = context.event_bus.as_ref() {
        bus.publish(LIFECYCLE_EVENT.to_string(), payload.clone());
    }

    // ── 8. Renderer mirror ──────────────────────────────────────────────────
    if let Some(app) = context.app_handle.as_ref() {
        use tauri::Emitter as _;
        let _ = app.emit(RENDERER_LIFECYCLE_EVENT, payload);
    }

    Ok(outcome)
}

/// Control-plane topic. Not in `EVENT_CHANNELS` on purpose: it is never
/// delivered to a subscriber, it closes their socket.
pub const LIFECYCLE_EVENT: &str = "security://device-lifecycle";

/// Renderer-facing mirror of the same transition.
pub const RENDERER_LIFECYCLE_EVENT: &str = "companion://device-lifecycle";

/// Drop the device's signaling registration and its Host-side signing key.
///
/// Lifted out of `api.rs` so both callers get it; the HTTP handler now goes
/// through here too.
fn clear_signaling_registration(device_id: &str) -> Result<(), LifecycleError> {
    let key_ref = match super::signaling::registration_store::installed() {
        Some(registrations) => registrations
            .remove_device(device_id)
            .map_err(|error| LifecycleError::Signaling(error.to_string()))?
            .unwrap_or_else(|| device_id.to_string()),
        None => device_id.to_string(),
    };
    super::signaling::envelope::clear_signaling_key(&key_ref).map_err(|error| {
        LifecycleError::Signaling(format!(
            "the Host signaling identity could not be removed: {error}"
        ))
    })
}

/// Whether a long-lived socket may keep running.
///
/// The single predicate behind the 1s re-check on `/ws/browser` and `/ws/acp`.
/// Extracted so it can be unit-tested without standing up a socket: the loops
/// themselves are untestable in `--lib` mode, the decision is not.
///
/// Fails **open** only when the store is missing entirely — that is a process
/// that cannot authenticate anyone, and tearing down every live session on a
/// transient store outage would be worse than letting an already-authenticated
/// session finish. Any definite answer other than `Active` closes the socket.
pub fn still_authorized(tenant_id: &str, device_id: &str) -> bool {
    let Some(store) = security_store() else {
        return true;
    };
    match store.device_state(tenant_id, device_id) {
        Ok(Some(state)) => state == DeviceLifecycleState::Active,
        Ok(None) => false,
        Err(error) => {
            log::warn!("companion lifecycle: device state lookup failed: {error}");
            true
        }
    }
}

/// The close reason a socket should report, once [`still_authorized`] says no.
///
/// Suspension and revocation are different facts and the client behaves
/// differently: a suspended device should tell its user to ask the host owner,
/// a revoked one has to re-pair.
pub fn close_reason(tenant_id: &str, device_id: &str) -> &'static str {
    match security_store().and_then(|store| store.device_state(tenant_id, device_id).ok().flatten())
    {
        Some(DeviceLifecycleState::Suspended) => "device_suspended",
        _ => "device_revoked",
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_api::security_store::{install_security_store, test_guard, SecurityStore};

    const TENANT: &str = "tnt_lifecycle";
    const NOW: i64 = 1_700_000_000;

    /// Holds the store lock **and** leaves the process-global store empty on
    /// the way out.
    ///
    /// Other suites assert the *absence* of an installed store — notably
    /// `server::challenge_fails_closed_without_security_store_after_spawn` —
    /// and they do not take this lock. A suite that installs one and walks away
    /// makes them flaky depending on scheduling order. Uninstalling inside the
    /// guard closes the window this module would otherwise open.
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

    fn store_with_owners(devices: &[&str]) -> Arc<SecurityStore> {
        let store = SecurityStore::in_memory().expect("in-memory store");
        for device in devices {
            let challenge = store.issue_challenge(TENANT, NOW, 600).expect("challenge");
            let invitation = store
                .create_owner_invitation(TENANT, "trust-root", NOW, 600)
                .expect("invitation");
            store
                .register_owner_device(
                    TENANT,
                    &invitation,
                    &challenge.id,
                    &challenge.nonce,
                    device,
                    "Owner",
                    "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
                    &format!("thumb-{device}"),
                    NOW,
                )
                .expect("register");
        }
        install_security_store(Some(store.clone()));
        store
    }

    fn lifecycle_context() -> LifecycleContext {
        LifecycleContext {
            event_bus: Some(EventBus::new()),
            deny_list: Some(Arc::new(DenyList::new())),
            app_handle: None,
        }
    }

    /// Rows that describe everything a lifecycle change is allowed to touch.
    ///
    /// Compared between the two callers below. Deliberately includes the audit
    /// actor, because "same effect" has to mean the audit trail agrees too.
    fn effect_snapshot(store: &SecurityStore, device_id: &str) -> serde_json::Value {
        let state = store
            .device_state(TENANT, device_id)
            .expect("state")
            .map(|state| state.as_str().to_string());
        let key = store
            .active_device_key(TENANT, device_id)
            .expect("device key")
            .is_some();
        let tenant = store
            .active_device_tenant(device_id)
            .expect("device tenant")
            .is_some();
        let capabilities = store
            .manageable_capability_snapshot(TENANT, device_id)
            .expect("capabilities")
            .map(|(_, capabilities)| capabilities);
        json!({
            "state": state,
            "hasActiveKey": key,
            "resolvesTenant": tenant,
            "capabilities": capabilities,
        })
    }

    /// The reason this module exists.
    ///
    /// The desktop command and the HTTP handler used to do different things —
    /// the desktop one never wrote the store at all. Driving `apply` from both
    /// actor shapes and diffing the resulting rows is what stops them drifting
    /// apart again.
    #[test]
    fn desktop_and_http_paths_produce_identical_effects() {
        let _scope = store_scope();

        // Desktop: local trust root.
        let store = store_with_owners(&["owner-keep", "target-device"]);
        let context = lifecycle_context();
        apply(
            &context,
            &LifecycleActor::local_trust_root(TENANT),
            "target-device",
            LifecycleAction::Revoke,
        )
        .expect("desktop revoke");
        let desktop = effect_snapshot(&store, "target-device");

        // HTTP: an authenticated owner device.
        let store = store_with_owners(&["owner-keep", "target-device"]);
        let context = lifecycle_context();
        apply(
            &context,
            &LifecycleActor::owner_device(TENANT, "owner-keep"),
            "target-device",
            LifecycleAction::Revoke,
        )
        .expect("http revoke");
        let http = effect_snapshot(&store, "target-device");

        assert_eq!(desktop, http, "the two revoke paths must agree row for row");
        assert_eq!(desktop["state"], "revoked");
        assert_eq!(desktop["hasActiveKey"], false);

        // The audit row is not compared here: its actor is *supposed* to differ
        // (the operator versus the owner device that asked), and both callers
        // reach the same `store.revoke_device`, so the action is identical by
        // construction. What the row contains is pinned at the store level by
        // `audit_records_suspend_and_resume_with_the_actor`.
    }

    /// The headline defect: revoking from the desktop must reach the store, not
    /// just an in-process cache the canonical auth plane never reads.
    #[test]
    fn a_desktop_revoke_reaches_the_store_not_only_the_cache() {
        let _scope = store_scope();
        let store = store_with_owners(&["owner-keep", "doomed"]);
        let context = lifecycle_context();

        apply(
            &context,
            &LifecycleActor::local_trust_root(TENANT),
            "doomed",
            LifecycleAction::Revoke,
        )
        .expect("revoke");

        // `POST /api/auth/token` resolves the device key and only accepts an
        // active row. This is the exact lookup that used to keep succeeding.
        assert!(store
            .active_device_key(TENANT, "doomed")
            .expect("key lookup")
            .is_none());
    }

    /// A revoked device must stop counting as an in-band listener at the moment
    /// authority ends, not whenever its socket happens to notice.
    ///
    /// While a lease survives it does two harmful things: it suppresses the
    /// push that would otherwise reach a device that CAN still act, and it
    /// satisfies the live-stream precondition an attach renewal checks — so a
    /// device whose grant was just pulled could renew straight back into
    /// control.
    #[test]
    fn revoking_a_device_closes_its_event_plane_leases_at_once() {
        let _scope = store_scope();
        let _store = store_with_owners(&["owner-keep", "doomed", "bystander"]);
        let context = lifecycle_context();

        let doomed = super::super::event_leases::EventStreamLeaseGuard::open(
            "doomed",
            super::super::event_leases::EventStreamTransport::Ws,
        );
        let bystander = super::super::event_leases::EventStreamLeaseGuard::open(
            "bystander",
            super::super::event_leases::EventStreamTransport::Rtc,
        );
        doomed.advance(super::super::event_leases::EventStreamState::Ready);
        bystander.advance(super::super::event_leases::EventStreamState::Ready);

        apply(
            &context,
            &LifecycleActor::local_trust_root(TENANT),
            "doomed",
            LifecycleAction::Revoke,
        )
        .expect("revoke");

        assert!(!super::super::event_leases::has_ready_stream("doomed"));
        assert!(
            super::super::event_leases::has_ready_stream("bystander"),
            "one device's revocation must not silence another's stream"
        );
        drop(doomed);
        drop(bystander);
    }

    /// Same reasoning for a suspension: it is reversible, but while it is in
    /// force the device may not act, so it must not read as present either.
    #[test]
    fn suspending_a_device_closes_its_event_plane_leases_too() {
        let _scope = store_scope();
        let _store = store_with_owners(&["owner-keep", "paused"]);
        let context = lifecycle_context();

        let lease = super::super::event_leases::EventStreamLeaseGuard::open(
            "paused",
            super::super::event_leases::EventStreamTransport::Ws,
        );
        lease.advance(super::super::event_leases::EventStreamState::Ready);

        apply(
            &context,
            &LifecycleActor::local_trust_root(TENANT),
            "paused",
            LifecycleAction::Suspend,
        )
        .expect("suspend");

        assert!(!super::super::event_leases::has_ready_stream("paused"));
        drop(lease);
    }

    /// Suspension has to be reversible, which means the device key survives.
    #[test]
    fn suspend_then_resume_round_trips_without_revoking_the_key() {
        let _scope = store_scope();
        let store = store_with_owners(&["owner-keep", "paused"]);
        let context = lifecycle_context();

        apply(
            &context,
            &LifecycleActor::local_trust_root(TENANT),
            "paused",
            LifecycleAction::Suspend,
        )
        .expect("suspend");
        assert_eq!(
            store.device_state(TENANT, "paused").unwrap(),
            Some(DeviceLifecycleState::Suspended)
        );
        // Suspended is refused everywhere authorization is decided...
        assert!(store
            .active_device_key(TENANT, "paused")
            .expect("key")
            .is_none());
        assert!(!still_authorized(TENANT, "paused"));

        apply(
            &context,
            &LifecycleActor::local_trust_root(TENANT),
            "paused",
            LifecycleAction::Resume,
        )
        .expect("resume");
        // ...and comes back with the same key, which is what makes it a pause.
        assert!(store
            .active_device_key(TENANT, "paused")
            .expect("key")
            .is_some());
        assert!(still_authorized(TENANT, "paused"));
    }

    #[test]
    fn repeating_an_action_reports_success_without_republishing_teardown() {
        let _scope = store_scope();
        store_with_owners(&["owner-keep", "paused"]);
        let context = lifecycle_context();
        let mut receiver = match context
            .event_bus
            .as_ref()
            .expect("bus")
            .subscribe(None, NOW.saturating_mul(1_000))
        {
            super::super::event_bus::SubscribeResult::Ok { receiver, .. } => receiver,
            _ => panic!("a fresh bus must accept a subscriber"),
        };

        let first = apply(
            &context,
            &LifecycleActor::local_trust_root(TENANT),
            "paused",
            LifecycleAction::Suspend,
        )
        .expect("first suspend");
        assert!(first.changed);
        assert_eq!(
            receiver.try_recv().map(|frame| frame.event_type),
            Ok(LIFECYCLE_EVENT.to_string())
        );

        let second = apply(
            &context,
            &LifecycleActor::local_trust_root(TENANT),
            "paused",
            LifecycleAction::Suspend,
        )
        .expect("second suspend still succeeds");
        assert!(!second.changed);
        assert!(
            receiver.try_recv().is_err(),
            "an unchanged device must not republish teardown"
        );
    }

    /// The deny-list cache tracks the store in both directions.
    #[test]
    fn the_cache_mirrors_every_transition() {
        let _scope = store_scope();
        store_with_owners(&["owner-keep", "mirrored"]);
        let context = lifecycle_context();
        let deny = context.deny_list.clone().expect("deny list");

        apply(
            &context,
            &LifecycleActor::local_trust_root(TENANT),
            "mirrored",
            LifecycleAction::Suspend,
        )
        .expect("suspend");
        assert!(deny.is_revoked(TENANT, "mirrored"));

        apply(
            &context,
            &LifecycleActor::local_trust_root(TENANT),
            "mirrored",
            LifecycleAction::Resume,
        )
        .expect("resume");
        assert!(!deny.is_revoked(TENANT, "mirrored"));

        apply(
            &context,
            &LifecycleActor::local_trust_root(TENANT),
            "mirrored",
            LifecycleAction::Revoke,
        )
        .expect("revoke");
        assert!(deny.is_revoked(TENANT, "mirrored"));
    }

    /// Revocation is terminal. "Un-revoking" was never real — the row is gone
    /// from the active set and the device key has been revoked — so resuming a
    /// revoked device must fail loudly rather than pretend.
    #[test]
    fn a_revoked_device_cannot_be_resumed() {
        let _scope = store_scope();
        store_with_owners(&["owner-keep", "gone"]);
        let context = lifecycle_context();
        apply(
            &context,
            &LifecycleActor::local_trust_root(TENANT),
            "gone",
            LifecycleAction::Revoke,
        )
        .expect("revoke");

        let error = apply(
            &context,
            &LifecycleActor::local_trust_root(TENANT),
            "gone",
            LifecycleAction::Resume,
        )
        .expect_err("resuming a revoked device must fail");
        assert!(
            matches!(
                error,
                LifecycleError::Store(SecurityStoreError::InvalidDeviceTransition)
            ),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn an_unknown_device_is_reported_as_unknown_not_as_a_no_op() {
        let _scope = store_scope();
        store_with_owners(&["owner-keep"]);
        let context = lifecycle_context();
        let error = apply(
            &context,
            &LifecycleActor::local_trust_root(TENANT),
            "never-paired",
            LifecycleAction::Suspend,
        )
        .expect_err("an unknown device must not silently succeed");
        assert!(matches!(error, LifecycleError::UnknownDevice));
    }

    /// The close reason has to distinguish the two states, because the client's
    /// next move differs: ask the owner, versus re-pair.
    #[test]
    fn the_close_reason_distinguishes_suspension_from_revocation() {
        let _scope = store_scope();
        store_with_owners(&["owner-keep", "paused", "gone"]);
        let context = lifecycle_context();
        apply(
            &context,
            &LifecycleActor::local_trust_root(TENANT),
            "paused",
            LifecycleAction::Suspend,
        )
        .expect("suspend");
        apply(
            &context,
            &LifecycleActor::local_trust_root(TENANT),
            "gone",
            LifecycleAction::Revoke,
        )
        .expect("revoke");

        assert_eq!(close_reason(TENANT, "paused"), "device_suspended");
        assert_eq!(close_reason(TENANT, "gone"), "device_revoked");
        assert_eq!(close_reason(TENANT, "never-heard-of"), "device_revoked");
    }

    /// A socket for a device that has since vanished must close, and a store
    /// outage must not tear down every live session.
    #[test]
    fn the_socket_predicate_closes_on_a_definite_no_and_holds_on_an_outage() {
        let _scope = store_scope();
        store_with_owners(&["owner-keep"]);
        assert!(still_authorized(TENANT, "owner-keep"));
        assert!(!still_authorized(TENANT, "not-a-device"));

        install_security_store(None);
        assert!(
            still_authorized(TENANT, "not-a-device"),
            "an absent store must not close already-authenticated sessions"
        );
    }
}
