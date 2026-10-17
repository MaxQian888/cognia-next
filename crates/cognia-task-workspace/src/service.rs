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
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

/// Moves execution working copies out of the data directory (ADR-0224 A8):
/// an absolute directory that holds `executions/` and the `scratch/` beside
/// it. An always-on Host whose sandbox pool mounts workspaces from one volume
/// points this into that volume, so the runtime a turn's tools run in can
/// mount the working copy the turn runs on.
pub const EXECUTION_ROOT_ENV: &str = "COGNIA_TASK_WORKSPACE_EXECUTION_ROOT";

#[derive(Debug, Clone)]
pub struct ServiceConfig {
    pub data_dir: PathBuf,
    pub retention: Duration,
    pub max_blob_bytes: u64,
    /// See [`EXECUTION_ROOT_ENV`]. Absent: `<data_dir>/task-workspaces`.
    pub execution_root: Option<PathBuf>,
    /// The largest working-copy snapshot this host accepts (ADR-0224 A11b,
    /// [`crate::CODE_SNAPSHOT_MAX_BYTES_ENV`]).
    pub code_snapshot_max_bytes: u64,
}

impl ServiceConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            retention: Duration::from_secs(30 * 24 * 60 * 60),
            max_blob_bytes: 1024 * 1024 * 1024,
            execution_root: None,
            code_snapshot_max_bytes: crate::DEFAULT_CODE_SNAPSHOT_MAX_BYTES,
        }
    }

    /// Where execution working copies are created.
    pub fn execution_dir(&self) -> PathBuf {
        self.execution_root
            .clone()
            .unwrap_or_else(|| self.data_dir.join("task-workspaces"))
            .join("executions")
    }
}

/// The execution root an [`EXECUTION_ROOT_ENV`] value names. Unset or blank
/// is no override; a relative path is refused rather than resolved against
/// whatever the working directory happens to be.
pub fn execution_root_from(raw: Option<&str>) -> Result<Option<PathBuf>, String> {
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(None),
        Some(value) if std::path::Path::new(value).is_absolute() => Ok(Some(PathBuf::from(value))),
        Some(value) => Err(format!(
            "{EXECUTION_ROOT_ENV}={value:?} must be an absolute path"
        )),
    }
}

pub struct TaskWorkspaceService {
    pub(crate) store: Arc<Mutex<WorkspaceStore>>,
    pub(crate) registry: WorkspaceRegistry,
    pub(crate) integration_dir: PathBuf,
    pub(crate) execution_dir: PathBuf,
    pub(crate) checkpoint_dir: PathBuf,
    /// Managed source checkouts supplied from a remote (ADR-0176).
    ///
    /// A sibling of `execution_dir`, not a child, because a source checkout is
    /// not an execution root: `reject_registry_owned_source` refuses anything
    /// under an execution root, and a supplied source has to be bindable.
    sources_dir: PathBuf,
    /// The bare-mirror cache the sources are derived from.
    ///
    /// Held here rather than read from `cognia_git_mirror::root()` so the
    /// service is consistent with its own data directory and testable without
    /// a process-global. `task_workspace::install` points the global at this
    /// same path, so the two never disagree in production.
    mirrors_dir: PathBuf,
    manifest_key: Vec<u8>,
    retention: Duration,
    transfers: TransferRegistry,
    upload_owners: Mutex<HashMap<String, UploadOwner>>,
    origin_hints: Mutex<HashMap<(String, String), ContributionOrigin>>,
    watchers: WatchManager,
    /// `WorktreeCreate` / `WorktreeRemove` producer (ADR-0111 decision 9).
    lifecycle: crate::lifecycle::WorktreeLifecycleEmitter,
    /// One mutex per repository, keyed by Git common directory.
    ///
    /// Every task-workspace command runs on the blocking pool, so two
    /// acquisitions for the same repository genuinely execute at the same time
    /// and race on Git's own administrative state — `index.lock`, the
    /// `worktrees/` directory, the ref store. Git reports that as a spurious
    /// "Unable to create '.../index.lock': File exists" and the acquisition
    /// fails for a reason that has nothing to do with the caller.
    ///
    /// Keyed by common directory rather than by workspace root so a repository
    /// and every linked worktree cut from it share one lock: they share the one
    /// administrative area that is being protected.
    git_admin_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// The last resource index folded, with the database change fingerprint
    /// it was folded at (ADR-0223 §8). The Files page reads the index a page
    /// at a time and again on every focus; while the ledger is unchanged each
    /// of those reads is a slice of this one fold.
    resource_index: Mutex<Option<ResourceIndexFold>>,
    /// Working-copy snapshots this device made for an always-on host
    /// (ADR-0224 A11b).
    code_snapshot_outbox: crate::CodeSnapshotOutbox,
    /// Snapshots arriving on this host and the checkouts they became.
    code_snapshot_inbox: crate::CodeSnapshotInbox,
    /// Work a handed-over checkout exported, waiting to be read (A11c).
    code_result_outbox: crate::CodeSnapshotOutbox,
    /// Work coming back to this device, and the worktrees it became.
    code_result_inbox: crate::CodeSnapshotInbox,
    /// Rows open-time recovery could not repair, reported (once) by the next
    /// maintenance pass.
    open_recovery_failures: Mutex<Vec<String>>,
    /// Latest non-authoritative discovery failure per cwd, exposed by snapshots.
    port_discovery_diagnostics: Mutex<BTreeMap<PathBuf, crate::PortLeaseDiagnostic>>,
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
    /// Branch the worktree was created on (`-b <requested_name>`), so a
    /// rollback removes it too — the worktree alone is not the whole artifact.
    created_branch: Option<String>,
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

struct ResourceIndexFold {
    fingerprint: (u64, i64),
    entries: Arc<Vec<crate::ResourceIndexEntry>>,
}

impl TaskWorkspaceService {
    pub fn open(config: ServiceConfig) -> Result<Self, String> {
        let service_dir = config.data_dir.join("task-workspaces");
        let execution_dir = config.execution_dir();
        fs::create_dir_all(&execution_dir).map_err(|error| {
            format!("create execution dir {}: {error}", execution_dir.display())
        })?;
        let sources_dir = service_dir.join("sources");
        let mirrors_dir = service_dir.join("mirrors");
        let snapshots_dir = service_dir.join("code-snapshots");
        // Under the execution root, so a containerised run on an always-on
        // host mounts a handed-over checkout like any other run's worktree.
        let code_snapshot_inbox = crate::CodeSnapshotInbox::new(
            &snapshots_dir,
            execution_dir.join("handoffs"),
            config.code_snapshot_max_bytes,
        );
        let code_result_inbox = crate::CodeSnapshotInbox::new(
            &snapshots_dir.join("returns"),
            execution_dir.join("returns"),
            config.code_snapshot_max_bytes,
        );
        let store = Arc::new(Mutex::new(WorkspaceStore::open(
            &service_dir,
            config.max_blob_bytes,
        )?));
        let registry =
            WorkspaceRegistry::new(Arc::clone(&store)).map_err(|error| error.to_string())?;
        let service = Self {
            store,
            registry,
            integration_dir: config.data_dir.join("integration"),
            execution_dir,
            checkpoint_dir: service_dir.join("sandbox-checkpoints"),
            sources_dir,
            mirrors_dir,
            manifest_key: load_or_create_manifest_key(&service_dir)?,
            retention: config.retention,
            transfers: TransferRegistry::new(Duration::from_secs(5 * 60)),
            upload_owners: Mutex::new(HashMap::new()),
            origin_hints: Mutex::new(HashMap::new()),
            watchers: WatchManager::new(),
            lifecycle: crate::lifecycle::WorktreeLifecycleEmitter::default(),
            git_admin_locks: Mutex::new(HashMap::new()),
            resource_index: Mutex::new(None),
            code_snapshot_outbox: crate::CodeSnapshotOutbox::new(snapshots_dir.join("outgoing")),
            code_snapshot_inbox,
            code_result_outbox: crate::CodeSnapshotOutbox::new(snapshots_dir.join("results")),
            code_result_inbox,
            open_recovery_failures: Mutex::new(Vec::new()),
            port_discovery_diagnostics: Mutex::new(BTreeMap::new()),
        };
        service.recover_incomplete_runs()?;
        service.recover_workspace_bundle_turns()?;
        // Per-row recovery failures (an offline or broken repository) never
        // keep the service from opening; the next maintenance pass reports
        // them, and the next open retries them.
        let integration_failures = service
            .recover_integrations()
            .map_err(|error| error.to_string())?;
        let pin_failures = service
            .recover_changeset_pins()
            .map_err(|error| error.to_string())?;
        *service.open_recovery_failures.lock() = integration_failures
            .into_iter()
            .map(|(id, error)| format!("integration {id} not recovered: {error}"))
            .chain(
                pin_failures
                    .into_iter()
                    .map(|(id, error)| format!("changeset {id} pin not repaired: {error}")),
            )
            .collect();
        if let Err(error) = crate::provenance::capture::reconcile(&mut service.store.lock()) {
            eprintln!("provenance boot reconciliation failed: {error}");
            service
                .open_recovery_failures
                .lock()
                .push(format!("provenance mutations not reconciled: {error}"));
        }
        service.reconcile_known_worktrees()?;
        match service.reconcile_workspace_port_leases() {
            Ok(diagnostics) => {
                service
                    .open_recovery_failures
                    .lock()
                    .extend(diagnostics.into_iter().map(|diagnostic| {
                        format!(
                            "port lease {:?}: {} ({:?})",
                            diagnostic.kind, diagnostic.detail, diagnostic.lease_ids
                        )
                    }))
            }
            Err(error) => service
                .open_recovery_failures
                .lock()
                .push(format!("port leases not reconciled: {error}")),
        }
        Ok(service)
    }

    /// Supply a managed source checkout from a remote, then hand back a root
    /// that `acquire_workspace_bundle` can be called on (ADR-0176).
    ///
    /// This is the missing half of the workspace story on a host with no
    /// human at a terminal. Everything after it already worked, and none of it
    /// changes: a supplied source is an ordinary non-bare git root with
    /// commits in it.
    ///
    /// The per-repository lock is the same one acquisition takes, so two issue
    /// runs that start on one repository at the same moment queue rather than
    /// racing on one directory. It is taken on the *source root* because that
    /// is the git common directory being written, and it is released before
    /// this returns so the acquisition that follows can take it in turn.
    pub fn ensure_remote_source(
        &self,
        input: &crate::remote_source::EnsureRemoteSource,
    ) -> Result<crate::remote_source::RemoteSourceCheckout, String> {
        let planned = cognia_git_mirror::checkout_path(&self.sources_dir, input.remote_url.trim())
            .map_err(|error| format!("resolve source checkout path: {error}"))?;
        // The lock keys on the git common directory, which does not exist for a
        // checkout that has not been supplied yet. Falling back to the planned
        // path still serialises the two callers that matter: the ones racing to
        // create it.
        let lock = self
            .git_admin_lock(&planned)
            .unwrap_or_else(|| Arc::new(Mutex::new(())));
        let _held = lock.lock();
        crate::remote_source::ensure_remote_source(&self.mirrors_dir, &self.sources_dir, input)
    }

    /// The directory a project's work runs in on this host: one of its own
    /// folders when one exists here, else a clone of its repository supplied
    /// through [`Self::ensure_remote_source`] (ADR-0224 A11).
    pub fn ensure_project_source(
        &self,
        input: &crate::project_source::EnsureProjectSource,
    ) -> Result<crate::project_source::ProjectSource, String> {
        crate::project_source::ensure_project_source(input, |request| {
            self.ensure_remote_source(&request)
        })
    }

    /// Resolve a session's canonical scratch bundle without accepting a path
    /// from the caller. The on-disk lock serializes separate service instances
    /// too, and is released by the OS if provisioning is interrupted.
    pub fn ensure_session_scratch_workspace(
        &self,
        input: &crate::EnsureSessionScratchWorkspace,
    ) -> Result<crate::WorkspaceBundle, String> {
        validate_id("sessionId", &input.session_id)?;
        if matches!(input.session_id.as_str(), "." | "..") {
            return Err("invalid sessionId".into());
        }
        if let Some(bundle_id) = &input.bundle_id {
            validate_id("bundleId", bundle_id)?;
        }
        let (_session_lock, seed) = self.lock_session_scratch(&input.session_id)?;
        validate_scratch_path(&seed)?;

        let bundles = self.list_workspace_bundles()?;
        let owned = bundles
            .iter()
            .filter(|bundle| {
                bundle.owner_type == WorkspaceOwnerType::Session
                    && bundle.owner_ref.as_deref() == Some(input.session_id.as_str())
            })
            .collect::<Vec<_>>();
        if let Some(bundle_id) = &input.bundle_id {
            let known = bundles
                .iter()
                .find(|bundle| &bundle.bundle_id == bundle_id)
                .ok_or_else(|| format!("scratch workspace bundle not found: {bundle_id}"))?;
            if known.owner_type != WorkspaceOwnerType::Session
                || known.owner_ref.as_deref() != Some(input.session_id.as_str())
            {
                return Err("scratch workspace bundle belongs to another owner".into());
            }
        }
        if owned.len() > 1 {
            return Err(
                "session has multiple workspace bundles; scratch ownership is ambiguous".into(),
            );
        }
        if let Some(bundle) = owned.first() {
            self.validate_session_scratch_bundle(bundle, &input.session_id, &seed)?;
            for lease in &bundle.leases {
                self.ensure_workspace_port_lease(
                    &lease.workspace_id,
                    crate::HOST_LOOPBACK_NAMESPACE,
                )
                .map_err(|error| error.to_string())?;
            }
            return Ok((*bundle).clone());
        }
        // An interrupted acquisition can leave a reserved registry row. Do
        // not replace it (or a lost bundle) with a new empty working copy.
        if self
            .registry
            .list()
            .map_err(|error| error.to_string())?
            .iter()
            .any(|record| {
                record.owner_type == WorkspaceOwnerType::Session
                    && record.owner_ref.as_deref() == Some(input.session_id.as_str())
            })
        {
            return Err(
                "scratch workspace has registry state but no bundle; repair is required".into(),
            );
        }
        if seed.exists() {
            return Err("scratch source exists without its bundle; repair is required".into());
        }
        fs::create_dir(&seed).map_err(|error| format!("create scratch session seed: {error}"))?;
        if git2::Repository::discover(&seed).is_ok() {
            let _ = fs::remove_dir(&seed);
            return Err("scratch source area must not be inside a Git repository".into());
        }
        let result = self.acquire_workspace_bundle(AcquireWorkspaceBundle {
            owner_type: WorkspaceOwnerType::Session,
            owner_ref: Some(input.session_id.clone()),
            project_id: None,
            environment_kind: crate::WorkspaceEnvironmentKind::Managed,
            base: WorkspaceBaseSpec::WorkingState,
            roots: vec![crate::WorkspaceBundleRootInput {
                logical_root_id: "primary".into(),
                role: crate::WorkspaceRootRole::Primary,
                source_root: seed.to_string_lossy().into_owned(),
            }],
            provisioning: None,
            requested_name: None,
        });
        let bundle = match result {
            Ok(bundle) => bundle,
            Err(error) => {
                // Remove only the empty seed this attempt created. Any
                // partial registry state remains visible on the next call.
                let _ = fs::remove_dir(&seed);
                return Err(error);
            }
        };
        self.validate_session_scratch_bundle(&bundle, &input.session_id, &seed)?;
        Ok(bundle)
    }

    /// One lock protects provisioning, turn acquisition, and archive. A
    /// checked idle scratch cannot become busy before its files are removed.
    fn lock_session_scratch(&self, session_id: &str) -> Result<(fs::File, PathBuf), String> {
        use sha2::{Digest, Sha256};
        let area = self.sources_dir.join("session-scratch");
        validate_scratch_path(&area)?;
        validate_scratch_path(&self.execution_dir.join("bundles"))?;
        fs::create_dir_all(&area)
            .map_err(|error| format!("create scratch source area: {error}"))?;
        let area = area
            .canonicalize()
            .map_err(|error| format!("resolve scratch source area: {error}"))?;
        let key = hex::encode(Sha256::digest(session_id.as_bytes()));
        let lock_path = area.join(format!("{key}.lock"));
        validate_scratch_path(&lock_path)?;
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let lock = options
            .open(&lock_path)
            .map_err(|error| format!("open scratch session lock: {error}"))?;
        lock.lock()
            .map_err(|error| format!("lock scratch session: {error}"))?;
        Ok((lock, area.join(key)))
    }

    fn lock_scratch_record(&self, record: &WorkspaceRecord) -> Result<Option<fs::File>, String> {
        use sha2::{Digest, Sha256};
        let Some(session_id) = record.owner_ref.as_deref() else {
            return Ok(None);
        };
        if record.owner_type != WorkspaceOwnerType::Session
            || record.environment_kind != crate::WorkspaceEnvironmentKind::Managed
            || record.isolation_kind != IsolationKind::Shadow
            || record.project_id.is_some()
        {
            return Ok(None);
        }
        let expected_seed = self
            .sources_dir
            .join("session-scratch")
            .join(hex::encode(Sha256::digest(session_id.as_bytes())));
        if normalized_path_key(Path::new(&record.source_root))
            != normalized_path_key(&expected_seed)
        {
            return Ok(None);
        }
        let (lock, _) = self.lock_session_scratch(session_id)?;
        Ok(Some(lock))
    }

    fn validate_session_scratch_bundle(
        &self,
        bundle: &crate::WorkspaceBundle,
        session_id: &str,
        seed: &Path,
    ) -> Result<(), String> {
        if bundle.environment_kind != crate::WorkspaceEnvironmentKind::Managed
            || bundle.state != WorkspaceState::Active
            || bundle.leases.len() != 1
        {
            return Err("scratch workspace bundle is not a single active managed root".into());
        }
        let lease = &bundle.leases[0];
        if lease.logical_root_id != "primary"
            || lease.role != crate::WorkspaceRootRole::Primary
            || lease.bundle_id != bundle.bundle_id
        {
            return Err("scratch workspace bundle has an invalid primary lease".into());
        }
        let record = self
            .registry
            .get(&lease.workspace_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "scratch workspace registry record is missing".to_string())?;
        let expected_root = self
            .execution_dir
            .join("bundles")
            .join(storage_key(&bundle.bundle_id))
            .join(storage_key(&lease.workspace_id));
        if record.owner_type != WorkspaceOwnerType::Session
            || record.owner_ref.as_deref() != Some(session_id)
            || record.environment_kind != crate::WorkspaceEnvironmentKind::Managed
            || record.isolation_kind != IsolationKind::Shadow
            || record.base != WorkspaceBaseSpec::WorkingState
            || record.project_id.is_some()
            || Path::new(&record.source_root) != seed
            || Path::new(&record.execution_root) != expected_root
            || Path::new(&lease.alias_path) != expected_root
        {
            return Err(
                "scratch workspace ownership, isolation, or managed path does not match".into(),
            );
        }
        validate_scratch_path(seed)?;
        validate_scratch_path(&expected_root)?;
        if !seed.is_dir()
            || fs::read_dir(seed)
                .map_err(|error| format!("read scratch seed: {error}"))?
                .next()
                .is_some()
        {
            return Err("scratch workspace empty source seed is missing or modified".into());
        }
        if !matches!(
            record.state,
            WorkspaceState::Active | WorkspaceState::Archived | WorkspaceState::Restorable
        ) {
            return Err(format!(
                "scratch workspace is not usable: {:?}",
                record.state
            ));
        }
        if !expected_root.is_dir() {
            if self
                .store
                .lock()
                .get_workspace_archive(&record.workspace_id)?
                .is_none()
            {
                return Err(
                    "scratch workspace files are missing and no restorable archive exists".into(),
                );
            }
            if record.state == WorkspaceState::Active {
                self.registry
                    .transition(
                        &record.workspace_id,
                        record.owner_type,
                        record.owner_ref.as_deref(),
                        WorkspaceState::Archived,
                        now_ms(),
                    )
                    .map_err(|error| error.to_string())?;
            }
            self.restore_managed_workspace(&record.workspace_id)?;
        } else if record.state != WorkspaceState::Active {
            return Err(
                "archived scratch workspace still has a directory; repair is required".into(),
            );
        }
        Ok(())
    }

    /// Snapshot a working copy on this device for an always-on host
    /// (ADR-0224 A11b). The bytes stay here until read out chunk by chunk.
    pub fn create_code_snapshot(
        &self,
        input: &crate::CreateCodeSnapshot,
    ) -> Result<crate::CreatedCodeSnapshot, String> {
        self.code_snapshot_outbox.create(input)
    }

    pub fn read_code_snapshot_chunk(
        &self,
        snapshot_id: &str,
        offset: u64,
    ) -> Result<TransferChunk, String> {
        self.code_snapshot_outbox.read_chunk(snapshot_id, offset)
    }

    pub fn discard_code_snapshot(&self, snapshot_id: &str) -> Result<(), String> {
        self.code_snapshot_outbox.discard(snapshot_id)
    }

    pub fn code_snapshot_limits(&self) -> crate::CodeSnapshotLimits {
        self.code_snapshot_inbox.limits()
    }

    pub fn open_code_snapshot_upload(
        &self,
        size_bytes: u64,
        sha256: &str,
    ) -> Result<crate::CodeSnapshotUpload, String> {
        self.code_snapshot_inbox.open_upload(size_bytes, sha256)
    }

    pub fn write_code_snapshot_chunk(
        &self,
        upload_id: &str,
        offset: u64,
        data_base64: &str,
        chunk_hash: &str,
    ) -> Result<u64, String> {
        self.code_snapshot_inbox
            .write_chunk(upload_id, offset, data_base64, chunk_hash)
    }

    pub fn commit_code_snapshot_upload(
        &self,
        upload_id: &str,
    ) -> Result<crate::CommittedCodeSnapshot, String> {
        self.code_snapshot_inbox.commit_upload(upload_id)
    }

    pub fn cancel_code_snapshot_upload(&self, upload_id: &str) -> Result<(), String> {
        self.code_snapshot_inbox.cancel_upload(upload_id)
    }

    /// The checkout a snapshot became on this host, if it did.
    pub fn code_checkout(&self, checkout_id: &str) -> Result<Option<crate::CodeCheckout>, String> {
        self.code_snapshot_inbox.checkout(checkout_id)
    }

    /// Turn a staged snapshot into a checkout on this host (ADR-0224 A11b).
    ///
    /// Idempotent per snapshot: applying one that already became a checkout
    /// answers with that checkout, so a caller that lost the first response
    /// can ask again. A git snapshot needs the project's repository: the
    /// base commit is supplied through the mirror (with the host's stored
    /// credential) into the project's source, a worktree is added on a new
    /// `cognia/handoff-…` branch, and the patch must rebuild the desktop's
    /// tree exactly or the checkout is refused.
    pub fn apply_code_snapshot(
        &self,
        input: &crate::ApplyCodeSnapshot,
    ) -> Result<crate::CodeCheckout, String> {
        if let Some(existing) = self.code_snapshot_inbox.checkout(&input.snapshot_id)? {
            return Ok(existing);
        }
        let staged = self
            .code_snapshot_inbox
            .staged(&input.snapshot_id, &input.manifest)?;
        let checkout = match input.manifest.kind {
            crate::CodeSnapshotKind::Tar => self.code_snapshot_inbox.apply_tar(input, &staged)?,
            crate::CodeSnapshotKind::GitPatch => self.apply_code_patch(input, &staged)?,
            crate::CodeSnapshotKind::GitBundle => return Err(
                "code_snapshot_invalid_manifest: a bundle is how work comes back, not a snapshot"
                    .into(),
            ),
        };
        self.code_snapshot_inbox.discard_staged(&input.snapshot_id);
        Ok(checkout)
    }

    fn apply_code_patch(
        &self,
        input: &crate::ApplyCodeSnapshot,
        staged: &Path,
    ) -> Result<crate::CodeCheckout, String> {
        let base = input
            .manifest
            .base_commit
            .as_deref()
            .ok_or("code_snapshot_invalid_manifest: a git snapshot names its base commit")?;
        let tree = input
            .manifest
            .tree
            .as_deref()
            .ok_or("code_snapshot_invalid_manifest: a git snapshot names its tree")?;
        let source = self.ensure_project_source(&crate::EnsureProjectSource {
            roots: input.roots.clone(),
            remote_url: input.remote_url.clone(),
            credential: input.credential.clone(),
        })?;
        let source_root = PathBuf::from(&source.root);
        if source.source == crate::ProjectSourceKind::Clone {
            crate::remote_source::prepare_source_commit(
                &self.mirrors_dir,
                &source_root,
                &crate::EnsureRemoteSource {
                    remote_url: source.remote_url.clone().unwrap_or_default(),
                    base: WorkspaceBaseSpec::RemoteDefault,
                    credential: input.credential.clone(),
                },
                base,
                input.manifest.base_ref.as_deref(),
            )?;
        }
        let dest = self.code_snapshot_inbox.checkout_dir(&input.snapshot_id)?;
        let branch = crate::handoff_branch(&input.snapshot_id);
        let reason = format!("cognia handoff {}", input.snapshot_id);
        {
            let lock = self
                .git_admin_lock(&source_root)
                .unwrap_or_else(|| Arc::new(Mutex::new(())));
            let _held = lock.lock();
            crate::code_snapshot::check_out_patch(
                &source_root,
                &dest,
                &branch,
                base,
                staged,
                tree,
                &reason,
            )?;
        }
        // A host that has the project's folder itself still knows where its
        // work goes back to: the repository the workspace records.
        let remote_url = source.remote_url.or_else(|| {
            input
                .remote_url
                .as_deref()
                .and_then(|url| crate::project_source::validate_project_remote(url.trim()).ok())
        });
        self.code_snapshot_inbox
            .record_patch_checkout(input, &dest, branch, remote_url)
    }

    /// Export the work a handed-over checkout holds (ADR-0224 A11c): pushed
    /// as `cognia/<agent>-…` when the repository takes it, else staged here
    /// as a bundle (or a tar for a folder without git) to be read out.
    pub fn export_code_checkout(
        &self,
        input: &crate::ExportCodeCheckout,
    ) -> Result<crate::CodeResult, String> {
        let checkout = self
            .code_snapshot_inbox
            .checkout(&input.checkout_id)?
            .ok_or_else(|| {
                format!(
                    "code_result_not_found: no checkout {} on this host",
                    input.checkout_id
                )
            })?;
        let root = PathBuf::from(&checkout.root);
        let lock = self
            .git_admin_lock(&root)
            .unwrap_or_else(|| Arc::new(Mutex::new(())));
        let _held = lock.lock();
        crate::code_result::export_checkout(
            &checkout,
            input,
            &self.code_result_outbox,
            self.code_snapshot_inbox.limits().max_bytes,
        )
    }

    pub fn read_code_result_chunk(
        &self,
        result_id: &str,
        offset: u64,
    ) -> Result<TransferChunk, String> {
        self.code_result_outbox.read_chunk(result_id, offset)
    }

    pub fn discard_code_result(&self, result_id: &str) -> Result<(), String> {
        self.code_result_outbox.discard(result_id)
    }

    pub fn open_code_result_receive(
        &self,
        size_bytes: u64,
        sha256: &str,
    ) -> Result<crate::CodeSnapshotUpload, String> {
        self.code_result_inbox.open_upload(size_bytes, sha256)
    }

    pub fn write_code_result_chunk(
        &self,
        upload_id: &str,
        offset: u64,
        data_base64: &str,
        chunk_hash: &str,
    ) -> Result<u64, String> {
        self.code_result_inbox
            .write_chunk(upload_id, offset, data_base64, chunk_hash)
    }

    pub fn commit_code_result_receive(
        &self,
        upload_id: &str,
    ) -> Result<crate::CommittedCodeSnapshot, String> {
        self.code_result_inbox.commit_upload(upload_id)
    }

    pub fn cancel_code_result_receive(&self, upload_id: &str) -> Result<(), String> {
        self.code_result_inbox.cancel_upload(upload_id)
    }

    /// Put work that came back into a new worktree (or folder) on this
    /// device, never into the folder the conversation started from.
    pub fn apply_code_result(
        &self,
        input: &crate::ApplyCodeResult,
    ) -> Result<crate::AppliedCodeResult, String> {
        let root = PathBuf::from(input.root.trim());
        let lock = self
            .git_admin_lock(&root)
            .unwrap_or_else(|| Arc::new(Mutex::new(())));
        let _held = lock.lock();
        crate::code_result::apply_result(input, &self.code_result_inbox)
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
        let mut record = self
            .registry
            .get(&lease.workspace_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("managed workspace is missing: {}", lease.workspace_id))?;
        let _scratch_lock = self.lock_scratch_record(&record)?;
        if _scratch_lock.is_some() {
            record = self
                .registry
                .get(&lease.workspace_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("managed workspace is missing: {}", lease.workspace_id))?;
        }
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
        let primary_record = self
            .registry
            .get(&primary_lease.workspace_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| {
                format!(
                    "managed workspace is missing: {}",
                    primary_lease.workspace_id
                )
            })?;
        let _scratch_lock = self.lock_scratch_record(&primary_record)?;
        let bundle_turn_id = request
            .run
            .turn_id
            .clone()
            .unwrap_or_else(|| Uuid::now_v7().to_string());
        validate_id("bundleTurnId", &bundle_turn_id)?;
        let existing_turn = self
            .store
            .lock()
            .get_workspace_bundle_turn(&bundle_turn_id)?;
        if let Some(existing) = existing_turn {
            let matches_runs = existing.runs.iter().all(|lease| {
                let suffix = &storage_key(&lease.workspace_id)[..12];
                lease.run.task_id == scoped_run_id(&request.run.task_id, suffix)
                    && lease.run.run_id == scoped_run_id(&request.run.run_id, suffix)
            });
            if existing.bundle_id == bundle_id
                && existing.primary_logical_root_id == request.primary_logical_root_id
                && matches_runs
            {
                for lease in &existing.runs {
                    self.ensure_workspace_port_lease(
                        &lease.workspace_id,
                        crate::HOST_LOOPBACK_NAMESPACE,
                    )
                    .map_err(|error| error.to_string())?;
                }
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
        let _cold_acquisition = self.lock_cold_workspace_acquisition(&root, false)?;
        let tracking_policy = resolve_tracking_policy(&root, &input.tracking_policy)?;
        if borrowed.is_some() {
            self.resolve_workspace_port_lease(crate::HOST_LOOPBACK_NAMESPACE, None, &root, true)
                .map_err(|error| error.to_string())?;
        }
        {
            let store = self.store.lock();
            crate::sandbox_snapshot::reject_snapshot_reservation(
                &store.connection, &root, &input.task_id,
            )?;
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
                if matches_request {
                    drop(store);
                    if let Some(id) = existing.workspace_id.as_deref() {
                        self.ensure_workspace_port_lease(id, crate::HOST_LOOPBACK_NAMESPACE)
                            .map_err(|error| error.to_string())?;
                    }
                }
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
        let _reused_acquisition = reusable.as_ref().map(|previous| {
            let execution_root = Path::new(&previous.execution_root);
            let guard = self.lock_cold_workspace_acquisition(execution_root, false)?;
            crate::sandbox_snapshot::reject_snapshot_reservation(
                &self.store.lock().connection, execution_root, &input.task_id,
            )?;
            Ok::<_, String>(guard)
        }).transpose()?;
        // Fence the generated root before its directory becomes visible. The
        // source root alone does not protect a snapshot of this new workspace.
        let _fresh_execution_acquisition = if reusable.is_none() && borrowed.is_none() {
            let execution_root = self.execution_dir
                .join(storage_key(&input.task_id)).join(storage_key(&input.run_id));
            Some(self.lock_cold_workspace_acquisition(&execution_root, false)?)
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
            // `git worktree add` mutates the repository's administrative state.
            // Two acquisitions for the same repository run in parallel on the
            // blocking pool, so without this they collide on `index.lock`.
            let admin = self.git_admin_lock(&root);
            let created = {
                let _admin = admin.as_ref().map(|lock| lock.lock());
                create_execution(
                    &root,
                    &execution_root,
                    &input.base,
                    &baseline,
                    &blobs,
                    record.locked_by.as_deref(),
                    // The single-root task path carries no repository declaration:
                    // it is reached by callers that never read one.
                    None,
                    // Pipeline runs never name their worktree.
                    None,
                    &tracking_policy,
                )
            };
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
                            None,
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
                        None,
                        now,
                    );
                }
                return Err(error);
            }
        }
        if let Some(workspace_id) = workspace_id.as_deref().filter(|_| {
            owns_execution
                && isolation_kind == IsolationKind::GitWorktree
                && base == WorkspaceBaseSpec::WorkingState
        }) {
            let persisted = crate::changeset::git_text(
                &execution_root,
                &["rev-parse", "--verify", "HEAD^{commit}"],
            )
            .map_err(|error| error.to_string())
            .and_then(|acquisition_commit| {
                store.put_workspace_capture_baseline(
                    workspace_id,
                    &baseline,
                    &tracking_policy,
                    Some(&acquisition_commit),
                )
            });
            if let Err(error) = persisted {
                drop(store);
                self.rollback_managed_execution(
                    Some(workspace_id),
                    &root,
                    &execution_root,
                    isolation_kind,
                    None,
                    now,
                );
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
                    None,
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
                    None,
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
                    None,
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

    /// Forget a branch the host deleted from the environment (a `select`
    /// promotion rolled back). Only the branch the row records may be cleared.
    pub fn forget_workspace_branch(
        &self,
        workspace_id: &str,
        branch: &str,
    ) -> Result<WorkspaceRecord, String> {
        self.validate_workspace_branch_target(workspace_id)?;
        self.registry
            .clear_branch_metadata(workspace_id, branch)
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
        for summary in &mut summaries {
            if summary.port_lease.is_none() {
                if let Ok(root) = crate::ports::registry_root(Path::new(&summary.path)) {
                    summary.port_lease = crate::ports::read_root(
                        &self.store.lock().connection,
                        crate::HOST_LOOPBACK_NAMESPACE,
                        &root,
                    )
                    .map_err(|error| error.to_string())?;
                }
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
        if row
            .lock_reason
            .as_deref()
            .and_then(crate::registry::parse_integration_lock_reason)
            .is_some()
        {
            return Err("host integration worktrees cannot be adopted".into());
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
            // A source repository that is no longer on disk is skipped, not
            // fatal. `open()` calls this with `?`, and a single row pointing at
            // a deleted clone (a scratch directory, an unmounted volume, a
            // worktree source someone moved) would otherwise refuse to start
            // the whole task-workspace service, taking every healthy workspace
            // with it. Nothing can be reconciled against a repository that is
            // not there, so there is no verdict to lose by skipping it.
            if !Path::new(&source_root).is_dir() {
                continue;
            }
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
        if read_git_worktree_inventory(&source_root)?
            .iter()
            .any(|row| {
                normalized_path_key(&row.path) == target_key
                    && row
                        .lock_reason
                        .as_deref()
                        .and_then(crate::registry::parse_integration_lock_reason)
                        .is_some()
            })
        {
            return Err(format!(
                "worktree {} is owned by the host integration queue; manual removal is not allowed",
                target.display()
            ));
        }
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
                // `Conflict` is swept too, which is what gives a conflicted row
                // any way back. The sweep is the only thing that can decide a
                // row is consistent again, and while it skipped this state a
                // row that reached it stayed there for good: the one
                // `Conflict → Active` transition in this service belongs to the
                // Bundle handoff retry, which a conversation refused with
                // `managed workspace is not active` never reaches.
                && matches!(
                    record.state,
                    WorkspaceState::Active | WorkspaceState::Provisioning | WorkspaceState::Conflict
                )
        }) {
            let path = normalized_path_key(Path::new(&record.execution_root));
            let verified = inventory_by_path.get(&path).is_some_and(|row| {
                row.lock_reason.as_deref() == record.locked_by.as_deref()
                    && record.git_common_dir == git_common_dir
            });
            // A row that says `gitWorktree` over a root that is not a linked
            // worktree checkout was mis-declared when it was provisioned, and
            // no amount of sweeping will find the worktree it is looking for.
            // The root on disk is already exactly what a shadow root is, so the
            // repair is the metadata alone. This is the residue of the bundle
            // path claiming Git isolation over a repository with no commit to
            // detach from.
            let mis_declared = !verified
                && !inventory_by_path.contains_key(&path)
                && Path::new(&record.execution_root).is_dir()
                && !is_linked_worktree_checkout(Path::new(&record.execution_root));
            if verified || mis_declared {
                if mis_declared
                    && matches!(
                        record.state,
                        WorkspaceState::Active | WorkspaceState::Conflict
                    )
                {
                    let _ = self
                        .registry
                        .reclassify_isolation(&record.workspace_id, IsolationKind::Shadow);
                }
                outcome.reclaimed.push(record.workspace_id.clone());
                if record.state == WorkspaceState::Conflict {
                    let _ = self.registry.transition(
                        &record.workspace_id,
                        record.owner_type,
                        record.owner_ref.as_deref(),
                        WorkspaceState::Active,
                        now_ms(),
                    );
                }
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
            if path_key == source_key
                || existing_paths.contains(&path_key)
                || row
                    .lock_reason
                    .as_deref()
                    .and_then(crate::registry::parse_integration_lock_reason)
                    .is_some()
            {
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
        let requested_name = input
            .requested_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(|name| validate_requested_worktree_name(name).map(|()| name.to_string()))
            .transpose()?;
        let inspected = input
            .roots
            .iter()
            .map(inspect_bundle_root)
            .collect::<Result<Vec<_>, _>>()?;
        if requested_name.is_some() && !inspected.iter().any(|root| root.git_common_dir.is_some()) {
            return Err(
                "a requested worktree name requires at least one Git root in the bundle".into(),
            );
        }
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
                let tracking_policy = crate::ResourceTrackingPolicy::default();
                let (mut baseline, blobs) = capture_with_policy(source_root, &tracking_policy)?;
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
                // Metadata failures must release the reservation and its port block too.
                let initialized = self
                    .registry
                    .set_environment_kind(&record.workspace_id, input.environment_kind)
                    .and_then(|record| {
                        self.registry
                            .set_project(&record.workspace_id, input.project_id.as_deref())?;
                        Ok(record)
                    });
                let record = match initialized {
                    Ok(record) => record,
                    Err(error) => {
                        self.discard_managed_workspace(&record, now);
                        return Err(error.to_string());
                    }
                };
                let admin = self.git_admin_lock(source_root);
                let created = {
                    let _admin = admin.as_ref().map(|lock| lock.lock());
                    create_execution(
                        source_root,
                        &execution_root,
                        &input.base,
                        &baseline,
                        &blobs,
                        record.locked_by.as_deref(),
                        input.provisioning.as_ref(),
                        requested_name.as_deref(),
                        &tracking_policy,
                    )
                };
                let (_isolation, requested_branch) = match created {
                    Ok(result) => result,
                    Err(error) => {
                        self.discard_managed_workspace(&record, now);
                        return Err(error);
                    }
                };
                if root.isolation == IsolationKind::GitWorktree
                    && input.base == WorkspaceBaseSpec::WorkingState
                {
                    let persisted = (|| {
                        let acquisition_commit = crate::changeset::git_text(
                            &execution_root,
                            &["rev-parse", "--verify", "HEAD^{commit}"],
                        )
                        .map_err(|error| error.to_string())?;
                        let mut store = self.store.lock();
                        for (hash, bytes) in &blobs {
                            store.put_blob(hash, bytes, now)?;
                        }
                        store.put_workspace_capture_baseline(
                            &record.workspace_id,
                            &baseline,
                            &tracking_policy,
                            Some(&acquisition_commit),
                        )
                    })();
                    if let Err(error) = persisted {
                        self.rollback_managed_execution(
                            Some(&record.workspace_id),
                            source_root,
                            &execution_root,
                            root.isolation,
                            requested_branch.as_deref(),
                            now,
                        );
                        return Err(error);
                    }
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
                            requested_branch.as_deref(),
                            now,
                        );
                        return Err(error.to_string());
                    }
                };
                if let Some(branch) = requested_branch.as_deref() {
                    if let Err(error) =
                        self.record_workspace_branch(&record.workspace_id, branch, None)
                    {
                        self.rollback_managed_execution(
                            Some(&record.workspace_id),
                            source_root,
                            &execution_root,
                            root.isolation,
                            Some(branch),
                            now,
                        );
                        return Err(error);
                    }
                }
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
                    created_branch: requested_branch,
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
        let persisted = self.store.lock().put_workspace_bundle(&bundle);
        if let Err(error) = persisted {
            let store = self.store.lock();
            let _ = store.delete_bundle_leases(&bundle.bundle_id);
            let _ = store.delete_workspace_bundle(&bundle.bundle_id);
            drop(store);
            self.rollback_acquired_bundle_roots(&acquired, now);
            return Err(error);
        }
        Ok(bundle)
    }

    /// Allocate only at an execution boundary. Existing blocks survive policy changes.
    pub fn ensure_workspace_port_lease(
        &self,
        workspace_id: &str,
        namespace: &str,
    ) -> Result<crate::WorkspacePortLease, crate::PortLeaseError> {
        let store = self.store.lock();
        let tx = rusqlite::Transaction::new_unchecked(
            &store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(crate::PortLeaseError::from)?;
        let record = store
            .get_workspace(workspace_id)
            .map_err(crate::PortLeaseError::Store)?
            .ok_or_else(|| crate::PortLeaseError::WorkspaceNotFound(workspace_id.into()))?;
        let existing = crate::ports::read_registry(&tx, namespace, &record)?;
        let root = match existing {
            Some(lease) => lease.canonical_root,
            None => crate::ports::registry_root(Path::new(&record.execution_root))?,
        };
        let policy = store
            .get_workspace_lifecycle_policy()
            .map_err(crate::PortLeaseError::Store)?
            .unwrap_or_default();
        let lease = crate::ports::ensure_in_transaction(
            &tx,
            namespace,
            crate::ports::LeaseSubject {
                kind: crate::PortSubjectKind::Registry,
                key: workspace_id,
                root: &root,
                registry_id: Some(workspace_id),
            },
            policy,
            now_ms(),
        )?;
        tx.commit().map_err(crate::PortLeaseError::from)?;
        Ok(lease)
    }

    pub fn read_workspace_port_lease(
        &self,
        workspace_id: &str,
        namespace: &str,
    ) -> Result<Option<crate::WorkspacePortLease>, crate::PortLeaseError> {
        let store = self.store.lock();
        let record = store
            .get_workspace(workspace_id)
            .map_err(crate::PortLeaseError::Store)?
            .ok_or_else(|| crate::PortLeaseError::WorkspaceNotFound(workspace_id.into()))?;
        crate::ports::read_registry(&store.connection, namespace, &record)
    }

    /// Register a desktop session or project checkout, sharing any physical-root block.
    pub fn ensure_subject_port_lease(
        &self,
        namespace: &str,
        kind: crate::PortSubjectKind,
        key: &str,
        root: &Path,
    ) -> Result<crate::WorkspacePortLease, crate::PortLeaseError> {
        if kind == crate::PortSubjectKind::Registry {
            return Err(crate::PortLeaseError::InvalidSubject(
                "registry subjects must use ensure_workspace_port_lease".into(),
            ));
        }
        let requested_root = root;
        let root = crate::ports::canonical_root(root)?;
        let store = self.store.lock();
        let policy = store
            .get_workspace_lifecycle_policy()
            .map_err(crate::PortLeaseError::Store)?
            .unwrap_or_default();
        let tx = rusqlite::Transaction::new_unchecked(
            &store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(crate::PortLeaseError::from)?;
        let lease = crate::ports::ensure_in_transaction(
            &tx,
            namespace,
            crate::ports::LeaseSubject {
                kind,
                key,
                root: &root,
                registry_id: None,
            },
            policy,
            now_ms(),
        )?;
        if kind == crate::PortSubjectKind::ProjectRoot {
            let alias = if requested_root.is_absolute() {
                requested_root
            } else {
                Path::new(&root)
            };
            crate::ports::record_project_root_alias(&tx, &lease, alias)?;
        }
        tx.commit().map_err(crate::PortLeaseError::from)?;
        Ok(lease)
    }

    /// A project may reference several physical roots. Reading never registers a subject.
    pub fn read_subject_port_leases(
        &self,
        namespace: &str,
        kind: crate::PortSubjectKind,
        key: &str,
    ) -> Result<Vec<crate::WorkspacePortLease>, crate::PortLeaseError> {
        crate::ports::read_subject(&self.store.lock().connection, namespace, kind, key)
    }

    pub fn release_subject_port_leases(
        &self,
        namespace: &str,
        kind: crate::PortSubjectKind,
        key: &str,
    ) -> Result<(), crate::PortLeaseError> {
        self.release_subject_port_lease_reference(namespace, kind, key, None)
    }

    /// Release one recorded root reference, or all roots when no lease is selected.
    /// Matching is ledger-based so an offline or trashed directory can be released.
    pub fn release_subject_port_lease_reference(
        &self,
        namespace: &str,
        kind: crate::PortSubjectKind,
        key: &str,
        lease_id: Option<&str>,
    ) -> Result<(), crate::PortLeaseError> {
        if kind == crate::PortSubjectKind::Registry {
            return Err(crate::PortLeaseError::InvalidSubject(
                "registry subjects must use release_archived_workspace_port_lease".into(),
            ));
        }
        let store = self.store.lock();
        let tx = rusqlite::Transaction::new_unchecked(
            &store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(crate::PortLeaseError::from)?;
        if let Some(root) = key
            .strip_prefix("root:")
            .filter(|_| kind == crate::PortSubjectKind::ProjectRoot)
        {
            crate::ports::release_project_root_reference_in_transaction(
                &tx,
                namespace,
                Path::new(root),
                lease_id,
            )?;
        } else {
            crate::ports::release_subject_reference_in_transaction(
                &tx,
                Some(namespace),
                kind,
                key,
                lease_id,
            )?;
        }
        tx.commit().map_err(crate::PortLeaseError::from)
    }

    /// Explicit release requires an archived, idle workspace. Host occupancy is
    /// report-only elsewhere; here it refuses release without touching the process.
    pub fn release_archived_workspace_port_lease(
        &self,
        workspace_id: &str,
        namespace: &str,
    ) -> Result<(), crate::PortLeaseError> {
        let store = self.store.lock();
        let tx = rusqlite::Transaction::new_unchecked(
            &store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(crate::PortLeaseError::from)?;
        let record = store
            .get_workspace(workspace_id)
            .map_err(crate::PortLeaseError::Store)?
            .ok_or_else(|| crate::PortLeaseError::WorkspaceNotFound(workspace_id.into()))?;
        if !matches!(
            record.state,
            WorkspaceState::Archived | WorkspaceState::Restorable
        ) {
            return Err(crate::PortLeaseError::WorkspaceBusy {
                workspace_id: workspace_id.into(),
                state: record.state,
            });
        }
        if let Some(lease) = crate::ports::read_registry(&tx, namespace, &record)? {
            crate::ports::require_idle(&lease)?;
        }
        crate::ports::release_subject_in_transaction(
            &tx,
            Some(namespace),
            crate::PortSubjectKind::Registry,
            workspace_id,
        )?;
        tx.commit().map_err(crate::PortLeaseError::from)
    }

    /// Explicit registry identity wins. Cwd fallback uses path components, never
    /// source_root (several isolated worktrees can share the same source).
    pub fn resolve_workspace_port_lease(
        &self,
        namespace: &str,
        workspace_id: Option<&str>,
        cwd: &Path,
        ensure: bool,
    ) -> Result<Option<crate::WorkspacePortLease>, crate::PortLeaseError> {
        self.resolve_workspace_port_lease_with_home(
            namespace,
            workspace_id,
            cwd,
            ensure,
            std::env::home_dir,
        )
    }

    fn resolve_workspace_port_lease_with_home(
        &self,
        namespace: &str,
        workspace_id: Option<&str>,
        cwd: &Path,
        ensure: bool,
        home: impl FnOnce() -> Option<PathBuf>,
    ) -> Result<Option<crate::WorkspacePortLease>, crate::PortLeaseError> {
        if let Some(id) = workspace_id {
            return if ensure {
                self.ensure_workspace_port_lease(id, namespace).map(Some)
            } else {
                self.read_workspace_port_lease(id, namespace)
            };
        }
        let requested_cwd = cwd;
        let cwd = PathBuf::from(crate::ports::canonical_root(cwd)?);
        let store = self.store.lock();
        let records = store
            .list_workspaces()
            .map_err(crate::PortLeaseError::Store)?;
        if let Some(record) = crate::ports::resolve_registry(&records, &cwd) {
            let id = record.workspace_id.clone();
            drop(store);
            return if ensure {
                self.ensure_workspace_port_lease(&id, namespace).map(Some)
            } else {
                self.read_workspace_port_lease(&id, namespace)
            };
        }
        let external = crate::ports::resolve_external(
            &crate::ports::external_leases(&store.connection, namespace)?,
            namespace,
            &cwd,
        );
        drop(store);
        // Registered identities are authoritative. Discovery only supplies a
        // missing execution identity; read-only resolution never discovers one.
        if external.is_some() {
            self.port_discovery_diagnostics.lock().remove(&cwd);
            return Ok(external);
        }
        if !ensure {
            return Ok(None);
        }
        let root = match discover_port_checkout_root(&cwd, home()) {
            Ok(root) => {
                self.port_discovery_diagnostics.lock().remove(&cwd);
                let Some(root) = root else { return Ok(None) };
                root
            }
            Err(diagnostic) => {
                self.port_discovery_diagnostics
                    .lock()
                    .insert(cwd, diagnostic);
                return Ok(None);
            }
        };
        // The helper uses explicit ceilings and empty open flags: it neither
        // reads Git discovery environment variables nor crosses filesystems.
        // Preserve only an alias of the actual checkout root, never a subdir.
        let mut requested_root = requested_cwd.to_path_buf();
        for _ in cwd
            .strip_prefix(&root)
            .expect("discovered root contains cwd")
            .components()
        {
            requested_root.pop();
        }
        if fs::canonicalize(&requested_root).ok().as_deref() != Some(Path::new(&root)) {
            requested_root = PathBuf::from(&root);
        }
        self.ensure_subject_port_lease(
            namespace,
            crate::PortSubjectKind::ProjectRoot,
            &format!("root:{root}"),
            &requested_root,
        )
        .map(Some)
    }

    /// Report the current ledger and diagnostics without repairing or allocating.
    pub fn list_workspace_port_leases(
        &self,
    ) -> Result<crate::WorkspacePortLeaseList, crate::PortLeaseError> {
        let mut snapshot = crate::ports::list_status(&self.store.lock())?;
        snapshot
            .diagnostics
            .extend(self.port_discovery_diagnostics.lock().values().cloned());
        Ok(snapshot)
    }

    pub fn reconcile_workspace_port_leases(
        &self,
    ) -> Result<Vec<crate::PortLeaseDiagnostic>, crate::PortLeaseError> {
        let mut diagnostics = crate::ports::reconcile(&self.store.lock())?;
        diagnostics.extend(self.port_discovery_diagnostics.lock().values().cloned());
        Ok(diagnostics)
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
        if policy.sandbox_snapshot_budget_bytes == 0 {
            return Err("sandbox snapshot budget must be greater than zero".into());
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
        let recovery_failures = std::mem::take(&mut *self.open_recovery_failures.lock())
            .into_iter()
            .chain(
                self.recover_integrations()
                    .map_err(|error| error.to_string())?
                    .into_iter()
                    .map(|(id, error)| format!("integration {id} not recovered: {error}")),
            )
            .collect::<Vec<_>>();
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
        events.extend(recovery_failures.into_iter().map(|detail| {
            crate::WorkspaceMaintenanceEvent {
                event_id: Uuid::now_v7().to_string(),
                kind: crate::WorkspaceMaintenanceEventKind::Failed,
                workspace_id: None,
                occurred_at: started_at,
                detail,
            }
        }));
        let policy = self.registry.policy();
        events.extend(self.maintain_integrations(started_at, policy));
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

    pub(crate) fn enforce_managed_workspace_capacity(&self, requested: u32) -> Result<(), String> {
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
                root.created_branch.as_deref(),
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
        let _scratch_lock = self.lock_scratch_record(&record)?;
        let _cold_acquisition = self.lock_cold_workspace_acquisition(Path::new(&record.execution_root), true)?;
        let locked_root = record.execution_root.clone();
        record = self.registry.get(workspace_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("workspace {workspace_id} not found"))?;
        if record.execution_root != locked_root {
            return Err("snapshot_busy: workspace root changed during acquisition".into());
        }
        crate::sandbox_snapshot::reject_snapshot_reservation(
            &self.store.lock().connection, Path::new(&record.execution_root),
            record.snapshot_task_id.as_deref().unwrap_or(workspace_id),
        )?;
        if _scratch_lock.is_some() {
            record = self
                .registry
                .get(workspace_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("workspace {workspace_id} not found"))?;
            let store = self.store.lock();
            let active_turn = store.list_workspace_bundle_turns()?.iter().any(|turn| {
                matches!(turn.state, RunState::Running | RunState::Settling)
                    && turn
                        .runs
                        .iter()
                        .any(|lease| lease.workspace_id == workspace_id)
            });
            let mut active_run = false;
            for task in store
                .list_tasks()?
                .iter()
                .filter(|task| Some(task.session_id.as_str()) == record.owner_ref.as_deref())
            {
                active_run |= store.list_runs(&task.task_id)?.iter().any(|run| {
                    matches!(run.state, RunState::Running | RunState::Settling)
                        && normalized_path_key(Path::new(&run.execution_root))
                            == normalized_path_key(Path::new(&record.execution_root))
                });
            }
            if active_turn || active_run {
                return Err("cannot archive a scratch workspace while a turn is active; retry after it settles".into());
            }
            validate_scratch_path(Path::new(&record.execution_root))?;
        }
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
            let policy = crate::ResourceTrackingPolicy {
                // Snapshot forks own their Git database inside the execution
                // root. It must survive archive, along with ignored outputs.
                self_contained: _scratch_lock.is_some()
                    || record.source_root == record.execution_root,
                ..Default::default()
            };
            let (snapshot, blobs) = capture_with_policy(execution_root, &policy)?;
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
                if policy.self_contained {
                    // Verify persisted bytes before deleting the only working copy.
                    let archived = store
                        .get_workspace_archive(workspace_id)?
                        .ok_or_else(|| "scratch archive was not persisted".to_string())?;
                    if archived != snapshot {
                        return Err("scratch archive snapshot verification failed".into());
                    }
                    for entry in archived.entries.values() {
                        let bytes = store.get_blob(&entry.hash, now)?;
                        if blobs.get(&entry.hash) != Some(&bytes) {
                            return Err(format!(
                                "scratch archive blob verification failed: {}",
                                entry.path
                            ));
                        }
                    }
                }
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
        let _cold_acquisition = self.lock_cold_workspace_acquisition(Path::new(&record.execution_root), true)?;
        let locked_root = record.execution_root.clone();
        record = self.registry.get(workspace_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("workspace {workspace_id} not found"))?;
        if record.execution_root != locked_root {
            return Err("snapshot_busy: workspace root changed during acquisition".into());
        }
        crate::sandbox_snapshot::reject_snapshot_reservation(
            &self.store.lock().connection, Path::new(&record.execution_root), workspace_id,
        )?;
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
        let blobs = {
            let mut store = self.store.lock();
            hydrate_snapshot_blobs(&mut store, &snapshot, Path::new(&record.source_root), now)?
        };
        self.ensure_workspace_port_lease(workspace_id, crate::HOST_LOOPBACK_NAMESPACE)
            .map_err(|error| error.to_string())?;
        let admin = self.git_admin_lock(Path::new(&record.source_root));
        let created = {
            let _admin = admin.as_ref().map(|lock| lock.lock());
            create_execution(
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
                // Restore reproduces the recorded state; the name request only
                // applies at first provisioning.
                None,
                &crate::ResourceTrackingPolicy::default(),
            )
        };
        created?;
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
        let _cold_acquisition = self.lock_cold_workspace_acquisition(Path::new(&record.execution_root), true)?;
        let locked_root = record.execution_root.clone();
        let record = self.registry.get(workspace_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("workspace {workspace_id} not found"))?;
        if record.execution_root != locked_root {
            return Err("snapshot_busy: workspace root changed during acquisition".into());
        }
        crate::sandbox_snapshot::reject_snapshot_reservation(
            &self.store.lock().connection, Path::new(&record.execution_root), workspace_id,
        )?;
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
        self.ensure_workspace_port_lease(workspace_id, crate::HOST_LOOPBACK_NAMESPACE)
            .map_err(|error| error.to_string())?;
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

    /// Mutex guarding Git's administrative state for the repository containing
    /// `workspace_root`.
    ///
    /// Returns an owned handle rather than a guard so the caller decides the
    /// hold: the registry lock must never be held across it, or two threads
    /// taking the pair in opposite orders would deadlock.
    pub(crate) fn git_admin_lock(&self, workspace_root: &Path) -> Option<Arc<Mutex<()>>> {
        let key = git_common_dir(workspace_root)?;
        let mut locks = self.git_admin_locks.lock();
        Some(Arc::clone(
            locks.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))),
        ))
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

    /// `created_branch` is the branch the worktree was created with, when the
    /// caller named one — a `-b` worktree leaves the branch behind on removal,
    /// and leaking it refuses the retry as a name collision.
    fn rollback_managed_execution(
        &self,
        workspace_id: Option<&str>,
        workspace_root: &Path,
        execution_root: &Path,
        isolation_kind: IsolationKind,
        created_branch: Option<&str>,
        now: i64,
    ) {
        unlock_git_worktree(workspace_root, execution_root, isolation_kind);
        cleanup_execution(
            workspace_root,
            execution_root,
            isolation_kind,
            created_branch,
        );
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
        let execution_root_path = PathBuf::from(&run.execution_root);
        let mut context = ReconcileContext {
            store: &mut store,
            revision: task.revision,
            run_id: &run.run_id,
            agent_id: &run.agent_id,
            origin_hints: &origin_hints,
            now,
            git_root: Some(execution_root_path.as_path()),
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
        let source_changes = changes
            .iter()
            .filter(|change| change.capture_class == ResourceCaptureClass::Source)
            .cloned()
            .collect::<Vec<_>>();
        persist_patch_blobs(&mut store, &source_changes, &execution_root_path, now)?;
        run.state = RunState::Ready;
        run.settled_at = Some(now);
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
            &source_changes,
            &mut store,
            &scratch,
            now,
        )?;
        store.put_patch_set(&patch)?;
        if let Err(error) = crate::provenance::capture::record_pending(
            &mut store,
            &patch,
            Path::new(&task.workspace_root),
            now,
        ) {
            crate::provenance::capture::warn_gap(
                &mut store,
                &format!("pending:{}:{}", patch.run_id, patch.created_at),
                &error,
            );
        }
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
        self.record_tool_event_with_receipt(run_id, path, old_path, kind, tool_call_id, None)
    }

    /// Tool evidence remains a causal hint unless a trusted host supplies the
    /// actual before/after hashes. Model-authored event arguments alone cannot
    /// establish a precise line-to-tool link.
    pub fn record_tool_event_with_receipt(
        &self,
        run_id: &str,
        path: &str,
        old_path: Option<&str>,
        kind: ResourceEventKind,
        tool_call_id: Option<&str>,
        receipt: Option<&crate::provenance::ToolMutationReceipt>,
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
        if let Some(receipt) = receipt {
            if receipt.run_id != run_id
                || receipt.path != path
                || Some(receipt.tool_call_id.as_str()) != tool_call_id
            {
                return Err("tool mutation receipt does not match its resource event".into());
            }
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
        if let Some(receipt) = receipt {
            if let Err(error) = self.record_tool_mutation_receipt(
                run_id,
                &receipt.tool_call_id,
                receipt.ordinal,
                path,
                receipt.before_hash.as_deref(),
                receipt.after_hash.as_deref(),
            ) {
                // Receipt storage is an optional provenance channel. Keep the
                // existing event observable even if this channel is unavailable.
                eprintln!("provenance tool receipt capture failed: {error}");
            }
        }
        Ok(events.remove(0))
    }

    /// Trusted host receipt channel. Hashes describe bytes observed around the
    /// tool mutation, with `None` representing an absent path (create/delete).
    pub fn record_tool_mutation_receipt(
        &self,
        run_id: &str,
        tool_call_id: &str,
        ordinal: u64,
        path: &str,
        before_hash: Option<&str>,
        after_hash: Option<&str>,
    ) -> Result<(), String> {
        validate_event_relative_path(path)?;
        let mut store = self.store.lock();
        store
            .get_run::<WorkspaceSnapshot>(run_id)?
            .ok_or_else(|| format!("unknown task run: {run_id}"))?;
        store
            .provenance()
            .record_tool_mutation_receipt(
                run_id,
                tool_call_id,
                ordinal,
                path,
                before_hash,
                after_hash,
            )
            .map_err(|error| error.to_string())
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
                let mut reserved = false;
                for root in std::iter::once(task.workspace_root.as_str())
                    .chain(runs.iter().map(|run| run.execution_root.as_str()))
                {
                    match crate::sandbox_snapshot::reject_snapshot_reservation(
                        &store.connection, Path::new(root), &task.task_id,
                    ) {
                        Ok(()) => {}
                        Err(error) if error.starts_with("snapshot_busy") => {
                            reserved = true;
                            break;
                        }
                        Err(error) => return Err(error),
                    }
                }
                if reserved {
                    continue;
                }
                candidates.push((task, runs));
            }
            candidates
        };
        let mut removed_task_ids = Vec::new();
        let mut removed_workspace_ids = std::collections::HashSet::new();
        for (task, runs) in candidates {
            let mut roots = std::iter::once(task.workspace_root.clone())
                .chain(runs.iter().map(|run| run.execution_root.clone()))
                .map(|root| crate::sandbox_snapshot::canonical_lock_root(Path::new(&root)))
                .collect::<Result<Vec<_>, _>>()?;
            roots.sort();
            roots.dedup();
            let mut acquisitions = Vec::new();
            let mut busy = false;
            for root in &roots {
                match self.lock_cold_workspace_acquisition(Path::new(root), true) {
                    Ok(guard) => acquisitions.push(guard),
                    Err(error) if error.starts_with("snapshot_busy") => { busy = true; break; }
                    Err(error) => return Err(error),
                }
            }
            if busy { continue; }
            {
                let store = self.store.lock();
                if !store.task_is_prunable(&task.task_id)? { continue; }
                for root in &roots {
                    match crate::sandbox_snapshot::reject_snapshot_reservation(&store.connection, Path::new(root), &task.task_id) {
                        Ok(()) => {},
                        Err(error) if error.starts_with("snapshot_busy") => { busy = true; break; },
                        Err(error) => return Err(error),
                    }
                }
            }
            if busy { continue; }
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

    /// The files agents left in each conversation's workspace, newest change
    /// first (ADR-0223 §8). Folded once per change to the database: the rows
    /// are read under the same lock as the fingerprint, so a fold is never
    /// older than the fingerprint it is kept under, and a write after it moves
    /// the fingerprint and refolds.
    pub fn list_resource_index(&self) -> Result<Arc<Vec<crate::ResourceIndexEntry>>, String> {
        let (fingerprint, rows) = {
            let store = self.store.lock();
            let fingerprint = store.change_fingerprint()?;
            if let Some(fold) = self.resource_index.lock().as_ref() {
                if fold.fingerprint == fingerprint {
                    return Ok(Arc::clone(&fold.entries));
                }
            }
            (fingerprint, store.list_resource_index_rows()?)
        };
        let entries = Arc::new(crate::resource_index::fold_resource_index(rows));
        *self.resource_index.lock() = Some(ResourceIndexFold {
            fingerprint,
            entries: Arc::clone(&entries),
        });
        Ok(entries)
    }

    /// A slice of the bytes `run_id` left at `path`, from the ledger's
    /// capture (ADR-0223 §8). Only for a file the run created, modified or
    /// renamed to and whose content the ledger captured; never for a
    /// credential-shaped path, which the ledger keeps out of every listing.
    /// The run and path, not a blob hash, name the bytes, so a caller reads
    /// only what the ledger recorded for that change.
    pub fn read_resource_capture(
        &self,
        run_id: &str,
        path: &str,
        offset: u64,
        length: u64,
    ) -> Result<crate::ResourceCaptureChunk, String> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        if is_sensitive_resource(path) {
            return Err(format!(
                "sensitive resource is not served from the ledger: {path}"
            ));
        }
        let mut store = self.store.lock();
        let change = store
            .get_run_resource(run_id, path)?
            .ok_or_else(|| format!("no captured change at {path} in run {run_id}"))?;
        if change.kind == ChangeKind::Deleted
            || change.sensitive
            || change.resource_kind != ResourceKind::File
            || change.capture_class != ResourceCaptureClass::Source
            || !change.content_captured
        {
            return Err(format!(
                "the ledger holds no content for {path} in run {run_id}"
            ));
        }
        let hash = change
            .hash
            .ok_or_else(|| format!("the ledger holds no content for {path} in run {run_id}"))?;
        let take = length.min(crate::RESOURCE_CAPTURE_CHUNK_MAX_BYTES);
        let slice = store.read_blob_range(&hash, offset, take, now_ms())?;
        let bytes_read = slice.bytes.len() as u64;
        Ok(crate::ResourceCaptureChunk {
            data_base64: STANDARD.encode(&slice.bytes),
            offset,
            bytes_read,
            size: slice.size,
            eof: offset.saturating_add(bytes_read) >= slice.size,
        })
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
            let blobs = hydrate_snapshot_blobs(
                &mut store,
                &snapshot,
                Path::new(&run.execution_root),
                now_ms(),
            )?;
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
                let outcome = ledger::keep_current(&mut patch, next_revision)?;
                if let Err(error) = crate::provenance::capture::discard(
                    &mut store,
                    &patch,
                    Path::new(&task.workspace_root),
                    next_revision,
                    now,
                ) {
                    crate::provenance::capture::warn_gap(
                        &mut store,
                        &format!("discard:{}:{}:{next_revision}", patch.run_id, patch.created_at),
                        &error,
                    );
                }
                outcome
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
pub(crate) fn apply_provisioning(
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
        copy_file_cow(source, target)
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

/// Copy one file into the worktree, preferring a copy-on-write clone.
///
/// `include` names the gitignored files a build wants. Most are a `.env` and
/// cost nothing either way, but the field also carries fixture corpora,
/// downloaded model weights and seeded databases — and a worktree is created
/// per task, so a byte-for-byte copy of those is paid every time. On APFS and
/// on btrfs/XFS a clone is a metadata operation: the extents are shared until
/// one side writes them, so the worktree costs only what it actually changes.
///
/// Every failure falls back to a real copy, and deliberately without reporting
/// a reason. The reasons are ordinary — the source and the worktree are on
/// different filesystems, the filesystem has no reflinks, the kernel does not
/// implement the ioctl, the target already exists — and none of them mean the
/// include should be skipped. Only the fallback's own failure is an error,
/// which is exactly the error this function had before.
fn copy_file_cow(source: &Path, target: &Path) -> Result<(), String> {
    if clone_file(source, target).is_ok() {
        return Ok(());
    }
    fs::copy(source, target)
        .map(|_| ())
        .map_err(|error| format!("copy {}: {error}", source.display()))
}

/// `copyfile(3)` with `COPYFILE_CLONE`.
///
/// Not `clonefile(2)`: its man page strongly discourages calling it on a
/// directory, and `copy_included` walks directories itself so it only ever
/// reaches here with a regular file. `COPYFILE_CLONE` implies `COPYFILE_EXCL`,
/// so an existing target is removed first — the caller's contract has always
/// been "overwrite", and leaving the old file in place would ship stale
/// content into the worktree.
#[cfg(target_os = "macos")]
fn clone_file(source: &Path, target: &Path) -> Result<(), ()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let from = CString::new(source.as_os_str().as_bytes()).map_err(|_| ())?;
    let to = CString::new(target.as_os_str().as_bytes()).map_err(|_| ())?;
    if fs::symlink_metadata(target).is_ok() {
        fs::remove_file(target).map_err(|_| ())?;
    }
    // SAFETY: both paths are NUL-terminated and outlive the call; the state
    // argument is optional and null means "no callbacks, no progress".
    let status = unsafe {
        libc::copyfile(
            from.as_ptr(),
            to.as_ptr(),
            std::ptr::null_mut(),
            libc::COPYFILE_CLONE,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(())
    }
}

/// The `FICLONE` ioctl — btrfs, XFS with reflink=1, and bcachefs.
///
/// The destination must be a freshly truncated file, which `File::create`
/// guarantees, and both must live on the same filesystem. Anything else
/// returns `EXDEV`/`EOPNOTSUPP` and the caller copies instead.
#[cfg(target_os = "linux")]
fn clone_file(source: &Path, target: &Path) -> Result<(), ()> {
    use std::os::unix::io::AsRawFd;

    let from = fs::File::open(source).map_err(|_| ())?;
    let to = fs::File::create(target).map_err(|_| ())?;
    // SAFETY: both descriptors are owned and open for the duration of the call.
    let status = unsafe { libc::ioctl(to.as_raw_fd(), libc::FICLONE, from.as_raw_fd()) };
    if status == 0 {
        Ok(())
    } else {
        // `File::create` already truncated the target, so the copy fallback
        // rewrites it in full rather than appending to a half-cloned file.
        Err(())
    }
}

/// Every other target: no reflink API worth reaching for, so always copy.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn clone_file(_source: &Path, _target: &Path) -> Result<(), ()> {
    Err(())
}

/// The name a caller asked the new worktree's branch to take. Mirrors the
/// ruleset `cognia-git`'s `validate_branch_name` enforces — kept in step
/// because both guard the same thing: a value interpolated into `git` argv
/// must never parse as a flag, and a name Git would refuse should fail here
/// with a clear message rather than mid-provisioning as a worktree-add error.
fn validate_requested_worktree_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("requested worktree name is empty".into());
    }
    if name.starts_with('-') {
        return Err(format!("worktree name may not start with '-': {name}"));
    }
    if name.chars().any(char::is_control)
        || name.contains("..")
        || name.contains(' ')
        || name.contains('~')
        || name.contains('^')
        || name.contains(':')
        || name.contains('?')
        || name.contains('*')
        || name.contains('[')
        || name.contains('\\')
        || name.ends_with('/')
        || name.ends_with(".lock")
    {
        return Err(format!("not a valid worktree name: {name}"));
    }
    Ok(())
}

#[allow(
    clippy::too_many_arguments,
    reason = "execution materialization requires each isolation input to remain explicit"
)]
fn create_execution(
    workspace_root: &Path,
    execution_root: &Path,
    base: &WorkspaceBaseSpec,
    baseline: &WorkspaceSnapshot,
    blobs: &HashMap<String, Vec<u8>>,
    lock_reason: Option<&str>,
    provisioning: Option<&WorkspaceProvisioning>,
    requested_name: Option<&str>,
    policy: &crate::ResourceTrackingPolicy,
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
        // A caller-named worktree takes `-b <name>` instead of `--detach`: the
        // branch IS the user-facing name they asked for, so the ADR-0111
        // stale-branch objection does not apply — the branch was the request,
        // not a per-dispatch artifact.
        let mut args: Vec<String> = vec!["worktree".into(), "add".into()];
        match requested_name {
            Some(name) => args.extend(["-b".into(), name.into()]),
            None => args.push("--detach".into()),
        }
        args.extend(["--lock".into(), "--reason".into(), lock_reason.into()]);
        args.push(execution_root.to_string_lossy().into_owned());
        args.push(base_ref.clone());
        let output = Command::new("git")
            .args(["-C"])
            .arg(workspace_root)
            .args(&args)
            .output()
            .map_err(|error| format!("start git worktree add: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "git worktree add failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        if *base == WorkspaceBaseSpec::WorkingState {
            // A Git-backed baseline is the checkout Git has just written plus a
            // small overlay, so the tree only needs the difference applied.
            // Emptying it first and rewriting every file from a blob — what a
            // blob-backed baseline still requires below — would throw away the
            // checkout that was just paid for and read the whole tree back out
            // of Git to reproduce it.
            let result =
                match crate::snapshot::apply_git_overlay(execution_root, baseline, blobs, policy) {
                    Ok(true) => Ok(()),
                    Ok(false) => clear_worktree_contents(execution_root)
                        .and_then(|_| materialize(execution_root, baseline, blobs)),
                    Err(error) => Err(error),
                };
            if let Err(error) = result {
                unlock_git_worktree(workspace_root, execution_root, IsolationKind::GitWorktree);
                cleanup_git_worktree(workspace_root, execution_root, requested_name.unwrap_or(""));
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
                cleanup_git_worktree(workspace_root, execution_root, requested_name.unwrap_or(""));
                return Err(error);
            }
        }
        // The baseline now depends on this commit staying reachable.
        crate::snapshot::pin_snapshot_base(workspace_root, execution_root, baseline);
        return Ok((
            IsolationKind::GitWorktree,
            requested_name.map(str::to_string),
        ));
    }
    if *base != WorkspaceBaseSpec::WorkingState {
        return Err("non-Git workspaces only support the workingState base".into());
    }
    materialize(execution_root, baseline, blobs)?;
    Ok((IsolationKind::Shadow, None))
}

/// How long a `git fetch origin` is treated as still fresh.
///
/// A `remoteDefault` base refetched on every acquisition, which on a fan-out —
/// a team run opening several workspaces at once, a bundle with several roots —
/// meant one network round trip per root to learn a default branch name that
/// changes approximately never. Short enough that a task still starts from what
/// the remote said moments ago, long enough that a burst pays for one fetch.
const REMOTE_FETCH_TTL: Duration = Duration::from_secs(30);

/// Last successful `git fetch origin` per repository, keyed by common directory.
static LAST_REMOTE_FETCH: std::sync::OnceLock<Mutex<HashMap<String, std::time::Instant>>> =
    std::sync::OnceLock::new();

/// Fetch `origin` unless this repository was fetched within [`REMOTE_FETCH_TTL`].
///
/// Keyed by common directory so the worktrees cut from one repository share the
/// window — they share the remote-tracking refs a fetch updates.
fn fetch_origin_throttled(workspace_root: &Path) -> Result<(), String> {
    let key = git_common_dir(workspace_root)
        .unwrap_or_else(|| workspace_root.to_string_lossy().into_owned());
    {
        let seen = LAST_REMOTE_FETCH
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock();
        if let Some(at) = seen.get(&key) {
            if at.elapsed() < REMOTE_FETCH_TTL {
                return Ok(());
            }
        }
    }
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
    LAST_REMOTE_FETCH
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .insert(key, std::time::Instant::now());
    Ok(())
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
            fetch_origin_throttled(workspace_root)?;
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

/// Can this root back a `git worktree add`?
///
/// Discovery and a workdir match are not enough. A repository whose HEAD is
/// unborn has no commit to detach from, and `git worktree add --detach <path>
/// HEAD` fails with `fatal: invalid reference: HEAD`. That is not a rare state:
/// it is exactly what `ensure-default-workspace.ts` produces on a fresh
/// install, which `git init`s the workspace it just created and never commits
/// to it. The first chat turn then asked for a managed worktree over an empty
/// repository and the whole turn was refused.
///
/// Answering `false` there routes the same directory to the Shadow backend,
/// which is what it would have received had `git init` never run, and it
/// upgrades itself: the moment the repository has a commit this answers `true`
/// again and later runs get real worktrees.
fn is_git_root(workspace_root: &Path) -> bool {
    let Ok(repository) = git2::Repository::discover(workspace_root) else {
        return false;
    };
    let workdir_matches = repository
        .workdir()
        .and_then(|path| path.canonicalize().ok())
        .is_some_and(|path| path == workspace_root);
    workdir_matches && repository_is_worktree_capable(&repository)
}

/// Has this repository a commit to detach a worktree from?
///
/// Extracted so the single-root and the bundle paths share one answer. They
/// used to decide separately, and only one of them was ever taught that an
/// unborn HEAD cannot back `git worktree add --detach <path> HEAD`.
fn repository_is_worktree_capable(repository: &git2::Repository) -> bool {
    repository.head().is_ok()
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
    crate::snapshot::unpin_snapshot_base(workspace_root, execution_root);
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
            crate::snapshot::unpin_snapshot_base(Path::new(&record.source_root), execution_root);
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

pub(crate) struct GitWorktreeInventoryRow {
    pub(crate) path: PathBuf,
    pub(crate) branch: Option<String>,
    pub(crate) head: Option<String>,
    pub(crate) lock_reason: Option<String>,
    prunable: bool,
    prune_reason: Option<String>,
}

pub(crate) fn read_git_worktree_inventory(
    source_root: &Path,
) -> Result<Vec<GitWorktreeInventoryRow>, String> {
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
        port_lease: record.and_then(|record| record.port_lease.clone()),
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
        // Both come from the Registry row, so a worktree Git knows about but
        // the Registry does not stays `None` rather than reporting a zero that
        // would read as "empty".
        size_bytes: record.and_then(|record| record.size_bytes),
        last_used_at: record.map(|record| record.last_used_at),
        allowed_actions,
    }
}

fn environment_summary_from_record(record: &WorkspaceRecord) -> crate::WorkspaceEnvironmentSummary {
    let ownership = environment_ownership(record);
    crate::WorkspaceEnvironmentSummary {
        port_lease: record.port_lease.clone(),
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
        size_bytes: record.size_bytes,
        last_used_at: Some(record.last_used_at),
        allowed_actions: environment_actions(
            ownership,
            Some(record.state),
            record.pinned,
            record.isolation_kind == IsolationKind::GitWorktree,
        ),
    }
}

/// Is this directory a checkout that `git worktree` created?
///
/// A linked worktree carries a `.git` FILE whose `gitdir:` line points into the
/// repository's `worktrees/` administrative directory. A shadow copy carries no
/// `.git` at all, and a standalone clone carries a `.git` directory. Only the
/// first is something `git worktree list` could ever have listed, which is what
/// separates a worktree that was removed from a row that never had one.
///
/// Answers `false` on any read error. The caller uses this to decide whether to
/// CORRECT a row, and correcting one on the strength of an unreadable directory
/// would be a guess.
fn is_linked_worktree_checkout(execution_root: &Path) -> bool {
    let dot_git = execution_root.join(".git");
    // Follows a symlink deliberately: what matters is what the entry resolves
    // to, not how it is spelled.
    if !fs::metadata(&dot_git).is_ok_and(|metadata| metadata.is_file()) {
        return false;
    }
    let Ok(text) = fs::read_to_string(&dot_git) else {
        return false;
    };
    text.lines()
        .filter_map(|line| line.trim().strip_prefix("gitdir:"))
        .any(|target| {
            Path::new(target.trim())
                .components()
                .any(|component| component.as_os_str() == "worktrees")
        })
}

fn normalized_path_key(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn discover_port_checkout_root(
    cwd: &Path,
    home: Option<PathBuf>,
) -> Result<Option<String>, crate::PortLeaseDiagnostic> {
    let diagnostic = |kind, detail| crate::PortLeaseDiagnostic {
        kind,
        lease_ids: Vec::new(),
        detail: format!("{}: {detail}", cwd.display()),
    };
    let home = home.map(|path| fs::canonicalize(&path).unwrap_or(path));
    // Allow inspection of home itself so a home checkout can be diagnosed, but
    // do not search its ancestors. Empty flags ignore GIT_* and forbid CROSS_FS.
    let ceilings: Vec<_> = home.as_deref().and_then(Path::parent).into_iter().collect();
    let repository =
        match git2::Repository::open_ext(cwd, git2::RepositoryOpenFlags::empty(), &ceilings) {
            Ok(repository) => repository,
            Err(error) if error.code() == git2::ErrorCode::NotFound => return Ok(None),
            Err(error) => {
                return Err(diagnostic(
                    crate::PortLeaseDiagnosticKind::DiscoveryFailed,
                    error.to_string(),
                ))
            }
        };
    let Some(root) = repository.workdir() else {
        return Ok(None);
    };
    let root = crate::ports::canonical_root(root).map_err(|error| {
        diagnostic(
            crate::PortLeaseDiagnosticKind::DiscoveryFailed,
            error.to_string(),
        )
    })?;
    let path = Path::new(&root);
    if !cwd.starts_with(path) {
        return Err(diagnostic(
            crate::PortLeaseDiagnosticKind::DiscoveryFailed,
            format!("checkout root {root} does not contain the execution directory"),
        ));
    }
    if path.parent().is_none() || home.as_ref().is_some_and(|home| home.starts_with(path)) {
        return Err(diagnostic(
            crate::PortLeaseDiagnosticKind::DiscoveryRejected,
            format!("checkout root {root} contains the home directory or is a filesystem root; explicit registration required"),
        ));
    }
    Ok(Some(root))
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
    // `is_ok()` on HEAD, not merely "a repository was discovered". The reason
    // is the same one `is_git_root` records, and this is the second copy of the
    // decision: a repository whose HEAD is unborn has no commit to detach from,
    // so `git worktree add` cannot make an execution root here.
    //
    // The single-root path already refused it. This one did not, and a bundle
    // is what a chat turn actually acquires, so the fix never reached the path
    // that needed it. `ensure-default-workspace.ts` creates the workspace
    // directory and `git init`s it without committing, which is precisely this
    // state on a fresh install: the bundle claimed Git isolation, the worktree
    // was never created, and the reconciliation sweep then found an Active
    // managed workspace with no matching entry in `git worktree list`, marked
    // it orphaned and moved it to `Conflict`. Every later turn in that
    // conversation was refused with "managed workspace is not active", with no
    // way back from the UI.
    //
    // Answering Shadow here is what the same directory would have received had
    // `git init` never run, and it upgrades itself: the first commit makes
    // later bundles real worktrees.
    if let Ok(repository) = git2::Repository::discover(&source_root) {
        if repository_is_worktree_capable(&repository) {
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

fn validate_scratch_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
        || workspace_path_contains_symlink(path)?
    {
        return Err(format!(
            "scratch workspace path must be absolute without traversal or symlinks: {}",
            path.display()
        ));
    }
    Ok(())
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
    /// Repository to read Git-resident blobs from, when either side of the
    /// comparison was captured against a commit. A linked worktree shares its
    /// object database with the repository it was cut from, so one root
    /// resolves content for both the baseline and the current snapshot.
    git_root: Option<&'a Path>,
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
        let bytes = resolve_blob(context, &entry.hash)?;
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
        let bytes = resolve_blob(context, &entry.hash)?;
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
            let old_bytes = resolve_blob(context, &old.hash)?;
            let new_bytes = resolve_blob(context, &new.hash)?;
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

/// Bytes for `hash`, from the blob store or else from Git.
///
/// A Git-backed snapshot stores no blob for content Git already has, so a miss
/// here is expected rather than exceptional. Only a genuine absence falls
/// through to Git — an unreadable or corrupt blob keeps its original error, so
/// a storage fault is never silently reported as a missing object.
fn resolve_blob(context: &mut ReconcileContext<'_>, hash: &str) -> Result<Vec<u8>, String> {
    match context.store.get_blob(hash, context.now) {
        Ok(bytes) => Ok(bytes),
        Err(error) if error.starts_with("missing blob") => {
            let Some(root) = context.git_root else {
                return Err(error);
            };
            crate::snapshot::git_read_blobs(root, std::slice::from_ref(&hash.to_string()))?
                .remove(hash)
                .ok_or(error)
        }
        Err(error) => Err(error),
    }
}

/// Patch application and undo use the ledger after the execution may be gone.
/// Persist only referenced content; unchanged Git-backed entries stay in Git.
fn persist_patch_blobs(
    store: &mut WorkspaceStore,
    changes: &[ResourceChange],
    git_root: &Path,
    now: i64,
) -> Result<(), String> {
    let hashes: std::collections::BTreeSet<_> = changes
        .iter()
        .flat_map(|change| change.before_hash.iter().chain(change.hash.iter()))
        .collect();
    let mut missing = Vec::new();
    for hash in hashes {
        match store.get_blob(hash, now) {
            Ok(_) => {}
            Err(error) if error == format!("missing blob {hash}") => missing.push(hash.clone()),
            Err(error) => return Err(error),
        }
    }
    if missing.is_empty() {
        return Ok(());
    }
    let mut from_git = crate::snapshot::git_read_blobs(git_root, &missing)?;
    for hash in missing {
        let bytes = from_git
            .remove(&hash)
            .ok_or_else(|| format!("missing blob {hash}"))?;
        store.put_blob(&hash, &bytes, now)?;
    }
    Ok(())
}

/// Bytes for every entry of `snapshot`, taking what the blob store has and
/// asking `git_root` for the rest in a single batch.
pub(crate) fn hydrate_snapshot_blobs(
    store: &mut WorkspaceStore,
    snapshot: &crate::snapshot::WorkspaceSnapshot,
    git_root: &Path,
    now: i64,
) -> Result<HashMap<String, Vec<u8>>, String> {
    let mut blobs: HashMap<String, Vec<u8>> = HashMap::new();
    let mut missing: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for entry in snapshot.entries.values() {
        if !seen.insert(entry.hash.as_str()) {
            continue;
        }
        match store.get_blob(&entry.hash, now) {
            Ok(bytes) => {
                blobs.insert(entry.hash.clone(), bytes);
            }
            Err(error) if error.starts_with("missing blob") => missing.push(entry.hash.clone()),
            Err(error) => return Err(error),
        }
    }
    if !missing.is_empty() {
        let mut from_git = crate::snapshot::git_read_blobs(git_root, &missing)?;
        for hash in missing {
            let bytes = from_git
                .remove(&hash)
                .ok_or_else(|| format!("missing blob {hash}"))?;
            blobs.insert(hash, bytes);
        }
    }
    Ok(blobs)
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

pub(crate) fn now_ms() -> i64 {
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

    #[test]
    fn port_fresh_git_checkout_ensure_discovers_root_and_releases_both_owners() {
        let data = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        git2::Repository::init(root.path()).unwrap();
        let nested = root.path().join("src/nested");
        fs::create_dir_all(&nested).unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let ns = "remote:checkout-test";
        assert!(service
            .resolve_workspace_port_lease(ns, None, &nested, false)
            .unwrap()
            .is_none());
        assert!(crate::ports::list(&service.store.lock().connection)
            .unwrap()
            .is_empty());
        let lease = service
            .resolve_workspace_port_lease(ns, None, &nested, true)
            .unwrap()
            .unwrap();
        let canonical = crate::ports::canonical_root(root.path()).unwrap();
        assert_eq!(lease.subject_kind, crate::PortSubjectKind::ProjectRoot);
        assert_eq!(lease.subject_key, format!("root:{canonical}"));
        assert_eq!(lease.canonical_root, canonical);
        assert_eq!(
            service
                .resolve_workspace_port_lease(ns, None, root.path(), true)
                .unwrap()
                .unwrap()
                .lease_id,
            lease.lease_id
        );
        let project = service
            .ensure_subject_port_lease(
                ns,
                crate::PortSubjectKind::ProjectRoot,
                "project-id",
                root.path(),
            )
            .unwrap();
        assert_eq!(project.lease_id, lease.lease_id);
        // Canonicalization is host-owned, including symlink aliases.
        #[cfg(unix)]
        let alias = {
            let alias = data.path().join("project-alias");
            std::os::unix::fs::symlink(root.path(), &alias).unwrap();
            alias
        };
        #[cfg(not(unix))]
        let alias = root.path().to_path_buf();
        service
            .ensure_subject_port_lease(
                ns,
                crate::PortSubjectKind::ProjectRoot,
                "project-id",
                &alias,
            )
            .unwrap();
        service
            .release_subject_port_leases(
                ns,
                crate::PortSubjectKind::ProjectRoot,
                &format!("root:{}", alias.display()),
            )
            .unwrap();
        assert_eq!(
            crate::ports::list(&service.store.lock().connection)
                .unwrap()
                .len(),
            1
        );
        service
            .release_subject_port_leases(ns, crate::PortSubjectKind::ProjectRoot, "project-id")
            .unwrap();
        assert!(crate::ports::list(&service.store.lock().connection)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn port_git_discovery_keeps_linked_worktrees_separate_and_offline_roots() {
        let data = TempDir::new().unwrap();
        let source = TempDir::new().unwrap();
        git2::Repository::init(source.path()).unwrap();
        seed_git_repository(source.path());
        let worktree = data.path().join("linked");
        git2::Repository::open(source.path())
            .unwrap()
            .worktree("port-test", &worktree, None)
            .unwrap();
        let service =
            TaskWorkspaceService::open(ServiceConfig::new(data.path().join("host"))).unwrap();
        let ns = "remote:worktree-test";
        let parent = service
            .resolve_workspace_port_lease(ns, None, source.path(), true)
            .unwrap()
            .unwrap();
        assert!(service
            .resolve_workspace_port_lease(ns, None, &worktree, false)
            .unwrap()
            .is_none());
        let child = service
            .resolve_workspace_port_lease(ns, None, &worktree, true)
            .unwrap()
            .unwrap();
        assert_ne!(child.lease_id, parent.lease_id);
        assert_ne!(child.base_port, parent.base_port);
        assert_eq!(
            child.canonical_root,
            crate::ports::canonical_root(&worktree).unwrap()
        );
        fs::remove_dir_all(&worktree).unwrap();
        service.reconcile_workspace_port_leases().unwrap();
        assert_eq!(
            service
                .read_subject_port_leases(
                    ns,
                    crate::PortSubjectKind::ProjectRoot,
                    &child.subject_key
                )
                .unwrap()
                .len(),
            1
        );
        service
            .release_subject_port_leases(
                ns,
                crate::PortSubjectKind::ProjectRoot,
                &child.subject_key,
            )
            .unwrap();
        assert_eq!(
            crate::ports::list(&service.store.lock().connection)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn port_host_only_subdirectory_delete_retains_shared_root_until_exact_orphan_release() {
        let data = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        git2::Repository::init(root.path()).unwrap();
        let nested = root.path().join("packages/app");
        fs::create_dir_all(&nested).unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let ns = "remote:subdirectory-release";
        let lease = service
            .resolve_workspace_port_lease(ns, None, &nested, true)
            .unwrap()
            .unwrap();
        fs::remove_dir_all(&nested).unwrap();
        service
            .release_subject_port_leases(
                ns,
                crate::PortSubjectKind::ProjectRoot,
                &format!("root:{}", nested.display()),
            )
            .unwrap();
        service
            .release_subject_port_leases(ns, crate::PortSubjectKind::ProjectRoot, "deleted-project")
            .unwrap();
        let snapshot = service.list_workspace_port_leases().unwrap();
        assert_eq!(snapshot.leases.len(), 1);
        assert!(!snapshot
            .diagnostics
            .iter()
            .any(|d| d.kind == crate::PortLeaseDiagnosticKind::MissingRoot));
        fs::remove_dir_all(root.path()).unwrap();
        assert!(service
            .reconcile_workspace_port_leases()
            .unwrap()
            .iter()
            .any(|d| d.kind == crate::PortLeaseDiagnosticKind::MissingRoot
                && d.lease_ids == [lease.lease_id.clone()]));
        assert!(service
            .list_workspace_port_leases()
            .unwrap()
            .diagnostics
            .iter()
            .any(|d| d.kind == crate::PortLeaseDiagnosticKind::MissingRoot));
        // The UI can explicitly release the orphan by its recorded root key.
        service
            .release_subject_port_leases(
                ns,
                crate::PortSubjectKind::ProjectRoot,
                &lease.subject_key,
            )
            .unwrap();
        assert!(service
            .list_workspace_port_leases()
            .unwrap()
            .leases
            .is_empty());
    }

    #[test]
    fn port_git_discovery_ignores_non_git_and_bare_repositories() {
        let data = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        for bare in [false, true] {
            if bare {
                git2::Repository::init_bare(root.path()).unwrap();
            }
            assert!(service
                .resolve_workspace_port_lease("remote:no-checkout", None, root.path(), true)
                .unwrap()
                .is_none());
        }
        assert!(crate::ports::list(&service.store.lock().connection)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn port_discovery_rejects_home_and_ancestors_but_allows_nested_repositories() {
        let data = TempDir::new().unwrap();
        let sandbox = TempDir::new().unwrap();
        let home = sandbox.path().join("home");
        fs::create_dir(&home).unwrap();
        git2::Repository::init(&home).unwrap();
        let nested = home.join("project/src");
        fs::create_dir_all(&nested).unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let ns = "remote:home";
        assert!(service
            .resolve_workspace_port_lease_with_home(ns, None, &nested, true, || Some(home.clone()))
            .unwrap()
            .is_none());
        assert!(service
            .list_workspace_port_leases()
            .unwrap()
            .diagnostics
            .iter()
            .any(|d| d.kind == crate::PortLeaseDiagnosticKind::DiscoveryRejected));
        git2::Repository::init(home.join("project")).unwrap();
        let lease = service
            .resolve_workspace_port_lease_with_home(ns, None, &nested, true, || Some(home.clone()))
            .unwrap()
            .unwrap();
        assert_eq!(
            lease.canonical_root,
            crate::ports::canonical_root(&home.join("project")).unwrap()
        );
        assert!(service
            .list_workspace_port_leases()
            .unwrap()
            .diagnostics
            .is_empty());

        // Treat the sandbox as a filesystem-root-like ceiling. A repository
        // there must not capture a plain directory under the fake home.
        fs::remove_dir_all(home.join(".git")).unwrap();
        git2::Repository::init(sandbox.path()).unwrap();
        let plain = home.join("plain");
        fs::create_dir(&plain).unwrap();
        assert!(service
            .resolve_workspace_port_lease_with_home(ns, None, &plain, true, || Some(home.clone()))
            .unwrap()
            .is_none());
        assert!(service
            .resolve_workspace_port_lease_with_home(ns, None, sandbox.path(), true, || Some(
                home.clone()
            ))
            .unwrap()
            .is_none());
        assert!(service
            .reconcile_workspace_port_leases()
            .unwrap()
            .iter()
            .any(|d| d.kind == crate::PortLeaseDiagnosticKind::DiscoveryRejected));
        // Explicitly registered home roots remain authoritative.
        let registered = service
            .ensure_subject_port_lease(
                ns,
                crate::PortSubjectKind::ProjectRoot,
                "explicit-home",
                &home,
            )
            .unwrap();
        assert_eq!(
            service
                .resolve_workspace_port_lease_with_home(ns, None, &plain, true, || panic!(
                    "registered roots do not discover"
                ))
                .unwrap()
                .unwrap()
                .lease_id,
            registered.lease_id
        );
    }

    #[test]
    fn port_discovery_ignores_host_git_environment() {
        const CHILD: &str = "COGNIA_PORT_DISCOVERY_ENV_CHILD";
        if let Some(cwd) = std::env::var_os(CHILD) {
            let data = TempDir::new().unwrap();
            let fake_home = TempDir::new().unwrap();
            let service =
                TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
            let cwd = PathBuf::from(cwd);
            let lease = service
                .resolve_workspace_port_lease_with_home(
                    "remote:env",
                    None,
                    &cwd.join("src"),
                    true,
                    || Some(fake_home.path().into()),
                )
                .unwrap()
                .unwrap();
            assert_eq!(
                lease.canonical_root,
                crate::ports::canonical_root(&cwd).unwrap()
            );
            return;
        }
        // Isolate process environment changes from concurrently running tests.
        let checkout = TempDir::new().unwrap();
        let foreign = TempDir::new().unwrap();
        git2::Repository::init(checkout.path()).unwrap();
        git2::Repository::init(foreign.path()).unwrap();
        fs::create_dir(checkout.path().join("src")).unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "service::tests::port_discovery_ignores_host_git_environment",
                "--nocapture",
            ])
            .env(CHILD, checkout.path())
            .env("GIT_DIR", foreign.path().join(".git"))
            .env("GIT_WORK_TREE", foreign.path())
            .env("GIT_CEILING_DIRECTORIES", checkout.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn port_discovery_submodule_uses_its_own_worktree_root() {
        let data = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let repository = git2::Repository::init(root.path()).unwrap();
        let submodule = repository
            .submodule(
                "https://example.invalid/local-fixture",
                Path::new("child"),
                true,
            )
            .unwrap();
        let subrepo = submodule.open().unwrap();
        let child = subrepo.workdir().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let lease = service
            .resolve_workspace_port_lease("remote:submodule", None, child, true)
            .unwrap()
            .unwrap();
        assert_eq!(
            lease.canonical_root,
            crate::ports::canonical_root(&root.path().join("child")).unwrap()
        );
        let parent = service
            .resolve_workspace_port_lease("remote:submodule", None, root.path(), true)
            .unwrap()
            .unwrap();
        assert_ne!(parent.lease_id, lease.lease_id);
    }

    #[test]
    fn port_discovery_failure_is_report_only_and_registered_subjects_skip_it() {
        let data = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        fs::write(root.path().join(".git"), "invalid gitdir file\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let ns = "remote:corrupt";
        assert!(service
            .resolve_workspace_port_lease(ns, None, root.path(), true)
            .unwrap()
            .is_none());
        assert!(service
            .resolve_workspace_port_lease(ns, None, root.path(), false)
            .unwrap()
            .is_none());
        assert!(service
            .list_workspace_port_leases()
            .unwrap()
            .diagnostics
            .iter()
            .any(|d| d.kind == crate::PortLeaseDiagnosticKind::DiscoveryFailed));
        let lease = service
            .ensure_subject_port_lease(
                ns,
                crate::PortSubjectKind::ProjectRoot,
                "project",
                root.path(),
            )
            .unwrap();
        assert_eq!(
            service
                .resolve_workspace_port_lease_with_home(ns, None, root.path(), true, || panic!(
                    "registered subjects skip discovery"
                ))
                .unwrap()
                .unwrap()
                .lease_id,
            lease.lease_id
        );
        service
            .release_subject_port_leases(ns, crate::PortSubjectKind::ProjectRoot, "project")
            .unwrap();
        assert!(service
            .list_workspace_port_leases()
            .unwrap()
            .leases
            .is_empty());
        // Allocation and ledger failures are still authoritative errors.
        service
            .store
            .lock()
            .connection
            .execute("DROP TABLE workspace_registry", [])
            .unwrap();
        assert!(matches!(
            service.resolve_workspace_port_lease(ns, None, root.path(), true),
            Err(crate::PortLeaseError::Store(_))
        ));
    }

    #[test]
    fn port_discovered_checkout_propagates_allocation_exhaustion() {
        let data = TempDir::new().unwrap();
        let first = TempDir::new().unwrap();
        let second = TempDir::new().unwrap();
        git2::Repository::init(first.path()).unwrap();
        git2::Repository::init(second.path()).unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        service
            .set_workspace_lifecycle_policy(crate::WorkspaceLifecyclePolicy {
                port_range_start: 41000,
                port_range_end: 41009,
                port_block_size: 10,
                ..Default::default()
            })
            .unwrap();
        service
            .resolve_workspace_port_lease("remote:exhaustion", None, first.path(), true)
            .unwrap()
            .unwrap();
        assert!(matches!(
            service.resolve_workspace_port_lease("remote:exhaustion", None, second.path(), true),
            Err(crate::PortLeaseError::Exhausted { .. })
        ));
    }

    #[test]
    fn port_targeted_subject_release_retains_new_root_and_shared_owners() {
        let data = TempDir::new().unwrap();
        let old_root = TempDir::new().unwrap();
        let new_root = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let ns = "remote:move";
        let kind = crate::PortSubjectKind::DesktopSession;
        let old = service
            .ensure_subject_port_lease(ns, kind, "session", old_root.path())
            .unwrap();
        let shared = service
            .ensure_subject_port_lease(
                ns,
                crate::PortSubjectKind::ProjectRoot,
                "project",
                old_root.path(),
            )
            .unwrap();
        let new = service
            .ensure_subject_port_lease(ns, kind, "session", new_root.path())
            .unwrap();
        assert_ne!(old.lease_id, new.lease_id);
        assert_eq!(
            service
                .ensure_subject_port_lease(ns, kind, "session", old_root.path())
                .unwrap(),
            old
        );
        assert_eq!(
            service
                .read_subject_port_leases(ns, kind, "session")
                .unwrap()
                .len(),
            2
        );
        // Wrong namespace, owner, kind or missing reference must never release a peer.
        for (namespace, subject_kind, key, id) in [
            ("remote:other", kind, "session", old.lease_id.as_str()),
            (ns, kind, "other", old.lease_id.as_str()),
            (
                ns,
                crate::PortSubjectKind::ProjectRoot,
                "session",
                old.lease_id.as_str(),
            ),
            (ns, kind, "session", "missing"),
        ] {
            service
                .release_subject_port_lease_reference(namespace, subject_kind, key, Some(id))
                .unwrap();
        }
        assert_eq!(
            service
                .read_subject_port_leases(ns, kind, "session")
                .unwrap()
                .len(),
            2
        );
        // Removing the directory does not prevent ledger-based cleanup.
        old_root.close().unwrap();
        for _ in 0..2 {
            service
                .release_subject_port_lease_reference(ns, kind, "session", Some(&old.lease_id))
                .unwrap();
        }
        assert_eq!(
            service
                .read_subject_port_leases(ns, kind, "session")
                .unwrap(),
            vec![new.clone()]
        );
        let retained = service
            .read_subject_port_leases(ns, crate::PortSubjectKind::ProjectRoot, "project")
            .unwrap();
        assert_eq!(retained[0].lease_id, shared.lease_id);
        assert_eq!(retained[0].base_port, shared.base_port);
        service
            .release_subject_port_lease_reference(
                ns,
                crate::PortSubjectKind::ProjectRoot,
                "project",
                Some(&old.lease_id),
            )
            .unwrap();
        assert_eq!(
            service.list_workspace_port_leases().unwrap().leases.len(),
            1
        );
        service
            .release_subject_port_leases(ns, kind, "session")
            .unwrap();
        assert!(service
            .list_workspace_port_leases()
            .unwrap()
            .leases
            .is_empty());
    }

    #[test]
    fn port_list_is_read_only_and_reports_all_subjects() {
        let data = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        assert!(service
            .list_workspace_port_leases()
            .unwrap()
            .leases
            .is_empty());
        let lease = service
            .ensure_subject_port_lease(
                "remote:list",
                crate::PortSubjectKind::ProjectRoot,
                "p",
                root.path(),
            )
            .unwrap();
        let report = service.list_workspace_port_leases().unwrap();
        assert_eq!(report.leases.len(), 1);
        assert_eq!(report.leases[0].lease, lease);
        assert_eq!(report.leases[0].subjects[0].key, "p");
        assert_eq!(report.leases[0].occupied_ports, None);
        assert!(report.diagnostics.is_empty());
    }

    #[test]
    fn port_subject_aliases_share_one_block_and_release_only_their_reference() {
        let data = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let ns = "container:subjects";
        assert!(service
            .read_subject_port_leases(ns, crate::PortSubjectKind::DesktopSession, "s")
            .unwrap()
            .is_empty());
        assert!(service
            .resolve_workspace_port_lease(ns, None, root.path(), false)
            .unwrap()
            .is_none());
        assert!(crate::ports::list(&service.store.lock().connection)
            .unwrap()
            .is_empty());
        let first = service
            .ensure_subject_port_lease(ns, crate::PortSubjectKind::DesktopSession, "s", root.path())
            .unwrap();
        let second = service
            .ensure_subject_port_lease(ns, crate::PortSubjectKind::ProjectRoot, "p", root.path())
            .unwrap();
        assert_eq!(first.lease_id, second.lease_id);
        let subdir = root.path().join("nested");
        fs::create_dir(&subdir).unwrap();
        assert_eq!(
            service
                .resolve_workspace_port_lease(ns, None, &subdir, false)
                .unwrap()
                .unwrap()
                .lease_id,
            first.lease_id
        );
        service
            .release_subject_port_leases(ns, crate::PortSubjectKind::DesktopSession, "s")
            .unwrap();
        assert_eq!(
            service
                .read_subject_port_leases(ns, crate::PortSubjectKind::ProjectRoot, "p")
                .unwrap()
                .len(),
            1
        );
        service
            .release_subject_port_leases(ns, crate::PortSubjectKind::ProjectRoot, "p")
            .unwrap();
        assert!(crate::ports::list(&service.store.lock().connection)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn port_explicit_release_survives_reconcile_and_restart_until_subject_ensure() {
        let data = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        git2::Repository::init(root.path()).unwrap();
        seed_git_repository(root.path());
        let config = ServiceConfig::new(data.path().into());
        let service = TaskWorkspaceService::open(config.clone()).unwrap();
        let ns = "remote:released";
        let mut record = service
            .registry
            .insert_imported(
                crate::ImportedWorkspaceHint {
                    source_root: root.path().to_string_lossy().into_owned(),
                    execution_root: root.path().to_string_lossy().into_owned(),
                    git_common_dir: None,
                    branch: None,
                },
                now_ms(),
            )
            .unwrap();
        record.state = WorkspaceState::Archived;
        service.store.lock().put_workspace(&record).unwrap();
        let lease = service
            .ensure_workspace_port_lease(&record.workspace_id, ns)
            .unwrap();
        let project = service
            .ensure_subject_port_lease(ns, crate::PortSubjectKind::ProjectRoot, "p", root.path())
            .unwrap();
        assert_eq!(lease.lease_id, project.lease_id);
        // Exercise the release transaction without a host probe in this remote namespace.
        {
            let store = service.store.lock();
            let tx = rusqlite::Transaction::new_unchecked(
                &store.connection,
                rusqlite::TransactionBehavior::Immediate,
            )
            .unwrap();
            crate::ports::release_subject_in_transaction(
                &tx,
                Some(ns),
                crate::PortSubjectKind::Registry,
                &record.workspace_id,
            )
            .unwrap();
            tx.commit().unwrap();
        }
        assert!(service
            .read_workspace_port_lease(&record.workspace_id, ns)
            .unwrap()
            .is_none());
        service.reconcile_workspace_port_leases().unwrap();
        assert!(service
            .read_workspace_port_lease(&record.workspace_id, ns)
            .unwrap()
            .is_none());
        drop(service);
        let service = TaskWorkspaceService::open(config.clone()).unwrap();
        assert!(service
            .read_workspace_port_lease(&record.workspace_id, ns)
            .unwrap()
            .is_none());
        service
            .release_subject_port_leases(ns, crate::PortSubjectKind::ProjectRoot, "p")
            .unwrap();
        assert!(crate::ports::list(&service.store.lock().connection)
            .unwrap()
            .is_empty());

        // The marker survives the block itself, and another subject's ensure cannot clear it.
        let project = service
            .ensure_subject_port_lease(ns, crate::PortSubjectKind::ProjectRoot, "p", root.path())
            .unwrap();
        service.reconcile_workspace_port_leases().unwrap();
        assert!(service
            .read_workspace_port_lease(&record.workspace_id, ns)
            .unwrap()
            .is_none());
        let restored = service
            .ensure_workspace_port_lease(&record.workspace_id, ns)
            .unwrap();
        assert_eq!(restored.lease_id, project.lease_id);
        assert_eq!(restored.base_port, project.base_port);
        drop(service);
        let service = TaskWorkspaceService::open(config).unwrap();
        assert_eq!(
            service
                .read_workspace_port_lease(&record.workspace_id, ns)
                .unwrap()
                .unwrap()
                .lease_id,
            restored.lease_id
        );
        service
            .release_subject_port_leases(ns, crate::PortSubjectKind::ProjectRoot, "p")
            .unwrap();
        assert_eq!(
            crate::ports::list(&service.store.lock().connection)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn port_resolution_uses_execution_roots_and_component_containment_not_source_roots() {
        let data = TempDir::new().unwrap();
        let source = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let ns = "container:paths";
        let main = service
            .ensure_subject_port_lease(
                ns,
                crate::PortSubjectKind::ProjectRoot,
                "project",
                source.path(),
            )
            .unwrap();
        let mut ids = Vec::new();
        let mut leases = Vec::new();
        for name in ["work", "work-other"] {
            let root = source.path().join(name);
            fs::create_dir_all(root.join("src/nested")).unwrap();
            let record = service
                .registry
                .insert_imported(
                    crate::ImportedWorkspaceHint {
                        source_root: source.path().to_string_lossy().into_owned(),
                        execution_root: root.to_string_lossy().into_owned(),
                        git_common_dir: None,
                        branch: None,
                    },
                    now_ms(),
                )
                .unwrap();
            assert!(service
                .read_workspace_port_lease(&record.workspace_id, ns)
                .unwrap()
                .is_none());
            assert!(service
                .get_managed_workspace(&record.workspace_id)
                .unwrap()
                .unwrap()
                .port_lease
                .is_none());
            let lease = service
                .resolve_workspace_port_lease(ns, None, &root.join("src/nested"), true)
                .unwrap()
                .unwrap();
            ids.push(record.workspace_id);
            leases.push(lease);
        }
        assert_ne!(leases[0].base_port, leases[1].base_port);
        assert_ne!(leases[0].base_port, main.base_port);
        assert_eq!(
            service
                .resolve_workspace_port_lease(ns, None, source.path(), true)
                .unwrap()
                .unwrap()
                .lease_id,
            main.lease_id
        );
        let sibling = source.path().join("work-sibling");
        fs::create_dir(&sibling).unwrap();
        assert_eq!(
            service
                .resolve_workspace_port_lease(ns, None, &sibling, false)
                .unwrap()
                .unwrap()
                .lease_id,
            main.lease_id
        );
        assert_eq!(
            service
                .resolve_workspace_port_lease(ns, Some(&ids[0]), &sibling, false)
                .unwrap()
                .unwrap()
                .lease_id,
            leases[0].lease_id
        );
        // A nested registry execution root wins over the containing checkout.
        let nested = source.path().join("work/src");
        let record = service
            .registry
            .insert_imported(
                crate::ImportedWorkspaceHint {
                    source_root: source.path().to_string_lossy().into_owned(),
                    execution_root: nested.to_string_lossy().into_owned(),
                    git_common_dir: None,
                    branch: None,
                },
                now_ms(),
            )
            .unwrap();
        let lease = service
            .ensure_workspace_port_lease(&record.workspace_id, ns)
            .unwrap();
        assert_eq!(
            service
                .resolve_workspace_port_lease(ns, None, &nested.join("nested"), false)
                .unwrap()
                .unwrap()
                .lease_id,
            lease.lease_id
        );
    }

    #[cfg(unix)]
    #[test]
    fn port_symlink_aliases_and_registry_aliases_share_a_physical_root() {
        let data = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let alias = data.path().join("alias");
        std::os::unix::fs::symlink(root.path(), &alias).unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let ns = "remote:aliases";
        let first = service
            .ensure_subject_port_lease(ns, crate::PortSubjectKind::ProjectRoot, "p1", root.path())
            .unwrap();
        let second = service
            .ensure_subject_port_lease(ns, crate::PortSubjectKind::ProjectRoot, "p2", &alias)
            .unwrap();
        assert_eq!(first, second);
        let mut ids = Vec::new();
        for path in [root.path(), &alias] {
            let record = service
                .registry
                .insert_imported(
                    crate::ImportedWorkspaceHint {
                        source_root: "/source".into(),
                        execution_root: path.to_string_lossy().into_owned(),
                        git_common_dir: None,
                        branch: None,
                    },
                    now_ms(),
                )
                .unwrap();
            assert_eq!(
                service
                    .ensure_workspace_port_lease(&record.workspace_id, ns)
                    .unwrap()
                    .lease_id,
                first.lease_id
            );
            ids.push(record.workspace_id);
        }
        assert_eq!(
            service
                .resolve_workspace_port_lease(ns, None, &alias, false)
                .unwrap()
                .unwrap()
                .lease_id,
            first.lease_id
        );
        service.registry.forget_imported(&ids[0]).unwrap();
        assert_eq!(
            service
                .read_workspace_port_lease(&ids[1], ns)
                .unwrap()
                .unwrap()
                .lease_id,
            first.lease_id
        );
    }

    #[test]
    fn port_boot_reconcile_repairs_links_and_retains_offline_archives() {
        let data = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let config = ServiceConfig::new(data.path().into());
        let service = TaskWorkspaceService::open(config.clone()).unwrap();
        let mut record = service
            .registry
            .insert_imported(
                crate::ImportedWorkspaceHint {
                    source_root: root.path().to_string_lossy().into_owned(),
                    execution_root: root.path().to_string_lossy().into_owned(),
                    git_common_dir: None,
                    branch: None,
                },
                now_ms(),
            )
            .unwrap();
        let lease = service
            .ensure_workspace_port_lease(&record.workspace_id, "remote:offline")
            .unwrap();
        record.state = WorkspaceState::Archived;
        service.store.lock().put_workspace(&record).unwrap();
        service
            .store
            .lock()
            .connection
            .execute(
                "UPDATE workspace_port_leases SET registry_workspace_id=NULL",
                [],
            )
            .unwrap();
        service
            .set_workspace_lifecycle_policy(crate::WorkspaceLifecyclePolicy {
                port_range_start: 60000,
                port_range_end: 60999,
                ..Default::default()
            })
            .unwrap();
        drop(root);
        drop(service);
        let reopened = TaskWorkspaceService::open(config).unwrap();
        let retained = reopened
            .read_workspace_port_lease(&record.workspace_id, "remote:offline")
            .unwrap()
            .unwrap();
        assert_eq!(retained.lease_id, lease.lease_id);
        assert_eq!(retained.base_port, lease.base_port);
        assert_eq!(
            retained.registry_workspace_id.as_deref(),
            Some(record.workspace_id.as_str())
        );
        assert!(reopened
            .open_recovery_failures
            .lock()
            .iter()
            .any(|message| message.contains("port lease OutOfRange")));
    }

    #[test]
    fn port_release_refuses_active_and_provisioning_and_ensure_rejects_files() {
        let data = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let mut record = service
            .registry
            .insert_imported(
                crate::ImportedWorkspaceHint {
                    source_root: root.path().to_string_lossy().into_owned(),
                    execution_root: root.path().to_string_lossy().into_owned(),
                    git_common_dir: None,
                    branch: None,
                },
                now_ms(),
            )
            .unwrap();
        for state in [WorkspaceState::Active, WorkspaceState::Provisioning] {
            record.state = state;
            service.store.lock().put_workspace(&record).unwrap();
            assert!(
                matches!(service.release_archived_workspace_port_lease(&record.workspace_id, crate::HOST_LOOPBACK_NAMESPACE), Err(crate::PortLeaseError::WorkspaceBusy { state: actual, .. }) if actual == state)
            );
        }
        let file = root.path().join("file.txt");
        fs::write(&file, "file").unwrap();
        assert!(matches!(
            service.ensure_subject_port_lease(
                "remote:test",
                crate::PortSubjectKind::ProjectRoot,
                "p",
                &file
            ),
            Err(crate::PortLeaseError::Root(_))
        ));
        assert!(crate::ports::list(&service.store.lock().connection)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn port_cwd_fallback_requires_a_registered_external_subject() {
        let data = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let record = service
            .registry
            .insert_imported(
                crate::ImportedWorkspaceHint {
                    source_root: root.path().to_string_lossy().into_owned(),
                    execution_root: root.path().to_string_lossy().into_owned(),
                    git_common_dir: None,
                    branch: None,
                },
                now_ms(),
            )
            .unwrap();
        let lease = service
            .ensure_workspace_port_lease(&record.workspace_id, "remote:orphan")
            .unwrap();
        service
            .store
            .lock()
            .connection
            .execute(
                "DELETE FROM workspace_registry WHERE workspace_id=?1",
                [&record.workspace_id],
            )
            .unwrap();
        assert!(service
            .resolve_workspace_port_lease("remote:orphan", None, root.path(), false)
            .unwrap()
            .is_none());
        let registered = service
            .ensure_subject_port_lease(
                "remote:orphan",
                crate::PortSubjectKind::ProjectRoot,
                "p",
                root.path(),
            )
            .unwrap();
        assert_eq!(registered.lease_id, lease.lease_id);
        assert_eq!(
            service
                .resolve_workspace_port_lease("remote:orphan", None, root.path(), false)
                .unwrap()
                .unwrap()
                .lease_id,
            lease.lease_id
        );
        service
            .release_subject_port_leases("remote:orphan", crate::PortSubjectKind::ProjectRoot, "p")
            .unwrap();
        assert_eq!(
            crate::ports::list(&service.store.lock().connection)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn port_reconcile_reads_registry_after_acquiring_the_cross_connection_write_lock() {
        use std::sync::atomic::{AtomicBool, Ordering};
        static RECONCILE_BLOCKED: AtomicBool = AtomicBool::new(false);
        RECONCILE_BLOCKED.store(false, Ordering::SeqCst);
        let data = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let config = ServiceConfig::new(data.path().into());
        let service = TaskWorkspaceService::open(config.clone()).unwrap();
        let writer = TaskWorkspaceService::open(config).unwrap();
        let record = service.registry.insert_imported(crate::ImportedWorkspaceHint {
            source_root: root.path().to_string_lossy().into_owned(),
            execution_root: root.path().to_string_lossy().into_owned(),
            git_common_dir: None,
            branch: None,
        }, now_ms()).unwrap();
        let lease = service.ensure_workspace_port_lease(&record.workspace_id, "remote:interleaving").unwrap();
        let mut alias = record.clone();
        alias.workspace_id = "port-alias-b".into();

        let store = writer.store.lock();
        let tx = rusqlite::Transaction::new_unchecked(&store.connection, rusqlite::TransactionBehavior::Immediate).unwrap();
        store.put_workspace(&alias).unwrap();
        crate::ports::ensure_in_transaction(&tx, "remote:interleaving", crate::ports::LeaseSubject {
            kind: crate::PortSubjectKind::Registry,
            key: &alias.workspace_id,
            root: &lease.canonical_root,
            registry_id: Some(&alias.workspace_id),
        }, crate::WorkspaceLifecyclePolicy::default(), now_ms()).unwrap();
        let worker = std::thread::spawn(move || {
            service.store.lock().connection.busy_handler(Some(|attempt| {
                RECONCILE_BLOCKED.store(true, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(1));
                attempt < 5000
            })).unwrap();
            service.reconcile_workspace_port_leases().unwrap();
            service
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !RECONCILE_BLOCKED.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        let blocked = RECONCILE_BLOCKED.load(Ordering::SeqCst);
        tx.commit().unwrap();
        drop(store);
        let service = worker.join().unwrap();
        assert!(blocked, "reconcile must wait for the alias writer's transaction");
        service.registry.forget_imported(&record.workspace_id).unwrap();
        let retained = service.read_workspace_port_lease(&alias.workspace_id, "remote:interleaving").unwrap().unwrap();
        assert_eq!(retained.lease_id, lease.lease_id);
        assert_eq!(retained.registry_workspace_id.as_deref(), Some(alias.workspace_id.as_str()));
    }

    #[cfg(unix)]
    #[test]
    fn port_reconcile_retains_an_offline_symlink_alias_after_other_alias_deletion() {
        let data = TempDir::new().unwrap();
        let paths = TempDir::new().unwrap();
        let root = paths.path().join("target");
        let alias = paths.path().join("alias");
        fs::create_dir(&root).unwrap();
        std::os::unix::fs::symlink(&root, &alias).unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let mut ids = Vec::new();
        for path in [&root, &alias] {
            let record = service.registry.insert_imported(crate::ImportedWorkspaceHint {
                source_root: paths.path().to_string_lossy().into_owned(),
                execution_root: path.to_string_lossy().into_owned(),
                git_common_dir: None,
                branch: None,
            }, now_ms()).unwrap();
            service.ensure_workspace_port_lease(&record.workspace_id, "remote:offline-alias").unwrap();
            ids.push(record.workspace_id);
        }
        let original = service.read_workspace_port_lease(&ids[1], "remote:offline-alias").unwrap().unwrap();
        fs::remove_dir(&root).unwrap();
        let diagnostics = service.reconcile_workspace_port_leases().unwrap();
        assert!(diagnostics.iter().any(|diagnostic| diagnostic.kind == crate::PortLeaseDiagnosticKind::UnresolvedRegistryRoot && diagnostic.detail.contains(&ids[1])));
        service.registry.forget_imported(&ids[0]).unwrap();
        let retained = service.read_workspace_port_lease(&ids[1], "remote:offline-alias").unwrap().unwrap();
        assert_eq!(retained.lease_id, original.lease_id);
        assert_eq!(retained.base_port, original.base_port);
        assert_eq!(retained.registry_workspace_id.as_deref(), Some(ids[1].as_str()));
        assert!(service.registry.get(&ids[1]).unwrap().is_some());
    }

    #[test]
    fn port_policy_set_rejects_invalid_values_without_persisting() {
        let data = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let invalid = crate::WorkspaceLifecyclePolicy {
            port_block_size: 0,
            ..Default::default()
        };
        assert!(service
            .set_workspace_lifecycle_policy(invalid)
            .unwrap_err()
            .contains("portBlockSize"));
        assert!(matches!(
            service.registry.set_policy(invalid),
            Err(crate::RegistryError::PortLease(
                crate::PortLeaseError::InvalidPolicy(_)
            ))
        ));
        assert_eq!(
            service.workspace_lifecycle_policy(),
            crate::WorkspaceLifecyclePolicy::default()
        );
        assert!(service
            .store
            .lock()
            .get_workspace_lifecycle_policy()
            .unwrap()
            .is_none());
    }

    #[test]
    fn port_settle_reuse_and_explicit_idle_release_obey_lifecycle() {
        let data = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        service.set_workspace_lifecycle_policy(crate::ports::isolated_host_policy()).unwrap();
        let mut request = input(&root, "port-task", "port-run");
        request.workspace_key = Some("pipeline".into());
        let run = service.begin_run(request.clone()).unwrap();
        let id = run.workspace_id.as_deref().unwrap();
        let lease = service
            .read_workspace_port_lease(id, crate::HOST_LOOPBACK_NAMESPACE)
            .unwrap()
            .unwrap();
        assert!(matches!(
            service.release_archived_workspace_port_lease(id, crate::HOST_LOOPBACK_NAMESPACE),
            Err(crate::PortLeaseError::WorkspaceBusy { .. })
        ));
        service.settle_run(&run.run_id).unwrap();
        assert_eq!(
            service
                .read_workspace_port_lease(id, crate::HOST_LOOPBACK_NAMESPACE)
                .unwrap(),
            Some(lease.clone())
        );
        request.run_id = "port-run-2".into();
        let next = service.begin_run(request).unwrap();
        assert_eq!(next.workspace_id.as_deref(), Some(id));
        assert_eq!(
            service
                .read_workspace_port_lease(id, crate::HOST_LOOPBACK_NAMESPACE)
                .unwrap(),
            Some(lease.clone())
        );
        service.settle_run(&next.run_id).unwrap();
        let listener = crate::ports::eventually(|| {
            std::net::TcpListener::bind(("127.0.0.1", lease.base_port as u16)).ok()
        });
        assert!(matches!(
            service.release_archived_workspace_port_lease(id, crate::HOST_LOOPBACK_NAMESPACE),
            Err(crate::PortLeaseError::Occupied { .. })
        ));
        drop(listener);
        crate::ports::eventually(|| {
            match service.release_archived_workspace_port_lease(id, crate::HOST_LOOPBACK_NAMESPACE) {
                Ok(()) => Some(()),
                Err(crate::PortLeaseError::Occupied { .. }) => None,
                Err(error) => panic!("release idle lease: {error}"),
            }
        });
        assert!(service
            .read_workspace_port_lease(id, crate::HOST_LOOPBACK_NAMESPACE)
            .unwrap()
            .is_none());
    }

    struct ChannelSink(Mutex<mpsc::Sender<TaskWorkspaceResourceEvent>>);

    fn scratch_input(session_id: &str) -> crate::EnsureSessionScratchWorkspace {
        crate::EnsureSessionScratchWorkspace {
            session_id: session_id.into(),
            bundle_id: None,
        }
    }

    #[test]
    fn scratch_ensure_reuses_content_after_restart_and_isolates_sessions() {
        let data = TempDir::new().unwrap();
        let config = ServiceConfig::new(data.path().into());
        let service = TaskWorkspaceService::open(config.clone()).unwrap();
        let first = service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap();
        assert_eq!(first.leases.len(), 1);
        let lease = &first.leases[0];
        assert_eq!(lease.logical_root_id, "primary");
        let record = service.registry.get(&lease.workspace_id).unwrap().unwrap();
        assert_eq!(record.isolation_kind, IsolationKind::Shadow);
        assert_eq!(record.base, WorkspaceBaseSpec::WorkingState);
        assert_eq!(record.project_id, None);
        assert!(!record.source_root.contains("session-1"));
        fs::write(Path::new(&lease.alias_path).join("keep.txt"), "retained").unwrap();
        drop(service);
        let service = TaskWorkspaceService::open(config).unwrap();
        let again = service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap();
        assert_eq!(first.bundle_id, again.bundle_id);
        assert_eq!(
            fs::read_to_string(Path::new(&again.leases[0].alias_path).join("keep.txt")).unwrap(),
            "retained"
        );
        let other = service
            .ensure_session_scratch_workspace(&scratch_input("session-2"))
            .unwrap();
        assert_ne!(first.bundle_id, other.bundle_id);
        assert_ne!(lease.alias_path, other.leases[0].alias_path);
        assert!(!Path::new(&other.leases[0].alias_path)
            .join("keep.txt")
            .exists());
    }

    #[test]
    fn scratch_ensure_serializes_concurrent_service_instances() {
        let data = TempDir::new().unwrap();
        let first = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let second = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let threads = [first, second]
            .into_iter()
            .map(|service| {
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    service
                        .ensure_session_scratch_workspace(&scratch_input("session-1"))
                        .unwrap()
                })
            })
            .collect::<Vec<_>>();
        let bundles = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(bundles[0].bundle_id, bundles[1].bundle_id);
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        assert_eq!(service.list_workspace_bundles().unwrap().len(), 1);
    }

    #[test]
    fn scratch_ensure_refuses_foreign_and_missing_known_bundles() {
        let data = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap();
        let foreign = crate::EnsureSessionScratchWorkspace {
            session_id: "session-2".into(),
            bundle_id: Some(bundle.bundle_id),
        };
        assert!(service
            .ensure_session_scratch_workspace(&foreign)
            .unwrap_err()
            .contains("another owner"));
        let missing = crate::EnsureSessionScratchWorkspace {
            session_id: "session-2".into(),
            bundle_id: Some("missing".into()),
        };
        assert!(service
            .ensure_session_scratch_workspace(&missing)
            .unwrap_err()
            .contains("not found"));
        assert_eq!(service.list_workspace_bundles().unwrap().len(), 1);
    }

    #[test]
    fn scratch_ensure_refuses_lost_files_without_snapshot() {
        let data = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap();
        fs::remove_dir_all(&bundle.leases[0].alias_path).unwrap();
        assert!(service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap_err()
            .contains("no restorable archive"));
        assert!(!Path::new(&bundle.leases[0].alias_path).exists());
        assert_eq!(service.list_workspace_bundles().unwrap().len(), 1);
    }

    #[test]
    fn scratch_ensure_refuses_a_lost_source_seed() {
        let data = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap();
        let record = service
            .registry
            .get(&bundle.leases[0].workspace_id)
            .unwrap()
            .unwrap();
        fs::remove_dir(&record.source_root).unwrap();
        assert!(service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap_err()
            .contains("source seed is missing"));
        assert!(!Path::new(&record.source_root).exists());
        assert!(Path::new(&record.execution_root).is_dir());
    }

    #[test]
    fn scratch_ensure_refuses_a_non_primary_lease_or_non_shadow_record() {
        let data = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let mut bundle = service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap();
        bundle.leases[0].logical_root_id = "other".into();
        service
            .store
            .lock()
            .delete_bundle_leases(&bundle.bundle_id)
            .unwrap();
        service.store.lock().put_workspace_bundle(&bundle).unwrap();
        assert!(service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap_err()
            .contains("primary lease"));
        bundle.leases[0].logical_root_id = "primary".into();
        service
            .store
            .lock()
            .delete_bundle_leases(&bundle.bundle_id)
            .unwrap();
        service.store.lock().put_workspace_bundle(&bundle).unwrap();
        service
            .registry
            .reclassify_isolation(&bundle.leases[0].workspace_id, IsolationKind::GitWorktree)
            .unwrap();
        assert!(service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap_err()
            .contains("isolation"));
    }

    #[test]
    fn scratch_ensure_restores_archived_content() {
        let data = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap();
        let lease = &bundle.leases[0];
        fs::write(Path::new(&lease.alias_path).join("keep.txt"), "archived").unwrap();
        service
            .archive_managed_workspace(&lease.workspace_id)
            .unwrap();
        assert!(!Path::new(&lease.alias_path).exists());
        let restored = service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap();
        assert_eq!(bundle.bundle_id, restored.bundle_id);
        assert_eq!(
            fs::read_to_string(Path::new(&lease.alias_path).join("keep.txt")).unwrap(),
            "archived"
        );
    }

    #[test]
    fn scratch_archive_restores_ignored_files() {
        let data = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .ensure_session_scratch_workspace(&scratch_input("session-ignored"))
            .unwrap();
        let lease = &bundle.leases[0];
        let root = Path::new(&lease.alias_path);
        fs::write(root.join(".gitignore"), "*.csv\n").unwrap();
        fs::write(root.join(".ignore"), "hidden-output/\n").unwrap();
        fs::create_dir(root.join("hidden-output")).unwrap();
        fs::write(root.join("result.csv"), "name,value\nanswer,42\n").unwrap();
        fs::write(root.join("hidden-output/result.txt"), "ignored output").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("result.csv", root.join("result-link")).unwrap();
        service
            .archive_managed_workspace(&lease.workspace_id)
            .unwrap();
        assert!(!root.exists());
        drop(service);
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        service
            .ensure_session_scratch_workspace(&scratch_input("session-ignored"))
            .unwrap();
        assert_eq!(
            fs::read_to_string(root.join("result.csv")).unwrap(),
            "name,value\nanswer,42\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("hidden-output/result.txt")).unwrap(),
            "ignored output"
        );
        #[cfg(unix)]
        assert_eq!(
            fs::read_link(root.join("result-link")).unwrap(),
            Path::new("result.csv")
        );
    }

    #[test]
    fn scratch_archive_size_limit_keeps_directory_and_active_record() {
        let data = TempDir::new().unwrap();
        let mut config = ServiceConfig::new(data.path().into());
        config.max_blob_bytes = 1;
        let service = TaskWorkspaceService::open(config).unwrap();
        let bundle = service
            .ensure_session_scratch_workspace(&scratch_input("session-large"))
            .unwrap();
        let lease = &bundle.leases[0];
        let root = Path::new(&lease.alias_path);
        fs::write(root.join(".gitignore"), "*.csv\n").unwrap();
        fs::write(root.join("result.csv"), "must not be lost").unwrap();
        let error = service
            .archive_managed_workspace(&lease.workspace_id)
            .unwrap_err();
        assert!(error.contains("capacity exceeded"), "{error}");
        assert_eq!(
            fs::read_to_string(root.join("result.csv")).unwrap(),
            "must not be lost"
        );
        let record = service
            .get_managed_workspace(&lease.workspace_id)
            .unwrap()
            .unwrap();
        assert_eq!(record.state, WorkspaceState::Active);
        assert!(service
            .store
            .lock()
            .get_workspace_archive(&lease.workspace_id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn scratch_archive_refuses_active_bundle_turn_then_preserves_settled_files() {
        let data = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap();
        let lease = &bundle.leases[0];
        let turn = service
            .begin_workspace_bundle_turn(
                &bundle.bundle_id,
                crate::BeginWorkspaceBundleTurn {
                    primary_logical_root_id: "primary".into(),
                    run: input(&data, "scratch-task", "scratch-run"),
                },
            )
            .unwrap();
        let path = Path::new(&lease.alias_path).join("during-turn.txt");
        fs::write(&path, "unfinished").unwrap();
        assert!(service
            .archive_managed_workspace(&lease.workspace_id)
            .unwrap_err()
            .contains("while a turn is active"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "unfinished");
        assert_eq!(
            service
                .registry
                .get(&lease.workspace_id)
                .unwrap()
                .unwrap()
                .state,
            WorkspaceState::Active
        );
        fs::write(&path, "finished").unwrap();
        service
            .settle_workspace_bundle_turn(&turn.bundle_turn_id, RunState::Ready)
            .unwrap();
        service
            .archive_managed_workspace(&lease.workspace_id)
            .unwrap();
        assert!(!path.exists());
        service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "finished");
    }

    #[test]
    fn scratch_archive_refuses_active_borrowed_run_until_aborted() {
        let data = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap();
        let lease = &bundle.leases[0];
        let run = service
            .begin_bundle_run(
                &bundle.bundle_id,
                "primary",
                input(&data, "scratch-task", "scratch-run"),
            )
            .unwrap();
        assert!(service
            .archive_managed_workspace(&lease.workspace_id)
            .unwrap_err()
            .contains("while a turn is active"));
        assert!(Path::new(&lease.alias_path).is_dir());
        service.settle_cancelled_run(&run.run_id).unwrap();
        service
            .archive_managed_workspace(&lease.workspace_id)
            .unwrap();
        assert!(!Path::new(&lease.alias_path).exists());
    }

    #[test]
    fn scratch_archive_and_turn_acquisition_are_serialized() {
        let data = TempDir::new().unwrap();
        let config = ServiceConfig::new(data.path().into());
        let service = TaskWorkspaceService::open(config.clone()).unwrap();
        let archive_service = TaskWorkspaceService::open(config).unwrap();
        let bundle = service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap();
        let workspace_id = bundle.leases[0].workspace_id.clone();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let archive_barrier = Arc::clone(&barrier);
        let archive = std::thread::spawn(move || {
            archive_barrier.wait();
            archive_service.archive_managed_workspace(&workspace_id)
        });
        barrier.wait();
        let turn = service.begin_workspace_bundle_turn(
            &bundle.bundle_id,
            crate::BeginWorkspaceBundleTurn {
                primary_logical_root_id: "primary".into(),
                run: input(&data, "scratch-task", "scratch-run"),
            },
        );
        let archived = archive.join().unwrap();
        match (turn, archived) {
            (Ok(turn), Err(error)) => {
                assert!(error.contains("while a turn is active"));
                assert!(Path::new(&bundle.leases[0].alias_path).is_dir());
                service
                    .abort_workspace_bundle_turn(&turn.bundle_turn_id)
                    .unwrap();
            }
            (Err(error), Ok(record)) => {
                assert!(error.contains("not active"));
                assert_eq!(record.state, WorkspaceState::Archived);
            }
            outcome => {
                panic!("scratch archive and acquisition both succeeded or failed: {outcome:?}")
            }
        }
    }

    #[test]
    fn scratch_ensure_refuses_traversal_and_tampered_alias() {
        let data = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        for session_id in ["../other", "..", "/tmp/other", "a/b", "a\\b", ""] {
            assert!(service
                .ensure_session_scratch_workspace(&scratch_input(session_id))
                .is_err());
        }
        let mut bundle = service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap();
        bundle.leases[0].alias_path = data.path().to_string_lossy().into_owned();
        service.store.lock().put_workspace_bundle(&bundle).unwrap();
        assert!(service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap_err()
            .contains("managed path"));
    }

    #[cfg(unix)]
    #[test]
    fn scratch_ensure_refuses_symlinked_execution_and_source_area() {
        use std::os::unix::fs::symlink;
        let data = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap();
        fs::remove_dir_all(&bundle.leases[0].alias_path).unwrap();
        symlink(outside.path(), &bundle.leases[0].alias_path).unwrap();
        assert!(service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap_err()
            .contains("symlinks"));
        let other_data = TempDir::new().unwrap();
        let service =
            TaskWorkspaceService::open(ServiceConfig::new(other_data.path().into())).unwrap();
        fs::create_dir_all(&service.sources_dir).unwrap();
        symlink(outside.path(), service.sources_dir.join("session-scratch")).unwrap();
        assert!(service
            .ensure_session_scratch_workspace(&scratch_input("session-1"))
            .unwrap_err()
            .contains("symlinks"));
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }

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

    /// Registers a row that claims Git isolation over a root that is not a
    /// worktree, which is exactly the residue the pre-fix bundle path left.
    fn insert_mis_declared_row(
        service: &TaskWorkspaceService,
        source_root: &Path,
        execution_root: &Path,
        state: WorkspaceState,
    ) -> String {
        fs::create_dir_all(execution_root).unwrap();
        let record = service
            .registry
            .insert(
                crate::WorkspaceOwnerType::Session,
                Some("session-1".into()),
                source_root.to_string_lossy().into_owned(),
                git_common_dir(source_root),
                WorkspaceBaseSpec::WorkingState,
                IsolationKind::GitWorktree,
                execution_root.to_string_lossy().into_owned(),
                1,
            )
            .unwrap();
        service
            .registry
            .transition(
                &record.workspace_id,
                record.owner_type,
                record.owner_ref.as_deref(),
                WorkspaceState::Active,
                2,
            )
            .unwrap();
        if state == WorkspaceState::Conflict {
            service
                .registry
                .transition(
                    &record.workspace_id,
                    record.owner_type,
                    record.owner_ref.as_deref(),
                    WorkspaceState::Conflict,
                    3,
                )
                .unwrap();
        }
        record.workspace_id
    }

    /// The row says `gitWorktree`, the root on disk is a plain directory, and
    /// the sweep will never find the worktree it is looking for. Before this it
    /// moved the row to `Conflict` on every pass, and nothing could move it
    /// back: the one `Conflict → Active` transition in this service belongs to
    /// the Bundle handoff retry, which a conversation refused with
    /// `managed workspace is not active` never reaches.
    #[test]
    fn a_row_claiming_a_worktree_it_never_had_is_corrected_to_shadow() {
        let data = TempDir::new().unwrap();
        let repository = TempDir::new().unwrap();
        git2::Repository::init(repository.path()).unwrap();
        seed_git_repository(&repository.path().canonicalize().unwrap());
        let executions = TempDir::new().unwrap();
        let execution_root = executions.path().join("root-1");

        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let workspace_id = insert_mis_declared_row(
            &service,
            &repository.path().canonicalize().unwrap(),
            &execution_root,
            WorkspaceState::Active,
        );

        let outcome = service.reconcile_known_worktrees().unwrap();
        assert!(outcome.reclaimed.contains(&workspace_id));
        assert!(outcome.orphaned.is_empty());

        let record = service.registry.get(&workspace_id).unwrap().unwrap();
        assert_eq!(record.isolation_kind, IsolationKind::Shadow);
        assert_eq!(record.state, WorkspaceState::Active);
        // Metadata only. A shadow root IS the directory, so nothing may be
        // copied, moved or discarded to reach this state.
        assert!(execution_root.is_dir());
    }

    /// The state a conversation is actually stuck in. The row was conflicted by
    /// an earlier sweep, and the sweep is the only thing that can decide it is
    /// consistent again, so it has to look at conflicted rows to do it.
    #[test]
    fn a_conflicted_row_returns_to_active_once_it_is_understood() {
        let data = TempDir::new().unwrap();
        let repository = TempDir::new().unwrap();
        git2::Repository::init(repository.path()).unwrap();
        seed_git_repository(&repository.path().canonicalize().unwrap());
        let executions = TempDir::new().unwrap();
        let execution_root = executions.path().join("root-1");

        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let workspace_id = insert_mis_declared_row(
            &service,
            &repository.path().canonicalize().unwrap(),
            &execution_root,
            WorkspaceState::Conflict,
        );

        service.reconcile_known_worktrees().unwrap();

        let record = service.registry.get(&workspace_id).unwrap().unwrap();
        assert_eq!(record.state, WorkspaceState::Active);
        assert_eq!(record.isolation_kind, IsolationKind::Shadow);
    }

    /// A worktree that really was one and lost its registration is a different
    /// fault, and correcting its isolation would silently change what the root
    /// IS. It stays conflicted so someone can look at it.
    #[test]
    fn a_worktree_that_lost_its_registration_stays_conflicted() {
        let data = TempDir::new().unwrap();
        let repository_parent = TempDir::new().unwrap();
        let repository = repository_parent.path().join("main");
        fs::create_dir_all(&repository).unwrap();
        git2::Repository::init(&repository).unwrap();
        seed_git_repository(&repository);
        let checkout = repository_parent.path().join("linked");

        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let record = service
            .registry
            .insert(
                crate::WorkspaceOwnerType::Session,
                Some("session-1".into()),
                repository
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                git_common_dir(&repository),
                WorkspaceBaseSpec::WorkingState,
                IsolationKind::GitWorktree,
                checkout.to_string_lossy().into_owned(),
                1,
            )
            .unwrap();
        let add = Command::new("git")
            .args(["-C"])
            .arg(&repository)
            .args(["worktree", "add", "--detach"])
            .arg(&checkout)
            .arg("HEAD")
            .output()
            .unwrap();
        assert!(add.status.success());
        service
            .registry
            .transition(
                &record.workspace_id,
                record.owner_type,
                record.owner_ref.as_deref(),
                WorkspaceState::Active,
                2,
            )
            .unwrap();
        // Drop git's administrative record while leaving the checkout, which is
        // what a pruned or hand-deleted `worktrees/` entry leaves behind.
        let admin = repository.join(".git").join("worktrees");
        fs::remove_dir_all(&admin).unwrap();
        assert!(is_linked_worktree_checkout(&checkout));

        let outcome = service.reconcile_known_worktrees().unwrap();
        assert!(outcome.orphaned.contains(&record.workspace_id));
        let after = service.registry.get(&record.workspace_id).unwrap().unwrap();
        assert_eq!(after.state, WorkspaceState::Conflict);
        assert_eq!(after.isolation_kind, IsolationKind::GitWorktree);
    }

    /// `open()` runs the sweep with `?`. One row pointing at a repository that
    /// is no longer on disk used to refuse to start the whole service, taking
    /// every healthy workspace down with it.
    #[test]
    fn a_source_repository_that_is_gone_does_not_refuse_the_service() {
        let data = TempDir::new().unwrap();
        let vanishing = TempDir::new().unwrap();
        let repository = vanishing.path().join("main");
        fs::create_dir_all(&repository).unwrap();
        git2::Repository::init(&repository).unwrap();
        seed_git_repository(&repository);
        let executions = TempDir::new().unwrap();
        let execution_root = executions.path().join("root-1");

        {
            let service =
                TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
            insert_mis_declared_row(
                &service,
                &repository.canonicalize().unwrap(),
                &execution_root,
                WorkspaceState::Active,
            );
        }
        drop(vanishing);

        let reopened = TaskWorkspaceService::open(ServiceConfig::new(data.path().into()));
        assert!(reopened.is_ok(), "{:?}", reopened.err());
        assert!(reopened.unwrap().reconcile_known_worktrees().is_ok());
    }

    #[test]
    fn a_shadow_root_is_not_mistaken_for_a_linked_worktree() {
        let plain = TempDir::new().unwrap();
        assert!(!is_linked_worktree_checkout(plain.path()));

        // A standalone clone carries a `.git` DIRECTORY, which no
        // `git worktree list` would ever have listed either.
        let clone = TempDir::new().unwrap();
        git2::Repository::init(clone.path()).unwrap();
        assert!(!is_linked_worktree_checkout(clone.path()));

        // A `.git` file that points somewhere other than an administrative
        // `worktrees/` entry is a submodule, not a linked worktree.
        let submodule = TempDir::new().unwrap();
        fs::write(
            submodule.path().join(".git"),
            "gitdir: ../.git/modules/sub\n",
        )
        .unwrap();
        assert!(!is_linked_worktree_checkout(submodule.path()));
    }

    /// A freshly `git init`ed directory with no commit: exactly what
    /// `ensure-default-workspace.ts` leaves behind on a first run.
    #[test]
    fn an_uncommitted_repository_is_not_worktree_capable() {
        let repository = TempDir::new().unwrap();
        git2::Repository::init(repository.path()).unwrap();
        let root = repository.path().canonicalize().unwrap();

        // `git worktree add --detach <path> HEAD` answers
        // `fatal: invalid reference: HEAD` here, so claiming Git isolation
        // refuses the run instead of falling back to the Shadow backend.
        assert!(!is_git_root(&root));

        seed_git_repository(&root);
        assert!(is_git_root(&root));
    }

    #[test]
    fn a_plain_directory_is_not_worktree_capable_either() {
        let plain = TempDir::new().unwrap();
        assert!(!is_git_root(&plain.path().canonicalize().unwrap()));
    }

    /// The bundle path had its own copy of the isolation decision, and only the
    /// single-root one was ever taught about an unborn HEAD. A chat turn
    /// acquires a BUNDLE, so the fix that shipped never reached the path that
    /// needed it: the row was written `gitWorktree`, no worktree was created,
    /// and reconciliation later moved the workspace to `Conflict`, which wedged
    /// the conversation for good.
    #[test]
    fn a_bundle_root_over_an_uncommitted_repository_falls_back_to_shadow() {
        let repository = TempDir::new().unwrap();
        git2::Repository::init(repository.path()).unwrap();
        let root = repository.path().canonicalize().unwrap();

        let inspect = |root: &Path| {
            inspect_bundle_root(&crate::WorkspaceBundleRootInput {
                logical_root_id: "root-1".into(),
                role: crate::WorkspaceRootRole::Primary,
                source_root: root.to_string_lossy().into_owned(),
            })
            .expect("inspect")
        };

        let unborn = inspect(&root);
        assert_eq!(unborn.isolation, IsolationKind::Shadow);
        assert!(unborn.repository_root.is_none());
        assert!(unborn.git_common_dir.is_none());

        // It upgrades itself: the first commit makes later bundles real
        // worktrees over the same directory.
        seed_git_repository(&root);
        let born = inspect(&root);
        assert_eq!(born.isolation, IsolationKind::GitWorktree);
        assert_eq!(born.repository_root.as_deref(), Some(root.as_path()));
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
    fn included_files_arrive_byte_for_byte_whether_or_not_the_clone_took() {
        // The copy-on-write path and the fallback must be indistinguishable to
        // the worktree: a reflink that quietly produced a truncated or empty
        // file would look like a build that mysteriously stopped finding its
        // fixtures.
        let source_dir = TempDir::new().unwrap();
        let target_dir = TempDir::new().unwrap();
        let source = source_dir.path().join("fixture.bin");
        let target = target_dir.path().join("fixture.bin");
        let payload: Vec<u8> = (0..64 * 1024).map(|index| (index % 251) as u8).collect();
        fs::write(&source, &payload).unwrap();

        copy_file_cow(&source, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), payload);
    }

    #[test]
    fn an_included_file_overwrites_a_stale_copy_from_a_previous_acquisition() {
        // `COPYFILE_CLONE` implies `COPYFILE_EXCL`, so this is the case that
        // would silently keep the old content if the existing target were not
        // removed first — and the worktree would run against a `.env` from a
        // branch nobody is on any more.
        let source_dir = TempDir::new().unwrap();
        let target_dir = TempDir::new().unwrap();
        let source = source_dir.path().join(".env");
        let target = target_dir.path().join(".env");
        fs::write(&source, "TOKEN=new\n").unwrap();
        fs::write(&target, "TOKEN=stale-and-longer\n").unwrap();

        copy_file_cow(&source, &target).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "TOKEN=new\n");
    }

    #[test]
    fn a_clone_across_filesystems_still_produces_the_file() {
        // The clone fails for ordinary reasons — a different filesystem, no
        // reflink support, an unimplemented ioctl — and every one of them must
        // degrade to a copy rather than to a missing include. Forced here by
        // pointing at a target directory that does not exist yet, which no
        // clone syscall will create.
        let source_dir = TempDir::new().unwrap();
        let target_dir = TempDir::new().unwrap();
        let source = source_dir.path().join("data.json");
        fs::write(&source, "{}").unwrap();
        let nested = target_dir.path().join("missing");
        assert!(copy_file_cow(&source, &nested.join("data.json")).is_err());

        fs::create_dir_all(&nested).unwrap();
        copy_file_cow(&source, &nested.join("data.json")).unwrap();
        assert_eq!(fs::read_to_string(nested.join("data.json")).unwrap(), "{}");
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
    fn registry_integration_worktree_stays_host_owned() {
        let data = TempDir::new().unwrap();
        let repository = TempDir::new().unwrap();
        let worktrees = TempDir::new().unwrap();
        let integration = worktrees.path().join("integration");
        git2::Repository::init(repository.path()).unwrap();
        seed_git_repository(repository.path());
        let add = Command::new("git")
            .arg("-C")
            .arg(repository.path())
            .args([
                "worktree",
                "add",
                "--detach",
                "--lock",
                "--reason",
                "cognia-integration:repo-key",
            ])
            .arg(&integration)
            .output()
            .unwrap();
        assert!(
            add.status.success(),
            "{}",
            String::from_utf8_lossy(&add.stderr)
        );
        {
            let service =
                TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
            service
                .bind_workspace_source("repository:integration:test", repository.path(), 10)
                .unwrap();
            let outcome = service.reconcile_known_worktrees().unwrap();
            assert!(outcome.imported.is_empty());
            assert!(service.list_managed_workspaces().unwrap().is_empty());

            let error = service
                .ensure_manual_worktree_removal_allowed(repository.path(), &integration)
                .unwrap_err();
            assert!(error.contains("owned by the host integration queue"));
            let environment_id = format!("git:{}", storage_key(&normalized_path_key(&integration)));
            let error = service
                .adopt_workspace_environment(&environment_id, repository.path(), &integration)
                .unwrap_err();
            assert!(error.contains("host integration worktrees cannot be adopted"));
            assert!(service.list_managed_workspaces().unwrap().is_empty());
        }
        let reopened = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        assert!(reopened.list_managed_workspaces().unwrap().is_empty());
        assert_eq!(
            managed_git_lock_reason(repository.path(), &integration).unwrap(),
            Some("cognia-integration:repo-key".into())
        );
        assert!(integration.join("README.md").is_file());
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
            self_contained: false,
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
    fn an_execution_root_override_moves_working_copies_out_of_the_data_dir() {
        let data = TempDir::new().unwrap();
        let moved = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        fs::write(workspace.path().join("a.txt"), "a\n").unwrap();
        let mut config = ServiceConfig::new(data.path().into());
        config.execution_root = Some(moved.path().into());
        assert_eq!(config.execution_dir(), moved.path().join("executions"));
        let service = TaskWorkspaceService::open(config).unwrap();
        let run = service
            .begin_run(input(&workspace, "task-moved", "run-moved"))
            .unwrap();
        assert!(
            Path::new(&run.execution_root).starts_with(moved.path().join("executions")),
            "{}",
            run.execution_root
        );
        assert!(!data
            .path()
            .join("task-workspaces")
            .join("executions")
            .exists());
        service.settle_run("run-moved").unwrap();
    }

    #[test]
    fn execution_root_values_are_absolute_or_absent() {
        assert_eq!(execution_root_from(None).unwrap(), None);
        assert_eq!(execution_root_from(Some("  ")).unwrap(), None);
        assert_eq!(
            execution_root_from(Some("/workspaces/.cognia-task-workspaces")).unwrap(),
            Some(PathBuf::from("/workspaces/.cognia-task-workspaces"))
        );
        assert!(execution_root_from(Some("relative/dir")).is_err());
        assert_eq!(
            ServiceConfig::new("/data".into()).execution_dir(),
            PathBuf::from("/data/task-workspaces/executions")
        );
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

    /// A `remoteDefault` acquisition used to hit the network every time. The
    /// second call inside the window must not run `git` at all — proven here by
    /// breaking `origin` in between: without the throttle the second call would
    /// try to fetch a remote that no longer resolves and fail.
    #[test]
    fn fetching_origin_is_skipped_inside_the_freshness_window() {
        use git2::Repository;

        let origin = TempDir::new().unwrap();
        let origin_repo = Repository::init_bare(origin.path()).unwrap();
        drop(origin_repo);

        let clone_dir = TempDir::new().unwrap();
        let repo = Repository::init(clone_dir.path()).unwrap();
        repo.remote("origin", &origin.path().to_string_lossy())
            .unwrap();
        drop(repo);

        fetch_origin_throttled(clone_dir.path()).expect("first fetch should reach the remote");

        // Point origin at a path that does not exist. A real fetch now fails.
        let repo = Repository::open(clone_dir.path()).unwrap();
        repo.remote_set_url("origin", "/nonexistent/definitely-not-a-repo")
            .unwrap();
        drop(repo);

        fetch_origin_throttled(clone_dir.path())
            .expect("the second call inside the window must not fetch");
    }

    /// The lock is keyed by Git common directory, not by workspace root.
    ///
    /// A repository and every managed worktree cut from it share one
    /// administrative area — one `index.lock`, one `worktrees/` directory, one
    /// ref store — so they have to share one mutex. Keying by root would hand
    /// each worktree its own lock and protect nothing.
    #[test]
    fn the_git_admin_lock_is_shared_across_a_repository_and_its_worktrees() {
        use git2::Repository;

        let data = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();

        let repo_dir = TempDir::new().unwrap();
        Repository::init(repo_dir.path()).unwrap();
        let nested = repo_dir.path().join("sub/dir");
        fs::create_dir_all(&nested).unwrap();

        let other_dir = TempDir::new().unwrap();
        Repository::init(other_dir.path()).unwrap();

        let root_lock = service.git_admin_lock(repo_dir.path()).unwrap();
        let nested_lock = service.git_admin_lock(&nested).unwrap();
        let other_lock = service.git_admin_lock(other_dir.path()).unwrap();

        assert!(
            Arc::ptr_eq(&root_lock, &nested_lock),
            "paths inside one repository must share a lock"
        );
        assert!(
            !Arc::ptr_eq(&root_lock, &other_lock),
            "a separate repository must not be serialized behind this one"
        );

        // A directory outside any repository has no administrative state to
        // guard, so there is nothing to lock.
        let bare = TempDir::new().unwrap();
        assert!(service.git_admin_lock(bare.path()).is_none());
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
        let sources = provenance_line_sources(&service, workspace.path(), "story.txt");
        assert_eq!(sources[1].run_id.as_deref(), Some("run-merge"));
        assert_eq!(sources[0].origin, crate::provenance::ProvenanceOrigin::Unknown);
        assert_eq!(sources[2].origin, crate::provenance::ProvenanceOrigin::Unknown);

        let undone = service.undo_patch_set("run-merge").unwrap();
        assert_eq!(undone.state, crate::PatchState::Reverted);
        assert_eq!(
            fs::read_to_string(workspace.path().join("story.txt")).unwrap(),
            "one\ntwo\nuser three\n"
        );
        assert!(provenance_line_sources(&service, workspace.path(), "story.txt")
            .iter().all(|source| source.run_id.is_none()));
    }

    fn settle_git(root: &Path, args: &[&str]) -> String {
        crate::changeset::git_text(root, args).unwrap()
    }

    fn settle_text_regression(dirty_baseline: bool, commit: bool) {
        let data = TempDir::new().unwrap();
        let source = TempDir::new().unwrap();
        git2::Repository::init(source.path()).unwrap();
        seed_git_repository(source.path());
        fs::write(source.path().join("tracked.txt"), "committed baseline\n").unwrap();
        fs::write(
            source.path().join("unrelated.bin"),
            vec![b'x'; 2 * 1024 * 1024],
        )
        .unwrap();
        settle_git(source.path(), &["add", "-A"]);
        settle_git(source.path(), &["commit", "-m", "tracked baseline"]);
        let unrelated = settle_git(source.path(), &["rev-parse", "HEAD:unrelated.bin"]);
        if dirty_baseline {
            fs::write(source.path().join("tracked.txt"), "user baseline\n").unwrap();
        }
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let mut request = input(&source, "settle-text", "settle-text-run");
        request.tracking_policy.auto_detect = false;
        let run = service.begin_run(request).unwrap();
        let before = service
            .store
            .lock()
            .get_run::<WorkspaceSnapshot>(&run.run_id)
            .unwrap()
            .unwrap()
            .1
            .entries["tracked.txt"]
            .hash
            .clone();
        let execution = Path::new(&run.execution_root);
        fs::write(execution.join("tracked.txt"), "agent after\n").unwrap();
        if commit {
            settle_git(execution, &["add", "-A"]);
            settle_git(execution, &["commit", "-m", "agent changes"]);
        }
        let after = settle_git(execution, &["hash-object", "tracked.txt"]);
        let settled = service.settle_run(&run.run_id);
        assert!(
            settled.is_ok(),
            "dirty={dirty_baseline}, commit={commit}, before={before}, after={after}: {settled:?}"
        );
        assert_eq!(settled.unwrap().len(), 1);
        assert_eq!(
            service.store.lock().get_blob(&unrelated, now_ms()),
            Err(format!("missing blob {unrelated}"))
        );
        drop(service);
        let reopened = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        assert_eq!(
            reopened.apply_patch_set(&run.run_id, &[]).unwrap().state,
            crate::PatchState::Applied
        );
        assert_eq!(
            fs::read(source.path().join("tracked.txt")).unwrap(),
            b"agent after\n"
        );
        assert_eq!(
            reopened.undo_patch_set(&run.run_id).unwrap().state,
            crate::PatchState::Reverted
        );
        assert_eq!(
            fs::read(source.path().join("tracked.txt")).unwrap(),
            if dirty_baseline {
                b"user baseline\n".as_slice()
            } else {
                b"committed baseline\n".as_slice()
            }
        );
        assert_eq!(
            reopened.store.lock().get_blob(&unrelated, now_ms()),
            Err(format!("missing blob {unrelated}"))
        );
    }

    #[test]
    fn settle_git_clean_baseline_committed_edit_retains_patch_blobs() {
        settle_text_regression(false, true);
    }

    #[test]
    fn settle_git_dirty_baseline_committed_edit_retains_patch_blobs() {
        settle_text_regression(true, true);
    }

    #[test]
    fn settle_git_clean_baseline_uncommitted_edit_retains_patch_blobs() {
        settle_text_regression(false, false);
    }

    #[test]
    fn settle_blob_capacity_failure_publishes_nothing_and_can_be_retried() {
        let data = TempDir::new().unwrap();
        let source = TempDir::new().unwrap();
        git2::Repository::init(source.path()).unwrap();
        seed_git_repository(source.path());
        let mut config = ServiceConfig::new(data.path().into());
        config.max_blob_bytes = 1;
        let service = TaskWorkspaceService::open(config).unwrap();
        let mut request = input(&source, "settle-capacity", "settle-capacity-run");
        request.tracking_policy.auto_detect = false;
        let run = service.begin_run(request).unwrap();
        let execution = Path::new(&run.execution_root);
        fs::write(execution.join("README.md"), "committed agent edit\n").unwrap();
        settle_git(execution, &["add", "-A"]);
        settle_git(execution, &["commit", "-m", "agent edit"]);
        let error = service.settle_run(&run.run_id).unwrap_err();
        assert!(
            error.starts_with("task workspace ledger capacity exceeded:"),
            "{error}"
        );
        assert_eq!(
            service
                .store
                .lock()
                .get_run::<WorkspaceSnapshot>(&run.run_id)
                .unwrap()
                .unwrap()
                .0
                .state,
            RunState::Settling
        );
        assert!(service.list_resources(&run.task_id).unwrap().is_empty());
        assert!(service.get_patch_set(&run.run_id).unwrap().is_none());
        assert_eq!(service.get_task(&run.task_id).unwrap().unwrap().revision, 0);
        drop(service);
        let reopened = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let changes = reopened.settle_run(&run.run_id).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(
            reopened.get_task(&run.task_id).unwrap().unwrap().revision,
            1
        );
        assert_eq!(
            reopened.apply_patch_set(&run.run_id, &[]).unwrap().state,
            crate::PatchState::Applied
        );
        assert_eq!(
            fs::read(source.path().join("README.md")).unwrap(),
            b"committed agent edit\n"
        );
        assert_eq!(
            reopened.undo_patch_set(&run.run_id).unwrap().state,
            crate::PatchState::Reverted
        );
        assert_eq!(
            fs::read(source.path().join("README.md")).unwrap(),
            b"seed\n"
        );
    }

    #[test]
    fn settle_patch_blob_retention_preserves_storage_errors_and_missing_objects() {
        for fault in ["read", "decompress", "missing-object"] {
            let data = TempDir::new().unwrap();
            let source = TempDir::new().unwrap();
            git2::Repository::init(source.path()).unwrap();
            seed_git_repository(source.path());
            let service =
                TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
            let mut request = input(&source, "settle-storage", "settle-storage-run");
            request.tracking_policy.auto_detect = false;
            let run = service.begin_run(request).unwrap();
            let execution = Path::new(&run.execution_root);
            fs::write(execution.join("asset.png"), vec![0; 10_000]).unwrap();
            settle_git(execution, &["add", "-A"]);
            settle_git(execution, &["commit", "-m", "binary output"]);
            let mut changes = service.settle_run(&run.run_id).unwrap();
            changes.push(changes[0].clone());
            // Existing content must not require a Git repository, even when
            // multiple patch entries reference the same object.
            persist_patch_blobs(
                &mut service.store.lock(),
                &changes,
                &source.path().join("not-a-repository"),
                now_ms(),
            )
            .unwrap();
            let hash = changes[0].hash.as_deref().unwrap();
            let blob = data
                .path()
                .join("task-workspaces/blobs")
                .join(format!("{hash}.gz"));
            assert!(blob.is_file());
            match fault {
                "read" => fs::remove_file(&blob).unwrap(),
                "decompress" => fs::write(&blob, b"invalid gzip").unwrap(),
                "missing-object" => {
                    let hash = "f".repeat(40);
                    for change in &mut changes {
                        change.hash = Some(hash.clone());
                    }
                }
                _ => unreachable!(),
            }
            let error =
                persist_patch_blobs(&mut service.store.lock(), &changes, execution, now_ms())
                    .unwrap_err();
            match fault {
                "read" => {
                    assert!(error.starts_with("read blob "), "{error}");
                    assert!(!blob.exists());
                }
                "decompress" => {
                    assert!(error.starts_with("decompress blob "), "{error}");
                    assert_eq!(fs::read(&blob).unwrap(), b"invalid gzip");
                }
                "missing-object" => assert_eq!(error, format!("missing blob {}", "f".repeat(40))),
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn settle_git_patch_kinds_apply_and_undo_after_reopening() {
        let mut failures = Vec::new();
        let kinds = [
            "added",
            "deleted",
            "renamed",
            "binary",
            #[cfg(unix)]
            "symlink",
        ];
        for kind in kinds {
            let data = TempDir::new().unwrap();
            let source = TempDir::new().unwrap();
            git2::Repository::init(source.path()).unwrap();
            seed_git_repository(source.path());
            let file_name = if kind == "binary" {
                "change.png"
            } else {
                "change"
            };
            let path = source.path().join(file_name);
            match kind {
                "added" => {}
                "binary" => fs::write(&path, [0, 1, 2, 3]).unwrap(),
                #[cfg(unix)]
                "symlink" => std::os::unix::fs::symlink("target-one", &path).unwrap(),
                _ => fs::write(&path, "original\n").unwrap(),
            }
            settle_git(source.path(), &["add", "-A"]);
            settle_git(
                source.path(),
                &["commit", "--allow-empty", "-m", "patch baseline"],
            );
            let service =
                TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
            let mut request = input(&source, "settle-kind", "settle-kind-run");
            request.tracking_policy.auto_detect = false;
            let run = service.begin_run(request).unwrap();
            let execution = Path::new(&run.execution_root);
            let changed = execution.join(file_name);
            match kind {
                "added" => fs::write(&changed, "created\n").unwrap(),
                "deleted" => fs::remove_file(&changed).unwrap(),
                "renamed" => fs::rename(&changed, execution.join("renamed")).unwrap(),
                "binary" => fs::write(&changed, [0, 4, 5, 6]).unwrap(),
                #[cfg(unix)]
                "symlink" => {
                    fs::remove_file(&changed).unwrap();
                    std::os::unix::fs::symlink("target-two", &changed).unwrap();
                }
                _ => unreachable!(),
            }
            settle_git(execution, &["add", "-A"]);
            settle_git(execution, &["commit", "-m", "agent change"]);
            let result = (|| -> Result<(), String> {
                let changes = service
                    .settle_run(&run.run_id)
                    .map_err(|error| format!("settle: {error}"))?;
                let expected = match kind {
                    "added" => ChangeKind::Created,
                    "deleted" => ChangeKind::Deleted,
                    "renamed" => ChangeKind::Renamed,
                    _ => ChangeKind::Modified,
                };
                assert_eq!(changes.len(), 1, "{kind}: {changes:?}");
                assert_eq!(changes[0].kind, expected, "{kind}");
                if kind == "binary" {
                    assert!(changes[0].binary);
                }
                drop(service);
                let reopened = TaskWorkspaceService::open(ServiceConfig::new(data.path().into()))?;
                let applied = reopened
                    .apply_patch_set(&run.run_id, &[])
                    .map_err(|error| format!("apply: {error}"))?;
                assert_eq!(
                    applied.state,
                    crate::PatchState::Applied,
                    "{kind}: {applied:?}"
                );
                match kind {
                    "added" => assert_eq!(fs::read(&path).unwrap(), b"created\n"),
                    "deleted" => assert!(!path.exists()),
                    "renamed" => {
                        assert!(!path.exists());
                        assert_eq!(
                            fs::read(source.path().join("renamed")).unwrap(),
                            b"original\n"
                        );
                    }
                    "binary" => assert_eq!(fs::read(&path).unwrap(), [0, 4, 5, 6]),
                    #[cfg(unix)]
                    "symlink" => {
                        assert_eq!(fs::read_link(&path).unwrap(), PathBuf::from("target-two"))
                    }
                    _ => unreachable!(),
                }
                let undone = reopened
                    .undo_patch_set(&run.run_id)
                    .map_err(|error| format!("undo: {error}"))?;
                assert_eq!(
                    undone.state,
                    crate::PatchState::Reverted,
                    "{kind}: {undone:?}"
                );
                match kind {
                    "added" => assert!(!path.exists()),
                    "binary" => assert_eq!(fs::read(&path).unwrap(), [0, 1, 2, 3]),
                    #[cfg(unix)]
                    "symlink" => {
                        assert_eq!(fs::read_link(&path).unwrap(), PathBuf::from("target-one"))
                    }
                    _ => assert_eq!(fs::read(&path).unwrap(), b"original\n"),
                }
                assert!(!source.path().join("renamed").exists());
                Ok(())
            })();
            if let Err(error) = result {
                failures.push(format!("{kind}: {error}"));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
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
        assert_eq!(provenance_line_sources(&service, workspace.path(), "story.txt")[1].run_id.as_deref(), Some("run-conflict"));
        service.undo_patch_set("run-conflict").unwrap();
        assert_eq!(
            fs::read_to_string(workspace.path().join("story.txt")).unwrap(),
            "one\nuser\n"
        );
        assert!(provenance_line_sources(&service, workspace.path(), "story.txt")
            .iter().all(|source| source.run_id.is_none()));
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
        for selected_hunk in [0, 1] {
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
            // The first hunk changes line count. Selecting only the second
            // must not use the offset of that unselected earlier insertion.
            let changed = baseline
                .replace("line 2\n", "agent line 2\nextra agent line\n")
                .replace("line 22\n", "agent line 22\n");
            fs::write(Path::new(&run.execution_root).join("many.txt"), changed).unwrap();
            service.settle_run("run-hunks").unwrap();

            let patch = service.get_patch_set("run-hunks").unwrap().unwrap();
            assert_eq!(patch.files[0].hunks.len(), 2);
            assert_eq!(patch.files[0].hunks[0].additions, 2);
            assert_eq!(patch.files[0].hunks[0].deletions, 1);
            let hunk_id = patch.files[0].hunks[selected_hunk].id.clone();
            let outcome = service
                .apply_patch_set(
                    "run-hunks",
                    &[crate::PatchSelection {
                        path: "many.txt".into(),
                        hunk_ids: vec![hunk_id],
                    }],
                )
                .unwrap();
            assert_eq!(outcome.state, crate::PatchState::Applied);
            let applied = fs::read_to_string(workspace.path().join("many.txt")).unwrap();
            let expected = if selected_hunk == 0 {
                baseline.replace("line 2\n", "agent line 2\nextra agent line\n")
            } else {
                baseline.replace("line 22\n", "agent line 22\n")
            };
            assert_eq!(applied, expected);
            let applied_patch = service.get_patch_set("run-hunks").unwrap().unwrap();
            assert!(applied_patch.applied_selection_known);
            assert_eq!(applied_patch.applied_selection.len(), 1);
            assert_eq!(applied_patch.applied_selection[0].hunk_ids.len(), 1);
            let sources = provenance_line_sources(&service, workspace.path(), "many.txt");
            for (index, source) in sources.iter().enumerate() {
                let selected = if selected_hunk == 0 { index == 1 || index == 2 } else { index == 21 };
                assert_eq!(source.run_id.as_deref(), selected.then_some("run-hunks"), "hunk {selected_hunk}, line {}", index + 1);
            }
            assert_eq!(provenance_adoption_states(&service, "run-hunks"), vec!["applied", "discarded", "partial", "pending"]);
        }
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
        // Provenance pins intentionally retain the applied transition bodies;
        // pruning must still collect unrelated, unreferenced blobs.
        service.store.lock().put_blob("unreferenced-prune-blob", b"unused", now_ms()).unwrap();
        let pruned = service.prune().unwrap();
        assert_eq!(pruned.removed_task_ids, vec!["task-prune"]);
        assert!(pruned.removed_blob_count > 0);
        assert!(pruned.reclaimed_bytes > 0);
        assert!(service.get_task("task-prune").unwrap().is_none());
        assert!(!Path::new(&run.execution_root).exists());
        assert!(crate::ports::list(&service.store.lock().connection)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn provenance_survives_real_service_task_prune() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let mut config = ServiceConfig::new(data.path().into());
        config.retention = Duration::ZERO;
        let service = TaskWorkspaceService::open(config).unwrap();
        let mut request = input(&workspace, "task-provenance", "run-provenance");
        request.session_id = "session".into();
        service.begin_run(request).unwrap();
        service.settle_run("run-provenance").unwrap();
        service.apply_patch_set("run-provenance", &[]).unwrap();
        let (root, resource, version) = crate::provenance::tests::seed_at_root(&mut service.store.lock(), workspace.path().to_str().unwrap());

        let pruned = service.prune().unwrap();
        assert_eq!(pruned.removed_task_ids, vec!["task-provenance"]);
        assert!(service.get_task("task-provenance").unwrap().is_none());
        assert!(service.list_runs("task-provenance").unwrap().is_empty());
        let mut store = service.store.lock();
        let provenance = store.provenance();
        assert_eq!(provenance.current_version(&root, "notes.txt").unwrap().unwrap().version_id, version.version_id);
        assert_eq!(provenance.segments(&root, &version.version_id, 1..2, None, 100).unwrap().items, version.segments);
        assert_eq!(provenance.source(&root, "source").unwrap().unwrap().assistant_message_id.as_deref(), Some("message"));
        assert_eq!(provenance.path_history(&root, &resource, None, 100).unwrap().items.len(), 1);
        assert_eq!(provenance.adoption_history(&root, "source", None, 100).unwrap().items.len(), 1);
        assert_eq!(store.get_blob("provenance-body", 2).unwrap(), b"agent line\n");
    }

    fn provenance_line_sources(
        service: &TaskWorkspaceService,
        root: &Path,
        path: &str,
    ) -> Vec<crate::provenance::ProvenanceSource> {
        let mut store = service.store.lock();
        let root_id: String = store.connection.query_row(
            "SELECT root_id FROM provenance_roots WHERE canonical_root=?1 AND stream_key='working-tree'",
            [fs::canonicalize(root).unwrap().to_str().unwrap()],
            |row| row.get(0),
        ).unwrap();
        let provenance = store.provenance();
        let version = provenance.current_version(&root_id, path).unwrap().unwrap();
        provenance.segments(&root_id, &version.version_id, 1..version.line_count + 1, None, 2_000)
            .unwrap().items.into_iter().flat_map(|segment| {
                let source = provenance.source(&root_id, &segment.provenance_id).unwrap().unwrap();
                (segment.start_line..segment.end_line).map(move |_| source.clone())
            }).collect()
    }

    fn provenance_adoption_states(
        service: &TaskWorkspaceService,
        run_id: &str,
    ) -> Vec<String> {
        let store = service.store.lock();
        let mut query = store.connection.prepare(
            "SELECT DISTINCT e.state FROM provenance_adoption_events e JOIN provenance_sources s ON s.provenance_id=e.provenance_id WHERE s.run_id=?1 ORDER BY e.state",
        ).unwrap();
        query.query_map([run_id], |row| row.get(0)).unwrap()
            .collect::<Result<Vec<_>, _>>().unwrap()
    }

    #[test]
    fn provenance_tool_receipts_capture_sources_that_survive_task_prune() {
        for receipt_tool in [None, Some("trusted-tool"), Some("inferred")] {
            let with_receipt = receipt_tool.is_some();
            let tool = receipt_tool.unwrap_or("trusted-tool");
            let data = TempDir::new().unwrap();
            let workspace = TempDir::new().unwrap();
            fs::write(workspace.path().join("result.txt"), "before\n").unwrap();
            let mut config = ServiceConfig::new(data.path().into());
            config.retention = Duration::ZERO;
            let service = TaskWorkspaceService::open(config).unwrap();
            let mut request = input(&workspace, "task-receipt", "run-receipt");
            request.session_id = "receipt-session".into();
            request.execution_run_id = Some("execution".into());
            request.trace_id = Some("trace".into());
            request.turn_id = Some("turn".into());
            request.attempt_id = Some("attempt".into());
            let run = service.begin_run(request).unwrap();
            fs::write(Path::new(&run.execution_root).join("result.txt"), "after\n").unwrap();
            let receipt = crate::provenance::ToolMutationReceipt {
                run_id: run.run_id.clone(),
                tool_call_id: tool.into(),
                ordinal: 1,
                path: "result.txt".into(),
                before_hash: Some(crate::provenance::content_hash(b"before\n")),
                after_hash: Some(crate::provenance::content_hash(b"after\n")),
            };
            service.record_tool_event_with_receipt(
                &run.run_id, "result.txt", None, ResourceEventKind::Modified,
                Some(tool), with_receipt.then_some(&receipt),
            ).unwrap();
            service.settle_run(&run.run_id).unwrap();
            assert!(provenance_adoption_states(&service, &run.run_id).contains(&"pending".into()));
            service.apply_patch_set(&run.run_id, &[]).unwrap();
            let before_prune = provenance_line_sources(&service, workspace.path(), "result.txt");
            assert_eq!(before_prune.len(), 1);
            let source = &before_prune[0];
            assert_eq!(source.run_id.as_deref(), Some(run.run_id.as_str()));
            assert_eq!(source.task_id.as_deref(), Some("task-receipt"));
            assert_eq!(source.session_id.as_deref(), Some("receipt-session"));
            assert_eq!(source.agent_id.as_deref(), Some(run.agent_id.as_str()));
            assert_eq!(source.execution_run_id.as_deref(), Some("execution"));
            assert_eq!(source.trace_id.as_deref(), Some("trace"));
            assert_eq!(source.turn_id.as_deref(), Some("turn"));
            assert_eq!(source.details["agentKind"].as_str(), Some(run.agent_kind.as_str()));
            assert_eq!(source.details["attemptId"].as_str(), Some("attempt"));
            assert_eq!(source.tool_call_id.as_deref(), with_receipt.then_some(tool));
            assert_eq!(source.evidence, if with_receipt {
                crate::provenance::OriginEvidence::ConfirmedReceipt
            } else {
                crate::provenance::OriginEvidence::Inferred
            });
            let pruned = service.prune().unwrap();
            assert_eq!(pruned.removed_task_ids, vec!["task-receipt"]);
            assert!(service.get_task("task-receipt").unwrap().is_none());
            assert_eq!(provenance_line_sources(&service, workspace.path(), "result.txt"), before_prune);
        }
    }

    #[test]
    fn provenance_keep_current_discards_without_claiming_a_file_write() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        fs::write(workspace.path().join("story.txt"), "before\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let run = service.begin_run(input(&workspace, "task-discard", "run-discard")).unwrap();
        fs::write(Path::new(&run.execution_root).join("story.txt"), "agent\n").unwrap();
        fs::write(workspace.path().join("story.txt"), "human\n").unwrap();
        service.settle_run(&run.run_id).unwrap();
        assert_eq!(service.apply_patch_set(&run.run_id, &[]).unwrap().state, crate::PatchState::Conflict);
        assert_eq!(provenance_adoption_states(&service, &run.run_id), vec!["pending"]);
        let versions_before: i64 = service.store.lock().connection.query_row(
            "SELECT COUNT(*) FROM resource_versions", [], |row| row.get(0),
        ).unwrap();
        service.resolve_conflict(&run.run_id, &[], crate::ConflictResolution::KeepCurrent).unwrap();
        assert_eq!(fs::read(workspace.path().join("story.txt")).unwrap(), b"human\n");
        assert_eq!(provenance_adoption_states(&service, &run.run_id), vec!["discarded", "pending"]);
        let versions_after: i64 = service.store.lock().connection.query_row(
            "SELECT COUNT(*) FROM resource_versions", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(versions_before, versions_after);
    }

    #[test]
    fn provenance_receipt_channel_rejects_unknown_runs_and_event_mismatch() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let hash = crate::provenance::content_hash(b"body\n");
        assert!(service.record_tool_mutation_receipt(
            "missing", "tool", 1, "result.txt", None, Some(&hash),
        ).unwrap_err().contains("unknown task run"));
        let run = service.begin_run(input(&workspace, "task-validation", "run-validation")).unwrap();
        assert!(service.record_tool_mutation_receipt(
            &run.run_id, "tool", 1, "../escape", None, Some(&hash),
        ).is_err());
        let receipt = crate::provenance::ToolMutationReceipt {
            run_id: run.run_id.clone(), tool_call_id: "another-tool".into(), ordinal: 1,
            path: "result.txt".into(), before_hash: None, after_hash: Some(hash.clone()),
        };
        assert!(service.record_tool_event_with_receipt(
            &run.run_id, "result.txt", None, ResourceEventKind::Created, Some("tool"), Some(&receipt),
        ).unwrap_err().contains("does not match"));
        service.record_tool_mutation_receipt(&run.run_id, "tool", 1, "result.txt", None, Some(&hash)).unwrap();
        assert_eq!(service.store.lock().provenance().matching_tool_mutation_receipt(
            &run.run_id, "result.txt", None, Some(&hash),
        ).unwrap().unwrap().tool_call_id, "tool");
    }

    #[test]
    fn provenance_capture_failure_does_not_fail_apply() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        fs::write(workspace.path().join("story.txt"), "before\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let run = service.begin_run(input(&workspace, "task-gap", "run-gap")).unwrap();
        fs::write(Path::new(&run.execution_root).join("story.txt"), "agent\n").unwrap();
        service.settle_run(&run.run_id).unwrap();
        service.store.lock().connection.execute_batch(
            "CREATE TRIGGER fail_provenance_version BEFORE INSERT ON resource_versions BEGIN SELECT RAISE(FAIL, 'injected provenance capture failure'); END;",
        ).unwrap();
        let outcome = service.apply_patch_set(&run.run_id, &[]).unwrap();
        assert_eq!(outcome.state, crate::PatchState::Applied);
        assert_eq!(fs::read(workspace.path().join("story.txt")).unwrap(), b"agent\n");
        assert_eq!(service.get_patch_set(&run.run_id).unwrap().unwrap().state, crate::PatchState::Applied);
        let gaps: i64 = service.store.lock().connection.query_row(
            "SELECT COUNT(*) FROM provenance_mutations WHERE commit_state='reconcile_required'", [], |row| row.get(0),
        ).unwrap();
        assert!(gaps > 0);
        let recorded_gaps: i64 = service.store.lock().connection.query_row(
            "SELECT COUNT(*) FROM provenance_capture_gaps WHERE completeness='gap'", [], |row| row.get(0),
        ).unwrap();
        assert!(recorded_gaps > 0);
    }

    #[test]
    fn provenance_recovery_preserves_pinned_task_metadata_at_the_same_revision() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        fs::write(workspace.path().join("story.txt"), "before\n").unwrap();
        let mut config = ServiceConfig::new(data.path().into());
        config.retention = Duration::ZERO;
        let service = TaskWorkspaceService::open(config).unwrap();
        let run = service.begin_run(input(&workspace, "task-recovery-pin", "run-recovery-pin")).unwrap();
        fs::write(Path::new(&run.execution_root).join("story.txt"), "agent\n").unwrap();
        service.settle_run(&run.run_id).unwrap();
        service.store.lock().connection.execute_batch(
            "CREATE TRIGGER fail_provenance_version BEFORE INSERT ON resource_versions BEGIN SELECT RAISE(FAIL, 'injected provenance capture failure'); END;",
        ).unwrap();
        assert_eq!(service.apply_patch_set(&run.run_id, &[]).unwrap().state, crate::PatchState::Applied);
        let applied = service.get_task(&run.task_id).unwrap().unwrap();
        let mut pinned = service.set_task_pinned(&run.task_id, true).unwrap();
        assert_eq!(pinned.revision, applied.revision);
        // An expired pinned task must remain retained; this independently
        // updated expiry must not be replaced by the prepared task snapshot.
        pinned.expires_at = 1;
        service.store.lock().put_task(&pinned).unwrap();
        service.store.lock().connection.execute(
            "UPDATE task_workspaces SET payload=json_set(payload,'$.independentMetadata','keep task') WHERE task_id=?1", [&run.task_id],
        ).unwrap();
        service.store.lock().connection.execute(
            "UPDATE task_patch_sets SET payload=json_set(payload,'$.independentMetadata','keep patch') WHERE run_id=?1", [&run.run_id],
        ).unwrap();
        service.store.lock().connection.execute_batch("DROP TRIGGER fail_provenance_version").unwrap();
        drop(service);

        let reopened = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let recovered = reopened.get_task(&run.task_id).unwrap().unwrap();
        assert_eq!(recovered, pinned);
        for (table, key_column, key, expected) in [
            ("task_workspaces", "task_id", &run.task_id, "keep task"),
            ("task_patch_sets", "run_id", &run.run_id, "keep patch"),
        ] {
            let metadata: String = reopened.store.lock().connection.query_row(
                &format!("SELECT json_extract(payload,'$.independentMetadata') FROM {table} WHERE {key_column}=?1"), [key], |row| row.get(0),
            ).unwrap();
            assert_eq!(metadata, expected);
        }
        assert_eq!(provenance_line_sources(&reopened, workspace.path(), "story.txt")[0].run_id.as_deref(), Some(run.run_id.as_str()));
        assert!(reopened.prune().unwrap().removed_task_ids.is_empty());
        assert!(reopened.get_task(&run.task_id).unwrap().unwrap().pinned);
    }

    #[test]
    fn provenance_runtime_retention_bounds_pins_and_keeps_an_old_patch_undoable() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let mut lines: Vec<_> = (1..=20).map(|n| format!("line {n}\n")).collect();
        fs::write(workspace.path().join("story.txt"), lines.concat()).unwrap();
        let mut config = ServiceConfig::new(data.path().into());
        config.retention = Duration::ZERO;
        let service = TaskWorkspaceService::open(config).unwrap();
        let seed = service.begin_run(input(&workspace, "task-history-seed", "run-history-seed")).unwrap();
        lines[1] = "earlier agent origin\n".into();
        fs::write(Path::new(&seed.execution_root).join("story.txt"), lines.concat()).unwrap();
        service.settle_run(&seed.run_id).unwrap();
        service.apply_patch_set(&seed.run_id, &[]).unwrap();
        service.prune().unwrap();

        let a = service.begin_run(input(&workspace, "task-history-a", "run-history-a")).unwrap();
        lines[1] = "agent A\n".into();
        fs::write(Path::new(&a.execution_root).join("story.txt"), lines.concat()).unwrap();
        service.settle_run(&a.run_id).unwrap();
        service.apply_patch_set(&a.run_id, &[]).unwrap();
        service.set_task_pinned(&a.task_id, true).unwrap();
        for n in 0..35 {
            let task = format!("task-history-{n}");
            let run = service.begin_run(input(&workspace, &task, &format!("run-history-{n}"))).unwrap();
            lines[17] = format!("later agent {n}\n");
            fs::write(Path::new(&run.execution_root).join("story.txt"), lines.concat()).unwrap();
            service.settle_run(&run.run_id).unwrap();
            service.apply_patch_set(&run.run_id, &[]).unwrap();
            let pruned = service.prune().unwrap();
            assert!(pruned.removed_task_ids.contains(&task));
        }
        {
            let store = service.store.lock();
            let versions: usize = store.connection.query_row("SELECT COUNT(*) FROM resource_versions", [], |r| r.get(0)).unwrap();
            let pins: usize = store.connection.query_row("SELECT COUNT(*) FROM provenance_blob_pins", [], |r| r.get(0)).unwrap();
            assert_eq!(versions, crate::provenance::RETAINED_VERSIONS + 1, "only the still-reversible old patch exceeds ordinary retention");
            assert!(pins <= 2 * (crate::provenance::RETAINED_VERSIONS + 1));
        }
        assert_eq!(provenance_line_sources(&service, workspace.path(), "story.txt")[17].run_id.as_deref(), Some("run-history-34"));
        assert_eq!(service.undo_patch_set(&a.run_id).unwrap().state, crate::PatchState::Reverted);
        lines[1] = "earlier agent origin\n".into();
        assert_eq!(fs::read_to_string(workspace.path().join("story.txt")).unwrap(), lines.concat());
        let sources = provenance_line_sources(&service, workspace.path(), "story.txt");
        assert_eq!(sources[1].run_id.as_deref(), Some("run-history-seed"));
        assert_eq!(sources[17].run_id.as_deref(), Some("run-history-34"));
        let versions: usize = service.store.lock().connection.query_row("SELECT COUNT(*) FROM resource_versions", [], |r| r.get(0)).unwrap();
        assert_eq!(versions, crate::provenance::RETAINED_VERSIONS);
    }

    #[test]
    fn provenance_undo_restores_prior_run_origins_and_keeps_later_human_lines_unknown() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        fs::write(workspace.path().join("story.txt"), "one\nbase two\ntail\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let first = service.begin_run(input(&workspace, "task-origin-one", "run-origin-one")).unwrap();
        fs::write(Path::new(&first.execution_root).join("story.txt"), "one\nfirst agent\ntail\n").unwrap();
        service.settle_run(&first.run_id).unwrap();
        service.apply_patch_set(&first.run_id, &[]).unwrap();
        let original_sources = provenance_line_sources(&service, workspace.path(), "story.txt");
        assert_eq!(original_sources[1].run_id.as_deref(), Some(first.run_id.as_str()));
        let second = service.begin_run(input(&workspace, "task-origin-two", "run-origin-two")).unwrap();
        fs::write(Path::new(&second.execution_root).join("story.txt"), "one\nsecond agent\ntail\n").unwrap();
        service.settle_run(&second.run_id).unwrap();
        service.apply_patch_set(&second.run_id, &[]).unwrap();
        assert_eq!(provenance_line_sources(&service, workspace.path(), "story.txt")[1].run_id.as_deref(), Some(second.run_id.as_str()));
        fs::write(workspace.path().join("story.txt"), "one\nhuman conflict\ntail\n").unwrap();
        assert_eq!(service.undo_patch_set(&second.run_id).unwrap().state, crate::PatchState::Conflict);
        assert!(!provenance_adoption_states(&service, &second.run_id).contains(&"reverted".into()));
        fs::write(workspace.path().join("story.txt"), "one\nsecond agent\ntail\nhuman later\n").unwrap();
        assert_eq!(service.undo_patch_set(&second.run_id).unwrap().state, crate::PatchState::Reverted);
        assert_eq!(fs::read(workspace.path().join("story.txt")).unwrap(), b"one\nfirst agent\ntail\nhuman later\n");
        let restored = provenance_line_sources(&service, workspace.path(), "story.txt");
        assert_eq!(&restored[..3], original_sources.as_slice());
        assert_eq!(restored[3].origin, crate::provenance::ProvenanceOrigin::Unknown);
        assert!(provenance_adoption_states(&service, &second.run_id).contains(&"reverted".into()));
    }

    #[test]
    fn provenance_rename_with_edit_and_delete_retains_identity_history() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let first = service.begin_run(input(&workspace, "task-create", "run-create")).unwrap();
        fs::write(Path::new(&first.execution_root).join("old.txt"), "original agent\nstable\n").unwrap();
        service.settle_run(&first.run_id).unwrap();
        service.apply_patch_set(&first.run_id, &[]).unwrap();
        let root = crate::provenance::capture::working_root(&mut service.store.lock(), workspace.path()).unwrap();
        let original = service.store.lock().provenance().resolve_path(&root.root_id, "old.txt").unwrap().unwrap();
        let rename = service.begin_run(input(&workspace, "task-rename", "run-rename")).unwrap();
        fs::rename(Path::new(&rename.execution_root).join("old.txt"), Path::new(&rename.execution_root).join("new.txt")).unwrap();
        fs::write(Path::new(&rename.execution_root).join("new.txt"), "renamed agent\nstable\n").unwrap();
        service.settle_run(&rename.run_id).unwrap();
        // Snapshot reconcile recognizes byte-identical renames only. Supply
        // the explicit rename patch a trusted producer can persist, leaving
        // resource-index reconciliation semantics unchanged.
        let mut patch = service.get_patch_set(&rename.run_id).unwrap().unwrap();
        let deleted = patch.files.iter().find(|file| file.path == "old.txt").unwrap().clone();
        let mut renamed = patch.files.iter().find(|file| file.path == "new.txt").unwrap().clone();
        renamed.kind = ChangeKind::Renamed;
        renamed.old_path = Some("old.txt".into());
        renamed.before_hash = deleted.before_hash;
        renamed.before_mode = deleted.before_mode;
        renamed.hunks.clear();
        patch.files = vec![renamed];
        service.store.lock().put_patch_set(&patch).unwrap();
        service.apply_patch_set(&rename.run_id, &[]).unwrap();
        let renamed = service.store.lock().provenance().resolve_path(&root.root_id, "new.txt").unwrap().unwrap();
        assert_eq!(renamed.resource_id, original.resource_id);
        let renamed_sources = provenance_line_sources(&service, workspace.path(), "new.txt");
        assert_eq!(renamed_sources[0].run_id.as_deref(), Some(rename.run_id.as_str()));
        assert_eq!(renamed_sources[1].run_id.as_deref(), Some(first.run_id.as_str()));

        let edit = service.begin_run(input(&workspace, "task-edit-renamed", "run-edit-renamed")).unwrap();
        fs::write(Path::new(&edit.execution_root).join("new.txt"), "edited agent\nstable\n").unwrap();
        service.settle_run(&edit.run_id).unwrap();
        service.apply_patch_set(&edit.run_id, &[]).unwrap();
        let sources = provenance_line_sources(&service, workspace.path(), "new.txt");
        assert_eq!(sources[0].run_id.as_deref(), Some(edit.run_id.as_str()));
        assert_eq!(sources[1].run_id.as_deref(), Some(first.run_id.as_str()));

        let delete = service.begin_run(input(&workspace, "task-delete", "run-delete")).unwrap();
        fs::remove_file(Path::new(&delete.execution_root).join("new.txt")).unwrap();
        service.settle_run(&delete.run_id).unwrap();
        service.apply_patch_set(&delete.run_id, &[]).unwrap();
        assert!(!workspace.path().join("new.txt").exists());
        let mut store = service.store.lock();
        let provenance = store.provenance();
        assert!(provenance.resolve_path(&root.root_id, "new.txt").unwrap().is_none());
        let history = provenance.path_history(&root.root_id, original.resource_id.as_deref().unwrap(), None, 100).unwrap().items;
        let deleted = history.iter().find(|entry| entry.state == crate::provenance::IdentityState::Deleted).unwrap();
        assert_eq!(deleted.resource_id, original.resource_id);
        assert!(history.iter().any(|entry| entry.relative_path == "old.txt"));
        assert!(history.iter().any(|entry| entry.relative_path == "new.txt"));
        drop(store);
        assert!(provenance_adoption_states(&service, &delete.run_id).contains(&"applied".into()));
    }

    #[test]
    fn provenance_boot_reconciles_a_prepared_file_write_without_in_memory_state() {
        use crate::provenance::{capture, AdoptionState, MappingEvidence, MutationCommitState};
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        fs::write(workspace.path().join("story.txt"), "before\n").unwrap();
        {
            let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
            let run = service.begin_run(input(&workspace, "task-crash-provenance", "run-crash-provenance")).unwrap();
            fs::write(Path::new(&run.execution_root).join("story.txt"), "agent\n").unwrap();
            service.settle_run(&run.run_id).unwrap();
            let mut patch = service.get_patch_set(&run.run_id).unwrap().unwrap();
            patch.state = crate::PatchState::Applied;
            patch.applied_revision = Some(service.get_task(&patch.task_id).unwrap().unwrap().revision + 1);
            let mut store = service.store.lock();
            let root = capture::working_root(&mut store, workspace.path()).unwrap();
            let source = capture::run_source(&mut store, &root, &patch, None).unwrap();
            let adoptions = capture::adoption_units(&patch, &source, &[], AdoptionState::Applied);
            capture::prepare(
                &mut store, &root, "service-crash-after-write", "apply",
                &[capture::CapturePath {
                    path: "story.txt".into(), old_path: None,
                    before: Some(b"before\n".to_vec()), after: Some(b"agent\n".to_vec()),
                    segments: Some(vec![crate::line_map::Segment {
                        start_line: 1, end_line: 2, provenance_id: source,
                        mapping_evidence: MappingEvidence::Exact,
                    }]),
                }],
                &adoptions, capture::Verification::Disk { root: root.canonical_root.clone() }, Some(&patch), now_ms(),
            ).unwrap();
            fs::write(workspace.path().join("story.txt"), "agent\n").unwrap();
            assert_eq!(store.provenance().mutation("service-crash-after-write").unwrap().unwrap().state, MutationCommitState::Prepared);
        }
        let reopened = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        assert_eq!(reopened.store.lock().provenance().mutation("service-crash-after-write").unwrap().unwrap().state, MutationCommitState::Committed);
        assert_eq!(provenance_line_sources(&reopened, workspace.path(), "story.txt")[0].run_id.as_deref(), Some("run-crash-provenance"));
        assert_eq!(reopened.get_patch_set("run-crash-provenance").unwrap().unwrap().state, crate::PatchState::Applied);
        drop(reopened);
        let again = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let versions: i64 = again.store.lock().connection.query_row("SELECT COUNT(*) FROM resource_versions", [], |row| row.get(0)).unwrap();
        assert_eq!(versions, 1);
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
    fn changeset_capture_baseline_preserves_original_acquisition_across_pipeline_runs() {
        let data = TempDir::new().unwrap();
        let source = TempDir::new().unwrap();
        git2::Repository::init(source.path()).unwrap();
        seed_git_repository(source.path());
        fs::write(source.path().join("README.md"), "dirty acquisition\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let mut first_request = input(&source, "baseline-pipeline", "baseline-first");
        first_request.workspace_key = Some("pipeline".into());
        first_request.tracking_policy.auto_detect = false;
        let first = service.begin_run(first_request).unwrap();
        let workspace_id = first.workspace_id.as_deref().unwrap();
        let original = service
            .store
            .lock()
            .get_workspace_capture_baseline(workspace_id)
            .unwrap()
            .unwrap();
        assert_eq!(original.1, first.tracking_policy);
        assert!(matches!(
            original.0.base,
            crate::snapshot::SnapshotBase::GitCommit { .. }
        ));
        let execution_repository = git2::Repository::open(&first.execution_root).unwrap();
        let acquisition_commit = execution_repository.head().unwrap().target().unwrap();
        assert_eq!(original.2, Some(acquisition_commit.to_string()));
        assert_eq!(
            service
                .store
                .lock()
                .get_blob(&original.0.entries["README.md"].hash, now_ms())
                .unwrap(),
            b"dirty acquisition\n"
        );
        fs::write(
            Path::new(&first.execution_root).join("README.md"),
            "agent later\n",
        )
        .unwrap();
        service.settle_run(&first.run_id).unwrap();
        let mut second_request = input(&source, "baseline-pipeline", "baseline-second");
        second_request.workspace_key = Some("pipeline".into());
        second_request.tracking_policy.auto_detect = false;
        let second = service.begin_run(second_request).unwrap();
        assert_eq!(second.workspace_id, first.workspace_id);
        assert_eq!(
            service
                .store
                .lock()
                .get_workspace_capture_baseline(workspace_id)
                .unwrap(),
            Some(original.clone())
        );
        let second_baseline = service
            .store
            .lock()
            .get_run::<WorkspaceSnapshot>(&second.run_id)
            .unwrap()
            .unwrap()
            .1;
        assert_ne!(
            second_baseline.entries["README.md"].hash,
            original.0.entries["README.md"].hash
        );
        assert_eq!(
            service
                .store
                .lock()
                .earliest_workspace_run(workspace_id)
                .unwrap()
                .unwrap()
                .run_id,
            first.run_id
        );
        service.settle_run(&second.run_id).unwrap();
        let mut index = execution_repository.index().unwrap();
        index.add_path(Path::new("README.md")).unwrap();
        index.write().unwrap();
        let tree = execution_repository
            .find_tree(index.write_tree().unwrap())
            .unwrap();
        let parent = execution_repository
            .find_commit(acquisition_commit)
            .unwrap();
        let signature = git2::Signature::now("Agent", "agent@example.com").unwrap();
        let agent_commit = execution_repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "agent commit after acquisition",
                &tree,
                &[&parent],
            )
            .unwrap();
        assert_ne!(agent_commit, acquisition_commit);
        assert_eq!(
            service
                .store
                .lock()
                .get_workspace_capture_baseline(workspace_id)
                .unwrap(),
            Some(original.clone())
        );
        drop(service);
        let reopened = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        assert_eq!(
            reopened
                .store
                .lock()
                .get_workspace_capture_baseline(workspace_id)
                .unwrap(),
            Some(original)
        );
    }

    #[test]
    fn changeset_capture_baseline_is_persisted_before_a_bundles_first_turn() {
        let data = TempDir::new().unwrap();
        let source = TempDir::new().unwrap();
        git2::Repository::init(source.path()).unwrap();
        seed_git_repository(source.path());
        fs::write(source.path().join("README.md"), "bundle acquisition\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-1".into()),
                project_id: None,
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                base: WorkspaceBaseSpec::WorkingState,
                roots: vec![crate::WorkspaceBundleRootInput {
                    logical_root_id: "primary".into(),
                    role: crate::WorkspaceRootRole::Primary,
                    source_root: source.path().to_string_lossy().into_owned(),
                }],
                provisioning: None,
                requested_name: None,
            })
            .unwrap();
        let lease = &bundle.leases[0];
        let original = service
            .store
            .lock()
            .get_workspace_capture_baseline(&lease.workspace_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            original.2,
            Some(
                git2::Repository::open(&lease.alias_path)
                    .unwrap()
                    .head()
                    .unwrap()
                    .target()
                    .unwrap()
                    .to_string()
            )
        );
        assert!(service
            .store
            .lock()
            .earliest_workspace_run(&lease.workspace_id)
            .unwrap()
            .is_none());
        assert_eq!(
            service
                .store
                .lock()
                .get_blob(&original.0.entries["README.md"].hash, now_ms())
                .unwrap(),
            b"bundle acquisition\n"
        );
        assert!(service
            .store
            .lock()
            .get_workspace_archive(&lease.workspace_id)
            .unwrap()
            .is_none());
        assert!(service
            .registry
            .get(&lease.workspace_id)
            .unwrap()
            .unwrap()
            .snapshot_task_id
            .is_none());
        fs::write(
            Path::new(&lease.alias_path).join("agent-only.txt"),
            "agent work\n",
        )
        .unwrap();
        let repository = git2::Repository::open(source.path()).unwrap();
        let target_ref = repository.head().unwrap().name().unwrap().to_string();
        let captured = service
            .capture_changeset(crate::CaptureChangeset {
                workspace_id: lease.workspace_id.clone(),
                target_ref: Some(target_ref),
                title: "Agent change before the first turn".into(),
                depends_on: Vec::new(),
                required_checks: Vec::new(),
                changeset_id: None,
            })
            .unwrap();
        assert_eq!(
            captured
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["agent-only.txt"]
        );
        let captured_commit = repository
            .find_commit(git2::Oid::from_str(&captured.head_sha).unwrap())
            .unwrap();
        let captured_tree = captured_commit.tree().unwrap();
        let readme = captured_tree.get_path(Path::new("README.md")).unwrap();
        assert_eq!(
            repository.find_blob(readme.id()).unwrap().content(),
            b"seed\n"
        );
        assert_eq!(
            fs::read_to_string(source.path().join("README.md")).unwrap(),
            "bundle acquisition\n"
        );
        assert_eq!(
            fs::read_to_string(Path::new(&lease.alias_path).join("README.md")).unwrap(),
            "bundle acquisition\n"
        );
        assert!(!source.path().join("agent-only.txt").exists());
        fs::write(
            Path::new(&lease.alias_path).join("README.md"),
            "changed before first turn\n",
        )
        .unwrap();
        let turn = service
            .begin_workspace_bundle_turn(
                &bundle.bundle_id,
                crate::BeginWorkspaceBundleTurn {
                    primary_logical_root_id: "primary".into(),
                    run: input(&source, "baseline-bundle-task", "baseline-bundle-run"),
                },
            )
            .unwrap();
        assert_eq!(
            service
                .store
                .lock()
                .get_workspace_capture_baseline(&lease.workspace_id)
                .unwrap(),
            Some(original)
        );
        service
            .abort_workspace_bundle_turn(&turn.bundle_turn_id)
            .unwrap();
    }

    #[test]
    fn changeset_capture_baseline_storage_failure_rolls_back_bundle_acquisition() {
        let data = TempDir::new().unwrap();
        let source = TempDir::new().unwrap();
        git2::Repository::init(source.path()).unwrap();
        seed_git_repository(source.path());
        fs::write(
            source.path().join("README.md"),
            "dirty acquisition that exceeds one byte\n",
        )
        .unwrap();
        let mut config = ServiceConfig::new(data.path().into());
        config.max_blob_bytes = 1;
        let service = TaskWorkspaceService::open(config).unwrap();
        let result = service.acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
            owner_type: WorkspaceOwnerType::Session,
            owner_ref: Some("session-1".into()),
            project_id: None,
            environment_kind: crate::WorkspaceEnvironmentKind::Managed,
            base: WorkspaceBaseSpec::WorkingState,
            roots: vec![crate::WorkspaceBundleRootInput {
                logical_root_id: "primary".into(),
                role: crate::WorkspaceRootRole::Primary,
                source_root: source.path().to_string_lossy().into_owned(),
            }],
            provisioning: None,
            requested_name: None,
        });
        assert!(result.unwrap_err().contains("capacity exceeded"));
        assert!(service.registry.list().unwrap().is_empty());
        assert!(service.list_workspace_bundles().unwrap().is_empty());
        assert_eq!(read_git_worktree_inventory(source.path()).unwrap().len(), 1);
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
                requested_name: None,
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
    fn a_requested_name_puts_the_worktree_on_a_branch_of_that_name() {
        let data = TempDir::new().unwrap();
        let repo = TempDir::new().unwrap();
        git2::Repository::init(repo.path()).unwrap();
        seed_git_repository(repo.path());

        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                requested_name: Some("feat/login".into()),
                provisioning: None,
                project_id: None,
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-named".into()),
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                base: WorkspaceBaseSpec::WorkingState,
                roots: vec![crate::WorkspaceBundleRootInput {
                    logical_root_id: "primary".into(),
                    role: crate::WorkspaceRootRole::Primary,
                    source_root: repo.path().to_string_lossy().into_owned(),
                }],
            })
            .unwrap();

        let record = service
            .registry
            .get(&bundle.leases[0].workspace_id)
            .unwrap()
            .unwrap();
        assert_eq!(record.branch.as_deref(), Some("feat/login"));
        // The worktree HEAD sits on the branch, not detached.
        let worktree = git2::Repository::open(&record.execution_root).unwrap();
        let head = worktree.head().unwrap();
        assert_eq!(head.shorthand().unwrap(), "feat/login");
        assert!(head.is_branch());
    }

    #[test]
    fn a_requested_name_is_validated_before_any_worktree_exists() {
        let data = TempDir::new().unwrap();
        let repo = TempDir::new().unwrap();
        git2::Repository::init(repo.path()).unwrap();
        seed_git_repository(repo.path());

        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let acquire = |name: &str| {
            service.acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                requested_name: Some(name.into()),
                provisioning: None,
                project_id: None,
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-bad-name".into()),
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                base: WorkspaceBaseSpec::WorkingState,
                roots: vec![crate::WorkspaceBundleRootInput {
                    logical_root_id: "primary".into(),
                    role: crate::WorkspaceRootRole::Primary,
                    source_root: repo.path().to_string_lossy().into_owned(),
                }],
            })
        };
        assert!(acquire("has space").is_err());
        assert!(acquire("-flag-like").is_err());
        assert!(acquire("bad..dots").is_err());
        // Nothing provisioned: the rejection happened before any record existed.
        assert!(service.registry.list().unwrap().is_empty());
    }

    #[test]
    fn a_requested_name_on_a_gitless_bundle_is_refused() {
        let data = TempDir::new().unwrap();
        let shadow = TempDir::new().unwrap();
        fs::write(shadow.path().join("notes.txt"), "notes\n").unwrap();

        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let error = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                requested_name: Some("named".into()),
                provisioning: None,
                project_id: None,
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-shadow".into()),
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                base: WorkspaceBaseSpec::WorkingState,
                roots: vec![crate::WorkspaceBundleRootInput {
                    logical_root_id: "primary".into(),
                    role: crate::WorkspaceRootRole::Primary,
                    source_root: shadow.path().to_string_lossy().into_owned(),
                }],
            })
            .unwrap_err();
        assert!(error.contains("requires at least one Git root"));
    }

    #[test]
    fn a_requested_name_colliding_with_an_existing_branch_fails_the_acquire() {
        let data = TempDir::new().unwrap();
        let repo = TempDir::new().unwrap();
        git2::Repository::init(repo.path()).unwrap();
        seed_git_repository(repo.path());
        // The name must collide with a branch the repository actually has —
        // default-branch naming differs across environments.
        {
            let repository = git2::Repository::open(repo.path()).unwrap();
            let head = repository.head().unwrap().peel_to_commit().unwrap();
            repository.branch("taken-branch", &head, false).unwrap();
        }
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let error = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                requested_name: Some("taken-branch".into()),
                provisioning: None,
                project_id: None,
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-taken".into()),
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                base: WorkspaceBaseSpec::WorkingState,
                roots: vec![crate::WorkspaceBundleRootInput {
                    logical_root_id: "primary".into(),
                    role: crate::WorkspaceRootRole::Primary,
                    source_root: repo.path().to_string_lossy().into_owned(),
                }],
            })
            .unwrap_err();
        assert!(error.contains("worktree add failed") || error.contains("already exists"));
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
                requested_name: None,
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
        let ports = crate::ports::list(&service.store.lock().connection).unwrap();
        assert_eq!(ports.len(), physical_ids.len());
        assert_eq!(
            ports.iter().map(|lease| lease.base_port).collect::<std::collections::HashSet<_>>().len(),
            3
        );
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
                requested_name: None,
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
                requested_name: None,
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
    fn port_bundle_metadata_and_publication_failures_release_reservations() {
        for failure in ["metadata", "publication"] {
            let data = TempDir::new().unwrap();
            let root = TempDir::new().unwrap();
            let service =
                TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
            let trigger = if failure == "metadata" {
                "CREATE TRIGGER reject_port_metadata BEFORE UPDATE ON workspace_registry
                 WHEN NEW.state='provisioning' AND OLD.state='provisioning'
                 BEGIN SELECT RAISE(ABORT, 'injected port failure'); END"
            } else {
                "CREATE TRIGGER reject_port_bundle BEFORE INSERT ON workspace_bundles
                 BEGIN SELECT RAISE(ABORT, 'injected port failure'); END"
            };
            service
                .store
                .lock()
                .connection
                .execute_batch(trigger)
                .unwrap();
            let error = service
                .acquire_workspace_bundle(AcquireWorkspaceBundle {
                    requested_name: None,
                    provisioning: None,
                    project_id: None,
                    owner_type: WorkspaceOwnerType::Session,
                    owner_ref: Some("session-port-rollback".into()),
                    environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                    base: WorkspaceBaseSpec::WorkingState,
                    roots: vec![crate::WorkspaceBundleRootInput {
                        logical_root_id: "root".into(),
                        role: crate::WorkspaceRootRole::Primary,
                        source_root: root.path().to_string_lossy().into_owned(),
                    }],
                })
                .unwrap_err();
            assert!(error.contains("injected port failure"), "{error}");
            assert!(service.list_managed_workspaces().unwrap().is_empty());
            assert!(service.list_workspace_bundles().unwrap().is_empty());
            assert!(crate::ports::list(&service.store.lock().connection)
                .unwrap()
                .is_empty());
        }
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
                requested_name: None,
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
        assert!(crate::ports::list(&service.store.lock().connection)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn archive_restore_and_delete_preserve_shadow_wip() {
        let data = TempDir::new().unwrap();
        let shadow = TempDir::new().unwrap();
        fs::write(shadow.path().join("notes.txt"), "before\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                requested_name: None,
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
        let port_lease = service
            .read_workspace_port_lease(&lease.workspace_id, crate::HOST_LOOPBACK_NAMESPACE)
            .unwrap()
            .unwrap();
        fs::write(Path::new(&lease.alias_path).join("notes.txt"), "after\n").unwrap();

        let archived = service
            .archive_managed_workspace(&lease.workspace_id)
            .unwrap();
        assert_eq!(archived.state, WorkspaceState::Archived);
        assert_eq!(archived.port_lease.as_ref(), Some(&port_lease));
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
        assert_eq!(restored.port_lease.as_ref(), Some(&port_lease));
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
        assert!(crate::ports::list(&service.store.lock().connection)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn permanent_environments_are_protected_from_archive_and_delete() {
        let data = TempDir::new().unwrap();
        let shadow = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let bundle = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                requested_name: None,
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
                requested_name: None,
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
                requested_name: None,
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
            ..Default::default()
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
                    requested_name: None,
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
                requested_name: None,
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
                requested_name: None,
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
    fn provenance_bundle_apply_failure_compensates_prior_root_and_restores_its_sources() {
        struct FailSecondApply<'a> {
            inner: ServiceBundleApplier<'a>,
            trace: std::cell::RefCell<Vec<String>>,
        }

        impl crate::BundleApplier for FailSecondApply<'_> {
            fn precheck(&self, step: &crate::ApplyStep) -> Result<(), Vec<crate::PatchConflict>> {
                self.trace.borrow_mut().push(format!("precheck:{}", step.step_index));
                crate::BundleApplier::precheck(&self.inner, step)
            }

            fn apply(&self, step: &crate::ApplyStep) -> Result<(), Vec<crate::PatchConflict>> {
                self.trace.borrow_mut().push(format!("apply:{}", step.step_index));
                if step.step_index == 1 {
                    return Err(vec![crate::PatchConflict {
                        path: "result.txt".into(),
                        reason: "injected second root apply failure".into(),
                    }]);
                }
                crate::BundleApplier::apply(&self.inner, step)
            }

            fn compensate(&self, step: &crate::ApplyStep) -> Result<(), Vec<crate::PatchConflict>> {
                self.trace.borrow_mut().push(format!("compensate:{}", step.step_index));
                crate::BundleApplier::compensate(&self.inner, step)
            }
        }

        let data = TempDir::new().unwrap();
        let primary = TempDir::new().unwrap();
        let additional = TempDir::new().unwrap();
        fs::write(primary.path().join("result.txt"), "original\n").unwrap();
        fs::write(additional.path().join("result.txt"), "before\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let prior = service.begin_run(input(&primary, "task-prior-bundle", "run-prior-bundle")).unwrap();
        fs::write(Path::new(&prior.execution_root).join("result.txt"), "before\n").unwrap();
        service.settle_run(&prior.run_id).unwrap();
        service.apply_patch_set(&prior.run_id, &[]).unwrap();
        let prior_sources = provenance_line_sources(&service, primary.path(), "result.txt");
        assert_eq!(prior_sources[0].run_id.as_deref(), Some(prior.run_id.as_str()));

        let bundle = service.acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
            requested_name: None,
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
        }).unwrap();
        let turn = service.begin_workspace_bundle_turn(&bundle.bundle_id, crate::BeginWorkspaceBundleTurn {
            primary_logical_root_id: "primary".into(),
            run: input(&primary, "task-mid-apply", "run-mid-apply"),
        }).unwrap();
        for lease in &turn.runs {
            fs::write(Path::new(&lease.run.execution_root).join("result.txt"), "after\n").unwrap();
        }
        service.settle_workspace_bundle_turn(&turn.bundle_turn_id, RunState::Ready).unwrap();
        let steps = ["primary", "additional"].iter().enumerate().map(|(step_index, logical)| {
            let lease = turn.runs.iter().find(|lease| lease.logical_root_ids.iter().any(|id| id.as_str() == *logical)).unwrap();
            crate::ApplyStep {
                step_index,
                workspace_id: lease.workspace_id.clone(),
                alias_path: lease.run.execution_root.clone(),
                patch: service.get_patch_set(&lease.run.run_id).unwrap().unwrap(),
            }
        }).collect::<Vec<_>>();
        let plan = crate::BundleApplyPlan { bundle_id: bundle.bundle_id, steps };
        let applier = FailSecondApply {
            inner: ServiceBundleApplier { service: &service, selections: HashMap::new(), allow_irreversible: false },
            trace: std::cell::RefCell::new(Vec::new()),
        };
        let outcome = crate::execute_bundle_apply(&plan, &applier);
        assert_eq!(outcome.state, WorkspaceState::Active);
        assert_eq!(outcome.rolled_back, vec![plan.steps[0].workspace_id.clone()]);
        assert_eq!(outcome.conflicts[0].reason, "injected second root apply failure");
        assert_eq!(*applier.trace.borrow(), vec!["precheck:0", "precheck:1", "apply:0", "apply:1", "compensate:0"]);
        assert_eq!(fs::read(primary.path().join("result.txt")).unwrap(), b"before\n");
        assert_eq!(fs::read(additional.path().join("result.txt")).unwrap(), b"before\n");
        assert_eq!(provenance_line_sources(&service, primary.path(), "result.txt"), prior_sources);
        assert_eq!(provenance_adoption_states(&service, &plan.steps[0].patch.run_id), vec!["applied", "pending", "reverted"]);
        assert_eq!(provenance_adoption_states(&service, &plan.steps[1].patch.run_id), vec!["pending"]);
        assert_eq!(service.get_patch_set(&plan.steps[0].patch.run_id).unwrap().unwrap().state, crate::PatchState::Reverted);
        assert_eq!(service.get_patch_set(&plan.steps[1].patch.run_id).unwrap().unwrap().state, crate::PatchState::Ready);
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
                requested_name: None,
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

        let primary_run_id = &turn.runs.iter()
            .find(|lease| lease.logical_root_ids.contains(&"primary".into())).unwrap().run.run_id;
        let additional_run_id = &turn.runs.iter()
            .find(|lease| lease.logical_root_ids.contains(&"additional".into())).unwrap().run.run_id;
        assert_eq!(provenance_line_sources(&service, primary.path(), "primary.txt")[0].run_id.as_deref(), Some(primary_run_id.as_str()));
        assert_eq!(provenance_line_sources(&service, additional.path(), "additional.txt")[0].run_id.as_deref(), Some(additional_run_id.as_str()));

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
        assert_eq!(provenance_line_sources(&service, additional.path(), "additional.txt")[0].run_id.as_deref(), Some(additional_run_id.as_str()));
        assert!(provenance_adoption_states(&service, additional_run_id).contains(&"reverted".into()));
        assert!(!provenance_adoption_states(&service, primary_run_id).contains(&"reverted".into()));

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
        assert_ne!(provenance_line_sources(&service, primary.path(), "primary.txt")[0].run_id.as_deref(), Some(primary_run_id.as_str()));
        assert_ne!(provenance_line_sources(&service, additional.path(), "additional.txt")[0].run_id.as_deref(), Some(additional_run_id.as_str()));
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
                ..Default::default()
            })
            .unwrap();
        let bundle = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                requested_name: None,
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
                ..Default::default()
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

    /// ADR-0176. The whole point of supplying from a remote: what comes back
    /// is an ordinary git root, so the acquisition path that already worked
    /// keeps working on it, unchanged, with a real worktree behind it.
    #[test]
    fn a_bundle_over_a_supplied_remote_gets_a_git_worktree() {
        let data = TempDir::new().unwrap();
        let upstream = TempDir::new().unwrap();
        git2::Repository::init(upstream.path()).unwrap();
        seed_git_repository(upstream.path());
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();

        let supplied = service
            .ensure_remote_source(&crate::EnsureRemoteSource {
                remote_url: format!("file://{}", upstream.path().display()),
                base: WorkspaceBaseSpec::RemoteDefault,
                credential: Some("ghs_SECRET".into()),
            })
            .expect("supply");

        let bundle = service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                requested_name: None,
                provisioning: None,
                project_id: None,
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-remote".into()),
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                base: WorkspaceBaseSpec::LocalHead,
                roots: vec![crate::WorkspaceBundleRootInput {
                    logical_root_id: "primary".into(),
                    role: crate::WorkspaceRootRole::Primary,
                    source_root: supplied.source_root.clone(),
                }],
            })
            .expect("acquire over a supplied source");

        let lease = &bundle.leases[0];
        let execution_root = PathBuf::from(&lease.alias_path);
        assert!(
            execution_root.join(".git").exists(),
            "a supplied source must produce a real git execution root"
        );
        assert!(execution_root.join("README.md").exists());
    }

    /// The credential is used once, by the mirror fetch, and this crate never
    /// learns it. Scans the store's bytes rather than the typed rows, because a
    /// leak would most likely arrive through a payload blob nobody typed.
    #[test]
    fn no_credential_is_ever_written_into_the_workspace_store() {
        let data = TempDir::new().unwrap();
        let upstream = TempDir::new().unwrap();
        git2::Repository::init(upstream.path()).unwrap();
        seed_git_repository(upstream.path());
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();

        let supplied = service
            .ensure_remote_source(&crate::EnsureRemoteSource {
                remote_url: format!("file://{}", upstream.path().display()),
                base: WorkspaceBaseSpec::RemoteDefault,
                credential: Some("ghs_SECRET".into()),
            })
            .expect("supply");
        service
            .acquire_workspace_bundle(crate::AcquireWorkspaceBundle {
                requested_name: None,
                provisioning: None,
                project_id: None,
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-secret".into()),
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                base: WorkspaceBaseSpec::LocalHead,
                roots: vec![crate::WorkspaceBundleRootInput {
                    logical_root_id: "primary".into(),
                    role: crate::WorkspaceRootRole::Primary,
                    source_root: supplied.source_root.clone(),
                }],
            })
            .expect("acquire");

        for entry in fs::read_dir(data.path().join("task-workspaces")).unwrap() {
            let path = entry.unwrap().path();
            if !path.is_file() {
                continue;
            }
            let bytes = fs::read(&path).unwrap();
            assert!(
                !contains_bytes(&bytes, b"ghs_SECRET"),
                "credential reached {}",
                path.display()
            );
        }

        // And not into the checkout's own configuration either, which is what
        // an agent with shell tools can read.
        let config = fs::read_to_string(PathBuf::from(&supplied.source_root).join(".git/config"))
            .unwrap_or_default();
        assert!(!config.contains("ghs_SECRET"), "{config}");
    }

    fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
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
                requested_name: None,
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

        let workspace_id = &bundle.leases[0].workspace_id;
        assert!(service
            .forget_workspace_branch(workspace_id, "feature/other")
            .is_err());
        let forgotten = service
            .forget_workspace_branch(workspace_id, "feature/managed")
            .unwrap();
        assert_eq!(forgotten.branch, None);
        assert_eq!(forgotten.head.as_deref(), Some("0123456789abcdef"));
        assert!(service
            .forget_workspace_branch(workspace_id, "feature/managed")
            .is_err());
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
                ..Default::default()
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

    #[test]
    fn the_resource_index_is_folded_once_per_change_to_the_ledger() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let run = service
            .begin_run(input(&workspace, "task-1", "run-1"))
            .unwrap();
        fs::write(Path::new(&run.execution_root).join("a.md"), "a").unwrap();
        service.settle_run("run-1").unwrap();

        let first = service.list_resource_index().unwrap();
        assert_eq!(first.len(), 1);
        // Nothing changed: the second read is the same fold, not a new one.
        assert!(Arc::ptr_eq(&first, &service.list_resource_index().unwrap()));

        // A write through this service refolds.
        let run = service
            .begin_run(input(&workspace, "task-1", "run-2"))
            .unwrap();
        fs::write(Path::new(&run.execution_root).join("b.md"), "b").unwrap();
        service.settle_run("run-2").unwrap();
        let second = service.list_resource_index().unwrap();
        assert!(!Arc::ptr_eq(&first, &second));
        let mut paths: Vec<_> = second.iter().map(|entry| entry.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, ["a.md", "b.md"]);

        // So does a write through another connection to the same database.
        let other = rusqlite::Connection::open(
            data.path()
                .join("task-workspaces")
                .join("task-workspaces.sqlite"),
        )
        .unwrap();
        other
            .execute("UPDATE task_workspaces SET session_id = 'session-2'", [])
            .unwrap();
        let third = service.list_resource_index().unwrap();
        assert!(third.iter().all(|entry| entry.session_id == "session-2"));
    }

    #[test]
    fn a_workspace_file_is_pending_until_applied_and_gone_once_undone() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let run = service
            .begin_run(input(&workspace, "task-1", "run-1"))
            .unwrap();
        fs::write(Path::new(&run.execution_root).join("plan.md"), "plan").unwrap();
        fs::write(Path::new(&run.execution_root).join("notes.md"), "notes").unwrap();
        service.settle_run("run-1").unwrap();

        let index = service.list_resource_index().unwrap();
        assert_eq!(index.len(), 2);
        assert!(index
            .iter()
            .all(|entry| entry.adoption == crate::ResourceAdoption::Pending));

        // The person takes one file of the two: the other was turned down.
        let applied = service
            .apply_patch_set(
                "run-1",
                &[crate::PatchSelection {
                    path: "plan.md".into(),
                    hunk_ids: Vec::new(),
                }],
            )
            .unwrap();
        assert_eq!(applied.state, crate::PatchState::Applied);
        let index = service.list_resource_index().unwrap();
        assert_eq!(index.len(), 1);
        assert_eq!(index[0].path, "plan.md");
        assert_eq!(index[0].adoption, crate::ResourceAdoption::Applied);
        assert!(workspace.path().join("plan.md").is_file());

        // Undone: none of it happened.
        service.undo_patch_set("run-1").unwrap();
        assert!(service.list_resource_index().unwrap().is_empty());
    }

    #[test]
    fn a_pending_file_is_read_from_the_ledger_once_its_run_root_is_gone() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let run = service
            .begin_run(input(&workspace, "task-1", "run-1"))
            .unwrap();
        let root = Path::new(&run.execution_root);
        let body = "the agent's plan\n".repeat(64);
        fs::write(root.join("plan.md"), &body).unwrap();
        fs::write(root.join(".env"), "TOKEN=1").unwrap();
        fs::write(root.join("gone.md"), "x").unwrap();
        service.settle_run("run-1").unwrap();
        // The root goes (archived, removed); nothing was applied.
        fs::remove_dir_all(root).unwrap();

        let mut read = Vec::new();
        let mut offset = 0;
        loop {
            let chunk = service
                .read_resource_capture("run-1", "plan.md", offset, 100)
                .unwrap();
            assert_eq!(chunk.offset, offset);
            assert_eq!(chunk.size, body.len() as u64);
            read.extend(STANDARD.decode(&chunk.data_base64).unwrap());
            offset += chunk.bytes_read;
            if chunk.eof {
                break;
            }
        }
        assert_eq!(String::from_utf8(read).unwrap(), body);
        // A zero-length read answers the size alone.
        let probe = service
            .read_resource_capture("run-1", "plan.md", 0, 0)
            .unwrap();
        assert_eq!((probe.bytes_read, probe.size), (0, body.len() as u64));

        // Credentials are never served, nor anything the run did not leave.
        assert!(service
            .read_resource_capture("run-1", ".env", 0, 10)
            .is_err());
        assert!(service
            .read_resource_capture("run-1", "absent.md", 0, 10)
            .is_err());
        assert!(service
            .read_resource_capture("run-2", "plan.md", 0, 10)
            .is_err());
    }

    /// A conversation's code goes to a host and its work comes back: the
    /// desktop's snapshot becomes a checkout there, the agent works in it, and
    /// the export arrives on the desktop as a new worktree (ADR-0224 A11b/c).
    #[test]
    fn code_handed_to_a_host_comes_back_as_a_new_worktree() {
        use base64::{engine::general_purpose::STANDARD, Engine};

        fn git(cwd: &Path, args: &[&str]) -> String {
            let output = std::process::Command::new("git")
                .current_dir(cwd)
                .args(args)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_AUTHOR_NAME", "T")
                .env("GIT_AUTHOR_EMAIL", "t@example.com")
                .env("GIT_COMMITTER_NAME", "T")
                .env("GIT_COMMITTER_EMAIL", "t@example.com")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }

        let tmp = TempDir::new().unwrap();
        let seed = tmp.path().join("seed");
        fs::create_dir_all(&seed).unwrap();
        git(&seed, &["init", "-q", "--initial-branch=main", "."]);
        fs::write(seed.join("README.md"), "hello\n").unwrap();
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-q", "-m", "first"]);
        let upstream = tmp.path().join("upstream.git");
        git(
            tmp.path(),
            &[
                "clone",
                "-q",
                "--bare",
                seed.to_str().unwrap(),
                upstream.to_str().unwrap(),
            ],
        );
        let desk = tmp.path().join("desk");
        let host_folder = tmp.path().join("host-folder");
        for dest in [&desk, &host_folder] {
            git(
                tmp.path(),
                &[
                    "clone",
                    "-q",
                    upstream.to_str().unwrap(),
                    dest.to_str().unwrap(),
                ],
            );
        }
        fs::write(desk.join("README.md"), "hello, from the desk\n").unwrap();

        let desk_data = TempDir::new().unwrap();
        let host_data = TempDir::new().unwrap();
        let desktop =
            TaskWorkspaceService::open(ServiceConfig::new(desk_data.path().into())).unwrap();
        let host = TaskWorkspaceService::open(ServiceConfig::new(host_data.path().into())).unwrap();

        // There: the snapshot, uploaded and applied.
        let created = desktop
            .create_code_snapshot(&crate::CreateCodeSnapshot {
                root: desk.to_string_lossy().into_owned(),
                max_bytes: None,
                kind: None,
            })
            .unwrap();
        let upload = host
            .open_code_snapshot_upload(created.manifest.size_bytes, &created.manifest.sha256)
            .unwrap();
        let mut offset = 0;
        loop {
            let chunk = desktop
                .read_code_snapshot_chunk(&created.snapshot_id, offset)
                .unwrap();
            offset = host
                .write_code_snapshot_chunk(
                    &upload.upload_id,
                    chunk.offset,
                    &chunk.data_base64,
                    &chunk.chunk_hash,
                )
                .unwrap();
            if chunk.eof {
                break;
            }
        }
        let committed = host.commit_code_snapshot_upload(&upload.upload_id).unwrap();
        let checkout = host
            .apply_code_snapshot(&crate::ApplyCodeSnapshot {
                snapshot_id: committed.snapshot_id,
                manifest: created.manifest.clone(),
                project_id: None,
                roots: vec![host_folder.to_string_lossy().into_owned()],
                remote_url: None,
                credential: None,
            })
            .unwrap();
        let worked_in = PathBuf::from(&checkout.working_dir);
        fs::write(worked_in.join("NOTES.md"), "written on the host\n").unwrap();

        // Back: no repository to push to, so a bundle, read out and applied.
        let result = host
            .export_code_checkout(&crate::ExportCodeCheckout {
                checkout_id: checkout.checkout_id.clone(),
                agent: Some("codex".into()),
                credential: None,
            })
            .unwrap();
        assert_eq!(result.kind, crate::CodeResultKind::Bundle);
        let transfer = result.transfer.clone().unwrap();
        let receive = desktop
            .open_code_result_receive(transfer.manifest.size_bytes, &transfer.manifest.sha256)
            .unwrap();
        let mut offset = 0;
        loop {
            let chunk = host
                .read_code_result_chunk(&transfer.result_id, offset)
                .unwrap();
            assert!(!STANDARD.decode(&chunk.data_base64).unwrap().is_empty());
            offset = desktop
                .write_code_result_chunk(
                    &receive.upload_id,
                    chunk.offset,
                    &chunk.data_base64,
                    &chunk.chunk_hash,
                )
                .unwrap();
            if chunk.eof {
                break;
            }
        }
        let received = desktop
            .commit_code_result_receive(&receive.upload_id)
            .unwrap();
        host.discard_code_result(&transfer.result_id).unwrap();
        let applied = desktop
            .apply_code_result(&crate::ApplyCodeResult {
                root: desk.to_string_lossy().into_owned(),
                result: result.clone(),
                received_id: Some(received.snapshot_id),
            })
            .unwrap();
        let worktree = PathBuf::from(&applied.path);
        assert!(worktree.starts_with(desk_data.path()));
        assert_eq!(
            fs::read_to_string(worktree.join("README.md")).unwrap(),
            "hello, from the desk\n"
        );
        assert_eq!(
            fs::read_to_string(worktree.join("NOTES.md")).unwrap(),
            "written on the host\n"
        );
        assert_eq!(
            applied.branch.as_deref(),
            Some(crate::code_result_branch(&checkout.checkout_id, "codex").as_str())
        );
        // An unknown checkout is refused.
        let error = host
            .export_code_checkout(&crate::ExportCodeCheckout {
                checkout_id: "0192f0c4-7a1e-7b3c-9d2e-000000000000".into(),
                agent: None,
                credential: None,
            })
            .unwrap_err();
        assert!(error.starts_with("code_result_not_found"), "{error}");
    }
}
