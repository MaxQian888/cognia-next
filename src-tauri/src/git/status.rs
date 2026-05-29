//! Working-tree status, grouped the way VSCode's Source Control view shows it:
//! Staged Changes / Changes / Merge Changes. A single file can legitimately
//! appear in both Staged and Changes (staged edit + further unstaged edit),
//! so we emit separate entries per side — matching VSCode.

use git2::{Repository, Status, StatusOptions};

use super::error::Result;
use super::read::{ahead_behind, head_branch, open_repo, operation_in_progress, upstream_shorthand};
use super::types::{GitFileChange, GitFileStatus, GitOperation, GitStatus, GitStatusGroup};

fn norm(path: &str) -> String {
    path.replace('\\', "/")
}

/// Compute the grouped status for the repository at `repo_path`.
pub fn status(repo_path: &str) -> Result<GitStatus> {
    let repo = open_repo(repo_path)?;
    status_for(&repo)
}

fn status_for(repo: &Repository) -> Result<GitStatus> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true)
        .include_ignored(false);

    let statuses = repo.statuses(Some(&mut opts))?;

    let mut staged = Vec::new();
    let mut changes = Vec::new();
    let mut merge = Vec::new();

    for entry in statuses.iter() {
        let st = entry.status();
        let fallback = entry.path().unwrap_or_default().to_string();

        if st.is_conflicted() {
            merge.push(GitFileChange {
                path: norm(&fallback),
                orig_path: None,
                status: GitFileStatus::Conflicted,
                staged: false,
                group: GitStatusGroup::Merge,
            });
            continue;
        }

        // --- staged side (index vs HEAD) ---
        if st.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE,
        ) {
            let delta = entry.head_to_index();
            let path = delta
                .as_ref()
                .and_then(|d| d.new_file().path())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| fallback.clone());
            let orig_path = if st.contains(Status::INDEX_RENAMED) {
                delta
                    .as_ref()
                    .and_then(|d| d.old_file().path())
                    .map(|p| norm(&p.to_string_lossy()))
            } else {
                None
            };
            staged.push(GitFileChange {
                path: norm(&path),
                orig_path,
                status: staged_status(st),
                staged: true,
                group: GitStatusGroup::Staged,
            });
        }

        // --- working-tree side (workdir vs index) ---
        if st.intersects(
            Status::WT_NEW
                | Status::WT_MODIFIED
                | Status::WT_DELETED
                | Status::WT_RENAMED
                | Status::WT_TYPECHANGE,
        ) {
            let delta = entry.index_to_workdir();
            let path = delta
                .as_ref()
                .and_then(|d| d.new_file().path())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| fallback.clone());
            let orig_path = if st.contains(Status::WT_RENAMED) {
                delta
                    .as_ref()
                    .and_then(|d| d.old_file().path())
                    .map(|p| norm(&p.to_string_lossy()))
            } else {
                None
            };
            changes.push(GitFileChange {
                path: norm(&path),
                orig_path,
                status: worktree_status(st),
                staged: false,
                group: GitStatusGroup::Changes,
            });
        }
    }

    let op = operation_in_progress(repo);
    Ok(GitStatus {
        branch: head_branch(repo),
        upstream: upstream_shorthand(repo),
        ahead: ahead_behind(repo).0,
        behind: ahead_behind(repo).1,
        staged,
        changes,
        merge,
        is_rebasing: matches!(op, Some(GitOperation::Rebase)),
        is_merging: matches!(op, Some(GitOperation::Merge)),
    })
}

fn staged_status(st: Status) -> GitFileStatus {
    if st.contains(Status::INDEX_NEW) {
        GitFileStatus::Added
    } else if st.contains(Status::INDEX_DELETED) {
        GitFileStatus::Deleted
    } else if st.contains(Status::INDEX_RENAMED) {
        GitFileStatus::Renamed
    } else if st.contains(Status::INDEX_TYPECHANGE) {
        GitFileStatus::TypeChanged
    } else {
        GitFileStatus::Modified
    }
}

fn worktree_status(st: Status) -> GitFileStatus {
    if st.contains(Status::WT_NEW) {
        GitFileStatus::Untracked
    } else if st.contains(Status::WT_DELETED) {
        GitFileStatus::Deleted
    } else if st.contains(Status::WT_RENAMED) {
        GitFileStatus::Renamed
    } else if st.contains(Status::WT_TYPECHANGE) {
        GitFileStatus::TypeChanged
    } else {
        GitFileStatus::Modified
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{IndexAddOption, Signature};
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    fn init_committed() -> (TempDir, Repository) {
        let tmp = TempDir::new().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "T").unwrap();
            cfg.set_str("user.email", "t@e.com").unwrap();
        }
        fs::write(tmp.path().join("tracked.txt"), "original\n").unwrap();
        {
            let sig = Signature::now("T", "t@e.com").unwrap();
            let mut index = repo.index().unwrap();
            index
                .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
                .unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
        }
        (tmp, repo)
    }

    #[test]
    fn untracked_file_is_in_changes_as_untracked() {
        let (tmp, repo) = init_committed();
        fs::write(tmp.path().join("new.txt"), "hi\n").unwrap();
        let s = status_for(&repo).unwrap();
        let entry = s.changes.iter().find(|c| c.path == "new.txt").unwrap();
        assert_eq!(entry.status, GitFileStatus::Untracked);
        assert!(s.staged.is_empty());
        let _ = tmp;
    }

    #[test]
    fn staged_modification_is_in_staged_group() {
        let (tmp, repo) = init_committed();
        fs::write(tmp.path().join("tracked.txt"), "changed\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("tracked.txt")).unwrap();
        index.write().unwrap();
        let s = status_for(&repo).unwrap();
        let entry = s.staged.iter().find(|c| c.path == "tracked.txt").unwrap();
        assert_eq!(entry.status, GitFileStatus::Modified);
        assert!(entry.staged);
        let _ = tmp;
    }

    #[test]
    fn file_can_be_in_both_staged_and_changes() {
        let (tmp, repo) = init_committed();
        // stage one change...
        fs::write(tmp.path().join("tracked.txt"), "staged\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("tracked.txt")).unwrap();
        index.write().unwrap();
        // ...then edit again in the working tree.
        fs::write(tmp.path().join("tracked.txt"), "staged then more\n").unwrap();
        let s = status_for(&repo).unwrap();
        assert!(s.staged.iter().any(|c| c.path == "tracked.txt"));
        assert!(s.changes.iter().any(|c| c.path == "tracked.txt"));
        let _ = tmp;
    }

    #[test]
    fn clean_repo_has_no_changes() {
        let (tmp, repo) = init_committed();
        let s = status_for(&repo).unwrap();
        assert!(s.staged.is_empty());
        assert!(s.changes.is_empty());
        assert!(s.merge.is_empty());
        assert!(!s.is_merging);
        let _ = tmp;
    }
}
