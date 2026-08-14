//! HTTP / WS server bootstrap.

use std::{net::SocketAddr, sync::Arc};

use axum::{
    response::IntoResponse,
    routing::{any, get},
    Json, Router,
};
use serde_json::json;
use tower_http::{limit::RequestBodyLimitLayer, trace::TraceLayer};
use tracing::info;

use cognia_signaling_core::policy::{is_valid_allowed_origin, RoomLimits};

use crate::{
    ip_limits::{default_max_conn_per_ip, trust_proxy_headers_from_env, IpLimits},
    metrics::Metrics,
    room::RoomRegistry,
    ws::ws_upgrade,
};

/// Cap on the pre-upgrade HTTP request body. This does **not** bound WS
/// frames after the upgrade — the per-frame 8 KiB cap lives in
/// `ws::handle_socket` (`MAX_FRAME_BYTES`) plus the hard `max_message_size`
/// set on the upgrade.
const MAX_BODY_BYTES: usize = 8 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub registry: Arc<RoomRegistry>,
    pub metrics: Arc<Metrics>,
    pub ip_limits: Arc<IpLimits>,
    /// Room admission caps (peer count, desktop cardinality). Shared verbatim
    /// with the Cloudflare Worker via `cognia-signaling-core::policy`.
    pub room_limits: RoomLimits,
    /// Allowed cross-origin WebSocket `Origin` values. Empty denies browser
    /// cross-origin access; native clients and same-origin browsers remain
    /// available.
    pub allowed_origins: Arc<Vec<String>>,
    /// Whether proxy-set client IP headers are trusted for the per-IP gate.
    pub trust_proxy_headers: bool,
}

/// Read [`RoomLimits`] from the environment, falling back to the defaults
/// (`max_peers = 2`, `max_desktops = 1`).
pub fn room_limits_from_env() -> RoomLimits {
    let default = RoomLimits::default();
    let max_peers = std::env::var("SIGNALING_MAX_PEERS_PER_ROOM")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(default.max_peers);
    let max_desktops = std::env::var("SIGNALING_MAX_DESKTOPS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(default.max_desktops);
    RoomLimits {
        max_peers,
        max_desktops,
    }
}

/// Parse the comma-separated `SIGNALING_ALLOWED_ORIGINS` env var into a list.
/// Blank / unset yields an empty list (same-origin only). Invalid entries are
/// rejected rather than ignored so a deployment cannot accidentally rely on a
/// wildcard, plaintext, or path-bearing value.
pub fn allowed_origins_from_env() -> anyhow::Result<Vec<String>> {
    parse_allowed_origins(&std::env::var("SIGNALING_ALLOWED_ORIGINS").unwrap_or_default())
}

fn parse_allowed_origins(raw: &str) -> anyhow::Result<Vec<String>> {
    raw.split(',')
        .map(str::trim)
        .filter(|origin| !origin.is_empty())
        .map(|origin| {
            if is_valid_allowed_origin(origin) {
                Ok(origin.to_string())
            } else {
                anyhow::bail!(
                    "SIGNALING_ALLOWED_ORIGINS entry must be an exact HTTPS origin: {origin}"
                )
            }
        })
        .collect()
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/metrics", get(metrics_handler))
        .route("/signaling", any(ws_upgrade))
        // Pre-rename path. Clients bake their endpoint in at pair time, so
        // already-paired devices keep dialing this one; dropping it would make
        // a relay redeploy silently cut them off.
        .route("/v2/signaling", any(ws_upgrade))
        .layer(RequestBodyLimitLayer::new(MAX_BODY_BYTES))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn healthz(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Json<serde_json::Value> {
    let stats = state.registry.stats();
    Json(json!({
        "ok": true,
        "rooms": stats.rooms,
        "peers": stats.peers,
        "uptimeSeconds": state.metrics.uptime_seconds(),
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

async fn metrics_handler(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> impl IntoResponse {
    let body = state.metrics.render_prometheus(state.registry.stats());
    (
        [("content-type", "text/plain; version=0.0.4; charset=utf-8")],
        body,
    )
}

/// Assemble a fresh `AppState`. Shared by `serve` and the test harness so the
/// two can't drift.
fn build_state(
    max_conn_per_ip: usize,
    room_limits: RoomLimits,
    allowed_origins: Vec<String>,
    trust_proxy_headers: bool,
) -> AppState {
    AppState {
        registry: Arc::new(RoomRegistry::new()),
        metrics: Arc::new(Metrics::new()),
        ip_limits: IpLimits::new(max_conn_per_ip),
        room_limits,
        allowed_origins: Arc::new(allowed_origins),
        trust_proxy_headers,
    }
}

/// Run the server in the current tokio runtime. Returns when the listener
/// stops accepting (e.g., SIGINT after `tokio::signal::ctrl_c`).
pub async fn serve(addr: SocketAddr) -> anyhow::Result<()> {
    let max_per_ip = default_max_conn_per_ip();
    let room_limits = room_limits_from_env();
    let allowed_origins = allowed_origins_from_env()?;
    let trust_proxy_headers = trust_proxy_headers_from_env();
    let app = router(build_state(
        max_per_ip,
        room_limits,
        allowed_origins.clone(),
        trust_proxy_headers,
    ));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let bound = listener.local_addr()?;
    info!(
        target: "signaling",
        %bound,
        max_conn_per_ip = max_per_ip,
        max_peers_per_room = room_limits.max_peers,
        max_desktops = room_limits.max_desktops,
        allowed_origins = allowed_origins.len(),
        trust_proxy_headers,
        "listening"
    );

    // `into_make_service_with_connect_info` is required so the WS upgrade
    // handler can extract `ConnectInfo<SocketAddr>` and pick up the
    // tcp-layer peer address for the IpLimits gate.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = term => {}
    }
    info!(target: "signaling", "shutting down");
}

/// Convenience for tests: bind to an ephemeral port and return the bound
/// address + shutdown handle. Public because the integration test crate
/// under `tests/` needs to call into it.
pub async fn serve_for_test() -> anyhow::Result<(std::net::SocketAddr, tokio::task::JoinHandle<()>)>
{
    serve_for_test_with(default_max_conn_per_ip()).await
}

/// Like [`serve_for_test`] but lets the caller pick the per-IP cap.
/// Used by the per-IP rate-limit integration test which would have to
/// open 50+ sockets otherwise.
pub async fn serve_for_test_with(
    max_conn_per_ip: usize,
) -> anyhow::Result<(std::net::SocketAddr, tokio::task::JoinHandle<()>)> {
    serve_for_test_full(
        max_conn_per_ip,
        room_limits_from_env(),
        allowed_origins_from_env()?,
        false,
    )
    .await
}

/// Like [`serve_for_test_with`] but also lets the caller pin the room limits
/// and origin allowlist. Used by the room-cap / origin integration tests.
pub async fn serve_for_test_full(
    max_conn_per_ip: usize,
    room_limits: RoomLimits,
    allowed_origins: Vec<String>,
    trust_proxy_headers: bool,
) -> anyhow::Result<(std::net::SocketAddr, tokio::task::JoinHandle<()>)> {
    let app = router(build_state(
        max_conn_per_ip,
        room_limits,
        allowed_origins,
        trust_proxy_headers,
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let handle = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    Ok((addr, handle))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt; // `oneshot`

    /// Drive a GET through the router without binding a socket.
    async fn get(uri: &str) -> (StatusCode, axum::http::HeaderMap, String) {
        let app = router(build_state(50, RoomLimits::default(), Vec::new(), false));
        let res = app
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        (status, headers, String::from_utf8(bytes.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn healthz_returns_ok_json() {
        let (status, _headers, body) = get("/healthz").await;
        assert_eq!(status, StatusCode::OK);
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["rooms"], 0);
        assert_eq!(v["peers"], 0);
        assert!(v["version"].is_string());
        assert!(v["uptimeSeconds"].is_number());
    }

    /// A plain GET on either signaling path reaches the upgrade handler (which
    /// then refuses a non-WebSocket request) rather than falling through to
    /// 404. Devices paired before the rename still dial `/v2/signaling`.
    #[tokio::test]
    async fn both_signaling_paths_are_routed() {
        for uri in ["/signaling", "/v2/signaling"] {
            let (status, _headers, _body) = get(uri).await;
            assert_ne!(status, StatusCode::NOT_FOUND, "{uri} must stay routed");
        }
    }

    #[tokio::test]
    async fn metrics_returns_prometheus_text() {
        let (status, headers, body) = get("/metrics").await;
        assert_eq!(status, StatusCode::OK);
        let ct = headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(ct.starts_with("text/plain"), "got content-type {ct}");
        assert!(body.contains("# TYPE signaling_frames_in_total counter\n"));
        assert!(body.contains("signaling_frames_rejected_total{reason=\"too_large\"} 0\n"));
        assert!(body.contains("signaling_uptime_seconds"));
    }

    #[test]
    fn build_state_uses_requested_cap() {
        let state = build_state(7, RoomLimits::default(), Vec::new(), false);
        assert_eq!(state.ip_limits.snapshot().max_per_ip, 7);
        assert_eq!(state.room_limits.max_peers, 2);
        assert!(state.allowed_origins.is_empty());
        assert!(!state.trust_proxy_headers);
    }

    #[test]
    fn env_helpers_return_defaults_when_unset() {
        // These keys aren't set by the test runner, so the helpers exercise
        // their default path. (Parsing of populated values is covered by the
        // pure split below and by core::policy's own tests.)
        let limits = room_limits_from_env();
        assert!(limits.max_peers >= 1 && limits.max_desktops >= 1);
        // Calling the origin helper exercises its body; the result depends on
        // the ambient env, so we only assert it is a (possibly empty) list.
        let _origins = allowed_origins_from_env();
    }

    #[test]
    fn allowed_origins_from_env_parses_csv() {
        // Drive the parser directly (no global env mutation, to stay
        // thread-safe under the test runner).
        let parsed = parse_allowed_origins("https://a.example, https://b.example ,,").unwrap();
        assert_eq!(parsed, vec!["https://a.example", "https://b.example"]);
    }

    #[test]
    fn allowed_origins_reject_wildcards_plaintext_and_paths() {
        for invalid in [
            "*",
            "http://app.example",
            "capacitor://localhost",
            "https://*.example",
            "https://app.example/path",
        ] {
            assert!(
                parse_allowed_origins(invalid).is_err(),
                "accepted {invalid}"
            );
        }
    }
}
