//! Remote Control subsystem.
//!
//! See `docs/content/docs/adr/0005-remote-control.md` (and the renderer-side
//! types under `types/remote-control/`) for the full design. The summary:
//!
//!   - **Inbound**: an axum HTTP server on 127.0.0.1 that lets external
//!     systems trigger scheduler tasks or fire scheduler events through
//!     authenticated POSTs. Bearer token + IP allowlist + body-size limit
//!     + rate limit. Off by default.
//!   - **Outbound**: HMAC signing + custom headers for the existing
//!     scheduler webhook channel. The actual send pipeline lives in
//!     `lib/scheduler/notification-integration.ts`; this module owns the
//!     keyring-backed signing secret + custom-headers config.
//!
//! Module entry point: `RemoteControlState`. The Tauri commands in
//! `commands.rs` operate on this state behind a `tauri::State<>`.

pub mod allowlist;
pub mod commands;
pub mod idempotency;
pub mod keyring;
pub mod rate_limit;
pub mod server;
pub mod spec_parity;
pub mod types;

use std::collections::HashMap;
use std::sync::Arc;

use chrono::Utc;
use parking_lot::Mutex;
use tauri::AppHandle;
use tokio::sync::oneshot;

use server::{RequestObserver, ServerHandle};
use types::{RemoteControlConfig, RemoteControlError, RemoteControlStatus};

/// Pending GET read round-trips keyed by request id. A read handler registers a
/// oneshot before emitting `remote-control://query`; `remote_control_query_response`
/// resolves it with the renderer's Dexie read. Entries the renderer never
/// answers are dropped on timeout. Mirrors `gateway::DecisionRegistry`.
pub type QueryRegistry = Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>;

/// Snapshot pushed into the renderer-side ring buffer. Keep field names in
/// the same camelCase shape as `types/remote-control/index.ts`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundCallEntry {
    pub id: String,
    pub at: String,
    pub route: String,
    pub status: u16,
    pub remote_ip: String,
}

pub struct RemoteControlState {
    inner: Mutex<RemoteControlInner>,
    /// In-flight GET read round-trips (server ⇄ renderer). Shared with the
    /// running server via an `Arc` so a push from `remote_control_query_response`
    /// resolves the waiting handler without a restart.
    queries: Arc<QueryRegistry>,
}

struct RemoteControlInner {
    config: RemoteControlConfig,
    status: RemoteControlStatus,
    server: Option<ServerHandle>,
}

impl RemoteControlState {
    pub fn new() -> Self {
        let mut config = RemoteControlConfig::default();
        // Reflect any token already in the keyring — `enabled` may be true but
        // the listener is started later in lib.rs's setup hook.
        let has_token = matches!(keyring::read_token(), Ok(Some(_)));
        if !has_token {
            config.inbound.enabled = false;
        }
        let has_signing_secret = matches!(keyring::read_signing_secret(), Ok(Some(_)));
        config.outbound.has_signing_secret = has_signing_secret;
        let status = RemoteControlStatus {
            has_inbound_token: has_token,
            ..Default::default()
        };
        Self {
            inner: Mutex::new(RemoteControlInner {
                config,
                status,
                server: None,
            }),
            queries: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Resolve a pending GET read round-trip (called by
    /// `remote_control_query_response`). Unknown / already-timed-out request ids
    /// are a silent no-op.
    pub fn resolve_query(&self, request_id: &str, payload: serde_json::Value) {
        if let Some(tx) = self.queries.lock().remove(request_id) {
            let _ = tx.send(payload);
        }
    }

    pub fn config(&self) -> RemoteControlConfig {
        self.inner.lock().config.clone()
    }

    pub fn status(&self) -> RemoteControlStatus {
        self.inner.lock().status.clone()
    }

    pub fn update_config(&self, next: RemoteControlConfig) {
        let mut inner = self.inner.lock();
        // Preserve the live `has_signing_secret` flag — only the keyring
        // setter can toggle it. This stops a renderer mutation from lying
        // about whether a secret is set.
        let preserved_has_secret = inner.config.outbound.has_signing_secret;
        inner.config = next;
        inner.config.outbound.has_signing_secret = preserved_has_secret;
        // If the server is running and the rate limit changed, push it down
        // to the live limiter without restarting the listener.
        // (Port + allowlist changes still require a stop/start cycle, which
        // the Tauri commands orchestrate.)
        // No-op for now — the limiter clones into the server on spawn.
    }

    pub fn record_token_presence(&self, has_token: bool) {
        let mut inner = self.inner.lock();
        inner.status.has_inbound_token = has_token;
        if !has_token {
            inner.config.inbound.enabled = false;
        }
    }

    pub fn record_signing_secret_presence(&self, has_secret: bool) {
        let mut inner = self.inner.lock();
        inner.config.outbound.has_signing_secret = has_secret;
    }

    pub async fn start(&self, app_handle: AppHandle) -> Result<(), RemoteControlError> {
        let token = keyring::read_token()
            .map_err(RemoteControlError::Keyring)?
            .ok_or(RemoteControlError::TokenMissing)?;

        let (port, allowlist, rate_limit, capability, allow_sensitive_targets, disabled_targets) = {
            let inner = self.inner.lock();
            if inner.server.is_some() {
                return Err(RemoteControlError::AlreadyRunning(
                    inner.status.bound_port.unwrap_or(0),
                ));
            }
            (
                inner.config.inbound.port,
                inner.config.inbound.allowlist.clone(),
                inner.config.inbound.rate_limit_per_min,
                inner.config.inbound.capability,
                inner.config.inbound.allow_sensitive_targets,
                inner.config.inbound.disabled_targets.clone(),
            )
        };

        let observer: Arc<dyn RequestObserver> = Arc::new(StateObserver {
            app_handle: app_handle.clone(),
            state: self_arc_for(self),
        });

        let handle = server::spawn_server(
            app_handle,
            port,
            token,
            allowlist,
            rate_limit,
            capability,
            allow_sensitive_targets,
            disabled_targets,
            self.queries.clone(),
            observer,
        )
        .await?;

        let mut inner = self.inner.lock();
        inner.status.inbound_running = true;
        inner.status.bound_port = Some(handle.bound_port);
        inner.config.inbound.enabled = true;
        inner.server = Some(handle);
        Ok(())
    }

    pub fn stop(&self) -> Result<(), RemoteControlError> {
        let mut inner = self.inner.lock();
        let Some(handle) = inner.server.take() else {
            return Err(RemoteControlError::NotRunning);
        };
        // Send the shutdown signal — axum's `with_graceful_shutdown` future
        // resolves when the watch sender fires.
        let _ = handle.shutdown.send(());
        inner.status.inbound_running = false;
        inner.status.bound_port = None;
        inner.config.inbound.enabled = false;
        Ok(())
    }

    /// Bump the call counter + last-call timestamp from the request observer.
    fn observe(
        &self,
        app_handle: &AppHandle,
        route: &str,
        status: u16,
        remote_ip: std::net::IpAddr,
    ) {
        let entry = InboundCallEntry {
            id: uuid::Uuid::new_v4().to_string(),
            at: Utc::now().to_rfc3339(),
            route: route.to_string(),
            status,
            remote_ip: remote_ip.to_string(),
        };
        {
            let mut inner = self.inner.lock();
            inner.status.inbound_calls_total = inner.status.inbound_calls_total.saturating_add(1);
            inner.status.last_call_at = Some(entry.at.clone());
        }
        // Push to the renderer ring buffer (best-effort — a missed event
        // just means the Overview tab is one entry behind).
        let _ = app_handle.emit("remote-control://inbound-call", entry);
    }
}

impl Default for RemoteControlState {
    fn default() -> Self {
        Self::new()
    }
}

/// `Arc<RemoteControlState>` proxy used by the request observer. We can't
/// easily share `&self` with the observer (which lives on the server side),
/// so we leak a static reference to the Tauri-managed state by going through
/// `AppHandle::state::<RemoteControlState>()` inside the observer at call
/// time — this helper just carries the resolution.
struct StateObserver {
    app_handle: AppHandle,
    state: SelfPtr,
}

/// Type-erased "I am a `&'static RemoteControlState`" handle. The state
/// itself is owned by Tauri's `manage()` for the entire process lifetime, so
/// holding a raw pointer to it for the duration of the server task is
/// sound. The `Send + Sync` impls reflect that the underlying
/// `RemoteControlState` is `Sync`.
#[derive(Clone)]
struct SelfPtr(*const RemoteControlState);
unsafe impl Send for SelfPtr {}
unsafe impl Sync for SelfPtr {}

fn self_arc_for(state: &RemoteControlState) -> SelfPtr {
    SelfPtr(state as *const _)
}

use tauri::Emitter;

impl RequestObserver for StateObserver {
    fn on_call(&self, route: &str, status: axum::http::StatusCode, remote_ip: std::net::IpAddr) {
        // SAFETY: the underlying `RemoteControlState` is owned by Tauri's
        // managed-state container for the entire process lifetime, so the
        // pointer stored at construction remains valid.
        let state: &RemoteControlState = unsafe { &*self.state.0 };
        state.observe(&self.app_handle, route, status.as_u16(), remote_ip);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_state_has_no_token() {
        // We can't depend on the OS keyring in unit tests, but we can verify
        // that `new()` doesn't panic and the defaults look sane on the path
        // where neither the token nor the signing secret exists (or where
        // the keyring read fails, which both map to `None`).
        let state = RemoteControlState::new();
        let cfg = state.config();
        let status = state.status();
        assert_eq!(cfg.inbound.port, 47821);
        assert!(!status.inbound_running);
    }

    #[test]
    fn record_token_presence_clears_enabled_when_missing() {
        let state = RemoteControlState::new();
        // simulate a renderer that flipped `enabled` true via `update_config`
        let mut cfg = state.config();
        cfg.inbound.enabled = true;
        state.update_config(cfg);
        state.record_token_presence(false);
        assert!(!state.config().inbound.enabled);
        assert!(!state.status().has_inbound_token);
    }

    #[test]
    fn update_config_preserves_secret_flag() {
        let state = RemoteControlState::new();
        state.record_signing_secret_presence(true);
        let mut cfg = state.config();
        // a malicious / mistaken renderer tries to clear the flag
        cfg.outbound.has_signing_secret = false;
        cfg.inbound.port = 50000;
        state.update_config(cfg);
        // port change applies, but the secret flag is governed by keyring.
        assert_eq!(state.config().inbound.port, 50000);
        assert!(state.config().outbound.has_signing_secret);
    }

    #[test]
    fn stop_without_running_returns_not_running() {
        let state = RemoteControlState::new();
        let err = state.stop().unwrap_err();
        assert!(matches!(err, RemoteControlError::NotRunning));
    }

    #[tokio::test]
    async fn resolve_query_delivers_to_the_waiting_oneshot() {
        let state = RemoteControlState::new();
        let (tx, rx) = oneshot::channel();
        state.queries.lock().insert("rcq-1".into(), tx);
        state.resolve_query("rcq-1", serde_json::json!({ "tasks": [] }));
        let got = rx.await.unwrap();
        assert_eq!(got, serde_json::json!({ "tasks": [] }));
        // The entry was removed from the registry.
        assert!(state.queries.lock().is_empty());
    }

    #[test]
    fn resolve_query_for_unknown_id_is_a_noop() {
        let state = RemoteControlState::new();
        state.resolve_query("never-registered", serde_json::json!(null)); // must not panic
    }
}
