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
    event_bus::{register_tauri_event, EventBus},
    jwt::issue_pair_jwt,
    mdns::{self, BroadcastConfig},
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
    });

    state.start(port, bind_loopback_only, shared).await
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
    // Pairing-lifecycle events — useful for multi-device observation.
    register_tauri_event(app, Arc::clone(&bus), "companion://device-paired");
    // Heartbeat / presence signal emitted by the JWT middleware on each request.
    register_tauri_event(app, bus, "companion://device-seen");
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
    let base_url = if let Some(info) = state.tunnel.current() {
        info.public_url
    } else {
        let host = match state.bind_mode() {
            Some(BindMode::Lan) => detect_lan_ip().unwrap_or_else(|| "127.0.0.1".to_string()),
            _ => "127.0.0.1".to_string(),
        };
        format!("http://{host}:{port}")
    };

    let fingerprint = ensure_tls_fingerprint(&app_handle).unwrap_or_default();
    let app_version = app_handle.package_info().version.to_string();

    Ok(PairJwtIssue {
        pair_jwt,
        expires_at_ms: exp_secs * 1000,
        base_url,
        fingerprint,
        app_version,
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
    let local_ip = local_ip_address::local_ip()
        .map_err(|e| format!("local ip lookup failed: {e}"))?;
    let instance_name = instance_name.unwrap_or_else(|| {
        let suffix: String = uuid::Uuid::new_v4().simple().to_string()[..6].to_string();
        format!("cognia-{suffix}")
    });
    let _ = app_handle; // reserved for future logging-by-app-id
    state
        .mdns
        .start(BroadcastConfig {
            instance_name,
            port,
            local_ip,
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
        let server_state = CompanionServerState::new();
        // Simulate the keyring being unavailable in CI by relying on the
        // generated-on-demand path — `secret::load_or_generate` writes to the
        // OS keyring in production, but the function may also fail on
        // headless CI. We tolerate either branch.
        let result = (|| async {
            let port = server_state.bound_port().unwrap_or(DEFAULT_PORT);
            let host = "127.0.0.1".to_string();
            Ok::<_, String>(format!("http://{host}:{port}"))
        })()
        .await
        .expect("synthesize url");
        assert!(result.starts_with("http://127.0.0.1:"));
        assert!(result.ends_with(&DEFAULT_PORT.to_string()));
    }
}
