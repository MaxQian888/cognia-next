//! Axum server bootstrap for the CLI bridge.
//!
//! Binds to `127.0.0.1:0` (ephemeral port), wires the twelve routes behind
//! the loopback + dev-token middleware, and returns
//! `(bound_port, shutdown_tx)` so the caller can shut us down later.

use ::anyhow::Result;
use axum::{
    extract::{ConnectInfo, Request, State},
    http::StatusCode,
    middleware::{from_fn_with_state, Next},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use serde_json::json;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use tokio::sync::watch;
use tower_http::limit::RequestBodyLimitLayer;

use super::{handlers, is_loopback, SharedState};

/// 4 MiB body cap — bundle paths are short, but reload events may carry a
/// manifest. Generous enough for foreseeable use, tight enough to refuse
/// pathological payloads.
const BODY_LIMIT_BYTES: usize = 4 * 1024 * 1024;

pub async fn spawn(state: SharedState) -> Result<(u16, watch::Sender<()>)> {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);
    let std_listener = std::net::TcpListener::bind(addr)?;
    std_listener.set_nonblocking(true)?;
    let bound_port = std_listener.local_addr()?.port();
    let tokio_listener = tokio::net::TcpListener::from_std(std_listener)?;

    let app = build_router(state.clone());

    let (tx, mut rx) = watch::channel(());
    tokio::spawn(async move {
        let result = axum::serve(
            tokio_listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = rx.changed().await;
        })
        .await;
        if let Err(e) = result {
            log::warn!("cli_bridge axum exited with error: {e}");
        }
    });

    Ok((bound_port, tx))
}

pub fn build_router(state: SharedState) -> Router {
    // NOTE: the `/api/dev/*` prefix is a stable wire path shared with the
    // `cognia-agent` CLI (see `cli/src/handoff/client.ts`) — it is NOT a
    // debug/dev-build gate. This bridge is started unconditionally in release
    // too (`mod.rs::init`); only the *dev-build binary discovery* is
    // debug-gated. Do not rename these routes without a coordinated CLI change,
    // or already-installed CLIs stop reaching the desktop.
    Router::new()
        .route("/api/dev/health", get(handlers::health))
        // ── Read endpoints ──────────────────────────────────────────────
        // `installed` returns the list of currently-loaded plugins so the
        // `cognia plugin install` CLI can preflight a same-id collision
        // and prompt the author before clobbering an existing version.
        // Snapshot subset — never exposes runtime_state (may carry
        // sensitive per-plugin secrets); see handlers::list_installed.
        .route("/api/dev/plugins/installed", get(handlers::list_installed))
        // ── Write endpoints ─────────────────────────────────────────────
        .route("/api/dev/plugins/install", post(handlers::install))
        .route(
            "/api/dev/plugins/install-directory",
            post(handlers::install_directory),
        )
        .route("/api/dev/plugins/uninstall", post(handlers::uninstall))
        .route("/api/dev/plugins/reload", post(handlers::reload))
        // ── ACP bridge ticket broker ─────────────────────────────────────
        // Mints a single-use Companion socket ticket for the `cognia acp` stdio↔WS
        // bridge (same loopback + dev-token trust model as plugin install).
        .route("/api/dev/acp/ticket", post(handlers::acp_ticket))
        // ── Session handoff (standalone agent CLI → desktop) ────────────
        // The CLI POSTs a session transcript; we emit it on
        // `cli-bridge:session-handoff` for the renderer to import + open.
        .route("/api/dev/sessions/handoff", post(handlers::handoff))
        // ── Renderer-backed routes (twin context / agent teams) ─────────
        // These round-trip through the WebView via the renderer bridge —
        // twin retrieval reads Dexie + the vector store, and AgentTeam
        // definitions live in the renderer's Zustand store, so the Rust
        // side cannot answer them directly.
        .route("/api/dev/twin/context", post(handlers::twin_context))
        .route("/api/dev/teams/list", post(handlers::teams_list))
        .route("/api/dev/teams/run", post(handlers::teams_run))
        .route(
            "/api/dev/teams/run-status",
            post(handlers::teams_run_status),
        )
        .layer(from_fn_with_state(state.clone(), auth_middleware))
        .layer(RequestBodyLimitLayer::new(BODY_LIMIT_BYTES))
        .with_state(state)
}

/// Tower middleware enforcing loopback origin + dev token. Returns the
/// canonical `Response` shape so error paths emit the same JSON envelope
/// as the handlers (`{ "ok": false, "error": "..." }`).
async fn auth_middleware(
    State(state): State<SharedState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Response {
    if !is_loopback(&addr) {
        log::warn!("cli_bridge rejected non-loopback connection from {addr}");
        return error_response(
            StatusCode::FORBIDDEN,
            "remote_blocked",
            "the cli bridge accepts loopback (127.0.0.1) connections only",
        );
    }
    let header_value = request
        .headers()
        .get("X-Cognia-Dev-Token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !constant_time_eq(header_value.as_bytes(), state.dev_token.as_bytes()) {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "bad_dev_token",
            "X-Cognia-Dev-Token header missing or incorrect",
        );
    }
    next.run(request).await
}

fn error_response(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "ok": false, "error": message, "code": code })),
    )
        .into_response()
}

/// Constant-time byte comparison — small dependency-free helper rather
/// than reaching for `subtle` for one call site.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOCUMENTED_DEV_ROUTES: [&str; 12] = [
        "/api/dev/health",
        "/api/dev/plugins/installed",
        "/api/dev/plugins/install",
        "/api/dev/plugins/install-directory",
        "/api/dev/plugins/uninstall",
        "/api/dev/plugins/reload",
        "/api/dev/acp/ticket",
        "/api/dev/sessions/handoff",
        "/api/dev/twin/context",
        "/api/dev/teams/list",
        "/api/dev/teams/run",
        "/api/dev/teams/run-status",
    ];

    #[test]
    fn constant_time_eq_basic() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn body_limit_constant_is_reasonable() {
        // 4 MiB is enough for any plausible plugin manifest + path string
        // but small enough to refuse pathological payloads.
        assert_eq!(BODY_LIMIT_BYTES, 4 * 1024 * 1024);
    }

    #[test]
    fn documented_dev_route_catalog_matches_router() {
        let source = include_str!("server.rs");
        let router_source = source
            .split("#[cfg(test)]")
            .next()
            .expect("router source precedes tests");
        assert_eq!(
            router_source.matches(".route(").count(),
            DOCUMENTED_DEV_ROUTES.len()
        );
        for route in DOCUMENTED_DEV_ROUTES {
            assert_eq!(
                router_source.matches(&format!("\"{route}\"")).count(),
                1,
                "route catalog drifted for {route}"
            );
        }
    }
}
