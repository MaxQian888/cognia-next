//! Stash — list (git2) + push/pop/apply/drop (system git, which handles
//! untracked/merge-state correctly).

use git2::Repository;

use super::error::Result;
use super::exec;
use super::types::GitStashEntry;

/// List stash entries newest-first. git2's `stash_foreach` requires `&mut`.
pub fn list_stashes(repo_path: &str) -> Result<Vec<GitStashEntry>> {
    let mut repo = Repository::discover(repo_path)
        .map_err(|_| super::error::GitError::NotARepo(repo_path.to_string()))?;
    let mut out = Vec::new();
    repo.stash_foreach(|index, message, _oid| {
        // Stash messages look like "WIP on main: <sha> <subject>".
        let branch = message
            .strip_prefix("WIP on ")
            .or_else(|| message.strip_prefix("On "))
            .and_then(|rest| rest.split(':').next())
            .map(str::to_string);
        out.push(GitStashEntry {
            index,
            message: message.to_string(),
            branch,
        });
        true
    })?;
    Ok(out)
}

fn cwd(repo_path: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(repo_path)
}

/// `git stash push [-m msg] [-u] [-k]`.
pub async fn push(
    repo_path: &str,
    message: Option<&str>,
    include_untracked: bool,
    keep_index: bool,
) -> Result<()> {
    let mut args = vec!["stash".to_string(), "push".to_string()];
    if include_untracked {
        args.push("-u".into());
    }
    if keep_index {
        args.push("--keep-index".into());
    }
    if let Some(m) = message {
        if !m.is_empty() {
            args.push("-m".into());
            args.push(m.into());
        }
    }
    exec::run(&cwd(repo_path), args).await
}

/// `git stash pop stash@{index}`.
pub async fn pop(repo_path: &str, index: usize) -> Result<()> {
    exec::run(&cwd(repo_path), ["stash", "pop", &stash_ref(index)]).await
}

/// `git stash apply stash@{index}`.
pub async fn apply(repo_path: &str, index: usize) -> Result<()> {
    exec::run(&cwd(repo_path), ["stash", "apply", &stash_ref(index)]).await
}

/// `git stash drop stash@{index}`.
pub async fn drop(repo_path: &str, index: usize) -> Result<()> {
    exec::run(&cwd(repo_path), ["stash", "drop", &stash_ref(index)]).await
}

fn stash_ref(index: usize) -> String {
    format!("stash@{{{index}}}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use tempfile::TempDir;

    #[test]
    fn stash_ref_format() {
        assert_eq!(stash_ref(0), "stash@{0}");
        assert_eq!(stash_ref(3), "stash@{3}");
    }

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

    #[tokio::test]
    async fn push_then_list_then_pop() {
        if !git_on_path() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.email", "t@e.com"]);
        git(p, &["config", "user.name", "T"]);
        // Pin line-ending handling so "v2\n" round-trips byte-exact through
        // stash push/pop regardless of the developer's global `core.autocrlf`
        // (true on some Windows machines), which would rewrite "\n" → "\r\n".
        git(p, &["config", "core.autocrlf", "false"]);
        std::fs::write(p.join("a.txt"), "v1\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-q", "-m", "init"]);

        std::fs::write(p.join("a.txt"), "v2\n").unwrap();
        let rp = p.to_string_lossy().into_owned();
        push(&rp, Some("wip"), false, false).await.unwrap();

        let stashes = list_stashes(&rp).unwrap();
        assert_eq!(stashes.len(), 1);
        assert_eq!(stashes[0].index, 0);

        pop(&rp, 0).await.unwrap();
        assert!(list_stashes(&rp).unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "v2\n");
    }

    #[test]
    fn empty_stash_list_for_fresh_repo() {
        let tmp = TempDir::new().unwrap();
        git2::Repository::init(tmp.path()).unwrap();
        let list = list_stashes(&tmp.path().to_string_lossy()).unwrap();
        assert!(list.is_empty());
    }
}
