//! Branch listing (git2) + switch/create/delete/rename (system git).
//!
//! Mutations shell out so `post-checkout` hooks fire, gitattributes filters
//! reapply, and git's own "would be overwritten" safety refusals surface as
//! typed [`GitError::DirtyWorkingTree`] / `MergeConflict` errors.

use git2::{BranchType, Repository};

use super::error::Result;
use super::exec;
use super::read::open_repo;
use super::types::GitBranch;

/// List local + remote branches with upstream tracking and ahead/behind.
pub fn list_branches(repo_path: &str) -> Result<Vec<GitBranch>> {
    let repo = open_repo(repo_path)?;
    list_for(&repo)
}

fn list_for(repo: &Repository) -> Result<Vec<GitBranch>> {
    let mut out = Vec::new();
    for item in repo.branches(None)? {
        let (branch, btype) = item?;
        let name = match branch.name()? {
            Some(n) => n.to_string(),
            None => continue,
        };
        let is_remote = btype == BranchType::Remote;
        let is_current = !is_remote && branch.is_head();

        let (upstream, ahead, behind) = if is_remote {
            (None, 0, 0)
        } else {
            match branch.upstream() {
                Ok(up) => {
                    let up_name = up.name().ok().flatten().map(str::to_string);
                    let (a, b) = match (branch.get().target(), up.get().target()) {
                        (Some(local), Some(remote)) => {
                            repo.graph_ahead_behind(local, remote).unwrap_or((0, 0))
                        }
                        _ => (0, 0),
                    };
                    (up_name, a, b)
                }
                Err(_) => (None, 0, 0),
            }
        };

        out.push(GitBranch {
            name,
            is_current,
            is_remote,
            upstream,
            ahead,
            behind,
        });
    }
    // Local branches first, current at the very top, then alphabetical.
    out.sort_by(|a, b| {
        b.is_current
            .cmp(&a.is_current)
            .then(a.is_remote.cmp(&b.is_remote))
            .then(a.name.cmp(&b.name))
    });
    Ok(out)
}

/// `git switch <name>` (falls back to `checkout` on very old git).
pub async fn checkout(repo_path: &str, name: &str) -> Result<()> {
    let cwd = std::path::PathBuf::from(repo_path);
    if exec::run(&cwd, ["switch", name]).await.is_ok() {
        return Ok(());
    }
    exec::run(&cwd, ["checkout", name]).await
}

/// Create a branch, optionally checking it out, optionally from a base ref.
pub async fn create(repo_path: &str, name: &str, checkout: bool, from: Option<&str>) -> Result<()> {
    let cwd = std::path::PathBuf::from(repo_path);
    let mut args: Vec<String> = Vec::new();
    if checkout {
        args.push("checkout".into());
        args.push("-b".into());
        args.push(name.into());
    } else {
        args.push("branch".into());
        args.push(name.into());
    }
    if let Some(base) = from {
        args.push(base.into());
    }
    exec::run(&cwd, args).await
}

/// `git branch -d/-D <name>`.
pub async fn delete(repo_path: &str, name: &str, force: bool) -> Result<()> {
    let cwd = std::path::PathBuf::from(repo_path);
    let flag = if force { "-D" } else { "-d" };
    exec::run(&cwd, ["branch", flag, name]).await
}

/// `git branch -m [old] <new>` — renames the current branch when `old` is None.
pub async fn rename(repo_path: &str, old: Option<&str>, new: &str) -> Result<()> {
    let cwd = std::path::PathBuf::from(repo_path);
    let mut args = vec!["branch".to_string(), "-m".to_string()];
    if let Some(o) = old {
        args.push(o.to_string());
    }
    args.push(new.to_string());
    exec::run(&cwd, args).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{IndexAddOption, Signature};
    use std::fs;
    use tempfile::TempDir;

    fn init_committed() -> (TempDir, Repository) {
        let tmp = TempDir::new().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "T").unwrap();
            cfg.set_str("user.email", "t@e.com").unwrap();
        }
        fs::write(tmp.path().join("a.txt"), "hi\n").unwrap();
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
    fn lists_the_current_branch_first() {
        let (tmp, repo) = init_committed();
        // Create a second local branch via git2.
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &head, false).unwrap();
        let branches = list_for(&repo).unwrap();
        assert!(branches.len() >= 2);
        assert!(branches[0].is_current);
        assert!(branches.iter().any(|b| b.name == "feature"));
        let _ = tmp;
    }

    #[test]
    fn new_branch_has_zero_ahead_behind_without_upstream() {
        let (tmp, repo) = init_committed();
        let branches = list_for(&repo).unwrap();
        assert!(branches.iter().all(|b| b.ahead == 0 && b.behind == 0));
        let _ = tmp;
    }
}
