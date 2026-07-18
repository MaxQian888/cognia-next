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
mod types;

pub use resource::{
    is_sensitive_resource, read_text_resource, ResourceEncoding, ResourceRead,
    DEFAULT_TEXT_PREVIEW_BYTES, MAX_EDITOR_BYTES,
};
pub use service::{ServiceConfig, TaskWorkspaceService};
pub use types::{
    AppliedFile, ApplyOutcome, BeginTaskRun, ChangeKind, ContributionOrigin, IsolationKind,
    PatchConflict, PatchFile, PatchHunk, PatchSelection, PatchSet, PatchState, ResourceChange,
    ResourceKind, RunState, TaskRun, TaskWorkspace, TaskWorkspaceState,
};
