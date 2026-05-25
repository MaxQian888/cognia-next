//! HTTP / WS server bootstrap.

use std::{net::SocketAddr, sync::Arc};

use axum::{
    response::IntoResponse,
    routing::{any, get},
    Json, Router,
};
use serde_json::json;
use tower_http::{cors::CorsLayer, limit::RequestBodyLimitLayer, trace::TraceLayer};
use tracing::info;

use crate::{
    ip_limits::{default_max_conn_per_ip, IpLimits},
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
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/metrics", get(metrics_handler))
        .route("/v1/signaling", any(ws_upgrade))
        .layer(RequestBodyLimitLayer::new(MAX_BODY_BYTES))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn healthz(axum::extract::State(state): axum::extract::State<AppState>) -> Json<serde_json::Value> {
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

/// Assemble a fresh `AppState` with the given per-IP connection cap. Shared
/// by `serve` and the test harness so the two can't drift.
fn build_state(max_conn_per_ip: usize) -> AppState {
    AppState {
        registry: Arc::new(RoomRegistry::new()),
        metrics: Arc::new(Metrics::new()),
        ip_limits: IpLimits::new(max_conn_per_ip),
    }
}

/// Run the server in the current tokio runtime. Returns when the listener
/// stops accepting (e.g., SIGINT after `tokio::signal::ctrl_c`).
pub async fn serve(addr: SocketAddr) -> anyhow::Result<()> {
    let max_per_ip = default_max_conn_per_ip();
    let app = router(build_state(max_per_ip));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let bound = listener.local_addr()?;
    info!(
        target: "signaling",
        %bound,
        max_conn_per_ip = max_per_ip,
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
        if let Ok(mut s) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
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
pub async fn serve_for_test() -> anyhow::Result<(std::net::SocketAddr, tokio::task::JoinHandle<()>)> {
    serve_for_test_with(default_max_conn_per_ip()).await
}

/// Like [`serve_for_test`] but lets the caller pick the per-IP cap.
/// Used by the per-IP rate-limit integration test which would have to
/// open 50+ sockets otherwise.
pub async fn serve_for_test_with(
    max_conn_per_ip: usize,
) -> anyhow::Result<(std::net::SocketAddr, tokio::task::JoinHandle<()>)> {
    let app = router(build_state(max_conn_per_ip));
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
        let app = router(build_state(50));
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
        let state = build_state(7);
        assert_eq!(state.ip_limits.snapshot().max_per_ip, 7);
    }
}
