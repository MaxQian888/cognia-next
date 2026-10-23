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
//! 3. Signaling registration cleanup and the device's host secrets
//!    (ADR-0224 A6) — **revoke only**. A suspended device keeps its
//!    registration, its keyring entry and the secrets it sent so resume can
//!    bring the same identity back; dropping them would make suspension a slow
//!    revocation.
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
    pub renderer: Option<Arc<dyn super::host::RendererPort>>,
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

    let changed = super::ws_browser_companion::update_device_authorization(
        &actor.tenant_id,
        device_id,
        || -> Result<bool, LifecycleError> {
            Ok(match action {
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
            })
        },
    )?;

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
        forget_device_secrets(device_id);
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
    if let Some(renderer) = context.renderer.as_ref() {
        renderer.emit(RENDERER_LIFECYCLE_EVENT, payload);
    }

    Ok(outcome)
}

/// What forgetting a device did.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgetOutcome {
    pub device_id: String,
}

/// The `action` the renderer mirror carries for a forgotten device.
pub const FORGET_ACTION: &str = "forget";

/// Forget a revoked device: remove it from every device list on this Host.
///
/// Not a lifecycle *transition* — there is no state after revoked — so not a
/// [`LifecycleAction`], but it lives here for the same reason [`apply`] does:
/// one ordered set of effects whichever surface asks.
///
/// 1. Store transaction — the authority
///    ([`SecurityStore::forget_revoked_device`]): refuses anything not revoked,
///    a service principal, or a device with an operation still in flight.
/// 2. Signaling registration and host secrets, again. Revocation already
///    removed both; this is the second chance for a revoke whose cleanup
///    failed, and it is best-effort — the device is gone from the store by
///    now, so a keyring hiccup is logged rather than reported as a failed
///    forget.
/// 3. Renderer mirror, so the desktop drops the device from its own list.
///
/// No bus frame and no deny-list change: a revoked device holds no live
/// socket to close, and its deny-list entry is worth keeping.
///
/// [`SecurityStore::forget_revoked_device`]: super::security_store::SecurityStore::forget_revoked_device
pub fn forget(
    context: &LifecycleContext,
    actor: &LifecycleActor,
    device_id: &str,
) -> Result<ForgetOutcome, LifecycleError> {
    let store = security_store().ok_or(LifecycleError::StoreUnavailable)?;
    let now = unix_time_secs();

    // ── 1. Store transaction ────────────────────────────────────────────────
    store
        .device_state(&actor.tenant_id, device_id)?
        .ok_or(LifecycleError::UnknownDevice)?;
    store.forget_revoked_device(&actor.tenant_id, &actor.actor_id, device_id, now)?;

    // ── 2. Leftover signaling registration and host secrets ─────────────────
    if let Err(error) = clear_signaling_registration(device_id) {
        log::warn!("forgotten device {device_id}: {error}");
    }
    forget_device_secrets(device_id);

    // ── 3. Renderer mirror ──────────────────────────────────────────────────
    if let Some(renderer) = context.renderer.as_ref() {
        renderer.emit(
            RENDERER_LIFECYCLE_EVENT,
            json!({
                "tenantId": actor.tenant_id,
                "deviceId": device_id,
                "action": FORGET_ACTION,
                "previousState": DeviceLifecycleState::Revoked.as_str(),
                "state": "forgotten",
                "atMs": now.saturating_mul(1_000),
            }),
        );
    }

    Ok(ForgetOutcome {
        device_id: device_id.to_string(),
    })
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
/// Delete the secrets a revoked device sealed on this host (ADR-0224 A6).
///
/// Provider keys, git tokens and connector credentials a device sent are
/// indexed by writer in `host_secrets`; a revoked device must not leave keys
/// behind that it can no longer see or remove. Runs after the store has
/// revoked the device, so a failure here cannot keep the device authorized: it
/// is logged, the undeleted entries stay indexed under the device, and the
/// next revoke sweep (or "Secrets on this host") still finds them. Suspension
/// keeps them, because resume brings the same device back.
pub fn forget_device_secrets(device_id: &str) {
    match cognia_secrets::host_secrets::forget_device(device_id) {
        Ok(removed) if removed.is_empty() => {}
        Ok(removed) => log::info!(
            "revoked device {device_id}: removed {} host secret(s): {}",
            removed.len(),
            removed
                .iter()
                .map(|(kind, name)| format!("{}/{name}", kind.as_str()))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Err(error) => log::error!(
            "revoked device {device_id}: its host secrets could not all be removed: {error}"
        ),
    }
}

/// Forget the host secrets of every writer this host no longer knows as a
/// live device: revoked, or gone from the store. Returns how many devices
/// were swept.
///
/// [`apply`] already does this for a revoke it performs. The sweep is for a
/// revocation another process made: `cognia-server devices revoke-device` run
/// next to a serving host edits the database directly, and the running
/// server's secret cache would write the deleted entries back on its next
/// write. The host runs this at boot and before it lists or loads secrets.
pub fn sweep_revoked_device_secrets(tenant_id: &str) -> usize {
    let Some(store) = security_store() else {
        return 0;
    };
    let writers = match cognia_secrets::host_secrets::writer_device_ids() {
        Ok(writers) => writers,
        Err(error) => {
            log::warn!("host secret sweep: index unreadable: {error}");
            return 0;
        }
    };
    let mut swept = 0;
    for device_id in writers {
        match store.device_state(tenant_id, &device_id) {
            Ok(Some(DeviceLifecycleState::Revoked)) | Ok(None) => {
                forget_device_secrets(&device_id);
                swept += 1;
            }
            Ok(Some(_)) => {}
            // An unreadable store is not evidence of revocation; keep the
            // secrets and try again on the next sweep.
            Err(error) => log::warn!("host secret sweep: state of {device_id}: {error}"),
        }
    }
    swept
}

/// [`sweep_revoked_device_secrets`] against this host's own tenant.
///
/// Host secrets, and the devices that wrote them, belong to the host, so the
/// device registry to consult is the bound tenant's whoever triggers the
/// sweep. A caller's tenant is the account claim of its token, and the brain's
/// service token carries its local account id (`cognia_server::brain`), not a
/// tenant: a sweep run on that found none of the paired devices and forgot
/// every secret a live phone had set, its connector credentials included.
pub fn sweep_revoked_host_device_secrets() -> usize {
    sweep_revoked_device_secrets(&super::host_identity::current_tenant_or_unbound())
}

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
        Some(DeviceLifecycleState::Quarantined) => "device_quarantined",
        _ => "device_revoked",
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security_store::{install_security_store, test_guard, SecurityStore};

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
        store_with_owners_in(TENANT, devices)
    }

    fn store_with_owners_in(tenant: &str, devices: &[&str]) -> Arc<SecurityStore> {
        let store = SecurityStore::in_memory().expect("in-memory store");
        register_owners(&store, tenant, devices);
        install_security_store(Some(store.clone()));
        store
    }

    fn register_owners(store: &SecurityStore, tenant: &str, devices: &[&str]) {
        for device in devices {
            let challenge = store.issue_challenge(tenant, NOW, 600).expect("challenge");
            let invitation = store
                .create_owner_invitation(tenant, "trust-root", NOW, 600)
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
                    &format!("thumb-{device}"),
                    NOW,
                )
                .expect("register");
        }
    }

    fn lifecycle_context() -> LifecycleContext {
        LifecycleContext {
            event_bus: Some(EventBus::new()),
            deny_list: Some(Arc::new(DenyList::new())),
            renderer: None,
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

    /// Records what the lifecycle emitted, standing in for the desktop WebView.
    #[derive(Default)]
    struct RecordingRenderer {
        emitted: parking_lot::Mutex<Vec<(String, serde_json::Value)>>,
    }

    impl crate::host::RendererPort for RecordingRenderer {
        fn emit(&self, event: &str, payload: serde_json::Value) {
            self.emitted.lock().push((event.to_string(), payload));
        }

        fn bridge_transport(&self) -> Arc<dyn crate::bridge_transport::BridgeTransport> {
            unreachable!("RecordingRenderer carries no bridge")
        }

        fn resource_dir(&self) -> Option<std::path::PathBuf> {
            None
        }

        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }

    #[test]
    fn forgetting_a_revoked_device_removes_it_and_tells_the_renderer() {
        let _scope = store_scope();
        let store = store_with_owners(&["owner-keep", "target-device"]);
        let actor = LifecycleActor::owner_device(TENANT, "owner-keep");
        apply(
            &lifecycle_context(),
            &actor,
            "target-device",
            LifecycleAction::Revoke,
        )
        .expect("revoke");

        let recording = Arc::new(RecordingRenderer::default());
        let context = LifecycleContext {
            renderer: Some(recording.clone()),
            ..lifecycle_context()
        };
        let outcome = forget(&context, &actor, "target-device").expect("forget");

        assert_eq!(outcome.device_id, "target-device");
        assert_eq!(
            store.device_state(TENANT, "target-device").expect("state"),
            None
        );
        assert!(store
            .device_state(TENANT, "owner-keep")
            .expect("state")
            .is_some());
        let emitted = recording.emitted.lock();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].0, RENDERER_LIFECYCLE_EVENT);
        assert_eq!(emitted[0].1["deviceId"], "target-device");
        assert_eq!(emitted[0].1["action"], FORGET_ACTION);
        assert_eq!(emitted[0].1["previousState"], "revoked");
    }

    #[test]
    fn forgetting_refuses_a_device_that_is_not_revoked_and_one_that_is_unknown() {
        let _scope = store_scope();
        let store = store_with_owners(&["owner-keep", "target-device"]);
        let actor = LifecycleActor::owner_device(TENANT, "owner-keep");
        let recording = Arc::new(RecordingRenderer::default());
        let context = LifecycleContext {
            renderer: Some(recording.clone()),
            ..lifecycle_context()
        };

        assert!(matches!(
            forget(&context, &actor, "target-device"),
            Err(LifecycleError::Store(
                SecurityStoreError::InvalidDeviceTransition
            ))
        ));
        assert_eq!(
            store.device_state(TENANT, "target-device").expect("state"),
            Some(DeviceLifecycleState::Active)
        );
        assert!(matches!(
            forget(&context, &actor, "nobody"),
            Err(LifecycleError::UnknownDevice)
        ));
        assert!(recording.emitted.lock().is_empty());
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

    /// ADR-0224 A6: a revoked device leaves no secrets behind on the host.
    /// A suspended one keeps them, because resume brings the same device back.
    #[test]
    fn revoking_a_device_deletes_the_host_secrets_it_wrote() {
        use cognia_secrets::host_secrets::{self, HostSecretKind, SecretWriter};
        let _scope = store_scope();
        let _store = store_with_owners(&["owner-keep", "sec-doomed", "sec-paused"]);
        let context = lifecycle_context();
        let by = |device: &str| {
            Some(SecretWriter {
                device_id: device.to_string(),
                label: None,
            })
        };
        host_secrets::set(HostSecretKind::Provider, "lc-doomed", "k", by("sec-doomed"), 1)
            .unwrap();
        host_secrets::set(HostSecretKind::Provider, "lc-paused", "k", by("sec-paused"), 1)
            .unwrap();

        apply(
            &context,
            &LifecycleActor::local_trust_root(TENANT),
            "sec-paused",
            LifecycleAction::Suspend,
        )
        .expect("suspend");
        apply(
            &context,
            &LifecycleActor::local_trust_root(TENANT),
            "sec-doomed",
            LifecycleAction::Revoke,
        )
        .expect("revoke");

        assert_eq!(
            host_secrets::get(HostSecretKind::Provider, "lc-doomed").unwrap(),
            None
        );
        assert_eq!(
            host_secrets::get(HostSecretKind::Provider, "lc-paused")
                .unwrap()
                .as_deref(),
            Some("k")
        );
    }

    /// A device revoked behind this process's back (the CLI next to a running
    /// server) loses its host secrets at the next sweep; live devices keep
    /// theirs, and a writer the store no longer knows is treated as gone.
    #[test]
    fn the_sweep_forgets_secrets_of_devices_revoked_elsewhere() {
        use cognia_secrets::host_secrets::{self, HostSecretKind, SecretWriter};
        let _scope = store_scope();
        let store = store_with_owners(&["owner-keep", "sw-revoked", "sw-live"]);
        let by = |device: &str| {
            Some(SecretWriter {
                device_id: device.to_string(),
                label: None,
            })
        };
        host_secrets::set(HostSecretKind::Provider, "sw-revoked", "k", by("sw-revoked"), 1)
            .unwrap();
        host_secrets::set(HostSecretKind::Provider, "sw-live", "k", by("sw-live"), 1).unwrap();
        host_secrets::set(HostSecretKind::Provider, "sw-ghost", "k", by("sw-ghost"), 1).unwrap();
        // Revoked straight in the store, as the CLI does.
        store
            .revoke_device(TENANT, "local-cli-trust-root", "sw-revoked", true, NOW)
            .unwrap();

        // At least these two: the secret store is process-global, so a
        // writer another test left behind (and this store does not know) is
        // swept as well.
        assert!(sweep_revoked_device_secrets(TENANT) >= 2);
        assert_eq!(host_secrets::get(HostSecretKind::Provider, "sw-revoked").unwrap(), None);
        assert_eq!(host_secrets::get(HostSecretKind::Provider, "sw-ghost").unwrap(), None);
        assert!(host_secrets::get(HostSecretKind::Provider, "sw-live")
            .unwrap()
            .is_some());
    }


    /// The brain sweeps when it loads provider keys, holding a token whose
    /// tenant is its local account id. The host sweep consults the host's own
    /// registry instead, so a live phone keeps the connector credentials it
    /// set, while sweeping by that foreign id would have taken them.
    #[test]
    fn the_host_sweep_keeps_a_live_devices_secrets_whoever_asks() {
        use cognia_secrets::host_secrets::{self, HostSecretKind, SecretWriter};
        let _scope = store_scope();
        // The host's tenant is the installed store's, so read it after.
        let store = store_with_owners(&[]);
        let host_tenant = crate::host_identity::current_tenant_or_unbound();
        assert_ne!(host_tenant, "local_acct_a");
        register_owners(&store, &host_tenant, &["owner-keep", "hsw-phone"]);
        host_secrets::set(
            HostSecretKind::Connector,
            "hsw-bot:appSecret",
            "s",
            Some(SecretWriter {
                device_id: "hsw-phone".to_string(),
                label: None,
            }),
            1,
        )
        .unwrap();

        sweep_revoked_host_device_secrets();
        assert!(
            host_secrets::get(HostSecretKind::Connector, "hsw-bot:appSecret")
                .unwrap()
                .is_some()
        );

        // What the brain's own tenant claim used to sweep against.
        sweep_revoked_device_secrets("local_acct_a");
        assert_eq!(
            host_secrets::get(HostSecretKind::Connector, "hsw-bot:appSecret").unwrap(),
            None
        );
    }

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
