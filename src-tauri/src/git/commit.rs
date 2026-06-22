//! Commit — always via system `git` so `pre-commit`/`commit-msg` hooks run,
//! GPG/SSH signing applies, and `user.name`/`user.email`/`commit.gpgsign`
//! config is honored. git2's `repo.commit()` bypasses all of it.

use super::error::{GitError, Result};
use super::exec;
use super::read::open_repo;

/// Commit currently-staged changes. Returns the new commit's full SHA.
/// Rejects when there is nothing staged (unless amending).
pub async fn commit(repo_path: &str, message: &str, amend: bool, signoff: bool) -> Result<String> {
    if message.trim().is_empty() && !amend {
        return Err(GitError::InvalidArgument("empty commit message".into()));
    }
    let cwd = std::path::PathBuf::from(repo_path);

    // Guard: nothing staged and not amending → surface a clear error rather
    // than letting git exit non-zero with a generic message.
    if !amend {
        let staged = exec::capture(&cwd, ["diff", "--cached", "--name-only"]).await?;
        if staged.trim().is_empty() {
            return Err(GitError::InvalidArgument("nothing staged to commit".into()));
        }
    }

    let mut args = vec!["commit".to_string(), "-m".to_string(), message.to_string()];
    if amend {
        args.push("--amend".into());
        // Keep the prior message when amending with an empty message.
        if message.trim().is_empty() {
            args.retain(|a| a != "-m" && a != message);
            args.push("--no-edit".into());
        }
    }
    if signoff {
        args.push("--signoff".into());
    }
    exec::run(&cwd, args).await?;

    let head = exec::capture(&cwd, ["rev-parse", "HEAD"]).await?;
    let _ = open_repo(repo_path); // cheap sanity touch; keeps read module linked
    Ok(head.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use tempfile::TempDir;

    fn git_on_path() -> bool {
        Command::new("git")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
    }

    fn git(cwd: &Path, args: &[&str]) {
        Command::new("git")
            .args(args)
            .current_dir(cwd)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
    }

    fn init_repo() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.email", "t@e.com"]);
        git(p, &["config", "user.name", "T"]);
        git(p, &["config", "commit.gpgsign", "false"]);
        tmp
    }

    #[tokio::test]
    async fn rejects_empty_message() {
        let err = commit("/nonexistent", "  ", false, false)
            .await
            .unwrap_err();
        assert!(matches!(err, GitError::InvalidArgument(_)));
    }

    #[tokio::test]
    async fn rejects_when_nothing_staged() {
        if !git_on_path() {
            return;
        }
        let tmp = init_repo();
        std::fs::write(tmp.path().join("a.txt"), "hi\n").unwrap();
        git(tmp.path(), &["add", "."]);
        git(tmp.path(), &["commit", "-q", "-m", "init"]);
        let err = commit(&tmp.path().to_string_lossy(), "noop", false, false)
            .await
            .unwrap_err();
        assert!(matches!(err, GitError::InvalidArgument(_)));
    }

    #[tokio::test]
    async fn commits_staged_changes_and_returns_sha() {
        if !git_on_path() {
            return;
        }
        let tmp = init_repo();
        std::fs::write(tmp.path().join("a.txt"), "hi\n").unwrap();
        git(tmp.path(), &["add", "."]);
        let sha = commit(&tmp.path().to_string_lossy(), "feat: first", false, false)
            .await
            .unwrap();
        assert_eq!(sha.len(), 40);
    }
}
