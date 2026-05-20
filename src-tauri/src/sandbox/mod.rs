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

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
pub mod mock;
pub mod policy;
pub mod traits;
pub mod types;
pub mod uninstalled;
#[cfg(target_os = "windows")]
pub mod windows;

use std::sync::Arc;

use crate::sandbox::traits::SandboxedExec;
use crate::sandbox::types::SandboxHealth;
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
use crate::sandbox::uninstalled::UninstalledSandboxBackend;

/// Backend selection. Single source of truth for the per-platform routing
/// table. Phase 4.3 + 4.4 land the real macOS + Linux backends; Windows is
/// a tracked follow-up that surfaces SetupRequired honestly until the
/// `codex-windows-sandbox` vendoring lands.
pub fn current_backend() -> Arc<dyn SandboxedExec> {
    #[cfg(target_os = "windows")]
    {
        Arc::new(windows::WindowsSandboxBackend::new())
    }
    #[cfg(target_os = "macos")]
    {
        Arc::new(macos::MacOsSandboxBackend::new())
    }
    #[cfg(target_os = "linux")]
    {
        // No bundled bwrap yet — the resolver falls back to system PATH.
        // Phase 8 (verification) wires the resource_dir lookup.
        Arc::new(linux::LinuxSandboxBackend::new(None))
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
    async fn current_backend_uses_per_platform_dispatch() {
        let backend = current_backend();
        let health = backend.health();
        #[cfg(target_os = "windows")]
        {
            // Vendor still pending — Phase 4.2 follow-up.
            assert_eq!(health.backend, "windows-codex-vendor-pending");
            assert!(!backend.is_available());
        }
        #[cfg(target_os = "macos")]
        {
            assert_eq!(health.backend, "macos-sandbox-exec");
        }
        #[cfg(target_os = "linux")]
        {
            assert_eq!(health.backend, "linux-bwrap");
        }
        // Silence on unsupported OS.
        let _ = health;
    }

    #[tokio::test]
    async fn sandbox_health_probe_reports_a_known_backend_id() {
        let health = sandbox_health_probe().await.unwrap();
        let ok = matches!(
            health.backend.as_str(),
            "windows-codex-vendor-pending"
                | "macos-sandbox-exec"
                | "linux-bwrap"
                | "mock"
        ) || health.backend.starts_with("uninstalled-");
        assert!(ok, "unexpected backend id: {}", health.backend);
    }
}
