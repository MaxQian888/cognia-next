//! Inbound LLM Gateway subsystem (ADR-0043 M3).
//!
//! A local axum HTTP server that exposes OpenAI- and Anthropic-compatible
//! chat endpoints backed by the user's configured providers + the renderer's
//! routing decisions. External tools (Claude Code CLI, any OpenAI client)
//! point their base URL at `http://127.0.0.1:<port>` and borrow Cognia's
//! credentials, routing, and reliability telemetry.
//!
//! Layout:
//!   - `server`   — axum routes + middleware (clones the remote-control
//!                  hardening: loopback Host, no Origin/Referer, IPv4
//!                  allowlist, constant-time bearer, rate limit).
//!   - `execute`  — candidate resolution + upstream request plumbing.
//!   - `translate`— inbound-format ⇄ upstream-protocol translation via a
//!                  canonical IR (N+M, not N×M).
//!   - `snapshot` — the routing + credential snapshot pushed by the renderer.
//!   - `keyring`  — OS-keyring-backed bearer token.
//!
//! `GatewayState` is the Tauri-managed entry point; the commands in
//! `commands.rs` operate on it behind a `tauri::State<>`.

pub mod commands;
pub mod execute;
pub mod keyring;
pub mod server;
pub mod snapshot;
pub mod translate;
pub mod types;

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use tauri::AppHandle;
use tokio::sync::oneshot;

use server::{RequestObserver, ServerHandle};
use snapshot::{RoutingSnapshot, SnapshotEntry};
use types::{GatewayConfig, GatewayError, GatewayStatus};

/// Pending live-routing decisions keyed by request id. The server registers a
/// oneshot before emitting `gateway://decide`; `gateway_decision_response`
/// resolves it. Entries the renderer never answers are dropped on timeout.
pub type DecisionRegistry = Mutex<HashMap<String, oneshot::Sender<Vec<SnapshotEntry>>>>;

pub struct GatewayState {
    inner: Mutex<GatewayInner>,
    /// The last routing+credential snapshot pushed by the renderer. Shared
    /// with the running server (read on every request) via an `Arc<RwLock>`
    /// so a push updates the live server without a restart. Keys live here
    /// in memory only — never persisted, never logged.
    snapshot: Arc<RwLock<Option<RoutingSnapshot>>>,
    /// In-flight live-decision round-trips (server ⇄ renderer).
    decisions: Arc<DecisionRegistry>,
}

struct GatewayInner {
    config: GatewayConfig,
    status: GatewayStatus,
    server: Option<ServerHandle>,
}

impl GatewayState {
    pub fn new() -> Self {
        let mut config = GatewayConfig::default();
        let has_token = matches!(keyring::read_token(), Ok(Some(_)));
        if !has_token {
            config.enabled = false;
        }
        let status = GatewayStatus {
            has_token,
            ..Default::default()
        };
        Self {
            inner: Mutex::new(GatewayInner {
                config,
                status,
                server: None,
            }),
            snapshot: Arc::new(RwLock::new(None)),
            decisions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Resolve a pending decision (called by `gateway_decision_response`).
    /// Unknown / already-timed-out request ids are a silent no-op.
    pub fn resolve_decision(&self, request_id: &str, entries: Vec<SnapshotEntry>) {
        if let Some(tx) = self.decisions.lock().remove(request_id) {
            let _ = tx.send(entries);
        }
    }

    pub fn config(&self) -> GatewayConfig {
        self.inner.lock().config.clone()
    }

    pub fn status(&self) -> GatewayStatus {
        self.inner.lock().status.clone()
    }

    pub fn update_config(&self, next: GatewayConfig) -> Result<(), GatewayError> {
        if let Err(error) = next.validate() {
            log::warn!("gateway config rejected: {error}");
            return Err(error);
        }
        self.inner.lock().config = next;
        Ok(())
    }

    pub fn record_token_presence(&self, has_token: bool) {
        let mut inner = self.inner.lock();
        inner.status.has_token = has_token;
        if !has_token {
            inner.config.enabled = false;
        }
    }

    /// Replace the live routing snapshot. Updates the status counters so the
    /// settings UI can show staleness.
    pub fn set_snapshot(&self, snapshot: RoutingSnapshot) {
        let provider_count = snapshot.providers.iter().filter(|p| p.enabled).count() as u32;
        let alias_count = snapshot.aliases.len() as u32;
        let generated_at = snapshot.generated_at_ms;
        *self.snapshot.write() = Some(snapshot);
        let mut inner = self.inner.lock();
        inner.status.snapshot_generated_at_ms = Some(generated_at);
        inner.status.snapshot_provider_count = provider_count;
        inner.status.snapshot_alias_count = alias_count;
    }

    pub async fn start(&self, app_handle: AppHandle) -> Result<(), GatewayError> {
        let token = keyring::read_token()
            .map_err(GatewayError::Keyring)?
            .ok_or(GatewayError::TokenMissing)?;

        let (port, allowlist, rate_limit) = {
            let inner = self.inner.lock();
            if inner.server.is_some() {
                return Err(GatewayError::AlreadyRunning(
                    inner.status.bound_port.unwrap_or(0),
                ));
            }
            (
                inner.config.port,
                inner.config.allowlist.clone(),
                inner.config.rate_limit_per_min,
            )
        };

        let observer: Arc<dyn RequestObserver> = Arc::new(StateObserver {
            app_handle: app_handle.clone(),
            state: SelfPtr(self as *const _),
        });

        let handle = server::spawn_server(
            app_handle,
            port,
            token,
            allowlist,
            rate_limit,
            self.snapshot.clone(),
            self.decisions.clone(),
            observer,
        )
        .await?;

        let mut inner = self.inner.lock();
        inner.status.running = true;
        inner.status.bound_port = Some(handle.bound_port);
        inner.config.enabled = true;
        inner.server = Some(handle);
        Ok(())
    }

    pub fn stop(&self) -> Result<(), GatewayError> {
        let mut inner = self.inner.lock();
        let Some(handle) = inner.server.take() else {
            return Err(GatewayError::NotRunning);
        };
        let _ = handle.shutdown.send(());
        inner.status.running = false;
        inner.status.bound_port = None;
        inner.config.enabled = false;
        Ok(())
    }

    /// Bump the call counter + last-call timestamp from the request observer.
    fn observe(&self, route: &str, status: u16, remote_ip: std::net::IpAddr) {
        let mut inner = self.inner.lock();
        inner.status.calls_total = inner.status.calls_total.saturating_add(1);
        inner.status.last_call_at = Some(chrono::Utc::now().to_rfc3339());
        drop(inner);
        // The renderer ring buffer (Overview tab) is fed by the server's own
        // `gateway://inbound-call` emit; this counter is the durable status.
        let _ = (route, status, remote_ip);
    }
}

impl Default for GatewayState {
    fn default() -> Self {
        Self::new()
    }
}

/// Type-erased `&'static GatewayState` handle for the request observer. The
/// state is owned by Tauri's `manage()` for the entire process lifetime, so
/// holding a raw pointer for the server task's duration is sound. Mirrors
/// `remote_control::SelfPtr`.
#[derive(Clone)]
struct SelfPtr(*const GatewayState);
unsafe impl Send for SelfPtr {}
unsafe impl Sync for SelfPtr {}

struct StateObserver {
    app_handle: AppHandle,
    state: SelfPtr,
}

use tauri::Emitter;

impl RequestObserver for StateObserver {
    fn on_call(&self, route: &str, status: axum::http::StatusCode, remote_ip: std::net::IpAddr) {
        // SAFETY: the underlying `GatewayState` is owned by Tauri's managed-
        // state container for the entire process lifetime.
        let state: &GatewayState = unsafe { &*self.state.0 };
        state.observe(route, status.as_u16(), remote_ip);
        let entry = serde_json::json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "at": chrono::Utc::now().to_rfc3339(),
            "route": route,
            "status": status.as_u16(),
            "remoteIp": remote_ip.to_string(),
        });
        let _ = self.app_handle.emit(server::INBOUND_CALL_EVENT, entry);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_state_is_off_with_sane_defaults() {
        let state = GatewayState::new();
        let cfg = state.config();
        assert!(!cfg.enabled);
        assert_eq!(cfg.port, 47823);
        assert!(!state.status().running);
    }

    #[test]
    fn record_token_presence_clears_enabled_when_missing() {
        let state = GatewayState::new();
        let mut cfg = state.config();
        cfg.enabled = true;
        state.update_config(cfg).unwrap();
        state.record_token_presence(false);
        assert!(!state.config().enabled);
        assert!(!state.status().has_token);
    }

    #[test]
    fn set_snapshot_updates_status_counts() {
        let state = GatewayState::new();
        let snapshot: RoutingSnapshot = serde_json::from_value(serde_json::json!({
            "aliases": [{ "alias": "fast", "entries": [] }],
            "providers": [
                { "id": "a", "protocol": "openai", "baseUrl": "u", "enabled": true },
                { "id": "b", "protocol": "openai", "baseUrl": "u", "enabled": false }
            ],
            "generatedAtMs": 123
        }))
        .unwrap();
        state.set_snapshot(snapshot);
        let status = state.status();
        assert_eq!(status.snapshot_generated_at_ms, Some(123));
        assert_eq!(status.snapshot_provider_count, 1); // only enabled
        assert_eq!(status.snapshot_alias_count, 1);
    }

    #[test]
    fn update_config_rejects_invalid_config_and_preserves_previous_state() {
        let state = GatewayState::new();
        let original = state.config();
        let mut invalid = original.clone();
        invalid.allowlist = vec!["not-a-cidr".into()];

        let err = state.update_config(invalid).unwrap_err();

        assert!(err.to_string().contains("allowlist"));
        assert_eq!(state.config().allowlist, original.allowlist);
    }

    #[test]
    fn stop_without_running_returns_not_running() {
        let state = GatewayState::new();
        assert!(matches!(state.stop(), Err(GatewayError::NotRunning)));
    }

    #[tokio::test]
    async fn resolve_decision_delivers_to_the_waiting_oneshot() {
        let state = GatewayState::new();
        let (tx, rx) = oneshot::channel();
        state.decisions.lock().insert("req-1".into(), tx);
        let entries: Vec<SnapshotEntry> = serde_json::from_value(serde_json::json!([
            { "providerId": "groq", "modelId": "llama" }
        ]))
        .unwrap();
        state.resolve_decision("req-1", entries);
        let got = rx.await.unwrap();
        assert_eq!(got[0].provider_id, "groq");
        // The entry was removed from the registry.
        assert!(state.decisions.lock().is_empty());
    }

    #[test]
    fn resolve_decision_for_unknown_id_is_a_noop() {
        let state = GatewayState::new();
        state.resolve_decision("never-registered", vec![]); // must not panic
    }
}
