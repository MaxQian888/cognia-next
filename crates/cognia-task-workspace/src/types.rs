use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskWorkspaceState {
    Active,
    Ready,
    Applied,
    Conflict,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunState {
    Running,
    Settling,
    Ready,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IsolationKind {
    GitWorktree,
    Shadow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Created,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContributionOrigin {
    Agent,
    User,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourceKind {
    File,
    Symlink,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourceCaptureClass {
    #[default]
    Source,
    Generated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceTrackingPolicy {
    #[serde(default)]
    pub generated_output_roots: Vec<String>,
    #[serde(default = "default_true")]
    pub auto_detect: bool,
}

impl Default for ResourceTrackingPolicy {
    fn default() -> Self {
        Self {
            generated_output_roots: Vec::new(),
            auto_detect: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourceEventEvidence {
    Watcher,
    Tool,
    Reconcile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourceTimelineCompleteness {
    Complete,
    ResyncRequired,
    Reconciled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PatchState {
    Ready,
    Applied,
    Reverted,
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictResolution {
    RetryMerge,
    ApplyTask,
    KeepCurrent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginTaskRun {
    pub task_id: String,
    pub session_id: String,
    pub run_id: String,
    pub parent_run_id: Option<String>,
    pub agent_id: String,
    pub agent_kind: String,
    pub workspace_root: String,
    #[serde(default)]
    pub base: WorkspaceBaseSpec,
    #[serde(default)]
    pub workspace_key: Option<String>,
    #[serde(default)]
    pub execution_run_id: Option<String>,
    #[serde(default)]
    pub trace_id: Option<String>,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub attempt_id: Option<String>,
    #[serde(default)]
    pub provider_attempt_id: Option<String>,
    #[serde(default)]
    pub surface: Option<String>,
    #[serde(default)]
    pub tracking_policy: ResourceTrackingPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkspace {
    pub task_id: String,
    pub session_id: String,
    pub workspace_root: String,
    pub state: TaskWorkspaceState,
    pub revision: u64,
    pub created_at: i64,
    pub expires_at: i64,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub run_id: String,
    pub task_id: String,
    pub parent_run_id: Option<String>,
    pub agent_id: String,
    pub agent_kind: String,
    pub execution_root: String,
    pub isolation_kind: IsolationKind,
    pub isolation_ref: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub base: WorkspaceBaseSpec,
    #[serde(default)]
    pub workspace_key: Option<String>,
    #[serde(default)]
    pub execution_run_id: Option<String>,
    #[serde(default)]
    pub trace_id: Option<String>,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub attempt_id: Option<String>,
    #[serde(default)]
    pub provider_attempt_id: Option<String>,
    #[serde(default)]
    pub surface: Option<String>,
    #[serde(default)]
    pub tracking_policy: ResourceTrackingPolicy,
    pub baseline_revision: u64,
    pub state: RunState,
    pub created_at: i64,
    pub settled_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceChange {
    pub run_id: String,
    pub path: String,
    pub old_path: Option<String>,
    pub kind: ChangeKind,
    pub origin: ContributionOrigin,
    pub agent_id: Option<String>,
    pub media_type: String,
    pub size: u64,
    pub hash: Option<String>,
    pub before_hash: Option<String>,
    pub insertions: Option<u32>,
    pub deletions: Option<u32>,
    pub binary: bool,
    pub resource_kind: ResourceKind,
    pub before_mode: Option<u32>,
    pub after_mode: Option<u32>,
    pub sensitive: bool,
    pub revision: u64,
    #[serde(default)]
    pub capture_class: ResourceCaptureClass,
    #[serde(default = "default_true")]
    pub content_captured: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceEvent {
    pub event_id: String,
    pub task_id: String,
    pub run_id: String,
    pub seq: u64,
    pub observed_at: i64,
    pub kind: crate::ResourceEventKind,
    pub path: Option<String>,
    pub old_path: Option<String>,
    pub capture_class: ResourceCaptureClass,
    pub origin: ContributionOrigin,
    pub agent_id: Option<String>,
    pub evidence: ResourceEventEvidence,
    pub tool_call_id: Option<String>,
    pub media_type: Option<String>,
    pub size: Option<u64>,
    pub resource_kind: Option<ResourceKind>,
    pub sensitive: bool,
    pub provisional: bool,
    pub overflow: bool,
    pub resync_required: bool,
    pub reconciled: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceEventCounts {
    pub created: u64,
    pub modified: u64,
    pub deleted: u64,
    pub renamed: u64,
    pub source: u64,
    pub generated: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResourceSummary {
    pub run_id: String,
    pub counts: ResourceEventCounts,
    pub event_count: u64,
    pub overflow_count: u64,
    pub completeness: ResourceTimelineCompleteness,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResourceManifest {
    pub schema_version: u32,
    pub exported_at: i64,
    pub task: TaskWorkspace,
    pub runs: Vec<TaskRun>,
    pub resources: Vec<ResourceChange>,
    pub events: Vec<ResourceEvent>,
    pub summaries: Vec<TaskResourceSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchHunk {
    pub id: String,
    pub header: String,
    pub forward_patch_hash: String,
    pub inverse_patch_hash: String,
    /// Added/deleted source lines in this hunk. Persisted as metrics only so
    /// consumers can measure a partial apply without retaining patch text.
    #[serde(default)]
    pub additions: u32,
    #[serde(default)]
    pub deletions: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchFile {
    pub path: String,
    pub old_path: Option<String>,
    pub kind: ChangeKind,
    pub resource_kind: ResourceKind,
    pub before_hash: Option<String>,
    pub after_hash: Option<String>,
    pub before_mode: Option<u32>,
    pub after_mode: Option<u32>,
    pub binary: bool,
    pub hunks: Vec<PatchHunk>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedFile {
    pub path: String,
    pub before_apply_hash: Option<String>,
    pub after_apply_hash: Option<String>,
    pub before_kind: Option<ResourceKind>,
    pub after_kind: Option<ResourceKind>,
    pub before_mode: Option<u32>,
    pub after_mode: Option<u32>,
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSet {
    pub patch_id: String,
    pub task_id: String,
    pub run_id: String,
    pub state: PatchState,
    pub base_revision: u64,
    pub applied_revision: Option<u64>,
    pub files: Vec<PatchFile>,
    pub applied_files: Vec<AppliedFile>,
    /// Exact file/hunk selection used by the successful apply. An empty
    /// selection means every file. `applied_selection_known` distinguishes
    /// that from patch rows written before this field existed.
    #[serde(default)]
    pub applied_selection: Vec<PatchSelection>,
    #[serde(default)]
    pub applied_selection_known: bool,
    #[serde(default = "default_true")]
    pub reversible: bool,
    pub created_at: i64,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSelection {
    pub path: String,
    /// Empty means the whole file. Non-empty IDs select textual hunks.
    pub hunk_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchConflict {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub state: PatchState,
    pub revision: u64,
    pub conflicts: Vec<PatchConflict>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneOutcome {
    pub removed_task_ids: Vec<String>,
    pub removed_blob_count: u64,
    pub reclaimed_bytes: u64,
}

// ---------------------------------------------------------------------------
// ADR-0111 Managed Workspace Registry types
// ---------------------------------------------------------------------------
//
// These types are additive — the existing Task Workspace surface stays intact.
// The Registry (see `registry.rs`) is the single owner of managed workspace
// lifecycle; `bundle.rs` composes them into a multi-root atomic apply unit.
//
// Fields are named to match the ADR-0111 record layout so wire encodings stay
// stable across Rust/TS boundaries.

/// Who created this managed workspace. Ownership determines whether the
/// Registry may prune or unlock the workspace during reconciliation.
///
/// `Imported` is reserved for worktrees discovered on disk that the Registry
/// cannot verify as its own — those rows never participate in auto-prune.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceOwnerType {
    User,
    Imported,
    Session,
    Team,
    Scheduled,
}

/// Product lifecycle of a physical execution environment.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceEnvironmentKind {
    #[default]
    Managed,
    Permanent,
    Imported,
}

/// Managed workspace lifecycle state. Transitions outside the Registry's
/// controlled paths are rejected fail-closed.
///
/// Legal transitions (all others error):
///
/// - `Provisioning → Active | Removing`
/// - `Active → Archived | Conflict | Removing`
/// - `Archived → Restorable | Removing`
/// - `Restorable → Active | Removing`
/// - `Conflict → Active | Removing`   (via `ConflictResolution`)
/// - `Removing → Removed`
///
/// `Removed` is terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceState {
    Provisioning,
    Active,
    Archived,
    Conflict,
    Restorable,
    Removing,
    Removed,
}

impl WorkspaceState {
    /// Returns `true` iff a workspace in this state may be automatically
    /// reclaimed by directory/snapshot retention.
    ///
    /// The ADR-0111 ineligibility list is the source of truth; this helper is
    /// the enforcement point everywhere retention runs.
    pub fn is_prunable(self) -> bool {
        matches!(self, WorkspaceState::Archived | WorkspaceState::Restorable)
    }
}

/// The base ref a managed workspace was materialized against.
///
/// Interactive worktrees default to `WorkingState` (dirty local content is
/// carried into the isolated root). Background and scheduled Git tasks
/// default to `RemoteDefault` and refresh `origin/HEAD` at fire time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorkspaceBaseSpec {
    /// Snapshot of the current working tree, including uncommitted edits.
    WorkingState,
    /// The current HEAD of the local branch.
    LocalHead,
    /// `origin/HEAD` (or the configured default branch), refreshed at
    /// acquisition.
    RemoteDefault,
    /// A specific git ref (branch, tag, commit).
    #[serde(rename_all = "camelCase")]
    GitRef { git_ref: String },
    /// A pull request head that the Registry will fetch.
    #[serde(rename_all = "camelCase")]
    PullRequest {
        provider: String,
        repo: String,
        number: u64,
        #[serde(default)]
        fetch_ref: Option<String>,
        #[serde(default)]
        head_sha: Option<String>,
    },
}

impl Default for WorkspaceBaseSpec {
    fn default() -> Self {
        Self::WorkingState
    }
}

impl WorkspaceBaseSpec {
    /// Encode the spec as a `(kind, ref)` pair for storage.
    ///
    /// `ref` is optional: it carries the git ref name for `GitRef` and a
    /// synthetic `<provider>#<repo>#<number>` for `PullRequest`. The other
    /// variants encode as `(kind, None)`.
    pub fn to_storage(&self) -> (WorkspaceBaseKind, Option<String>) {
        match self {
            WorkspaceBaseSpec::WorkingState => (WorkspaceBaseKind::WorkingState, None),
            WorkspaceBaseSpec::LocalHead => (WorkspaceBaseKind::LocalHead, None),
            WorkspaceBaseSpec::RemoteDefault => (WorkspaceBaseKind::RemoteDefault, None),
            WorkspaceBaseSpec::GitRef { git_ref } => {
                (WorkspaceBaseKind::GitRef, Some(git_ref.clone()))
            }
            WorkspaceBaseSpec::PullRequest {
                provider,
                repo,
                number,
                fetch_ref,
                head_sha,
            } => (
                WorkspaceBaseKind::PullRequest,
                Some(format!(
                    "{provider}#{repo}#{number}#{}#{}",
                    fetch_ref.as_deref().unwrap_or_default(),
                    head_sha.as_deref().unwrap_or_default()
                )),
            ),
        }
    }

    /// Rebuild a spec from its stored `(kind, ref)` pair.
    ///
    /// Returns an error if `ref` is missing when required by `kind`, or if a
    /// `PullRequest` marker fails to parse. This is the load-side inverse of
    /// `to_storage`.
    pub fn from_storage(kind: WorkspaceBaseKind, base_ref: Option<&str>) -> Result<Self, String> {
        match kind {
            WorkspaceBaseKind::WorkingState => Ok(WorkspaceBaseSpec::WorkingState),
            WorkspaceBaseKind::LocalHead => Ok(WorkspaceBaseSpec::LocalHead),
            WorkspaceBaseKind::RemoteDefault => Ok(WorkspaceBaseSpec::RemoteDefault),
            WorkspaceBaseKind::GitRef => base_ref
                .map(|value| WorkspaceBaseSpec::GitRef {
                    git_ref: value.to_string(),
                })
                .ok_or_else(|| "gitRef base spec is missing its ref".to_string()),
            WorkspaceBaseKind::PullRequest => {
                let value = base_ref
                    .ok_or_else(|| "pullRequest base spec is missing its marker".to_string())?;
                let mut parts = value.splitn(5, '#');
                let provider = parts
                    .next()
                    .ok_or_else(|| "pullRequest marker missing provider".to_string())?;
                let repo = parts
                    .next()
                    .ok_or_else(|| "pullRequest marker missing repo".to_string())?;
                let number = parts
                    .next()
                    .ok_or_else(|| "pullRequest marker missing number".to_string())?
                    .parse::<u64>()
                    .map_err(|error| format!("pullRequest marker number: {error}"))?;
                let fetch_ref = parts
                    .next()
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string);
                let head_sha = parts
                    .next()
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string);
                Ok(WorkspaceBaseSpec::PullRequest {
                    provider: provider.to_string(),
                    repo: repo.to_string(),
                    number,
                    fetch_ref,
                    head_sha,
                })
            }
        }
    }
}

/// Storage-side discriminant for `WorkspaceBaseSpec`. Kept as its own enum so
/// SQLite rows encode a stable short string independent of the JSON shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceBaseKind {
    WorkingState,
    LocalHead,
    RemoteDefault,
    GitRef,
    PullRequest,
}

/// One row in the Registry. Combines ownership, lifecycle, and the physical
/// isolation location.
///
/// `execution_root` is the on-disk path handed to executors. For Git
/// workspaces it is the worktree path; for `Shadow` it is the materialized
/// scratch directory. Trust is a separate axis and is not encoded here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub workspace_id: String,
    #[serde(default)]
    pub environment_kind: WorkspaceEnvironmentKind,
    pub owner_type: WorkspaceOwnerType,
    pub owner_ref: Option<String>,
    pub state: WorkspaceState,
    pub source_root: String,
    pub git_common_dir: Option<String>,
    pub base: WorkspaceBaseSpec,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub isolation_kind: IsolationKind,
    pub execution_root: String,
    pub snapshot_task_id: Option<String>,
    pub size_bytes: Option<u64>,
    pub last_used_at: i64,
    pub locked_by: Option<String>,
    pub pinned: bool,
    pub created_at: i64,
}

/// A worker-local mapping from a stable repository ref to a trusted Git root.
/// Paths never leave the worker; remote callers use `binding_ref` only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSourceBinding {
    pub binding_ref: String,
    pub source_root: String,
    pub git_common_dir: String,
    pub repository_fingerprint: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// The role a logical root plays inside a Bundle.
///
/// Exactly one lease must be `Primary`; the rest are `Additional` (forwarded
/// as `additionalDirectories` when the executor spawns).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceRootRole {
    Primary,
    Additional,
}

/// One logical root inside a Bundle, resolved to its physical execution
/// location.
///
/// `alias_path` is the path executors see. Multiple leases may point at the
/// same physical worktree when they share a Git common dir — the Bundle
/// composer collapses roots by `git_common_dir` before creating worktrees.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRootLease {
    pub bundle_id: String,
    pub workspace_id: String,
    pub logical_root_id: String,
    pub role: WorkspaceRootRole,
    pub alias_path: String,
}

/// One logical root requested for transactional bundle acquisition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBundleRootInput {
    pub logical_root_id: String,
    pub role: WorkspaceRootRole,
    pub source_root: String,
}

/// Filesystem-bound request to provision every writable root for one task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquireWorkspaceBundle {
    pub owner_type: WorkspaceOwnerType,
    pub owner_ref: Option<String>,
    #[serde(default)]
    pub environment_kind: WorkspaceEnvironmentKind,
    #[serde(default)]
    pub base: WorkspaceBaseSpec,
    pub roots: Vec<WorkspaceBundleRootInput>,
}

/// A collection of `WorkspaceRootLease`s acquired atomically for one execution.
///
/// The Registry acquires a Bundle in one call; on failure it rolls back every
/// lease it already provisioned. See `bundle.rs` for the acquisition and
/// atomic-apply implementations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBundle {
    pub bundle_id: String,
    #[serde(default)]
    pub environment_kind: WorkspaceEnvironmentKind,
    pub owner_type: WorkspaceOwnerType,
    pub owner_ref: Option<String>,
    pub state: WorkspaceState,
    pub leases: Vec<WorkspaceRootLease>,
    pub last_used_at: i64,
    pub pinned: bool,
    pub created_at: i64,
}

/// Outcome of a `WorkspaceBundle` apply. On compensation failure the bundle
/// ends up in `state = Conflict` and `conflicts` is non-empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBundleOutcome {
    pub bundle_id: String,
    pub applied: Vec<String>,
    pub rolled_back: Vec<String>,
    pub conflicts: Vec<PatchConflict>,
    pub state: WorkspaceState,
}

/// Retention policy inputs. All three knobs are user-adjustable in settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLifecyclePolicy {
    pub active_directory_cap: u32,
    pub snapshot_retention_days: u32,
    pub blob_budget_bytes: u64,
}

impl Default for WorkspaceLifecyclePolicy {
    /// ADR-0111 defaults: 15 active directories, 30-day snapshot retention,
    /// 1 GiB blob budget.
    fn default() -> Self {
        Self {
            active_directory_cap: 15,
            snapshot_retention_days: 30,
            blob_budget_bytes: 1 << 30,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracking_policy_defaults_to_safe_auto_detection() {
        let policy: ResourceTrackingPolicy = serde_json::from_str("{}").unwrap();
        assert!(policy.auto_detect);
        assert!(policy.generated_output_roots.is_empty());
    }

    #[test]
    fn legacy_resource_changes_default_to_captured_source() {
        let mut value = serde_json::to_value(ResourceChange {
            run_id: "run-1".into(),
            path: "src/a.ts".into(),
            old_path: None,
            kind: ChangeKind::Modified,
            origin: ContributionOrigin::Agent,
            agent_id: Some("agent-1".into()),
            media_type: "text/typescript".into(),
            size: 1,
            hash: None,
            before_hash: None,
            insertions: None,
            deletions: None,
            binary: false,
            resource_kind: ResourceKind::File,
            before_mode: None,
            after_mode: None,
            sensitive: false,
            revision: 1,
            capture_class: ResourceCaptureClass::Source,
            content_captured: true,
        })
        .unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("captureClass");
        object.remove("contentCaptured");
        let decoded: ResourceChange = serde_json::from_value(value).unwrap();
        assert_eq!(decoded.capture_class, ResourceCaptureClass::Source);
        assert!(decoded.content_captured);
    }

    #[test]
    fn base_spec_round_trips_through_storage_encoding() {
        for spec in [
            WorkspaceBaseSpec::WorkingState,
            WorkspaceBaseSpec::LocalHead,
            WorkspaceBaseSpec::RemoteDefault,
            WorkspaceBaseSpec::GitRef {
                git_ref: "refs/heads/main".into(),
            },
            WorkspaceBaseSpec::PullRequest {
                provider: "github".into(),
                repo: "acme/app".into(),
                number: 42,
                fetch_ref: Some("refs/pull/42/head".into()),
                head_sha: Some("0123456789abcdef0123456789abcdef01234567".into()),
            },
        ] {
            let (kind, base_ref) = spec.to_storage();
            let decoded = WorkspaceBaseSpec::from_storage(kind, base_ref.as_deref()).unwrap();
            assert_eq!(spec, decoded, "spec {spec:?} did not round-trip");
        }
    }

    #[test]
    fn legacy_pull_request_base_decodes_without_claiming_resolution() {
        let decoded = WorkspaceBaseSpec::from_storage(
            WorkspaceBaseKind::PullRequest,
            Some("github#acme/app#42"),
        )
        .unwrap();
        assert_eq!(
            decoded,
            WorkspaceBaseSpec::PullRequest {
                provider: "github".into(),
                repo: "acme/app".into(),
                number: 42,
                fetch_ref: None,
                head_sha: None,
            }
        );
    }

    #[test]
    fn base_spec_rejects_missing_git_ref() {
        let error = WorkspaceBaseSpec::from_storage(WorkspaceBaseKind::GitRef, None)
            .expect_err("must reject missing ref");
        assert!(error.contains("gitRef"));
    }

    #[test]
    fn base_spec_rejects_malformed_pull_request_marker() {
        let error = WorkspaceBaseSpec::from_storage(WorkspaceBaseKind::PullRequest, Some("bad"))
            .expect_err("must reject malformed marker");
        assert!(error.contains("pullRequest"));
    }

    #[test]
    fn only_archived_and_restorable_are_prunable() {
        for state in [
            WorkspaceState::Provisioning,
            WorkspaceState::Active,
            WorkspaceState::Conflict,
            WorkspaceState::Removing,
            WorkspaceState::Removed,
        ] {
            assert!(!state.is_prunable(), "{state:?} must be protected");
        }
        assert!(WorkspaceState::Archived.is_prunable());
        assert!(WorkspaceState::Restorable.is_prunable());
    }

    #[test]
    fn lifecycle_policy_defaults_match_adr_0111() {
        let policy = WorkspaceLifecyclePolicy::default();
        assert_eq!(policy.active_directory_cap, 15);
        assert_eq!(policy.snapshot_retention_days, 30);
        assert_eq!(policy.blob_budget_bytes, 1 << 30);
    }
}
