//! Tags: list (git2) + create/delete (system git).
//!
//! Listing reads refs directly via libgit2; create/delete shell out so the
//! user's signing config and hooks apply, mirroring the rest of the mutating
//! command surface.

use git2::Repository;

use super::error::Result;
use super::exec;
use super::read::open_repo;
use super::types::GitTag;

/// List tags, resolving annotated-tag objects to their target commit + message.
pub fn list_tags(repo_path: &str) -> Result<Vec<GitTag>> {
    let repo = open_repo(repo_path)?;
    list_for(&repo)
}

fn list_for(repo: &Repository) -> Result<Vec<GitTag>> {
    let mut out: Vec<GitTag> = Vec::new();
    repo.tag_foreach(|oid, name_bytes| {
        let full = String::from_utf8_lossy(name_bytes);
        let name = full.strip_prefix("refs/tags/").unwrap_or(&full).to_string();
        let (target_hash, message, is_annotated) = match repo.find_tag(oid) {
            // Annotated tag object → resolve to the commit it points at.
            Ok(tag) => (
                tag.target_id().to_string(),
                tag.message().map(|m| m.trim().to_string()).filter(|m| !m.is_empty()),
                true,
            ),
            // Lightweight tag → the ref points straight at the commit.
            Err(_) => (oid.to_string(), None, false),
        };
        out.push(GitTag {
            name,
            target_hash,
            message,
            is_annotated,
        });
        true
    })?;
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn cwd(repo_path: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(repo_path)
}

/// `git tag [-a -m <message>] <name> [<target>]`. An annotated tag is created
/// when `message` is provided; otherwise a lightweight tag.
pub async fn create(
    repo_path: &str,
    name: &str,
    message: Option<&str>,
    target: Option<&str>,
) -> Result<()> {
    let mut args = vec!["tag".to_string()];
    if let Some(m) = message {
        args.push("-a".into());
        args.push("-m".into());
        args.push(m.to_string());
    }
    args.push(name.to_string());
    if let Some(t) = target {
        args.push(t.to_string());
    }
    exec::run(&cwd(repo_path), args).await
}

/// `git tag -d <name>`.
pub async fn delete(repo_path: &str, name: &str) -> Result<()> {
    exec::run(&cwd(repo_path), ["tag", "-d", name]).await
}

/// `git push <remote> <name>` — publish a single tag to a remote.
pub async fn push(repo_path: &str, remote: &str, name: &str) -> Result<()> {
    exec::run(&cwd(repo_path), ["push", remote, name]).await
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
            index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        }
        (tmp, repo)
    }

    fn git_on_path() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok()
    }

    #[test]
    fn empty_tags_for_fresh_repo() {
        let (tmp, repo) = init_committed();
        assert!(list_for(&repo).unwrap().is_empty());
        let _ = tmp;
    }

    #[tokio::test]
    async fn create_lightweight_and_annotated_then_delete() {
        if !git_on_path() {
            return;
        }
        let (tmp, repo) = init_committed();
        let rp = tmp.path().to_string_lossy().into_owned();

        create(&rp, "v1.0", None, None).await.unwrap();
        create(&rp, "v2.0", Some("release two"), None).await.unwrap();

        let tags = list_for(&repo).unwrap();
        let light = tags.iter().find(|t| t.name == "v1.0").unwrap();
        assert!(!light.is_annotated);
        let annotated = tags.iter().find(|t| t.name == "v2.0").unwrap();
        assert!(annotated.is_annotated);
        assert_eq!(annotated.message.as_deref(), Some("release two"));

        delete(&rp, "v1.0").await.unwrap();
        assert!(!list_for(&repo).unwrap().iter().any(|t| t.name == "v1.0"));
    }

    #[tokio::test]
    async fn push_tag_to_a_bare_remote() {
        if !git_on_path() {
            return;
        }
        let (tmp, _repo) = init_committed();
        let rp = tmp.path().to_string_lossy().into_owned();
        // A bare repo standing in for the remote.
        let bare = TempDir::new().unwrap();
        Repository::init_bare(bare.path()).unwrap();
        let bare_path = bare.path().to_string_lossy().into_owned();

        exec::run(&cwd(&rp), ["remote", "add", "origin", &bare_path]).await.unwrap();
        create(&rp, "v9.9", Some("ship"), None).await.unwrap();
        push(&rp, "origin", "v9.9").await.unwrap();

        // The bare remote now knows the tag.
        let remote_tags = list_for(&Repository::open(bare.path()).unwrap()).unwrap();
        assert!(remote_tags.iter().any(|t| t.name == "v9.9"));
    }
}
