//! Tauri commands for the companion API server lifecycle.
//!
//! Commands shipped in M2.3: `companion_server_start`.
//! Commands added in M2.4: `companion_seed_deny_list`, `companion_revoke_device`,
//! `companion_unrevoke_device`.

use parking_lot::RwLock;
use std::sync::Arc;
use tauri::State;

use super::{
    event_bus::{register_tauri_event, EventBus},
    secret,
    server::CompanionServerError,
    CompanionServerState, CompanionState, SharedState,
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
    });

    state.start(port, bind_loopback_only, shared).await
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

    #[test]
    fn commands_module_compiles() {}
}
