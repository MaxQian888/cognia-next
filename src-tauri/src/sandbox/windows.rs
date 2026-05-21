// ADR-0028 Phase 4.2 / Phase 13 — Windows backend.
//
// Composes two shipped binaries:
//
//   - `cognia-sandbox-setup.exe` — UAC-elevated, idempotent. Creates the
//     two synthetic users (`CogniaSandboxOffline` / `CogniaSandboxOnline`)
//     and installs per-SID Firewall rules. `--uninstall` reverses the
//     setup; the WiX/NSIS uninstall hook calls it on app removal.
//   - `cognia-sandbox-runner.exe` — non-elevated. Re-launches the
//     requested argv under the synthetic user via
//     `runas /user:<…> /trustlevel:0x20000`, capturing the exit code
//     and timing into a JSON `SandboxResult`.
//
// The backend's `run()` serialises the `SandboxCommand` into the runner's
// JSON contract and shells out. `first_time_setup()` invokes the setup
// binary through `runas` (UAC prompt surfaces here). Health resolves to
// "Active" once the setup marker file exists; until then we honestly
// report `SetupRequired` so the renderer's strict-mode refusal kicks in
// — no silent fallback to unsandboxed execution.
//
// The codex-rs `windows-sandbox-rs` vendoring referenced in ADR-0028
// §"Open follow-ups" remains the natural next step: it replaces the
// runner's `runas /trustlevel` mechanism with a proper restricted-token
// + `CreateProcessAsUser` flow. The current shape gives us the synthetic-
// user + per-SID Firewall scaffolding while the deeper restricted-token
// work lands incrementally.

#![allow(dead_code)]

use async_trait::async_trait;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use crate::sandbox::traits::SandboxedExec;
use crate::sandbox::types::{
    NetworkPolicy, SandboxCommand, SandboxError, SandboxHealth, SandboxPolicy, SandboxResult,
};

pub const OFFLINE_USER: &str = "CogniaSandboxOffline";
pub const ONLINE_USER: &str = "CogniaSandboxOnline";

/// Returns the path the setup binary writes when it finishes
/// successfully. Used as a cheap availability probe.
pub fn marker_path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("cognia").join("sandbox").join("setup.ok"))
}

#[derive(Debug, Clone, Default)]
pub struct WindowsSandboxBackend {
    /// Overrides for tests — production constructs `WindowsSandboxBackend::new`.
    setup_binary: Option<PathBuf>,
    runner_binary: Option<PathBuf>,
    marker_override: Option<PathBuf>,
}

impl WindowsSandboxBackend {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_paths(setup: PathBuf, runner: PathBuf, marker: PathBuf) -> Self {
        Self {
            setup_binary: Some(setup),
            runner_binary: Some(runner),
            marker_override: Some(marker),
        }
    }

    fn setup_path(&self) -> PathBuf {
        self.setup_binary
            .clone()
            .unwrap_or_else(|| PathBuf::from("cognia-sandbox-setup.exe"))
    }

    fn runner_path(&self) -> PathBuf {
        self.runner_binary
            .clone()
            .unwrap_or_else(|| PathBuf::from("cognia-sandbox-runner.exe"))
    }

    fn marker(&self) -> Option<PathBuf> {
        self.marker_override.clone().or_else(marker_path)
    }

    fn target_user_for(&self, policy: &SandboxPolicy) -> &'static str {
        // Online tier is reserved for sandbox policies that grant network;
        // every other shape goes to the offline user.
        let network = match policy {
            SandboxPolicy::Bash { network, .. } => network,
            SandboxPolicy::Edit { .. }
            | SandboxPolicy::Write { .. }
            | SandboxPolicy::TextEditor { .. } => &NetworkPolicy::Off,
        };
        match network {
            NetworkPolicy::Off => OFFLINE_USER,
            NetworkPolicy::On | NetworkPolicy::Allowlist { .. } => ONLINE_USER,
        }
    }
}

#[async_trait]
impl SandboxedExec for WindowsSandboxBackend {
    async fn run(
        &self,
        command: SandboxCommand,
        policy: SandboxPolicy,
    ) -> Result<SandboxResult, SandboxError> {
        if !self.is_available() {
            return Err(SandboxError::SetupRequired {
                reason: "Windows sandbox setup marker missing — run first_time_setup() first.".into(),
            });
        }
        let runner = self.runner_path();
        let target_user = self.target_user_for(&policy);
        let payload = build_runner_payload(target_user, &command);
        let serialised = serde_json::to_string(&payload).map_err(|err| {
            SandboxError::BackendFailed {
                reason: format!("serialise runner payload failed: {err}"),
            }
        })?;
        let output = Command::new(&runner)
            .arg(&serialised)
            .output()
            .map_err(|err| SandboxError::BackendFailed {
                reason: format!("spawn {runner:?} failed: {err}"),
            })?;
        if !output.status.success() {
            return Err(SandboxError::BackendFailed {
                reason: format!(
                    "runner exited {} — stderr: {}",
                    output.status.code().unwrap_or(-1),
                    String::from_utf8_lossy(&output.stderr)
                ),
            });
        }
        let parsed: RunnerOutput =
            serde_json::from_slice(&output.stdout).map_err(|err| {
                SandboxError::BackendFailed {
                    reason: format!("parse runner JSON failed: {err}"),
                }
            })?;
        Ok(SandboxResult {
            exit_code: parsed.exit_code,
            stdout: parsed.stdout,
            stderr: parsed.stderr,
            duration: Duration::from_millis(parsed.duration_ms),
            timed_out: parsed.timed_out,
        })
    }

    fn is_available(&self) -> bool {
        match self.marker() {
            Some(path) => path.exists(),
            None => false,
        }
    }

    async fn first_time_setup(&self) -> Result<(), SandboxError> {
        let setup = self.setup_path();
        // The renderer drives the UAC prompt by spawning the setup
        // binary via `runas` (Windows) — that surfaces the consent
        // dialog. We invoke it directly here for non-Windows builds /
        // unit tests; the renderer-side first-run wizard uses
        // ShellExecute("runas", ...) for the real elevation.
        let status = Command::new(&setup)
            .status()
            .map_err(|err| SandboxError::BackendFailed {
                reason: format!("spawn setup {setup:?} failed: {err}"),
            })?;
        if !status.success() {
            return Err(SandboxError::SetupRequired {
                reason: format!(
                    "setup exited {}; user may have denied UAC.",
                    status.code().unwrap_or(-1)
                ),
            });
        }
        if !self.is_available() {
            return Err(SandboxError::SetupRequired {
                reason: "setup exited 0 but the heartbeat marker is missing.".into(),
            });
        }
        Ok(())
    }

    fn health(&self) -> SandboxHealth {
        let available = self.is_available();
        SandboxHealth {
            available,
            backend: "windows-cognia-sandbox".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            last_error: if available {
                String::new()
            } else {
                "Sandbox setup has not been completed yet. Run Settings → Sandbox → \
                 Set up sandbox to trigger the UAC prompt."
                    .into()
            },
        }
    }
}

#[derive(serde::Serialize)]
struct RunnerPayload<'a> {
    target_user: &'a str,
    argv: &'a [String],
    cwd: String,
    env: Vec<(String, String)>,
    timeout_seconds: u64,
}

#[derive(serde::Deserialize)]
struct RunnerOutput {
    exit_code: i32,
    #[serde(default)]
    stdout: String,
    #[serde(default)]
    stderr: String,
    #[serde(default)]
    duration_ms: u64,
    #[serde(default)]
    timed_out: bool,
}

fn build_runner_payload<'a>(target_user: &'a str, command: &'a SandboxCommand) -> RunnerPayload<'a> {
    RunnerPayload {
        target_user,
        argv: &command.argv,
        cwd: command.cwd.to_string_lossy().into_owned(),
        env: command
            .env
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        timeout_seconds: command.timeout.as_secs(),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::time::Duration;

    use super::*;

    fn sample_cmd() -> SandboxCommand {
        SandboxCommand {
            argv: vec!["whoami".into()],
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
    async fn run_returns_setup_required_without_marker() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backend = WindowsSandboxBackend::with_paths(
            PathBuf::from("does-not-matter"),
            PathBuf::from("does-not-matter"),
            dir.path().join("missing.ok"),
        );
        let err = backend.run(sample_cmd(), sample_policy()).await.unwrap_err();
        assert!(matches!(err, SandboxError::SetupRequired { .. }));
    }

    #[test]
    fn is_available_reflects_marker_presence() {
        let dir = tempfile::tempdir().expect("tempdir");
        let marker = dir.path().join("setup.ok");
        let backend = WindowsSandboxBackend::with_paths(
            PathBuf::from("setup.exe"),
            PathBuf::from("runner.exe"),
            marker.clone(),
        );
        assert!(!backend.is_available());
        std::fs::write(&marker, b"2026-05-21").unwrap();
        assert!(backend.is_available());
    }

    #[test]
    fn target_user_picks_offline_when_network_off() {
        let backend = WindowsSandboxBackend::new();
        let user = backend.target_user_for(&sample_policy());
        assert_eq!(user, OFFLINE_USER);
    }

    #[test]
    fn target_user_picks_online_when_network_on() {
        let backend = WindowsSandboxBackend::new();
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/tmp")],
            readable: vec![],
            network: NetworkPolicy::On,
            max_cpu_seconds: 1,
            max_memory_mb: 64,
        };
        assert_eq!(backend.target_user_for(&policy), ONLINE_USER);
    }

    #[test]
    fn target_user_picks_online_when_allowlist() {
        let backend = WindowsSandboxBackend::new();
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/tmp")],
            readable: vec![],
            network: NetworkPolicy::Allowlist {
                hosts: vec!["api.example.com".into()],
            },
            max_cpu_seconds: 1,
            max_memory_mb: 64,
        };
        assert_eq!(backend.target_user_for(&policy), ONLINE_USER);
    }

    #[test]
    fn target_user_defaults_offline_for_file_tools() {
        let backend = WindowsSandboxBackend::new();
        let policy = SandboxPolicy::Edit {
            target_files: vec![PathBuf::from("c:\\\\x.txt")],
            readable: vec![],
        };
        assert_eq!(backend.target_user_for(&policy), OFFLINE_USER);
    }

    #[test]
    fn health_marks_unavailable_without_marker() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backend = WindowsSandboxBackend::with_paths(
            PathBuf::from("setup.exe"),
            PathBuf::from("runner.exe"),
            dir.path().join("missing.ok"),
        );
        let h = backend.health();
        assert!(!h.available);
        assert_eq!(h.backend, "windows-cognia-sandbox");
        assert!(!h.last_error.is_empty());
    }

    #[test]
    fn health_marks_active_when_marker_present() {
        let dir = tempfile::tempdir().expect("tempdir");
        let marker = dir.path().join("setup.ok");
        std::fs::write(&marker, b"").unwrap();
        let backend = WindowsSandboxBackend::with_paths(
            PathBuf::from("setup.exe"),
            PathBuf::from("runner.exe"),
            marker,
        );
        let h = backend.health();
        assert!(h.available);
        assert!(h.last_error.is_empty());
    }

    #[test]
    fn build_runner_payload_carries_argv_cwd_env_and_timeout() {
        let mut env = BTreeMap::new();
        env.insert("FOO".into(), "bar".into());
        let cmd = SandboxCommand {
            argv: vec!["echo".into(), "hi".into()],
            cwd: PathBuf::from("C:\\work"),
            env,
            stdin: None,
            timeout: Duration::from_secs(42),
        };
        let payload = build_runner_payload(OFFLINE_USER, &cmd);
        assert_eq!(payload.target_user, OFFLINE_USER);
        assert_eq!(payload.argv, &cmd.argv);
        assert_eq!(payload.cwd, "C:\\work");
        assert_eq!(payload.env, vec![("FOO".to_string(), "bar".to_string())]);
        assert_eq!(payload.timeout_seconds, 42);
    }
}
