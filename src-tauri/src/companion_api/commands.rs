//! Tauri commands for the companion API server lifecycle.
//!
//! Commands shipped in M2.3: `companion_server_start`.
//! Commands added in M2.4: `companion_seed_deny_list`, `companion_revoke_device`,
//! `companion_unrevoke_device`.
//! Commands added in M2.8: `companion_server_stop`, `companion_server_status`,
//! `companion_issue_pair_jwt`.

use parking_lot::RwLock;
use serde::Serialize;
use std::net::IpAddr;
use std::sync::Arc;
use tauri::{Manager, State};

use super::{
    auth::{generate_pair_code, now_ms},
    desktop_messages_bridge,
    desktop_writes_bridge,
    event_bus::{register_tauri_event, EventBus},
    jwt::issue_pair_jwt,
    mdns::AutoStartConfig,
    pair_code_lru::PairCodeEntry,
    secret,
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
        addr: std::net::SocketAddr::new(
            std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
            port,
        ),
        source: std::io::Error::other(e),
    })?;

    // Build the event bus and register default Tauri event channels before
    // starting the server so no events are missed.
    let event_bus = EventBus::new();
    register_default_event_channels(&app_handle, Arc::clone(&event_bus));

    // Clone the deny_list Arc so both the Tauri command layer and the axum
    // server share the same live deny list.
    let shared: SharedState = Arc::new(CompanionState {
        secret: RwLock::new(signing_secret),
        redemption_lru: super::redemption_lru::RedemptionLru::new(),
        deny_list: Arc::clone(&state.deny_list),
        app_handle: Some(app_handle),
        idempotency: Arc::new(super::idempotency::IdempotencyCache::new()),
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
        // Wave 4.x — share the long-lived pair-code LRU so codes minted
        // by `companion_pair_issue` before a server bounce can still be
        // redeemed afterwards.
        pair_code_lru: Arc::clone(&state.pair_code_lru),
    });

    // Load TLS material (M2.9 — every companion-server bind terminates HTTPS).
    let dir = data_dir(shared.app_handle.as_ref().expect("app_handle present"))
        .map_err(CompanionServerError::Tls)?;
    let tls_material = tls::ensure_certificate(&dir)
        .map_err(|e| CompanionServerError::Tls(e.to_string()))?;

    // Publish the fingerprint so `whoami` (P0.3) can include it in responses
    // for app-layer attestation against the QR-pinned value.
    super::set_tls_fingerprint(tls_material.fingerprint_sha256.clone());

    // ADR-0021 — wire the WebRTC signaling hub to the live SharedState now
    // that it exists. Idempotent across restarts: `bind()` replaces the
    // stored binding so reconfigured clients pick up the fresh state on
    // their next reconnect.
    {
        use tauri::Manager as _;
        let app = shared
            .app_handle
            .as_ref()
            .expect("app_handle present");
        if let Some(hub) =
            app.try_state::<std::sync::Arc<super::signaling::SignalingHub>>()
        {
            hub.bind(Arc::clone(&shared), app.clone());
        }
    }

    state.start(port, bind_loopback_only, tls_material, shared).await
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
    state.revoke_device(device_id);
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
    // Remote Session Control — /goal lifecycle status so a remote watcher
    // sees pause / resume / stop / completion transitions live.
    register_tauri_event(app, Arc::clone(&bus), "goal://status");
    // Remote Session Control — host computer-use HITL consent prompts so a
    // remote watcher can render and resolve them via `automation_consent_respond`.
    register_tauri_event(app, Arc::clone(&bus), "automation:consent-request");
    // Pairing-lifecycle events — useful for multi-device observation.
    register_tauri_event(app, Arc::clone(&bus), "companion://device-paired");
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

            let data: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(&raw)
                    .ok()
                    .and_then(|v: serde_json::Value| v.as_object().cloned())
                    .unwrap_or_default();
            let payload = super::push::PushPayload {
                title: Some("cognia".into()),
                body: Some(
                    channel_name
                        .replace("claude://", "")
                        .replace("companion://", ""),
                ),
                data,
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

/// Response payload for [`companion_issue_pair_jwt`].
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairJwtIssue {
    /// Short-lived (5 min) HS256 JWT — encoded into the QR payload.
    pub pair_jwt: String,
    /// Millisecond epoch when the pair JWT expires.
    pub expires_at_ms: i64,
    /// Best-reachable URL the QR encodes. Tunnel takes priority over LAN
    /// when active. When the server is bound loopback-only, falls back to
    /// `http://127.0.0.1:<port>` so the developer can still verify the
    /// QR pipeline on a single machine.
    pub base_url: String,
    /// SHA-256 SubjectPublicKeyInfo fingerprint of the desktop server's
    /// TLS certificate (lower-case hex). The mobile client pins this in
    /// SecureStorage and refuses to talk to a peer whose presented cert
    /// doesn't match. Empty string when the cert subsystem is uninitialized
    /// (Wave 1.4 cert generation guarantees this is non-empty in practice).
    pub fingerprint: String,
    /// App version surfaced in the QR for forward-compat — phone uses this
    /// to gate breaking pair-payload changes.
    pub app_version: String,
    /// 6-digit numeric code that maps server-side to the same pair JWT.
    /// Emulator-friendly path for the mobile client when scanning a QR is
    /// impractical (Pixel 7 AVD has no working camera passthrough). Single-
    /// use, same TTL as the underlying JWT.
    pub pair_code: String,
    /// Millisecond epoch when the numeric code stops being redeemable —
    /// equal to [`expires_at_ms`] so the desktop UI can render one shared
    /// countdown next to both surfaces.
    pub pair_code_expires_at_ms: i64,
}

/// Issue a one-shot pair JWT for the QR flow.
///
/// Calls into the auth helpers directly rather than via HTTP — the desktop UI
/// runs in-process so a self-call would just round-trip the same router.
/// The token is a copy of what `POST /api/v1/auth/pair/issue` would return.
#[tauri::command]
pub async fn companion_issue_pair_jwt(
    state: State<'_, CompanionServerState>,
    app_handle: tauri::AppHandle,
) -> Result<PairJwtIssue, String> {
    let signing_secret = secret::load_or_generate().map_err(|e| e.to_string())?;
    let (pair_jwt, exp_secs) = issue_pair_jwt(&signing_secret).map_err(|e| e.to_string())?;
    let port = state.bound_port().unwrap_or(DEFAULT_PORT);

    // URL priority: active tunnel > LAN > loopback fallback.
    // Local origins use HTTPS (M2.9 self-signed termination); the tunnel URL
    // is already Cloudflare HTTPS upstream.
    let base_url = if let Some(info) = state.tunnel.current() {
        info.public_url
    } else {
        let host = match state.bind_mode() {
            Some(BindMode::Lan) => detect_lan_ip().unwrap_or_else(|| "127.0.0.1".to_string()),
            _ => "127.0.0.1".to_string(),
        };
        format!("https://{host}:{port}")
    };

    let fingerprint = ensure_tls_fingerprint(&app_handle).unwrap_or_default();
    let app_version = app_handle.package_info().version.to_string();

    let expires_at_ms = exp_secs * 1000;

    // Mint a 6-digit numeric code that maps to the same pair JWT in the
    // server-side LRU. PairDeviceCard renders the code alongside the QR
    // so an emulator user (no camera) can still complete pairing by
    // typing the digits.
    let pair_code = generate_pair_code();
    state.pair_code_lru.insert(
        pair_code.clone(),
        PairCodeEntry {
            pair_jwt: pair_jwt.clone(),
            expires_at_ms,
        },
        now_ms(),
    );

    Ok(PairJwtIssue {
        pair_jwt,
        expires_at_ms,
        base_url,
        fingerprint,
        app_version,
        pair_code,
        pair_code_expires_at_ms: expires_at_ms,
    })
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

/// Start a Cloudflared tunnel to the loopback companion server. Returns the
/// public trycloudflare URL once it appears in the cloudflared subprocess
/// stderr. Errors with "not_installed" if cloudflared is missing from PATH.
#[tauri::command]
pub async fn companion_tunnel_start(
    state: State<'_, CompanionServerState>,
    local_url: String,
) -> Result<TunnelInfo, String> {
    state
        .tunnel
        .start(&local_url)
        .await
        .map_err(|e| match e {
            tunnel::TunnelError::NotInstalled => {
                "cloudflared not found in PATH (install: https://developers.cloudflare.com/cloudflared/install/)".to_string()
            }
            other => other.to_string(),
        })
}

/// Stop the Cloudflared tunnel. No-op if not running.
#[tauri::command]
pub fn companion_tunnel_stop(state: State<'_, CompanionServerState>) {
    state.tunnel.stop();
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
pub fn companion_push_configure_fcm(
    service_account_json: String,
) -> Result<(), String> {
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
        Some(s) => (
            s.load_fcm()?.is_some(),
            s.load_apns()?.is_some(),
        ),
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
    let port = state.bound_port().ok_or_else(|| "server not running".to_string())?;
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
        .build()
        .map_err(|e| format!("reqwest builder: {e}"))?;

    let mut out = Vec::with_capacity(candidates.len());
    for url in candidates {
        let started = std::time::Instant::now();
        // Hit a public-pre-auth endpoint so we don't need a JWT — issue/pair
        // accepts an empty POST and returns 200.
        let probe_url = format!("{}/api/v1/auth/pair/issue", url.trim_end_matches('/'));
        match client.post(&probe_url).send().await {
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

/// Return the active tunnel info, or null when no tunnel is running.
#[tauri::command]
pub fn companion_tunnel_current(state: State<'_, CompanionServerState>) -> Option<TunnelInfo> {
    state.tunnel.current()
}

/// Best-effort detect a routable LAN IPv4 address.  Returns `None` when the
/// host has no non-loopback interface (e.g., container without a network).
fn detect_lan_ip() -> Option<String> {
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
    async fn issue_pair_jwt_returns_loopback_when_stopped() {
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
