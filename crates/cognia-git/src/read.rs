//! Shared git2 (libgit2) read primitives.
//!
//! These are the structural reads the panel does constantly — open the repo,
//! resolve HEAD, compute ahead/behind, read blob text. They run synchronously
//! (libgit2 is sync) and are always wrapped in `spawn_blocking` by the command
//! layer. This is also the module the Twin code-repo importer
//! (`twin/code_repo.rs`) should migrate onto in a follow-up so the libgit2
//! mechanics live in one place.

use std::path::{Component, Path, PathBuf};

use git2::{Repository, RepositoryState};

use super::error::{GitError, Result};
use super::types::{GitOperation, GitRepoState};

/// Open a repository, searching upward from `path` for the `.git` dir (so a
/// subdirectory of the repo still resolves, matching `git` CLI behavior).
pub fn open_repo(path: &str) -> Result<Repository> {
    Repository::discover(path).map_err(|_| GitError::NotARepo(path.to_string().into()))
}

/// Validate a renderer/plugin file operand before it reaches either git2 or
/// direct filesystem I/O. Source-control file paths are always repo-relative;
/// accepting an absolute path or `..` would let a `git:read`/`git:write`
/// caller escape the active repository.
pub fn validate_repo_relative_path(path: &str) -> Result<&Path> {
    let candidate = Path::new(path);
    let valid = !path.trim().is_empty()
        && !candidate.is_absolute()
        && candidate
            .components()
            .all(|component| matches!(component, Component::Normal(_)));
    if !valid {
        return Err(GitError::InvalidArgument(
            format!("path must be repository-relative without traversal: {path}").into(),
        ));
    }
    Ok(candidate)
}

/// Discovered work-tree root for a repository path (which itself may point at
/// a nested directory inside the repository).
pub fn repo_workdir(repo_path: &str) -> Result<PathBuf> {
    let repo = open_repo(repo_path)?;
    repo.workdir()
        .map(Path::to_path_buf)
        .ok_or_else(|| GitError::NotARepo(repo_path.to_string().into()))
}

/// Resolve a validated repo-relative path without following a parent symlink
/// outside the work tree. The final component may itself be a symlink (Git
/// tracks symlinks as files); its parent must still resolve inside the repo.
pub fn safe_workdir_path(repo: &Repository, path: &str) -> Result<PathBuf> {
    let relative = validate_repo_relative_path(path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| GitError::NotARepo("bare repository has no work tree".into()))?;
    let canonical_root = std::fs::canonicalize(workdir).map_err(|error| {
        GitError::CommandFailed(format!("canonicalize repository root: {error}").into())
    })?;
    let full = workdir.join(relative);

    // Resolve the nearest existing parent. This catches `link/secret` where
    // `link` is a directory symlink pointing outside the repository, while
    // still allowing a deleted path whose final component no longer exists.
    let mut ancestor = full.parent().unwrap_or(workdir);
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or_else(|| {
            GitError::InvalidArgument(format!("path escapes repository: {path}").into())
        })?;
    }
    let canonical_ancestor = std::fs::canonicalize(ancestor).map_err(|error| {
        GitError::CommandFailed(format!("canonicalize path parent {path}: {error}").into())
    })?;
    if !canonical_ancestor.starts_with(&canonical_root) {
        return Err(GitError::InvalidArgument(
            format!("path escapes repository through a symlink: {path}").into(),
        ));
    }
    Ok(full)
}

/// Short name of the current branch, or `None` when detached/unborn.
pub fn head_branch(repo: &Repository) -> Option<String> {
    let head = repo.head().ok()?;
    if head.is_branch() {
        head.shorthand().ok().map(str::to_string)
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
    let name = head.shorthand().ok()?;
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
        Ok(n) => n,
        Err(_) => return (0, 0),
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

/// Read `path` from the working directory as text, or `None` when absent or
/// binary. Symlinks are represented by their link target (the bytes Git
/// stores), never by reading the target file.
pub fn workdir_text(repo: &Repository, path: &str) -> Result<Option<String>> {
    let full = safe_workdir_path(repo, path)?;
    let metadata = match std::fs::symlink_metadata(&full) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(GitError::CommandFailed(
                format!("read work-tree metadata for {path}: {error}").into(),
            ))
        }
    };
    if metadata.file_type().is_symlink() {
        let target = std::fs::read_link(&full).map_err(|error| {
            GitError::CommandFailed(format!("read symlink {path}: {error}").into())
        })?;
        return Ok(Some(target.to_string_lossy().into_owned()));
    }
    let bytes = std::fs::read(&full).map_err(|error| {
        GitError::CommandFailed(format!("read work-tree file {path}: {error}").into())
    })?;
    Ok(blob_text(&bytes))
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
        assert_eq!(
            head_blob_text(&repo, "a.txt").as_deref(),
            Some("version1\n")
        );
        // Stage a new version.
        fs::write(tmp.path().join("a.txt"), "version2\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();
        assert_eq!(
            index_blob_text(&repo, "a.txt").as_deref(),
            Some("version2\n")
        );
        assert_eq!(
            workdir_text(&repo, "a.txt").unwrap().as_deref(),
            Some("version2\n")
        );
    }

    #[test]
    fn rejects_absolute_and_parent_paths() {
        assert!(matches!(
            validate_repo_relative_path("../secret"),
            Err(GitError::InvalidArgument(_))
        ));
        assert!(matches!(
            validate_repo_relative_path("/tmp/secret"),
            Err(GitError::InvalidArgument(_))
        ));
        assert!(validate_repo_relative_path("src/main.rs").is_ok());
    }

    #[test]
    fn ahead_behind_zero_without_upstream() {
        let (tmp, repo) = init_repo();
        fs::write(tmp.path().join("a.txt"), "hi\n").unwrap();
        commit_all(&repo, "init");
        assert_eq!(ahead_behind(&repo), (0, 0));
    }
}
