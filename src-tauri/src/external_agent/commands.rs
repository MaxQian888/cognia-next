//! External Agent Tauri Commands
//!
//! Exposes Tauri commands for managing external agent processes and terminals.

use super::process::{
    ExternalAgentEventSink, ExternalAgentProcessManager, ExternalAgentSpawnConfig,
};
use super::terminal::{AcpTerminalManager, TerminalExitStatus};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// State wrapper for the process manager.
///
/// The manager is already internally synchronized (`&self` methods over an
/// inner `RwLock` + per-process `Mutex`), so it is shared through a plain `Arc`
/// — wrapping it in an outer `Mutex` would needlessly serialize every
/// external-agent operation (spawn, send, kill, status) against each other.
pub struct ExternalAgentState(pub Arc<ExternalAgentProcessManager>);

impl Default for ExternalAgentState {
    fn default() -> Self {
        Self(Arc::new(ExternalAgentProcessManager::new()))
    }
}

/// Emits `external-agent://*` events for a spawned process. Passed to
/// `ExternalAgentProcessManager::spawn` so the stdout/stderr reader tasks and
/// the exit supervisor push straight to the webview — no polling, no lock.
struct TauriEventSink {
    app: AppHandle,
}

impl ExternalAgentEventSink for TauriEventSink {
    fn stdout_line(&self, agent_id: &str, line: &str) {
        let _ = self.app.emit(
            "external-agent://stdout",
            serde_json::json!({ "agentId": agent_id, "data": line }),
        );
    }

    fn stderr_line(&self, agent_id: &str, line: &str) {
        let _ = self.app.emit(
            "external-agent://stderr",
            serde_json::json!({ "agentId": agent_id, "data": line }),
        );
    }

    fn exited(&self, agent_id: &str, code: Option<i32>, signal: Option<String>) {
        // Mirror the previous poll-loop payloads: a state-change to Stopped
        // followed by the exit event (code defaults to 0 when unavailable).
        let _ = self.app.emit(
            "external-agent://state-change",
            serde_json::json!({ "agentId": agent_id, "state": "Stopped" }),
        );
        let _ = self.app.emit(
            "external-agent://exit",
            serde_json::json!({
                "agentId": agent_id,
                "code": code.unwrap_or(0),
                "signal": signal
            }),
        );
    }
}

/// State wrapper for the terminal manager
pub struct AcpTerminalState(pub Arc<AcpTerminalManager>);

impl Default for AcpTerminalState {
    fn default() -> Self {
        Self(Arc::new(AcpTerminalManager::new()))
    }
}

/// Spawn an external agent process
#[tauri::command]
pub async fn spawn_external_agent(
    config: ExternalAgentSpawnConfig,
    state: State<'_, ExternalAgentState>,
    app: AppHandle,
) -> Result<String, String> {
    let id = config.id.clone();
    let sink: Arc<dyn ExternalAgentEventSink> = Arc::new(TauriEventSink { app: app.clone() });

    let result = state.0.spawn(config, sink).await;

    if result.is_ok() {
        // Emit spawn event with Starting state
        let _ = app.emit(
            "external-agent://spawn",
            serde_json::json!({
                "agentId": id,
                "status": "starting"
            }),
        );

        // Transition to Running state
        let _ = state.0.set_running(&id).await;

        // Emit state change to Running
        let _ = app.emit(
            "external-agent://state-change",
            serde_json::json!({
                "agentId": id,
                "state": "Running"
            }),
        );

        // stdout/stderr/exit events are now pushed by the reader + supervisor
        // tasks via the sink — no polling loop here.
    } else {
        // Spawn failed - this happens before process is created
        let _ = app.emit(
            "external-agent://state-change",
            serde_json::json!({
                "agentId": id,
                "state": "Failed"
            }),
        );
    }

    result
}

/// Send a message to an external agent process
#[tauri::command]
pub async fn send_to_external_agent(
    agent_id: String,
    message: String,
    state: State<'_, ExternalAgentState>,
) -> Result<(), String> {
    state.0.send(&agent_id, &message).await
}

/// Kill an external agent process. The exit event is emitted by the process
/// supervisor task (single source of truth), not here.
#[tauri::command]
pub async fn kill_external_agent(
    agent_id: String,
    state: State<'_, ExternalAgentState>,
) -> Result<(), String> {
    state.0.kill(&agent_id).await
}

/// Get status of an external agent process
#[tauri::command]
pub async fn get_external_agent_status(
    agent_id: String,
    state: State<'_, ExternalAgentState>,
) -> Result<String, String> {
    match state.0.status(&agent_id).await {
        Some(status) => Ok(format!("{:?}", status)),
        None => Err(format!("Agent {} not found", agent_id)),
    }
}

/// List all external agent processes
#[tauri::command]
pub async fn list_external_agents(
    state: State<'_, ExternalAgentState>,
) -> Result<Vec<String>, String> {
    Ok(state.0.list().await)
}

/// Check if an external agent process is running
#[tauri::command]
pub async fn is_external_agent_running(
    agent_id: String,
    state: State<'_, ExternalAgentState>,
) -> Result<bool, String> {
    state.0.is_running(&agent_id).await
}

/// Get detailed info about an external agent process
#[tauri::command]
pub async fn get_external_agent_info(
    agent_id: String,
    state: State<'_, ExternalAgentState>,
) -> Result<serde_json::Value, String> {
    state.0.get_info(&agent_id).await
}

/// Set external agent state to Running
#[tauri::command]
pub async fn set_external_agent_running(
    agent_id: String,
    state: State<'_, ExternalAgentState>,
    app: AppHandle,
) -> Result<(), String> {
    let result = state.0.set_running(&agent_id).await;

    if result.is_ok() {
        let _ = app.emit(
            "external-agent://state-change",
            serde_json::json!({
                "agentId": agent_id,
                "state": "Running"
            }),
        );
    }

    result
}

/// Set external agent state to Failed
#[tauri::command]
pub async fn set_external_agent_failed(
    agent_id: String,
    state: State<'_, ExternalAgentState>,
    app: AppHandle,
) -> Result<(), String> {
    let result = state.0.set_failed(&agent_id).await;

    if result.is_ok() {
        let _ = app.emit(
            "external-agent://state-change",
            serde_json::json!({
                "agentId": agent_id,
                "state": "Failed"
            }),
        );
    }

    result
}

/// Kill all external agent processes
#[tauri::command]
pub async fn kill_all_external_agents(state: State<'_, ExternalAgentState>) -> Result<(), String> {
    state.0.kill_all().await
}

// ============================================================================
// ACP Terminal Commands
// ============================================================================

fn build_terminal_output_response(
    output: String,
    truncated: bool,
    exit_status: TerminalExitStatus,
) -> serde_json::Value {
    let exit_code = exit_status.exit_code;
    serde_json::json!({
        "output": output,
        "truncated": truncated,
        "exitStatus": exit_status,
        "exitCode": exit_code
    })
}

fn build_terminal_wait_response(exit_status: TerminalExitStatus) -> serde_json::Value {
    let exit_code = exit_status.exit_code;
    serde_json::json!({
        "exitStatus": exit_status,
        "exitCode": exit_code
    })
}

/// Create a new terminal for ACP agent
#[tauri::command]
pub async fn acp_terminal_create(
    session_id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    output_byte_limit: Option<usize>,
    state: State<'_, AcpTerminalState>,
) -> Result<String, String> {
    state
        .0
        .create(
            &session_id,
            &command,
            &args,
            cwd.as_deref(),
            env.as_ref(),
            output_byte_limit,
        )
        .await
}

/// Get output from an ACP terminal
#[tauri::command]
pub async fn acp_terminal_output(
    terminal_id: String,
    output_byte_limit: Option<usize>,
    state: State<'_, AcpTerminalState>,
) -> Result<serde_json::Value, String> {
    let (output, truncated, exit_status) =
        state.0.get_output(&terminal_id, output_byte_limit).await?;
    Ok(build_terminal_output_response(
        output,
        truncated,
        exit_status,
    ))
}

/// Kill an ACP terminal
#[tauri::command]
pub async fn acp_terminal_kill(
    terminal_id: String,
    state: State<'_, AcpTerminalState>,
) -> Result<(), String> {
    state.0.kill(&terminal_id).await
}

/// Release an ACP terminal (remove from manager)
#[tauri::command]
pub async fn acp_terminal_release(
    terminal_id: String,
    state: State<'_, AcpTerminalState>,
) -> Result<(), String> {
    state.0.release(&terminal_id).await
}

/// Wait for an ACP terminal to exit
#[tauri::command]
pub async fn acp_terminal_wait_for_exit(
    terminal_id: String,
    timeout: Option<u64>,
    state: State<'_, AcpTerminalState>,
) -> Result<serde_json::Value, String> {
    let exit_status = state.0.wait_for_exit(&terminal_id, timeout).await?;
    Ok(build_terminal_wait_response(exit_status))
}

/// Write to an ACP terminal
#[tauri::command]
pub async fn acp_terminal_write(
    terminal_id: String,
    data: String,
    state: State<'_, AcpTerminalState>,
) -> Result<(), String> {
    state.0.write(&terminal_id, &data).await
}

/// Get all terminals for a session
#[tauri::command]
pub async fn acp_terminal_get_session_terminals(
    session_id: String,
    state: State<'_, AcpTerminalState>,
) -> Result<Vec<String>, String> {
    Ok(state.0.get_session_terminals(&session_id).await)
}

/// Kill all terminals for a session
#[tauri::command]
pub async fn acp_terminal_kill_session_terminals(
    session_id: String,
    state: State<'_, AcpTerminalState>,
) -> Result<(), String> {
    state.0.kill_session_terminals(&session_id).await
}

/// Check if a terminal is running
#[tauri::command]
pub async fn acp_terminal_is_running(
    terminal_id: String,
    state: State<'_, AcpTerminalState>,
) -> Result<bool, String> {
    state.0.is_running(&terminal_id).await
}

/// Get terminal info (state, command, session_id)
#[tauri::command]
pub async fn acp_terminal_get_info(
    terminal_id: String,
    state: State<'_, AcpTerminalState>,
) -> Result<serde_json::Value, String> {
    state.0.get_info(&terminal_id).await
}

/// List all terminal IDs
#[tauri::command]
pub async fn acp_terminal_list(state: State<'_, AcpTerminalState>) -> Result<Vec<String>, String> {
    Ok(state.0.list().await)
}

// ============================================================================
// Misc helpers
// ============================================================================

/// Check whether a command is reachable on the user's PATH. Used by the
/// ecosystem-readiness layer to decide whether an external-agent preset
/// is `executable`, `guided`, or `documented-only`.
///
/// Delegates to the same [`command_resolver`](super::command_resolver) the
/// spawn path uses, so a preset reported `executable` is one that will
/// actually launch (incl. Windows `.cmd`/`.bat` shims).
#[tauri::command]
pub async fn check_command_exists(command: String) -> Result<bool, String> {
    Ok(super::command_resolver::check_command_exists(&command))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn check_command_exists_rejects_empty_and_unknown() {
        assert_eq!(check_command_exists(String::new()).await, Ok(false));
        assert_eq!(check_command_exists("   ".to_string()).await, Ok(false));
        assert_eq!(
            check_command_exists("definitely-not-a-real-binary-xyz-123".to_string()).await,
            Ok(false)
        );
    }

    #[test]
    fn terminal_output_response_round_trips_exit_code() {
        let status = TerminalExitStatus {
            exit_code: Some(7),
            signal: None,
        };
        let value = build_terminal_output_response("out".to_string(), true, status);
        assert_eq!(value["output"], serde_json::json!("out"));
        assert_eq!(value["truncated"], serde_json::json!(true));
        assert_eq!(value["exitCode"], serde_json::json!(7));
    }

    #[test]
    fn terminal_wait_response_surfaces_exit_code() {
        let status = TerminalExitStatus {
            exit_code: None,
            signal: Some("killed".to_string()),
        };
        let value = build_terminal_wait_response(status);
        assert_eq!(value["exitCode"], serde_json::Value::Null);
        assert_eq!(value["exitStatus"]["signal"], serde_json::json!("killed"));
    }
}
