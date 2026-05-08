//! Companion API — QR-pairing exchange and mobile device authentication.
//!
//! This module implements the server-side of the cognia mobile companion
//! pairing flow (M2.3).  It exposes an axum HTTP server on a configurable
//! port (default 7890) with two endpoints:
//!
//! - `POST /api/v1/auth/pair/issue` — desktop-only (127.0.0.1 listener when
//!   `bind_loopback_only = true`); issues a short-lived pair JWT that the QR
//!   generator encodes into an image.
//!
//! - `POST /api/v1/auth/pair` — redeems the pair JWT and returns a long-lived
//!   device JWT.  Callable from the phone over LAN or a cloudflared tunnel
//!   (M2.8).
//!
//! # Module layout
//!
//! - [`secret`]          — HS256 signing-secret persistence (OS keyring).
//! - [`jwt`]             — HS256 JWT issue + verify helpers.
//! - [`redemption_lru`]  — Single-use JTI tracker.
//! - [`auth`]            — Axum handlers for the two pair endpoints.
//! - [`server`]          — Axum server spawn + router builder.
//!
//! # Tauri integration
//!
//! The Tauri command `companion_server_start` (in [`commands`]) is the entry
//! point from the frontend.  State is held in [`CompanionState`] managed by
//! Tauri's `manage()`.  Device persistence is handled exclusively by the TS
//! layer: the handler emits `companion://device-paired` and the TS side calls
//! `addPairedDevice` from `lib/db/paired-devices.ts`.

pub mod auth;
pub mod deny_list;
pub mod event_bus;
pub mod idempotency;
pub mod jwt;
pub mod middleware;
pub mod redemption_lru;
pub mod rpc;
pub mod secret;
pub mod server;
pub mod ws;

pub mod commands;

/// Re-export so handlers can read the device identity without reaching into
/// the middleware module by full path.  Not yet consumed by any handler in
/// M2.4 — M2.5+ routes will use it.
#[allow(unused_imports)]
pub use middleware::DeviceContext;

use parking_lot::RwLock;
use std::sync::Arc;

use deny_list::DenyList;
use event_bus::EventBus;
use idempotency::IdempotencyCache;
use redemption_lru::RedemptionLru;

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

/// Shared state injected into every axum handler.
///
/// Wrapped in `Arc` for cheap cloning into tower layers.
pub type SharedState = Arc<CompanionState>;

/// Application state for the companion API server.
pub struct CompanionState {
    /// The HS256 signing secret (raw bytes).  Protected by a `RwLock` so the
    /// secret can be rotated (M3+) without restarting the server.
    pub secret: RwLock<Vec<u8>>,
    /// Single-use redemption tracker for pair JWTs.
    pub redemption_lru: RedemptionLru,
    /// In-memory set of revoked device IDs.  Shared with [`CompanionServerState`]
    /// via `Arc` so Tauri commands (`companion_revoke_device`, etc.) can mutate
    /// it even when the axum server holds a clone of the same `SharedState`.
    pub deny_list: Arc<DenyList>,
    /// Tauri `AppHandle` — `None` in unit tests, `Some` in production.
    pub app_handle: Option<tauri::AppHandle>,
    /// Per-device idempotency cache for `POST /api/v1/_rpc/:name`.
    ///
    /// Keyed by `(device_id, Idempotency-Key header)`.  Successful responses
    /// are stored for 60 s; read-only commands skip caching entirely.
    pub idempotency: Arc<IdempotencyCache>,
    /// Event bus — broadcasts Tauri events to all connected WS clients and
    /// maintains a replay buffer for reconnecting clients (M2.6).
    pub event_bus: Arc<EventBus>,
}

// ---------------------------------------------------------------------------
// Orchestrator state (Tauri-managed)
// ---------------------------------------------------------------------------

use parking_lot::Mutex;
use server::ServerHandle;

/// Tauri-managed state for the companion API server lifecycle.
///
/// Mirrors the pattern in `mcp_server/mod.rs::McpServerState`.
pub struct CompanionServerState {
    inner: Mutex<CompanionServerInner>,
    /// The deny list is kept here (behind `Arc`) so Tauri commands can reach it
    /// regardless of whether the HTTP server is currently running.  When the
    /// server is started, the same `Arc<DenyList>` is cloned into the
    /// `SharedState`, giving both sides a live view of the same data.
    pub deny_list: Arc<DenyList>,
}

struct CompanionServerInner {
    handle: Option<ServerHandle>,
    bound_port: Option<u16>,
    /// Mirror of the `bind_loopback_only` flag passed to the most recent
    /// `start` so the settings UI can read back the bind mode without a
    /// separate state lookup. `None` means the server is stopped.
    bind_mode: Option<BindMode>,
}

/// Bind selection persisted alongside the listener handle so the M2.8
/// settings UI can render the current mode without re-reading prefs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BindMode {
    Loopback,
    Lan,
}

impl CompanionServerState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(CompanionServerInner {
                handle: None,
                bound_port: None,
                bind_mode: None,
            }),
            deny_list: Arc::new(DenyList::new()),
        }
    }

    /// Whether the server is currently running.
    pub fn is_running(&self) -> bool {
        self.inner.lock().handle.is_some()
    }

    /// The port the server is bound to, if running.
    pub fn bound_port(&self) -> Option<u16> {
        self.inner.lock().bound_port
    }

    /// Spawn the server and store the handle.  Returns the bound port.
    pub async fn start(
        &self,
        port: u16,
        bind_loopback_only: bool,
        state: SharedState,
    ) -> Result<u16, server::CompanionServerError> {
        {
            let inner = self.inner.lock();
            if inner.handle.is_some() {
                if let Some(p) = inner.bound_port {
                    // Already running — return the current port.
                    return Ok(p);
                }
            }
        }
        let handle = server::spawn_server(port, bind_loopback_only, state).await?;
        let bound_port = handle.bound_port;
        let mode = if bind_loopback_only {
            BindMode::Loopback
        } else {
            BindMode::Lan
        };
        {
            let mut inner = self.inner.lock();
            inner.handle = Some(handle);
            inner.bound_port = Some(bound_port);
            inner.bind_mode = Some(mode);
        }
        Ok(bound_port)
    }

    /// Stop the server gracefully.  Called by M2.8 settings UI.
    pub fn stop(&self) {
        let mut inner = self.inner.lock();
        if let Some(handle) = inner.handle.take() {
            let _ = handle.shutdown.send(());
        }
        inner.bound_port = None;
        inner.bind_mode = None;
    }

    /// Whether the most recent `start` was loopback-only.  `None` if the
    /// server is currently stopped.
    ///
    /// Mirror tracked alongside the listener so the M2.8 settings UI can
    /// render the bind mode without re-reading from a pref file.
    pub fn bind_mode(&self) -> Option<BindMode> {
        self.inner.lock().bind_mode
    }

    // ── Deny-list pass-throughs (used by Tauri commands) ───────────────────

    pub fn seed_deny_list(&self, device_ids: Vec<String>) {
        self.deny_list.seed(device_ids);
    }

    pub fn revoke_device(&self, device_id: String) {
        self.deny_list.revoke(device_id);
    }

    pub fn unrevoke_device(&self, device_id: &str) {
        self.deny_list.unrevoke(device_id);
    }
}

impl Default for CompanionServerState {
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

    fn test_shared_state() -> SharedState {
        Arc::new(CompanionState {
            secret: RwLock::new(vec![0u8; 32]),
            redemption_lru: RedemptionLru::new(),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
        })
    }

    #[test]
    fn new_state_is_not_running() {
        let state = CompanionServerState::new();
        assert!(!state.is_running());
        assert!(state.bound_port().is_none());
    }

    #[tokio::test]
    async fn start_stop_round_trip() {
        let server_state = CompanionServerState::new();
        let shared = test_shared_state();

        let port = server_state
            .start(0, true, shared)
            .await
            .expect("start");
        assert!(port > 0);
        assert!(server_state.is_running());
        assert_eq!(server_state.bound_port(), Some(port));
        assert_eq!(server_state.bind_mode(), Some(BindMode::Loopback));

        server_state.stop();
        assert!(!server_state.is_running());
        assert!(server_state.bound_port().is_none());
        assert!(server_state.bind_mode().is_none());
    }

    #[tokio::test]
    async fn lan_bind_records_lan_mode() {
        let server_state = CompanionServerState::new();
        let shared = test_shared_state();

        let _ = server_state.start(0, false, shared).await.expect("start");
        assert_eq!(server_state.bind_mode(), Some(BindMode::Lan));

        server_state.stop();
        assert!(server_state.bind_mode().is_none());
    }

    #[tokio::test]
    async fn double_start_returns_same_port() {
        let server_state = CompanionServerState::new();
        let shared1 = test_shared_state();
        let shared2 = test_shared_state();

        let port1 = server_state.start(0, true, shared1).await.expect("start");
        let port2 = server_state.start(0, true, shared2).await.expect("second start");
        assert_eq!(port1, port2, "second start must return same port");

        server_state.stop();
    }
}
