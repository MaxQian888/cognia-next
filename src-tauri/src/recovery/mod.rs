//! ADR-0067 Tier C facade — the recovery runtime moved to
//! `cognia_observability::recovery_runtime`; only the Tauri command shells stay
//! here, matching the `proxy_config` / `keyring_secrets` facade pattern.
//!
//! Re-exported wholesale so every `crate::recovery::…` call site — the sidecar
//! supervisor (`claude/sidecar.rs`), the Tauri `setup` hook and the diagnostics
//! IPC in `lib.rs` — resolves unchanged.

pub use cognia_observability::recovery_runtime::*;

pub mod commands;
