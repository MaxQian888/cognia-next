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
pub mod jwt;
pub mod redemption_lru;
pub mod secret;
pub mod server;

pub mod commands;

use parking_lot::RwLock;
use std::sync::Arc;

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
    /// Tauri `AppHandle` — `None` in unit tests, `Some` in production.
    pub app_handle: Option<tauri::AppHandle>,
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
}

struct CompanionServerInner {
    handle: Option<ServerHandle>,
    bound_port: Option<u16>,
}

impl CompanionServerState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(CompanionServerInner {
                handle: None,
                bound_port: None,
            }),
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
        {
            let mut inner = self.inner.lock();
            inner.handle = Some(handle);
            inner.bound_port = Some(bound_port);
        }
        Ok(bound_port)
    }

    /// Stop the server gracefully.  Called by M2.8 settings UI.
    #[allow(dead_code)]
    pub fn stop(&self) {
        let mut inner = self.inner.lock();
        if let Some(handle) = inner.handle.take() {
            let _ = handle.shutdown.send(());
        }
        inner.bound_port = None;
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
            app_handle: None,
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

        server_state.stop();
        assert!(!server_state.is_running());
        assert!(server_state.bound_port().is_none());
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
