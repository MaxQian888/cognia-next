//! What the installer needs from a remote machine, and nothing more.
//!
//! An adapter (the VS Code tunnel helper first, an SSH client later) answers
//! four primitives: `stat`, `mkdirp`, a streamed upload with a declared length
//! and digest, and a one-shot exec with argv, cwd, explicit env, a wait budget
//! and bounded output. The machine probe is built on exec here, so every
//! adapter reports the same facts the same way.
//!
//! Every result is a [`RemoteOutcome`]. `NotStarted` means the remote side
//! provably did nothing, so the step may be retried. `Unknown` means the
//! request may or may not have run (the transport broke mid-flight, the
//! helper crashed): like `IdempotencyDecision::Indeterminate` it is never
//! replayed. The installer stops and the next session re-inspects the machine.

use std::collections::BTreeMap;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::AsyncRead;

/// Why a remote step did not start, split the way `SandboxSpawnError` is.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ShellError {
    /// The remote said no: a missing binary, a permission, a path that is
    /// not allowed. Retrying the same request will not help.
    #[error("refused: {0}")]
    Refused(String),
    /// The channel failed before the request reached the remote. A retry may
    /// succeed.
    #[error("fault: {0}")]
    Fault(String),
}

/// The result of one remote request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteOutcome<T> {
    /// It ran to completion. For exec, a non-zero exit is still `Completed`.
    Completed(T),
    /// It provably did not run.
    NotStarted(ShellError),
    /// It may or may not have run. Never replayed.
    Unknown(String),
}

impl<T> RemoteOutcome<T> {
    pub fn map<U>(self, f: impl FnOnce(T) -> U) -> RemoteOutcome<U> {
        match self {
            Self::Completed(value) => RemoteOutcome::Completed(f(value)),
            Self::NotStarted(error) => RemoteOutcome::NotStarted(error),
            Self::Unknown(detail) => RemoteOutcome::Unknown(detail),
        }
    }
}

/// One exec. Never through a shell: `argv[0]` is the program.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecRequest {
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    /// Set on top of the remote login environment; nothing is inherited from
    /// the desktop.
    pub env: BTreeMap<String, String>,
    /// How long the adapter waits for exit before answering `Unknown`.
    pub wait: Duration,
    /// Output beyond this is dropped and `truncated` is set.
    pub max_output_bytes: usize,
    /// The output carries a credential (`pair --json`). Adapters must not log
    /// or trace it.
    pub secret_output: bool,
}

/// Default output bound for commands whose output the installer parses.
pub const DEFAULT_MAX_OUTPUT_BYTES: usize = 256 * 1024;

impl ExecRequest {
    pub fn new(argv: impl IntoIterator<Item = impl Into<String>>, wait: Duration) -> Self {
        Self {
            argv: argv.into_iter().map(Into::into).collect(),
            cwd: None,
            env: BTreeMap::new(),
            wait,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
            secret_output: false,
        }
    }

    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    pub fn secret(mut self) -> Self {
        self.secret_output = true;
        self
    }
}

/// What a completed exec produced.
#[derive(Clone, PartialEq, Eq)]
pub struct ExecOutput {
    /// `None` when the process was killed by a signal.
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}

impl ExecOutput {
    pub fn success(&self) -> bool {
        self.exit_code == Some(0)
    }
}

/// Output can hold a pair invitation; it is never printed whole.
impl std::fmt::Debug for ExecOutput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExecOutput")
            .field("exit_code", &self.exit_code)
            .field("stdout_bytes", &self.stdout.len())
            .field("stderr_bytes", &self.stderr.len())
            .field("truncated", &self.truncated)
            .finish()
    }
}

/// A remote path's kind and size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemoteStat {
    pub is_dir: bool,
    pub size: u64,
}

/// A local file streamed to the remote. The adapter must write exactly `len`
/// bytes and fail when the stream ends early or runs long.
pub struct UploadSource {
    pub len: u64,
    /// Hex SHA-256 of the bytes, checked again on the remote after upload.
    pub sha256: String,
    pub reader: Box<dyn AsyncRead + Send + Unpin>,
}

impl std::fmt::Debug for UploadSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UploadSource")
            .field("len", &self.len)
            .field("sha256", &self.sha256)
            .finish_non_exhaustive()
    }
}

/// The machine at the other end. Paths are remote POSIX paths.
#[async_trait]
pub trait RemoteShell: Send + Sync {
    async fn stat(&self, path: &str) -> RemoteOutcome<Option<RemoteStat>>;
    async fn mkdirp(&self, path: &str) -> RemoteOutcome<()>;
    async fn upload(&self, path: &str, source: UploadSource) -> RemoteOutcome<()>;
    async fn exec(&self, request: ExecRequest) -> RemoteOutcome<ExecOutput>;

    /// The machine facts the installer plans from. Built on [`Self::exec`] so
    /// every adapter answers it the same way; an adapter overrides it only to
    /// read the same facts more cheaply.
    async fn probe(&self) -> RemoteOutcome<RemoteProbe> {
        crate::probe::probe_via_exec(self).await
    }
}

/// The operating system the remote reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteOs {
    Linux,
    MacOs,
    Windows,
    Other(String),
}

/// The CPU architecture the remote reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteArch {
    X64,
    Arm64,
    Other(String),
}

/// The service manager a user-scope install can use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InitSystem {
    Systemd,
    Launchd,
    None,
}

/// What the probe found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteProbe {
    pub os: RemoteOs,
    pub arch: RemoteArch,
    pub init: InitSystem,
    /// `uname -n`. Typing it is the second confirmation for deleting the
    /// Host's data on this machine.
    pub hostname: String,
    /// The login user.
    pub user: String,
    pub home: String,
    /// systemd lingering for the user. `None` off Linux, or when `loginctl`
    /// could not say.
    pub linger: Option<bool>,
    /// The C library on Linux: `(major, minor)` of glibc. `None` for musl or
    /// when it could not be read.
    pub glibc: Option<(u32, u32)>,
    /// Bytes free on the filesystem holding `home`.
    pub free_bytes: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_keeps_not_started_and_unknown_as_they_are() {
        assert_eq!(
            RemoteOutcome::Completed(2).map(|n| n * 2),
            RemoteOutcome::Completed(4)
        );
        let refused: RemoteOutcome<i32> =
            RemoteOutcome::NotStarted(ShellError::Refused("no".into()));
        assert_eq!(
            refused.map(|n| n * 2),
            RemoteOutcome::NotStarted(ShellError::Refused("no".into()))
        );
        let unknown: RemoteOutcome<i32> = RemoteOutcome::Unknown("dropped".into());
        assert_eq!(
            unknown.map(|n| n * 2),
            RemoteOutcome::Unknown("dropped".into())
        );
    }

    #[test]
    fn a_request_starts_bounded_and_without_inherited_env() {
        let request = ExecRequest::new(["cognia-server", "pair"], Duration::from_secs(5))
            .env("COGNIA_DATA_DIR", "/d")
            .secret();
        assert_eq!(request.argv, vec!["cognia-server", "pair"]);
        assert_eq!(request.env.len(), 1);
        assert_eq!(request.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES);
        assert!(request.secret_output);
        assert!(!ExecRequest::new(["x"], Duration::ZERO).secret_output);
    }

    #[test]
    fn exec_output_debug_shows_sizes_never_content() {
        let output = ExecOutput {
            exit_code: Some(0),
            stdout: "cgnp4|owner-secret".into(),
            stderr: "token=abc".into(),
            truncated: false,
        };
        let shown = format!("{output:?}");
        assert!(!shown.contains("owner-secret"));
        assert!(!shown.contains("token=abc"));
        assert!(shown.contains("stdout_bytes: 18"));
        assert!(output.success());
        assert!(!ExecOutput {
            exit_code: None,
            ..output
        }
        .success());
    }
}
