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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchHunk {
    pub id: String,
    pub header: String,
    pub forward_patch_hash: String,
    pub inverse_patch_hash: String,
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
    pub created_at: i64,
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
