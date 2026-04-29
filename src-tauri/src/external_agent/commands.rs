//! External Agent Tauri Commands
//!
//! Exposes Tauri commands for managing external agent processes and terminals.

use super::process::{
    ExternalAgentProcessManager, ExternalAgentProcessState, ExternalAgentSpawnConfig,
};
use super::terminal::{AcpTerminalManager, TerminalExitStatus};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

/// State wrapper for the process manager
pub struct ExternalAgentState(pub Arc<Mutex<ExternalAgentProcessManager>>);

impl Default for ExternalAgentState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(ExternalAgentProcessManager::new())))
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
    let manager = state.0.lock().await;
    let id = config.id.clone();

    let result = manager.spawn(config).await;

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
        let _ = manager.set_running(&id).await;

        // Emit state change to Running
        let _ = app.emit(
            "external-agent://state-change",
            serde_json::json!({
                "agentId": id,
                "state": "Running"
            }),
        );

        // Start background task to emit stdout/stderr events
        let manager_clone = state.0.clone();
        let app_clone = app.clone();
        let id_clone = id.clone();

        tokio::spawn(async move {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

                let manager = manager_clone.lock().await;

                // Check if process is still running using is_running method
                let is_running = manager.is_running(&id_clone).await.unwrap_or(false);

                if is_running {
                    // Get stdout lines and emit
                    if let Ok(lines) = manager.receive_stdout(&id_clone).await {
                        for line in lines {
                            let _ = app_clone.emit(
                                "external-agent://stdout",
                                serde_json::json!({
                                    "agentId": id_clone,
                                    "data": line
                                }),
                            );
                        }
                    }

                    // Get stderr lines and emit
                    if let Ok(lines) = manager.receive_stderr(&id_clone).await {
                        for line in lines {
                            let _ = app_clone.emit(
                                "external-agent://stderr",
                                serde_json::json!({
                                    "agentId": id_clone,
                                    "data": line
                                }),
                            );
                        }
                    }
                } else {
                    // Process exited - check final state
                    let status = manager.status(&id_clone).await;
                    let exit_state = match status {
                        Some(ExternalAgentProcessState::Failed) => "Failed",
                        _ => "Stopped",
                    };
                    let info = manager.get_info(&id_clone).await.ok();
                    let exit_code = info
                        .as_ref()
                        .and_then(|v| v.get("exitCode"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0) as i32;
                    let exit_signal = info
                        .as_ref()
                        .and_then(|v| v.get("exitSignal"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());

                    let _ = app_clone.emit(
                        "external-agent://state-change",
                        serde_json::json!({
                            "agentId": id_clone,
                            "state": exit_state
                        }),
                    );

                    let _ = app_clone.emit(
                        "external-agent://exit",
                        serde_json::json!({
                            "agentId": id_clone,
                            "code": exit_code,
                            "signal": exit_signal
                        }),
                    );
                    break;
                }
            }
        });
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
    let manager = state.0.lock().await;
    manager.send(&agent_id, &message).await
}

/// Kill an external agent process
#[tauri::command]
pub async fn kill_external_agent(
    agent_id: String,
    state: State<'_, ExternalAgentState>,
    app: AppHandle,
) -> Result<(), String> {
    let manager = state.0.lock().await;
    let result = manager.kill(&agent_id).await;

    if result.is_ok() {
        let _ = app.emit(
            "external-agent://exit",
            serde_json::json!({
                "agentId": agent_id,
                "code": 0
            }),
        );
    }

    result
}

/// Get status of an external agent process
#[tauri::command]
pub async fn get_external_agent_status(
    agent_id: String,
    state: State<'_, ExternalAgentState>,
) -> Result<String, String> {
    let manager = state.0.lock().await;
    let status = manager.status(&agent_id).await;

    match status {
        Some(state) => Ok(format!("{:?}", state)),
        None => Err(format!("Agent {} not found", agent_id)),
    }
}

/// List all external agent processes
#[tauri::command]
pub async fn list_external_agents(
    state: State<'_, ExternalAgentState>,
) -> Result<Vec<String>, String> {
    let manager = state.0.lock().await;
    Ok(manager.list().await)
}

/// Receive stderr from an external agent process
#[tauri::command]
pub async fn receive_external_agent_stderr(
    agent_id: String,
    state: State<'_, ExternalAgentState>,
) -> Result<Vec<String>, String> {
    let manager = state.0.lock().await;
    manager.receive_stderr(&agent_id).await
}

/// Check if an external agent process is running
#[tauri::command]
pub async fn is_external_agent_running(
    agent_id: String,
    state: State<'_, ExternalAgentState>,
) -> Result<bool, String> {
    let manager = state.0.lock().await;
    manager.is_running(&agent_id).await
}

/// Get detailed info about an external agent process
#[tauri::command]
pub async fn get_external_agent_info(
    agent_id: String,
    state: State<'_, ExternalAgentState>,
) -> Result<serde_json::Value, String> {
    let manager = state.0.lock().await;
    manager.get_info(&agent_id).await
}

/// Set external agent state to Running
#[tauri::command]
pub async fn set_external_agent_running(
    agent_id: String,
    state: State<'_, ExternalAgentState>,
    app: AppHandle,
) -> Result<(), String> {
    let manager = state.0.lock().await;
    let result = manager.set_running(&agent_id).await;

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
    let manager = state.0.lock().await;
    let result = manager.set_failed(&agent_id).await;

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
    let manager = state.0.lock().await;
    manager.kill_all().await
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
#[tauri::command]
pub async fn check_command_exists(command: String) -> Result<bool, String> {
    let path_var = match std::env::var_os("PATH") {
        Some(v) => v,
        None => return Ok(false),
    };

    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }

    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(trimmed);
        if candidate.is_file() {
            return Ok(true);
        }
        #[cfg(windows)]
        {
            for ext in ["exe", "cmd", "bat", "ps1"].iter() {
                let with_ext = candidate.with_extension(ext);
                if with_ext.is_file() {
                    return Ok(true);
                }
            }
        }
    }

    Ok(false)
}
