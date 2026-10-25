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
    "fs_read_workspace_file_versioned",
    "fs_read_workspace_file_base64",
    "fs_read_workspace_file_chunk",
    "fs_write_workspace_file",
    "project_environment_execute",
    "task_workspace_status",
    "task_workspace_begin",
    "task_workspace_bundle_begin",
    "task_workspace_bundle_turn_begin",
    "task_workspace_bundle_turn_settle",
    "task_workspace_bundle_turn_abort",
    "task_workspace_bundle_turn_get",
    "task_workspace_managed_get",
    "task_workspace_managed_list",
    "task_workspace_environment_list",
    "task_workspace_bundle_get",
    "task_workspace_bundle_list",
    "task_workspace_bundle_acquire",
    "task_workspace_bundle_apply",
    "task_workspace_bundle_handoff_retry",
    "task_workspace_bundle_handoff_get",
    "task_workspace_bundle_handoff_undo",
    "task_workspace_bundle_handoff_undo_get",
    "task_workspace_reconcile",
    "task_workspace_policy_get",
    "task_workspace_policy_set",
    "task_workspace_port_lease_get",
    "task_workspace_port_lease_ensure",
    "task_workspace_port_lease_resolve",
    "task_workspace_port_lease_resolve_ensure",
    "task_workspace_port_lease_subject_ensure",
    "task_workspace_port_lease_subject_get",
    "task_workspace_port_lease_subject_release",
    "task_workspace_port_lease_release",
    "task_workspace_port_lease_list",
    "task_workspace_maintenance_run",
    "task_workspace_maintenance_events",
    "task_workspace_managed_pin",
    "task_workspace_managed_permanent",
    "task_workspace_managed_archive",
    "task_workspace_managed_adopt",
    "task_workspace_environment_adopt",
    "task_workspace_environment_create_branch",
    "task_workspace_environment_delete_branch",
    "task_workspace_changeset_get",
    "task_workspace_changeset_list",
    "task_workspace_changeset_eligibility",
    "task_workspace_integration_analyze",
    "task_workspace_integration_get",
    "task_workspace_integration_list",
    "task_workspace_canonical_root",
    "best_of_n_start",
    "best_of_n_get",
    "best_of_n_list",
    "best_of_n_cancel",
    "best_of_n_select",
    "best_of_n_archive",
    "best_of_n_candidate_progress",
    "best_of_n_recover",
    "task_workspace_changeset_capture",
    "task_workspace_changeset_mark_ready",
    "task_workspace_changeset_record_review",
    "task_workspace_changeset_record_check",
    "task_workspace_changeset_approve",
    "task_workspace_changeset_abandon",
    "task_workspace_integration_prepare",
    "task_workspace_integration_record_check",
    "task_workspace_integration_publish",
    "task_workspace_integration_rebuild",
    "task_workspace_integration_drop_item",
    "task_workspace_integration_abort",
    "task_workspace_integration_rollback",
    "task_workspace_managed_restore",
    "task_workspace_managed_delete",
    "task_workspace_settle",
    "task_workspace_get",
    "task_workspace_list",
    "task_workspace_list_runs",
    "task_workspace_list_resources",
    "task_workspace_list_resource_events",
    "task_workspace_list_resource_index",
    "task_workspace_read_resource_capture",
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
    // A working copy handed to this always-on host (ADR-0224 A11b).
    "code_snapshot_limits_get",
    "code_snapshot_upload_open",
    "code_snapshot_upload_write_chunk",
    "code_snapshot_upload_commit",
    "code_snapshot_upload_cancel",
    "code_snapshot_apply",
    "code_checkout_export",
    "code_result_read_chunk",
    "code_result_discard",
    "task_workspace_apply",
    "task_workspace_undo",
    "task_workspace_restore_snapshot",
    "task_workspace_pin",
    "task_workspace_resolve_conflict",
    "task_workspace_prune",
    "fs_workspace_roots",
    "fs_list_workspace_dir",
    "fs_stat_workspace_file",
    "fs_create_workspace_dir",
    "fs_delete_workspace_entry",
    "fs_rename_workspace_entry",
    "fs_copy_workspace_entry",
];

// Bound disk work across all paired peers. A permit moves into the blocking
// closure, so disconnecting a caller cannot free capacity while its I/O runs.
static TRANSFER_IO_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);

/// Keep conflicts distinct; the stable message prefix carries their hash in
/// the existing three-field RPC error envelope.
fn workspace_write_error(error: cognia_files::files::WorkspaceWriteError) -> (StatusCode, Json<RpcError>) {
    match error {
        cognia_files::files::WorkspaceWriteError::Conflict { .. } => (
            StatusCode::CONFLICT,
            Json(RpcError::new("workspace_file_conflict", error.to_string())),
        ),
        cognia_files::files::WorkspaceWriteError::InvalidPrecondition { message } => {
            RpcError::validation_failed(message)
        }
        cognia_files::files::WorkspaceWriteError::Other { message } => RpcError::internal(message),
    }
}

/// HTTP status for the changeset / integration rejections the shared
/// problem table does not know: a state race is a conflict, an unmet gate is
/// unprocessable, a malformed reference is a bad request.
fn scm_status(code: &str) -> Option<StatusCode> {
    Some(match code {
        "busy"
        | "stale_head"
        | "stale_candidate"
        | "target_moved"
        | "illegal_transition"
        | "changeset_state"
        | "invalid_state"
        | "dependency"
        | "rollback_conflict"
        | "target_checked_out_dirty"
        | "overlay_conflict" => StatusCode::CONFLICT,
        "checks"
        | "ineligible"
        | "attempts_exhausted"
        | "cycles"
        | "nothing_to_capture"
        | "sensitive_history"
        | "overlay_unsupported" => StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_input" | "invalid_target" | "invalid_workspace" | "target_required" => {
            StatusCode::BAD_REQUEST
        }
        _ => return None,
    })
}

fn scm_command_error(
    error: cognia_core::command_error::CommandError,
) -> (StatusCode, Json<RpcError>) {
    let problem: cognia_problem::Problem = error.into();
    (
        scm_status(&problem.code).unwrap_or_else(|| problem.status_code()),
        Json(RpcError {
            code: problem.code,
            message: problem.detail,
            retryable: problem.retryable,
            details: None,
        }),
    )
}

async fn run_transfer_io<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, (StatusCode, Json<RpcError>)> {
    let permit = TRANSFER_IO_SLOTS
        .acquire()
        .await
        .map_err(|error| RpcError::internal(error.to_string()))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        operation()
    })
    .await
    .map_err(|error| RpcError::internal(error.to_string()))?
    .map_err(RpcError::internal)
}

pub(super) async fn dispatch(
    name: &str,
    args: Value,
    state: &SharedState,
    host: &dyn crate::rpc_host::RpcHost,
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
                cognia_files::files::read_text_file_impl(path, cognia_files::files::FsOrigin::Remote)
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
                cognia_files::files::write_text_file_impl(path, content, cognia_files::files::FsOrigin::Remote)
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
                cognia_files::files::write_text_file_confined(path, content, allowed_roots)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "ensure_dir" => {
            let path: String = required(&args, "path")?;
            tokio::task::spawn_blocking(move || {
                cognia_files::files::ensure_dir_impl(path, cognia_files::files::FsOrigin::Remote)
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
                cognia_files::files::ensure_dir_confined(path, allowed_roots)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "default_export_dir" => tokio::task::spawn_blocking(cognia_files::files::default_export_dir)
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(Value::String)
            .map_err(RpcError::internal),
        "fs_search_workspace" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let query: String = optional(&args, "query")?.unwrap_or_default();
            let limit: Option<usize> = optional(&args, "limit")?;
            tokio::task::spawn_blocking(move || {
                cognia_files::files::fs_search_workspace(root, query, limit)
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
            // A chat-only device's matches never come from a sensitive file.
            let allow_sensitive = sensitive_reads_allowed(device_id, scope);
            tokio::task::spawn_blocking(move || {
                cognia_files::files::search_workspace_content(
                    root,
                    query,
                    is_regex,
                    case_sensitive,
                    max_results,
                    allow_sensitive,
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
            let allow_sensitive = authorize_workspace_read(&root, &rel_path, device_id, scope)?;
            tokio::task::spawn_blocking(move || {
                cognia_files::files::read_workspace_file(root, rel_path, max_bytes, allow_sensitive)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(Value::String)
            .map_err(RpcError::internal)
        }
        "fs_read_workspace_file_versioned" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let rel_path: String = required(&args, "relPath")?;
            let max_bytes: Option<usize> = optional(&args, "maxBytes")?;
            let allow_sensitive = authorize_workspace_read(&root, &rel_path, device_id, scope)?;
            tokio::task::spawn_blocking(move || {
                cognia_files::files::read_workspace_file_versioned(root, rel_path, max_bytes, allow_sensitive)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "fs_read_workspace_file_base64" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let rel_path: String = required(&args, "relPath")?;
            let max_bytes: Option<usize> = optional(&args, "maxBytes")?;
            let allow_sensitive = authorize_workspace_read(&root, &rel_path, device_id, scope)?;
            tokio::task::spawn_blocking(move || {
                cognia_files::files::read_workspace_file_base64(root, rel_path, max_bytes, allow_sensitive)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(Value::String)
            .map_err(RpcError::internal)
        }
        "fs_read_workspace_file_chunk" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let rel_path: String = required(&args, "relPath")?;
            let offset: u64 = required(&args, "offset")?;
            let length: usize = required(&args, "length")?;
            let allow_sensitive = authorize_workspace_read(&root, &rel_path, device_id, scope)?;
            tokio::task::spawn_blocking(move || {
                cognia_files::files::read_workspace_file_chunk(
                    root,
                    rel_path,
                    offset,
                    length,
                    allow_sensitive,
                )
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "fs_write_workspace_file" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let rel_path: String = required(&args, "relPath")?;
            let content: String = required(&args, "content")?;
            let encoding: Option<String> = optional(&args, "encoding")?;
            let expected_sha256: Option<String> = optional(&args, "expectedSha256")?;
            let expect_absent: Option<bool> = optional(&args, "expectAbsent")?;
            tokio::task::spawn_blocking(move || {
                cognia_files::files::fs_write_workspace_file(
                    root, rel_path, content, encoding, expected_sha256, expect_absent,
                )
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map_err(workspace_write_error)
            .and_then(to_json)
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
        "task_workspace_status" => to_json(cognia_task_workspace_host::host_surface::task_workspace_status()),
        "task_workspace_begin" => {
            let input: cognia_task_workspace::BeginTaskRun = required(&args, "input")?;
            let sink: std::sync::Arc<dyn cognia_task_workspace::TaskWorkspaceEventSink> =
                std::sync::Arc::new(cognia_task_workspace_host::host_surface::BusResourceEventSink(
                    std::sync::Arc::clone(&state.event_bus),
                ));
            tokio::task::spawn_blocking(move || {
                cognia_task_workspace_host::host_surface::begin_hosted_turn(
                    input.session_id.clone(),
                    cognia_task_workspace_host::host_surface::TaskWorkspaceTurnEnvelope {
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
        "task_workspace_bundle_begin" => {
            let bundle_id: String = required(&args, "bundleId")?;
            let logical_root_id: String = required(&args, "logicalRootId")?;
            let input: cognia_task_workspace::BeginTaskRun = required(&args, "input")?;
            let sink: std::sync::Arc<dyn cognia_task_workspace::TaskWorkspaceEventSink> =
                std::sync::Arc::new(cognia_task_workspace_host::host_surface::BusResourceEventSink(
                    std::sync::Arc::clone(&state.event_bus),
                ));
            tokio::task::spawn_blocking(move || {
                cognia_task_workspace_host::host_surface::begin_hosted_bundle_turn(
                    bundle_id,
                    logical_root_id,
                    input,
                    sink,
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_bundle_turn_begin" => {
            let bundle_id: String = required(&args, "bundleId")?;
            let request: cognia_task_workspace::BeginWorkspaceBundleTurn =
                required(&args, "request")?;
            let sink: std::sync::Arc<dyn cognia_task_workspace::TaskWorkspaceEventSink> =
                std::sync::Arc::new(cognia_task_workspace_host::host_surface::BusResourceEventSink(
                    std::sync::Arc::clone(&state.event_bus),
                ));
            tokio::task::spawn_blocking(move || {
                cognia_task_workspace_host::host_surface::begin_hosted_workspace_bundle_turn(bundle_id, request, sink)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_bundle_turn_settle" => {
            let bundle_turn_id: String = required(&args, "bundleTurnId")?;
            let final_state: Option<cognia_task_workspace::RunState> =
                optional(&args, "finalState")?;
            tokio::task::spawn_blocking(move || {
                cognia_task_workspace_host::host_surface::service()?.settle_workspace_bundle_turn(
                    &bundle_turn_id,
                    final_state.unwrap_or(cognia_task_workspace::RunState::Ready),
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_bundle_turn_abort" => {
            let bundle_turn_id: String = required(&args, "bundleTurnId")?;
            tokio::task::spawn_blocking(move || {
                cognia_task_workspace_host::host_surface::service()?.abort_workspace_bundle_turn(&bundle_turn_id)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_bundle_turn_get" => {
            let bundle_turn_id: String = required(&args, "bundleTurnId")?;
            cognia_task_workspace_host::host_surface::service()
                .and_then(|service| service.get_workspace_bundle_turn(&bundle_turn_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_managed_get" => {
            let workspace_id: String = required(&args, "workspaceId")?;
            cognia_task_workspace_host::host_surface::service()
                .and_then(|service| service.get_managed_workspace(&workspace_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_managed_list" => cognia_task_workspace_host::host_surface::service()
            .and_then(|service| service.list_managed_workspaces())
            .map_err(RpcError::internal)
            .and_then(to_json),
        "task_workspace_environment_list" => {
            let root_dir: Option<String> = optional(&args, "rootDir")?;
            tokio::task::spawn_blocking(move || {
                cognia_task_workspace_host::host_surface::service().and_then(|service| {
                    service
                        .list_workspace_environments(root_dir.as_deref().map(std::path::Path::new))
                })
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_bundle_get" => {
            let bundle_id: String = required(&args, "bundleId")?;
            cognia_task_workspace_host::host_surface::service()
                .and_then(|service| service.get_workspace_bundle(&bundle_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_bundle_list" => cognia_task_workspace_host::host_surface::service()
            .and_then(|service| service.list_workspace_bundles())
            .map_err(RpcError::internal)
            .and_then(to_json),
        "task_workspace_bundle_acquire" => {
            let input: cognia_task_workspace::AcquireWorkspaceBundle = required(&args, "input")?;
            tokio::task::spawn_blocking(move || {
                cognia_task_workspace_host::host_surface::service()?.acquire_workspace_bundle(input)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_bundle_apply" => {
            let bundle_id: String = required(&args, "bundleId")?;
            let request: cognia_task_workspace::BundleHandoffRequest = required(&args, "request")?;
            tokio::task::spawn_blocking(move || {
                cognia_task_workspace_host::host_surface::service()?.apply_workspace_bundle(&bundle_id, request)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_bundle_handoff_retry" => {
            let bundle_id: String = required(&args, "bundleId")?;
            let request: cognia_task_workspace::BundleHandoffRequest = required(&args, "request")?;
            tokio::task::spawn_blocking(move || {
                cognia_task_workspace_host::host_surface::service()?
                    .retry_workspace_bundle_handoff(&bundle_id, request)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_bundle_handoff_get" => {
            let bundle_turn_id: String = required(&args, "bundleTurnId")?;
            cognia_task_workspace_host::host_surface::service()
                .and_then(|service| service.get_bundle_handoff_outcome(&bundle_turn_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_bundle_handoff_undo" => {
            let bundle_id: String = required(&args, "bundleId")?;
            let bundle_turn_id: String = required(&args, "bundleTurnId")?;
            tokio::task::spawn_blocking(move || {
                cognia_task_workspace_host::host_surface::service()?
                    .undo_workspace_bundle_handoff(&bundle_id, &bundle_turn_id)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_bundle_handoff_undo_get" => {
            let bundle_turn_id: String = required(&args, "bundleTurnId")?;
            cognia_task_workspace_host::host_surface::service()
                .and_then(|service| service.get_bundle_handoff_undo_outcome(&bundle_turn_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_reconcile" => tokio::task::spawn_blocking(move || {
            cognia_task_workspace_host::host_surface::service()?.reconcile_known_worktrees()
        })
        .await
        .map_err(|error| RpcError::internal(error.to_string()))?
        .map_err(RpcError::internal)
        .and_then(to_json),
        "task_workspace_policy_get" => cognia_task_workspace_host::host_surface::service()
            .map(|service| service.workspace_lifecycle_policy())
            .map_err(RpcError::internal)
            .and_then(to_json),
        "task_workspace_policy_set" => {
            let policy: cognia_task_workspace::WorkspaceLifecyclePolicy =
                required(&args, "policy")?;
            cognia_task_workspace_host::host_surface::service()
                .and_then(|service| service.set_workspace_lifecycle_policy(policy))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_port_lease_get" => {
            let workspace_id: String = required(&args, "workspaceId")?;
            let namespace: Option<String> = optional(&args, "namespace")?;
            cognia_task_workspace_host::host_surface::task_workspace_port_lease_get(workspace_id, namespace)
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_port_lease_ensure" => {
            let workspace_id: String = required(&args, "workspaceId")?;
            let namespace: Option<String> = optional(&args, "namespace")?;
            cognia_task_workspace_host::host_surface::task_workspace_port_lease_ensure(workspace_id, namespace)
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_port_lease_resolve" => {
            let cwd: String = required(&args, "cwd")?;
            let workspace_id: Option<String> = optional(&args, "workspaceId")?;
            let namespace: Option<String> = optional(&args, "namespace")?;
            cognia_task_workspace_host::host_surface::task_workspace_port_lease_resolve(cwd, workspace_id, namespace)
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_port_lease_resolve_ensure" => {
            let cwd: String = required(&args, "cwd")?;
            let workspace_id: Option<String> = optional(&args, "workspaceId")?;
            let namespace: Option<String> = optional(&args, "namespace")?;
            cognia_task_workspace_host::host_surface::task_workspace_port_lease_resolve_ensure(cwd, workspace_id, namespace)
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_port_lease_subject_ensure" => {
            let kind: cognia_task_workspace::ExternalPortSubjectKind = required(&args, "kind")?;
            let key: String = required(&args, "key")?;
            let root: String = required(&args, "root")?;
            let namespace: Option<String> = optional(&args, "namespace")?;
            cognia_task_workspace_host::host_surface::task_workspace_port_lease_subject_ensure(kind, key, root, namespace)
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_port_lease_subject_get" => {
            let kind: cognia_task_workspace::ExternalPortSubjectKind = required(&args, "kind")?;
            let key: String = required(&args, "key")?;
            let namespace: Option<String> = optional(&args, "namespace")?;
            cognia_task_workspace_host::host_surface::task_workspace_port_lease_subject_get(kind, key, namespace)
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_port_lease_subject_release" => {
            let kind: cognia_task_workspace::ExternalPortSubjectKind = required(&args, "kind")?;
            let key: String = required(&args, "key")?;
            let namespace: Option<String> = optional(&args, "namespace")?;
            let lease_id: Option<String> = optional(&args, "leaseId")?;
            cognia_task_workspace_host::host_surface::task_workspace_port_lease_subject_release(
                kind, key, namespace, lease_id,
            )
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_port_lease_release" => {
            let workspace_id: String = required(&args, "workspaceId")?;
            let namespace: Option<String> = optional(&args, "namespace")?;
            cognia_task_workspace_host::host_surface::task_workspace_port_lease_release(workspace_id, namespace)
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_port_lease_list" => {
            cognia_task_workspace_host::host_surface::task_workspace_port_lease_list()
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_maintenance_run" => {
            let request: Option<cognia_task_workspace::WorkspaceMaintenanceRequest> =
                optional(&args, "request")?;
            cognia_task_workspace_host::host_surface::task_workspace_maintenance_run(request)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_maintenance_events" => {
            let page = page_request(&args)?;
            cognia_task_workspace_host::host_surface::service()
                .and_then(|service| cognia_task_workspace_host::host_surface::maintenance_events_page(&service, &page))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_managed_pin" => {
            let workspace_id: String = required(&args, "workspaceId")?;
            let pinned: bool = required(&args, "pinned")?;
            cognia_task_workspace_host::host_surface::service()
                .and_then(|service| service.set_managed_workspace_pinned(&workspace_id, pinned))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_managed_permanent" => {
            let workspace_id: String = required(&args, "workspaceId")?;
            cognia_task_workspace_host::host_surface::service()
                .and_then(|service| service.make_workspace_permanent(&workspace_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_managed_archive" => {
            let workspace_id: String = required(&args, "workspaceId")?;
            tokio::task::spawn_blocking(move || {
                cognia_task_workspace_host::host_surface::service()?.archive_managed_workspace(&workspace_id)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_managed_adopt" => {
            let workspace_id: String = required(&args, "workspaceId")?;
            tokio::task::spawn_blocking(move || {
                cognia_task_workspace_host::host_surface::service()?.adopt_imported_workspace(&workspace_id)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_environment_adopt" => {
            let environment_id: String = required(&args, "environmentId")?;
            let source_root: String = required(&args, "sourceRoot")?;
            let path: String = required(&args, "path")?;
            tokio::task::spawn_blocking(move || {
                cognia_task_workspace_host::host_surface::service()?.adopt_workspace_environment(
                    &environment_id,
                    std::path::Path::new(&source_root),
                    std::path::Path::new(&path),
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_environment_create_branch" => {
            let workspace_id: String = required(&args, "workspaceId")?;
            let branch: String = required(&args, "branch")?;
            cognia_task_workspace_host::host_surface::task_workspace_environment_create_branch(workspace_id, branch)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_environment_delete_branch" => {
            let workspace_id: String = required(&args, "workspaceId")?;
            let branch: String = required(&args, "branch")?;
            cognia_task_workspace_host::host_surface::task_workspace_environment_delete_branch(workspace_id, branch)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_changeset_get" => {
            let changeset_id: String = required(&args, "changesetId")?;
            cognia_task_workspace_host::host_surface::task_workspace_changeset_get(changeset_id)
                .await
                .map_err(scm_command_error)
                .and_then(to_json)
        }
        "task_workspace_changeset_list" => {
            let filter: cognia_task_workspace::ChangesetFilter = required(&args, "filter")?;
            cognia_task_workspace_host::host_surface::task_workspace_changeset_list(filter)
                .await
                .map_err(scm_command_error)
                .and_then(to_json)
        }
        "task_workspace_changeset_eligibility" => {
            let changeset_id: String = required(&args, "changesetId")?;
            cognia_task_workspace_host::host_surface::task_workspace_changeset_eligibility(changeset_id)
                .await
                .map_err(scm_command_error)
                .and_then(to_json)
        }
        "task_workspace_integration_analyze" => {
            let changeset_ids: Vec<String> = required(&args, "changesetIds")?;
            let target_ref: Option<String> = optional(&args, "targetRef")?;
            cognia_task_workspace_host::host_surface::task_workspace_integration_analyze(changeset_ids, target_ref)
                .await
                .map_err(scm_command_error)
                .and_then(to_json)
        }
        "task_workspace_integration_get" => {
            let integration_id: String = required(&args, "integrationId")?;
            cognia_task_workspace_host::host_surface::task_workspace_integration_get(integration_id)
                .await
                .map_err(scm_command_error)
                .and_then(to_json)
        }
        "task_workspace_integration_list" => {
            let filter: cognia_task_workspace_host::host_surface::IntegrationRunFilter = required(&args, "filter")?;
            cognia_task_workspace_host::host_surface::task_workspace_integration_list(filter)
                .await
                .map_err(scm_command_error)
                .and_then(to_json)
        }
        "task_workspace_changeset_capture" => {
            let input: cognia_task_workspace::CaptureChangeset = required(&args, "input")?;
            cognia_task_workspace_host::host_surface::task_workspace_changeset_capture(input)
                .await
                .map_err(scm_command_error)
                .and_then(to_json)
        }
        "task_workspace_changeset_mark_ready" => {
            let changeset_id: String = required(&args, "changesetId")?;
            cognia_task_workspace_host::host_surface::task_workspace_changeset_mark_ready(changeset_id)
                .await
                .map_err(scm_command_error)
                .and_then(to_json)
        }
        "task_workspace_changeset_record_review" => {
            let changeset_id: String = required(&args, "changesetId")?;
            let review: cognia_task_workspace::ChangesetReview = required(&args, "review")?;
            cognia_task_workspace_host::host_surface::task_workspace_changeset_record_review(changeset_id, review)
                .await
                .map_err(scm_command_error)
                .and_then(to_json)
        }
        "task_workspace_changeset_record_check" => {
            let changeset_id: String = required(&args, "changesetId")?;
            let check: cognia_task_workspace::ChangesetCheck = required(&args, "check")?;
            cognia_task_workspace_host::host_surface::task_workspace_changeset_record_check(changeset_id, check)
                .await
                .map_err(scm_command_error)
                .and_then(to_json)
        }
        "task_workspace_changeset_approve" => {
            let changeset_id: String = required(&args, "changesetId")?;
            let head_sha: String = required(&args, "headSha")?;
            let approver: String = required(&args, "approver")?;
            cognia_task_workspace_host::host_surface::task_workspace_changeset_approve(
                changeset_id,
                head_sha,
                approver,
            )
            .await
            .map_err(scm_command_error)
            .and_then(to_json)
        }
        "task_workspace_changeset_abandon" => {
            let changeset_id: String = required(&args, "changesetId")?;
            cognia_task_workspace_host::host_surface::task_workspace_changeset_abandon(changeset_id)
                .await
                .map_err(scm_command_error)
                .and_then(to_json)
        }
        "task_workspace_canonical_root" => {
            let path = authorize_workspace_root(host, required(&args, "path")?)?;
            cognia_task_workspace_host::host_surface::task_workspace_canonical_root(path).await.map_err(RpcError::internal).and_then(to_json)
        }
        "best_of_n_start" => {
            let input: cognia_task_workspace::StartBestOfN = required(&args, "input")?;
            cognia_task_workspace_host::host_surface::best_of_n_start(input).await.map_err(RpcError::internal).and_then(to_json)
        }
        "best_of_n_cancel" => {
            let input: cognia_task_workspace::BestOfNMutation = required(&args, "input")?;
            cognia_task_workspace_host::host_surface::best_of_n_cancel(input).await.map_err(RpcError::internal).and_then(to_json)
        }
        "best_of_n_archive" => {
            let input: cognia_task_workspace::BestOfNMutation = required(&args, "input")?;
            cognia_task_workspace_host::host_surface::best_of_n_archive(input).await.map_err(RpcError::internal).and_then(to_json)
        }
        "best_of_n_candidate_progress" => {
            let input: cognia_task_workspace::BestOfNCandidateProgress = required(&args, "input")?;
            cognia_task_workspace_host::host_surface::best_of_n_candidate_progress(input).await.map_err(RpcError::internal).and_then(to_json)
        }
        "best_of_n_recover" => {
            let input: cognia_task_workspace::BestOfNMutation = required(&args, "input")?;
            cognia_task_workspace_host::host_surface::best_of_n_recover(input).await.map_err(RpcError::internal).and_then(to_json)
        }
        "best_of_n_get" => {
            let group_id: String = required(&args, "groupId")?;
            cognia_task_workspace_host::host_surface::best_of_n_get(group_id).await.map_err(RpcError::internal).and_then(to_json)
        }
        "best_of_n_list" => {
            cognia_task_workspace_host::host_surface::best_of_n_list().await.map_err(RpcError::internal).and_then(to_json)
        }
        // Authentication or automated approval cannot manufacture an interactive user.
        "best_of_n_select" => Err((StatusCode::FORBIDDEN, Json(RpcError::new(
            "best_of_n_interactive_user_required",
            cognia_task_workspace_host::host_surface::best_of_n_remote_selection_error(),
        )))),
        "task_workspace_integration_prepare" => {
            let input: cognia_task_workspace::PrepareIntegration = required(&args, "input")?;
            cognia_task_workspace_host::host_surface::task_workspace_integration_prepare(input)
                .await
                .map_err(scm_command_error)
                .and_then(to_json)
        }
        "task_workspace_integration_record_check" => {
            let integration_id: String = required(&args, "integrationId")?;
            let candidate_sha: String = required(&args, "candidateSha")?;
            let check: cognia_task_workspace::ChangesetCheck = required(&args, "check")?;
            cognia_task_workspace_host::host_surface::task_workspace_integration_record_check(
                integration_id,
                candidate_sha,
                check,
            )
            .await
            .map_err(scm_command_error)
            .and_then(to_json)
        }
        "task_workspace_integration_publish" => {
            let integration_id: String = required(&args, "integrationId")?;
            let candidate_sha: String = required(&args, "candidateSha")?;
            let required_checks: Vec<String> = required(&args, "requiredChecks")?;
            cognia_task_workspace_host::host_surface::task_workspace_integration_publish(
                integration_id,
                candidate_sha,
                required_checks,
            )
            .await
            .map_err(scm_command_error)
            .and_then(to_json)
        }
        "task_workspace_integration_rebuild" => {
            let integration_id: String = required(&args, "integrationId")?;
            cognia_task_workspace_host::host_surface::task_workspace_integration_rebuild(integration_id)
                .await
                .map_err(scm_command_error)
                .and_then(to_json)
        }
        "task_workspace_integration_drop_item" => {
            let integration_id: String = required(&args, "integrationId")?;
            let changeset_id: String = required(&args, "changesetId")?;
            cognia_task_workspace_host::host_surface::task_workspace_integration_drop_item(
                integration_id,
                changeset_id,
            )
            .await
            .map_err(scm_command_error)
            .and_then(to_json)
        }
        "task_workspace_integration_abort" => {
            let integration_id: String = required(&args, "integrationId")?;
            cognia_task_workspace_host::host_surface::task_workspace_integration_abort(integration_id)
                .await
                .map_err(scm_command_error)
                .and_then(to_json)
        }
        "task_workspace_integration_rollback" => {
            let integration_id: String = required(&args, "integrationId")?;
            cognia_task_workspace_host::host_surface::task_workspace_integration_rollback(integration_id)
                .await
                .map_err(scm_command_error)
                .and_then(to_json)
        }
        "task_workspace_managed_restore" => {
            let workspace_id: String = required(&args, "workspaceId")?;
            tokio::task::spawn_blocking(move || {
                cognia_task_workspace_host::host_surface::service()?.restore_managed_workspace(&workspace_id)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_managed_delete" => {
            let workspace_id: String = required(&args, "workspaceId")?;
            tokio::task::spawn_blocking(move || {
                cognia_task_workspace_host::host_surface::service()?.delete_managed_workspace(&workspace_id)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }
        "task_workspace_settle" => {
            let run_id: String = required(&args, "runId")?;
            let final_state: Option<cognia_task_workspace::RunState> =
                optional(&args, "finalState")?;
            let settle_run_id = run_id.clone();
            let resources = tokio::task::spawn_blocking(move || {
                let service = cognia_task_workspace_host::host_surface::service()?;
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
            cognia_task_workspace_host::host_surface::service()
                .and_then(|service| service.get_task(&task_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_list" => {
            let session_id: Option<String> = optional(&args, "sessionId")?;
            cognia_task_workspace_host::host_surface::service()
                .and_then(|service| service.list_tasks(session_id.as_deref()))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_list_runs" => {
            let task_id: String = required(&args, "taskId")?;
            cognia_task_workspace_host::host_surface::service()
                .and_then(|service| service.list_runs(&task_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_list_resources" => {
            let task_id: String = required(&args, "taskId")?;
            cognia_task_workspace_host::host_surface::service()
                .and_then(|service| service.list_resources(&task_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_list_resource_events" => {
            let run_id: String = required(&args, "runId")?;
            let page = page_request(&args)?;
            cognia_task_workspace_host::host_surface::service()
                .and_then(|service| {
                    cognia_task_workspace_host::host_surface::resource_events_page(&service, &run_id, &page)
                })
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_list_resource_index" => {
            let page = page_request(&args)?;
            // A scan of the whole ledger when it has changed: off the runtime.
            tokio::task::spawn_blocking(move || {
                cognia_task_workspace_host::host_surface::service()
                    .and_then(|service| cognia_task_workspace_host::host_surface::resource_index_page(&service, &page))
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_read_resource_capture" => {
            let run_id: String = required(&args, "runId")?;
            let path: String = required(&args, "path")?;
            let offset: u64 = required(&args, "offset")?;
            let length: u64 = required(&args, "length")?;
            tokio::task::spawn_blocking(move || {
                cognia_task_workspace_host::host_surface::service().and_then(|service| {
                    service.read_resource_capture(&run_id, &path, offset, length)
                })
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_get_resource_summary" => {
            let run_id: String = required(&args, "runId")?;
            cognia_task_workspace_host::host_surface::service()
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
            cognia_task_workspace_host::host_surface::service()
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
            cognia_task_workspace_host::host_surface::service()
                .and_then(|service| service.export_resource_manifest(&task_id, run_id.as_deref()))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_get_resource" => {
            let task_id: String = required(&args, "taskId")?;
            let path: String = required(&args, "path")?;
            cognia_task_workspace_host::host_surface::service()
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
            cognia_task_workspace_host::host_surface::service()
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
            cognia_task_workspace_host::host_surface::service()
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
                cognia_task_workspace_host::host_surface::service()?.read_resource(
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
            run_transfer_io(move || {
                cognia_task_workspace_host::host_surface::service()?.open_resource_download(
                    &run_id,
                    &rel_path,
                    allow_sensitive,
                )
            })
            .await
            .and_then(to_json)
        }
        "task_resource_download_read_chunk" => {
            let handle_id: String = required(&args, "handleId")?;
            let offset: u64 = required(&args, "offset")?;
            let length: Option<usize> = optional(&args, "length")?;
            run_transfer_io(move || {
                cognia_task_workspace_host::host_surface::service()?.read_download_chunk(&handle_id, offset, length)
            })
            .await
            .and_then(to_json)
        }
        "task_resource_download_close" => {
            let handle_id: String = required(&args, "handleId")?;
            cognia_task_workspace_host::host_surface::service()
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
            run_transfer_io(move || {
                cognia_task_workspace_host::host_surface::service()?.open_resource_upload(
                    &run_id,
                    &rel_path,
                    expected_size,
                    &expected_hash,
                    allow_sensitive.unwrap_or(false),
                )
            })
            .await
            .and_then(to_json)
        }
        "task_resource_upload_write_chunk" => {
            let handle_id: String = required(&args, "handleId")?;
            let offset: u64 = required(&args, "offset")?;
            let data_base64: String = required(&args, "dataBase64")?;
            let chunk_hash: String = required(&args, "chunkHash")?;
            run_transfer_io(move || {
                cognia_task_workspace_host::host_surface::service()?.write_upload_chunk(
                    &handle_id,
                    offset,
                    &data_base64,
                    &chunk_hash,
                )
            })
            .await
            .and_then(to_json)
        }
        "task_resource_upload_commit" => {
            let handle_id: String = required(&args, "handleId")?;
            run_transfer_io(move || {
                cognia_task_workspace_host::host_surface::service()?.commit_resource_upload(&handle_id)
            })
            .await
            .and_then(to_json)
        }
        "task_resource_upload_abort" => {
            let handle_id: String = required(&args, "handleId")?;
            run_transfer_io(move || {
                cognia_task_workspace_host::host_surface::service()?.abort_resource_upload(&handle_id)
            })
            .await
            .map(|_| Value::Null)
        }
        // ADR-0224 A11b. A device continuing a conversation here hands over
        // its working copy: what this host accepts, a chunked upload into a
        // staging area, and the apply that turns it into a checkout. Every
        // write is interactive in the manifest, so each call carries the
        // admin lease the hand-over was granted.
        "code_snapshot_limits_get" => cognia_task_workspace_host::host_surface::code_snapshot_limits_get()
            .map_err(RpcError::internal)
            .and_then(to_json),
        "code_snapshot_upload_open" => {
            let size_bytes: u64 = required(&args, "sizeBytes")?;
            let sha256: String = required(&args, "sha256")?;
            cognia_task_workspace_host::host_surface::code_snapshot_upload_open(size_bytes, sha256)
                .await
                .map_err(RpcError::validation_failed)
                .and_then(to_json)
        }
        "code_snapshot_upload_write_chunk" => {
            let upload_id: String = required(&args, "uploadId")?;
            let offset: u64 = required(&args, "offset")?;
            let data_base64: String = required(&args, "dataBase64")?;
            let chunk_hash: String = required(&args, "chunkHash")?;
            let permit = TRANSFER_IO_SLOTS
                .acquire()
                .await
                .map_err(|error| RpcError::internal(error.to_string()))?;
            let written = cognia_task_workspace_host::host_surface::code_snapshot_upload_write_chunk(
                upload_id,
                offset,
                data_base64,
                chunk_hash,
            )
            .await;
            drop(permit);
            written
                .map_err(RpcError::validation_failed)
                .and_then(to_json)
        }
        "code_snapshot_upload_commit" => {
            let upload_id: String = required(&args, "uploadId")?;
            cognia_task_workspace_host::host_surface::code_snapshot_upload_commit(upload_id)
                .await
                .map_err(RpcError::validation_failed)
                .and_then(to_json)
        }
        "code_snapshot_upload_cancel" => {
            let upload_id: String = required(&args, "uploadId")?;
            cognia_task_workspace_host::host_surface::code_snapshot_upload_cancel(upload_id)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::validation_failed)
        }
        "code_snapshot_apply" => {
            let input: cognia_task_workspace::ApplyCodeSnapshot = required(&args, "input")?;
            cognia_task_workspace_host::host_surface::code_snapshot_apply(input)
                .await
                .map_err(RpcError::validation_failed)
                .and_then(to_json)
        }
        "code_checkout_export" => {
            let input: cognia_task_workspace::ExportCodeCheckout = required(&args, "input")?;
            cognia_task_workspace_host::host_surface::code_checkout_export(input)
                .await
                .map_err(RpcError::validation_failed)
                .and_then(to_json)
        }
        "code_result_read_chunk" => {
            let result_id: String = required(&args, "resultId")?;
            let offset: u64 = required(&args, "offset")?;
            run_transfer_io(move || {
                cognia_task_workspace_host::host_surface::service()?.read_code_result_chunk(&result_id, offset)
            })
            .await
            .and_then(to_json)
        }
        "code_result_discard" => {
            let result_id: String = required(&args, "resultId")?;
            cognia_task_workspace_host::host_surface::code_result_discard(result_id)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::validation_failed)
        }
        "task_workspace_apply" => {
            let run_id: String = required(&args, "runId")?;
            let selection: Option<Vec<cognia_task_workspace::PatchSelection>> =
                optional(&args, "selection")?;
            let allow_irreversible: Option<bool> = optional(&args, "allowIrreversible")?;
            tokio::task::spawn_blocking(move || {
                cognia_task_workspace_host::host_surface::service()?.apply_patch_set_with_options(
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
                cognia_task_workspace_host::host_surface::service()?.undo_patch_set(&run_id)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_restore_snapshot" => {
            let run_id: String = required(&args, "runId")?;
            cognia_task_workspace_host::host_surface::task_workspace_restore_snapshot(run_id)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_pin" => {
            let task_id: String = required(&args, "taskId")?;
            let pinned: bool = required(&args, "pinned")?;
            cognia_task_workspace_host::host_surface::service()
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
                cognia_task_workspace_host::host_surface::service()?.resolve_conflict_with_options(
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
            tokio::task::spawn_blocking(move || cognia_task_workspace_host::host_surface::service()?.prune())
                .await
                .map_err(|error| RpcError::internal(error.to_string()))?
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        // File-tree browser: list children / stat one path (reads), and
        // mkdir / delete / rename / copy (CONTROL-gated writes). All use the
        // `root` + `relPath` sandbox shape of the read/write variants above.
        // The one command a client can issue *before* it knows anything. Every
        // other entry point here takes a `root` the caller had to already know,
        // and a caller that guesses wrong gets a refusal it has no way to act
        // on. The headless answer is produced by the enforcement path itself
        // (`validate_workspace_root` creates and canonicalizes the directory),
        // so the reported root is by construction a root this Host accepts.
        "fs_workspace_roots" => {
            if let Some(services) = host.headless() {
                let policy = services.spawn_policy.clone();
                tokio::task::spawn_blocking(move || {
                    let requested = policy.workspaces_dir().to_string_lossy().into_owned();
                    policy.validate_workspace_root(&requested)
                })
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map(|path| cognia_files::files::WorkspaceRootsReport {
                    roots: vec![cognia_files::files::WorkspaceRoot {
                        path,
                        source: cognia_files::files::WORKSPACE_ROOT_SOURCE_HEADLESS.to_string(),
                    }],
                })
                .map_err(|error| {
                    RpcError::internal(format!("workspaces root unavailable: {error}"))
                })
                .and_then(to_json)
            } else {
                to_json(cognia_files::files::fs_workspace_roots())
            }
        }
        "fs_list_workspace_dir" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let rel_path: Option<String> = optional(&args, "relPath")?;
            let include_ignored: Option<bool> = optional(&args, "includeIgnored")?;
            tokio::task::spawn_blocking(move || {
                cognia_files::files::fs_list_workspace_dir(root, rel_path, include_ignored)
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
                cognia_files::files::fs_stat_workspace_file(root, rel_path)
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
                cognia_files::files::fs_create_workspace_dir(root, rel_path)
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
                cognia_files::files::fs_delete_workspace_entry(root, rel_path, recursive)
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
                cognia_files::files::fs_rename_workspace_entry(root, from_rel_path, to_rel_path)
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
                cognia_files::files::fs_copy_workspace_entry(root, from_rel_path, to_rel_path, recursive)
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
    fn best_of_n_remote_selection_never_dispatches_caller_identity() {
        let source = include_str!("filesystem.rs");
        let arm = source.split("\"best_of_n_select\" =>").nth(1).unwrap().split("\n        \"").next().unwrap();
        assert!(arm.contains("StatusCode::FORBIDDEN"));
        assert!(!arm.contains("required(&args"));
        assert!(!arm.contains("best_of_n_select("));
    }

    #[test]
    fn workspace_write_conflict_preserves_current_hash_and_http_status() {
        for current_sha256 in [None, Some("a".repeat(64))] {
            let error = cognia_files::files::WorkspaceWriteError::Conflict {
                current_sha256: current_sha256.clone(),
            };
            let (status, Json(rpc_error)) = workspace_write_error(error);
            assert_eq!(status, StatusCode::CONFLICT);
            assert_eq!(rpc_error.code, "workspace_file_conflict");
            assert!(!rpc_error.retryable);
            let payload: Value = serde_json::from_str(
                rpc_error.message.strip_prefix("workspace_file_conflict:").unwrap(),
            ).unwrap();
            assert_eq!(payload, json!({ "currentSha256": current_sha256 }));
        }
        assert_eq!(workspace_write_error(cognia_files::files::WorkspaceWriteError::InvalidPrecondition {
            message: "invalid hash".into(),
        }).0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn changeset_rejections_answer_a_client_status_not_a_server_fault() {
        let status = |code: &str| {
            scm_command_error(cognia_core::command_error::CommandError {
                code: code.into(),
                message: "m".into(),
                retryable: false,
            })
            .0
        };
        assert_eq!(status("busy"), StatusCode::CONFLICT);
        assert_eq!(status("stale_candidate"), StatusCode::CONFLICT);
        assert_eq!(status("checks"), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(status("invalid_workspace"), StatusCode::BAD_REQUEST);
        assert_eq!(status("not_found"), StatusCode::NOT_FOUND);
        assert_eq!(
            status("service_unavailable"),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(status("git"), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn changeset_command_error_keeps_its_code_and_retryability_on_the_wire() {
        let error = cognia_task_workspace::IntegrationError::TargetMoved {
            expected: "expected-tip".into(),
            actual: Some("new-tip".into()),
        };
        let message = error.to_string();
        let (status, Json(rpc_error)) =
            scm_command_error(cognia_core::command_error::CommandError {
                code: error.code().to_string(),
                message: message.clone(),
                retryable: error.retryable(),
            });
        // A target that moved is a state race, not a server fault.
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            serde_json::to_value(rpc_error).unwrap(),
            json!({
                "code": "target_moved",
                "message": message,
                "retryable": true
            })
        );
    }

    #[tokio::test]
    async fn cancelled_transfer_io_keeps_its_slot_until_disk_work_finishes() {
        let reserved = TRANSFER_IO_SLOTS.acquire_many(7).await.unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let call = tokio::spawn(run_transfer_io(move || {
            let _ = started_tx.send(());
            release_rx.recv().unwrap();
            Ok(())
        }));
        started_rx.await.unwrap();
        call.abort();
        let _ = call.await;
        let held = TRANSFER_IO_SLOTS.available_permits();
        release_tx.send(()).unwrap();
        let last = TRANSFER_IO_SLOTS.acquire().await.unwrap();
        assert_eq!(
            held, 0,
            "cancelling a caller released a still-running disk slot"
        );
        drop((last, reserved));
    }

    #[test]
    fn command_family_is_non_empty_and_unique() {
        assert!(!COMMANDS.is_empty());
        let unique: std::collections::HashSet<_> = COMMANDS.iter().copied().collect();
        assert_eq!(unique.len(), COMMANDS.len());
    }

    #[test]
    fn registry_inventory_and_lifecycle_commands_are_remotely_routed() {
        for command in [
            "task_workspace_bundle_begin",
            "task_workspace_bundle_turn_begin",
            "task_workspace_bundle_turn_settle",
            "task_workspace_bundle_turn_abort",
            "task_workspace_bundle_turn_get",
            "task_workspace_managed_list",
            "task_workspace_environment_list",
            "task_workspace_bundle_list",
            "task_workspace_bundle_acquire",
            "task_workspace_bundle_apply",
            "task_workspace_bundle_handoff_retry",
            "task_workspace_bundle_handoff_get",
            "task_workspace_bundle_handoff_undo",
            "task_workspace_bundle_handoff_undo_get",
            "task_workspace_reconcile",
            "task_workspace_policy_get",
            "task_workspace_policy_set",
            "task_workspace_port_lease_get",
            "task_workspace_port_lease_ensure",
            "task_workspace_port_lease_resolve",
            "task_workspace_port_lease_resolve_ensure",
            "task_workspace_port_lease_subject_ensure",
            "task_workspace_port_lease_subject_get",
            "task_workspace_port_lease_subject_release",
            "task_workspace_port_lease_release",
            "task_workspace_port_lease_list",
            "task_workspace_maintenance_run",
            "task_workspace_maintenance_events",
            "task_workspace_managed_archive",
            "task_workspace_managed_adopt",
            "task_workspace_environment_adopt",
            "task_workspace_environment_create_branch",
            "task_workspace_environment_delete_branch",
            "task_workspace_changeset_get",
            "task_workspace_changeset_list",
            "task_workspace_changeset_eligibility",
            "task_workspace_integration_analyze",
            "task_workspace_integration_get",
            "task_workspace_integration_list",
            "task_workspace_changeset_capture",
            "task_workspace_changeset_mark_ready",
            "task_workspace_changeset_record_review",
            "task_workspace_changeset_record_check",
            "task_workspace_changeset_approve",
            "task_workspace_changeset_abandon",
            "task_workspace_integration_prepare",
            "task_workspace_integration_record_check",
            "task_workspace_integration_publish",
            "task_workspace_integration_rebuild",
            "task_workspace_integration_drop_item",
            "task_workspace_integration_abort",
            "task_workspace_integration_rollback",
            "task_workspace_managed_restore",
            "task_workspace_managed_delete",
        ] {
            assert!(COMMANDS.contains(&command), "missing {command}");
        }
    }
}
