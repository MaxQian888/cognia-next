//! Shared task configuration and ownership rules for native and sandbox execution.
pub use cognia_sandboxd::gateway_task::*;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_task_api_retains_safe_task_identity_validation() {
        let environment = std::collections::HashMap::from([(
            PAYLOAD_ENV.into(),
            serde_json::json!({"taskId":"../escape","runtime":"codex","binding":{},"files":{}})
                .to_string(),
        )]);
        assert!(task_home(&environment, std::path::Path::new("/tmp")).is_err());
    }

    #[test]
    fn deletion_preflight_refuses_live_task_and_session_processes() {
        assert!(ensure_gateway_task_stopped("one", &["gateway-task-one".into()]).is_err());
        assert!(ensure_gateway_task_stopped("one", &["gateway-task-one:native-session".into()]).is_err());
        assert!(ensure_gateway_task_stopped("one", &["gateway-task-onetwo".into()]).is_ok());
        assert!(ensure_gateway_task_stopped("one", &[]).is_ok());
    }
}

/// Canonical native and routed sandbox history deletion, shared with the Host
/// cleanup worker. Never infer success from absence in only one backend.
pub async fn delete_gateway_task_for_device(task_id: &str,
    backend: &dyn crate::exec_backend::ExecBackend, device: Option<&str>) -> Result<(), String> {
    if backend.kind() != "local-process" {
        return Err("Gateway task state deletion requires a local process backend".into());
    }
    let prefix = format!("gateway-task-{task_id}");
    if backend.list().await.iter().any(|id| id == &prefix || id.starts_with(&format!("{prefix}:"))) {
        return Err("Stop the gateway task before deleting its state".into());
    }
    backend.delete_retained_gateway_task(task_id, device).await?;
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or("Gateway task requires a host home directory")?;
    let task = task_id.to_owned(); let device = device.map(str::to_owned);
    tokio::task::spawn_blocking(move || delete_task_for_device(&task, std::path::Path::new(&home), device.as_deref()))
        .await.map_err(|_| "Gateway task deletion failed".to_string())?
}

/// Refuse while any process of the task, or of one of its sessions, still runs.
pub(crate) fn ensure_gateway_task_stopped(task_id: &str, ids: &[String]) -> Result<(), String> {
    let prefix = format!("gateway-task-{task_id}");
    if ids.iter().any(|id| id == &prefix || id.starts_with(&format!("{prefix}:"))) {
        Err("Stop the gateway task before deleting its state".into())
    } else { Ok(()) }
}

/// Check that a gateway task's state may be deleted, before anything is removed.
pub async fn authorize_gateway_task_deletion(
    task_id: &str,
    backend: &dyn crate::exec_backend::ExecBackend,
    device: Option<&str>,
) -> Result<(), String> {
    if backend.kind() != "local-process" {
        return Err("Gateway task state deletion requires a local process backend".into());
    }
    ensure_gateway_task_stopped(task_id, &backend.list().await)?;
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or("Gateway task requires a host home directory")?;
    let task_id = task_id.to_owned();
    let device = device.map(str::to_owned);
    tokio::task::spawn_blocking(move || crate::gateway_task::authorize_task_deletion(
        &task_id, std::path::Path::new(&home), device.as_deref(),
    )).await.map_err(|_| "Gateway task deletion preflight failed".to_string())?
}
