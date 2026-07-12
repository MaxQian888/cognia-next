//! `git reset` (system git) — move HEAD (and optionally the index / working
//! tree) to a target ref. Always shells out so reflog, hooks, and git's own
//! safety behavior apply.

use super::error::{GitError, Result};
use super::exec;

/// Reset mode mirroring the renderer-side union `"soft" | "mixed" | "hard"`.
fn mode_flag(mode: &str) -> Result<&'static str> {
    match mode {
        "soft" => Ok("--soft"),
        "mixed" => Ok("--mixed"),
        "hard" => Ok("--hard"),
        other => Err(GitError::InvalidArgument(format!(
            "unknown reset mode: {other}"
        ))),
    }
}

/// `git reset --<mode> <target>`.
pub async fn reset(repo_path: &str, mode: &str, target: &str) -> Result<()> {
    let flag = mode_flag(mode)?;
    exec::run(
        &std::path::PathBuf::from(repo_path),
        ["reset", flag, target],
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn git_on_path() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok()
    }

    fn git(cwd: &std::path::Path, args: &[&str]) {
        std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
    }

    #[test]
    fn rejects_unknown_mode() {
        assert!(mode_flag("wobble").is_err());
        assert_eq!(mode_flag("soft").unwrap(), "--soft");
        assert_eq!(mode_flag("hard").unwrap(), "--hard");
    }

    #[tokio::test]
    async fn soft_reset_moves_head_keeps_worktree() {
        if !git_on_path() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.email", "t@e.com"]);
        git(p, &["config", "user.name", "T"]);
        fs::write(p.join("a.txt"), "v1\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-q", "-m", "c1"]);
        fs::write(p.join("a.txt"), "v2\n").unwrap();
        git(p, &["commit", "-q", "-am", "c2"]);

        let rp = p.to_string_lossy().into_owned();
        reset(&rp, "soft", "HEAD~1").await.unwrap();
        // Working tree keeps v2; HEAD is back at c1 so the change is staged.
        assert_eq!(fs::read_to_string(p.join("a.txt")).unwrap(), "v2\n");
    }
}
