//! Tauri commands for the MCP HTTP server subsystem.
//!
//! Each command mirrors a function in `lib/tauri/mcp-server.ts` 1:1.
//! The renderer calls these to start, stop, restart, and inspect the server.

use tauri::State;

use super::types::{McpServerError, McpServerStatus};
use super::McpServerState;

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
    state: State<'_, McpServerState>,
    port: u16,
    token: String,
    settings_json: String,
    sidecar_path: String,
) -> Result<u16, McpServerError> {
    state.start(port, token, settings_json, sidecar_path).await
}

/// Stop the MCP HTTP server, draining in-flight requests first.
#[tauri::command]
pub async fn mcp_server_stop(state: State<'_, McpServerState>) -> Result<(), McpServerError> {
    state.stop()
}

/// Restart the MCP HTTP server.
///
/// Equivalent to calling `mcp_server_stop` then `mcp_server_start` in one
/// atomic command so the renderer doesn't have to race the two calls.
#[tauri::command]
pub async fn mcp_server_restart(
    state: State<'_, McpServerState>,
    port: u16,
    token: String,
    settings_json: String,
    sidecar_path: String,
) -> Result<u16, McpServerError> {
    // Stop is best-effort — if it's not running, that's fine.
    let _ = state.stop();
    state.start(port, token, settings_json, sidecar_path).await
}

/// Return the current status of the MCP HTTP server.
#[tauri::command]
pub async fn mcp_server_status(
    state: State<'_, McpServerState>,
) -> Result<McpServerStatus, McpServerError> {
    Ok(state.status())
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
                "some-token".to_string(),
                "not json at all".to_string(),
                "/nonexistent/cognia-mcp.js".to_string(),
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
        use crate::mcp_server::sidecar::spawn_echo_for_tests;
        use std::sync::Arc;

        let Ok(sidecar) = spawn_echo_for_tests().await else {
            return; // node not available
        };

        let state = McpServerState::new();

        // Inject a running handle directly, bypassing sidecar spawn.
        {
            let (tx, _rx) = tokio::sync::watch::channel(());
            let handle = crate::mcp_server::http_server::ServerHandle {
                bound_port: 12345,
                shutdown: tx,
            };
            let mut inner = state.inner.lock();
            inner.status.running = true;
            inner.status.port = Some(12345);
            inner.server = Some((handle, Arc::new(sidecar)));
        }

        let err = state
            .start(
                0,
                "tok".to_string(),
                r#"{"enabled":true,"enabledScopes":[]}"#.to_string(),
                "/nonexistent/cognia-mcp.js".to_string(),
            )
            .await
            .unwrap_err();

        assert!(matches!(err, McpServerError::AlreadyRunning(12345)));
    }
}
