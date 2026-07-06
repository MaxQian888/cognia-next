//! Prometheus text exposition for the companion front door (ADR-0059 D9).
//!
//! Same hand-rolled pattern as `services/{signaling,share}-server/src/
//! metrics.rs` — no client-library dependency, atomics + a render function.
//! Served at `GET /metrics` (public, like the services; the payload reveals
//! only aggregate counters). Counters are process-global (the usual
//! `TLS_FINGERPRINT` idiom) so the RPC handler / middleware / WS paths can
//! bump them without threading state.

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::Instant;

use axum::response::{IntoResponse, Response};
use once_cell::sync::Lazy;

static STARTED_AT: Lazy<Instant> = Lazy::new(Instant::now);

static RPC_CALLS_TOTAL: AtomicU64 = AtomicU64::new(0);
static RPC_ERRORS_TOTAL: AtomicU64 = AtomicU64::new(0);
static AUTH_FAILURES_TOTAL: AtomicU64 = AtomicU64::new(0);
static WS_CLIENTS_ACTIVE: AtomicI64 = AtomicI64::new(0);

/// Force `STARTED_AT` early so uptime measures boot, not first scrape.
pub fn init() {
    Lazy::force(&STARTED_AT);
}

pub fn record_rpc_call(success: bool) {
    RPC_CALLS_TOTAL.fetch_add(1, Ordering::Relaxed);
    if !success {
        RPC_ERRORS_TOTAL.fetch_add(1, Ordering::Relaxed);
    }
}

pub fn record_auth_failure() {
    AUTH_FAILURES_TOTAL.fetch_add(1, Ordering::Relaxed);
}

pub fn ws_client_connected() {
    WS_CLIENTS_ACTIVE.fetch_add(1, Ordering::Relaxed);
}

pub fn ws_client_disconnected() {
    WS_CLIENTS_ACTIVE.fetch_sub(1, Ordering::Relaxed);
}

fn push_metric(out: &mut String, name: &str, kind: &str, help: &str, value: impl std::fmt::Display) {
    out.push_str(&format!("# HELP {name} {help}\n"));
    out.push_str(&format!("# TYPE {name} {kind}\n"));
    out.push_str(&format!("{name} {value}\n"));
}

/// Render the exposition. Pure over the atomics + the live supervision
/// globals — unit-tested without a server.
pub fn render_prometheus() -> String {
    let mut out = String::with_capacity(2048);
    push_metric(
        &mut out,
        "cognia_uptime_seconds",
        "gauge",
        "Seconds since the front door booted.",
        STARTED_AT.elapsed().as_secs(),
    );
    push_metric(
        &mut out,
        "cognia_rpc_calls_total",
        "counter",
        "Companion RPC calls dispatched (HTTP path).",
        RPC_CALLS_TOTAL.load(Ordering::Relaxed),
    );
    push_metric(
        &mut out,
        "cognia_rpc_errors_total",
        "counter",
        "Companion RPC calls that returned an error envelope.",
        RPC_ERRORS_TOTAL.load(Ordering::Relaxed),
    );
    push_metric(
        &mut out,
        "cognia_auth_failures_total",
        "counter",
        "JWT middleware rejections (bad/expired/missing tokens).",
        AUTH_FAILURES_TOTAL.load(Ordering::Relaxed),
    );
    push_metric(
        &mut out,
        "cognia_ws_clients_active",
        "gauge",
        "Open /ws/v1/events client connections.",
        WS_CLIENTS_ACTIVE.load(Ordering::Relaxed).max(0),
    );

    // Supervision blocks (headless installs only; 0/absent on desktop).
    if let Some(status) = crate::headless::brain::brain_status() {
        push_metric(
            &mut out,
            "cognia_brain_ready",
            "gauge",
            "1 when the brain completed the bridge hello.",
            u8::from(status.ready),
        );
        push_metric(
            &mut out,
            "cognia_brain_restarts_total",
            "counter",
            "Brain child spawns since boot.",
            status.restart_count,
        );
        push_metric(
            &mut out,
            "cognia_brain_rss_bytes",
            "gauge",
            "Brain RSS from its bridge pong frames (0 = unknown).",
            status.rss_bytes,
        );
    }
    if let Some(services) = crate::headless::headless_services() {
        push_metric(
            &mut out,
            "cognia_sidecar_restarts_total",
            "counter",
            "Sidecar spawns since boot.",
            services.sidecar.restart_count(),
        );
    }
    out
}

/// `GET /metrics` — Prometheus text format v0.0.4.
pub async fn metrics_handler() -> Response {
    (
        [(axum::http::header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        render_prometheus(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposition_carries_the_core_series_and_reacts_to_counters() {
        init();
        let before = render_prometheus();
        assert!(before.contains("cognia_uptime_seconds"));
        assert!(before.contains("# TYPE cognia_rpc_calls_total counter"));
        assert!(before.contains("cognia_auth_failures_total"));
        assert!(before.contains("cognia_ws_clients_active"));

        record_rpc_call(true);
        record_rpc_call(false);
        record_auth_failure();
        ws_client_connected();
        let after = render_prometheus();

        let value = |text: &str, name: &str| -> u64 {
            text.lines()
                .find(|l| l.starts_with(name) && !l.starts_with('#'))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|v| v.parse().ok())
                .unwrap_or(0)
        };
        assert!(value(&after, "cognia_rpc_calls_total") >= value(&before, "cognia_rpc_calls_total") + 2);
        assert!(value(&after, "cognia_rpc_errors_total") >= 1);
        assert!(value(&after, "cognia_auth_failures_total") >= 1);
        ws_client_disconnected();
    }
}
