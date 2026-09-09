//! System-`git` runner for the Source Control subsystem.
//!
//! Mutating + network operations shell out to the user's `git` (this build of
//! libgit2 has `default-features = false` with no `https`/`ssh` transport, so
//! it *cannot* do network I/O — see `Cargo.toml`). Shelling out also means
//! `pre-commit`/`commit-msg`/`pre-push` hooks, GPG/SSH signing, gitattributes
//! filters, and the OS credential manager / SSH agent all work exactly as in
//! the user's own terminal — which git2 would bypass.
//!
//! The runner inherits the parent environment (so the credential manager and
//! SSH agent resolve), but forces non-interactive mode so a missing credential
//! fails fast instead of hanging the app on a hidden prompt.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use super::error::{Detail, GitError};

/// Strip embedded credentials from any text before it leaves the backend.
///
/// ADR-0176: one redactor. The regex that used to live here and the literal
/// token stripper that used to live in `github::workspace` are now the same
/// function, so a path that knows its token and a path that does not both get
/// the whole treatment. `None` here because this runner is never handed a
/// credential: it inherits the ambient credential manager instead, and the
/// credentialed URLs it must scrub are the ones git echoes back.
pub fn redact(text: &str) -> String {
    cognia_git_mirror::credential::redact(text, None)
}

/// Build a `git` command rooted at `cwd` with the standard non-interactive
/// environment. Never calls `.env_clear()` — the ambient credential manager,
/// SSH agent, `HOME`/`USERPROFILE`, `PATH`, and `GIT_*` all pass through.
fn base_command(cwd: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd)
        // Fail fast instead of blocking on a hidden credential prompt.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        // Non-interactive editors: accept the default message instead of
        // spawning vi/notepad (e.g. on `rebase|cherry-pick|revert --continue`).
        // `true` exits 0, keeping the prepared message.
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        // Deterministic English stderr so `classify_failure` can match it.
        .env("LC_ALL", "C")
        .env("LANG", "C");
    cmd
}

/// Map a non-zero git exit (with its stderr) to the most specific
/// [`GitError`] variant we can. Falls back to `CommandFailed`.
pub fn classify_failure(stderr: &str) -> GitError {
    let s = stderr.to_lowercase();
    // `Detail` redacts on Serialize/Display, so the payload is carried raw here
    // and stripped of any embedded credential when it leaves the backend.
    let detail: Detail = stderr.trim().into();
    if s.contains("author identity unknown")
        || s.contains("please tell me who you are")
        || s.contains("unable to auto-detect email address")
    {
        return GitError::IdentityRequired(detail);
    }
    if s.contains("authentication failed")
        || s.contains("could not read username")
        || s.contains("could not read password")
        || s.contains("permission denied (publickey)")
        || s.contains("terminal prompts disabled")
        || s.contains("invalid username or password")
        // HTTP 401/403 on the remote URL — an insufficient/expired token, not a
        // transport failure. Must precede the network branch below, since the
        // 403 string also contains "unable to access".
        || s.contains("the requested url returned error: 401")
        || s.contains("the requested url returned error: 403")
        || s.contains("401 unauthorized")
        || s.contains("403 forbidden")
    {
        return GitError::AuthRequired(detail);
    }
    // Before the conflict branch, though neither string contains "conflict":
    // these are refusals about WHERE a branch lives, and a caller can act on
    // them directly. `git switch` says "already used by worktree at", the
    // `checkout` fallback says "already checked out at".
    if s.contains("already used by worktree")
        || s.contains("is already checked out at")
        || s.contains("already checked out at")
    {
        return GitError::BranchCheckedOutElsewhere(detail);
    }
    if s.contains("is not fully merged") {
        return GitError::BranchNotFullyMerged(detail);
    }
    if s.contains("conflict") || s.contains("would be overwritten by merge") {
        return GitError::MergeConflict(detail);
    }
    if s.contains("patch does not apply")
        || s.contains("does not apply")
        || s.contains("corrupt patch")
    {
        return GitError::PatchFailed(detail);
    }
    if s.contains("index.lock") || (s.contains("unable to create") && s.contains(".lock")) {
        return GitError::LockHeld(detail);
    }
    if s.contains("could not resolve host")
        || s.contains("failed to connect")
        || s.contains("connection timed out")
        || s.contains("network is unreachable")
        || s.contains("unable to access")
    {
        return GitError::NetworkFailed(detail);
    }
    if s.contains("local changes")
        || s.contains("overwritten by checkout")
        || s.contains("please commit your changes or stash")
        // `worktree remove` refusing a dirty worktree. Same shape as the
        // others here: work would be lost, and `--force` is the way past.
        || s.contains("contains modified or untracked files")
    {
        return GitError::DirtyWorkingTree(detail);
    }
    GitError::CommandFailed(detail)
}

/// Translate a spawn failure (couldn't even launch `git`) into a typed error.
fn spawn_error(e: std::io::Error) -> GitError {
    if e.kind() == std::io::ErrorKind::NotFound {
        GitError::GitNotInstalled
    } else {
        GitError::CommandFailed(format!("git spawn: {e}").into())
    }
}

/// Run `git <args>` in `cwd`, discarding stdout. Errors are classified.
pub async fn run<I, S>(cwd: &Path, args: I) -> Result<(), GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let _perf = cognia_instrument::guard("git.exec");
    let output = base_command(cwd)
        .args(args)
        .output()
        .await
        .map_err(spawn_error)?;
    if !output.status.success() {
        return Err(classify_failure(&String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}

/// Whether a budgeted run finished on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Budgeted {
    Completed,
    /// The budget elapsed. The child was killed *and reaped* before this was
    /// returned, so a caller is free to delete the directory it was writing to.
    TimedOut,
}

/// Run `git <args>` in `cwd` under a wall-clock budget, and actually stop it.
///
/// `tokio::time::timeout(budget, run(..))` does not stop it.
/// `tokio::process::Command` defaults to `kill_on_drop(false)`, so dropping
/// that future on timeout leaves git running — still writing into the very
/// directory the timeout branch then deletes. The clone "timed out"; the
/// process did not. Keeping the child handle here means the budget ends with a
/// `kill` and a `wait`, and the caller deletes a directory nothing is writing
/// to.
///
/// stderr is drained on its own task rather than after the wait: a clone is
/// chatty, and a pipe nobody reads is a git that blocks on the write instead of
/// making progress.
pub async fn run_within<I, S>(cwd: &Path, args: I, budget: Duration) -> Result<Budgeted, GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let _perf = cognia_instrument::guard("git.exec");
    let mut child = base_command(cwd)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        // Belt and braces for the case the budget cannot cover: the whole
        // future being dropped (a cancelled caller, a runtime shutting down).
        .kill_on_drop(true)
        .spawn()
        .map_err(spawn_error)?;

    let pipe = child.stderr.take();
    let drain = tokio::spawn(async move {
        let mut buffer = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut buffer).await;
        }
        buffer
    });

    let status = match tokio::time::timeout(budget, child.wait()).await {
        Ok(status) => status.map_err(spawn_error)?,
        Err(_) => {
            // `kill` is start_kill + wait: the child is reaped, not merely
            // signalled, before the caller is told the budget elapsed.
            let _ = child.kill().await;
            let _ = drain.await;
            return Ok(Budgeted::TimedOut);
        }
    };

    let stderr = drain.await.unwrap_or_default();
    if !status.success() {
        return Err(classify_failure(&String::from_utf8_lossy(&stderr)));
    }
    Ok(Budgeted::Completed)
}

/// Run `git <args>` in `cwd` with extra environment variables layered on top
/// of the standard non-interactive base (used by interactive rebase to point
/// `GIT_SEQUENCE_EDITOR` / `GIT_EDITOR` at generated scripts).
pub async fn run_with_env<I, S>(cwd: &Path, args: I, envs: &[(&str, &str)]) -> Result<(), GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let mut cmd = base_command(cwd);
    cmd.args(args);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let output = cmd.output().await.map_err(spawn_error)?;
    if !output.status.success() {
        return Err(classify_failure(&String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}

/// Run `git <args>` in `cwd`, returning trimmed stdout.
pub async fn capture<I, S>(cwd: &Path, args: I) -> Result<String, GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let _perf = cognia_instrument::guard("git.exec");
    let output = base_command(cwd)
        .args(args)
        .output()
        .await
        .map_err(spawn_error)?;
    if !output.status.success() {
        return Err(classify_failure(&String::from_utf8_lossy(&output.stderr)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Run `git <args>` in `cwd` and report only whether it succeeded.
///
/// For the handful of git commands whose *answer* is the exit code rather than
/// an error: `merge-base --is-ancestor` exits 1 to mean "no", and
/// `rev-parse --verify --quiet` exits 1 to mean "that ref does not exist".
/// Routing those through [`run`] would turn a fact into a `CommandFailed`, and
/// the caller would have to string-match its way back to the boolean.
///
/// A spawn failure is still an error — "git is not installed" is not "no".
pub async fn succeeds<I, S>(cwd: &Path, args: I) -> Result<bool, GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let _perf = cognia_instrument::guard("git.exec");
    let output = base_command(cwd)
        .args(args)
        .output()
        .await
        .map_err(spawn_error)?;
    Ok(output.status.success())
}

/// Run `git <args>` in `cwd` and return everything it produced, exit status
/// included, without deciding that a non-zero exit was a failure.
///
/// For capability probes. `git <cmd> -h` prints its usage and exits 129 —
/// success by every measure that matters here — and a missing subcommand
/// reports "is not a git command" on stderr with a different non-zero code.
/// [`capture`] throws both away as errors, which is exactly backwards when the
/// output IS the answer.
pub async fn capture_output<I, S>(cwd: &Path, args: I) -> Result<(bool, String, String), GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let _perf = cognia_instrument::guard("git.exec");
    let output = base_command(cwd)
        .args(args)
        .output()
        .await
        .map_err(spawn_error)?;
    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    ))
}

/// Run `git <args>` feeding `stdin` to the process — used for
/// `git apply --cached` where the patch arrives on stdin.
pub async fn run_with_stdin<I, S>(cwd: &Path, args: I, stdin: &str) -> Result<(), GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let mut child = base_command(cwd)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(spawn_error)?;

    if let Some(mut sink) = child.stdin.take() {
        sink.write_all(stdin.as_bytes()).await.map_err(|e| {
            GitError::CommandFailed(format!("write patch to git stdin: {e}").into())
        })?;
        sink.shutdown()
            .await
            .map_err(|e| GitError::CommandFailed(format!("close git stdin: {e}").into()))?;
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| GitError::CommandFailed(format!("git wait: {e}").into()))?;
    if !output.status.success() {
        return Err(classify_failure(&String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `git switch` and the `git checkout` fallback word this differently, and
    /// `branch.rs::checkout` can emit either, so both must classify.
    #[test]
    fn classifies_a_branch_held_by_another_worktree() {
        assert!(matches!(
            classify_failure("fatal: 'feature' is already used by worktree at '/repo/wt/feature'"),
            GitError::BranchCheckedOutElsewhere(_)
        ));
        assert!(matches!(
            classify_failure("fatal: 'feature' is already checked out at '/repo/wt/feature'"),
            GitError::BranchCheckedOutElsewhere(_)
        ));
    }

    #[test]
    fn classifies_an_unmerged_branch_delete() {
        assert!(matches!(
            classify_failure("error: the branch 'feature' is not fully merged."),
            GitError::BranchNotFullyMerged(_)
        ));
    }

    /// `worktree remove` on a dirty tree is the same class of refusal as a
    /// dirty checkout: work would be lost, and `--force` is the way past.
    #[test]
    fn classifies_a_dirty_worktree_removal() {
        assert!(matches!(
            classify_failure(
                "fatal: '/repo/wt/a' contains modified or untracked files, use --force to delete it"
            ),
            GitError::DirtyWorkingTree(_)
        ));
    }

    /// The new arms sit above the conflict branch. A real merge conflict must
    /// still reach `MergeConflict`, and a plain failure must still fall
    /// through to `CommandFailed`.
    #[test]
    fn the_new_arms_do_not_shadow_the_existing_ones() {
        assert!(matches!(
            classify_failure("CONFLICT (content): Merge conflict in a.txt"),
            GitError::MergeConflict(_)
        ));
        assert!(matches!(
            classify_failure("fatal: something else entirely"),
            GitError::CommandFailed(_)
        ));
    }

    #[test]
    fn redact_strips_credentialed_https_url() {
        let text =
            "fatal: unable to access 'https://x-access-token:ghp_abc123@github.com/o/r.git/'";
        let out = redact(text);
        assert!(!out.contains("ghp_abc123"));
        assert!(out.contains("https://<redacted>@github.com/o/r.git"));
    }

    #[test]
    fn redact_leaves_plain_urls_untouched() {
        let text = "remote: https://github.com/o/r.git";
        assert_eq!(redact(text), text);
    }

    #[test]
    fn redact_handles_multiple_occurrences() {
        let text = "https://a:b@h1/x https://c:d@h2/y";
        let out = redact(text);
        assert_eq!(out.matches("<redacted>").count(), 2);
        assert!(!out.contains("a:b"));
        assert!(!out.contains("c:d"));
    }

    #[test]
    fn classify_auth_failure() {
        assert!(matches!(
            classify_failure("fatal: Authentication failed for 'https://github.com/o/r.git/'"),
            GitError::AuthRequired(_)
        ));
        assert!(matches!(
            classify_failure("git@github.com: Permission denied (publickey)."),
            GitError::AuthRequired(_)
        ));
    }

    #[test]
    fn classify_http_403_and_401_as_auth_not_network() {
        // GitHub returns 403/401 for an insufficient or expired token. The
        // string also contains "unable to access", so it must be classified as
        // auth *before* the network branch (which owns "unable to access").
        assert!(matches!(
            classify_failure(
                "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403"
            ),
            GitError::AuthRequired(_)
        ));
        assert!(matches!(
            classify_failure(
                "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 401"
            ),
            GitError::AuthRequired(_)
        ));
    }

    #[test]
    fn classify_missing_commit_identity_as_identity_required() {
        for stderr in [
            "Author identity unknown\n\n*** Please tell me who you are.",
            "fatal: unable to auto-detect email address (got 'runner@host.(none)')",
        ] {
            assert!(matches!(
                classify_failure(stderr),
                GitError::IdentityRequired(_)
            ));
        }
    }

    #[test]
    fn classify_patch_failure() {
        assert!(matches!(
            classify_failure("error: patch does not apply"),
            GitError::PatchFailed(_)
        ));
    }

    #[test]
    fn classify_network_failure() {
        assert!(matches!(
            classify_failure("fatal: unable to access 'https://h/r': Could not resolve host: h"),
            // "unable to access" matches the auth-free network branch.
            GitError::NetworkFailed(_)
        ));
    }

    #[test]
    fn classify_dirty_tree() {
        assert!(matches!(
            classify_failure(
                "error: Your local changes to the following files would be overwritten by checkout"
            ),
            GitError::DirtyWorkingTree(_)
        ));
    }

    #[test]
    fn classify_lock_held() {
        assert!(matches!(
            classify_failure("fatal: Unable to create '/r/.git/index.lock': File exists."),
            GitError::LockHeld(_)
        ));
    }

    #[test]
    fn classify_lock_held_via_create_lock_without_index_lock() {
        // Exercises the `unable to create` && `.lock` branch (no `index.lock`),
        // which the parenthesization `a || (b && c)` keeps grouped correctly.
        assert!(matches!(
            classify_failure("fatal: Unable to create '/r/.git/shallow.lock': File exists."),
            GitError::LockHeld(_)
        ));
    }

    #[test]
    fn classify_falls_back_to_command_failed() {
        assert!(matches!(
            classify_failure("error: something entirely unexpected"),
            GitError::CommandFailed(_)
        ));
    }

    #[test]
    fn classified_detail_is_redacted() {
        let err = classify_failure(
            "fatal: Authentication failed for 'https://u:tok@github.com/o/r.git/'",
        );
        if let GitError::AuthRequired(detail) = err {
            // `Detail` redacts at its Display/Serialize boundary.
            let shown = detail.to_string();
            assert!(!shown.contains("u:tok"), "token leaked: {shown}");
            assert!(shown.contains("<redacted>"));
        } else {
            panic!("expected AuthRequired");
        }
    }
}
