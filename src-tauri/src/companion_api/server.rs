//! Axum HTTP server for the companion API (`/api/v1/*`).
//!
//! # Port separation rationale
//!
//! The companion API runs on its own TCP port (default 7890) rather than
//! sharing the MCP server port (default from `mcp_server/http_server.rs`).
//! This keeps the MCP server untouched and gives M2.4 (JWT verifier middleware),
//! M2.5 (RPC routes), and M2.6 (WS upgrade) clean, independent mount points on
//! a single axum `Router`.  Sharing a port via `Router::merge` would require
//! significant changes to the existing MCP server's state model.
//!
//! # Bind strategy
//!
//! When `bind_loopback_only` is `true`, the server binds to `127.0.0.1`
//! (only processes on the same machine can reach it).  When `false`, it binds
//! to `0.0.0.0` (LAN-accessible).  M2.8 exposes a UI toggle; M2.3 defaults to
//! loopback-only so the pair/issue endpoint is safe before the LAN-bind toggle
//! lands.
//!
//! # Graceful shutdown
//!
//! Identical pattern to `mcp_server/http_server.rs`: `tokio::sync::watch`
//! channel; caller sends `()` to drain and exit.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use axum::{middleware::from_fn_with_state, routing::{any, get, post}, Router};
use super::{rpc, ws};
use tokio::sync::watch;
use tower_http::limit::RequestBodyLimitLayer;

use super::{auth, middleware, SharedState};

/// 64 KiB — pair request bodies are tiny; the generous limit leaves room for
/// future endpoints (e.g., push-token registration in M4.6).
const BODY_LIMIT_BYTES: usize = 64 * 1024;

/// Default companion API port.  Configurable via `companion_server_start`.
/// Used by M2.8 settings UI.
pub const DEFAULT_PORT: u16 = 7890;

// ---------------------------------------------------------------------------
// Public handle
// ---------------------------------------------------------------------------

/// Returned by [`spawn_server`] so the caller can record the bound port and
/// send the graceful-shutdown signal later.
#[derive(Clone)]
pub struct ServerHandle {
    /// The port the listener is actually bound to (`0` → OS-assigned).
    pub bound_port: u16,
    /// Send `()` here to initiate graceful shutdown.
    ///
    /// Read by tests and by `CompanionServerState::stop`.
    #[allow(dead_code)]
    pub shutdown: watch::Sender<()>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum CompanionServerError {
    #[error("companion server bind failed on {addr}: {source}")]
    Bind {
        addr: SocketAddr,
        #[source]
        source: std::io::Error,
    },
}

impl serde::Serialize for CompanionServerError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Spawn the companion axum server and return a [`ServerHandle`].
///
/// # Arguments
///
/// - `port` — TCP port.  Pass `0` to let the OS choose an ephemeral port
///   (useful in tests).
/// - `bind_loopback_only` — `true` → `127.0.0.1`; `false` → `0.0.0.0`.
/// - `state` — shared companion state (secret, redemption LRU, app handle).
pub async fn spawn_server(
    port: u16,
    bind_loopback_only: bool,
    state: SharedState,
) -> Result<ServerHandle, CompanionServerError> {
    let ip: IpAddr = if bind_loopback_only {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    } else {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    };
    let addr = SocketAddr::new(ip, port);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|source| CompanionServerError::Bind { addr, source })?;

    let bound_port = listener
        .local_addr()
        .map_err(|source| CompanionServerError::Bind { addr, source })?
        .port();

    let app = build_router(state);

    let (tx, mut rx) = watch::channel(());

    tokio::spawn(async move {
        let result = axum::serve(listener, app.into_make_service())
            .with_graceful_shutdown(async move {
                let _ = rx.changed().await;
            })
            .await;

        if let Err(e) = result {
            log::warn!("companion-api server exited with error: {e}");
        }
    });

    Ok(ServerHandle {
        bound_port,
        shutdown: tx,
    })
}

/// Build the axum `Router` for the companion API.
///
/// Extracted so tests can call it without binding a TCP port (via
/// `Router::oneshot`).  M2.5 will add `/api/v1/_rpc/:name`; M2.6 will add
/// the WS upgrade route.
///
/// # Route structure
///
/// ```text
/// public_routes   — no middleware (pre-auth)
///   POST /api/v1/auth/pair/issue
///   POST /api/v1/auth/pair
///
/// protected_routes — require_device_jwt middleware applied
///   GET  /api/v1/whoami   — identity check for the mobile app post-pair
/// ```
pub fn build_router(state: SharedState) -> Router {
    // Pre-auth routes — no JWT middleware.
    let public_routes = Router::new()
        .route("/api/v1/auth/pair/issue", post(auth::issue_handler))
        .route("/api/v1/auth/pair", post(auth::pair_handler));

    // Authenticated routes — JWT verifier middleware applied.
    //
    // The WS upgrade route uses `any()` rather than `get()` so it handles both
    // HTTP/1.1 GET upgrades and HTTP/2 CONNECT upgrades transparently.
    // It is intentionally outside the `RequestBodyLimitLayer` applied below
    // because that layer can interfere with the WS upgrade handshake.
    let protected_routes = Router::new()
        .route("/api/v1/whoami", get(auth::whoami_handler))
        .route("/api/v1/_rpc/:name", post(rpc::rpc_handler))
        .route("/ws/v1/events", any(ws::ws_handler))
        .layer(from_fn_with_state(
            state.clone(),
            middleware::require_device_jwt,
        ));

    Router::new()
        .merge(public_routes)
        .merge(protected_routes)
        // Body-size limit applied to all routes.  JWT payloads are tiny; the
        // generous limit leaves room for future multipart (M4.6 push-token).
        .layer(RequestBodyLimitLayer::new(BODY_LIMIT_BYTES))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_api::{redemption_lru::RedemptionLru, CompanionState};
    use parking_lot::RwLock;
    use std::sync::Arc;

    const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";

    fn test_state() -> SharedState {
        use crate::companion_api::{
            deny_list::DenyList, event_bus::EventBus, idempotency::IdempotencyCache,
        };
        Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
        })
    }

    // ── Smoke: spawn + immediate shutdown ────────────────────────────────

    #[tokio::test]
    async fn spawn_and_shutdown_loopback() {
        let state = test_state();
        let handle = spawn_server(0, true, state)
            .await
            .expect("spawn on ephemeral port");
        assert!(handle.bound_port > 0);
        // Graceful shutdown must not hang.
        let _ = handle.shutdown.send(());
    }

    #[tokio::test]
    async fn spawn_and_shutdown_unspecified() {
        let state = test_state();
        let handle = spawn_server(0, false, state)
            .await
            .expect("spawn on ephemeral port");
        assert!(handle.bound_port > 0);
        let _ = handle.shutdown.send(());
    }

    // ── HTTP smoke via reqwest ────────────────────────────────────────────

    #[tokio::test]
    async fn issue_reachable_after_spawn() {
        let state = test_state();
        let handle = spawn_server(0, true, state)
            .await
            .expect("spawn");

        let url = format!(
            "http://127.0.0.1:{}/api/v1/auth/pair/issue",
            handle.bound_port
        );
        let client = reqwest::Client::new();
        let resp = client
            .post(&url)
            .send()
            .await
            .expect("POST /api/v1/auth/pair/issue");
        assert_eq!(resp.status().as_u16(), 200);

        let _ = handle.shutdown.send(());
    }

    #[test]
    fn body_limit_is_64_kib() {
        assert_eq!(BODY_LIMIT_BYTES, 64 * 1024);
    }

    #[test]
    fn default_port_is_7890() {
        assert_eq!(DEFAULT_PORT, 7890);
    }
}
