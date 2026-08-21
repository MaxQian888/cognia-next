//! ADR-0067 Tier C facade — the recovery runtime moved to
//! `cognia_observability::recovery_runtime`; only the Tauri command shells stay
//! here, matching the `proxy_config` / `keyring_secrets` facade pattern.
//!
//! Re-exported wholesale so every `crate::recovery::…` call site — the sidecar
//! supervisor (`claude/sidecar.rs`), the Tauri `setup` hook and the diagnostics
//! IPC in `lib.rs` — resolves unchanged.

pub use cognia_observability::recovery_runtime::*;

pub mod commands;

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_observability::recovery::{ChildAction, RecoverySubsystem};

    /// This module is a pure re-export after ADR-0067 Tier C, so what is worth
    /// pinning is the surface itself: every `crate::recovery::…` path that the
    /// sidecar supervisor, the Tauri `setup` hook and the diagnostics IPC rely
    /// on must still resolve here rather than only in `cognia-observability`.
    #[test]
    fn the_runtime_surface_is_re_exported_under_the_old_path() {
        let _: fn() -> Option<&'static std::sync::Arc<RecoveryController>> = controller;
        let _: fn(RecoverySubsystem) -> Option<ChildAction> = report_child_failure;
        let _: fn(RecoverySubsystem) -> bool = is_subsystem_disabled;
        let _: fn() -> Option<std::path::PathBuf> = diagnostics_dir;
        let _: fn() -> String = build_id;
    }

    /// No controller is published in a unit-test process, and the callers above
    /// must read that as "no recovery policy" rather than panicking.
    #[test]
    fn an_unpublished_controller_reads_as_absent_without_panicking() {
        assert!(!is_subsystem_disabled(RecoverySubsystem::Sidecar));
        assert!(!build_id().is_empty());
    }
}
