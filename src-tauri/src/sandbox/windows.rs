// ADR-0028 Phase 4 — Windows backend.
//
// `run()` serialises the `SandboxCommand` into the runner's JSON contract and
// shells out to `cognia-sandbox-runner.exe` — now the real restricted-token +
// low-integrity + Job Object runner living in its own workspace member crate
// (`crates/cognia-sandbox-runner`), which replaced the `runas /trustlevel`
// stopgap. Because that runner launches the child under a restricted SUBSET of
// the app's own token, `CreateProcessAsUserW` needs no SeAssignPrimaryToken
// privilege — so the sandbox needs **no UAC, no synthetic users, no setup**.
//
// Availability is therefore simply whether the bundled runner binary resolves
// next to the app executable; `first_time_setup()` is a no-op confirming that.
// Strict mode still holds: if the runner is missing we report `SetupRequired`
// rather than silently running unsandboxed.
//
// `cognia-sandbox-setup.exe` (synthetic users + per-SID Firewall) remains for
// the OPTIONAL kernel-enforced network-egress follow-up — it is no longer on
// the critical path for filesystem / privilege / process confinement.

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
        if let Some(p) = &self.runner_binary {
            return p.clone();
        }
        // Bundled alongside the app — resolve next to the running executable so
        // availability is checkable without relying on the cwd / PATH.
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let candidate = dir.join("cognia-sandbox-runner.exe");
                if candidate.exists() {
                    return candidate;
                }
            }
        }
        PathBuf::from("cognia-sandbox-runner.exe")
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
                reason: "Windows sandbox runner (cognia-sandbox-runner.exe) not found — reinstall."
                    .into(),
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
        // The restricted-token + low-integrity + Job Object runner needs no
        // elevated setup or synthetic users, so availability is simply whether
        // the bundled runner binary resolves.
        self.runner_path().exists()
    }

    async fn first_time_setup(&self) -> Result<(), SandboxError> {
        // No-op: a restricted token is a subset of our own, so
        // `CreateProcessAsUserW` needs no SeAssignPrimaryToken privilege — no
        // UAC, no synthetic users. "Setup" is just confirming the bundled
        // runner is present. (Optional per-SID Firewall rules for
        // kernel-enforced network egress remain a follow-up via
        // cognia-sandbox-setup.exe; they are not required for the
        // filesystem/privilege/process confinement this backend provides.)
        if self.is_available() {
            Ok(())
        } else {
            Err(SandboxError::SetupRequired {
                reason: format!(
                    "sandbox runner not found at {:?} — reinstall cognia (it ships bundled).",
                    self.runner_path()
                ),
            })
        }
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
                "Sandbox runner binary (cognia-sandbox-runner.exe) not found next to the app — \
                 reinstall to restore it."
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
    async fn run_returns_setup_required_without_runner() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backend = WindowsSandboxBackend::with_paths(
            PathBuf::from("does-not-matter"),
            dir.path().join("missing-runner.exe"),
            dir.path().join("missing.ok"),
        );
        let err = backend.run(sample_cmd(), sample_policy()).await.unwrap_err();
        assert!(matches!(err, SandboxError::SetupRequired { .. }));
    }

    #[test]
    fn is_available_reflects_runner_presence() {
        let dir = tempfile::tempdir().expect("tempdir");
        let runner = dir.path().join("cognia-sandbox-runner.exe");
        let backend = WindowsSandboxBackend::with_paths(
            PathBuf::from("setup.exe"),
            runner.clone(),
            dir.path().join("setup.ok"),
        );
        assert!(!backend.is_available());
        std::fs::write(&runner, b"MZ").unwrap();
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
    fn health_marks_unavailable_without_runner() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backend = WindowsSandboxBackend::with_paths(
            PathBuf::from("setup.exe"),
            dir.path().join("missing-runner.exe"),
            dir.path().join("missing.ok"),
        );
        let h = backend.health();
        assert!(!h.available);
        assert_eq!(h.backend, "windows-cognia-sandbox");
        assert!(!h.last_error.is_empty());
    }

    #[test]
    fn health_marks_active_when_runner_present() {
        let dir = tempfile::tempdir().expect("tempdir");
        let runner = dir.path().join("cognia-sandbox-runner.exe");
        std::fs::write(&runner, b"MZ").unwrap();
        let backend = WindowsSandboxBackend::with_paths(
            PathBuf::from("setup.exe"),
            runner,
            dir.path().join("setup.ok"),
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
