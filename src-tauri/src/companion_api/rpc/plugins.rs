use super::*;

pub(super) const COMMANDS: &[&str] = &[
    "plugin_list",
    "plugin_runtime_snapshot",
    "plugin_install",
    "plugin_install_from_github",
    "plugin_uninstall",
    "plugin_stage_version",
    "plugin_commit_staged_update",
    "plugin_discard_staged_update",
    "plugin_finalize_staged_update",
    "plugin_backup_create",
    "plugin_backup_restore",
    "plugin_backup_delete",
    "plugin_set_status",
    "plugin_permission_grant",
    "plugin_permission_list",
    "plugin_permission_revoke",
    "plugin_set_shell_allowlist",
    "plugin_set_network_allowlist",
    "plugin_python_initialize",
    "plugin_python_runtime_info",
    "plugin_python_load",
    "plugin_python_call_hook",
    "plugin_python_push_config",
    "plugin_python_get_tools",
    "plugin_python_call_tool",
    "plugin_python_call",
    "plugin_python_eval",
    "plugin_python_import",
    "plugin_python_module_call",
    "plugin_python_module_getattr",
    "plugin_python_is_initialized",
    "plugin_python_get_info",
    "plugin_python_install_deps",
    "plugin_python_unload",
    "plugin_python_list",
    "plugin_api_invoke",
    "plugin_api_batch_invoke",
    "plugin_get_capabilities",
    "plugin_workspace_repo_remove",
    "codeserver_supported",
    "codeserver_ensure",
    "codeserver_status",
    "codeserver_stop",
    "codeserver_stop_all",
    "codeserver_open_file",
    "codeserver_agent_open",
    "codeserver_agent_apply_edit",
    "codeserver_agent_read_active",
    "codeserver_agent_save_all",
    "codeserver_agent_show_diff",
    "codeserver_agent_reveal",
    "codeserver_agent_run_in_terminal",
    "codeserver_agent_notify",
    "codeserver_agent_workspace_snapshot",
    "codeserver_read_user_settings",
    "codeserver_write_user_settings",
    "codeserver_read_runtime_args",
    "codeserver_write_runtime_args",
    "codeserver_build_proxy",
    "codeserver_activate_proxy",
    "codeserver_list_proxies",
    "codeserver_broker_validate_paths",
    "codeserver_broker_respond",
    "codeserver_broker_notify",
    "lsp_host_ensure",
    "lsp_host_request",
    "ensure_system_lsp_host",
    "plugin_load_vscode",
    "plugin_activate_vscode",
    "plugin_deactivate_vscode",
    "plugin_unload_vscode",
    "plugin_invoke_vscode_rpc",
    "plugin_vscode_send_response",
    "plugin_launch_js",
    "plugin_invoke_js_callback",
    "plugin_deactivate_js",
    "plugin_stop_js",
    "plugin_js_status",
    "plugin_wasm_load",
    "plugin_wasm_activate",
    "plugin_wasm_deactivate",
    "plugin_wasm_call",
    "plugin_wasm_unload",
    "plugin_wasm_list",
    // `plugin_wasm_renderer_response` deliberately absent: it is the renderer
    // half of the WASM capability bridge (disposition `runtime-internal`), so
    // it is not in KNOWN_COMMANDS. Listing it here without an allowlist entry
    // made its arm unreachable dead code — the gate at rpc.rs rejects the name
    // before this table is consulted — which is exactly the drift the
    // KNOWN_COMMANDS doc comment warns about.
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
    use tauri::Manager as _;

    let _ = (state, host, device_id, account_id, scope);
    let result = match name {
        // ── Plugins ──────────────────────────────────────────────────────────
        // Native install/uninstall manage the on-disk plugin dir + Rust
        // snapshot. Headless mutations notify the Node PluginManager; desktop
        // mutations take effect on the next renderer reload.
        "plugin_list" => {
            if let Some(services) = host.headless() {
                return crate::plugin_api::lifecycle::plugin_get_all_for_state(
                    services.plugin_runtime.as_ref(),
                )
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json);
            }
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::lifecycle::plugin_get_all(st)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "plugin_runtime_snapshot" => {
            let plugin_id: String = required(&args, "pluginId")?;
            if let Some(services) = host.headless() {
                return crate::plugin_api::lifecycle::plugin_runtime_snapshot_for_state(
                    services.plugin_runtime.as_ref(),
                    plugin_id,
                )
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json);
            }
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::lifecycle::plugin_runtime_snapshot(st, plugin_id)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "plugin_install" => {
            let plugin_id: String = required(&args, "pluginId")?;
            let source: String = required(&args, "source")?;
            let payload_val: Value =
                optional(&args, "payload")?.unwrap_or_else(|| serde_json::json!({}));
            let payload: crate::plugin_api::lifecycle::InstallPayload =
                serde_json::from_value(payload_val)
                    .map_err(|e| RpcError::malformed(format!("plugin_install.payload: {e}")))?;
            if let Some(services) = host.headless() {
                let snapshot = crate::plugin_api::lifecycle::plugin_install_for_state(
                    services.plugin_runtime.as_ref(),
                    plugin_id,
                    source,
                    payload,
                )
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?;
                services.event_bus.publish(
                    "plugin://runtime-changed".to_string(),
                    serde_json::json!({
                        "action": "installed",
                        "pluginId": snapshot.plugin_id,
                        "accountId": account_id,
                    }),
                );
                return to_json(snapshot);
            }
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::lifecycle::plugin_install(st, plugin_id, source, payload)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "plugin_install_from_github" => {
            let repo: String = required(&args, "repo")?;
            let git_ref: Option<String> = optional(&args, "gitRef")?;
            let subdir: Option<String> = optional(&args, "subdir")?;
            let generated_files: Option<std::collections::BTreeMap<String, String>> =
                optional(&args, "generatedFiles")?;
            if let Some(services) = host.headless() {
                let result =
                    crate::plugin_api::github::installer::plugin_install_from_github_for_state(
                        services.plugin_runtime.as_ref(),
                        repo,
                        git_ref,
                        subdir,
                        generated_files.unwrap_or_default(),
                    )
                    .await
                    .map_err(RpcError::internal)?;
                services.event_bus.publish(
                    "plugin://runtime-changed".to_string(),
                    serde_json::json!({
                        "action": "installed",
                        "pluginId": result.manifest.get("id").and_then(Value::as_str),
                        "accountId": account_id,
                    }),
                );
                return to_json(result);
            }
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::github::installer::plugin_install_from_github(
                st,
                repo,
                git_ref,
                subdir,
                generated_files,
            )
            .await
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "plugin_uninstall" => {
            let plugin_id: String = required(&args, "pluginId")?;
            if let Some(services) = host.headless() {
                crate::plugin_api::lifecycle::plugin_uninstall_for_state(
                    services.plugin_runtime.as_ref(),
                    plugin_id.clone(),
                )
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?;
                services.event_bus.publish(
                    "plugin://runtime-changed".to_string(),
                    serde_json::json!({
                        "action": "uninstalled",
                        "pluginId": plugin_id,
                        "accountId": account_id,
                    }),
                );
                return Ok(Value::Null);
            }
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::lifecycle::plugin_uninstall(st, plugin_id)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "plugin_stage_version" => {
            let plugin_id: String = required(&args, "pluginId")?;
            let version: String = required(&args, "version")?;
            let download_url: String = required(&args, "downloadUrl")?;
            let checksum: Option<String> = optional(&args, "checksum")?;
            let signature_hex: Option<String> = optional(&args, "signatureHex")?;
            let public_key_hex: Option<String> = optional(&args, "publicKeyHex")?;
            let require_signature: Option<bool> = optional(&args, "requireSignature")?;
            if let Some(services) = host.headless() {
                return crate::plugin_api::marketplace::plugin_stage_version_for_state(
                    services.plugin_runtime.as_ref(),
                    plugin_id,
                    version,
                    download_url,
                    checksum,
                    signature_hex,
                    public_key_hex,
                    require_signature,
                )
                .await
                .map_err(|error| RpcError::internal(error.to_string()))
                .and_then(to_json);
            }
            let app = host.tauri_app(name)?;
            let state: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::marketplace::plugin_stage_version_for_state(
                state.inner(),
                plugin_id,
                version,
                download_url,
                checksum,
                signature_hex,
                public_key_hex,
                require_signature,
            )
            .await
            .map_err(|error| RpcError::internal(error.to_string()))
            .and_then(to_json)
        }
        "plugin_commit_staged_update" => {
            let plugin_id: String = required(&args, "pluginId")?;
            let transaction_id: String = required(&args, "transactionId")?;
            if let Some(services) = host.headless() {
                let committed = crate::plugin_api::marketplace::commit_staged_update_for_state(
                    services.plugin_runtime.as_ref(),
                    &plugin_id,
                    &transaction_id,
                )
                .map_err(|error| RpcError::internal(error.to_string()))?;
                services.event_bus.publish(
                    "plugin://runtime-changed".to_string(),
                    serde_json::json!({
                        "action": "updated",
                        "pluginId": plugin_id,
                        "accountId": account_id,
                    }),
                );
                return to_json(committed);
            }
            let app = host.tauri_app(name)?;
            let state: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::marketplace::commit_staged_update_for_state(
                state.inner(),
                &plugin_id,
                &transaction_id,
            )
            .map_err(|error| RpcError::internal(error.to_string()))
            .and_then(to_json)
        }
        "plugin_discard_staged_update" => {
            let plugin_id: String = required(&args, "pluginId")?;
            let transaction_id: String = required(&args, "transactionId")?;
            if let Some(services) = host.headless() {
                return crate::plugin_api::marketplace::discard_staged_update_for_state(
                    services.plugin_runtime.as_ref(),
                    &plugin_id,
                    &transaction_id,
                )
                .map(|_| Value::Null)
                .map_err(|error| RpcError::internal(error.to_string()));
            }
            let app = host.tauri_app(name)?;
            let state: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::marketplace::discard_staged_update_for_state(
                state.inner(),
                &plugin_id,
                &transaction_id,
            )
            .map(|_| Value::Null)
            .map_err(|error| RpcError::internal(error.to_string()))
        }
        "plugin_finalize_staged_update" => {
            let plugin_id: String = required(&args, "pluginId")?;
            let transaction_id: String = required(&args, "transactionId")?;
            if let Some(services) = host.headless() {
                return crate::plugin_api::marketplace::finalize_staged_update_for_state(
                    services.plugin_runtime.as_ref(),
                    &plugin_id,
                    &transaction_id,
                )
                .map(|_| Value::Null)
                .map_err(|error| RpcError::internal(error.to_string()));
            }
            let app = host.tauri_app(name)?;
            let state: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::marketplace::finalize_staged_update_for_state(
                state.inner(),
                &plugin_id,
                &transaction_id,
            )
            .map(|_| Value::Null)
            .map_err(|error| RpcError::internal(error.to_string()))
        }
        "plugin_backup_create" => {
            let plugin_id: String = required(&args, "pluginId")?;
            let label: Option<String> = optional(&args, "label")?;
            if let Some(services) = host.headless() {
                return crate::plugin_api::backup::plugin_backup_create_for_state(
                    services.plugin_runtime.as_ref(),
                    plugin_id,
                    label,
                )
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json);
            }
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::backup::plugin_backup_create(st, plugin_id, label)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "plugin_backup_restore" => {
            let plugin_id: String = required(&args, "pluginId")?;
            let backup_id: String = required(&args, "backupId")?;
            if let Some(services) = host.headless() {
                crate::plugin_api::backup::plugin_backup_restore_for_state(
                    services.plugin_runtime.as_ref(),
                    plugin_id.clone(),
                    backup_id,
                )
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?;
                services.event_bus.publish(
                    "plugin://runtime-changed".to_string(),
                    serde_json::json!({
                        "action": "restored",
                        "pluginId": plugin_id,
                        "accountId": account_id,
                    }),
                );
                return Ok(Value::Null);
            }
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::backup::plugin_backup_restore(st, plugin_id, backup_id)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "plugin_backup_delete" => {
            let plugin_id: String = required(&args, "pluginId")?;
            let backup_id: String = required(&args, "backupId")?;
            if let Some(services) = host.headless() {
                return crate::plugin_api::backup::plugin_backup_delete_for_state(
                    services.plugin_runtime.as_ref(),
                    plugin_id,
                    backup_id,
                )
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()));
            }
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::backup::plugin_backup_delete(st, plugin_id, backup_id)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }

        "plugin_set_status" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_runtime = std::sync::Arc::clone(&services.plugin_runtime);
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let status: String = required(&args, "status")?;
            tokio::task::spawn_blocking(move || {
                crate::plugin_api::lifecycle::plugin_set_status_for_state(
                    plugin_runtime.as_ref(),
                    plugin_id,
                    status,
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map(|_| Value::Null)
            .map_err(|error| RpcError::internal(error.to_string()))
        }
        "plugin_permission_grant" => {
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let permission: String = required(&args, "permission")?;
            let granted_by: String = required_aliased(&args, "granted_by", "grantedBy")?;
            let expires_at: Option<String> = match optional(&args, "expiresAt")? {
                Some(value) => Some(value),
                None => optional(&args, "expires_at")?,
            };
            let grant = crate::plugin_api::permissions::grant_permission_for_state(
                host.plugin_runtime(),
                plugin_id,
                permission,
                granted_by,
                expires_at,
            )
            .map_err(|error| RpcError::internal(error.to_string()))?;
            to_json(grant)
        }
        "plugin_permission_list" => {
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let permissions = crate::plugin_api::permissions::list_permissions_for_state(
                host.plugin_runtime(),
                plugin_id,
            )
            .map_err(|error| RpcError::internal(error.to_string()))?;
            to_json(permissions)
        }
        "plugin_permission_revoke" => {
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let permission: String = required(&args, "permission")?;
            crate::plugin_api::permissions::revoke_permission_for_state(
                host.plugin_runtime(),
                plugin_id,
                permission,
            )
            .map(|_| Value::Null)
            .map_err(|error| RpcError::internal(error.to_string()))
        }
        "plugin_set_shell_allowlist" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let commands: Vec<String> = required(&args, "commands")?;
            services
                .plugin_runtime
                .set_shell_allowlist(&plugin_id, commands);
            Ok(Value::Null)
        }
        "plugin_set_network_allowlist" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let domains: Vec<String> = required(&args, "domains")?;
            let rules: Option<Vec<crate::plugin_api::NetworkAccessRule>> =
                optional(&args, "rules")?;
            services
                .plugin_runtime
                .set_network_allowlist(&plugin_id, domains);
            if let Some(rules) = rules {
                services.plugin_runtime.set_network_rules(&plugin_id, rules);
            }
            Ok(Value::Null)
        }

        "plugin_python_initialize" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let python_path: Option<String> = optional(&args, "pythonPath")?;
            crate::plugin_api::python::commands::plugin_python_initialize_for_state(
                services.python_plugins.as_ref(),
                python_path,
                None,
            )
            .await
            .map(|_| Value::Null)
            .map_err(plugin_rpc_error)
        }
        "plugin_python_runtime_info" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            to_json(
                crate::plugin_api::python::commands::plugin_python_runtime_info_for_state(
                    services.python_plugins.as_ref(),
                ),
            )
        }
        "plugin_python_load" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let plugin_path: String = required_aliased(&args, "plugin_path", "pluginPath")?;
            let main_module: String = required_aliased(&args, "main_module", "mainModule")?;
            let dependencies: Option<Vec<String>> = optional(&args, "dependencies")?;
            let config: Option<Value> = optional(&args, "config")?;
            let host_settings: Option<crate::plugin_api::python::commands::PythonHostSettings> =
                optional(&args, "hostSettings")?;
            crate::plugin_api::python::commands::plugin_python_load_for_state(
                services.python_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                plugin_path,
                main_module,
                dependencies,
                config,
                host_settings,
            )
            .await
            .map_err(plugin_rpc_error)
        }
        "plugin_python_call_hook" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            let event: String = required(&args, "event")?;
            let hook_name: String = required(&args, "name")?;
            let payload: Value = required(&args, "payload")?;
            crate::plugin_api::python::commands::plugin_python_call_hook_generation_for_state(
                services.python_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                event,
                hook_name,
                payload,
                generation,
            )
            .await
            .map_err(plugin_rpc_error)
        }
        "plugin_python_push_config" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            let config: Value = required(&args, "config")?;
            crate::plugin_api::python::commands::plugin_python_push_config_generation_for_state(
                services.python_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                config,
                generation,
            )
            .await
            .map(|_| Value::Null)
            .map_err(plugin_rpc_error)
        }
        "plugin_python_get_tools" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            crate::plugin_api::python::commands::plugin_python_get_tools_generation_for_state(
                services.python_plugins.as_ref(),
                plugin_id,
                generation,
            )
            .await
            .map_err(plugin_rpc_error)
        }
        "plugin_python_call_tool" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            let tool_name: String = required_aliased(&args, "tool_name", "toolName")?;
            let tool_args: Value = required(&args, "args")?;
            crate::plugin_api::python::commands::plugin_python_call_tool_generation_for_state(
                services.python_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                tool_name,
                tool_args,
                generation,
            )
            .await
            .map_err(plugin_rpc_error)
        }
        "plugin_python_call" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            let function_name: String = required_aliased(&args, "function_name", "functionName")?;
            let call_args: Vec<Value> = required(&args, "args")?;
            crate::plugin_api::python::commands::plugin_python_call_generation_for_state(
                services.python_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                function_name,
                call_args,
                generation,
            )
            .await
            .map_err(plugin_rpc_error)
        }
        "plugin_python_eval" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            let code: String = required(&args, "code")?;
            let locals: Option<Value> = optional(&args, "locals")?;
            crate::plugin_api::python::commands::plugin_python_eval_generation_for_state(
                services.python_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                code,
                locals,
                generation,
            )
            .await
            .map_err(plugin_rpc_error)
        }
        "plugin_python_import" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            let module_name: String = required_aliased(&args, "module_name", "moduleName")?;
            crate::plugin_api::python::commands::plugin_python_import_generation_for_state(
                services.python_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                module_name,
                generation,
            )
            .await
            .map_err(plugin_rpc_error)
        }
        "plugin_python_module_call" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            let module_name: String = required_aliased(&args, "module_name", "moduleName")?;
            let function_name: String = required_aliased(&args, "function_name", "functionName")?;
            let call_args: Vec<Value> = required(&args, "args")?;
            crate::plugin_api::python::commands::plugin_python_module_call_generation_for_state(
                services.python_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                module_name,
                function_name,
                call_args,
                generation,
            )
            .await
            .map_err(plugin_rpc_error)
        }
        "plugin_python_module_getattr" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            let module_name: String = required_aliased(&args, "module_name", "moduleName")?;
            let attr_name: String = required_aliased(&args, "attr_name", "attrName")?;
            crate::plugin_api::python::commands::plugin_python_module_getattr_generation_for_state(
                services.python_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                module_name,
                attr_name,
                generation,
            )
            .await
            .map_err(plugin_rpc_error)
        }
        "plugin_python_is_initialized" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            crate::plugin_api::python::commands::plugin_python_is_initialized_generation_for_state(
                services.python_plugins.as_ref(),
                plugin_id,
                generation,
            )
            .await
            .map(Value::Bool)
            .map_err(plugin_rpc_error)
        }
        "plugin_python_get_info" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            to_json(
                crate::plugin_api::python::commands::plugin_python_get_info_generation_for_state(
                    services.python_plugins.as_ref(),
                    &plugin_id,
                    &generation,
                )
                .map_err(plugin_rpc_error)?,
            )
        }
        "plugin_python_install_deps" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let dependencies: Vec<String> = required(&args, "dependencies")?;
            let venv_scope: Option<String> = optional_aliased(&args, "venv_scope", "venvScope")?;
            let host_settings: Option<crate::plugin_api::python::commands::PythonHostSettings> =
                optional_aliased(&args, "host_settings", "hostSettings")?;
            to_json(
                crate::plugin_api::python::commands::plugin_python_install_deps_for_state(
                    services.python_plugins.as_ref(),
                    services.plugin_runtime.as_ref(),
                    &plugin_id,
                    &dependencies,
                    venv_scope.as_deref(),
                    host_settings.unwrap_or_default(),
                )
                .await
                .map_err(plugin_rpc_error)?,
            )
        }
        "plugin_python_unload" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            crate::plugin_api::python::commands::plugin_python_unload_generation_for_state(
                services.python_plugins.as_ref(),
                &plugin_id,
                &generation,
            )
            .await
            .map(|_| Value::Null)
            .map_err(plugin_rpc_error)
        }
        "plugin_python_list" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            to_json(
                crate::plugin_api::python::commands::plugin_python_list_for_state(
                    services.python_plugins.as_ref(),
                ),
            )
        }

        "plugin_api_invoke" => {
            let request: crate::plugin_api::api_bridge::PluginApiInvokeRequest =
                required(&args, "request")?;
            let response = crate::plugin_api::api_bridge::plugin_api_invoke_for_state(
                host.plugin_runtime(),
                request,
            )
            .await
            .map_err(plugin_rpc_error)?;
            to_json(response)
        }
        "plugin_api_batch_invoke" => {
            let request: crate::plugin_api::api_bridge::BatchInvokeRequest =
                required(&args, "request")?;
            let response = crate::plugin_api::api_bridge::plugin_api_batch_invoke_for_state(
                host.plugin_runtime(),
                request,
            )
            .await
            .map_err(plugin_rpc_error)?;
            to_json(response)
        }
        "plugin_get_capabilities" => {
            to_json(crate::plugin_api::api_bridge::plugin_get_capabilities_for_host(false))
        }
        "plugin_workspace_repo_remove" => {
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let segments: Vec<String> = required(&args, "segments")?;
            crate::plugin_api::api_bridge::plugin_workspace_repo_remove_for_state(
                host.plugin_runtime(),
                &plugin_id,
                &segments,
            )
            .map_err(plugin_rpc_error)
            .and_then(to_json)
        }

        "codeserver_supported" => to_json(crate::codeserver::download::resolve_platform().is_ok()),
        "codeserver_ensure" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let profile = optional::<crate::codeserver::profile::IdeProfile>(&args, "profile")?
                .unwrap_or_default();
            services
                .code_server
                .ensure(&root, profile, device_id)
                .await
                .and_then(|status| {
                    serde_json::to_value(status)
                        .map_err(|error| format!("serialize code-server status: {error}"))
                })
                .map_err(RpcError::service_unavailable)
        }
        "codeserver_status" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            services
                .code_server
                .status(&root, device_id)
                .await
                .and_then(|status| {
                    serde_json::to_value(status)
                        .map_err(|error| format!("serialize code-server status: {error}"))
                })
                .map_err(RpcError::service_unavailable)
        }
        "codeserver_stop" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            to_json(services.code_server.stop(&root).await)
        }
        "codeserver_stop_all" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            services.code_server.stop_all().await;
            Ok(Value::Null)
        }
        "codeserver_open_file" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let path: String = required(&args, "path")?;
            let line = optional::<u32>(&args, "line")?;
            let column = optional::<u32>(&args, "column")?;
            host.ide_open_file(&root, device_id, &path, line, column)
                .await
                .map(|()| Value::Null)
                .map_err(RpcError::service_unavailable)
        }
        "codeserver_agent_open" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let path: String = required(&args, "path")?;
            let line = optional::<u32>(&args, "line")?;
            let column = optional::<u32>(&args, "column")?;
            let canonical = host
                .ide_canonical_root(&root, device_id)
                .await
                .map_err(RpcError::service_unavailable)?;
            crate::codeserver::agent_channel::verbs::open(&canonical, &path, line, column)
                .await
                .map_err(RpcError::service_unavailable)
        }
        "codeserver_agent_apply_edit" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let path: String = required(&args, "path")?;
            let line = optional::<u32>(&args, "line")?;
            let column = optional::<u32>(&args, "column")?;
            let canonical = host
                .ide_canonical_root(&root, device_id)
                .await
                .map_err(RpcError::service_unavailable)?;
            crate::codeserver::agent_channel::verbs::apply_edit(&canonical, &path, line, column)
                .await
                .map_err(RpcError::service_unavailable)
        }
        "codeserver_agent_read_active" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let canonical = host
                .ide_canonical_root(&root, device_id)
                .await
                .map_err(RpcError::service_unavailable)?;
            crate::codeserver::agent_channel::verbs::read_active(&canonical)
                .await
                .map_err(RpcError::service_unavailable)
        }
        "codeserver_agent_save_all" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let path = optional::<String>(&args, "path")?;
            let canonical = host
                .ide_canonical_root(&root, device_id)
                .await
                .map_err(RpcError::service_unavailable)?;
            crate::codeserver::agent_channel::verbs::save_all(&canonical, path.as_deref())
                .await
                .map_err(RpcError::service_unavailable)
        }
        "codeserver_agent_show_diff" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let path: String = required(&args, "path")?;
            // The proposed revision travels inline, so a large file can exceed
            // the host's `rpcJsonBodyBytes` ceiling and be refused before it
            // reaches this arm. That is the honest outcome: the renderer falls
            // back to the on-disk diff rather than silently truncating.
            let content: String = required(&args, "content")?;
            let title = optional::<String>(&args, "title")?;
            let canonical = host
                .ide_canonical_root(&root, device_id)
                .await
                .map_err(RpcError::service_unavailable)?;
            crate::codeserver::agent_channel::verbs::show_diff(
                &canonical,
                &path,
                &content,
                title.as_deref(),
            )
            .await
            .map_err(RpcError::service_unavailable)
        }
        "codeserver_agent_reveal" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let path: String = required(&args, "path")?;
            let canonical = host
                .ide_canonical_root(&root, device_id)
                .await
                .map_err(RpcError::service_unavailable)?;
            crate::codeserver::agent_channel::verbs::reveal(&canonical, &path)
                .await
                .map_err(RpcError::service_unavailable)
        }
        "codeserver_agent_run_in_terminal" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let command: String = required(&args, "command")?;
            let cwd = optional::<String>(&args, "cwd")?;
            let terminal_name = optional::<String>(&args, "name")?;
            let canonical = host
                .ide_canonical_root(&root, device_id)
                .await
                .map_err(RpcError::service_unavailable)?;
            crate::codeserver::agent_channel::verbs::run_in_terminal(
                &canonical,
                &command,
                cwd.as_deref(),
                terminal_name.as_deref(),
            )
            .await
            .map_err(RpcError::service_unavailable)
        }
        "codeserver_agent_notify" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let message: String = required(&args, "message")?;
            let kind = optional::<String>(&args, "kind")?;
            let canonical = host
                .ide_canonical_root(&root, device_id)
                .await
                .map_err(RpcError::service_unavailable)?;
            crate::codeserver::agent_channel::verbs::notify(&canonical, &message, kind.as_deref())
                .await
                .map_err(RpcError::service_unavailable)
        }
        "codeserver_agent_workspace_snapshot" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let snapshot: Value = required(&args, "snapshot")?;
            let canonical = host
                .ide_canonical_root(&root, device_id)
                .await
                .map_err(RpcError::service_unavailable)?;
            crate::codeserver::agent_channel::verbs::workspace_snapshot(&canonical, snapshot)
                .await
                .map_err(RpcError::service_unavailable)
        }
        "codeserver_read_user_settings" => {
            let profile = optional::<crate::codeserver::profile::IdeProfile>(&args, "profile")?
                .unwrap_or_default();
            host.ide_read_user_settings(profile)
                .await
                .and_then(|contents| {
                    serde_json::to_value(contents)
                        .map_err(|error| format!("serialize code-server settings: {error}"))
                })
                .map_err(RpcError::service_unavailable)
        }
        "codeserver_write_user_settings" => {
            let contents: String = required(&args, "contents")?;
            let profile = optional::<crate::codeserver::profile::IdeProfile>(&args, "profile")?
                .unwrap_or_default();
            host.ide_write_user_settings(contents, profile)
                .await
                .map(|()| Value::Null)
                .map_err(RpcError::service_unavailable)
        }
        "codeserver_read_runtime_args" => {
            let profile = optional::<crate::codeserver::profile::IdeProfile>(&args, "profile")?
                .unwrap_or_default();
            host.ide_read_runtime_args(profile)
                .await
                .and_then(|contents| {
                    serde_json::to_value(contents)
                        .map_err(|error| format!("serialize code-server runtime args: {error}"))
                })
                .map_err(RpcError::service_unavailable)
        }
        "codeserver_write_runtime_args" => {
            let contents: String = required(&args, "contents")?;
            let profile = optional::<crate::codeserver::profile::IdeProfile>(&args, "profile")?
                .unwrap_or_default();
            host.ide_write_runtime_args(contents, profile)
                .await
                .map(|()| Value::Null)
                .map_err(RpcError::service_unavailable)
        }
        "codeserver_build_proxy" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let request: crate::codeserver::proxy::ProxyBuildRequest = required(&args, "request")?;
            let code_server = std::sync::Arc::clone(&services.code_server);
            let artifact = tokio::task::spawn_blocking(move || code_server.build_proxy(request))
                .await
                .map_err(|error| {
                    RpcError::internal(format!("build managed proxy task failed: {error}"))
                })?
                .map_err(RpcError::service_unavailable)?;
            serde_json::to_value(artifact)
                .map_err(|error| RpcError::internal(format!("serialize proxy artifact: {error}")))
        }
        "codeserver_activate_proxy" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let artifact: crate::codeserver::proxy::ProxyArtifact = required(&args, "artifact")?;
            to_json(services.code_server.install_proxy_artifact(&artifact).await)
        }
        "codeserver_list_proxies" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let code_server = std::sync::Arc::clone(&services.code_server);
            tokio::task::spawn_blocking(move || code_server.list_proxies())
                .await
                .map_err(|error| {
                    RpcError::internal(format!("list managed proxies task failed: {error}"))
                })?
                .and_then(|artifacts| {
                    serde_json::to_value(artifacts)
                        .map_err(|error| format!("serialize proxy artifacts: {error}"))
                })
                .map_err(RpcError::service_unavailable)
        }
        "codeserver_broker_validate_paths" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let paths: Vec<String> = required(&args, "paths")?;
            tokio::task::spawn_blocking(move || {
                paths
                    .iter()
                    .map(|path| {
                        crate::files::validate_confined_path(path, std::slice::from_ref(&root))
                            .map(|value| value.to_string_lossy().into_owned())
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .await
            .map_err(|error| {
                RpcError::internal(format!("validate managed IDE paths task failed: {error}"))
            })?
            .and_then(|paths| {
                serde_json::to_value(paths)
                    .map_err(|error| format!("serialize validated IDE paths: {error}"))
            })
            .map_err(RpcError::service_unavailable)
        }
        "codeserver_broker_respond" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let generation: u64 = required(&args, "generation")?;
            let id: Value = required(&args, "id")?;
            let result: Option<Value> = optional(&args, "result")?;
            let error: Option<Value> = optional(&args, "error")?;
            crate::codeserver::agent_channel::global()
                .respond(&root, generation, id, result, error)
                .await
                .map(|()| Value::Null)
                .map_err(RpcError::service_unavailable)
        }
        "codeserver_broker_notify" => {
            let root = authorize_workspace_root(host, required(&args, "root")?)?;
            let generation: u64 = required(&args, "generation")?;
            let params: Value = required(&args, "params")?;
            crate::codeserver::agent_channel::global()
                .notify_provider(&root, generation, params)
                .await
                .map(|()| Value::Null)
                .map_err(RpcError::service_unavailable)
        }
        "lsp_host_ensure" => crate::plugin_api::vscode::commands::ensure_system_lsp_host_for_state(
            host.vscode_plugins(),
        )
        .await
        .map(|_| Value::Null)
        .map_err(vscode_rpc_error),
        "lsp_host_request" => {
            let method: String = required(&args, "method")?;
            if !remote_lsp_method_allowed(&method) {
                return Err(RpcError::malformed(format!(
                    "lsp_host_request method is not allowed: {method}"
                )));
            }
            let payload_json = match args.get("payloadJson").or_else(|| args.get("payload_json")) {
                Some(Value::String(raw)) => raw.clone(),
                Some(value) => value.to_string(),
                None => "null".to_string(),
            };
            crate::plugin_api::vscode::commands::plugin_invoke_vscode_rpc_for_state(
                host.vscode_plugins(),
                crate::plugin_api::vscode::commands::LSP_HOST_KEY.to_string(),
                method,
                payload_json,
            )
            .await
            .map(Value::String)
            .map_err(vscode_rpc_error)
        }
        "ensure_system_lsp_host" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            crate::plugin_api::vscode::commands::ensure_system_lsp_host_for_state(
                services.vscode_plugins.as_ref(),
            )
            .await
            .map(|_| Value::Null)
            .map_err(vscode_rpc_error)
        }
        "plugin_load_vscode" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let manifest_json: String = required_aliased(&args, "manifest_json", "manifestJson")?;
            let plugin_path: String = required_aliased(&args, "plugin_path", "pluginPath")?;
            crate::plugin_api::vscode::commands::plugin_load_vscode_for_state(
                services.vscode_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                manifest_json,
                plugin_path,
            )
            .await
            .map_err(vscode_rpc_error)
            .and_then(to_json)
        }
        "plugin_activate_vscode" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            let config_json: String = required_aliased(&args, "config_json", "configJson")?;
            crate::plugin_api::vscode::commands::plugin_activate_vscode_generation_for_state(
                services.vscode_plugins.as_ref(),
                plugin_id,
                generation,
                config_json,
            )
            .await
            .map_err(vscode_rpc_error)
            .and_then(to_json)
        }
        "plugin_deactivate_vscode" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            crate::plugin_api::vscode::commands::plugin_deactivate_vscode_generation_for_state(
                services.vscode_plugins.as_ref(),
                plugin_id,
                generation,
            )
            .await
            .map(|_| Value::Null)
            .map_err(vscode_rpc_error)
        }
        "plugin_unload_vscode" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            crate::plugin_api::vscode::commands::plugin_unload_vscode_generation_for_state(
                services.vscode_plugins.as_ref(),
                plugin_id,
                generation,
            )
            .await
            .map(|_| Value::Null)
            .map_err(vscode_rpc_error)
        }
        "plugin_invoke_vscode_rpc" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            let method: String = required(&args, "method")?;
            let payload_json: String = required_aliased(&args, "payload_json", "payloadJson")?;
            crate::plugin_api::vscode::commands::plugin_invoke_vscode_rpc_generation_for_state(
                services.vscode_plugins.as_ref(),
                plugin_id,
                generation,
                method,
                payload_json,
            )
            .await
            .map(Value::String)
            .map_err(vscode_rpc_error)
        }
        "plugin_vscode_send_response" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            let response_json: String = required_aliased(&args, "response_json", "responseJson")?;
            crate::plugin_api::vscode::commands::plugin_vscode_send_response_generation_for_state(
                services.vscode_plugins.as_ref(),
                plugin_id,
                generation,
                response_json,
            )
            .map(|_| Value::Null)
            .map_err(vscode_rpc_error)
        }

        // Node-target JavaScript stays inside cognia-server. The brain uses
        // the same host-neutral lifecycle as desktop Tauri, backed by the
        // verified COGNIA_PLUGIN_NODE_PATH runtime in server images.
        "plugin_launch_js" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let plugin_path: String = required_aliased(&args, "plugin_path", "pluginPath")?;
            let entry: String = required(&args, "entry")?;
            let extra_args: Option<Vec<String>> = optional(&args, "extraArgs")?;
            crate::plugin_api::lifecycle::plugin_launch_js_for_state(
                services.plugin_runtime.as_ref(),
                plugin_id,
                plugin_path,
                entry,
                extra_args.unwrap_or_default(),
                None,
            )
            .await
            .map_err(plugin_rpc_error)
            .and_then(to_json)
        }
        "plugin_invoke_js_callback" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let plugin_path: String = required_aliased(&args, "plugin_path", "pluginPath")?;
            let entry: String = required(&args, "entry")?;
            let callback_id: String = required_aliased(&args, "callback_id", "callbackId")?;
            let callback_args: Value = required(&args, "args")?;
            let generation: String = required(&args, "generation")?;
            crate::plugin_api::lifecycle::plugin_invoke_js_callback_for_state(
                services.plugin_runtime.as_ref(),
                plugin_id,
                plugin_path,
                entry,
                callback_id,
                callback_args,
                generation,
                None,
            )
            .await
            .map_err(plugin_rpc_error)
        }
        "plugin_deactivate_js" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let plugin_path: String = required_aliased(&args, "plugin_path", "pluginPath")?;
            let entry: String = required(&args, "entry")?;
            let generation: String = required(&args, "generation")?;
            crate::plugin_api::lifecycle::plugin_deactivate_js_for_state(
                services.plugin_runtime.as_ref(),
                plugin_id,
                plugin_path,
                entry,
                generation,
                None,
            )
            .await
            .map(|_| Value::Null)
            .map_err(plugin_rpc_error)
        }
        "plugin_stop_js" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            crate::plugin_api::lifecycle::plugin_stop_js_for_state(
                services.plugin_runtime.as_ref(),
                plugin_id,
                generation,
            )
            .await
            .map(|_| Value::Null)
            .map_err(plugin_rpc_error)
        }
        "plugin_js_status" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            crate::plugin_api::lifecycle::plugin_js_status_for_state(
                services.plugin_runtime.as_ref(),
                plugin_id,
                generation,
            )
            .await
            .map(Value::Bool)
            .map_err(plugin_rpc_error)
        }

        // Native plugin execution stays inside cognia-server. The Node brain
        // reaches the existing wasmtime host through its service transport;
        // no guest code or capability decision is reimplemented in JS.
        "plugin_wasm_load" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let manifest_json: String = required_aliased(&args, "manifest_json", "manifestJson")?;
            let plugin_path: String = required_aliased(&args, "plugin_path", "pluginPath")?;
            crate::plugin_api::wasm::commands::plugin_wasm_load_for_state(
                services.wasm_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                manifest_json,
                plugin_path,
            )
            .await
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "plugin_wasm_activate" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            let config_json: String = required_aliased(&args, "config_json", "configJson")?;
            crate::plugin_api::wasm::commands::plugin_wasm_activate_generation_for_state(
                services.wasm_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                config_json,
                generation,
            )
            .await
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "plugin_wasm_deactivate" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            crate::plugin_api::wasm::commands::plugin_wasm_deactivate_generation_for_state(
                services.wasm_plugins.as_ref(),
                plugin_id,
                generation,
            )
            .await
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "plugin_wasm_call" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            let export_name: String = required_aliased(&args, "export_name", "exportName")?;
            let payload_json: String = required_aliased(&args, "payload_json", "payloadJson")?;
            crate::plugin_api::wasm::commands::plugin_wasm_call_generation_for_state(
                services.wasm_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                export_name,
                payload_json,
                generation,
            )
            .await
            .map(Value::String)
            .map_err(RpcError::internal)
        }
        "plugin_wasm_unload" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            crate::plugin_api::wasm::commands::plugin_wasm_unload_generation_for_state(
                services.wasm_plugins.as_ref(),
                plugin_id,
                generation,
            )
            .await
            .map(Value::Bool)
            .map_err(RpcError::internal)
        }
        "plugin_wasm_list" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            crate::plugin_api::wasm::commands::plugin_wasm_list_for_state(
                services.wasm_plugins.as_ref(),
            )
            .await
            .map_err(RpcError::internal)
            .and_then(to_json)
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
