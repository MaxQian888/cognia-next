//! Task-scoped workspace isolation and reversible resource ledger.
//!
//! This crate is transport-neutral. The Tauri desktop and `cognia-server`
//! install the same service and expose it through their existing command and
//! Companion transport surfaces.

mod bundle;
mod ledger;
mod lifecycle;
mod registry;
mod remote_source;
mod resource;
mod sensitive;
mod service;
mod snapshot;
mod store;
mod tracking;
mod transfer;
mod types;
mod watcher;
mod worker_cli;

pub use bundle::{
    execute_bundle_apply, plan_bundle_apply, plan_bundle_composition, ApplyStep, BundleApplier,
    BundleApplyPlan, BundleError, PhysicalLeaseGroup, RootRequest,
};
pub use lifecycle::{
    WorktreeLifecycleEmitter, WorktreeLifecycleEvent, WorktreeLifecycleKind, WorktreeLifecycleSink,
};
// ADR-0176. The mirror moved to `cognia-git-mirror`, a leaf `cognia-git` can
// also depend on. The algorithm is unchanged and these aliases are unchanged,
// so every existing caller compiles as it did. What moved with it is the part
// this crate never had: the orchestration that drives git, the cache root, and
// the credential policy.
pub use cognia_git_mirror::plan::{
    clone_args as mirror_clone_args, derive_args as mirror_derive_args,
    fetch_args as mirror_fetch_args, is_fresh as mirror_is_fresh, is_mirror,
    maintenance_commands as mirror_maintenance_commands, mirror_path, normalize_remote_url,
    reclaim_candidates as mirror_reclaim_candidates, stamp_fetch as mirror_stamp_fetch,
    MirrorError, DEFAULT_MIRROR_TTL,
};
// ADR-0176. Supplying a workspace from a remote, for a host with nobody at a
// terminal to clone it first.
pub use registry::{
    compose_lock_reason, parse_lock_reason, plan_directory_reclaim, plan_reconcile,
    plan_snapshot_expiration, validate_state_transition, DirectoryReclaimCandidate,
    DirectoryReclaimReason, ImportedWorkspaceHint, ReconcileOutcome, RegistryError,
    SnapshotExpirationCandidate, SnapshotExpirationReason, WorkspaceRegistry,
};
pub use remote_source::{
    ensure_remote_source, extra_refspecs_for, EnsureRemoteSource, RemoteSourceCheckout,
    REMOTE_SUPPLY_BUDGET, UPSTREAM_REMOTE,
};
pub use resource::{
    is_sensitive_resource, read_text_resource, ResourceEncoding, ResourceRead,
    DEFAULT_TEXT_PREVIEW_BYTES, MAX_EDITOR_BYTES,
};
pub use sensitive::{
    decide_access, validate_include_pattern, IncludePatternError, SensitiveAuditEntry,
    SensitiveDecision, SensitiveGrant, SensitiveGrantStore,
};
pub use service::{ServiceConfig, TaskWorkspaceService};
pub use transfer::{
    DownloadHandle, TransferChunk, TransferRegistry, UploadHandle, MAX_TRANSFER_CHUNK_BYTES,
};
pub use types::{
    AcquireWorkspaceBundle, AppliedFile, ApplyOutcome, BeginTaskRun, BeginWorkspaceBundleTurn,
    BundleHandoffOutcome, BundleHandoffRequest, BundleHandoffRootSelection,
    BundleHandoffUndoOutcome, ChangeKind, ConflictResolution, ContributionOrigin, IsolationKind,
    PatchConflict, PatchFile, PatchHunk, PatchSelection, PatchSet, PatchState, PruneOutcome,
    ResourceCaptureClass, ResourceChange, ResourceEvent, ResourceEventCounts,
    ResourceEventEvidence, ResourceKind, ResourceTimelineCompleteness, ResourceTrackingPolicy,
    RunState, TaskResourceManifest, TaskResourceSummary, TaskRun, TaskWorkspace,
    TaskWorkspaceState, WorkspaceBaseKind, WorkspaceBaseSpec, WorkspaceBundle,
    WorkspaceBundleOutcome, WorkspaceBundleRootInput, WorkspaceBundleTurnLease,
    WorkspaceBundleTurnOutcome, WorkspaceBundleTurnRunLease, WorkspaceBundleTurnRunOutcome,
    WorkspaceCacheLink, WorkspaceEnvironmentAction, WorkspaceEnvironmentKind,
    WorkspaceEnvironmentOwnership, WorkspaceEnvironmentSummary, WorkspaceLifecyclePolicy,
    WorkspaceMaintenanceEvent, WorkspaceMaintenanceEventKind, WorkspaceMaintenanceRequest,
    WorkspaceMaintenanceResult, WorkspaceOwnerType, WorkspaceProvisioning, WorkspaceRecord,
    WorkspaceRootLease, WorkspaceRootRole, WorkspaceSourceBinding, WorkspaceState,
};
pub use watcher::{
    ResourceEventChange, ResourceEventKind, TaskWorkspaceEventSink, TaskWorkspaceResourceEvent,
    WatchManager,
};
pub use worker_cli::run_worker_cli;

#[cfg(test)]
mod tests {
    use super::*;

    /// ADR-0175 B4. `closed_object` says every declared property is written.
    /// A field that carries `skip_serializing_if`, `skip_serializing` or
    /// `serde(flatten)` breaks that, and the published output contract would
    /// then demand a key the host does not always send, which the enforcing
    /// planes answer with `contract_output_violation`. The transform cannot
    /// see the contradiction at runtime because the omitted field is simply
    /// absent from the schema it receives, so the pairing is checked here,
    /// against this crate's own sources.
    #[test]
    fn no_wire_struct_claims_every_field_while_omitting_one() {
        let source_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut scanned = 0usize;
        let mut violations = Vec::new();
        for entry in std::fs::read_dir(&source_dir).expect("the crate has a src directory") {
            let path = entry.expect("readable directory entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path).expect("readable source file");
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            scanned += 1;
            violations.extend(
                cognia_problem::wire_schema::closed_object_pairing_violations(name, &source),
            );
        }
        assert!(
            scanned > 10,
            "only {scanned} source files scanned, the walk is broken and this test proves nothing"
        );
        assert!(violations.is_empty(), "{}", violations.join("\n"));
    }

    #[test]
    fn tracking_contract_is_exported_from_the_crate_root() {
        let policy = ResourceTrackingPolicy::default();
        assert!(policy.auto_detect);
        assert_eq!(
            ResourceCaptureClass::default(),
            ResourceCaptureClass::Source
        );
    }
}
