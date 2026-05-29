//! Commit history (Timeline) — repo-wide and per-file, via a git2 revwalk.
//! Reuses the same libgit2 walk shape as `twin/code_repo.rs`.

use git2::{Commit, DiffOptions, Repository, Sort};

use super::error::Result;
use super::read::open_repo;
use super::types::GitCommit;

/// Walk commits newest-first. When `path` is set, only commits that touched
/// that path are returned (per-file Timeline). `skip` + `max_count` paginate.
pub fn log(
    repo_path: &str,
    max_count: usize,
    skip: usize,
    path: Option<&str>,
) -> Result<Vec<GitCommit>> {
    let repo = open_repo(repo_path)?;
    log_for(&repo, max_count, skip, path)
}

fn log_for(
    repo: &Repository,
    max_count: usize,
    skip: usize,
    path: Option<&str>,
) -> Result<Vec<GitCommit>> {
    if repo.head().is_err() {
        // Unborn HEAD (no commits yet).
        return Ok(Vec::new());
    }
    let mut walker = repo.revwalk()?;
    walker.set_sorting(Sort::TIME)?;
    walker.push_head()?;

    let mut out = Vec::new();
    let mut skipped = 0usize;

    for oid in walker {
        if out.len() >= max_count {
            break;
        }
        let oid = oid?;
        let commit = repo.find_commit(oid)?;

        if let Some(p) = path {
            if !commit_touches_path(repo, &commit, p)? {
                continue;
            }
        }
        if skipped < skip {
            skipped += 1;
            continue;
        }
        out.push(to_record(&commit));
    }
    Ok(out)
}

fn commit_touches_path(repo: &Repository, commit: &Commit<'_>, path: &str) -> Result<bool> {
    let new_tree = commit.tree()?;
    let parent_tree = if commit.parent_count() == 0 {
        None
    } else {
        Some(commit.parent(0)?.tree()?)
    };
    let mut opts = DiffOptions::new();
    opts.pathspec(path);
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&new_tree), Some(&mut opts))?;
    Ok(diff.deltas().len() > 0)
}

fn to_record(commit: &Commit<'_>) -> GitCommit {
    let hash = commit.id().to_string();
    let short_hash = hash.chars().take(7).collect();
    let summary = commit.summary().unwrap_or_default().to_string();
    let body = commit.body().unwrap_or_default().trim().to_string();
    let author = commit.author();
    GitCommit {
        hash,
        short_hash,
        summary,
        body,
        author_name: author.name().unwrap_or_default().to_string(),
        author_email: author.email().unwrap_or_default().to_string(),
        authored_at_ms: author.when().seconds().saturating_mul(1_000),
        parents: commit.parent_ids().map(|o| o.to_string()).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{IndexAddOption, Signature};
    use std::fs;
    use tempfile::TempDir;

    fn init() -> (TempDir, Repository) {
        let tmp = TempDir::new().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "T").unwrap();
            cfg.set_str("user.email", "t@e.com").unwrap();
        }
        (tmp, repo)
    }

    fn commit_all(repo: &Repository, msg: &str, secs: i64) -> git2::Oid {
        let sig = Signature::new("T", "t@e.com", &git2::Time::new(secs, 0)).unwrap();
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
            .unwrap()
    }

    #[test]
    fn empty_log_for_unborn_head() {
        let (tmp, repo) = init();
        assert!(log_for(&repo, 10, 0, None).unwrap().is_empty());
        let _ = tmp;
    }

    #[test]
    fn repo_log_is_newest_first() {
        let (tmp, repo) = init();
        fs::write(tmp.path().join("a.txt"), "1\n").unwrap();
        commit_all(&repo, "first", 1000);
        fs::write(tmp.path().join("a.txt"), "2\n").unwrap();
        commit_all(&repo, "second", 2000);
        let log = log_for(&repo, 10, 0, None).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].summary, "second");
        assert_eq!(log[1].summary, "first");
        let _ = tmp;
    }

    #[test]
    fn skip_and_max_count_paginate() {
        let (tmp, repo) = init();
        for i in 0..5 {
            fs::write(tmp.path().join("a.txt"), format!("{i}\n")).unwrap();
            commit_all(&repo, &format!("c{i}"), 1000 + i);
        }
        let page = log_for(&repo, 2, 1, None).unwrap();
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].summary, "c3");
        let _ = tmp;
    }

    #[test]
    fn per_file_log_filters_by_path() {
        let (tmp, repo) = init();
        fs::write(tmp.path().join("a.txt"), "a\n").unwrap();
        commit_all(&repo, "touch a", 1000);
        fs::write(tmp.path().join("b.txt"), "b\n").unwrap();
        commit_all(&repo, "touch b", 2000);
        let a_log = log_for(&repo, 10, 0, Some("a.txt")).unwrap();
        assert_eq!(a_log.len(), 1);
        assert_eq!(a_log[0].summary, "touch a");
        let _ = tmp;
    }

    #[test]
    fn short_hash_is_seven_chars() {
        let (tmp, repo) = init();
        fs::write(tmp.path().join("a.txt"), "a\n").unwrap();
        commit_all(&repo, "c", 1000);
        let log = log_for(&repo, 1, 0, None).unwrap();
        assert_eq!(log[0].short_hash.len(), 7);
        let _ = tmp;
    }
}
