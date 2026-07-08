//! Git worktree management for agent-team per-dispatch isolation.
//!
//! When a team run has workspace isolation enabled, each teammate dispatch gets
//! its own linked worktree branched off the run's base HEAD, so parallel agents
//! never share a working tree / index / branch. Worktrees share the main repo's
//! `.git` object store (cheap), and git's "one branch per worktree" rule is a
//! natural guard against two dispatches colliding on the same branch.
//!
//! Like the rest of the Source Control subsystem, mutations shell out to the
//! user's `git` (via [`super::exec`]) so hooks/filters/credentials behave as in
//! the user's own terminal. Errors are the typed [`GitError`].

use std::path::PathBuf;

use super::error::Result;
use super::exec;
use super::types::GitWorktree;

/// `git -C <main_repo> worktree add -b <branch> <path> [<base_ref>]`.
///
/// Creates a new linked worktree at `path` on a fresh `branch`, based on
/// `base_ref` (defaults to the current HEAD when `None`). Fails (typed
/// [`GitError`]) if `branch` already exists or is already checked out
/// elsewhere — the caller relies on that as the collision guard.
pub async fn add(
    main_repo: &str,
    path: &str,
    branch: &str,
    base_ref: Option<&str>,
) -> Result<()> {
    let cwd = PathBuf::from(main_repo);
    let mut args: Vec<String> = vec![
        "worktree".into(),
        "add".into(),
        "-b".into(),
        branch.into(),
        path.into(),
    ];
    if let Some(base) = base_ref {
        args.push(base.into());
    }
    exec::run(&cwd, args).await
}

/// `git -C <main_repo> worktree remove [--force] <path>`, then optionally
/// prune + delete the branch it was on.
///
/// `force` removes the worktree even with uncommitted changes (the retain
/// policy decides whether that is desired). When `delete_branch` is set the
/// branch is `-D`-deleted after a `worktree prune` so the ref is reclaimed.
pub async fn remove(
    main_repo: &str,
    path: &str,
    force: bool,
    delete_branch: Option<&str>,
) -> Result<()> {
    let cwd = PathBuf::from(main_repo);
    let mut args: Vec<String> = vec!["worktree".into(), "remove".into()];
    if force {
        args.push("--force".into());
    }
    args.push(path.into());
    exec::run(&cwd, args).await?;

    if let Some(branch) = delete_branch {
        // Prune the administrative entry first so the branch is no longer
        // "checked out in a worktree" and `-D` can reclaim it.
        exec::run(&cwd, ["worktree", "prune"]).await?;
        exec::run(&cwd, ["branch", "-D", branch]).await?;
    }
    Ok(())
}

/// `git -C <main_repo> worktree list --porcelain`, parsed into [`GitWorktree`].
pub async fn list(main_repo: &str) -> Result<Vec<GitWorktree>> {
    let cwd = PathBuf::from(main_repo);
    let out = exec::capture(&cwd, ["worktree", "list", "--porcelain"]).await?;
    Ok(parse_worktree_list(&out))
}

/// `git -C <main_repo> worktree prune` — drop administrative entries for
/// worktrees whose directories were removed out-of-band (crash/GC recovery).
pub async fn prune(main_repo: &str) -> Result<()> {
    let cwd = PathBuf::from(main_repo);
    exec::run(&cwd, ["worktree", "prune"]).await
}

/// Stage everything and commit inside `worktree_path` so the agent's work is
/// captured on its branch (worktrees are GC'd, so uncommitted changes would be
/// lost, and reconcile merge/select operate on commits). Returns `Some(sha)`
/// for a new commit, `None` when the tree was already clean. Relies on the
/// repo's ambient `user.name`/`user.email` (inherited by the worktree), same as
/// the user's own terminal.
pub async fn commit(worktree_path: &str, message: &str) -> Result<Option<String>> {
    let cwd = PathBuf::from(worktree_path);
    let status = exec::capture(&cwd, ["status", "--porcelain"]).await?;
    if status.trim().is_empty() {
        return Ok(None);
    }
    exec::run(&cwd, ["add", "-A"]).await?;
    exec::run(&cwd, ["commit", "-m", message]).await?;
    let sha = exec::capture(&cwd, ["rev-parse", "HEAD"]).await?;
    Ok(Some(sha.trim().to_string()))
}

/// Parse `git worktree list --porcelain` output. Records are separated by a
/// blank line; each is a `worktree <path>` line plus optional `HEAD <sha>`,
/// `branch refs/heads/<name>` (or `detached`), `bare`, `locked`, `prunable`
/// lines. The main worktree is always emitted first by git.
fn parse_worktree_list(porcelain: &str) -> Vec<GitWorktree> {
    let mut out: Vec<GitWorktree> = Vec::new();
    let mut path: Option<String> = None;
    let mut head: Option<String> = None;
    let mut branch: Option<String> = None;

    fn flush(
        out: &mut Vec<GitWorktree>,
        path: &mut Option<String>,
        head: &mut Option<String>,
        branch: &mut Option<String>,
    ) {
        if let Some(p) = path.take() {
            let is_main = out.is_empty();
            out.push(GitWorktree {
                path: p,
                branch: branch.take(),
                head: head.take(),
                is_main,
            });
        } else {
            // No `worktree` line seen for this block — drop stray fields.
            *head = None;
            *branch = None;
        }
    }

    for raw in porcelain.lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            flush(&mut out, &mut path, &mut head, &mut branch);
            continue;
        }
        if let Some(rest) = line.strip_prefix("worktree ") {
            // A new record without a separating blank line — flush the prior.
            flush(&mut out, &mut path, &mut head, &mut branch);
            path = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("HEAD ") {
            head = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("branch ") {
            branch = Some(rest.strip_prefix("refs/heads/").unwrap_or(rest).to_string());
        }
        // `detached` / `bare` / `locked` / `prunable ...` → ignored (branch
        // stays `None` for detached, which is the only field we surface).
    }
    flush(&mut out, &mut path, &mut head, &mut branch);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_main_plus_linked_worktrees() {
        let porcelain = "\
worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo/../.cognia-agent-worktrees/run_x/alice-t1-abc
HEAD 2222222222222222222222222222222222222222
branch refs/heads/agent/run_x/alice/t1
";
        let wts = parse_worktree_list(porcelain);
        assert_eq!(wts.len(), 2);

        assert_eq!(wts[0].path, "/repo");
        assert_eq!(wts[0].branch.as_deref(), Some("main"));
        assert_eq!(
            wts[0].head.as_deref(),
            Some("1111111111111111111111111111111111111111")
        );
        assert!(wts[0].is_main, "first record is the main worktree");

        assert_eq!(
            wts[1].path,
            "/repo/../.cognia-agent-worktrees/run_x/alice-t1-abc"
        );
        assert_eq!(wts[1].branch.as_deref(), Some("agent/run_x/alice/t1"));
        assert!(!wts[1].is_main);
    }

    #[test]
    fn strips_refs_heads_prefix_only() {
        // A branch ref that itself contains "refs/heads" further down must only
        // lose the leading prefix.
        let porcelain = "worktree /r\nHEAD abc\nbranch refs/heads/feature/refs/heads-lookalike\n";
        let wts = parse_worktree_list(porcelain);
        assert_eq!(
            wts[0].branch.as_deref(),
            Some("feature/refs/heads-lookalike")
        );
    }

    #[test]
    fn detached_worktree_has_no_branch() {
        let porcelain = "worktree /r\nHEAD abc\ndetached\n";
        let wts = parse_worktree_list(porcelain);
        assert_eq!(wts.len(), 1);
        assert!(wts[0].branch.is_none());
        assert_eq!(wts[0].head.as_deref(), Some("abc"));
    }

    #[test]
    fn tolerates_missing_trailing_blank_line_between_records() {
        // Real porcelain separates records with a blank line, but be robust to
        // back-to-back `worktree` lines.
        let porcelain = "worktree /a\nHEAD a1\nbranch refs/heads/a\nworktree /b\nHEAD b1\nbranch refs/heads/b\n";
        let wts = parse_worktree_list(porcelain);
        assert_eq!(wts.len(), 2);
        assert_eq!(wts[0].path, "/a");
        assert_eq!(wts[1].path, "/b");
        assert!(wts[0].is_main);
        assert!(!wts[1].is_main);
    }

    #[test]
    fn empty_output_yields_no_worktrees() {
        assert!(parse_worktree_list("").is_empty());
        assert!(parse_worktree_list("\n\n").is_empty());
    }

    #[test]
    fn ignores_bare_and_locked_lines() {
        let porcelain = "worktree /r\nHEAD abc\nbranch refs/heads/main\nlocked\n";
        let wts = parse_worktree_list(porcelain);
        assert_eq!(wts.len(), 1);
        assert_eq!(wts[0].branch.as_deref(), Some("main"));
    }

    // ---- env-conditional integration tests (need `git` on PATH) ----

    fn git_on_path() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok()
    }

    fn init_repo_with_commit(dir: &std::path::Path) {
        let run = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?} failed");
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "t@e.com"]);
        run(&["config", "user.name", "T"]);
        std::fs::write(dir.join("README"), b"hi").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "init"]);
    }

    #[tokio::test]
    async fn add_list_remove_roundtrip() {
        if !git_on_path() {
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo_with_commit(&repo);
        let repo_str = repo.to_string_lossy().into_owned();

        let wt_path = tmp.path().join("wt-alice");
        let wt_str = wt_path.to_string_lossy().into_owned();

        add(&repo_str, &wt_str, "agent/run_x/alice/t1", None)
            .await
            .expect("worktree add");
        assert!(wt_path.join("README").exists(), "worktree checked out");

        let wts = list(&repo_str).await.expect("worktree list");
        assert!(wts.iter().any(|w| w.is_main));
        let agent = wts
            .iter()
            .find(|w| w.branch.as_deref() == Some("agent/run_x/alice/t1"))
            .expect("agent worktree present");
        assert!(!agent.is_main);

        remove(&repo_str, &wt_str, true, Some("agent/run_x/alice/t1"))
            .await
            .expect("worktree remove");
        assert!(!wt_path.exists(), "worktree dir gone");

        let after = list(&repo_str).await.expect("list after remove");
        assert!(
            !after
                .iter()
                .any(|w| w.branch.as_deref() == Some("agent/run_x/alice/t1")),
            "branch reclaimed"
        );
    }

    #[tokio::test]
    async fn commit_captures_changes_then_reports_clean() {
        if !git_on_path() {
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo_with_commit(&repo);
        let repo_str = repo.to_string_lossy().into_owned();

        let wt = tmp.path().join("wt");
        let wt_str = wt.to_string_lossy().into_owned();
        add(&repo_str, &wt_str, "agent/c", None).await.unwrap();

        // Clean tree → None.
        assert!(commit(&wt_str, "noop").await.unwrap().is_none());

        // Change → Some(sha).
        std::fs::write(wt.join("new.txt"), b"work").unwrap();
        let sha = commit(&wt_str, "agent work").await.unwrap();
        assert!(sha.is_some(), "commit returns a sha");
        assert_eq!(sha.unwrap().len(), 40, "full sha");

        // Clean again → None.
        assert!(commit(&wt_str, "noop2").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn prune_reclaims_dangling_worktree_entry() {
        if !git_on_path() {
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo_with_commit(&repo);
        let repo_str = repo.to_string_lossy().into_owned();

        let wt_path = tmp.path().join("wt-crash");
        let wt_str = wt_path.to_string_lossy().into_owned();
        add(&repo_str, &wt_str, "agent/crash", None)
            .await
            .expect("worktree add");

        // Simulate a crashed dispatch: the working directory vanishes without a
        // `git worktree remove`, so git still holds a stale administrative entry.
        std::fs::remove_dir_all(&wt_path).unwrap();
        assert!(
            list(&repo_str)
                .await
                .unwrap()
                .iter()
                .any(|w| w.branch.as_deref() == Some("agent/crash")),
            "stale entry still listed before prune"
        );

        prune(&repo_str).await.expect("worktree prune");

        assert!(
            !list(&repo_str)
                .await
                .unwrap()
                .iter()
                .any(|w| w.branch.as_deref() == Some("agent/crash")),
            "prune reclaimed the dangling administrative entry"
        );
    }

    #[tokio::test]
    async fn add_rejects_same_branch_twice() {
        if !git_on_path() {
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo_with_commit(&repo);
        let repo_str = repo.to_string_lossy().into_owned();

        let a = tmp.path().join("a").to_string_lossy().into_owned();
        let b = tmp.path().join("b").to_string_lossy().into_owned();
        add(&repo_str, &a, "agent/dup", None).await.expect("first add");
        // git refuses to check the same branch out in two worktrees.
        assert!(
            add(&repo_str, &b, "agent/dup", None).await.is_err(),
            "second add on same branch must fail"
        );
    }
}
