use super::*;

pub(super) const COMMANDS: &[&str] = &[
    "spawn_external_agent",
    "send_to_external_agent",
    "kill_external_agent",
    "get_external_agent_status",
    "connectors_register",
    "connectors_unregister",
    "connectors_list_adapters",
    "connectors_runtime_lease_acquire",
    "connectors_runtime_lease_renew",
    "connectors_runtime_lease_release",
    "integration_ingress_register",
    "integration_ingress_unregister",
    "integration_ingress_get_url",
    "integration_ingress_poll",
    "integration_ingress_deadletters",
    "integration_ingress_deadletter",
    "integration_ingress_requeue",
    "github_workspace_clone",
    "github_workspace_commit_and_push",
    "github_workspace_remove",
    "github_workspace_stat",
    "integration_ingress_ack",
    "integration_ingress_nack",
    "provider_profiles_list",
    "provider_profiles_import",
    "provider_profiles_version",
    "provider_catalog_status",
    "provider_catalog_search",
    "provider_catalog_refresh",
    "connectors_health",
    "connectors_keyring_set",
    "connectors_keyring_get",
    "connectors_keyring_delete",
    "connectors_keyring_list",
    "connectors_http_request",
    "connectors_ws_open",
    "connectors_ws_send",
    "connectors_ws_close",
    "connectors_onebot_send",
    "connectors_onebot_probe",
    "connectors_discord_upload",
    "connectors_lark_ws_open",
    "connectors_lark_ws_close",
    "connectors_reset_all_ws",
    "connectors_attachment_fetch",
    "connectors_attachment_read",
    "connectors_attachment_list",
    "connectors_attachment_delete",
    "connectors_attachment_evict_adapter",
    "connectors_attachment_enforce_budget",
    "connectors_media_upload",
    "connectors_matrix_crypto_init",
    "connectors_matrix_crypto_close",
    "connectors_matrix_crypto_outgoing_requests",
    "connectors_matrix_crypto_mark_request_sent",
    "connectors_matrix_crypto_receive_sync_changes",
    "connectors_matrix_crypto_decrypt_event",
    "connectors_matrix_crypto_encrypt_event",
    "connectors_matrix_crypto_share_room_key",
    "connectors_matrix_crypto_update_tracked_users",
    "connectors_matrix_crypto_get_missing_sessions",
    "connectors_matrix_encrypted_media_upload",
    "connectors_matrix_encrypted_media_fetch",
    "connectors_lark_upload_file",
    "connectors_lark_upload_image",
    "automation_consent_respond",
    "automation_consent_pending",
    "companion_can_control",
    "companion_endpoints",
    "app_settings_update",
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
        // ── Headless external-agent execution plane (ADR-0059 R11) ───────────
        // Service-scope only (gated above + in rpc_handler); every decision
        // is written to the audit log. The spawn request must clear the
        // SpawnPolicy preset allowlist before it touches the exec backend.
        "spawn_external_agent" => {
            let policy = host.remote_spawn_policy().map_err(RpcError::internal)?;
            let config: crate::external_agent::process::ExternalAgentSpawnConfig =
                required(&args, "config")?;
            let summary = serde_json::json!({
                "agent_id": config.id,
                "command": config.command,
                "args": config.args,
            });
            match policy.validate(config) {
                Err(violation) => {
                    let mut fields = summary;
                    fields["reason"] = Value::String(violation.to_string());
                    super::super::audit::record_async(
                        "external_agent_spawn",
                        device_id,
                        scope.unwrap_or(""),
                        "deny",
                        fields,
                    )
                    .await;
                    Err(RpcError::forbidden(format!(
                        "spawn denied by policy: {violation}"
                    )))
                }
                Ok(validated) => {
                    let mut fields = summary;
                    fields["cwd"] = Value::String(validated.config.cwd.clone().unwrap_or_default());
                    fields["dropped_env_keys"] =
                        serde_json::to_value(&validated.dropped_env_keys).unwrap_or(Value::Null);
                    super::super::audit::record_async(
                        "external_agent_spawn",
                        device_id,
                        scope.unwrap_or(""),
                        "allow",
                        fields,
                    )
                    .await;
                    // Confinement is the host's business: the desktop wraps the
                    // child in its sandbox host exactly as the local Tauri
                    // command does; the container relies on its ExecBackend.
                    let hardened = host
                        .harden_spawn_config(validated.config)
                        .map_err(RpcError::internal)?;
                    crate::external_agent::exec_backend::spawn_with_events(
                        host.exec_backend().as_ref(),
                        host.agent_event_emitter(),
                        hardened,
                    )
                    .await
                    .map(Value::String)
                    .map_err(RpcError::internal)
                }
            }
        }

        "send_to_external_agent" => {
            let agent_id: String = required_aliased(&args, "agent_id", "agentId")?;
            let message: String = required(&args, "message")?;
            super::super::audit::record_async(
                "external_agent_send",
                device_id,
                scope.unwrap_or(""),
                "allow",
                serde_json::json!({ "agent_id": agent_id, "bytes": message.len() }),
            )
            .await;
            host.exec_backend()
                .send(&agent_id, &message)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "kill_external_agent" => {
            let agent_id: String = required_aliased(&args, "agent_id", "agentId")?;
            super::super::audit::record_async(
                "external_agent_kill",
                device_id,
                scope.unwrap_or(""),
                "allow",
                serde_json::json!({ "agent_id": agent_id }),
            )
            .await;
            host.exec_backend()
                .kill(&agent_id)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "get_external_agent_status" => {
            let agent_id: String = required_aliased(&args, "agent_id", "agentId")?;
            match host.exec_backend().status(&agent_id).await {
                Some(status) => Ok(Value::String(format!("{status:?}"))),
                None => Err(RpcError::internal(format!("Agent {agent_id} not found"))),
            }
        }

        // ── Connector webhook ingress registry (ADR-0059 F4 / R12) ───────────
        // The brain registers its adapters here so the public `/connectors`
        // routes on the front door can verify + forward platform webhooks.
        "connectors_register" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let adapter_id: String = required(&args, "adapter_id")?;
            let adapter_type: String = required(&args, "adapter_type")?;
            services.connectors.inner.lock().registered_adapters.insert(
                adapter_id.clone(),
                crate::connectors::types::AdapterRegistration {
                    adapter_id,
                    adapter_type,
                    webhook_path: None,
                },
            );
            Ok(Value::Null)
        }

        "connectors_unregister" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let adapter_id: String = required(&args, "adapter_id")?;
            services
                .connectors
                .inner
                .lock()
                .registered_adapters
                .remove(&adapter_id);
            Ok(Value::Null)
        }

        "connectors_list_adapters" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let adapters: Vec<Value> = services
                .connectors
                .inner
                .lock()
                .registered_adapters
                .values()
                .map(|reg| {
                    serde_json::json!({
                        "adapter_id": reg.adapter_id,
                        "adapter_type": reg.adapter_type,
                    })
                })
                .collect();
            Ok(serde_json::json!({ "adapters": adapters }))
        }

        "connectors_runtime_lease_acquire" => {
            let owner_id: String = required_aliased(&args, "owner_id", "ownerId")?;
            let ttl_ms: u64 = required_aliased(&args, "ttl_ms", "ttlMs")?;
            let handoff_aware: bool =
                optional_aliased(&args, "handoff_aware", "handoffAware")?.unwrap_or(false);
            if handoff_aware {
                let outcome = host
                    .connectors_state()
                    .acquire_runtime_lease_outcome(&owner_id, ttl_ms)
                    .map_err(RpcError::validation_failed)?;
                Ok(Value::String(outcome.as_str().to_string()))
            } else {
                // Legacy callers cannot acknowledge a handoff, so their
                // boolean claim is non-preemptive and side-effect free while
                // another owner is live.
                host.connectors_state()
                    .acquire_runtime_lease(&owner_id, ttl_ms)
                    .map(Value::Bool)
                    .map_err(RpcError::validation_failed)
            }
        }

        "connectors_runtime_lease_renew" => {
            let owner_id: String = required_aliased(&args, "owner_id", "ownerId")?;
            let ttl_ms: u64 = required_aliased(&args, "ttl_ms", "ttlMs")?;
            let renewed = host
                .connectors_state()
                .renew_runtime_lease(&owner_id, ttl_ms)
                .map_err(RpcError::validation_failed)?;
            Ok(Value::Bool(renewed))
        }

        "connectors_runtime_lease_release" => {
            let owner_id: String = required_aliased(&args, "owner_id", "ownerId")?;
            let released = host
                .connectors_state()
                .release_runtime_lease(&owner_id)
                .map_err(RpcError::validation_failed)?;
            Ok(Value::Bool(released))
        }

        // ── Marketplace Integration ingress + encrypted spool ───────────────
        // Both hosts execute the same scheduling-crate command bodies. The
        // service-token gate above keeps webhook material and route secrets
        // inaccessible to paired-device principals.
        "integration_ingress_register" => {
            let input: crate::workflow::triggers::webhook_router::IntegrationIngressEntry =
                required(&args, "input")?;
            let result = match host {
                super::super::dispatch_host::DispatchHost::Tauri(app) => {
                    let workflow = app.state::<crate::workflow::WorkflowState>();
                    crate::workflow::commands::integration_ingress_register_for_state(
                        workflow.inner(),
                        input,
                    )
                }
                super::super::dispatch_host::DispatchHost::Headless(services) => {
                    crate::workflow::commands::integration_ingress_register_for_state(
                        services.workflow.as_ref(),
                        input,
                    )
                }
            }
            .map_err(RpcError::internal)?;
            to_json(result)
        }

        "integration_ingress_unregister" => {
            let route_id: String = required_aliased(&args, "route_id", "routeId")?;
            match host {
                super::super::dispatch_host::DispatchHost::Tauri(app) => {
                    let workflow = app.state::<crate::workflow::WorkflowState>();
                    crate::workflow::commands::integration_ingress_unregister_for_state(
                        workflow.inner(),
                        route_id,
                    )
                }
                super::super::dispatch_host::DispatchHost::Headless(services) => {
                    crate::workflow::commands::integration_ingress_unregister_for_state(
                        services.workflow.as_ref(),
                        route_id,
                    )
                }
            }
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }

        "integration_ingress_get_url" => {
            let route_id: String = required_aliased(&args, "route_id", "routeId")?;
            let result = match host {
                super::super::dispatch_host::DispatchHost::Tauri(app) => {
                    let workflow = app.state::<crate::workflow::WorkflowState>();
                    crate::workflow::commands::integration_ingress_get_url_for_state(
                        workflow.inner(),
                        route_id,
                    )
                }
                super::super::dispatch_host::DispatchHost::Headless(services) => {
                    crate::workflow::commands::integration_ingress_get_url_for_state(
                        services.workflow.as_ref(),
                        route_id,
                    )
                }
            }
            .map_err(RpcError::internal)?;
            to_json(result)
        }

        "integration_ingress_poll" => {
            let limit: Option<usize> = optional(&args, "limit")?;
            let result = match host {
                super::super::dispatch_host::DispatchHost::Tauri(app) => {
                    let workflow = app.state::<crate::workflow::WorkflowState>();
                    crate::workflow::commands::integration_ingress_poll_for_state(
                        workflow.inner(),
                        limit,
                    )
                }
                super::super::dispatch_host::DispatchHost::Headless(services) => {
                    crate::workflow::commands::integration_ingress_poll_for_state(
                        services.workflow.as_ref(),
                        limit,
                    )
                }
            }
            .map_err(RpcError::internal)?;
            to_json(result)
        }

        "integration_ingress_deadletters" => {
            let limit: Option<usize> = optional(&args, "limit")?;
            let result = match host {
                super::super::dispatch_host::DispatchHost::Tauri(app) => {
                    let workflow = app.state::<crate::workflow::WorkflowState>();
                    crate::workflow::commands::integration_ingress_deadletters_for_state(
                        workflow.inner(),
                        limit,
                    )
                }
                super::super::dispatch_host::DispatchHost::Headless(services) => {
                    crate::workflow::commands::integration_ingress_deadletters_for_state(
                        services.workflow.as_ref(),
                        limit,
                    )
                }
            }
            .map_err(RpcError::internal)?;
            to_json(result)
        }

        "integration_ingress_deadletter" => {
            let route_id: String = required_aliased(&args, "route_id", "routeId")?;
            let delivery_id: String = required_aliased(&args, "delivery_id", "deliveryId")?;
            let result = match host {
                super::super::dispatch_host::DispatchHost::Tauri(app) => {
                    let workflow = app.state::<crate::workflow::WorkflowState>();
                    crate::workflow::commands::integration_ingress_deadletter_for_state(
                        workflow.inner(),
                        route_id,
                        delivery_id,
                    )
                }
                super::super::dispatch_host::DispatchHost::Headless(services) => {
                    crate::workflow::commands::integration_ingress_deadletter_for_state(
                        services.workflow.as_ref(),
                        route_id,
                        delivery_id,
                    )
                }
            }
            .map_err(RpcError::internal)?;
            to_json(result)
        }

        "integration_ingress_requeue" => {
            let route_id: String = required_aliased(&args, "route_id", "routeId")?;
            let delivery_id: String = required_aliased(&args, "delivery_id", "deliveryId")?;
            let result = match host {
                super::super::dispatch_host::DispatchHost::Tauri(app) => {
                    let workflow = app.state::<crate::workflow::WorkflowState>();
                    crate::workflow::commands::integration_ingress_requeue_for_state(
                        workflow.inner(),
                        route_id,
                        delivery_id,
                    )
                }
                super::super::dispatch_host::DispatchHost::Headless(services) => {
                    crate::workflow::commands::integration_ingress_requeue_for_state(
                        services.workflow.as_ref(),
                        route_id,
                        delivery_id,
                    )
                }
            }
            .map_err(RpcError::internal)?;
            to_json(result)
        }

        "github_workspace_clone" => {
            let command_args: crate::github::workspace::CloneArgs = required(&args, "args")?;
            crate::github::workspace::github_workspace_clone(command_args)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }

        "github_workspace_commit_and_push" => {
            let command_args: crate::github::workspace::CommitAndPushArgs =
                required(&args, "args")?;
            crate::github::workspace::github_workspace_commit_and_push(command_args)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }

        "github_workspace_remove" => {
            let path: String = required(&args, "path")?;
            crate::github::workspace::github_workspace_remove(path)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }

        "github_workspace_stat" => {
            let path: String = required(&args, "path")?;
            crate::github::workspace::github_workspace_stat(path)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }

        "integration_ingress_ack" | "integration_ingress_nack" => {
            let route_id: String = required_aliased(&args, "route_id", "routeId")?;
            let delivery_id: String = required_aliased(&args, "delivery_id", "deliveryId")?;
            let result = match host {
                super::super::dispatch_host::DispatchHost::Tauri(app) => {
                    let workflow = app.state::<crate::workflow::WorkflowState>();
                    if name == "integration_ingress_ack" {
                        crate::workflow::commands::integration_ingress_ack_for_state(
                            workflow.inner(),
                            route_id,
                            delivery_id,
                        )
                    } else {
                        crate::workflow::commands::integration_ingress_nack_for_state(
                            workflow.inner(),
                            route_id,
                            delivery_id,
                        )
                    }
                }
                super::super::dispatch_host::DispatchHost::Headless(services) => {
                    if name == "integration_ingress_ack" {
                        crate::workflow::commands::integration_ingress_ack_for_state(
                            services.workflow.as_ref(),
                            route_id,
                            delivery_id,
                        )
                    } else {
                        crate::workflow::commands::integration_ingress_nack_for_state(
                            services.workflow.as_ref(),
                            route_id,
                            delivery_id,
                        )
                    }
                }
            };
            result.map(|_| Value::Null).map_err(RpcError::internal)
        }

        // ── Provider Profile Store admin plane (ADR-0090 Phase 1) ───────────
        // Service-scope only (SERVICE_ONLY_COMMANDS). The store is sync
        // rusqlite behind a parking_lot Mutex — each arm runs the whole
        // operation inside spawn_blocking so no guard crosses an .await.
        "provider_profiles_list" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let profiles = std::sync::Arc::clone(&services.profiles);
            tokio::task::spawn_blocking(move || profiles.export_redacted())
                .await
                .map_err(|e| RpcError::internal(format!("profiles export join: {e}")))?
                .map_err(|e| RpcError::internal(format!("profiles export: {e}")))
        }

        "provider_profiles_import" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let payload = args
                .get("payload")
                .cloned()
                .ok_or_else(|| RpcError::malformed("missing 'payload'".to_string()))?;
            let profiles = std::sync::Arc::clone(&services.profiles);
            let version = tokio::task::spawn_blocking(move || profiles.import(&payload))
                .await
                .map_err(|e| RpcError::internal(format!("profiles import join: {e}")))?
                .map_err(|e| RpcError::malformed(format!("profiles import: {e}")))?;
            Ok(serde_json::json!({ "profileVersion": version }))
        }

        "provider_profiles_version" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let profiles = std::sync::Arc::clone(&services.profiles);
            let version = tokio::task::spawn_blocking(move || profiles.profile_version())
                .await
                .map_err(|e| RpcError::internal(format!("profiles version join: {e}")))?
                .map_err(|e| RpcError::internal(format!("profiles version: {e}")))?;
            Ok(serde_json::json!({ "profileVersion": version }))
        }

        "provider_catalog_status" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let profiles = std::sync::Arc::clone(&services.profiles);
            let status = tokio::task::spawn_blocking(move || profiles.catalog_status())
                .await
                .map_err(|e| RpcError::internal(format!("catalog status join: {e}")))?
                .map_err(|e| RpcError::internal(format!("catalog status: {e}")))?;
            serde_json::to_value(status)
                .map_err(|e| RpcError::internal(format!("catalog status serialization: {e}")))
        }

        "provider_catalog_search" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let query = args
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if query.len() > 512 {
                return Err(RpcError::malformed(
                    "catalog search query exceeds 512 bytes".to_string(),
                ));
            }
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(50)
                .try_into()
                .unwrap_or(200);
            let profiles = std::sync::Arc::clone(&services.profiles);
            let results =
                tokio::task::spawn_blocking(move || profiles.catalog_search(&query, limit))
                    .await
                    .map_err(|e| RpcError::internal(format!("catalog search join: {e}")))?
                    .map_err(|e| RpcError::internal(format!("catalog search: {e}")))?;
            Ok(serde_json::json!({ "results": results }))
        }

        "provider_catalog_refresh" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let payload = args
                .get("payload")
                .cloned()
                .ok_or_else(|| RpcError::malformed("missing 'payload'".to_string()))?;
            let snapshot: crate::provider_profiles::CatalogSnapshotDoc =
                serde_json::from_value(payload)
                    .map_err(|e| RpcError::malformed(format!("catalog refresh payload: {e}")))?;
            let profiles = std::sync::Arc::clone(&services.profiles);
            let status = tokio::task::spawn_blocking(move || profiles.catalog_refresh(&snapshot))
                .await
                .map_err(|e| RpcError::internal(format!("catalog refresh join: {e}")))?
                .map_err(|e| RpcError::malformed(format!("catalog refresh: {e}")))?;
            serde_json::to_value(status)
                .map_err(|e| RpcError::internal(format!("catalog refresh serialization: {e}")))
        }

        // ── Connector command plane for the headless brain (ADR-0059 T-A5) ──
        // The brain's connector-runtime routes the `connectors_*` TS wrappers
        // here (same names, camelCase args verbatim). Every arm delegates to
        // the SAME free function its Tauri command wraps — the desktop path
        // (src/connectors/commands.rs) stays untouched and no logic is
        // duplicated. `required_aliased` accepts the snake_case spelling too
        // for parity with the R12 register/unregister arms.
        "connectors_health" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let count = services.connectors.inner.lock().registered_adapters.len();
            // On the headless front door the `/connectors` ingress router is
            // mounted by the companion server itself — there is no separately
            // started local axum server (and thus no distinct bound address).
            to_json(crate::connectors::types::ConnectorsHealth {
                server_running: true,
                bound_addr: None,
                registered_adapter_count: count,
            })
        }

        "connectors_keyring_set" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let credential: String = required(&args, "credential")?;
            let value: String = required(&args, "value")?;
            tokio::task::spawn_blocking(move || {
                crate::connectors::keyring::set(&adapter_id, &credential, &value)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_keyring_get" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let credential: String = required(&args, "credential")?;
            let value = tokio::task::spawn_blocking(move || {
                crate::connectors::keyring::get(&adapter_id, &credential)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            to_json(value)
        }

        "connectors_keyring_delete" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let credential: String = required(&args, "credential")?;
            tokio::task::spawn_blocking(move || {
                crate::connectors::keyring::delete(&adapter_id, &credential)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_keyring_list" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let accounts: Vec<String> = required(&args, "accounts")?;
            let present = tokio::task::spawn_blocking(move || {
                crate::connectors::keyring::list(&adapter_id, &accounts)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            to_json(present)
        }

        "connectors_http_request" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: crate::connectors::types::TauriHttpRequest = required(&args, "req")?;
            let resp = crate::connectors::http_client::http_request(req)
                .await
                .map_err(RpcError::internal)?;
            to_json(resp)
        }

        "connectors_ws_open" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let url: String = required(&args, "url")?;
            let headers: Option<std::collections::HashMap<String, String>> =
                optional(&args, "headers")?;
            let emitter = std::sync::Arc::new(super::super::event_bus::ConnectorEventEmitter(
                std::sync::Arc::clone(&services.event_bus),
            ));
            let handle_id = crate::connectors::ws_client::open_ws(emitter, url, headers)
                .await
                .map_err(RpcError::internal)?;
            to_json(handle_id)
        }

        "connectors_ws_send" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let handle_id: String = required_aliased(&args, "handle_id", "handleId")?;
            let data: String = required(&args, "data")?;
            crate::connectors::ws_client::ws_send(&handle_id, data)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_ws_close" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let handle_id: String = required_aliased(&args, "handle_id", "handleId")?;
            crate::connectors::ws_client::ws_close(&handle_id)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_onebot_send" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let call_json: String = required_aliased(&args, "call_json", "callJson")?;
            crate::connectors::ws_server::send(&adapter_id, call_json)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        // ADR-0131 — reverse-WS OneBot liveness probe. Deliberately NOT gated
        // on `host.headless()`: it reads the in-process WS registry, which
        // exists on the desktop shell too, and a host gate would add a
        // class-C host-parity entry (that baseline may only shrink).
        "connectors_onebot_probe" => to_json(crate::connectors::ws_server::live_clients()),

        // ADR-0131 — Discord multipart upload. Same reasoning as the probe:
        // pure HTTP against Discord, no AppHandle, so no host gate.
        "connectors_discord_upload" => {
            let req: crate::connectors::discord_upload::ConnectorDiscordUploadRequest =
                serde_json::from_value(args).map_err(|e| {
                    RpcError::malformed(format!("connectors_discord_upload args: {e}"))
                })?;
            let message_id = crate::connectors::discord_upload::upload(req)
                .await
                .map_err(RpcError::internal)?;
            to_json(message_id)
        }

        "connectors_lark_ws_open" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let emitter = std::sync::Arc::new(super::super::event_bus::ConnectorEventEmitter(
                std::sync::Arc::clone(&services.event_bus),
            ));
            let handle_id = crate::connectors::lark_ws::open(emitter, adapter_id)
                .await
                .map_err(RpcError::internal)?;
            to_json(handle_id)
        }

        "connectors_lark_ws_close" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let handle_id: String = required_aliased(&args, "handle_id", "handleId")?;
            crate::connectors::lark_ws::close(&handle_id)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_reset_all_ws" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let count = crate::connectors::commands::connectors_reset_all_ws()
                .await
                .map_err(RpcError::internal)?;
            to_json(count)
        }

        "connectors_attachment_fetch" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let remote_ref: String = required_aliased(&args, "remote_ref", "remoteRef")?;
            let source_url: String = required_aliased(&args, "source_url", "sourceUrl")?;
            let headers: Option<std::collections::HashMap<String, String>> =
                optional(&args, "headers")?;
            // Absent means "use the 7-day default"; an explicit `0` means
            // "never expires, LRU only". Both must reach the cache, so this
            // stays an Option rather than being defaulted here.
            let ttl_ms: Option<u64> = optional_aliased(&args, "ttl_ms", "ttlMs")?;
            let attachment = crate::connectors::attachments::fetch_attachment(
                adapter_id, remote_ref, source_url, headers, ttl_ms,
            )
            .await
            .map_err(RpcError::internal)?;
            to_json(attachment)
        }

        "connectors_attachment_read" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let remote_ref: String = required_aliased(&args, "remote_ref", "remoteRef")?;
            let max_bytes: u64 = required_aliased(&args, "max_bytes", "maxBytes")?;
            let bytes = crate::connectors::attachments::read_attachment_base64(
                &adapter_id,
                &remote_ref,
                max_bytes,
            )
            .map_err(RpcError::internal)?;
            to_json(bytes)
        }

        // Cache upkeep — the sweep `lib/connectors/housekeeping-scheduler.ts`
        // runs every cycle. Deliberately NOT gated on `host.headless()` the way
        // the two arms above are: `crate::connectors::attachments` resolves its
        // directory from `dirs::data_dir()` and takes no host handle — the
        // desktop `#[tauri::command]` wrappers call these very functions with no
        // AppHandle — so refusing a desktop host would deny a request it is
        // perfectly able to serve. Reach is already bounded by
        // SERVICE_ONLY_COMMANDS: only a loopback service token arrives here.
        //
        // Each helper walks and rewrites the cache directory synchronously, so
        // it runs on the blocking pool rather than stalling the reactor — the
        // same shape the Tauri wrappers use.
        "connectors_attachment_list" => {
            let entries =
                tokio::task::spawn_blocking(crate::connectors::attachments::list_attachments)
                    .await
                    .map_err(|error| {
                        RpcError::internal(format!("attachment list task failed: {error}"))
                    })?
                    .map_err(RpcError::internal)?;
            to_json(entries)
        }

        "connectors_attachment_delete" => {
            let cache_keys: Vec<String> = required_aliased(&args, "cache_keys", "cacheKeys")?;
            let report = tokio::task::spawn_blocking(move || {
                crate::connectors::attachments::delete_attachments(cache_keys)
            })
            .await
            .map_err(|error| RpcError::internal(format!("attachment delete task failed: {error}")))?
            .map_err(RpcError::internal)?;
            to_json(report)
        }

        "connectors_attachment_evict_adapter" => {
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let report = tokio::task::spawn_blocking(move || {
                crate::connectors::attachments::evict_adapter_attachments(&adapter_id)
            })
            .await
            .map_err(|error| RpcError::internal(format!("attachment evict task failed: {error}")))?
            .map_err(RpcError::internal)?;
            to_json(report)
        }

        "connectors_attachment_enforce_budget" => {
            let max_total_bytes: u64 = required_aliased(&args, "max_total_bytes", "maxTotalBytes")?;
            let report = tokio::task::spawn_blocking(move || {
                crate::connectors::attachments::enforce_cache_budget(max_total_bytes)
            })
            .await
            .map_err(|error| RpcError::internal(format!("attachment budget task failed: {error}")))?
            .map_err(RpcError::internal)?;
            to_json(report)
        }

        "connectors_media_upload" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: crate::connectors::types::ConnectorMediaUploadRequest =
                required(&args, "req")?;
            let uri = crate::connectors::media_upload::upload_media(req)
                .await
                .map_err(RpcError::internal)?;
            to_json(uri)
        }

        "connectors_matrix_crypto_init" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: crate::connectors::matrix_crypto::MatrixCryptoInitRequest =
                required(&args, "req")?;
            crate::connectors::matrix_crypto::matrix_crypto_init(req)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_matrix_crypto_close" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            crate::connectors::matrix_crypto::matrix_crypto_close(&adapter_id)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_matrix_crypto_outgoing_requests" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let requests =
                crate::connectors::matrix_crypto::matrix_crypto_outgoing_requests(adapter_id)
                    .await
                    .map_err(RpcError::internal)?;
            to_json(requests)
        }

        "connectors_matrix_crypto_mark_request_sent" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: crate::connectors::matrix_crypto::MatrixCryptoMarkSentRequest =
                required(&args, "req")?;
            crate::connectors::matrix_crypto::matrix_crypto_mark_request_sent(req)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_matrix_crypto_receive_sync_changes" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: crate::connectors::matrix_crypto::MatrixCryptoReceiveSyncRequest =
                required(&args, "req")?;
            crate::connectors::matrix_crypto::matrix_crypto_receive_sync_changes(req)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_matrix_crypto_decrypt_event" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: crate::connectors::matrix_crypto::MatrixCryptoDecryptRequest =
                required(&args, "req")?;
            let response = crate::connectors::matrix_crypto::matrix_crypto_decrypt_event(req)
                .await
                .map_err(RpcError::internal)?;
            to_json(response)
        }

        "connectors_matrix_crypto_encrypt_event" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: crate::connectors::matrix_crypto::MatrixCryptoEncryptRequest =
                required(&args, "req")?;
            let response = crate::connectors::matrix_crypto::matrix_crypto_encrypt_event(req)
                .await
                .map_err(RpcError::internal)?;
            to_json(response)
        }

        "connectors_matrix_crypto_share_room_key" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: crate::connectors::matrix_crypto::MatrixCryptoShareRoomKeyRequest =
                required(&args, "req")?;
            let requests = crate::connectors::matrix_crypto::matrix_crypto_share_room_key(req)
                .await
                .map_err(RpcError::internal)?;
            to_json(requests)
        }

        "connectors_matrix_crypto_update_tracked_users" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: crate::connectors::matrix_crypto::MatrixCryptoTrackUsersRequest =
                required(&args, "req")?;
            crate::connectors::matrix_crypto::matrix_crypto_update_tracked_users(req)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_matrix_crypto_get_missing_sessions" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: crate::connectors::matrix_crypto::MatrixCryptoMissingSessionsRequest =
                required(&args, "req")?;
            let requests =
                crate::connectors::matrix_crypto::matrix_crypto_get_missing_sessions(req)
                    .await
                    .map_err(RpcError::internal)?;
            to_json(requests)
        }

        "connectors_matrix_encrypted_media_upload" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: crate::connectors::types::MatrixEncryptedMediaUploadRequest =
                required(&args, "req")?;
            let response = crate::connectors::media_upload::upload_matrix_encrypted_media(req)
                .await
                .map_err(RpcError::internal)?;
            to_json(response)
        }

        "connectors_matrix_encrypted_media_fetch" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: crate::connectors::types::MatrixEncryptedMediaFetchRequest =
                required(&args, "req")?;
            let response = crate::connectors::attachments::fetch_matrix_encrypted_attachment(req)
                .await
                .map_err(RpcError::internal)?;
            to_json(response)
        }

        "connectors_lark_upload_file" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let access_token: String = required_aliased(&args, "access_token", "accessToken")?;
            let source_url: String = required_aliased(&args, "source_url", "sourceUrl")?;
            let file_type: String = required_aliased(&args, "file_type", "fileType")?;
            let file_name: String = required_aliased(&args, "file_name", "fileName")?;
            let duration_ms: Option<u64> = match optional(&args, "duration_ms")? {
                Some(v) => Some(v),
                None => optional(&args, "durationMs")?,
            };
            let file_key = crate::connectors::lark_upload::upload_file(
                &access_token,
                &source_url,
                &file_type,
                &file_name,
                duration_ms,
            )
            .await
            .map_err(RpcError::internal)?;
            to_json(file_key)
        }

        "connectors_lark_upload_image" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let access_token: String = required_aliased(&args, "access_token", "accessToken")?;
            let source_url: String = required_aliased(&args, "source_url", "sourceUrl")?;
            let image_type: Option<String> = match optional(&args, "image_type")? {
                Some(v) => Some(v),
                None => optional(&args, "imageType")?,
            };
            let image_key = crate::connectors::lark_upload::upload_image(
                &access_token,
                &source_url,
                image_type.as_deref(),
            )
            .await
            .map_err(RpcError::internal)?;
            to_json(image_key)
        }

        // Remote Session Control — resolve a host computer-use HITL consent
        // prompt from a remote device. The prompt streams to the phone over
        // `/ws/events` as the `automation:consent-request` frame; the phone
        // renders it and calls this to allow/deny. First-responder wins —
        // `ConsentBroker::resolve` removes the pending oneshot, so a duplicate
        // (desktop overlay + phone) is harmless. Distinct HITL channel from
        // `claude_approve` (which resolves Claude SDK tool-use prompts).
        "automation_consent_respond" => {
            if host.headless().is_some() {
                return Err(RpcError::headless_unsupported(name));
            }
            let respond_args: crate::automation::commands::ConsentRespondArgs =
                serde_json::from_value(args).map_err(|e| {
                    RpcError::malformed(format!("automation_consent_respond args: {e}"))
                })?;
            let app = host.tauri_app(name)?;
            let automation_state: tauri::State<'_, crate::automation::commands::AutomationState> =
                app.state();
            crate::automation::commands::automation_consent_respond(automation_state, respond_args)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "automation_consent_pending" => {
            if host.headless().is_some() {
                return Err(RpcError::headless_unsupported(name));
            }
            let app = host.tauri_app(name)?;
            let automation_state: tauri::State<'_, crate::automation::commands::AutomationState> =
                app.state();
            let pending = automation_state.consent.pending_requests();
            to_json(pending)
        }

        // Remote Session Control — read-only capability probe. A paired device
        // calls this once (on the mobile shell) to learn whether it may resolve
        // host computer-use consent, so observe-only clients hide the consent
        // sheet entirely instead of surfacing a prompt that 403s on tap. `app`
        // is unused; this is a pure read of the process-global allow list, and
        // is deliberately absent from CONTROL_COMMANDS so every paired device
        // can query its own standing.
        "companion_can_control" => Ok(can_control_response(device_id)),

        // Read-only channel inventory. Deliberately degrades instead of 503-ing
        // off the desktop: the tunnel launcher is Tauri-managed state, and a
        // headless `cognia-server` simply has no tunnel — that is a `null`
        // `tunnelBaseUrl`, not an unsupported command. The LAN address and the
        // TLS fingerprint are process-global and answer correctly on both hosts.
        "companion_endpoints" => {
            let (tunnel_base_url, bind_lan) = match host.tauri_app(name) {
                Ok(app) => {
                    let server_state: tauri::State<'_, super::super::CompanionServerState> =
                        app.state();
                    let tunnel = server_state
                        .tunnel
                        .current()
                        .map(|info| info.public_url)
                        .or_else(|| server_state.tunnel.named_public_url());
                    let bind_lan = server_state
                        .bind_mode()
                        .map(|mode| matches!(mode, super::super::BindMode::Lan));
                    (tunnel, bind_lan)
                }
                // Headless: no tunnel launcher, and the listener is bound
                // `0.0.0.0`, so leave `bind_lan` unknown (= assume LAN).
                Err(_) => (None, None),
            };
            let server_id = super::super::healthz::derive_server_id(&state.secret.read());
            Ok(endpoints_response(
                lan_base_url(bind_lan),
                tunnel_base_url,
                super::super::tls_fingerprint(),
                server_id,
            ))
        }

        "app_settings_update" => {
            // Allowlist enforcement — phone may only mutate user-facing
            // preferences, never transport / sidecar / provider keys.
            // Wave 3.2: distinguish validation failures (recoverable —
            // user can fix the payload) from transport-level malformed
            // requests by emitting `validation_failed` here. This is also
            // enforced in `rpc_handler` *before* the AppHandle gate; we keep
            // it here so the WebRTC `signaling::dispatch` path (which calls
            // `dispatch` directly) stays guarded too.
            validate_app_settings_update(&args)?;
            let bridge = std::sync::Arc::clone(&state.desktop_writes_bridge);
            // Connected brain first, desktop WebView second (ADR-0059 R4/R5).
            let transport = super::super::ws_bridge::resolve_bridge_transport(state)
                .map_err(RpcError::service_unavailable)?;
            bridge
                .dispatch(
                    transport.as_ref(),
                    name,
                    args,
                    crate::companion_api::desktop_writes_bridge::DEFAULT_TIMEOUT,
                )
                .await
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
