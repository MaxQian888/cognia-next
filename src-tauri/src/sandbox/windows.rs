// ADR-0028 Phase 4.2 — Windows backend.
//
// The real implementation vendors a subset of OpenAI's
// `codex-rs/windows-sandbox-rs` (Apache-2.0) per the vendoring plan in the
// background-research output captured during Phase 4.1 (~6,500–7,000 LOC
// of Windows-API code across ~30+ files plus two elevated binaries:
// `cognia-windows-sandbox-setup.exe` and `cognia-command-runner.exe`).
//
// The vendoring is a multi-day effort that involves:
//   1. Copy the Apache-2.0 licensed crate from `openai/codex` into
//      `src-tauri/vendor/windows-sandbox/`, preserve `LICENSE` + add
//      `THIRD_PARTY_NOTICES` per Apache-2.0 §4(b).
//   2. Rename crate / bins / library / synthetic users / state paths
//      from `Codex*` to `Cognia*`.
//   3. Replace upstream Codex-internal deps (`codex-protocol`,
//      `codex-utils-pty`, `codex-utils-string`, `codex-otel`) with
//      cognia equivalents or inline minimal copies.
//   4. Wire WiX/NSIS installer hooks for the two binaries + UAC manifest +
//      uninstall cleanup of synthetic users + Firewall rules.
//   5. Integration smoketests (port a slimmer subset of the upstream
//      `sandbox_smoketests.py`).
//
// Until that ships, the Windows backend honestly returns SetupRequired so
// the renderer's strict-mode policy refuses Bash / Edit / Write tool
// calls cleanly. macOS + Linux backends are V1; Windows is a tracked
// follow-up (ADR-0028 §"Open follow-ups").
//
// References:
//   - https://github.com/openai/codex/tree/main/codex-rs/windows-sandbox-rs
//   - https://openai.com/index/building-codex-windows-sandbox/
//   - ADR-0028 + plan-distributed-wren.md Phase 4.2

#![allow(dead_code)]

use async_trait::async_trait;

use crate::sandbox::traits::SandboxedExec;
use crate::sandbox::types::{SandboxCommand, SandboxError, SandboxHealth, SandboxPolicy, SandboxResult};

#[derive(Debug, Clone, Default)]
pub struct WindowsSandboxBackend;

impl WindowsSandboxBackend {
    pub fn new() -> Self {
        Self
    }
}

const VENDOR_PENDING_MSG: &str = "Windows sandbox vendoring (ADR-0028 Phase 4.2) is a tracked \
    follow-up. Until then this build refuses to claim sandboxed execution on Windows. \
    Either run cognia on macOS / Linux for sandbox coverage, or wait for the \
    codex-windows-sandbox vendoring commit to land.";

#[async_trait]
impl SandboxedExec for WindowsSandboxBackend {
    async fn run(
        &self,
        _command: SandboxCommand,
        _policy: SandboxPolicy,
    ) -> Result<SandboxResult, SandboxError> {
        // ADR-0028 strict mode: deny rather than degrade silently. The
        // renderer surfaces this as "Sandbox unavailable — Bash/Edit/Write
        // disabled on Windows in this build."
        Err(SandboxError::SetupRequired {
            reason: VENDOR_PENDING_MSG.into(),
        })
    }

    fn is_available(&self) -> bool {
        false
    }

    async fn first_time_setup(&self) -> Result<(), SandboxError> {
        Err(SandboxError::SetupRequired {
            reason: VENDOR_PENDING_MSG.into(),
        })
    }

    fn health(&self) -> SandboxHealth {
        SandboxHealth {
            available: false,
            backend: "windows-codex-vendor-pending".into(),
            version: String::new(),
            last_error: VENDOR_PENDING_MSG.into(),
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
            cwd: PathBuf::from("C:\\workspace"),
            env: BTreeMap::new(),
            stdin: None,
            timeout: Duration::from_secs(5),
        }
    }

    fn sample_policy() -> SandboxPolicy {
        SandboxPolicy::Bash {
            writable: vec![PathBuf::from("C:\\workspace")],
            readable: vec![],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 5,
            max_memory_mb: 128,
        }
    }

    #[tokio::test]
    async fn run_returns_setup_required_until_vendor_ships() {
        let backend = WindowsSandboxBackend::new();
        let err = backend.run(sample_cmd(), sample_policy()).await.unwrap_err();
        assert!(matches!(err, SandboxError::SetupRequired { .. }));
    }

    #[tokio::test]
    async fn first_time_setup_signals_vendor_pending() {
        let backend = WindowsSandboxBackend::new();
        let err = backend.first_time_setup().await.unwrap_err();
        assert!(matches!(err, SandboxError::SetupRequired { .. }));
    }

    #[test]
    fn health_marks_unavailable_with_vendor_pending_backend_id() {
        let backend = WindowsSandboxBackend::new();
        let h = backend.health();
        assert!(!h.available);
        assert_eq!(h.backend, "windows-codex-vendor-pending");
        assert!(!h.last_error.is_empty());
    }
}
