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
}
