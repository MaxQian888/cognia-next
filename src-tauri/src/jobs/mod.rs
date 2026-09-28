//! Desktop command shells for the shared background-job host runtime.

pub use cognia_jobs::host::{dispatch_host_rpc, install, monitors, supervisor};
use cognia_jobs::{JobOwner, MonitorCondition, SpawnJobRequest};
use serde_json::{json, Value};
use std::path::PathBuf;

/// Renderer/remote-controller projection of the same supervisor used by the
/// sidecar. These commands intentionally return the wire JSON unchanged so
/// desktop, mobile, and headless Companion clients share one contract.
#[tauri::command]
pub async fn background_job_list(owner: Option<JobOwner>) -> Result<Value, String> {
    dispatch_host_rpc("jobs.list", &json!({ "owner": owner })).await
}

#[tauri::command]
pub async fn background_job_read(
    job_id: String,
    from_offset: Option<u64>,
    max_bytes: Option<u64>,
) -> Result<Value, String> {
    dispatch_host_rpc(
        "jobs.read",
        &json!({
            "jobId": job_id,
            "fromOffset": from_offset.unwrap_or(0),
            "maxBytes": max_bytes.unwrap_or(30_000),
        }),
    )
    .await
}

#[tauri::command]
pub async fn background_job_kill(job_id: String) -> Result<Value, String> {
    // No requester means the trusted user-facing control surface may stop any
    // owner. Agent calls always use host_rpc directly and include a requester.
    dispatch_host_rpc("jobs.kill", &json!({ "jobId": job_id })).await
}

#[tauri::command]
pub async fn background_job_spawn_scheduled(
    task_id: String,
    command: String,
    cwd: PathBuf,
    label: Option<String>,
) -> Result<Value, String> {
    if command.trim().is_empty() {
        return Err("background command must not be empty".to_string());
    }
    #[cfg(windows)]
    let (program, args) = (
        "powershell.exe".to_string(),
        vec![
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            command.clone(),
        ],
    );
    #[cfg(not(windows))]
    let (program, args) = (
        "/bin/sh".to_string(),
        vec!["-lc".to_string(), command.clone()],
    );

    dispatch_host_rpc(
        "jobs.spawn",
        &serde_json::to_value(SpawnJobRequest {
            command,
            program,
            args,
            cwd,
            env: Default::default(),
            owner: JobOwner::ScheduledTask { task_id },
            windows_verbatim_arguments: false,
            label,
        })
        .map_err(|e| e.to_string())?,
    )
    .await
}

#[tauri::command]
pub async fn background_monitor_list(owner: Option<JobOwner>) -> Result<Value, String> {
    dispatch_host_rpc("monitors.list", &json!({ "owner": owner })).await
}

#[tauri::command]
pub async fn background_monitor_cancel(monitor_id: String) -> Result<Value, String> {
    dispatch_host_rpc("monitors.cancel", &json!({ "monitorId": monitor_id })).await
}

#[tauri::command]
pub async fn background_monitor_register_scheduled(
    task_id: String,
    condition: MonitorCondition,
    expires_at_ms: Option<i64>,
    label: Option<String>,
) -> Result<Value, String> {
    dispatch_host_rpc(
        "monitors.register",
        &json!({
            "condition": condition,
            "owner": JobOwner::ScheduledTask { task_id },
            "expiresAtMs": expires_at_ms,
            "label": label,
        }),
    )
    .await
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn scheduled_job_rejects_empty_commands_before_spawning() {
        let result = super::background_job_spawn_scheduled(
            "task-1".into(),
            "  ".into(),
            std::path::PathBuf::from("."),
            None,
        )
        .await;
        assert_eq!(result.unwrap_err(), "background command must not be empty");
    }
}
