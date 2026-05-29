//! Shared git2 (libgit2) read primitives.
//!
//! These are the structural reads the panel does constantly — open the repo,
//! resolve HEAD, compute ahead/behind, read blob text. They run synchronously
//! (libgit2 is sync) and are always wrapped in `spawn_blocking` by the command
//! layer. This is also the module the Twin code-repo importer
//! (`twin/code_repo.rs`) should migrate onto in a follow-up so the libgit2
//! mechanics live in one place.

use std::path::Path;

use git2::{Repository, RepositoryState};

use super::error::{GitError, Result};
use super::types::{GitOperation, GitRepoState};

/// Open a repository, searching upward from `path` for the `.git` dir (so a
/// subdirectory of the repo still resolves, matching `git` CLI behavior).
pub fn open_repo(path: &str) -> Result<Repository> {
    Repository::discover(path).map_err(|_| GitError::NotARepo(path.to_string()))
}

/// Short name of the current branch, or `None` when detached/unborn.
pub fn head_branch(repo: &Repository) -> Option<String> {
    let head = repo.head().ok()?;
    if head.is_branch() {
        head.shorthand().map(str::to_string)
    } else {
        None
    }
}

/// `true` when HEAD points directly at a commit rather than a branch ref.
pub fn is_detached(repo: &Repository) -> bool {
    repo.head_detached().unwrap_or(false)
}

/// Upstream tracking ref shorthand (e.g. `origin/main`) for the current branch.
pub fn upstream_shorthand(repo: &Repository) -> Option<String> {
    let head = repo.head().ok()?;
    let name = head.shorthand()?;
    let branch = repo.find_branch(name, git2::BranchType::Local).ok()?;
    let upstream = branch.upstream().ok()?;
    upstream.name().ok().flatten().map(str::to_string)
}

/// `(ahead, behind)` of the current branch versus its upstream. `(0, 0)` when
/// there is no upstream or HEAD is unborn.
pub fn ahead_behind(repo: &Repository) -> (usize, usize) {
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return (0, 0),
    };
    let local_oid = match head.target() {
        Some(oid) => oid,
        None => return (0, 0),
    };
    let name = match head.shorthand() {
        Some(n) => n,
        None => return (0, 0),
    };
    let upstream = match repo
        .find_branch(name, git2::BranchType::Local)
        .and_then(|b| b.upstream())
    {
        Ok(u) => u,
        Err(_) => return (0, 0),
    };
    let upstream_oid = match upstream.get().target() {
        Some(oid) => oid,
        None => return (0, 0),
    };
    repo.graph_ahead_behind(local_oid, upstream_oid)
        .unwrap_or((0, 0))
}

/// Repository operation state (merge/rebase/cherry-pick/revert in progress).
pub fn operation_in_progress(repo: &Repository) -> Option<GitOperation> {
    match repo.state() {
        RepositoryState::Merge => Some(GitOperation::Merge),
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge => Some(GitOperation::Rebase),
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => {
            Some(GitOperation::CherryPick)
        }
        RepositoryState::Revert | RepositoryState::RevertSequence => Some(GitOperation::Revert),
        _ => None,
    }
}

/// Best-effort repo state probe. Never errors — a non-repo path resolves to
/// `{ isRepo: false }` so the renderer can show the "Open Folder" state.
pub fn repo_state(path: &str) -> GitRepoState {
    match open_repo(path) {
        Ok(repo) => {
            let root_dir = repo
                .workdir()
                .map(|p| p.to_string_lossy().replace('\\', "/"));
            GitRepoState {
                is_repo: true,
                root_dir,
                detached_head: is_detached(&repo),
                operation_in_progress: operation_in_progress(&repo),
            }
        }
        Err(_) => GitRepoState {
            is_repo: false,
            root_dir: None,
            detached_head: false,
            operation_in_progress: None,
        },
    }
}

/// Text content of `path` from the HEAD tree, or `None` if absent / binary.
pub fn head_blob_text(repo: &Repository, path: &str) -> Option<String> {
    let head = repo.head().ok()?;
    let tree = head.peel_to_tree().ok()?;
    let entry = tree.get_path(Path::new(path)).ok()?;
    let blob = repo.find_blob(entry.id()).ok()?;
    blob_text(blob.content())
}

/// Text content of `path` from the index (staged), or `None`.
pub fn index_blob_text(repo: &Repository, path: &str) -> Option<String> {
    let index = repo.index().ok()?;
    let entry = index.get_path(Path::new(path), 0)?;
    let blob = repo.find_blob(entry.id).ok()?;
    blob_text(blob.content())
}

/// Read `path` from the working directory as text, or `None`.
pub fn workdir_text(repo: &Repository, path: &str) -> Option<String> {
    let workdir = repo.workdir()?;
    let full = workdir.join(path);
    let bytes = std::fs::read(full).ok()?;
    blob_text(&bytes)
}

/// Decode bytes to a UTF-8 string, returning `None` for binary content.
pub fn blob_text(bytes: &[u8]) -> Option<String> {
    if bytes.contains(&0) {
        return None;
    }
    std::str::from_utf8(bytes).ok().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{IndexAddOption, Signature};
    use std::fs;
    use tempfile::TempDir;

    fn init_repo() -> (TempDir, Repository) {
        let tmp = TempDir::new().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "Test").unwrap();
            cfg.set_str("user.email", "t@e.com").unwrap();
        }
        (tmp, repo)
    }

    fn commit_all(repo: &Repository, msg: &str) -> git2::Oid {
        let sig = Signature::now("Test", "t@e.com").unwrap();
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
            .unwrap()
    }

    #[test]
    fn open_repo_discovers_from_subdir() {
        let (tmp, _repo) = init_repo();
        let sub = tmp.path().join("a/b");
        fs::create_dir_all(&sub).unwrap();
        assert!(open_repo(&sub.to_string_lossy()).is_ok());
    }

    #[test]
    fn open_repo_errors_on_non_repo() {
        let tmp = TempDir::new().unwrap();
        assert!(matches!(
            open_repo(&tmp.path().to_string_lossy()),
            Err(GitError::NotARepo(_))
        ));
    }

    #[test]
    fn head_branch_after_commit() {
        let (tmp, repo) = init_repo();
        fs::write(tmp.path().join("a.txt"), "hi\n").unwrap();
        commit_all(&repo, "init");
        // Default branch name varies; just assert we get *some* branch.
        assert!(head_branch(&repo).is_some());
    }

    #[test]
    fn repo_state_reports_non_repo() {
        let tmp = TempDir::new().unwrap();
        let state = repo_state(&tmp.path().to_string_lossy());
        assert!(!state.is_repo);
        assert!(state.root_dir.is_none());
    }

    #[test]
    fn repo_state_reports_repo_with_workdir() {
        let (tmp, repo) = init_repo();
        fs::write(tmp.path().join("a.txt"), "hi\n").unwrap();
        commit_all(&repo, "init");
        let state = repo_state(&tmp.path().to_string_lossy());
        assert!(state.is_repo);
        assert!(state.root_dir.is_some());
        assert!(state.operation_in_progress.is_none());
    }

    #[test]
    fn blob_text_rejects_binary() {
        assert!(blob_text(&[0u8, 1, 2]).is_none());
        assert_eq!(blob_text(b"hello").as_deref(), Some("hello"));
    }

    #[test]
    fn head_and_index_blob_text_roundtrip() {
        let (tmp, repo) = init_repo();
        fs::write(tmp.path().join("a.txt"), "version1\n").unwrap();
        commit_all(&repo, "init");
        assert_eq!(head_blob_text(&repo, "a.txt").as_deref(), Some("version1\n"));
        // Stage a new version.
        fs::write(tmp.path().join("a.txt"), "version2\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();
        assert_eq!(index_blob_text(&repo, "a.txt").as_deref(), Some("version2\n"));
        assert_eq!(workdir_text(&repo, "a.txt").as_deref(), Some("version2\n"));
    }

    #[test]
    fn ahead_behind_zero_without_upstream() {
        let (tmp, repo) = init_repo();
        fs::write(tmp.path().join("a.txt"), "hi\n").unwrap();
        commit_all(&repo, "init");
        assert_eq!(ahead_behind(&repo), (0, 0));
    }
}
