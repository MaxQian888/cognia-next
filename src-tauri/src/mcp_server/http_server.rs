//! Axum HTTP server for the External Bridge MCP endpoint.
//!
//! # Endpoints
//!
//! - `GET  /healthz`  — liveness probe, no auth required.
//! - `POST /mcp`      — JSON-RPC MCP request; forwarded to the Node sidecar.
//! - `POST /mcp/sse`  — SSE streaming endpoint; returns 501 in Phase 1.
//!
//! # Middleware (outer → inner)
//!
//! 1. Body-size limit (1 MiB) via `tower_http::limit::RequestBodyLimitLayer`.
//! 2. Bearer auth via `subtle::ConstantTimeEq` — constant-time comparison
//!    prevents timing-based token oracle attacks.
//!
//! No IP allowlist: the listener binds only to `127.0.0.1`, which is
//! sufficient for v1.  Localhost-only binding means only processes on the
//! same machine can reach the port.
//!
//! # Graceful shutdown
//!
//! Driven by a `tokio::sync::watch` channel.  The outer state calls
//! `handle.shutdown.send(())` to signal the server task to drain and exit.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    middleware::{from_fn_with_state, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use subtle::ConstantTimeEq;
use tokio::sync::watch;
use tower_http::limit::RequestBodyLimitLayer;

use super::sidecar::SidecarProcess;
use super::streamable_http::{self, SessionRegistry};
use super::types::McpServerError;

/// 1 MiB — MCP envelopes can be larger than the 8 KiB remote-control limit.
const BODY_LIMIT_BYTES: usize = 1024 * 1024;

/// Returned by [`spawn_server`] so the caller can record the ephemeral port
/// and later send the graceful-shutdown signal.
#[derive(Clone)]
pub struct ServerHandle {
    /// The port the listener is actually bound to (`0` → OS-assigned).
    pub bound_port: u16,
    /// Send `()` here to initiate graceful shutdown.
    pub shutdown: watch::Sender<()>,
}

/// Shared state injected into every axum handler.
#[derive(Clone)]
pub(crate) struct AppState {
    token: Arc<String>,
    sidecar: Arc<SidecarProcess>,
    pub(crate) sessions: Arc<SessionRegistry>,
}

/// Spawn the axum listener on `127.0.0.1:<port>`.
///
/// Returns a [`ServerHandle`] containing the actual bound port (relevant when
/// `port` is `0`) and a shutdown sender.
pub async fn spawn_server(
    port: u16,
    token: String,
    sidecar: Arc<SidecarProcess>,
    sessions: Arc<SessionRegistry>,
) -> Result<ServerHandle, McpServerError> {
    let bind_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .map_err(|source| McpServerError::Bind { port, source })?;
    let bound_port = listener
        .local_addr()
        .map_err(|source| McpServerError::Bind { port, source })?
        .port();

    let state = AppState {
        token: Arc::new(token),
        sidecar,
        sessions: Arc::clone(&sessions),
    };

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/mcp", post(mcp_post))
        // Modern streamable-HTTP transport (session-scoped, SSE-capable).
        .route(
            "/mcp/stream",
            post(streamable_http::post_handler)
                .get(streamable_http::get_handler)
                .delete(streamable_http::delete_handler),
        )
        // Back-compat alias: the old 501 stub now delegates to the streamable
        // POST handler so configs pointing at `/mcp/sse` keep working.
        .route("/mcp/sse", post(streamable_http::post_handler))
        .layer(from_fn_with_state(state.clone(), auth_middleware))
        .layer(RequestBodyLimitLayer::new(BODY_LIMIT_BYTES))
        .with_state(state);

    let (tx, mut rx) = watch::channel(());

    // Idle-session reaper — swept every 30s, cancelled by the shutdown signal.
    let mut reap_rx = tx.subscribe();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {
                    sessions.reap_idle();
                }
                _ = reap_rx.changed() => break,
            }
        }
    });

    tokio::spawn(async move {
        let result = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = rx.changed().await;
        })
        .await;

        if let Err(error) = result {
            log::warn!("mcp-server exited with error: {error}");
        }
    });

    Ok(ServerHandle {
        bound_port,
        shutdown: tx,
    })
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn healthz() -> impl IntoResponse {
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

async fn mcp_post(
    State(state): State<AppState>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let request_str = match std::str::from_utf8(&body) {
        Ok(s) => s.trim().to_string(),
        Err(_) => return error_body(StatusCode::BAD_REQUEST, "request body must be UTF-8"),
    };

    if request_str.is_empty() {
        return error_body(StatusCode::BAD_REQUEST, "request body required");
    }

    match state.sidecar.round_trip(&request_str).await {
        Ok(response) => {
            // Pass the sidecar response through as raw JSON.  Avoid
            // re-parsing extension fields that the MCP SDK may add.
            let raw: serde_json::Value =
                serde_json::from_str(&response).unwrap_or(serde_json::Value::Null);
            (StatusCode::OK, Json(raw)).into_response()
        }
        Err(e) => error_body(StatusCode::BAD_GATEWAY, &format!("sidecar error: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/// Bearer-token authentication middleware.
///
/// `/healthz` is explicitly exempted so liveness probes work without a token.
async fn auth_middleware(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    if request.uri().path() == "/healthz" {
        return next.run(request).await;
    }

    let supplied_token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));

    let Some(supplied_token) = supplied_token else {
        return error_body(StatusCode::UNAUTHORIZED, "missing bearer token");
    };

    let expected = state.token.as_bytes();
    let supplied = supplied_token.as_bytes();

    // Length mismatch is revealed; content comparison is always constant-time
    // via `subtle` so no timing oracle can leak the token.
    if expected.len() != supplied.len() || expected.ct_eq(supplied).unwrap_u8() == 0 {
        return error_body(StatusCode::UNAUTHORIZED, "invalid token");
    }

    next.run(request).await
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn error_body(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_server::sidecar::spawn_echo_for_tests;

    /// An empty session registry backed by the echo spawner (tests).
    fn echo_sessions() -> Arc<SessionRegistry> {
        Arc::new(SessionRegistry::new(
            streamable_http::Spawner::Echo,
            streamable_http::DEFAULT_IDLE_TTL,
        ))
    }

    // ── Pure unit tests (no network, no sidecar) ──────────────────────────

    #[test]
    fn body_limit_is_one_mib() {
        assert_eq!(BODY_LIMIT_BYTES, 1024 * 1024);
    }

    #[test]
    fn body_limit_larger_than_remote_control_8kib() {
        assert!(BODY_LIMIT_BYTES > 8 * 1024);
    }

    #[test]
    fn constant_time_eq_identical_tokens() {
        let a = b"correct-bearer-token";
        let b = b"correct-bearer-token";
        assert_eq!(a.ct_eq(b).unwrap_u8(), 1);
    }

    #[test]
    fn constant_time_eq_different_content_same_length() {
        let a = b"aaaaaaaaaaaaaaaaaaa1";
        let b = b"aaaaaaaaaaaaaaaaaaa2";
        assert_eq!(a.ct_eq(b).unwrap_u8(), 0);
    }

    #[test]
    fn length_mismatch_caught_before_constant_time_compare() {
        let expected = b"long-token-value";
        let supplied = b"short";
        assert_ne!(expected.len(), supplied.len());
    }

    // ── Integration tests (require `node` on PATH) ────────────────────────

    #[tokio::test]
    async fn healthz_returns_200_without_auth() {
        let Ok(sidecar) = spawn_echo_for_tests().await else {
            return; // node not available
        };

        let handle = spawn_server(0, "test-token".to_string(), Arc::new(sidecar), echo_sessions())
            .await
            .expect("server should bind on ephemeral port");

        let url = format!("http://127.0.0.1:{}/healthz", handle.bound_port);
        let resp = reqwest::get(&url).await.expect("GET /healthz");
        assert_eq!(resp.status().as_u16(), 200);

        let body: serde_json::Value = resp.json().await.expect("json");
        assert_eq!(body["ok"], true);

        let _ = handle.shutdown.send(());
    }

    #[tokio::test]
    async fn mcp_post_rejects_missing_bearer() {
        let Ok(sidecar) = spawn_echo_for_tests().await else {
            return;
        };

        let handle = spawn_server(0, "test-token".to_string(), Arc::new(sidecar), echo_sessions())
            .await
            .expect("bind");

        let client = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{}/mcp", handle.bound_port);
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)
            .send()
            .await
            .expect("POST");

        assert_eq!(resp.status().as_u16(), 401);

        let _ = handle.shutdown.send(());
    }

    #[tokio::test]
    async fn mcp_post_rejects_wrong_token() {
        let Ok(sidecar) = spawn_echo_for_tests().await else {
            return;
        };

        let handle = spawn_server(0, "correct-token".to_string(), Arc::new(sidecar), echo_sessions())
            .await
            .expect("bind");

        let client = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{}/mcp", handle.bound_port);
        let resp = client
            .post(&url)
            .header("Authorization", "Bearer wrong-token!")
            .header("Content-Type", "application/json")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)
            .send()
            .await
            .expect("POST");

        assert_eq!(resp.status().as_u16(), 401);

        let _ = handle.shutdown.send(());
    }

    #[tokio::test]
    async fn mcp_post_accepts_correct_token_and_forwards_to_sidecar() {
        let Ok(sidecar) = spawn_echo_for_tests().await else {
            return;
        };

        let handle = spawn_server(0, "correct-token".to_string(), Arc::new(sidecar), echo_sessions())
            .await
            .expect("bind");

        let client = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{}/mcp", handle.bound_port);
        let payload = r#"{"jsonrpc":"2.0","id":42,"method":"tools/list"}"#;
        let resp = client
            .post(&url)
            .header("Authorization", "Bearer correct-token")
            .header("Content-Type", "application/json")
            .body(payload)
            .send()
            .await
            .expect("POST /mcp");

        // Echo sidecar returns the same JSON — expect 200 with valid JSON body.
        assert_eq!(resp.status().as_u16(), 200);

        let body: serde_json::Value = resp.json().await.expect("json body");
        assert_eq!(body["id"], 42);
        assert_eq!(body["method"], "tools/list");

        let _ = handle.shutdown.send(());
    }

    #[tokio::test]
    async fn mcp_sse_delegates_to_stream_initialize() {
        let Ok(sidecar) = spawn_echo_for_tests().await else {
            return;
        };

        let handle = spawn_server(0, "tok".to_string(), Arc::new(sidecar), echo_sessions())
            .await
            .expect("bind");

        let client = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{}/mcp/sse", handle.bound_port);
        // The 501 stub is gone — `/mcp/sse` now delegates to the streamable
        // POST handler. An `initialize` creates a session (echo replies in kind).
        let resp = client
            .post(&url)
            .header("Authorization", "Bearer tok")
            .header("Content-Type", "application/json")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#)
            .send()
            .await
            .expect("POST /mcp/sse");

        assert_eq!(resp.status().as_u16(), 200);
        assert!(resp.headers().get("mcp-session-id").is_some());

        let _ = handle.shutdown.send(());
    }

    #[tokio::test]
    async fn mcp_stream_initialize_then_session_routing() {
        let Ok(sidecar) = spawn_echo_for_tests().await else {
            return;
        };

        let handle = spawn_server(0, "tok".to_string(), Arc::new(sidecar), echo_sessions())
            .await
            .expect("bind");

        let client = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{}/mcp/stream", handle.bound_port);

        // 1. initialize → 200 + Mcp-Session-Id.
        let init = client
            .post(&url)
            .header("Authorization", "Bearer tok")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#)
            .send()
            .await
            .expect("POST initialize");
        assert_eq!(init.status().as_u16(), 200);
        let sid = init
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .expect("session id")
            .to_string();

        // 2. a non-initialize request WITHOUT a session header → 400.
        let no_sid = client
            .post(&url)
            .header("Authorization", "Bearer tok")
            .body(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#)
            .send()
            .await
            .expect("POST no-sid");
        assert_eq!(no_sid.status().as_u16(), 400);

        // 3. an unknown session id → 404.
        let bad_sid = client
            .post(&url)
            .header("Authorization", "Bearer tok")
            .header("Mcp-Session-Id", "does-not-exist")
            .body(r#"{"jsonrpc":"2.0","id":3,"method":"tools/list"}"#)
            .send()
            .await
            .expect("POST bad-sid");
        assert_eq!(bad_sid.status().as_u16(), 404);

        // 4. the real session id routes through to the echo sidecar → 200.
        let ok = client
            .post(&url)
            .header("Authorization", "Bearer tok")
            .header("Mcp-Session-Id", &sid)
            .body(r#"{"jsonrpc":"2.0","id":4,"method":"tools/list"}"#)
            .send()
            .await
            .expect("POST with sid");
        assert_eq!(ok.status().as_u16(), 200);
        let body: serde_json::Value = ok.json().await.expect("json");
        assert_eq!(body["id"], 4);

        // 5. DELETE ends the session → subsequent use is 404.
        let del = client
            .delete(&url)
            .header("Authorization", "Bearer tok")
            .header("Mcp-Session-Id", &sid)
            .send()
            .await
            .expect("DELETE");
        assert_eq!(del.status().as_u16(), 204);

        let _ = handle.shutdown.send(());
    }

    #[tokio::test]
    async fn mcp_stream_requires_bearer() {
        let Ok(sidecar) = spawn_echo_for_tests().await else {
            return;
        };
        let handle = spawn_server(0, "tok".to_string(), Arc::new(sidecar), echo_sessions())
            .await
            .expect("bind");
        let client = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{}/mcp/stream", handle.bound_port);
        let resp = client
            .post(&url)
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#)
            .send()
            .await
            .expect("POST");
        assert_eq!(resp.status().as_u16(), 401);
        let _ = handle.shutdown.send(());
    }
}
