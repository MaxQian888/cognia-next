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
        "cognia_ws_clients_active",
        "gauge",
        "Open /ws/v1/events client connections.",
        WS_CLIENTS_ACTIVE.load(Ordering::Relaxed).max(0),
    );

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
        assert!(
            value(&after, "cognia_rpc_calls_total") >= value(&before, "cognia_rpc_calls_total") + 2
        );
        assert!(value(&after, "cognia_rpc_errors_total") >= 1);
        assert!(value(&after, "cognia_auth_failures_total") >= 1);
        ws_client_disconnected();
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
