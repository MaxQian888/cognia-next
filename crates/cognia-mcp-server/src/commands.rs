//! Tauri commands for the MCP HTTP server subsystem.
//!
//! Each command mirrors a function in `lib/tauri/mcp-server.ts` 1:1.
//! The renderer calls these to start, stop, restart, and inspect the server.

use tauri::State;

use super::orchestration_proxy::{tauri_event_sink, OrchestrationEventSink};
use super::types::{McpServerError, McpServerStatus};
use super::McpServerState;
use cognia_automation::automation::commands::AutomationState;

/// Start the MCP HTTP server.
///
/// # Parameters
///
/// - `port` — TCP port to bind.  Pass `0` to let the OS choose.
/// - `token` — Bearer token that clients must supply.
/// - `settings_json` — JSON-serialised `ExternalBridgeSettings`.
/// - `sidecar_path` — Filesystem path to the Node sidecar script
///   (`cognia-mcp.js`).
///
/// # Returns
///
/// The port the server is actually listening on (relevant when `port` was `0`).
#[tauri::command]
pub async fn mcp_server_start(
    app: tauri::AppHandle,
    state: State<'_, McpServerState>,
    automation: State<'_, AutomationState>,
    port: u16,
    token: String,
    settings_json: String,
    sidecar_path: String,
) -> Result<u16, McpServerError> {
    state
        .start(
            port,
            token,
            settings_json,
            sidecar_path,
            Some((
                automation.handle.clone(),
                cognia_automation::automation::dispatcher::Enforcement::from_state(&automation),
            )),
            Some(tauri_event_sink(app)),
        )
        .await
}

pub async fn mcp_server_start_for_state(
    state: &McpServerState,
    port: u16,
    token: String,
    settings_json: String,
    sidecar_path: String,
    automation: Option<(
        cognia_automation::automation::worker::AutomationHandle,
        cognia_automation::automation::dispatcher::Enforcement,
    )>,
    orchestration_sink: Option<OrchestrationEventSink>,
) -> Result<u16, McpServerError> {
    state
        .start(
            port,
            token,
            settings_json,
            sidecar_path,
            automation,
            orchestration_sink,
        )
        .await
}

/// Stop the MCP HTTP server, draining in-flight requests first.
#[tauri::command]
pub async fn mcp_server_stop(state: State<'_, McpServerState>) -> Result<(), McpServerError> {
    mcp_server_stop_for_state(&state)
}

pub fn mcp_server_stop_for_state(state: &McpServerState) -> Result<(), McpServerError> {
    match state.stop() {
        Ok(()) | Err(McpServerError::NotRunning) => Ok(()),
        Err(error) => Err(error),
    }
}

/// Restart the MCP HTTP server.
///
/// Equivalent to calling `mcp_server_stop` then `mcp_server_start` in one
/// atomic command so the renderer doesn't have to race the two calls.
#[tauri::command]
pub async fn mcp_server_restart(
    app: tauri::AppHandle,
    state: State<'_, McpServerState>,
    automation: State<'_, AutomationState>,
    port: u16,
    token: String,
    settings_json: String,
    sidecar_path: String,
) -> Result<u16, McpServerError> {
    // Stop is best-effort — if it's not running, that's fine.
    mcp_server_stop_for_state(&state)?;
    state
        .start(
            port,
            token,
            settings_json,
            sidecar_path,
            Some((
                automation.handle.clone(),
                cognia_automation::automation::dispatcher::Enforcement::from_state(&automation),
            )),
            Some(tauri_event_sink(app)),
        )
        .await
}

pub async fn mcp_server_restart_for_state(
    state: &McpServerState,
    port: u16,
    token: String,
    settings_json: String,
    sidecar_path: String,
    automation: Option<(
        cognia_automation::automation::worker::AutomationHandle,
        cognia_automation::automation::dispatcher::Enforcement,
    )>,
    orchestration_sink: Option<OrchestrationEventSink>,
) -> Result<u16, McpServerError> {
    mcp_server_stop_for_state(state)?;
    mcp_server_start_for_state(
        state,
        port,
        token,
        settings_json,
        sidecar_path,
        automation,
        orchestration_sink,
    )
    .await
}

/// Renderer → Rust callback that completes one orchestration round-trip.
///
/// The orchestration proxy emits `orchestration-proxy:exec` to the renderer;
/// the renderer dispatch provider runs the real entry point (`agent_dispatch`
/// / `team_run` / `plugin_tool_invoke`) and posts the result back here, keyed
/// by the request `id`. First reply wins; unknown / already-resolved ids are a
/// no-op (so a second window can't double-resolve).
#[tauri::command]
pub fn orchestration_proxy_response(
    state: State<'_, McpServerState>,
    id: String,
    ok: bool,
    result: Option<serde_json::Value>,
    error: Option<String>,
) -> Result<(), McpServerError> {
    state.resolve_orchestration_reply(
        &id,
        super::orchestration_proxy::OrchestrationReply { ok, result, error },
    );
    Ok(())
}

/// Return the current status of the MCP HTTP server.
#[tauri::command]
pub async fn mcp_server_status(
    state: State<'_, McpServerState>,
) -> Result<McpServerStatus, McpServerError> {
    Ok(state.status())
}

/// Env override for the stdio sidecar, for dev trees and packagers.
pub const MCP_SIDECAR_PATH_ENV: &str = "COGNIA_MCP_SIDECAR_PATH";

/// Pick the first candidate that exists on disk.
///
/// Split out from the command so the ordering is testable without an
/// `AppHandle`. Returning `None` rather than a best guess is the point: the
/// renderer used to synthesise `~/.cognia/cognia-mcp.js` — a path no build
/// step, installer or first-run task has ever written — and both spawned the
/// server against it and printed it in the client setup snippet.
pub fn first_existing_sidecar(candidates: &[std::path::PathBuf]) -> Option<std::path::PathBuf> {
    candidates.iter().find(|path| path.is_file()).cloned()
}

/// Resolve the stdio sidecar the HTTP server will spawn, or `None` when it is
/// not installed.
///
/// Single source of truth for the spawn path and the client setup snippet —
/// they disagreed before, and neither pointed at a real file.
#[tauri::command]
pub async fn mcp_server_sidecar_path(
    app: tauri::AppHandle,
) -> Result<Option<String>, McpServerError> {
    Ok(resolve_sidecar_path(&app).map(|path| path.to_string_lossy().into_owned()))
}

/// Candidate order: explicit env override, the bundled resource
/// (`tauri.conf.json` → `resources`), then the `~/.cognia` user-install
/// convention that predates the bundling.
pub fn resolve_sidecar_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<std::path::PathBuf> {
    use tauri::Manager;

    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(explicit) = std::env::var_os(MCP_SIDECAR_PATH_ENV) {
        candidates.push(explicit.into());
    }
    if let Ok(resource) = app.path().resolve(
        "sidecar/cognia-mcp.mjs",
        tauri::path::BaseDirectory::Resource,
    ) {
        candidates.push(resource);
    }
    if let Ok(home) = app.path().home_dir() {
        candidates.push(home.join(".cognia").join("cognia-mcp.js"));
    }
    first_existing_sidecar(&candidates)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify the state machine: fresh state is not running.
    #[test]
    fn fresh_state_is_not_running() {
        let state = McpServerState::new();
        let status = state.status();
        assert!(!status.running);
        assert!(status.port.is_none());
        assert!(status.started_at.is_none());
    }

    /// Verify that stopping a not-running server returns `NotRunning`.
    #[test]
    fn stop_when_not_running_returns_error() {
        let state = McpServerState::new();
        let err = state.stop().unwrap_err();
        assert!(matches!(err, McpServerError::NotRunning));
    }

    #[test]
    fn sidecar_resolution_takes_the_first_candidate_that_exists() {
        let dir = std::env::temp_dir().join("cognia-mcp-sidecar-resolve-test");
        std::fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("not-installed.mjs");
        let present = dir.join("cognia-mcp.mjs");
        let _ = std::fs::remove_file(&missing);
        std::fs::write(&present, b"// bundled").unwrap();

        // Earlier candidates win only when they are actually on disk — the
        // whole defect was synthesising a path and trusting it.
        assert_eq!(
            first_existing_sidecar(&[missing.clone(), present.clone()]),
            Some(present.clone())
        );
        // A directory is not a spawnable script.
        assert_eq!(first_existing_sidecar(std::slice::from_ref(&dir)), None);
        // Nothing installed → None, so the caller can say so instead of
        // printing a path that is not there.
        assert_eq!(first_existing_sidecar(&[missing]), None);
        assert_eq!(first_existing_sidecar(&[]), None);

        let _ = std::fs::remove_file(&present);
    }

    #[test]
    fn host_neutral_stop_is_idempotent() {
        let state = McpServerState::new();
        assert!(mcp_server_stop_for_state(&state).is_ok());
        assert!(mcp_server_stop_for_state(&state).is_ok());
    }

    #[tokio::test]
    async fn host_neutral_start_keeps_the_canonical_validation() {
        let state = McpServerState::new();
        let error = mcp_server_start_for_state(
            &state,
            0,
            String::new(),
            r#"{"enabled":true,"enabledScopes":[]}"#.into(),
            "/nonexistent/cognia-mcp.mjs".into(),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, McpServerError::TokenMissing));
    }

    /// Verify token-missing guard: empty token is rejected.
    #[tokio::test]
    async fn start_with_empty_token_returns_error() {
        let state = McpServerState::new();
        let err = state
            .start(
                0,
                String::new(),
                r#"{"enabled":true,"enabledScopes":[]}"#.to_string(),
                "/nonexistent/cognia-mcp.js".to_string(),
                None,
                None,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, McpServerError::TokenMissing));
    }

    /// Verify invalid JSON is rejected before spawning the sidecar.
    #[tokio::test]
    async fn start_with_invalid_settings_json_returns_error() {
        let state = McpServerState::new();
        let err = state
            .start(
                0,
                // Must clear the 32-char min-length so we reach settings parsing.
                "a-sufficiently-long-mcp-test-token".to_string(),
                "not json at all".to_string(),
                "/nonexistent/cognia-mcp.js".to_string(),
                None,
                None,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, McpServerError::InvalidSettings(_)));
    }

    /// Verify double-start returns `AlreadyRunning`.
    ///
    /// This test requires `node` on PATH to successfully start once.
    #[tokio::test]
    async fn double_start_returns_already_running() {
        use crate::sidecar::spawn_echo_for_tests;
        use std::sync::Arc;

        let Ok(sidecar) = spawn_echo_for_tests().await else {
            return; // node not available
        };

        let state = McpServerState::new();

        // Inject a running handle directly, bypassing sidecar spawn.
        {
            let (tx, _rx) = tokio::sync::watch::channel(());
            let handle = crate::http_server::ServerHandle {
                bound_port: 12345,
                shutdown: tx,
                client_verifiers: crate::http_server::ClientVerifierStore::from_tokens(&[
                    "a-sufficiently-long-mcp-test-token".into(),
                ])
                .unwrap(),
                sessions: Arc::new(crate::streamable_http::SessionRegistry::new(
                    crate::streamable_http::Spawner::Echo,
                    crate::streamable_http::DEFAULT_IDLE_TTL,
                )),
            };
            let mut inner = state.inner.lock();
            inner.status.running = true;
            inner.status.port = Some(12345);
            inner.server = Some((handle, Arc::new(sidecar), None, None));
        }

        let err = state
            .start(
                0,
                // Long enough to pass the min-length guard and reach the
                // already-running check.
                "a-sufficiently-long-mcp-test-token".to_string(),
                r#"{"enabled":true,"enabledScopes":[]}"#.to_string(),
                "/nonexistent/cognia-mcp.js".to_string(),
                None,
                None,
            )
            .await
            .unwrap_err();

        assert!(matches!(err, McpServerError::AlreadyRunning(12345)));
    }
}
