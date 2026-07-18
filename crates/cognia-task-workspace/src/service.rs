use crate::{
    ledger,
    resource::{is_sensitive_resource, media_type_for},
    snapshot::{capture, materialize, WorkspaceSnapshot},
    store::WorkspaceStore,
    BeginTaskRun, ChangeKind, ContributionOrigin, DownloadHandle, IsolationKind, ResourceChange,
    RunState, TaskRun, TaskWorkspace, TaskWorkspaceEventSink, TaskWorkspaceState, TransferChunk,
    TransferRegistry, UploadHandle, WatchManager,
};
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

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
    store: Mutex<WorkspaceStore>,
    execution_dir: PathBuf,
    retention: Duration,
    transfers: TransferRegistry,
    upload_owners: Mutex<HashMap<String, (String, String)>>,
    origin_hints: Mutex<HashMap<(String, String), ContributionOrigin>>,
    watchers: WatchManager,
}

impl TaskWorkspaceService {
    pub fn open(config: ServiceConfig) -> Result<Self, String> {
        let service_dir = config.data_dir.join("task-workspaces");
        let execution_dir = service_dir.join("executions");
        fs::create_dir_all(&execution_dir).map_err(|error| {
            format!("create execution dir {}: {error}", execution_dir.display())
        })?;
        Ok(Self {
            store: Mutex::new(WorkspaceStore::open(&service_dir, config.max_blob_bytes)?),
            execution_dir,
            retention: config.retention,
            transfers: TransferRegistry::new(Duration::from_secs(5 * 60)),
            upload_owners: Mutex::new(HashMap::new()),
            origin_hints: Mutex::new(HashMap::new()),
            watchers: WatchManager::new(),
        })
    }

    pub fn begin_run(&self, input: BeginTaskRun) -> Result<TaskRun, String> {
        validate_id("taskId", &input.task_id)?;
        validate_id("runId", &input.run_id)?;
        let root = PathBuf::from(&input.workspace_root)
            .canonicalize()
            .map_err(|error| format!("canonicalize workspace {}: {error}", input.workspace_root))?;
        if !root.is_dir() {
            return Err(format!("workspace is not a directory: {}", root.display()));
        }
        let now = now_ms();
        let (baseline, blobs) = capture(&root)?;
        let execution_root = self.execution_dir.join(&input.task_id).join(&input.run_id);
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

        let mut store = self.store.lock();
        for (hash, bytes) in &blobs {
            if let Err(error) = store.put_blob(hash, bytes, now) {
                let _ = fs::remove_dir_all(&execution_root);
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
            let _ = fs::remove_dir_all(&execution_root);
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
            baseline_revision: task.revision,
            state: RunState::Running,
            created_at: now,
            settled_at: None,
        };
        store.put_run(&run, &baseline)?;
        Ok(run)
    }

    pub fn settle_run(&self, run_id: &str) -> Result<Vec<ResourceChange>, String> {
        let now = now_ms();
        let mut store = self.store.lock();
        let (mut run, baseline): (TaskRun, WorkspaceSnapshot) = store
            .get_run(run_id)?
            .ok_or_else(|| format!("unknown task run: {run_id}"))?;
        if !matches!(
            run.state,
            RunState::Running | RunState::Settling | RunState::Ready
        ) {
            return store.list_resources(&run.task_id);
        }
        if run.state == RunState::Ready {
            return store.list_run_resources(run_id);
        }
        run.state = RunState::Settling;
        store.put_run(&run, &baseline)?;
        let (current, blobs) = capture(Path::new(&run.execution_root))?;
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
        let changes = reconcile(&baseline, &current, &mut context)?;
        drop(origin_hints);
        run.state = RunState::Ready;
        run.settled_at = Some(now);
        task.state = TaskWorkspaceState::Ready;
        task.expires_at = now + self.retention.as_millis() as i64;
        store.replace_resources(&task.task_id, &run.run_id, task.revision, &changes)?;
        let scratch = self
            .execution_dir
            .parent()
            .unwrap_or(&self.execution_dir)
            .join("scratch");
        let patch = ledger::build_patch_set(
            &task.task_id,
            &run.run_id,
            run.baseline_revision,
            &changes,
            &mut store,
            &scratch,
            now,
        )?;
        store.put_patch_set(&patch)?;
        store.put_run(&run, &baseline)?;
        store.put_task(&task)?;
        Ok(changes)
    }

    pub fn get_task(&self, task_id: &str) -> Result<Option<TaskWorkspace>, String> {
        self.store.lock().get_task(task_id)
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

    pub fn apply_patch_set(
        &self,
        run_id: &str,
        selection: &[crate::PatchSelection],
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
            next_revision,
            now,
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
            (run_id.to_string(), rel_path.to_string()),
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
        let _ = self.watchers.mark_echo(&owner.0, &owner.1);
        let hash = self.transfers.commit_upload(handle_id)?;
        self.upload_owners.lock().remove(handle_id);
        self.origin_hints
            .lock()
            .insert(owner, ContributionOrigin::User);
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
        self.watchers.start(
            &run.task_id,
            &run.run_id,
            Path::new(&run.execution_root),
            sink,
        )
    }

    pub fn stop_watching_run(&self, run_id: &str) -> Result<(), String> {
        self.watchers.stop(run_id)
    }
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
        let branch = format!("cognia/task/{task_id}/{run_id}");
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
    let origin = meta
        .origin_hints
        .get(&(meta.run_id.to_string(), path.to_string()))
        .copied()
        .unwrap_or(ContributionOrigin::Agent);
    ResourceChange {
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
        sensitive: visible
            .map(|entry| entry.sensitive)
            .unwrap_or_else(|| is_sensitive_resource(path)),
        revision: meta.revision,
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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ChangeKind, IsolationKind, RunState, TaskWorkspaceState};
    use std::fs;
    use tempfile::TempDir;

    fn input(root: &TempDir, task_id: &str, run_id: &str) -> BeginTaskRun {
        BeginTaskRun {
            task_id: task_id.into(),
            session_id: "session-1".into(),
            run_id: run_id.into(),
            parent_run_id: None,
            agent_id: "agent-1".into(),
            agent_kind: "in-app".into(),
            workspace_root: root.path().to_string_lossy().into_owned(),
        }
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
            .begin_run(input(&workspace, "task-git", "run-git"))
            .unwrap();

        assert_eq!(run.isolation_kind, IsolationKind::GitWorktree);
        assert_eq!(
            run.isolation_ref.as_deref(),
            Some("cognia/task/task-git/run-git")
        );
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
}
