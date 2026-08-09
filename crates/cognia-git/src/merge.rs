//! Merge-conflict detection (git2 index stages) + resolution (system git).
//!
//! Conflict bodies (ours/theirs/base) are read from the conflicting index
//! stages so the renderer can drive a 3-way Monaco merge view. Resolution
//! either writes the renderer's merged buffer or checks out one side, then
//! `git add`s to mark the path resolved.

use git2::Repository;

use super::error::{GitError, Result};
use super::exec;
use super::read::{blob_text, open_repo, safe_workdir_path, validate_repo_relative_path};
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
    ensure_conflicted_path(&repo, path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| GitError::NotARepo(repo_path.to_string().into()))?
        .to_path_buf();
    let full = safe_workdir_path(&repo, path)?;
    match tokio::fs::symlink_metadata(&full).await {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(GitError::InvalidArgument(
                format!("refusing to write conflict resolution through a symlink: {path}").into(),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(GitError::CommandFailed(
                format!("inspect conflict path {path}: {error}").into(),
            ));
        }
    }
    tokio::fs::write(&full, content)
        .await
        .map_err(|e| GitError::CommandFailed(format!("write resolved {path}: {e}").into()))?;
    exec::run(&workdir, ["add", "--", path]).await
}

/// Check out one side of a conflict and stage it as resolved.
pub async fn resolve_side(repo_path: &str, path: &str, side: ConflictSide) -> Result<()> {
    let repo = open_repo(repo_path)?;
    ensure_conflicted_path(&repo, path)?;
    let flag = match side {
        ConflictSide::Ours => "--ours",
        ConflictSide::Theirs => "--theirs",
    };
    let c = repo
        .workdir()
        .ok_or_else(|| GitError::NotARepo(repo_path.to_string().into()))?
        .to_path_buf();
    exec::run(&c, ["checkout", flag, "--", path]).await?;
    exec::run(&c, ["add", "--", path]).await
}

fn ensure_conflicted_path(repo: &Repository, path: &str) -> Result<()> {
    validate_repo_relative_path(path)?;
    let expected = path.replace('\\', "/");
    let index = repo.index()?;
    let mut conflicts = index.conflicts()?;
    let found = conflicts.any(|entry| {
        entry.ok().is_some_and(|entry| {
            [entry.our, entry.their, entry.ancestor]
                .into_iter()
                .flatten()
                .any(|entry| String::from_utf8_lossy(&entry.path).replace('\\', "/") == expected)
        })
    });
    if found {
        Ok(())
    } else {
        Err(GitError::InvalidArgument(
            format!("path is not an unresolved conflict: {path}").into(),
        ))
    }
}

/// `git merge <branch>` — integrate a branch into the current one. A conflict
/// fails the command and leaves the repo in merge state; the renderer then
/// drives the existing conflict resolver and sequencer continue/abort.
pub async fn merge(repo_path: &str, branch: &str) -> Result<()> {
    exec::run(&cwd(repo_path), ["merge", branch]).await
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
        // Pin line-ending handling so conflict sides ("ours\n"/"theirs\n")
        // round-trip byte-exact regardless of the developer's global
        // `core.autocrlf` (true on some Windows machines).
        git(p, &["config", "core.autocrlf", "false"]);
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

    #[tokio::test]
    async fn merge_fast_forwards_a_clean_branch() {
        if !git_on_path() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.email", "t@e.com"]);
        git(p, &["config", "user.name", "T"]);
        std::fs::write(p.join("a.txt"), "base\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-q", "-m", "base"]);
        git(p, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(p.join("b.txt"), "feature\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-q", "-m", "add b"]);
        git(p, &["checkout", "-q", "main"]);

        let rp = p.to_string_lossy().into_owned();
        merge(&rp, "feature").await.unwrap();
        assert!(p.join("b.txt").exists());
        assert!(list_conflicts(&rp).unwrap().is_empty());
    }

    #[tokio::test]
    async fn merge_conflict_errors_and_enters_merge_state() {
        if !git_on_path() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.email", "t@e.com"]);
        git(p, &["config", "user.name", "T"]);
        git(p, &["config", "core.autocrlf", "false"]);
        std::fs::write(p.join("a.txt"), "base\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-q", "-m", "base"]);
        git(p, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(p.join("a.txt"), "theirs\n").unwrap();
        git(p, &["commit", "-aqm", "theirs"]);
        git(p, &["checkout", "-q", "main"]);
        std::fs::write(p.join("a.txt"), "ours\n").unwrap();
        git(p, &["commit", "-aqm", "ours"]);

        let rp = p.to_string_lossy().into_owned();
        assert!(merge(&rp, "feature").await.is_err());
        // The repo is mid-merge with the conflict listed — the UI flow's input.
        assert_eq!(list_conflicts(&rp).unwrap().len(), 1);
        merge_abort(&rp).await.unwrap();
        assert!(list_conflicts(&rp).unwrap().is_empty());
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
        resolve_side(&rp, "a.txt", ConflictSide::Ours)
            .await
            .unwrap();
        assert!(list_conflicts(&rp).unwrap().is_empty());
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(),
            "ours\n"
        );
    }

    #[tokio::test]
    async fn resolve_manual_writes_and_stages() {
        if !git_on_path() {
            return;
        }
        let tmp = conflicted_repo();
        let rp = tmp.path().to_string_lossy().into_owned();
        resolve_manual(&rp, "a.txt", "merged result\n")
            .await
            .unwrap();
        assert!(list_conflicts(&rp).unwrap().is_empty());
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(),
            "merged result\n"
        );
    }

    #[tokio::test]
    async fn resolve_manual_rejects_a_path_outside_the_repository() {
        if !git_on_path() {
            return;
        }
        let repo = conflicted_repo();
        let outside = TempDir::new().unwrap();
        let secret = outside.path().join("secret.txt");
        std::fs::write(&secret, "keep\n").unwrap();

        let error = resolve_manual(
            &repo.path().to_string_lossy(),
            &secret.to_string_lossy(),
            "overwrite\n",
        )
        .await
        .expect_err("conflict resolution must stay inside the repository");

        assert!(matches!(error, GitError::InvalidArgument(_)));
        assert_eq!(std::fs::read_to_string(secret).unwrap(), "keep\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn resolve_manual_rejects_a_conflict_path_replaced_by_a_symlink() {
        use std::os::unix::fs::symlink;

        if !git_on_path() {
            return;
        }
        let repo = conflicted_repo();
        let outside = TempDir::new().unwrap();
        let secret = outside.path().join("secret.txt");
        std::fs::write(&secret, "keep\n").unwrap();
        std::fs::remove_file(repo.path().join("a.txt")).unwrap();
        symlink(&secret, repo.path().join("a.txt")).unwrap();

        let error = resolve_manual(&repo.path().to_string_lossy(), "a.txt", "overwrite\n")
            .await
            .expect_err("manual conflict resolution must not follow a symlink");

        assert!(matches!(error, GitError::InvalidArgument(_)));
        assert_eq!(std::fs::read_to_string(secret).unwrap(), "keep\n");
    }
}
