//! Foundation utilities shared across cognia subsystem crates (ADR-0067).
//!
//! Each module was extracted so subsystem crates can depend on it without an
//! upward edge into `app_lib`; `app_lib` re-aliases every one of them
//! (`pub use cognia_core::fs_atomic`, …) so existing `crate::fs_atomic::…`
//! call sites — in fleet, ccswitch, automation and the top-level modules —
//! are unchanged.
//!
//! Nothing here may take a `tauri` dependency: eight crates link `cognia-core`,
//! several of them deliberately headless.

pub mod command_error;
pub mod fs_atomic;
pub mod node_runtime;
pub mod supervision_backoff;
