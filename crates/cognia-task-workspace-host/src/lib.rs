//! The task-workspace host surface (ADR-0196 P6f): the process's service
//! slot, daily maintenance, the worktree-lifecycle hook sink, the resource
//! event sinks and the `task_workspace_*` command bodies, over the sync
//! `cognia-task-workspace` service. It owns the async runtime work that crate
//! deliberately keeps out.
//!
//! The commands live in [`host_surface`] rather than at this root: a
//! `#[tauri::command]` at a crate root collides with its own macro namespace.

pub mod host_surface;
