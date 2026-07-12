//! Foundation utilities shared across cognia subsystem crates (ADR-0067).
//!
//! Currently just [`fs_atomic`] (atomic file writes with mtime guards + backup
//! rotation), extracted so the automation cluster can depend on it without an
//! upward edge into `app_lib`. `app_lib` re-aliases the module
//! (`pub use cognia_core::fs_atomic`) so existing `crate::fs_atomic::…` call
//! sites — in fleet, ccswitch, automation and the top-level modules — are
//! unchanged.

pub mod fs_atomic;
