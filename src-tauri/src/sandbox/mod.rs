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

/// Tauri-exposed execution dispatcher consumed by the
/// `cognia-sandboxed-tools` plugin (Phase 4.5). The renderer-side plugin
/// tool's `execute()` forwards every call here.
///
/// Flow: derive a `SandboxPolicy` from `(tool, request)` via
/// `policy::policy_for`, then dispatch to `current_backend().run(...)`.
/// Each call is also recorded in the shared `AuditRing` with
/// `Surface::Sandbox` (ADR-0028 Phase 14) so the Diagnostics tab can
/// surface allow/deny/error counts alongside the desktop-automation
/// surfaces.
///
/// Errors come back as `String` (Tauri can't serialize the rich
/// `SandboxError` enum directly without a custom impl); the plugin uses
/// `error.message` verbatim as the ToolResult error so the model sees the
/// same stderr-style failure a native shell command would emit.
#[tauri::command]
pub async fn sandbox_exec(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::automation::commands::AutomationState>,
    tool: String,
    command: crate::sandbox::types::SandboxCommand,
    request: crate::sandbox::policy::PolicyRequest,
) -> Result<crate::sandbox::types::SandboxResult, String> {
    use crate::automation::audit::{AuditEntry, Decision as AuditDecision};
    use crate::automation::permission::Surface;
    use std::time::Instant;
    use tauri::Emitter;

    let started = Instant::now();
    let stripped = tool.strip_prefix("sandbox_").unwrap_or(&tool).to_string();
    let cwd_label = command.cwd.to_string_lossy().into_owned();
    let policy = match crate::sandbox::policy::policy_for(&stripped, request) {
        Ok(p) => p,
        Err(err) => {
            let msg = err.to_string();
            let entry = state.audit.record(AuditEntry {
                id: String::new(),
                ts: chrono::Utc::now().timestamp_millis(),
                surface: Surface::Sandbox,
                plugin_id: None,
                command: tool.clone(),
                process_name: None,
                window_title: Some(cwd_label.clone()),
                decision: AuditDecision::Deny,
                reason: Some("invalid_policy".into()),
                duration_ms: started.elapsed().as_millis() as u64,
                error: Some(msg.clone()),
            });
            let _ = app.emit("automation:event", &entry);
            return Err(msg);
        }
    };
    let outcome = current_backend().run(command, policy).await;
    let entry = match &outcome {
        Ok(result) => AuditEntry {
            id: String::new(),
            ts: chrono::Utc::now().timestamp_millis(),
            surface: Surface::Sandbox,
            plugin_id: None,
            command: tool.clone(),
            process_name: None,
            window_title: Some(cwd_label),
            decision: AuditDecision::Allow,
            reason: None,
            duration_ms: result.duration.as_millis() as u64,
            error: if result.exit_code == 0 {
                None
            } else {
                Some(format!("exit_code={}", result.exit_code))
            },
        },
        Err(err) => AuditEntry {
            id: String::new(),
            ts: chrono::Utc::now().timestamp_millis(),
            surface: Surface::Sandbox,
            plugin_id: None,
            command: tool.clone(),
            process_name: None,
            window_title: Some(cwd_label),
            decision: AuditDecision::Deny,
            reason: Some("backend_error".into()),
            duration_ms: started.elapsed().as_millis() as u64,
            error: Some(err.to_string()),
        },
    };
    let recorded = state.audit.record(entry);
    let _ = app.emit("automation:event", &recorded);
    outcome.map_err(|e| e.to_string())
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
            // The Windows backend is the in-house "cognia-sandbox" runner
            // (see `windows.rs`). It is unavailable until the user completes
            // the elevated setup that writes the heartbeat marker, which a
            // clean test environment never has.
            assert_eq!(health.backend, "windows-cognia-sandbox");
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
            "windows-cognia-sandbox"
                | "macos-sandbox-exec"
                | "linux-bwrap"
                | "mock"
        ) || health.backend.starts_with("uninstalled-");
        assert!(ok, "unexpected backend id: {}", health.backend);
    }
}
