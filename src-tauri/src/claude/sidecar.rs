//! Desktop facade for the shared sidecar supervisor.
use std::path::PathBuf;
use tauri::AppHandle;

pub use cognia_sidecar::supervisor::*;

/// Shared sidecar directory installed by the host's first startup step.
pub fn sidecar_dir(_app: &AppHandle) -> Result<PathBuf, String> {
    cognia_sidecar::directory()
}

/// Resolve the absolute path to `sidecar/claude-host.mjs`, in both dev and
/// release builds. `pub(crate)` so `host::TauriSidecarHost` can delegate.
pub(crate) fn resolve_sidecar_script(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = sidecar_dir(app)?;
    // ADR-0090 Phase 3: the host entry is agent-host.mjs; claude-host.mjs
    // remains as a compatibility shim for stale bundles/spawn paths.
    let candidate = dir.join("agent-host.mjs");
    if candidate.exists() {
        return Ok(candidate);
    }
    let candidate = dir.join("claude-host.mjs");
    if candidate.exists() {
        return Ok(candidate);
    }
    Err(format!(
        "sidecar script not found at {}",
        candidate.display()
    ))
}

#[cfg(test)]
mod tests {
    #[test]
    fn runtime_surface_is_shared_with_headless_hosts() {
        let _state: cognia_sidecar::supervisor::SidecarState = super::SidecarState::new();
    }
}
