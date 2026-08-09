//! Task-scoped workspace isolation and reversible resource ledger.
//!
//! This crate is transport-neutral. The Tauri desktop and `cognia-server`
//! install the same service and expose it through their existing command and
//! Companion transport surfaces.

mod bundle;
mod ledger;
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

pub use bundle::{
    execute_bundle_apply, plan_bundle_apply, plan_bundle_composition, ApplyStep, BundleApplier,
    BundleApplyPlan, BundleError, PhysicalLeaseGroup, RootRequest,
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
    AppliedFile, ApplyOutcome, BeginTaskRun, ChangeKind, ConflictResolution, ContributionOrigin,
    IsolationKind, PatchConflict, PatchFile, PatchHunk, PatchSelection, PatchSet, PatchState,
    PruneOutcome, ResourceCaptureClass, ResourceChange, ResourceEvent, ResourceEventCounts,
    ResourceEventEvidence, ResourceKind, ResourceTimelineCompleteness, ResourceTrackingPolicy,
    RunState, TaskResourceManifest, TaskResourceSummary, TaskRun, TaskWorkspace,
    TaskWorkspaceState, WorkspaceBaseKind, WorkspaceBaseSpec, WorkspaceBundle,
    WorkspaceBundleOutcome, WorkspaceLifecyclePolicy, WorkspaceOwnerType, WorkspaceRecord,
    WorkspaceRootLease, WorkspaceRootRole, WorkspaceState,
};
pub use watcher::{
    ResourceEventChange, ResourceEventKind, TaskWorkspaceEventSink, TaskWorkspaceResourceEvent,
    WatchManager,
};

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
