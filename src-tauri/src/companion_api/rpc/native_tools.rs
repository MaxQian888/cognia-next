use super::*;

pub(super) const COMMANDS: &[&str] = &[
    "ocr_list_native_backends",
    "ocr_list_available_backends",
    "ocr_extract_native",
    "ocr_model_status",
    "ocr_download_model",
    "ocr_cancel_model_download",
    // Which agent runtimes this Host already has. A read of this machine, so it
    // answers here rather than riding the generic renderer bridge the
    // `external_agent_config_*` arms use: the browser asking has no PATH.
    "external_agent_detect_runtimes",
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
    "host_consent_pending",
    "host_consent_respond",
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
    let _ = (state, host, device_id, account_id, scope);
    let result = match name {
        // ── Native OCR service plane ────────────────────────────────────────
        //
        // Host-neutral through `DispatchHost::ocr_registry()`: both hosts own a
        // `NativeOcrRegistry` (the desktop `.manage()`s one at boot, the headless
        // container installs its compiled backends lazily), and the registry
        // itself already subtracts the OS-bound `apple-vision` /
        // `windows-media-ocr` backends where they cannot run. There is nothing
        // desktop-only about the arms, only about two of the backends.
        "external_agent_detect_runtimes" => {
            to_json(crate::external_agent::version_probe::detect_runtimes().await)
        }

        "ocr_list_native_backends" => {
            let ids = host
                .ocr_registry()
                .await
                .list_ids()
                .await
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>();
            to_json(ids)
        }

        "ocr_list_available_backends" => {
            let ids = host
                .ocr_registry()
                .await
                .available_ids()
                .await
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>();
            to_json(ids)
        }

        "ocr_extract_native" => {
            let payload: crate::ocr::NativeOcrInvokePayload = required(&args, "payload")?;
            let result = host
                .ocr_registry()
                .await
                .dispatch(&payload)
                .await
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
            // Progress delivery is the only host-specific part, and
            // `ocr_progress_emitter()` owns that split; the download itself is
            // the same code on both hosts.
            let result = crate::ocr::native::ocr_download_model_with_emitter(
                backend,
                variant,
                request_id,
                host.ocr_progress_emitter(),
            )
            .await
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
            let owner_authorized = host_admin_authorized(device_id, account_id, scope);

            // `confirmed` is deliberately NOT read from the arguments any more.
            // It was a bool the caller sent and the host checked, which is not
            // a check — the only client wrote `true` unconditionally, and
            // `authorize_approval` special-cased this command so its
            // `approval: interactive` never met a real gate. The confirmation
            // is now something the host obtains; see `host_consent`.
            let confirmed = match scope {
                // Outside the device plane entirely: the loopback service
                // principal IS the Brain plane's authority, and `owner` is the
                // Owner API's DPoP-proved principal. Neither has anyone to ask,
                // and neither can be impersonated by a paired device.
                Some("service") | Some("owner") => true,
                // The tenant's Owner DEVICE is the deployment's trust root, and
                // on `_rpc` it arrives with `scope: "device"` like everyone
                // else. Asking it for someone else's approval is a bootstrap
                // deadlock: a fresh headless deployment has exactly one paired
                // device, and requiring a second one to exist before the first
                // can configure anything means nothing can ever be configured.
                // Asking it to approve ITSELF is the self-attestation this
                // whole change removes. So it is trusted, and every non-Owner
                // device is not — which is also decision L23: configuring a
                // connector is administrator work.
                _ if is_owner_device(device_id, account_id) => true,
                _ => super::super::host_consent::take_approved(device_id, &operations),
            };

            if !confirmed {
                let ask =
                    super::super::host_consent::request(device_id, account_id, operations.clone());
                host.publish_host_event(
                    super::super::host_consent::CONSENT_CHANNEL,
                    serde_json::to_value(&ask).unwrap_or(Value::Null),
                );
                // 428, and the code travels in the message so a console
                // approver has something to type. The requester retries; the
                // ask is idempotent, so retrying does not queue a second one.
                Err(external_bridge_rpc_error(format!(
                    "REMOTE_CONSENT_REQUIRED: this device needs approval on the host (code {})",
                    ask.code
                )))
            } else {
                super::super::admin_lease::issue(
                    device_id,
                    operations,
                    ttl_seconds,
                    owner_authorized,
                )
                .map_err(external_bridge_rpc_error)
                .and_then(to_json)
            }
        }

        "host_admin_lease_revoke" => {
            super::super::admin_lease::revoke_device(device_id);
            // An open ask outlives nothing: a device that just gave up its
            // leases has no business collecting an approval granted for them.
            super::super::host_consent::forget_device(device_id);
            Ok(Value::Null)
        }

        // ── Host escalation consent (ADR-0153) ───────────────────────────────
        //
        // The approver side of `host_admin_lease_issue`. Both arms are host
        // admin work, so both need `host.admin`; NEITHER requires an admin
        // lease, because a lease is the thing being approved and requiring one
        // to grant one is a loop with no entry.
        "host_consent_pending" => {
            if !host_admin_authorized(device_id, account_id, scope) {
                return Err(external_bridge_rpc_error(
                    "REMOTE_SCOPE_DENIED: listing escalation requests requires host.admin".into(),
                ));
            }
            let open = super::super::host_consent::pending();
            // A device is shown only what it may answer. The self-approval rule
            // lives in `host_consent::resolve`, but a list that included the
            // caller's own ask would offer an action the host is about to
            // refuse — and on the requesting device that row is the one the
            // operator is most likely to tap.
            let visible: Vec<_> = match scope {
                Some("service") | Some("owner") => open,
                _ => open
                    .into_iter()
                    .filter(|entry| entry.device_id != device_id)
                    .collect(),
            };
            to_json(visible)
        }

        "host_consent_respond" => {
            if !host_admin_authorized(device_id, account_id, scope) {
                return Err(external_bridge_rpc_error(
                    "REMOTE_SCOPE_DENIED: answering an escalation request requires host.admin"
                        .into(),
                ));
            }
            let request_id: String = required_aliased(&args, "request_id", "requestId")?;
            let approve: bool = required(&args, "approve")?;
            // A device answers as itself so it cannot answer for itself; the
            // desktop operator and the host console answer as the host.
            let approver = match scope {
                Some("service") | Some("owner") => super::super::host_consent::Approver::Host,
                _ => super::super::host_consent::Approver::Device(device_id),
            };
            let answered = super::super::host_consent::resolve(&request_id, approve, approver)
                .map_err(external_bridge_rpc_error)?;
            // Same channel as the ask: an approver surface elsewhere needs to
            // drop the row it is still showing.
            host.publish_host_event(
                super::super::host_consent::CONSENT_CHANNEL,
                serde_json::to_value(&answered).unwrap_or(Value::Null),
            );
            to_json(answered)
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

/// Whether this caller may act as a host administrator.
///
/// `owner` and `service` are off the device plane — the desktop operator and
/// the loopback console — so they pass without a capability lookup. Everyone
/// else is a paired device and needs `host.admin` granted to it explicitly,
/// which is what keeps a multi-tenant member device out of the escalation path
/// entirely (decision L23).
fn host_admin_authorized(device_id: &str, account_id: Option<&str>, scope: Option<&str>) -> bool {
    if scope == Some("owner") || scope == Some("service") {
        return true;
    }
    account_id
        .zip(super::super::security_store::security_store())
        .is_some_and(|(tenant_id, security)| {
            security
                .has_capability(tenant_id, device_id, "host.admin")
                .unwrap_or(false)
        })
}

/// Whether this caller is the tenant's Owner device.
///
/// Separate from [`host_admin_authorized`] on purpose: `host.admin` is a
/// capability an Owner may grant to a member, and a member holding it still
/// needs someone to approve its escalations. Only the Owner is the root.
fn is_owner_device(device_id: &str, account_id: Option<&str>) -> bool {
    account_id
        .zip(super::super::security_store::security_store())
        .is_some_and(|(tenant_id, security)| {
            security
                .is_owner_device(tenant_id, device_id)
                .unwrap_or(false)
        })
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
