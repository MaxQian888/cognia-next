//! Tauri commands for the companion API server lifecycle.
//!
//! Commands shipped in M2.3: `companion_server_start`.
//! Commands added in M2.4: `companion_seed_deny_list`, `companion_revoke_device`,
//! `companion_unrevoke_device`.
//! Commands added in M2.8: `companion_server_stop`, `companion_server_status`,
//! `companion_create_owner_invitation`.

use parking_lot::RwLock;
use serde::Serialize;
use std::net::IpAddr;
use std::sync::Arc;
use tauri::{Manager, State};

use super::{
    browser_access, desktop_messages_bridge, desktop_writes_bridge,
    event_bus::{register_tauri_event, EventBus},
    host_identity,
    mdns::AutoStartConfig,
    reachability_config::{self, ReachabilityConfig},
    secret, security_store,
    server::{CompanionServerError, DEFAULT_PORT},
    tls,
    tunnel::{self, TunnelInfo},
    BindMode, CompanionServerState, CompanionState, SharedState,
};

/// The tenant every desktop-paired device belongs to. Resolved once here
/// because the grant commands below must address the same tenant the pairing
/// commands enrolled the device into — a mismatch would write grants nothing
/// looks up.
///
/// Used to be the `local_acct_a` literal, which made every install share one
/// tenant id. It now comes from the host binding, and falls back to the
/// unclaimed bucket before anyone has unlocked — the same tenant
/// [`super::api::registration_authority`] enrols into, so the two stay paired.
fn paired_tenant_id() -> String {
    host_identity::current_tenant_or_unbound()
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

/// Start the companion API HTTP server.
///
/// Loads (or generates) the HS256 signing secret from the OS keyring, builds
/// the shared state, and spawns the axum listener.  If the server is already
/// running, returns the current bound port without restarting.
///
/// # Parameters
///
/// - `port` — TCP port to bind.  Pass `0` to let the OS choose.
/// - `bind_loopback_only` — `true` → `127.0.0.1` (local only); `false` →
///   `0.0.0.0` (LAN-accessible).  M2.8 surfaces this as a UI toggle.
///
/// # Returns
///
/// The port the server is actually listening on.
#[tauri::command]
pub async fn companion_server_start(
    state: State<'_, CompanionServerState>,
    app_handle: tauri::AppHandle,
    port: u16,
    bind_loopback_only: bool,
) -> Result<u16, CompanionServerError> {
    // If already running, return the existing port without rebuilding state.
    if state.is_running() {
        if let Some(p) = state.bound_port() {
            return Ok(p);
        }
    }

    let signing_secret = secret::load_or_generate().map_err(|e| CompanionServerError::Bind {
        addr: std::net::SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), port),
        source: std::io::Error::other(e),
    })?;
    *state.host_id.write() = Some(super::opaque_host_id_from_secret(&signing_secret));

    // Build the event bus and register default Tauri event channels before
    // starting the server so no events are missed.
    let event_bus = EventBus::new();
    register_default_event_channels(&app_handle, Arc::clone(&event_bus));
    *state.event_bus.write() = Some(Arc::clone(&event_bus));
    let dir = data_dir(&app_handle).map_err(CompanionServerError::Tls)?;
    let idempotency =
        super::idempotency::IdempotencyCache::open(dir.join("companion-idempotency.sqlite"))
            .map_err(|error| CompanionServerError::Security(error.to_string()))?;

    // Clone the deny_list Arc so both the Tauri command layer and the axum
    // server share the same live deny list.
    let shared: SharedState = Arc::new(CompanionState {
        secret: RwLock::new(signing_secret),
        deny_list: Arc::clone(&state.deny_list),
        app_handle: Some(app_handle),
        idempotency: Arc::new(idempotency),
        event_bus,
        // Same Arc as the long-lived CompanionServerState — keeps the
        // `companion_sync_pull_response` Tauri command and the in-flight
        // HTTP handler talking to the same registry of pending requests.
        sync_bridge: Arc::clone(&state.sync_bridge),
        // Same Arc-cloning trick — the `companion_message_response`
        // Tauri command resolves pending oneshots on the long-lived
        // CompanionServerState even after a server restart hands the
        // axum handler a fresh SharedState.
        desktop_messages_bridge: Arc::clone(&state.desktop_messages_bridge),
        // Wave 2 desktop-write bridge — same Arc-cloning trick as the
        // messages bridge above. Carries the 7 mutating Wave 2 RPCs +
        // twin_profile_get through one event channel.
        desktop_writes_bridge: Arc::clone(&state.desktop_writes_bridge),
        // Wave 3.5 — share the long-lived sync table registry so plugin
        // registrations made before `start()` propagate to the server.
        sync_registry: Arc::clone(&state.sync_registry),
        // Wave 3.3 — same Arc-cloning trick: keep buckets alive across
        // server restarts so a misbehaving device can't reset its quota
        // by stop-starting the companion server.
        rate_limiter: Arc::clone(&state.rate_limiter),
        // Wave 3.4 — preserve registered push tokens across server
        // restarts so the desktop never has to re-prompt the phone for
        // re-registration just because the user toggled the server off.
        push_tokens: Arc::clone(&state.push_tokens),
    });

    // Load TLS material (M2.9 — every companion-server bind terminates HTTPS).
    let tls_material =
        tls::ensure_certificate(&dir).map_err(|e| CompanionServerError::Tls(e.to_string()))?;
    let security = security_store::SecurityStore::open(dir.join("companion-security.sqlite"))
        .map_err(|error| CompanionServerError::Security(error.to_string()))?;
    security_store::install_security_store(Some(security));
    let signaling_store = super::signaling::registration_store::SignalingRegistrationStore::open(
        dir.join("companion-signaling.sqlite"),
    )
    .map_err(|error| CompanionServerError::Security(error.to_string()))?;
    super::signaling::registration_store::install(Some(Arc::clone(&signaling_store)));

    // Publish the fingerprint so `whoami` (P0.3) can include it in responses
    // for app-layer attestation against the QR-pinned value.
    super::set_tls_fingerprint(tls_material.fingerprint_sha256.clone());

    // ADR-0021 — wire the WebRTC signaling hub to the live SharedState now
    // that it exists. Idempotent across restarts: `bind()` replaces the
    // stored binding so reconfigured clients pick up the fresh state on
    // their next reconnect.
    {
        use tauri::Manager as _;
        let app = shared.app_handle.as_ref().expect("app_handle present");
        if let Some(hub) = app.try_state::<std::sync::Arc<super::signaling::SignalingHub>>() {
            let hub_arc = Arc::clone(hub.inner());
            super::signaling::install_hub(Some(&hub_arc));
            let pending = hub.registrations_snapshot();
            hub.bind(Arc::clone(&shared));
            if pending.is_empty() {
                let persisted = signaling_store
                    .load_all()
                    .map_err(|error| CompanionServerError::Security(error.to_string()))?;
                hub.sync_devices(persisted);
            } else {
                signaling_store
                    .replace_all(&pending, unix_time_secs().saturating_mul(1_000))
                    .map_err(|error| CompanionServerError::Security(error.to_string()))?;
            }
        }
    }

    state
        .start(port, bind_loopback_only, tls_material, shared)
        .await
}

// ---------------------------------------------------------------------------
// Sync-down bridge response command (M4.7)
// ---------------------------------------------------------------------------

/// Resolve a pending `companion://sync-pull-request` event with the delta
/// the WebView fetched from Dexie.
///
/// The flow:
///   1. Phone calls `_rpc/sync_pull` against the desktop's HTTP server.
///   2. The Rust handler emits `companion://sync-pull-request` and awaits.
///   3. The desktop WebView's `lib/sync/desktop-sync-source.ts` listener
///      runs the table-specific Dexie query, then invokes this command.
///   4. We resolve the matching oneshot — the HTTP handler returns to the
///      phone with the delta in its response body.
///
/// `delta` should be the JSON the phone expects (`{ rows, deleted_ids,
/// next_since }`) or `None` paired with a non-empty `error`. Either is
/// allowed but not both.
#[tauri::command]
pub fn companion_sync_pull_response(
    request_id: String,
    delta: Option<serde_json::Value>,
    error: Option<String>,
    state: State<'_, CompanionServerState>,
) -> Result<(), String> {
    state
        .sync_bridge
        .resolve(super::sync_bridge::SyncPullResponse {
            request_id,
            delta,
            error,
        });
    Ok(())
}

// ---------------------------------------------------------------------------
// Desktop-message-mutation bridge response command (Mobile completeness P2)
// ---------------------------------------------------------------------------

/// Resolve a pending `companion://message-{update,delete}-request` or
/// `companion://session-list-request` event with the result the WebView
/// produced from Dexie.
///
/// The flow:
///   1. Phone calls `_rpc/message_update` (or `_delete` / `session_list`)
///      against the desktop's HTTP server.
///   2. The Rust handler emits the matching event and awaits a oneshot.
///   3. The desktop WebView's `lib/companion/desktop-message-source.ts`
///      listener runs the Dexie call, then invokes this command.
///   4. We resolve the matching oneshot — the HTTP handler returns to the
///      phone with the result in its response body.
///
/// Exactly one of `result` / `error` should be populated. Both `None` is
/// surfaced as a generic bridge error.
#[tauri::command]
pub fn companion_message_response(
    request_id: String,
    result: Option<serde_json::Value>,
    error: Option<String>,
    state: State<'_, CompanionServerState>,
) -> Result<(), String> {
    state
        .desktop_messages_bridge
        .resolve(desktop_messages_bridge::MessageBridgeResponse {
            request_id,
            result,
            error,
        });
    Ok(())
}

/// Resolve a pending session-media read with a raw IPC body. Metadata travels
/// in bounded headers so image bytes never expand through JSON/base64.
#[tauri::command]
pub fn companion_media_response(
    request: tauri::ipc::Request<'_>,
    state: State<'_, CompanionServerState>,
) -> Result<(), String> {
    const MAX_MEDIA_BYTES: usize = 10 * 1024 * 1024;
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    let request_id = header("x-cognia-request-id")
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .ok_or_else(|| "missing media request id".to_string())?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) if bytes.len() <= MAX_MEDIA_BYTES => bytes.clone(),
        tauri::ipc::InvokeBody::Raw(_) => return Err("media response too large".to_string()),
        _ => return Err("media response must use a raw invoke body".to_string()),
    };
    state
        .desktop_messages_bridge
        .resolve_media(desktop_messages_bridge::MediaBridgeResponse {
            request_id,
            bytes,
            media_type: header("content-type")
                .unwrap_or_else(|| "application/octet-stream".to_string()),
            etag: header("etag"),
            error: header("x-cognia-error"),
        });
    Ok(())
}

// ---------------------------------------------------------------------------
// Desktop-write bridge response command (Wave 2)
// ---------------------------------------------------------------------------

/// Resolve a pending `companion://desktop-write-request` event with the
/// result the WebView produced. Mirrors `companion_message_response`
/// but generic across the 7 Wave 2 mutating commands and `twin_profile_get`.
///
/// The TS-side dispatcher (`lib/companion/desktop-write-source.ts`) routes
/// each event to the appropriate Dexie helper before invoking this command
/// with the result.
///
/// Exactly one of `result` / `error` should be populated; both None is
/// surfaced as a generic bridge error.
#[tauri::command]
pub fn companion_desktop_write_response(
    request_id: String,
    result: Option<serde_json::Value>,
    error: Option<String>,
    state: State<'_, CompanionServerState>,
) -> Result<(), String> {
    state
        .desktop_writes_bridge
        .resolve(desktop_writes_bridge::DesktopWriteResponse {
            request_id,
            result,
            error,
        });
    Ok(())
}

/// Publish a committed HostState action through the existing replayable
/// EventBus. The TS authority calls this only after its ledger transaction;
/// returning success is the broadcast receipt persisted by HostStateService.
#[tauri::command]
pub fn companion_host_state_publish(
    topic: String,
    event: serde_json::Value,
    state: State<'_, CompanionServerState>,
) -> Result<(), String> {
    if topic != "host-state://action" {
        return Err("unsupported HostState topic".to_string());
    }
    let event_bus = state
        .event_bus
        .read()
        .clone()
        .ok_or_else(|| "companion EventBus is not running".to_string())?;
    event_bus.publish(topic, event);
    Ok(())
}

// ---------------------------------------------------------------------------
// Deny-list management commands (M2.4)
// ---------------------------------------------------------------------------

/// Bulk-load revoked device IDs into the in-memory deny list.
///
/// Called once at server startup so the Rust layer reflects the persisted
/// Dexie `pairedDevices` rows without reading the database itself.
/// Idempotent — existing entries are preserved (union semantics).
#[tauri::command]
pub async fn companion_seed_deny_list(
    device_ids: Vec<String>,
    state: State<'_, CompanionServerState>,
) -> Result<(), String> {
    // The deny list lives on the SharedState inside the server, but the
    // CompanionServerState wraps the server lifecycle, not the SharedState
    // directly.  The deny list is therefore also mirrored on CompanionServerState
    // itself so commands can mutate it regardless of whether the server is
    // currently running.
    //
    // For M2.4 the canonical approach is: the TS layer calls
    // `companion_server_start` first (which builds a fresh SharedState with an
    // empty deny list), then calls `companion_seed_deny_list`.  The seed
    // reaches the server-side deny list through the `CompanionServerState`
    // accessor below.
    state.seed_deny_list(device_ids);
    Ok(())
}

/// Revoke a paired device so its JWT is rejected on the next request.
///
/// The TS layer calls this when the user unpairs a device from the Settings
/// UI.  The revocation takes effect immediately for all in-flight requests
/// after this command returns.
#[tauri::command]
pub async fn companion_revoke_device(
    device_id: String,
    state: State<'_, CompanionServerState>,
) -> Result<(), String> {
    state.revoke_device(device_id.clone());
    if let Some(store) = super::signaling::registration_store::installed() {
        if let Some(key_ref) = store
            .remove_device(&device_id)
            .map_err(|error| error.to_string())?
        {
            super::signaling::envelope::clear_signaling_key(&key_ref)?;
        }
        super::signaling::refresh_installed_hub()?;
    }
    Ok(())
}

/// Un-revoke a device (e.g. after a re-pair).
///
/// Returns silently whether or not the device was previously revoked.
#[tauri::command]
pub async fn companion_unrevoke_device(
    device_id: String,
    state: State<'_, CompanionServerState>,
) -> Result<(), String> {
    state.unrevoke_device(&device_id);
    Ok(())
}

// ---------------------------------------------------------------------------
// Per-device elevated grants
// ---------------------------------------------------------------------------
//
// All three toggles below write the SecurityStore's `capability_grants` table,
// because that is the only thing the request path reads:
// `remote_execution::authorize_capability` checks the manifest capability for
// every command, and the two terminal gates (`rpc::ensure_terminal_rpc_authorized`,
// `ws_terminal`) ask `has_capability(.., "terminal.open")` directly.
//
// They previously wrote a set of process-global in-memory allow lists that no
// gate had consulted since authorization moved into the store — so the switches
// reported granting a permission they were not granting. The headless half of
// that migration had already landed (`cognia-server devices grant` writes the
// store, and `migrate_legacy_device_grants` imports the retired JSON file); this
// is the desktop half.

/// Apply one elevated grant to a paired device.
///
/// Reads the live capability snapshot, adds or removes exactly the capabilities
/// [`GrantKind::capabilities`] maps this grant onto, and writes the whole set
/// back atomically. Additive/subtractive rather than a wholesale replace, so
/// toggling terminal access cannot disturb an unrelated capability the device
/// holds — including the `host.admin` grant the store refuses to let an owner
/// device lose.
///
/// Takes effect on the very next request: the gates read the store, not a
/// cached projection of it.
fn apply_device_grant(
    device_id: &str,
    kind: super::device_grants::GrantKind,
    allowed: bool,
) -> Result<(), String> {
    // An empty id is what an unauthenticated or malformed RPC context carries,
    // so granting one would hand the capability to every such caller.
    if device_id.trim().is_empty() {
        return Err("device_id is required".into());
    }
    let security = security_store::security_store()
        .ok_or_else(|| "companion security store is unavailable".to_string())?;
    let mut capabilities: std::collections::BTreeSet<String> = security
        .capability_snapshot(&paired_tenant_id(), device_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "paired device is unknown or revoked".to_string())?
        .into_iter()
        .collect();
    for capability in kind.capabilities() {
        if allowed {
            capabilities.insert((*capability).to_string());
        } else {
            capabilities.remove(*capability);
        }
    }
    security
        .replace_device_capabilities(
            &paired_tenant_id(),
            "local-trust-root",
            device_id,
            &capabilities.into_iter().collect::<Vec<_>>(),
            unix_time_secs(),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Which elevated grants a paired device currently holds, for the
/// paired-devices card.
///
/// The card used to render its switches from the Dexie mirror, which drifts
/// from the store the moment a grant is changed anywhere else — the
/// `cognia-server devices` CLI, the owner API, or the defaults a device
/// receives at enrolment. Reporting the store keeps the switch position and the
/// permission it describes the same fact.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceGrantSummary {
    pub device_id: String,
    pub control: bool,
    pub agent_control: bool,
    pub terminal: bool,
}

#[tauri::command]
pub async fn companion_list_device_grants() -> Result<Vec<DeviceGrantSummary>, String> {
    let security = security_store::security_store()
        .ok_or_else(|| "companion security store is unavailable".to_string())?;
    let devices = security
        .list_devices(&paired_tenant_id())
        .map_err(|error| error.to_string())?;
    Ok(devices
        .into_iter()
        .map(|device| {
            // A grant counts as held only when the device has every capability
            // it maps onto. A partial set is not the grant, and reporting it as
            // one would put the switch back to describing something other than
            // what the gates will allow.
            let holds = |kind: super::device_grants::GrantKind| {
                kind.capabilities()
                    .iter()
                    .all(|capability| device.capabilities.iter().any(|held| held == capability))
            };
            DeviceGrantSummary {
                control: holds(super::device_grants::GrantKind::Control),
                agent_control: holds(super::device_grants::GrantKind::AgentControl),
                terminal: holds(super::device_grants::GrantKind::Terminal),
                device_id: device.device_id,
            }
        })
        .collect())
}

/// Grant or revoke a device's **remote-control** capability (Remote Session
/// Control) — steering sessions, writing files, pushing commits. Driven by the
/// paired-devices card behind the biometric guard.
#[tauri::command]
pub async fn companion_set_remote_control(device_id: String, allowed: bool) -> Result<(), String> {
    apply_device_grant(
        &device_id,
        super::device_grants::GrantKind::Control,
        allowed,
    )
}

/// Grant or revoke a device's **agent-control** capability: starting and
/// driving external agents on this desktop.
///
/// A separate grant from remote control on purpose. Remote control steers work
/// this host already chose to run; this launches new processes. Folding them
/// into one switch would mean a user enabling remote control so their phone can
/// approve a prompt had also handed out process execution.
#[tauri::command]
pub async fn companion_set_agent_control(device_id: String, allowed: bool) -> Result<(), String> {
    apply_device_grant(
        &device_id,
        super::device_grants::GrantKind::AgentControl,
        allowed,
    )
}

/// Grant or revoke interactive terminal access for a paired device.
///
/// Deliberately separate from remote-control and agent-control: it exposes an
/// interactive shell, so neither adjacent capability may imply it. The settings
/// UI performs system confirmation before invoking this command.
#[tauri::command]
pub async fn companion_set_remote_terminal(device_id: String, allowed: bool) -> Result<(), String> {
    apply_device_grant(
        &device_id,
        super::device_grants::GrantKind::Terminal,
        allowed,
    )
}

/// Import the desktop's legacy Dexie grant flags into the SecurityStore, once.
///
/// The desktop's pre-migration truth was `pairedDevices.allowRemoteControl` and
/// its two siblings, re-projected onto in-memory lists at every boot. Those
/// lists are gone, so without this import an upgrading user would silently lose
/// grants they had made. It shares the marker with the headless import in
/// [`super::security_store::SecurityStore::migrate_legacy_device_grants`], so it
/// runs at most once per host and a grant revoked afterwards can never be
/// resurrected by a stale Dexie row on the next launch.
///
/// Returns whether the import actually ran.
#[tauri::command]
pub async fn companion_migrate_legacy_device_grants(
    control: Vec<String>,
    agent_control: Vec<String>,
    terminal: Vec<String>,
) -> Result<bool, String> {
    let security = security_store::security_store()
        .ok_or_else(|| "companion security store is unavailable".to_string())?;
    security
        .migrate_legacy_device_grants(&control, &agent_control, &terminal, unix_time_secs())
        .map_err(|error| error.to_string())
}

/// Grant or revoke opt-in macOS Locked Use for a paired device.
///
/// **Dormant on purpose** — unlike the three grants above, this one does not
/// write the SecurityStore, because its enforcement point is not the RPC
/// capability gate. It writes [`super::locked_use_allow_list`], whose reader is
/// `LockedUseController`; that controller is complete but unreachable until the
/// macOS native edge ships. The paired-devices card renders this switch
/// disabled and labelled unavailable so it cannot imply otherwise. Read
/// [`super::locked_use_allow_list`]'s module docs before changing any of that —
/// the three axes have to move together.
#[tauri::command]
pub async fn companion_set_locked_computer_use(
    device_id: String,
    allowed: bool,
) -> Result<(), String> {
    if device_id.trim().is_empty() {
        return Err("device_id is required".into());
    }
    let acl = super::locked_use_allow_list::global();
    if allowed {
        acl.allow(device_id);
    } else {
        acl.disallow(&device_id);
    }
    Ok(())
}

/// Re-seed Locked Use grants at desktop boot. Still Dexie-projected rather than
/// store-backed, because the list it feeds is in-memory and dormant — see
/// [`companion_set_locked_computer_use`].
#[tauri::command]
pub async fn companion_seed_locked_computer_use(device_ids: Vec<String>) -> Result<(), String> {
    super::locked_use_allow_list::global().reseed(
        device_ids
            .into_iter()
            .filter(|device_id| !device_id.trim().is_empty())
            .collect(),
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Event-channel registration (M2.6)
// ---------------------------------------------------------------------------

/// Bridge every catalogued Tauri event channel into the companion
/// [`EventBus`].
///
/// Called once from [`companion_server_start`] before the axum server is
/// spawned. The channel list itself lives in
/// [`event_channels::EVENT_CHANNELS`](super::event_channels::EVENT_CHANNELS)
/// — registering here only decides whether a Tauri event can reach the bus,
/// while whether it then reaches a given client is the connection's
/// subscription (and that channel's audience) to decide.
///
/// Splitting those two questions is what let this list grow past the original
/// eighteen entries. Before the subscription existed, registering a channel
/// meant broadcasting it to every connected device, so each addition had to be
/// weighed against the bandwidth and exposure it imposed on clients that never
/// asked for it. Now everything added is `default_on: false` and reaches only
/// a client that named it.
pub fn register_default_event_channels(app: &tauri::AppHandle, bus: Arc<EventBus>) {
    for channel in super::event_channels::tauri_forwarded_channels() {
        register_tauri_event(app, Arc::clone(&bus), channel);
    }
    // Phase B4 — push fan-out for events worth notifying about while the
    // phone is offline (WS not subscribed).
    register_push_trigger(app, "claude://message-added");
    // Remote Session Control — a watched host session needs a tool-use
    // approval decision; notify a backgrounded watcher so it doesn't wait
    // out the renderer-side backstop. Emitted by
    // `lib/companion/needs-input-notifier.ts`.
    register_push_trigger(app, "companion://needs-input");
    // ADR-0061 P2 — terminal workflow runs (failed always; succeeded /
    // cancelled only when a paired device triggered the run — policy lives
    // in `companion-run-events.ts`). Payload carries ids + status only.
    register_push_trigger(app, "workflow://run-terminal");
    // ADR-0061 P2 — a workflow is blocked on a human approval; wake
    // backgrounded devices. Ids only (transits APNs/FCM) — the phone
    // fetches the request text via `workflow_approval_list` on open.
    register_push_trigger(app, "workflow://approval-pending");
    // ADR-0061 P3 — a remote step is waiting on a device. Ids only; the
    // request params ride the WS frame the device receives on open.
    register_push_trigger(app, "workflow://step-pending");
    // Host computer-use is blocked on a HITL consent decision. Without this
    // the prompt reached foreground devices only, so a backgrounded phone
    // never saw it and the broker fail-closed on timeout — i.e. remote
    // supervision silently didn't work whenever the screen was off.
    // The payload is sanitized down to ids by `push_data_for_channel`.
    register_push_trigger(app, AUTOMATION_CONSENT_CHANNEL);
    // ADR-0131 cross-shell inbox relay — an inbound IM message landed on this
    // host. Without a push a paired phone only learns about it when it next
    // comes to the foreground, which is exactly the case the relay exists to
    // fix (bot on the desktop, operator on the phone). Payload is ids + the
    // `/inbox/c?key=…` deep link; message text never rides the push.
    register_push_trigger(app, CONNECTOR_MESSAGE_ADDED_CHANNEL);
}

/// Channel announcing an inbound IM message (ADR-0131). Named because the
/// event-bus registration, the push trigger, and the body builder all
/// reference it.
pub(crate) const CONNECTOR_MESSAGE_ADDED_CHANNEL: &str = "connector://message-added";

/// Channel carrying host computer-use consent prompts. Named because both the
/// event-bus registration and the push trigger reference it, and because its
/// payload needs channel-specific sanitizing before it can transit a push.
pub(crate) const AUTOMATION_CONSENT_CHANNEL: &str = "automation:consent-request";

/// Human-ish push body for a channel: strip any `scheme://` prefix so e.g.
/// `workflow://run-terminal` renders as `run-terminal`. The phone resolves
/// real display text from its synced mirror via `data`.
///
/// The consent channel gets a real sentence instead, because there is nothing
/// for the phone to resolve it against until the user opens the app — and the
/// whole point is to let them triage from the lock screen. It names the action
/// and the process but **never** the window title: notification text is
/// readable by anyone holding the phone, and the title is the field most
/// likely to carry something private ("Re: severance package.xlsx").
fn push_body_for_channel(
    channel: &str,
    data: &serde_json::Map<String, serde_json::Value>,
) -> String {
    if channel == AUTOMATION_CONSENT_CHANNEL {
        let command = data
            .get("command")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("a desktop action");
        return match data
            .get("processName")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            Some(process) => format!("Confirm {command} in {process}"),
            None => format!("Confirm {command}"),
        };
    }
    if channel == CONNECTOR_MESSAGE_ADDED_CHANNEL {
        // Name the conversation, never the message. `senderName` is already
        // the display name the operator sees in the Inbox list; when the
        // adapter could not resolve one, fall back to the platform so the
        // notification still says *where* rather than nothing.
        let who = data
            .get("senderName")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        let platform = data
            .get("platform")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        return match (who, platform) {
            (Some(who), Some(platform)) => format!("New message from {who} on {platform}"),
            (Some(who), None) => format!("New message from {who}"),
            (None, Some(platform)) => format!("New message on {platform}"),
            (None, None) => "New message".to_string(),
        };
    }
    match channel.split_once("://") {
        Some((_, rest)) => rest.to_string(),
        None => channel.to_string(),
    }
}

/// Project an event payload into the `data` map that rides the push.
///
/// Most channels pass through: they already carry ids only. The consent
/// channel does not — its frame holds a screen thumbnail (tens of KB, far past
/// the ~4 KB APNs/FCM payload ceiling, so passing it through would break the
/// push outright) plus the window title and the full command detail, which are
/// exactly the fields decided to stay off the lock screen. Allowlist down to
/// what the phone needs to deep-link; it reads the rest off the authenticated
/// WS frame once opened.
fn push_data_for_channel(
    channel: &str,
    raw: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    if channel != AUTOMATION_CONSENT_CHANNEL {
        return raw.clone();
    }
    let mut out = serde_json::Map::new();
    if let Some(id) = raw.get("id").and_then(|v| v.as_str()) {
        out.insert("id".into(), serde_json::Value::String(id.to_string()));
    }
    out.insert(
        "source".into(),
        serde_json::Value::String("automation".into()),
    );
    // The consent sheet is mounted app-wide (`mobile-shell-wrapper.tsx`), so
    // any route brings it up; the deep link only has to foreground the app.
    out.insert("href".into(), serde_json::Value::String("/".into()));
    out
}

/// Subscribe to `channel` and, on each emit, broadcast a push payload to
/// every registered device whose WebSocket isn't currently open. No-op when
/// no push dispatchers are configured.
fn register_push_trigger(app: &tauri::AppHandle, channel: &'static str) {
    use tauri::Listener as _;
    let app_clone = app.clone();
    app.listen(channel, move |event| {
        let raw = event.payload().to_string();
        let app2 = app_clone.clone();
        let channel_name = channel.to_string();
        tauri::async_runtime::spawn(async move {
            // Probe Tauri-managed state for the registry; absent in tests.
            let Some(state) = app2.try_state::<super::CompanionServerState>() else {
                return;
            };
            let registry = std::sync::Arc::clone(&state.push_tokens);
            let dispatchers = super::push_dispatchers();

            let raw_data: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&raw)
                .ok()
                .and_then(|v: serde_json::Value| v.as_object().cloned())
                .unwrap_or_default();
            // Body is derived from the *raw* payload (it needs the action and
            // process name); `data` is the sanitized projection that actually
            // transits the push provider.
            let payload = super::push::PushPayload {
                title: Some("cognia".into()),
                body: Some(push_body_for_channel(&channel_name, &raw_data)),
                data: push_data_for_channel(&channel_name, &raw_data),
            };

            for provider in [
                super::push::PushProvider::Fcm,
                super::push::PushProvider::Apns,
            ] {
                if let Some(d) = dispatchers.for_provider(provider) {
                    let _ = registry
                        .broadcast_to_offline(provider, &payload, d.as_ref())
                        .await;
                }
            }
        });
    });
}

// ---------------------------------------------------------------------------
// Lifecycle commands (M2.8)
// ---------------------------------------------------------------------------

/// Stop the running companion server (no-op if not running).
///
/// Called by the M2.8 settings UI when the user turns the master toggle off.
/// Always succeeds — a missing handle is treated as already-stopped.
#[tauri::command]
pub async fn companion_server_stop(state: State<'_, CompanionServerState>) -> Result<(), String> {
    state.stop();
    Ok(())
}

/// Snapshot of the current server lifecycle for the settings UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionServerStatus {
    /// Whether the axum listener is currently bound.
    pub running: bool,
    /// `"loopback"` | `"lan"` | `"none"`.
    ///
    /// `"none"` is emitted when the server is stopped — distinct from
    /// `"loopback"` so the UI can keep the previously-chosen radio button
    /// state separately from the live binding.
    pub bind_mode: &'static str,
    /// The OS-assigned bound port if the server is running.
    pub bound_port: Option<u16>,
}

/// Live status snapshot for the settings UI.
#[tauri::command]
pub fn companion_server_status(state: State<'_, CompanionServerState>) -> CompanionServerStatus {
    let running = state.is_running();
    let bound_port = state.bound_port();
    let bind_mode = match state.bind_mode() {
        Some(BindMode::Loopback) => "loopback",
        Some(BindMode::Lan) => "lan",
        None => "none",
    };
    CompanionServerStatus {
        running,
        bind_mode,
        bound_port,
    }
}

/// One-time owner invitation and discovery data encoded in a pairing QR.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerInvitationIssue {
    pub invitation: String,
    pub expires_at_ms: i64,
    pub base_url: String,
    pub fingerprint: String,
    pub app_version: String,
    pub host_id: String,
    pub tenant_id: String,
}

/// Renderer-facing view of the browser-access configuration.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAccessSummary {
    /// Whether the user has switched browser access on.
    pub enabled: bool,
    /// Exact browser origins allowed to reach this Host.
    pub allowed_origins: Vec<String>,
    /// Configured loopback port for the plaintext listener.
    pub port: u16,
    /// The port the listener is actually bound to right now. `None` when the
    /// server is stopped or the listener could not bind — which is how the UI
    /// distinguishes "configured" from "working".
    pub bound_port: Option<u16>,
    /// Origins offered as a starting point. Never applied implicitly.
    pub suggested_origins: Vec<String>,
    /// Base URL a browser should use, once the listener is live.
    pub browser_base_url: Option<String>,
    /// Origin a "pair in browser" link should open.
    pub primary_origin: Option<String>,
}

fn browser_access_summary(
    state: &State<'_, CompanionServerState>,
    config: browser_access::BrowserAccessConfig,
) -> BrowserAccessSummary {
    let bound_port = state.browser_port();
    BrowserAccessSummary {
        browser_base_url: bound_port.map(|port| format!("http://127.0.0.1:{port}")),
        primary_origin: config.primary_origin().map(str::to_string),
        enabled: config.enabled,
        allowed_origins: config.allowed_origins.clone(),
        port: config.port,
        bound_port,
        suggested_origins: browser_access::SUGGESTED_ORIGINS
            .iter()
            .map(|origin| (*origin).to_string())
            .collect(),
    }
}

/// Read the browser-access configuration and its live binding.
#[tauri::command]
pub fn companion_browser_access_get(
    state: State<'_, CompanionServerState>,
) -> BrowserAccessSummary {
    let config = browser_access::load(state.data_dir());
    browser_access_summary(&state, config)
}

/// Persist the browser-access configuration.
///
/// Takes effect on the next server start: the plaintext listener is bound
/// alongside the HTTPS one, and rebinding it under a live server would drop
/// in-flight browser connections mid-request. The renderer restarts the server
/// to apply, which is the same round-trip the bind-mode switch already makes.
#[tauri::command]
pub fn companion_browser_access_set(
    state: State<'_, CompanionServerState>,
    enabled: bool,
    allowed_origins: Vec<String>,
    port: Option<u16>,
) -> Result<BrowserAccessSummary, String> {
    let saved = browser_access::save(
        state.data_dir(),
        browser_access::BrowserAccessConfig {
            enabled,
            allowed_origins,
            port: port.unwrap_or(browser_access::DEFAULT_BROWSER_PORT),
        },
    )?;
    Ok(browser_access_summary(&state, saved))
}

/// One-time least-privilege worker enrollment and connection metadata.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerEnrollmentIssue {
    pub enrollment: String,
    pub expires_at_ms: i64,
    pub base_url: String,
    pub fingerprint: String,
    pub tenant_id: String,
}

#[tauri::command]
pub async fn companion_create_worker_enrollment(
    state: State<'_, CompanionServerState>,
    app_handle: tauri::AppHandle,
) -> Result<WorkerEnrollmentIssue, String> {
    const ENROLLMENT_TTL_SECS: i64 = 10 * 60;
    let port = state.bound_port().unwrap_or(DEFAULT_PORT);
    let (base_url, is_tunnel) = if let Some(info) = state.tunnel.current() {
        (info.public_url, true)
    } else if let Some(hostname) = state.tunnel.named_public_url() {
        (hostname, true)
    } else {
        let host = match state.bind_mode() {
            Some(BindMode::Lan) => detect_lan_ip().unwrap_or_else(|| "127.0.0.1".to_string()),
            _ => "127.0.0.1".to_string(),
        };
        (format!("https://{host}:{port}"), false)
    };
    let fingerprint = if is_tunnel {
        String::new()
    } else {
        ensure_tls_fingerprint(&app_handle).unwrap_or_default()
    };
    let now = unix_time_secs();
    let security = security_store::security_store()
        .ok_or_else(|| "companion security store is unavailable".to_string())?;
    // Same tenant the pairing commands enrol into: a worker filed under a
    // different one would authenticate and then find no grants.
    let tenant_id = paired_tenant_id();
    let enrollment = security
        .create_worker_enrollment(&tenant_id, "local-trust-root", now, ENROLLMENT_TTL_SECS)
        .map_err(|error| error.to_string())?;
    Ok(WorkerEnrollmentIssue {
        enrollment,
        expires_at_ms: now.saturating_add(ENROLLMENT_TTL_SECS) * 1_000,
        base_url,
        fingerprint,
        tenant_id,
    })
}

#[tauri::command]
pub async fn companion_list_workers() -> Result<Vec<super::ws_worker::WorkerDeviceSummary>, String>
{
    let tenant_id = paired_tenant_id();
    let security = security_store::security_store()
        .ok_or_else(|| "companion security store is unavailable".to_string())?;
    let devices = security
        .list_worker_devices(&tenant_id)
        .map_err(|error| error.to_string())?;
    Ok(super::ws_worker::worker_device_summaries(
        &tenant_id, devices,
    ))
}

#[tauri::command]
pub async fn companion_set_worker(device_id: String, allowed: bool) -> Result<(), String> {
    if device_id.trim().is_empty() {
        return Err("device_id is required".into());
    }
    let tenant_id = paired_tenant_id();
    let security = security_store::security_store()
        .ok_or_else(|| "companion security store is unavailable".to_string())?;
    let mut capabilities = security
        .capability_snapshot(&tenant_id, &device_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "worker device is unavailable".to_string())?;
    capabilities.retain(|capability| capability != "agent.worker");
    if allowed {
        capabilities.push("agent.worker".to_string());
    }
    security
        .replace_device_capabilities(
            &tenant_id,
            "local-trust-root",
            &device_id,
            &capabilities,
            unix_time_secs(),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Create the destructive-upgrade pairing payload. No bearer credential is
/// placed in the QR; the invitation can be consumed exactly once by device-key
/// registration.
///
/// Takes no account argument. It used to accept a `localAccountId` that the body
/// ignored in favour of a hardcoded tenant, so the caller's account had no
/// effect on which tenant the device was enrolled into. The tenant now comes
/// from the host binding, which is the same source
/// [`super::api::registration_authority`] uses to admit the device that redeems
/// this invitation. A `renderer_never_supplies_an_account_id` pin test on each
/// side keeps the argument from creeping back — `audit:command-parity` only
/// diffs command *names*, so a stale TS argument would pass every gate and then
/// fail at runtime.
#[tauri::command]
pub async fn companion_create_owner_invitation(
    state: State<'_, CompanionServerState>,
    app_handle: tauri::AppHandle,
) -> Result<OwnerInvitationIssue, String> {
    const INVITATION_TTL_SECS: i64 = 5 * 60;

    let port = state.bound_port().unwrap_or(DEFAULT_PORT);
    let (base_url, is_tunnel) = if let Some(info) = state.tunnel.current() {
        (info.public_url, true)
    } else if let Some(hostname) = state.tunnel.named_public_url() {
        (hostname, true)
    } else {
        let host = match state.bind_mode() {
            Some(BindMode::Lan) => detect_lan_ip().unwrap_or_else(|| "127.0.0.1".to_string()),
            _ => "127.0.0.1".to_string(),
        };
        (format!("https://{host}:{port}"), false)
    };
    let fingerprint = if is_tunnel {
        String::new()
    } else {
        ensure_tls_fingerprint(&app_handle).unwrap_or_default()
    };
    let now = unix_time_secs();
    let security = security_store::security_store()
        .ok_or_else(|| "companion security store is unavailable".to_string())?;
    // Resolve once: the tenant the invitation is filed under and the tenant
    // stamped into the QR must be the same string, or the phone dials a tenant
    // that holds no invitation.
    let tenant_id = paired_tenant_id();
    let invitation = security
        .create_owner_invitation(&tenant_id, "local-trust-root", now, INVITATION_TTL_SECS)
        .map_err(|error| error.to_string())?;
    let signing_secret = secret::load_or_generate().map_err(|error| error.to_string())?;

    Ok(OwnerInvitationIssue {
        invitation,
        expires_at_ms: now.saturating_add(INVITATION_TTL_SECS) * 1_000,
        base_url,
        fingerprint,
        app_version: app_handle.package_info().version.to_string(),
        host_id: super::healthz::derive_server_id(&signing_secret),
        tenant_id,
    })
}

fn unix_time_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

// ---------------------------------------------------------------------------
// TLS / mDNS / Tunnel commands (Wave 1.4 / 1.5 / 1.6)
// ---------------------------------------------------------------------------

fn data_dir(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))
}

fn ensure_tls_fingerprint(app_handle: &tauri::AppHandle) -> Result<String, String> {
    let dir = data_dir(app_handle)?;
    let material = tls::ensure_certificate(&dir).map_err(|e| e.to_string())?;
    Ok(material.fingerprint_sha256)
}

/// Lazily generate (or load) the companion-server TLS cert and return its
/// SHA-256 SubjectPublicKeyInfo fingerprint. The mobile pair flow encodes
/// this into the QR payload so the phone can pin the cert.
#[tauri::command]
pub fn companion_get_tls_fingerprint(app_handle: tauri::AppHandle) -> Result<String, String> {
    ensure_tls_fingerprint(&app_handle)
}

/// Diagnostics: where the companion TLS cert + key live on disk. Used by
/// the Settings → Companion advanced view so a user can inspect / rotate
/// the cert without grepping app-data paths by hand.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionTlsPaths {
    pub cert_pem_path: String,
    pub key_pem_path: String,
    pub fingerprint_sha256: String,
}

#[tauri::command]
pub fn companion_tls_paths(app_handle: tauri::AppHandle) -> Result<CompanionTlsPaths, String> {
    let dir = data_dir(&app_handle)?;
    let material = tls::ensure_certificate(&dir).map_err(|e| e.to_string())?;
    Ok(CompanionTlsPaths {
        cert_pem_path: material.cert_pem_path.to_string_lossy().into_owned(),
        key_pem_path: material.key_pem_path.to_string_lossy().into_owned(),
        fingerprint_sha256: material.fingerprint_sha256,
    })
}

/// Begin advertising the running companion server over mDNS so phones on
/// the same LAN can discover it without typing a URL. Idempotent — repeat
/// calls replace the existing broadcast.
#[tauri::command]
pub fn companion_mdns_start(
    state: State<'_, CompanionServerState>,
    app_handle: tauri::AppHandle,
    port: u16,
    app_version: String,
    tls_fingerprint: String,
    instance_name: Option<String>,
) -> Result<String, String> {
    let instance_name = instance_name.unwrap_or_else(|| {
        let suffix: String = uuid::Uuid::new_v4().simple().to_string()[..6].to_string();
        format!("cognia-{suffix}")
    });
    let _ = app_handle; // reserved for future logging-by-app-id
    state
        .mdns
        .start_auto(AutoStartConfig {
            instance_name,
            port,
            app_version,
            tls_fingerprint,
        })
        .map_err(|e| e.to_string())
}

/// Stop the mDNS broadcaster. No-op if not running.
#[tauri::command]
pub fn companion_mdns_stop(state: State<'_, CompanionServerState>) {
    state.mdns.stop();
}

/// Whether the mDNS broadcaster is currently active.
#[tauri::command]
pub fn companion_mdns_status(state: State<'_, CompanionServerState>) -> bool {
    state.mdns.is_running()
}

/// One `_cognia._tcp` host this desktop can see on the LAN, plus whether it is
/// this desktop's own advertisement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowsedHost {
    #[serde(flatten)]
    pub host: super::mdns::DiscoveredHost,
    /// `https://<addr>:<port>` — precomputed so the renderer does not
    /// re-derive URL assembly (and get IPv6 bracketing wrong).
    pub base_url: Option<String>,
    /// This machine's own broadcast. Kept in the list rather than filtered out
    /// so the Add-host form can say "that's this computer" instead of showing
    /// a host that silently fails to pair with itself.
    pub is_self: bool,
}

/// Sweep the LAN for other Cognia hosts advertising over mDNS.
///
/// The desktop has advertised `_cognia._tcp` since Wave 1.5 but never listened
/// for it, so pairing this desktop *to another host* (ADR-0082) meant typing an
/// address for a machine that was broadcasting its own the whole time.
///
/// `timeout_ms` is clamped to a sane sweep window: below ~500 ms a host that is
/// awake but slow to answer is missed, and above ~10 s the form appears hung.
/// Runs on the blocking pool — [`super::mdns::browse_once`] parks on the mDNS
/// event channel and would otherwise stall the UI thread for its whole window.
#[tauri::command]
pub async fn companion_mdns_browse(
    state: State<'_, CompanionServerState>,
    timeout_ms: Option<u64>,
) -> Result<Vec<BrowsedHost>, String> {
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(2_000).clamp(500, 10_000));
    let own_fullname = state.mdns.current_fullname();

    let hosts = tauri::async_runtime::spawn_blocking(move || super::mdns::browse_once(timeout))
        .await
        .map_err(|error| format!("mdns browse task failed: {error}"))?
        .map_err(|error| error.to_string())?;

    Ok(hosts
        .into_iter()
        .map(|host| BrowsedHost {
            base_url: host.base_url(),
            is_self: own_fullname.as_deref() == Some(host.fullname.as_str()),
            host,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Reachability preference — persisted "how should this desktop be reachable"
// ---------------------------------------------------------------------------

/// Read the saved reachability preference. Returns the all-off default when
/// nothing has been saved, so the caller never has to special-case "first run".
#[tauri::command]
pub fn companion_reachability_get(
    app_handle: tauri::AppHandle,
) -> Result<ReachabilityConfig, String> {
    let dir = data_dir(&app_handle)?;
    Ok(reachability_config::load_config(Some(&dir)))
}

/// Persist the reachability preference.
///
/// Called by Settings → Companion when the user changes the server switch, the
/// bind mode, or the mDNS switch. Deliberately **not** called by
/// `companion_server_start`: see the module docs on why only user intent — and
/// not every internal start — is allowed to write this file.
#[tauri::command]
pub fn companion_reachability_set(
    app_handle: tauri::AppHandle,
    config: ReachabilityConfig,
) -> Result<(), String> {
    let dir = data_dir(&app_handle)?;
    reachability_config::save_config(Some(&dir), &config)
}

/// What [`restore_reachability`] actually did, for logs and for the test that
/// pins the "advertise only behind a live listener" rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReachabilityRestoreOutcome {
    /// Whether the companion listener was started by this call.
    pub restored: bool,
    /// The port it actually bound, when it started.
    pub port: Option<u16>,
    /// Whether mDNS advertising was (re-)established.
    pub advertising: bool,
}

impl ReachabilityRestoreOutcome {
    fn skipped() -> Self {
        Self {
            restored: false,
            port: None,
            advertising: false,
        }
    }
}

/// Boot-time restore of the saved reachability preference.
///
/// Invoked from the Tauri `setup` hook rather than from the renderer, so a
/// launch that never opens a window (tray-only start, autostart at login) still
/// becomes reachable. A phone that paired over the LAN can therefore find this
/// desktop again after a restart without the user opening Settings.
///
/// Both legs delegate to the same commands the Settings switches call, so the
/// restored path and the manual path cannot drift apart.
pub async fn restore_reachability(
    app_handle: tauri::AppHandle,
) -> Result<ReachabilityRestoreOutcome, String> {
    let dir = data_dir(&app_handle)?;
    let config = reachability_config::load_config(Some(&dir));
    if !config.restores_anything() {
        return Ok(ReachabilityRestoreOutcome::skipped());
    }

    let state = app_handle.state::<CompanionServerState>();
    let port = companion_server_start(
        state.clone(),
        app_handle.clone(),
        config.port,
        config.bind_loopback_only,
    )
    .await
    .map_err(|error| error.to_string())?;

    // `advertises()` — not `mdns_enabled` — because advertising without a live
    // listener publishes an address that refuses every connection.
    let advertising = if config.advertises() {
        let fingerprint = ensure_tls_fingerprint(&app_handle)?;
        companion_mdns_start(
            state.clone(),
            app_handle.clone(),
            port,
            env!("CARGO_PKG_VERSION").to_string(),
            fingerprint,
            None,
        )?;
        true
    } else {
        false
    };

    Ok(ReachabilityRestoreOutcome {
        restored: true,
        port: Some(port),
        advertising,
    })
}

/// Start a Cloudflared tunnel. The mode is read from persisted config:
/// - **Quick**: spawns `cloudflared tunnel --url <local_url>` and waits for the
///   random `*.trycloudflare.com` URL.
/// - **Named**: reads the connector token from the keyring and spawns
///   `cloudflared tunnel run --token <token>`.
///
/// Errors with "not_installed" if cloudflared is missing from PATH, or
/// "no named config" if the user selected Named mode but hasn't saved a
/// token/hostname yet.
#[tauri::command]
pub async fn companion_tunnel_start(
    state: State<'_, CompanionServerState>,
    local_url: String,
) -> Result<TunnelInfo, String> {
    let config = super::tunnel_config::load_config(state.data_dir());
    match config.mode {
        super::tunnel_config::TunnelMode::Named => {
            let token = super::tunnel_config::load_token()
                .map_err(|e: String| e)?
                .ok_or("named tunnel token not found — save config first")?;
            let named = config.named.ok_or("named tunnel hostname not configured")?;
            state
                .tunnel
                .start_named(&token, &named)
                .await
                .map_err(map_tunnel_error)
        }
        super::tunnel_config::TunnelMode::Quick => state
            .tunnel
            .start(&local_url)
            .await
            .map_err(map_tunnel_error),
    }
}

fn map_tunnel_error(e: tunnel::TunnelError) -> String {
    match e {
        tunnel::TunnelError::NotInstalled => {
            "cloudflared not found in PATH (install: https://developers.cloudflare.com/cloudflared/install/)".to_string()
        }
        other => other.to_string(),
    }
}

/// Stop the Cloudflared tunnel. No-op if not running.
#[tauri::command]
pub fn companion_tunnel_stop(state: State<'_, CompanionServerState>) {
    state.tunnel.stop();
}

/// Return the active tunnel info, or null when no tunnel is running.
#[tauri::command]
pub fn companion_tunnel_current(state: State<'_, CompanionServerState>) -> Option<TunnelInfo> {
    state.tunnel.current()
}

/// Save a named tunnel configuration: token goes to the OS keyring,
/// hostname + mode switch go to the config file.
#[tauri::command]
pub fn companion_tunnel_save_named_config(
    state: State<'_, CompanionServerState>,
    token: String,
    hostname: String,
) -> Result<(), String> {
    super::tunnel_config::save_named(state.data_dir(), &token, &hostname).map_err(|e: String| e)?;
    state
        .tunnel
        .set_named_config(super::tunnel_config::NamedTunnelConfig { hostname });
    Ok(())
}

/// Get the current tunnel config summary (mode, hostname, hasToken).
/// The secret token itself is NOT returned.
#[tauri::command]
pub fn companion_tunnel_get_config(
    state: State<'_, CompanionServerState>,
) -> super::tunnel_config::TunnelConfigSummary {
    super::tunnel_config::summarize(state.data_dir())
}

/// Switch tunnel mode. When switching to Quick, the named config and token
/// are cleared from persistence.
#[tauri::command]
pub fn companion_tunnel_set_mode(
    state: State<'_, CompanionServerState>,
    mode: super::tunnel_config::TunnelMode,
) -> Result<(), String> {
    match mode {
        super::tunnel_config::TunnelMode::Quick => {
            super::tunnel_config::clear_named(state.data_dir()).map_err(|e: String| e)?;
            state.tunnel.stop();
        }
        super::tunnel_config::TunnelMode::Named => {
            super::tunnel_config::save_config(
                state.data_dir(),
                &super::tunnel_config::TunnelConfigFile {
                    mode: super::tunnel_config::TunnelMode::Named,
                    named: super::tunnel_config::load_config(state.data_dir()).named,
                },
            )
            .map_err(|e: String| e)?;
        }
    }
    Ok(())
}

/// Clear the named tunnel config (token + hostname) while keeping the mode
/// set to Named. This lets the user wipe credentials and re-enter them
/// without toggling the mode radio.
#[tauri::command]
pub fn companion_tunnel_clear_named(state: State<'_, CompanionServerState>) -> Result<(), String> {
    super::tunnel_config::clear_named(state.data_dir()).map_err(|e: String| e)?;
    state.tunnel.stop();
    Ok(())
}

// ---------------------------------------------------------------------------
// Push delivery configuration (Phase B2 / B3)
// ---------------------------------------------------------------------------

/// Install an FCM dispatcher built from a service-account JSON payload.
/// The JSON is exactly what the Google Cloud Console hands out under
/// IAM → Service Accounts → Keys → "Create new key" → JSON. Credentials
/// are persisted via the active `PushCredStore` (keyring on desktop, JSON
/// file in headless mode) so they survive restarts.
#[tauri::command]
pub fn companion_push_configure_fcm(service_account_json: String) -> Result<(), String> {
    let creds: super::dispatchers::FcmServiceAccount = serde_json::from_str(&service_account_json)
        .map_err(|e| format!("invalid FCM service-account JSON: {e}"))?;
    if let Some(store) = super::push_creds::active() {
        store.store_fcm(&creds)?;
    }
    let dispatcher = super::dispatchers::FcmDispatcher::new(creds);
    super::push_dispatchers().set_fcm(dispatcher);
    Ok(())
}

/// Install an APNs dispatcher from key + identifier inputs.
#[tauri::command]
pub fn companion_push_configure_apns(
    key_id: String,
    team_id: String,
    bundle_id: String,
    private_key_pem: String,
    production: bool,
) -> Result<(), String> {
    let persisted = super::push_creds::PersistedApns {
        key_id,
        team_id,
        bundle_id,
        private_key_pem,
        production,
    };
    if let Some(store) = super::push_creds::active() {
        store.store_apns(&persisted)?;
    }
    let dispatcher = super::dispatchers::ApnsDispatcher::new(persisted.clone().into())?;
    super::push_dispatchers().set_apns(dispatcher);
    Ok(())
}

/// Clear the FCM dispatcher (e.g. after the user rotates credentials).
#[tauri::command]
pub fn companion_push_clear_fcm() -> Result<(), String> {
    if let Some(store) = super::push_creds::active() {
        store.clear_fcm()?;
    }
    super::push_dispatchers().clear_fcm();
    Ok(())
}

/// Clear the APNs dispatcher.
#[tauri::command]
pub fn companion_push_clear_apns() -> Result<(), String> {
    if let Some(store) = super::push_creds::active() {
        store.clear_apns()?;
    }
    super::push_dispatchers().clear_apns();
    Ok(())
}

/// Diagnostics — which providers are currently configured. Used by the
/// Settings UI to render the "Configured ✓" badges.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushConfigStatus {
    pub fcm_configured: bool,
    pub apns_configured: bool,
}

#[tauri::command]
pub fn companion_push_status() -> Result<PushConfigStatus, String> {
    let store = super::push_creds::active();
    let (fcm, apns) = match store {
        Some(s) => (s.load_fcm()?.is_some(), s.load_apns()?.is_some()),
        None => (false, false),
    };
    Ok(PushConfigStatus {
        fcm_configured: fcm,
        apns_configured: apns,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushBroadcastResult {
    pub sent: usize,
}

/// Build the deliberately metadata-only payload used by the unified
/// Notification Center's `push` channel. Notification title/body may contain
/// local or user-authored text, so they must never transit APNs/FCM here.
fn notification_center_push_payload(
    notification_id: &str,
    source: &str,
    level: &str,
    href: Option<&str>,
) -> Result<super::push::PushPayload, String> {
    if notification_id.trim().is_empty()
        || notification_id.len() > 128
        || notification_id.chars().any(char::is_control)
    {
        return Err("notificationId must be 1..128 printable bytes".into());
    }
    if !matches!(level, "info" | "success" | "warning" | "error" | "critical") {
        return Err("level must be a valid notification level".into());
    }
    if !matches!(
        source,
        "scheduler" | "agent-team" | "plugin" | "connector" | "session" | "workflow" | "system"
    ) {
        return Err("source must be a valid notification source".into());
    }
    if href.is_some_and(|value| {
        !value.starts_with('/') || value.starts_with("//") || value.len() > 512
    }) {
        return Err("href must be an app-relative path".into());
    }

    let mut data = serde_json::Map::new();
    data.insert(
        "notificationId".into(),
        serde_json::Value::String(notification_id.to_string()),
    );
    data.insert("level".into(), serde_json::Value::String(level.to_string()));
    data.insert(
        "source".into(),
        serde_json::Value::String(source.to_string()),
    );
    if let Some(value) = href {
        data.insert("href".into(), serde_json::Value::String(value.to_string()));
    }

    Ok(super::push::PushPayload {
        title: Some("Cognia".into()),
        body: Some("Open Cognia to view new activity".into()),
        data,
    })
}

/// Fan out a Notification Center record to configured APNs/FCM dispatchers.
/// Only offline devices receive provider pushes; foreground devices keep using
/// the authenticated realtime channel and avoid a duplicate native alert.
#[tauri::command]
pub async fn companion_push_notification(
    state: State<'_, CompanionServerState>,
    notification_id: String,
    source: String,
    level: String,
    href: Option<String>,
) -> Result<PushBroadcastResult, String> {
    let payload =
        notification_center_push_payload(&notification_id, &source, &level, href.as_deref())?;
    let dispatchers = super::push_dispatchers();
    let mut sent = 0;
    for provider in [
        super::push::PushProvider::Fcm,
        super::push::PushProvider::Apns,
    ] {
        if let Some(dispatcher) = dispatchers.for_provider(provider) {
            sent += state
                .push_tokens
                .broadcast_to_offline(provider, &payload, dispatcher.as_ref())
                .await;
        }
    }
    Ok(PushBroadcastResult { sent })
}

// ---------------------------------------------------------------------------
// Connection diagnostics (Phase C2)
// ---------------------------------------------------------------------------

/// Per-candidate test-connection result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionReachability {
    pub url: String,
    pub reachable: bool,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

/// Probe the local companion server on every plausible host (loopback, LAN
/// IP, optional tunnel) and report which paths are reachable. The mobile
/// app uses the same priority list (`lib/connectivity/connection-strategy.ts`)
/// but from the phone side; this command is the desktop's mirror — useful
/// for "is my server reachable at all" diagnostics.
#[tauri::command]
pub async fn companion_test_local_reachability(
    state: State<'_, CompanionServerState>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<CompanionReachability>, String> {
    let port = state
        .bound_port()
        .ok_or_else(|| "server not running".to_string())?;
    let mut candidates: Vec<String> = vec![format!("https://127.0.0.1:{port}")];
    if let Some(lan) = detect_lan_ip() {
        candidates.push(format!("https://{lan}:{port}"));
    }
    if let Some(info) = state.tunnel.current() {
        candidates.push(info.public_url);
    }

    let fp = ensure_tls_fingerprint(&app_handle).unwrap_or_default();
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(5))
        // These are audited self-reachability probes (loopback, LAN address,
        // and this process's own tunnel), not desktop public egress.
        .no_proxy()
        .build()
        .map_err(|e| format!("reqwest builder: {e}"))?;

    let mut out = Vec::with_capacity(candidates.len());
    for url in candidates {
        let started = std::time::Instant::now();
        // Hit the canonical public health endpoint; reachability diagnostics
        // must not mint or depend on any credential.
        let probe_url = format!("{}/healthz", url.trim_end_matches('/'));
        match client.get(&probe_url).send().await {
            Ok(resp) => {
                let ok = resp.status().is_success();
                out.push(CompanionReachability {
                    url,
                    reachable: ok,
                    latency_ms: Some(started.elapsed().as_millis() as u64),
                    error: if ok {
                        None
                    } else {
                        Some(format!("HTTP {}", resp.status()))
                    },
                });
            }
            Err(err) => {
                out.push(CompanionReachability {
                    url,
                    reachable: false,
                    latency_ms: None,
                    error: Some(err.to_string()),
                });
            }
        }
    }
    // Silence unused warning on the fingerprint when it's not consumed.
    let _ = fp;
    Ok(out)
}

/// Best-effort detect a routable LAN IPv4 address.  Returns `None` when the
/// host has no non-loopback interface (e.g., container without a network).
///
/// `pub(crate)` so the `companion_endpoints` RPC arm can report the same LAN
/// address the QR pair payload would have carried — a phone that paired over a
/// tunnel needs it to discover that the desktop is also reachable on the LAN.
pub(crate) fn detect_lan_ip() -> Option<String> {
    match local_ip_address::local_ip() {
        Ok(IpAddr::V4(v4)) if !v4.is_loopback() && !v4.is_unspecified() => Some(v4.to_string()),
        Ok(IpAddr::V6(v6)) if !v6.is_loopback() && !v6.is_unspecified() => Some(v6.to_string()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    // Commands that require `tauri::AppHandle` cannot be unit-tested without a
    // full Tauri runtime, which is impractical in `--lib` mode.  The logic
    // exercised here is the `CompanionServerState` orchestration, which is
    // covered by `mod.rs::tests`.  Integration behaviour (keyring load, full
    // start → HTTP request → shutdown) is covered by `server::tests`.
    //
    // Compile-only smoke: ensure the module builds without errors.

    use super::*;

    #[test]
    fn commands_module_compiles() {}

    /// `companion_create_owner_invitation` must not regrow an account argument.
    ///
    /// It used to take a `_local_account_id` the body threw away, so the
    /// renderer believed it was choosing an account while the command enrolled
    /// into a hardcoded tenant. `audit:command-parity` compares command *names*
    /// only, so a re-added argument would pass every gate in the repo and then
    /// fail at runtime with an arity error. The renderer half is pinned by
    /// `companion-section.test.tsx`, which asserts the invoke carries no args.
    #[test]
    fn the_owner_invitation_command_takes_no_account_argument() {
        let source = include_str!("commands.rs");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .expect("production commands.rs source");
        let signature = production
            .split("pub async fn companion_create_owner_invitation(")
            .nth(1)
            .expect("the owner invitation command must exist")
            .split(')')
            .next()
            .expect("a parameter list");
        assert!(
            !signature.contains("account"),
            "companion_create_owner_invitation must take no account parameter, got: {signature}"
        );
    }

    /// The tenant is resolved from the host binding, not spelled as a literal.
    ///
    /// Every device row, grant and audit event on this host is filed under it,
    /// so a literal here means two installs share one tenant id and a bound
    /// account addresses a tenant nothing enrolled into.
    #[test]
    fn no_command_addresses_a_hardcoded_tenant() {
        let source = include_str!("commands.rs");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .expect("production commands.rs source");
        // The quoted form only: the prose above `paired_tenant_id` names the
        // literal it replaced, and a doc comment is not a call site.
        assert!(
            !production.contains(&format!("{q}local_acct_a{q}", q = '"')),
            "companion commands must resolve the tenant through host_identity"
        );
    }

    /// The QR must advertise the same tenant the invitation was filed under.
    ///
    /// These were two separately-written strings that happened to match. Once
    /// the tenant came from a binding they could drift, and a phone dialling
    /// the advertised tenant would find no invitation there.
    #[tokio::test]
    async fn the_invitation_tenant_matches_the_store_it_was_written_to() {
        let _guard = security_store::test_guard();
        let store = security_store::SecurityStore::in_memory().expect("in-memory store");
        security_store::install_security_store(Some(store.clone()));
        host_identity::unbind_local_account();

        let tenant = paired_tenant_id();
        let now = unix_time_secs();
        let invitation = store
            .create_owner_invitation(&tenant, "local-trust-root", now, 300)
            .expect("invitation");

        // Redeeming under the advertised tenant is the property that matters:
        // the store only honours an invitation for the tenant it was filed
        // under, so a successful challenge proves the two agree.
        let challenge = store
            .issue_challenge(&tenant, now, 300)
            .expect("challenge for the advertised tenant");
        store
            .register_owner_device(
                &tenant,
                &invitation,
                &challenge.id,
                &challenge.nonce,
                "qr-device",
                "Owner phone",
                "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
                "thumb-qr-device",
                now,
            )
            .expect("the advertised tenant must be able to redeem the invitation");
    }

    /// Binding an account must not strand devices paired before the unlock.
    ///
    /// The unclaimed `__local__` bucket keeps its tenant when an account adopts
    /// it, so a device enrolled while locked stays reachable afterwards. If
    /// adoption minted a fresh tenant instead, every already-paired device would
    /// silently stop authenticating on the next unlock.
    #[tokio::test]
    async fn a_device_paired_before_unlock_survives_the_account_binding() {
        let _guard = security_store::test_guard();
        let device = "pre-unlock-device";
        let store = install_store_with_device(device);
        let before = paired_tenant_id();

        host_identity::bind_local_account("acct_late", "digest-late").expect("bind");

        let after = paired_tenant_id();
        assert_eq!(before, after, "adoption must keep the unclaimed tenant");
        assert!(
            store
                .capability_snapshot(&after, device)
                .expect("snapshot")
                .is_some(),
            "the device paired before the unlock must remain addressable"
        );
        host_identity::unbind_local_account();
    }

    /// Register a paired owner device in a fresh in-memory store and install it
    /// as the process-global one. Returns the device id.
    fn install_store_with_device(device_id: &str) -> std::sync::Arc<security_store::SecurityStore> {
        let store = security_store::SecurityStore::in_memory().expect("in-memory store");
        security_store::install_security_store(Some(store.clone()));
        host_identity::unbind_local_account();
        // Resolve the tenant the way the commands do, *after* installing the
        // store. Enrolling under a literal would silently stop exercising the
        // binding these commands now read.
        let tenant = paired_tenant_id();
        let now = unix_time_secs();
        let challenge = store.issue_challenge(&tenant, now, 600).expect("challenge");
        let invitation = store
            .create_owner_invitation(&tenant, "local-trust-root", now, 600)
            .expect("invitation");
        store
            .register_owner_device(
                &tenant,
                &invitation,
                &challenge.id,
                &challenge.nonce,
                device_id,
                "Owner phone",
                "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
                &format!("thumb-{device_id}"),
                now,
            )
            .expect("register");
        store
    }

    fn holds(store: &security_store::SecurityStore, device_id: &str, capability: &str) -> bool {
        store
            .has_capability(&paired_tenant_id(), device_id, capability)
            .expect("capability lookup")
    }

    /// The terminal toggle must move the capability the terminal gates read.
    ///
    /// This is the whole point of the command: `rpc::ensure_terminal_rpc_authorized`
    /// and `ws_terminal` both ask the store for `terminal.open`, so a toggle
    /// that writes anywhere else grants nothing while claiming to.
    #[tokio::test]
    async fn revoking_terminal_access_refuses_the_device_at_the_terminal_gate() {
        let _guard = security_store::test_guard();
        let device = "terminal-gate-device";
        let store = install_store_with_device(device);

        companion_set_remote_terminal(device.into(), true)
            .await
            .unwrap();
        assert!(holds(&store, device, "terminal.open"));
        // Remote terminal access is enabled on the host, and the device holds
        // the grant → authorized.
        assert!(super::super::rpc::terminal_rpc_authorization(device, true, true).is_ok());

        companion_set_remote_terminal(device.into(), false)
            .await
            .unwrap();
        assert!(!holds(&store, device, "terminal.open"));
        // Same host, same device, grant withdrawn → refused. Before this
        // command wrote the store, the revocation moved an in-memory list the
        // gate never consulted and the device stayed authorized.
        let refused = super::super::rpc::terminal_rpc_authorization(
            device,
            true,
            holds(&store, device, "terminal.open"),
        )
        .expect_err("a device without terminal.open must be refused");
        assert_eq!(refused.0, axum::http::StatusCode::FORBIDDEN);

        security_store::install_security_store(None);
    }

    /// Toggling one grant must not disturb the others, or a user revoking
    /// terminal access would silently also revoke file writes.
    #[tokio::test]
    async fn each_grant_moves_only_its_own_capabilities() {
        let _guard = security_store::test_guard();
        let device = "grant-isolation-device";
        let store = install_store_with_device(device);

        for kind in super::super::device_grants::GrantKind::all() {
            for capability in kind.capabilities() {
                assert!(
                    holds(&store, device, capability),
                    "an owner device starts with {capability}"
                );
            }
        }

        companion_set_remote_terminal(device.into(), false)
            .await
            .unwrap();
        assert!(!holds(&store, device, "terminal.open"));
        // The other two grants are untouched...
        for capability in super::super::device_grants::GrantKind::Control.capabilities() {
            assert!(holds(&store, device, capability), "{capability} survived");
        }
        for capability in super::super::device_grants::GrantKind::AgentControl.capabilities() {
            assert!(holds(&store, device, capability), "{capability} survived");
        }
        // ...and so is the owner grant the store refuses to let an owner lose.
        assert!(holds(&store, device, "host.admin"));

        companion_set_agent_control(device.into(), false)
            .await
            .unwrap();
        assert!(!holds(&store, device, "process.spawn"));
        assert!(holds(&store, device, "workspace.write"));

        security_store::install_security_store(None);
    }

    #[tokio::test]
    async fn grants_refuse_an_empty_device_id_rather_than_widening_to_every_caller() {
        let _guard = security_store::test_guard();
        install_store_with_device("some-other-device");
        // An empty id is what an unauthenticated or malformed context carries.
        for allowed in [true, false] {
            assert!(companion_set_remote_terminal("   ".into(), allowed)
                .await
                .is_err());
            assert!(companion_set_remote_control("".into(), allowed)
                .await
                .is_err());
            assert!(companion_set_agent_control("  ".into(), allowed)
                .await
                .is_err());
        }
        security_store::install_security_store(None);
    }

    /// An unknown device must be an error, not a silent no-op: a toggle that
    /// reports success while writing nothing is the failure mode this whole
    /// change exists to remove.
    #[tokio::test]
    async fn granting_to_an_unknown_device_surfaces_instead_of_succeeding_silently() {
        let _guard = security_store::test_guard();
        install_store_with_device("known-device");
        assert!(companion_set_remote_terminal("never-paired".into(), true)
            .await
            .is_err());
        security_store::install_security_store(None);
    }

    /// The Locked Use toggle is the one grant that is still dormant, and it
    /// must stay visibly dormant: it writes its own in-memory list and must
    /// never quietly acquire a SecurityStore capability, which would make it
    /// live without the UI or the docs moving with it. See
    /// `locked_use_allow_list`'s module docs.
    #[tokio::test]
    async fn locked_use_stays_out_of_the_capability_store() {
        let _guard = security_store::test_guard();
        let device = "locked-use-device";
        let store = install_store_with_device(device);
        let before = store
            .capability_snapshot(&paired_tenant_id(), device)
            .expect("snapshot")
            .expect("device");

        companion_set_locked_computer_use(device.into(), true)
            .await
            .unwrap();
        assert!(super::super::locked_use_allow_list::global().is_allowed(device));
        assert_eq!(
            store
                .capability_snapshot(&paired_tenant_id(), device)
                .expect("snapshot")
                .expect("device"),
            before,
            "Locked Use must not grant a capability while its enforcement point is unshipped"
        );

        companion_set_locked_computer_use(device.into(), false)
            .await
            .unwrap();
        assert!(!super::super::locked_use_allow_list::global().is_allowed(device));
        assert!(companion_set_locked_computer_use("  ".into(), true)
            .await
            .is_err());
        security_store::install_security_store(None);
    }

    /// The card reads the store rather than the Dexie mirror, so the switch
    /// position and the permission it describes are the same fact.
    #[tokio::test]
    async fn listed_grants_report_the_store() {
        let _guard = security_store::test_guard();
        let device = "listed-grants-device";
        install_store_with_device(device);

        companion_set_agent_control(device.into(), false)
            .await
            .unwrap();
        let summary = companion_list_device_grants()
            .await
            .unwrap()
            .into_iter()
            .find(|row| row.device_id == device)
            .expect("the paired device is listed");
        assert!(summary.control);
        assert!(summary.terminal);
        assert!(!summary.agent_control);

        security_store::install_security_store(None);
    }

    fn empty_data() -> serde_json::Map<String, serde_json::Value> {
        serde_json::Map::new()
    }

    /// A consent frame as it actually arrives: flattened prompt fields, a
    /// window title, a command detail, and a fat base64 thumbnail.
    fn consent_payload() -> serde_json::Map<String, serde_json::Value> {
        let mut m = serde_json::Map::new();
        m.insert("id".into(), serde_json::json!("consent-123"));
        m.insert("command".into(), serde_json::json!("click"));
        m.insert("surface".into(), serde_json::json!("computerUse"));
        m.insert("processName".into(), serde_json::json!("Xcode"));
        m.insert(
            "windowTitle".into(),
            serde_json::json!("Re: severance package.xlsx"),
        );
        m.insert(
            "commandDetail".into(),
            serde_json::json!("rm -rf ~/Documents/secret"),
        );
        m.insert("sessionKey".into(), serde_json::json!("session-a"));
        m.insert(
            "thumbnail".into(),
            serde_json::json!({ "bytes": "A".repeat(40_000), "width": 640, "height": 400, "redacted": false }),
        );
        m
    }

    #[test]
    fn push_body_strips_any_scheme_prefix() {
        assert_eq!(
            push_body_for_channel("claude://message-added", &empty_data()),
            "message-added"
        );
        assert_eq!(
            push_body_for_channel("companion://needs-input", &empty_data()),
            "needs-input"
        );
        assert_eq!(
            push_body_for_channel("workflow://run-terminal", &empty_data()),
            "run-terminal"
        );
        assert_eq!(
            push_body_for_channel("no-scheme", &empty_data()),
            "no-scheme"
        );
    }

    /// ADR-0131 — the inbound-IM push says WHO and WHERE, never WHAT. The
    /// body is readable on a lock screen, so the message text must never
    /// reach it; `push_data_for_channel` likewise passes ids + href only.
    #[test]
    fn connector_message_added_push_body_names_sender_not_message() {
        let mut data = serde_json::Map::new();
        data.insert("senderName".into(), serde_json::json!("Ada"));
        data.insert("platform".into(), serde_json::json!("Telegram"));
        data.insert("text".into(), serde_json::json!("the secret is 42"));
        let body = push_body_for_channel(CONNECTOR_MESSAGE_ADDED_CHANNEL, &data);
        assert_eq!(body, "New message from Ada on Telegram");
        assert!(
            !body.contains("42"),
            "message text must never ride the push"
        );

        // Missing display name / platform degrade, never panic.
        assert_eq!(
            push_body_for_channel(CONNECTOR_MESSAGE_ADDED_CHANNEL, &empty_data()),
            "New message"
        );
        let mut only_platform = serde_json::Map::new();
        only_platform.insert("platform".into(), serde_json::json!("Slack"));
        assert_eq!(
            push_body_for_channel(CONNECTOR_MESSAGE_ADDED_CHANNEL, &only_platform),
            "New message on Slack"
        );
    }

    #[test]
    fn consent_push_body_names_action_and_process() {
        assert_eq!(
            push_body_for_channel(AUTOMATION_CONSENT_CHANNEL, &consent_payload()),
            "Confirm click in Xcode"
        );
    }

    #[test]
    fn consent_push_body_never_leaks_the_window_title() {
        let body = push_body_for_channel(AUTOMATION_CONSENT_CHANNEL, &consent_payload());
        assert!(
            !body.contains("severance"),
            "lock-screen text must not carry the window title, got {body:?}"
        );
        assert!(
            !body.contains("rm -rf"),
            "lock-screen text must not carry the command detail, got {body:?}"
        );
    }

    #[test]
    fn consent_push_body_degrades_without_a_process_name() {
        let mut payload = consent_payload();
        payload.remove("processName");
        assert_eq!(
            push_body_for_channel(AUTOMATION_CONSENT_CHANNEL, &payload),
            "Confirm click"
        );
    }

    #[test]
    fn consent_push_data_is_allowlisted_to_ids() {
        let data = push_data_for_channel(AUTOMATION_CONSENT_CHANNEL, &consent_payload());
        assert_eq!(data.get("id").and_then(|v| v.as_str()), Some("consent-123"));
        assert_eq!(data.get("href").and_then(|v| v.as_str()), Some("/"));
        for leaked in ["thumbnail", "windowTitle", "commandDetail", "sessionKey"] {
            assert!(
                !data.contains_key(leaked),
                "{leaked} must never transit a push provider"
            );
        }
    }

    #[test]
    fn consent_push_data_stays_under_the_provider_payload_ceiling() {
        // APNs and FCM both cap a notification payload at ~4 KB. The raw frame
        // is far past that because of the thumbnail; the sanitized projection
        // must not be.
        let data = push_data_for_channel(AUTOMATION_CONSENT_CHANNEL, &consent_payload());
        let encoded = serde_json::to_string(&data).expect("data serializes");
        assert!(
            encoded.len() < 4096,
            "sanitized push data is {} bytes, over the ~4 KB provider ceiling",
            encoded.len()
        );
    }

    #[test]
    fn other_channels_pass_their_payload_through_untouched() {
        let mut m = serde_json::Map::new();
        m.insert("runId".into(), serde_json::json!("run-1"));
        let data = push_data_for_channel("workflow://run-terminal", &m);
        assert_eq!(data.get("runId").and_then(|v| v.as_str()), Some("run-1"));
    }

    #[test]
    fn notification_center_push_payload_is_metadata_only() {
        let payload = notification_center_push_payload(
            "notification-1",
            "scheduler",
            "warning",
            Some("/inbox"),
        )
        .expect("valid payload");
        assert_eq!(payload.title.as_deref(), Some("Cognia"));
        assert_eq!(
            payload.data.get("notificationId").and_then(|v| v.as_str()),
            Some("notification-1")
        );
        assert_eq!(
            payload.data.get("href").and_then(|v| v.as_str()),
            Some("/inbox")
        );
        assert_eq!(
            payload.data.get("source").and_then(|v| v.as_str()),
            Some("scheduler")
        );
        let encoded = serde_json::to_string(&payload).expect("payload serializes");
        assert!(!encoded.contains("Private task title"));
        assert!(!encoded.contains("Private task body"));
    }

    #[test]
    fn notification_center_push_payload_rejects_unsafe_metadata() {
        assert!(notification_center_push_payload("", "system", "warning", None).is_err());
        assert!(notification_center_push_payload("id", "system", "debug", None).is_err());
        assert!(notification_center_push_payload("id", "unknown", "info", None).is_err());
        assert!(notification_center_push_payload(
            "id",
            "system",
            "info",
            Some("https://example.com")
        )
        .is_err());
        assert!(
            notification_center_push_payload("id", "system", "info", Some("//example.com"))
                .is_err()
        );
    }

    #[test]
    fn detect_lan_ip_returns_string_or_none() {
        // Whatever the host returns, the result must be `Option<String>`.
        // We can't assert a specific value because CI hosts vary, but we can
        // assert the call doesn't panic and that returned strings parse as
        // `IpAddr` (so the QR base_url is well-formed).
        if let Some(ip) = detect_lan_ip() {
            assert!(ip.parse::<IpAddr>().is_ok(), "detect_lan_ip returned {ip}");
        }
    }

    #[tokio::test]
    async fn owner_invitation_uses_loopback_when_stopped() {
        // Server is never started → bind_mode is None → loopback fallback.
        // Post-M2.9 the loopback URL is HTTPS (the desktop server always
        // terminates TLS, so the same scheme works whether the QR is
        // scanned by a phone over LAN or shown to a developer pasting it
        // into a local browser with cert pinning bypass).
        let server_state = CompanionServerState::new();
        let result = (|| async {
            let port = server_state.bound_port().unwrap_or(DEFAULT_PORT);
            let host = "127.0.0.1".to_string();
            Ok::<_, String>(format!("https://{host}:{port}"))
        })()
        .await
        .expect("synthesize url");
        assert!(result.starts_with("https://127.0.0.1:"));
        assert!(result.ends_with(&DEFAULT_PORT.to_string()));
    }
}
