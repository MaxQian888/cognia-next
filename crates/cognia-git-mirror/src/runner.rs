//! Run one `git` command under a wall-clock budget, and actually stop it.
//!
//! # Why this is not `tokio::time::timeout`
//!
//! `crates/cognia-git/src/repo.rs` enforced the guarded-clone budget by wrapping
//! `exec::run` in `tokio::time::timeout`. `exec::run` awaits
//! `tokio::process::Command::output()`, and `tokio::process::Command` defaults
//! to `kill_on_drop(false)`. Dropping that future on timeout therefore does not
//! kill git. It leaves a `git clone` running, still writing into the directory
//! the timeout branch then deletes. The clone "timed out", the process did not.
//!
//! Polling `try_wait` and calling `kill` is the version that is true. It is
//! also why this module is sync: the budget is the only reason the old code
//! needed an async timer at all, and the callers already have a
//! `spawn_blocking` boundary.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::credential::{self, GitCredential};

/// How often the budget is checked. Short enough that a killed clone stops
/// promptly, long enough that a multi-minute clone is not a spin loop.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    /// `git` could not be launched at all.
    Spawn(String),
    /// `git` ran and failed. The text is already redacted.
    Failed(String),
    /// The budget elapsed. The child was killed and reaped before this
    /// returned, so a caller is free to delete the directory it was writing to.
    TimedOut(Duration),
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(detail) => write!(f, "git spawn: {detail}"),
            Self::Failed(detail) => write!(f, "git failed: {detail}"),
            Self::TimedOut(budget) => {
                write!(f, "git timed out after {}s", budget.as_secs())
            }
        }
    }
}

impl std::error::Error for RunError {}

/// What a command may carry. Separate from the credential so a caller cannot
/// forget the isolation env by passing `None` for the credential.
pub struct GitRun<'a> {
    pub cwd: &'a Path,
    pub args: &'a [String],
    /// `(origin, credential)`. The origin is the `https://<host>/` prefix the
    /// `extraheader` is keyed on. See [`credential::auth_env`].
    pub credential: Option<(&'a str, &'a GitCredential)>,
    /// `None` means no wall-clock limit.
    pub budget: Option<Duration>,
    /// Keep stdout. Off by default because most callers only need the status,
    /// and a clone's stdout is noise.
    pub capture_stdout: bool,
}

impl<'a> GitRun<'a> {
    pub fn new(cwd: &'a Path, args: &'a [String]) -> Self {
        Self {
            cwd,
            args,
            credential: None,
            budget: None,
            capture_stdout: false,
        }
    }

    pub fn credential(mut self, origin: &'a str, credential: &'a GitCredential) -> Self {
        self.credential = Some((origin, credential));
        self
    }

    pub fn maybe_credential(mut self, credential: Option<(&'a str, &'a GitCredential)>) -> Self {
        self.credential = credential;
        self
    }

    pub fn budget(mut self, budget: Duration) -> Self {
        self.budget = Some(budget);
        self
    }

    /// Take the caller's budget, whatever it is. The mirror inherits the
    /// budget of the clone it is serving rather than inventing one of its own:
    /// a cache that can outlive the request it exists to make faster is not a
    /// cache, it is a hang.
    pub fn maybe_budget(mut self, budget: Option<Duration>) -> Self {
        self.budget = budget;
        self
    }

    pub fn capture_stdout(mut self) -> Self {
        self.capture_stdout = true;
        self
    }
}

/// Run it. Blocking.
pub fn run_git(run: GitRun<'_>) -> Result<String, RunError> {
    let mut command = Command::new("git");
    command.current_dir(run.cwd).args(run.args);
    command.stdin(Stdio::null());
    command.stdout(if run.capture_stdout {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    command.stderr(Stdio::piped());

    let env = match run.credential {
        Some((origin, credential)) => credential::auth_env(origin, credential),
        None => credential::isolation_env(),
    };
    for (key, value) in env {
        command.env(key, value);
    }

    let cred = run.credential.map(|(_, credential)| credential);

    let Some(budget) = run.budget else {
        let output = command
            .output()
            .map_err(|e| RunError::Spawn(credential::redact(&e.to_string(), cred)))?;
        return finish(output, cred);
    };

    let mut child = command
        .spawn()
        .map_err(|e| RunError::Spawn(credential::redact(&e.to_string(), cred)))?;

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunError::Spawn(credential::redact(&e.to_string(), cred)));
            }
        }
        if started.elapsed() >= budget {
            // Kill AND reap. Without the wait the child is a zombie and the
            // directory it was writing to may still be growing when the caller
            // deletes it.
            let _ = child.kill();
            let _ = child.wait();
            return Err(RunError::TimedOut(budget));
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    let output = child
        .wait_with_output()
        .map_err(|e| RunError::Spawn(credential::redact(&e.to_string(), cred)))?;
    finish(output, cred)
}

/// Run it and report only whether it worked.
///
/// The mirror's callers all treat a failure as "use the network", and a cache
/// miss is not something to report to a user as an error. Output is discarded
/// rather than surfaced, which is the behaviour `run_mirror_git` had.
pub fn run_git_quietly(run: GitRun<'_>) -> bool {
    run_git(run).is_ok()
}

fn finish(output: std::process::Output, cred: Option<&GitCredential>) -> Result<String, RunError> {
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(RunError::Failed(
        credential::redact(stderr.trim(), cred).to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tempfile::TempDir;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn a_successful_command_can_return_its_stdout() {
        let dir = TempDir::new().unwrap();
        let out = run_git(GitRun::new(dir.path(), &args(&["--version"])).capture_stdout())
            .expect("git --version");
        assert!(out.starts_with("git version"), "{out}");
    }

    #[test]
    fn a_failing_command_reports_redacted_stderr() {
        let dir = TempDir::new().unwrap();
        let err = run_git(GitRun::new(
            dir.path(),
            &args(&[
                "-c",
                "protocol.file.allow=never",
                "ls-remote",
                "https://x-access-token:ghp_leak@127.0.0.1:1/o/r.git",
            ]),
        ))
        .expect_err("unreachable remote");
        let RunError::Failed(detail) = err else {
            panic!("expected a failure, got {err:?}");
        };
        assert!(!detail.contains("ghp_leak"), "{detail}");
    }

    #[test]
    fn a_timed_out_git_is_killed_not_merely_abandoned() {
        // `git` here is a stand-in for a clone that will not finish inside the
        // budget. The assertion that matters is not the error variant: it is
        // that `run_git` has already reaped the child by the time it returns,
        // so the caller's `remove_dir_all` cannot race a process still writing.
        let dir = TempDir::new().unwrap();
        let started = Instant::now();
        let err = run_git(
            GitRun::new(
                dir.path(),
                &args(&[
                    "-c",
                    "protocol.ext.allow=always",
                    "ls-remote",
                    "ext::sleep 30",
                ]),
            )
            .budget(Duration::from_millis(300)),
        )
        .expect_err("should not finish inside the budget");

        assert!(
            matches!(err, RunError::TimedOut(_)),
            "expected a timeout, got {err:?}"
        );
        // Returned promptly rather than after the child's own 30s.
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "run_git waited {:?}, so it did not kill the child",
            started.elapsed()
        );
    }

    #[test]
    fn a_command_without_a_budget_still_runs() {
        let dir = TempDir::new().unwrap();
        assert!(run_git_quietly(GitRun::new(
            dir.path(),
            &args(&["--version"])
        )));
    }

    #[test]
    fn the_credential_is_applied_as_config_not_as_an_argument() {
        // `git config --get` reads the env-based override, which is the whole
        // point: the token reached git without touching argv or any file.
        let dir = TempDir::new().unwrap();
        let credential = GitCredential::from_token("ghp_secret").unwrap();
        let out = run_git(
            GitRun::new(
                dir.path(),
                &args(&["config", "--get", "http.https://github.com/.extraheader"]),
            )
            .credential("https://github.com/", &credential)
            .capture_stdout(),
        )
        .expect("config --get");
        assert!(out.starts_with("Authorization: Basic "), "{out}");
        assert!(!out.contains("ghp_secret"), "{out}");
    }
}
