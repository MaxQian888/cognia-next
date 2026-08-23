//! Shared task-workspace command surface for desktop and headless runtimes.

use cognia_task_workspace::{
    AcquireWorkspaceBundle, ApplyOutcome, BeginTaskRun, ConflictResolution, DownloadHandle,
    PatchSelection, PatchSet, PruneOutcome, ReconcileOutcome, ResourceChange, ResourceEvent,
    ResourceEventKind, ResourceRead, ResourceTrackingPolicy, RunState, ServiceConfig,
    TaskResourceManifest, TaskResourceSummary, TaskRun, TaskWorkspace, TaskWorkspaceEventSink,
    TaskWorkspaceResourceEvent, TaskWorkspaceService, TransferChunk, UploadHandle, WorkspaceBundle,
    WorkspaceLifecyclePolicy, WorkspaceRecord, WorktreeLifecycleEvent, WorktreeLifecycleKind,
    WorktreeLifecycleSink,
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
    // ADR-0111 decision 9: the Registry is the producer of the
    // `WorktreeCreate` / `WorktreeRemove` agent hook events. The crate cannot
    // reach the hook runner, so the app installs this sink at boot.
    service.set_worktree_lifecycle_sink(Some(Arc::new(HookWorktreeLifecycleSink)));
    *slot().write() = Some(Arc::clone(&service));
    Ok(service)
}

/// Runs the `WorktreeCreate` / `WorktreeRemove` lifecycle hooks for a
/// registry event. Fire-and-forget on the Tauri async runtime: the registry
/// state machine must never wait on user hook scripts, and a slow or failing
/// hook must not fail the run that created the worktree (the runner already
/// treats these as observational — `block` is ignored).
pub struct HookWorktreeLifecycleSink;

/// Wire payload for the two hook events. Exposed so the TS producer in
/// `lib/git/commands.ts` and the catalog docs stay byte-identical with this.
pub fn worktree_hook_fields(event: &WorktreeLifecycleEvent) -> serde_json::Value {
    serde_json::json!({
        "worktree_path": event.worktree_path,
        "workspace_root": event.workspace_root,
        "workspace_id": event.workspace_id,
        "owner_type": event.owner_type,
        "owner_ref": event.owner_ref,
        "branch": event.branch,
        "base": event.base,
        "reason": event.reason,
        "source": "managed-registry",
    })
}

impl WorktreeLifecycleSink for HookWorktreeLifecycleSink {
    fn emit(&self, event: WorktreeLifecycleEvent) {
        let hook_event = match event.kind {
            WorktreeLifecycleKind::Created => crate::hooks::HookEvent::WorktreeCreate,
            WorktreeLifecycleKind::Removed => crate::hooks::HookEvent::WorktreeRemove,
        };
        let session_id = event.session_id.clone().unwrap_or_default();
        let cwd = event.workspace_root.clone();
        let fields = worktree_hook_fields(&event);
        tauri::async_runtime::spawn(async move {
            let settings = crate::hooks::load_effective_settings(Some(&cwd));
            let decision = crate::hooks::run_session_scoped(
                &settings,
                hook_event,
                &session_id,
                Some(&cwd),
                // Worktree lifecycle is host bookkeeping, not an agent turn —
                // same classification the TS producer uses in lib/git/commands.ts.
                crate::hooks::HookAgentIdentity {
                    kind: Some("system".to_string()),
                    agent_ref: None,
                },
                fields,
            )
            .await;
            for warning in decision.warnings {
                log::warn!("worktree lifecycle hook: {warning}");
            }
        });
    }
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
    #[serde(default)]
    pub base: cognia_task_workspace::WorkspaceBaseSpec,
    pub agent_id: String,
    pub agent_kind: String,
    pub workspace_key: Option<String>,
    pub execution_run_id: Option<String>,
    pub trace_id: Option<String>,
    pub turn_id: Option<String>,
    pub attempt_id: Option<String>,
    pub provider_attempt_id: Option<String>,
    pub surface: Option<String>,
    #[serde(default)]
    pub tracking_policy: ResourceTrackingPolicy,
}

pub fn begin_hosted_turn(
    session_id: String,
    envelope: TaskWorkspaceTurnEnvelope,
    sink: Arc<dyn TaskWorkspaceEventSink>,
) -> Result<TaskRun, String> {
    let service = service()?;
    let input = BeginTaskRun {
        task_id: envelope.task_id,
        session_id,
        run_id: envelope.run_id,
        parent_run_id: envelope.parent_run_id,
        agent_id: envelope.agent_id,
        agent_kind: envelope.agent_kind,
        workspace_root: envelope.workspace_root,
        base: envelope.base,
        workspace_key: envelope.workspace_key,
        execution_run_id: envelope.execution_run_id,
        trace_id: envelope.trace_id,
        turn_id: envelope.turn_id,
        attempt_id: envelope.attempt_id,
        provider_attempt_id: envelope.provider_attempt_id,
        surface: envelope.surface,
        tracking_policy: envelope.tracking_policy,
    };
    begin_and_watch(&service, input, move |service, run| {
        service.watch_run(&run.run_id, sink)
    })
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
pub async fn task_workspace_begin(
    input: BeginTaskRun,
    app: tauri::AppHandle,
) -> Result<TaskRun, String> {
    blocking(move |service| {
        begin_and_watch(service, input, move |service, run| {
            service.watch_run(&run.run_id, Arc::new(TauriResourceEventSink(app)))
        })
    })
    .await
}

#[tauri::command]
pub async fn task_workspace_bundle_begin(
    bundle_id: String,
    logical_root_id: String,
    input: BeginTaskRun,
    app: tauri::AppHandle,
) -> Result<TaskRun, String> {
    blocking(move |service| {
        begin_bundle_and_watch(
            service,
            &bundle_id,
            &logical_root_id,
            input,
            move |service, run| {
                service.watch_run(&run.run_id, Arc::new(TauriResourceEventSink(app)))
            },
        )
    })
    .await
}

#[tauri::command]
pub async fn task_workspace_settle(
    run_id: String,
    final_state: Option<RunState>,
) -> Result<Vec<ResourceChange>, String> {
    blocking(
        move |service| match final_state.unwrap_or(RunState::Ready) {
            RunState::Ready => service.settle_run(&run_id),
            RunState::Failed => service.settle_failed_run(&run_id),
            RunState::Cancelled => service.settle_cancelled_run(&run_id),
            state => Err(format!("invalid settle state: {state:?}")),
        },
    )
    .await
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
pub fn task_workspace_managed_get(workspace_id: String) -> Result<Option<WorkspaceRecord>, String> {
    service()?.get_managed_workspace(&workspace_id)
}

#[tauri::command]
pub fn task_workspace_managed_list() -> Result<Vec<WorkspaceRecord>, String> {
    service()?.list_managed_workspaces()
}

#[tauri::command]
pub fn task_workspace_bundle_get(bundle_id: String) -> Result<Option<WorkspaceBundle>, String> {
    service()?.get_workspace_bundle(&bundle_id)
}

#[tauri::command]
pub fn task_workspace_bundle_list() -> Result<Vec<WorkspaceBundle>, String> {
    service()?.list_workspace_bundles()
}

#[tauri::command]
pub async fn task_workspace_bundle_acquire(
    input: AcquireWorkspaceBundle,
) -> Result<WorkspaceBundle, String> {
    blocking(move |service| service.acquire_workspace_bundle(input)).await
}

#[tauri::command]
pub async fn task_workspace_reconcile() -> Result<ReconcileOutcome, String> {
    blocking(move |service| service.reconcile_known_worktrees()).await
}

#[tauri::command]
pub fn task_workspace_policy_get() -> Result<WorkspaceLifecyclePolicy, String> {
    Ok(service()?.workspace_lifecycle_policy())
}

#[tauri::command]
pub fn task_workspace_policy_set(
    policy: WorkspaceLifecyclePolicy,
) -> Result<WorkspaceLifecyclePolicy, String> {
    service()?.set_workspace_lifecycle_policy(policy)
}

#[tauri::command]
pub fn task_workspace_managed_pin(
    workspace_id: String,
    pinned: bool,
) -> Result<WorkspaceRecord, String> {
    service()?.set_managed_workspace_pinned(&workspace_id, pinned)
}

#[tauri::command]
pub fn task_workspace_managed_permanent(workspace_id: String) -> Result<WorkspaceRecord, String> {
    service()?.make_workspace_permanent(&workspace_id)
}

#[tauri::command]
pub async fn task_workspace_managed_archive(
    workspace_id: String,
) -> Result<WorkspaceRecord, String> {
    blocking(move |service| service.archive_managed_workspace(&workspace_id)).await
}

#[tauri::command]
pub async fn task_workspace_managed_restore(
    workspace_id: String,
) -> Result<WorkspaceRecord, String> {
    blocking(move |service| service.restore_managed_workspace(&workspace_id)).await
}

#[tauri::command]
pub async fn task_workspace_managed_delete(workspace_id: String) -> Result<(), String> {
    blocking(move |service| service.delete_managed_workspace(&workspace_id)).await
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
pub fn task_workspace_list_resource_events(
    run_id: String,
    cursor: Option<u64>,
    limit: Option<u32>,
) -> Result<Vec<ResourceEvent>, String> {
    service()?.list_resource_events(&run_id, cursor, limit.unwrap_or(200))
}

#[tauri::command]
pub fn task_workspace_get_resource_summary(run_id: String) -> Result<TaskResourceSummary, String> {
    service()?.get_resource_summary(&run_id)
}

#[tauri::command]
pub fn task_workspace_record_tool_event(
    run_id: String,
    path: String,
    old_path: Option<String>,
    kind: ResourceEventKind,
    tool_call_id: Option<String>,
) -> Result<ResourceEvent, String> {
    service()?.record_tool_event(
        &run_id,
        &path,
        old_path.as_deref(),
        kind,
        tool_call_id.as_deref(),
    )
}

#[tauri::command]
pub fn task_workspace_export_resource_manifest(
    task_id: String,
    run_id: Option<String>,
) -> Result<TaskResourceManifest, String> {
    service()?.export_resource_manifest(&task_id, run_id.as_deref())
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
pub async fn task_workspace_restore_snapshot(run_id: String) -> Result<TaskRun, String> {
    blocking(move |service| service.restore_run_snapshot(&run_id)).await
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
    allow_irreversible: Option<bool>,
) -> Result<ApplyOutcome, String> {
    blocking(move |service| {
        service.apply_patch_set_with_options(
            &run_id,
            &selection,
            allow_irreversible.unwrap_or(false),
        )
    })
    .await
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
    allow_irreversible: Option<bool>,
) -> Result<ApplyOutcome, String> {
    blocking(move |service| {
        service.resolve_conflict_with_options(
            &run_id,
            &selection,
            resolution,
            allow_irreversible.unwrap_or(false),
        )
    })
    .await
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

fn begin_and_watch<F>(
    service: &TaskWorkspaceService,
    input: BeginTaskRun,
    watch: F,
) -> Result<TaskRun, String>
where
    F: FnOnce(&TaskWorkspaceService, &TaskRun) -> Result<(), String>,
{
    let run = service.begin_run(input)?;
    watch_started_run(service, run, watch)
}

fn begin_bundle_and_watch<F>(
    service: &TaskWorkspaceService,
    bundle_id: &str,
    logical_root_id: &str,
    input: BeginTaskRun,
    watch: F,
) -> Result<TaskRun, String>
where
    F: FnOnce(&TaskWorkspaceService, &TaskRun) -> Result<(), String>,
{
    let run = service.begin_bundle_run(bundle_id, logical_root_id, input)?;
    watch_started_run(service, run, watch)
}

fn watch_started_run<F>(
    service: &TaskWorkspaceService,
    run: TaskRun,
    watch: F,
) -> Result<TaskRun, String>
where
    F: FnOnce(&TaskWorkspaceService, &TaskRun) -> Result<(), String>,
{
    if matches!(run.state, RunState::Running | RunState::Settling) {
        if let Err(error) = watch(service, &run) {
            let _ = service.settle_failed_run(&run.run_id);
            return Err(error);
        }
    }
    Ok(run)
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

    static TEST_LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();

    fn test_guard() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap()
    }

    struct NoopSink;

    impl TaskWorkspaceEventSink for NoopSink {
        fn emit(&self, _event: TaskWorkspaceResourceEvent) {}
    }

    fn begin_input(workspace: &TempDir, run_id: &str) -> BeginTaskRun {
        BeginTaskRun {
            task_id: "task-test".into(),
            session_id: "session-test".into(),
            run_id: run_id.into(),
            parent_run_id: None,
            agent_id: "agent-test".into(),
            agent_kind: "assistant".into(),
            workspace_root: workspace.path().to_string_lossy().into_owned(),
            base: cognia_task_workspace::WorkspaceBaseSpec::WorkingState,
            workspace_key: None,
            execution_run_id: None,
            trace_id: None,
            turn_id: None,
            attempt_id: None,
            provider_attempt_id: None,
            surface: Some("test".into()),
            tracking_policy: ResourceTrackingPolicy::default(),
        }
    }

    #[test]
    fn worktree_hook_fields_carry_the_documented_wire_names() {
        let event = WorktreeLifecycleEvent {
            kind: WorktreeLifecycleKind::Created,
            workspace_id: "ws-1".into(),
            workspace_root: "/repo".into(),
            worktree_path: "/repo/.cognia/ws-1".into(),
            owner_type: cognia_task_workspace::WorkspaceOwnerType::Session,
            owner_ref: Some("sess-1".into()),
            session_id: Some("sess-1".into()),
            base: cognia_task_workspace::WorkspaceBaseSpec::WorkingState,
            branch: Some("cognia/ws-1".into()),
            reason: None,
        };
        let fields = worktree_hook_fields(&event);
        assert_eq!(fields["worktree_path"], "/repo/.cognia/ws-1");
        assert_eq!(fields["workspace_root"], "/repo");
        assert_eq!(fields["workspace_id"], "ws-1");
        assert_eq!(fields["owner_type"], "session");
        assert_eq!(fields["owner_ref"], "sess-1");
        assert_eq!(fields["branch"], "cognia/ws-1");
        assert_eq!(fields["source"], "managed-registry");
        assert!(fields["reason"].is_null());
    }

    #[test]
    fn install_registers_the_hook_lifecycle_sink() {
        let _guard = test_guard();
        let data = TempDir::new().unwrap();
        let service = install(data.path().to_path_buf()).unwrap();
        assert!(
            service.has_worktree_lifecycle_sink(),
            "boot must install the WorktreeCreate/WorktreeRemove producer"
        );
        // Restore whatever the other tests expect: leave the slot populated.
        assert!(super::service().is_ok());
    }

    fn turn_envelope(workspace: &TempDir, run_id: &str) -> TaskWorkspaceTurnEnvelope {
        let input = begin_input(workspace, run_id);
        TaskWorkspaceTurnEnvelope {
            task_id: input.task_id,
            run_id: input.run_id,
            parent_run_id: input.parent_run_id,
            workspace_root: input.workspace_root,
            base: input.base,
            agent_id: input.agent_id,
            agent_kind: input.agent_kind,
            workspace_key: input.workspace_key,
            execution_run_id: input.execution_run_id,
            trace_id: input.trace_id,
            turn_id: input.turn_id,
            attempt_id: input.attempt_id,
            provider_attempt_id: input.provider_attempt_id,
            surface: input.surface,
            tracking_policy: input.tracking_policy,
        }
    }

    #[test]
    fn status_reports_the_transport_contract() {
        let _guard = test_guard();
        let data = TempDir::new().unwrap();
        install(data.path().to_path_buf()).unwrap();

        let status = task_workspace_status();
        assert!(status.available);
        assert_eq!(status.event_name, RESOURCE_EVENT);
        assert_eq!(status.max_transfer_chunk_bytes, 24 * 1024);
        assert_eq!(status.text_preview_bytes, 1024 * 1024);
        assert_eq!(status.editor_bytes, 5 * 1024 * 1024);
    }

    #[test]
    fn hosted_turn_reattaches_to_the_same_running_run() {
        let _guard = test_guard();
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        install(data.path().to_path_buf()).unwrap();

        let first = begin_hosted_turn(
            "session-test".into(),
            turn_envelope(&workspace, "run-reattach"),
            Arc::new(NoopSink),
        )
        .unwrap();
        let second = begin_hosted_turn(
            "session-test".into(),
            turn_envelope(&workspace, "run-reattach"),
            Arc::new(NoopSink),
        )
        .unwrap();

        assert_eq!(first, second);
        assert_eq!(second.state, RunState::Running);
        task_workspace_stop_watch(second.run_id).unwrap();
    }

    #[test]
    fn watcher_start_failure_marks_the_run_failed() {
        let _guard = test_guard();
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let service = install(data.path().to_path_buf()).unwrap();

        let error = begin_and_watch(&service, begin_input(&workspace, "run-failed"), |_, _| {
            Err("watcher unavailable".into())
        })
        .unwrap_err();

        assert_eq!(error, "watcher unavailable");
        let run = service
            .list_runs("task-test")
            .unwrap()
            .into_iter()
            .find(|run| run.run_id == "run-failed")
            .unwrap();
        assert_eq!(run.state, RunState::Failed);
    }

    #[test]
    fn bundle_watcher_start_failure_marks_the_borrowed_run_failed() {
        let _guard = test_guard();
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let service = install(data.path().to_path_buf()).unwrap();
        let bundle = service
            .acquire_bundle(cognia_task_workspace::AcquireWorkspaceBundle {
                owner_type: cognia_task_workspace::WorkspaceOwnerType::Session,
                owner_ref: Some("session-test".into()),
                environment_kind: cognia_task_workspace::WorkspaceEnvironmentKind::Managed,
                base: cognia_task_workspace::WorkspaceBaseSpec::WorkingState,
                roots: vec![cognia_task_workspace::WorkspaceBundleRootRequest {
                    logical_root_id: "root-1".into(),
                    role: cognia_task_workspace::WorkspaceRootRole::Primary,
                    source_root: workspace.path().to_string_lossy().into_owned(),
                }],
            })
            .unwrap();

        let error = begin_bundle_and_watch(
            &service,
            &bundle.bundle_id,
            "root-1",
            begin_input(&workspace, "run-bundle-failed"),
            |_, _| Err("watcher unavailable".into()),
        )
        .unwrap_err();

        assert_eq!(error, "watcher unavailable");
        let run = service
            .list_runs("task-test")
            .unwrap()
            .into_iter()
            .find(|run| run.run_id == "run-bundle-failed")
            .unwrap();
        assert_eq!(run.state, RunState::Failed);
        assert_eq!(
            service
                .get_bundle(&bundle.bundle_id)
                .unwrap()
                .unwrap()
                .state,
            cognia_task_workspace::WorkspaceBundleState::Active
        );
    }

    #[test]
    fn resource_commands_forward_events_summaries_and_manifests() {
        let _guard = test_guard();
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let service = install(data.path().to_path_buf()).unwrap();
        service
            .begin_run(begin_input(&workspace, "run-resource"))
            .unwrap();

        let event = task_workspace_record_tool_event(
            "run-resource".into(),
            "output/result.txt".into(),
            None,
            ResourceEventKind::Created,
            Some("tool-call-1".into()),
        )
        .unwrap();
        let events =
            task_workspace_list_resource_events("run-resource".into(), None, Some(10)).unwrap();
        let summary = task_workspace_get_resource_summary("run-resource".into()).unwrap();
        let manifest = task_workspace_export_resource_manifest(
            "task-test".into(),
            Some("run-resource".into()),
        )
        .unwrap();

        assert_eq!(event.path.as_deref(), Some("output/result.txt"));
        assert_eq!(event.tool_call_id.as_deref(), Some("tool-call-1"));
        assert!(events.iter().any(|candidate| candidate == &event));
        assert_eq!(summary.event_count, 1);
        assert_eq!(summary.counts.created, 1);
        assert_eq!(manifest.events, vec![event]);
        assert_eq!(manifest.summaries, vec![summary]);
    }
}
