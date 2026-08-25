//! Tauri command surface for the Source Control panel.
//!
//! Read commands run on a blocking thread (libgit2 is sync). Mutating /
//! network commands are already async via `tokio::process` in their modules.
//! Every command returns `Result<T, GitError>` so the renderer can switch on
//! `err.kind` (see `error.rs`).

use tauri::{AppHandle, State};

use super::error::GitError;
use super::types::{
    AheadBehind, ConflictSide, GitBlameLine, GitBranch, GitCommit, GitConflict, GitDiff,
    GitFileChange, GitFileDiffStat, GitIdentity, GitRef, GitRemote, GitRepoState, GitStashEntry,
    GitStatus, GitTag, GitWorktree, RebaseTodoEntry,
};
use super::watcher::GitWatcherState;
use super::stack::{
    RestackOutcome, StackCapabilities, StackLayerState, StackPushOutcome,
};
use super::{
    blame, branch, commit, diff, diff_stat, history, interactive_rebase, merge, read, remote, repo,
    reset, restore, sequencer, stack, stage, stash, status, tag, worktree,
};

/// Run a synchronous git2 read on the blocking pool.
async fn blocking<T, F>(label: &'static str, f: F) -> Result<T, GitError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, GitError> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| GitError::CommandFailed(format!("{label} task panicked: {e}").into()))?
}

// ---------------------------------------------------------------- reads (git2)

#[tauri::command]
pub async fn git_is_repo(repo_path: String) -> Result<bool, GitError> {
    blocking("git_is_repo", move || {
        Ok(read::open_repo(&repo_path).is_ok())
    })
    .await
}

#[tauri::command]
pub async fn git_repo_state(repo_path: String) -> Result<GitRepoState, GitError> {
    blocking("git_repo_state", move || Ok(read::repo_state(&repo_path))).await
}

#[tauri::command]
pub async fn git_status(repo_path: String) -> Result<GitStatus, GitError> {
    blocking("git_status", move || status::status(&repo_path)).await
}

#[tauri::command]
pub async fn git_diff_stat(repo_path: String) -> Result<Vec<GitFileDiffStat>, GitError> {
    blocking("git_diff_stat", move || diff_stat::diff_stat(&repo_path)).await
}

#[tauri::command]
pub async fn git_diff_file(
    repo_path: String,
    path: String,
    staged: bool,
) -> Result<GitDiff, GitError> {
    blocking("git_diff_file", move || {
        diff::file_diff(&repo_path, &path, staged)
    })
    .await
}

#[tauri::command]
pub async fn git_diff_commit(
    repo_path: String,
    sha: String,
    path: String,
) -> Result<GitDiff, GitError> {
    blocking("git_diff_commit", move || {
        diff::commit_file_diff(&repo_path, &sha, &path)
    })
    .await
}

#[tauri::command]
pub async fn git_commit_files(
    repo_path: String,
    sha: String,
) -> Result<Vec<GitFileChange>, GitError> {
    blocking("git_commit_files", move || {
        diff::commit_files(&repo_path, &sha)
    })
    .await
}

#[tauri::command]
pub async fn git_diff_refs_files(
    repo_path: String,
    base: String,
    target: String,
) -> Result<Vec<GitFileChange>, GitError> {
    blocking("git_diff_refs_files", move || {
        diff::diff_refs_files(&repo_path, &base, &target)
    })
    .await
}

#[tauri::command]
pub async fn git_diff_refs_file(
    repo_path: String,
    base: String,
    target: String,
    path: String,
) -> Result<GitDiff, GitError> {
    blocking("git_diff_refs_file", move || {
        diff::diff_refs_file(&repo_path, &base, &target, &path)
    })
    .await
}

/// Aggregate staged diff text (`git diff --cached`) — the AI commit-message
/// prompt input. Async (shells out via `exec`), so it is NOT wrapped in
/// `blocking`.
#[tauri::command]
pub async fn git_diff_staged_all(repo_path: String) -> Result<String, GitError> {
    diff::staged_all_text(&repo_path).await
}

#[tauri::command]
pub async fn git_log(
    repo_path: String,
    max_count: usize,
    skip: usize,
) -> Result<Vec<GitCommit>, GitError> {
    blocking("git_log", move || {
        history::log(&repo_path, max_count, skip, None)
    })
    .await
}

#[tauri::command]
pub async fn git_file_history(
    repo_path: String,
    path: String,
    max_count: usize,
) -> Result<Vec<GitCommit>, GitError> {
    blocking("git_file_history", move || {
        history::log(&repo_path, max_count, 0, Some(&path))
    })
    .await
}

#[tauri::command]
pub async fn git_refs(repo_path: String) -> Result<Vec<GitRef>, GitError> {
    blocking("git_refs", move || history::refs(&repo_path)).await
}

/// Per-line blame (`git blame --porcelain`) for the working-tree file. Async
/// (shells out via `exec`), so not wrapped in `blocking`.
#[tauri::command]
pub async fn git_blame(
    repo_path: String,
    path: String,
    rev: Option<String>,
) -> Result<Vec<GitBlameLine>, GitError> {
    blame::blame(&repo_path, &path, rev.as_deref()).await
}

#[tauri::command]
pub async fn git_branches(repo_path: String) -> Result<Vec<GitBranch>, GitError> {
    blocking("git_branches", move || branch::list_branches(&repo_path)).await
}

#[tauri::command]
pub async fn git_remotes(repo_path: String) -> Result<Vec<GitRemote>, GitError> {
    blocking("git_remotes", move || remote::list_remotes(&repo_path)).await
}

#[tauri::command]
pub async fn git_tags(repo_path: String) -> Result<Vec<GitTag>, GitError> {
    blocking("git_tags", move || tag::list_tags(&repo_path)).await
}

#[tauri::command]
pub async fn git_stash_list(repo_path: String) -> Result<Vec<GitStashEntry>, GitError> {
    blocking("git_stash_list", move || stash::list_stashes(&repo_path)).await
}

#[tauri::command]
pub async fn git_conflicts(repo_path: String) -> Result<Vec<GitConflict>, GitError> {
    blocking("git_conflicts", move || merge::list_conflicts(&repo_path)).await
}

// ------------------------------------------------- mutations / network (system)

#[tauri::command]
pub async fn git_stage(
    repo_path: String,
    paths: Vec<String>,
    hunk_patch: Option<String>,
) -> Result<(), GitError> {
    match hunk_patch {
        Some(patch) => stage::stage_hunk(&repo_path, &patch).await,
        None => stage::stage(&repo_path, &paths).await,
    }
}

#[tauri::command]
pub async fn git_unstage(
    repo_path: String,
    paths: Vec<String>,
    hunk_patch: Option<String>,
) -> Result<(), GitError> {
    match hunk_patch {
        Some(patch) => stage::unstage_hunk(&repo_path, &patch).await,
        None => stage::unstage(&repo_path, &paths).await,
    }
}

#[tauri::command]
pub async fn git_discard(
    repo_path: String,
    paths: Vec<String>,
    hunk_patch: Option<String>,
) -> Result<(), GitError> {
    match hunk_patch {
        Some(patch) => stage::discard_hunk(&repo_path, &patch).await,
        None => stage::discard(&repo_path, &paths).await,
    }
}

#[tauri::command]
pub async fn git_discard_all(repo_path: String, include_untracked: bool) -> Result<(), GitError> {
    stage::discard_all(&repo_path, include_untracked).await
}

#[tauri::command]
pub async fn git_commit(
    repo_path: String,
    message: String,
    amend: bool,
    signoff: bool,
) -> Result<String, GitError> {
    commit::commit(&repo_path, &message, amend, signoff).await
}

#[tauri::command]
pub async fn git_checkout_branch(repo_path: String, name: String) -> Result<(), GitError> {
    branch::checkout(&repo_path, &name).await
}

#[tauri::command]
pub async fn git_create_branch(
    repo_path: String,
    name: String,
    checkout: bool,
    from: Option<String>,
) -> Result<(), GitError> {
    branch::create(&repo_path, &name, checkout, from.as_deref()).await
}

#[tauri::command]
pub async fn git_delete_branch(
    repo_path: String,
    name: String,
    force: bool,
) -> Result<(), GitError> {
    branch::delete(&repo_path, &name, force).await
}

#[tauri::command]
pub async fn git_rename_branch(
    repo_path: String,
    old: Option<String>,
    new_name: String,
) -> Result<(), GitError> {
    branch::rename(&repo_path, old.as_deref(), &new_name).await
}

// ---- worktrees (agent-team per-dispatch isolation) ----

#[tauri::command]
pub async fn git_worktree_add(
    repo_path: String,
    path: String,
    branch: String,
    base_ref: Option<String>,
) -> Result<(), GitError> {
    worktree::add(&repo_path, &path, &branch, base_ref.as_deref()).await
}

#[tauri::command]
pub async fn git_worktree_remove(
    repo_path: String,
    path: String,
    force: bool,
    delete_branch: Option<String>,
) -> Result<(), GitError> {
    worktree::remove(&repo_path, &path, force, delete_branch.as_deref()).await
}

#[tauri::command]
pub async fn git_worktree_list(repo_path: String) -> Result<Vec<GitWorktree>, GitError> {
    worktree::list(&repo_path).await
}

#[tauri::command]
pub async fn git_worktree_commit(
    worktree_path: String,
    message: String,
) -> Result<Option<String>, GitError> {
    worktree::commit(&worktree_path, &message).await
}

#[tauri::command]
pub async fn git_worktree_prune(repo_path: String) -> Result<(), GitError> {
    worktree::prune(&repo_path).await
}

#[tauri::command]
pub async fn git_fetch(
    repo_path: String,
    remote: Option<String>,
    prune: bool,
) -> Result<(), GitError> {
    remote::fetch(&repo_path, remote.as_deref(), prune).await
}

#[tauri::command]
pub async fn git_pull(
    repo_path: String,
    remote: Option<String>,
    branch: Option<String>,
    rebase: bool,
) -> Result<(), GitError> {
    remote::pull(&repo_path, remote.as_deref(), branch.as_deref(), rebase).await
}

#[tauri::command]
pub async fn git_push(
    repo_path: String,
    remote: Option<String>,
    branch: Option<String>,
    set_upstream: bool,
    force_with_lease: bool,
) -> Result<(), GitError> {
    remote::push(
        &repo_path,
        remote.as_deref(),
        branch.as_deref(),
        set_upstream,
        force_with_lease,
    )
    .await
}

#[tauri::command]
pub async fn git_sync(repo_path: String) -> Result<AheadBehind, GitError> {
    remote::sync(&repo_path).await
}

#[tauri::command]
pub async fn git_remote_add(repo_path: String, name: String, url: String) -> Result<(), GitError> {
    remote::add(&repo_path, &name, &url).await
}

#[tauri::command]
pub async fn git_remote_remove(repo_path: String, name: String) -> Result<(), GitError> {
    remote::remove(&repo_path, &name).await
}

#[tauri::command]
pub async fn git_create_tag(
    repo_path: String,
    name: String,
    message: Option<String>,
    target: Option<String>,
) -> Result<(), GitError> {
    tag::create(&repo_path, &name, message.as_deref(), target.as_deref()).await
}

#[tauri::command]
pub async fn git_delete_tag(repo_path: String, name: String) -> Result<(), GitError> {
    tag::delete(&repo_path, &name).await
}

#[tauri::command]
pub async fn git_push_tag(repo_path: String, remote: String, name: String) -> Result<(), GitError> {
    tag::push(&repo_path, &remote, &name).await
}

#[tauri::command]
pub async fn git_reset(repo_path: String, mode: String, target: String) -> Result<(), GitError> {
    reset::reset(&repo_path, &mode, &target).await
}

#[tauri::command]
pub async fn git_restore(
    repo_path: String,
    paths: Vec<String>,
    staged: bool,
    source: Option<String>,
) -> Result<(), GitError> {
    restore::restore(&repo_path, &paths, staged, source.as_deref()).await
}

#[tauri::command]
pub async fn git_rebase(repo_path: String, onto: String) -> Result<(), GitError> {
    sequencer::rebase(&repo_path, &onto).await
}

#[tauri::command]
pub async fn git_cherry_pick(repo_path: String, sha: String) -> Result<(), GitError> {
    sequencer::cherry_pick(&repo_path, &sha).await
}

#[tauri::command]
pub async fn git_revert(repo_path: String, sha: String) -> Result<(), GitError> {
    sequencer::revert(&repo_path, &sha).await
}

#[tauri::command]
pub async fn git_sequencer_continue(repo_path: String) -> Result<(), GitError> {
    sequencer::sequencer_continue(&repo_path).await
}

#[tauri::command]
pub async fn git_sequencer_abort(repo_path: String) -> Result<(), GitError> {
    sequencer::sequencer_abort(&repo_path).await
}

// ---------------------------------------------------------------- stacks

#[tauri::command]
pub async fn git_stack_capabilities(repo_path: String) -> Result<StackCapabilities, GitError> {
    stack::capabilities(&repo_path).await
}

#[tauri::command]
pub async fn git_stack_parents(repo_path: String) -> Result<Vec<(String, String)>, GitError> {
    blocking("git_stack_parents", move || {
        Ok(stack::parent_map(&repo_path)?.into_iter().collect())
    })
    .await
}

#[tauri::command]
pub async fn git_stack_set_parent(
    repo_path: String,
    branch: String,
    parent: Option<String>,
) -> Result<(), GitError> {
    stack::set_parent(&repo_path, &branch, parent.as_deref()).await
}

#[tauri::command]
pub async fn git_stack_validate(
    repo_path: String,
    branches: Vec<String>,
) -> Result<Vec<StackLayerState>, GitError> {
    stack::validate(&repo_path, &branches).await
}

#[tauri::command]
pub async fn git_stack_restack(
    repo_path: String,
    onto: String,
    branches: Vec<String>,
) -> Result<RestackOutcome, GitError> {
    stack::restack(&repo_path, &onto, &branches).await
}

#[tauri::command]
pub async fn git_stack_history(
    repo_path: String,
    branch: String,
) -> Result<Vec<(String, String)>, GitError> {
    stack::history(&repo_path, &branch).await
}

#[tauri::command]
pub async fn git_stack_revert(
    repo_path: String,
    branch: String,
    history_ref: String,
) -> Result<String, GitError> {
    stack::revert_to_history(&repo_path, &branch, &history_ref).await
}

#[tauri::command]
pub async fn git_stack_push(
    repo_path: String,
    remote: String,
    branches: Vec<String>,
) -> Result<StackPushOutcome, GitError> {
    stack::push_stack(&repo_path, &remote, &branches).await
}

#[tauri::command]
pub async fn git_rebase_commits(
    repo_path: String,
    base: String,
) -> Result<Vec<GitCommit>, GitError> {
    blocking("git_rebase_commits", move || {
        interactive_rebase::list_commits(&repo_path, &base)
    })
    .await
}

#[tauri::command]
pub async fn git_interactive_rebase(
    repo_path: String,
    base: String,
    entries: Vec<RebaseTodoEntry>,
) -> Result<(), GitError> {
    interactive_rebase::run(&repo_path, &base, &entries).await
}

#[tauri::command]
pub async fn git_stash_push(
    repo_path: String,
    message: Option<String>,
    include_untracked: bool,
    keep_index: bool,
) -> Result<(), GitError> {
    stash::push(
        &repo_path,
        message.as_deref(),
        include_untracked,
        keep_index,
    )
    .await
}

#[tauri::command]
pub async fn git_stash_pop(repo_path: String, index: usize) -> Result<(), GitError> {
    stash::pop(&repo_path, index).await
}

#[tauri::command]
pub async fn git_stash_apply(repo_path: String, index: usize) -> Result<(), GitError> {
    stash::apply(&repo_path, index).await
}

#[tauri::command]
pub async fn git_stash_drop(repo_path: String, index: usize) -> Result<(), GitError> {
    stash::drop(&repo_path, index).await
}

#[tauri::command]
pub async fn git_resolve_conflict(
    repo_path: String,
    path: String,
    merged_content: Option<String>,
    side: Option<ConflictSide>,
) -> Result<(), GitError> {
    if let Some(content) = merged_content {
        merge::resolve_manual(&repo_path, &path, &content).await
    } else if let Some(side) = side {
        merge::resolve_side(&repo_path, &path, side).await
    } else {
        Err(GitError::InvalidArgument(
            "git_resolve_conflict needs mergedContent or side".into(),
        ))
    }
}

#[tauri::command]
pub async fn git_init(path: String) -> Result<(), GitError> {
    repo::init(&path).await
}

#[tauri::command]
pub async fn git_clone(remote_url: String, destination: String) -> Result<String, GitError> {
    repo::clone_repo(&remote_url, &destination).await
}

/// Clone under guard rails (https-only, host allow-list, shallow, timed, size
/// bounded) — the entry point for callers that did not type the URL, such as a
/// plugin acquiring a repository to document. `git_clone` stays unguarded for
/// the Source Control panel, where the user supplied the remote themselves.
#[tauri::command]
pub async fn git_clone_guarded(
    remote_url: String,
    destination: String,
    guards: Option<repo::CloneGuards>,
) -> Result<String, GitError> {
    repo::clone_repo_guarded(&remote_url, &destination, &guards.unwrap_or_default()).await
}

/// Read `path` as text at `git_ref` (branch, tag or SHA).
///
/// `Ok(None)` distinguishes "absent or binary at that revision" from an error,
/// which is the distinction a consumer needs: a file that did not exist yet at
/// a base ref is normal, a bad ref is not. The underlying `read::blob_text` has
/// existed since the crate was written and was never exposed as a command, so
/// the only way to read a historical file was to abuse `git_diff_refs_file` and
/// hope the file happened to differ.
#[tauri::command]
pub async fn git_read_blob_at_ref(
    repo_path: String,
    git_ref: String,
    path: String,
) -> Result<Option<String>, GitError> {
    blocking("git_read_blob_at_ref", move || {
        read::blob_text_at_ref(&repo_path, &git_ref, &path)
    })
    .await
}

#[tauri::command]
pub async fn git_identity(repo_path: String) -> Result<GitIdentity, GitError> {
    blocking("git_identity", move || repo::identity(&repo_path)).await
}

#[tauri::command]
pub async fn git_set_identity(
    repo_path: String,
    name: String,
    email: String,
    global: bool,
) -> Result<(), GitError> {
    repo::set_identity(&repo_path, &name, &email, global).await
}

#[tauri::command]
pub async fn git_ignore_add(repo_path: String, pattern: String) -> Result<(), GitError> {
    repo::ignore_add(&repo_path, &pattern).await
}

#[tauri::command]
pub async fn git_merge(repo_path: String, branch: String) -> Result<(), GitError> {
    merge::merge(&repo_path, &branch).await
}

#[tauri::command]
pub async fn git_merge_abort(repo_path: String) -> Result<(), GitError> {
    merge::merge_abort(&repo_path).await
}

// --------------------------------------------------------------------- watcher

#[tauri::command]
pub async fn git_watch_start(
    state: State<'_, GitWatcherState>,
    app: AppHandle,
    repo_path: String,
) -> Result<(), GitError> {
    super::watcher::start(&state, &app, &repo_path)
}

#[tauri::command]
pub async fn git_watch_stop(
    state: State<'_, GitWatcherState>,
    repo_path: String,
) -> Result<(), GitError> {
    super::watcher::stop(&state, &repo_path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_on_path() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok()
    }

    fn run_git(cwd: &std::path::Path, args: &[&str]) {
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

    fn staged_names(cwd: &std::path::Path) -> String {
        let out = std::process::Command::new("git")
            .args(["diff", "--cached", "--name-only"])
            .current_dir(cwd)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    #[tokio::test]
    async fn blocking_maps_a_panic_to_command_failed() {
        // The blocking wrapper must turn a spawn_blocking panic into a typed
        // CommandFailed instead of unwinding the command task.
        let r: Result<(), GitError> = blocking("boom", || panic!("kaboom")).await;
        assert!(matches!(r, Err(GitError::CommandFailed(_))));
    }

    #[tokio::test]
    async fn blocking_passes_through_ok_and_err() {
        let ok: Result<i32, GitError> = blocking("ok", || Ok(7)).await;
        assert_eq!(ok.unwrap(), 7);
        let err: Result<(), GitError> =
            blocking("err", || Err(GitError::InvalidArgument("x".into()))).await;
        assert!(matches!(err, Err(GitError::InvalidArgument(_))));
    }

    #[tokio::test]
    async fn resolve_conflict_without_content_or_side_is_invalid_argument() {
        // The third dispatch branch: neither mergedContent nor side provided
        // fails fast with InvalidArgument, before touching the repo.
        let r = git_resolve_conflict("/nonexistent".into(), "f.txt".into(), None, None).await;
        assert!(matches!(r, Err(GitError::InvalidArgument(_))));
    }

    #[tokio::test]
    async fn stage_and_unstage_dispatch_to_paths_without_a_hunk() {
        if !git_on_path() {
            return;
        }
        // hunk_patch = None must route git_stage/git_unstage to whole-file
        // (path) staging, not the hunk path.
        let tmp = tempfile::TempDir::new().unwrap();
        let p = tmp.path();
        run_git(p, &["init", "-q", "-b", "main"]);
        run_git(p, &["config", "user.email", "t@e.com"]);
        run_git(p, &["config", "user.name", "T"]);
        std::fs::write(p.join("a.txt"), "one\n").unwrap();
        run_git(p, &["add", "."]);
        run_git(p, &["commit", "-q", "-m", "init"]);
        std::fs::write(p.join("a.txt"), "two\n").unwrap();
        let rp = p.to_string_lossy().into_owned();

        git_stage(rp.clone(), vec!["a.txt".into()], None)
            .await
            .unwrap();
        assert!(staged_names(p).contains("a.txt"));

        git_unstage(rp, vec!["a.txt".into()], None).await.unwrap();
        assert!(!staged_names(p).contains("a.txt"));
    }

    #[tokio::test]
    async fn clone_command_returns_the_created_worktree_path() {
        if !git_on_path() {
            return;
        }
        let fixture = tempfile::TempDir::new().unwrap();
        let source = fixture.path().join("source");
        std::fs::create_dir(&source).unwrap();
        run_git(&source, &["init", "-q", "-b", "main"]);
        run_git(&source, &["config", "user.email", "test@example.com"]);
        run_git(&source, &["config", "user.name", "Test User"]);
        std::fs::write(source.join("README.md"), "# source\n").unwrap();
        run_git(&source, &["add", "README.md"]);
        run_git(&source, &["commit", "-q", "-m", "initial"]);

        let destination = fixture.path().join("clone");
        let cloned = git_clone(
            source.to_string_lossy().into_owned(),
            destination.to_string_lossy().into_owned(),
        )
        .await
        .unwrap();

        assert_eq!(
            std::path::PathBuf::from(cloned),
            destination.canonicalize().unwrap()
        );
    }

    #[tokio::test]
    async fn identity_commands_round_trip_repository_local_config() {
        if !git_on_path() {
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        run_git(tmp.path(), &["init", "-q", "-b", "main"]);
        let repo_path = tmp.path().to_string_lossy().into_owned();

        git_set_identity(
            repo_path.clone(),
            "Cognia Developer".into(),
            "developer@example.com".into(),
            false,
        )
        .await
        .unwrap();
        let configured = git_identity(repo_path).await.unwrap();

        assert_eq!(configured.name.as_deref(), Some("Cognia Developer"));
        assert_eq!(configured.email.as_deref(), Some("developer@example.com"));
    }
}
