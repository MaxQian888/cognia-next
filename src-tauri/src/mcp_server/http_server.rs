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
use std::time::Instant;

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    middleware::{from_fn_with_state, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use tokio::sync::watch;
use tower_http::limit::RequestBodyLimitLayer;

use super::proxy_common::{token_matches, RateLimiter};
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
    /// Per-peer bad-token lockout for the auth middleware. Reuses the proxy
    /// limiter; only the lockout half is applied here (well-authenticated
    /// traffic is never throttled — see `auth_middleware`).
    auth_limiter: Arc<RateLimiter>,
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
        auth_limiter: Arc::new(RateLimiter::default()),
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

/// Returns true when a request is genuinely local — i.e. not a browser
/// cross-origin / DNS-rebinding attempt against this loopback-bound server.
///
/// A DNS-rebinding page resolves an attacker hostname to `127.0.0.1` and POSTs
/// from the victim's browser; the request then carries `Host: attacker.com`
/// (and usually `Origin: http://attacker.com`). Legitimate MCP clients connect
/// directly to loopback and send a loopback `Host` with no cross-origin
/// `Origin`. Requiring the `Host` authority — and the `Origin`, when present —
/// to be loopback defeats both vectors. The MCP streamable-HTTP spec mandates
/// exactly this Origin validation.
fn is_local_request(host: Option<&str>, origin: Option<&str>) -> bool {
    fn authority_is_loopback(value: &str) -> bool {
        // Strip an optional scheme (Origin is `scheme://host[:port]`; Host is
        // bare `host[:port]`), then the path and port, leaving the hostname.
        let after_scheme = value.split_once("://").map(|(_, r)| r).unwrap_or(value);
        let host_only = after_scheme.split(['/', '?']).next().unwrap_or("");
        // Bracketed IPv6 (`[::1]:port`) vs host:port — handle both.
        let hostname = if let Some(rest) = host_only.strip_prefix('[') {
            rest.split(']').next().unwrap_or("")
        } else {
            host_only.split(':').next().unwrap_or("")
        };
        matches!(hostname, "127.0.0.1" | "localhost" | "::1")
    }

    // The Host header is mandatory and must be loopback.
    match host {
        Some(h) if authority_is_loopback(h) => {}
        _ => return false,
    }
    // Origin, when present, must also be loopback ("null" / cross-origin → reject).
    match origin {
        None => true,
        Some(o) => authority_is_loopback(o),
    }
}

/// Bearer-token authentication middleware.
///
/// Applies, in order: (1) a DNS-rebinding / cross-origin guard on every route,
/// (2) a `/healthz` auth bypass, (3) a per-peer bad-token lockout, and (4) the
/// constant-time bearer check. Correctly-authenticated traffic is never
/// throttled — only repeated bad tokens trigger the lockout.
async fn auth_middleware(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    // 1. Cross-origin / DNS-rebinding guard (all routes, including healthz).
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok());
    let origin = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    if !is_local_request(host, origin) {
        return error_body(
            StatusCode::FORBIDDEN,
            "cross-origin or non-local request rejected",
        );
    }

    // 2. Liveness probe needs no token.
    if request.uri().path() == "/healthz" {
        return next.run(request).await;
    }

    // 3. Bad-token lockout (does not throttle good traffic).
    let ip = peer.ip();
    let now = Instant::now();
    if state.auth_limiter.is_locked_out(ip, now) {
        return error_body(
            StatusCode::TOO_MANY_REQUESTS,
            "too many failed attempts; try again later",
        );
    }

    // 4. Bearer check (constant-time, length-prechecked).
    let supplied_token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));

    let Some(supplied_token) = supplied_token else {
        state.auth_limiter.record_bad_token(ip, now);
        return error_body(StatusCode::UNAUTHORIZED, "missing bearer token");
    };

    if !token_matches(supplied_token, &state.token) {
        state.auth_limiter.record_bad_token(ip, now);
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
    fn token_matches_identical_tokens() {
        assert!(token_matches("correct-bearer-token", "correct-bearer-token"));
    }

    #[test]
    fn token_matches_rejects_different_content_same_length() {
        assert!(!token_matches("aaaaaaaaaaaaaaaaaaa1", "aaaaaaaaaaaaaaaaaaa2"));
    }

    #[test]
    fn token_matches_rejects_length_mismatch() {
        assert!(!token_matches("short", "long-token-value"));
    }

    // ── DNS-rebinding / cross-origin guard (P1-2) ─────────────────────────

    #[test]
    fn is_local_request_accepts_loopback_host_no_origin() {
        assert!(is_local_request(Some("127.0.0.1:47920"), None));
        assert!(is_local_request(Some("localhost:47920"), None));
        assert!(is_local_request(Some("[::1]:47920"), None));
    }

    #[test]
    fn is_local_request_accepts_loopback_host_and_loopback_origin() {
        assert!(is_local_request(
            Some("127.0.0.1:47920"),
            Some("http://127.0.0.1:47920")
        ));
        assert!(is_local_request(
            Some("localhost:47920"),
            Some("http://localhost")
        ));
    }

    #[test]
    fn is_local_request_rejects_rebound_host() {
        // DNS rebinding: hostname resolves to 127.0.0.1 but Host carries the
        // attacker domain.
        assert!(!is_local_request(Some("attacker.com"), None));
        assert!(!is_local_request(Some("attacker.com:47920"), None));
    }

    #[test]
    fn is_local_request_rejects_cross_origin_browser_request() {
        // Loopback Host but a cross-origin Origin → reject.
        assert!(!is_local_request(
            Some("127.0.0.1:47920"),
            Some("http://evil.example")
        ));
        // "null" origin (sandboxed iframe) → reject.
        assert!(!is_local_request(Some("127.0.0.1:47920"), Some("null")));
    }

    #[test]
    fn is_local_request_rejects_missing_host() {
        assert!(!is_local_request(None, None));
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
    async fn mcp_post_rejects_rebinding_host_even_with_valid_token() {
        let Ok(sidecar) = spawn_echo_for_tests().await else {
            return;
        };
        let handle = spawn_server(
            0,
            "correct-token-correct-token-1234".to_string(),
            Arc::new(sidecar),
            echo_sessions(),
        )
        .await
        .expect("bind");

        let client = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{}/mcp", handle.bound_port);
        // Simulate a DNS-rebinding page: correct bearer, but the Host header is
        // an attacker domain (resolved to loopback). Must be rejected with 403
        // before the bearer is even considered.
        let resp = client
            .post(&url)
            .header("Host", "attacker.example")
            .header("Authorization", "Bearer correct-token-correct-token-1234")
            .header("Content-Type", "application/json")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)
            .send()
            .await
            .expect("POST");

        assert_eq!(resp.status().as_u16(), 403);
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
