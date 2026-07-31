//! Task-scoped workspace isolation and reversible resource ledger.
//!
//! This crate is transport-neutral. The Tauri desktop and `cognia-server`
//! install the same service and expose it through their existing command and
//! Companion transport surfaces.

mod ledger;
mod resource;
mod service;
mod snapshot;
mod store;
mod tracking;
mod transfer;
mod types;
mod watcher;

pub use resource::{
    is_sensitive_resource, read_text_resource, ResourceEncoding, ResourceRead,
    DEFAULT_TEXT_PREVIEW_BYTES, MAX_EDITOR_BYTES,
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
    TaskWorkspaceState,
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
