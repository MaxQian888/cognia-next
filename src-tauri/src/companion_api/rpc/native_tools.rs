use super::*;

pub(super) const COMMANDS: &[&str] = &[
    "ocr_list_native_backends",
    "ocr_list_available_backends",
    "ocr_extract_native",
    "ocr_model_status",
    "ocr_download_model",
    "ocr_cancel_model_download",
    "skills_scan_native",
    "skills_load_registry",
    "skills_install_native",
    "skills_uninstall_native",
    "skills_catalog_get",
    "skills_bundle_upload_open",
    "skills_bundle_upload_write",
    "skills_bundle_upload_commit",
    "skills_bundle_upload_abort",
    "skills_install_atomic",
    "skills_uninstall",
    "external_bridge_config_get",
    "external_bridge_config_update",
    "external_bridge_client_create",
    "external_bridge_client_list",
    "external_bridge_client_rotate",
    "external_bridge_client_revoke",
    "external_bridge_start",
    "external_bridge_restart",
    "external_bridge_stop",
    "external_bridge_status",
    "external_bridge_relay_enable",
    "external_bridge_relay_disable",
    "host_admin_lease_issue",
    "host_admin_lease_revoke",
    "mcp_server_start",
    "mcp_server_restart",
    "mcp_server_stop",
    "mcp_server_status",
    "mcp_oauth_status",
    "mcp_oauth_load_entry",
    "mcp_oauth_authenticate",
    "mcp_oauth_refresh",
    "mcp_oauth_clear",
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
        // ── Native OCR service plane ────────────────────────────────────────
        "ocr_list_native_backends" => {
            let ids = if let Some(services) = host.headless() {
                services
                    .ocr_registry()
                    .await
                    .list_ids()
                    .await
                    .into_iter()
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            } else {
                let app = host.tauri_app(name)?;
                let registry: tauri::State<'_, crate::ocr::NativeOcrRegistry> = app.state();
                registry
                    .list_ids()
                    .await
                    .into_iter()
                    .map(str::to_string)
                    .collect()
            };
            to_json(ids)
        }

        "ocr_list_available_backends" => {
            let ids = if let Some(services) = host.headless() {
                services
                    .ocr_registry()
                    .await
                    .available_ids()
                    .await
                    .into_iter()
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            } else {
                let app = host.tauri_app(name)?;
                let registry: tauri::State<'_, crate::ocr::NativeOcrRegistry> = app.state();
                registry
                    .available_ids()
                    .await
                    .into_iter()
                    .map(str::to_string)
                    .collect()
            };
            to_json(ids)
        }

        "ocr_extract_native" => {
            let payload: crate::ocr::NativeOcrInvokePayload = required(&args, "payload")?;
            let result = if let Some(services) = host.headless() {
                services.ocr_registry().await.dispatch(&payload).await
            } else {
                let app = host.tauri_app(name)?;
                let registry: tauri::State<'_, crate::ocr::NativeOcrRegistry> = app.state();
                registry.dispatch(&payload).await
            }
            .map_err(|error| RpcError::internal(error.to_string()))?;
            to_json(result)
        }

        "ocr_model_status" => {
            let backend: String = required(&args, "backend")?;
            let variant: Option<String> = optional(&args, "variant")?;
            crate::ocr::native::ocr_model_status(backend, variant)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }

        "ocr_download_model" => {
            let backend: String = required(&args, "backend")?;
            let variant: Option<String> = optional(&args, "variant")?;
            let request_id: Option<String> = match optional(&args, "requestId")? {
                Some(value) => Some(value),
                None => optional(&args, "request_id")?,
            };
            let result = if let Some(services) = host.headless() {
                let event_bus = std::sync::Arc::clone(&services.event_bus);
                crate::ocr::native::ocr_download_model_with_emitter(
                    backend,
                    variant,
                    request_id,
                    std::sync::Arc::new(move |event| {
                        if let Ok(payload) = serde_json::to_value(event) {
                            event_bus.publish("ocr://download-progress".to_string(), payload);
                        }
                    }),
                )
                .await
            } else {
                let app = host.tauri_app(name)?;
                crate::ocr::native::ocr_download_model(app.clone(), backend, variant, request_id)
                    .await
            }
            .map_err(RpcError::internal)?;
            to_json(result)
        }

        "ocr_cancel_model_download" => {
            let request_id: String = required_aliased(&args, "request_id", "requestId")?;
            to_json(crate::ocr::native::ocr_cancel_model_download(request_id))
        }

        // ── Skills ────────────────────────────────────────────────────────────
        "skills_scan_native" => tokio::task::spawn_blocking(skills_native::skills_scan_native)
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map_err(RpcError::internal)
            .and_then(|r| serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))),

        "skills_load_registry" => tokio::task::spawn_blocking(registry::skills_load_registry)
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map_err(RpcError::internal)
            .and_then(|r| serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))),

        "skills_install_native" => {
            let request: crate::skills::types::InstallSkillRequest = required(&args, "request")?;
            tokio::task::spawn_blocking(move || install::skills_install_native(request))
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map_err(RpcError::internal)
                .and_then(|r| {
                    serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        "skills_uninstall_native" => {
            let dir_name: String = required(&args, "dir_name")?;
            tokio::task::spawn_blocking(move || skills_native::skills_uninstall_native(dir_name))
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map_err(RpcError::internal)
                .and_then(|r| {
                    serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        "skills_catalog_get" => {
            let host = host.clone();
            tokio::task::spawn_blocking(move || {
                super::super::skill_transactions::catalog_get(&host)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(skill_transaction_rpc_error)
            .and_then(to_json)
        }

        "skills_bundle_upload_open" => {
            let request: crate::skills::bundle::BundleUploadOpenRequest =
                required(&args, "request")?;
            let host = host.clone();
            let device_id = device_id.to_owned();
            tokio::task::spawn_blocking(move || {
                super::super::skill_transactions::upload_open(&host, &device_id, request)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(skill_transaction_rpc_error)
            .and_then(to_json)
        }

        "skills_bundle_upload_write" => {
            let handle_id: String = required_aliased(&args, "handle_id", "handleId")?;
            let offset: u64 = required(&args, "offset")?;
            let data_base64: String = required_aliased(&args, "data_base64", "dataBase64")?;
            let chunk_hash: String = required_aliased(&args, "chunk_hash", "chunkHash")?;
            let host = host.clone();
            let device_id = device_id.to_owned();
            tokio::task::spawn_blocking(move || {
                super::super::skill_transactions::upload_write(
                    &host,
                    &device_id,
                    &handle_id,
                    offset,
                    &data_base64,
                    &chunk_hash,
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(skill_transaction_rpc_error)
            .and_then(to_json)
        }

        "skills_bundle_upload_commit" => {
            let handle_id: String = required_aliased(&args, "handle_id", "handleId")?;
            let host = host.clone();
            let device_id = device_id.to_owned();
            tokio::task::spawn_blocking(move || {
                super::super::skill_transactions::upload_commit(&host, &device_id, &handle_id)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(skill_transaction_rpc_error)?;
            Ok(Value::Null)
        }

        "skills_bundle_upload_abort" => {
            let handle_id: String = required_aliased(&args, "handle_id", "handleId")?;
            let host = host.clone();
            let device_id = device_id.to_owned();
            tokio::task::spawn_blocking(move || {
                super::super::skill_transactions::upload_abort(&host, &device_id, &handle_id)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(skill_transaction_rpc_error)?;
            Ok(Value::Null)
        }

        "skills_install_atomic" => {
            let handle_id: String = required_aliased(&args, "handle_id", "handleId")?;
            let host = host.clone();
            let device_id = device_id.to_owned();
            tokio::task::spawn_blocking(move || {
                super::super::skill_transactions::install_atomic(&host, &device_id, &handle_id)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(skill_transaction_rpc_error)
            .and_then(to_json)
        }

        "skills_uninstall" => {
            let target: crate::skills::install::SkillsTarget = required(&args, "target")?;
            let dir_name: String = required_aliased(&args, "dir_name", "dirName")?;
            let host = host.clone();
            tokio::task::spawn_blocking(move || {
                super::super::skill_transactions::uninstall(&host, target, &dir_name)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(skill_transaction_rpc_error)
            .and_then(to_json)
        }

        "external_bridge_config_get" => {
            let data_dir = host.data_dir().map_err(external_bridge_rpc_error)?;
            tokio::task::spawn_blocking(move || {
                super::super::external_bridge::config_get(&data_dir)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(external_bridge_rpc_error)
            .and_then(to_json)
        }

        "external_bridge_config_update" => {
            let update: super::super::external_bridge::ExternalBridgeConfigUpdate =
                required(&args, "update")?;
            let data_dir = host.data_dir().map_err(external_bridge_rpc_error)?;
            let running = host.mcp_server_status().running;
            let bridge_data_dir = data_dir.clone();
            let updated = tokio::task::spawn_blocking(move || {
                super::super::external_bridge::config_update(&bridge_data_dir, update)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(external_bridge_rpc_error)?;
            if running {
                super::super::external_bridge::set_runtime_state(
                    &data_dir,
                    "degraded",
                    Some("configuration changed; restart required".into()),
                );
            }
            to_json(updated)
        }

        "external_bridge_client_create" => {
            let name: String = required(&args, "name")?;
            let scopes: Vec<String> = required(&args, "scopes")?;
            let expires_at: Option<u64> = optional_aliased(&args, "expires_at", "expiresAt")?;
            let data_dir = host.data_dir().map_err(external_bridge_rpc_error)?;
            let bridge_data_dir = data_dir.clone();
            let created = tokio::task::spawn_blocking(move || {
                super::super::external_bridge::client_create(
                    &bridge_data_dir,
                    name,
                    scopes,
                    expires_at,
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(external_bridge_rpc_error)?;
            sync_external_bridge_verifiers(host, &data_dir).await?;
            to_json(created)
        }

        "external_bridge_client_list" => {
            let data_dir = host.data_dir().map_err(external_bridge_rpc_error)?;
            tokio::task::spawn_blocking(move || {
                super::super::external_bridge::client_list(&data_dir)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(external_bridge_rpc_error)
            .and_then(to_json)
        }

        "external_bridge_client_rotate" => {
            let client_id: String = required_aliased(&args, "client_id", "clientId")?;
            let data_dir = host.data_dir().map_err(external_bridge_rpc_error)?;
            let bridge_data_dir = data_dir.clone();
            let rotated = tokio::task::spawn_blocking(move || {
                super::super::external_bridge::client_rotate(&bridge_data_dir, &client_id)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(external_bridge_rpc_error)?;
            sync_external_bridge_verifiers(host, &data_dir).await?;
            to_json(rotated)
        }

        "external_bridge_client_revoke" => {
            let client_id: String = required_aliased(&args, "client_id", "clientId")?;
            let data_dir = host.data_dir().map_err(external_bridge_rpc_error)?;
            let bridge_data_dir = data_dir.clone();
            let revoked = tokio::task::spawn_blocking(move || {
                super::super::external_bridge::client_revoke(&bridge_data_dir, &client_id)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(external_bridge_rpc_error)?;
            sync_external_bridge_verifiers(host, &data_dir).await?;
            to_json(revoked)
        }

        "external_bridge_start" => external_bridge_start_for_host(host, false).await,
        "external_bridge_restart" => external_bridge_start_for_host(host, true).await,
        "external_bridge_stop" => {
            use tauri::Manager;
            let data_dir = host.data_dir().map_err(external_bridge_rpc_error)?;
            let result = match host {
                super::super::dispatch_host::DispatchHost::Tauri(app) => {
                    crate::mcp_server::commands::mcp_server_stop_for_state(
                        app.state::<crate::mcp_server::McpServerState>().inner(),
                    )
                }
                super::super::dispatch_host::DispatchHost::Headless(services) => {
                    crate::mcp_server::commands::mcp_server_stop_for_state(
                        services.mcp_server.as_ref(),
                    )
                }
            };
            result.map_err(mcp_server_rpc_error)?;
            super::super::external_bridge::set_runtime_state(&data_dir, "stopped", None);
            Ok(Value::Null)
        }

        "external_bridge_status" => {
            let data_dir = host.data_dir().map_err(external_bridge_rpc_error)?;
            let server_status = host.mcp_server_status();
            tokio::task::spawn_blocking(move || {
                super::super::external_bridge::status(&data_dir, &server_status)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(external_bridge_rpc_error)
            .and_then(to_json)
        }

        "external_bridge_relay_enable" | "external_bridge_relay_disable" => {
            Err(external_bridge_rpc_error(
                "REMOTE_FEATURE_UNSUPPORTED: managed relay is not advertised by this host".into(),
            ))
        }

        "host_admin_lease_issue" => {
            let operations: Vec<String> = required(&args, "operations")?;
            let ttl_seconds: Option<u64> = optional_aliased(&args, "ttl_seconds", "ttlSeconds")?;
            let confirmed: bool = required(&args, "confirmed")?;
            let owner_authorized = if scope == Some("owner") || scope == Some("service") {
                true
            } else {
                account_id
                    .zip(super::super::security_store::security_store())
                    .is_some_and(|(tenant_id, security)| {
                        security
                            .has_capability(tenant_id, device_id, "host.admin")
                            .unwrap_or(false)
                    })
            };
            super::super::admin_lease::issue(
                device_id,
                operations,
                ttl_seconds,
                confirmed,
                owner_authorized,
            )
            .map_err(external_bridge_rpc_error)
            .and_then(to_json)
        }

        "host_admin_lease_revoke" => {
            super::super::admin_lease::revoke_device(device_id);
            Ok(Value::Null)
        }

        // ── MCP server ────────────────────────────────────────────────────────
        "mcp_server_start" | "mcp_server_restart" => {
            use tauri::Manager;

            let port: u16 = required(&args, "port")?;
            let token: String = required(&args, "token")?;
            let settings_json: String = required_aliased(&args, "settings_json", "settingsJson")?;
            if name == "mcp_server_restart" {
                match &host {
                    crate::companion_api::dispatch_host::DispatchHost::Tauri(app) => {
                        crate::mcp_server::commands::mcp_server_stop_for_state(
                            app.state::<crate::mcp_server::McpServerState>().inner(),
                        )
                        .map_err(mcp_server_rpc_error)?;
                    }
                    crate::companion_api::dispatch_host::DispatchHost::Headless(services) => {
                        crate::mcp_server::commands::mcp_server_stop_for_state(
                            services.mcp_server.as_ref(),
                        )
                        .map_err(mcp_server_rpc_error)?;
                    }
                }
            }

            match &host {
                crate::companion_api::dispatch_host::DispatchHost::Tauri(app) => {
                    // Same resolver the settings snippet reads, so the path we
                    // spawn and the path we tell the user to paste cannot
                    // diverge — they did, and neither existed.
                    let sidecar_path = crate::mcp_server::commands::resolve_sidecar_path(app)
                        .ok_or_else(|| {
                            RpcError::internal(
                                "External Bridge MCP sidecar is not installed (expected \
                                 sidecar/cognia-mcp.mjs in the app resources)"
                                    .to_string(),
                            )
                        })?;
                    let automation = app.state::<crate::automation::commands::AutomationState>();
                    app.state::<crate::mcp_server::McpServerState>()
                        .start(
                            port,
                            token,
                            settings_json,
                            sidecar_path.to_string_lossy().into_owned(),
                            Some((
                                automation.handle.clone(),
                                crate::automation::dispatcher::Enforcement::from_state(&automation),
                            )),
                            Some(crate::mcp_server::orchestration_proxy::tauri_event_sink(
                                app.clone(),
                            )),
                        )
                        .await
                        .map(|bound| json!(bound))
                        .map_err(mcp_server_rpc_error)
                }
                crate::companion_api::dispatch_host::DispatchHost::Headless(services) => {
                    crate::mcp_server::commands::mcp_server_start_for_state(
                        services.mcp_server.as_ref(),
                        port,
                        token,
                        settings_json,
                        crate::headless::resolve_mcp_sidecar_path()
                            .to_string_lossy()
                            .into_owned(),
                        None,
                        Some(headless_orchestration_event_sink()),
                    )
                    .await
                    .map(|bound| json!(bound))
                    .map_err(mcp_server_rpc_error)
                }
            }
        }
        "mcp_server_stop" => match &host {
            crate::companion_api::dispatch_host::DispatchHost::Tauri(app) => {
                use tauri::Manager;
                crate::mcp_server::commands::mcp_server_stop_for_state(
                    app.state::<crate::mcp_server::McpServerState>().inner(),
                )
                .map(|_| Value::Null)
                .map_err(mcp_server_rpc_error)
            }
            crate::companion_api::dispatch_host::DispatchHost::Headless(services) => {
                crate::mcp_server::commands::mcp_server_stop_for_state(services.mcp_server.as_ref())
                    .map(|_| Value::Null)
                    .map_err(mcp_server_rpc_error)
            }
        },
        "mcp_server_status" => {
            let status = host.mcp_server_status();
            serde_json::to_value(status).map_err(|e| RpcError::internal(e.to_string()))
        }
        "mcp_oauth_status" => {
            let account_id = account_id.ok_or_else(|| {
                RpcError::forbidden("MCP OAuth requires an account-bound service principal")
            })?;
            let server_name: String = required_aliased(&args, "server_name", "serverName")?;
            crate::mcp_oauth::headless_status(account_id, &server_name)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "mcp_oauth_load_entry" => {
            let account_id = account_id.ok_or_else(|| {
                RpcError::forbidden("MCP OAuth requires an account-bound service principal")
            })?;
            let server_name: String = required_aliased(&args, "server_name", "serverName")?;
            crate::mcp_oauth::headless_load_entry(account_id, &server_name)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "mcp_oauth_authenticate" => {
            let account_id = account_id.ok_or_else(|| {
                RpcError::forbidden("MCP OAuth requires an account-bound service principal")
            })?;
            let server_name: String = required_aliased(&args, "server_name", "serverName")?;
            let server: Value = required(&args, "server")?;
            crate::mcp_oauth::headless_authenticate(account_id, &server_name, server)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "mcp_oauth_refresh" => {
            let account_id = account_id.ok_or_else(|| {
                RpcError::forbidden("MCP OAuth requires an account-bound service principal")
            })?;
            let server_name: String = required_aliased(&args, "server_name", "serverName")?;
            let server: Value = required(&args, "server")?;
            crate::mcp_oauth::headless_refresh(account_id, &server_name, server)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "mcp_oauth_clear" => {
            let account_id = account_id.ok_or_else(|| {
                RpcError::forbidden("MCP OAuth requires an account-bound service principal")
            })?;
            let server_name: String = required_aliased(&args, "server_name", "serverName")?;
            crate::mcp_oauth::headless_clear(account_id, &server_name)
                .await
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
