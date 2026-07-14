//! App-side facade over [`cognia_subscription`] (ADR-0067 Tier B).
//!
//! The vault/provider/discovery logic lives in the `cognia-subscription`
//! crate; this module re-exports it so existing `crate::subscription::…` call
//! sites (ccswitch, lib.rs `.manage()` + `generate_handler!`) are unchanged,
//! and keeps the top-level 17-command IPC surface (`commands.rs`) app-side —
//! it owns the sidecar-restart seam (`claude::sidecar`) and `ApiKeyState`.

pub use cognia_subscription::*;

pub mod commands;
pub mod volcengine;
