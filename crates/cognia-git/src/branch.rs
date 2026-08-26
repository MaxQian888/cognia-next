//! Branch listing (git2) + switch/create/delete/rename (system git).
//!
//! Mutations shell out so `post-checkout` hooks fire, gitattributes filters
//! reapply, and git's own "would be overwritten" safety refusals surface as
//! typed [`GitError::DirtyWorkingTree`] / `MergeConflict` errors.

use git2::{BranchType, Repository};
use serde::{Deserialize, Serialize};

use super::error::{GitError, Result};
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

// ── The trunk ──────────────────────────────────────────────────────────────

/// Conventional trunk names, most likely first. Only consulted when the
/// remote left no `HEAD` record — a repository that has one is never guessed at.
const TRUNK_CANDIDATES: [&str; 5] = ["main", "master", "trunk", "develop", "development"];

/// How the trunk was determined.
///
/// "The remote told us" and "we guessed" are different facts, and callers that
/// root a stack on the answer need to tell them apart: a stack based on a
/// branch that does not exist is rejected by the forge with an error that
/// blames the pull request rather than the guess that produced it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DefaultBranchSource {
    /// `refs/remotes/<remote>/HEAD` — what the remote itself reported.
    RemoteHead,
    /// No `HEAD` record, but a conventional name exists as a remote branch.
    RemoteBranch,
    /// No remote match; a conventional name exists locally.
    LocalBranch,
    /// Nothing matched. The name comes from `init.defaultBranch` (or `main`)
    /// and is not known to exist.
    Guess,
}

/// A repository's trunk, and how sure we are of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultBranch {
    /// Short name, e.g. `main` — never `origin/main` or `refs/heads/main`.
    pub branch: String,
    pub source: DefaultBranchSource,
    /// Whether the name resolves to a commit here, locally or remote-tracking.
    pub exists: bool,
}

/// The repository's default branch, resolved from local state only.
///
/// Deliberately offline. Every caller of this runs on a path where a network
/// round trip is either impossible (no credentials in scope) or unwanted (a
/// task loop asking once per run), and `git clone` already recorded the answer
/// in `refs/remotes/<remote>/HEAD`. When it did not, the ladder below degrades
/// one honest step at a time and says so in [`DefaultBranch::source`] rather
/// than returning a confident `"main"`.
///
/// What it must never do is answer with the *current* branch. That reads
/// correctly on a trunk checkout and silently roots everything on a feature
/// branch anywhere else.
pub async fn default_branch(repo_path: &str, remote: &str) -> Result<DefaultBranch> {
    if remote.is_empty() || remote.starts_with('-') {
        return Err(GitError::InvalidArgument(
            format!("not a valid remote name: {remote}").into(),
        ));
    }
    let cwd = std::path::PathBuf::from(repo_path);

    let head_ref = format!("refs/remotes/{remote}/HEAD");
    if let (true, stdout, _) = exec::capture_output(&cwd, ["symbolic-ref", &head_ref]).await? {
        let target = stdout.trim();
        let prefix = format!("refs/remotes/{remote}/");
        if let Some(name) = target.strip_prefix(&prefix) {
            if !name.is_empty() {
                return Ok(DefaultBranch {
                    branch: name.to_string(),
                    source: DefaultBranchSource::RemoteHead,
                    exists: true,
                });
            }
        }
    }

    for candidate in TRUNK_CANDIDATES {
        let reference = format!("refs/remotes/{remote}/{candidate}");
        if ref_exists(&cwd, &reference).await? {
            return Ok(DefaultBranch {
                branch: candidate.to_string(),
                source: DefaultBranchSource::RemoteBranch,
                exists: true,
            });
        }
    }

    for candidate in TRUNK_CANDIDATES {
        let reference = format!("refs/heads/{candidate}");
        if ref_exists(&cwd, &reference).await? {
            return Ok(DefaultBranch {
                branch: candidate.to_string(),
                source: DefaultBranchSource::LocalBranch,
                exists: true,
            });
        }
    }

    let configured = exec::capture_output(&cwd, ["config", "--get", "init.defaultBranch"])
        .await
        .ok()
        .and_then(|(ok, stdout, _)| {
            let value = stdout.trim().to_string();
            (ok && !value.is_empty() && !value.starts_with('-')).then_some(value)
        });
    let branch = configured.unwrap_or_else(|| "main".to_string());
    let exists = ref_exists(&cwd, &format!("refs/heads/{branch}")).await?;
    Ok(DefaultBranch {
        branch,
        source: DefaultBranchSource::Guess,
        exists,
    })
}

/// Whether a fully-qualified ref resolves here. `--verify --quiet` exits 1 for
/// "no such ref", which is an answer rather than a failure.
async fn ref_exists(cwd: &std::path::Path, reference: &str) -> Result<bool> {
    exec::succeeds(cwd, ["rev-parse", "--verify", "--quiet", reference]).await
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

    // ── default_branch ────────────────────────────────────────────────────

    fn sh(root: &std::path::Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .current_dir(root)
            .args(args)
            .env("GIT_AUTHOR_NAME", "T")
            .env("GIT_AUTHOR_EMAIL", "t@e.com")
            .env("GIT_COMMITTER_NAME", "T")
            .env("GIT_COMMITTER_EMAIL", "t@e.com")
            .output()
            .unwrap_or_else(|error| panic!("spawn git {args:?}: {error}"));
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// A repository on `trunk` with one commit, plus a fake `origin` whose
    /// remote-tracking refs are written directly (no network involved).
    fn with_remote(initial: &str) -> (TempDir, String) {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();
        sh(&root, &["init", &format!("--initial-branch={initial}")]);
        sh(&root, &["config", "user.name", "T"]);
        sh(&root, &["config", "user.email", "t@e.com"]);
        fs::write(root.join("a.txt"), "hi\n").unwrap();
        sh(&root, &["add", "a.txt"]);
        sh(&root, &["commit", "-m", "init"]);
        sh(&root, &["remote", "add", "origin", "https://example.invalid/o/r.git"]);
        let path = root.to_str().unwrap().to_string();
        (tmp, path)
    }

    #[tokio::test]
    async fn reads_the_trunk_the_remote_reported() {
        let (tmp, path) = with_remote("main");
        let root = std::path::Path::new(&path);
        // What `git clone` leaves behind: a tracking ref and a HEAD pointing at it.
        sh(root, &["update-ref", "refs/remotes/origin/release", "HEAD"]);
        sh(root, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release"]);

        let resolved = default_branch(&path, "origin").await.unwrap();
        assert_eq!(resolved.branch, "release");
        assert_eq!(resolved.source, DefaultBranchSource::RemoteHead);
        assert!(resolved.exists);
        let _ = tmp;
    }

    #[tokio::test]
    async fn never_answers_with_the_branch_that_is_checked_out() {
        // The defect this function exists to close: on a feature branch the
        // trunk is still the trunk. Answering `HEAD` roots every stack on
        // whatever the user happened to have checked out.
        let (tmp, path) = with_remote("main");
        let root = std::path::Path::new(&path);
        sh(root, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        sh(root, &["checkout", "-b", "feature/x"]);

        let resolved = default_branch(&path, "origin").await.unwrap();
        assert_eq!(resolved.branch, "main");
        assert_eq!(resolved.source, DefaultBranchSource::RemoteBranch);
        let _ = tmp;
    }

    #[tokio::test]
    async fn falls_back_to_a_conventional_remote_branch_then_a_local_one() {
        let (tmp, path) = with_remote("master");
        let root = std::path::Path::new(&path);
        // No origin/HEAD at all — a repo whose remote was added by hand.
        let resolved = default_branch(&path, "origin").await.unwrap();
        assert_eq!(resolved.branch, "master");
        assert_eq!(resolved.source, DefaultBranchSource::LocalBranch);
        assert!(resolved.exists);

        // A remote-tracking match outranks the local one.
        sh(root, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        let resolved = default_branch(&path, "origin").await.unwrap();
        assert_eq!(resolved.branch, "main");
        assert_eq!(resolved.source, DefaultBranchSource::RemoteBranch);
        let _ = tmp;
    }

    #[tokio::test]
    async fn a_guess_says_so_and_reports_whether_it_exists() {
        let (tmp, path) = with_remote("prod");
        // `prod` is not conventional, so nothing in the ladder matches and the
        // answer degrades to a guess that is honest about not existing.
        let resolved = default_branch(&path, "origin").await.unwrap();
        assert_eq!(resolved.source, DefaultBranchSource::Guess);
        assert_eq!(resolved.branch, "main");
        assert!(!resolved.exists, "main does not exist in this repository");
        let _ = tmp;
    }

    #[tokio::test]
    async fn honours_init_default_branch_when_it_has_to_guess() {
        let (tmp, path) = with_remote("prod");
        let root = std::path::Path::new(&path);
        sh(root, &["config", "init.defaultBranch", "prod"]);
        let resolved = default_branch(&path, "origin").await.unwrap();
        assert_eq!(resolved.branch, "prod");
        assert_eq!(resolved.source, DefaultBranchSource::Guess);
        assert!(resolved.exists, "the configured guess happens to be real here");
        let _ = tmp;
    }

    #[tokio::test]
    async fn refuses_a_remote_name_that_would_be_read_as_a_flag() {
        let (tmp, path) = with_remote("main");
        assert!(default_branch(&path, "--upload-pack=touch").await.is_err());
        assert!(default_branch(&path, "").await.is_err());
        let _ = tmp;
    }
}
