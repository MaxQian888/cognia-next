//! Prometheus text exposition for the companion front door (ADR-0059 D9).
//!
//! Same hand-rolled pattern as `services/{signaling,share}-server/src/
//! metrics.rs` — no client-library dependency, atomics + a render function.
//! Served at operator-gated `GET /metrics`; the payload reveals
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
static DPOP_REJECTIONS_TOTAL: AtomicU64 = AtomicU64::new(0);
static DPOP_REPLAYS_TOTAL: AtomicU64 = AtomicU64::new(0);
static WS_CLIENTS_ACTIVE: AtomicI64 = AtomicI64::new(0);

const RPC_DURATION_BUCKETS_SECONDS: [f64; 8] = [0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 10.0];

struct RpcPlaneMetrics {
    completed: AtomicU64,
    accepted: AtomicU64,
    errors: AtomicU64,
    saturated: AtomicU64,
    in_flight: AtomicI64,
    duration_buckets: [AtomicU64; RPC_DURATION_BUCKETS_SECONDS.len() + 1],
    duration_count: AtomicU64,
    duration_sum_micros: AtomicU64,
}

impl Default for RpcPlaneMetrics {
    fn default() -> Self {
        Self {
            completed: AtomicU64::new(0),
            accepted: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            saturated: AtomicU64::new(0),
            in_flight: AtomicI64::new(0),
            duration_buckets: std::array::from_fn(|_| AtomicU64::new(0)),
            duration_count: AtomicU64::new(0),
            duration_sum_micros: AtomicU64::new(0),
        }
    }
}

static PUBLIC_RPC_METRICS: Lazy<RpcPlaneMetrics> = Lazy::new(RpcPlaneMetrics::default);
static INTERNAL_RPC_METRICS: Lazy<RpcPlaneMetrics> = Lazy::new(RpcPlaneMetrics::default);
static OPERATIONS_ACCEPTED_TOTAL: AtomicU64 = AtomicU64::new(0);
static OPERATIONS_COMPLETED_TOTAL: AtomicU64 = AtomicU64::new(0);
static OPERATIONS_REPLAYED_TOTAL: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RpcPlane {
    Public,
    Internal,
}

impl RpcPlane {
    fn label(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Internal => "internal",
        }
    }

    fn metrics(self) -> &'static RpcPlaneMetrics {
        match self {
            Self::Public => &PUBLIC_RPC_METRICS,
            Self::Internal => &INTERNAL_RPC_METRICS,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RpcOutcome {
    Completed,
    Accepted,
    Error { saturated: bool },
}

pub struct RpcObservation {
    plane: RpcPlane,
    started_at: Instant,
    finished: bool,
}

impl RpcObservation {
    pub fn start(plane: RpcPlane) -> Self {
        plane.metrics().in_flight.fetch_add(1, Ordering::Relaxed);
        Self {
            plane,
            started_at: Instant::now(),
            finished: false,
        }
    }

    pub fn finish(mut self, outcome: RpcOutcome) {
        self.record(outcome);
        self.finished = true;
    }

    fn record(&self, outcome: RpcOutcome) {
        let metrics = self.plane.metrics();
        metrics.in_flight.fetch_sub(1, Ordering::Relaxed);
        match outcome {
            RpcOutcome::Completed => {
                metrics.completed.fetch_add(1, Ordering::Relaxed);
            }
            RpcOutcome::Accepted => {
                metrics.accepted.fetch_add(1, Ordering::Relaxed);
            }
            RpcOutcome::Error { saturated } => {
                metrics.errors.fetch_add(1, Ordering::Relaxed);
                if saturated {
                    metrics.saturated.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        let elapsed = self.started_at.elapsed();
        let elapsed_seconds = elapsed.as_secs_f64();
        for (index, boundary) in RPC_DURATION_BUCKETS_SECONDS.iter().enumerate() {
            if elapsed_seconds <= *boundary {
                metrics.duration_buckets[index].fetch_add(1, Ordering::Relaxed);
            }
        }
        metrics.duration_buckets[RPC_DURATION_BUCKETS_SECONDS.len()]
            .fetch_add(1, Ordering::Relaxed);
        metrics.duration_count.fetch_add(1, Ordering::Relaxed);
        metrics.duration_sum_micros.fetch_add(
            elapsed.as_micros().min(u64::MAX as u128) as u64,
            Ordering::Relaxed,
        );
    }
}

impl Drop for RpcObservation {
    fn drop(&mut self) {
        if !self.finished {
            self.record(RpcOutcome::Error { saturated: false });
            self.finished = true;
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationOutcome {
    Accepted,
    Completed,
    Replayed,
}

pub fn record_operation(outcome: OperationOutcome) {
    let counter = match outcome {
        OperationOutcome::Accepted => &OPERATIONS_ACCEPTED_TOTAL,
        OperationOutcome::Completed => &OPERATIONS_COMPLETED_TOTAL,
        OperationOutcome::Replayed => &OPERATIONS_REPLAYED_TOTAL,
    };
    counter.fetch_add(1, Ordering::Relaxed);
}

// ── Lark dual-entry counters (plan 2026-07-24 P6.2) ─────────────────────────
// Bumped by the `/integrations/lark/*` handlers directly and by the brain via
// the `lark_metrics_record` RPC arm (hardcoded name allowlist below — the
// brain cannot mint arbitrary series).
static LARK_SSO_LOGINS_TOTAL: AtomicU64 = AtomicU64::new(0);
static LARK_SSO_FAILURES_TOTAL: AtomicU64 = AtomicU64::new(0);
static LARK_ENTRY_RESOLVE_OK_TOTAL: AtomicU64 = AtomicU64::new(0);
static LARK_ENTRY_RESOLVE_DENIED_TOTAL: AtomicU64 = AtomicU64::new(0);
static LARK_PRINCIPAL_UNBOUND_TOTAL: AtomicU64 = AtomicU64::new(0);
static LARK_CALLBACK_AUTH_DENIED_TOTAL: AtomicU64 = AtomicU64::new(0);
static LARK_CHAT_TAB_SYNC_FAILURES_TOTAL: AtomicU64 = AtomicU64::new(0);
static LARK_NATIVE_SLASH_TOTAL: AtomicU64 = AtomicU64::new(0);
static LARK_MESSAGE_IMPORTS_TOTAL: AtomicU64 = AtomicU64::new(0);
static LARK_MESSAGE_IMPORT_DENIED_TOTAL: AtomicU64 = AtomicU64::new(0);
static LARK_GROUP_MENU_SYNC_FAILURES_TOTAL: AtomicU64 = AtomicU64::new(0);
static LARK_PLUS_CREATE_TOTAL: AtomicU64 = AtomicU64::new(0);
static LARK_PLUS_CREATE_DENIED_TOTAL: AtomicU64 = AtomicU64::new(0);
static LARK_CALLBACK_AUTH_WOULD_DENY_TOTAL: AtomicU64 = AtomicU64::new(0);
static LARK_INBOUND_RATE_LIMITED_TOTAL: AtomicU64 = AtomicU64::new(0);

/// Bump one Lark counter by its exposition name (without the `cognia_`
/// prefix). Returns `false` for unknown names so the RPC arm can reject them.
pub fn record_lark_counter(name: &str) -> bool {
    let counter = match name {
        "lark_sso_logins_total" => &LARK_SSO_LOGINS_TOTAL,
        "lark_sso_failures_total" => &LARK_SSO_FAILURES_TOTAL,
        "lark_entry_resolve_ok_total" => &LARK_ENTRY_RESOLVE_OK_TOTAL,
        "lark_entry_resolve_denied_total" => &LARK_ENTRY_RESOLVE_DENIED_TOTAL,
        "lark_principal_unbound_total" => &LARK_PRINCIPAL_UNBOUND_TOTAL,
        "lark_callback_auth_denied_total" => &LARK_CALLBACK_AUTH_DENIED_TOTAL,
        "lark_chat_tab_sync_failures_total" => &LARK_CHAT_TAB_SYNC_FAILURES_TOTAL,
        "lark_native_slash_total" => &LARK_NATIVE_SLASH_TOTAL,
        "lark_message_imports_total" => &LARK_MESSAGE_IMPORTS_TOTAL,
        "lark_message_import_denied_total" => &LARK_MESSAGE_IMPORT_DENIED_TOTAL,
        "lark_group_menu_sync_failures_total" => &LARK_GROUP_MENU_SYNC_FAILURES_TOTAL,
        "lark_plus_create_total" => &LARK_PLUS_CREATE_TOTAL,
        "lark_plus_create_denied_total" => &LARK_PLUS_CREATE_DENIED_TOTAL,
        "lark_callback_auth_would_deny_total" => &LARK_CALLBACK_AUTH_WOULD_DENY_TOTAL,
        "lark_inbound_rate_limited_total" => &LARK_INBOUND_RATE_LIMITED_TOTAL,
        _ => return false,
    };
    counter.fetch_add(1, Ordering::Relaxed);
    true
}

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

pub fn record_dpop_replay() {
    DPOP_REPLAYS_TOTAL.fetch_add(1, Ordering::Relaxed);
}

pub fn record_dpop_rejection() {
    DPOP_REJECTIONS_TOTAL.fetch_add(1, Ordering::Relaxed);
}

pub fn ws_client_connected() {
    WS_CLIENTS_ACTIVE.fetch_add(1, Ordering::Relaxed);
}

pub fn ws_client_disconnected() {
    WS_CLIENTS_ACTIVE.fetch_sub(1, Ordering::Relaxed);
}

fn push_metric(
    out: &mut String,
    name: &str,
    kind: &str,
    help: &str,
    value: impl std::fmt::Display,
) {
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
        "cognia_dpop_rejections_total",
        "counter",
        "Rejected DPoP proofs with invalid signatures, expiry, or request bindings.",
        DPOP_REJECTIONS_TOTAL.load(Ordering::Relaxed),
    );
    push_metric(
        &mut out,
        "cognia_dpop_replays_total",
        "counter",
        "Rejected DPoP proofs whose jti was already consumed.",
        DPOP_REPLAYS_TOTAL.load(Ordering::Relaxed),
    );
    push_metric(
        &mut out,
        "cognia_ws_clients_active",
        "gauge",
        "Open /ws/events client connections.",
        WS_CLIENTS_ACTIVE.load(Ordering::Relaxed).max(0),
    );

    out.push_str("# HELP cognia_rpc_requests_total Canonical RPC requests by plane and outcome.\n");
    out.push_str("# TYPE cognia_rpc_requests_total counter\n");
    out.push_str(
        "# HELP cognia_rpc_saturated_total RPC requests rejected by rate or capacity limits.\n",
    );
    out.push_str("# TYPE cognia_rpc_saturated_total counter\n");
    out.push_str("# HELP cognia_rpc_in_flight RPC requests currently executing.\n");
    out.push_str("# TYPE cognia_rpc_in_flight gauge\n");
    out.push_str("# HELP cognia_rpc_duration_seconds Canonical RPC request latency.\n");
    out.push_str("# TYPE cognia_rpc_duration_seconds histogram\n");
    for plane in [RpcPlane::Public, RpcPlane::Internal] {
        let label = plane.label();
        let metrics = plane.metrics();
        for (outcome, counter) in [
            ("completed", &metrics.completed),
            ("accepted", &metrics.accepted),
            ("error", &metrics.errors),
        ] {
            out.push_str(&format!(
                "cognia_rpc_requests_total{{plane=\"{label}\",outcome=\"{outcome}\"}} {}\n",
                counter.load(Ordering::Relaxed)
            ));
        }
        out.push_str(&format!(
            "cognia_rpc_saturated_total{{plane=\"{label}\"}} {}\n",
            metrics.saturated.load(Ordering::Relaxed)
        ));
        out.push_str(&format!(
            "cognia_rpc_in_flight{{plane=\"{label}\"}} {}\n",
            metrics.in_flight.load(Ordering::Relaxed).max(0)
        ));
        for (index, boundary) in RPC_DURATION_BUCKETS_SECONDS.iter().enumerate() {
            out.push_str(&format!(
                "cognia_rpc_duration_seconds_bucket{{plane=\"{label}\",le=\"{boundary}\"}} {}\n",
                metrics.duration_buckets[index].load(Ordering::Relaxed)
            ));
        }
        out.push_str(&format!(
            "cognia_rpc_duration_seconds_bucket{{plane=\"{label}\",le=\"+Inf\"}} {}\n",
            metrics.duration_buckets[RPC_DURATION_BUCKETS_SECONDS.len()].load(Ordering::Relaxed)
        ));
        out.push_str(&format!(
            "cognia_rpc_duration_seconds_sum{{plane=\"{label}\"}} {:.6}\n",
            metrics.duration_sum_micros.load(Ordering::Relaxed) as f64 / 1_000_000.0
        ));
        out.push_str(&format!(
            "cognia_rpc_duration_seconds_count{{plane=\"{label}\"}} {}\n",
            metrics.duration_count.load(Ordering::Relaxed)
        ));
    }
    out.push_str("# HELP cognia_rpc_operations_total Durable operation lifecycle outcomes.\n");
    out.push_str("# TYPE cognia_rpc_operations_total counter\n");
    for (outcome, counter) in [
        ("accepted", &OPERATIONS_ACCEPTED_TOTAL),
        ("completed", &OPERATIONS_COMPLETED_TOTAL),
        ("replayed", &OPERATIONS_REPLAYED_TOTAL),
    ] {
        out.push_str(&format!(
            "cognia_rpc_operations_total{{outcome=\"{outcome}\"}} {}\n",
            counter.load(Ordering::Relaxed)
        ));
    }

    // Lark dual-entry counters (plan 2026-07-24 P6.2).
    let lark_series: &[(&str, &AtomicU64, &str)] = &[
        (
            "cognia_lark_sso_logins_total",
            &LARK_SSO_LOGINS_TOTAL,
            "Successful Lark web SSO callbacks (session issued).",
        ),
        (
            "cognia_lark_sso_failures_total",
            &LARK_SSO_FAILURES_TOTAL,
            "Lark web SSO failures (invalid state, exchange errors).",
        ),
        (
            "cognia_lark_entry_resolve_ok_total",
            &LARK_ENTRY_RESOLVE_OK_TOTAL,
            "Entry-context tokens resolved successfully.",
        ),
        (
            "cognia_lark_entry_resolve_denied_total",
            &LARK_ENTRY_RESOLVE_DENIED_TOTAL,
            "Entry-context resolutions denied (expired/replayed/forbidden).",
        ),
        (
            "cognia_lark_principal_unbound_total",
            &LARK_PRINCIPAL_UNBOUND_TOTAL,
            "Inbound Lark events rejected because the sender is unbound.",
        ),
        (
            "cognia_lark_callback_auth_denied_total",
            &LARK_CALLBACK_AUTH_DENIED_TOTAL,
            "Connector callbacks denied by the authorization guard.",
        ),
        (
            "cognia_lark_chat_tab_sync_failures_total",
            &LARK_CHAT_TAB_SYNC_FAILURES_TOTAL,
            "Chat Tab reconcile attempts that ended in error.",
        ),
        (
            "cognia_lark_native_slash_total",
            &LARK_NATIVE_SLASH_TOTAL,
            "Native Lark slash-command events dispatched.",
        ),
        (
            "cognia_lark_message_imports_total",
            &LARK_MESSAGE_IMPORTS_TOTAL,
            "Message-shortcut imports completed.",
        ),
        (
            "cognia_lark_message_import_denied_total",
            &LARK_MESSAGE_IMPORT_DENIED_TOTAL,
            "Message-shortcut imports denied (permission/limit).",
        ),
        (
            "cognia_lark_group_menu_sync_failures_total",
            &LARK_GROUP_MENU_SYNC_FAILURES_TOTAL,
            "Group-menu reconcile attempts that ended in error.",
        ),
        (
            "cognia_lark_plus_create_total",
            &LARK_PLUS_CREATE_TOTAL,
            "Sessions created from the chat input-box `+` menu.",
        ),
        (
            "cognia_lark_plus_create_denied_total",
            &LARK_PLUS_CREATE_DENIED_TOTAL,
            "`+`-menu create intents denied (flag/principal/membership).",
        ),
        (
            "cognia_lark_callback_auth_would_deny_total",
            &LARK_CALLBACK_AUTH_WOULD_DENY_TOTAL,
            "Callbacks the guard WOULD deny in audit mode (gray-release signal).",
        ),
        (
            "cognia_lark_inbound_rate_limited_total",
            &LARK_INBOUND_RATE_LIMITED_TOTAL,
            "Inbound events dropped by a user/channel/tenant rate-limit bucket.",
        ),
    ];
    for (name, counter, help) in lark_series {
        push_metric(
            &mut out,
            name,
            "counter",
            help,
            counter.load(Ordering::Relaxed),
        );
    }

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
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; version=0.0.4",
        )],
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
        assert!(before.contains("cognia_dpop_replays_total"));
        assert!(before.contains("cognia_dpop_rejections_total"));
        assert!(before.contains("cognia_ws_clients_active"));

        record_rpc_call(true);
        record_rpc_call(false);
        record_auth_failure();
        record_dpop_replay();
        record_dpop_rejection();
        ws_client_connected();
        let after = render_prometheus();

        let value = |text: &str, name: &str| -> u64 {
            text.lines()
                .find(|l| l.starts_with(name) && !l.starts_with('#'))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|v| v.parse().ok())
                .unwrap_or(0)
        };
        assert!(
            value(&after, "cognia_rpc_calls_total") >= value(&before, "cognia_rpc_calls_total") + 2
        );
        assert!(value(&after, "cognia_rpc_errors_total") >= 1);
        assert!(value(&after, "cognia_auth_failures_total") >= 1);
        assert!(value(&after, "cognia_dpop_replays_total") >= 1);
        assert!(value(&after, "cognia_dpop_rejections_total") >= 1);
        ws_client_disconnected();
    }

    #[test]
    fn rpc_observations_publish_bounded_plane_outcome_and_latency_metrics() {
        let before = render_prometheus();
        RpcObservation::start(RpcPlane::Internal).finish(RpcOutcome::Completed);
        RpcObservation::start(RpcPlane::Public).finish(RpcOutcome::Error { saturated: true });
        let after = render_prometheus();

        assert!(
            after.contains("cognia_rpc_requests_total{plane=\"internal\",outcome=\"completed\"}")
        );
        assert!(after.contains("cognia_rpc_requests_total{plane=\"public\",outcome=\"error\"}"));
        assert!(after.contains("cognia_rpc_saturated_total{plane=\"public\"}"));
        assert!(
            after.contains("cognia_rpc_duration_seconds_bucket{plane=\"internal\",le=\"+Inf\"}")
        );
        assert!(after.contains("cognia_rpc_in_flight{plane=\"internal\"} 0"));
        assert!(!after.contains("command="));
        assert_ne!(before, after);
    }

    #[test]
    fn durable_operation_metrics_distinguish_accept_complete_and_replay() {
        let before = render_prometheus();
        record_operation(OperationOutcome::Accepted);
        record_operation(OperationOutcome::Completed);
        record_operation(OperationOutcome::Replayed);
        let after = render_prometheus();

        for outcome in ["accepted", "completed", "replayed"] {
            assert!(after.contains(&format!(
                "cognia_rpc_operations_total{{outcome=\"{outcome}\"}}"
            )));
        }
        assert_ne!(before, after);
    }

    #[test]
    fn lark_counters_are_allowlisted_and_exposed() {
        // Unknown names are rejected — the brain cannot mint new series.
        assert!(!record_lark_counter("lark_made_up_total"));
        assert!(!record_lark_counter("rpc_calls_total"));

        assert!(record_lark_counter("lark_sso_logins_total"));
        assert!(record_lark_counter("lark_entry_resolve_denied_total"));
        let text = render_prometheus();
        for name in [
            "cognia_lark_sso_logins_total",
            "cognia_lark_sso_failures_total",
            "cognia_lark_entry_resolve_ok_total",
            "cognia_lark_entry_resolve_denied_total",
            "cognia_lark_principal_unbound_total",
            "cognia_lark_callback_auth_denied_total",
            "cognia_lark_chat_tab_sync_failures_total",
            "cognia_lark_native_slash_total",
            "cognia_lark_message_imports_total",
            "cognia_lark_message_import_denied_total",
        ] {
            assert!(text.contains(name), "missing series {name}");
        }
    }
}
