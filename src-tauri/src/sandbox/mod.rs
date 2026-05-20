// ADR-0028 — sandbox module entry. Hosts the `SandboxedExec` trait
// (`traits.rs`), the data types (`types.rs`), the per-tool policy resolver
// (`policy.rs`), the production backends, the test mock (`mock.rs`), and
// the dispatcher + Tauri command surface below.
//
// `current_backend()` returns the per-platform real backend in `cfg`
// arms — today every platform routes to `UninstalledSandboxBackend`
// because Phase 4.2 / 4.3 / 4.4 haven't shipped yet. Each per-platform
// commit replaces just that one arm.
//
// `sandbox_exec` stays UNREGISTERED in `lib.rs::invoke_handler` until
// Phase 4.2+ provides a real backend on at least one OS. Only
// `sandbox_health_probe` (read-only diagnostic) is registered today so
// the Settings → Sandbox tab can render a meaningful status badge from
// `lib/claude/env-resolver.ts`-style helpers when those land in Phase 7.

pub mod mock;
pub mod policy;
pub mod traits;
pub mod types;
pub mod uninstalled;

use std::sync::Arc;

use crate::sandbox::traits::SandboxedExec;
use crate::sandbox::types::SandboxHealth;
use crate::sandbox::uninstalled::UninstalledSandboxBackend;

/// Backend selection. Single source of truth for the per-platform routing
/// table. Today every arm yields `UninstalledSandboxBackend`; Phase 4.2
/// (Windows) / 4.3 (macOS) / 4.4 (Linux) replace one arm each.
///
/// Returns `Arc<dyn SandboxedExec>` so callers can clone the handle into
/// async tasks without paying the trait-object setup cost per call.
pub fn current_backend() -> Arc<dyn SandboxedExec> {
    // Per-OS cfg arms are pre-wired here so the per-platform Phase 4.x
    // commits land as one-line swaps.
    #[cfg(target_os = "windows")]
    {
        Arc::new(UninstalledSandboxBackend::new())
    }
    #[cfg(target_os = "macos")]
    {
        Arc::new(UninstalledSandboxBackend::new())
    }
    #[cfg(target_os = "linux")]
    {
        Arc::new(UninstalledSandboxBackend::new())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Arc::new(UninstalledSandboxBackend::new())
    }
}

/// Tauri-exposed read-only diagnostic. The Settings → Sandbox tab
/// (Phase 7) polls this to drive the status badge ("Active" / "Setup
/// required" / "Unavailable") and the "Retry setup" button visibility.
///
/// Cheap — no I/O, no keyring, no spawn. Safe to poll on a 5s interval.
#[tauri::command]
pub async fn sandbox_health_probe() -> Result<SandboxHealth, String> {
    Ok(current_backend().health())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn current_backend_returns_uninstalled_until_phase_4_2() {
        let backend = current_backend();
        // is_available is false because no real per-platform backend has
        // shipped yet. The renderer's strict-mode policy refuses calls.
        assert!(!backend.is_available());
    }

    #[tokio::test]
    async fn sandbox_health_probe_reports_uninstalled() {
        let health = sandbox_health_probe().await.unwrap();
        assert!(!health.available);
        assert!(health.backend.starts_with("uninstalled-"));
    }
}
