//! Merge-conflict detection (git2 index stages) + resolution (system git).
//!
//! Conflict bodies (ours/theirs/base) are read from the conflicting index
//! stages so the renderer can drive a 3-way Monaco merge view. Resolution
//! either writes the renderer's merged buffer or checks out one side, then
//! `git add`s to mark the path resolved.

use git2::Repository;

use super::error::{GitError, Result};
use super::exec;
use super::read::{blob_text, open_repo};
use super::types::{ConflictSide, GitConflict};

/// List conflicted paths with their three sides extracted from the index.
pub fn list_conflicts(repo_path: &str) -> Result<Vec<GitConflict>> {
    let repo = open_repo(repo_path)?;
    list_for(&repo)
}

fn list_for(repo: &Repository) -> Result<Vec<GitConflict>> {
    let index = repo.index()?;
    if !index.has_conflicts() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in index.conflicts()? {
        let entry = entry?;
        // The path is identical across stages; read it from whichever side exists.
        let path = entry
            .our
            .as_ref()
            .or(entry.their.as_ref())
            .or(entry.ancestor.as_ref())
            .map(|e| String::from_utf8_lossy(&e.path).replace('\\', "/"))
            .unwrap_or_default();

        let ours = entry
            .our
            .as_ref()
            .and_then(|e| repo.find_blob(e.id).ok())
            .and_then(|b| blob_text(b.content()))
            .unwrap_or_default();
        let theirs = entry
            .their
            .as_ref()
            .and_then(|e| repo.find_blob(e.id).ok())
            .and_then(|b| blob_text(b.content()))
            .unwrap_or_default();
        let base = entry
            .ancestor
            .as_ref()
            .and_then(|e| repo.find_blob(e.id).ok())
            .and_then(|b| blob_text(b.content()));

        out.push(GitConflict {
            path,
            ours,
            theirs,
            base,
        });
    }
    Ok(out)
}

fn cwd(repo_path: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(repo_path)
}

/// Write the renderer's merged buffer to disk and stage it as resolved.
pub async fn resolve_manual(repo_path: &str, path: &str, content: &str) -> Result<()> {
    let repo = open_repo(repo_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| GitError::NotARepo(repo_path.to_string()))?
        .to_path_buf();
    let full = workdir.join(path);
    tokio::fs::write(&full, content)
        .await
        .map_err(|e| GitError::CommandFailed(format!("write resolved {path}: {e}")))?;
    exec::run(&cwd(repo_path), ["add", "--", path]).await
}

/// Check out one side of a conflict and stage it as resolved.
pub async fn resolve_side(repo_path: &str, path: &str, side: ConflictSide) -> Result<()> {
    let flag = match side {
        ConflictSide::Ours => "--ours",
        ConflictSide::Theirs => "--theirs",
    };
    let c = cwd(repo_path);
    exec::run(&c, ["checkout", flag, "--", path]).await?;
    exec::run(&c, ["add", "--", path]).await
}

/// `git merge --abort`.
pub async fn merge_abort(repo_path: &str) -> Result<()> {
    exec::run(&cwd(repo_path), ["merge", "--abort"]).await
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

    /// Build a repo with a guaranteed merge conflict on `a.txt`.
    fn conflicted_repo() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.email", "t@e.com"]);
        git(p, &["config", "user.name", "T"]);
        std::fs::write(p.join("a.txt"), "base\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-q", "-m", "base"]);

        git(p, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(p.join("a.txt"), "theirs\n").unwrap();
        git(p, &["commit", "-aqm", "theirs"]);

        git(p, &["checkout", "-q", "main"]);
        std::fs::write(p.join("a.txt"), "ours\n").unwrap();
        git(p, &["commit", "-aqm", "ours"]);

        // Merge feature → conflict.
        Command::new("git")
            .args(["merge", "feature"])
            .current_dir(p)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        tmp
    }

    #[test]
    fn no_conflicts_in_clean_repo() {
        let tmp = TempDir::new().unwrap();
        Repository::init(tmp.path()).unwrap();
        assert!(list_conflicts(&tmp.path().to_string_lossy())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn detects_conflict_sides() {
        if !git_on_path() {
            return;
        }
        let tmp = conflicted_repo();
        let conflicts = list_conflicts(&tmp.path().to_string_lossy()).unwrap();
        assert_eq!(conflicts.len(), 1);
        let c = &conflicts[0];
        assert_eq!(c.path, "a.txt");
        assert_eq!(c.ours, "ours\n");
        assert_eq!(c.theirs, "theirs\n");
        assert_eq!(c.base.as_deref(), Some("base\n"));
    }

    #[tokio::test]
    async fn resolve_side_ours_stages_resolution() {
        if !git_on_path() {
            return;
        }
        let tmp = conflicted_repo();
        let rp = tmp.path().to_string_lossy().into_owned();
        resolve_side(&rp, "a.txt", ConflictSide::Ours).await.unwrap();
        assert!(list_conflicts(&rp).unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(), "ours\n");
    }

    #[tokio::test]
    async fn resolve_manual_writes_and_stages() {
        if !git_on_path() {
            return;
        }
        let tmp = conflicted_repo();
        let rp = tmp.path().to_string_lossy().into_owned();
        resolve_manual(&rp, "a.txt", "merged result\n").await.unwrap();
        assert!(list_conflicts(&rp).unwrap().is_empty());
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(),
            "merged result\n"
        );
    }
}
