//! Shared task-workspace command surface for desktop and headless runtimes.

use cognia_task_workspace::{
    ApplyOutcome, BeginTaskRun, ConflictResolution, DownloadHandle, PatchSelection, PatchSet,
    PruneOutcome, ResourceChange, ResourceRead, RunState, ServiceConfig, TaskRun, TaskWorkspace,
    TaskWorkspaceEventSink, TaskWorkspaceResourceEvent, TaskWorkspaceService, TransferChunk,
    UploadHandle,
};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
};
use tauri::Emitter;

pub const RESOURCE_EVENT: &str = "task-workspace://resources-changed";

static SERVICE: OnceLock<RwLock<Option<Arc<TaskWorkspaceService>>>> = OnceLock::new();

fn slot() -> &'static RwLock<Option<Arc<TaskWorkspaceService>>> {
    SERVICE.get_or_init(|| RwLock::new(None))
}

pub fn install(data_dir: PathBuf) -> Result<Arc<TaskWorkspaceService>, String> {
    let mut config = ServiceConfig::new(data_dir);
    if let Ok(days) = std::env::var("COGNIA_TASK_WORKSPACE_RETENTION_DAYS") {
        let days = days
            .parse::<u64>()
            .map_err(|error| format!("invalid COGNIA_TASK_WORKSPACE_RETENTION_DAYS: {error}"))?;
        config.retention = std::time::Duration::from_secs(days.saturating_mul(24 * 60 * 60));
    }
    if let Ok(bytes) = std::env::var("COGNIA_TASK_WORKSPACE_MAX_BLOB_BYTES") {
        config.max_blob_bytes = bytes
            .parse::<u64>()
            .map_err(|error| format!("invalid COGNIA_TASK_WORKSPACE_MAX_BLOB_BYTES: {error}"))?;
    }
    let service = Arc::new(TaskWorkspaceService::open(config)?);
    *slot().write() = Some(Arc::clone(&service));
    Ok(service)
}

pub fn service() -> Result<Arc<TaskWorkspaceService>, String> {
    slot()
        .read()
        .clone()
        .ok_or_else(|| "task workspace service is not initialized".to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkspaceStatus {
    pub available: bool,
    pub event_name: &'static str,
    pub max_transfer_chunk_bytes: usize,
    pub text_preview_bytes: usize,
    pub editor_bytes: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkspaceTurnEnvelope {
    pub task_id: String,
    pub run_id: String,
    pub parent_run_id: Option<String>,
    pub workspace_root: String,
    pub agent_id: String,
    pub agent_kind: String,
}

pub fn begin_hosted_turn(
    session_id: String,
    envelope: TaskWorkspaceTurnEnvelope,
    sink: Arc<dyn TaskWorkspaceEventSink>,
) -> Result<TaskRun, String> {
    let service = service()?;
    if let Some(existing) = service
        .list_runs(&envelope.task_id)?
        .into_iter()
        .find(|run| run.run_id == envelope.run_id)
    {
        service.watch_run(&existing.run_id, sink)?;
        return Ok(existing);
    }
    let run = service.begin_run(BeginTaskRun {
        task_id: envelope.task_id,
        session_id,
        run_id: envelope.run_id,
        parent_run_id: envelope.parent_run_id,
        agent_id: envelope.agent_id,
        agent_kind: envelope.agent_kind,
        workspace_root: envelope.workspace_root,
    })?;
    service.watch_run(&run.run_id, sink)?;
    Ok(run)
}

#[tauri::command]
pub fn task_workspace_status() -> TaskWorkspaceStatus {
    TaskWorkspaceStatus {
        available: service().is_ok(),
        event_name: RESOURCE_EVENT,
        max_transfer_chunk_bytes: cognia_task_workspace::MAX_TRANSFER_CHUNK_BYTES,
        text_preview_bytes: cognia_task_workspace::DEFAULT_TEXT_PREVIEW_BYTES,
        editor_bytes: cognia_task_workspace::MAX_EDITOR_BYTES,
    }
}

#[tauri::command]
pub async fn task_workspace_begin(input: BeginTaskRun) -> Result<TaskRun, String> {
    blocking(move |service| service.begin_run(input)).await
}

#[tauri::command]
pub async fn task_workspace_settle(
    run_id: String,
    final_state: Option<RunState>,
) -> Result<Vec<ResourceChange>, String> {
    let settled_run_id = run_id.clone();
    let outcome = blocking(
        move |service| match final_state.unwrap_or(RunState::Ready) {
            RunState::Ready => service.settle_run(&run_id),
            RunState::Failed => service.settle_failed_run(&run_id),
            RunState::Cancelled => service.settle_cancelled_run(&run_id),
            state => Err(format!("invalid settle state: {state:?}")),
        },
    )
    .await;
    if let Ok(service) = service() {
        let _ = service.stop_watching_run(&settled_run_id);
    }
    outcome
}

#[tauri::command]
pub fn task_workspace_get(task_id: String) -> Result<Option<TaskWorkspace>, String> {
    service()?.get_task(&task_id)
}

#[tauri::command]
pub fn task_workspace_list(session_id: Option<String>) -> Result<Vec<TaskWorkspace>, String> {
    service()?.list_tasks(session_id.as_deref())
}

#[tauri::command]
pub fn task_workspace_list_runs(task_id: String) -> Result<Vec<TaskRun>, String> {
    service()?.list_runs(&task_id)
}

#[tauri::command]
pub fn task_workspace_list_resources(task_id: String) -> Result<Vec<ResourceChange>, String> {
    service()?.list_resources(&task_id)
}

#[tauri::command]
pub fn task_workspace_get_resource(
    task_id: String,
    path: String,
) -> Result<Option<ResourceChange>, String> {
    Ok(service()?
        .list_resources(&task_id)?
        .into_iter()
        .filter(|resource| resource.path == path)
        .max_by_key(|resource| resource.revision))
}

#[tauri::command]
pub fn task_workspace_get_patch_set(run_id: String) -> Result<Option<PatchSet>, String> {
    service()?.get_patch_set(&run_id)
}

#[tauri::command]
pub fn task_resource_read_diff(
    run_id: String,
    path: String,
    allow_sensitive: bool,
) -> Result<String, String> {
    service()?.read_patch_diff(&run_id, &path, allow_sensitive)
}

#[tauri::command]
pub async fn task_resource_read_text(
    run_id: String,
    rel_path: String,
    offset: u64,
    max_bytes: Option<usize>,
    allow_sensitive: bool,
) -> Result<ResourceRead, String> {
    blocking(move |service| {
        service.read_resource(&run_id, &rel_path, offset, max_bytes, allow_sensitive)
    })
    .await
}

#[tauri::command]
pub fn task_resource_download_open(
    run_id: String,
    rel_path: String,
    allow_sensitive: bool,
) -> Result<DownloadHandle, String> {
    service()?.open_resource_download(&run_id, &rel_path, allow_sensitive)
}

#[tauri::command]
pub fn task_resource_download_read_chunk(
    handle_id: String,
    offset: u64,
    length: Option<usize>,
) -> Result<TransferChunk, String> {
    service()?.read_download_chunk(&handle_id, offset, length)
}

#[tauri::command]
pub fn task_resource_download_close(handle_id: String) -> Result<(), String> {
    service()?.close_resource_download(&handle_id)
}

#[tauri::command]
pub fn task_resource_upload_open(
    run_id: String,
    rel_path: String,
    expected_size: u64,
    expected_hash: String,
    allow_sensitive: bool,
) -> Result<UploadHandle, String> {
    service()?.open_resource_upload(
        &run_id,
        &rel_path,
        expected_size,
        &expected_hash,
        allow_sensitive,
    )
}

#[tauri::command]
pub fn task_resource_upload_write_chunk(
    handle_id: String,
    offset: u64,
    data_base64: String,
    chunk_hash: String,
) -> Result<u64, String> {
    service()?.write_upload_chunk(&handle_id, offset, &data_base64, &chunk_hash)
}

#[tauri::command]
pub fn task_resource_upload_commit(handle_id: String) -> Result<String, String> {
    service()?.commit_resource_upload(&handle_id)
}

#[tauri::command]
pub fn task_resource_upload_abort(handle_id: String) -> Result<(), String> {
    service()?.abort_resource_upload(&handle_id)
}

#[tauri::command]
pub async fn task_workspace_apply(
    run_id: String,
    selection: Vec<PatchSelection>,
) -> Result<ApplyOutcome, String> {
    blocking(move |service| service.apply_patch_set(&run_id, &selection)).await
}

#[tauri::command]
pub async fn task_workspace_undo(run_id: String) -> Result<ApplyOutcome, String> {
    blocking(move |service| service.undo_patch_set(&run_id)).await
}

#[tauri::command]
pub async fn task_workspace_resolve_conflict(
    run_id: String,
    selection: Vec<PatchSelection>,
    resolution: ConflictResolution,
) -> Result<ApplyOutcome, String> {
    blocking(move |service| service.resolve_conflict(&run_id, &selection, resolution)).await
}

#[tauri::command]
pub fn task_workspace_pin(task_id: String, pinned: bool) -> Result<TaskWorkspace, String> {
    service()?.set_task_pinned(&task_id, pinned)
}

#[tauri::command]
pub async fn task_workspace_prune() -> Result<PruneOutcome, String> {
    blocking(TaskWorkspaceService::prune).await
}

pub struct TauriResourceEventSink(pub tauri::AppHandle);

impl TaskWorkspaceEventSink for TauriResourceEventSink {
    fn emit(&self, event: TaskWorkspaceResourceEvent) {
        if let Err(error) = self.0.emit(RESOURCE_EVENT, event) {
            log::warn!("emit task workspace resource event: {error}");
        }
    }
}

pub struct BusResourceEventSink(pub Arc<crate::companion_api::event_bus::EventBus>);

impl TaskWorkspaceEventSink for BusResourceEventSink {
    fn emit(&self, event: TaskWorkspaceResourceEvent) {
        match serde_json::to_value(event) {
            Ok(payload) => {
                self.0.publish(RESOURCE_EVENT.to_string(), payload);
            }
            Err(error) => log::warn!("serialize task workspace resource event: {error}"),
        }
    }
}

#[tauri::command]
pub fn task_workspace_watch(run_id: String, app: tauri::AppHandle) -> Result<(), String> {
    service()?.watch_run(&run_id, Arc::new(TauriResourceEventSink(app)))
}

#[tauri::command]
pub fn task_workspace_stop_watch(run_id: String) -> Result<(), String> {
    service()?.stop_watching_run(&run_id)
}

async fn blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&TaskWorkspaceService) -> Result<T, String> + Send + 'static,
{
    let service = service()?;
    tokio::task::spawn_blocking(move || operation(&service))
        .await
        .map_err(|error| format!("task workspace operation panicked: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn status_reports_the_transport_contract() {
        let data = TempDir::new().unwrap();
        install(data.path().to_path_buf()).unwrap();

        let status = task_workspace_status();
        assert!(status.available);
        assert_eq!(status.event_name, RESOURCE_EVENT);
        assert_eq!(status.max_transfer_chunk_bytes, 24 * 1024);
        assert_eq!(status.text_preview_bytes, 1024 * 1024);
        assert_eq!(status.editor_bytes, 5 * 1024 * 1024);
    }
}
