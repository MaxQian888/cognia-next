use crate::{
    ledger,
    resource::{is_sensitive_resource, media_type_for},
    snapshot::{
        capture_with_policy, materialize, EntryKind, GeneratedSnapshotEntry, SnapshotEntry,
        WorkspaceSnapshot,
    },
    store::WorkspaceStore,
    tracking::resolve_tracking_policy,
    AcquireWorkspaceBundle, BeginTaskRun, ChangeKind, ContributionOrigin, DownloadHandle,
    IsolationKind, ResourceCaptureClass, ResourceChange, ResourceEvent, ResourceEventEvidence,
    ResourceEventKind, ResourceKind, RunState, TaskResourceManifest, TaskResourceSummary, TaskRun,
    TaskWorkspace, TaskWorkspaceEventSink, TaskWorkspaceResourceEvent, TaskWorkspaceState,
    TransferChunk, TransferRegistry, UploadHandle, WatchManager, WorkspaceBaseSpec,
    WorkspaceOwnerType, WorkspaceProvisioning, WorkspaceRecord, WorkspaceRegistry,
    WorkspaceSourceBinding, WorkspaceState,
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
    registry: WorkspaceRegistry,
    execution_dir: PathBuf,
    manifest_key: Vec<u8>,
    retention: Duration,
    transfers: TransferRegistry,
    upload_owners: Mutex<HashMap<String, UploadOwner>>,
    origin_hints: Mutex<HashMap<(String, String), ContributionOrigin>>,
    watchers: WatchManager,
    /// `WorktreeCreate` / `WorktreeRemove` producer (ADR-0111 decision 9).
    lifecycle: crate::lifecycle::WorktreeLifecycleEmitter,
}

#[derive(Clone)]
struct UploadOwner {
    run_id: String,
    path: String,
    existed: bool,
}

struct InspectedBundleRoot {
    logical_root_id: String,
    role: crate::WorkspaceRootRole,
    source_root: PathBuf,
    repository_root: Option<PathBuf>,
    git_common_dir: Option<PathBuf>,
    isolation: IsolationKind,
}

struct BundleAcquiredRoot {
    record: WorkspaceRecord,
    source_root: PathBuf,
    execution_root: PathBuf,
}

struct BorrowedExecution {
    root: PathBuf,
    isolation_kind: IsolationKind,
    isolation_ref: Option<String>,
    base: WorkspaceBaseSpec,
}

struct ServiceBundleApplier<'a> {
    service: &'a TaskWorkspaceService,
    selections: HashMap<String, Vec<crate::PatchSelection>>,
    allow_irreversible: bool,
}

struct LogicalBundleSelection {
    path_prefix: String,
    selection: Vec<crate::PatchSelection>,
}

impl ServiceBundleApplier<'_> {
    fn target(&self, step: &crate::ApplyStep) -> Result<PathBuf, Vec<crate::PatchConflict>> {
        self.service
            .registry
            .get(&step.workspace_id)
            .map_err(|error| bundle_operation_conflict(step, error.to_string()))?
            .map(|record| PathBuf::from(record.source_root))
            .ok_or_else(|| bundle_operation_conflict(step, "managed workspace is missing"))
    }
}

impl crate::BundleApplier for ServiceBundleApplier<'_> {
    fn precheck(&self, step: &crate::ApplyStep) -> Result<(), Vec<crate::PatchConflict>> {
        let target = self.target(step)?;
        let scratch = self
            .service
            .execution_dir
            .parent()
            .unwrap_or(&self.service.execution_dir)
            .join("scratch");
        let mut store = self.service.store.lock();
        let patch = store
            .get_patch_set(&step.patch.run_id)
            .map_err(|error| bundle_operation_conflict(step, error))?
            .ok_or_else(|| bundle_operation_conflict(step, "patch set is missing"))?;
        let selection = self
            .selections
            .get(&step.workspace_id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let conflicts =
            ledger::precheck(&target, &scratch, &mut store, &patch, selection, now_ms())
                .map_err(|error| bundle_operation_conflict(step, error))?;
        conflicts.is_empty().then_some(()).ok_or(conflicts)
    }

    fn apply(&self, step: &crate::ApplyStep) -> Result<(), Vec<crate::PatchConflict>> {
        let target = self.target(step)?;
        let scratch = self
            .service
            .execution_dir
            .parent()
            .unwrap_or(&self.service.execution_dir)
            .join("scratch");
        let now = now_ms();
        let mut store = self.service.store.lock();
        let mut patch = store
            .get_patch_set(&step.patch.run_id)
            .map_err(|error| bundle_operation_conflict(step, error))?
            .ok_or_else(|| bundle_operation_conflict(step, "patch set is missing"))?;
        let mut task = store
            .get_task(&patch.task_id)
            .map_err(|error| bundle_operation_conflict(step, error))?
            .ok_or_else(|| bundle_operation_conflict(step, "task workspace is missing"))?;
        let revision = task.revision.saturating_add(1);
        let selection = self
            .selections
            .get(&step.workspace_id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let outcome = ledger::apply(
            &target,
            &scratch,
            &mut store,
            &mut patch,
            selection,
            ledger::ApplyOptions {
                revision,
                now,
                allow_irreversible: self.allow_irreversible,
            },
        )
        .map_err(|error| bundle_operation_conflict(step, error))?;
        if outcome.state == crate::PatchState::Applied {
            task.revision = revision;
            task.state = TaskWorkspaceState::Applied;
        } else {
            task.state = TaskWorkspaceState::Conflict;
        }
        store
            .put_patch_set(&patch)
            .and_then(|_| store.put_task(&task))
            .map_err(|error| bundle_operation_conflict(step, error))?;
        if outcome.state == crate::PatchState::Applied {
            Ok(())
        } else {
            Err(outcome.conflicts)
        }
    }

    fn compensate(&self, step: &crate::ApplyStep) -> Result<(), Vec<crate::PatchConflict>> {
        let target = self.target(step)?;
        let scratch = self
            .service
            .execution_dir
            .parent()
            .unwrap_or(&self.service.execution_dir)
            .join("scratch");
        let now = now_ms();
        let mut store = self.service.store.lock();
        let mut patch = store
            .get_patch_set(&step.patch.run_id)
            .map_err(|error| bundle_operation_conflict(step, error))?
            .ok_or_else(|| bundle_operation_conflict(step, "patch set is missing"))?;
        let mut task = store
            .get_task(&patch.task_id)
            .map_err(|error| bundle_operation_conflict(step, error))?
            .ok_or_else(|| bundle_operation_conflict(step, "task workspace is missing"))?;
        let revision = task.revision.saturating_add(1);
        let outcome = ledger::undo(&target, &scratch, &mut store, &mut patch, revision, now)
            .map_err(|error| bundle_operation_conflict(step, error))?;
        if outcome.state == crate::PatchState::Reverted {
            task.revision = revision;
            task.state = TaskWorkspaceState::Ready;
        } else {
            task.state = TaskWorkspaceState::Conflict;
        }
        store
            .put_patch_set(&patch)
            .and_then(|_| store.put_task(&task))
            .map_err(|error| bundle_operation_conflict(step, error))?;
        if outcome.state == crate::PatchState::Reverted {
            Ok(())
        } else {
            Err(outcome.conflicts)
        }
    }
}

impl TaskWorkspaceService {
    pub fn open(config: ServiceConfig) -> Result<Self, String> {
        let service_dir = config.data_dir.join("task-workspaces");
        let execution_dir = service_dir.join("executions");
        fs::create_dir_all(&execution_dir).map_err(|error| {
            format!("create execution dir {}: {error}", execution_dir.display())
        })?;
        let store = Arc::new(Mutex::new(WorkspaceStore::open(
            &service_dir,
            config.max_blob_bytes,
        )?));
        let registry =
            WorkspaceRegistry::new(Arc::clone(&store)).map_err(|error| error.to_string())?;
        let service = Self {
            store,
            registry,
            execution_dir,
            manifest_key: load_or_create_manifest_key(&service_dir)?,
            retention: config.retention,
            transfers: TransferRegistry::new(Duration::from_secs(5 * 60)),
            upload_owners: Mutex::new(HashMap::new()),
            origin_hints: Mutex::new(HashMap::new()),
            watchers: WatchManager::new(),
            lifecycle: crate::lifecycle::WorktreeLifecycleEmitter::default(),
        };
        service.recover_incomplete_runs()?;
        service.recover_workspace_bundle_turns()?;
        service.reconcile_known_worktrees()?;
        Ok(service)
    }

    /// Bind a stable repository ref to an explicitly trusted, device-local Git root.
    pub fn bind_workspace_source(
        &self,
        binding_ref: &str,
        source_root: &Path,
        now: i64,
    ) -> Result<WorkspaceSourceBinding, String> {
        validate_repository_binding_ref(binding_ref)?;
        let inspected = inspect_workspace_source(source_root)?;
        self.reject_registry_owned_source(&inspected.source_root)?;
        let existing = self
            .store
            .lock()
            .get_workspace_source_binding(binding_ref)?;
        let binding = WorkspaceSourceBinding {
            binding_ref: binding_ref.to_string(),
            source_root: inspected.source_root.to_string_lossy().into_owned(),
            git_common_dir: inspected.git_common_dir.to_string_lossy().into_owned(),
            repository_fingerprint: inspected.repository_fingerprint,
            created_at: existing.map_or(now, |entry| entry.created_at),
            updated_at: now,
        };
        self.store.lock().put_workspace_source_binding(&binding)?;
        Ok(binding)
    }

    pub fn list_workspace_source_bindings(&self) -> Result<Vec<WorkspaceSourceBinding>, String> {
        self.store.lock().list_workspace_source_bindings()
    }

    pub fn remove_workspace_source_binding(&self, binding_ref: &str) -> Result<bool, String> {
        validate_repository_binding_ref(binding_ref)?;
        self.store
            .lock()
            .delete_workspace_source_binding(binding_ref)
    }

    /// Resolve and revalidate a binding immediately before a worker run.
    pub fn resolve_workspace_source(
        &self,
        binding_ref: &str,
    ) -> Result<WorkspaceSourceBinding, String> {
        validate_repository_binding_ref(binding_ref)?;
        let binding = self
            .store
            .lock()
            .get_workspace_source_binding(binding_ref)?
            .ok_or_else(|| format!("workspace source is not bound: {binding_ref}"))?;
        let inspected = inspect_workspace_source(Path::new(&binding.source_root))?;
        self.reject_registry_owned_source(&inspected.source_root)?;
        if inspected.repository_fingerprint != binding.repository_fingerprint
            || inspected.git_common_dir.to_string_lossy() != binding.git_common_dir
        {
            return Err(format!(
                "workspace source binding changed and must be rebound: {binding_ref}"
            ));
        }
        Ok(binding)
    }

    /// Start an isolated run from a stable worker-local binding.
    pub fn begin_bound_run(
        &self,
        binding_ref: &str,
        mut input: BeginTaskRun,
    ) -> Result<TaskRun, String> {
        let binding = self.resolve_workspace_source(binding_ref)?;
        input.workspace_root = binding.source_root;
        self.begin_run(input)
    }

    /// Start resource tracking inside an already-provisioned Registry lease.
    ///
    /// The TaskRun borrows the physical directory: settling the run must not
    /// archive or remove the Bundle-owned environment.
    pub fn begin_bundle_run(
        &self,
        bundle_id: &str,
        logical_root_id: &str,
        mut input: BeginTaskRun,
    ) -> Result<TaskRun, String> {
        let bundle = self
            .store
            .lock()
            .get_workspace_bundle(bundle_id)?
            .ok_or_else(|| format!("workspace bundle not found: {bundle_id}"))?;
        if bundle.state != WorkspaceState::Active {
            return Err(format!("workspace bundle is not active: {bundle_id}"));
        }
        if bundle.environment_kind == crate::WorkspaceEnvironmentKind::Imported {
            return Err("imported environments must be adopted before execution".into());
        }
        if bundle.owner_type == WorkspaceOwnerType::Session
            && bundle.owner_ref.as_deref() != Some(input.session_id.as_str())
        {
            return Err("workspace bundle is owned by another session".into());
        }
        let lease = bundle
            .leases
            .iter()
            .find(|lease| lease.logical_root_id == logical_root_id)
            .ok_or_else(|| format!("workspace bundle has no logical root: {logical_root_id}"))?;
        let record = self
            .registry
            .get(&lease.workspace_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("managed workspace is missing: {}", lease.workspace_id))?;
        if record.state != WorkspaceState::Active {
            return Err(format!(
                "managed workspace is not active: {}",
                lease.workspace_id
            ));
        }
        let execution_root = PathBuf::from(&record.execution_root)
            .canonicalize()
            .map_err(|error| format!("canonicalize managed execution root: {error}"))?;
        let alias_root = PathBuf::from(&lease.alias_path)
            .canonicalize()
            .map_err(|error| format!("canonicalize workspace lease alias: {error}"))?;
        if !alias_root.starts_with(&execution_root) {
            return Err("workspace lease alias escapes its managed execution root".into());
        }
        input.workspace_root = alias_root.to_string_lossy().into_owned();
        input.base = record.base.clone();
        self.begin_run_internal(
            input,
            Some(BorrowedExecution {
                root: alias_root,
                isolation_kind: record.isolation_kind,
                isolation_ref: record.branch,
                base: record.base,
            }),
        )
    }

    /// Start one persisted turn across every unique physical workspace in a
    /// Registry Bundle. Logical roots sharing a workspace share one TaskRun,
    /// so watchers cover the physical root exactly once.
    pub fn begin_workspace_bundle_turn(
        &self,
        bundle_id: &str,
        request: crate::BeginWorkspaceBundleTurn,
    ) -> Result<crate::WorkspaceBundleTurnLease, String> {
        validate_id("taskId", &request.run.task_id)?;
        validate_id("runId", &request.run.run_id)?;
        let bundle = self
            .store
            .lock()
            .get_workspace_bundle(bundle_id)?
            .ok_or_else(|| format!("workspace bundle not found: {bundle_id}"))?;
        if bundle.state != WorkspaceState::Active {
            return Err(format!("workspace bundle is not active: {bundle_id}"));
        }
        if bundle.environment_kind == crate::WorkspaceEnvironmentKind::Imported {
            return Err("imported environments must be adopted before execution".into());
        }
        if bundle.owner_type == WorkspaceOwnerType::Session
            && bundle.owner_ref.as_deref() != Some(request.run.session_id.as_str())
        {
            return Err("workspace bundle is owned by another session".into());
        }
        let primary_lease = bundle
            .leases
            .iter()
            .find(|lease| lease.logical_root_id == request.primary_logical_root_id)
            .ok_or_else(|| {
                format!(
                    "workspace bundle has no logical root: {}",
                    request.primary_logical_root_id
                )
            })?;
        if primary_lease.role != crate::WorkspaceRootRole::Primary {
            return Err(format!(
                "workspace bundle logical root is not primary: {}",
                request.primary_logical_root_id
            ));
        }
        let bundle_turn_id = request
            .run
            .turn_id
            .clone()
            .unwrap_or_else(|| Uuid::now_v7().to_string());
        validate_id("bundleTurnId", &bundle_turn_id)?;
        if let Some(existing) = self
            .store
            .lock()
            .get_workspace_bundle_turn(&bundle_turn_id)?
        {
            let matches_runs = existing.runs.iter().all(|lease| {
                let suffix = &storage_key(&lease.workspace_id)[..12];
                lease.run.task_id == scoped_run_id(&request.run.task_id, suffix)
                    && lease.run.run_id == scoped_run_id(&request.run.run_id, suffix)
            });
            if existing.bundle_id == bundle_id
                && existing.primary_logical_root_id == request.primary_logical_root_id
                && matches_runs
            {
                return Ok(existing);
            }
            return Err(format!(
                "bundleTurnId is already owned by another workspace bundle: {bundle_turn_id}"
            ));
        }

        let mut workspace_ids = Vec::new();
        for lease in &bundle.leases {
            if !workspace_ids.contains(&lease.workspace_id) {
                workspace_ids.push(lease.workspace_id.clone());
            }
        }
        let prepared = workspace_ids
            .into_iter()
            .map(|workspace_id| {
                let record = self
                    .registry
                    .get(&workspace_id)
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| format!("managed workspace is missing: {workspace_id}"))?;
                if record.state != WorkspaceState::Active {
                    return Err(format!("managed workspace is not active: {workspace_id}"));
                }
                let execution_root = PathBuf::from(&record.execution_root)
                    .canonicalize()
                    .map_err(|error| format!("canonicalize managed execution root: {error}"))?;
                let logical_root_ids = bundle
                    .leases
                    .iter()
                    .filter(|lease| lease.workspace_id == workspace_id)
                    .map(|lease| lease.logical_root_id.clone())
                    .collect::<Vec<_>>();
                Ok((workspace_id, record, execution_root, logical_root_ids))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let mut opened_runs: Vec<crate::WorkspaceBundleTurnRunLease> =
            Vec::with_capacity(prepared.len());
        for (workspace_id, record, execution_root, logical_root_ids) in prepared {
            let mut input = request.run.clone();
            let suffix = &storage_key(&workspace_id)[..12];
            input.task_id = scoped_run_id(&request.run.task_id, suffix);
            input.run_id = scoped_run_id(&request.run.run_id, suffix);
            input.turn_id = Some(bundle_turn_id.clone());
            input.workspace_root = execution_root.to_string_lossy().into_owned();
            input.base = record.base.clone();
            let run = self.begin_run_internal(
                input,
                Some(BorrowedExecution {
                    root: execution_root,
                    isolation_kind: record.isolation_kind,
                    isolation_ref: record.branch,
                    base: record.base,
                }),
            );
            let run = match run {
                Ok(run) => run,
                Err(error) => {
                    for opened in &opened_runs {
                        let _ = self.settle_failed_run(&opened.run.run_id);
                    }
                    return Err(error);
                }
            };
            opened_runs.push(crate::WorkspaceBundleTurnRunLease {
                workspace_id,
                logical_root_ids,
                run,
            });
        }
        let now = now_ms();
        let turn = crate::WorkspaceBundleTurnLease {
            bundle_turn_id,
            bundle_id: bundle_id.to_string(),
            primary_logical_root_id: request.primary_logical_root_id,
            primary_alias: primary_lease.alias_path.clone(),
            additional_aliases: bundle
                .leases
                .iter()
                .filter(|lease| lease.role == crate::WorkspaceRootRole::Additional)
                .map(|lease| lease.alias_path.clone())
                .collect(),
            runs: opened_runs,
            state: RunState::Running,
            created_at: now,
            settled_at: None,
        };
        if let Err(error) = self.store.lock().put_workspace_bundle_turn(&turn) {
            for opened in &turn.runs {
                let _ = self.settle_failed_run(&opened.run.run_id);
            }
            return Err(error);
        }
        Ok(turn)
    }

    pub fn get_workspace_bundle_turn(
        &self,
        bundle_turn_id: &str,
    ) -> Result<Option<crate::WorkspaceBundleTurnLease>, String> {
        self.store.lock().get_workspace_bundle_turn(bundle_turn_id)
    }

    pub fn settle_workspace_bundle_turn(
        &self,
        bundle_turn_id: &str,
        final_state: RunState,
    ) -> Result<crate::WorkspaceBundleTurnOutcome, String> {
        if !matches!(
            final_state,
            RunState::Ready | RunState::Failed | RunState::Cancelled
        ) {
            return Err(format!(
                "invalid terminal bundle turn state: {final_state:?}"
            ));
        }
        let mut turn = self
            .store
            .lock()
            .get_workspace_bundle_turn(bundle_turn_id)?
            .ok_or_else(|| format!("workspace bundle turn not found: {bundle_turn_id}"))?;
        let mut outcomes = Vec::with_capacity(turn.runs.len());
        let mut all_resources = Vec::new();
        for lease in &mut turn.runs {
            let resources = match final_state {
                RunState::Ready => self.settle_run_single(&lease.run.run_id)?,
                RunState::Failed => {
                    let resources = self.settle_run_single(&lease.run.run_id)?;
                    self.set_run_terminal_state(&lease.run.run_id, RunState::Failed)?;
                    resources
                }
                RunState::Cancelled => {
                    let resources = self.settle_run_single(&lease.run.run_id)?;
                    self.set_run_terminal_state(&lease.run.run_id, RunState::Cancelled)?;
                    resources
                }
                RunState::Running | RunState::Settling => unreachable!(),
            };
            let (run, _): (TaskRun, WorkspaceSnapshot) = self
                .store
                .lock()
                .get_run(&lease.run.run_id)?
                .ok_or_else(|| format!("unknown task run: {}", lease.run.run_id))?;
            lease.run = run;
            all_resources.extend(resources.iter().cloned());
            outcomes.push(crate::WorkspaceBundleTurnRunOutcome {
                workspace_id: lease.workspace_id.clone(),
                logical_root_ids: lease.logical_root_ids.clone(),
                run_id: lease.run.run_id.clone(),
                state: lease.run.state,
                resources,
            });
        }
        let settled_at = now_ms();
        turn.state = final_state;
        turn.settled_at = Some(settled_at);
        self.store.lock().put_workspace_bundle_turn(&turn)?;
        Ok(crate::WorkspaceBundleTurnOutcome {
            bundle_turn_id: turn.bundle_turn_id,
            bundle_id: turn.bundle_id,
            state: final_state,
            runs: outcomes,
            resources: all_resources,
            settled_at,
        })
    }

    pub fn abort_workspace_bundle_turn(
        &self,
        bundle_turn_id: &str,
    ) -> Result<crate::WorkspaceBundleTurnOutcome, String> {
        self.settle_workspace_bundle_turn(bundle_turn_id, RunState::Cancelled)
    }

    /// Synchronize persisted Bundle turns with TaskRuns recovered at startup.
    pub fn recover_workspace_bundle_turns(
        &self,
    ) -> Result<Vec<crate::WorkspaceBundleTurnLease>, String> {
        let turns = self.store.lock().list_workspace_bundle_turns()?;
        let mut recovered = Vec::with_capacity(turns.len());
        for mut turn in turns {
            let mut states = Vec::with_capacity(turn.runs.len());
            for lease in &mut turn.runs {
                if let Some((run, _)) = self
                    .store
                    .lock()
                    .get_run::<WorkspaceSnapshot>(&lease.run.run_id)?
                {
                    lease.run = run;
                }
                states.push(lease.run.state);
            }
            turn.state = aggregate_bundle_turn_state(&states);
            if !matches!(turn.state, RunState::Running | RunState::Settling) {
                turn.settled_at.get_or_insert_with(now_ms);
            }
            self.store.lock().put_workspace_bundle_turn(&turn)?;
            recovered.push(turn);
        }
        Ok(recovered)
    }

    fn reject_registry_owned_source(&self, source_root: &Path) -> Result<(), String> {
        for workspace in self.registry.list().map_err(|error| error.to_string())? {
            let execution_root = PathBuf::from(&workspace.execution_root);
            let execution_root = execution_root.canonicalize().unwrap_or(execution_root);
            if source_root.starts_with(&execution_root) {
                return Err(format!(
                    "workspace source is a Registry-owned execution root: {}",
                    source_root.display()
                ));
            }
        }
        Ok(())
    }

    pub fn begin_run(&self, input: BeginTaskRun) -> Result<TaskRun, String> {
        self.begin_run_internal(input, None)
    }

    fn begin_run_internal(
        &self,
        input: BeginTaskRun,
        borrowed: Option<BorrowedExecution>,
    ) -> Result<TaskRun, String> {
        let _perf = cognia_instrument::guard("workspace.begin_run");
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
                    && existing.base == input.base
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
        if reusable.is_none() && borrowed.is_none() {
            self.enforce_managed_workspace_capacity(1)?;
        }
        let (
            baseline,
            blobs,
            execution_root,
            isolation_kind,
            isolation_ref,
            workspace_id,
            base,
            owns_execution,
        ) = if let Some(previous) = reusable {
            let execution_root = PathBuf::from(&previous.execution_root);
            if !execution_root.is_dir() {
                return Err(format!(
                    "pipeline workspace is unavailable: {}",
                    execution_root.display()
                ));
            }
            let (baseline, blobs) = capture_with_policy(&execution_root, &tracking_policy)?;
            if let Some(workspace_id) = previous.workspace_id.as_deref() {
                self.reactivate_managed_workspace(workspace_id)?;
            }
            (
                baseline,
                blobs,
                execution_root,
                previous.isolation_kind,
                previous.isolation_ref,
                previous.workspace_id,
                previous.base,
                false,
            )
        } else if let Some(borrowed) = borrowed {
            if borrowed.root != root {
                return Err("workspace lease changed during run acquisition".into());
            }
            let (baseline, blobs) = capture_with_policy(&root, &tracking_policy)?;
            (
                baseline,
                blobs,
                root.clone(),
                borrowed.isolation_kind,
                borrowed.isolation_ref,
                None,
                borrowed.base,
                false,
            )
        } else {
            let (mut baseline, mut blobs) = capture_with_policy(&root, &tracking_policy)?;
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
            let isolation_kind = if is_git_root(&root) {
                IsolationKind::GitWorktree
            } else {
                IsolationKind::Shadow
            };
            let (owner_type, owner_ref) = managed_owner(&input);
            let workspace_id = Uuid::now_v7().to_string();
            let record = self
                .registry
                .insert_reserved(
                    workspace_id,
                    owner_type,
                    owner_ref.clone(),
                    root.to_string_lossy().into_owned(),
                    git_common_dir(&root),
                    input.base.clone(),
                    isolation_kind,
                    execution_root.to_string_lossy().into_owned(),
                    now,
                )
                .map_err(|error| error.to_string())?;
            let created = create_execution(
                &root,
                &execution_root,
                &input.base,
                &baseline,
                &blobs,
                record.locked_by.as_deref(),
                // The single-root task path carries no repository declaration:
                // it is reached by callers that never read one.
                None,
            );
            let (created_kind, isolation_ref) = match created {
                Ok(created) => created,
                Err(error) => {
                    self.discard_managed_workspace(&record, now);
                    return Err(error);
                }
            };
            debug_assert_eq!(created_kind, isolation_kind);
            if input.base != WorkspaceBaseSpec::WorkingState {
                match capture_with_policy(&execution_root, &tracking_policy) {
                    Ok(captured) => (baseline, blobs) = captured,
                    Err(error) => {
                        self.rollback_managed_execution(
                            Some(&record.workspace_id),
                            &root,
                            &execution_root,
                            isolation_kind,
                            now,
                        );
                        return Err(error);
                    }
                }
            }
            if let Err(error) = self.registry.transition(
                &record.workspace_id,
                owner_type,
                owner_ref.as_deref(),
                WorkspaceState::Active,
                now,
            ) {
                unlock_git_worktree(&root, &execution_root, isolation_kind);
                cleanup_execution(&root, &execution_root, isolation_kind, None);
                self.discard_managed_workspace(&record, now);
                return Err(error.to_string());
            }
            // The worktree exists, is locked, and is Active: this is the
            // `WorktreeCreate` moment ADR-0111 decision 9 names.
            self.lifecycle.emit(
                crate::lifecycle::WorktreeLifecycleKind::Created,
                &record,
                Some(&input.session_id),
                None,
            );
            (
                baseline,
                blobs,
                execution_root,
                isolation_kind,
                isolation_ref,
                Some(record.workspace_id),
                input.base.clone(),
                true,
            )
        };

        let mut store = self.store.lock();
        for (hash, bytes) in &blobs {
            if let Err(error) = store.put_blob(hash, bytes, now) {
                if owns_execution {
                    drop(store);
                    self.rollback_managed_execution(
                        workspace_id.as_deref(),
                        &root,
                        &execution_root,
                        isolation_kind,
                        now,
                    );
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
                drop(store);
                self.rollback_managed_execution(
                    workspace_id.as_deref(),
                    &root,
                    &execution_root,
                    isolation_kind,
                    now,
                );
            }
            return Err("one task cannot span multiple workspace roots".into());
        }
        task.state = TaskWorkspaceState::Active;
        task.expires_at = now + self.retention.as_millis() as i64;
        if let Err(error) = store.put_task(&task) {
            if owns_execution {
                drop(store);
                self.rollback_managed_execution(
                    workspace_id.as_deref(),
                    &root,
                    &execution_root,
                    isolation_kind,
                    now,
                );
            }
            return Err(error);
        }
        let run = TaskRun {
            run_id: input.run_id,
            task_id: input.task_id,
            parent_run_id: input.parent_run_id,
            agent_id: input.agent_id,
            agent_kind: input.agent_kind,
            execution_root: execution_root.to_string_lossy().into_owned(),
            isolation_kind,
            isolation_ref,
            workspace_id,
            base,
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
        if let Err(error) = store.put_run(&run, &baseline) {
            if owns_execution {
                drop(store);
                self.rollback_managed_execution(
                    run.workspace_id.as_deref(),
                    &root,
                    &execution_root,
                    isolation_kind,
                    now,
                );
            }
            return Err(error);
        }
        Ok(run)
    }

    pub fn get_managed_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceRecord>, String> {
        self.registry
            .get(workspace_id)
            .map_err(|error| error.to_string())
    }

    /// Record the successful result of the host's existing
    /// `cognia_git::worktree::create_branch_here` operation.
    pub fn record_workspace_branch(
        &self,
        workspace_id: &str,
        branch: &str,
        head: Option<&str>,
    ) -> Result<WorkspaceRecord, String> {
        if branch.trim().is_empty()
            || branch.chars().any(char::is_control)
            || head
                .is_some_and(|value| value.trim().is_empty() || value.chars().any(char::is_control))
        {
            return Err("workspace branch metadata is invalid".into());
        }
        self.validate_workspace_branch_target(workspace_id)?;
        self.registry
            .set_branch_metadata(workspace_id, branch.to_string(), head.map(str::to_string))
            .map_err(|error| error.to_string())
    }

    /// Validate branch creation and return the Registry-owned worktree path
    /// that the host may pass to `cognia_git::worktree::create_branch_here`.
    pub fn workspace_branch_target(&self, workspace_id: &str) -> Result<String, String> {
        self.validate_workspace_branch_target(workspace_id)
            .map(|record| record.execution_root)
    }

    fn validate_workspace_branch_target(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceRecord, String> {
        let record = self
            .registry
            .get(workspace_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("workspace {workspace_id} not found"))?;
        if record.state != WorkspaceState::Active {
            return Err("branch metadata can only be recorded for an active environment".into());
        }
        if record.isolation_kind != IsolationKind::GitWorktree {
            return Err("branch metadata is only valid for a Git worktree".into());
        }
        if !matches!(
            record.environment_kind,
            crate::WorkspaceEnvironmentKind::Managed | crate::WorkspaceEnvironmentKind::Permanent
        ) {
            return Err("imported environments must be adopted before creating a branch".into());
        }
        Ok(record)
    }

    pub fn list_managed_workspaces(&self) -> Result<Vec<WorkspaceRecord>, String> {
        self.registry.list().map_err(|error| error.to_string())
    }

    /// Return one canonical inventory for both ordinary Git worktrees and
    /// Registry-owned environments. This query is read-only: discovering a
    /// manual worktree does not transfer ownership to the Registry.
    pub fn list_workspace_environments(
        &self,
        root_dir: Option<&Path>,
    ) -> Result<Vec<crate::WorkspaceEnvironmentSummary>, String> {
        let records = self.registry.list().map_err(|error| error.to_string())?;
        let requested_source = root_dir
            .map(|path| {
                git2::Repository::discover(path)
                    .map_err(|error| format!("discover workspace repository: {error}"))?
                    .workdir()
                    .map(Path::to_path_buf)
                    .ok_or_else(|| {
                        "bare repositories do not have workspace environments".to_string()
                    })?
                    .canonicalize()
                    .map_err(|error| format!("canonicalize workspace repository: {error}"))
            })
            .transpose()?;
        let requested_key = requested_source.as_deref().map(normalized_path_key);
        let mut source_roots = std::collections::BTreeSet::new();
        if let Some(source) = requested_source.as_ref() {
            source_roots.insert(source.to_string_lossy().into_owned());
        } else {
            source_roots.extend(
                records
                    .iter()
                    .filter(|record| record.isolation_kind == IsolationKind::GitWorktree)
                    .map(|record| record.source_root.clone()),
            );
            source_roots.extend(
                self.store
                    .lock()
                    .list_workspace_source_bindings()?
                    .into_iter()
                    .map(|binding| binding.source_root),
            );
        }

        let records_by_path = records
            .iter()
            .map(|record| {
                (
                    normalized_path_key(Path::new(&record.execution_root)),
                    record,
                )
            })
            .collect::<HashMap<_, _>>();
        let mut seen_paths = std::collections::HashSet::new();
        let mut summaries = Vec::new();
        for source_root in source_roots {
            let source = PathBuf::from(&source_root);
            let inventory = read_git_worktree_inventory(&source)?;
            let canonical_source = inventory
                .first()
                .map(|row| row.path.clone())
                .unwrap_or(source);
            let source_key = normalized_path_key(&canonical_source);
            for row in inventory {
                let path_key = normalized_path_key(&row.path);
                if !seen_paths.insert(path_key.clone()) {
                    continue;
                }
                let record = records_by_path.get(&path_key).copied();
                let ownership = if path_key == source_key {
                    crate::WorkspaceEnvironmentOwnership::Main
                } else {
                    record.map_or(crate::WorkspaceEnvironmentOwnership::Manual, |record| {
                        environment_ownership(record)
                    })
                };
                summaries.push(environment_summary_from_git(
                    &canonical_source,
                    row,
                    record,
                    ownership,
                ));
            }
        }
        for record in records {
            if requested_key.as_ref().is_some_and(|requested| {
                normalized_path_key(Path::new(&record.source_root)) != *requested
            }) {
                continue;
            }
            let path_key = normalized_path_key(Path::new(&record.execution_root));
            if seen_paths.insert(path_key) {
                summaries.push(environment_summary_from_record(&record));
            }
        }
        summaries.sort_by(|left, right| {
            environment_ownership_rank(left.ownership)
                .cmp(&environment_ownership_rank(right.ownership))
                .then_with(|| left.path.cmp(&right.path))
        });
        Ok(summaries)
    }

    /// Explicitly transfer one manual Git worktree into Registry ownership.
    /// The caller must echo the inventory identity and path; the service
    /// re-reads Git porcelain immediately before inserting only that row.
    pub fn adopt_workspace_environment(
        &self,
        environment_id: &str,
        source_root: &Path,
        path: &Path,
    ) -> Result<WorkspaceRecord, String> {
        let source_root = source_root
            .canonicalize()
            .map_err(|error| format!("canonicalize worktree source: {error}"))?;
        let target_key = normalized_path_key(path);
        let row = read_git_worktree_inventory(&source_root)?
            .into_iter()
            .find(|row| normalized_path_key(&row.path) == target_key)
            .ok_or_else(|| format!("manual workspace is no longer present: {}", path.display()))?;
        if normalized_path_key(&row.path) == normalized_path_key(&source_root) {
            return Err("the main worktree cannot be adopted".into());
        }
        let expected_environment_id = format!("git:{}", storage_key(&target_key));
        if environment_id != expected_environment_id {
            return Err("workspace environment identity changed; refresh the inventory".into());
        }
        if self
            .registry
            .list()
            .map_err(|error| error.to_string())?
            .iter()
            .any(|record| normalized_path_key(Path::new(&record.execution_root)) == target_key)
        {
            return Err("workspace environment is already Registry-owned".into());
        }
        let imported = self
            .registry
            .insert_imported(
                crate::ImportedWorkspaceHint {
                    source_root: source_root.to_string_lossy().into_owned(),
                    execution_root: row.path.to_string_lossy().into_owned(),
                    git_common_dir: git_common_dir(&source_root),
                    branch: row.branch,
                },
                now_ms(),
            )
            .map_err(|error| error.to_string())?;
        self.adopt_imported_workspace(&imported.workspace_id)
    }

    pub fn reconcile_known_worktrees(&self) -> Result<crate::ReconcileOutcome, String> {
        let records = self.registry.list().map_err(|error| error.to_string())?;
        let mut source_roots = records
            .iter()
            .filter(|record| record.isolation_kind == IsolationKind::GitWorktree)
            .map(|record| record.source_root.clone())
            .collect::<std::collections::BTreeSet<_>>();
        source_roots.extend(
            self.store
                .lock()
                .list_workspace_source_bindings()?
                .into_iter()
                .map(|binding| binding.source_root),
        );
        let mut outcome = crate::ReconcileOutcome {
            reclaimed: Vec::new(),
            orphaned: Vec::new(),
            imported: Vec::new(),
        };
        for source_root in source_roots {
            self.reconcile_git_source(Path::new(&source_root), &records, &mut outcome)?;
        }
        Ok(outcome)
    }

    /// Reconcile one Git repository and reject generic removal when the target
    /// is owned by the Registry. This is the host-side backstop for callers
    /// that bypass the manual Worktree panel (Companion, headless, or direct
    /// Tauri commands).
    ///
    /// Unknown linked worktrees are imported before the ownership check, so an
    /// external worktree cannot be force-removed in the same request that first
    /// exposes it to Cognia. Adopted/managed worktrees remain removable only via
    /// the Registry lifecycle commands, which verify their signed Git lock.
    pub fn ensure_manual_worktree_removal_allowed(
        &self,
        source_root: &Path,
        target: &Path,
    ) -> Result<(), String> {
        let source_root = source_root
            .canonicalize()
            .map_err(|error| format!("canonicalize worktree source: {error}"))?;
        let target = if target.is_absolute() {
            target.to_path_buf()
        } else {
            source_root.join(target)
        };
        let records = self.registry.list().map_err(|error| error.to_string())?;
        let mut outcome = crate::ReconcileOutcome {
            reclaimed: Vec::new(),
            orphaned: Vec::new(),
            imported: Vec::new(),
        };
        self.reconcile_git_source(&source_root, &records, &mut outcome)?;

        let target_key = normalized_path_key(&target);
        if let Some(record) = self
            .registry
            .list()
            .map_err(|error| error.to_string())?
            .into_iter()
            .find(|record| normalized_path_key(Path::new(&record.execution_root)) == target_key)
        {
            return Err(format!(
                "worktree {} is owned by workspace {} ({:?}); use the workspace Archive or Delete action",
                target.display(),
                record.workspace_id,
                record.environment_kind
            ));
        }
        Ok(())
    }

    fn reconcile_git_source(
        &self,
        source_root: &Path,
        records: &[WorkspaceRecord],
        outcome: &mut crate::ReconcileOutcome,
    ) -> Result<(), String> {
        let source_root = source_root
            .canonicalize()
            .map_err(|error| format!("canonicalize reconcile source: {error}"))?;
        let git_common_dir = git_common_dir(&source_root);
        let inventory = read_git_worktree_inventory(&source_root)?;
        let existing_paths = records
            .iter()
            .map(|record| normalized_path_key(Path::new(&record.execution_root)))
            .collect::<std::collections::HashSet<_>>();
        let inventory_by_path = inventory
            .iter()
            .map(|row| (normalized_path_key(&row.path), row))
            .collect::<HashMap<_, _>>();

        for record in records.iter().filter(|record| {
            record.isolation_kind == IsolationKind::GitWorktree
                && normalized_path_key(Path::new(&record.source_root))
                    == normalized_path_key(&source_root)
                && record.environment_kind != crate::WorkspaceEnvironmentKind::Imported
                && matches!(
                    record.state,
                    WorkspaceState::Active | WorkspaceState::Provisioning
                )
        }) {
            let path = normalized_path_key(Path::new(&record.execution_root));
            let verified = inventory_by_path.get(&path).is_some_and(|row| {
                row.lock_reason.as_deref() == record.locked_by.as_deref()
                    && record.git_common_dir == git_common_dir
            });
            if verified {
                outcome.reclaimed.push(record.workspace_id.clone());
            } else {
                outcome.orphaned.push(record.workspace_id.clone());
                if record.state == WorkspaceState::Active {
                    let _ = self.registry.transition(
                        &record.workspace_id,
                        record.owner_type,
                        record.owner_ref.as_deref(),
                        WorkspaceState::Conflict,
                        now_ms(),
                    );
                }
            }
        }

        let source_key = normalized_path_key(&source_root);
        for row in inventory {
            let path_key = normalized_path_key(&row.path);
            if path_key == source_key || existing_paths.contains(&path_key) {
                continue;
            }
            let hint = crate::ImportedWorkspaceHint {
                source_root: source_root.to_string_lossy().into_owned(),
                execution_root: row.path.to_string_lossy().into_owned(),
                git_common_dir: git_common_dir.clone(),
                branch: row.branch,
            };
            self.registry
                .insert_imported(hint.clone(), now_ms())
                .map_err(|error| error.to_string())?;
            outcome.imported.push(hint);
        }
        Ok(())
    }

    pub fn get_workspace_bundle(
        &self,
        bundle_id: &str,
    ) -> Result<Option<crate::WorkspaceBundle>, String> {
        self.store.lock().get_workspace_bundle(bundle_id)
    }

    pub fn list_workspace_bundles(&self) -> Result<Vec<crate::WorkspaceBundle>, String> {
        self.store.lock().list_workspace_bundles()
    }

    /// Atomically apply the settled patches from one Bundle turn back to all
    /// source roots. The existing ledger performs preflight/apply/undo; the
    /// Bundle executor only coordinates ordering and compensation.
    pub fn apply_workspace_bundle(
        &self,
        bundle_id: &str,
        request: crate::BundleHandoffRequest,
    ) -> Result<crate::BundleHandoffOutcome, String> {
        let mut bundle = self
            .store
            .lock()
            .get_workspace_bundle(bundle_id)?
            .ok_or_else(|| format!("workspace bundle not found: {bundle_id}"))?;
        let turn = self
            .store
            .lock()
            .get_workspace_bundle_turn(&request.bundle_turn_id)?
            .ok_or_else(|| {
                format!(
                    "workspace bundle turn not found: {}",
                    request.bundle_turn_id
                )
            })?;
        if turn.bundle_id != bundle_id {
            return Err("workspace bundle turn belongs to another bundle".into());
        }
        if turn.state != RunState::Ready {
            return Err(format!(
                "workspace bundle turn is not ready: {:?}",
                turn.state
            ));
        }

        let mut selection_specs: HashMap<String, Vec<LogicalBundleSelection>> = HashMap::new();
        for selected in &request.selections {
            let lease = bundle
                .leases
                .iter()
                .find(|lease| {
                    lease.workspace_id == selected.workspace_id
                        && lease.logical_root_id == selected.logical_root_id
                })
                .ok_or_else(|| {
                    format!(
                        "bundle selection does not match a logical root: {}/{}",
                        selected.workspace_id, selected.logical_root_id
                    )
                })?;
            let record = self
                .registry
                .get(&lease.workspace_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("managed workspace is missing: {}", lease.workspace_id))?;
            let prefix = Path::new(&lease.alias_path)
                .strip_prefix(Path::new(&record.execution_root))
                .map_err(|_| "bundle logical root escapes its physical workspace".to_string())?
                .to_string_lossy()
                .into_owned();
            let translated = selected
                .selection
                .iter()
                .map(|selection| {
                    Ok(crate::PatchSelection {
                        path: join_logical_selection_path(&prefix, &selection.path)?,
                        hunk_ids: selection.hunk_ids.clone(),
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            selection_specs
                .entry(lease.workspace_id.clone())
                .or_default()
                .push(LogicalBundleSelection {
                    path_prefix: prefix,
                    selection: translated,
                });
        }

        let selecting_subset = !request.selections.is_empty();
        let mut selections = HashMap::new();
        let mut patches = HashMap::new();
        let mut groups = Vec::with_capacity(turn.runs.len());
        for run_lease in &turn.runs {
            let record = self
                .registry
                .get(&run_lease.workspace_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| {
                    format!("managed workspace is missing: {}", run_lease.workspace_id)
                })?;
            let patch = self
                .store
                .lock()
                .get_patch_set(&run_lease.run.run_id)?
                .ok_or_else(|| format!("patch set is missing: {}", run_lease.run.run_id))?;
            if selecting_subset {
                if let Some(specs) = selection_specs.get(&run_lease.workspace_id) {
                    let mut combined = Vec::new();
                    for spec in specs {
                        if spec.selection.is_empty() {
                            combined.extend(
                                patch
                                    .files
                                    .iter()
                                    .filter(|file| {
                                        path_has_logical_prefix(&file.path, &spec.path_prefix)
                                    })
                                    .map(|file| crate::PatchSelection {
                                        path: file.path.clone(),
                                        hunk_ids: Vec::new(),
                                    }),
                            );
                        } else {
                            combined.extend(spec.selection.iter().cloned());
                        }
                    }
                    merge_patch_selections(&mut combined)?;
                    if combined.is_empty() {
                        continue;
                    }
                    selections.insert(run_lease.workspace_id.clone(), combined);
                } else {
                    continue;
                }
            }
            patches.insert(run_lease.workspace_id.clone(), patch);
            groups.push(crate::PhysicalLeaseGroup {
                bundle_id: bundle_id.to_string(),
                group_key: record
                    .git_common_dir
                    .clone()
                    .unwrap_or_else(|| format!("shadow:{}", record.workspace_id)),
                alias_path: record.source_root.clone(),
                isolation: record.isolation_kind,
                git_common_dir: record.git_common_dir,
                logical_root_ids: run_lease.logical_root_ids.clone(),
                workspace_id: Some(run_lease.workspace_id.clone()),
            });
        }
        let plan = crate::plan_bundle_apply(&bundle, &groups, patches)
            .map_err(|error| error.to_string())?;
        let applier = ServiceBundleApplier {
            service: self,
            selections,
            allow_irreversible: request.allow_irreversible,
        };
        let outcome = crate::execute_bundle_apply(&plan, &applier);
        bundle.state = outcome.state;
        self.store.lock().put_workspace_bundle(&bundle)?;
        if outcome.state == WorkspaceState::Conflict {
            let now = now_ms();
            for run in &turn.runs {
                if let Ok(Some(record)) = self.registry.get(&run.workspace_id) {
                    if record.state == WorkspaceState::Active {
                        let _ = self.registry.transition(
                            &record.workspace_id,
                            record.owner_type,
                            record.owner_ref.as_deref(),
                            WorkspaceState::Conflict,
                            now,
                        );
                    }
                }
            }
        }
        let handoff = crate::BundleHandoffOutcome {
            bundle_turn_id: request.bundle_turn_id.clone(),
            request,
            outcome,
        };
        self.store.lock().put_bundle_handoff_outcome(&handoff)?;
        Ok(handoff)
    }

    pub fn get_bundle_handoff_outcome(
        &self,
        bundle_turn_id: &str,
    ) -> Result<Option<crate::BundleHandoffOutcome>, String> {
        self.store.lock().get_bundle_handoff_outcome(bundle_turn_id)
    }

    /// Retry a persisted conflicted handoff after the user has repaired the
    /// source roots. Successfully compensated patches are reset to Ready;
    /// every root then passes through the same atomic precheck again.
    pub fn retry_workspace_bundle_handoff(
        &self,
        bundle_id: &str,
        request: crate::BundleHandoffRequest,
    ) -> Result<crate::BundleHandoffOutcome, String> {
        let previous = self
            .store
            .lock()
            .get_bundle_handoff_outcome(&request.bundle_turn_id)?
            .ok_or_else(|| {
                format!(
                    "workspace bundle handoff not found: {}",
                    request.bundle_turn_id
                )
            })?;
        if previous.outcome.bundle_id != bundle_id
            || previous.outcome.state != WorkspaceState::Conflict
            || previous.request != request
        {
            return Err(
                "only the persisted request for a conflicted bundle handoff can be retried".into(),
            );
        }
        let turn = self
            .store
            .lock()
            .get_workspace_bundle_turn(&request.bundle_turn_id)?
            .ok_or_else(|| {
                format!(
                    "workspace bundle turn not found: {}",
                    request.bundle_turn_id
                )
            })?;
        {
            let store = self.store.lock();
            for run in &turn.runs {
                let mut patch = store
                    .get_patch_set(&run.run.run_id)?
                    .ok_or_else(|| format!("patch set is missing: {}", run.run.run_id))?;
                match patch.state {
                    crate::PatchState::Reverted => {
                        patch.state = crate::PatchState::Ready;
                        patch.applied_revision = None;
                        patch.applied_files.clear();
                        patch.applied_selection.clear();
                        patch.applied_selection_known = false;
                        patch.reversible = true;
                        store.put_patch_set(&patch)?;
                    }
                    crate::PatchState::Ready | crate::PatchState::Conflict => {}
                    crate::PatchState::Applied => {
                        return Err(format!(
                            "bundle retry cannot reset an applied patch: {}",
                            patch.patch_id
                        ));
                    }
                }
            }
        }
        let now = now_ms();
        for run in &turn.runs {
            if let Some(record) = self
                .registry
                .get(&run.workspace_id)
                .map_err(|error| error.to_string())?
            {
                if record.state == WorkspaceState::Conflict {
                    self.registry
                        .transition(
                            &record.workspace_id,
                            record.owner_type,
                            record.owner_ref.as_deref(),
                            WorkspaceState::Active,
                            now,
                        )
                        .map_err(|error| error.to_string())?;
                }
            }
        }
        let mut bundle = self
            .store
            .lock()
            .get_workspace_bundle(bundle_id)?
            .ok_or_else(|| format!("workspace bundle not found: {bundle_id}"))?;
        bundle.state = WorkspaceState::Active;
        self.store.lock().put_workspace_bundle(&bundle)?;
        self.apply_workspace_bundle(bundle_id, request)
    }

    /// Undo a successfully applied Bundle handoff as one persisted operation.
    /// Roots are reverted in reverse apply order. If an undo fails after an
    /// earlier root was reverted, those roots are re-applied in original
    /// order so the Bundle returns to its pre-undo state whenever possible.
    pub fn undo_workspace_bundle_handoff(
        &self,
        bundle_id: &str,
        bundle_turn_id: &str,
    ) -> Result<crate::BundleHandoffUndoOutcome, String> {
        let handoff = self
            .store
            .lock()
            .get_bundle_handoff_outcome(bundle_turn_id)?
            .ok_or_else(|| format!("workspace bundle handoff not found: {bundle_turn_id}"))?;
        if handoff.outcome.bundle_id != bundle_id
            || handoff.outcome.state != WorkspaceState::Active
            || !handoff.outcome.conflicts.is_empty()
        {
            return Err("only a successfully applied bundle handoff can be undone".into());
        }
        if let Some(previous) = self
            .store
            .lock()
            .get_bundle_handoff_undo_outcome(bundle_turn_id)?
        {
            if previous.bundle_id != bundle_id {
                return Err("bundle handoff undo belongs to another bundle".into());
            }
            if previous.state == WorkspaceState::Conflict || previous.conflicts.is_empty() {
                return Ok(previous);
            }
        }

        let bundle = self
            .store
            .lock()
            .get_workspace_bundle(bundle_id)?
            .ok_or_else(|| format!("workspace bundle not found: {bundle_id}"))?;
        if bundle.state != WorkspaceState::Active {
            return Err(format!("workspace bundle is not active: {bundle_id}"));
        }
        let turn = self
            .store
            .lock()
            .get_workspace_bundle_turn(bundle_turn_id)?
            .ok_or_else(|| format!("workspace bundle turn not found: {bundle_turn_id}"))?;
        if turn.bundle_id != bundle_id {
            return Err("workspace bundle turn belongs to another bundle".into());
        }

        let retrying_compensated_failure = self
            .store
            .lock()
            .get_bundle_handoff_undo_outcome(bundle_turn_id)?
            .is_some_and(|outcome| !outcome.conflicts.is_empty());
        let mut selections = HashMap::new();
        let mut steps = Vec::with_capacity(handoff.outcome.applied.len());
        for (step_index, workspace_id) in handoff.outcome.applied.iter().enumerate() {
            let run = turn
                .runs
                .iter()
                .find(|run| run.workspace_id == *workspace_id)
                .ok_or_else(|| {
                    format!("bundle turn has no run for applied workspace: {workspace_id}")
                })?;
            let record = self
                .registry
                .get(workspace_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("managed workspace is missing: {workspace_id}"))?;
            let patch = self
                .store
                .lock()
                .get_patch_set(&run.run.run_id)?
                .ok_or_else(|| format!("patch set is missing: {}", run.run.run_id))?;
            let valid_state = patch.state == crate::PatchState::Applied
                || (retrying_compensated_failure && patch.state == crate::PatchState::Conflict);
            if !valid_state {
                return Err(format!(
                    "bundle handoff patch cannot be undone from state {:?}: {}",
                    patch.state, patch.patch_id
                ));
            }
            if !patch.reversible {
                return Err(format!(
                    "bundle handoff patch was applied irreversibly: {}",
                    patch.patch_id
                ));
            }
            if !patch.applied_selection_known {
                return Err(format!(
                    "bundle handoff patch has no persisted apply selection: {}",
                    patch.patch_id
                ));
            }
            if self.store.lock().get_task(&patch.task_id)?.is_none() {
                return Err(format!("task workspace is missing: {}", patch.task_id));
            }
            selections.insert(workspace_id.clone(), patch.applied_selection.clone());
            steps.push(crate::ApplyStep {
                step_index,
                workspace_id: workspace_id.clone(),
                alias_path: record.source_root,
                patch,
            });
        }

        let applier = ServiceBundleApplier {
            service: self,
            selections,
            allow_irreversible: handoff.request.allow_irreversible,
        };
        let mut reverted_steps = Vec::new();
        let mut conflicts = Vec::new();
        for step in steps.iter().rev() {
            match crate::BundleApplier::compensate(&applier, step) {
                Ok(()) => reverted_steps.push(step.clone()),
                Err(mut undo_conflicts) => {
                    conflicts.append(&mut undo_conflicts);
                    break;
                }
            }
        }

        let mut re_applied = Vec::new();
        if !conflicts.is_empty() {
            for step in reverted_steps.iter().rev() {
                self.reset_reverted_bundle_patch(&step.patch.run_id)?;
                match crate::BundleApplier::apply(&applier, step) {
                    Ok(()) => re_applied.push(step.workspace_id.clone()),
                    Err(mut apply_conflicts) => conflicts.append(&mut apply_conflicts),
                }
            }
        }
        let re_applied_set = re_applied.iter().collect::<std::collections::HashSet<_>>();
        let reverted = reverted_steps
            .iter()
            .filter(|step| !re_applied_set.contains(&step.workspace_id))
            .map(|step| step.workspace_id.clone())
            .collect::<Vec<_>>();
        let state = if conflicts.is_empty() || reverted.is_empty() {
            WorkspaceState::Active
        } else {
            WorkspaceState::Conflict
        };
        let outcome = crate::BundleHandoffUndoOutcome {
            bundle_turn_id: bundle_turn_id.to_string(),
            bundle_id: bundle_id.to_string(),
            reverted,
            re_applied,
            conflicts,
            state,
        };
        self.store
            .lock()
            .put_bundle_handoff_undo_outcome(&outcome)?;
        self.persist_bundle_operation_state(&turn, state)?;
        Ok(outcome)
    }

    pub fn get_bundle_handoff_undo_outcome(
        &self,
        bundle_turn_id: &str,
    ) -> Result<Option<crate::BundleHandoffUndoOutcome>, String> {
        self.store
            .lock()
            .get_bundle_handoff_undo_outcome(bundle_turn_id)
    }

    fn reset_reverted_bundle_patch(&self, run_id: &str) -> Result<(), String> {
        let store = self.store.lock();
        let mut patch = store
            .get_patch_set(run_id)?
            .ok_or_else(|| format!("patch set is missing: {run_id}"))?;
        if patch.state != crate::PatchState::Reverted {
            return Err(format!(
                "bundle undo compensation expected a reverted patch: {}",
                patch.patch_id
            ));
        }
        patch.state = crate::PatchState::Ready;
        patch.applied_revision = None;
        patch.applied_files.clear();
        store.put_patch_set(&patch)
    }

    fn persist_bundle_operation_state(
        &self,
        turn: &crate::WorkspaceBundleTurnLease,
        state: WorkspaceState,
    ) -> Result<(), String> {
        let mut bundle = self
            .store
            .lock()
            .get_workspace_bundle(&turn.bundle_id)?
            .ok_or_else(|| format!("workspace bundle not found: {}", turn.bundle_id))?;
        bundle.state = state;
        self.store.lock().put_workspace_bundle(&bundle)?;
        if state == WorkspaceState::Conflict {
            let now = now_ms();
            for run in &turn.runs {
                if let Ok(Some(record)) = self.registry.get(&run.workspace_id) {
                    if record.state == WorkspaceState::Active {
                        let _ = self.registry.transition(
                            &record.workspace_id,
                            record.owner_type,
                            record.owner_ref.as_deref(),
                            WorkspaceState::Conflict,
                            now,
                        );
                    }
                }
            }
        }
        Ok(())
    }

    /// Provision every writable root as one transactionally acquired bundle.
    pub fn acquire_workspace_bundle(
        &self,
        input: AcquireWorkspaceBundle,
    ) -> Result<crate::WorkspaceBundle, String> {
        let _perf = cognia_instrument::guard("workspace.acquire_bundle");
        if input.owner_type == WorkspaceOwnerType::Imported {
            return Err("imported environments can only be registered by reconciliation".into());
        }
        if input.environment_kind == crate::WorkspaceEnvironmentKind::Imported {
            return Err("imported environments cannot be provisioned".into());
        }
        let inspected = input
            .roots
            .iter()
            .map(inspect_bundle_root)
            .collect::<Result<Vec<_>, _>>()?;
        let requests = inspected
            .iter()
            .map(|root| crate::RootRequest {
                logical_root_id: root.logical_root_id.clone(),
                role: root.role,
                source_root: root.source_root.to_string_lossy().into_owned(),
                isolation: root.isolation,
                git_common_dir: root
                    .git_common_dir
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned()),
            })
            .collect::<Vec<_>>();
        let now = now_ms();
        let (mut bundle, groups) = crate::plan_bundle_composition(
            input.owner_type,
            input.owner_ref.clone(),
            &requests,
            now,
        )
        .map_err(|error| error.to_string())?;
        self.enforce_managed_workspace_capacity(groups.len() as u32)?;

        let mut acquired = Vec::with_capacity(groups.len());
        for group in &groups {
            let _perf_root = cognia_instrument::guard("workspace.acquire_root");
            let logical_id = group
                .logical_root_ids
                .first()
                .ok_or_else(|| "bundle planner returned an empty physical group".to_string())?;
            let root = inspected
                .iter()
                .find(|root| &root.logical_root_id == logical_id)
                .ok_or_else(|| {
                    format!("bundle root disappeared during provisioning: {logical_id}")
                })?;
            let source_root = root.repository_root.as_deref().unwrap_or(&root.source_root);
            let workspace_id = group
                .workspace_id
                .clone()
                .ok_or_else(|| "bundle planner omitted workspace identity".to_string())?;
            let execution_root = self
                .execution_dir
                .join("bundles")
                .join(storage_key(&bundle.bundle_id))
                .join(storage_key(&workspace_id));
            let provisioned = (|| {
                let (mut baseline, blobs) =
                    capture_with_policy(source_root, &crate::ResourceTrackingPolicy::default())?;
                baseline.generated_entries.clear();
                let record = self
                    .registry
                    .insert_reserved(
                        workspace_id,
                        input.owner_type,
                        input.owner_ref.clone(),
                        source_root.to_string_lossy().into_owned(),
                        root.git_common_dir
                            .as_ref()
                            .map(|path| path.to_string_lossy().into_owned()),
                        input.base.clone(),
                        root.isolation,
                        execution_root.to_string_lossy().into_owned(),
                        now,
                    )
                    .map_err(|error| error.to_string())?;
                let record = self
                    .registry
                    .set_environment_kind(&record.workspace_id, input.environment_kind)
                    .map_err(|error| error.to_string())?;
                // Stamp the owning Workspace, so "which execution slots does
                // this project own" is answerable — deleting a project can then
                // find the directories it produced, and the inventory can be
                // scoped instead of only shown machine-wide.
                self.registry
                    .set_project(&record.workspace_id, input.project_id.as_deref())
                    .map_err(|error| error.to_string())?;
                if let Err(error) = create_execution(
                    source_root,
                    &execution_root,
                    &input.base,
                    &baseline,
                    &blobs,
                    record.locked_by.as_deref(),
                    input.provisioning.as_ref(),
                ) {
                    self.discard_managed_workspace(&record, now);
                    return Err(error);
                }
                let record = match self.registry.transition(
                    &record.workspace_id,
                    record.owner_type,
                    record.owner_ref.as_deref(),
                    WorkspaceState::Active,
                    now,
                ) {
                    Ok(record) => record,
                    Err(error) => {
                        self.rollback_managed_execution(
                            Some(&record.workspace_id),
                            source_root,
                            &execution_root,
                            root.isolation,
                            now,
                        );
                        return Err(error.to_string());
                    }
                };
                self.lifecycle.emit(
                    crate::lifecycle::WorktreeLifecycleKind::Created,
                    &record,
                    None,
                    None,
                );
                Ok(BundleAcquiredRoot {
                    record,
                    source_root: source_root.to_path_buf(),
                    execution_root,
                })
            })();
            match provisioned {
                Ok(root) => acquired.push(root),
                Err(error) => {
                    self.rollback_acquired_bundle_roots(&acquired, now);
                    return Err(error);
                }
            }
        }

        bundle.environment_kind = input.environment_kind;
        bundle.state = WorkspaceState::Active;
        for lease in &mut bundle.leases {
            let acquired_root = acquired
                .iter()
                .find(|root| root.record.workspace_id == lease.workspace_id)
                .ok_or_else(|| {
                    format!("missing acquired root for lease {}", lease.logical_root_id)
                })?;
            let logical_root = inspected
                .iter()
                .find(|root| root.logical_root_id == lease.logical_root_id)
                .ok_or_else(|| format!("missing logical root {}", lease.logical_root_id))?;
            let relative = logical_root
                .repository_root
                .as_deref()
                .and_then(|repository_root| {
                    logical_root.source_root.strip_prefix(repository_root).ok()
                });
            lease.alias_path = relative
                .filter(|path| !path.as_os_str().is_empty())
                .map(|path| acquired_root.execution_root.join(path))
                .unwrap_or_else(|| acquired_root.execution_root.clone())
                .to_string_lossy()
                .into_owned();
        }
        if let Err(error) = self.store.lock().put_workspace_bundle(&bundle) {
            let store = self.store.lock();
            let _ = store.delete_bundle_leases(&bundle.bundle_id);
            let _ = store.delete_workspace_bundle(&bundle.bundle_id);
            drop(store);
            self.rollback_acquired_bundle_roots(&acquired, now);
            return Err(error);
        }
        Ok(bundle)
    }

    pub fn workspace_lifecycle_policy(&self) -> crate::WorkspaceLifecyclePolicy {
        self.registry.policy()
    }

    pub fn set_workspace_lifecycle_policy(
        &self,
        policy: crate::WorkspaceLifecyclePolicy,
    ) -> Result<crate::WorkspaceLifecyclePolicy, String> {
        if policy.active_directory_cap == 0 {
            return Err("active directory cap must be greater than zero".into());
        }
        if policy.snapshot_retention_days == 0 {
            return Err("snapshot retention must be greater than zero".into());
        }
        if policy.blob_budget_bytes == 0 {
            return Err("blob budget must be greater than zero".into());
        }
        self.registry
            .set_policy(policy)
            .map_err(|error| error.to_string())?;
        Ok(policy)
    }

    /// Execute one host-side Registry maintenance pass. Candidate planning is
    /// delegated to the existing retention planners; this method only applies
    /// their safe lifecycle operations and records durable history.
    pub fn run_workspace_maintenance(
        &self,
        request: crate::WorkspaceMaintenanceRequest,
    ) -> Result<crate::WorkspaceMaintenanceResult, String> {
        let started_at = request.now.unwrap_or_else(now_ms);
        let reconcile = self.reconcile_known_worktrees()?;
        let mut events = vec![crate::WorkspaceMaintenanceEvent {
            event_id: Uuid::now_v7().to_string(),
            kind: crate::WorkspaceMaintenanceEventKind::Reconciled,
            workspace_id: None,
            occurred_at: started_at,
            detail: format!(
                "reclaimed={}, orphaned={}, imported={}",
                reconcile.reclaimed.len(),
                reconcile.orphaned.len(),
                reconcile.imported.len()
            ),
        }];
        let policy = self.registry.policy();
        let records = self.registry.list().map_err(|error| error.to_string())?;
        let protected_workspace_ids = self.workspace_ids_with_unsettled_or_unapplied_tasks()?;
        let directory_candidates = crate::plan_directory_reclaim(&records, policy)
            .into_iter()
            .filter(|candidate| !protected_workspace_ids.contains(&candidate.workspace_id));
        let mut reclaimed_workspace_ids = Vec::new();
        for candidate in directory_candidates {
            match self.archive_managed_workspace(&candidate.workspace_id) {
                Ok(_) => {
                    reclaimed_workspace_ids.push(candidate.workspace_id.clone());
                    events.push(crate::WorkspaceMaintenanceEvent {
                        event_id: Uuid::now_v7().to_string(),
                        kind: crate::WorkspaceMaintenanceEventKind::DirectoryReclaimed,
                        workspace_id: Some(candidate.workspace_id),
                        occurred_at: started_at,
                        detail: format!("{:?}", candidate.reason),
                    });
                }
                Err(error) => events.push(crate::WorkspaceMaintenanceEvent {
                    event_id: Uuid::now_v7().to_string(),
                    kind: crate::WorkspaceMaintenanceEventKind::Failed,
                    workspace_id: Some(candidate.workspace_id),
                    occurred_at: started_at,
                    detail: error,
                }),
            }
        }

        let records = self.registry.list().map_err(|error| error.to_string())?;
        let snapshot_candidates = crate::plan_snapshot_expiration(&records, policy, started_at)
            .into_iter()
            .filter(|candidate| !protected_workspace_ids.contains(&candidate.workspace_id));
        let mut expired_snapshot_task_ids = Vec::new();
        for candidate in snapshot_candidates {
            match self.delete_managed_workspace(&candidate.workspace_id) {
                Ok(()) => {
                    expired_snapshot_task_ids.push(candidate.snapshot_task_id.clone());
                    events.push(crate::WorkspaceMaintenanceEvent {
                        event_id: Uuid::now_v7().to_string(),
                        kind: crate::WorkspaceMaintenanceEventKind::SnapshotExpired,
                        workspace_id: Some(candidate.workspace_id),
                        occurred_at: started_at,
                        detail: format!("{:?}", candidate.reason),
                    });
                }
                Err(error) => events.push(crate::WorkspaceMaintenanceEvent {
                    event_id: Uuid::now_v7().to_string(),
                    kind: crate::WorkspaceMaintenanceEventKind::Failed,
                    workspace_id: Some(candidate.workspace_id),
                    occurred_at: started_at,
                    detail: error,
                }),
            }
        }
        let (removed_blob_count, reclaimed_bytes) =
            match self.store.lock().prune_unreferenced_blobs() {
                Ok(outcome) => outcome,
                Err(error) => {
                    events.push(crate::WorkspaceMaintenanceEvent {
                        event_id: Uuid::now_v7().to_string(),
                        kind: crate::WorkspaceMaintenanceEventKind::Failed,
                        workspace_id: None,
                        occurred_at: started_at,
                        detail: error,
                    });
                    (0, 0)
                }
            };
        self.store
            .lock()
            .append_workspace_maintenance_events(&events)?;
        Ok(crate::WorkspaceMaintenanceResult {
            started_at,
            finished_at: now_ms().max(started_at),
            reconcile,
            reclaimed_workspace_ids,
            expired_snapshot_task_ids,
            removed_blob_count,
            reclaimed_bytes,
            events,
        })
    }

    pub fn list_workspace_maintenance_events(
        &self,
        limit: u32,
    ) -> Result<Vec<crate::WorkspaceMaintenanceEvent>, String> {
        if limit == 0 || limit > 1_000 {
            return Err("workspace maintenance event limit must be between 1 and 1000".into());
        }
        self.store.lock().list_workspace_maintenance_events(limit)
    }

    fn workspace_ids_with_unsettled_or_unapplied_tasks(
        &self,
    ) -> Result<std::collections::HashSet<String>, String> {
        let store = self.store.lock();
        let mut protected = std::collections::HashSet::new();
        for task in store.list_tasks()? {
            if store.task_is_prunable(&task.task_id)? {
                continue;
            }
            protected.extend(
                store
                    .list_runs(&task.task_id)?
                    .into_iter()
                    .filter_map(|run| run.workspace_id),
            );
        }
        Ok(protected)
    }

    fn enforce_managed_workspace_capacity(&self, requested: u32) -> Result<(), String> {
        let policy = self.registry.policy();
        let active_managed = self
            .registry
            .list()
            .map_err(|error| error.to_string())?
            .into_iter()
            .filter(|record| {
                record.environment_kind == crate::WorkspaceEnvironmentKind::Managed
                    && matches!(
                        record.state,
                        WorkspaceState::Provisioning | WorkspaceState::Active
                    )
            })
            .count() as u32;
        if active_managed.saturating_add(requested) > policy.active_directory_cap {
            return Err(format!(
                "managed workspace capacity reached ({active_managed}+{requested}/{}); archive an environment or raise the limit in Workspace settings",
                policy.active_directory_cap
            ));
        }
        Ok(())
    }

    fn rollback_acquired_bundle_roots(&self, roots: &[BundleAcquiredRoot], now: i64) {
        for root in roots.iter().rev() {
            self.rollback_managed_execution(
                Some(&root.record.workspace_id),
                &root.source_root,
                &root.execution_root,
                root.record.isolation_kind,
                now,
            );
        }
    }

    pub fn set_managed_workspace_pinned(
        &self,
        workspace_id: &str,
        pinned: bool,
    ) -> Result<WorkspaceRecord, String> {
        let record = self
            .registry
            .get(workspace_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("workspace {workspace_id} not found"))?;
        if record.environment_kind != crate::WorkspaceEnvironmentKind::Managed
            || !matches!(
                record.state,
                WorkspaceState::Active | WorkspaceState::Archived | WorkspaceState::Restorable
            )
        {
            return Err("only active or restorable managed environments can be pinned".into());
        }
        self.registry
            .set_pinned(workspace_id, pinned)
            .map_err(|error| error.to_string())
    }

    pub fn make_workspace_permanent(&self, workspace_id: &str) -> Result<WorkspaceRecord, String> {
        let record = self
            .registry
            .get(workspace_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("workspace {workspace_id} not found"))?;
        if record.state != WorkspaceState::Active {
            return Err("only an active environment can be made permanent".into());
        }
        if record.environment_kind != crate::WorkspaceEnvironmentKind::Managed {
            return Err("only a managed environment can be made permanent".into());
        }
        self.registry
            .set_environment_kind(workspace_id, crate::WorkspaceEnvironmentKind::Permanent)
            .map_err(|error| error.to_string())
    }

    pub fn adopt_imported_workspace(&self, workspace_id: &str) -> Result<WorkspaceRecord, String> {
        let record = self
            .registry
            .get(workspace_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("workspace {workspace_id} not found"))?;
        if record.environment_kind != crate::WorkspaceEnvironmentKind::Imported
            || record.owner_type != WorkspaceOwnerType::Imported
        {
            return Err("only an imported environment can be adopted".into());
        }
        if record.state != WorkspaceState::Active {
            return Err("only an active imported environment can be adopted".into());
        }
        self.enforce_managed_workspace_capacity(1)?;
        let lock_reason = crate::registry::compose_lock_reason(workspace_id);
        if record.isolation_kind == IsolationKind::GitWorktree {
            match managed_git_lock_reason(
                Path::new(&record.source_root),
                Path::new(&record.execution_root),
            )? {
                Some(existing_reason) if existing_reason == lock_reason => {
                    // A matching lock can remain after a process exit between
                    // the physical lock and the Registry transaction. Resume
                    // that adoption instead of stranding the imported row.
                }
                Some(existing_reason) => {
                    return Err(format!(
                        "imported worktree is locked by another owner ({existing_reason}); unlock it explicitly before adoption"
                    ));
                }
                None => {
                    let lock = Command::new("git")
                        .args(["-C"])
                        .arg(&record.source_root)
                        .args(["worktree", "lock", "--reason", &lock_reason])
                        .arg(&record.execution_root)
                        .output()
                        .map_err(|error| format!("start git worktree adoption lock: {error}"))?;
                    if !lock.status.success() {
                        return Err(format!(
                            "adopt imported worktree lock failed: {}",
                            String::from_utf8_lossy(&lock.stderr).trim()
                        ));
                    }
                }
            }
        }
        match self.registry.adopt_imported(
            workspace_id,
            WorkspaceOwnerType::User,
            None,
            crate::WorkspaceEnvironmentKind::Managed,
        ) {
            Ok(adopted) => Ok(adopted),
            Err(error) => {
                if record.isolation_kind == IsolationKind::GitWorktree {
                    let unlock = Command::new("git")
                        .args(["-C"])
                        .arg(&record.source_root)
                        .args(["worktree", "unlock"])
                        .arg(&record.execution_root)
                        .output()
                        .map_err(|unlock_error| {
                            format!(
                                "adoption Registry update failed: {error}; recovery could not start git worktree unlock: {unlock_error}; inspect {} before retrying",
                                record.execution_root
                            )
                        })?;
                    if !unlock.status.success() {
                        return Err(format!(
                            "adoption Registry update failed: {error}; recovery could not unlock the worktree: {}; inspect {} before retrying",
                            String::from_utf8_lossy(&unlock.stderr).trim(),
                            record.execution_root
                        ));
                    }
                }
                Err(error.to_string())
            }
        }
    }

    pub fn archive_managed_workspace(&self, workspace_id: &str) -> Result<WorkspaceRecord, String> {
        let mut record = self
            .registry
            .get(workspace_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("workspace {workspace_id} not found"))?;
        match record.environment_kind {
            crate::WorkspaceEnvironmentKind::Imported => {
                return Err("imported environments cannot be archived before adoption".into())
            }
            crate::WorkspaceEnvironmentKind::Permanent => {
                return Err(
                    "permanent environments require an explicit detach before archive".into(),
                )
            }
            crate::WorkspaceEnvironmentKind::Managed => {}
        }
        if !matches!(
            record.state,
            WorkspaceState::Active | WorkspaceState::Archived
        ) {
            return Err(format!(
                "workspace {workspace_id} cannot be archived from state {:?}",
                record.state
            ));
        }
        let execution_root = Path::new(&record.execution_root);
        if execution_root.is_dir() {
            let (snapshot, blobs) =
                capture_with_policy(execution_root, &crate::ResourceTrackingPolicy::default())?;
            let now = now_ms();
            let size_bytes = blobs.values().fold(0_u64, |total, bytes| {
                total.saturating_add(bytes.len() as u64)
            });
            {
                let mut store = self.store.lock();
                for (hash, bytes) in &blobs {
                    store.put_blob(hash, bytes, now)?;
                }
                store.put_workspace_archive(workspace_id, &snapshot, now)?;
            }
            record = self
                .registry
                .set_archive_metadata(
                    workspace_id,
                    Some(format!("workspace:{workspace_id}")),
                    Some(size_bytes),
                )
                .map_err(|error| error.to_string())?;
            if record.state == WorkspaceState::Active {
                record = self
                    .registry
                    .transition(
                        workspace_id,
                        record.owner_type,
                        record.owner_ref.as_deref(),
                        WorkspaceState::Archived,
                        now,
                    )
                    .map_err(|error| error.to_string())?;
            }
            remove_managed_execution(&record)?;
        } else if self
            .store
            .lock()
            .get_workspace_archive(workspace_id)?
            .is_none()
        {
            return Err(format!(
                "workspace {workspace_id} has no directory or restorable archive"
            ));
        }
        Ok(record)
    }

    pub fn restore_managed_workspace(&self, workspace_id: &str) -> Result<WorkspaceRecord, String> {
        let mut record = self
            .registry
            .get(workspace_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("workspace {workspace_id} not found"))?;
        if record.environment_kind != crate::WorkspaceEnvironmentKind::Managed {
            return Err("only managed environments can be restored".into());
        }
        let now = now_ms();
        if record.state == WorkspaceState::Archived {
            record = self
                .registry
                .transition(
                    workspace_id,
                    record.owner_type,
                    record.owner_ref.as_deref(),
                    WorkspaceState::Restorable,
                    now,
                )
                .map_err(|error| error.to_string())?;
        }
        if record.state != WorkspaceState::Restorable {
            return Err(format!(
                "workspace {workspace_id} cannot be restored from state {:?}",
                record.state
            ));
        }
        let execution_root = Path::new(&record.execution_root);
        if execution_root.exists() {
            return Err(format!(
                "workspace archive directory still exists and requires repair: {}",
                execution_root.display()
            ));
        }
        let snapshot = self
            .store
            .lock()
            .get_workspace_archive(workspace_id)?
            .ok_or_else(|| format!("workspace {workspace_id} has no restorable archive"))?;
        let mut blobs = HashMap::new();
        {
            let mut store = self.store.lock();
            for entry in snapshot.entries.values() {
                if !blobs.contains_key(&entry.hash) {
                    blobs.insert(entry.hash.clone(), store.get_blob(&entry.hash, now)?);
                }
            }
        }
        if let Err(error) = create_execution(
            Path::new(&record.source_root),
            execution_root,
            &WorkspaceBaseSpec::WorkingState,
            &snapshot,
            &blobs,
            record.locked_by.as_deref(),
            // Rematerializing an existing record restores the snapshot it was
            // captured with. Re-provisioning here would apply a declaration the
            // record was not created under.
            None,
        ) {
            return Err(error);
        }
        match self.registry.transition(
            workspace_id,
            record.owner_type,
            record.owner_ref.as_deref(),
            WorkspaceState::Active,
            now,
        ) {
            Ok(restored) => Ok(restored),
            Err(error) => {
                unlock_git_worktree(
                    Path::new(&record.source_root),
                    execution_root,
                    record.isolation_kind,
                );
                cleanup_execution(
                    Path::new(&record.source_root),
                    execution_root,
                    record.isolation_kind,
                    None,
                );
                Err(error.to_string())
            }
        }
    }

    pub fn delete_managed_workspace(&self, workspace_id: &str) -> Result<(), String> {
        let record = self
            .registry
            .get(workspace_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("workspace {workspace_id} not found"))?;
        if record.environment_kind != crate::WorkspaceEnvironmentKind::Managed {
            return Err("permanent and imported environments are protected from deletion".into());
        }
        if !matches!(
            record.state,
            WorkspaceState::Archived | WorkspaceState::Restorable
        ) {
            return Err("archive the managed environment before deleting it".into());
        }
        if Path::new(&record.execution_root).exists() {
            return Err(
                "archive still owns a physical directory; retry archive before delete".into(),
            );
        }
        let now = now_ms();
        self.registry
            .transition(
                workspace_id,
                record.owner_type,
                record.owner_ref.as_deref(),
                WorkspaceState::Removing,
                now,
            )
            .map_err(|error| error.to_string())?;
        self.store.lock().delete_workspace_archive(workspace_id)?;
        let reason = crate::registry::compose_lock_reason(workspace_id);
        self.registry
            .remove_workspace(workspace_id, &reason)
            .map_err(|error| error.to_string())
    }

    fn reactivate_managed_workspace(&self, workspace_id: &str) -> Result<(), String> {
        let Some(record) = self
            .registry
            .get(workspace_id)
            .map_err(|error| error.to_string())?
        else {
            return Err(format!("managed workspace is missing: {workspace_id}"));
        };
        let now = now_ms();
        let mut state = record.state;
        if state == WorkspaceState::Archived {
            state = self
                .registry
                .transition(
                    workspace_id,
                    record.owner_type,
                    record.owner_ref.as_deref(),
                    WorkspaceState::Restorable,
                    now,
                )
                .map_err(|error| error.to_string())?
                .state;
        }
        if state != WorkspaceState::Active {
            self.registry
                .transition(
                    workspace_id,
                    record.owner_type,
                    record.owner_ref.as_deref(),
                    WorkspaceState::Active,
                    now,
                )
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn archive_run_workspace(&self, run: &TaskRun, now: i64) -> Result<(), String> {
        let Some(workspace_id) = run.workspace_id.as_deref() else {
            return Ok(());
        };
        let Some(record) = self
            .registry
            .get(workspace_id)
            .map_err(|error| error.to_string())?
        else {
            return Err(format!("managed workspace is missing: {workspace_id}"));
        };
        if record.state == WorkspaceState::Active {
            self.registry
                .transition(
                    workspace_id,
                    record.owner_type,
                    record.owner_ref.as_deref(),
                    WorkspaceState::Archived,
                    now,
                )
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn discard_managed_workspace(&self, record: &WorkspaceRecord, now: i64) {
        // Only an Active worktree was ever announced as created; a discard
        // during provisioning rollback has no `WorktreeCreate` to pair with.
        let was_active = self
            .registry
            .get(&record.workspace_id)
            .ok()
            .flatten()
            .map(|current| current.state == WorkspaceState::Active)
            .unwrap_or(false);
        let transitioned = self.registry.transition(
            &record.workspace_id,
            record.owner_type,
            record.owner_ref.as_deref(),
            WorkspaceState::Removing,
            now,
        );
        if transitioned.is_ok() {
            let reason = crate::registry::compose_lock_reason(&record.workspace_id);
            let removed = self
                .registry
                .remove_workspace(&record.workspace_id, &reason);
            if removed.is_ok() && was_active {
                self.lifecycle.emit(
                    crate::lifecycle::WorktreeLifecycleKind::Removed,
                    record,
                    None,
                    Some("discard"),
                );
            }
        }
    }

    fn rollback_managed_execution(
        &self,
        workspace_id: Option<&str>,
        workspace_root: &Path,
        execution_root: &Path,
        isolation_kind: IsolationKind,
        now: i64,
    ) {
        unlock_git_worktree(workspace_root, execution_root, isolation_kind);
        cleanup_execution(workspace_root, execution_root, isolation_kind, None);
        if let Some(workspace_id) = workspace_id {
            if let Ok(Some(record)) = self.registry.get(workspace_id) {
                self.discard_managed_workspace(&record, now);
            }
        }
    }

    pub fn settle_run(&self, run_id: &str) -> Result<Vec<ResourceChange>, String> {
        if let Some(turn) = self.workspace_bundle_turn_for_run(run_id)? {
            if matches!(turn.state, RunState::Running | RunState::Settling) {
                return self
                    .settle_workspace_bundle_turn(&turn.bundle_turn_id, RunState::Ready)
                    .map(|outcome| outcome.resources);
            }
            return self.bundle_turn_resources(&turn);
        }
        self.settle_run_single(run_id)
    }

    fn settle_run_single(&self, run_id: &str) -> Result<Vec<ResourceChange>, String> {
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
        drop(store);
        self.archive_run_workspace(&run, now)?;
        Ok(changes)
    }

    pub fn settle_failed_run(&self, run_id: &str) -> Result<Vec<ResourceChange>, String> {
        if let Some(turn) = self.workspace_bundle_turn_for_run(run_id)? {
            return self
                .settle_workspace_bundle_turn(&turn.bundle_turn_id, RunState::Failed)
                .map(|outcome| outcome.resources);
        }
        let resources = self.settle_run_single(run_id)?;
        self.set_run_terminal_state(run_id, RunState::Failed)?;
        Ok(resources)
    }

    pub fn settle_cancelled_run(&self, run_id: &str) -> Result<Vec<ResourceChange>, String> {
        if let Some(turn) = self.workspace_bundle_turn_for_run(run_id)? {
            return self
                .settle_workspace_bundle_turn(&turn.bundle_turn_id, RunState::Cancelled)
                .map(|outcome| outcome.resources);
        }
        let resources = self.settle_run_single(run_id)?;
        self.set_run_terminal_state(run_id, RunState::Cancelled)?;
        Ok(resources)
    }

    fn workspace_bundle_turn_for_run(
        &self,
        run_id: &str,
    ) -> Result<Option<crate::WorkspaceBundleTurnLease>, String> {
        Ok(self
            .store
            .lock()
            .list_workspace_bundle_turns()?
            .into_iter()
            .find(|turn| turn.runs.iter().any(|lease| lease.run.run_id == run_id)))
    }

    fn bundle_turn_resources(
        &self,
        turn: &crate::WorkspaceBundleTurnLease,
    ) -> Result<Vec<ResourceChange>, String> {
        let store = self.store.lock();
        let mut resources = Vec::new();
        for lease in &turn.runs {
            resources.extend(store.list_run_resources(&lease.run.run_id)?);
        }
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
        let candidates = {
            let store = self.store.lock();
            let mut candidates = Vec::new();
            for task in store.list_tasks()? {
                if task.pinned || task.expires_at > now || !store.task_is_prunable(&task.task_id)? {
                    continue;
                }
                let runs = store.list_runs(&task.task_id)?;
                candidates.push((task, runs));
            }
            candidates
        };
        let mut removed_task_ids = Vec::new();
        let mut removed_workspace_ids = std::collections::HashSet::new();
        for (task, runs) in candidates {
            for run in runs {
                if let Some(workspace_id) = run.workspace_id.as_deref() {
                    if !removed_workspace_ids.insert(workspace_id.to_string()) {
                        continue;
                    }
                    let record = self
                        .registry
                        .get(workspace_id)
                        .map_err(|error| error.to_string())?
                        .ok_or_else(|| format!("managed workspace is missing: {workspace_id}"))?;
                    self.registry
                        .transition(
                            workspace_id,
                            record.owner_type,
                            record.owner_ref.as_deref(),
                            WorkspaceState::Removing,
                            now,
                        )
                        .map_err(|error| error.to_string())?;
                    unlock_git_worktree(
                        Path::new(&task.workspace_root),
                        Path::new(&run.execution_root),
                        run.isolation_kind,
                    );
                    cleanup_execution(
                        Path::new(&task.workspace_root),
                        Path::new(&run.execution_root),
                        run.isolation_kind,
                        run.isolation_ref.as_deref(),
                    );
                    if Path::new(&run.execution_root).exists() {
                        return Err(format!(
                            "managed workspace removal did not remove execution root: {}",
                            run.execution_root
                        ));
                    }
                    let reason = crate::registry::compose_lock_reason(workspace_id);
                    self.registry
                        .remove_workspace(workspace_id, &reason)
                        .map_err(|error| error.to_string())?;
                    self.lifecycle.emit(
                        crate::lifecycle::WorktreeLifecycleKind::Removed,
                        &record,
                        None,
                        Some("prune"),
                    );
                    continue;
                }
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
            self.store.lock().delete_task(&task.task_id)?;
            removed_task_ids.push(task.task_id);
        }
        let mut store = self.store.lock();
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

    /// Install (or clear) the sink that receives `WorktreeCreate` /
    /// `WorktreeRemove` lifecycle events. The host installs it once at boot;
    /// tests install a recorder.
    pub fn set_worktree_lifecycle_sink(
        &self,
        sink: Option<Arc<dyn crate::lifecycle::WorktreeLifecycleSink>>,
    ) {
        self.lifecycle.set_sink(sink);
    }

    pub fn has_worktree_lifecycle_sink(&self) -> bool {
        self.lifecycle.has_sink()
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

/// Apply a repository's provisioning declaration to a freshly created worktree.
///
/// Order matters and is not arbitrary:
///
///   1. **sparse-checkout first.** Narrowing the tree deletes the paths it
///      excludes, so linking or copying before it would have the link removed
///      out from under the caller.
///   2. **cache links next.** They are directories the build wants present
///      before anything reads them, and a symlink is cheap.
///   3. **includes last.** They are real file copies and the most likely to
///      fail on a large tree; failing after the cheap steps keeps the rollback
///      window short.
///
/// Every path is re-validated here rather than trusted. The renderer's parser
/// already rejects `..` and absolute paths, but this function is reachable from
/// any caller of the acquire command — a plugin, the CLI, a paired device — and
/// "someone upstream checked it" is how a path traversal ships.
fn apply_provisioning(
    workspace_root: &Path,
    execution_root: &Path,
    provisioning: &WorkspaceProvisioning,
) -> Result<(), String> {
    let _perf = cognia_instrument::guard("workspace.apply_provisioning");
    if !provisioning.sparse_paths.is_empty() {
        for path in &provisioning.sparse_paths {
            validate_event_relative_path(path)?;
        }
        // Cone mode: directory-granular, orders of magnitude faster than the
        // pattern matcher on a large tree, and the only mode whose semantics a
        // repository author can predict from a path list.
        let init = Command::new("git")
            .args(["-C"])
            .arg(execution_root)
            .args(["sparse-checkout", "init", "--cone"])
            .output()
            .map_err(|error| format!("start git sparse-checkout init: {error}"))?;
        if !init.status.success() {
            return Err(format!(
                "git sparse-checkout init failed: {}",
                String::from_utf8_lossy(&init.stderr).trim()
            ));
        }
        let set = Command::new("git")
            .args(["-C"])
            .arg(execution_root)
            .args(["sparse-checkout", "set"])
            .args(&provisioning.sparse_paths)
            .output()
            .map_err(|error| format!("start git sparse-checkout set: {error}"))?;
        if !set.status.success() {
            return Err(format!(
                "git sparse-checkout set failed: {}",
                String::from_utf8_lossy(&set.stderr).trim()
            ));
        }
    }

    for link in &provisioning.cache_links {
        validate_event_relative_path(&link.source)?;
        validate_event_relative_path(&link.target)?;
        let source = workspace_root.join(&link.source);
        let target = execution_root.join(&link.target);
        // A cache that does not exist in the source checkout yet is not an
        // error: the point of the link is that the first build fills it.
        if !source.exists() {
            fs::create_dir_all(&source)
                .map_err(|error| format!("create {}: {error}", source.display()))?;
        }
        if target.exists() || fs::symlink_metadata(&target).is_ok() {
            // Already provisioned (a re-acquisition, or the repository tracks
            // the path). Replacing it would discard a real directory.
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
        symlink_dir(&source, &target)?;
    }

    for path in &provisioning.include {
        validate_event_relative_path(path)?;
        let source = workspace_root.join(path);
        // Absent is not an error either: `include` names the gitignored files a
        // build wants, and a contributor who has not created their `.env` yet
        // must still get a worktree.
        if !source.exists() {
            continue;
        }
        let target = execution_root.join(path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
        copy_included(&source, &target)?;
    }

    Ok(())
}

#[cfg(unix)]
fn symlink_dir(source: &Path, target: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(source, target)
        .map_err(|error| format!("link {} -> {}: {error}", target.display(), source.display()))
}

#[cfg(windows)]
fn symlink_dir(source: &Path, target: &Path) -> Result<(), String> {
    // Requires Developer Mode or elevation on Windows. The error is surfaced
    // rather than swallowed: a build that silently rebuilds its cache every
    // acquisition looks like a performance mystery, not a missing permission.
    std::os::windows::fs::symlink_dir(source, target)
        .map_err(|error| format!("link {} -> {}: {error}", target.display(), source.display()))
}

/// Copy one included path — a file, or a directory tree.
fn copy_included(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("read {}: {error}", source.display()))?;
    if metadata.is_symlink() {
        // Following a symlink out of the checkout is exactly the escape the
        // relative-path check exists to prevent, one indirection later.
        return Ok(());
    }
    if metadata.is_file() {
        fs::copy(source, target)
            .map(|_| ())
            .map_err(|error| format!("copy {}: {error}", source.display()))
    } else if metadata.is_dir() {
        fs::create_dir_all(target)
            .map_err(|error| format!("create {}: {error}", target.display()))?;
        let entries =
            fs::read_dir(source).map_err(|error| format!("read {}: {error}", source.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("read {}: {error}", source.display()))?;
            copy_included(&entry.path(), &target.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        Ok(())
    }
}

fn create_execution(
    workspace_root: &Path,
    execution_root: &Path,
    base: &WorkspaceBaseSpec,
    baseline: &WorkspaceSnapshot,
    blobs: &HashMap<String, Vec<u8>>,
    lock_reason: Option<&str>,
    provisioning: Option<&WorkspaceProvisioning>,
) -> Result<(IsolationKind, Option<String>), String> {
    let _perf = cognia_instrument::guard("workspace.create_execution");
    if is_git_root(workspace_root) {
        let lock_reason = lock_reason
            .filter(|reason| !reason.is_empty())
            .ok_or_else(|| "managed Git worktree requires a Registry lock reason".to_string())?;
        let base_ref = resolve_git_base(workspace_root, base)?;
        if let Some(parent) = execution_root.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
        let output = Command::new("git")
            .args(["-C"])
            .arg(workspace_root)
            .args([
                "worktree",
                "add",
                "--detach",
                "--lock",
                "--reason",
                lock_reason,
            ])
            .arg(execution_root)
            .arg(&base_ref)
            .output()
            .map_err(|error| format!("start git worktree add: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "git worktree add failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        if *base == WorkspaceBaseSpec::WorkingState {
            let result = clear_worktree_contents(execution_root)
                .and_then(|_| materialize(execution_root, baseline, blobs));
            if let Err(error) = result {
                unlock_git_worktree(workspace_root, execution_root, IsolationKind::GitWorktree);
                cleanup_git_worktree(workspace_root, execution_root, "");
                return Err(error);
            }
        }
        // Provisioning is part of creating the tree, not a later touch-up: a
        // half-provisioned worktree handed to an agent is worse than none, so a
        // failure here rolls the whole acquisition back the same way a failed
        // materialize does.
        if let Some(provisioning) = provisioning.filter(|value| !value.is_empty()) {
            if let Err(error) = apply_provisioning(workspace_root, execution_root, provisioning) {
                unlock_git_worktree(workspace_root, execution_root, IsolationKind::GitWorktree);
                cleanup_git_worktree(workspace_root, execution_root, "");
                return Err(error);
            }
        }
        return Ok((IsolationKind::GitWorktree, None));
    }
    if *base != WorkspaceBaseSpec::WorkingState {
        return Err("non-Git workspaces only support the workingState base".into());
    }
    materialize(execution_root, baseline, blobs)?;
    Ok((IsolationKind::Shadow, None))
}

fn resolve_git_base(workspace_root: &Path, base: &WorkspaceBaseSpec) -> Result<String, String> {
    let _perf = cognia_instrument::guard("workspace.resolve_git_base");
    match base {
        WorkspaceBaseSpec::WorkingState | WorkspaceBaseSpec::LocalHead => Ok("HEAD".into()),
        WorkspaceBaseSpec::GitRef { git_ref } if !git_ref.trim().is_empty() => {
            Ok(git_ref.trim().to_string())
        }
        WorkspaceBaseSpec::GitRef { .. } => Err("gitRef base cannot be empty".into()),
        WorkspaceBaseSpec::RemoteDefault => {
            let fetch = Command::new("git")
                .args(["-C"])
                .arg(workspace_root)
                .args(["fetch", "origin"])
                .output()
                .map_err(|error| format!("start git fetch origin: {error}"))?;
            if !fetch.status.success() {
                return Err(format!(
                    "refresh remote default failed: {}",
                    String::from_utf8_lossy(&fetch.stderr).trim()
                ));
            }
            let output = Command::new("git")
                .args(["-C"])
                .arg(workspace_root)
                .args(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
                .output()
                .map_err(|error| format!("resolve origin/HEAD: {error}"))?;
            if !output.status.success() {
                return Err("remote default is unavailable: configure origin/HEAD".into());
            }
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        }
        WorkspaceBaseSpec::PullRequest {
            fetch_ref,
            head_sha,
            ..
        } => resolve_pull_request_base(workspace_root, fetch_ref.as_deref(), head_sha.as_deref()),
    }
}

fn resolve_pull_request_base(
    workspace_root: &Path,
    fetch_ref: Option<&str>,
    head_sha: Option<&str>,
) -> Result<String, String> {
    let fetch_ref = fetch_ref
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "pullRequest base has no provider-resolved fetch ref".to_string())?;
    let head_sha = head_sha
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "pullRequest base has no immutable head SHA".to_string())?;
    let valid_sha =
        matches!(head_sha.len(), 40 | 64) && head_sha.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !valid_sha {
        return Err("pullRequest base has an invalid immutable head SHA".into());
    }
    let check_ref = Command::new("git")
        .args(["check-ref-format", fetch_ref])
        .output()
        .map_err(|error| format!("validate pull request fetch ref: {error}"))?;
    if !check_ref.status.success() || !fetch_ref.starts_with("refs/") {
        return Err("pullRequest base has an invalid provider fetch ref".into());
    }
    let fetch = Command::new("git")
        .args(["-C"])
        .arg(workspace_root)
        .args(["fetch", "origin", fetch_ref])
        .output()
        .map_err(|error| format!("refresh pull request head: {error}"))?;
    if !fetch.status.success() {
        return Err(format!(
            "refresh pull request head failed: {}",
            String::from_utf8_lossy(&fetch.stderr).trim()
        ));
    }
    let resolved = Command::new("git")
        .args(["-C"])
        .arg(workspace_root)
        .args(["rev-parse", "FETCH_HEAD^{commit}"])
        .output()
        .map_err(|error| format!("resolve refreshed pull request head: {error}"))?;
    if !resolved.status.success() {
        return Err("refreshed pull request head is not a commit".into());
    }
    let resolved_sha = String::from_utf8_lossy(&resolved.stdout).trim().to_string();
    if !resolved_sha.eq_ignore_ascii_case(head_sha) {
        return Err(format!(
            "pull request head changed during refresh: expected {head_sha}, resolved {resolved_sha}"
        ));
    }
    Ok(resolved_sha)
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

fn cleanup_execution(
    workspace_root: &Path,
    execution_root: &Path,
    isolation_kind: IsolationKind,
    branch: Option<&str>,
) {
    match isolation_kind {
        IsolationKind::GitWorktree => {
            cleanup_git_worktree(workspace_root, execution_root, branch.unwrap_or_default())
        }
        IsolationKind::Shadow => {
            let _ = fs::remove_dir_all(execution_root);
        }
    }
}

fn remove_managed_execution(record: &WorkspaceRecord) -> Result<(), String> {
    let execution_root = Path::new(&record.execution_root);
    match record.isolation_kind {
        IsolationKind::Shadow => fs::remove_dir_all(execution_root).map_err(|error| {
            format!(
                "remove managed shadow {}: {error}",
                execution_root.display()
            )
        }),
        IsolationKind::GitWorktree => {
            let expected = record
                .locked_by
                .as_deref()
                .ok_or_else(|| format!("workspace {} has no signed lock", record.workspace_id))?;
            let actual = managed_git_lock_reason(Path::new(&record.source_root), execution_root)?;
            if actual.as_deref() != Some(expected) {
                return Err(format!(
                    "workspace {} lock mismatch: expected {expected:?}, found {actual:?}",
                    record.workspace_id
                ));
            }
            let unlock = Command::new("git")
                .args(["-C"])
                .arg(&record.source_root)
                .args(["worktree", "unlock"])
                .arg(execution_root)
                .output()
                .map_err(|error| format!("start git worktree unlock: {error}"))?;
            if !unlock.status.success() {
                return Err(format!(
                    "git worktree unlock failed: {}",
                    String::from_utf8_lossy(&unlock.stderr).trim()
                ));
            }
            let remove = Command::new("git")
                .args(["-C"])
                .arg(&record.source_root)
                .args(["worktree", "remove", "--force"])
                .arg(execution_root)
                .output()
                .map_err(|error| format!("start git worktree remove: {error}"))?;
            remove.status.success().then_some(()).ok_or_else(|| {
                format!(
                    "git worktree remove failed: {}",
                    String::from_utf8_lossy(&remove.stderr).trim()
                )
            })
        }
    }
}

fn managed_git_lock_reason(
    workspace_root: &Path,
    execution_root: &Path,
) -> Result<Option<String>, String> {
    let output = Command::new("git")
        .args(["-C"])
        .arg(workspace_root)
        .args(["worktree", "list", "--porcelain", "-z"])
        .output()
        .map_err(|error| format!("start git worktree list: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "git worktree list failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let inventory = String::from_utf8(output.stdout)
        .map_err(|error| format!("git worktree list returned invalid UTF-8: {error}"))?;
    let target = execution_root
        .canonicalize()
        .unwrap_or_else(|_| execution_root.to_path_buf());
    let mut current_matches = false;
    for raw in inventory.split(if inventory.contains('\0') { '\0' } else { '\n' }) {
        let line = raw.trim_end();
        if let Some(path) = line.strip_prefix("worktree ") {
            let listed = Path::new(path)
                .canonicalize()
                .unwrap_or_else(|_| PathBuf::from(path));
            current_matches = listed == target;
        } else if let Some(reason) = line.strip_prefix("locked ") {
            if current_matches {
                return Ok(Some(reason.to_string()));
            }
        } else if line == "locked" && current_matches {
            return Ok(None);
        }
    }
    Ok(None)
}

struct GitWorktreeInventoryRow {
    path: PathBuf,
    branch: Option<String>,
    head: Option<String>,
    lock_reason: Option<String>,
    prunable: bool,
    prune_reason: Option<String>,
}

fn read_git_worktree_inventory(source_root: &Path) -> Result<Vec<GitWorktreeInventoryRow>, String> {
    let output = Command::new("git")
        .args(["-C"])
        .arg(source_root)
        .args(["worktree", "list", "--porcelain", "-z"])
        .output()
        .map_err(|error| format!("start git worktree list: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "git worktree list failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let porcelain = String::from_utf8(output.stdout)
        .map_err(|error| format!("git worktree list returned invalid UTF-8: {error}"))?;
    let mut rows = Vec::new();
    let mut path: Option<PathBuf> = None;
    let mut branch: Option<String> = None;
    let mut head: Option<String> = None;
    let mut lock_reason: Option<String> = None;
    let mut prunable = false;
    let mut prune_reason: Option<String> = None;
    let flush = |rows: &mut Vec<GitWorktreeInventoryRow>,
                 path: &mut Option<PathBuf>,
                 branch: &mut Option<String>,
                 head: &mut Option<String>,
                 lock_reason: &mut Option<String>,
                 prunable: &mut bool,
                 prune_reason: &mut Option<String>| {
        if let Some(path) = path.take() {
            rows.push(GitWorktreeInventoryRow {
                path,
                branch: branch.take(),
                head: head.take(),
                lock_reason: lock_reason.take(),
                prunable: *prunable,
                prune_reason: prune_reason.take(),
            });
        } else {
            *branch = None;
            *head = None;
            *lock_reason = None;
            *prune_reason = None;
        }
        *prunable = false;
    };
    for raw in porcelain.split(if porcelain.contains('\0') { '\0' } else { '\n' }) {
        let line = raw.trim_end();
        if line.is_empty() {
            flush(
                &mut rows,
                &mut path,
                &mut branch,
                &mut head,
                &mut lock_reason,
                &mut prunable,
                &mut prune_reason,
            );
        } else if let Some(value) = line.strip_prefix("worktree ") {
            flush(
                &mut rows,
                &mut path,
                &mut branch,
                &mut head,
                &mut lock_reason,
                &mut prunable,
                &mut prune_reason,
            );
            path = Some(PathBuf::from(value));
        } else if let Some(value) = line.strip_prefix("HEAD ") {
            head = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("branch ") {
            branch = Some(
                value
                    .strip_prefix("refs/heads/")
                    .unwrap_or(value)
                    .to_string(),
            );
        } else if let Some(value) = line.strip_prefix("locked ") {
            lock_reason = Some(value.to_string());
        } else if line == "locked" {
            lock_reason = Some(String::new());
        } else if let Some(value) = line.strip_prefix("prunable ") {
            prunable = true;
            prune_reason = Some(value.to_string());
        } else if line == "prunable" {
            prunable = true;
        }
    }
    flush(
        &mut rows,
        &mut path,
        &mut branch,
        &mut head,
        &mut lock_reason,
        &mut prunable,
        &mut prune_reason,
    );
    Ok(rows)
}

fn environment_ownership(record: &WorkspaceRecord) -> crate::WorkspaceEnvironmentOwnership {
    match record.environment_kind {
        crate::WorkspaceEnvironmentKind::Managed => crate::WorkspaceEnvironmentOwnership::Managed,
        crate::WorkspaceEnvironmentKind::Imported => crate::WorkspaceEnvironmentOwnership::Imported,
        crate::WorkspaceEnvironmentKind::Permanent => {
            crate::WorkspaceEnvironmentOwnership::Permanent
        }
    }
}

fn environment_ownership_rank(ownership: crate::WorkspaceEnvironmentOwnership) -> u8 {
    match ownership {
        crate::WorkspaceEnvironmentOwnership::Main => 0,
        crate::WorkspaceEnvironmentOwnership::Managed => 1,
        crate::WorkspaceEnvironmentOwnership::Permanent => 2,
        crate::WorkspaceEnvironmentOwnership::Imported => 3,
        crate::WorkspaceEnvironmentOwnership::Manual => 4,
    }
}

fn environment_actions(
    ownership: crate::WorkspaceEnvironmentOwnership,
    state: Option<WorkspaceState>,
    pinned: bool,
    git_worktree: bool,
) -> Vec<crate::WorkspaceEnvironmentAction> {
    use crate::WorkspaceEnvironmentAction as Action;
    use crate::WorkspaceEnvironmentOwnership as Ownership;
    match ownership {
        Ownership::Main => vec![Action::Open],
        Ownership::Manual => vec![Action::Open, Action::Remove, Action::Adopt],
        Ownership::Imported => vec![Action::Open, Action::Adopt],
        Ownership::Permanent => match state {
            Some(WorkspaceState::Active) => {
                let mut actions = vec![Action::Open];
                if git_worktree {
                    actions.push(Action::CreateBranchHere);
                }
                actions
            }
            Some(WorkspaceState::Conflict) => vec![Action::Open],
            _ => Vec::new(),
        },
        Ownership::Managed => match state {
            Some(WorkspaceState::Archived | WorkspaceState::Restorable) => {
                vec![Action::Restore, Action::Delete, Action::Pin]
            }
            Some(WorkspaceState::Conflict) => vec![Action::Open],
            Some(WorkspaceState::Removing | WorkspaceState::Removed) => Vec::new(),
            Some(WorkspaceState::Active) => {
                let mut actions = vec![Action::Open];
                if git_worktree {
                    actions.push(Action::CreateBranchHere);
                }
                actions.push(Action::Pin);
                actions.push(Action::MakePermanent);
                if !pinned {
                    actions.push(Action::Archive);
                }
                actions
            }
            _ => Vec::new(),
        },
    }
}

fn environment_summary_from_git(
    source_root: &Path,
    row: GitWorktreeInventoryRow,
    record: Option<&WorkspaceRecord>,
    ownership: crate::WorkspaceEnvironmentOwnership,
) -> crate::WorkspaceEnvironmentSummary {
    let path = row.path.to_string_lossy().into_owned();
    let workspace_id = record.map(|record| record.workspace_id.clone());
    let pinned = record.is_some_and(|record| record.pinned);
    let state = record.map(|record| record.state);
    let allowed_actions = match ownership {
        crate::WorkspaceEnvironmentOwnership::Manual if row.prunable => {
            vec![crate::WorkspaceEnvironmentAction::Prune]
        }
        crate::WorkspaceEnvironmentOwnership::Manual if row.lock_reason.is_some() => {
            vec![crate::WorkspaceEnvironmentAction::Open]
        }
        crate::WorkspaceEnvironmentOwnership::Imported
            if row.lock_reason.as_deref().is_some_and(|reason| {
                record.is_none_or(|record| {
                    reason != crate::registry::compose_lock_reason(&record.workspace_id)
                })
            }) =>
        {
            vec![crate::WorkspaceEnvironmentAction::Open]
        }
        _ => environment_actions(ownership, state, pinned, true),
    };
    crate::WorkspaceEnvironmentSummary {
        environment_id: workspace_id
            .clone()
            .unwrap_or_else(|| format!("git:{}", storage_key(&normalized_path_key(&row.path)))),
        workspace_id,
        project_id: record.and_then(|record| record.project_id.clone()),
        path,
        source_root: source_root.to_string_lossy().into_owned(),
        ownership,
        owner_type: record.map(|record| record.owner_type),
        owner_ref: record.and_then(|record| record.owner_ref.clone()),
        state,
        branch: row
            .branch
            .or_else(|| record.and_then(|record| record.branch.clone())),
        head: row
            .head
            .or_else(|| record.and_then(|record| record.head.clone())),
        locked: row.lock_reason.is_some(),
        lock_reason: row.lock_reason,
        prunable: row.prunable,
        prune_reason: row.prune_reason,
        base: record.map(|record| record.base.clone()),
        pinned,
        allowed_actions,
    }
}

fn environment_summary_from_record(record: &WorkspaceRecord) -> crate::WorkspaceEnvironmentSummary {
    let ownership = environment_ownership(record);
    crate::WorkspaceEnvironmentSummary {
        environment_id: record.workspace_id.clone(),
        workspace_id: Some(record.workspace_id.clone()),
        project_id: record.project_id.clone(),
        path: record.execution_root.clone(),
        source_root: record.source_root.clone(),
        ownership,
        owner_type: Some(record.owner_type),
        owner_ref: record.owner_ref.clone(),
        state: Some(record.state),
        branch: record.branch.clone(),
        head: record.head.clone(),
        locked: record.locked_by.is_some(),
        lock_reason: record.locked_by.clone(),
        prunable: record.environment_kind == crate::WorkspaceEnvironmentKind::Managed
            && record.state.is_prunable()
            && !record.pinned,
        prune_reason: None,
        base: Some(record.base.clone()),
        pinned: record.pinned,
        allowed_actions: environment_actions(
            ownership,
            Some(record.state),
            record.pinned,
            record.isolation_kind == IsolationKind::GitWorktree,
        ),
    }
}

fn normalized_path_key(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn git_common_dir(workspace_root: &Path) -> Option<String> {
    git2::Repository::discover(workspace_root)
        .ok()
        .and_then(|repository| repository.commondir().canonicalize().ok())
        .map(|path| path.to_string_lossy().into_owned())
}

struct InspectedWorkspaceSource {
    source_root: PathBuf,
    git_common_dir: PathBuf,
    repository_fingerprint: String,
}

fn inspect_workspace_source(source_root: &Path) -> Result<InspectedWorkspaceSource, String> {
    if workspace_path_contains_symlink(source_root)? {
        return Err(format!(
            "workspace source must not contain a symlink: {}",
            source_root.display()
        ));
    }
    let source_root = source_root
        .canonicalize()
        .map_err(|error| format!("canonicalize workspace source: {error}"))?;
    if !source_root.is_dir() {
        return Err(format!(
            "workspace source is not a directory: {}",
            source_root.display()
        ));
    }
    let repository = git2::Repository::discover(&source_root)
        .map_err(|error| format!("workspace source is not a Git repository: {error}"))?;
    let workdir = repository
        .workdir()
        .ok_or_else(|| "workspace source must not be a bare Git repository".to_string())?
        .canonicalize()
        .map_err(|error| format!("canonicalize Git worktree root: {error}"))?;
    if workdir != source_root {
        return Err(format!(
            "workspace source must be the exact Git worktree root: {}",
            workdir.display()
        ));
    }
    let git_common_dir = repository
        .commondir()
        .canonicalize()
        .map_err(|error| format!("canonicalize Git common dir: {error}"))?;
    let origin = repository
        .find_remote("origin")
        .ok()
        .and_then(|remote| remote.url().ok().map(str::to_owned))
        .unwrap_or_default();
    let mut digest = sha2::Sha256::new();
    use sha2::Digest;
    digest.update(source_root.to_string_lossy().as_bytes());
    digest.update([0]);
    digest.update(git_common_dir.to_string_lossy().as_bytes());
    digest.update([0]);
    digest.update(origin.as_bytes());
    Ok(InspectedWorkspaceSource {
        source_root,
        git_common_dir,
        repository_fingerprint: format!("sha256:{}", hex::encode(digest.finalize())),
    })
}

fn inspect_bundle_root(
    input: &crate::WorkspaceBundleRootInput,
) -> Result<InspectedBundleRoot, String> {
    validate_id("logicalRootId", &input.logical_root_id)?;
    let source_path = Path::new(&input.source_root);
    if workspace_path_contains_symlink(source_path)? {
        return Err(format!(
            "bundle source must not contain a symlink: {}",
            source_path.display()
        ));
    }
    let source_root = source_path.canonicalize().map_err(|error| {
        format!(
            "canonicalize bundle root {}: {error}",
            source_path.display()
        )
    })?;
    if !source_root.is_dir() {
        return Err(format!(
            "bundle root is not a directory: {}",
            source_root.display()
        ));
    }
    if let Ok(repository) = git2::Repository::discover(&source_root) {
        let repository_root = repository
            .workdir()
            .ok_or_else(|| "bundle roots cannot use bare Git repositories".to_string())?
            .canonicalize()
            .map_err(|error| format!("canonicalize bundle Git root: {error}"))?;
        let git_common_dir = repository
            .commondir()
            .canonicalize()
            .map_err(|error| format!("canonicalize bundle Git common dir: {error}"))?;
        return Ok(InspectedBundleRoot {
            logical_root_id: input.logical_root_id.clone(),
            role: input.role,
            source_root,
            repository_root: Some(repository_root),
            git_common_dir: Some(git_common_dir),
            isolation: IsolationKind::GitWorktree,
        });
    }
    Ok(InspectedBundleRoot {
        logical_root_id: input.logical_root_id.clone(),
        role: input.role,
        source_root,
        repository_root: None,
        git_common_dir: None,
        isolation: IsolationKind::Shadow,
    })
}

fn workspace_path_contains_symlink(path: &Path) -> Result<bool, String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| format!("resolve current directory: {error}"))?
            .join(path)
    };
    let mut prefix = PathBuf::new();
    for component in absolute.components() {
        prefix.push(component);
        let metadata = match prefix.symlink_metadata() {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "inspect workspace source component {}: {error}",
                    prefix.display()
                ))
            }
        };
        if metadata.file_type().is_symlink() {
            #[cfg(target_os = "macos")]
            if prefix == Path::new("/var") {
                continue;
            }
            return Ok(true);
        }
    }
    Ok(false)
}

fn validate_repository_binding_ref(binding_ref: &str) -> Result<(), String> {
    let segments = binding_ref.split(':').collect::<Vec<_>>();
    if segments.len() != 3
        || segments[0] != "repository"
        || segments[1..].iter().any(|segment| {
            segment.is_empty()
                || !segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
    {
        return Err(format!(
            "invalid repository binding ref (expected repository:<projectId>:<repositoryId>): {binding_ref}"
        ));
    }
    Ok(())
}

fn unlock_git_worktree(
    workspace_root: &Path,
    execution_root: &Path,
    isolation_kind: IsolationKind,
) {
    if isolation_kind != IsolationKind::GitWorktree {
        return;
    }
    let _ = Command::new("git")
        .args(["-C"])
        .arg(workspace_root)
        .args(["worktree", "unlock"])
        .arg(execution_root)
        .status();
}

fn managed_owner(input: &BeginTaskRun) -> (WorkspaceOwnerType, Option<String>) {
    match input.surface.as_deref() {
        Some("scheduled" | "scheduler") => {
            (WorkspaceOwnerType::Scheduled, Some(input.task_id.clone()))
        }
        Some("team") => (WorkspaceOwnerType::Team, Some(input.task_id.clone())),
        _ => (WorkspaceOwnerType::Session, Some(input.session_id.clone())),
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

fn scoped_run_id(base: &str, suffix: &str) -> String {
    const MAX_ID_BYTES: usize = 128;
    let separator_bytes = 1;
    let keep = MAX_ID_BYTES.saturating_sub(separator_bytes + suffix.len());
    let prefix = &base.as_bytes()[..base.len().min(keep)];
    let prefix = std::str::from_utf8(prefix).unwrap_or(base);
    format!("{prefix}:{suffix}")
}

fn aggregate_bundle_turn_state(states: &[RunState]) -> RunState {
    if states
        .iter()
        .any(|state| matches!(state, RunState::Running | RunState::Settling))
    {
        RunState::Running
    } else if states.contains(&RunState::Failed) {
        RunState::Failed
    } else if states.contains(&RunState::Cancelled) {
        RunState::Cancelled
    } else {
        RunState::Ready
    }
}

fn bundle_operation_conflict(
    step: &crate::ApplyStep,
    reason: impl Into<String>,
) -> Vec<crate::PatchConflict> {
    vec![crate::PatchConflict {
        path: step.alias_path.clone(),
        reason: reason.into(),
    }]
}

fn join_logical_selection_path(prefix: &str, path: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("bundle patch selection path cannot be empty".into());
    }
    let mut relative = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            std::path::Component::Normal(value) => relative.push(value),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err(format!(
                    "bundle patch selection escapes its logical root: {path}"
                ));
            }
        }
    }
    if relative.as_os_str().is_empty() {
        return Err("bundle patch selection path cannot be empty".into());
    }
    Ok(Path::new(prefix)
        .join(relative)
        .to_string_lossy()
        .into_owned())
}

fn path_has_logical_prefix(path: &str, prefix: &str) -> bool {
    prefix.is_empty() || Path::new(path).starts_with(prefix)
}

fn merge_patch_selections(selections: &mut Vec<crate::PatchSelection>) -> Result<(), String> {
    let mut merged: std::collections::BTreeMap<String, Option<std::collections::BTreeSet<String>>> =
        std::collections::BTreeMap::new();
    for selection in selections.drain(..) {
        if selection.path.is_empty() {
            return Err("bundle patch selection path cannot be empty".into());
        }
        let entry = merged
            .entry(selection.path)
            .or_insert_with(|| Some(std::collections::BTreeSet::new()));
        if selection.hunk_ids.is_empty() {
            *entry = None;
        } else if let Some(hunks) = entry {
            hunks.extend(selection.hunk_ids);
        }
    }
    selections.extend(merged.into_iter().map(|(path, hunks)| {
        crate::PatchSelection {
            path,
            hunk_ids: hunks
                .map(|hunks| hunks.into_iter().collect())
                .unwrap_or_default(),
        }
    }));
    Ok(())
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
    use crate::WorkspaceCacheLink;
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
            base: WorkspaceBaseSpec::WorkingState,
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

    fn seed_git_repository(root: &Path) {
        use git2::{IndexAddOption, Repository, Signature};

        let repository = Repository::open(root).unwrap();
        fs::write(root.join("README.md"), "seed\n").unwrap();
        let mut index = repository.index().unwrap();
        index
            .add_all(["README.md"], IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree = repository.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = Signature::now("Task Workspace Test", "task@example.com").unwrap();
        repository
            .commit(Some("HEAD"), &signature, &signature, "seed", &tree, &[])
            .unwrap();
    }

    fn provisioning_repository() -> TempDir {
        let repository = TempDir::new().unwrap();
        git2::Repository::init(repository.path()).unwrap();
        seed_git_repository(repository.path());
        repository
    }

    #[test]
    fn provisioning_links_a_cache_and_copies_the_gitignored_files_a_build_needs() {
        let repository = provisioning_repository();
        let source = repository.path();
        fs::create_dir_all(source.join("node_modules/pkg")).unwrap();
        fs::write(source.join("node_modules/pkg/index.js"), "cached").unwrap();
        fs::write(source.join(".env"), "TOKEN=local").unwrap();

        let worktree = TempDir::new().unwrap();
        let execution_root = worktree.path().join("wt");
        fs::create_dir_all(&execution_root).unwrap();

        apply_provisioning(
            source,
            &execution_root,
            &WorkspaceProvisioning {
                cache_links: vec![WorkspaceCacheLink {
                    source: "node_modules".into(),
                    target: "node_modules".into(),
                }],
                include: vec![".env".into()],
                ..Default::default()
            },
        )
        .unwrap();

        // The link resolves back into the source checkout, which is the point:
        // a worktree that rebuilds `node_modules` from nothing on every
        // acquisition is the cost this exists to remove.
        assert_eq!(
            fs::read_to_string(execution_root.join("node_modules/pkg/index.js")).unwrap(),
            "cached"
        );
        assert!(fs::symlink_metadata(execution_root.join("node_modules"))
            .unwrap()
            .is_symlink());
        // A copy, not a link: the worktree may edit its own `.env`.
        assert_eq!(
            fs::read_to_string(execution_root.join(".env")).unwrap(),
            "TOKEN=local"
        );
        assert!(!fs::symlink_metadata(execution_root.join(".env"))
            .unwrap()
            .is_symlink());
    }

    #[test]
    fn provisioning_refuses_every_path_that_escapes_the_checkout() {
        // The renderer's parser rejects these too, but this function is
        // reachable from any caller of the acquire command — "someone upstream
        // checked it" is how a path traversal ships.
        let repository = provisioning_repository();
        let worktree = TempDir::new().unwrap();
        let execution_root = worktree.path().join("wt");
        fs::create_dir_all(&execution_root).unwrap();

        for provisioning in [
            WorkspaceProvisioning {
                include: vec!["../outside".into()],
                ..Default::default()
            },
            WorkspaceProvisioning {
                include: vec!["/etc/passwd".into()],
                ..Default::default()
            },
            WorkspaceProvisioning {
                cache_links: vec![WorkspaceCacheLink {
                    source: "../../secrets".into(),
                    target: "cache".into(),
                }],
                ..Default::default()
            },
            WorkspaceProvisioning {
                cache_links: vec![WorkspaceCacheLink {
                    source: "cache".into(),
                    target: "../escape".into(),
                }],
                ..Default::default()
            },
            WorkspaceProvisioning {
                sparse_paths: vec!["../elsewhere".into()],
                ..Default::default()
            },
        ] {
            let error = apply_provisioning(repository.path(), &execution_root, &provisioning)
                .expect_err("expected the escape to be refused");
            assert!(error.contains("escapes workspace"), "unexpected: {error}");
        }
    }

    #[test]
    fn provisioning_does_not_follow_a_symlink_out_of_the_checkout() {
        let repository = provisioning_repository();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("secret"), "leaked").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            outside.path().join("secret"),
            repository.path().join("link"),
        )
        .unwrap();
        #[cfg(not(unix))]
        return;

        let worktree = TempDir::new().unwrap();
        let execution_root = worktree.path().join("wt");
        fs::create_dir_all(&execution_root).unwrap();

        apply_provisioning(
            repository.path(),
            &execution_root,
            &WorkspaceProvisioning {
                include: vec!["link".into()],
                ..Default::default()
            },
        )
        .unwrap();

        // A confined relative path that resolves outside is the same escape,
        // one indirection later.
        assert!(!execution_root.join("link").exists());
    }

    #[test]
    fn provisioning_tolerates_what_a_fresh_clone_does_not_have_yet() {
        let repository = provisioning_repository();
        let worktree = TempDir::new().unwrap();
        let execution_root = worktree.path().join("wt");
        fs::create_dir_all(&execution_root).unwrap();

        apply_provisioning(
            repository.path(),
            &execution_root,
            &WorkspaceProvisioning {
                // The contributor has not created their `.env` yet, and the
                // cache is empty because nothing has built. Neither may refuse
                // them a worktree.
                include: vec![".env".into()],
                cache_links: vec![WorkspaceCacheLink {
                    source: "target".into(),
                    target: "target".into(),
                }],
                ..Default::default()
            },
        )
        .unwrap();

        assert!(!execution_root.join(".env").exists());
        assert!(repository.path().join("target").is_dir());
        assert!(execution_root.join("target").exists());
    }

    #[test]
    fn provisioning_leaves_an_already_provisioned_target_alone() {
        // Re-acquisition, or a repository that tracks the path. Replacing it
        // would discard a real directory.
        let repository = provisioning_repository();
        fs::create_dir_all(repository.path().join("cache")).unwrap();
        let worktree = TempDir::new().unwrap();
        let execution_root = worktree.path().join("wt");
        fs::create_dir_all(execution_root.join("cache")).unwrap();
        fs::write(execution_root.join("cache/real.txt"), "mine").unwrap();

        apply_provisioning(
            repository.path(),
            &execution_root,
            &WorkspaceProvisioning {
                cache_links: vec![WorkspaceCacheLink {
                    source: "cache".into(),
                    target: "cache".into(),
                }],
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(execution_root.join("cache/real.txt")).unwrap(),
            "mine"
        );
    }

    #[test]
    fn provisioning_narrows_a_worktree_to_the_declared_paths() {
        let repository = provisioning_repository();
        fs::create_dir_all(repository.path().join("packages/web")).unwrap();
        fs::write(repository.path().join("packages/web/app.ts"), "web").unwrap();
        fs::create_dir_all(repository.path().join("packages/api")).unwrap();
        fs::write(repository.path().join("packages/api/server.ts"), "api").unwrap();
        let add = Command::new("git")
            .args(["-C"])
            .arg(repository.path())
            .args(["add", "-A"])
            .output()
            .unwrap();
        assert!(add.status.success());
        let commit = Command::new("git")
            .args(["-C"])
            .arg(repository.path())
            .args([
                "-c",
                "user.email=t@e.com",
                "-c",
                "user.name=T",
                "commit",
                "-m",
                "packages",
            ])
            .output()
            .unwrap();
        assert!(commit.status.success());

        let worktree = TempDir::new().unwrap();
        let execution_root = worktree.path().join("wt");
        let created = Command::new("git")
            .args(["-C"])
            .arg(repository.path())
            .args(["worktree", "add", "--detach"])
            .arg(&execution_root)
            .arg("HEAD")
            .output()
            .unwrap();
        assert!(created.status.success());

        apply_provisioning(
            repository.path(),
            &execution_root,
            &WorkspaceProvisioning {
                sparse_paths: vec!["packages/web".into()],
                ..Default::default()
            },
        )
        .unwrap();

        assert!(execution_root.join("packages/web/app.ts").exists());
        assert!(!execution_root.join("packages/api/server.ts").exists());
    }

    #[test]
    fn an_empty_declaration_is_a_no_op() {
        let repository = provisioning_repository();
        let worktree = TempDir::new().unwrap();
        let execution_root = worktree.path().join("wt");
        fs::create_dir_all(&execution_root).unwrap();
        assert!(WorkspaceProvisioning::default().is_empty());
        apply_provisioning(
            repository.path(),
            &execution_root,
            &WorkspaceProvisioning::default(),
        )
        .unwrap();
        assert_eq!(fs::read_dir(&execution_root).unwrap().count(), 0);
    }

    #[test]
    fn pull_request_base_refreshes_and_verifies_the_provider_sha() {
        let repository = TempDir::new().unwrap();
        let remote = TempDir::new().unwrap();
        git2::Repository::init(repository.path()).unwrap();
        git2::Repository::init_bare(remote.path()).unwrap();
        seed_git_repository(repository.path());
        let remote_add = Command::new("git")
            .args(["-C"])
            .arg(repository.path())
            .args(["remote", "add", "origin"])
            .arg(remote.path())
            .output()
            .unwrap();
        assert!(remote_add.status.success());
        let push = Command::new("git")
            .args(["-C"])
            .arg(repository.path())
            .args(["push", "origin", "HEAD:refs/pull/42/head"])
            .output()
            .unwrap();
        assert!(push.status.success());
        let head = git2::Repository::open(repository.path())
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap()
            .to_string();

        assert_eq!(
            resolve_pull_request_base(repository.path(), Some("refs/pull/42/head"), Some(&head))
                .unwrap(),
            head
        );
        let error = resolve_pull_request_base(
            repository.path(),
            Some("refs/pull/42/head"),
            Some("0000000000000000000000000000000000000000"),
        )
        .unwrap_err();
        assert!(error.contains("changed during refresh"));
    }

    #[test]
    fn pull_request_base_rejects_unresolved_or_unsafe_provider_data() {
        let repository = TempDir::new().unwrap();
        git2::Repository::init(repository.path()).unwrap();
        seed_git_repository(repository.path());

        assert!(resolve_pull_request_base(repository.path(), None, None)
            .unwrap_err()
            .contains("fetch ref"));
        assert!(resolve_pull_request_base(
            repository.path(),
            Some("--upload-pack=malicious"),
            Some("0123456789abcdef0123456789abcdef01234567")
        )
        .unwrap_err()
        .contains("invalid provider fetch ref"));
    }

    #[test]
    fn source_bindings_resolve_only_exact_pretrusted_git_roots() {
        let data = TempDir::new().unwrap();
        let repository = TempDir::new().unwrap();
        git2::Repository::init(repository.path()).unwrap();
        fs::create_dir(repository.path().join("nested")).unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();

        let binding = service
            .bind_workspace_source("repository:project-1:repo-1", repository.path(), 10)
            .unwrap();
        assert_eq!(binding.binding_ref, "repository:project-1:repo-1");
        assert!(!binding.repository_fingerprint.is_empty());
        assert_eq!(
            service.list_workspace_source_bindings().unwrap(),
            vec![binding.clone()]
        );
        assert_eq!(
            service
                .resolve_workspace_source("repository:project-1:repo-1")
                .unwrap(),
            binding
        );

        let nested = service
            .bind_workspace_source(
                "repository:project-1:nested",
                &repository.path().join("nested"),
                11,
            )
            .unwrap_err();
        assert!(nested.contains("exact Git worktree root"));

        service
            .remove_workspace_source_binding("repository:project-1:repo-1")
            .unwrap();
        assert!(service
            .resolve_workspace_source("repository:project-1:repo-1")
            .unwrap_err()
            .contains("not bound"));
    }

    #[test]
    fn manual_removal_imports_and_blocks_an_unknown_external_worktree() {
        let data = TempDir::new().unwrap();
        let repository = TempDir::new().unwrap();
        let worktrees = TempDir::new().unwrap();
        let external = worktrees.path().join("external");
        git2::Repository::init(repository.path()).unwrap();
        seed_git_repository(repository.path());
        let add = Command::new("git")
            .args(["-C"])
            .arg(repository.path())
            .args(["worktree", "add", "--detach"])
            .arg(&external)
            .output()
            .unwrap();
        assert!(
            add.status.success(),
            "{}",
            String::from_utf8_lossy(&add.stderr)
        );
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();

        let error = service
            .ensure_manual_worktree_removal_allowed(repository.path(), &external)
            .unwrap_err();

        assert!(error.contains("is owned by workspace"));
        assert!(error.contains("Imported"));
        let records = service.list_managed_workspaces().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].environment_kind,
            crate::WorkspaceEnvironmentKind::Imported
        );
        assert!(external.exists());
    }

    #[test]
    fn manual_removal_allows_a_path_outside_the_git_inventory() {
        let data = TempDir::new().unwrap();
        let repository = TempDir::new().unwrap();
        git2::Repository::init(repository.path()).unwrap();
        seed_git_repository(repository.path());
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();

        service
            .ensure_manual_worktree_removal_allowed(repository.path(), Path::new("missing"))
            .unwrap();
        assert!(service.list_managed_workspaces().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn source_bindings_reject_symlink_roots_and_managed_execution_roots() {
        use std::os::unix::fs::symlink;

        let data = TempDir::new().unwrap();
        let repository = TempDir::new().unwrap();
        git2::Repository::init(repository.path()).unwrap();
        seed_git_repository(repository.path());
        let alias_parent = TempDir::new().unwrap();
        let alias = alias_parent.path().join("repository-link");
        symlink(repository.path(), &alias).unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();

        assert!(service
            .bind_workspace_source("repository:project-1:symlink", &alias, 10)
            .unwrap_err()
            .contains("symlink"));

        let nested_parent = TempDir::new().unwrap();
        fs::create_dir(nested_parent.path().join("real")).unwrap();
        let nested_repository = nested_parent.path().join("real/repository");
        fs::create_dir(&nested_repository).unwrap();
        git2::Repository::init(&nested_repository).unwrap();
        symlink(
            nested_parent.path().join("real"),
            nested_parent.path().join("alias"),
        )
        .unwrap();
        assert!(service
            .bind_workspace_source(
                "repository:project-1:nested-symlink",
                &nested_parent.path().join("alias/repository"),
                10,
            )
            .unwrap_err()
            .contains("symlink"));

        let run = service
            .begin_run(input(&repository, "task-owned", "run-owned"))
            .unwrap();
        assert!(service
            .bind_workspace_source(
                "repository:project-1:managed",
                Path::new(&run.execution_root),
                11,
            )
            .unwrap_err()
            .contains("Registry-owned execution root"));
    }

    #[test]
    fn bound_runs_fail_before_isolation_when_the_binding_is_missing() {
        let data = TempDir::new().unwrap();
        let repository = TempDir::new().unwrap();
        git2::Repository::init(repository.path()).unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();

        let error = service
            .begin_bound_run(
                "repository:project-1:missing",
                input(&repository, "task-missing", "run-missing"),
            )
            .unwrap_err();
        assert!(error.contains("not bound"));
        assert!(service.list_tasks(None).unwrap().is_empty());
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
        assert_eq!(run.isolation_ref, None);
        let workspace_id = run
            .workspace_id
            .as_deref()
            .expect("managed run has a registry identity");
        let record = service
            .get_managed_workspace(workspace_id)
            .unwrap()
            .expect("registry row");
        assert_eq!(record.state, WorkspaceState::Active);
        assert_eq!(record.owner_type, WorkspaceOwnerType::Session);
        assert_eq!(record.owner_ref.as_deref(), Some("session-1"));
        let execution = PathBuf::from(run.execution_root);
        let inventory = Command::new("git")
            .args(["-C"])
            .arg(workspace.path())
            .args(["worktree", "list", "--porcelain", "-z"])
            .output()
            .unwrap();
        assert!(inventory.status.success());
        let inventory = String::from_utf8(inventory.stdout).unwrap();
        assert!(inventory.contains(&format!("locked cognia:{workspace_id}")));
        assert!(execution.join(".git").is_file());
        assert!(!Command::new("git")
            .args(["-C"])
            .arg(&execution)
            .args(["symbolic-ref", "-q", "--short", "HEAD"])
            .status()
            .unwrap()
            .success());
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
    fn git_worktree_lifecycle_emits_worktree_create_and_remove() {
        use crate::lifecycle::{
            WorktreeLifecycleEvent, WorktreeLifecycleKind, WorktreeLifecycleSink,
        };
        use git2::{IndexAddOption, Repository, Signature};
        use std::sync::Mutex as StdMutex;

        struct Recorder(StdMutex<Vec<WorktreeLifecycleEvent>>);
        impl WorktreeLifecycleSink for Recorder {
            fn emit(&self, event: WorktreeLifecycleEvent) {
                self.0.lock().unwrap().push(event);
            }
        }

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

        let mut config = ServiceConfig::new(data.path().into());
        config.retention = Duration::ZERO;
        let service = TaskWorkspaceService::open(config).unwrap();
        assert!(!service.has_worktree_lifecycle_sink());
        let recorder = Arc::new(Recorder(StdMutex::new(Vec::new())));
        service.set_worktree_lifecycle_sink(Some(recorder.clone()));
        assert!(service.has_worktree_lifecycle_sink());

        let run = service
            .begin_run(input(&workspace, "task:lifecycle", "run:lifecycle"))
            .unwrap();
        assert_eq!(run.isolation_kind, IsolationKind::GitWorktree);
        {
            let events = recorder.0.lock().unwrap();
            assert_eq!(events.len(), 1, "one WorktreeCreate after activation");
            assert_eq!(events[0].kind, WorktreeLifecycleKind::Created);
            assert_eq!(events[0].worktree_path, run.execution_root);
            assert_eq!(
                events[0].workspace_id.as_str(),
                run.workspace_id.as_deref().unwrap()
            );
            assert_eq!(events[0].session_id.as_deref(), Some("session-1"));
            assert_eq!(events[0].owner_type, WorkspaceOwnerType::Session);
        }

        // Settle + apply so the task becomes prunable, then prune → WorktreeRemove.
        service.settle_run("run:lifecycle").unwrap();
        service.apply_patch_set("run:lifecycle", &[]).unwrap();
        let pruned = service.prune().unwrap();
        assert_eq!(pruned.removed_task_ids, vec!["task:lifecycle"]);
        let events = recorder.0.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].kind, WorktreeLifecycleKind::Removed);
        assert_eq!(events[1].reason.as_deref(), Some("prune"));
        assert_eq!(events[1].worktree_path, run.execution_root);
        assert!(!Path::new(&run.execution_root).exists());
    }

    #[test]
    fn shadow_runs_never_emit_worktree_lifecycle_events() {
        use crate::lifecycle::{WorktreeLifecycleEvent, WorktreeLifecycleSink};
        use std::sync::Mutex as StdMutex;

        struct Recorder(StdMutex<Vec<WorktreeLifecycleEvent>>);
        impl WorktreeLifecycleSink for Recorder {
            fn emit(&self, event: WorktreeLifecycleEvent) {
                self.0.lock().unwrap().push(event);
            }
        }
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        fs::write(workspace.path().join("plain.txt"), "x\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let recorder = Arc::new(Recorder(StdMutex::new(Vec::new())));
        service.set_worktree_lifecycle_sink(Some(recorder.clone()));
        let run = service
            .begin_run(input(&workspace, "task:shadow", "run:shadow"))
            .unwrap();
        assert_eq!(run.isolation_kind, IsolationKind::Shadow);
        assert!(recorder.0.lock().unwrap().is_empty());
        service.set_worktree_lifecycle_sink(None);
        assert!(!service.has_worktree_lifecycle_sink());
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
        assert_eq!(patch.files[0].hunks[0].additions, 1);
        assert_eq!(patch.files[0].hunks[0].deletions, 1);
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
        let applied_patch = service.get_patch_set("run-hunks").unwrap().unwrap();
        assert!(applied_patch.applied_selection_known);
        assert_eq!(applied_patch.applied_selection.len(), 1);
        assert_eq!(applied_patch.applied_selection[0].hunk_ids.len(), 1);
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

    #[test]
    fn a_bundle_stamps_its_owning_workspace_on_every_registry_row_it_provisions() {
        // Without this, deleting a project cannot find the directories it
        // produced: rows are addressed by path and `(owner_type, owner_ref)`,
        // and an owner ref is a session, never a project.
        let data = TempDir::new().unwrap();
        let repo = TempDir::new().unwrap();
        git2::Repository::init(repo.path()).unwrap();
        seed_git_repository(repo.path());

        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                provisioning: None,
                project_id: Some("project-a".into()),
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-1".into()),
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                base: WorkspaceBaseSpec::WorkingState,
                roots: vec![crate::WorkspaceBundleRootInput {
                    logical_root_id: "primary".into(),
                    role: crate::WorkspaceRootRole::Primary,
                    source_root: repo.path().to_string_lossy().into_owned(),
                }],
            })
            .unwrap();

        for lease in &bundle.leases {
            let record = service.registry.get(&lease.workspace_id).unwrap().unwrap();
            assert_eq!(record.project_id, Some("project-a".into()));
        }
        let owned = service.registry.list_for_project("project-a").unwrap();
        assert_eq!(owned.len(), bundle.leases.len());
        assert!(service
            .registry
            .list_for_project("project-b")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn acquires_multi_repository_and_shadow_roots_as_one_bundle() {
        let data = TempDir::new().unwrap();
        let primary = TempDir::new().unwrap();
        git2::Repository::init(primary.path()).unwrap();
        seed_git_repository(primary.path());
        let package = primary.path().join("packages/app");
        fs::create_dir_all(&package).unwrap();
        fs::write(package.join("package.txt"), "package\n").unwrap();

        let second = TempDir::new().unwrap();
        git2::Repository::init(second.path()).unwrap();
        seed_git_repository(second.path());
        let shadow = TempDir::new().unwrap();
        fs::write(shadow.path().join("notes.txt"), "notes\n").unwrap();

        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                provisioning: None,
                project_id: None,
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-bundle".into()),
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                base: WorkspaceBaseSpec::WorkingState,
                roots: vec![
                    crate::WorkspaceBundleRootInput {
                        logical_root_id: "primary".into(),
                        role: crate::WorkspaceRootRole::Primary,
                        source_root: primary.path().to_string_lossy().into_owned(),
                    },
                    crate::WorkspaceBundleRootInput {
                        logical_root_id: "package".into(),
                        role: crate::WorkspaceRootRole::Additional,
                        source_root: package.to_string_lossy().into_owned(),
                    },
                    crate::WorkspaceBundleRootInput {
                        logical_root_id: "second".into(),
                        role: crate::WorkspaceRootRole::Additional,
                        source_root: second.path().to_string_lossy().into_owned(),
                    },
                    crate::WorkspaceBundleRootInput {
                        logical_root_id: "notes".into(),
                        role: crate::WorkspaceRootRole::Additional,
                        source_root: shadow.path().to_string_lossy().into_owned(),
                    },
                ],
            })
            .unwrap();

        assert_eq!(bundle.state, WorkspaceState::Active);
        assert_eq!(bundle.leases.len(), 4);
        let physical_ids = bundle
            .leases
            .iter()
            .map(|lease| lease.workspace_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(physical_ids.len(), 3);
        let primary_lease = bundle
            .leases
            .iter()
            .find(|lease| lease.logical_root_id == "primary")
            .unwrap();
        let package_lease = bundle
            .leases
            .iter()
            .find(|lease| lease.logical_root_id == "package")
            .unwrap();
        assert_eq!(primary_lease.workspace_id, package_lease.workspace_id);
        assert!(Path::new(&package_lease.alias_path)
            .join("package.txt")
            .is_file());
        let notes_lease = bundle
            .leases
            .iter()
            .find(|lease| lease.logical_root_id == "notes")
            .unwrap();
        assert!(Path::new(&notes_lease.alias_path)
            .join("notes.txt")
            .is_file());
        assert_eq!(service.list_managed_workspaces().unwrap().len(), 3);
        assert_eq!(
            service
                .get_workspace_bundle(&bundle.bundle_id)
                .unwrap()
                .unwrap(),
            bundle
        );
    }

    #[test]
    fn bundle_runs_track_changes_without_archiving_the_borrowed_environment() {
        let data = TempDir::new().unwrap();
        let shadow = TempDir::new().unwrap();
        fs::write(shadow.path().join("notes.txt"), "before\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                provisioning: None,
                project_id: None,
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-1".into()),
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                base: WorkspaceBaseSpec::WorkingState,
                roots: vec![crate::WorkspaceBundleRootInput {
                    logical_root_id: "notes".into(),
                    role: crate::WorkspaceRootRole::Primary,
                    source_root: shadow.path().to_string_lossy().into_owned(),
                }],
            })
            .unwrap();
        let lease = &bundle.leases[0];
        let run = service
            .begin_bundle_run(
                &bundle.bundle_id,
                "notes",
                input(&shadow, "task-bundle-run", "run-bundle-run"),
            )
            .unwrap();

        assert_eq!(
            Path::new(&run.execution_root).canonicalize().unwrap(),
            Path::new(&lease.alias_path).canonicalize().unwrap()
        );
        assert!(run.workspace_id.is_none());
        fs::write(Path::new(&run.execution_root).join("notes.txt"), "after\n").unwrap();
        let changes = service.settle_run(&run.run_id).unwrap();

        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "notes.txt");
        assert_eq!(
            service
                .get_workspace_bundle(&bundle.bundle_id)
                .unwrap()
                .unwrap()
                .state,
            WorkspaceState::Active
        );
        assert!(Path::new(&lease.alias_path).is_dir());
    }

    #[test]
    fn bundle_runs_reject_cross_session_ownership() {
        let data = TempDir::new().unwrap();
        let shadow = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                provisioning: None,
                project_id: None,
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-other".into()),
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                base: WorkspaceBaseSpec::WorkingState,
                roots: vec![crate::WorkspaceBundleRootInput {
                    logical_root_id: "notes".into(),
                    role: crate::WorkspaceRootRole::Primary,
                    source_root: shadow.path().to_string_lossy().into_owned(),
                }],
            })
            .unwrap();

        let error = service
            .begin_bundle_run(
                &bundle.bundle_id,
                "notes",
                input(&shadow, "task-wrong-owner", "run-wrong-owner"),
            )
            .unwrap_err();

        assert!(error.contains("owned by another session"));
    }

    #[test]
    fn bundle_acquisition_rolls_back_every_root_when_one_leg_fails() {
        let data = TempDir::new().unwrap();
        let repository = TempDir::new().unwrap();
        git2::Repository::init(repository.path()).unwrap();
        seed_git_repository(repository.path());
        let shadow = TempDir::new().unwrap();
        fs::write(shadow.path().join("notes.txt"), "notes\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();

        let error = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                provisioning: None,
                project_id: None,
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-rollback".into()),
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                base: WorkspaceBaseSpec::LocalHead,
                roots: vec![
                    crate::WorkspaceBundleRootInput {
                        logical_root_id: "git".into(),
                        role: crate::WorkspaceRootRole::Primary,
                        source_root: repository.path().to_string_lossy().into_owned(),
                    },
                    crate::WorkspaceBundleRootInput {
                        logical_root_id: "shadow".into(),
                        role: crate::WorkspaceRootRole::Additional,
                        source_root: shadow.path().to_string_lossy().into_owned(),
                    },
                ],
            })
            .unwrap_err();

        assert!(error.contains("non-Git workspaces only support the workingState base"));
        assert!(service.list_managed_workspaces().unwrap().is_empty());
        assert!(service.list_workspace_bundles().unwrap().is_empty());
        let inventory = Command::new("git")
            .args(["-C"])
            .arg(repository.path())
            .args(["worktree", "list", "--porcelain"])
            .output()
            .unwrap();
        let inventory = String::from_utf8(inventory.stdout).unwrap();
        assert_eq!(
            inventory
                .lines()
                .filter(|line| line.starts_with("worktree "))
                .count(),
            1
        );
    }

    #[test]
    fn archive_restore_and_delete_preserve_shadow_wip() {
        let data = TempDir::new().unwrap();
        let shadow = TempDir::new().unwrap();
        fs::write(shadow.path().join("notes.txt"), "before\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                provisioning: None,
                project_id: None,
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-lifecycle".into()),
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                base: WorkspaceBaseSpec::WorkingState,
                roots: vec![crate::WorkspaceBundleRootInput {
                    logical_root_id: "notes".into(),
                    role: crate::WorkspaceRootRole::Primary,
                    source_root: shadow.path().to_string_lossy().into_owned(),
                }],
            })
            .unwrap();
        let lease = &bundle.leases[0];
        fs::write(Path::new(&lease.alias_path).join("notes.txt"), "after\n").unwrap();

        let archived = service
            .archive_managed_workspace(&lease.workspace_id)
            .unwrap();
        assert_eq!(archived.state, WorkspaceState::Archived);
        assert!(!Path::new(&archived.execution_root).exists());
        let expected_snapshot_id = format!("workspace:{}", lease.workspace_id);
        assert_eq!(
            archived.snapshot_task_id.as_deref(),
            Some(expected_snapshot_id.as_str())
        );

        let restored = service
            .restore_managed_workspace(&lease.workspace_id)
            .unwrap();
        assert_eq!(restored.state, WorkspaceState::Active);
        assert_eq!(
            fs::read_to_string(Path::new(&restored.execution_root).join("notes.txt")).unwrap(),
            "after\n"
        );

        service
            .archive_managed_workspace(&lease.workspace_id)
            .unwrap();
        service
            .delete_managed_workspace(&lease.workspace_id)
            .unwrap();
        assert!(service
            .get_managed_workspace(&lease.workspace_id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn permanent_environments_are_protected_from_archive_and_delete() {
        let data = TempDir::new().unwrap();
        let shadow = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                provisioning: None,
                project_id: None,
                owner_type: WorkspaceOwnerType::User,
                owner_ref: Some("project-1".into()),
                environment_kind: crate::WorkspaceEnvironmentKind::Permanent,
                base: WorkspaceBaseSpec::WorkingState,
                roots: vec![crate::WorkspaceBundleRootInput {
                    logical_root_id: "primary".into(),
                    role: crate::WorkspaceRootRole::Primary,
                    source_root: shadow.path().to_string_lossy().into_owned(),
                }],
            })
            .unwrap();
        let workspace_id = &bundle.leases[0].workspace_id;

        assert!(service
            .archive_managed_workspace(workspace_id)
            .unwrap_err()
            .contains("explicit detach"));
        assert!(service
            .delete_managed_workspace(workspace_id)
            .unwrap_err()
            .contains("protected"));
        assert!(service
            .set_managed_workspace_pinned(workspace_id, true)
            .unwrap_err()
            .contains("managed environments"));
        assert!(service
            .make_workspace_permanent(workspace_id)
            .unwrap_err()
            .contains("managed environment"));
        assert!(Path::new(&bundle.leases[0].alias_path).exists());
    }

    #[test]
    fn managed_lifecycle_mutations_revalidate_registry_ownership() {
        let data = TempDir::new().unwrap();
        let shadow = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                provisioning: None,
                project_id: None,
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-lifecycle-mutation".into()),
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                base: WorkspaceBaseSpec::WorkingState,
                roots: vec![crate::WorkspaceBundleRootInput {
                    logical_root_id: "primary".into(),
                    role: crate::WorkspaceRootRole::Primary,
                    source_root: shadow.path().to_string_lossy().into_owned(),
                }],
            })
            .unwrap();
        let workspace_id = &bundle.leases[0].workspace_id;

        let pinned = service
            .set_managed_workspace_pinned(workspace_id, true)
            .unwrap();
        assert!(pinned.pinned);
        let permanent = service.make_workspace_permanent(workspace_id).unwrap();
        assert_eq!(
            permanent.environment_kind,
            crate::WorkspaceEnvironmentKind::Permanent
        );
        assert!(service
            .set_managed_workspace_pinned(workspace_id, false)
            .unwrap_err()
            .contains("managed environments"));
    }

    #[test]
    fn archive_and_restore_recreate_the_signed_git_worktree() {
        let data = TempDir::new().unwrap();
        let repository = TempDir::new().unwrap();
        git2::Repository::init(repository.path()).unwrap();
        seed_git_repository(repository.path());
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                provisioning: None,
                project_id: None,
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-git-archive".into()),
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                base: WorkspaceBaseSpec::WorkingState,
                roots: vec![crate::WorkspaceBundleRootInput {
                    logical_root_id: "primary".into(),
                    role: crate::WorkspaceRootRole::Primary,
                    source_root: repository.path().to_string_lossy().into_owned(),
                }],
            })
            .unwrap();
        let lease = &bundle.leases[0];
        fs::write(Path::new(&lease.alias_path).join("README.md"), "managed\n").unwrap();

        service
            .archive_managed_workspace(&lease.workspace_id)
            .unwrap();
        assert!(!Path::new(&lease.alias_path).exists());
        let restored = service
            .restore_managed_workspace(&lease.workspace_id)
            .unwrap();
        assert_eq!(
            fs::read_to_string(Path::new(&restored.execution_root).join("README.md")).unwrap(),
            "managed\n"
        );
        let expected_lock = crate::registry::compose_lock_reason(&lease.workspace_id);
        assert_eq!(
            managed_git_lock_reason(repository.path(), Path::new(&restored.execution_root))
                .unwrap()
                .as_deref(),
            Some(expected_lock.as_str())
        );
    }

    #[test]
    fn startup_reconcile_imports_external_worktrees_without_mutating_them() {
        let data = TempDir::new().unwrap();
        let repository_parent = TempDir::new().unwrap();
        let repository = repository_parent.path().join("main");
        let external = repository_parent.path().join("external");
        fs::create_dir_all(&repository).unwrap();
        git2::Repository::init(&repository).unwrap();
        seed_git_repository(&repository);
        let add = Command::new("git")
            .args(["-C"])
            .arg(&repository)
            .args(["worktree", "add", "--detach"])
            .arg(&external)
            .arg("HEAD")
            .output()
            .unwrap();
        assert!(add.status.success());

        {
            let service =
                TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
            service
                .bind_workspace_source("repository:project:root", &repository, 1)
                .unwrap();
        }

        let reopened = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let imported = reopened
            .list_managed_workspaces()
            .unwrap()
            .into_iter()
            .find(|record| record.environment_kind == crate::WorkspaceEnvironmentKind::Imported)
            .expect("external worktree registered as imported");
        assert_eq!(
            normalized_path_key(Path::new(&imported.execution_root)),
            normalized_path_key(&external)
        );
        assert!(external.is_dir());
        assert_eq!(
            managed_git_lock_reason(&repository, &external).unwrap(),
            None
        );
        assert!(reopened
            .archive_managed_workspace(&imported.workspace_id)
            .unwrap_err()
            .contains("before adoption"));

        let second = reopened.reconcile_known_worktrees().unwrap();
        assert!(second.imported.is_empty());
        assert_eq!(
            reopened
                .list_managed_workspaces()
                .unwrap()
                .into_iter()
                .filter(|record| {
                    record.environment_kind == crate::WorkspaceEnvironmentKind::Imported
                })
                .count(),
            1
        );
        let foreign_lock = Command::new("git")
            .args(["-C"])
            .arg(&repository)
            .args(["worktree", "lock", "--reason", "external-owner"])
            .arg(&external)
            .status()
            .unwrap();
        assert!(foreign_lock.success());
        assert!(reopened
            .adopt_imported_workspace(&imported.workspace_id)
            .unwrap_err()
            .contains("locked by another owner (external-owner)"));
        let foreign_unlock = Command::new("git")
            .args(["-C"])
            .arg(&repository)
            .args(["worktree", "unlock"])
            .arg(&external)
            .status()
            .unwrap();
        assert!(foreign_unlock.success());

        let expected_lock = crate::registry::compose_lock_reason(&imported.workspace_id);
        let interrupted_lock = Command::new("git")
            .args(["-C"])
            .arg(&repository)
            .args(["worktree", "lock", "--reason", &expected_lock])
            .arg(&external)
            .status()
            .unwrap();
        assert!(interrupted_lock.success());
        let adopted = reopened
            .adopt_imported_workspace(&imported.workspace_id)
            .unwrap();
        assert_eq!(
            adopted.environment_kind,
            crate::WorkspaceEnvironmentKind::Managed
        );
        assert_eq!(adopted.owner_type, WorkspaceOwnerType::User);
        assert_eq!(
            managed_git_lock_reason(&repository, &external)
                .unwrap()
                .as_deref(),
            Some(expected_lock.as_str())
        );
    }

    #[test]
    fn lifecycle_policy_persists_and_blocks_creation_at_capacity() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let policy = crate::WorkspaceLifecyclePolicy {
            active_directory_cap: 1,
            snapshot_retention_days: 9,
            blob_budget_bytes: 4096,
        };
        {
            let service =
                TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
            assert_eq!(
                service.set_workspace_lifecycle_policy(policy).unwrap(),
                policy
            );
            service
                .begin_run(input(&workspace, "task-capacity-1", "run-capacity-1"))
                .unwrap();
            let error = service
                .begin_run(input(&workspace, "task-capacity-2", "run-capacity-2"))
                .unwrap_err();
            assert!(error.contains("managed workspace capacity reached (1+1/1)"));
            assert!(error.contains("Workspace settings"));
        }

        let reopened = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        assert_eq!(reopened.workspace_lifecycle_policy(), policy);
    }

    #[test]
    fn unified_environment_inventory_classifies_main_manual_and_managed_rows() {
        let data = TempDir::new().unwrap();
        let repository_parent = TempDir::new().unwrap();
        let repository = repository_parent.path().join("main");
        let manual = repository_parent.path().join("manual");
        fs::create_dir_all(&repository).unwrap();
        git2::Repository::init(&repository).unwrap();
        seed_git_repository(&repository);
        let add = Command::new("git")
            .args(["-C"])
            .arg(&repository)
            .args(["worktree", "add", "--detach"])
            .arg(&manual)
            .arg("HEAD")
            .output()
            .unwrap();
        assert!(add.status.success());

        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let environments = service
            .list_workspace_environments(Some(&repository))
            .unwrap();

        assert_eq!(environments.len(), 2);
        let main = environments
            .iter()
            .find(|environment| environment.ownership == crate::WorkspaceEnvironmentOwnership::Main)
            .unwrap();
        assert_eq!(
            Path::new(&main.path).canonicalize().unwrap(),
            repository.canonicalize().unwrap()
        );
        assert_eq!(
            main.allowed_actions,
            vec![crate::WorkspaceEnvironmentAction::Open]
        );
        assert_eq!(main.owner_type, None);
        assert_eq!(main.owner_ref, None);
        let manual = environments
            .iter()
            .find(|environment| {
                Path::new(&environment.path).canonicalize().ok() == manual.canonicalize().ok()
            })
            .unwrap();
        assert_eq!(
            manual.ownership,
            crate::WorkspaceEnvironmentOwnership::Manual
        );
        assert!(manual
            .allowed_actions
            .contains(&crate::WorkspaceEnvironmentAction::Adopt));
        assert!(manual
            .allowed_actions
            .contains(&crate::WorkspaceEnvironmentAction::Remove));
        assert!(manual.workspace_id.is_none());
        assert_eq!(manual.owner_type, None);
        assert_eq!(manual.owner_ref, None);

        let adopted = service
            .adopt_workspace_environment(
                &manual.environment_id,
                &repository,
                Path::new(&manual.path),
            )
            .unwrap();
        assert_eq!(
            adopted.environment_kind,
            crate::WorkspaceEnvironmentKind::Managed
        );
        assert_eq!(
            Path::new(&adopted.execution_root).canonicalize().unwrap(),
            Path::new(&manual.path).canonicalize().unwrap()
        );
        let adopted_summary = service
            .list_workspace_environments(Some(&repository))
            .unwrap()
            .into_iter()
            .find(|environment| environment.workspace_id.as_deref() == Some(&adopted.workspace_id))
            .unwrap();
        assert_eq!(adopted_summary.owner_type, Some(WorkspaceOwnerType::User));
        assert_eq!(adopted_summary.owner_ref, None);
    }

    #[test]
    fn environment_actions_only_advertise_executable_lifecycle_and_git_operations() {
        use crate::WorkspaceEnvironmentAction as Action;
        use crate::WorkspaceEnvironmentOwnership as Ownership;

        let active_git = environment_actions(
            Ownership::Managed,
            Some(WorkspaceState::Active),
            false,
            true,
        );
        assert!(active_git.contains(&Action::Archive));
        assert!(active_git.contains(&Action::CreateBranchHere));
        assert!(!active_git.contains(&Action::Review));
        assert!(!active_git.contains(&Action::Handoff));
        assert!(!active_git.contains(&Action::Publish));
        assert!(!active_git.contains(&Action::Delete));

        let active_shadow = environment_actions(
            Ownership::Managed,
            Some(WorkspaceState::Active),
            false,
            false,
        );
        assert!(!active_shadow.contains(&Action::CreateBranchHere));
        assert!(!active_shadow.contains(&Action::Publish));
        assert!(!active_shadow.contains(&Action::Delete));

        let archived = environment_actions(
            Ownership::Managed,
            Some(WorkspaceState::Archived),
            false,
            true,
        );
        assert!(archived.contains(&Action::Restore));
        assert!(archived.contains(&Action::Delete));

        let manual = environment_actions(Ownership::Manual, None, false, true);
        assert!(manual.contains(&Action::Remove));
        assert!(manual.contains(&Action::Adopt));
        assert!(!manual.contains(&Action::Prune));
    }

    #[test]
    fn bundle_turn_tracks_each_unique_physical_workspace_and_recovers_after_restart() {
        let data = TempDir::new().unwrap();
        let primary = TempDir::new().unwrap();
        let additional = TempDir::new().unwrap();
        fs::write(primary.path().join("primary.txt"), "before\n").unwrap();
        fs::write(additional.path().join("additional.txt"), "before\n").unwrap();

        let turn_id;
        {
            let service =
                TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
            let bundle = service
                .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                    provisioning: None,
                    project_id: None,
                    owner_type: WorkspaceOwnerType::Session,
                    owner_ref: Some("session-1".into()),
                    environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                    base: WorkspaceBaseSpec::WorkingState,
                    roots: vec![
                        crate::WorkspaceBundleRootInput {
                            logical_root_id: "primary".into(),
                            role: crate::WorkspaceRootRole::Primary,
                            source_root: primary.path().to_string_lossy().into_owned(),
                        },
                        crate::WorkspaceBundleRootInput {
                            logical_root_id: "additional".into(),
                            role: crate::WorkspaceRootRole::Additional,
                            source_root: additional.path().to_string_lossy().into_owned(),
                        },
                    ],
                })
                .unwrap();
            let request = crate::BeginWorkspaceBundleTurn {
                primary_logical_root_id: "primary".into(),
                run: BeginTaskRun {
                    turn_id: Some("bundle-turn-1".into()),
                    ..input(&primary, "task-turn", "run-turn")
                },
            };
            let turn = service
                .begin_workspace_bundle_turn(&bundle.bundle_id, request)
                .unwrap();
            assert_eq!(turn.runs.len(), 2);
            assert_eq!(turn.state, RunState::Running);
            assert_eq!(turn.primary_alias, bundle.leases[0].alias_path);
            assert_eq!(
                turn.additional_aliases,
                vec![bundle.leases[1].alias_path.clone()]
            );
            for run in &turn.runs {
                assert_eq!(run.logical_root_ids.len(), 1);
                assert_eq!(
                    run.run.turn_id.as_deref(),
                    Some(turn.bundle_turn_id.as_str())
                );
            }
            turn_id = turn.bundle_turn_id;
        }

        let reopened = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let recovered = reopened
            .get_workspace_bundle_turn(&turn_id)
            .unwrap()
            .unwrap();
        assert_eq!(recovered.runs.len(), 2);
        assert_eq!(recovered.state, RunState::Failed);
        assert!(recovered.settled_at.is_some());
    }

    #[test]
    fn settling_a_bundle_turn_run_cascades_to_every_physical_workspace() {
        let data = TempDir::new().unwrap();
        let primary = TempDir::new().unwrap();
        let additional = TempDir::new().unwrap();
        fs::write(primary.path().join("primary.txt"), "before\n").unwrap();
        fs::write(additional.path().join("additional.txt"), "before\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                provisioning: None,
                project_id: None,
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-1".into()),
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                base: WorkspaceBaseSpec::WorkingState,
                roots: vec![
                    crate::WorkspaceBundleRootInput {
                        logical_root_id: "primary".into(),
                        role: crate::WorkspaceRootRole::Primary,
                        source_root: primary.path().to_string_lossy().into_owned(),
                    },
                    crate::WorkspaceBundleRootInput {
                        logical_root_id: "additional".into(),
                        role: crate::WorkspaceRootRole::Additional,
                        source_root: additional.path().to_string_lossy().into_owned(),
                    },
                ],
            })
            .unwrap();
        let turn = service
            .begin_workspace_bundle_turn(
                &bundle.bundle_id,
                crate::BeginWorkspaceBundleTurn {
                    primary_logical_root_id: "primary".into(),
                    run: input(&primary, "task-cascade", "run-cascade"),
                },
            )
            .unwrap();
        for run in &turn.runs {
            let name = if run
                .logical_root_ids
                .iter()
                .any(|logical| logical == "primary")
            {
                "primary.txt"
            } else {
                "additional.txt"
            };
            fs::write(Path::new(&run.run.execution_root).join(name), "after\n").unwrap();
        }
        let primary_run_id = turn
            .runs
            .iter()
            .find(|run| {
                run.logical_root_ids
                    .iter()
                    .any(|logical| logical == "primary")
            })
            .unwrap()
            .run
            .run_id
            .clone();

        let resources = service.settle_run(&primary_run_id).unwrap();

        assert_eq!(resources.len(), 2);
        let settled = service
            .get_workspace_bundle_turn(&turn.bundle_turn_id)
            .unwrap()
            .unwrap();
        assert_eq!(settled.state, RunState::Ready);
        assert!(settled
            .runs
            .iter()
            .all(|run| run.run.state == RunState::Ready));
    }

    #[test]
    fn bundle_turn_deduplicates_logical_roots_in_one_git_worktree() {
        let data = TempDir::new().unwrap();
        let repository = TempDir::new().unwrap();
        git2::Repository::init(repository.path()).unwrap();
        seed_git_repository(repository.path());
        let package = repository.path().join("package");
        fs::create_dir_all(&package).unwrap();
        fs::write(package.join("package.txt"), "package\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                provisioning: None,
                project_id: None,
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-1".into()),
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                base: WorkspaceBaseSpec::WorkingState,
                roots: vec![
                    crate::WorkspaceBundleRootInput {
                        logical_root_id: "repository".into(),
                        role: crate::WorkspaceRootRole::Primary,
                        source_root: repository.path().to_string_lossy().into_owned(),
                    },
                    crate::WorkspaceBundleRootInput {
                        logical_root_id: "package".into(),
                        role: crate::WorkspaceRootRole::Additional,
                        source_root: package.to_string_lossy().into_owned(),
                    },
                ],
            })
            .unwrap();

        let turn = service
            .begin_workspace_bundle_turn(
                &bundle.bundle_id,
                crate::BeginWorkspaceBundleTurn {
                    primary_logical_root_id: "repository".into(),
                    run: input(&repository, "task-shared-root", "run-shared-root"),
                },
            )
            .unwrap();

        assert_eq!(turn.runs.len(), 1);
        assert_eq!(
            turn.runs[0].logical_root_ids,
            vec!["repository".to_string(), "package".to_string()]
        );
    }

    #[test]
    fn bundle_handoff_applies_every_physical_root_as_one_service_operation() {
        let data = TempDir::new().unwrap();
        let primary = TempDir::new().unwrap();
        let additional = TempDir::new().unwrap();
        fs::write(primary.path().join("primary.txt"), "before\n").unwrap();
        fs::write(additional.path().join("additional.txt"), "before\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                provisioning: None,
                project_id: None,
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-1".into()),
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                base: WorkspaceBaseSpec::WorkingState,
                roots: vec![
                    crate::WorkspaceBundleRootInput {
                        logical_root_id: "primary".into(),
                        role: crate::WorkspaceRootRole::Primary,
                        source_root: primary.path().to_string_lossy().into_owned(),
                    },
                    crate::WorkspaceBundleRootInput {
                        logical_root_id: "additional".into(),
                        role: crate::WorkspaceRootRole::Additional,
                        source_root: additional.path().to_string_lossy().into_owned(),
                    },
                ],
            })
            .unwrap();
        let turn = service
            .begin_workspace_bundle_turn(
                &bundle.bundle_id,
                crate::BeginWorkspaceBundleTurn {
                    primary_logical_root_id: "primary".into(),
                    run: input(&primary, "task-handoff", "run-handoff"),
                },
            )
            .unwrap();
        let additional_workspace_id = bundle
            .leases
            .iter()
            .find(|lease| lease.logical_root_id == "additional")
            .unwrap()
            .workspace_id
            .clone();
        for run in &turn.runs {
            let name = if run.logical_root_ids.contains(&"primary".to_string()) {
                "primary.txt"
            } else {
                "additional.txt"
            };
            fs::write(Path::new(&run.run.execution_root).join(name), "after\n").unwrap();
        }
        service
            .settle_workspace_bundle_turn(&turn.bundle_turn_id, RunState::Ready)
            .unwrap();
        fs::write(primary.path().join("primary.txt"), "user change\n").unwrap();

        let request = crate::BundleHandoffRequest {
            bundle_turn_id: turn.bundle_turn_id.clone(),
            selections: Vec::new(),
            allow_irreversible: false,
        };
        let conflicted = service
            .apply_workspace_bundle(&bundle.bundle_id, request.clone())
            .unwrap();
        assert_eq!(conflicted.outcome.state, WorkspaceState::Conflict);
        assert_eq!(
            fs::read_to_string(additional.path().join("additional.txt")).unwrap(),
            "before\n"
        );
        fs::write(primary.path().join("primary.txt"), "before\n").unwrap();

        let handoff = service
            .retry_workspace_bundle_handoff(&bundle.bundle_id, request)
            .unwrap();

        assert_eq!(handoff.outcome.state, WorkspaceState::Active);
        assert_eq!(handoff.outcome.applied.len(), 2);
        assert_eq!(
            fs::read_to_string(primary.path().join("primary.txt")).unwrap(),
            "after\n"
        );
        assert_eq!(
            fs::read_to_string(additional.path().join("additional.txt")).unwrap(),
            "after\n"
        );

        fs::write(primary.path().join("primary.txt"), "user change\n").unwrap();
        let compensated = service
            .undo_workspace_bundle_handoff(&bundle.bundle_id, &turn.bundle_turn_id)
            .unwrap();
        assert_eq!(compensated.state, WorkspaceState::Active);
        assert_eq!(compensated.reverted, Vec::<String>::new());
        assert_eq!(compensated.re_applied, vec![additional_workspace_id]);
        assert!(!compensated.conflicts.is_empty());
        assert_eq!(
            fs::read_to_string(primary.path().join("primary.txt")).unwrap(),
            "user change\n"
        );
        assert_eq!(
            fs::read_to_string(additional.path().join("additional.txt")).unwrap(),
            "after\n"
        );

        fs::write(primary.path().join("primary.txt"), "after\n").unwrap();
        let undone = service
            .undo_workspace_bundle_handoff(&bundle.bundle_id, &turn.bundle_turn_id)
            .unwrap();
        assert_eq!(undone.state, WorkspaceState::Active);
        assert_eq!(undone.reverted.len(), 2);
        assert!(undone.re_applied.is_empty());
        assert!(undone.conflicts.is_empty());
        assert_eq!(
            fs::read_to_string(primary.path().join("primary.txt")).unwrap(),
            "before\n"
        );
        assert_eq!(
            fs::read_to_string(additional.path().join("additional.txt")).unwrap(),
            "before\n"
        );
        assert_eq!(
            service
                .get_bundle_handoff_undo_outcome(&turn.bundle_turn_id)
                .unwrap(),
            Some(undone)
        );
    }

    #[test]
    fn maintenance_expires_aged_archives_and_persists_history() {
        let data = TempDir::new().unwrap();
        let shadow = TempDir::new().unwrap();
        fs::write(shadow.path().join("notes.txt"), "notes\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        service
            .set_workspace_lifecycle_policy(crate::WorkspaceLifecyclePolicy {
                active_directory_cap: 15,
                snapshot_retention_days: 1,
                blob_budget_bytes: 1 << 30,
            })
            .unwrap();
        let bundle = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                provisioning: None,
                project_id: None,
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-1".into()),
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                base: WorkspaceBaseSpec::WorkingState,
                roots: vec![crate::WorkspaceBundleRootInput {
                    logical_root_id: "primary".into(),
                    role: crate::WorkspaceRootRole::Primary,
                    source_root: shadow.path().to_string_lossy().into_owned(),
                }],
            })
            .unwrap();
        let workspace_id = bundle.leases[0].workspace_id.clone();
        service.archive_managed_workspace(&workspace_id).unwrap();

        let result = service
            .run_workspace_maintenance(crate::WorkspaceMaintenanceRequest {
                now: Some(now_ms() + 2 * 24 * 60 * 60 * 1_000),
            })
            .unwrap();

        assert_eq!(
            result.expired_snapshot_task_ids,
            vec![format!("workspace:{workspace_id}")]
        );
        assert!(service
            .get_managed_workspace(&workspace_id)
            .unwrap()
            .is_none());
        let history = service.list_workspace_maintenance_events(10).unwrap();
        assert!(history.iter().any(|event| {
            event.kind == crate::WorkspaceMaintenanceEventKind::SnapshotExpired
                && event.workspace_id.as_deref() == Some(workspace_id.as_str())
        }));
    }

    #[test]
    fn maintenance_preserves_archives_with_unapplied_task_patches() {
        let data = TempDir::new().unwrap();
        let shadow = TempDir::new().unwrap();
        fs::write(shadow.path().join("notes.txt"), "before\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        service
            .set_workspace_lifecycle_policy(crate::WorkspaceLifecyclePolicy {
                active_directory_cap: 15,
                snapshot_retention_days: 1,
                blob_budget_bytes: 1 << 30,
            })
            .unwrap();
        let run = service
            .begin_run(input(&shadow, "task-protected", "run-protected"))
            .unwrap();
        fs::write(Path::new(&run.execution_root).join("notes.txt"), "after\n").unwrap();
        service.settle_run(&run.run_id).unwrap();
        let workspace_id = run.workspace_id.unwrap();
        service.archive_managed_workspace(&workspace_id).unwrap();

        let result = service
            .run_workspace_maintenance(crate::WorkspaceMaintenanceRequest {
                now: Some(now_ms() + 2 * 24 * 60 * 60 * 1_000),
            })
            .unwrap();

        assert!(result.expired_snapshot_task_ids.is_empty());
        assert!(service
            .get_managed_workspace(&workspace_id)
            .unwrap()
            .is_some());
    }

    #[test]
    fn records_host_created_branch_on_an_active_managed_git_environment() {
        let data = TempDir::new().unwrap();
        let repository = TempDir::new().unwrap();
        git2::Repository::init(repository.path()).unwrap();
        seed_git_repository(repository.path());
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                provisioning: None,
                project_id: None,
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-1".into()),
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                base: WorkspaceBaseSpec::LocalHead,
                roots: vec![crate::WorkspaceBundleRootInput {
                    logical_root_id: "primary".into(),
                    role: crate::WorkspaceRootRole::Primary,
                    source_root: repository.path().to_string_lossy().into_owned(),
                }],
            })
            .unwrap();

        let recorded = service
            .record_workspace_branch(
                &bundle.leases[0].workspace_id,
                "feature/managed",
                Some("0123456789abcdef"),
            )
            .unwrap();

        assert_eq!(
            service
                .workspace_branch_target(&bundle.leases[0].workspace_id)
                .unwrap(),
            bundle.leases[0].alias_path
        );
        assert_eq!(recorded.branch.as_deref(), Some("feature/managed"));
        assert_eq!(recorded.head.as_deref(), Some("0123456789abcdef"));
    }

    #[test]
    fn adoption_respects_managed_workspace_capacity() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        service
            .set_workspace_lifecycle_policy(crate::WorkspaceLifecyclePolicy {
                active_directory_cap: 1,
                snapshot_retention_days: 9,
                blob_budget_bytes: 4096,
            })
            .unwrap();
        service
            .begin_run(input(&workspace, "task-capacity-1", "run-capacity-1"))
            .unwrap();
        let imported = service
            .registry
            .insert_imported(
                crate::ImportedWorkspaceHint {
                    source_root: workspace.path().to_string_lossy().into_owned(),
                    execution_root: workspace
                        .path()
                        .join("external")
                        .to_string_lossy()
                        .into_owned(),
                    git_common_dir: None,
                    branch: None,
                },
                2,
            )
            .unwrap();

        let adoption_error = service
            .adopt_imported_workspace(&imported.workspace_id)
            .unwrap_err();
        assert!(adoption_error.contains("managed workspace capacity reached (1+1/1)"));
        assert_eq!(
            service
                .registry
                .get(&imported.workspace_id)
                .unwrap()
                .unwrap()
                .environment_kind,
            crate::WorkspaceEnvironmentKind::Imported
        );
    }
}
