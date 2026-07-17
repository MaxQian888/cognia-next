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

use once_cell::sync::Lazy;
use regex::Regex;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use super::error::{Detail, GitError};

/// `https://user:token@host/...` → `https://<redacted>@host/...`.
/// Generalizes `github::workspace::redact_token` (which only strips a *known*
/// literal token) to any credentialed URL in arbitrary git stderr.
static CRED_URL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(https?://)[^/@\s]+@").expect("static regex"));

/// Strip embedded credentials from any text before it leaves the backend.
pub fn redact(text: &str) -> String {
    CRED_URL.replace_all(text, "$1<redacted>@").into_owned()
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
    if s.contains("conflict") || s.contains("would be overwritten by merge") {
        return GitError::MergeConflict(detail);
    }
    if s.contains("patch does not apply")
        || s.contains("does not apply")
        || s.contains("corrupt patch")
    {
        return GitError::PatchFailed(detail);
    }
    if s.contains("index.lock") || s.contains("unable to create") && s.contains(".lock") {
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
        sink.write_all(stdin.as_bytes())
            .await
            .map_err(|e| GitError::CommandFailed(format!("write patch to git stdin: {e}").into()))?;
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
