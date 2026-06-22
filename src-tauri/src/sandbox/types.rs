// ADR-0028 — sandbox data types.
//
// `SandboxCommand` describes what to run; `SandboxPolicy` describes how to
// constrain it. The two are passed to `SandboxedExec::run`, which returns a
// `SandboxResult` (success) or `SandboxError` (refusal / runtime failure).
//
// These shapes are now consumed by the Tauri `sandbox_exec` command, the
// `cognia-sandboxed-tools` plugin, and the Computer Use native-tool route.
// Some variants remain cfg- or backend-specific, so keep the module-level
// allow to avoid noisy dead-code churn on hosts that do not compile every
// backend.
#![allow(dead_code)]
//
// The shapes are deliberately platform-agnostic — Windows / macOS / Linux
// backends translate the same `SandboxPolicy` into the restricted-token +
// low-integrity + Job Object runner, `sandbox-exec` SBPL profiles, and
// `bwrap` flags respectively.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Command to execute inside a sandbox. `argv[0]` is the program; rest are
/// arguments. The sandbox is responsible for launching it under whatever
/// restricted identity / namespace its backend uses.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SandboxCommand {
    /// `["bash", "-c", "ls -la"]` shape. `argv` is preserved as-given; the
    /// backend does NOT shell-interpret unless `argv[0]` is `bash` / `sh`
    /// (whose own shell-interpretation is then sandboxed).
    pub argv: Vec<String>,

    /// Working directory the spawned process starts in. Must be inside the
    /// `SandboxPolicy::writable` set (the backend enforces this); the
    /// dispatcher does not pre-check.
    pub cwd: PathBuf,

    /// Environment to set on the child. Use a `BTreeMap` rather than
    /// `HashMap` for deterministic ordering — useful for hashing / audit
    /// records and ergonomic test assertions.
    #[serde(default)]
    pub env: BTreeMap<String, String>,

    /// Optional stdin payload (e.g. for `bash -c "..."` plus piped input).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdin: Option<Vec<u8>>,

    /// Wall-clock timeout. When it fires the backend kills the whole sandbox
    /// process tree (Linux: bwrap `--die-with-parent` + the unshared PID ns;
    /// macOS: the child runs in its own session and the watchdog signals the
    /// process group; Windows: the runner's Job Object, with a host-side
    /// `kill_on_drop` margin). `Duration::from_secs(0)` means "no timeout" —
    /// the renderer must opt into that explicitly.
    #[serde(with = "duration_secs")]
    pub timeout: Duration,
}

/// Network egress shape. Each variant is honoured differently per backend:
/// Linux `bwrap` uses `--unshare-net` + optional `--share-net`; macOS
/// `sandbox-exec` uses `(allow|deny) network*`; Windows currently carries the
/// network choice in the runner payload while process / filesystem confinement
/// is provided by the restricted-token + low-integrity + Job Object runner.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NetworkPolicy {
    /// No network at all.
    Off,
    /// Only the listed hosts are reachable. Each entry is a DNS name (e.g.
    /// `api.anthropic.com`); the backend translates to firewall rules.
    Allowlist {
        #[serde(default)]
        hosts: Vec<String>,
    },
    /// Unrestricted egress.
    On,
}

impl Default for NetworkPolicy {
    fn default() -> Self {
        NetworkPolicy::Off
    }
}

/// What the sandbox is constraining for THIS tool call. Distinct variants
/// per high-risk tool because each has a different policy shape — Bash needs
/// network + cpu/mem caps, Edit only needs file write scoping.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "tool", rename_all = "snake_case")]
pub enum SandboxPolicy {
    /// Shell command. Network is opt-in (default deny). Filesystem read is
    /// limited to `readable`; write to `writable`. Resource caps are
    /// best-effort (Windows `JobObject` + macOS `ulimit` + Linux cgroup).
    Bash {
        #[serde(default)]
        writable: Vec<PathBuf>,
        #[serde(default)]
        readable: Vec<PathBuf>,
        #[serde(default)]
        network: NetworkPolicy,
        /// 0 = no cap.
        #[serde(default)]
        max_cpu_seconds: u32,
        /// 0 = no cap.
        #[serde(default)]
        max_memory_mb: u32,
    },
    /// `Edit` tool — modifies an existing file. `target_files` is the exact
    /// allowed write set; nothing else on the FS is writable. Reads
    /// fall through to `readable` for callsites that need to load
    /// neighbours (e.g., go-to-definition lookups by an LSP-aware editor).
    Edit {
        target_files: Vec<PathBuf>,
        #[serde(default)]
        readable: Vec<PathBuf>,
    },
    /// `Write` tool — creates / overwrites whole files. Same shape as Edit
    /// but semantically distinct (an Edit policy is tighter — only listed
    /// files writable, network always off).
    Write {
        target_files: Vec<PathBuf>,
        #[serde(default)]
        readable: Vec<PathBuf>,
    },
    /// Anthropic native `text_editor` — file edits driven by the model.
    /// Same shape as Edit; the discriminator lets backends apply tool-
    /// specific quotas if needed.
    TextEditor {
        target_files: Vec<PathBuf>,
        #[serde(default)]
        readable: Vec<PathBuf>,
    },
}

/// Result of a successful sandboxed execution. Stdout / stderr are returned
/// verbatim — no truncation in V1 (the renderer renders them inside the
/// tool-result message envelope and can elide there if needed).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxResult {
    /// Process exit code (0 = success). On signal termination, backends
    /// report 128 + signo (POSIX) or the raw exit code (Windows).
    pub exit_code: i32,
    /// UTF-8 stdout. Non-UTF-8 bytes are lossy-replaced.
    pub stdout: String,
    /// UTF-8 stderr. Non-UTF-8 bytes are lossy-replaced.
    pub stderr: String,
    /// Wall-clock duration the child ran for.
    #[serde(with = "duration_secs")]
    pub duration: Duration,
    /// True if the command was killed by the timeout watchdog.
    pub timed_out: bool,
}

/// Refusal or runtime failure. Surfaced to the renderer verbatim via the
/// `cognia-sandboxed-tools` plugin's ToolResult so the model sees the same
/// stderr-style error a native command would emit.
#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SandboxError {
    /// The current platform's backend isn't installed yet (Phase 4.x not
    /// shipped for this OS). The user-facing UX is "Settings → Sandbox →
    /// Retry setup" + a hard deny per ADR-0028 strict mode.
    #[error("sandbox unavailable: {reason}")]
    Unavailable { reason: String },
    /// First-time setup is required (for example, a missing bundled runner).
    /// Distinct from `Unavailable` so the renderer can show a "Run setup"
    /// button rather than "Reinstall".
    #[error("sandbox setup required: {reason}")]
    SetupRequired { reason: String },
    /// Policy itself is invalid (e.g. writable list empty for a Bash call
    /// that needs to write its cwd). Reported before any process spawn.
    #[error("invalid policy: {reason}")]
    InvalidPolicy { reason: String },
    /// Backend-side OS failure (failed to spawn, ACL apply failed, etc.).
    /// Carries the OS-level message so debugging is possible.
    #[error("backend failed: {reason}")]
    BackendFailed { reason: String },
    /// Wall-clock timeout fired. The whole sandbox process tree is killed
    /// (SIGKILL to the child's process group on unix; Job Object / kill_on_drop
    /// on Windows). Returned even if the child managed to emit some output
    /// before being killed — partial stdout / stderr are NOT preserved in
    /// the error variant; use a successful `SandboxResult.timed_out=true`
    /// path for partial-output cases.
    #[error("timeout after {seconds}s")]
    Timeout { seconds: u64 },
}

/// Health snapshot reported by `sandbox_health_probe`. The renderer's
/// Settings → Sandbox tab consumes this to drive the status badge + "Retry
/// setup" button.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxHealth {
    /// True when the backend is installed and ready to serve calls.
    pub available: bool,
    /// Stable backend id: `"windows-cognia-sandbox"`, `"macos-sandbox-exec"`,
    /// `"linux-bwrap"`, `"mock"`, or `"uninstalled-<os>"`. The renderer
    /// switches the badge label on this string.
    pub backend: String,
    /// Human-readable version / commit / SBPL-profile-set marker. Empty
    /// when the backend has nothing to surface.
    #[serde(default)]
    pub version: String,
    /// Last error observed (e.g. missing runner, runner exit code). Cleared on
    /// every successful call. Empty when no problem.
    #[serde(default)]
    pub last_error: String,
}

/// Helper module for `serde(with = …)` on `Duration` — emits a plain
/// integer-seconds count rather than the default `{secs, nanos}` blob that
/// would otherwise pollute IPC payloads.
mod duration_secs {
    use std::time::Duration;

    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(d: &Duration, s: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        s.serialize_u64(d.as_secs())
    }

    pub fn deserialize<'de, D>(d: D) -> Result<Duration, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(Duration::from_secs(u64::deserialize(d)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_policy_default_is_off() {
        assert_eq!(NetworkPolicy::default(), NetworkPolicy::Off);
    }

    #[test]
    fn sandbox_command_serializes_duration_as_seconds() {
        let cmd = SandboxCommand {
            argv: vec!["ls".into()],
            cwd: PathBuf::from("/tmp"),
            env: BTreeMap::new(),
            stdin: None,
            timeout: Duration::from_secs(42),
        };
        let json = serde_json::to_value(&cmd).unwrap();
        assert_eq!(json["timeout"], 42);
    }

    #[test]
    fn sandbox_policy_bash_roundtrips_through_json() {
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/workspace")],
            readable: vec![PathBuf::from("/usr")],
            network: NetworkPolicy::Allowlist {
                hosts: vec!["api.anthropic.com".into()],
            },
            max_cpu_seconds: 30,
            max_memory_mb: 512,
        };
        let json = serde_json::to_string(&policy).unwrap();
        let back: SandboxPolicy = serde_json::from_str(&json).unwrap();
        assert_eq!(policy, back);
    }

    #[test]
    fn sandbox_policy_tagged_discriminator_is_snake_case() {
        let policy = SandboxPolicy::TextEditor {
            target_files: vec![PathBuf::from("/tmp/a.txt")],
            readable: vec![],
        };
        let json = serde_json::to_value(&policy).unwrap();
        assert_eq!(json["tool"], "text_editor");
    }

    #[test]
    fn sandbox_error_display_is_user_readable() {
        let err = SandboxError::Unavailable {
            reason: "Linux bwrap binary missing from app resources".into(),
        };
        assert_eq!(
            err.to_string(),
            "sandbox unavailable: Linux bwrap binary missing from app resources"
        );
    }
}
