//! Remotes (git2 read) + fetch/pull/push/sync (system git — mandatory, since
//! this libgit2 build has no network transport). Credentials resolve through
//! the ambient credential manager / SSH agent inherited by `exec`.

use git2::Repository;

use super::error::Result;
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

/// `git push [origin branch] [--set-upstream] [--force-with-lease]`.
pub async fn push(
    repo_path: &str,
    remote: Option<&str>,
    branch: Option<&str>,
    set_upstream: bool,
    force_with_lease: bool,
) -> Result<()> {
    let mut args = vec!["push".to_string()];
    if set_upstream {
        args.push("--set-upstream".into());
    }
    if force_with_lease {
        args.push("--force-with-lease".into());
    }
    if let Some(r) = remote {
        args.push(r.to_string());
        if let Some(b) = branch {
            args.push(b.to_string());
        }
    }
    exec::run(&cwd(repo_path), args).await
}

/// Pull then push, returning the post-sync divergence from upstream.
/// `git pull` respects the user's `pull.rebase` config.
pub async fn sync(repo_path: &str) -> Result<AheadBehind> {
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
        assert!(list_for(&repo).unwrap().iter().any(|r| r.name == "upstream"));

        remove(&rp, "upstream").await.unwrap();
        assert!(!list_for(&repo).unwrap().iter().any(|r| r.name == "upstream"));
    }
}
