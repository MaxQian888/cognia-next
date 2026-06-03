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
    GitFileChange, GitRef, GitRemote, GitRepoState, GitStashEntry, GitStatus, GitTag,
    RebaseTodoEntry,
};
use super::watcher::GitWatcherState;
use super::{
    blame, branch, commit, diff, history, interactive_rebase, merge, read, remote, reset, restore,
    sequencer, stage, stash, status, tag,
};

/// Run a synchronous git2 read on the blocking pool.
async fn blocking<T, F>(label: &'static str, f: F) -> Result<T, GitError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, GitError> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| GitError::CommandFailed(format!("{label} task panicked: {e}")))?
}

// ---------------------------------------------------------------- reads (git2)

#[tauri::command]
pub async fn git_is_repo(repo_path: String) -> Result<bool, GitError> {
    blocking("git_is_repo", move || Ok(read::open_repo(&repo_path).is_ok())).await
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
pub async fn git_discard_all(
    repo_path: String,
    include_untracked: bool,
) -> Result<(), GitError> {
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
    stash::push(&repo_path, message.as_deref(), include_untracked, keep_index).await
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
