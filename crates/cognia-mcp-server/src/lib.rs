//! MCP HTTP server subsystem.
//!
//! Exposes the External Bridge MCP server over `127.0.0.1:<port>` with
//! bearer-token authentication.  The HTTP layer is a thin proxy: it verifies
//! the bearer token then forwards JSON-RPC requests to a long-lived Node
//! sidecar process (`cognia-mcp.js`) over stdin/stdout.
//!
//! # Architecture
//!
//! ```text
//! External Agent (Cursor / HTTP mode)
//!     │ POST http://127.0.0.1:<port>/mcp
//!     │ Authorization: Bearer <token>
//!     ▼
//! http_server.rs   (axum, bearer auth, body-size limit)
//!     │ verify token (subtle constant-time)
//!     ▼
//! sidecar.rs       (tokio::process, mutex-guarded stdin/stdout)
//!     │ persistent `node cognia-mcp.js` process
//!     ▼
//! standalone-entry.ts  (node, COGNIA_BRIDGED=1)
//!     ▼
//! server.ts        (McpServer SDK + Cognia handlers)
//! ```
//!
//! # Module layout
//!
//! - `types`       — wire-shape types and errors
//! - `sidecar`     — Node child-process lifecycle
//! - `http_server` — axum server spawn
//! - `commands`    — Tauri command entry points
//! - `mod` (here)  — `McpServerState` orchestrator

pub mod automation_proxy;
pub mod commands;
pub mod http_server;
pub mod orchestration_proxy;
pub mod proxy_common;
pub mod sidecar;
pub mod streamable_http;
pub mod types;

use std::sync::Arc;

use chrono::Utc;
use parking_lot::Mutex;
use tauri::AppHandle;

use automation_proxy::AutomationProxy;
use cognia_automation::automation::dispatcher::Enforcement;
use http_server::{spawn_server, ServerHandle};
use orchestration_proxy::{OrchestrationProxy, OrchestrationReply};
use sidecar::SidecarProcess;
use types::{ExternalBridgeSettings, McpServerError, McpServerStatus};

use cognia_automation::automation::worker::AutomationHandle;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// Application-managed state for the MCP HTTP server.
///
/// Owned by Tauri's `manage()` for the entire process lifetime.  Wraps a
/// `parking_lot::Mutex` so it can be shared across command handlers without
/// async overhead for the fast path (status reads, stop).
pub struct McpServerState {
    pub(crate) inner: Mutex<McpServerInner>,
}

/// Liveness snapshot of the MCP server's Node sidecar, consumed by the
/// unified managed-process registry (`src-tauri/src/process_registry`).
#[derive(Debug, Clone)]
pub struct McpManagedInfo {
    pub port: u16,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
}

pub(crate) struct McpServerInner {
    pub(crate) status: McpServerStatus,
    /// Running server handle + the sidecar process it talks to + the optional
    /// automation proxy + the optional orchestration proxy. Each proxy is
    /// `Some` only when start() was given the corresponding dependency
    /// (`AutomationHandle` / `AppHandle`); tests that build state manually
    /// (e.g. `start_stop_round_trip`) leave them `None`.
    pub(crate) server: Option<(
        ServerHandle,
        Arc<SidecarProcess>,
        Option<Arc<AutomationProxy>>,
        Option<Arc<OrchestrationProxy>>,
    )>,
}

impl McpServerState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(McpServerInner {
                status: McpServerStatus::default(),
                server: None,
            }),
        }
    }

    /// Snapshot of the current status (cheap — only clones scalars/strings).
    pub fn status(&self) -> McpServerStatus {
        self.inner.lock().status.clone()
    }

    /// Whether the HTTP listener is currently running.
    #[allow(dead_code)] // used by tests and future UI status polling
    pub fn is_running(&self) -> bool {
        self.inner.lock().server.is_some()
    }

    /// Liveness snapshot for the unified managed-process registry
    /// (`src-tauri/src/process_registry`). `None` when the server is stopped.
    /// The MCP server is surfaced as a single managed process — its Node
    /// sidecar — identified by the bound port; per-HTTP-session streaming
    /// children are transient (idle-reaped) and intentionally not listed.
    pub fn managed_snapshot(&self) -> Option<McpManagedInfo> {
        let inner = self.inner.lock();
        inner
            .server
            .as_ref()
            .map(|(handle, sidecar, ..)| McpManagedInfo {
                port: handle.bound_port,
                pid: sidecar.pid(),
                started_at: inner.status.started_at.clone(),
            })
    }

    // ── Start ────────────────────────────────────────────────────────────

    /// Spawn the sidecar + HTTP server and record the resulting handle.
    ///
    /// # Errors
    ///
    /// - [`McpServerError::AlreadyRunning`] if the server is already bound.
    /// - [`McpServerError::TokenMissing`] if `token` is empty.
    /// - [`McpServerError::InvalidSettings`] if `settings_json` is not valid
    ///   JSON matching `ExternalBridgeSettings`.
    /// - [`McpServerError::SidecarSpawn`] if `node <sidecar_path>` fails.
    /// - [`McpServerError::Bind`] if the TCP port cannot be bound.
    pub async fn start(
        &self,
        port: u16,
        token: String,
        settings_json: String,
        sidecar_path: String,
        automation: Option<(AutomationHandle, Enforcement)>,
        app_handle: Option<AppHandle>,
    ) -> Result<u16, McpServerError> {
        // Guard: reject empty token before attempting any I/O.
        if token.is_empty() {
            return Err(McpServerError::TokenMissing);
        }

        // Guard: enforce a minimum token strength. The renderer generates a
        // 64-hex-char CSPRNG token (`lib/external-bridge/token.ts`); rejecting
        // anything shorter stops a weak/guessable bearer from being the only
        // thing standing between a local process (or a DNS-rebinding page) and
        // the tool surface. 32 chars (≈128 bits if hex) is the floor.
        const MIN_TOKEN_LEN: usize = 32;
        if token.len() < MIN_TOKEN_LEN {
            return Err(McpServerError::TokenTooWeak(
                "bearer token must be at least 32 characters",
            ));
        }

        // Validate settings JSON early — we want a clear error, not a
        // cryptic sidecar crash on malformed env.
        let _settings: ExternalBridgeSettings = serde_json::from_str(&settings_json)
            .map_err(|e| McpServerError::InvalidSettings(format!("settings_json: {e}")))?;

        // Guard: reject if already running.
        {
            let inner = self.inner.lock();
            if let Some((handle, ..)) = &inner.server {
                return Err(McpServerError::AlreadyRunning(handle.bound_port));
            }
        }

        // Spawn the optional automation proxy BEFORE the sidecar so its
        // address + token can be passed through the sidecar's env. The
        // proxy lifetime is tied to McpServerInner — drop releases the
        // port and aborts the listener task.
        let (proxy, proxy_env): (Option<Arc<AutomationProxy>>, Vec<(String, String)>) =
            match automation {
                Some((handle, enforcement)) => {
                    let proxy = AutomationProxy::spawn(handle, enforcement)
                        .await
                        .map_err(|e| {
                            McpServerError::SidecarSpawn(format!(
                                "automation_proxy bind failed: {e}"
                            ))
                        })?;
                    let env = vec![
                        (
                            "COGNIA_AUTOMATION_PROXY".to_string(),
                            proxy.addr.to_string(),
                        ),
                        (
                            "COGNIA_AUTOMATION_PROXY_TOKEN".to_string(),
                            proxy.token.clone(),
                        ),
                    ];
                    (Some(Arc::new(proxy)), env)
                }
                None => (None, Vec::new()),
            };

        // Spawn the optional orchestration proxy BEFORE the sidecar too, so its
        // address + token reach the sidecar via env. It bounces orchestration
        // calls to the renderer; without an `AppHandle` (headless/tests) it is
        // simply absent and the sidecar handlers return the desktop-required
        // error. Lifetime is tied to McpServerInner — drop aborts the listener.
        let (orch_proxy, orch_env): (Option<Arc<OrchestrationProxy>>, Vec<(String, String)>) =
            match app_handle {
                Some(app) => {
                    let proxy = OrchestrationProxy::spawn(app).await.map_err(|e| {
                        McpServerError::SidecarSpawn(format!(
                            "orchestration_proxy bind failed: {e}"
                        ))
                    })?;
                    let env = vec![
                        ("COGNIA_ORCH_PROXY".to_string(), proxy.addr.to_string()),
                        ("COGNIA_ORCH_PROXY_TOKEN".to_string(), proxy.token.clone()),
                    ];
                    (Some(Arc::new(proxy)), env)
                }
                None => (None, Vec::new()),
            };

        // Combine the automation + orchestration proxy env for the sidecar.
        let mut all_env = proxy_env;
        all_env.extend(orch_env);

        // Spawn the Node sidecar — passing the proxy env if we have one.
        let sidecar =
            SidecarProcess::spawn_with_env(&sidecar_path, &settings_json, &all_env).await?;
        let sidecar = Arc::new(sidecar);

        // Streaming-session registry: each streamable-HTTP session spawns its
        // own sidecar from these same params (path + settings + proxy env).
        let sessions = Arc::new(streamable_http::SessionRegistry::new(
            streamable_http::Spawner::Node {
                sidecar_path: sidecar_path.clone(),
                settings_json: settings_json.clone(),
                extra_env: all_env.clone(),
            },
            streamable_http::DEFAULT_IDLE_TTL,
        ));

        // Bind and spawn the axum listener.
        let server_handle = spawn_server(port, token, Arc::clone(&sidecar), sessions).await?;

        let bound_port = server_handle.bound_port;
        let started_at = Utc::now().to_rfc3339();

        {
            let mut inner = self.inner.lock();
            inner.status = McpServerStatus {
                running: true,
                port: Some(bound_port),
                started_at: Some(started_at),
            };
            inner.server = Some((server_handle, sidecar, proxy, orch_proxy));
        }

        Ok(bound_port)
    }

    // ── Orchestration reply plumbing ──────────────────────────────────────

    /// Fire the parked orchestration round-trip identified by `id` with the
    /// renderer's reply. Called by the `orchestration_proxy_response` Tauri
    /// command. No-op when the server (or its orchestration proxy) is not
    /// running, or the id is unknown / already resolved.
    pub fn resolve_orchestration_reply(&self, id: &str, reply: OrchestrationReply) {
        let proxy = {
            let inner = self.inner.lock();
            inner
                .server
                .as_ref()
                .and_then(|(_, _, _, orch)| orch.clone())
        };
        if let Some(proxy) = proxy {
            proxy.resolve(id, reply);
        }
    }

    // ── Stop ─────────────────────────────────────────────────────────────

    /// Send the graceful-shutdown signal and drop the sidecar handle.
    ///
    /// # Errors
    ///
    /// - [`McpServerError::NotRunning`] if the server is already stopped.
    pub fn stop(&self) -> Result<(), McpServerError> {
        let mut inner = self.inner.lock();
        let Some((handle, _sidecar, _proxy, _orch_proxy)) = inner.server.take() else {
            return Err(McpServerError::NotRunning);
        };
        // Signal axum's graceful-shutdown future. `_sidecar` is dropped
        // here, which triggers `kill_on_drop` on the Node child. `_proxy`
        // and `_orch_proxy` (if any) are dropped here too, which aborts the
        // listener tasks and releases the bound TCP ports.
        let _ = handle.shutdown.send(());
        inner.status = McpServerStatus::default();
        Ok(())
    }
}

impl Default for McpServerState {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_state_is_not_running() {
        let state = McpServerState::new();
        assert!(!state.is_running());
        let s = state.status();
        assert!(!s.running);
        assert!(s.port.is_none());
        assert!(s.started_at.is_none());
    }

    #[test]
    fn managed_snapshot_is_none_when_stopped() {
        let state = McpServerState::new();
        assert!(state.managed_snapshot().is_none());
    }

    #[test]
    fn stop_when_not_running_returns_not_running() {
        let state = McpServerState::new();
        assert!(matches!(state.stop(), Err(McpServerError::NotRunning)));
    }

    #[tokio::test]
    async fn start_empty_token_returns_token_missing() {
        let state = McpServerState::new();
        let err = state
            .start(
                0,
                String::new(),
                "{}".to_string(),
                "/dev/null".to_string(),
                None,
                None,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, McpServerError::TokenMissing));
    }

    #[tokio::test]
    async fn start_short_token_returns_token_too_weak() {
        let state = McpServerState::new();
        // Non-empty but below the 32-char floor → rejected before any I/O.
        let err = state
            .start(
                0,
                "tok".to_string(),
                "{}".to_string(),
                "/dev/null".to_string(),
                None,
                None,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, McpServerError::TokenTooWeak(_)));
    }

    #[tokio::test]
    async fn start_bad_json_returns_invalid_settings() {
        let state = McpServerState::new();
        // Token must clear the 32-char min-length so we reach settings parsing.
        let err = state
            .start(
                0,
                "a-sufficiently-long-test-token-1234".to_string(),
                "garbage".to_string(),
                "/dev/null".to_string(),
                None,
                None,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, McpServerError::InvalidSettings(_)));
    }

    /// Full start → stop round-trip with a real echo sidecar (requires node).
    #[tokio::test]
    async fn start_stop_round_trip() {
        let state = McpServerState::new();

        // We inject the sidecar manually to avoid needing a real cognia-mcp.js.
        // Instead of calling state.start(), we build the handles ourselves.
        let Ok(sidecar) = sidecar::spawn_echo_for_tests().await else {
            return; // node not available
        };

        let sidecar = Arc::new(sidecar);
        let server_handle = spawn_server(
            0,
            "tok".to_string(),
            Arc::clone(&sidecar),
            Arc::new(streamable_http::SessionRegistry::new(
                streamable_http::Spawner::Echo,
                streamable_http::DEFAULT_IDLE_TTL,
            )),
        )
        .await
        .expect("bind");

        let bound_port = server_handle.bound_port;
        {
            let mut inner = state.inner.lock();
            inner.status = McpServerStatus {
                running: true,
                port: Some(bound_port),
                started_at: Some(Utc::now().to_rfc3339()),
            };
            inner.server = Some((server_handle, sidecar, None, None));
        }

        assert!(state.is_running());
        assert_eq!(state.status().port, Some(bound_port));

        // The managed-process registry sees the running sidecar by bound port,
        // and surfaces the Node child's OS pid.
        let snap = state.managed_snapshot().expect("running server has a snapshot");
        assert_eq!(snap.port, bound_port);
        assert!(snap.pid.is_some(), "a running sidecar should report an OS pid");

        state.stop().expect("stop should succeed");
        assert!(!state.is_running());
        assert!(state.status().port.is_none());
        assert!(state.managed_snapshot().is_none());
    }

    /// Second stop() after first must fail with NotRunning.
    #[tokio::test]
    async fn double_stop_returns_not_running() {
        let Ok(sidecar) = sidecar::spawn_echo_for_tests().await else {
            return;
        };

        let state = McpServerState::new();
        let sidecar = Arc::new(sidecar);
        let server_handle = spawn_server(
            0,
            "tok".to_string(),
            Arc::clone(&sidecar),
            Arc::new(streamable_http::SessionRegistry::new(
                streamable_http::Spawner::Echo,
                streamable_http::DEFAULT_IDLE_TTL,
            )),
        )
        .await
        .expect("bind");

        {
            let mut inner = state.inner.lock();
            inner.status = McpServerStatus {
                running: true,
                port: Some(server_handle.bound_port),
                started_at: None,
            };
            inner.server = Some((server_handle, sidecar, None, None));
        }

        state.stop().expect("first stop");
        let err = state.stop().unwrap_err();
        assert!(matches!(err, McpServerError::NotRunning));
    }
}
