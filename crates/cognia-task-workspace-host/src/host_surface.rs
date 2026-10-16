//! Shared task-workspace command surface for desktop and headless runtimes.
//!
//! ADR-0196 P6f: moved out of `app_lib`. The service slot, host maintenance,
//! the worktree-lifecycle hook sink and the command bodies are Tauri-free, so
//! the headless server reaches them without the desktop. `tauri-host` adds the
//! command attributes and the four commands that watch a run through the
//! `AppHandle`. The desktop re-exports this module as `task_workspace`.

use cognia_core::command_error::CommandError;
use cognia_task_workspace::{
    apply_revision_patch, changeset_eligibility, read_confined_text, read_report_file,
    workspace_revision, AcquireWorkspaceBundle, AgentChangeset, AppliedCodeResult, ApplyCodeResult,
    ApplyCodeSnapshot, ApplyOutcome, BeginTaskRun, BeginWorkspaceBundleTurn, BundleHandoffOutcome,
    BundleHandoffRequest, BundleHandoffUndoOutcome, CaptureChangeset, ChangesetCheck,
    ChangesetError, ChangesetFilter, ChangesetReview, CodeCheckout, CodeResult, CodeSnapshotLimits,
    CodeSnapshotUpload, CommittedCodeSnapshot, ConfinedFileRead, ConflictResolution,
    CreateCodeSnapshot, CreatedCodeSnapshot, DownloadHandle, EligibilityGap, EnsureProjectSource,
    EnsureRemoteSource, EnsureSessionScratchWorkspace, ExportCodeCheckout, IntegrationAnalysis,
    IntegrationError, IntegrationRun, IntegrationState, PatchSelection, PatchSet,
    PrepareIntegration, ProjectSource, PruneOutcome, ReconcileOutcome, RemoteSourceCheckout,
    ResourceCaptureChunk, ResourceChange, ResourceEvent, ResourceEventKind, ResourceIndexEntry,
    ResourceRead, ResourceTrackingPolicy, RevisionApplyOutcome, RevisionPatch, RunState,
    ServiceConfig, TaskResourceManifest, TaskResourceSummary, TaskRun, TaskWorkspace,
    TaskWorkspaceEventSink, TaskWorkspaceResourceEvent, TaskWorkspaceService, TransferChunk,
    UploadHandle, WorkspaceBundle, WorkspaceBundleTurnLease, WorkspaceBundleTurnOutcome,
    WorkspaceEnvironmentSummary, WorkspaceLifecyclePolicy, WorkspaceMaintenanceEvent,
    WorkspaceMaintenanceRequest, WorkspaceMaintenanceResult, WorkspaceRecord, WorkspaceRevision,
    ExternalPortSubjectKind, WorkspacePortLease, WorkspacePortLeaseList,
    WorktreeLifecycleEvent, WorktreeLifecycleKind, WorktreeLifecycleSink,
};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
};
#[cfg(feature = "tauri-host")]
use tauri::Emitter;

pub const RESOURCE_EVENT: &str = "task-workspace://resources-changed";

static SERVICE: OnceLock<RwLock<Option<Arc<TaskWorkspaceService>>>> = OnceLock::new();
static MAINTENANCE_STARTED: AtomicBool = AtomicBool::new(false);
const MAINTENANCE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

fn slot() -> &'static RwLock<Option<Arc<TaskWorkspaceService>>> {
    SERVICE.get_or_init(|| RwLock::new(None))
}

pub fn install(data_dir: PathBuf) -> Result<Arc<TaskWorkspaceService>, String> {
    // ADR-0176. Point the shared mirror cache at the data directory before any
    // clone can run. Both hosts reach this one function — the desktop shell at
    // `lib.rs` boot and `cognia-server` at `bin/cognia-server.rs` — so the
    // cache has one location per process instead of following whatever the
    // working directory happened to be, which is the bug the process-global
    // root exists to close. A second call losing is fine and expected in tests:
    // the root is set once and the first writer wins.
    cognia_git_mirror::set_root(data_dir.join("task-workspaces").join("mirrors"));
    let mut config = ServiceConfig::new(data_dir);
    config.execution_root = cognia_task_workspace::execution_root_from(
        std::env::var(cognia_task_workspace::EXECUTION_ROOT_ENV)
            .ok()
            .as_deref(),
    )?;
    if let Ok(days) = std::env::var("COGNIA_TASK_WORKSPACE_RETENTION_DAYS") {
        let days = days
            .parse::<u64>()
            .map_err(|error| format!("invalid COGNIA_TASK_WORKSPACE_RETENTION_DAYS: {error}"))?;
        config.retention = std::time::Duration::from_secs(days.saturating_mul(24 * 60 * 60));
    }
    config.code_snapshot_max_bytes = cognia_task_workspace::code_snapshot_max_bytes_from(
        std::env::var(cognia_task_workspace::CODE_SNAPSHOT_MAX_BYTES_ENV)
            .ok()
            .as_deref(),
    )?;
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

/// Start host-owned maintenance once per process. The first pass runs at
/// startup; later passes run every 24 hours without depending on a renderer.
pub fn start_workspace_maintenance() {
    if MAINTENANCE_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        MAINTENANCE_STARTED.store(false, Ordering::Release);
        log::error!("task workspace maintenance requires an async runtime");
        return;
    };
    handle.spawn(async {
        loop {
            // Mirrors are ours, not the user's repositories, so they are
            // reclaimed on the same schedule as the workspaces they serve.
            // ADR-0176: the sweep reads the same process-global root every
            // writer clones into, so the collector and the writers can no
            // longer disagree about where the cache is.
            let mirrors = reclaim_stale_mirrors().await;
            discard_the_legacy_relative_cache().await;
            let result = run_workspace_maintenance_once().await;
            match result {
                Ok(outcome) => log::info!(
                    "task workspace maintenance completed: reclaimed={}, snapshots={}, blobs={}, mirrors={}",
                    outcome.reclaimed_workspace_ids.len(),
                    outcome.expired_snapshot_task_ids.len(),
                    outcome.removed_blob_count,
                    mirrors
                ),
                Err(error) => log::warn!(
                    "task workspace maintenance failed: {error} (mirrors reclaimed: {mirrors})"
                ),
            }
            tokio::time::sleep(MAINTENANCE_INTERVAL).await;
        }
    });
}

/// Delete mirrors nothing has fetched in [`cognia_git_mirror::DEFAULT_MIRROR_MAX_AGE`].
///
/// ADR-0176. This used to live in `github/workspace.rs`, which made the cache
/// GitHub's — it swept `mirror_root(None)` while a caller that passed a base
/// directory wrote somewhere else entirely. The cache is now every clone's, so
/// the sweep belongs next to the loop that owns the schedule, and it reads
/// [`cognia_git_mirror::root`] rather than deriving a root of its own.
///
/// `spawn_blocking` because the crate is deliberately sync: the directory walk
/// and the `remove_dir_all` are filesystem work, and a day-long timer has no
/// reason to hold a runtime thread while they run.
async fn reclaim_stale_mirrors() -> usize {
    tokio::task::spawn_blocking(|| {
        cognia_git_mirror::reclaim_stale(
            &cognia_git_mirror::root(),
            cognia_git_mirror::DEFAULT_MIRROR_MAX_AGE,
        )
    })
    .await
    .unwrap_or(0)
}

/// The directory name the pre-ADR-0176 cache used, relative to the process
/// working directory.
const LEGACY_RELATIVE_CACHE: &str = "cognia-github-worktrees/.mirrors";

static LEGACY_CACHE_SWEPT: AtomicBool = AtomicBool::new(false);

/// Delete the cache the relative root left behind, once per process.
///
/// ADR-0176. The old `mirror_root` derived its path from `DEFAULT_BASE_DIR`,
/// which is relative, so the cache landed under whatever working directory the
/// process happened to have. Nothing ever swept it: the collector looked at the
/// un-injected default instead. Those mirrors are bare repositories of real
/// repositories and can be hundreds of megabytes each.
///
/// Only `.mirrors` is removed. The worktrees beside it are live workspaces
/// somebody may still be working in, and this is a cache sweep, not a cleanup
/// of the user's checkouts.
///
/// Best effort in every direction: a working directory that has since changed
/// simply finds nothing, and a failure to delete is logged and dropped. This
/// runs on the maintenance loop rather than at `install`, so a large legacy
/// cache costs a background task rather than boot latency, and a sweep that
/// cannot finish can never fail a clone.
async fn discard_the_legacy_relative_cache() {
    if LEGACY_CACHE_SWEPT.swap(true, Ordering::AcqRel) {
        return;
    }
    // Relative on purpose: the path is only meaningful against the working
    // directory that produced it, which is the whole defect being cleaned up.
    discard_cache_at(&PathBuf::from(LEGACY_RELATIVE_CACHE)).await;
}

/// The sweep itself, against an explicit directory.
///
/// Split out so the test can name a temporary directory instead of moving the
/// process working directory. `set_current_dir` is process-global, and this
/// module's tests share a binary with every other test in the crate.
async fn discard_cache_at(legacy: &Path) {
    if !legacy.is_dir() {
        return;
    }
    match tokio::fs::remove_dir_all(legacy).await {
        Ok(()) => log::info!(
            "removed the legacy relative mirror cache at {}",
            legacy.display()
        ),
        Err(error) => log::warn!(
            "could not remove the legacy relative mirror cache at {}: {error}",
            legacy.display()
        ),
    }
}

async fn run_workspace_maintenance_once() -> Result<WorkspaceMaintenanceResult, String> {
    tokio::task::spawn_blocking(|| {
        maintain_workspaces(&*service()?, WorkspaceMaintenanceRequest { now: None })
    })
    .await
    .map_err(|error| format!("task workspace maintenance panicked: {error}"))?
}

/// Only Registry-owned worktrees authorize maintenance of their source. Resolve
/// aliases before deduplicating, and leave bare mirrors to the mirror sweep.
fn source_maintenance_common_dirs(records: &[WorkspaceRecord]) -> BTreeSet<PathBuf> {
    use cognia_task_workspace::{
        IsolationKind, WorkspaceEnvironmentKind, WorkspaceOwnerType, WorkspaceState,
    };

    let mut directories = BTreeSet::new();
    for record in records {
        if record.environment_kind != WorkspaceEnvironmentKind::Managed
            || record.owner_type == WorkspaceOwnerType::Imported
            || record.isolation_kind != IsolationKind::GitWorktree
            || !matches!(
                record.state,
                WorkspaceState::Active | WorkspaceState::Archived
            )
        {
            continue;
        }
        let Some(common_dir) = record.git_common_dir.as_deref() else {
            continue;
        };
        match Path::new(common_dir).canonicalize() {
            Ok(path) => {
                directories.insert(path);
            }
            Err(error) => log::warn!("source maintenance skipped {common_dir}: {error}"),
        }
    }
    directories.retain(|directory| {
        match std::process::Command::new("git")
            .arg("--git-dir")
            .arg(directory)
            .args(["rev-parse", "--is-bare-repository"])
            .output()
        {
            Ok(output) if output.status.success() => output.stdout == b"false\n",
            Ok(output) => {
                log::warn!(
                    "source maintenance could not inspect {}: {}",
                    directory.display(),
                    String::from_utf8_lossy(&output.stderr)
                );
                false
            }
            Err(error) => {
                log::warn!(
                    "source maintenance could not inspect {}: {error}",
                    directory.display()
                );
                false
            }
        }
    });
    directories
}

fn maintain_workspaces(
    service: &TaskWorkspaceService,
    request: WorkspaceMaintenanceRequest,
) -> Result<WorkspaceMaintenanceResult, String> {
    let mut outcome = service.run_workspace_maintenance(request)?;
    let records = service.list_managed_workspaces()?;
    for (index, common_dir) in source_maintenance_common_dirs(&records)
        .into_iter()
        .enumerate()
    {
        let success = cognia_git_mirror::run_source_maintenance(&common_dir);
        let detail = format!(
            "source commit-graph maintenance: repository={}, success={success}",
            common_dir.display()
        );
        if success {
            log::info!("{detail}");
        } else {
            log::warn!("{detail}");
        }
        outcome.events.push(WorkspaceMaintenanceEvent {
            event_id: format!("source-maintenance-{}-{index}", outcome.started_at),
            kind: if success {
                cognia_task_workspace::WorkspaceMaintenanceEventKind::Reconciled
            } else {
                cognia_task_workspace::WorkspaceMaintenanceEventKind::Failed
            },
            workspace_id: None,
            occurred_at: outcome.finished_at,
            detail,
        });
    }
    Ok(outcome)
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
            WorktreeLifecycleKind::Created => cognia_hooks::HookEvent::WorktreeCreate,
            WorktreeLifecycleKind::Removed => cognia_hooks::HookEvent::WorktreeRemove,
        };
        let session_id = event.session_id.clone().unwrap_or_default();
        let cwd = event.workspace_root.clone();
        let fields = worktree_hook_fields(&event);
        cognia_core::rt::spawn(async move {
            let settings = cognia_hooks::load_effective_settings(Some(&cwd));
            let cwd_trusted = cognia_hooks::trust::is_trusted(&cwd);
            let decision = cognia_hooks::run_session_scoped(
                &settings,
                hook_event,
                &session_id,
                Some(&cwd),
                cwd_trusted,
                // Worktree lifecycle is host bookkeeping, not an agent turn —
                // same classification the TS producer uses in lib/git/commands.ts.
                cognia_hooks::HookAgentIdentity {
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

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
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

pub fn begin_hosted_bundle_turn(
    bundle_id: String,
    logical_root_id: String,
    input: BeginTaskRun,
    sink: Arc<dyn TaskWorkspaceEventSink>,
) -> Result<TaskRun, String> {
    let service = service()?;
    begin_bundle_and_watch(
        &service,
        &bundle_id,
        &logical_root_id,
        input,
        move |service, run| service.watch_run(&run.run_id, sink),
    )
}

pub fn begin_hosted_workspace_bundle_turn(
    bundle_id: String,
    request: BeginWorkspaceBundleTurn,
    sink: Arc<dyn TaskWorkspaceEventSink>,
) -> Result<WorkspaceBundleTurnLease, String> {
    let service = service()?;
    begin_workspace_bundle_turn_and_watch(&service, &bundle_id, request, move |service, run| {
        service.watch_run(&run.run_id, Arc::clone(&sink))
    })
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_status() -> TaskWorkspaceStatus {
    TaskWorkspaceStatus {
        available: service().is_ok(),
        event_name: RESOURCE_EVENT,
        max_transfer_chunk_bytes: cognia_task_workspace::MAX_TRANSFER_CHUNK_BYTES,
        text_preview_bytes: cognia_task_workspace::DEFAULT_TEXT_PREVIEW_BYTES,
        editor_bytes: cognia_task_workspace::MAX_EDITOR_BYTES,
    }
}

#[cfg(feature = "tauri-host")]
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

#[cfg(feature = "tauri-host")]
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

#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn task_workspace_bundle_turn_begin(
    bundle_id: String,
    request: BeginWorkspaceBundleTurn,
    app: tauri::AppHandle,
) -> Result<WorkspaceBundleTurnLease, String> {
    blocking(move |service| {
        begin_workspace_bundle_turn_and_watch(service, &bundle_id, request, move |service, run| {
            service.watch_run(&run.run_id, Arc::new(TauriResourceEventSink(app.clone())))
        })
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_bundle_turn_settle(
    bundle_turn_id: String,
    final_state: Option<RunState>,
) -> Result<WorkspaceBundleTurnOutcome, String> {
    blocking(move |service| {
        service
            .settle_workspace_bundle_turn(&bundle_turn_id, final_state.unwrap_or(RunState::Ready))
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_bundle_turn_abort(
    bundle_turn_id: String,
) -> Result<WorkspaceBundleTurnOutcome, String> {
    blocking(move |service| service.abort_workspace_bundle_turn(&bundle_turn_id)).await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_bundle_turn_get(
    bundle_turn_id: String,
) -> Result<Option<WorkspaceBundleTurnLease>, String> {
    service()?.get_workspace_bundle_turn(&bundle_turn_id)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
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

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_get(task_id: String) -> Result<Option<TaskWorkspace>, String> {
    service()?.get_task(&task_id)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_list(session_id: Option<String>) -> Result<Vec<TaskWorkspace>, String> {
    service()?.list_tasks(session_id.as_deref())
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_managed_get(workspace_id: String) -> Result<Option<WorkspaceRecord>, String> {
    service()?.get_managed_workspace(&workspace_id)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_managed_list() -> Result<Vec<WorkspaceRecord>, String> {
    service()?.list_managed_workspaces()
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_environment_list(
    root_dir: Option<String>,
) -> Result<Vec<WorkspaceEnvironmentSummary>, String> {
    blocking(move |service| service.list_workspace_environments(root_dir.as_deref().map(Path::new)))
        .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_bundle_get(bundle_id: String) -> Result<Option<WorkspaceBundle>, String> {
    service()?.get_workspace_bundle(&bundle_id)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_bundle_list() -> Result<Vec<WorkspaceBundle>, String> {
    service()?.list_workspace_bundles()
}

/// Supply a managed source checkout from a remote (ADR-0176).
///
/// Deliberately **not** on the device plane. `task_workspace_bundle_acquire`
/// beside it is `workspace.write`, which a paired client holding a `host.admin`
/// lease can reach. This one takes a GitHub installation token, and a
/// credential a `service.internal` caller is trusted with must not become
/// addressable from a phone. It is registered only in
/// `companion_api/rpc/service_plane.rs`, which is loopback-only and
/// service-token gated.
///
/// A caller that sends no token gets the one this host keeps for the
/// remote's git host, if a paired device stored one (ADR-0224 A6): an
/// always-on host clones for work nobody is there to authenticate.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_remote_source_ensure(
    input: EnsureRemoteSource,
) -> Result<RemoteSourceCheckout, String> {
    let input = with_stored_git_token(input);
    blocking(move |service| service.ensure_remote_source(&input)).await
}

/// The directory a project's work runs in on this always-on host (ADR-0224
/// A11): one of its own folders when one exists here, else a clone of its
/// repository with the git credential a paired device stored for that host.
/// Service-only, like [`task_workspace_remote_source_ensure`], for the same
/// reason: it clones with a stored credential. Not a desktop command: only
/// the brain of an always-on host asks, over the service plane.
pub async fn task_workspace_project_source_ensure(
    input: EnsureProjectSource,
) -> Result<ProjectSource, String> {
    let input = with_stored_project_token(input);
    blocking(move |service| service.ensure_project_source(&input)).await
}

/// Service-only session scratch acquisition. The trusted host brain supplies
/// the session identity; this command never accepts a filesystem path.
pub async fn task_workspace_session_scratch_ensure(
    input: EnsureSessionScratchWorkspace,
) -> Result<WorkspaceBundle, String> {
    blocking(move |service| service.ensure_session_scratch_workspace(&input)).await
}

// ---------------------------------------------------------------------------
// Working-copy snapshots (ADR-0224 A11b)
// ---------------------------------------------------------------------------

/// Snapshot a folder on this device for an always-on host: a binary patch
/// against a commit its remote has, or a tar of a folder without git. The
/// bytes stay on this device until read out with [`code_snapshot_read_chunk`].
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn code_snapshot_create(
    input: CreateCodeSnapshot,
) -> Result<CreatedCodeSnapshot, String> {
    blocking(move |service| service.create_code_snapshot(&input)).await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn code_snapshot_read_chunk(
    snapshot_id: String,
    offset: u64,
) -> Result<TransferChunk, String> {
    blocking(move |service| service.read_code_snapshot_chunk(&snapshot_id, offset)).await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn code_snapshot_discard(snapshot_id: String) -> Result<(), String> {
    blocking(move |service| service.discard_code_snapshot(&snapshot_id)).await
}

/// What this host accepts. Not a desktop command: a device pairing this host
/// asks over the companion plane before it makes a snapshot.
pub fn code_snapshot_limits_get() -> Result<CodeSnapshotLimits, String> {
    Ok(service()?.code_snapshot_limits())
}

pub async fn code_snapshot_upload_open(
    size_bytes: u64,
    sha256: String,
) -> Result<CodeSnapshotUpload, String> {
    blocking(move |service| service.open_code_snapshot_upload(size_bytes, &sha256)).await
}

pub async fn code_snapshot_upload_write_chunk(
    upload_id: String,
    offset: u64,
    data_base64: String,
    chunk_hash: String,
) -> Result<u64, String> {
    blocking(move |service| {
        service.write_code_snapshot_chunk(&upload_id, offset, &data_base64, &chunk_hash)
    })
    .await
}

pub async fn code_snapshot_upload_commit(
    upload_id: String,
) -> Result<CommittedCodeSnapshot, String> {
    blocking(move |service| service.commit_code_snapshot_upload(&upload_id)).await
}

pub async fn code_snapshot_upload_cancel(upload_id: String) -> Result<(), String> {
    blocking(move |service| service.cancel_code_snapshot_upload(&upload_id)).await
}

/// Turn a staged snapshot into a checkout here. The base commit is fetched
/// with the git credential this host stored for the remote's host (ADR-0224
/// A6), the same one the clone in [`task_workspace_project_source_ensure`]
/// uses; a caller never sends one.
pub async fn code_snapshot_apply(mut input: ApplyCodeSnapshot) -> Result<CodeCheckout, String> {
    input.credential = with_stored_project_token(EnsureProjectSource {
        roots: Vec::new(),
        remote_url: input.remote_url.clone(),
        credential: None,
    })
    .credential;
    blocking(move |service| service.apply_code_snapshot(&input)).await
}

/// The checkout a handed-over conversation works in. Service-only: the brain
/// binds the continued session to it, by id, so a path never arrives from
/// another device.
pub async fn code_snapshot_checkout_get(
    checkout_id: String,
) -> Result<Option<CodeCheckout>, String> {
    blocking(move |service| service.code_checkout(&checkout_id)).await
}

/// Export the work a handed-over checkout holds (ADR-0224 A11c). The push
/// carries the git credential this host stored for the remote's host, as the
/// fetch in [`code_snapshot_apply`] did; a caller never sends one.
pub async fn code_checkout_export(mut input: ExportCodeCheckout) -> Result<CodeResult, String> {
    blocking(move |service| {
        let remote_url = service
            .code_checkout(&input.checkout_id)?
            .and_then(|checkout| checkout.remote_url);
        input.credential = with_stored_project_token(EnsureProjectSource {
            roots: Vec::new(),
            remote_url,
            credential: None,
        })
        .credential;
        service.export_code_checkout(&input)
    })
    .await
}

pub async fn code_result_read_chunk(
    result_id: String,
    offset: u64,
) -> Result<TransferChunk, String> {
    blocking(move |service| service.read_code_result_chunk(&result_id, offset)).await
}

pub async fn code_result_discard(result_id: String) -> Result<(), String> {
    blocking(move |service| service.discard_code_result(&result_id)).await
}

/// Receive a host's exported bundle or tar on this device, chunk by chunk,
/// for [`code_result_apply`].
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn code_result_receive_open(
    size_bytes: u64,
    sha256: String,
) -> Result<CodeSnapshotUpload, String> {
    blocking(move |service| service.open_code_result_receive(size_bytes, &sha256)).await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn code_result_receive_write_chunk(
    upload_id: String,
    offset: u64,
    data_base64: String,
    chunk_hash: String,
) -> Result<u64, String> {
    blocking(move |service| {
        service.write_code_result_chunk(&upload_id, offset, &data_base64, &chunk_hash)
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn code_result_receive_commit(
    upload_id: String,
) -> Result<CommittedCodeSnapshot, String> {
    blocking(move |service| service.commit_code_result_receive(&upload_id)).await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn code_result_receive_cancel(upload_id: String) -> Result<(), String> {
    blocking(move |service| service.cancel_code_result_receive(&upload_id)).await
}

/// Put a host's exported work into a new worktree (or folder) on this
/// device, fetching a pushed branch with the user's own git credentials.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn code_result_apply(input: ApplyCodeResult) -> Result<AppliedCodeResult, String> {
    blocking(move |service| service.apply_code_result(&input)).await
}

/// [`with_stored_git_token`] for a project's remote.
fn with_stored_project_token(mut input: EnsureProjectSource) -> EnsureProjectSource {
    let has_token = input
        .credential
        .as_deref()
        .is_some_and(|token| !token.trim().is_empty());
    if has_token {
        return input;
    }
    let Some(remote) = input
        .remote_url
        .as_deref()
        .filter(|url| !url.trim().is_empty())
    else {
        return input;
    };
    match cognia_secrets::host_secrets::git_token_for_remote(remote) {
        Ok(token) => input.credential = token,
        Err(error) => log::warn!("stored git token unreadable: {error}"),
    }
    input
}

/// Fill in the host's stored git token when the caller sent none. A token the
/// caller did send always wins, and an unreadable store means "no token", the
/// same as before the store existed: the fetch then fails as unauthenticated
/// rather than this command failing for a reason the caller cannot act on.
fn with_stored_git_token(mut input: EnsureRemoteSource) -> EnsureRemoteSource {
    if input
        .credential
        .as_deref()
        .is_some_and(|token| !token.trim().is_empty())
    {
        return input;
    }
    match cognia_secrets::host_secrets::git_token_for_remote(&input.remote_url) {
        Ok(token) => input.credential = token,
        Err(error) => log::warn!("stored git token unreadable: {error}"),
    }
    input
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_bundle_acquire(
    input: AcquireWorkspaceBundle,
) -> Result<WorkspaceBundle, String> {
    blocking(move |service| service.acquire_workspace_bundle(input)).await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_bundle_apply(
    bundle_id: String,
    request: BundleHandoffRequest,
) -> Result<BundleHandoffOutcome, String> {
    blocking(move |service| service.apply_workspace_bundle(&bundle_id, request)).await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_bundle_handoff_retry(
    bundle_id: String,
    request: BundleHandoffRequest,
) -> Result<BundleHandoffOutcome, String> {
    blocking(move |service| service.retry_workspace_bundle_handoff(&bundle_id, request)).await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_bundle_handoff_get(
    bundle_turn_id: String,
) -> Result<Option<BundleHandoffOutcome>, String> {
    service()?.get_bundle_handoff_outcome(&bundle_turn_id)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_bundle_handoff_undo(
    bundle_id: String,
    bundle_turn_id: String,
) -> Result<BundleHandoffUndoOutcome, String> {
    blocking(move |service| service.undo_workspace_bundle_handoff(&bundle_id, &bundle_turn_id))
        .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_bundle_handoff_undo_get(
    bundle_turn_id: String,
) -> Result<Option<BundleHandoffUndoOutcome>, String> {
    service()?.get_bundle_handoff_undo_outcome(&bundle_turn_id)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_reconcile() -> Result<ReconcileOutcome, String> {
    blocking(move |service| service.reconcile_known_worktrees()).await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_policy_get() -> Result<WorkspaceLifecyclePolicy, String> {
    Ok(service()?.workspace_lifecycle_policy())
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_policy_set(
    policy: WorkspaceLifecyclePolicy,
) -> Result<WorkspaceLifecyclePolicy, String> {
    service()?.set_workspace_lifecycle_policy(policy)
}

fn port_namespace(namespace: &Option<String>) -> &str {
    namespace
        .as_deref()
        .unwrap_or(cognia_task_workspace::HOST_LOOPBACK_NAMESPACE)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_port_lease_get(
    workspace_id: String,
    namespace: Option<String>,
) -> Result<Option<WorkspacePortLease>, String> {
    service()?
        .read_workspace_port_lease(&workspace_id, port_namespace(&namespace))
        .map_err(|error| error.to_string())
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_port_lease_ensure(
    workspace_id: String,
    namespace: Option<String>,
) -> Result<WorkspacePortLease, String> {
    service()?
        .ensure_workspace_port_lease(&workspace_id, port_namespace(&namespace))
        .map_err(|error| error.to_string())
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_port_lease_resolve(
    cwd: String,
    workspace_id: Option<String>,
    namespace: Option<String>,
) -> Result<Option<WorkspacePortLease>, String> {
    service()?
        .resolve_workspace_port_lease(
            port_namespace(&namespace),
            workspace_id.as_deref(),
            Path::new(&cwd),
            false,
        )
        .map_err(|error| error.to_string())
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_port_lease_resolve_ensure(
    cwd: String,
    workspace_id: Option<String>,
    namespace: Option<String>,
) -> Result<Option<WorkspacePortLease>, String> {
    service()?
        .resolve_workspace_port_lease(
            port_namespace(&namespace),
            workspace_id.as_deref(),
            Path::new(&cwd),
            true,
        )
        .map_err(|error| error.to_string())
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_port_lease_subject_ensure(
    kind: ExternalPortSubjectKind,
    key: String,
    root: String,
    namespace: Option<String>,
) -> Result<WorkspacePortLease, String> {
    service()?
        .ensure_subject_port_lease(
            port_namespace(&namespace),
            kind.into(),
            &key,
            Path::new(&root),
        )
        .map_err(|error| error.to_string())
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_port_lease_subject_get(
    kind: ExternalPortSubjectKind,
    key: String,
    namespace: Option<String>,
) -> Result<Vec<WorkspacePortLease>, String> {
    service()?
        .read_subject_port_leases(port_namespace(&namespace), kind.into(), &key)
        .map_err(|error| error.to_string())
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_port_lease_subject_release(
    kind: ExternalPortSubjectKind,
    key: String,
    namespace: Option<String>,
    lease_id: Option<String>,
) -> Result<(), String> {
    service()?
        .release_subject_port_lease_reference(
            port_namespace(&namespace),
            kind.into(),
            &key,
            lease_id.as_deref(),
        )
        .map_err(|error| error.to_string())
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_port_lease_release(
    workspace_id: String,
    namespace: Option<String>,
) -> Result<(), String> {
    service()?
        .release_archived_workspace_port_lease(&workspace_id, port_namespace(&namespace))
        .map_err(|error| error.to_string())
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_port_lease_list() -> Result<WorkspacePortLeaseList, String> {
    service()?
        .list_workspace_port_leases()
        .map_err(|error| error.to_string())
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_maintenance_run(
    request: Option<WorkspaceMaintenanceRequest>,
) -> Result<WorkspaceMaintenanceResult, String> {
    blocking(move |service| {
        maintain_workspaces(
            service,
            request.unwrap_or(WorkspaceMaintenanceRequest { now: None }),
        )
    })
    .await
}

/// One page of workspace maintenance events (ADR-0175 B3). The store answers
/// its newest thousand at most and the page walks them.
pub fn maintenance_events_page(
    service: &TaskWorkspaceService,
    page: &cognia_problem::paging::PageRequest,
) -> Result<cognia_problem::paging::Page<WorkspaceMaintenanceEvent>, String> {
    let all = service.list_workspace_maintenance_events(cognia_problem::paging::MAX_PAGE_SIZE)?;
    cognia_problem::paging::Page::slice_all(all, page, 100).map_err(|error| error.to_string())
}

/// One page of a run's resource events in sequence order (ADR-0175 B3). The
/// token carries the last sequence the caller saw.
pub fn resource_events_page(
    service: &TaskWorkspaceService,
    run_id: &str,
    page: &cognia_problem::paging::PageRequest,
) -> Result<cognia_problem::paging::Page<ResourceEvent>, String> {
    let cursor = page
        .cursor()
        .map_err(|error| error.to_string())?
        .map(|cursor| {
            cursor
                .parse::<u64>()
                .map_err(|_| cognia_problem::paging::PagingError::PageToken.to_string())
        })
        .transpose()?;
    let page_size = page.page_size_or(200);
    let mut events = service.list_resource_events(run_id, cursor, page_size + 1)?;
    let more = events.len() > page_size as usize;
    if more {
        events.truncate(page_size as usize);
    }
    let next = more
        .then(|| events.last().map(|event| event.seq.to_string()))
        .flatten();
    Ok(cognia_problem::paging::Page::from_cursor(events, next))
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_maintenance_events(
    page_size: Option<u32>,
    page_token: Option<String>,
) -> Result<cognia_problem::paging::Page<WorkspaceMaintenanceEvent>, String> {
    let page = cognia_problem::paging::PageRequest::from_parts(page_size, page_token.as_deref())
        .map_err(|error| error.to_string())?;
    maintenance_events_page(&*service()?, &page)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_managed_pin(
    workspace_id: String,
    pinned: bool,
) -> Result<WorkspaceRecord, String> {
    service()?.set_managed_workspace_pinned(&workspace_id, pinned)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_managed_permanent(workspace_id: String) -> Result<WorkspaceRecord, String> {
    service()?.make_workspace_permanent(&workspace_id)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_managed_adopt(workspace_id: String) -> Result<WorkspaceRecord, String> {
    blocking(move |service| service.adopt_imported_workspace(&workspace_id)).await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_environment_adopt(
    environment_id: String,
    source_root: String,
    path: String,
) -> Result<WorkspaceRecord, String> {
    blocking(move |service| {
        service.adopt_workspace_environment(
            &environment_id,
            Path::new(&source_root),
            Path::new(&path),
        )
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_environment_create_branch(
    workspace_id: String,
    branch: String,
) -> Result<WorkspaceRecord, String> {
    let execution_root = service()?.workspace_branch_target(&workspace_id)?;
    let old_head = cognia_git::exec::capture(Path::new(&execution_root), ["rev-parse", "HEAD"])
        .await
        .map_err(|error| error.to_string())?;
    cognia_git::worktree::create_branch_here(&execution_root, &branch)
        .await
        .map_err(|error| error.to_string())?;
    let result = async {
        let head = cognia_git::exec::capture(Path::new(&execution_root), ["rev-parse", "HEAD"])
            .await
            .map_err(|error| error.to_string())?;
        service()?.record_workspace_branch(&workspace_id, &branch, Some(head.trim()))
    }
    .await;
    match result {
        Ok(record) => Ok(record),
        Err(error) => {
            let rollback =
                rollback_workspace_branch(&execution_root, &branch, old_head.trim()).await;
            match rollback {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(format!(
                    "{error}; branch rollback also failed: {rollback_error}"
                )),
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct ChangesetEligibility {
    pub eligible: bool,
    pub gaps: Vec<EligibilityGap>,
}

#[derive(Debug, Clone, Default, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationRunFilter {
    pub repo_common_dir: Option<String>,
    pub target_ref: Option<String>,
    pub states: Option<Vec<IntegrationState>>,
}

impl IntegrationRunFilter {
    fn matches(&self, run: &IntegrationRun) -> bool {
        self.repo_common_dir
            .as_ref()
            .is_none_or(|dir| dir == &run.repo_common_dir)
            && self
                .target_ref
                .as_ref()
                .is_none_or(|target| target == &run.target_ref)
            && self
                .states
                .as_ref()
                .is_none_or(|states| states.contains(&run.state))
    }
}

fn changeset_command_error(error: ChangesetError) -> CommandError {
    let mut command = CommandError::new(error.code(), error.to_string());
    command.retryable = error.retryable();
    command
}

fn integration_command_error(error: IntegrationError) -> CommandError {
    let mut command = CommandError::new(error.code(), error.to_string());
    command.retryable = error.retryable();
    command
}

/// Keep the service-slot guard inside `service()` and all git/SQLite work on
/// the blocking pool, preserving typed rejections across both transports.
async fn scm_blocking<T, F>(operation: F) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce(&TaskWorkspaceService) -> Result<T, CommandError> + Send + 'static,
{
    let service =
        service().map_err(|error| CommandError::retryable("service_unavailable", error))?;
    tokio::task::spawn_blocking(move || operation(&service))
        .await
        .map_err(|error| {
            CommandError::new(
                "internal_error",
                format!("task workspace operation panicked: {error}"),
            )
        })?
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_changeset_capture(
    input: CaptureChangeset,
) -> Result<AgentChangeset, CommandError> {
    scm_blocking(move |service| {
        service
            .capture_changeset(input)
            .map_err(changeset_command_error)
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_changeset_get(
    changeset_id: String,
) -> Result<Option<AgentChangeset>, CommandError> {
    scm_blocking(move |service| match service.get_changeset(&changeset_id) {
        Ok(changeset) => Ok(Some(changeset)),
        Err(ChangesetError::NotFound(_)) => Ok(None),
        Err(error) => Err(changeset_command_error(error)),
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_changeset_list(
    filter: ChangesetFilter,
) -> Result<Vec<AgentChangeset>, CommandError> {
    scm_blocking(move |service| {
        service
            .list_changesets(filter)
            .map_err(changeset_command_error)
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_changeset_mark_ready(
    changeset_id: String,
) -> Result<AgentChangeset, CommandError> {
    scm_blocking(move |service| {
        service
            .mark_changeset_ready(&changeset_id)
            .map_err(changeset_command_error)
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_changeset_record_review(
    changeset_id: String,
    review: ChangesetReview,
) -> Result<AgentChangeset, CommandError> {
    scm_blocking(move |service| {
        service
            .record_changeset_review(&changeset_id, review)
            .map_err(changeset_command_error)
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_changeset_record_check(
    changeset_id: String,
    check: ChangesetCheck,
) -> Result<AgentChangeset, CommandError> {
    scm_blocking(move |service| {
        service
            .record_changeset_check(&changeset_id, check)
            .map_err(changeset_command_error)
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_changeset_approve(
    changeset_id: String,
    head_sha: String,
    approver: String,
) -> Result<AgentChangeset, CommandError> {
    scm_blocking(move |service| {
        service
            .approve_changeset(&changeset_id, &head_sha, &approver)
            .map_err(changeset_command_error)
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_changeset_abandon(
    changeset_id: String,
) -> Result<AgentChangeset, CommandError> {
    scm_blocking(move |service| {
        service
            .abandon_changeset(&changeset_id)
            .map_err(changeset_command_error)
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_changeset_eligibility(
    changeset_id: String,
) -> Result<ChangesetEligibility, CommandError> {
    scm_blocking(move |service| {
        let changeset = service
            .get_changeset(&changeset_id)
            .map_err(changeset_command_error)?;
        let gaps = changeset_eligibility(&changeset).err().unwrap_or_default();
        Ok(ChangesetEligibility {
            eligible: gaps.is_empty(),
            gaps,
        })
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_integration_analyze(
    changeset_ids: Vec<String>,
    target_ref: Option<String>,
) -> Result<IntegrationAnalysis, CommandError> {
    scm_blocking(move |service| {
        service
            .analyze_integration(changeset_ids, target_ref)
            .map_err(integration_command_error)
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_integration_prepare(
    input: PrepareIntegration,
) -> Result<IntegrationRun, CommandError> {
    scm_blocking(move |service| {
        service
            .prepare_integration(input)
            .map_err(integration_command_error)
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_integration_get(
    integration_id: String,
) -> Result<Option<IntegrationRun>, CommandError> {
    scm_blocking(move |service| {
        service
            .get_integration(&integration_id)
            .map_err(integration_command_error)
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_integration_list(
    filter: IntegrationRunFilter,
) -> Result<Vec<IntegrationRun>, CommandError> {
    scm_blocking(move |service| {
        let mut runs = service
            .list_integrations()
            .map_err(integration_command_error)?;
        runs.retain(|run| filter.matches(run));
        Ok(runs)
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_integration_record_check(
    integration_id: String,
    candidate_sha: String,
    check: ChangesetCheck,
) -> Result<IntegrationRun, CommandError> {
    scm_blocking(move |service| {
        service
            .record_integration_check(&integration_id, &candidate_sha, check)
            .map_err(integration_command_error)
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_integration_publish(
    integration_id: String,
    candidate_sha: String,
    required_checks: Vec<String>,
) -> Result<IntegrationRun, CommandError> {
    scm_blocking(move |service| {
        service
            .publish_integration(&integration_id, &candidate_sha, required_checks)
            .map_err(integration_command_error)
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_integration_rebuild(
    integration_id: String,
) -> Result<IntegrationRun, CommandError> {
    scm_blocking(move |service| {
        service
            .rebuild_integration(&integration_id)
            .map_err(integration_command_error)
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_integration_drop_item(
    integration_id: String,
    changeset_id: String,
) -> Result<IntegrationRun, CommandError> {
    scm_blocking(move |service| {
        service
            .drop_integration_item(&integration_id, &changeset_id)
            .map_err(integration_command_error)
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_integration_abort(
    integration_id: String,
) -> Result<IntegrationRun, CommandError> {
    scm_blocking(move |service| {
        service
            .abort_integration(&integration_id)
            .map_err(integration_command_error)
    })
    .await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_integration_rollback(
    integration_id: String,
) -> Result<IntegrationRun, CommandError> {
    scm_blocking(move |service| {
        service
            .rollback_integration(&integration_id)
            .map_err(integration_command_error)
    })
    .await
}

/// Delete a branch `task_workspace_environment_create_branch` made, leaving
/// the environment detached at the same commit, so nothing the agent made is
/// lost. Agent Team `select` uses it to roll back a promotion that failed
/// part way. Only the branch the environment's row records is deleted; any
/// other name, or a repeat, answers the record unchanged.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_environment_delete_branch(
    workspace_id: String,
    branch: String,
) -> Result<WorkspaceRecord, String> {
    let id = workspace_id.clone();
    let record = blocking(move |service| {
        service
            .get_managed_workspace(&id)?
            .ok_or_else(|| format!("workspace {id} not found"))
    })
    .await?;
    if record.branch.as_deref() != Some(branch.as_str()) {
        // Already forgotten (a repeat), or never this environment's branch:
        // either way nothing here is ours to delete.
        return Ok(record);
    }
    let id = workspace_id.clone();
    let execution_root = blocking(move |service| service.workspace_branch_target(&id)).await?;
    delete_workspace_branch(&execution_root, &branch).await?;
    blocking(move |service| service.forget_workspace_branch(&workspace_id, &branch)).await
}

async fn delete_workspace_branch(execution_root: &str, branch: &str) -> Result<(), String> {
    let root = Path::new(execution_root);
    let (attached, current, _) =
        cognia_git::exec::capture_output(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])
            .await
            .map_err(|error| error.to_string())?;
    let on_branch = attached && current.trim() == branch;
    if on_branch {
        cognia_git::exec::run(root, ["checkout", "--detach", "HEAD"])
            .await
            .map_err(|error| error.to_string())?;
    }
    let local_ref = format!("refs/heads/{branch}");
    let (exists, _, _) =
        cognia_git::exec::capture_output(root, ["rev-parse", "--verify", "--quiet", &local_ref])
            .await
            .map_err(|error| error.to_string())?;
    if !exists {
        return Ok(());
    }
    // Detached at the branch tip, HEAD keeps every commit, so force is safe.
    // An environment that moved off the branch gets the merged-only delete,
    // which refuses rather than strand commits only the branch holds.
    cognia_git::branch::delete(execution_root, branch, on_branch)
        .await
        .map_err(|error| error.to_string())
}

async fn rollback_workspace_branch(
    execution_root: &str,
    branch: &str,
    old_head: &str,
) -> Result<(), String> {
    cognia_git::exec::run(
        Path::new(execution_root),
        ["checkout", "--detach", old_head],
    )
    .await
    .map_err(|error| error.to_string())?;
    cognia_git::branch::delete(execution_root, branch, true)
        .await
        .map_err(|error| error.to_string())
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_managed_archive(
    workspace_id: String,
) -> Result<WorkspaceRecord, String> {
    blocking(move |service| service.archive_managed_workspace(&workspace_id)).await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_managed_restore(
    workspace_id: String,
) -> Result<WorkspaceRecord, String> {
    blocking(move |service| service.restore_managed_workspace(&workspace_id)).await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_managed_delete(workspace_id: String) -> Result<(), String> {
    blocking(move |service| service.delete_managed_workspace(&workspace_id)).await
}

/// Host-side protected form of the generic Source Control worktree removal.
/// Registry-owned and newly discovered external worktrees must flow through
/// Archive/Delete or explicit Adopt instead of this manual command.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn git_worktree_remove(
    repo_path: String,
    path: String,
    force: bool,
    delete_branch: Option<String>,
) -> Result<(), String> {
    let guard_repo_path = repo_path.clone();
    let guard_path = path.clone();
    blocking(move |service| {
        service.ensure_manual_worktree_removal_allowed(
            PathBuf::from(guard_repo_path).as_path(),
            PathBuf::from(guard_path).as_path(),
        )
    })
    .await?;
    cognia_git::worktree::remove(&repo_path, &path, force, delete_branch.as_deref())
        .await
        .map_err(|error| error.to_string())
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_list_runs(task_id: String) -> Result<Vec<TaskRun>, String> {
    service()?.list_runs(&task_id)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_list_resources(task_id: String) -> Result<Vec<ResourceChange>, String> {
    service()?.list_resources(&task_id)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_list_resource_events(
    run_id: String,
    page_size: Option<u32>,
    page_token: Option<String>,
) -> Result<cognia_problem::paging::Page<ResourceEvent>, String> {
    let page = cognia_problem::paging::PageRequest::from_parts(page_size, page_token.as_deref())
        .map_err(|error| error.to_string())?;
    resource_events_page(&*service()?, &run_id, &page)
}

/// The files agents left in each conversation's workspace, newest change
/// first (ADR-0223 §8). The Files page lists them as workspace files, and
/// asks again whenever its window regains focus, so the read (a scan of the
/// whole ledger when it has changed) runs off the main thread.
#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn task_workspace_list_resource_index(
    page_size: Option<u32>,
    page_token: Option<String>,
) -> Result<cognia_problem::paging::Page<ResourceIndexEntry>, String> {
    let page = cognia_problem::paging::PageRequest::from_parts(page_size, page_token.as_deref())
        .map_err(|error| error.to_string())?;
    blocking(move |service| resource_index_page(service, &page)).await
}

/// One page of the resource index. The token is an offset into its
/// newest-first order. The service folds the ledger once per change to it,
/// so the pages of one listing share a fold; a change between two pages can
/// repeat or skip an entry, which a reader folds by key.
pub fn resource_index_page(
    service: &TaskWorkspaceService,
    page: &cognia_problem::paging::PageRequest,
) -> Result<cognia_problem::paging::Page<ResourceIndexEntry>, String> {
    let offset = page.offset().map_err(|error| error.to_string())?;
    let page_size = page.page_size_or(500) as usize;
    let entries = service.list_resource_index()?;
    let start = usize::try_from(offset)
        .unwrap_or(usize::MAX)
        .min(entries.len());
    let end = start.saturating_add(page_size).min(entries.len());
    let more = end < entries.len();
    Ok(cognia_problem::paging::Page::from_offset(
        entries[start..end].to_vec(),
        offset,
        more,
    ))
}

/// A slice of the bytes a run's change left at a path, from the ledger's
/// capture (ADR-0223 §8): what Files reads for an agent's file that is not
/// applied yet once the run's own root is gone. Off the main thread, since a
/// compressed capture is decoded to be sliced.
#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn task_workspace_read_resource_capture(
    run_id: String,
    path: String,
    offset: u64,
    length: u64,
) -> Result<ResourceCaptureChunk, String> {
    blocking(move |service| service.read_resource_capture(&run_id, &path, offset, length)).await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_get_resource_summary(run_id: String) -> Result<TaskResourceSummary, String> {
    service()?.get_resource_summary(&run_id)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
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

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_export_resource_manifest(
    task_id: String,
    run_id: Option<String>,
) -> Result<TaskResourceManifest, String> {
    service()?.export_resource_manifest(&task_id, run_id.as_deref())
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
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

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_get_patch_set(run_id: String) -> Result<Option<PatchSet>, String> {
    service()?.get_patch_set(&run_id)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_restore_snapshot(run_id: String) -> Result<TaskRun, String> {
    blocking(move |service| service.restore_run_snapshot(&run_id)).await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_resource_read_diff(
    run_id: String,
    path: String,
    allow_sensitive: bool,
) -> Result<String, String> {
    service()?.read_patch_diff(&run_id, &path, allow_sensitive)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
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

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_resource_download_open(
    run_id: String,
    rel_path: String,
    allow_sensitive: bool,
) -> Result<DownloadHandle, String> {
    service()?.open_resource_download(&run_id, &rel_path, allow_sensitive)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_resource_download_read_chunk(
    handle_id: String,
    offset: u64,
    length: Option<usize>,
) -> Result<TransferChunk, String> {
    service()?.read_download_chunk(&handle_id, offset, length)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_resource_download_close(handle_id: String) -> Result<(), String> {
    service()?.close_resource_download(&handle_id)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
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

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_resource_upload_write_chunk(
    handle_id: String,
    offset: u64,
    data_base64: String,
    chunk_hash: String,
) -> Result<u64, String> {
    service()?.write_upload_chunk(&handle_id, offset, &data_base64, &chunk_hash)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_resource_upload_commit(handle_id: String) -> Result<String, String> {
    service()?.commit_resource_upload(&handle_id)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_resource_upload_abort(handle_id: String) -> Result<(), String> {
    service()?.abort_resource_upload(&handle_id)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
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

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_undo(run_id: String) -> Result<ApplyOutcome, String> {
    blocking(move |service| service.undo_patch_set(&run_id)).await
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
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

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn task_workspace_pin(task_id: String, pinned: bool) -> Result<TaskWorkspace, String> {
    service()?.set_task_pinned(&task_id, pinned)
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_prune() -> Result<PruneOutcome, String> {
    blocking(TaskWorkspaceService::prune).await
}

// ── revision CAS over a workspace root (ADR-0188 B4, WP-D6's crate API) ──────
//
// Three local-workspace operations the TS host had no way to reach: the
// revision a delegate patch is cut from and checked against, the compare-and-
// swap that applies one, and the confined read that brings a file or an
// acceptance report back out of a sandbox worktree.
//
// Renderer-owned on purpose (`target: "client"` in the command manifest). They
// name a filesystem path on THIS machine and write the person's checkout, so
// no paired device may call them: a device that wants a run's patch applied
// asks for the run's approval, and the apply then happens here. A device's
// read of a workspace file stays `fs_read_workspace_file`, which is confined
// to a registered workspace root and gated by `host.observe`.
//
// Every one of them is filesystem work, so it runs on the blocking pool rather
// than on the async runtime's worker.

/// The revision a patch is cut from: `wsrev1:<sha256>` over the tree, and the
/// number of files it covers.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_revision_get(root: String) -> Result<WorkspaceRevision, String> {
    spawn_workspace_read(move || workspace_revision(Path::new(&root))).await
}

/// Apply a whole-file patch against the revision it declares. A workspace that
/// moved is answered `conflict` with nothing written (DEL-04); a patch this
/// host will not take — an unknown format, a path that leaves the root — is
/// `refused` with the reason, never a partial write.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_revision_apply(
    root: String,
    patch: RevisionPatch,
) -> Result<RevisionApplyOutcome, String> {
    spawn_workspace_read(move || apply_revision_patch(Path::new(&root), &patch)).await
}

/// Read one file out of a workspace root, confined to it.
///
/// `whole: true` is the acceptance-report read: a report is parsed whole, so
/// over its cap it answers `too_large` instead of truncating, and a command
/// that wrote no report at all answers `missing` — which is what tells a run
/// it is inconclusive rather than passed (DEL-02). Without it the read is the
/// ordinary text read, which truncates at its limit and says so.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn task_workspace_revision_read(
    root: String,
    rel_path: String,
    max_bytes: Option<u64>,
    whole: Option<bool>,
) -> Result<ConfinedFileRead, String> {
    spawn_workspace_read(move || {
        if whole.unwrap_or(false) {
            read_report_file(Path::new(&root), &rel_path, max_bytes)
        } else {
            read_confined_text(Path::new(&root), &rel_path, max_bytes)
        }
    })
    .await
}

/// Run one crate call on the blocking pool. These take no service: the root is
/// the caller's own path, confined by the crate itself.
async fn spawn_workspace_read<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| format!("task workspace operation panicked: {error}"))?
}

#[cfg(feature = "tauri-host")]
pub struct TauriResourceEventSink(pub tauri::AppHandle);

#[cfg(feature = "tauri-host")]
impl TaskWorkspaceEventSink for TauriResourceEventSink {
    fn emit(&self, event: TaskWorkspaceResourceEvent) {
        if let Err(error) = self.0.emit(RESOURCE_EVENT, event) {
            log::warn!("emit task workspace resource event: {error}");
        }
    }
}

pub struct BusResourceEventSink(pub Arc<cognia_companion_bus::event_bus::EventBus>);

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

#[cfg(feature = "tauri-host")]
#[tauri::command]
pub fn task_workspace_watch(run_id: String, app: tauri::AppHandle) -> Result<(), String> {
    service()?.watch_run(&run_id, Arc::new(TauriResourceEventSink(app)))
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
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

fn begin_workspace_bundle_turn_and_watch<F>(
    service: &TaskWorkspaceService,
    bundle_id: &str,
    request: BeginWorkspaceBundleTurn,
    mut watch: F,
) -> Result<WorkspaceBundleTurnLease, String>
where
    F: FnMut(&TaskWorkspaceService, &TaskRun) -> Result<(), String>,
{
    let turn = service.begin_workspace_bundle_turn(bundle_id, request)?;
    for lease in &turn.runs {
        if matches!(lease.run.state, RunState::Running | RunState::Settling) {
            if let Err(error) = watch(service, &lease.run) {
                let _ =
                    service.settle_workspace_bundle_turn(&turn.bundle_turn_id, RunState::Failed);
                return Err(error);
            }
        }
    }
    Ok(turn)
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
    #[test]
    fn port_subject_commands_reject_registry_and_default_to_host_namespace() {
        assert!(serde_json::from_str::<super::ExternalPortSubjectKind>("\"registry\"").is_err());
        assert_eq!(
            super::port_namespace(&None),
            cognia_task_workspace::HOST_LOOPBACK_NAMESPACE
        );
        assert_eq!(
            super::port_namespace(&Some("remote:test".into())),
            "remote:test"
        );
        let message = cognia_task_workspace::PortLeaseError::Exhausted {
            start: 41000,
            end: 48999,
            block_size: 10,
        }
        .to_string();
        for field in ["portRangeStart", "portRangeEnd", "portBlockSize"] {
            assert!(message.contains(field));
        }
    }

    #[test]
    fn port_list_command_reports_and_explicitly_releases_deleted_root() {
        let _guard = test_guard();
        let data = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        super::install(data.path().into()).unwrap();
        let key = format!(
            "root:{}",
            std::fs::canonicalize(root.path()).unwrap().display()
        );
        let namespace = Some("remote:orphan-command-test".to_string());
        let lease = super::task_workspace_port_lease_subject_ensure(
            super::ExternalPortSubjectKind::ProjectRoot,
            key.clone(),
            root.path().to_string_lossy().into_owned(),
            namespace.clone(),
        )
        .unwrap();
        std::fs::remove_dir_all(root.path()).unwrap();
        let snapshot = super::task_workspace_port_lease_list().unwrap();
        assert_eq!(snapshot.leases.len(), 1);
        assert!(snapshot.diagnostics.iter().any(|diagnostic| diagnostic.kind
            == cognia_task_workspace::PortLeaseDiagnosticKind::MissingRoot
            && diagnostic.lease_ids == [lease.lease_id.clone()]));
        super::task_workspace_port_lease_subject_release(
            super::ExternalPortSubjectKind::ProjectRoot,
            key,
            namespace,
            None,
        )
        .unwrap();
        assert!(super::task_workspace_port_lease_list()
            .unwrap()
            .leases
            .is_empty());
    }

    #[test]
    fn a_remote_source_without_a_token_uses_the_one_stored_for_its_host() {
        use cognia_secrets::host_secrets::{self, HostSecretKind};
        host_secrets::set(HostSecretKind::Git, "supply.example.com", "ghp_stored", None, 1)
            .unwrap();
        let input = |credential: Option<&str>| super::EnsureRemoteSource {
            remote_url: "https://supply.example.com/acme/app.git".to_string(),
            base: Default::default(),
            credential: credential.map(str::to_string),
        };
        assert_eq!(
            super::with_stored_git_token(input(None)).credential.as_deref(),
            Some("ghp_stored")
        );
        assert_eq!(
            super::with_stored_git_token(input(Some("  "))).credential.as_deref(),
            Some("ghp_stored")
        );
        assert_eq!(
            super::with_stored_git_token(input(Some("ghp_sent"))).credential.as_deref(),
            Some("ghp_sent")
        );
        let elsewhere = super::EnsureRemoteSource {
            remote_url: "https://other.example.com/a.git".to_string(),
            base: Default::default(),
            credential: None,
        };
        assert_eq!(super::with_stored_git_token(elsewhere).credential, None);
    }

    #[test]
    fn a_project_clone_uses_the_token_stored_for_its_remotes_host() {
        use cognia_secrets::host_secrets::{self, HostSecretKind};
        host_secrets::set(HostSecretKind::Git, "project.example.com", "ghp_project", None, 1)
            .unwrap();
        let input = |remote: Option<&str>, credential: Option<&str>| super::EnsureProjectSource {
            roots: vec!["/Users/me/app".to_string()],
            remote_url: remote.map(str::to_string),
            credential: credential.map(str::to_string),
        };
        let remote = Some("https://project.example.com/acme/app.git");
        assert_eq!(
            super::with_stored_project_token(input(remote, None))
                .credential
                .as_deref(),
            Some("ghp_project")
        );
        assert_eq!(
            super::with_stored_project_token(input(remote, Some("ghp_sent")))
                .credential
                .as_deref(),
            Some("ghp_sent")
        );
        assert_eq!(
            super::with_stored_project_token(input(None, None)).credential,
            None
        );
    }

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

    fn run_git(root: &std::path::Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .args(["-C"])
            .arg(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn source_maintenance_writes_the_managed_repository_commit_graph() {
        let _guard = test_guard();
        let data = TempDir::new().unwrap();
        let repository = TempDir::new().unwrap();
        run_git(repository.path(), &["init"]);
        run_git(repository.path(), &["config", "user.name", "Cognia Test"]);
        run_git(
            repository.path(),
            &["config", "user.email", "cognia@example.com"],
        );
        run_git(
            repository.path(),
            &["commit", "--allow-empty", "-m", "seed"],
        );
        let service = Arc::new(
            TaskWorkspaceService::open(ServiceConfig::new(data.path().to_path_buf())).unwrap(),
        );
        service
            .begin_run(begin_input(&repository, "maintenance-run"))
            .unwrap();
        let managed = service.list_managed_workspaces().unwrap().remove(0);
        let mut archived_alias = managed.clone();
        archived_alias.state = cognia_task_workspace::WorkspaceState::Archived;
        archived_alias.git_common_dir =
            Some(format!("{}/.", managed.git_common_dir.as_ref().unwrap()));
        let imported_repo = TempDir::new().unwrap();
        run_git(imported_repo.path(), &["init"]);
        let mut imported = managed.clone();
        imported.owner_type = cognia_task_workspace::WorkspaceOwnerType::Imported;
        imported.git_common_dir = Some(
            imported_repo
                .path()
                .join(".git")
                .to_string_lossy()
                .into_owned(),
        );
        let bare = TempDir::new().unwrap();
        run_git(bare.path(), &["init", "--bare"]);
        let mut mirror = managed.clone();
        mirror.git_common_dir = Some(bare.path().to_string_lossy().into_owned());
        assert_eq!(
            source_maintenance_common_dirs(&[
                managed.clone(),
                archived_alias,
                imported.clone(),
                mirror
            ]),
            BTreeSet::from([repository.path().join(".git").canonicalize().unwrap()])
        );
        assert!(source_maintenance_common_dirs(&[imported]).is_empty());
        for state in [
            cognia_task_workspace::WorkspaceState::Provisioning,
            cognia_task_workspace::WorkspaceState::Restorable,
            cognia_task_workspace::WorkspaceState::Conflict,
            cognia_task_workspace::WorkspaceState::Removing,
            cognia_task_workspace::WorkspaceState::Removed,
        ] {
            let mut excluded = managed.clone();
            excluded.state = state;
            assert!(source_maintenance_common_dirs(&[excluded]).is_empty());
        }
        for kind in [
            cognia_task_workspace::WorkspaceEnvironmentKind::Imported,
            cognia_task_workspace::WorkspaceEnvironmentKind::Permanent,
        ] {
            let mut excluded = managed.clone();
            excluded.environment_kind = kind;
            assert!(source_maintenance_common_dirs(&[excluded]).is_empty());
        }
        *slot().write() = Some(service);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let outcome = runtime.block_on(run_workspace_maintenance_once()).unwrap();
        assert_eq!(
            outcome
                .events
                .iter()
                .filter(|event| event.detail.starts_with("source commit-graph maintenance:"))
                .count(),
            1
        );
        assert!(repository
            .path()
            .join(".git/objects/info/commit-graphs/commit-graph-chain")
            .is_file());
        assert!(!imported_repo
            .path()
            .join(".git/objects/info/commit-graphs/commit-graph-chain")
            .exists());
    }

    #[test]
    fn target_moved_retains_its_code_and_retryability_on_both_transports() {
        let error = integration_command_error(IntegrationError::TargetMoved {
            expected: "old".into(),
            actual: Some("new".into()),
        });
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({
                "code": "target_moved", "message": "target moved: expected old, actual Some(\"new\")", "retryable": true,
            })
        );
        let problem: cognia_problem::Problem = error.into();
        let value = serde_json::to_value(problem).unwrap();
        assert_eq!(value["code"], "target_moved");
        assert_eq!(value["retryable"], true);
        let error = changeset_command_error(ChangesetError::StaleHead {
            expected: "old".into(),
            actual: "new".into(),
        });
        assert_eq!(error.code, "stale_head");
        assert!(!error.retryable);
    }

    #[test]
    fn scm_host_commands_capture_gate_publish_and_rollback() {
        use cognia_task_workspace::{
            ChangesetCheckOutcome, ChangesetReviewVerdict, ChangesetReviewer, ChangesetRiskTier,
            ChangesetState, IntegrationConflictPolicy, IntegrationStrategy,
        };
        let _guard = test_guard();
        let data = TempDir::new().unwrap();
        let repository = TempDir::new().unwrap();
        run_git(repository.path(), &["init", "-b", "main"]);
        run_git(repository.path(), &["config", "user.name", "Cognia Test"]);
        run_git(
            repository.path(),
            &["config", "user.email", "cognia@example.com"],
        );
        run_git(
            repository.path(),
            &["commit", "--allow-empty", "-m", "seed"],
        );
        let service = Arc::new(
            TaskWorkspaceService::open(ServiceConfig::new(data.path().to_path_buf())).unwrap(),
        );
        let run = service
            .begin_run(begin_input(&repository, "scm-run"))
            .unwrap();
        std::fs::write(
            Path::new(&run.execution_root).join("change.txt"),
            "agent change\n",
        )
        .unwrap();
        *slot().write() = Some(service);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            assert!(task_workspace_changeset_get("missing".into())
                .await
                .unwrap()
                .is_none());
            assert!(task_workspace_integration_get("missing".into())
                .await
                .unwrap()
                .is_none());
            assert_eq!(
                task_workspace_changeset_eligibility("missing".into())
                    .await
                    .unwrap_err()
                    .code,
                "not_found"
            );
            let captured = task_workspace_changeset_capture(CaptureChangeset {
                workspace_id: run.workspace_id.clone().unwrap(),
                target_ref: Some("refs/heads/main".into()),
                title: "Agent change".into(),
                depends_on: vec![],
                required_checks: vec!["test".into()],
                changeset_id: None,
            })
            .await
            .unwrap();
            let id = captured.changeset_id.clone();
            let eligibility = task_workspace_changeset_eligibility(id.clone())
                .await
                .unwrap();
            assert!(!eligibility.eligible);
            assert!(eligibility.gaps.contains(&EligibilityGap::MissingReview));
            assert!(serde_json::to_value(&eligibility).unwrap().is_object());
            assert_eq!(
                task_workspace_changeset_get(id.clone()).await.unwrap(),
                Some(captured.clone())
            );
            assert_eq!(
                task_workspace_changeset_list(ChangesetFilter::default())
                    .await
                    .unwrap(),
                vec![captured.clone()]
            );
            task_workspace_changeset_mark_ready(id.clone())
                .await
                .unwrap();
            task_workspace_changeset_record_review(
                id.clone(),
                ChangesetReview {
                    head_sha: captured.head_sha.clone(),
                    verdict: ChangesetReviewVerdict::Approve,
                    reviewer: ChangesetReviewer::User,
                    risk_tier: ChangesetRiskTier::Low,
                    reasons: vec![],
                    findings: vec![],
                    requires_human_approval: true,
                    recorded_at: 1,
                },
            )
            .await
            .unwrap();
            let check = |sha: &str| ChangesetCheck {
                head_sha: sha.into(),
                profile_id: "test".into(),
                outcome: ChangesetCheckOutcome::Passed,
                tier: None,
                report_digest: None,
                log_tail: None,
                ran_at: 1,
            };
            let stale = task_workspace_changeset_record_check(id.clone(), check("stale"))
                .await
                .unwrap_err();
            assert_eq!(stale.code, "stale_head");
            task_workspace_changeset_record_check(id.clone(), check(&captured.head_sha))
                .await
                .unwrap();
            task_workspace_changeset_approve(
                id.clone(),
                captured.head_sha.clone(),
                "reviewer".into(),
            )
            .await
            .unwrap();
            assert!(
                task_workspace_changeset_eligibility(id.clone())
                    .await
                    .unwrap()
                    .eligible
            );
            let analysis = task_workspace_integration_analyze(vec![id.clone()], None)
                .await
                .unwrap();
            assert_eq!(analysis.order, vec![id.clone()]);
            let prepared = task_workspace_integration_prepare(PrepareIntegration {
                changeset_ids: vec![id.clone()],
                required_checks: Vec::new(),
                target_ref: "refs/heads/main".into(),
                strategy: IntegrationStrategy::Merge,
                on_conflict: IntegrationConflictPolicy::Stop,
                provisioning: None,
                integration_id: None,
            })
            .await
            .unwrap();
            let integration_id = prepared.integration_id.clone();
            assert_eq!(
                task_workspace_integration_get(integration_id.clone())
                    .await
                    .unwrap(),
                Some(prepared.clone())
            );
            for filter in [
                serde_json::json!({}),
                serde_json::json!({"repoCommonDir": captured.repo_common_dir}),
                serde_json::json!({"targetRef": "refs/heads/main", "states": ["prepared"]}),
            ] {
                assert_eq!(
                    task_workspace_integration_list(serde_json::from_value(filter).unwrap())
                        .await
                        .unwrap(),
                    vec![prepared.clone()]
                );
            }
            for filter in [
                serde_json::json!({"repoCommonDir":"elsewhere"}),
                serde_json::json!({"targetRef":"refs/heads/other"}),
                serde_json::json!({"states": []}),
                serde_json::json!({"states":["published"]}),
            ] {
                assert!(
                    task_workspace_integration_list(serde_json::from_value(filter).unwrap())
                        .await
                        .unwrap()
                        .is_empty()
                );
            }
            let candidate = prepared.candidate_sha.unwrap();
            assert_eq!(
                task_workspace_integration_publish(integration_id.clone(), "stale".into(), vec![])
                    .await
                    .unwrap_err()
                    .code,
                "stale_candidate"
            );
            assert_eq!(
                task_workspace_integration_publish(
                    integration_id.clone(),
                    candidate.clone(),
                    vec!["test".into()]
                )
                .await
                .unwrap_err()
                .code,
                "checks"
            );
            task_workspace_integration_record_check(
                integration_id.clone(),
                candidate.clone(),
                check(&candidate),
            )
            .await
            .unwrap();
            let published = task_workspace_integration_publish(
                integration_id.clone(),
                candidate,
                vec!["test".into()],
            )
            .await
            .unwrap();
            assert_eq!(published.state, IntegrationState::Published);
            assert_eq!(
                std::fs::read_to_string(repository.path().join("change.txt")).unwrap(),
                "agent change\n"
            );
            let rolled_back = task_workspace_integration_rollback(integration_id)
                .await
                .unwrap();
            assert_eq!(rolled_back.state, IntegrationState::RolledBack);
            assert!(!repository.path().join("change.txt").exists());
            assert_eq!(
                task_workspace_changeset_get(id)
                    .await
                    .unwrap()
                    .unwrap()
                    .state,
                ChangesetState::RolledBack
            );
            let abandoned = task_workspace_changeset_capture(CaptureChangeset {
                workspace_id: run.workspace_id.unwrap(),
                target_ref: Some("refs/heads/main".into()),
                title: "Abandoned change".into(),
                depends_on: vec![],
                required_checks: vec![],
                changeset_id: None,
            })
            .await
            .unwrap();
            assert_eq!(
                task_workspace_changeset_abandon(abandoned.changeset_id)
                    .await
                    .unwrap()
                    .state,
                ChangesetState::Abandoned
            );
            assert_eq!(
                task_workspace_integration_rebuild("missing".into())
                    .await
                    .unwrap_err()
                    .code,
                "not_found"
            );
            assert_eq!(
                task_workspace_integration_drop_item("missing".into(), "missing".into())
                    .await
                    .unwrap_err()
                    .code,
                "not_found"
            );
            assert_eq!(
                task_workspace_integration_abort("missing".into())
                    .await
                    .unwrap_err()
                    .code,
                "not_found"
            );
        });
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

    #[tokio::test]
    // The installed workspace service is process-global test state and stays
    // serialized through the asynchronous maintenance pass.
    #[allow(clippy::await_holding_lock)]
    async fn maintenance_pass_runs_immediately_against_the_installed_registry() {
        let _guard = test_guard();
        let data = TempDir::new().unwrap();
        install(data.path().to_path_buf()).unwrap();

        let result = run_workspace_maintenance_once().await.unwrap();

        assert!(result.reclaimed_workspace_ids.is_empty());
        assert!(result.expired_snapshot_task_ids.is_empty());
        assert_eq!(result.removed_blob_count, 0);
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn generic_worktree_remove_fails_closed_for_external_inventory() {
        let _guard = test_guard();
        let data = TempDir::new().unwrap();
        let repository = TempDir::new().unwrap();
        let worktrees = TempDir::new().unwrap();
        let external = worktrees.path().join("external");
        run_git(repository.path(), &["init"]);
        run_git(repository.path(), &["config", "user.name", "Cognia Test"]);
        run_git(
            repository.path(),
            &["config", "user.email", "cognia@example.com"],
        );
        std::fs::write(repository.path().join("README.md"), "seed\n").unwrap();
        run_git(repository.path(), &["add", "README.md"]);
        run_git(repository.path(), &["commit", "-m", "seed"]);
        let external_arg = external.to_string_lossy().into_owned();
        run_git(
            repository.path(),
            &["worktree", "add", "--detach", &external_arg],
        );
        install(data.path().to_path_buf()).unwrap();

        let error = git_worktree_remove(
            repository.path().to_string_lossy().into_owned(),
            external_arg,
            true,
            None,
        )
        .await
        .unwrap_err();

        assert!(error.contains("is owned by workspace"));
        assert!(external.exists());
        let records = task_workspace_managed_list().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].environment_kind,
            cognia_task_workspace::WorkspaceEnvironmentKind::Imported
        );
    }

    #[tokio::test]
    async fn branch_rollback_restores_detached_head_and_removes_created_branch() {
        let repository = TempDir::new().unwrap();
        run_git(repository.path(), &["init"]);
        run_git(repository.path(), &["config", "user.name", "Cognia Test"]);
        run_git(
            repository.path(),
            &["config", "user.email", "cognia@example.com"],
        );
        std::fs::write(repository.path().join("README.md"), "seed\n").unwrap();
        run_git(repository.path(), &["add", "README.md"]);
        run_git(repository.path(), &["commit", "-m", "seed"]);
        let old_head = cognia_git::exec::capture(repository.path(), ["rev-parse", "HEAD"])
            .await
            .unwrap();
        let root = repository.path().to_string_lossy().into_owned();
        cognia_git::worktree::create_branch_here(&root, "feature/rollback")
            .await
            .unwrap();

        rollback_workspace_branch(&root, "feature/rollback", old_head.trim())
            .await
            .unwrap();

        let current = cognia_git::exec::capture(repository.path(), ["rev-parse", "HEAD"])
            .await
            .unwrap();
        assert_eq!(current.trim(), old_head.trim());
        let branch =
            cognia_git::exec::capture(repository.path(), ["branch", "--list", "feature/rollback"])
                .await
                .unwrap();
        assert!(branch.trim().is_empty());
    }

    #[tokio::test]
    async fn branch_delete_detaches_at_the_same_commit_and_is_idempotent() {
        let repository = TempDir::new().unwrap();
        run_git(repository.path(), &["init"]);
        run_git(repository.path(), &["config", "user.name", "Cognia Test"]);
        run_git(
            repository.path(),
            &["config", "user.email", "cognia@example.com"],
        );
        std::fs::write(repository.path().join("README.md"), "seed\n").unwrap();
        run_git(repository.path(), &["add", "README.md"]);
        run_git(repository.path(), &["commit", "-m", "seed"]);
        let root = repository.path().to_string_lossy().into_owned();
        cognia_git::worktree::create_branch_here(&root, "agent/run/alice/task")
            .await
            .unwrap();
        std::fs::write(repository.path().join("work.txt"), "agent\n").unwrap();
        run_git(repository.path(), &["add", "work.txt"]);
        run_git(repository.path(), &["commit", "-m", "agent work"]);
        let head = cognia_git::exec::capture(repository.path(), ["rev-parse", "HEAD"])
            .await
            .unwrap();

        delete_workspace_branch(&root, "agent/run/alice/task")
            .await
            .unwrap();

        let current = cognia_git::exec::capture(repository.path(), ["rev-parse", "HEAD"])
            .await
            .unwrap();
        assert_eq!(current.trim(), head.trim());
        let branch = cognia_git::exec::capture(
            repository.path(),
            ["branch", "--list", "agent/run/alice/task"],
        )
        .await
        .unwrap();
        assert!(branch.trim().is_empty());
        // A retry after the branch is gone still succeeds.
        delete_workspace_branch(&root, "agent/run/alice/task")
            .await
            .unwrap();

        // Off the branch, commits only the branch holds are never stranded.
        cognia_git::worktree::create_branch_here(&root, "agent/run/bob/task")
            .await
            .unwrap();
        std::fs::write(repository.path().join("bob.txt"), "bob\n").unwrap();
        run_git(repository.path(), &["add", "bob.txt"]);
        run_git(repository.path(), &["commit", "-m", "bob work"]);
        run_git(repository.path(), &["checkout", "--detach", head.trim()]);
        assert!(delete_workspace_branch(&root, "agent/run/bob/task")
            .await
            .is_err());
        let kept = cognia_git::exec::capture(
            repository.path(),
            ["branch", "--list", "agent/run/bob/task"],
        )
        .await
        .unwrap();
        assert!(!kept.trim().is_empty());
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
        assert_eq!(status.max_transfer_chunk_bytes, 64 * 1024);
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
            .acquire_workspace_bundle(cognia_task_workspace::AcquireWorkspaceBundle {
                requested_name: None,
                owner_type: cognia_task_workspace::WorkspaceOwnerType::Session,
                owner_ref: Some("session-test".into()),
                // This run belongs to no Workspace and the fixture repository
                // declares no provisioning — the case ADR-0147 documents as the
                // common one, and the only thing this test is exercising is what
                // a failing watcher does to a borrowed run.
                project_id: None,
                provisioning: None,
                environment_kind: cognia_task_workspace::WorkspaceEnvironmentKind::Managed,
                base: cognia_task_workspace::WorkspaceBaseSpec::WorkingState,
                roots: vec![cognia_task_workspace::WorkspaceBundleRootInput {
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
                .get_workspace_bundle(&bundle.bundle_id)
                .unwrap()
                .unwrap()
                .state,
            cognia_task_workspace::WorkspaceState::Active
        );
    }

    #[test]
    fn the_resource_index_lists_settled_agent_files_a_page_at_a_time() {
        let _guard = test_guard();
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let service = install(data.path().to_path_buf()).unwrap();
        let run = service
            .begin_run(begin_input(&workspace, "run-index"))
            .unwrap();
        let root = std::path::Path::new(&run.execution_root);
        for name in ["a.md", "b.md", "c.md"] {
            std::fs::write(root.join(name), name).unwrap();
        }
        service.settle_run("run-index").unwrap();

        let page = |token: Option<&str>| {
            cognia_problem::paging::PageRequest::from_parts(Some(2), token)
                .map(|page| resource_index_page(&service, &page))
        };
        let first = page(None).unwrap().unwrap();
        assert_eq!(first.items.len(), 2);
        let token = first.next_page_token.clone().expect("a second page");
        let second = page(Some(&token)).unwrap().unwrap();
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.next_page_token, None);

        let mut paths: Vec<_> = first
            .items
            .iter()
            .chain(&second.items)
            .map(|entry| entry.path.clone())
            .collect();
        paths.sort();
        assert_eq!(paths, ["a.md", "b.md", "c.md"]);
        let entry = &second.items[0];
        assert_eq!(entry.session_id, "session-test");
        assert_eq!(entry.execution_root, run.execution_root);
        assert_eq!(
            std::path::Path::new(&entry.workspace_root),
            workspace.path().canonicalize().unwrap()
        );
        assert_eq!(entry.kind, cognia_task_workspace::ChangeKind::Created);
        // Settled, not applied: the file is in the run's own root.
        assert_eq!(
            entry.adoption,
            cognia_task_workspace::ResourceAdoption::Pending
        );
        assert!(page(Some("nonsense")).is_err());
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
            task_workspace_list_resource_events("run-resource".into(), Some(10), None).unwrap();
        let summary = task_workspace_get_resource_summary("run-resource".into()).unwrap();
        let manifest = task_workspace_export_resource_manifest(
            "task-test".into(),
            Some("run-resource".into()),
        )
        .unwrap();

        assert_eq!(event.path.as_deref(), Some("output/result.txt"));
        assert_eq!(event.tool_call_id.as_deref(), Some("tool-call-1"));
        assert!(events.items.iter().any(|candidate| candidate == &event));
        assert_eq!(events.next_page_token, None);
        assert_eq!(summary.event_count, 1);
        assert_eq!(summary.counts.created, 1);
        assert_eq!(manifest.events, vec![event]);
        assert_eq!(manifest.summaries, vec![summary]);
    }

    /// ADR-0176. The legacy sweep must take the orphaned cache and nothing
    /// else. The worktrees beside it are live workspaces, and a "cleanup" that
    /// deleted the directory someone is working in would be worse than the
    /// wasted disk it set out to reclaim.
    #[tokio::test]
    async fn the_legacy_sweep_takes_the_cache_and_leaves_the_worktrees() {
        let base = TempDir::new().unwrap();
        let legacy = base.path().join(LEGACY_RELATIVE_CACHE);
        std::fs::create_dir_all(legacy.join("github.com-o-r.git")).unwrap();
        let worktree = base.path().join("cognia-github-worktrees").join("o-r");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(worktree.join("README.md"), "live work").unwrap();

        discard_cache_at(&legacy).await;

        assert!(!legacy.exists(), "the orphaned cache was not reclaimed");
        assert!(
            worktree.join("README.md").exists(),
            "the sweep took a live worktree with it"
        );
    }

    /// A working directory that never held the legacy cache finds nothing, and
    /// says nothing about it. The sweep runs on every host at every boot, and
    /// most of them have no such directory.
    #[tokio::test]
    async fn the_legacy_sweep_is_silent_when_there_is_nothing_to_sweep() {
        let base = TempDir::new().unwrap();
        let absent = base.path().join(LEGACY_RELATIVE_CACHE);

        discard_cache_at(&absent).await;

        assert!(!absent.exists());
        assert!(base.path().exists(), "the sweep must not touch its parent");
    }

    /// Once per process. The loop runs daily, and after the first pass the path
    /// belongs to whoever recreated it, not to us.
    #[tokio::test]
    async fn the_legacy_sweep_runs_once() {
        LEGACY_CACHE_SWEPT.store(true, Ordering::Release);
        discard_the_legacy_relative_cache().await;
        assert!(LEGACY_CACHE_SWEPT.load(Ordering::Acquire));
    }

    /// ADR-0176. The mirror cache root is dormant unless boot points it at the
    /// data directory: `cognia_git_mirror::root()` otherwise answers with a
    /// temp-dir fallback, and every clone would cache somewhere the day-long
    // ── the revision commands (WP-D6's crate API, reached from TS) ───────────
    //
    // The crate's own suite proves the CAS and the confinement. What these pin
    // is the command layer: that each one reaches the right crate function
    // with the caller's arguments, that `whole` picks the report read rather
    // than the truncating one, and that a failure comes back as a value the
    // renderer can act on instead of a panic.
    use cognia_task_workspace::ConfinedReadStatus;
    use sha2::Digest as _;

    fn patch(base: &str, path: &str, content: &str) -> RevisionPatch {
        RevisionPatch {
            format: cognia_task_workspace::REVISION_PATCH_FORMAT.to_string(),
            base_revision: base.to_string(),
            files: vec![cognia_task_workspace::RevisionPatchFile {
                path: path.to_string(),
                action: cognia_task_workspace::RevisionPatchAction::Write,
                content: Some(content.to_string()),
                content_sha256: Some(hex::encode(sha2::Sha256::digest(content.as_bytes()))),
            }],
        }
    }

    #[tokio::test]
    async fn revision_get_answers_the_root_it_was_given() {
        let workspace = TempDir::new().unwrap();
        std::fs::write(workspace.path().join("a.txt"), "one").unwrap();
        let root = workspace.path().to_string_lossy().to_string();

        let revision = task_workspace_revision_get(root.clone()).await.unwrap();
        assert!(revision.revision.starts_with("wsrev1:"));
        assert_eq!(revision.file_count, 1);

        // The same tree is the same revision; a changed tree is not.
        assert_eq!(
            task_workspace_revision_get(root.clone()).await.unwrap(),
            revision
        );
        std::fs::write(workspace.path().join("b.txt"), "two").unwrap();
        let moved = task_workspace_revision_get(root).await.unwrap();
        assert_ne!(moved.revision, revision.revision);
        assert_eq!(moved.file_count, 2);
    }

    #[tokio::test]
    async fn revision_apply_writes_on_its_base_and_conflicts_once_the_tree_moved() {
        let workspace = TempDir::new().unwrap();
        std::fs::write(workspace.path().join("a.txt"), "one").unwrap();
        let root = workspace.path().to_string_lossy().to_string();
        let base = task_workspace_revision_get(root.clone())
            .await
            .unwrap()
            .revision;

        let applied = task_workspace_revision_apply(root.clone(), patch(&base, "a.txt", "two"))
            .await
            .unwrap();
        assert_eq!(
            applied.status,
            cognia_task_workspace::RevisionApplyStatus::Applied
        );
        assert_eq!(applied.written, vec!["a.txt".to_string()]);
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("a.txt")).unwrap(),
            "two"
        );

        // The same patch against the revision it was cut from no longer fits:
        // nothing is written, and the caller is told where the tree is now.
        let conflict = task_workspace_revision_apply(root.clone(), patch(&base, "a.txt", "three"))
            .await
            .unwrap();
        assert_eq!(
            conflict.status,
            cognia_task_workspace::RevisionApplyStatus::Conflict
        );
        assert!(conflict.written.is_empty());
        assert_eq!(
            conflict.current_revision,
            Some(applied.current_revision.clone().unwrap())
        );
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("a.txt")).unwrap(),
            "two"
        );

        // A patch this host does not speak is refused with its reason, never
        // half-written.
        let mut alien = patch(&base, "a.txt", "four");
        alien.format = "someone-elses-patch".into();
        let refused = task_workspace_revision_apply(root, alien).await.unwrap();
        assert_eq!(
            refused.status,
            cognia_task_workspace::RevisionApplyStatus::Refused
        );
        assert!(refused.refusal.is_some());
    }

    #[tokio::test]
    async fn revision_read_truncates_text_and_refuses_an_oversized_report() {
        let workspace = TempDir::new().unwrap();
        std::fs::write(workspace.path().join("notes.txt"), "abcdefghij").unwrap();
        let root = workspace.path().to_string_lossy().to_string();

        // The text read is bounded and says when it stopped early.
        let cut = task_workspace_revision_read(root.clone(), "notes.txt".into(), Some(4), None)
            .await
            .unwrap();
        assert_eq!(cut.status, ConfinedReadStatus::Ok);
        assert_eq!(cut.content.as_deref(), Some("abcd"));
        assert!(cut.truncated);
        assert_eq!(cut.size_bytes, 10);

        // The report read is whole or nothing: a cut JUnit file is a parse
        // error, not a smaller report.
        let too_large =
            task_workspace_revision_read(root.clone(), "notes.txt".into(), Some(4), Some(true))
                .await
                .unwrap();
        assert_eq!(too_large.status, ConfinedReadStatus::TooLarge);
        assert!(too_large.content.is_none());

        let whole =
            task_workspace_revision_read(root.clone(), "notes.txt".into(), None, Some(true))
                .await
                .unwrap();
        assert_eq!(whole.status, ConfinedReadStatus::Ok);
        assert_eq!(whole.content.as_deref(), Some("abcdefghij"));
        assert!(!whole.truncated);

        // A command that wrote no report at all is `missing`, which is what
        // lets a run be called inconclusive instead of passed (DEL-02).
        let missing =
            task_workspace_revision_read(root.clone(), "report.xml".into(), None, Some(true))
                .await
                .unwrap();
        assert_eq!(missing.status, ConfinedReadStatus::Missing);

        // And a path that leaves the root never reads anything.
        let escape = task_workspace_revision_read(root, "../secrets.txt".into(), None, None)
            .await
            .unwrap();
        assert_eq!(escape.status, ConfinedReadStatus::Refused);
        assert!(escape.content.is_none());
    }

    #[tokio::test]
    async fn revision_commands_answer_an_unusable_root_as_an_error() {
        let missing = TempDir::new().unwrap().path().join("gone");
        let root = missing.to_string_lossy().to_string();
        assert!(task_workspace_revision_get(root.clone()).await.is_err());
        assert!(
            task_workspace_revision_read(root, "a.txt".into(), None, None)
                .await
                .is_err()
        );
    }

    /// sweep never looks. `install` is the one seam both hosts pass through, so
    /// pinning it here pins it for the desktop shell and `cognia-server` alike.
    #[test]
    fn install_points_the_mirror_cache_at_the_data_directory() {
        let _guard = test_guard();
        let data = TempDir::new().unwrap();
        install(data.path().to_path_buf()).unwrap();

        let root = cognia_git_mirror::root();
        assert!(
            root.ends_with("task-workspaces/mirrors"),
            "the cache must sit under the task-workspace data directory, got {}",
            root.display()
        );
        assert!(
            !root.starts_with(std::env::temp_dir().join("cognia-git-mirrors")),
            "boot must beat the unset fallback"
        );
    }
}
