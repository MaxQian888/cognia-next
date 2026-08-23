use super::*;

#[derive(Clone)]
struct RemoteGitTarget {
    workspace: crate::files::RemoteGitWorkspace,
    relative_path: String,
    resolved_path: std::path::PathBuf,
}

fn relative_path_from_args(
    args: &Value,
    key: &str,
) -> Result<String, (StatusCode, Json<RpcError>)> {
    optional::<String>(args, key).map(|value| value.unwrap_or_default())
}

/// Where a host's remote Git workspaces come from.
///
/// The desktop's are the account-scoped roots its renderer registers through
/// `fs_set_allowed_roots` (`lib/files/allowed-roots-sync.ts`). That command is
/// `target=client` and the brain never runs the renderer, so on the headless
/// host that registry is empty forever — which is why Source Control used to
/// be a desktop-only host feature although not one git arm is host-gated.
/// The headless host instead treats every directory directly under its
/// policy-owned workspaces root as a Git workspace: the same trust boundary
/// `authorize_workspace_root` already applies to `workspace.files`, so a
/// remote client can `git_status` exactly what it can `fs_read_workspace_file`.
#[derive(Clone)]
enum GitWorkspaceSource {
    DesktopRegistry,
    HeadlessPolicy(crate::external_agent::presets::SpawnPolicy),
}

impl GitWorkspaceSource {
    fn for_host(host: &super::super::dispatch_host::DispatchHost) -> Self {
        match host.headless() {
            Some(services) => Self::HeadlessPolicy(services.spawn_policy.clone()),
            None => Self::DesktopRegistry,
        }
    }

    fn list(&self, account_id: &str) -> Vec<crate::files::RemoteGitWorkspace> {
        match self {
            Self::DesktopRegistry => crate::files::list_remote_git_workspaces(account_id),
            Self::HeadlessPolicy(policy) => list_headless_git_workspaces(policy),
        }
    }

    fn resolve(
        &self,
        account_id: &str,
        workspace_id: &str,
        relative_path: &str,
    ) -> Result<(crate::files::RemoteGitWorkspace, std::path::PathBuf), String> {
        match self {
            Self::DesktopRegistry => crate::files::resolve_remote_git_workspace_path(
                account_id,
                workspace_id,
                Some(relative_path),
            ),
            Self::HeadlessPolicy(policy) => {
                let workspace = resolve_headless_git_workspace(policy, workspace_id)?;
                let resolved = crate::files::resolve_git_workspace_relative_path(
                    &workspace,
                    Some(relative_path),
                )?;
                Ok((workspace, resolved))
            }
        }
    }
}

/// A headless Git workspace id is the bare name of a directory directly under
/// the workspaces root — one normal path component, nothing that could climb.
fn headless_workspace_dir_name(workspace_id: &str) -> Option<&str> {
    let name = workspace_id.trim();
    let mut components = std::path::Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(std::path::Component::Normal(only)), None)
            if only == name && !name.starts_with('.') && !name.contains(['/', '\\']) =>
        {
            Some(name)
        }
        _ => None,
    }
}

fn resolve_headless_git_workspace(
    policy: &crate::external_agent::presets::SpawnPolicy,
    workspace_id: &str,
) -> Result<crate::files::RemoteGitWorkspace, String> {
    let name = headless_workspace_dir_name(workspace_id)
        .ok_or_else(|| "Git workspace is not authorized for this account".to_string())?;
    // `validate_workspace_root` joins a relative name onto the workspaces root,
    // canonicalizes it and refuses anything that escapes — the policy owns the
    // boundary, this arm only names a directory inside it.
    let path = policy
        .validate_workspace_root(name)
        .map_err(|_| "Git workspace is not authorized for this account".to_string())?;
    if !std::path::Path::new(&path).is_dir() {
        return Err("Git workspace is not authorized for this account".to_string());
    }
    Ok(crate::files::RemoteGitWorkspace {
        workspace_id: name.to_string(),
        display_name: name.to_string(),
        path,
    })
}

fn list_headless_git_workspaces(
    policy: &crate::external_agent::presets::SpawnPolicy,
) -> Vec<crate::files::RemoteGitWorkspace> {
    let Ok(root) = policy.validate_workspace_root(".") else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut workspaces = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_string();
            headless_workspace_dir_name(&name)?;
            Some(crate::files::RemoteGitWorkspace {
                workspace_id: name.clone(),
                display_name: name,
                path: entry.path().to_string_lossy().into_owned(),
            })
        })
        .collect::<Vec<_>>();
    workspaces.sort_by(|left, right| left.workspace_id.cmp(&right.workspace_id));
    workspaces
}

fn resolve_remote_target(
    source: &GitWorkspaceSource,
    args: &Value,
    account_id: Option<&str>,
    relative_key: &str,
) -> Result<RemoteGitTarget, (StatusCode, Json<RpcError>)> {
    let account_id = account_id
        .ok_or_else(|| RpcError::forbidden("remote Git requires an account-bound device token"))?;
    let workspace_id: String = required(args, "workspaceId")?;
    let relative_path = relative_path_from_args(args, relative_key)?;
    let (workspace, resolved_path) = source
        .resolve(account_id, &workspace_id, &relative_path)
        .map_err(RpcError::forbidden)?;
    Ok(RemoteGitTarget {
        workspace,
        relative_path,
        resolved_path,
    })
}

fn authorize_discovered_repository(
    target: &RemoteGitTarget,
) -> Result<(), (StatusCode, Json<RpcError>)> {
    let (workdir, git_dir) =
        crate::git::read::repository_boundaries(&target.resolved_path.to_string_lossy())
            .map_err(|error| RpcError::internal(sanitize_text(&error.to_string(), target)))?;
    let root = std::path::Path::new(&target.workspace.path)
        .canonicalize()
        .map_err(|_| RpcError::forbidden("authorized Git workspace is no longer available"))?;
    if !workdir.starts_with(&root) || !git_dir.starts_with(&root) {
        return Err(RpcError::forbidden(
            "discovered repository escapes the authorized Git workspace",
        ));
    }
    Ok(())
}

fn prepare_remote_args(
    source: &GitWorkspaceSource,
    name: &str,
    mut args: Value,
    account_id: Option<&str>,
    scope: Option<&str>,
) -> Result<(Value, Option<RemoteGitTarget>), (StatusCode, Json<RpcError>)> {
    if scope == Some("service") || name == "git_workspace_list" {
        return Ok((args, None));
    }
    let object = args
        .as_object_mut()
        .ok_or_else(|| RpcError::malformed("Git RPC arguments must be an object".into()))?;
    let relative_key = match name {
        "git_clone" => "destinationRelativePath",
        "git_worktree_commit" | "git_worktree_remove" => "worktreeRelativePath",
        "git_worktree_add" => "destinationRelativePath",
        _ => "relativePath",
    };
    let target = resolve_remote_target(
        source,
        &Value::Object(object.clone()),
        account_id,
        relative_key,
    )?;
    let resolved = target.resolved_path.to_string_lossy().to_string();
    match name {
        "git_clone" => {
            object.insert("destination".into(), Value::String(resolved));
        }
        "git_init" => {
            object.insert("path".into(), Value::String(resolved));
        }
        "git_worktree_add" | "git_worktree_remove" => {
            let repository_target = resolve_remote_target(
                source,
                &Value::Object(object.clone()),
                account_id,
                "relativePath",
            )?;
            authorize_discovered_repository(&repository_target)?;
            object.insert(
                "repoPath".into(),
                Value::String(
                    repository_target
                        .resolved_path
                        .to_string_lossy()
                        .to_string(),
                ),
            );
            object.insert("path".into(), Value::String(resolved));
            if name == "git_worktree_remove" {
                authorize_discovered_repository(&target)?;
            }
        }
        "git_worktree_commit" => {
            object.insert("worktreePath".into(), Value::String(resolved));
            authorize_discovered_repository(&target)?;
        }
        "git_repo_state" | "git_is_repo" => {
            if crate::git::read::repository_boundaries(&resolved).is_ok() {
                authorize_discovered_repository(&target)?;
            }
            object.insert("repoPath".into(), Value::String(resolved));
        }
        _ => {
            authorize_discovered_repository(&target)?;
            object.insert("repoPath".into(), Value::String(resolved));
        }
    }
    Ok((args, Some(target)))
}

fn sanitize_text(value: &str, target: &RemoteGitTarget) -> String {
    value
        .replace(&target.workspace.path, "<workspace>")
        .replace(
            &target.resolved_path.to_string_lossy().to_string(),
            "<workspace>",
        )
}

fn relative_to_workspace(path: &str, target: &RemoteGitTarget) -> Option<String> {
    let root = std::path::Path::new(&target.workspace.path)
        .canonicalize()
        .ok()?;
    let canonical = std::path::Path::new(path).canonicalize().ok()?;
    canonical
        .strip_prefix(root)
        .ok()
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
}

fn sanitize_remote_result(name: &str, value: Value, target: &RemoteGitTarget) -> Value {
    if name == "git_clone" {
        return json!({
            "workspaceId": target.workspace.workspace_id,
            "relativePath": target.relative_path,
        });
    }
    let mut value = value;
    if name == "git_repo_state" {
        if let Some(root_dir) = value.get("rootDir").and_then(Value::as_str) {
            value["rootDir"] = relative_to_workspace(root_dir, target)
                .map(Value::String)
                .unwrap_or(Value::Null);
        }
    } else if name == "git_worktree_list" {
        let entries = value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                let path = entry.get("path")?.as_str()?;
                let relative = relative_to_workspace(path, target)?;
                let mut entry = entry.clone();
                entry["path"] = Value::String(relative);
                Some(entry)
            })
            .collect();
        value = Value::Array(entries);
    } else if name == "git_remotes" {
        if let Some(remotes) = value.as_array_mut() {
            for remote in remotes {
                for key in ["fetchUrl", "pushUrl"] {
                    if let Some(url) = remote.get(key).and_then(Value::as_str) {
                        if is_local_remote_url(url) {
                            remote[key] = Value::String("local://redacted".into());
                        }
                    }
                }
            }
        }
    }
    sanitize_value(value, target)
}

fn is_local_remote_url(value: &str) -> bool {
    let bytes = value.as_bytes();
    std::path::Path::new(value).is_absolute()
        || value.starts_with("file:")
        || value.starts_with("\\\\")
        || value.starts_with("//")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\'))
}

fn sanitize_value(value: Value, target: &RemoteGitTarget) -> Value {
    match value {
        Value::String(value) => Value::String(sanitize_text(&value, target)),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| sanitize_value(value, target))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, sanitize_value(value, target)))
                .collect(),
        ),
        value => value,
    }
}

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
    "git_workspace_list",
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
    let _ = (state, device_id);
    let workspace_source = GitWorkspaceSource::for_host(host);
    let prepare_source = workspace_source.clone();
    let prepare_name = name.to_string();
    let prepare_account_id = account_id.map(str::to_string);
    let prepare_scope = scope.map(str::to_string);
    let (args, remote_target) = tokio::task::spawn_blocking(move || {
        prepare_remote_args(
            &prepare_source,
            &prepare_name,
            args,
            prepare_account_id.as_deref(),
            prepare_scope.as_deref(),
        )
    })
    .await
    .map_err(|error| RpcError::internal(format!("prepare Git request: {error}")))??;
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
            crate::task_workspace::git_worktree_remove(repo_path, path, force, delete_branch)
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
            let identity = if remote_target.is_some() {
                crate::git::repo::identity_local(&repo_path)
            } else {
                crate::git::repo::identity(&repo_path)
            }
            .map_err(|e| RpcError::internal(e.to_string()))?;
            serde_json::to_value(identity)
                .map_err(|e| RpcError::internal(format!("serialize git identity: {e}")))
        }
        "git_set_identity" => {
            let repo_path: String = required(&args, "repoPath")?;
            let name: String = required(&args, "name")?;
            let email: String = required(&args, "email")?;
            let global: bool = optional(&args, "global")?.unwrap_or(false);
            if remote_target.is_some() && global {
                return Err(RpcError::forbidden(
                    "remote Git identity may only be changed for the selected repository",
                ));
            }
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
        "git_workspace_list" => {
            let account_id = account_id
                .ok_or_else(|| {
                    RpcError::forbidden("remote Git requires an account-bound device token")
                })?
                .to_string();
            let list_source = workspace_source.clone();
            let workspaces = tokio::task::spawn_blocking(move || {
                list_source
                    .list(&account_id)
                    .into_iter()
                    .map(|workspace| {
                        let target = RemoteGitTarget {
                            relative_path: String::new(),
                            resolved_path: std::path::PathBuf::from(&workspace.path),
                            workspace: workspace.clone(),
                        };
                        let mut state = crate::git::read::repo_state(&workspace.path);
                        if state.is_repo && authorize_discovered_repository(&target).is_err() {
                            state = crate::git::types::GitRepoState {
                                is_repo: false,
                                root_dir: None,
                                detached_head: false,
                                operation_in_progress: None,
                            };
                        }
                        if let Some(root_dir) = state.root_dir.as_deref() {
                            state.root_dir = relative_to_workspace(root_dir, &target);
                        }
                        json!({
                            "workspaceId": workspace.workspace_id,
                            "displayName": workspace.display_name,
                            "repositoryState": state,
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .await
            .map_err(|error| RpcError::internal(format!("list Git workspaces: {error}")))?;
            Ok(Value::Array(workspaces))
        }
        unknown => Err(RpcError::unknown_command(unknown)),
    };
    match (result, remote_target.as_ref()) {
        (Ok(value), Some(target)) => Ok(sanitize_remote_result(name, value, target)),
        (Err((status, Json(mut error))), Some(target)) => {
            error.message = sanitize_text(&error.message, target);
            Err((status, Json(error)))
        }
        (result, None) => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `fs_set_allowed_roots` REPLACES a process-global root list rather than
    /// adding to it, so two tests that register a workspace concurrently
    /// overwrite each other and the loser fails an authorization assertion that
    /// has nothing to do with what it was testing. That is how
    /// `upward_repository_discovery_is_rejected_but_nested_repository_is_allowed`
    /// came to pass alone and fail in the suite.
    ///
    /// Poison is absorbed: a panic in one of these tests should fail that test,
    /// not convert the other two into unrelated poison errors.
    static ALLOWED_ROOTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock_roots() -> std::sync::MutexGuard<'static, ()> {
        ALLOWED_ROOTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn register_workspace(account_id: &str, workspace_id: &str, root: &std::path::Path) {
        crate::files::fs_set_allowed_roots(
            vec![root.to_string_lossy().to_string()],
            Some(account_id.to_string()),
            Some(vec![crate::files::GitWorkspaceRegistration {
                workspace_id: workspace_id.to_string(),
                display_name: "Authorized workspace".to_string(),
                path: root.to_string_lossy().to_string(),
            }]),
        );
    }

    #[test]
    fn command_family_is_non_empty_and_unique() {
        assert!(!COMMANDS.is_empty());
        let unique: std::collections::HashSet<_> = COMMANDS.iter().copied().collect();
        assert_eq!(unique.len(), COMMANDS.len());
    }

    #[test]
    fn remote_target_uses_account_scoped_workspace_and_rejects_traversal() {
        let _roots = lock_roots();
        let root = tempfile::TempDir::new().unwrap();
        register_workspace("acct-source-a", "workspace-a", root.path());
        let args = json!({ "workspaceId": "workspace-a", "relativePath": "nested" });

        let (prepared, target) = prepare_remote_args(
            &GitWorkspaceSource::DesktopRegistry,
            "git_repo_state",
            args,
            Some("acct-source-a"),
            None,
        )
        .unwrap();

        assert_eq!(
            prepared["repoPath"],
            Value::String(root.path().join("nested").to_string_lossy().to_string())
        );
        assert_eq!(target.unwrap().workspace.workspace_id, "workspace-a");
        assert!(prepare_remote_args(
            &GitWorkspaceSource::DesktopRegistry,
            "git_repo_state",
            json!({ "workspaceId": "workspace-a", "relativePath": "../escape" }),
            Some("acct-source-a"),
            None,
        )
        .is_err());
        assert!(prepare_remote_args(
            &GitWorkspaceSource::DesktopRegistry,
            "git_repo_state",
            json!({ "workspaceId": "workspace-a" }),
            Some("acct-source-b"),
            None,
        )
        .is_err());
    }

    #[tokio::test]
    async fn upward_repository_discovery_is_rejected_but_nested_repository_is_allowed() {
        let _roots = lock_roots();
        let parent = tempfile::TempDir::new().unwrap();
        crate::git::repo::init(&parent.path().to_string_lossy())
            .await
            .unwrap();
        let granted_child = parent.path().join("granted");
        std::fs::create_dir_all(&granted_child).unwrap();
        register_workspace("acct-upward", "workspace-upward", &granted_child);

        assert!(prepare_remote_args(
            &GitWorkspaceSource::DesktopRegistry,
            "git_status",
            json!({ "workspaceId": "workspace-upward" }),
            Some("acct-upward"),
            None,
        )
        .is_err());

        let nested = granted_child.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        crate::git::repo::init(&nested.to_string_lossy())
            .await
            .unwrap();
        assert!(prepare_remote_args(
            &GitWorkspaceSource::DesktopRegistry,
            "git_status",
            json!({ "workspaceId": "workspace-upward", "relativePath": "nested" }),
            Some("acct-upward"),
            None,
        )
        .is_ok());
    }

    #[tokio::test]
    async fn remote_worktree_requests_keep_the_authorized_repository_path() {
        let _roots = lock_roots();
        let root = tempfile::TempDir::new().unwrap();
        crate::git::repo::init(&root.path().to_string_lossy())
            .await
            .unwrap();
        let nested = root.path().join("nested-worktree");
        std::fs::create_dir_all(&nested).unwrap();
        crate::git::repo::init(&nested.to_string_lossy())
            .await
            .unwrap();
        register_workspace("acct-worktree", "workspace-worktree", root.path());

        let (add, _) = prepare_remote_args(
            &GitWorkspaceSource::DesktopRegistry,
            "git_worktree_add",
            json!({
                "workspaceId": "workspace-worktree",
                "relativePath": "",
                "destinationRelativePath": "new-worktree",
                "branch": "feature"
            }),
            Some("acct-worktree"),
            None,
        )
        .unwrap();
        assert_eq!(add["repoPath"], root.path().to_string_lossy().as_ref());
        assert_eq!(
            add["path"],
            root.path().join("new-worktree").to_string_lossy().as_ref()
        );

        let (remove, _) = prepare_remote_args(
            &GitWorkspaceSource::DesktopRegistry,
            "git_worktree_remove",
            json!({
                "workspaceId": "workspace-worktree",
                "relativePath": "",
                "worktreeRelativePath": "nested-worktree",
                "force": false
            }),
            Some("acct-worktree"),
            None,
        )
        .unwrap();
        assert_eq!(remove["repoPath"], root.path().to_string_lossy().as_ref());
        assert_eq!(remove["path"], nested.to_string_lossy().as_ref());
    }

    fn headless_source(root: &std::path::Path) -> GitWorkspaceSource {
        GitWorkspaceSource::HeadlessPolicy(crate::external_agent::presets::SpawnPolicy::new(
            root.to_path_buf(),
            false,
        ))
    }

    #[test]
    fn headless_workspaces_are_the_directories_under_the_policy_root() {
        let root = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(root.path().join("beta")).unwrap();
        std::fs::create_dir_all(root.path().join("alpha")).unwrap();
        std::fs::create_dir_all(root.path().join(".hidden")).unwrap();
        std::fs::write(root.path().join("not-a-dir"), b"x").unwrap();
        let source = headless_source(root.path());

        let listed = source.list("any-account");
        assert_eq!(
            listed
                .iter()
                .map(|workspace| workspace.workspace_id.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "beta"]
        );
        let canonical_root = root.path().canonicalize().unwrap();
        assert_eq!(
            std::path::Path::new(&listed[0].path),
            canonical_root.join("alpha")
        );

        // The listing is per host, not per account: the policy root is the
        // single-tenant trust boundary, exactly like `authorize_workspace_root`.
        assert_eq!(source.list("another-account").len(), 2);
    }

    #[test]
    fn headless_workspace_ids_resolve_inside_the_policy_root_and_cannot_climb() {
        let root = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(root.path().join("alpha").join("nested")).unwrap();
        let outside = tempfile::TempDir::new().unwrap();
        let source = headless_source(root.path());
        let canonical_root = root.path().canonicalize().unwrap();

        let (workspace, resolved) = source.resolve("acct", "alpha", "nested").unwrap();
        assert_eq!(workspace.workspace_id, "alpha");
        assert_eq!(resolved, canonical_root.join("alpha").join("nested"));

        let (_, resolved_root) = source.resolve("acct", "alpha", "").unwrap();
        assert_eq!(resolved_root, canonical_root.join("alpha"));

        for bad in [
            "",
            ".",
            "..",
            "../alpha",
            "alpha/nested",
            "alpha\\nested",
            ".hidden",
            "missing",
            outside.path().to_str().unwrap(),
        ] {
            assert!(
                source.resolve("acct", bad, "").is_err(),
                "workspace id {bad:?} must be refused"
            );
        }
        assert!(source.resolve("acct", "alpha", "../escape").is_err());
        assert!(source.resolve("acct", "alpha", "/etc").is_err());
    }

    #[test]
    fn headless_prepare_rewrites_the_opaque_target_onto_the_policy_root() {
        let root = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(root.path().join("alpha")).unwrap();
        let source = headless_source(root.path());
        let canonical_root = root.path().canonicalize().unwrap();

        let (prepared, target) = prepare_remote_args(
            &source,
            "git_repo_state",
            json!({ "workspaceId": "alpha", "relativePath": "" }),
            Some("acct"),
            None,
        )
        .unwrap();
        assert_eq!(
            prepared["repoPath"],
            Value::String(canonical_root.join("alpha").to_string_lossy().to_string())
        );
        assert_eq!(target.unwrap().workspace.display_name, "alpha");

        // The desktop registry never sees headless ids, and vice versa.
        assert!(prepare_remote_args(
            &GitWorkspaceSource::DesktopRegistry,
            "git_repo_state",
            json!({ "workspaceId": "alpha", "relativePath": "" }),
            Some("acct"),
            None,
        )
        .is_err());
    }

    #[test]
    fn local_remote_url_detection_is_cross_platform() {
        for local in [
            "/srv/repository.git",
            "file:///srv/repository.git",
            r"C:\repository.git",
            "C:/repository.git",
            r"\\server\share\repository.git",
            "//server/share/repository.git",
        ] {
            assert!(is_local_remote_url(local), "expected local URL: {local}");
        }
        assert!(!is_local_remote_url("https://example.com/repository.git"));
        assert!(!is_local_remote_url("git@example.com:team/repository.git"));
    }

    #[test]
    fn remote_results_replace_host_paths_and_local_remote_urls() {
        let root = tempfile::TempDir::new().unwrap();
        let target = RemoteGitTarget {
            workspace: crate::files::RemoteGitWorkspace {
                workspace_id: "workspace-redact".into(),
                display_name: "Redacted".into(),
                path: root.path().to_string_lossy().to_string(),
            },
            relative_path: String::new(),
            resolved_path: root.path().to_path_buf(),
        };
        let result = sanitize_remote_result(
            "git_remotes",
            json!([{
                "name": "local",
                "fetchUrl": format!("file://{}", root.path().display()),
                "pushUrl": root.path().join("bare.git").to_string_lossy(),
            }]),
            &target,
        );
        let encoded = serde_json::to_string(&result).unwrap();
        assert!(!encoded.contains(&root.path().to_string_lossy().to_string()));
        assert!(encoded.contains("local://redacted"));
    }
}
