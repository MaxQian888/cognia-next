//! Repository lifecycle (system git): `git init`, plus `.gitignore` editing.
//!
//! Lives apart from `read.rs` because that module is git2-only/sync; these
//! helpers shell out (init) or touch the worktree (ignore_add).

use super::error::{GitError, Result};
use super::exec;
use super::read::open_repo;

fn cwd(path: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(path)
}

/// `git init` — turn a plain directory into a repository.
pub async fn init(path: &str) -> Result<()> {
    exec::run(&cwd(path), ["init"]).await
}

/// Append `pattern` as a line to the repo-root `.gitignore`, creating the file
/// if missing. A pattern that already exists as a line is a no-op.
pub async fn ignore_add(repo_path: &str, pattern: &str) -> Result<()> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Err(GitError::InvalidArgument("empty ignore pattern".into()));
    }
    let repo = open_repo(repo_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| GitError::NotARepo(repo_path.to_string()))?
        .to_path_buf();
    let path = workdir.join(".gitignore");

    let existing = match tokio::fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(GitError::CommandFailed(format!("read .gitignore: {e}"))),
    };
    if existing.lines().any(|l| l.trim() == pattern) {
        return Ok(());
    }

    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(pattern);
    next.push('\n');
    tokio::fs::write(&path, next)
        .await
        .map_err(|e| GitError::CommandFailed(format!("write .gitignore: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;
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

    #[tokio::test]
    async fn init_creates_a_repository() {
        if !git_on_path() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let rp = tmp.path().to_string_lossy().into_owned();
        init(&rp).await.unwrap();
        assert!(Repository::open(tmp.path()).is_ok());
    }

    #[tokio::test]
    async fn ignore_add_creates_the_file() {
        let tmp = TempDir::new().unwrap();
        Repository::init(tmp.path()).unwrap();
        let rp = tmp.path().to_string_lossy().into_owned();
        ignore_add(&rp, "dist/").await.unwrap();
        assert_eq!(
            fs::read_to_string(tmp.path().join(".gitignore")).unwrap(),
            "dist/\n"
        );
    }

    #[tokio::test]
    async fn ignore_add_appends_with_newline_handling() {
        let tmp = TempDir::new().unwrap();
        Repository::init(tmp.path()).unwrap();
        // Existing file without a trailing newline.
        fs::write(tmp.path().join(".gitignore"), "node_modules").unwrap();
        let rp = tmp.path().to_string_lossy().into_owned();
        ignore_add(&rp, "dist/").await.unwrap();
        assert_eq!(
            fs::read_to_string(tmp.path().join(".gitignore")).unwrap(),
            "node_modules\ndist/\n"
        );
    }

    #[tokio::test]
    async fn ignore_add_dedupes_existing_lines() {
        let tmp = TempDir::new().unwrap();
        Repository::init(tmp.path()).unwrap();
        fs::write(tmp.path().join(".gitignore"), "dist/\n").unwrap();
        let rp = tmp.path().to_string_lossy().into_owned();
        ignore_add(&rp, " dist/ ").await.unwrap();
        assert_eq!(
            fs::read_to_string(tmp.path().join(".gitignore")).unwrap(),
            "dist/\n"
        );
    }

    #[tokio::test]
    async fn ignore_add_rejects_empty_pattern() {
        let tmp = TempDir::new().unwrap();
        Repository::init(tmp.path()).unwrap();
        let rp = tmp.path().to_string_lossy().into_owned();
        assert!(ignore_add(&rp, "  ").await.is_err());
    }
}
