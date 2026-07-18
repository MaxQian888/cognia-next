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
    AppliedFile, ApplyOutcome, BeginTaskRun, ChangeKind, ContributionOrigin, IsolationKind,
    PatchConflict, PatchFile, PatchHunk, PatchSelection, PatchSet, PatchState, PruneOutcome,
    ResourceChange, ResourceKind, RunState, TaskRun, TaskWorkspace, TaskWorkspaceState,
};
pub use watcher::{
    ResourceEventChange, ResourceEventKind, TaskWorkspaceEventSink, TaskWorkspaceResourceEvent,
    WatchManager,
};
