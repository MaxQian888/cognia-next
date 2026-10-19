//! Desktop command shells for the shared background-job host runtime.
//!
//! The bodies live in `cognia_jobs::commands`, where the companion RPC
//! families call them too; these shells only give them a Tauri IPC surface.

pub use cognia_jobs::host::{dispatch_host_rpc, install, monitors, supervisor};
use cognia_jobs::{commands, JobOwner, MonitorCondition};
use serde_json::Value;
use std::path::PathBuf;

/// Renderer/remote-controller projection of the same supervisor used by the
/// sidecar. These commands intentionally return the wire JSON unchanged so
/// desktop, mobile, and headless Companion clients share one contract.
#[tauri::command]
pub async fn background_job_list(owner: Option<JobOwner>) -> Result<Value, String> {
    commands::background_job_list(owner).await
}

#[tauri::command]
pub async fn background_job_read(
    job_id: String,
    from_offset: Option<u64>,
    max_bytes: Option<u64>,
) -> Result<Value, String> {
    commands::background_job_read(job_id, from_offset, max_bytes).await
}

#[tauri::command]
pub async fn background_job_kill(job_id: String) -> Result<Value, String> {
    commands::background_job_kill(job_id).await
}

#[tauri::command]
pub async fn background_job_spawn_scheduled(
    task_id: String,
    command: String,
    cwd: PathBuf,
    label: Option<String>,
) -> Result<Value, String> {
    commands::background_job_spawn_scheduled(task_id, command, cwd, label).await
}

/// Start a shell command for an External Bridge MCP client (`shell_run`).
#[tauri::command]
pub async fn background_job_spawn_bridge(
    client_id: String,
    command: String,
    cwd: PathBuf,
    label: Option<String>,
) -> Result<Value, String> {
    commands::background_job_spawn_bridge(client_id, command, cwd, label).await
}

/// Start a chat composer's `!` line as a supervised job.
#[tauri::command]
pub async fn background_job_spawn_session(
    session_id: String,
    command: String,
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
    label: Option<String>,
) -> Result<Value, String> {
    commands::background_job_spawn_session(session_id, command, program, args, cwd, label).await
}

/// Long-poll a job's output: returns as soon as bytes past `from_offset` land
/// or the job settles, or after `wait_ms` (capped at 30s host-side).
#[tauri::command]
pub async fn background_job_wait(
    job_id: String,
    from_offset: Option<u64>,
    max_bytes: Option<u64>,
    wait_ms: Option<u64>,
) -> Result<Value, String> {
    commands::background_job_wait(job_id, from_offset, max_bytes, wait_ms).await
}

#[tauri::command]
pub async fn background_monitor_list(owner: Option<JobOwner>) -> Result<Value, String> {
    commands::background_monitor_list(owner).await
}

#[tauri::command]
pub async fn background_monitor_cancel(monitor_id: String) -> Result<Value, String> {
    commands::background_monitor_cancel(monitor_id).await
}

#[tauri::command]
pub async fn background_monitor_register_scheduled(
    task_id: String,
    condition: MonitorCondition,
    expires_at_ms: Option<i64>,
    label: Option<String>,
) -> Result<Value, String> {
    commands::background_monitor_register_scheduled(task_id, condition, expires_at_ms, label).await
}

#[cfg(test)]
mod tests {
    /// The shells add nothing to the bodies: a refusal the body makes before
    /// spawning reaches the IPC caller unchanged.
    #[tokio::test]
    async fn the_shells_forward_the_bodies_refusals() {
        let scheduled = super::background_job_spawn_scheduled(
            "task-1".into(),
            "  ".into(),
            std::path::PathBuf::from("."),
            None,
        )
        .await;
        assert_eq!(
            scheduled.unwrap_err(),
            "background command must not be empty"
        );
        let session = super::background_job_spawn_session(
            "../other".into(),
            "echo hi".into(),
            "/bin/sh".into(),
            vec![],
            std::path::PathBuf::from("."),
            None,
        )
        .await;
        assert_eq!(session.unwrap_err(), "invalid chat session id");
        let bridge = super::background_job_spawn_bridge(
            "../chat".into(),
            "echo hi".into(),
            std::path::PathBuf::from("."),
            None,
        )
        .await;
        assert_eq!(bridge.unwrap_err(), "invalid bridge client id");
    }
}
