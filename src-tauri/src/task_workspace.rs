//! The task-workspace host surface lives in `cognia_task_workspace_host`
//! (ADR-0196 P6f), re-exported here so `generate_handler!`'s
//! `task_workspace::…` and every `crate::task_workspace::…` path resolve
//! unchanged.

pub use cognia_task_workspace_host::host_surface::*;
