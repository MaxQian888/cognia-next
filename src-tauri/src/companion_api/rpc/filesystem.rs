use super::*;

pub(super) const COMMANDS: &[&str] = &[
    "read_text_file",
    "write_text_file",
    "write_text_file_confined",
    "ensure_dir",
    "ensure_dir_confined",
    "default_export_dir",
    "fs_search_workspace",
    "fs_search_content_workspace",
    "fs_read_workspace_file",
    "fs_write_workspace_file",
    "project_environment_execute",
    "task_workspace_status",
    "task_workspace_begin",
    "task_workspace_settle",
    "task_workspace_get",
    "task_workspace_list",
    "task_workspace_list_runs",
    "task_workspace_list_resources",
    "task_workspace_list_resource_events",
    "task_workspace_get_resource_summary",
    "task_workspace_record_tool_event",
    "task_workspace_export_resource_manifest",
    "task_workspace_get_resource",
    "task_workspace_get_patch_set",
    "task_resource_read_diff",
    "task_resource_read_text",
    "task_resource_download_open",
    "task_resource_download_read_chunk",
    "task_resource_download_close",
    "task_resource_upload_open",
    "task_resource_upload_write_chunk",
    "task_resource_upload_commit",
    "task_resource_upload_abort",
    "task_workspace_apply",
    "task_workspace_undo",
    "task_workspace_pin",
    "task_workspace_resolve_conflict",
    "task_workspace_prune",
    "fs_list_workspace_dir",
    "fs_stat_workspace_file",
    "fs_create_workspace_dir",
    "fs_delete_workspace_entry",
    "fs_rename_workspace_entry",
    "fs_copy_workspace_entry",
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
        // ── Filesystem ───────────────────────────────────────────────────────
        // Raw absolute-path ops have NO sandbox (desktop relied on a file-dialog
        // gesture for scope; remote exposure removes it). Both the writes AND
        // this read are therefore CONTROL-gated (see `CONTROL_COMMANDS`). The
        // `fs_*_workspace` variants enforce a root-relative path-traversal check
        // and remain the recommended, ungated client path for workspace files.
        "read_text_file" => {
            let path: String = required(&args, "path")?;
            tokio::task::spawn_blocking(move || {
                crate::files::read_text_file_impl(path, crate::files::FsOrigin::Remote)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(Value::String)
            .map_err(RpcError::internal)
        }
        "write_text_file" => {
            let path: String = required(&args, "path")?;
            let content: String = required(&args, "content")?;
            tokio::task::spawn_blocking(move || {
                crate::files::write_text_file_impl(path, content, crate::files::FsOrigin::Remote)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "write_text_file_confined" => {
            let path: String = required(&args, "path")?;
            let content: String = required(&args, "content")?;
            let allowed_roots: Vec<String> = required(&args, "allowedRoots")?;
            tokio::task::spawn_blocking(move || {
                crate::files::write_text_file_confined(path, content, allowed_roots)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "ensure_dir" => {
            let path: String = required(&args, "path")?;
            tokio::task::spawn_blocking(move || {
                crate::files::ensure_dir_impl(path, crate::files::FsOrigin::Remote)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "ensure_dir_confined" => {
            let path: String = required(&args, "path")?;
            let allowed_roots: Vec<String> = required(&args, "allowedRoots")?;
            tokio::task::spawn_blocking(move || {
                crate::files::ensure_dir_confined(path, allowed_roots)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "default_export_dir" => tokio::task::spawn_blocking(crate::files::default_export_dir)
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(Value::String)
            .map_err(RpcError::internal),
        "fs_search_workspace" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let query: String = optional(&args, "query")?.unwrap_or_default();
            let limit: Option<usize> = optional(&args, "limit")?;
            tokio::task::spawn_blocking(move || {
                crate::files::fs_search_workspace(root, query, limit)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "fs_search_content_workspace" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let query: String = optional(&args, "query")?.unwrap_or_default();
            let is_regex: Option<bool> = optional(&args, "isRegex")?;
            let case_sensitive: Option<bool> = optional(&args, "caseSensitive")?;
            let max_results: Option<usize> = optional(&args, "maxResults")?;
            tokio::task::spawn_blocking(move || {
                crate::files::fs_search_content_workspace(
                    root,
                    query,
                    is_regex,
                    case_sensitive,
                    max_results,
                )
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "fs_read_workspace_file" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let rel_path: String = required(&args, "relPath")?;
            let max_bytes: Option<usize> = optional(&args, "maxBytes")?;
            tokio::task::spawn_blocking(move || {
                crate::files::fs_read_workspace_file(root, rel_path, max_bytes)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(Value::String)
            .map_err(RpcError::internal)
        }
        "fs_write_workspace_file" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let rel_path: String = required(&args, "relPath")?;
            let content: String = required(&args, "content")?;
            tokio::task::spawn_blocking(move || {
                crate::files::fs_write_workspace_file(root, rel_path, content)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "project_environment_execute" => {
            let script: crate::project_environment::EnvironmentScript = required(&args, "script")?;
            let cwd = authorize_workspace_root(host, required(&args, "cwd")?)?;
            let variables: std::collections::BTreeMap<String, String> =
                optional(&args, "variables")?.unwrap_or_default();
            let keyring_references: Vec<crate::project_environment::EnvironmentKeyringReference> =
                optional(&args, "keyringReferences")?.unwrap_or_default();
            let policy: Option<crate::project_environment::EnvironmentPolicy> =
                optional(&args, "policy")?;
            let timeout_secs: Option<u64> = optional(&args, "timeoutSecs")?;
            crate::project_environment::project_environment_execute_cloud(
                script,
                cwd,
                variables,
                keyring_references,
                policy,
                timeout_secs,
            )
            .await
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_status" => to_json(crate::task_workspace::task_workspace_status()),
        "task_workspace_begin" => {
            let input: cognia_task_workspace::BeginTaskRun = required(&args, "input")?;
            let sink: std::sync::Arc<dyn cognia_task_workspace::TaskWorkspaceEventSink> =
                std::sync::Arc::new(crate::task_workspace::BusResourceEventSink(
                    std::sync::Arc::clone(&state.event_bus),
                ));
            tokio::task::spawn_blocking(move || {
                crate::task_workspace::begin_hosted_turn(
                    input.session_id.clone(),
                    crate::task_workspace::TaskWorkspaceTurnEnvelope {
                        task_id: input.task_id,
                        run_id: input.run_id,
                        parent_run_id: input.parent_run_id,
                        workspace_root: input.workspace_root,
                        base: input.base,
                        agent_id: input.agent_id,
                        agent_kind: input.agent_kind,
                        workspace_key: input.workspace_key,
                        execution_run_id: input.execution_run_id,
                        trace_id: input.trace_id,
                        turn_id: input.turn_id,
                        attempt_id: input.attempt_id,
                        provider_attempt_id: input.provider_attempt_id,
                        surface: input.surface,
                        tracking_policy: input.tracking_policy,
                    },
                    sink,
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_settle" => {
            let run_id: String = required(&args, "runId")?;
            let final_state: Option<cognia_task_workspace::RunState> =
                optional(&args, "finalState")?;
            let settle_run_id = run_id.clone();
            let resources = tokio::task::spawn_blocking(move || {
                let service = crate::task_workspace::service()?;
                match final_state.unwrap_or(cognia_task_workspace::RunState::Ready) {
                    cognia_task_workspace::RunState::Ready => service.settle_run(&settle_run_id),
                    cognia_task_workspace::RunState::Failed => {
                        service.settle_failed_run(&settle_run_id)
                    }
                    cognia_task_workspace::RunState::Cancelled => {
                        service.settle_cancelled_run(&settle_run_id)
                    }
                    state => Err(format!("invalid settle state: {state:?}")),
                }
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            to_json(resources)
        }
        "task_workspace_get" => {
            let task_id: String = required(&args, "taskId")?;
            crate::task_workspace::service()
                .and_then(|service| service.get_task(&task_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_list" => {
            let session_id: Option<String> = optional(&args, "sessionId")?;
            crate::task_workspace::service()
                .and_then(|service| service.list_tasks(session_id.as_deref()))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_list_runs" => {
            let task_id: String = required(&args, "taskId")?;
            crate::task_workspace::service()
                .and_then(|service| service.list_runs(&task_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_list_resources" => {
            let task_id: String = required(&args, "taskId")?;
            crate::task_workspace::service()
                .and_then(|service| service.list_resources(&task_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_list_resource_events" => {
            let run_id: String = required(&args, "runId")?;
            let cursor: Option<u64> = optional(&args, "cursor")?;
            let limit: Option<u32> = optional(&args, "limit")?;
            crate::task_workspace::service()
                .and_then(|service| {
                    service.list_resource_events(&run_id, cursor, limit.unwrap_or(200))
                })
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_get_resource_summary" => {
            let run_id: String = required(&args, "runId")?;
            crate::task_workspace::service()
                .and_then(|service| service.get_resource_summary(&run_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_record_tool_event" => {
            let run_id: String = required(&args, "runId")?;
            let path: String = required(&args, "path")?;
            let old_path: Option<String> = optional(&args, "oldPath")?;
            let kind: cognia_task_workspace::ResourceEventKind = required(&args, "kind")?;
            let tool_call_id: Option<String> = optional(&args, "toolCallId")?;
            crate::task_workspace::service()
                .and_then(|service| {
                    service.record_tool_event(
                        &run_id,
                        &path,
                        old_path.as_deref(),
                        kind,
                        tool_call_id.as_deref(),
                    )
                })
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_export_resource_manifest" => {
            let task_id: String = required(&args, "taskId")?;
            let run_id: Option<String> = optional(&args, "runId")?;
            crate::task_workspace::service()
                .and_then(|service| service.export_resource_manifest(&task_id, run_id.as_deref()))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_get_resource" => {
            let task_id: String = required(&args, "taskId")?;
            let path: String = required(&args, "path")?;
            crate::task_workspace::service()
                .and_then(|service| service.list_resources(&task_id))
                .map(|resources| {
                    resources
                        .into_iter()
                        .filter(|resource| resource.path == path)
                        .max_by_key(|resource| resource.revision)
                })
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_get_patch_set" => {
            let run_id: String = required(&args, "runId")?;
            crate::task_workspace::service()
                .and_then(|service| service.get_patch_set(&run_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_resource_read_diff" => {
            let run_id: String = required(&args, "runId")?;
            let path: String = required(&args, "path")?;
            let requested_sensitive: Option<bool> = optional(&args, "allowSensitive")?;
            let allow_sensitive = authorize_sensitive_resource(
                requested_sensitive.unwrap_or(false),
                device_id,
                scope,
            )?;
            crate::task_workspace::service()
                .and_then(|service| service.read_patch_diff(&run_id, &path, allow_sensitive))
                .map(Value::String)
                .map_err(RpcError::internal)
        }
        "task_resource_read_text" => {
            let run_id: String = required(&args, "runId")?;
            let rel_path: String = required(&args, "relPath")?;
            let offset: Option<u64> = optional(&args, "offset")?;
            let max_bytes: Option<usize> = optional(&args, "maxBytes")?;
            let requested_sensitive: Option<bool> = optional(&args, "allowSensitive")?;
            let allow_sensitive = authorize_sensitive_resource(
                requested_sensitive.unwrap_or(false),
                device_id,
                scope,
            )?;
            tokio::task::spawn_blocking(move || {
                crate::task_workspace::service()?.read_resource(
                    &run_id,
                    &rel_path,
                    offset.unwrap_or(0),
                    max_bytes,
                    allow_sensitive,
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_resource_download_open" => {
            let run_id: String = required(&args, "runId")?;
            let rel_path: String = required(&args, "relPath")?;
            let requested_sensitive: Option<bool> = optional(&args, "allowSensitive")?;
            let allow_sensitive = authorize_sensitive_resource(
                requested_sensitive.unwrap_or(false),
                device_id,
                scope,
            )?;
            tokio::task::spawn_blocking(move || {
                crate::task_workspace::service()?.open_resource_download(
                    &run_id,
                    &rel_path,
                    allow_sensitive,
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_resource_download_read_chunk" => {
            let handle_id: String = required(&args, "handleId")?;
            let offset: u64 = required(&args, "offset")?;
            let length: Option<usize> = optional(&args, "length")?;
            crate::task_workspace::service()
                .and_then(|service| service.read_download_chunk(&handle_id, offset, length))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_resource_download_close" => {
            let handle_id: String = required(&args, "handleId")?;
            crate::task_workspace::service()
                .and_then(|service| service.close_resource_download(&handle_id))
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }
        "task_resource_upload_open" => {
            let run_id: String = required(&args, "runId")?;
            let rel_path: String = required(&args, "relPath")?;
            let expected_size: u64 = required(&args, "expectedSize")?;
            let expected_hash: String = required(&args, "expectedHash")?;
            let allow_sensitive: Option<bool> = optional(&args, "allowSensitive")?;
            crate::task_workspace::service()
                .and_then(|service| {
                    service.open_resource_upload(
                        &run_id,
                        &rel_path,
                        expected_size,
                        &expected_hash,
                        allow_sensitive.unwrap_or(false),
                    )
                })
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_resource_upload_write_chunk" => {
            let handle_id: String = required(&args, "handleId")?;
            let offset: u64 = required(&args, "offset")?;
            let data_base64: String = required(&args, "dataBase64")?;
            let chunk_hash: String = required(&args, "chunkHash")?;
            crate::task_workspace::service()
                .and_then(|service| {
                    service.write_upload_chunk(&handle_id, offset, &data_base64, &chunk_hash)
                })
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_resource_upload_commit" => {
            let handle_id: String = required(&args, "handleId")?;
            crate::task_workspace::service()
                .and_then(|service| service.commit_resource_upload(&handle_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_resource_upload_abort" => {
            let handle_id: String = required(&args, "handleId")?;
            crate::task_workspace::service()
                .and_then(|service| service.abort_resource_upload(&handle_id))
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }
        "task_workspace_apply" => {
            let run_id: String = required(&args, "runId")?;
            let selection: Option<Vec<cognia_task_workspace::PatchSelection>> =
                optional(&args, "selection")?;
            let allow_irreversible: Option<bool> = optional(&args, "allowIrreversible")?;
            tokio::task::spawn_blocking(move || {
                crate::task_workspace::service()?.apply_patch_set_with_options(
                    &run_id,
                    &selection.unwrap_or_default(),
                    allow_irreversible.unwrap_or(false),
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_undo" => {
            let run_id: String = required(&args, "runId")?;
            tokio::task::spawn_blocking(move || {
                crate::task_workspace::service()?.undo_patch_set(&run_id)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_pin" => {
            let task_id: String = required(&args, "taskId")?;
            let pinned: bool = required(&args, "pinned")?;
            crate::task_workspace::service()
                .and_then(|service| service.set_task_pinned(&task_id, pinned))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_resolve_conflict" => {
            let run_id: String = required(&args, "runId")?;
            let selection: Option<Vec<cognia_task_workspace::PatchSelection>> =
                optional(&args, "selection")?;
            let resolution: cognia_task_workspace::ConflictResolution =
                required(&args, "resolution")?;
            let allow_irreversible: Option<bool> = optional(&args, "allowIrreversible")?;
            tokio::task::spawn_blocking(move || {
                crate::task_workspace::service()?.resolve_conflict_with_options(
                    &run_id,
                    &selection.unwrap_or_default(),
                    resolution,
                    allow_irreversible.unwrap_or(false),
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_prune" => {
            tokio::task::spawn_blocking(move || crate::task_workspace::service()?.prune())
                .await
                .map_err(|error| RpcError::internal(error.to_string()))?
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        // File-tree browser: list children / stat one path (reads), and
        // mkdir / delete / rename / copy (CONTROL-gated writes). All use the
        // `root` + `relPath` sandbox shape of the read/write variants above.
        "fs_list_workspace_dir" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let rel_path: Option<String> = optional(&args, "relPath")?;
            let include_ignored: Option<bool> = optional(&args, "includeIgnored")?;
            tokio::task::spawn_blocking(move || {
                crate::files::fs_list_workspace_dir(root, rel_path, include_ignored)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "fs_stat_workspace_file" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let rel_path: String = required(&args, "relPath")?;
            tokio::task::spawn_blocking(move || {
                crate::files::fs_stat_workspace_file(root, rel_path)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "fs_create_workspace_dir" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let rel_path: String = required(&args, "relPath")?;
            tokio::task::spawn_blocking(move || {
                crate::files::fs_create_workspace_dir(root, rel_path)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "fs_delete_workspace_entry" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let rel_path: String = required(&args, "relPath")?;
            let recursive: Option<bool> = optional(&args, "recursive")?;
            tokio::task::spawn_blocking(move || {
                crate::files::fs_delete_workspace_entry(root, rel_path, recursive)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "fs_rename_workspace_entry" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let from_rel_path: String = required(&args, "fromRelPath")?;
            let to_rel_path: String = required(&args, "toRelPath")?;
            tokio::task::spawn_blocking(move || {
                crate::files::fs_rename_workspace_entry(root, from_rel_path, to_rel_path)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "fs_copy_workspace_entry" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let from_rel_path: String = required(&args, "fromRelPath")?;
            let to_rel_path: String = required(&args, "toRelPath")?;
            let recursive: Option<bool> = optional(&args, "recursive")?;
            tokio::task::spawn_blocking(move || {
                crate::files::fs_copy_workspace_entry(root, from_rel_path, to_rel_path, recursive)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
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
