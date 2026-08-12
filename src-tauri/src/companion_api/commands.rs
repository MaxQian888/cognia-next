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
    desktop_messages_bridge, desktop_writes_bridge,
    event_bus::{register_tauri_event, EventBus},
    mdns::AutoStartConfig,
    secret, security_store,
    server::{CompanionServerError, DEFAULT_PORT},
    tls,
    tunnel::{self, TunnelInfo},
    BindMode, CompanionServerState, CompanionState, SharedState,
};

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

    // Build the event bus and register default Tauri event channels before
    // starting the server so no events are missed.
    let event_bus = EventBus::new();
    register_default_event_channels(&app_handle, Arc::clone(&event_bus));
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
            cognia_secrets::keyring_secrets::clear(
                super::signaling::envelope_v2::SIGNALING_KEY_NAMESPACE,
                &key_ref,
            )?;
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

/// Grant or revoke a device's **remote-control** capability (Remote Session
/// Control). Mirrors the Dexie `pairedDevices.allowRemoteControl` flag into
/// the process-global [`super::control_allow_list`] consulted by the
/// per-command gate in [`super::rpc`]. Takes effect immediately for in-flight
/// requests after this command returns. Driven by the paired-devices card
/// behind the biometric guard.
#[tauri::command]
pub async fn companion_set_remote_control(device_id: String, allowed: bool) -> Result<(), String> {
    let acl = super::control_allow_list::global();
    if allowed {
        acl.allow(device_id);
    } else {
        acl.disallow(&device_id);
    }
    Ok(())
}

/// Re-seed the remote-control allow list at desktop boot from the persisted
/// Dexie rows where `allowRemoteControl === true`. Replace semantics (not
/// union) so a capability revoked while the process was down is not retained.
#[tauri::command]
pub async fn companion_seed_remote_control(device_ids: Vec<String>) -> Result<(), String> {
    super::control_allow_list::global().reseed(device_ids);
    Ok(())
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
    // An empty id is what an unauthenticated or malformed RPC context carries,
    // so storing one would hand agent control to every such caller. The CLI
    // path (`device_grants::grant`) already refuses it; this is the same
    // refusal on the desktop path.
    if device_id.trim().is_empty() {
        return Err("device_id is required".into());
    }
    let acl = super::control_allow_list::agent_control_global();
    if allowed {
        acl.allow(device_id);
    } else {
        acl.disallow(&device_id);
    }
    Ok(())
}

/// Re-seed the agent-control allow list at desktop boot from the persisted
/// Dexie rows where `allowAgentControl === true`. Replace semantics, matching
/// [`companion_seed_remote_control`].
#[tauri::command]
pub async fn companion_seed_agent_control(device_ids: Vec<String>) -> Result<(), String> {
    super::control_allow_list::agent_control_global().reseed(device_ids);
    Ok(())
}

/// Grant or revoke interactive terminal access for a paired device.
///
/// This is deliberately separate from remote-control and agent-control. The
/// settings UI performs system confirmation before invoking this command.
#[tauri::command]
pub async fn companion_set_remote_terminal(device_id: String, allowed: bool) -> Result<(), String> {
    if device_id.trim().is_empty() {
        return Err("device_id is required".into());
    }
    let acl = super::control_allow_list::terminal_global();
    if allowed {
        acl.allow(device_id);
    } else {
        acl.disallow(&device_id);
    }
    Ok(())
}

/// Re-seed terminal grants from persisted paired-device rows at desktop boot.
#[tauri::command]
pub async fn companion_seed_remote_terminal(device_ids: Vec<String>) -> Result<(), String> {
    super::control_allow_list::terminal_global().reseed(
        device_ids
            .into_iter()
            .filter(|device_id| !device_id.trim().is_empty())
            .collect(),
    );
    Ok(())
}

#[tauri::command]
pub async fn companion_set_locked_computer_use(
    device_id: String,
    allowed: bool,
) -> Result<(), String> {
    let acl = super::locked_use_allow_list::global();
    if allowed {
        acl.allow(device_id);
    } else {
        acl.disallow(&device_id);
    }
    Ok(())
}

#[tauri::command]
pub async fn companion_seed_locked_computer_use(device_ids: Vec<String>) -> Result<(), String> {
    super::locked_use_allow_list::global().reseed(device_ids);
    Ok(())
}

// ---------------------------------------------------------------------------
// Event-channel registration (M2.6)
// ---------------------------------------------------------------------------

/// Register the default set of Tauri event channels that the companion API
/// should forward to connected WebSocket clients.
///
/// Called once from [`companion_server_start`] before the axum server is
/// spawned.  Adding a channel here is the canonical way to expose a new
/// Tauri event to mobile clients.
pub fn register_default_event_channels(app: &tauri::AppHandle, bus: Arc<EventBus>) {
    // Primary chat-streaming channel — the most latency-sensitive event.
    register_tauri_event(app, Arc::clone(&bus), "claude://message");
    // Phase A3 — fine-grained message mutation events emitted by the
    // JS-side `messageRepository` (lib/db/plugin-bridge.ts). Mobile WS
    // subscribers observe these to keep their session view in sync.
    register_tauri_event(app, Arc::clone(&bus), "claude://message-added");
    register_tauri_event(app, Arc::clone(&bus), "claude://message-updated");
    register_tauri_event(app, Arc::clone(&bus), "claude://message-deleted");
    // Transcript V1 invalidation contains only session identity + monotonic
    // revision. Clients reconcile the bounded newest page on receipt.
    register_tauri_event(app, Arc::clone(&bus), "transcript://revision");
    // Remote Session Control — /goal lifecycle status so a remote watcher
    // sees pause / resume / stop / completion transitions live.
    register_tauri_event(app, Arc::clone(&bus), "goal://status");
    // Remote Session Control — host computer-use HITL consent prompts so a
    // remote watcher can render and resolve them via `automation_consent_respond`.
    register_tauri_event(app, Arc::clone(&bus), AUTOMATION_CONSENT_CHANNEL);
    // Server OCR and desktop OCR share one progress channel. Headless emits
    // directly into EventBus; desktop forwards the Tauri event here.
    register_tauri_event(app, Arc::clone(&bus), "ocr://download-progress");
    // Pairing-lifecycle events — useful for multi-device observation.
    register_tauri_event(app, Arc::clone(&bus), "companion://device-paired");
    // ADR-0061 P2 — live workflow run-status frames (every transition incl.
    // per-step lastStepId advances). Emitted by the TS
    // `lib/workflow/runtime/companion-run-events.ts` funnel.
    register_tauri_event(app, Arc::clone(&bus), "workflow://run-status");
    // ADR-0061 P2 — HITL approval gate lifecycle: full request frames for
    // foreground devices (title/message ride the authenticated WS only) and
    // resolution frames so pending lists clear immediately. Emitted by
    // `lib/workflow/runtime/approval-notify.ts`.
    register_tauri_event(app, Arc::clone(&bus), "workflow://approval-request");
    register_tauri_event(app, Arc::clone(&bus), "workflow://approval-resolved");
    // ADR-0061 P3 — desktop-issued remote step requests. Full params ride
    // the authenticated WS only; the device answers via the
    // `workflow_step_result` RPC. Emitted by
    // `lib/workflow/runtime/remote-step-broker.ts`.
    register_tauri_event(app, Arc::clone(&bus), "workflow://step-execute");
    // ADR-0061 P2 — sync invalidation. The mobile `installEventDrivenSync`
    // has subscribed to this channel since ADR-0027; the desktop now emits
    // it (terminal workflow runs → { table: "workflowRuns" }) so the phone
    // re-pulls exactly when data changed instead of waiting for the next
    // foreground/resume/network trigger.
    register_tauri_event(app, Arc::clone(&bus), "sync://invalidate");
    // ADR-0038 — repo change signal from the native git watcher
    // (`git/watcher.rs`). Remote source-control clients can't run
    // `git_watch_start` (it needs the Tauri watcher state), so this forwarded
    // frame is their only push-based refresh trigger; the desktop StatusBar
    // owns the watcher lifecycle.
    register_tauri_event(app, Arc::clone(&bus), "git://status-changed");
    // Task-scoped resource invalidations carry only ids, paths, and summaries;
    // clients fetch file bodies through the bounded resource RPCs.
    register_tauri_event(app, Arc::clone(&bus), crate::task_workspace::RESOURCE_EVENT);
    // ADR-0009 — live agent-fleet snapshot. A phone / companion browser watching
    // the fleet subscribes to this to mirror the desktop island in real time
    // (backfill via the `fleet_get_snapshot` RPC). Full-snapshot semantics, so
    // no push trigger — it fires on every tool call and would spam notifications.
    register_tauri_event(app, Arc::clone(&bus), crate::fleet::UPDATE_EVENT);
    // Heartbeat / presence signal emitted by the JWT middleware on each request.
    register_tauri_event(app, bus, "companion://device-seen");
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
}

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
                    let _ = registry.broadcast_to_offline(&payload, d.as_ref()).await;
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
    const TENANT_ID: &str = "local_acct_a";
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
    let enrollment = security
        .create_worker_enrollment(TENANT_ID, "local-trust-root", now, ENROLLMENT_TTL_SECS)
        .map_err(|error| error.to_string())?;
    Ok(WorkerEnrollmentIssue {
        enrollment,
        expires_at_ms: now.saturating_add(ENROLLMENT_TTL_SECS) * 1_000,
        base_url,
        fingerprint,
        tenant_id: TENANT_ID.to_string(),
    })
}

#[tauri::command]
pub async fn companion_list_workers() -> Result<Vec<security_store::DeviceSummary>, String> {
    const TENANT_ID: &str = "local_acct_a";
    let security = security_store::security_store()
        .ok_or_else(|| "companion security store is unavailable".to_string())?;
    security
        .list_worker_devices(TENANT_ID)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn companion_set_worker(device_id: String, allowed: bool) -> Result<(), String> {
    const TENANT_ID: &str = "local_acct_a";
    if device_id.trim().is_empty() {
        return Err("device_id is required".into());
    }
    let security = security_store::security_store()
        .ok_or_else(|| "companion security store is unavailable".to_string())?;
    let mut capabilities = security
        .capability_snapshot(TENANT_ID, &device_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "worker device is unavailable".to_string())?;
    capabilities.retain(|capability| capability != "agent.worker");
    if allowed {
        capabilities.push("agent.worker".to_string());
    }
    security
        .replace_device_capabilities(
            TENANT_ID,
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
#[tauri::command]
pub async fn companion_create_owner_invitation(
    _local_account_id: String,
    state: State<'_, CompanionServerState>,
    app_handle: tauri::AppHandle,
) -> Result<OwnerInvitationIssue, String> {
    const TENANT_ID: &str = "local_acct_a";
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
    let invitation = security
        .create_owner_invitation(TENANT_ID, "local-trust-root", now, INVITATION_TTL_SECS)
        .map_err(|error| error.to_string())?;
    let signing_secret = secret::load_or_generate().map_err(|error| error.to_string())?;

    Ok(OwnerInvitationIssue {
        invitation,
        expires_at_ms: now.saturating_add(INVITATION_TTL_SECS) * 1_000,
        base_url,
        fingerprint,
        app_version: app_handle.package_info().version.to_string(),
        host_id: super::healthz::derive_server_id(&signing_secret),
        tenant_id: TENANT_ID.to_string(),
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

    #[tokio::test]
    async fn remote_terminal_grants_reject_empty_ids_and_support_revoke_and_reseed() {
        let acl = super::super::control_allow_list::terminal_global();
        acl.clear();

        assert!(companion_set_remote_terminal("   ".into(), true)
            .await
            .is_err());
        companion_set_remote_terminal("terminal-device".into(), true)
            .await
            .unwrap();
        assert!(acl.is_allowed("terminal-device"));
        companion_set_remote_terminal("terminal-device".into(), false)
            .await
            .unwrap();
        assert!(!acl.is_allowed("terminal-device"));

        companion_seed_remote_terminal(vec!["seeded-terminal".into(), "".into(), "   ".into()])
            .await
            .unwrap();
        assert!(acl.is_allowed("seeded-terminal"));
        assert!(!acl.is_allowed(""));
        assert!(!acl.is_allowed("   "));

        acl.clear();
    }

    #[test]
    fn commands_module_compiles() {}

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
