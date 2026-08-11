use super::*;

pub(super) const COMMANDS: &[&str] = &[
    "git_is_repo",
    "git_repo_state",
    "git_status",
    "git_diff_stat",
    "git_diff_file",
    "git_diff_commit",
    "git_commit_files",
    "git_log",
    "git_file_history",
    "git_branches",
    "git_remotes",
    "git_stash_list",
    "git_conflicts",
    "git_stage",
    "git_unstage",
    "git_discard",
    "git_discard_all",
    "git_commit",
    "git_checkout_branch",
    "git_create_branch",
    "git_delete_branch",
    "git_rename_branch",
    "git_fetch",
    "git_pull",
    "git_push",
    "git_sync",
    "git_stash_push",
    "git_stash_pop",
    "git_stash_apply",
    "git_stash_drop",
    "git_resolve_conflict",
    "git_merge_abort",
    "git_diff_refs_files",
    "git_diff_refs_file",
    "git_diff_staged_all",
    "git_refs",
    "git_blame",
    "git_tags",
    "git_worktree_list",
    "git_rebase_commits",
    "git_worktree_add",
    "git_worktree_remove",
    "git_worktree_commit",
    "git_worktree_prune",
    "git_remote_add",
    "git_remote_remove",
    "git_create_tag",
    "git_delete_tag",
    "git_push_tag",
    "git_reset",
    "git_restore",
    "git_rebase",
    "git_cherry_pick",
    "git_revert",
    "git_sequencer_continue",
    "git_sequencer_abort",
    "git_interactive_rebase",
    "git_init",
    "git_clone",
    "git_identity",
    "git_set_identity",
    "git_ignore_add",
    "git_merge",
];

pub(super) async fn dispatch(
    name: &str,
    args: Value,
    state: &SharedState,
    host: &super::super::dispatch_host::DispatchHost,
    device_id: &str,
    account_id: Option<&str>,
    scope: Option<&str>,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    let _ = (state, host, device_id, account_id, scope);
    let result = match name {
        // ── Source control (ADR-0038) — native git porcelain ────────────────
        // camelCase arg keys mirror `lib/git/commands.ts` (the shared desktop
        // client), so the entire git client works over Companion unchanged.
        "git_is_repo" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_is_repo(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_repo_state" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_repo_state(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_status" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_status(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_diff_stat" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_diff_stat(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_diff_file" => {
            let repo_path: String = required(&args, "repoPath")?;
            let path: String = required(&args, "path")?;
            let staged: bool = required(&args, "staged")?;
            crate::git::commands::git_diff_file(repo_path, path, staged)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_diff_commit" => {
            let repo_path: String = required(&args, "repoPath")?;
            let sha: String = required(&args, "sha")?;
            let path: String = required(&args, "path")?;
            crate::git::commands::git_diff_commit(repo_path, sha, path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_commit_files" => {
            let repo_path: String = required(&args, "repoPath")?;
            let sha: String = required(&args, "sha")?;
            crate::git::commands::git_commit_files(repo_path, sha)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_log" => {
            let repo_path: String = required(&args, "repoPath")?;
            let max_count: usize = required(&args, "maxCount")?;
            let skip: usize = required(&args, "skip")?;
            crate::git::commands::git_log(repo_path, max_count, skip)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_file_history" => {
            let repo_path: String = required(&args, "repoPath")?;
            let path: String = required(&args, "path")?;
            let max_count: usize = required(&args, "maxCount")?;
            crate::git::commands::git_file_history(repo_path, path, max_count)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_branches" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_branches(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_remotes" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_remotes(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_stash_list" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_stash_list(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_conflicts" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_conflicts(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_stage" => {
            let repo_path: String = required(&args, "repoPath")?;
            let paths: Vec<String> = required(&args, "paths")?;
            let hunk_patch: Option<String> = optional(&args, "hunkPatch")?;
            crate::git::commands::git_stage(repo_path, paths, hunk_patch)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_unstage" => {
            let repo_path: String = required(&args, "repoPath")?;
            let paths: Vec<String> = required(&args, "paths")?;
            let hunk_patch: Option<String> = optional(&args, "hunkPatch")?;
            crate::git::commands::git_unstage(repo_path, paths, hunk_patch)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_discard" => {
            let repo_path: String = required(&args, "repoPath")?;
            let paths: Vec<String> = required(&args, "paths")?;
            let hunk_patch: Option<String> = optional(&args, "hunkPatch")?;
            crate::git::commands::git_discard(repo_path, paths, hunk_patch)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_discard_all" => {
            let repo_path: String = required(&args, "repoPath")?;
            let include_untracked: bool = required(&args, "includeUntracked")?;
            crate::git::commands::git_discard_all(repo_path, include_untracked)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_commit" => {
            let repo_path: String = required(&args, "repoPath")?;
            let message: String = required(&args, "message")?;
            let amend: bool = required(&args, "amend")?;
            let signoff: bool = required(&args, "signoff")?;
            crate::git::commands::git_commit(repo_path, message, amend, signoff)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_checkout_branch" => {
            let repo_path: String = required(&args, "repoPath")?;
            let name: String = required(&args, "name")?;
            crate::git::commands::git_checkout_branch(repo_path, name)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_create_branch" => {
            let repo_path: String = required(&args, "repoPath")?;
            let name: String = required(&args, "name")?;
            let checkout: bool = required(&args, "checkout")?;
            let from: Option<String> = optional(&args, "from")?;
            crate::git::commands::git_create_branch(repo_path, name, checkout, from)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_delete_branch" => {
            let repo_path: String = required(&args, "repoPath")?;
            let name: String = required(&args, "name")?;
            let force: bool = required(&args, "force")?;
            crate::git::commands::git_delete_branch(repo_path, name, force)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_rename_branch" => {
            let repo_path: String = required(&args, "repoPath")?;
            let old: Option<String> = optional(&args, "old")?;
            let new_name: String = required(&args, "newName")?;
            crate::git::commands::git_rename_branch(repo_path, old, new_name)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_fetch" => {
            let repo_path: String = required(&args, "repoPath")?;
            let remote: Option<String> = optional(&args, "remote")?;
            let prune: bool = optional(&args, "prune")?.unwrap_or(false);
            crate::git::commands::git_fetch(repo_path, remote, prune)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_pull" => {
            let repo_path: String = required(&args, "repoPath")?;
            let remote: Option<String> = optional(&args, "remote")?;
            let branch: Option<String> = optional(&args, "branch")?;
            let rebase: bool = optional(&args, "rebase")?.unwrap_or(false);
            crate::git::commands::git_pull(repo_path, remote, branch, rebase)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_push" => {
            let repo_path: String = required(&args, "repoPath")?;
            let remote: Option<String> = optional(&args, "remote")?;
            let branch: Option<String> = optional(&args, "branch")?;
            let set_upstream: bool = optional(&args, "setUpstream")?.unwrap_or(false);
            let force_with_lease: bool = optional(&args, "forceWithLease")?.unwrap_or(false);
            crate::git::commands::git_push(
                repo_path,
                remote,
                branch,
                set_upstream,
                force_with_lease,
            )
            .await
            .map(|_| Value::Null)
            .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_sync" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_sync(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_stash_push" => {
            let repo_path: String = required(&args, "repoPath")?;
            let message: Option<String> = optional(&args, "message")?;
            let include_untracked: bool = optional(&args, "includeUntracked")?.unwrap_or(false);
            let keep_index: bool = optional(&args, "keepIndex")?.unwrap_or(false);
            crate::git::commands::git_stash_push(repo_path, message, include_untracked, keep_index)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_stash_pop" => {
            let repo_path: String = required(&args, "repoPath")?;
            let index: usize = required(&args, "index")?;
            crate::git::commands::git_stash_pop(repo_path, index)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_stash_apply" => {
            let repo_path: String = required(&args, "repoPath")?;
            let index: usize = required(&args, "index")?;
            crate::git::commands::git_stash_apply(repo_path, index)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_stash_drop" => {
            let repo_path: String = required(&args, "repoPath")?;
            let index: usize = required(&args, "index")?;
            crate::git::commands::git_stash_drop(repo_path, index)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_resolve_conflict" => {
            let repo_path: String = required(&args, "repoPath")?;
            let path: String = required(&args, "path")?;
            let merged_content: Option<String> = optional(&args, "mergedContent")?;
            let side: Option<crate::git::types::ConflictSide> = optional(&args, "side")?;
            crate::git::commands::git_resolve_conflict(repo_path, path, merged_content, side)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_merge_abort" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_merge_abort(repo_path)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_diff_refs_files" => {
            let repo_path: String = required(&args, "repoPath")?;
            let base: String = required(&args, "base")?;
            let target: String = required(&args, "target")?;
            crate::git::commands::git_diff_refs_files(repo_path, base, target)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_diff_refs_file" => {
            let repo_path: String = required(&args, "repoPath")?;
            let base: String = required(&args, "base")?;
            let target: String = required(&args, "target")?;
            let path: String = required(&args, "path")?;
            crate::git::commands::git_diff_refs_file(repo_path, base, target, path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_diff_staged_all" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_diff_staged_all(repo_path)
                .await
                .map(Value::String)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_refs" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_refs(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_blame" => {
            let repo_path: String = required(&args, "repoPath")?;
            let path: String = required(&args, "path")?;
            let rev: Option<String> = optional(&args, "rev")?;
            crate::git::commands::git_blame(repo_path, path, rev)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_tags" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_tags(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_worktree_list" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_worktree_list(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_rebase_commits" => {
            let repo_path: String = required(&args, "repoPath")?;
            let base: String = required(&args, "base")?;
            crate::git::commands::git_rebase_commits(repo_path, base)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_worktree_add" => {
            let repo_path: String = required(&args, "repoPath")?;
            let path: String = required(&args, "path")?;
            let branch: String = required(&args, "branch")?;
            let base_ref: Option<String> = optional(&args, "baseRef")?;
            crate::git::commands::git_worktree_add(repo_path, path, branch, base_ref)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_worktree_remove" => {
            let repo_path: String = required(&args, "repoPath")?;
            let path: String = required(&args, "path")?;
            let force: bool = required(&args, "force")?;
            let delete_branch: Option<String> = optional(&args, "deleteBranch")?;
            crate::git::commands::git_worktree_remove(repo_path, path, force, delete_branch)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_worktree_commit" => {
            let worktree_path: String = required(&args, "worktreePath")?;
            let message: String = required(&args, "message")?;
            crate::git::commands::git_worktree_commit(worktree_path, message)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_worktree_prune" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_worktree_prune(repo_path)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_remote_add" => {
            let repo_path: String = required(&args, "repoPath")?;
            let name: String = required(&args, "name")?;
            let url: String = required(&args, "url")?;
            crate::git::commands::git_remote_add(repo_path, name, url)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_remote_remove" => {
            let repo_path: String = required(&args, "repoPath")?;
            let name: String = required(&args, "name")?;
            crate::git::commands::git_remote_remove(repo_path, name)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_create_tag" => {
            let repo_path: String = required(&args, "repoPath")?;
            let name: String = required(&args, "name")?;
            let message: Option<String> = optional(&args, "message")?;
            let target: Option<String> = optional(&args, "target")?;
            crate::git::commands::git_create_tag(repo_path, name, message, target)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_delete_tag" => {
            let repo_path: String = required(&args, "repoPath")?;
            let name: String = required(&args, "name")?;
            crate::git::commands::git_delete_tag(repo_path, name)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_push_tag" => {
            let repo_path: String = required(&args, "repoPath")?;
            let remote: String = required(&args, "remote")?;
            let name: String = required(&args, "name")?;
            crate::git::commands::git_push_tag(repo_path, remote, name)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_reset" => {
            let repo_path: String = required(&args, "repoPath")?;
            let mode: String = required(&args, "mode")?;
            let target: String = required(&args, "target")?;
            crate::git::commands::git_reset(repo_path, mode, target)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_restore" => {
            let repo_path: String = required(&args, "repoPath")?;
            let paths: Vec<String> = required(&args, "paths")?;
            let staged: bool = required(&args, "staged")?;
            let source: Option<String> = optional(&args, "source")?;
            crate::git::commands::git_restore(repo_path, paths, staged, source)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_rebase" => {
            let repo_path: String = required(&args, "repoPath")?;
            let onto: String = required(&args, "onto")?;
            crate::git::commands::git_rebase(repo_path, onto)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_cherry_pick" => {
            let repo_path: String = required(&args, "repoPath")?;
            let sha: String = required(&args, "sha")?;
            crate::git::commands::git_cherry_pick(repo_path, sha)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_revert" => {
            let repo_path: String = required(&args, "repoPath")?;
            let sha: String = required(&args, "sha")?;
            crate::git::commands::git_revert(repo_path, sha)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_sequencer_continue" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_sequencer_continue(repo_path)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_sequencer_abort" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_sequencer_abort(repo_path)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_interactive_rebase" => {
            let repo_path: String = required(&args, "repoPath")?;
            let base: String = required(&args, "base")?;
            let entries: Vec<crate::git::types::RebaseTodoEntry> = required(&args, "entries")?;
            crate::git::commands::git_interactive_rebase(repo_path, base, entries)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_init" => {
            let path: String = required(&args, "path")?;
            crate::git::commands::git_init(path)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_clone" => {
            let remote_url: String = required(&args, "remoteUrl")?;
            let destination: String = required(&args, "destination")?;
            crate::git::commands::git_clone(remote_url, destination)
                .await
                .map(Value::String)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_identity" => {
            let repo_path: String = required(&args, "repoPath")?;
            let identity = crate::git::commands::git_identity(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?;
            serde_json::to_value(identity)
                .map_err(|e| RpcError::internal(format!("serialize git identity: {e}")))
        }
        "git_set_identity" => {
            let repo_path: String = required(&args, "repoPath")?;
            let name: String = required(&args, "name")?;
            let email: String = required(&args, "email")?;
            let global: bool = optional(&args, "global")?.unwrap_or(false);
            crate::git::commands::git_set_identity(repo_path, name, email, global)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_ignore_add" => {
            let repo_path: String = required(&args, "repoPath")?;
            let pattern: String = required(&args, "pattern")?;
            crate::git::commands::git_ignore_add(repo_path, pattern)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_merge" => {
            let repo_path: String = required(&args, "repoPath")?;
            let branch: String = required(&args, "branch")?;
            crate::git::commands::git_merge(repo_path, branch)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        unknown => Err(RpcError::unknown_command(unknown)),
    };
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_family_is_non_empty_and_unique() {
        assert!(!COMMANDS.is_empty());
        let unique: std::collections::HashSet<_> = COMMANDS.iter().copied().collect();
        assert_eq!(unique.len(), COMMANDS.len());
    }
}
