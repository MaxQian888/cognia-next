//! The SSH adapter (ADR-0235 P6): [`RemoteShell`] over a saved SSH profile.
//!
//! The connection is the terminal's own (`cognia_terminal::ssh::
//! open_hosted_exec`): the same dial and jump chain, the same TOFU
//! `known_hosts` the terminal trusts, credentials resolved from the OS keyring
//! in this process, and no forwards. The adapter adds only the mapping onto
//! the installer's four primitives.
//!
//! **Commands.** The remote login shell may be bash, zsh, fish or csh, and they
//! quote differently. So the command line is only `sh -s`, which every shell
//! runs the same way, and the request travels on stdin as a POSIX script
//! (`cd`, `exec env`, the quoted argv) that `sh` alone parses. Nothing from the
//! desktop's environment is passed, and the command's stdin is `/dev/null`.
//!
//! **Files.** `stat` and `upload` use SFTP on the same connection; `mkdirp` is
//! `mkdir -p`. SFTP checks size only, so the upload hashes what it streams
//! against the declared digest, and the session checks the remote file's
//! sha256 on the machine afterwards.
//!
//! **Outcomes.** A command the server never received, or refused to start, is
//! `NotStarted`; one that was sent and then lost its channel or deadline is
//! `Unknown`, as is an upload that wrote anything before failing.

use std::time::Duration;

use async_trait::async_trait;
use cognia_terminal::ssh::{HostedSshExec, SshExecError, SshExecOutput};
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{OpenFlags, StatusCode};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::shell::{
    ExecOutput, ExecRequest, RemoteOutcome, RemoteShell, RemoteStat, ShellError, UploadSource,
};

/// The command line every request runs: `sh` reading its script from stdin.
pub const SCRIPT_RUNNER: &str = "sh -s";

/// Wait budget for `mkdir -p`.
const MKDIR_WAIT: Duration = Duration::from_secs(30);

/// Bytes read from the local archive per SFTP write.
const UPLOAD_CHUNK_BYTES: usize = 256 * 1024;

/// What the adapter needs from an SSH connection. The terminal's
/// [`HostedSshExec`] is the real one; tests drive the adapter over a fake
/// exec and an in-memory SFTP server.
#[async_trait]
pub trait SshLink: Send + Sync {
    async fn exec(
        &self,
        command: &str,
        stdin: &[u8],
        wait: Duration,
        max_output_bytes: usize,
    ) -> Result<SshExecOutput, SshExecError>;
    async fn sftp(&self) -> Result<SftpSession, String>;
}

#[async_trait]
impl SshLink for HostedSshExec {
    async fn exec(
        &self,
        command: &str,
        stdin: &[u8],
        wait: Duration,
        max_output_bytes: usize,
    ) -> Result<SshExecOutput, SshExecError> {
        HostedSshExec::exec(self, command, stdin, wait, max_output_bytes).await
    }

    async fn sftp(&self) -> Result<SftpSession, String> {
        HostedSshExec::sftp(self).await
    }
}

/// A [`RemoteShell`] over one SSH connection.
pub struct SshShell<L: SshLink = HostedSshExec> {
    link: L,
    /// Opened on first use and kept; dropped after a transport failure so the
    /// next call opens a fresh one.
    sftp: tokio::sync::Mutex<Option<SftpSession>>,
}

impl<L: SshLink> SshShell<L> {
    pub fn new(link: L) -> Self {
        Self {
            link,
            sftp: tokio::sync::Mutex::new(None),
        }
    }

    pub fn link(&self) -> &L {
        &self.link
    }
}

/// `word` as one POSIX shell word: single-quoted, with each `'` closed,
/// escaped and reopened.
fn quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', r"'\''"))
}

fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The POSIX script that runs `request`, or why it cannot be expressed.
pub fn posix_script(request: &ExecRequest) -> Result<String, String> {
    let Some(program) = request.argv.first() else {
        return Err("an exec needs a program".into());
    };
    let words = request
        .argv
        .iter()
        .chain(request.cwd.iter())
        .chain(request.env.keys())
        .chain(request.env.values());
    for word in words {
        if word.contains('\0') {
            return Err("an argument holds a NUL byte".into());
        }
    }
    if let Some(name) = request.env.keys().find(|name| !is_env_name(name)) {
        return Err(format!("{name:?} is not an environment variable name"));
    }
    let mut script = String::new();
    if let Some(cwd) = &request.cwd {
        script.push_str(&format!("cd -- {} || exit 125\n", quote(cwd)));
    }
    script.push_str("exec");
    if !request.env.is_empty() {
        // `env` would read a program named `A=B` as one more assignment.
        if program.contains('=') {
            return Err("a program name with `=` cannot follow an environment".into());
        }
        script.push_str(" env");
        for (name, value) in &request.env {
            script.push(' ');
            script.push_str(&quote(&format!("{name}={value}")));
        }
    }
    for word in &request.argv {
        script.push(' ');
        script.push_str(&quote(word));
    }
    script.push_str(" </dev/null\n");
    Ok(script)
}

fn exec_outcome(result: Result<SshExecOutput, SshExecError>) -> RemoteOutcome<ExecOutput> {
    match result {
        Ok(output) => RemoteOutcome::Completed(ExecOutput {
            exit_code: output.exit_code,
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            truncated: output.truncated,
        }),
        Err(SshExecError::NotSent(detail)) => RemoteOutcome::NotStarted(ShellError::Fault(detail)),
        Err(SshExecError::Rejected(detail)) => {
            RemoteOutcome::NotStarted(ShellError::Refused(detail))
        }
        Err(SshExecError::Interrupted(detail)) => RemoteOutcome::Unknown(detail),
    }
}

/// An SFTP error on a step that changed nothing: the server's refusal, or a
/// transport fault.
fn untouched(error: &SftpError) -> ShellError {
    match error {
        SftpError::Status(_) => ShellError::Refused(error.to_string()),
        other => ShellError::Fault(other.to_string()),
    }
}

impl<L: SshLink> SshShell<L> {
    /// The SFTP session, opened on first use.
    async fn sftp_session(
        &self,
    ) -> Result<tokio::sync::MutexGuard<'_, Option<SftpSession>>, ShellError> {
        let mut guard = self.sftp.lock().await;
        if guard.is_none() {
            *guard = Some(self.link.sftp().await.map_err(ShellError::Fault)?);
        }
        Ok(guard)
    }

    async fn write_all(
        session: &SftpSession,
        path: &str,
        mut source: UploadSource,
    ) -> RemoteOutcome<()> {
        let mut file = match session
            .open_with_flags(
                path,
                OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
            )
            .await
        {
            Ok(file) => file,
            Err(error) => return RemoteOutcome::NotStarted(untouched(&error)),
        };
        let mut hasher = Sha256::new();
        let mut written: u64 = 0;
        let mut buffer = vec![0u8; UPLOAD_CHUNK_BYTES];
        loop {
            let read = match source.reader.read(&mut buffer).await {
                Ok(read) => read,
                Err(error) => {
                    return RemoteOutcome::Unknown(format!("reading the local archive: {error}"))
                }
            };
            if read == 0 {
                break;
            }
            written += read as u64;
            if written > source.len {
                return RemoteOutcome::Unknown("the local archive is longer than declared".into());
            }
            hasher.update(&buffer[..read]);
            if let Err(error) = file.write_all(&buffer[..read]).await {
                return RemoteOutcome::Unknown(format!("writing the remote file: {error}"));
            }
        }
        if let Err(error) = file.shutdown().await {
            return RemoteOutcome::Unknown(format!("closing the remote file: {error}"));
        }
        if written != source.len {
            return RemoteOutcome::Unknown(format!(
                "the local archive ended after {written} of {} bytes",
                source.len
            ));
        }
        if hex::encode(hasher.finalize()) != source.sha256.to_ascii_lowercase() {
            return RemoteOutcome::Unknown(
                "the streamed bytes do not match the declared sha256".into(),
            );
        }
        match session.metadata(path).await {
            Ok(metadata) if metadata.len() == source.len => RemoteOutcome::Completed(()),
            Ok(metadata) => RemoteOutcome::Unknown(format!(
                "the remote file holds {} of {} bytes",
                metadata.len(),
                source.len
            )),
            Err(error) => RemoteOutcome::Unknown(format!("checking the remote file: {error}")),
        }
    }
}

#[async_trait]
impl<L: SshLink> RemoteShell for SshShell<L> {
    async fn stat(&self, path: &str) -> RemoteOutcome<Option<RemoteStat>> {
        let mut guard = match self.sftp_session().await {
            Ok(guard) => guard,
            Err(error) => return RemoteOutcome::NotStarted(error),
        };
        let Some(session) = guard.as_ref() else {
            return RemoteOutcome::NotStarted(ShellError::Fault("no SFTP session".into()));
        };
        match session.metadata(path).await {
            Ok(metadata) => RemoteOutcome::Completed(Some(RemoteStat {
                is_dir: metadata.file_type().is_dir(),
                size: metadata.len(),
            })),
            Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => {
                RemoteOutcome::Completed(None)
            }
            Err(error) => {
                if !matches!(error, SftpError::Status(_)) {
                    *guard = None;
                }
                // A stat changes nothing, so it is safe to run again.
                RemoteOutcome::NotStarted(untouched(&error))
            }
        }
    }

    async fn mkdirp(&self, path: &str) -> RemoteOutcome<()> {
        let request = ExecRequest::new(["mkdir", "-p", "--", path], MKDIR_WAIT);
        match self.exec(request).await {
            RemoteOutcome::Completed(output) if output.success() => RemoteOutcome::Completed(()),
            RemoteOutcome::Completed(output) => RemoteOutcome::NotStarted(ShellError::Refused(
                format!("mkdir -p failed: {}", output.stderr.trim()),
            )),
            RemoteOutcome::NotStarted(error) => RemoteOutcome::NotStarted(error),
            RemoteOutcome::Unknown(detail) => RemoteOutcome::Unknown(detail),
        }
    }

    async fn upload(&self, path: &str, source: UploadSource) -> RemoteOutcome<()> {
        let mut guard = match self.sftp_session().await {
            Ok(guard) => guard,
            Err(error) => return RemoteOutcome::NotStarted(error),
        };
        let Some(session) = guard.as_ref() else {
            return RemoteOutcome::NotStarted(ShellError::Fault("no SFTP session".into()));
        };
        let outcome = Self::write_all(session, path, source).await;
        if !matches!(
            outcome,
            RemoteOutcome::Completed(()) | RemoteOutcome::NotStarted(ShellError::Refused(_))
        ) {
            *guard = None;
        }
        outcome
    }

    async fn exec(&self, request: ExecRequest) -> RemoteOutcome<ExecOutput> {
        let script = match posix_script(&request) {
            Ok(script) => script,
            Err(reason) => return RemoteOutcome::NotStarted(ShellError::Refused(reason)),
        };
        exec_outcome(
            self.link
                .exec(
                    SCRIPT_RUNNER,
                    script.as_bytes(),
                    request.wait,
                    request.max_output_bytes,
                )
                .await,
        )
    }
}

#[cfg(test)]
#[path = "ssh_tests.rs"]
mod tests;
