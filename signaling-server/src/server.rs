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

/// 8 KiB cap on every WS frame's HTTP body — pre-upgrade only; per-frame
/// caps are enforced by `axum::extract::ws::WebSocket` defaults.
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

/// Run the server in the current tokio runtime. Returns when the listener
/// stops accepting (e.g., SIGINT after `tokio::signal::ctrl_c`).
pub async fn serve(addr: SocketAddr) -> anyhow::Result<()> {
    let max_per_ip = default_max_conn_per_ip();
    let state = AppState {
        registry: Arc::new(RoomRegistry::new()),
        metrics: Arc::new(Metrics::new()),
        ip_limits: IpLimits::new(max_per_ip),
    };
    let app = router(state);
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
    let state = AppState {
        registry: Arc::new(RoomRegistry::new()),
        metrics: Arc::new(Metrics::new()),
        ip_limits: IpLimits::new(max_conn_per_ip),
    };
    let app = router(state);
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
