//! Task-scoped workspace isolation and reversible resource ledger.
//!
//! This crate is transport-neutral. The Tauri desktop and `cognia-server`
//! install the same service and expose it through their existing command and
//! Companion transport surfaces.

mod bundle;
mod ledger;
mod lifecycle;
mod mirror;
mod registry;
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
pub use mirror::{
    clone_args as mirror_clone_args, derive_args as mirror_derive_args,
    fetch_args as mirror_fetch_args, is_fresh as mirror_is_fresh, is_mirror,
    maintenance_commands as mirror_maintenance_commands, mirror_path, normalize_remote_url,
    reclaim_candidates as mirror_reclaim_candidates, stamp_fetch as mirror_stamp_fetch,
    MirrorError, DEFAULT_MIRROR_TTL,
};
pub use registry::{
    compose_lock_reason, parse_lock_reason, plan_directory_reclaim, plan_reconcile,
    plan_snapshot_expiration, validate_state_transition, DirectoryReclaimCandidate,
    DirectoryReclaimReason, ImportedWorkspaceHint, ReconcileOutcome, RegistryError,
    SnapshotExpirationCandidate, SnapshotExpirationReason, WorkspaceRegistry,
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
