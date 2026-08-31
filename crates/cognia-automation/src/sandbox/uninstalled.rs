// ADR-0028 — `UninstalledSandboxBackend`. Originally the default
// `current_backend()` for every platform until Phase 4.2 / 4.3 / 4.4 ship.
//
// After 4.3 (macOS) and 4.4 (Linux) land, this is the fallback only for
// non-tier-1 OSes (BSD, etc.). Kept for that long-tail coverage.
#![allow(dead_code)]
//
// Honest about its state: every `run()` returns `SandboxError::Unavailable`,
// `is_available()` returns false, `first_time_setup()` returns
// `SetupRequired` so the renderer surfaces "Run setup" rather than silently
// running a no-op. The renderer's strict-mode policy (ADR-0028) then
// refuses the tool call cleanly — no bypass.

use async_trait::async_trait;

use crate::sandbox::traits::SandboxedExec;
use crate::sandbox::types::{
    SandboxCommand, SandboxError, SandboxHealth, SandboxPolicy, SandboxResult,
};

#[derive(Debug, Clone)]
pub struct UninstalledSandboxBackend {
    os: &'static str,
}

impl UninstalledSandboxBackend {
    pub fn new() -> Self {
        Self { os: detect_os() }
    }
}

impl Default for UninstalledSandboxBackend {
    fn default() -> Self {
        Self::new()
    }
}

fn detect_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

#[async_trait]
impl SandboxedExec for UninstalledSandboxBackend {
    async fn run(
        &self,
        _command: SandboxCommand,
        _policy: SandboxPolicy,
    ) -> Result<SandboxResult, SandboxError> {
        Err(SandboxError::Unavailable {
            reason: format!(
                "ADR-0028 sandbox backend for {} is not yet installed in this build",
                self.os
            ),
        })
    }

    fn is_available(&self) -> bool {
        false
    }

    async fn first_time_setup(&self) -> Result<(), SandboxError> {
        Err(SandboxError::SetupRequired {
            reason: format!(
                "no setup possible — ADR-0028 sandbox backend for {} is not bundled in this build",
                self.os
            ),
        })
    }

    fn health(&self) -> SandboxHealth {
        SandboxHealth {
            available: false,
            backend: format!("uninstalled-{}", self.os),
            version: String::new(),
            last_error: format!(
                "no sandbox backend bundled for {} yet — Phase 4.2/4.3/4.4 not shipped",
                self.os
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::time::Duration;

    use super::*;
    use crate::sandbox::types::NetworkPolicy;

    fn sample_cmd() -> SandboxCommand {
        SandboxCommand {
            argv: vec!["ls".into()],
            cwd: PathBuf::from("/tmp"),
            env: BTreeMap::new(),
            stdin: None,
            timeout: Duration::from_secs(5),
        }
    }

    fn sample_policy() -> SandboxPolicy {
        SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/tmp")],
            readable: vec![],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 5,
            max_memory_mb: 128,
        }
    }

    #[tokio::test]
    async fn run_always_returns_unavailable() {
        let backend = UninstalledSandboxBackend::new();
        let err = backend
            .run(sample_cmd(), sample_policy())
            .await
            .unwrap_err();
        assert!(matches!(err, SandboxError::Unavailable { .. }));
    }

    #[tokio::test]
    async fn is_available_is_false() {
        let backend = UninstalledSandboxBackend::new();
        assert!(!backend.is_available());
    }

    #[tokio::test]
    async fn first_time_setup_returns_setup_required() {
        let backend = UninstalledSandboxBackend::new();
        let err = backend.first_time_setup().await.unwrap_err();
        assert!(matches!(err, SandboxError::SetupRequired { .. }));
    }

    #[test]
    fn health_uses_uninstalled_prefix() {
        let backend = UninstalledSandboxBackend::new();
        let h = backend.health();
        assert!(!h.available);
        assert!(h.backend.starts_with("uninstalled-"));
        assert!(!h.last_error.is_empty());
    }

    #[test]
    fn detect_os_matches_current_platform() {
        let os = detect_os();
        #[cfg(target_os = "windows")]
        assert_eq!(os, "windows");
        #[cfg(target_os = "macos")]
        assert_eq!(os, "macos");
        #[cfg(target_os = "linux")]
        assert_eq!(os, "linux");
        // Other OSes (BSD, etc.) report "unknown" — accept either, depending
        // on the host running the test.
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        assert_eq!(os, "unknown");
        // Silence unused warning on the platforms above.
        let _ = os;
    }
}
