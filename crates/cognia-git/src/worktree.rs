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
pub async fn add(main_repo: &str, path: &str, branch: &str, base_ref: Option<&str>) -> Result<()> {
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

/// ADR-0111 managed-worktree add: detached HEAD by default, no auto-branch,
/// optional atomic lock reason.
///
/// Unlike [`add`], the managed variant does **not** create a per-dispatch
/// branch (ADR-0111 §4 — every dispatch previously produced a stale
/// `cognia/task/**` branch). If the caller wants a branch, they invoke
/// [`create_branch_here`] after the worktree materializes — the Registry
/// UI does this on explicit "Create branch here" only.
///
/// When `lock_reason` is `Some(reason)`, `--lock --reason <reason>` is passed
/// to `git worktree add` itself. Native Git therefore publishes the worktree
/// and its ownership lock as one operation.
pub async fn add_managed(
    main_repo: &str,
    path: &str,
    base_ref: Option<&str>,
    lock_reason: Option<&str>,
) -> Result<()> {
    let cwd = PathBuf::from(main_repo);
    let mut args: Vec<String> = vec![
        "worktree".into(),
        "add".into(),
        "--detach".into(),
    ];
    if let Some(reason) = lock_reason {
        args.extend(["--lock".into(), "--reason".into(), reason.into()]);
    }
    args.push(path.into());
    if let Some(base) = base_ref {
        args.push(base.into());
    }
    exec::run(&cwd, args).await
}

/// `git -C <main_repo> worktree lock <path> --reason <reason>`.
///
/// ADR-0111 §3: the Registry stamps `cognia:<workspaceId>` as the reason so
/// other owners (Agent Team dispatch, the user-facing worktree panel) can
/// detect that the worktree is Registry-managed and refuse to delete it.
pub async fn lock(main_repo: &str, path: &str, reason: &str) -> Result<()> {
    let cwd = PathBuf::from(main_repo);
    exec::run(&cwd, ["worktree", "lock", path, "--reason", reason]).await
}

/// `git -C <main_repo> worktree unlock <path>`.
///
/// Only used by the Registry's controlled remove path.
pub async fn unlock(main_repo: &str, path: &str) -> Result<()> {
    let cwd = PathBuf::from(main_repo);
    exec::run(&cwd, ["worktree", "unlock", path]).await
}

/// Return the current lock reason for `path`, or `None` when unlocked.
///
/// Parses `git worktree list --porcelain` and picks the `locked` line for
/// the requested path. The porcelain form is `locked <reason>` when a
/// reason was set, or bare `locked` otherwise.
pub async fn lock_reason(main_repo: &str, path: &str) -> Result<Option<String>> {
    let cwd = PathBuf::from(main_repo);
    let porcelain = exec::capture(&cwd, ["worktree", "list", "--porcelain", "-z"]).await?;
    Ok(extract_lock_reason(&porcelain, path))
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

/// ADR-0111 managed-worktree remove: refuses when the lock reason does not
/// match `expected_lock_reason`, so the user-facing worktree panel and the
/// Agent Team dispatch cannot force-delete a Registry-managed row.
///
/// The remove path is:
///
/// 1. Read the current lock reason. If it does not match, error out.
/// 2. Unlock the worktree.
/// 3. `git worktree remove --force <path>` (managed rows never require the
///    user to resolve dirty state — the Registry has already snapshotted
///    the run).
///
/// The `delete_branch` argument is preserved for callers that mixed
/// [`remove`] and [`remove_managed`] during the migration, though ADR-0111
/// runs `--detach` so there is usually no branch to delete.
pub async fn remove_managed(
    main_repo: &str,
    path: &str,
    expected_lock_reason: &str,
    delete_branch: Option<&str>,
) -> Result<()> {
    let cwd = PathBuf::from(main_repo);
    let actual = lock_reason(main_repo, path).await?;
    if actual.as_deref() != Some(expected_lock_reason) {
        return Err(super::error::GitError::LockHeld(
            format!(
                "worktree at {path} is locked by {actual:?}, expected {expected_lock_reason:?}"
            )
            .into(),
        ));
    }
    unlock(main_repo, path).await?;
    exec::run(&cwd, ["worktree", "remove", "--force", path]).await?;
    if let Some(branch) = delete_branch {
        exec::run(&cwd, ["worktree", "prune"]).await?;
        exec::run(&cwd, ["branch", "-D", branch]).await?;
    }
    Ok(())
}

/// ADR-0111 detached-worktree "Create branch here" — the only place
/// Registry creates a branch on a managed worktree.
///
/// Runs inside the worktree so `git checkout -b <name>` puts the worktree on
/// the new branch without also switching the main worktree's HEAD.
pub async fn create_branch_here(worktree_path: &str, branch: &str) -> Result<()> {
    let cwd = PathBuf::from(worktree_path);
    exec::run(&cwd, ["checkout", "-b", branch]).await
}

/// `git -C <main_repo> worktree list --porcelain -z`, parsed into [`GitWorktree`].
pub async fn list(main_repo: &str) -> Result<Vec<GitWorktree>> {
    let cwd = PathBuf::from(main_repo);
    let out = exec::capture(&cwd, ["worktree", "list", "--porcelain", "-z"]).await?;
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

/// Extract the lock reason for a specific worktree from `git worktree list
/// --porcelain` output.
///
/// The porcelain form for a locked worktree is either `locked <reason>` (with
/// a reason) or bare `locked` (no reason). Returns `None` when the requested
/// path is not present or is unlocked.
fn extract_lock_reason(porcelain: &str, target_path: &str) -> Option<String> {
    let mut current_path: Option<&str> = None;
    for raw in porcelain_fields(porcelain) {
        let line = raw.trim_end();
        if let Some(rest) = line.strip_prefix("worktree ") {
            current_path = Some(rest);
        } else if line == "locked" && current_path == Some(target_path) {
            // Locked without a reason. ADR-0111 requires a reason so this
            // path is treated as "unowned by Cognia" for lookups.
            return None;
        } else if let Some(rest) = line.strip_prefix("locked ") {
            if current_path == Some(target_path) {
                return Some(rest.to_string());
            }
        }
    }
    None
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
    let mut locked = false;
    let mut lock_reason: Option<String> = None;
    let mut prunable = false;
    let mut prune_reason: Option<String> = None;

    fn flush(
        out: &mut Vec<GitWorktree>,
        path: &mut Option<String>,
        head: &mut Option<String>,
        branch: &mut Option<String>,
        locked: &mut bool,
        lock_reason: &mut Option<String>,
        prunable: &mut bool,
        prune_reason: &mut Option<String>,
    ) {
        if let Some(p) = path.take() {
            let is_main = out.is_empty();
            out.push(GitWorktree {
                path: p,
                branch: branch.take(),
                head: head.take(),
                locked: std::mem::take(locked),
                lock_reason: lock_reason.take(),
                prunable: std::mem::take(prunable),
                prune_reason: prune_reason.take(),
                is_main,
            });
        } else {
            // No `worktree` line seen for this block — drop stray fields.
            *head = None;
            *branch = None;
            *locked = false;
            *lock_reason = None;
            *prunable = false;
            *prune_reason = None;
        }
    }

    for raw in porcelain_fields(porcelain) {
        let line = raw.trim_end();
        if line.is_empty() {
            flush(
                &mut out,
                &mut path,
                &mut head,
                &mut branch,
                &mut locked,
                &mut lock_reason,
                &mut prunable,
                &mut prune_reason,
            );
            continue;
        }
        if let Some(rest) = line.strip_prefix("worktree ") {
            // A new record without a separating blank line — flush the prior.
            flush(
                &mut out,
                &mut path,
                &mut head,
                &mut branch,
                &mut locked,
                &mut lock_reason,
                &mut prunable,
                &mut prune_reason,
            );
            path = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("HEAD ") {
            head = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("branch ") {
            branch = Some(rest.strip_prefix("refs/heads/").unwrap_or(rest).to_string());
        } else if line == "locked" {
            locked = true;
        } else if let Some(rest) = line.strip_prefix("locked ") {
            locked = true;
            lock_reason = Some(rest.to_string());
        } else if line == "prunable" {
            prunable = true;
        } else if let Some(rest) = line.strip_prefix("prunable ") {
            prunable = true;
            prune_reason = Some(rest.to_string());
        }
        // `detached` / `bare` leave branch as `None`.
    }
    flush(
        &mut out,
        &mut path,
        &mut head,
        &mut branch,
        &mut locked,
        &mut lock_reason,
        &mut prunable,
        &mut prune_reason,
    );
    out
}

fn porcelain_fields(porcelain: &str) -> impl Iterator<Item = &str> {
    porcelain.split(if porcelain.contains('\0') { '\0' } else { '\n' })
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
        assert!(wts[0].locked);
        assert!(wts[0].lock_reason.is_none());
        assert!(!wts[0].prunable);
    }

    #[test]
    fn parses_nul_terminated_lock_and_prune_metadata_without_quoting_paths() {
        let porcelain = concat!(
            "worktree /repo with spaces\0",
            "HEAD abc\0",
            "detached\0",
            "locked cognia:ws-42\0",
            "prunable gitdir file points to non-existent location\0\0"
        );
        let wts = parse_worktree_list(porcelain);
        assert_eq!(wts.len(), 1);
        assert_eq!(wts[0].path, "/repo with spaces");
        assert!(wts[0].locked);
        assert_eq!(wts[0].lock_reason.as_deref(), Some("cognia:ws-42"));
        assert!(wts[0].prunable);
        assert_eq!(
            wts[0].prune_reason.as_deref(),
            Some("gitdir file points to non-existent location")
        );
    }

    // ---------------------------------------------------------------
    // ADR-0111 lock-reason parsing (pure — no git required)
    // ---------------------------------------------------------------

    #[test]
    fn extract_lock_reason_returns_reason_for_matching_worktree() {
        let porcelain = "\
worktree /repo
HEAD abc
branch refs/heads/main

worktree /wt-managed
HEAD def
locked cognia:ws-42
";
        assert_eq!(
            extract_lock_reason(porcelain, "/wt-managed").as_deref(),
            Some("cognia:ws-42")
        );
    }

    #[test]
    fn extract_lock_reason_returns_none_for_bare_lock() {
        // Manual lock without a reason (rare) — treated as "not Cognia's" so
        // remove_managed will refuse the delete.
        let porcelain = "worktree /wt\nlocked\n";
        assert!(extract_lock_reason(porcelain, "/wt").is_none());
    }

    #[test]
    fn extract_lock_reason_returns_none_when_worktree_not_locked() {
        let porcelain = "worktree /a\nHEAD abc\n\nworktree /b\nlocked custom\n";
        assert!(extract_lock_reason(porcelain, "/a").is_none());
        assert_eq!(
            extract_lock_reason(porcelain, "/b").as_deref(),
            Some("custom")
        );
    }

    #[test]
    fn extract_lock_reason_returns_none_when_worktree_missing() {
        let porcelain = "worktree /a\nlocked custom\n";
        assert!(extract_lock_reason(porcelain, "/nowhere").is_none());
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
        add(&repo_str, &a, "agent/dup", None)
            .await
            .expect("first add");
        // git refuses to check the same branch out in two worktrees.
        assert!(
            add(&repo_str, &b, "agent/dup", None).await.is_err(),
            "second add on same branch must fail"
        );
    }

    // ---------------------------------------------------------------
    // ADR-0111 managed worktree (detached HEAD + lock reason)
    // ---------------------------------------------------------------

    #[tokio::test]
    async fn add_managed_creates_detached_and_locked_worktree() {
        if !git_on_path() {
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo_with_commit(&repo);
        let repo_str = repo.to_string_lossy().into_owned();
        let wt = tmp.path().join("wt-managed");
        let wt_str = wt.to_string_lossy().into_owned();

        add_managed(&repo_str, &wt_str, None, Some("cognia:ws-managed"))
            .await
            .expect("managed add");

        // git canonicalizes the worktree path (e.g. `/var/folders/...` →
        // `/private/var/folders/...` on macOS), so resolve before comparing.
        let canonical = wt.canonicalize().expect("canonicalize wt");
        let canonical_str = canonical.to_string_lossy().into_owned();

        // Detached HEAD → no branch surfaces on the worktree.
        let wts = list(&repo_str).await.unwrap();
        let managed = wts
            .iter()
            .find(|w| w.path == canonical_str)
            .unwrap_or_else(|| panic!("row for {canonical_str} present in {wts:?}"));
        assert!(
            managed.branch.is_none(),
            "managed worktree must be detached, got branch {:?}",
            managed.branch
        );

        // Lock reason must round-trip. `lock_reason` scans porcelain using
        // the path git itself printed, so we pass the canonicalized string.
        let reason = lock_reason(&repo_str, &canonical_str)
            .await
            .expect("read lock reason");
        assert_eq!(reason.as_deref(), Some("cognia:ws-managed"));
    }

    #[tokio::test]
    async fn remove_managed_refuses_mismatched_lock_reason() {
        if !git_on_path() {
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo_with_commit(&repo);
        let repo_str = repo.to_string_lossy().into_owned();
        let wt = tmp.path().join("wt-managed");
        let wt_str = wt.to_string_lossy().into_owned();

        add_managed(&repo_str, &wt_str, None, Some("cognia:ws-A"))
            .await
            .unwrap();
        let canonical_str = wt
            .canonicalize()
            .expect("canonicalize wt")
            .to_string_lossy()
            .into_owned();

        let error = remove_managed(&repo_str, &canonical_str, "cognia:ws-B", None)
            .await
            .expect_err("wrong reason must fail");
        assert!(
            matches!(error, crate::error::GitError::LockHeld(_)),
            "unexpected error {error:?}"
        );

        // Worktree must still exist after refusal.
        assert!(wt.exists(), "refused remove must not delete files");

        // Correct reason succeeds.
        remove_managed(&repo_str, &canonical_str, "cognia:ws-A", None)
            .await
            .expect("correct reason removes");
        assert!(!wt.exists(), "worktree dir gone after managed remove");
    }

    #[tokio::test]
    async fn create_branch_here_puts_the_managed_worktree_on_a_named_branch() {
        if !git_on_path() {
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo_with_commit(&repo);
        let repo_str = repo.to_string_lossy().into_owned();
        let wt = tmp.path().join("wt-detached");
        let wt_str = wt.to_string_lossy().into_owned();

        add_managed(&repo_str, &wt_str, None, Some("cognia:ws-cb"))
            .await
            .unwrap();
        let canonical_str = wt
            .canonicalize()
            .expect("canonicalize wt")
            .to_string_lossy()
            .into_owned();

        create_branch_here(&wt_str, "feature/managed-branch")
            .await
            .expect("checkout -b");

        let wts = list(&repo_str).await.unwrap();
        let managed = wts
            .iter()
            .find(|w| w.path == canonical_str)
            .expect("present");
        assert_eq!(
            managed.branch.as_deref(),
            Some("feature/managed-branch"),
            "branch was created and checked out"
        );
    }
}
