use crate::{
    ledger,
    resource::{is_sensitive_resource, media_type_for},
    snapshot::{
        capture_with_policy, materialize, EntryKind, GeneratedSnapshotEntry, SnapshotEntry,
        WorkspaceSnapshot,
    },
    store::WorkspaceStore,
    tracking::resolve_tracking_policy,
    BeginTaskRun, ChangeKind, ContributionOrigin, DownloadHandle, IsolationKind,
    ResourceCaptureClass, ResourceChange, ResourceEvent, ResourceEventEvidence, ResourceEventKind,
    ResourceKind, RunState, TaskResourceManifest, TaskResourceSummary, TaskRun, TaskWorkspace,
    TaskWorkspaceEventSink, TaskWorkspaceResourceEvent, TaskWorkspaceState, TransferChunk,
    TransferRegistry, UploadHandle, WatchManager,
};
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct ServiceConfig {
    pub data_dir: PathBuf,
    pub retention: Duration,
    pub max_blob_bytes: u64,
}

impl ServiceConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            retention: Duration::from_secs(30 * 24 * 60 * 60),
            max_blob_bytes: 1024 * 1024 * 1024,
        }
    }
}

pub struct TaskWorkspaceService {
    store: Arc<Mutex<WorkspaceStore>>,
    execution_dir: PathBuf,
    manifest_key: Vec<u8>,
    retention: Duration,
    transfers: TransferRegistry,
    upload_owners: Mutex<HashMap<String, UploadOwner>>,
    origin_hints: Mutex<HashMap<(String, String), ContributionOrigin>>,
    watchers: WatchManager,
}

#[derive(Clone)]
struct UploadOwner {
    run_id: String,
    path: String,
    existed: bool,
}

impl TaskWorkspaceService {
    pub fn open(config: ServiceConfig) -> Result<Self, String> {
        let service_dir = config.data_dir.join("task-workspaces");
        let execution_dir = service_dir.join("executions");
        fs::create_dir_all(&execution_dir).map_err(|error| {
            format!("create execution dir {}: {error}", execution_dir.display())
        })?;
        let service = Self {
            store: Arc::new(Mutex::new(WorkspaceStore::open(
                &service_dir,
                config.max_blob_bytes,
            )?)),
            execution_dir,
            manifest_key: load_or_create_manifest_key(&service_dir)?,
            retention: config.retention,
            transfers: TransferRegistry::new(Duration::from_secs(5 * 60)),
            upload_owners: Mutex::new(HashMap::new()),
            origin_hints: Mutex::new(HashMap::new()),
            watchers: WatchManager::new(),
        };
        service.recover_incomplete_runs()?;
        Ok(service)
    }

    pub fn begin_run(&self, input: BeginTaskRun) -> Result<TaskRun, String> {
        validate_id("taskId", &input.task_id)?;
        validate_id("runId", &input.run_id)?;
        if let Some(workspace_key) = input.workspace_key.as_deref() {
            validate_id("workspaceKey", workspace_key)?;
        }
        let root = PathBuf::from(&input.workspace_root)
            .canonicalize()
            .map_err(|error| format!("canonicalize workspace {}: {error}", input.workspace_root))?;
        if !root.is_dir() {
            return Err(format!("workspace is not a directory: {}", root.display()));
        }
        let tracking_policy = resolve_tracking_policy(&root, &input.tracking_policy)?;
        {
            let store = self.store.lock();
            if let Some((existing, _)) = store.get_run::<WorkspaceSnapshot>(&input.run_id)? {
                let task = store
                    .get_task(&existing.task_id)?
                    .ok_or_else(|| format!("missing task: {}", existing.task_id))?;
                let matches_request = existing.task_id == input.task_id
                    && existing.parent_run_id == input.parent_run_id
                    && existing.agent_id == input.agent_id
                    && existing.agent_kind == input.agent_kind
                    && existing.workspace_key == input.workspace_key
                    && existing.execution_run_id == input.execution_run_id
                    && existing.trace_id == input.trace_id
                    && existing.turn_id == input.turn_id
                    && existing.attempt_id == input.attempt_id
                    && existing.provider_attempt_id == input.provider_attempt_id
                    && existing.surface == input.surface
                    && existing.tracking_policy == tracking_policy
                    && task.session_id == input.session_id
                    && Path::new(&task.workspace_root) == root;
                return matches_request.then_some(existing).ok_or_else(|| {
                    format!(
                        "runId is already owned by another task run: {}",
                        input.run_id
                    )
                });
            }
        }
        let now = now_ms();
        let reusable = if let Some(workspace_key) = input.workspace_key.as_deref() {
            let runs = self.store.lock().list_runs(&input.task_id)?;
            if runs.iter().any(|run| {
                run.workspace_key.as_deref() == Some(workspace_key)
                    && matches!(run.state, RunState::Running | RunState::Settling)
            }) {
                return Err(format!(
                    "pipeline workspace is already active: {workspace_key}"
                ));
            }
            runs.into_iter().rev().find(|run| {
                run.workspace_key.as_deref() == Some(workspace_key) && run.state == RunState::Ready
            })
        } else {
            None
        };
        let (baseline, blobs, execution_root, isolation_kind, isolation_ref, owns_execution) =
            if let Some(previous) = reusable {
                let execution_root = PathBuf::from(&previous.execution_root);
                if !execution_root.is_dir() {
                    return Err(format!(
                        "pipeline workspace is unavailable: {}",
                        execution_root.display()
                    ));
                }
                let (baseline, blobs) = capture_with_policy(&execution_root, &tracking_policy)?;
                (
                    baseline,
                    blobs,
                    execution_root,
                    previous.isolation_kind,
                    previous.isolation_ref,
                    false,
                )
            } else {
                let (mut baseline, blobs) = capture_with_policy(&root, &tracking_policy)?;
                // A fresh isolated execution root intentionally starts without
                // ignored build outputs. Treat the generated baseline as empty
                // so pre-existing host artifacts are not reported as deletions.
                baseline.generated_entries.clear();
                let execution_root = self
                    .execution_dir
                    .join(storage_key(&input.task_id))
                    .join(storage_key(&input.run_id));
                if execution_root.exists() {
                    return Err(format!(
                        "run already has an execution root: {}",
                        input.run_id
                    ));
                }
                let (isolation_kind, isolation_ref) = create_execution(
                    &root,
                    &execution_root,
                    &input.task_id,
                    &input.run_id,
                    &baseline,
                    &blobs,
                )?;
                (
                    baseline,
                    blobs,
                    execution_root,
                    isolation_kind,
                    isolation_ref,
                    true,
                )
            };

        let mut store = self.store.lock();
        for (hash, bytes) in &blobs {
            if let Err(error) = store.put_blob(hash, bytes, now) {
                if owns_execution {
                    let _ = fs::remove_dir_all(&execution_root);
                }
                return Err(error);
            }
        }
        let mut task = store.get_task(&input.task_id)?.unwrap_or(TaskWorkspace {
            task_id: input.task_id.clone(),
            session_id: input.session_id.clone(),
            workspace_root: root.to_string_lossy().into_owned(),
            state: TaskWorkspaceState::Active,
            revision: 0,
            created_at: now,
            expires_at: now + self.retention.as_millis() as i64,
            pinned: false,
        });
        if task.workspace_root != root.to_string_lossy() {
            if owns_execution {
                let _ = fs::remove_dir_all(&execution_root);
            }
            return Err("one task cannot span multiple workspace roots".into());
        }
        task.state = TaskWorkspaceState::Active;
        task.expires_at = now + self.retention.as_millis() as i64;
        store.put_task(&task)?;
        let run = TaskRun {
            run_id: input.run_id,
            task_id: input.task_id,
            parent_run_id: input.parent_run_id,
            agent_id: input.agent_id,
            agent_kind: input.agent_kind,
            execution_root: execution_root.to_string_lossy().into_owned(),
            isolation_kind,
            isolation_ref,
            workspace_key: input.workspace_key,
            execution_run_id: input.execution_run_id,
            trace_id: input.trace_id,
            turn_id: input.turn_id,
            attempt_id: input.attempt_id,
            provider_attempt_id: input.provider_attempt_id,
            surface: input.surface,
            tracking_policy,
            baseline_revision: task.revision,
            state: RunState::Running,
            created_at: now,
            settled_at: None,
        };
        store.put_run(&run, &baseline)?;
        Ok(run)
    }

    pub fn settle_run(&self, run_id: &str) -> Result<Vec<ResourceChange>, String> {
        // Stop drains queued notifications and joins the watcher before the
        // authoritative snapshot, preventing provisional events after settle.
        let _ = self.watchers.stop(run_id);
        let now = now_ms();
        let mut store = self.store.lock();
        let (mut run, baseline): (TaskRun, WorkspaceSnapshot) = store
            .get_run(run_id)?
            .ok_or_else(|| format!("unknown task run: {run_id}"))?;
        if !matches!(
            run.state,
            RunState::Running | RunState::Settling | RunState::Ready
        ) {
            return store.list_run_resources(run_id);
        }
        if run.state == RunState::Ready {
            return store.list_run_resources(run_id);
        }
        run.state = RunState::Settling;
        store.put_run(&run, &baseline)?;
        let (current, blobs) =
            capture_with_policy(Path::new(&run.execution_root), &run.tracking_policy)?;
        for (hash, bytes) in &blobs {
            store.put_blob(hash, bytes, now)?;
        }
        let mut task = store
            .get_task(&run.task_id)?
            .ok_or_else(|| format!("missing task: {}", run.task_id))?;
        task.revision = task.revision.saturating_add(1);
        let origin_hints = self.origin_hints.lock();
        let mut context = ReconcileContext {
            store: &mut store,
            revision: task.revision,
            run_id: &run.run_id,
            agent_id: &run.agent_id,
            origin_hints: &origin_hints,
            now,
        };
        let mut changes = reconcile(&baseline, &current, &mut context)?;
        changes.extend(reconcile_generated(
            &baseline.generated_entries,
            &current.generated_entries,
            task.revision,
            &run,
        ));
        changes.sort_by(|left, right| left.path.cmp(&right.path));
        drop(origin_hints);
        run.state = RunState::Ready;
        run.settled_at = Some(now);
        task.expires_at = now + self.retention.as_millis() as i64;
        store.replace_resources(&task.task_id, &run.run_id, task.revision, &changes)?;
        let scratch = self
            .execution_dir
            .parent()
            .unwrap_or(&self.execution_dir)
            .join("scratch");
        let source_changes = changes
            .iter()
            .filter(|change| change.capture_class == ResourceCaptureClass::Source)
            .cloned()
            .collect::<Vec<_>>();
        let patch = ledger::build_patch_set(
            &task.task_id,
            &run.run_id,
            run.baseline_revision,
            &source_changes,
            &mut store,
            &scratch,
            now,
        )?;
        store.put_patch_set(&patch)?;
        append_missing_reconcile_events(&mut store, &run, &changes, now)?;
        store.reconcile_resource_events(&run.run_id)?;
        store.put_run(&run, &baseline)?;
        task.state = if store
            .list_runs(&task.task_id)?
            .iter()
            .any(|candidate| matches!(candidate.state, RunState::Running | RunState::Settling))
        {
            TaskWorkspaceState::Active
        } else {
            TaskWorkspaceState::Ready
        };
        store.put_task(&task)?;
        Ok(changes)
    }

    pub fn settle_failed_run(&self, run_id: &str) -> Result<Vec<ResourceChange>, String> {
        let resources = self.settle_run(run_id)?;
        self.set_run_terminal_state(run_id, RunState::Failed)?;
        Ok(resources)
    }

    pub fn settle_cancelled_run(&self, run_id: &str) -> Result<Vec<ResourceChange>, String> {
        let resources = self.settle_run(run_id)?;
        self.set_run_terminal_state(run_id, RunState::Cancelled)?;
        Ok(resources)
    }

    fn recover_incomplete_runs(&self) -> Result<(), String> {
        let run_ids = {
            let store = self.store.lock();
            let mut run_ids = Vec::new();
            for task in store.list_tasks()? {
                run_ids.extend(
                    store
                        .list_runs(&task.task_id)?
                        .into_iter()
                        .filter(|run| matches!(run.state, RunState::Running | RunState::Settling))
                        .map(|run| run.run_id),
                );
            }
            run_ids
        };
        for run_id in run_ids {
            if self.settle_failed_run(&run_id).is_err() {
                let _ = self.set_run_terminal_state(&run_id, RunState::Failed);
            }
        }
        Ok(())
    }

    fn set_run_terminal_state(&self, run_id: &str, state: RunState) -> Result<(), String> {
        if !matches!(
            state,
            RunState::Ready | RunState::Failed | RunState::Cancelled
        ) {
            return Err(format!("invalid terminal task run state: {state:?}"));
        }
        let store = self.store.lock();
        let (mut run, baseline): (TaskRun, WorkspaceSnapshot) = store
            .get_run(run_id)?
            .ok_or_else(|| format!("unknown task run: {run_id}"))?;
        run.state = state;
        run.settled_at.get_or_insert_with(now_ms);
        store.put_run(&run, &baseline)
    }

    pub fn get_task(&self, task_id: &str) -> Result<Option<TaskWorkspace>, String> {
        self.store.lock().get_task(task_id)
    }

    pub fn list_tasks(&self, session_id: Option<&str>) -> Result<Vec<TaskWorkspace>, String> {
        let mut tasks = self.store.lock().list_tasks()?;
        if let Some(session_id) = session_id {
            tasks.retain(|task| task.session_id == session_id);
        }
        tasks.sort_by_key(|task| std::cmp::Reverse(task.created_at));
        Ok(tasks)
    }

    pub fn set_task_pinned(&self, task_id: &str, pinned: bool) -> Result<TaskWorkspace, String> {
        let store = self.store.lock();
        let mut task = store
            .get_task(task_id)?
            .ok_or_else(|| format!("unknown task workspace: {task_id}"))?;
        task.pinned = pinned;
        store.put_task(&task)?;
        Ok(task)
    }

    pub fn list_resource_events(
        &self,
        run_id: &str,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<Vec<ResourceEvent>, String> {
        self.store
            .lock()
            .list_resource_events(run_id, cursor, limit)
    }

    pub fn record_tool_event(
        &self,
        run_id: &str,
        path: &str,
        old_path: Option<&str>,
        kind: ResourceEventKind,
        tool_call_id: Option<&str>,
    ) -> Result<ResourceEvent, String> {
        if !matches!(
            kind,
            ResourceEventKind::Created
                | ResourceEventKind::Modified
                | ResourceEventKind::Deleted
                | ResourceEventKind::Renamed
        ) {
            return Err(format!("invalid tool resource event kind: {kind:?}"));
        }
        validate_event_relative_path(path)?;
        if let Some(old_path) = old_path {
            validate_event_relative_path(old_path)?;
        }
        let run = self
            .store
            .lock()
            .get_run::<WorkspaceSnapshot>(run_id)?
            .map(|(run, _)| run)
            .ok_or_else(|| format!("unknown task run: {run_id}"))?;
        let change = crate::ResourceEventChange {
            path: path.to_string(),
            kind,
            old_path: old_path.map(str::to_string),
        };
        let mut event = watcher_resource_event(&run, &change, now_ms());
        event.evidence = ResourceEventEvidence::Tool;
        event.tool_call_id = tool_call_id.map(str::to_string);
        let mut events = vec![event];
        self.store.lock().append_resource_events(&mut events)?;
        Ok(events.remove(0))
    }

    pub fn get_resource_summary(&self, run_id: &str) -> Result<TaskResourceSummary, String> {
        self.store.lock().resource_summary(run_id)
    }

    pub fn export_resource_manifest(
        &self,
        task_id: &str,
        run_id: Option<&str>,
    ) -> Result<TaskResourceManifest, String> {
        let store = self.store.lock();
        let mut task = store
            .get_task(task_id)?
            .ok_or_else(|| format!("unknown task workspace: {task_id}"))?;
        task.workspace_root = ".".into();
        let mut runs = store.list_runs(task_id)?;
        if let Some(run_id) = run_id {
            runs.retain(|run| run.run_id == run_id);
            if runs.is_empty() {
                return Err(format!("unknown task run: {run_id}"));
            }
        }
        for run in &mut runs {
            run.execution_root = ".".into();
            run.isolation_ref = None;
        }
        let run_ids = runs
            .iter()
            .map(|run| run.run_id.clone())
            .collect::<std::collections::HashSet<_>>();
        let mut resources = store
            .list_resources(task_id)?
            .into_iter()
            .filter(|resource| run_ids.contains(&resource.run_id))
            .collect::<Vec<_>>();
        for resource in &mut resources {
            redact_resource_change(resource, &self.manifest_key);
        }
        let mut events = Vec::new();
        let mut summaries = Vec::new();
        for run in &runs {
            let mut run_events = store.list_all_resource_events(&run.run_id)?;
            for event in &mut run_events {
                redact_resource_event(event, &self.manifest_key);
            }
            events.extend(run_events);
            summaries.push(store.resource_summary(&run.run_id)?);
        }
        Ok(TaskResourceManifest {
            schema_version: 1,
            exported_at: now_ms(),
            task,
            runs,
            resources,
            events,
            summaries,
        })
    }

    pub fn prune(&self) -> Result<crate::PruneOutcome, String> {
        let now = now_ms();
        let mut store = self.store.lock();
        let mut removed_task_ids = Vec::new();
        for task in store.list_tasks()? {
            if task.pinned || task.expires_at > now || !store.task_is_prunable(&task.task_id)? {
                continue;
            }
            for run in store.list_runs(&task.task_id)? {
                let execution_root = Path::new(&run.execution_root);
                match run.isolation_kind {
                    IsolationKind::GitWorktree => cleanup_git_worktree(
                        Path::new(&task.workspace_root),
                        execution_root,
                        run.isolation_ref.as_deref().unwrap_or_default(),
                    ),
                    IsolationKind::Shadow => {
                        if execution_root.exists() {
                            fs::remove_dir_all(execution_root).map_err(|error| {
                                format!(
                                    "remove execution root {}: {error}",
                                    execution_root.display()
                                )
                            })?;
                        }
                    }
                }
            }
            store.delete_task(&task.task_id)?;
            removed_task_ids.push(task.task_id);
        }
        let (removed_blob_count, reclaimed_bytes) = store.prune_unreferenced_blobs()?;
        Ok(crate::PruneOutcome {
            removed_task_ids,
            removed_blob_count,
            reclaimed_bytes,
        })
    }

    pub fn list_runs(&self, task_id: &str) -> Result<Vec<TaskRun>, String> {
        self.store.lock().list_runs(task_id)
    }

    pub fn list_resources(&self, task_id: &str) -> Result<Vec<ResourceChange>, String> {
        self.store.lock().list_resources(task_id)
    }

    pub fn get_patch_set(&self, run_id: &str) -> Result<Option<crate::PatchSet>, String> {
        self.store.lock().get_patch_set(run_id)
    }

    /// Restore the authoritative post-run snapshot into its managed execution
    /// root. This recreates historical chat state from content-addressed blobs
    /// and refuses to race a currently running turn on the same task.
    pub fn restore_run_snapshot(&self, run_id: &str) -> Result<TaskRun, String> {
        let (run, snapshot, blobs) = {
            let mut store = self.store.lock();
            let (run, mut snapshot) = store
                .get_run::<WorkspaceSnapshot>(run_id)?
                .ok_or_else(|| format!("unknown task run: {run_id}"))?;
            if store.list_runs(&run.task_id)?.iter().any(|candidate| {
                candidate.run_id != run.run_id
                    && matches!(candidate.state, RunState::Running | RunState::Settling)
            }) {
                return Err("cannot restore a snapshot while a task run is active".to_string());
            }
            let patch = store
                .get_patch_set(run_id)?
                .ok_or_else(|| format!("unknown patch set for run: {run_id}"))?;
            for file in patch.files {
                if let Some(old_path) = file.old_path.as_deref() {
                    snapshot.entries.remove(old_path);
                }
                match file.kind {
                    ChangeKind::Deleted => {
                        snapshot.entries.remove(&file.path);
                    }
                    ChangeKind::Created | ChangeKind::Modified | ChangeKind::Renamed => {
                        let hash = file
                            .after_hash
                            .ok_or_else(|| format!("missing restored hash for {}", file.path))?;
                        let bytes = store.get_blob(&hash, now_ms())?;
                        snapshot.entries.insert(
                            file.path.clone(),
                            SnapshotEntry {
                                path: file.path.clone(),
                                kind: match file.resource_kind {
                                    ResourceKind::File => EntryKind::File,
                                    ResourceKind::Symlink => EntryKind::Symlink,
                                },
                                hash,
                                size: bytes.len() as u64,
                                mode: file.after_mode,
                                binary: file.binary,
                                media_type: media_type_for(&file.path, file.binary).to_string(),
                                sensitive: is_sensitive_resource(&file.path),
                            },
                        );
                    }
                }
            }
            let mut blobs = HashMap::new();
            for entry in snapshot.entries.values() {
                blobs.insert(entry.hash.clone(), store.get_blob(&entry.hash, now_ms())?);
            }
            (run, snapshot, blobs)
        };
        let execution_root = PathBuf::from(&run.execution_root);
        if !execution_root.is_dir() {
            return Err(format!(
                "managed execution root is unavailable: {}",
                execution_root.display()
            ));
        }
        clear_worktree_contents(&execution_root)?;
        materialize(&execution_root, &snapshot, &blobs)?;
        Ok(run)
    }

    pub fn read_patch_diff(
        &self,
        run_id: &str,
        path: &str,
        allow_sensitive: bool,
    ) -> Result<String, String> {
        if is_sensitive_resource(path) && !allow_sensitive {
            return Err(format!(
                "sensitive resource requires explicit authorization: {path}"
            ));
        }
        let now = now_ms();
        let mut store = self.store.lock();
        let patch = store
            .get_patch_set(run_id)?
            .ok_or_else(|| format!("unknown patch set for run: {run_id}"))?;
        let file = patch
            .files
            .iter()
            .find(|file| file.path == path)
            .ok_or_else(|| format!("resource is not part of patch set: {path}"))?;
        if file.binary || file.resource_kind != crate::ResourceKind::File {
            return Err(format!("resource does not have a textual diff: {path}"));
        }
        let mut diff = String::new();
        for hunk in &file.hunks {
            let bytes = store.get_blob(&hunk.forward_patch_hash, now)?;
            let text = std::str::from_utf8(&bytes)
                .map_err(|_| format!("stored patch is not UTF-8: {}", hunk.id))?;
            diff.push_str(text);
            if !diff.ends_with('\n') {
                diff.push('\n');
            }
        }
        Ok(diff)
    }

    pub fn apply_patch_set(
        &self,
        run_id: &str,
        selection: &[crate::PatchSelection],
    ) -> Result<crate::ApplyOutcome, String> {
        self.apply_patch_set_with_options(run_id, selection, false)
    }

    pub fn apply_patch_set_with_options(
        &self,
        run_id: &str,
        selection: &[crate::PatchSelection],
        allow_irreversible: bool,
    ) -> Result<crate::ApplyOutcome, String> {
        let now = now_ms();
        let mut store = self.store.lock();
        let mut patch = store
            .get_patch_set(run_id)?
            .ok_or_else(|| format!("unknown patch set for run: {run_id}"))?;
        let mut task = store
            .get_task(&patch.task_id)?
            .ok_or_else(|| format!("missing task: {}", patch.task_id))?;
        let next_revision = task.revision.saturating_add(1);
        let scratch = self
            .execution_dir
            .parent()
            .unwrap_or(&self.execution_dir)
            .join("scratch");
        let outcome = ledger::apply(
            Path::new(&task.workspace_root),
            &scratch,
            &mut store,
            &mut patch,
            selection,
            ledger::ApplyOptions {
                revision: next_revision,
                now,
                allow_irreversible,
            },
        )?;
        if outcome.state == crate::PatchState::Applied {
            task.revision = next_revision;
            task.state = TaskWorkspaceState::Applied;
        } else if outcome.state == crate::PatchState::Conflict {
            task.state = TaskWorkspaceState::Conflict;
        }
        task.expires_at = now + self.retention.as_millis() as i64;
        store.put_patch_set(&patch)?;
        store.put_task(&task)?;
        Ok(outcome)
    }

    pub fn undo_patch_set(&self, run_id: &str) -> Result<crate::ApplyOutcome, String> {
        let now = now_ms();
        let mut store = self.store.lock();
        let mut patch = store
            .get_patch_set(run_id)?
            .ok_or_else(|| format!("unknown patch set for run: {run_id}"))?;
        let mut task = store
            .get_task(&patch.task_id)?
            .ok_or_else(|| format!("missing task: {}", patch.task_id))?;
        let next_revision = task.revision.saturating_add(1);
        let scratch = self
            .execution_dir
            .parent()
            .unwrap_or(&self.execution_dir)
            .join("scratch");
        let outcome = ledger::undo(
            Path::new(&task.workspace_root),
            &scratch,
            &mut store,
            &mut patch,
            next_revision,
            now,
        )?;
        if outcome.state == crate::PatchState::Reverted {
            task.revision = next_revision;
            task.state = TaskWorkspaceState::Ready;
        } else if outcome.state == crate::PatchState::Conflict {
            task.state = TaskWorkspaceState::Conflict;
        }
        task.expires_at = now + self.retention.as_millis() as i64;
        store.put_patch_set(&patch)?;
        store.put_task(&task)?;
        Ok(outcome)
    }

    pub fn resolve_conflict(
        &self,
        run_id: &str,
        selection: &[crate::PatchSelection],
        resolution: crate::ConflictResolution,
    ) -> Result<crate::ApplyOutcome, String> {
        self.resolve_conflict_with_options(run_id, selection, resolution, false)
    }

    pub fn resolve_conflict_with_options(
        &self,
        run_id: &str,
        selection: &[crate::PatchSelection],
        resolution: crate::ConflictResolution,
        allow_irreversible: bool,
    ) -> Result<crate::ApplyOutcome, String> {
        if resolution == crate::ConflictResolution::RetryMerge {
            return self.apply_patch_set_with_options(run_id, selection, allow_irreversible);
        }
        let now = now_ms();
        let mut store = self.store.lock();
        let mut patch = store
            .get_patch_set(run_id)?
            .ok_or_else(|| format!("unknown patch set for run: {run_id}"))?;
        let mut task = store
            .get_task(&patch.task_id)?
            .ok_or_else(|| format!("missing task: {}", patch.task_id))?;
        let next_revision = task.revision.saturating_add(1);
        let scratch = self
            .execution_dir
            .parent()
            .unwrap_or(&self.execution_dir)
            .join("scratch");
        let outcome = match resolution {
            crate::ConflictResolution::ApplyTask => ledger::force_apply(
                Path::new(&task.workspace_root),
                &scratch,
                &mut store,
                &mut patch,
                selection,
                ledger::ApplyOptions {
                    revision: next_revision,
                    now,
                    allow_irreversible,
                },
            )?,
            crate::ConflictResolution::KeepCurrent => {
                ledger::keep_current(&mut patch, next_revision)?
            }
            crate::ConflictResolution::RetryMerge => unreachable!(),
        };
        task.revision = next_revision;
        task.state = if outcome.state == crate::PatchState::Applied {
            TaskWorkspaceState::Applied
        } else {
            TaskWorkspaceState::Ready
        };
        task.expires_at = now + self.retention.as_millis() as i64;
        store.put_patch_set(&patch)?;
        store.put_task(&task)?;
        Ok(outcome)
    }

    pub fn read_resource(
        &self,
        run_id: &str,
        rel_path: &str,
        offset: u64,
        max_bytes: Option<usize>,
        allow_sensitive: bool,
    ) -> Result<crate::ResourceRead, String> {
        if is_sensitive_resource(rel_path) && !allow_sensitive {
            return Err(format!(
                "sensitive resource requires explicit authorization: {rel_path}"
            ));
        }
        let (run, _): (TaskRun, WorkspaceSnapshot) = self
            .store
            .lock()
            .get_run(run_id)?
            .ok_or_else(|| format!("unknown task run: {run_id}"))?;
        crate::read_text_resource(Path::new(&run.execution_root), rel_path, offset, max_bytes)
    }

    pub fn open_resource_download(
        &self,
        run_id: &str,
        rel_path: &str,
        allow_sensitive: bool,
    ) -> Result<DownloadHandle, String> {
        let (run, _): (TaskRun, WorkspaceSnapshot) = self
            .store
            .lock()
            .get_run(run_id)?
            .ok_or_else(|| format!("unknown task run: {run_id}"))?;
        self.transfers
            .open_download(Path::new(&run.execution_root), rel_path, allow_sensitive)
    }

    pub fn read_download_chunk(
        &self,
        handle_id: &str,
        offset: u64,
        length: Option<usize>,
    ) -> Result<TransferChunk, String> {
        self.transfers.read_chunk(handle_id, offset, length)
    }

    pub fn close_resource_download(&self, handle_id: &str) -> Result<(), String> {
        self.transfers.close_download(handle_id)
    }

    pub fn open_resource_upload(
        &self,
        run_id: &str,
        rel_path: &str,
        expected_size: u64,
        expected_hash: &str,
        allow_sensitive: bool,
    ) -> Result<UploadHandle, String> {
        let (run, _): (TaskRun, WorkspaceSnapshot) = self
            .store
            .lock()
            .get_run(run_id)?
            .ok_or_else(|| format!("unknown task run: {run_id}"))?;
        let handle = self.transfers.open_upload(
            Path::new(&run.execution_root),
            rel_path,
            expected_size,
            expected_hash,
            allow_sensitive,
        )?;
        self.upload_owners.lock().insert(
            handle.handle_id.clone(),
            UploadOwner {
                run_id: run_id.to_string(),
                path: rel_path.to_string(),
                existed: Path::new(&run.execution_root)
                    .join(rel_path)
                    .symlink_metadata()
                    .is_ok(),
            },
        );
        Ok(handle)
    }

    pub fn write_upload_chunk(
        &self,
        handle_id: &str,
        offset: u64,
        data_base64: &str,
        chunk_hash: &str,
    ) -> Result<u64, String> {
        self.transfers
            .write_chunk(handle_id, offset, data_base64, chunk_hash)
    }

    pub fn commit_resource_upload(&self, handle_id: &str) -> Result<String, String> {
        let owner = self
            .upload_owners
            .lock()
            .get(handle_id)
            .cloned()
            .ok_or_else(|| format!("unknown upload owner: {handle_id}"))?;
        let _ = self.watchers.mark_echo(&owner.run_id, &owner.path);
        let hash = self.transfers.commit_upload(handle_id)?;
        self.upload_owners.lock().remove(handle_id);
        self.origin_hints.lock().insert(
            (owner.run_id.clone(), owner.path.clone()),
            ContributionOrigin::User,
        );
        let (run, _): (TaskRun, WorkspaceSnapshot) = self
            .store
            .lock()
            .get_run(&owner.run_id)?
            .ok_or_else(|| format!("unknown task run: {}", owner.run_id))?;
        let change = crate::ResourceEventChange {
            path: owner.path,
            kind: if owner.existed {
                ResourceEventKind::Modified
            } else {
                ResourceEventKind::Created
            },
            old_path: None,
        };
        let mut event = watcher_resource_event(&run, &change, now_ms());
        event.origin = ContributionOrigin::User;
        event.agent_id = None;
        event.evidence = ResourceEventEvidence::Tool;
        let mut events = vec![event];
        self.store.lock().append_resource_events(&mut events)?;
        Ok(hash)
    }

    pub fn abort_resource_upload(&self, handle_id: &str) -> Result<(), String> {
        self.upload_owners.lock().remove(handle_id);
        self.transfers.abort_upload(handle_id)
    }

    pub fn watch_run(
        &self,
        run_id: &str,
        sink: std::sync::Arc<dyn TaskWorkspaceEventSink>,
    ) -> Result<(), String> {
        let (run, _): (TaskRun, WorkspaceSnapshot) = self
            .store
            .lock()
            .get_run(run_id)?
            .ok_or_else(|| format!("unknown task run: {run_id}"))?;
        let persistent_sink = Arc::new(PersistingEventSink {
            store: Arc::clone(&self.store),
            run: run.clone(),
            downstream: sink,
        });
        self.watchers.start(
            &run.task_id,
            &run.run_id,
            Path::new(&run.execution_root),
            &run.tracking_policy.generated_output_roots,
            persistent_sink,
        )
    }

    pub fn stop_watching_run(&self, run_id: &str) -> Result<(), String> {
        self.watchers.stop(run_id)
    }
}

struct PersistingEventSink {
    store: Arc<Mutex<WorkspaceStore>>,
    run: TaskRun,
    downstream: Arc<dyn TaskWorkspaceEventSink>,
}

impl TaskWorkspaceEventSink for PersistingEventSink {
    fn emit(&self, event: TaskWorkspaceResourceEvent) {
        let observed_at = now_ms();
        // The scan verifies that final state is readable immediately, but the
        // timeline remains explicitly incomplete until settle persists the
        // authoritative reconciliation. Never claim that a discarded watcher
        // interval was reconstructed from a successful scan alone.
        let resync_scan_succeeded = event.overflow
            && capture_with_policy(
                Path::new(&self.run.execution_root),
                &self.run.tracking_policy,
            )
            .is_ok();
        let mut detailed = event
            .changes
            .iter()
            .map(|change| watcher_resource_event(&self.run, change, observed_at))
            .collect::<Vec<_>>();
        if event.overflow {
            detailed.push(ResourceEvent {
                event_id: Uuid::now_v7().to_string(),
                task_id: self.run.task_id.clone(),
                run_id: self.run.run_id.clone(),
                seq: 0,
                observed_at,
                kind: ResourceEventKind::Gap,
                path: None,
                old_path: None,
                capture_class: ResourceCaptureClass::Source,
                origin: ContributionOrigin::Unknown,
                agent_id: None,
                evidence: ResourceEventEvidence::Watcher,
                tool_call_id: None,
                media_type: None,
                size: None,
                resource_kind: None,
                sensitive: false,
                provisional: true,
                overflow: true,
                resync_required: true,
                reconciled: false,
            });
            if resync_scan_succeeded {
                detailed.push(ResourceEvent {
                    event_id: Uuid::now_v7().to_string(),
                    task_id: self.run.task_id.clone(),
                    run_id: self.run.run_id.clone(),
                    seq: 0,
                    observed_at,
                    kind: ResourceEventKind::Resync,
                    path: None,
                    old_path: None,
                    capture_class: ResourceCaptureClass::Source,
                    origin: ContributionOrigin::Unknown,
                    agent_id: None,
                    evidence: ResourceEventEvidence::Reconcile,
                    tool_call_id: None,
                    media_type: None,
                    size: None,
                    resource_kind: None,
                    sensitive: false,
                    provisional: true,
                    overflow: false,
                    resync_required: true,
                    reconciled: false,
                });
            }
        }
        if self
            .store
            .lock()
            .append_resource_events(&mut detailed)
            .is_ok()
        {
            self.downstream.emit(event);
        }
    }
}

fn watcher_resource_event(
    run: &TaskRun,
    change: &crate::ResourceEventChange,
    observed_at: i64,
) -> ResourceEvent {
    let capture_class = capture_class_for_path(&run.tracking_policy, &change.path);
    let target = Path::new(&run.execution_root).join(&change.path);
    let metadata = target.symlink_metadata().ok();
    let resource_kind = metadata.as_ref().map(|metadata| {
        if metadata.file_type().is_symlink() {
            ResourceKind::Symlink
        } else {
            ResourceKind::File
        }
    });
    ResourceEvent {
        event_id: Uuid::now_v7().to_string(),
        task_id: run.task_id.clone(),
        run_id: run.run_id.clone(),
        seq: 0,
        observed_at,
        kind: change.kind,
        path: Some(change.path.clone()),
        old_path: change.old_path.clone(),
        capture_class,
        origin: ContributionOrigin::Agent,
        agent_id: Some(run.agent_id.clone()),
        evidence: ResourceEventEvidence::Watcher,
        tool_call_id: None,
        media_type: Some(media_type_for(&change.path, false).to_string()),
        size: metadata.map(|metadata| metadata.len()),
        resource_kind,
        sensitive: is_sensitive_resource(&change.path)
            || change
                .old_path
                .as_deref()
                .is_some_and(is_sensitive_resource),
        provisional: true,
        overflow: false,
        resync_required: false,
        reconciled: false,
    }
}

fn capture_class_for_path(
    policy: &crate::ResourceTrackingPolicy,
    path: &str,
) -> ResourceCaptureClass {
    if policy
        .generated_output_roots
        .iter()
        .any(|generated| Path::new(path).starts_with(generated))
    {
        ResourceCaptureClass::Generated
    } else {
        ResourceCaptureClass::Source
    }
}

fn append_missing_reconcile_events(
    store: &mut WorkspaceStore,
    run: &TaskRun,
    changes: &[ResourceChange],
    observed_at: i64,
) -> Result<(), String> {
    let existing = store.list_all_resource_events(&run.run_id)?;
    let mut missing = changes
        .iter()
        .filter(|change| {
            !existing.iter().any(|event| {
                event.path.as_deref() == Some(change.path.as_str())
                    && event_kind_for_change(change.kind) == event.kind
            })
        })
        .map(|change| ResourceEvent {
            event_id: Uuid::now_v7().to_string(),
            task_id: run.task_id.clone(),
            run_id: run.run_id.clone(),
            seq: 0,
            observed_at,
            kind: event_kind_for_change(change.kind),
            path: Some(change.path.clone()),
            old_path: change.old_path.clone(),
            capture_class: change.capture_class,
            origin: change.origin,
            agent_id: change.agent_id.clone(),
            evidence: ResourceEventEvidence::Reconcile,
            tool_call_id: None,
            media_type: Some(change.media_type.clone()),
            size: Some(change.size),
            resource_kind: Some(change.resource_kind),
            sensitive: change.sensitive,
            provisional: false,
            overflow: false,
            resync_required: false,
            reconciled: true,
        })
        .collect::<Vec<_>>();
    store.append_resource_events(&mut missing)
}

fn event_kind_for_change(kind: ChangeKind) -> ResourceEventKind {
    match kind {
        ChangeKind::Created => ResourceEventKind::Created,
        ChangeKind::Modified => ResourceEventKind::Modified,
        ChangeKind::Deleted => ResourceEventKind::Deleted,
        ChangeKind::Renamed => ResourceEventKind::Renamed,
    }
}

fn reconcile_generated(
    before: &std::collections::BTreeMap<String, GeneratedSnapshotEntry>,
    after: &std::collections::BTreeMap<String, GeneratedSnapshotEntry>,
    revision: u64,
    run: &TaskRun,
) -> Vec<ResourceChange> {
    let mut changes = Vec::new();
    for (path, entry) in after {
        let kind = match before.get(path) {
            None => Some(ChangeKind::Created),
            Some(previous) if previous != entry => Some(ChangeKind::Modified),
            Some(_) => None,
        };
        if let Some(kind) = kind {
            changes.push(generated_change(
                path,
                kind,
                before.get(path),
                Some(entry),
                revision,
                run,
            ));
        }
    }
    for (path, entry) in before {
        if !after.contains_key(path) {
            changes.push(generated_change(
                path,
                ChangeKind::Deleted,
                Some(entry),
                None,
                revision,
                run,
            ));
        }
    }
    changes
}

fn generated_change(
    path: &str,
    kind: ChangeKind,
    before: Option<&GeneratedSnapshotEntry>,
    after: Option<&GeneratedSnapshotEntry>,
    revision: u64,
    run: &TaskRun,
) -> ResourceChange {
    let visible = after.or(before).expect("generated change has metadata");
    ResourceChange {
        run_id: run.run_id.clone(),
        path: path.to_string(),
        old_path: None,
        kind,
        origin: ContributionOrigin::Agent,
        agent_id: Some(run.agent_id.clone()),
        media_type: visible.media_type.clone(),
        size: after.or(before).map(|entry| entry.size).unwrap_or(0),
        hash: None,
        before_hash: None,
        insertions: None,
        deletions: None,
        binary: !visible.media_type.starts_with("text/")
            && visible.media_type != "application/json",
        resource_kind: visible.kind,
        before_mode: before.and_then(|entry| entry.mode),
        after_mode: after.and_then(|entry| entry.mode),
        sensitive: visible.sensitive,
        revision,
        capture_class: ResourceCaptureClass::Generated,
        content_captured: false,
    }
}

fn redact_resource_change(resource: &mut ResourceChange, manifest_key: &[u8]) {
    if is_sensitive_resource(&resource.path) {
        resource.path = redacted_path(manifest_key, &resource.path);
    }
    if resource
        .old_path
        .as_deref()
        .is_some_and(is_sensitive_resource)
    {
        resource.old_path = resource
            .old_path
            .as_deref()
            .map(|path| redacted_path(manifest_key, path));
    }
}

fn redact_resource_event(event: &mut ResourceEvent, manifest_key: &[u8]) {
    if event.path.as_deref().is_some_and(is_sensitive_resource) {
        event.path = event
            .path
            .as_deref()
            .map(|path| redacted_path(manifest_key, path));
    }
    if event.old_path.as_deref().is_some_and(is_sensitive_resource) {
        event.old_path = event
            .old_path
            .as_deref()
            .map(|path| redacted_path(manifest_key, path));
    }
}

fn redacted_path(manifest_key: &[u8], path: &str) -> String {
    use sha2::{Digest, Sha256};

    let mut digest = Sha256::new();
    digest.update(manifest_key);
    digest.update([0]);
    digest.update(path.as_bytes());
    format!("redacted:{}", &hex::encode(digest.finalize())[..24])
}

fn validate_event_relative_path(path: &str) -> Result<(), String> {
    use std::path::Component;
    let path_value = Path::new(path);
    if path.is_empty()
        || path_value.is_absolute()
        || path_value.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("path escapes workspace: {path}"));
    }
    Ok(())
}

fn create_execution(
    workspace_root: &Path,
    execution_root: &Path,
    task_id: &str,
    run_id: &str,
    baseline: &WorkspaceSnapshot,
    blobs: &HashMap<String, Vec<u8>>,
) -> Result<(IsolationKind, Option<String>), String> {
    if is_git_root(workspace_root) {
        let branch = format!(
            "cognia/task/{}/{}",
            storage_key(task_id),
            storage_key(run_id)
        );
        if let Some(parent) = execution_root.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
        let output = Command::new("git")
            .args(["-C"])
            .arg(workspace_root)
            .args(["worktree", "add", "-b", &branch])
            .arg(execution_root)
            .arg("HEAD")
            .output()
            .map_err(|error| format!("start git worktree add: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "git worktree add failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let result = clear_worktree_contents(execution_root)
            .and_then(|_| materialize(execution_root, baseline, blobs));
        if let Err(error) = result {
            cleanup_git_worktree(workspace_root, execution_root, &branch);
            return Err(error);
        }
        return Ok((IsolationKind::GitWorktree, Some(branch)));
    }
    materialize(execution_root, baseline, blobs)?;
    Ok((IsolationKind::Shadow, None))
}

fn is_git_root(workspace_root: &Path) -> bool {
    let Ok(repository) = git2::Repository::discover(workspace_root) else {
        return false;
    };
    repository
        .workdir()
        .and_then(|path| path.canonicalize().ok())
        .is_some_and(|path| path == workspace_root)
}

fn clear_worktree_contents(execution_root: &Path) -> Result<(), String> {
    for entry in fs::read_dir(execution_root)
        .map_err(|error| format!("read worktree {}: {error}", execution_root.display()))?
    {
        let entry = entry.map_err(|error| format!("read worktree entry: {error}"))?;
        if entry.file_name() == ".git" {
            continue;
        }
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("stat {}: {error}", path.display()))?;
        if file_type.is_dir() && !file_type.is_symlink() {
            fs::remove_dir_all(&path)
                .map_err(|error| format!("remove {}: {error}", path.display()))?;
        } else {
            fs::remove_file(&path)
                .map_err(|error| format!("remove {}: {error}", path.display()))?;
        }
    }
    Ok(())
}

fn cleanup_git_worktree(workspace_root: &Path, execution_root: &Path, branch: &str) {
    let _ = Command::new("git")
        .args(["-C"])
        .arg(workspace_root)
        .args(["worktree", "remove", "--force"])
        .arg(execution_root)
        .status();
    if !branch.is_empty() {
        let _ = Command::new("git")
            .args(["-C"])
            .arg(workspace_root)
            .args(["branch", "-D", branch])
            .status();
    }
}

struct ReconcileContext<'a> {
    store: &'a mut WorkspaceStore,
    revision: u64,
    run_id: &'a str,
    agent_id: &'a str,
    origin_hints: &'a HashMap<(String, String), ContributionOrigin>,
    now: i64,
}

fn reconcile(
    before: &WorkspaceSnapshot,
    after: &WorkspaceSnapshot,
    context: &mut ReconcileContext<'_>,
) -> Result<Vec<ResourceChange>, String> {
    let meta = ChangeMeta {
        revision: context.revision,
        run_id: context.run_id,
        agent_id: context.agent_id,
        origin_hints: context.origin_hints,
    };
    let mut deleted: Vec<_> = before
        .entries
        .iter()
        .filter(|(path, _)| !after.entries.contains_key(*path))
        .collect();
    let mut created: Vec<_> = after
        .entries
        .iter()
        .filter(|(path, _)| !before.entries.contains_key(*path))
        .collect();
    let mut renames = Vec::new();
    let mut consumed_deleted = Vec::new();
    let mut consumed_created = Vec::new();
    for (deleted_index, (old_path, old)) in deleted.iter().enumerate() {
        if let Some((created_index, (new_path, new))) = created
            .iter()
            .enumerate()
            .find(|(index, (_, new))| !consumed_created.contains(index) && new.hash == old.hash)
        {
            consumed_deleted.push(deleted_index);
            consumed_created.push(created_index);
            renames.push((
                (*old_path).clone(),
                (*new_path).clone(),
                (*old).clone(),
                (*new).clone(),
            ));
        }
    }
    deleted = deleted
        .into_iter()
        .enumerate()
        .filter_map(|(index, value)| (!consumed_deleted.contains(&index)).then_some(value))
        .collect();
    created = created
        .into_iter()
        .enumerate()
        .filter_map(|(index, value)| (!consumed_created.contains(&index)).then_some(value))
        .collect();

    let mut changes = Vec::new();
    for (old_path, new_path, old, new) in renames {
        changes.push(change_from_entries(
            &new_path,
            Some(old_path),
            ChangeKind::Renamed,
            Some(&old),
            Some(&new),
            meta,
            None,
        ));
    }
    for (path, entry) in created {
        let bytes = context.store.get_blob(&entry.hash, context.now)?;
        let stats = (!entry.binary).then(|| (line_count(&bytes), 0));
        changes.push(change_from_entries(
            path,
            None,
            ChangeKind::Created,
            None,
            Some(entry),
            meta,
            stats,
        ));
    }
    for (path, entry) in deleted {
        let bytes = context.store.get_blob(&entry.hash, context.now)?;
        let stats = (!entry.binary).then(|| (0, line_count(&bytes)));
        changes.push(change_from_entries(
            path,
            None,
            ChangeKind::Deleted,
            Some(entry),
            None,
            meta,
            stats,
        ));
    }
    for (path, old) in &before.entries {
        let Some(new) = after.entries.get(path) else {
            continue;
        };
        if old.hash == new.hash && old.mode == new.mode && old.kind == new.kind {
            continue;
        }
        let stats = if !old.binary && !new.binary {
            let old_bytes = context.store.get_blob(&old.hash, context.now)?;
            let new_bytes = context.store.get_blob(&new.hash, context.now)?;
            line_stats(&old_bytes, &new_bytes)
        } else {
            None
        };
        changes.push(change_from_entries(
            path,
            None,
            ChangeKind::Modified,
            Some(old),
            Some(new),
            meta,
            stats,
        ));
    }
    changes.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(changes)
}

#[derive(Clone, Copy)]
struct ChangeMeta<'a> {
    revision: u64,
    run_id: &'a str,
    agent_id: &'a str,
    origin_hints: &'a HashMap<(String, String), ContributionOrigin>,
}

fn change_from_entries(
    path: &str,
    old_path: Option<String>,
    kind: ChangeKind,
    before: Option<&crate::snapshot::SnapshotEntry>,
    after: Option<&crate::snapshot::SnapshotEntry>,
    meta: ChangeMeta<'_>,
    stats: Option<(u32, u32)>,
) -> ResourceChange {
    let visible = after.or(before);
    let sensitive = visible.map(|entry| entry.sensitive).unwrap_or(false)
        || is_sensitive_resource(path)
        || old_path.as_deref().is_some_and(is_sensitive_resource);
    let origin = meta
        .origin_hints
        .get(&(meta.run_id.to_string(), path.to_string()))
        .copied()
        .unwrap_or(ContributionOrigin::Agent);
    ResourceChange {
        run_id: meta.run_id.to_string(),
        path: path.to_string(),
        old_path,
        kind,
        origin,
        agent_id: (origin == ContributionOrigin::Agent).then(|| meta.agent_id.to_string()),
        media_type: visible
            .map(|entry| entry.media_type.clone())
            .unwrap_or_else(|| media_type_for(path, false).to_string()),
        size: after.map(|entry| entry.size).unwrap_or(0),
        hash: after.map(|entry| entry.hash.clone()),
        before_hash: before.map(|entry| entry.hash.clone()),
        insertions: stats.map(|value| value.0),
        deletions: stats.map(|value| value.1),
        binary: visible.map(|entry| entry.binary).unwrap_or(false),
        resource_kind: match visible.map(|entry| entry.kind) {
            Some(crate::snapshot::EntryKind::Symlink) => crate::ResourceKind::Symlink,
            _ => crate::ResourceKind::File,
        },
        before_mode: before.and_then(|entry| entry.mode),
        after_mode: after.and_then(|entry| entry.mode),
        sensitive,
        revision: meta.revision,
        capture_class: ResourceCaptureClass::Source,
        content_captured: true,
    }
}

fn line_count(bytes: &[u8]) -> u32 {
    if bytes.is_empty() {
        return 0;
    }
    let newlines = bytes.iter().filter(|byte| **byte == b'\n').count() as u32;
    newlines + u32::from(!bytes.ends_with(b"\n"))
}

fn line_stats(before: &[u8], after: &[u8]) -> Option<(u32, u32)> {
    let before = std::str::from_utf8(before)
        .ok()?
        .lines()
        .collect::<Vec<_>>();
    let after = std::str::from_utf8(after).ok()?.lines().collect::<Vec<_>>();
    if before.len().saturating_mul(after.len()) > 4_000_000 {
        return None;
    }
    let mut previous = vec![0_u32; after.len() + 1];
    for before_line in &before {
        let mut current = vec![0_u32; after.len() + 1];
        for (index, after_line) in after.iter().enumerate() {
            current[index + 1] = if before_line == after_line {
                previous[index] + 1
            } else {
                current[index].max(previous[index + 1])
            };
        }
        previous = current;
    }
    let common = previous[after.len()];
    Some((after.len() as u32 - common, before.len() as u32 - common))
}

fn validate_id(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(format!("invalid {label}: {value}"));
    }
    Ok(())
}

fn storage_key(value: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(value.as_bytes()))[..24].to_string()
}

fn load_or_create_manifest_key(service_dir: &Path) -> Result<Vec<u8>, String> {
    let path = service_dir.join("manifest-redaction.key");
    if path.exists() {
        let key = fs::read(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
        return (key.len() >= 16)
            .then_some(key)
            .ok_or_else(|| format!("invalid manifest redaction key: {}", path.display()));
    }
    let key = Uuid::new_v4().as_bytes().to_vec();
    fs::write(&path, &key).map_err(|error| format!("write {}: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("protect {}: {error}", path.display()))?;
    }
    Ok(key)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ChangeKind, IsolationKind, ResourceCaptureClass, ResourceEventKind, ResourceTrackingPolicy,
        RunState, TaskWorkspaceState,
    };
    use parking_lot::Mutex;
    use std::{
        fs,
        sync::{mpsc, Arc},
        time::Duration,
    };
    use tempfile::TempDir;

    struct ChannelSink(Mutex<mpsc::Sender<TaskWorkspaceResourceEvent>>);

    impl TaskWorkspaceEventSink for ChannelSink {
        fn emit(&self, event: TaskWorkspaceResourceEvent) {
            let _ = self.0.lock().send(event);
        }
    }

    fn input(root: &TempDir, task_id: &str, run_id: &str) -> BeginTaskRun {
        BeginTaskRun {
            task_id: task_id.into(),
            session_id: "session-1".into(),
            run_id: run_id.into(),
            parent_run_id: None,
            agent_id: "agent-1".into(),
            agent_kind: "in-app".into(),
            workspace_root: root.path().to_string_lossy().into_owned(),
            workspace_key: None,
            execution_run_id: None,
            trace_id: None,
            turn_id: None,
            attempt_id: None,
            provider_attempt_id: None,
            surface: None,
            tracking_policy: ResourceTrackingPolicy::default(),
        }
    }

    #[test]
    fn persists_generated_lifecycle_without_storing_generated_content() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        fs::write(workspace.path().join("source.txt"), "before\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let mut request = input(&workspace, "task-events", "run-events");
        request.tracking_policy = ResourceTrackingPolicy {
            generated_output_roots: vec!["dist".into()],
            auto_detect: false,
        };
        let run = service.begin_run(request).unwrap();
        let execution = PathBuf::from(&run.execution_root);
        fs::create_dir_all(execution.join("dist")).unwrap();

        let (tx, rx) = mpsc::channel();
        service
            .watch_run("run-events", Arc::new(ChannelSink(Mutex::new(tx))))
            .unwrap();
        fs::write(execution.join("dist/transient.js"), "temporary").unwrap();
        rx.recv_timeout(Duration::from_secs(3)).unwrap();
        fs::remove_file(execution.join("dist/transient.js")).unwrap();
        rx.recv_timeout(Duration::from_secs(3)).unwrap();
        fs::write(execution.join("dist/bundle.js"), "generated body").unwrap();
        fs::write(execution.join("source.txt"), "after\n").unwrap();
        service
            .record_tool_event(
                "run-events",
                "source.txt",
                None,
                ResourceEventKind::Modified,
                Some("tool-call-1"),
            )
            .unwrap();
        rx.recv_timeout(Duration::from_secs(3)).unwrap();
        service.stop_watching_run("run-events").unwrap();

        let events = service
            .list_resource_events("run-events", None, 100)
            .unwrap();
        assert!(events.iter().any(|event| {
            event.path.as_deref() == Some("dist/transient.js")
                && event.kind == ResourceEventKind::Created
                && event.capture_class == ResourceCaptureClass::Generated
        }));
        assert!(events.iter().any(|event| {
            event.path.as_deref() == Some("source.txt")
                && event.evidence == ResourceEventEvidence::Tool
                && event.tool_call_id.as_deref() == Some("tool-call-1")
        }));
        assert!(events.iter().any(|event| {
            event.path.as_deref() == Some("dist/transient.js")
                && event.kind == ResourceEventKind::Deleted
        }));

        let changes = service.settle_run("run-events").unwrap();
        let generated = changes
            .iter()
            .find(|change| change.path == "dist/bundle.js")
            .unwrap();
        assert_eq!(generated.capture_class, ResourceCaptureClass::Generated);
        assert!(!generated.content_captured);
        assert_eq!(generated.hash, None);
        assert_eq!(generated.before_hash, None);
        assert_eq!(generated.size, 14);

        let source = changes
            .iter()
            .find(|change| change.path == "source.txt")
            .unwrap();
        assert_eq!(source.capture_class, ResourceCaptureClass::Source);
        assert!(source.content_captured);
        assert!(source.hash.is_some());

        let patch = service.get_patch_set("run-events").unwrap().unwrap();
        assert_eq!(patch.files.len(), 1);
        assert_eq!(patch.files[0].path, "source.txt");
    }

    #[test]
    fn exports_relative_metadata_and_redacts_sensitive_paths() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        fs::write(workspace.path().join(".env"), "TOKEN=before\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let request = input(&workspace, "task-export", "run-export");
        let run = service.begin_run(request).unwrap();
        fs::write(
            Path::new(&run.execution_root).join(".env"),
            "TOKEN=after-secret\n",
        )
        .unwrap();
        service.settle_run("run-export").unwrap();

        let manifest = service
            .export_resource_manifest("task-export", Some("run-export"))
            .unwrap();
        assert_eq!(manifest.schema_version, 1);
        assert_eq!(manifest.task.workspace_root, ".");
        assert_eq!(manifest.runs[0].execution_root, ".");
        assert!(manifest.resources[0].path.starts_with("redacted:"));
        let opaque_path = manifest.resources[0].path.clone();
        assert!(manifest.events[0]
            .path
            .as_deref()
            .unwrap()
            .starts_with("redacted:"));
        let json = serde_json::to_string(&manifest).unwrap();
        assert!(!json.contains(&workspace.path().to_string_lossy().to_string()));
        assert!(!json.contains("after-secret"));
        assert!(!json.contains(".env"));

        drop(service);
        let reopened = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let reexported = reopened
            .export_resource_manifest("task-export", Some("run-export"))
            .unwrap();
        assert_eq!(reexported.resources[0].path, opaque_path);
    }

    #[test]
    fn export_redacts_only_the_sensitive_side_of_a_rename() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        fs::write(workspace.path().join(".env"), "TOKEN=secret\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let run = service
            .begin_run(input(&workspace, "task-rename-export", "run-rename-export"))
            .unwrap();
        fs::rename(
            Path::new(&run.execution_root).join(".env"),
            Path::new(&run.execution_root).join("config.txt"),
        )
        .unwrap();
        service.settle_run("run-rename-export").unwrap();

        let manifest = service
            .export_resource_manifest("task-rename-export", Some("run-rename-export"))
            .unwrap();
        let resource = manifest
            .resources
            .iter()
            .find(|resource| resource.kind == ChangeKind::Renamed)
            .unwrap();
        assert_eq!(resource.path, "config.txt");
        assert!(resource
            .old_path
            .as_deref()
            .unwrap()
            .starts_with("redacted:"));
        let json = serde_json::to_string(&manifest).unwrap();
        assert!(!json.contains(".env"));
        assert!(!json.contains("TOKEN=secret"));
    }

    #[test]
    fn non_git_run_is_isolated_and_settles_authoritative_changes() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        fs::write(workspace.path().join("modify.txt"), "before\n").unwrap();
        fs::write(workspace.path().join("delete.txt"), "gone\n").unwrap();

        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let run = service
            .begin_run(input(&workspace, "task-1", "run-1"))
            .unwrap();
        assert_eq!(run.isolation_kind, IsolationKind::Shadow);
        assert_eq!(run.state, RunState::Running);
        assert_ne!(run.execution_root, workspace.path().to_string_lossy());

        let execution = PathBuf::from(&run.execution_root);
        fs::write(execution.join("modify.txt"), "after\n").unwrap();
        fs::remove_file(execution.join("delete.txt")).unwrap();
        fs::write(execution.join("create.txt"), "created\n").unwrap();

        assert_eq!(
            fs::read_to_string(workspace.path().join("modify.txt")).unwrap(),
            "before\n"
        );
        assert!(workspace.path().join("delete.txt").exists());
        assert!(!workspace.path().join("create.txt").exists());

        let changes = service.settle_run("run-1").unwrap();
        assert_eq!(
            changes
                .iter()
                .map(|change| (change.path.as_str(), change.kind))
                .collect::<Vec<_>>(),
            vec![
                ("create.txt", ChangeKind::Created),
                ("delete.txt", ChangeKind::Deleted),
                ("modify.txt", ChangeKind::Modified),
            ]
        );
        assert!(changes.iter().all(|change| change.revision == 1));

        let task = service.get_task("task-1").unwrap().unwrap();
        assert_eq!(task.state, TaskWorkspaceState::Ready);
        assert_eq!(task.revision, 1);
        assert_eq!(service.list_resources("task-1").unwrap(), changes);
        assert_eq!(
            service.list_runs("task-1").unwrap()[0].state,
            RunState::Ready
        );
    }

    #[test]
    fn one_task_lists_retry_and_child_runs_as_versions() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();

        service
            .begin_run(input(&workspace, "task-1", "run-1"))
            .unwrap();
        let mut child = input(&workspace, "task-1", "run-2");
        child.parent_run_id = Some("run-1".into());
        child.agent_id = "agent-2".into();
        service.begin_run(child).unwrap();

        let runs = service.list_runs("task-1").unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[1].parent_run_id.as_deref(), Some("run-1"));
        assert_eq!(runs[1].agent_id, "agent-2");
        service.settle_run("run-1").unwrap();
        assert_eq!(
            service.get_task("task-1").unwrap().unwrap().state,
            TaskWorkspaceState::Active
        );
        service.settle_run("run-2").unwrap();
        assert_eq!(
            service.get_task("task-1").unwrap().unwrap().state,
            TaskWorkspaceState::Ready
        );
    }

    #[test]
    fn beginning_the_same_run_is_idempotent_but_rejects_reuse() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let request = input(&workspace, "task-idempotent-begin", "run-idempotent-begin");

        let first = service.begin_run(request.clone()).unwrap();
        let second = service.begin_run(request).unwrap();
        assert_eq!(second, first);

        let mut reused = input(&workspace, "another-task", "run-idempotent-begin");
        reused.agent_id = "another-agent".into();
        assert!(service
            .begin_run(reused)
            .unwrap_err()
            .contains("already owned"));
    }

    #[test]
    fn lists_tasks_by_session_newest_first() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        service
            .begin_run(input(&workspace, "task-1", "run-1"))
            .unwrap();
        let mut other = input(&workspace, "task-2", "run-2");
        other.session_id = "session-2".into();
        service.begin_run(other).unwrap();

        let session_tasks = service.list_tasks(Some("session-1")).unwrap();
        assert_eq!(session_tasks.len(), 1);
        assert_eq!(session_tasks[0].task_id, "task-1");
        assert_eq!(service.list_tasks(None).unwrap().len(), 2);
    }

    #[test]
    fn git_run_uses_worktree_with_the_live_workspace_as_its_baseline() {
        use git2::{IndexAddOption, Repository, Signature};

        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let repo = Repository::init(workspace.path()).unwrap();
        {
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "Task Workspace Test").unwrap();
            config.set_str("user.email", "task@example.com").unwrap();
        }
        fs::write(workspace.path().join("tracked.txt"), "committed\n").unwrap();
        let mut index = repo.index().unwrap();
        index
            .add_all(["tracked.txt"], IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = Signature::now("Task Workspace Test", "task@example.com").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "seed", &tree, &[])
            .unwrap();
        drop(tree);

        fs::write(
            workspace.path().join("tracked.txt"),
            "uncommitted baseline\n",
        )
        .unwrap();
        fs::write(workspace.path().join("untracked.txt"), "also baseline\n").unwrap();

        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let run = service
            .begin_run(input(&workspace, "task:git", "run:git"))
            .unwrap();

        assert_eq!(run.isolation_kind, IsolationKind::GitWorktree);
        let expected_branch = format!(
            "cognia/task/{}/{}",
            storage_key("task:git"),
            storage_key("run:git")
        );
        assert_eq!(run.isolation_ref.as_deref(), Some(expected_branch.as_str()));
        let execution = PathBuf::from(run.execution_root);
        assert!(execution.join(".git").is_file());
        assert_eq!(
            fs::read_to_string(execution.join("tracked.txt")).unwrap(),
            "uncommitted baseline\n"
        );
        assert_eq!(
            fs::read_to_string(execution.join("untracked.txt")).unwrap(),
            "also baseline\n"
        );
        assert_eq!(
            fs::read_to_string(workspace.path().join("tracked.txt")).unwrap(),
            "uncommitted baseline\n"
        );
    }

    #[test]
    fn apply_and_undo_preserve_non_overlapping_user_edits() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        fs::write(workspace.path().join("story.txt"), "one\ntwo\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let run = service
            .begin_run(input(&workspace, "task-merge", "run-merge"))
            .unwrap();

        fs::write(
            Path::new(&run.execution_root).join("story.txt"),
            "one\nagent two\n",
        )
        .unwrap();
        fs::write(workspace.path().join("story.txt"), "one\ntwo\nuser three\n").unwrap();
        service.settle_run("run-merge").unwrap();

        let patch = service.get_patch_set("run-merge").unwrap().unwrap();
        assert_eq!(patch.state, crate::PatchState::Ready);
        let applied = service.apply_patch_set("run-merge", &[]).unwrap();
        assert_eq!(applied.state, crate::PatchState::Applied);
        assert_eq!(
            fs::read_to_string(workspace.path().join("story.txt")).unwrap(),
            "one\nagent two\nuser three\n"
        );

        let undone = service.undo_patch_set("run-merge").unwrap();
        assert_eq!(undone.state, crate::PatchState::Reverted);
        assert_eq!(
            fs::read_to_string(workspace.path().join("story.txt")).unwrap(),
            "one\ntwo\nuser three\n"
        );
    }

    #[test]
    fn overlapping_apply_conflict_is_fail_closed() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        fs::write(workspace.path().join("story.txt"), "one\ntwo\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let run = service
            .begin_run(input(&workspace, "task-conflict", "run-conflict"))
            .unwrap();
        fs::write(
            Path::new(&run.execution_root).join("story.txt"),
            "one\nagent\n",
        )
        .unwrap();
        fs::write(workspace.path().join("story.txt"), "one\nuser\n").unwrap();
        service.settle_run("run-conflict").unwrap();

        let outcome = service.apply_patch_set("run-conflict", &[]).unwrap();
        assert_eq!(outcome.state, crate::PatchState::Conflict);
        assert_eq!(outcome.conflicts[0].path, "story.txt");
        assert_eq!(
            fs::read_to_string(workspace.path().join("story.txt")).unwrap(),
            "one\nuser\n"
        );

        let resolved = service
            .resolve_conflict("run-conflict", &[], crate::ConflictResolution::ApplyTask)
            .unwrap();
        assert_eq!(resolved.state, crate::PatchState::Applied);
        assert_eq!(
            fs::read_to_string(workspace.path().join("story.txt")).unwrap(),
            "one\nagent\n"
        );
        service.undo_patch_set("run-conflict").unwrap();
        assert_eq!(
            fs::read_to_string(workspace.path().join("story.txt")).unwrap(),
            "one\nuser\n"
        );
    }

    #[test]
    fn conflict_can_keep_current_or_retry_after_user_resolves_drift() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        fs::write(workspace.path().join("story.txt"), "base\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let run = service
            .begin_run(input(&workspace, "task-resolution", "run-resolution"))
            .unwrap();
        fs::write(Path::new(&run.execution_root).join("story.txt"), "agent\n").unwrap();
        fs::write(workspace.path().join("story.txt"), "user\n").unwrap();
        service.settle_run("run-resolution").unwrap();
        assert_eq!(
            service
                .apply_patch_set("run-resolution", &[])
                .unwrap()
                .state,
            crate::PatchState::Conflict
        );
        assert_eq!(
            service
                .resolve_conflict(
                    "run-resolution",
                    &[],
                    crate::ConflictResolution::KeepCurrent,
                )
                .unwrap()
                .state,
            crate::PatchState::Reverted
        );
        assert_eq!(
            fs::read_to_string(workspace.path().join("story.txt")).unwrap(),
            "user\n"
        );

        let retry = service
            .begin_run(input(&workspace, "task-retry", "run-retry"))
            .unwrap();
        fs::write(
            Path::new(&retry.execution_root).join("story.txt"),
            "agent retry\n",
        )
        .unwrap();
        fs::write(workspace.path().join("story.txt"), "drift\n").unwrap();
        service.settle_run("run-retry").unwrap();
        assert_eq!(
            service.apply_patch_set("run-retry", &[]).unwrap().state,
            crate::PatchState::Conflict
        );
        fs::write(workspace.path().join("story.txt"), "user\n").unwrap();
        assert_eq!(
            service
                .resolve_conflict("run-retry", &[], crate::ConflictResolution::RetryMerge)
                .unwrap()
                .state,
            crate::PatchState::Applied
        );
    }

    #[test]
    fn failed_and_cancelled_runs_reconcile_before_becoming_terminal() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        for (run_id, cancelled) in [("run-failed", false), ("run-cancelled", true)] {
            let run = service
                .begin_run(input(&workspace, run_id, run_id))
                .unwrap();
            fs::write(
                Path::new(&run.execution_root).join(format!("{run_id}.txt")),
                "saved",
            )
            .unwrap();
            if cancelled {
                service.settle_cancelled_run(run_id).unwrap();
            } else {
                service.settle_failed_run(run_id).unwrap();
            }
            let state = service.list_runs(run_id).unwrap()[0].state;
            assert_eq!(
                state,
                if cancelled {
                    RunState::Cancelled
                } else {
                    RunState::Failed
                }
            );
            assert_eq!(service.list_resources(run_id).unwrap().len(), 1);
        }
    }

    #[test]
    fn applies_only_the_selected_text_hunk() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let baseline = (1..=24)
            .map(|line| format!("line {line}\n"))
            .collect::<String>();
        fs::write(workspace.path().join("many.txt"), &baseline).unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let run = service
            .begin_run(input(&workspace, "task-hunks", "run-hunks"))
            .unwrap();
        let changed = baseline
            .replace("line 2\n", "agent line 2\n")
            .replace("line 22\n", "agent line 22\n");
        fs::write(Path::new(&run.execution_root).join("many.txt"), changed).unwrap();
        service.settle_run("run-hunks").unwrap();

        let patch = service.get_patch_set("run-hunks").unwrap().unwrap();
        assert_eq!(patch.files[0].hunks.len(), 2);
        let first_hunk = patch.files[0].hunks[0].id.clone();
        let outcome = service
            .apply_patch_set(
                "run-hunks",
                &[crate::PatchSelection {
                    path: "many.txt".into(),
                    hunk_ids: vec![first_hunk],
                }],
            )
            .unwrap();
        assert_eq!(outcome.state, crate::PatchState::Applied);
        let applied = fs::read_to_string(workspace.path().join("many.txt")).unwrap();
        assert!(applied.contains("agent line 2\n"));
        assert!(applied.contains("line 22\n"));
        assert!(!applied.contains("agent line 22\n"));
    }

    #[test]
    fn uploaded_task_resource_is_attributed_to_the_user() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        use sha2::{Digest, Sha256};

        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        service
            .begin_run(input(&workspace, "task-user", "run-user"))
            .unwrap();
        let bytes = b"written in the task dock";
        let hash = hex::encode(Sha256::digest(bytes));
        let handle = service
            .open_resource_upload(
                "run-user",
                "notes/user.txt",
                bytes.len() as u64,
                &hash,
                false,
            )
            .unwrap();
        service
            .write_upload_chunk(&handle.handle_id, 0, &STANDARD.encode(bytes), &hash)
            .unwrap();
        service.commit_resource_upload(&handle.handle_id).unwrap();

        let changes = service.settle_run("run-user").unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].origin, ContributionOrigin::User);
        assert_eq!(changes[0].agent_id, None);
        let events = service.list_resource_events("run-user", None, 10).unwrap();
        assert!(events.iter().any(|event| {
            event.path.as_deref() == Some("notes/user.txt")
                && event.origin == ContributionOrigin::User
                && event.evidence == ResourceEventEvidence::Tool
        }));
    }

    #[test]
    fn settling_a_ready_run_is_idempotent() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let run = service
            .begin_run(input(&workspace, "task-idempotent", "run-idempotent"))
            .unwrap();
        fs::write(Path::new(&run.execution_root).join("result.txt"), "result").unwrap();

        let first = service.settle_run("run-idempotent").unwrap();
        let first_task = service.get_task("task-idempotent").unwrap().unwrap();
        let second = service.settle_run("run-idempotent").unwrap();
        let second_task = service.get_task("task-idempotent").unwrap().unwrap();

        assert_eq!(second, first);
        assert_eq!(second_task.revision, first_task.revision);
        assert_eq!(second_task.revision, 1);
    }

    #[test]
    fn sensitive_resource_reads_require_explicit_authorization() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        fs::write(workspace.path().join(".env.local"), "TOKEN=secret\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        service
            .begin_run(input(&workspace, "task-sensitive", "run-sensitive"))
            .unwrap();

        let denied = service
            .read_resource("run-sensitive", ".env.local", 0, None, false)
            .unwrap_err();
        assert!(denied.contains("explicit authorization"));

        let allowed = service
            .read_resource("run-sensitive", ".env.local", 0, None, true)
            .unwrap();
        assert_eq!(allowed.content.as_deref(), Some("TOKEN=secret\n"));
        assert!(allowed.sensitive);
    }

    #[test]
    fn prune_keeps_unapplied_tasks_and_removes_expired_applied_tasks() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        fs::write(workspace.path().join("result.txt"), "before\n").unwrap();
        let mut config = ServiceConfig::new(data.path().into());
        config.retention = Duration::ZERO;
        let service = TaskWorkspaceService::open(config).unwrap();
        let run = service
            .begin_run(input(&workspace, "task-prune", "run-prune"))
            .unwrap();
        fs::write(Path::new(&run.execution_root).join("result.txt"), "after\n").unwrap();
        service.settle_run("run-prune").unwrap();

        let protected = service.prune().unwrap();
        assert!(protected.removed_task_ids.is_empty());
        assert!(service.get_task("task-prune").unwrap().is_some());

        service.apply_patch_set("run-prune", &[]).unwrap();
        let pruned = service.prune().unwrap();
        assert_eq!(pruned.removed_task_ids, vec!["task-prune"]);
        assert!(pruned.removed_blob_count > 0);
        assert!(pruned.reclaimed_bytes > 0);
        assert!(service.get_task("task-prune").unwrap().is_none());
        assert!(!Path::new(&run.execution_root).exists());
    }

    #[test]
    fn prune_keeps_pinned_tasks() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let mut config = ServiceConfig::new(data.path().into());
        config.retention = Duration::ZERO;
        let service = TaskWorkspaceService::open(config).unwrap();
        service
            .begin_run(input(&workspace, "task-pinned", "run-pinned"))
            .unwrap();
        service.settle_run("run-pinned").unwrap();
        service.apply_patch_set("run-pinned", &[]).unwrap();
        service.set_task_pinned("task-pinned", true).unwrap();

        assert!(service.prune().unwrap().removed_task_ids.is_empty());
        assert!(service.get_task("task-pinned").unwrap().is_some());
    }

    #[test]
    fn reads_only_ledger_backed_text_diffs() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        fs::write(workspace.path().join("story.txt"), "before\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let run = service
            .begin_run(input(&workspace, "task-diff", "run-diff"))
            .unwrap();
        fs::write(Path::new(&run.execution_root).join("story.txt"), "after\n").unwrap();
        service.settle_run("run-diff").unwrap();

        let diff = service
            .read_patch_diff("run-diff", "story.txt", false)
            .unwrap();
        assert!(diff.contains("-before"));
        assert!(diff.contains("+after"));
        assert!(service
            .read_patch_diff("run-diff", "missing.txt", false)
            .unwrap_err()
            .contains("not part"));
    }

    #[test]
    fn reopening_recovers_and_reconciles_an_interrupted_run() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let run = {
            let service =
                TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
            let run = service
                .begin_run(input(&workspace, "task-crash", "run-crash"))
                .unwrap();
            fs::write(
                Path::new(&run.execution_root).join("recovered.txt"),
                "saved",
            )
            .unwrap();
            run
        };

        let recovered = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let runs = recovered.list_runs("task-crash").unwrap();
        assert_eq!(runs[0].state, RunState::Failed);
        assert_eq!(
            recovered.list_resources("task-crash").unwrap()[0].path,
            "recovered.txt"
        );
        assert!(Path::new(&run.execution_root).exists());
    }

    #[test]
    fn pipeline_runs_reuse_a_settled_execution_root_with_a_fresh_baseline() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let mut first_input = input(&workspace, "task-pipeline", "run-stage-1");
        first_input.workspace_key = Some("pipeline-main".into());
        let first = service.begin_run(first_input).unwrap();
        fs::write(Path::new(&first.execution_root).join("stage-1.txt"), "one").unwrap();
        service.settle_run(&first.run_id).unwrap();

        let mut second_input = input(&workspace, "task-pipeline", "run-stage-2");
        second_input.workspace_key = Some("pipeline-main".into());
        let second = service.begin_run(second_input).unwrap();
        assert_eq!(second.execution_root, first.execution_root);
        assert_eq!(second.workspace_key.as_deref(), Some("pipeline-main"));
        fs::write(Path::new(&second.execution_root).join("stage-2.txt"), "two").unwrap();

        let changes = service.settle_run(&second.run_id).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "stage-2.txt");
    }

    #[test]
    fn restores_a_historical_post_run_snapshot_into_the_reused_worktree() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        fs::write(workspace.path().join("base.txt"), "base").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let mut first_input = input(&workspace, "task-restore", "run-1");
        first_input.workspace_key = Some("chat-1".into());
        let first = service.begin_run(first_input).unwrap();
        fs::write(Path::new(&first.execution_root).join("first.txt"), "one").unwrap();
        service.settle_run("run-1").unwrap();

        let mut second_input = input(&workspace, "task-restore", "run-2");
        second_input.workspace_key = Some("chat-1".into());
        let second = service.begin_run(second_input).unwrap();
        fs::write(Path::new(&second.execution_root).join("second.txt"), "two").unwrap();
        service.settle_run("run-2").unwrap();
        assert!(Path::new(&second.execution_root)
            .join("second.txt")
            .exists());

        service.restore_run_snapshot("run-1").unwrap();
        assert!(Path::new(&first.execution_root).join("first.txt").exists());
        assert!(!Path::new(&first.execution_root).join("second.txt").exists());
        assert_eq!(
            fs::read_to_string(Path::new(&first.execution_root).join("base.txt")).unwrap(),
            "base"
        );
    }

    #[test]
    fn pipeline_workspace_rejects_concurrent_runs() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let mut first_input = input(&workspace, "task-pipeline", "run-stage-1");
        first_input.workspace_key = Some("pipeline-main".into());
        service.begin_run(first_input).unwrap();

        let mut second_input = input(&workspace, "task-pipeline", "run-stage-2");
        second_input.workspace_key = Some("pipeline-main".into());
        let error = service.begin_run(second_input).unwrap_err();
        assert!(error.contains("pipeline workspace is already active"));
    }
}
