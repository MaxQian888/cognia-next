//! Sequencer operations (system git): rebase, cherry-pick, revert, plus a
//! unified continue/abort that dispatches on the repo's in-progress operation.
//!
//! All shell out so hooks, signing, and git's own conflict handling apply; a
//! conflict surfaces as [`GitError::MergeConflict`] and the renderer drives the
//! existing conflict resolver, then calls `continue`/`abort`.

use super::error::{GitError, Result};
use super::exec;
use super::read::{open_repo, operation_in_progress};
use super::types::GitOperation;

fn cwd(repo_path: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(repo_path)
}

/// `git rebase <onto>` — replay the current branch onto another ref.
pub async fn rebase(repo_path: &str, onto: &str) -> Result<()> {
    exec::run(&cwd(repo_path), ["rebase", onto]).await
}

/// `git cherry-pick <sha>` — apply a commit onto the current branch.
pub async fn cherry_pick(repo_path: &str, sha: &str) -> Result<()> {
    exec::run(&cwd(repo_path), ["cherry-pick", sha]).await
}

/// `git revert --no-edit <sha>` — create a commit that undoes `sha`.
pub async fn revert(repo_path: &str, sha: &str) -> Result<()> {
    exec::run(&cwd(repo_path), ["revert", "--no-edit", sha]).await
}

/// Sub-command (`rebase`/`cherry-pick`/`revert`/`merge`) for the in-progress op.
fn in_progress_subcommand(repo_path: &str) -> Result<&'static str> {
    let repo = open_repo(repo_path)?;
    match operation_in_progress(&repo) {
        Some(GitOperation::Rebase) => Ok("rebase"),
        Some(GitOperation::CherryPick) => Ok("cherry-pick"),
        Some(GitOperation::Revert) => Ok("revert"),
        Some(GitOperation::Merge) => Ok("merge"),
        None => Err(GitError::InvalidArgument(
            "no sequencer operation in progress".into(),
        )),
    }
}

/// `git <op> --continue` for whichever sequencer op is mid-flight.
pub async fn sequencer_continue(repo_path: &str) -> Result<()> {
    let sub = in_progress_subcommand(repo_path)?;
    exec::run(&cwd(repo_path), [sub, "--continue"]).await
}

/// `git <op> --abort` for whichever sequencer op is mid-flight.
pub async fn sequencer_abort(repo_path: &str) -> Result<()> {
    let sub = in_progress_subcommand(repo_path)?;
    exec::run(&cwd(repo_path), [sub, "--abort"]).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    fn git_on_path() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok()
    }

    fn git(cwd: &Path, args: &[&str]) {
        std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
    }

    #[test]
    fn no_op_in_progress_errors() {
        let tmp = TempDir::new().unwrap();
        git2::Repository::init(tmp.path()).unwrap();
        let err = in_progress_subcommand(&tmp.path().to_string_lossy()).unwrap_err();
        assert!(matches!(err, GitError::InvalidArgument(_)));
    }

    #[tokio::test]
    async fn cherry_pick_applies_a_commit() {
        if !git_on_path() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.email", "t@e.com"]);
        git(p, &["config", "user.name", "T"]);
        git(p, &["config", "core.autocrlf", "false"]);
        fs::write(p.join("a.txt"), "base\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-q", "-m", "base"]);
        // Make a feature commit on another branch.
        git(p, &["checkout", "-q", "-b", "feature"]);
        fs::write(p.join("b.txt"), "feature\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-q", "-m", "add b"]);
        let sha = String::from_utf8(
            std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(p)
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        git(p, &["checkout", "-q", "main"]);

        let rp = p.to_string_lossy().into_owned();
        cherry_pick(&rp, sha.trim()).await.unwrap();
        assert!(p.join("b.txt").exists());
    }

    #[tokio::test]
    async fn revert_undoes_a_commit() {
        if !git_on_path() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.email", "t@e.com"]);
        git(p, &["config", "user.name", "T"]);
        git(p, &["config", "core.autocrlf", "false"]);
        fs::write(p.join("a.txt"), "base\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-q", "-m", "base"]);
        fs::write(p.join("a.txt"), "changed\n").unwrap();
        git(p, &["commit", "-q", "-am", "change a"]);

        let rp = p.to_string_lossy().into_owned();
        revert(&rp, "HEAD").await.unwrap();
        // The revert commit restores the original content.
        assert_eq!(fs::read_to_string(p.join("a.txt")).unwrap(), "base\n");
    }
}
