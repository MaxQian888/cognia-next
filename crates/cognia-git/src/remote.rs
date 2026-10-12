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
    for name in repo
        .remotes()?
        .iter()
        .filter_map(|entry| entry.ok().flatten())
    {
        let remote = match repo.find_remote(name) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let fetch_url = remote.url().map(exec::redact).unwrap_or_default();
        let push_url = remote
            .pushurl()
            .ok()
            .flatten()
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

/// Fetch one immutable commit from an existing named remote, without changing ref mappings.
pub async fn fetch_revision(repo_path: &str, remote: &str, revision: &str) -> Result<()> {
    if !matches!(revision.len(), 40 | 64) || !revision.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(GitError::InvalidArgument(
            "fetch revision must be an exact commit SHA".into(),
        ));
    }
    if remote.is_empty()
        || !remote
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        || remote.starts_with('-')
    {
        return Err(GitError::InvalidArgument(
            "fetch revision requires a named remote".into(),
        ));
    }
    exec::run(
        &cwd(repo_path),
        ["fetch", "--no-tags", "--", remote, revision],
    )
    .await
}

/// What a credentialed fetch may ask for. Each maps to one refspec that never
/// rewrites a local branch: an exact commit, a pull request's head (which a
/// fork PR's commits may only be reachable through), or a branch into its
/// remote-tracking ref.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchTarget {
    Revision(String),
    PullHead(u64),
    Branch(String),
}

impl FetchTarget {
    pub fn parse(value: &str) -> Result<Self> {
        let value = value.trim();
        if matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Ok(Self::Revision(value.to_ascii_lowercase()));
        }
        if let Some(digits) = value
            .strip_prefix("refs/pull/")
            .and_then(|rest| rest.strip_suffix("/head"))
        {
            // Canonical decimal only: `042` and `+42` name the same PR as `42`
            // to a parser, but not to git.
            if !digits.starts_with('0') && digits.bytes().all(|byte| byte.is_ascii_digit()) {
                if let Ok(number) = digits.parse::<u64>() {
                    return Ok(Self::PullHead(number));
                }
            }
            return Err(GitError::InvalidArgument("invalid pull request ref".into()));
        }
        // Any other namespace (`refs/pull/N/merge`, `refs/tags/…`, `refs/remotes/…`)
        // is not something a credentialed fetch is for.
        if value.starts_with("refs/") && !value.starts_with("refs/heads/") {
            return Err(GitError::InvalidArgument("invalid fetch ref".into()));
        }
        let branch = value.strip_prefix("refs/heads/").unwrap_or(value);
        let valid = !branch.is_empty()
            && branch.len() <= 255
            && branch.as_bytes()[0].is_ascii_alphanumeric()
            && branch
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._/-".contains(&byte))
            && !branch.contains("..")
            && !branch.contains("//")
            && !branch.ends_with('/')
            && !branch.ends_with(".lock");
        if !valid {
            return Err(GitError::InvalidArgument("invalid fetch ref".into()));
        }
        Ok(Self::Branch(branch.to_string()))
    }

    /// The refspec and the local ref the fetched commit lands on.
    pub fn refspec(&self, remote: &str) -> (String, Option<String>) {
        match self {
            Self::Revision(sha) => (sha.clone(), None),
            Self::PullHead(number) => {
                let local = format!("refs/remotes/{remote}/pull/{number}/head");
                (format!("+refs/pull/{number}/head:{local}"), Some(local))
            }
            Self::Branch(branch) => {
                let local = format!("refs/remotes/{remote}/{branch}");
                (format!("+refs/heads/{branch}:{local}"), Some(local))
            }
        }
    }
}

/// How long a credentialed fetch may run before it is killed.
const AUTHENTICATED_FETCH_BUDGET: std::time::Duration = std::time::Duration::from_secs(120);

/// Fetch one target from a named https remote with a one-shot credential.
///
/// The token reaches this git process only, as an `extraheader` keyed on the
/// remote's own origin (see `repo::credentialed_env`); the user's global and
/// system Git config are dropped for the call, so neither their credential
/// helper nor an `insteadOf` rewrite can stand in for the bound account.
pub async fn fetch_authenticated(
    repo_path: &str,
    remote: &str,
    target: &FetchTarget,
    token: &super::repo::SecretToken,
) -> Result<()> {
    if remote.is_empty()
        || remote.starts_with('-')
        || !remote
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(GitError::InvalidArgument(
            "credentialed fetch requires a named remote".into(),
        ));
    }
    let url = exec::capture(&cwd(repo_path), ["remote", "get-url", "--", remote]).await?;
    let env = super::repo::credentialed_env(url.trim(), token)?;
    let (refspec, _) = target.refspec(remote);
    let args = vec![
        "fetch".to_string(),
        "--no-tags".to_string(),
        "--".to_string(),
        remote.to_string(),
        refspec,
    ];
    match exec::run_within_env(&cwd(repo_path), args, AUTHENTICATED_FETCH_BUDGET, &env).await? {
        exec::Budgeted::Completed => Ok(()),
        exec::Budgeted::TimedOut => Err(GitError::CommandFailed(
            format!(
                "fetch timed out after {}s",
                AUTHENTICATED_FETCH_BUDGET.as_secs()
            )
            .into(),
        )),
    }
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
    let mut names: Vec<String> = remotes
        .iter()
        .filter_map(|entry| entry.ok().flatten())
        .map(str::to_string)
        .collect();
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
            Ok(n) => n.to_string(),
            Err(_) => return Ok(false),
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
    fn fetch_targets_are_exactly_a_commit_a_pull_head_or_a_branch() {
        let sha = "a".repeat(40);
        assert_eq!(
            FetchTarget::parse(&sha.to_uppercase()).unwrap(),
            FetchTarget::Revision(sha.clone())
        );
        assert_eq!(
            FetchTarget::parse("refs/pull/42/head").unwrap(),
            FetchTarget::PullHead(42)
        );
        assert_eq!(
            FetchTarget::parse("refs/heads/feature/x").unwrap(),
            FetchTarget::Branch("feature/x".into())
        );
        assert_eq!(
            FetchTarget::parse("main").unwrap(),
            FetchTarget::Branch("main".into())
        );
        for bad in [
            "",
            "-upload-pack=evil",
            "refs/pull/0/head",
            "refs/pull/042/head",
            "refs/pull/x/head",
            "refs/pull/1/merge",
            "a..b",
            "a//b",
            "branch/",
            "x.lock",
            "+refs/heads/main:refs/heads/main",
        ] {
            assert!(FetchTarget::parse(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn fetch_refspecs_never_rewrite_a_local_branch() {
        assert_eq!(
            FetchTarget::PullHead(7).refspec("origin"),
            (
                "+refs/pull/7/head:refs/remotes/origin/pull/7/head".into(),
                Some("refs/remotes/origin/pull/7/head".into())
            )
        );
        assert_eq!(
            FetchTarget::Branch("dev".into()).refspec("origin").0,
            "+refs/heads/dev:refs/remotes/origin/dev"
        );
        let sha = "b".repeat(64);
        assert_eq!(
            FetchTarget::Revision(sha.clone()).refspec("origin"),
            (sha, None)
        );
    }

    #[tokio::test]
    async fn a_credentialed_fetch_refuses_a_remote_it_cannot_key_a_header_on() {
        let tmp = TempDir::new().unwrap();
        Repository::init(tmp.path()).unwrap();
        let path = tmp.path().to_string_lossy().into_owned();
        exec::run(
            tmp.path(),
            ["remote", "add", "origin", "git@github.com:owner/repo.git"],
        )
        .await
        .unwrap();
        let error = fetch_authenticated(
            &path,
            "origin",
            &FetchTarget::Branch("main".into()),
            &crate::repo::SecretToken::new("ghs_test"),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("https remote"), "{error}");
        assert!(fetch_authenticated(
            &path,
            "-x",
            &FetchTarget::Branch("main".into()),
            &crate::repo::SecretToken::new("ghs_test"),
        )
        .await
        .is_err());
    }

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

    fn run_git_in(cwd: &std::path::Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    /// Identity + no commit signing (the CI/dev box may have `commit.gpgsign`
    /// on globally with no TTY for pinentry).
    fn cfg(dir: &std::path::Path) {
        run_git_in(dir, &["config", "user.email", "t@e.com"]);
        run_git_in(dir, &["config", "user.name", "T"]);
        run_git_in(dir, &["config", "commit.gpgsign", "false"]);
    }

    #[tokio::test]
    async fn fetch_revision_rejects_refspec_and_remote_injection() {
        for revision in ["main", "HEAD:refs/heads/main", "--upload-pack=evil"] {
            assert!(matches!(
                fetch_revision("/missing", "origin", revision).await,
                Err(GitError::InvalidArgument(_))
            ));
        }
        for remote in ["--upload-pack=evil", "https://example.com/repo", ""] {
            assert!(matches!(
                fetch_revision("/missing", remote, &"a".repeat(40)).await,
                Err(GitError::InvalidArgument(_))
            ));
        }
    }

    #[tokio::test]
    async fn fetch_revision_acquires_commit_reachable_only_from_pull_ref() {
        if !git_on_path() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        run_git_in(
            tmp.path(),
            &["init", "-q", "--bare", "-b", "main", "remote.git"],
        );
        run_git_in(tmp.path(), &["init", "-q", "-b", "main", "work"]);
        let work = tmp.path().join("work");
        let bare = tmp.path().join("remote.git");
        cfg(&work);
        fs::write(work.join("a.txt"), "base").unwrap();
        run_git_in(&work, &["add", "."]);
        run_git_in(&work, &["commit", "-q", "-m", "base"]);
        run_git_in(&work, &["remote", "add", "origin", bare.to_str().unwrap()]);
        run_git_in(&work, &["push", "-q", "origin", "main"]);
        run_git_in(
            tmp.path(),
            &[
                "clone",
                "-q",
                "--no-local",
                bare.to_str().unwrap(),
                "checkout",
            ],
        );
        fs::write(work.join("a.txt"), "fork").unwrap();
        run_git_in(&work, &["commit", "-qam", "fork-only"]);
        run_git_in(&work, &["push", "-q", "origin", "HEAD:refs/pull/7/head"]);
        let output = std::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(&work)
            .output()
            .unwrap();
        let sha = String::from_utf8(output.stdout).unwrap().trim().to_string();
        let checkout = tmp.path().join("checkout");
        fetch_revision(checkout.to_str().unwrap(), "origin", &sha)
            .await
            .unwrap();
        run_git_in(&checkout, &["checkout", "--detach", &sha]);
        assert_eq!(fs::read_to_string(checkout.join("a.txt")).unwrap(), "fork");
    }

    #[tokio::test]
    async fn push_set_upstream_fetch_pull_sync_roundtrip() {
        if !git_on_path() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        run_git_in(
            tmp.path(),
            &["init", "-q", "--bare", "-b", "main", "remote.git"],
        );
        let bare = tmp.path().join("remote.git");
        let work = tmp.path().join("work");
        run_git_in(tmp.path(), &["init", "-q", "-b", "main", "work"]);
        cfg(&work);
        fs::write(work.join("a.txt"), "one\n").unwrap();
        run_git_in(&work, &["add", "."]);
        run_git_in(&work, &["commit", "-q", "-m", "init"]);
        let wp = work.to_string_lossy().into_owned();
        add(&wp, "origin", bare.to_str().unwrap()).await.unwrap();

        // set_upstream with NO explicit remote resolves the sole remote (origin)
        // via resolve_default_remote, publishes main, and sets the upstream.
        push(&wp, None, Some("main"), true, false).await.unwrap();

        // Upstream is now configured, so sync is a clean no-op divergence.
        let ab = sync(&wp).await.unwrap();
        assert_eq!((ab.ahead, ab.behind), (0, 0));

        // fetch (with prune) and pull against the configured remote both succeed.
        fetch(&wp, Some("origin"), true).await.unwrap();
        pull(&wp, Some("origin"), Some("main"), false)
            .await
            .unwrap();

        // The bare remote actually received main.
        let out = std::process::Command::new("git")
            .args([
                "-C",
                bare.to_str().unwrap(),
                "rev-parse",
                "--verify",
                "main",
            ])
            .output()
            .unwrap();
        assert!(out.status.success(), "remote is missing main");
    }

    #[tokio::test]
    async fn pull_integrates_a_commit_from_the_remote() {
        if !git_on_path() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        run_git_in(
            tmp.path(),
            &["init", "-q", "--bare", "-b", "main", "remote.git"],
        );
        let url = tmp.path().join("remote.git");
        let url = url.to_str().unwrap();

        // Repo A publishes main.
        let a = tmp.path().join("a");
        run_git_in(tmp.path(), &["init", "-q", "-b", "main", "a"]);
        cfg(&a);
        fs::write(a.join("f.txt"), "1\n").unwrap();
        run_git_in(&a, &["add", "."]);
        run_git_in(&a, &["commit", "-q", "-m", "c1"]);
        let ap = a.to_string_lossy().into_owned();
        add(&ap, "origin", url).await.unwrap();
        push(&ap, Some("origin"), Some("main"), true, false)
            .await
            .unwrap();

        // Repo B clones the published branch.
        run_git_in(tmp.path(), &["clone", "-q", url, "b"]);
        let b = tmp.path().join("b");
        cfg(&b);

        // A advances main and pushes.
        fs::write(a.join("f.txt"), "2\n").unwrap();
        run_git_in(&a, &["commit", "-q", "-am", "c2"]);
        push(&ap, Some("origin"), Some("main"), false, false)
            .await
            .unwrap();

        // B pulls via our pull() and sees c2.
        let bp = b.to_string_lossy().into_owned();
        pull(&bp, Some("origin"), Some("main"), false)
            .await
            .unwrap();
        assert_eq!(fs::read_to_string(b.join("f.txt")).unwrap(), "2\n");
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
