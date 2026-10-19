//! The desktop's IPC shells over the environment family (ADR-0221 G7).
//!
//! The family lives in `cognia_companion_rpc::rpc::environment`, where a
//! paired client reaches the same arms; these shells only give the desktop's
//! own UI a Tauri IPC surface, answered as the host owner.

use std::sync::Arc;

use serde_json::Value;

use super::rpc::environment::local_call;
use super::rpc::RpcError;
use super::sandbox_previews::CreateSandboxPreview;
use super::sandbox_snapshots::{
    CreateSandboxSnapshot, ForkSandboxSnapshot, RestoreSandboxSnapshot,
};

/// The desktop's own environment plane: one command answering through the
/// arms a paired client reaches, so the two can never disagree.
#[tauri::command]
pub async fn environment_local_call(
    app: tauri::AppHandle,
    name: String,
    args: Option<Value>,
) -> Result<Value, RpcError> {
    local_call(
        Arc::new(super::dispatch_host::DispatchHost::Tauri(app)),
        name,
        args,
    )
    .await
}

/// Named IPC shells share the companion authority and dispatch implementation.
#[tauri::command]
pub async fn sandbox_snapshot_create(
    app: tauri::AppHandle,
    request: CreateSandboxSnapshot,
) -> Result<Value, RpcError> {
    environment_local_call(
        app,
        "sandbox_snapshot_create".into(),
        Some(serde_json::json!({"request": request})),
    )
    .await
}
#[tauri::command]
pub async fn sandbox_snapshot_list(
    app: tauri::AppHandle,
    project_id: String,
    page_size: Option<u32>,
    page_token: Option<String>,
) -> Result<Value, RpcError> {
    environment_local_call(
        app,
        "sandbox_snapshot_list".into(),
        Some(serde_json::json!({"projectId": project_id, "pageSize": page_size, "pageToken": page_token})),
    )
    .await
}
#[tauri::command]
pub async fn sandbox_snapshot_get(
    app: tauri::AppHandle,
    snapshot_id: String,
) -> Result<Value, RpcError> {
    environment_local_call(
        app,
        "sandbox_snapshot_get".into(),
        Some(serde_json::json!({"snapshotId": snapshot_id})),
    )
    .await
}
#[tauri::command]
pub async fn sandbox_snapshot_delete(
    app: tauri::AppHandle,
    snapshot_id: String,
) -> Result<Value, RpcError> {
    environment_local_call(
        app,
        "sandbox_snapshot_delete".into(),
        Some(serde_json::json!({"snapshotId": snapshot_id})),
    )
    .await
}
#[tauri::command]
pub async fn sandbox_snapshot_pin(
    app: tauri::AppHandle,
    snapshot_id: String,
    pinned: bool,
) -> Result<Value, RpcError> {
    environment_local_call(
        app,
        "sandbox_snapshot_pin".into(),
        Some(serde_json::json!({"snapshotId": snapshot_id, "pinned": pinned})),
    )
    .await
}
#[tauri::command]
pub async fn sandbox_snapshot_fork(
    app: tauri::AppHandle,
    request: ForkSandboxSnapshot,
) -> Result<Value, RpcError> {
    environment_local_call(
        app,
        "sandbox_snapshot_fork".into(),
        Some(serde_json::json!({"request": request})),
    )
    .await
}
#[tauri::command]
pub async fn sandbox_snapshot_restore(
    app: tauri::AppHandle,
    request: RestoreSandboxSnapshot,
) -> Result<Value, RpcError> {
    environment_local_call(
        app,
        "sandbox_snapshot_restore".into(),
        Some(serde_json::json!({"request": request})),
    )
    .await
}

/// Desktop-local shells bypass remote dispatch. The loopback service contract
/// also forbids receipts for create/open: capability plaintext is never stored.
#[tauri::command]
pub async fn sandbox_preview_create(
    app: tauri::AppHandle,
    request: CreateSandboxPreview,
) -> Result<Value, RpcError> {
    environment_local_call(
        app,
        "sandbox_preview_create".into(),
        Some(serde_json::json!({"request": request})),
    )
    .await
}

#[tauri::command]
pub async fn sandbox_preview_list(
    app: tauri::AppHandle,
    project_id: String,
    workspace_id: Option<String>,
    page_size: Option<u32>,
    page_token: Option<String>,
) -> Result<Value, RpcError> {
    environment_local_call(
        app,
        "sandbox_preview_list".into(),
        Some(serde_json::json!({"projectId": project_id, "workspaceId": workspace_id, "pageSize": page_size, "pageToken": page_token})),
    )
    .await
}

#[tauri::command]
pub async fn sandbox_preview_revoke(
    app: tauri::AppHandle,
    grant_id: String,
) -> Result<Value, RpcError> {
    environment_local_call(
        app,
        "sandbox_preview_revoke".into(),
        Some(serde_json::json!({"grantId": grant_id})),
    )
    .await
}

#[tauri::command]
pub async fn sandbox_preview_open(
    app: tauri::AppHandle,
    grant_id: String,
) -> Result<Value, RpcError> {
    environment_local_call(
        app,
        "sandbox_preview_open".into(),
        Some(serde_json::json!({"grantId": grant_id})),
    )
    .await
}

#[tauri::command]
pub async fn sandbox_preview_context(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<Value, RpcError> {
    environment_local_call(
        app,
        "sandbox_preview_context".into(),
        Some(serde_json::json!({"projectId": project_id})),
    )
    .await
}

#[cfg(test)]
mod tests {
    /// Every named shell forwards a command the environment family serves;
    /// one naming anything else would answer `environment_command_unknown`
    /// at runtime.
    #[test]
    fn every_shell_names_an_environment_command() {
        let source = include_str!("environment_commands.rs");
        let source = source.split("#[cfg(test)]").next().unwrap_or_default();
        let names: Vec<&str> = source
            .split("environment_local_call(\n        app,\n        \"")
            .skip(1)
            .filter_map(|rest| rest.split('"').next())
            .collect();
        assert_eq!(names.len(), 12, "{names:?}");
        for name in names {
            assert!(
                super::super::rpc::environment::COMMANDS.contains(&name),
                "{name}"
            );
        }
    }
}
