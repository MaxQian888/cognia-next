//! Remotes (git2 read) + fetch/pull/push/sync (system git — mandatory, since
//! this libgit2 build has no network transport). Credentials resolve through
//! the ambient credential manager / SSH agent inherited by `exec`.

use git2::Repository;

use super::error::{GitError, Result};
use super::exec;
use super::read::{ahead_behind, open_repo};
use super::types::{AheadBehind, GitRemote};

/// List configured remotes with redacted fetch/push URLs.
pub fn list_remotes(repo_path: &str) -> Result<Vec<GitRemote>> {
    let repo = open_repo(repo_path)?;
    list_for(&repo)
}

fn list_for(repo: &Repository) -> Result<Vec<GitRemote>> {
    let mut out = Vec::new();
    for name in repo.remotes()?.iter().flatten() {
        let remote = match repo.find_remote(name) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let fetch_url = remote.url().map(exec::redact).unwrap_or_default();
        let push_url = remote
            .pushurl()
            .map(exec::redact)
            .unwrap_or_else(|| fetch_url.clone());
        out.push(GitRemote {
            name: name.to_string(),
            fetch_url,
            push_url,
        });
    }
    Ok(out)
}

fn cwd(repo_path: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(repo_path)
}

/// `git remote add <name> <url>`.
pub async fn add(repo_path: &str, name: &str, url: &str) -> Result<()> {
    exec::run(&cwd(repo_path), ["remote", "add", name, url]).await
}

/// `git remote remove <name>`.
pub async fn remove(repo_path: &str, name: &str) -> Result<()> {
    exec::run(&cwd(repo_path), ["remote", "remove", name]).await
}

/// `git fetch [remote] [--prune]`.
pub async fn fetch(repo_path: &str, remote: Option<&str>, prune: bool) -> Result<()> {
    let mut args = vec!["fetch".to_string()];
    if prune {
        args.push("--prune".into());
    }
    args.push(remote.unwrap_or("--all").to_string());
    exec::run(&cwd(repo_path), args).await
}

/// `git pull [--rebase] [remote] [branch]`.
pub async fn pull(
    repo_path: &str,
    remote: Option<&str>,
    branch: Option<&str>,
    rebase: bool,
) -> Result<()> {
    let mut args = vec!["pull".to_string()];
    if rebase {
        args.push("--rebase".into());
    }
    if let Some(r) = remote {
        args.push(r.to_string());
        if let Some(b) = branch {
            args.push(b.to_string());
        }
    }
    exec::run(&cwd(repo_path), args).await
}

/// Pick the remote `--set-upstream` should publish to when the caller did not
/// name one: the sole remote if there is exactly one, otherwise `origin` when
/// present, otherwise the first alphabetically.
fn resolve_default_remote(repo: &Repository) -> Option<String> {
    let remotes = repo.remotes().ok()?;
    let mut names: Vec<String> = remotes.iter().flatten().map(str::to_string).collect();
    if names.is_empty() {
        return None;
    }
    if names.len() == 1 {
        return names.pop();
    }
    if names.iter().any(|n| n == "origin") {
        return Some("origin".to_string());
    }
    names.sort();
    names.into_iter().next()
}

/// `git push [remote branch] [--set-upstream] [--force-with-lease]`.
///
/// Publishing (`set_upstream` without an explicit remote) resolves the target
/// remote from the repo config instead of assuming `origin`.
pub async fn push(
    repo_path: &str,
    remote: Option<&str>,
    branch: Option<&str>,
    set_upstream: bool,
    force_with_lease: bool,
) -> Result<()> {
    let resolved = match remote {
        Some(r) => Some(r.to_string()),
        None if set_upstream => resolve_default_remote(&open_repo(repo_path)?),
        None => None,
    };
    let mut args = vec!["push".to_string()];
    if set_upstream {
        args.push("--set-upstream".into());
    }
    if force_with_lease {
        args.push("--force-with-lease".into());
    }
    if let Some(r) = resolved {
        args.push(r);
        if let Some(b) = branch {
            args.push(b.to_string());
        }
    }
    exec::run(&cwd(repo_path), args).await
}

/// Whether the current branch has a configured upstream to sync against. An
/// unborn HEAD (no commits yet) or a detached HEAD has none.
fn has_upstream(repo_path: &str) -> Result<bool> {
    let repo = open_repo(repo_path)?;
    let name = match repo.head() {
        Ok(head) => match head.shorthand() {
            Some(n) => n.to_string(),
            None => return Ok(false),
        },
        Err(_) => return Ok(false),
    };
    let has = match repo.find_branch(&name, git2::BranchType::Local) {
        Ok(branch) => branch.upstream().is_ok(),
        Err(_) => false,
    };
    Ok(has)
}

/// Pull then push, returning the post-sync divergence from upstream.
/// `git pull` respects the user's `pull.rebase` config.
pub async fn sync(repo_path: &str) -> Result<AheadBehind> {
    // A branch with no upstream can't sync by tracking; guide the user to
    // publish it first instead of failing with a generic "git command failed".
    if !has_upstream(repo_path)? {
        return Err(GitError::InvalidArgument(
            "no upstream is set for the current branch; publish it first with push --set-upstream"
                .into(),
        ));
    }
    let c = cwd(repo_path);
    exec::run(&c, ["pull"]).await?;
    exec::run(&c, ["push"]).await?;
    let repo = open_repo(repo_path)?;
    let (ahead, behind) = ahead_behind(&repo);
    Ok(AheadBehind { ahead, behind })
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Signature;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn lists_remote_with_redacted_url() {
        let tmp = TempDir::new().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "T").unwrap();
            cfg.set_str("user.email", "t@e.com").unwrap();
        }
        fs::write(tmp.path().join("a.txt"), "hi\n").unwrap();
        let sig = Signature::now("T", "t@e.com").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("a.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
            .unwrap();

        repo.remote("origin", "https://user:secret@github.com/o/r.git")
            .unwrap();
        let remotes = list_for(&repo).unwrap();
        let origin = remotes.iter().find(|r| r.name == "origin").unwrap();
        assert!(!origin.fetch_url.contains("secret"));
        assert!(origin.fetch_url.contains("<redacted>"));
    }

    #[test]
    fn empty_remotes_for_fresh_repo() {
        let tmp = TempDir::new().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        assert!(list_for(&repo).unwrap().is_empty());
    }

    #[test]
    fn default_remote_none_without_remotes() {
        let tmp = TempDir::new().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        assert_eq!(resolve_default_remote(&repo), None);
    }

    #[test]
    fn default_remote_uses_the_single_remote() {
        let tmp = TempDir::new().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        repo.remote("upstream", "https://example.com/o/r.git")
            .unwrap();
        assert_eq!(resolve_default_remote(&repo).as_deref(), Some("upstream"));
    }

    #[test]
    fn default_remote_prefers_origin_among_many() {
        let tmp = TempDir::new().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        repo.remote("upstream", "https://example.com/o/r.git")
            .unwrap();
        repo.remote("origin", "https://example.com/o/r2.git")
            .unwrap();
        assert_eq!(resolve_default_remote(&repo).as_deref(), Some("origin"));
    }

    #[test]
    fn default_remote_falls_back_to_first_alphabetical() {
        let tmp = TempDir::new().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        repo.remote("zeta", "https://example.com/o/r.git").unwrap();
        repo.remote("alpha", "https://example.com/o/r2.git")
            .unwrap();
        assert_eq!(resolve_default_remote(&repo).as_deref(), Some("alpha"));
    }

    #[tokio::test]
    async fn sync_without_upstream_is_invalid_argument() {
        if !git_on_path() {
            return;
        }
        // A repo with a commit but no upstream: sync() must refuse with a typed
        // InvalidArgument (guiding --set-upstream) before attempting a pull.
        let tmp = TempDir::new().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "T").unwrap();
            cfg.set_str("user.email", "t@e.com").unwrap();
        }
        fs::write(tmp.path().join("a.txt"), "hi\n").unwrap();
        let sig = Signature::now("T", "t@e.com").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("a.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
            .unwrap();

        let rp = tmp.path().to_string_lossy().into_owned();
        let err = sync(&rp).await.unwrap_err();
        assert!(matches!(err, GitError::InvalidArgument(_)));
    }

    fn git_on_path() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok()
    }

    #[tokio::test]
    async fn add_then_remove_remote() {
        if !git_on_path() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        let rp = tmp.path().to_string_lossy().into_owned();

        add(&rp, "upstream", "https://github.com/o/r.git")
            .await
            .unwrap();
        assert!(list_for(&repo)
            .unwrap()
            .iter()
            .any(|r| r.name == "upstream"));

        remove(&rp, "upstream").await.unwrap();
        assert!(!list_for(&repo)
            .unwrap()
            .iter()
            .any(|r| r.name == "upstream"));
    }
}
