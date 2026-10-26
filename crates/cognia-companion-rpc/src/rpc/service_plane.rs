use super::*;

pub(super) const COMMANDS: &[&str] = &[
    // ADR-0228 — the brain asking after, driving and hinting a paired browser.
    "companion_browser_extension_status",
    "companion_browser_extension_read",
    "companion_browser_extension_call",
    "companion_browser_extension_notify",
    "spawn_external_agent",
    "send_to_external_agent",
    "kill_external_agent",
    "external_agent_delete_gateway_task",
    "get_external_agent_status",
    "environment_task_shell_exec",
    "environment_task_shell_release",
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
    "task_workspace_remote_source_ensure",
    "task_workspace_project_source_ensure",
    "task_workspace_session_scratch_ensure",
    "code_snapshot_checkout_get",
    "github_workspace_remove",
    "github_workspace_stat",
    "integration_ingress_ack",
    "integration_ingress_nack",
    "workflow_register_trigger",
    "workflow_unregister_trigger",
    "workflow_file_watch_ack",
    "workflow_get_webhook_url",
    "workflow_webhook_respond",
    "workflow_persist_run_state",
    "workflow_reload_in_flight_runs",
    "workflow_ack_completed",
    "workflow_waitpoint_create",
    "workflow_waitpoint_get",
    "workflow_waitpoint_list_pending",
    "workflow_waitpoint_decide",
    "workflow_wait_event_persist",
    "workflow_wait_event_prune",
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
    // ADR-0224 A6 — secrets a paired device keeps on this host.
    "host_secret_list",
    "org_model_credential_list",
    "org_model_credential_set",
    "org_model_credential_delete",
    "org_agent_policy_get",
    "org_agent_policy_set",
    "org_member_usage_get",
    "org_usage_cap_set",
    "org_member_usage_cap_set",
    "host_provider_credential_set",
    "host_provider_credential_delete",
    "host_git_credential_set",
    "host_git_credential_delete",
    "host_provider_credentials_load",
    "connectors_http_request",
    "connectors_google_docs_auth",
    "connectors_ws_open",
    "connectors_ws_send",
    "connectors_ws_close",
    "connectors_onebot_send",
    "connectors_onebot_probe",
    "connectors_discord_upload",
    "connectors_lark_ws_open",
    "connectors_lark_ws_close",
    "connectors_lark_callback_respond",
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
    "automation_kill_switch_engaged",
    "automation_settings_get",
    "automation_audit_snapshot",
    "automation_kill_switch",
    "companion_can_control",
    "companion_endpoints",
    "langfuse_credentials_set",
    "langfuse_credentials_status",
    "langfuse_credentials_clear",
    "langfuse_connection_test",
    "langfuse_trace_ingest",
    "app_settings_update",
];

fn require_org_server(kind: &str) -> Result<(), (StatusCode, Json<RpcError>)> {
    if kind == "headless" { Ok(()) } else {
        Err((StatusCode::CONFLICT, Json(RpcError::new("org_scope_unavailable", "organization administration requires a multi-tenant cognia-server"))))
    }
}

/// The sandbox pool's runtime control, or the refusal that names the switch.
fn task_shell_runtime() -> Result<
    std::sync::Arc<dyn cognia_sandbox_pool::runtime::SandboxRuntimeControl>,
    (StatusCode, Json<RpcError>),
> {
    cognia_companion::environment_pool::installed()
        .and_then(|pool| pool.runtime)
        .ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(RpcError::new(
                    "sandbox_pool_disabled",
                    "task shells need the runtime environment sandbox pool \
                     (COGNIA_SANDBOX_POOL_ENABLED)",
                )),
            )
        })
}

fn task_shell_error(
    error: cognia_external_agent::sandbox_routing_backend::SandboxSpawnError,
) -> (StatusCode, Json<RpcError>) {
    use cognia_external_agent::sandbox_routing_backend::SandboxErrorKind;
    let status = tenant_execution_status(&error.code).unwrap_or(match error.kind {
        SandboxErrorKind::Refused => StatusCode::BAD_REQUEST,
        SandboxErrorKind::Fault => StatusCode::BAD_GATEWAY,
    });
    (status, Json(RpcError::new(error.code, error.message)))
}

fn tenant_execution_status(code: &str) -> Option<StatusCode> {
    match code {
        "execution_isolation_unavailable"
        | "placement_binding_required"
        | "execution_binding_store_unavailable"
        | "execution_binding_store_full" => Some(StatusCode::SERVICE_UNAVAILABLE),
        "placement_binding_client_supplied"
        | "credential_delivery_refused"
        | "credential_use_forbidden"
        | "workspace_read_forbidden"
        | "execution_request_forbidden"
        | "workspace_mount_forbidden"
        | "workspace_unresolved"
        | "workspace_root_claimed"
        | "workspace_root_unconfigured" => Some(StatusCode::FORBIDDEN),
        _ => None,
    }
}

fn tenant_execution_refusal(code: &str) -> (StatusCode, Json<RpcError>) {
    (
        tenant_execution_status(code).unwrap_or(StatusCode::FORBIDDEN),
        Json(RpcError::new(code, code)),
    )
}

fn spawn_execution_error(message: String) -> (StatusCode, Json<RpcError>) {
    if let Some((code, _)) = message.split_once(':') {
        if let Some(status) = tenant_execution_status(code) {
            return (status, Json(RpcError::new(code, message.clone())));
        }
    }
    RpcError::internal(message)
}

fn placement_matches_binding(
    info: &Value,
    binding: &cognia_external_agent::spawn_authority::PlacementBinding,
) -> bool {
    info.pointer("/placement/kind").and_then(Value::as_str) == Some("sandbox")
        && info.pointer("/placement/binding") == Some(&serde_json::json!(binding))
}

/// Capture Host lifecycle authority at spawn: exit readers do not inherit
/// request task-locals. Cleanup compares the exact execution generation.
struct BindingEmitter {
    inner: std::sync::Arc<dyn cognia_external_agent::exec_backend::AgentEventEmitter>,
    directory: std::path::PathBuf,
    binding: cognia_external_agent::spawn_authority::PlacementBinding,
    agent_id: String,
    exited: std::sync::Arc<std::sync::atomic::AtomicBool>,
    runtime: tokio::runtime::Handle,
    // P6d capture audience before leaving request task-locals.
    person_bus: Option<std::sync::Arc<cognia_companion::event_bus::EventBus>>,
    person_reason: std::sync::Arc<parking_lot::RwLock<Option<String>>>,
}

// Runtime operations still address agent ids. Hold this async lock from
// binding validation through control/creation/rollback, so an old request
// cannot act on a replacement. Weak entries are pruned on every acquisition.
fn execution_lifecycle_lock(id: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    cognia_companion::host_surface_gate::person_execution_run_lock(id)
}
impl cognia_external_agent::exec_backend::AgentEventEmitter for BindingEmitter {
    fn emit(&self, channel: &str, mut payload: Value) {
        if matches!(channel, "external-agent://state-change" | "external-agent://exit") {
            if let Some(reason) = self.person_reason.read().as_ref() { payload["reason"] = serde_json::json!(reason); }
        }
        if channel == cognia_external_agent::exec_backend::EXIT_CHANNEL
            && payload.get("agentId").and_then(Value::as_str) == Some(self.agent_id.as_str())
        {
            self.exited.store(true, std::sync::atomic::Ordering::SeqCst);
            cognia_companion::host_surface_gate::person_execution_lease_revoke(&self.agent_id, &self.binding);
            let directory = self.directory.clone();
            let binding = self.binding.clone();
            let id = self.agent_id.clone();
            self.runtime.spawn_blocking(move || {
                if let Err(problem) = cognia_companion::host_surface_gate::forget_execution_record(
                    &directory,
                    "spawn_external_agent",
                    &id,
                    &binding,
                ) {
                    log::warn!("execution binding exit cleanup failed: {}", problem.code);
                }
            });
        }
        if let Some(bus) = &self.person_bus {
            if let Some(person) = cognia_companion::host_surface_gate::person_execution_owner(&self.binding) {
                cognia_companion::person_chat::person_publish_to(bus, channel, &payload, &person);
            }
        } else { self.inner.emit(channel, payload); }
    }
}

/// P6d bounded watchdog. A completed run never retains a timer beyond one
/// interval. The partition and generation fences protect replacement runs.
fn person_start_watchdog(root: std::path::PathBuf, id: String,
    binding: cognia_external_agent::spawn_authority::PlacementBinding,
    backend: std::sync::Arc<dyn cognia_external_agent::exec_backend::ExecBackend>,
    emitter: std::sync::Arc<dyn cognia_external_agent::exec_backend::AgentEventEmitter>,
    exited: std::sync::Arc<std::sync::atomic::AtomicBool>,
    reason: std::sync::Arc<parking_lot::RwLock<Option<String>>>) {
    person_watchdog_with_interval(root, id, binding, backend, emitter, exited, reason,
        cognia_external_agent::person_workspace::PERSON_WORKSPACE_INTERVAL);
}

fn person_watchdog_with_interval(root: std::path::PathBuf, id: String,
    binding: cognia_external_agent::spawn_authority::PlacementBinding,
    backend: std::sync::Arc<dyn cognia_external_agent::exec_backend::ExecBackend>,
    emitter: std::sync::Arc<dyn cognia_external_agent::exec_backend::AgentEventEmitter>,
    exited: std::sync::Arc<std::sync::atomic::AtomicBool>,
    reason: std::sync::Arc<parking_lot::RwLock<Option<String>>>, interval: std::time::Duration) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(interval).await;
            if exited.load(std::sync::atomic::Ordering::SeqCst) { break; }
            let Some(person) = cognia_companion::host_surface_gate::person_execution_owner(&binding) else { break; };
            let _partition = cognia_companion::host_surface_gate::person_execution_lock(&person.account_id).lock_owned().await;
            let _run = execution_lifecycle_lock(&id).lock_owned().await;
            let Ok(info) = backend.get_info(&id).await else { break; };
            if !placement_matches_binding(&info, &binding) { break; }
            use cognia_external_agent::process::ExternalAgentProcessState::{Stopped, Failed};
            if matches!(backend.status(&id).await, None | Some(Stopped | Failed)) { break; }
            let path = root.clone();
            let measured = tokio::task::spawn_blocking(move || {
                let max = cognia_external_agent::person_workspace::person_workspace_max_bytes()
                    .map_err(|_| "person_workspace_unavailable")?;
                let used = cognia_external_agent::person_workspace::person_workspace_usage(&path,
                    cognia_external_agent::person_workspace::PERSON_WORKSPACE_ENTRY_LIMIT).map_err(|error| error.code())?;
                Ok::<_, &'static str>((used, max))
            }).await.unwrap_or(Err("person_workspace_unavailable"));
            let standing = cognia_companion::host_surface_gate::person_execution_standing(&person).await;
            let violation = reason.read().clone().or_else(|| standing.err().map(|problem| problem.code)).or_else(|| match measured {
                Ok((used, max)) if used > max => Some("person_workspace_quota_exceeded".to_owned()),
                Err(code) => Some(code.to_owned()), _ => None,
            }).or_else(|| (!cognia_companion::host_surface_gate::person_execution_lease_refresh(&id, &binding))
                .then(|| "credential_delivery_refused".to_owned()));
            if let Some(code) = violation {
                cognia_companion::host_surface_gate::person_execution_lease_revoke(&id, &binding);
                *reason.write() = Some(code.clone());
                emitter.emit(cognia_external_agent::exec_backend::STATE_CHANGE_CHANNEL,
                    serde_json::json!({"agentId":id,"state":"Stopping","reason":code}));
                match tokio::time::timeout(std::time::Duration::from_secs(10), async {
                    backend.kill(&id).await?;
                    use cognia_external_agent::process::ExternalAgentProcessState::{Stopped, Failed};
                    while !matches!(backend.status(&id).await, None | Some(Stopped | Failed)) {
                        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                    }
                    Ok::<_, String>(())
                }).await {
                    Ok(Ok(())) => break,
                    _ => log::warn!("person quota kill pending for {id}"),
                }
            }
        }
        cognia_companion::host_surface_gate::person_execution_lease_revoke(&id, &binding);
    });
}

fn langfuse_account(tenant_id: Option<&str>) -> Result<&str, (StatusCode, Json<RpcError>)> {
    tenant_id.ok_or_else(|| RpcError::forbidden("Langfuse requires an authenticated account"))
}

fn map_langfuse_ingest_error(detail: String) -> (StatusCode, Json<RpcError>) {
    if detail.contains("rate limit") {
        return RpcError::rate_limited(60);
    }
    if detail.contains("disabled for this account")
        || detail.contains("credentials are not configured")
    {
        return RpcError::forbidden(detail);
    }
    if detail.starts_with("Langfuse trace export")
        || detail.starts_with("Langfuse endpoint DNS")
        || detail.starts_with("Langfuse client build")
    {
        return RpcError::service_unavailable(detail);
    }
    RpcError::validation_failed(detail)
}

/// The workflow state of whichever host is answering: the desktop's managed
/// `WorkflowState`, or the one `HeadlessServices` opened for cognia-server.
///
/// Both hosts run the same cron daemon, webhook router, file-watch daemon and
/// run-state mirror; what differed was only who could reach them. The desktop
/// renderer invokes the Tauri commands directly, and the headless brain has no
/// `invoke`, so until these arms existed its `tauri-bridge.ts` dropped every
/// call on the floor and cognia-server ran daemons nobody registered with.
/// The desktop's computer-use runtime, or the historical per-arm
/// `503 headless_unsupported` on a host that has none.
fn host_automation<'a>(
    host: &'a dyn crate::rpc_host::RpcHost,
    name: &str,
) -> Result<crate::rpc_host::HostAutomation<'a>, (StatusCode, Json<RpcError>)> {
    host.automation()
        .ok_or_else(|| RpcError::headless_unsupported(name))
}

pub(super) fn workflow_state(
    host: &dyn crate::rpc_host::RpcHost,
) -> Result<&cognia_scheduling::workflow::WorkflowState, (StatusCode, Json<RpcError>)> {
    host.workflow_state().ok_or_else(|| {
        RpcError::service_unavailable("workflow state is not managed yet".to_string())
    })
}

pub(super) async fn dispatch(
    name: &str,
    args: Value,
    state: &SharedState,
    host: &dyn crate::rpc_host::RpcHost,
    device_id: &str,
    tenant_id: Option<&str>,
    scope: Option<&str>,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    let _ = (state, host, device_id, tenant_id, scope);
    // P6d: all execution controls share purge's partition fence.
    let person = if scope == Some("person-brain") {
        Some(crate::person_execution::person_caller(scope, tenant_id, name)?)
    } else { None };
    let _person_execution = match &person {
        Some(person) => Some(cognia_companion::host_surface_gate::person_execution_lock(&person.account_id).lock_owned().await),
        None => None,
    };
    if let Some(person) = &person {
        crate::person_execution::person_caller(scope, tenant_id, name)?;
        if cognia_external_agent::spawn_authority::execution_admission().as_ref()
            .and_then(|decision| cognia_companion::host_surface_gate::person_execution_owner(&decision.binding)).as_ref() != Some(person) {
            return Err(crate::person_model::person_forbidden());
        }
        if name == "spawn_external_agent" && !host.exec_backend().routes_sandboxes() {
            return Err(tenant_execution_refusal("execution_isolation_unavailable"));
        }
    }
    let _execution_lifecycle =
        if cognia_external_agent::spawn_authority::execution_admission().is_some()
            || matches!(name, "get_external_agent_status" | "kill_external_agent" | "send_to_external_agent") {
            let id = if name == "spawn_external_agent" {
                args.pointer("/config/id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            } else if matches!(
                name,
                "send_to_external_agent" | "kill_external_agent" | "get_external_agent_status"
            ) {
                Some(required_aliased::<String>(&args, "agent_id", "agentId")?)
            } else {
                None
            };
            match id {
                Some(id) => Some(execution_lifecycle_lock(&id).lock_owned().await),
                None => None,
            }
        } else {
            None
        };
    // Operator controls also take the run fence before checking ownership:
    // a person spawn may still be installing this id when the request arrives.
    if matches!(name, "get_external_agent_status" | "kill_external_agent" | "send_to_external_agent") && person.is_none() {
        let id: String = required_aliased(&args, "agent_id", "agentId")?;
        if let Ok(info) = host.exec_backend().get_info(&id).await {
            if info.pointer("/placement/binding").cloned()
                .and_then(|binding| serde_json::from_value::<cognia_external_agent::spawn_authority::PlacementBinding>(binding).ok())
                .and_then(|binding| cognia_companion::host_surface_gate::person_execution_owner(&binding)).is_some() {
                return Err(crate::person_model::person_forbidden());
            }
        }
    }
    if let Some(person) = &person {
        cognia_companion::host_surface_gate::person_execution_standing(person).await
            .map_err(|p| (p.status_code(), Json(RpcError::new(p.code, p.detail))))?;
    }
    if matches!(
        name,
        "send_to_external_agent" | "kill_external_agent" | "get_external_agent_status"
    ) {
        if let Some(decision) = cognia_external_agent::spawn_authority::execution_admission() {
            let agent_id: String = required_aliased(&args, "agent_id", "agentId")?;
            if matches!(
                host.exec_backend().status(&agent_id).await,
                None | Some(
                    cognia_external_agent::process::ExternalAgentProcessState::Stopped
                        | cognia_external_agent::process::ExternalAgentProcessState::Failed
                )
            ) {
                cognia_companion::host_surface_gate::forget_execution_binding(
                    state, name, &agent_id,
                )
                .await
                .map_err(|problem| {
                    (
                        problem.status_code(),
                        Json(RpcError::new(problem.code, problem.detail)),
                    )
                })?;
                return Err(tenant_execution_refusal("workspace_unresolved"));
            }
            let info = host
                .exec_backend()
                .get_info(&agent_id)
                .await
                .map_err(|_| tenant_execution_refusal("placement_binding_required"))?;
            if let Some(person) = &person {
                let owner = info.pointer("/placement/binding").cloned()
                    .and_then(|value| serde_json::from_value::<cognia_external_agent::spawn_authority::PlacementBinding>(value).ok())
                    .and_then(|binding| cognia_companion::host_surface_gate::person_execution_owner(&binding));
                if owner.as_ref() != Some(person) { return Err(crate::person_model::person_forbidden()); }
            }
            if !placement_matches_binding(&info, &decision.binding) {
                return Err(tenant_execution_refusal("execution_isolation_unavailable"));
            }
            if decision
                .workspace_read_only()
                .map_err(tenant_execution_refusal)?
                && info
                    .pointer("/placement/workspaceReadOnly")
                    .and_then(Value::as_bool)
                    != Some(true)
            {
                return Err(tenant_execution_refusal("workspace_mount_forbidden"));
            }
        }
    }
    if matches!(
        name,
        "send_to_external_agent" | "kill_external_agent" | "get_external_agent_status"
    ) && cognia_external_agent::spawn_authority::execution_admission().is_none()
    {
        let agent_id: String = required_aliased(&args, "agent_id", "agentId")?;
        super::gateway_plane::authorize_task_agent_control(host, device_id, &agent_id).await?;
        if cognia_companion::environment_pool::installed()
            .and_then(|pool| pool.runtime)
            .and_then(|runtime| runtime.agent_origin_allowed(&agent_id, device_id))
            == Some(false)
        {
            return Err(RpcError::forbidden(
                "Sandbox agent belongs to another device",
            ));
        }
    }
    let result = match name {
        // ── Browser device socket (ADR-0228 §5–§6) ───────────────────────────
        // The brain's agent-mode gate, `ExtensionBrowserEngine` and status
        // notifier. Service scope only: a paired device never drives another
        // device's browser. `browser.drive` and the Browser Access switch are
        // checked again inside `call` for every operation.
        "companion_browser_extension_status" => {
            let browser: String = required_aliased(&args, "device_id", "deviceId")?;
            to_json(cognia_companion::ws_browser_companion::rpc_device_status(
                &browser,
            ))
        }

        // Split by effect (`ws_browser_companion::READ_OPERATIONS`): a look
        // is a read the ledger never stores, an action keeps its receipt so a
        // retry is not run twice.
        "companion_browser_extension_read" | "companion_browser_extension_call" => {
            let browser: String = required_aliased(&args, "device_id", "deviceId")?;
            let operation: String = required(&args, "operation")?;
            let operation_args = optional::<Value>(&args, "args")?
                .unwrap_or_else(|| Value::Object(Default::default()));
            let timeout_ms: Option<u64> = optional_aliased(&args, "timeout_ms", "timeoutMs")?;
            if name == "companion_browser_extension_read" {
                cognia_companion::ws_browser_companion::rpc_read(
                    &browser,
                    &operation,
                    operation_args,
                    timeout_ms,
                )
                .await
            } else {
                cognia_companion::ws_browser_companion::rpc_call(
                    &browser,
                    &operation,
                    operation_args,
                    timeout_ms,
                )
                .await
            }
        }

        "companion_browser_extension_notify" => {
            let browser: String = required_aliased(&args, "device_id", "deviceId")?;
            cognia_companion::ws_browser_companion::rpc_notify_status(&browser);
            Ok(Value::Null)
        }

        // ── Headless external-agent execution plane (ADR-0059 R11) ───────────
        // Service-scope only (gated above + in rpc_handler); every decision
        // is written to the audit log. The spawn request must clear the
        // SpawnPolicy preset allowlist before it touches the exec backend.
        "spawn_external_agent" => {
            if person.is_some() && args.pointer("/config/sandbox").is_some() {
                return Err(crate::person_execution::person_refusal(StatusCode::FORBIDDEN, "placement_client_supplied"));
            }
            let policy = host.remote_spawn_policy().map_err(RpcError::internal)?;
            let mut config: cognia_external_agent::process::ExternalAgentSpawnConfig =
                required(&args, "config")?;
            let person_runtime = if person.is_some() { Some(required::<String>(&args, "runtimeId")?) } else { None };
            let (person_workspace, person_gateway, mut person_lease) = match (&person, &person_runtime) {
                (Some(person), Some(runtime)) => {
                    let (root, gateway, lease) = crate::person_execution::person_prepare_spawn(person, runtime, policy.clone(), &mut config, host).await?;
                    (Some(root), Some(gateway), Some(lease))
                }
                _ => (None, None, None),
            };
            if let Some(decision) = cognia_external_agent::spawn_authority::execution_admission() {
                decision
                    .authorize_inputs(
                        config.env.keys().map(String::as_str),
                        config.args.iter().map(String::as_str),
                        false,
                    )
                    .map_err(tenant_execution_refusal)?;
                if config
                    .sandbox
                    .as_ref()
                    .and_then(|placement| placement.workspace())
                    .is_some_and(|workspace| workspace.credential.is_some())
                    && !decision.has("credential.use")
                {
                    return Err(tenant_execution_refusal("credential_use_forbidden"));
                }
                config
                    .sandbox
                    .as_mut()
                    .ok_or_else(|| tenant_execution_refusal("execution_isolation_unavailable"))?
                    .stamp(decision)
                    .map_err(tenant_execution_refusal)?;
            } else if cognia_companion::deployment::deployment_mode()
                == cognia_companion::deployment::DeploymentMode::MultiTenant
            {
                return Err(tenant_execution_refusal("execution_isolation_unavailable"));
            }
            let mut gateway_authority = if person.is_some() {
                person_gateway
            } else { super::gateway_plane::authorize_task_spawn(
                state,
                host,
                device_id,
                tenant_id,
                scope,
                &mut config,
            )? };
            let delivery_source_declaration = config
                .env
                .remove(cognia_external_agent::spawn_authority::DELIVERY_SOURCE_ENV);
            let mut summary = serde_json::json!({
                "agent_id": config.id,
                "command": config.command,
                "args": config.args,
            });
            // A runtime environment request (ADR-0182), as claimed. Absent
            // for a spawn without one, so those lines are unchanged.
            if let Some(placement) = config.sandbox.as_ref() {
                summary["sandbox"] = placement.audit_fields();
            }
            match policy.validate(config) {
                Err(violation) => {
                    let mut fields = summary;
                    fields["reason"] = Value::String(violation.to_string());
                    cognia_companion::audit::record_async(
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
                    cognia_companion::audit::record_async(
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
                    // One backend for both steps: the desktop's sandbox router
                    // can be installed between two reads (ADR-0221).
                    let backend = host.exec_backend();
                    let mut hardened = host
                        .harden_spawn_config(validated.config, backend.as_ref())
                        .map_err(RpcError::internal)?;
                    let admitted_cwd = hardened.cwd.clone().unwrap_or_default();
                    if cognia_external_agent::spawn_authority::execution_admission().is_some()
                        && admitted_cwd.is_empty()
                    {
                        return Err(tenant_execution_refusal("workspace_unresolved"));
                    }
                    cognia_companion::host_surface_gate::authorize_execution_mount(
                        state,
                        &admitted_cwd,
                    )
                    .await
                    .map_err(|problem| {
                        (
                            problem.status_code(),
                            Json(RpcError::new(problem.code, problem.detail)),
                        )
                    })?;
                    if let Some(declaration) = delivery_source_declaration {
                        hardened.env.insert(
                            cognia_external_agent::spawn_authority::DELIVERY_SOURCE_ENV.into(),
                            declaration,
                        );
                        let authority = gateway_authority.as_mut().ok_or_else(|| {
                            RpcError::forbidden("delivery_source_gateway_required")
                        })?;
                        let owner = if let Some(tenant) = tenant_id {
                            cognia_companion::host_identity::namespace_for_tenant(tenant)
                        } else if cognia_companion::jwt::is_service_scope(scope) {
                            cognia_companion::host_identity::current()
                                .ok()
                                .and_then(|binding| {
                                    cognia_companion::host_identity::namespace_for_tenant(
                                        &binding.remote_tenant_id,
                                    )
                                })
                        } else {
                            None
                        }
                        .ok_or_else(|| RpcError::forbidden("delivery_source_account_required"))?;
                        let directory = host.cognia_data_dir().map_err(RpcError::internal)?;
                        let task = authority.task_id.clone();
                        let device = authority
                            .device_id
                            .clone()
                            .unwrap_or_else(|| device_id.to_owned());
                        let (config, source) = tokio::task::spawn_blocking(move || {
                            let host_id = crate::deployment_id::resolve(&directory)?;
                            let source = crate::delivery_admission::consume(
                                &directory,
                                &owner,
                                &host_id,
                                &device,
                                &task,
                                &mut hardened,
                            )?;
                            Ok::<_, String>((hardened, source))
                        })
                        .await
                        .map_err(|_| RpcError::internal("delivery_source_admission_failed".into()))?
                        .map_err(RpcError::forbidden)?;
                        hardened = config;
                        authority.delivery_source = source;
                        if !(authority.authorized)() {
                            return Err(RpcError::forbidden("delivery_source_authority_revoked"));
                        }
                    }
                    let mut emitter = host.agent_event_emitter();
                    let person_reason = std::sync::Arc::new(parking_lot::RwLock::new(None));
                    let exited = if let Some(decision) =
                        cognia_external_agent::spawn_authority::execution_admission()
                    {
                        let exited = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                        let directory =
                            state.runtime.execution_binding_root(state).ok_or_else(|| {
                                tenant_execution_refusal("execution_binding_store_unavailable")
                            })?;
                        emitter = std::sync::Arc::new(BindingEmitter {
                            inner: emitter,
                            directory,
                            binding: decision.binding,
                            agent_id: hardened.id.clone(),
                            exited: exited.clone(),
                            runtime: tokio::runtime::Handle::current(),
                            person_bus: person.as_ref().map(|_| state.event_bus.clone()),
                            person_reason: person_reason.clone(),
                        });
                        Some(exited)
                    } else {
                        None
                    };
                    let person_emitter = emitter.clone();
                    let spawned = cognia_external_agent::spawn_authority::with_remote_origin(
                        device_id,
                        cognia_external_agent::spawn_authority::with_gateway(
                            gateway_authority,
                            cognia_external_agent::exec_backend::spawn_with_events(
                                backend.as_ref(),
                                emitter,
                                hardened,
                            ),
                        ),
                    )
                    .await
                    .map_err(spawn_execution_error)?;
                    if let Err(problem) =
                        cognia_companion::host_surface_gate::persist_execution_binding(
                            state,
                            name,
                            &args,
                            &admitted_cwd,
                        )
                        .await
                    {
                        let cleanup = backend.kill(&spawned).await;
                        let detail = match cleanup {
                            Ok(()) => problem.detail.clone(),
                            Err(error) => {
                                format!("{}; sandbox cleanup failed: {error}", problem.detail)
                            }
                        };
                        return Err((
                            problem.status_code(),
                            Json(RpcError::new(problem.code, detail)),
                        ));
                    }
                    // A short-lived process may exit before its create call
                    // persists the record. Its early callback then had no row.
                    if exited.as_ref().is_some_and(|exited| exited.load(std::sync::atomic::Ordering::SeqCst))
                    {
                        cognia_companion::host_surface_gate::forget_execution_binding(
                            state, name, &spawned,
                        )
                        .await
                        .map_err(|problem| {
                            (
                                problem.status_code(),
                                Json(RpcError::new(problem.code, problem.detail)),
                            )
                        })?;
                    }
                    if let (Some(root), Some(exited), Some(decision)) = (person_workspace, exited,
                        cognia_external_agent::spawn_authority::execution_admission()) {
                        person_start_watchdog(root, spawned.clone(), decision.binding,
                            backend, person_emitter, exited, person_reason);
                    }
                    if let Some(lease) = &mut person_lease { lease.commit(); }
                    Ok(Value::String(spawned))
                }
            }
        }

        "send_to_external_agent" => {
            let agent_id: String = required_aliased(&args, "agent_id", "agentId")?;
            let message: String = required(&args, "message")?;
            cognia_companion::audit::record_async(
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
            cognia_companion::audit::record_async(
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
                .map_err(RpcError::internal)?;
            if let Some(decision) = cognia_external_agent::spawn_authority::execution_admission() {
                cognia_companion::host_surface_gate::person_execution_lease_revoke(&agent_id, &decision.binding);
            }
            cognia_companion::host_surface_gate::forget_execution_binding(state, name, &agent_id)
                .await
                .map_err(|problem| {
                    (
                        problem.status_code(),
                        Json(RpcError::new(problem.code, problem.detail)),
                    )
                })?;
            Ok(Value::Null)
        }

        "external_agent_delete_gateway_task" => {
            let task_id: String = required_aliased(&args, "task_id", "taskId")?;
            let backend = host.exec_backend();
            crate::delivery_admission::delete_with_source_fence(
                async {
                    cognia_external_agent::gateway_task::authorize_gateway_task_deletion(
                        &task_id,
                        backend.as_ref(),
                        (!cognia_companion::jwt::is_service_scope(scope)).then_some(device_id),
                    )
                    .await
                    .map_err(RpcError::internal)
                },
                async {
                    let directory = host.cognia_data_dir().map_err(RpcError::internal)?;
                    let source_store =
                        cognia_sandbox_pool::provenance::SourceStore::new(&directory);
                    let reader = source_store.clone();
                    let task = task_id.clone();
                    let has_source = tokio::task::spawn_blocking(move || reader.has_task(&task))
                        .await
                        .map_err(|_| RpcError::internal("delivery_source_unavailable".into()))?
                        .map_err(RpcError::internal)?;
                    if !has_source {
                        return Ok(());
                    }
                    let owner = if let Some(tenant) = tenant_id {
                        cognia_companion::host_identity::namespace_for_tenant(tenant)
                    } else if cognia_companion::jwt::is_service_scope(scope) {
                        cognia_companion::host_identity::current()
                            .ok()
                            .and_then(|binding| {
                                cognia_companion::host_identity::namespace_for_tenant(
                                    &binding.remote_tenant_id,
                                )
                            })
                    } else {
                        None
                    }
                    .ok_or_else(|| RpcError::forbidden("delivery_source_account_required"))?;
                    let task = task_id.clone();
                    let device = (!cognia_companion::jwt::is_service_scope(scope)).then(|| device_id.to_owned());
                    tokio::task::spawn_blocking(move || {
                        let host_id = crate::deployment_id::resolve(&directory)?;
                        source_store.revoke_owned_task(&owner, &host_id, &task, device.as_deref())
                    })
                    .await
                    .map_err(|_| RpcError::internal("delivery_source_revocation_failed".into()))?
                    .map_err(RpcError::forbidden)
                },
                async {
                    let directory = host.cognia_data_dir().map_err(RpcError::internal)?;
                    let owner = tenant_id
                        .and_then(cognia_companion::host_identity::namespace_for_tenant)
                        .or_else(|| {
                            (cognia_companion::jwt::is_service_scope(scope))
                                .then(|| {
                                    cognia_companion::host_identity::current()
                                        .ok()
                                        .and_then(|b| {
                                            cognia_companion::host_identity::namespace_for_tenant(
                                                &b.remote_tenant_id,
                                            )
                                        })
                                })
                                .flatten()
                        });
                    let root = directory.clone();
                    let host_id =
                        tokio::task::spawn_blocking(move || crate::deployment_id::resolve(&root))
                            .await
                            .map_err(|_| RpcError::internal("delivery_source_unavailable".into()))?
                            .map_err(RpcError::internal)?;
                    let admission = crate::managed_desktops::task_deletion_admission(
                        crate::managed_desktops::Caller {
                            device_id,
                            tenant_id,
                            scope,
                            local: false,
                        },
                        host_id.clone(),
                        owner.clone(),
                    );
                    crate::managed_desktop_results::delete_task_history(
                        &directory,
                        owner,
                        host_id,
                        task_id.clone(),
                        (!cognia_companion::jwt::is_service_scope(scope)).then(|| device_id.to_owned()),
                        admission,
                        cognia_external_agent::gateway_task::delete_gateway_task_for_device(
                            &task_id,
                            backend.as_ref(),
                            (!cognia_companion::jwt::is_service_scope(scope)).then_some(device_id),
                        ),
                    )
                    .await
                    .map_err(RpcError::internal)
                },
            )
            .await?;
            cognia_companion::audit::record_async(
                "external_agent_gateway_task_deleted",
                device_id,
                scope.unwrap_or(""),
                "allow",
                serde_json::json!({ "task_id": task_id }),
            )
            .await;
            Ok(Value::Null)
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
        // ── Host task shells (ADR-0224 A8) ───────────────────────────────────
        // A built-in turn's sandboxed tool command on an always-on Host runs
        // in a retained runtime of the task's environment, never on the Host.
        // Service-only: the brain stamps the placement it resolved; the
        // workspace must clear the same SpawnPolicy rule a spawn's cwd does.
        "environment_task_shell_exec" => {
            let policy = host.remote_spawn_policy().map_err(RpcError::internal)?;
            let mut placement: cognia_external_agent::sandbox_routing_backend::SandboxPlacement =
                required(&args, "placement")?;
            let owner: String = required(&args, "owner")?;
            let workspace_path: String = required(&args, "workspaceRoot")?;
            let cwd: Option<String> = optional(&args, "cwd")?;
            let argv: Vec<String> = required(&args, "argv")?;
            let env: std::collections::BTreeMap<String, String> =
                optional(&args, "env")?.unwrap_or_default();
            if let Some(decision) = cognia_external_agent::spawn_authority::execution_admission() {
                decision
                    .authorize_inputs(
                        env.keys().map(String::as_str),
                        argv.iter().map(String::as_str),
                        false,
                    )
                    .map_err(tenant_execution_refusal)?;
                placement
                    .stamp(decision)
                    .map_err(tenant_execution_refusal)?;
            } else if cognia_companion::deployment::deployment_mode()
                == cognia_companion::deployment::DeploymentMode::MultiTenant
            {
                return Err(tenant_execution_refusal("execution_isolation_unavailable"));
            }
            let stdin: Option<String> = optional(&args, "stdin")?;
            let timeout_ms: u64 = required(&args, "timeoutMs")?;
            let denied = |violation: cognia_external_agent::presets::PolicyViolation| {
                RpcError::forbidden(format!("task shell denied by policy: {violation}"))
            };
            let workspace_root = policy
                .validate_workspace_path(&workspace_path)
                .map_err(denied)?;
            let cwd = cwd.unwrap_or_else(|| workspace_path.clone());
            // The command starts under the workspace both as named and once
            // resolved: a symlink inside it cannot lead the cwd out.
            if !std::path::Path::new(&cwd).starts_with(&workspace_path)
                || !std::path::Path::new(&policy.validate_workspace_path(&cwd).map_err(denied)?)
                    .starts_with(&workspace_root)
            {
                return Err(RpcError::forbidden(
                    "task shell denied by policy: the cwd is outside its workspace",
                ));
            }
            let runtime = task_shell_runtime()?;
            let mut fields = serde_json::json!({
                "owner": owner,
                "program": argv.first().cloned().unwrap_or_default(),
                "cwd": cwd,
                "sandbox": placement.audit_fields(),
            });
            let outcome = runtime
                .exec_task_shell(cognia_sandbox_pool::runtime::TaskShellRequest {
                    placement,
                    owner,
                    workspace_root,
                    workspace_path,
                    cwd,
                    argv,
                    env,
                    stdin,
                    timeout_ms,
                })
                .await;
            match &outcome {
                Ok(result) => {
                    fields["exit_code"] = serde_json::json!(result.exit_code);
                    fields["timed_out"] = Value::Bool(result.timed_out);
                    fields["tier"] = Value::String(result.tier.clone());
                }
                Err(error) => fields["reason"] = Value::String(error.code.clone()),
            }
            cognia_companion::audit::record_async(
                "environment_task_shell",
                device_id,
                scope.unwrap_or(""),
                if outcome.is_ok() { "allow" } else { "deny" },
                fields,
            )
            .await;
            to_json(outcome.map_err(task_shell_error)?)
        }
        "environment_task_shell_release" => {
            let provider: String = required(&args, "provider")?;
            let container_ids: Vec<String> = required(&args, "containerIds")?;
            let removed = task_shell_runtime()?
                .release_task_shell(&provider, &container_ids)
                .await
                .map_err(task_shell_error)?;
            to_json(cognia_sandbox_pool::runtime::TaskShellRelease { removed })
        }
        "connectors_register" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let adapter_id: String = required(&args, "adapter_id")?;
            let adapter_type: String = required(&args, "adapter_type")?;
            // A plugin connector has no hand-written verifier in
            // `verify_webhook`, so its declared scheme has to survive this
            // arm. Dropping it here would leave the brain, which is the host a
            // plugin connector is most likely to run on, serving an endpoint
            // that refuses everything.
            let verification: Option<
                cognia_connectors::sigverify::declarative::WebhookVerificationSpec,
            > = optional(&args, "verification")?;
            if let Some(spec) = verification.as_ref() {
                // Checked before the row lands, exactly as the Tauri command
                // does. A spec found unusable on the first inbound request is
                // one found after the endpoint has been publicly reachable.
                spec.validate().map_err(|reason| {
                    RpcError::malformed(format!(
                        "adapter {adapter_id} declares an unusable webhook verification: {reason}"
                    ))
                })?;
            }
            services.connectors.inner.lock().registered_adapters.insert(
                adapter_id.clone(),
                cognia_connectors::types::AdapterRegistration {
                    adapter_id,
                    adapter_type,
                    webhook_path: None,
                    verification,
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

        // ── Workflow mirror, trigger daemons and webhook router ─────────────
        // The `_for_state` bodies the Tauri commands wrap, served to the
        // headless brain over the internal plane. Argument names are the
        // Tauri command's, so `lib/workflow/runtime/tauri-bridge.ts` sends one
        // payload shape to both hosts.
        "workflow_register_trigger" => {
            let input: cognia_scheduling::workflow::types::RegisterTriggerInput =
                required(&args, "input")?;
            cognia_scheduling::workflow::commands::workflow_register_trigger_for_state(
                workflow_state(host)?,
                input,
            )
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "workflow_unregister_trigger" => {
            let workflow_id: String = required_aliased(&args, "workflow_id", "workflowId")?;
            let trigger_id: String = required_aliased(&args, "trigger_id", "triggerId")?;
            cognia_scheduling::workflow::commands::workflow_unregister_trigger_for_state(
                workflow_state(host)?,
                workflow_id,
                trigger_id,
            )
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "workflow_file_watch_ack" => {
            let workflow_id: String = required_aliased(&args, "workflow_id", "workflowId")?;
            let trigger_id: String = required_aliased(&args, "trigger_id", "triggerId")?;
            cognia_scheduling::workflow::commands::workflow_file_watch_ack_for_state(
                workflow_state(host)?,
                workflow_id,
                trigger_id,
            )
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "workflow_get_webhook_url" => {
            let workflow_id: String = required_aliased(&args, "workflow_id", "workflowId")?;
            let trigger_id: String = required_aliased(&args, "trigger_id", "triggerId")?;
            let url = cognia_scheduling::workflow::commands::workflow_get_webhook_url_for_state(
                workflow_state(host)?,
                workflow_id,
                trigger_id,
            )
            .map_err(RpcError::internal)?;
            to_json(url)
        }
        "workflow_webhook_respond" => {
            let correlation_id: String =
                required_aliased(&args, "correlation_id", "correlationId")?;
            let status: u16 = required(&args, "status")?;
            let body: String = required(&args, "body")?;
            let headers: Option<std::collections::BTreeMap<String, String>> =
                optional(&args, "headers")?;
            let answered =
                cognia_scheduling::workflow::commands::workflow_webhook_respond_for_state(
                    workflow_state(host)?,
                    correlation_id,
                    status,
                    body,
                    headers,
                )
                .map_err(RpcError::internal)?;
            Ok(Value::Bool(answered))
        }
        "workflow_persist_run_state" => {
            let input: cognia_scheduling::workflow::types::PersistRunStateInput =
                required(&args, "input")?;
            cognia_scheduling::workflow::commands::workflow_persist_run_state_for_state(
                workflow_state(host)?,
                input,
            )
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "workflow_reload_in_flight_runs" => {
            let rows =
                cognia_scheduling::workflow::commands::workflow_reload_in_flight_runs_for_state(
                    workflow_state(host)?,
                )
                .map_err(RpcError::internal)?;
            to_json(rows)
        }
        "workflow_ack_completed" => {
            let run_id: String = required_aliased(&args, "run_id", "runId")?;
            cognia_scheduling::workflow::commands::workflow_ack_completed_for_state(
                workflow_state(host)?,
                run_id,
            )
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "workflow_waitpoint_create" => {
            let waitpoint: cognia_scheduling::workflow::types::WorkflowWaitpointRow =
                required(&args, "waitpoint")?;
            let row = cognia_scheduling::workflow::commands::workflow_waitpoint_create_for_state(
                workflow_state(host)?,
                waitpoint,
            )
            .map_err(RpcError::internal)?;
            to_json(row)
        }
        "workflow_waitpoint_get" => {
            let waitpoint_id: String = required_aliased(&args, "waitpoint_id", "waitpointId")?;
            let row = cognia_scheduling::workflow::commands::workflow_waitpoint_get_for_state(
                workflow_state(host)?,
                waitpoint_id,
            )
            .map_err(RpcError::internal)?;
            to_json(row)
        }
        "workflow_waitpoint_list_pending" => {
            let rows =
                cognia_scheduling::workflow::commands::workflow_waitpoint_list_pending_for_state(
                    workflow_state(host)?,
                )
                .map_err(RpcError::internal)?;
            to_json(rows)
        }
        "workflow_waitpoint_decide" => {
            let input: cognia_scheduling::workflow::types::WorkflowWaitpointDecisionInput =
                required(&args, "input")?;
            let changed =
                cognia_scheduling::workflow::commands::workflow_waitpoint_decide_for_state(
                    workflow_state(host)?,
                    input,
                )
                .map_err(RpcError::internal)?;
            Ok(Value::Bool(changed))
        }
        "workflow_wait_event_persist" => {
            let event: cognia_scheduling::workflow::types::WorkflowWaitEventRow =
                required(&args, "event")?;
            cognia_scheduling::workflow::commands::workflow_wait_event_persist_for_state(
                workflow_state(host)?,
                event,
            )
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "workflow_wait_event_prune" => {
            let now: i64 = required(&args, "now")?;
            let pruned =
                cognia_scheduling::workflow::commands::workflow_wait_event_prune_for_state(
                    workflow_state(host)?,
                    now,
                )
                .map_err(RpcError::internal)?;
            to_json(pruned)
        }

        // ── Marketplace Integration ingress + encrypted spool ───────────────
        // Both hosts execute the same scheduling-crate command bodies. The
        // service-token gate above keeps webhook material and route secrets
        // inaccessible to paired-device principals.
        "integration_ingress_register" => {
            let input: cognia_scheduling::workflow::triggers::webhook_router::IntegrationIngressEntry =
                required(&args, "input")?;
            let result = {
                let workflow = workflow_state(host)?;
                cognia_scheduling::workflow::commands::integration_ingress_register_for_state(
                    workflow, input,
                )
            }
            .map_err(RpcError::internal)?;
            to_json(result)
        }

        "integration_ingress_unregister" => {
            let route_id: String = required_aliased(&args, "route_id", "routeId")?;
            {
                let workflow = workflow_state(host)?;
                cognia_scheduling::workflow::commands::integration_ingress_unregister_for_state(
                    workflow, route_id,
                )
            }
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }

        "integration_ingress_get_url" => {
            let route_id: String = required_aliased(&args, "route_id", "routeId")?;
            let result = {
                let workflow = workflow_state(host)?;
                cognia_scheduling::workflow::commands::integration_ingress_get_url_for_state(
                    workflow, route_id,
                )
            }
            .map_err(RpcError::internal)?;
            to_json(result)
        }

        "integration_ingress_poll" => {
            let limit: Option<usize> = optional(&args, "limit")?;
            let result = {
                let workflow = workflow_state(host)?;
                cognia_scheduling::workflow::commands::integration_ingress_poll_for_state(
                    workflow, limit,
                )
            }
            .map_err(RpcError::internal)?;
            to_json(result)
        }

        "integration_ingress_deadletters" => {
            let page = page_request(&args)?;
            // The spool answers its newest 500 at most. The page walks them.
            let limit = Some(500usize);
            let result = {
                let workflow = workflow_state(host)?;
                cognia_scheduling::workflow::commands::integration_ingress_deadletters_for_state(
                    workflow, limit,
                )
            }
            .map_err(RpcError::internal)?;
            cognia_companion::paging::Page::slice_all(result, &page, 100)
                .map_err(paging_error)
                .and_then(to_json)
        }

        "integration_ingress_deadletter" => {
            let route_id: String = required_aliased(&args, "route_id", "routeId")?;
            let delivery_id: String = required_aliased(&args, "delivery_id", "deliveryId")?;
            let result = {
                let workflow = workflow_state(host)?;
                cognia_scheduling::workflow::commands::integration_ingress_deadletter_for_state(
                    workflow,
                    route_id,
                    delivery_id,
                )
            }
            .map_err(RpcError::internal)?;
            to_json(result)
        }

        "integration_ingress_requeue" => {
            let route_id: String = required_aliased(&args, "route_id", "routeId")?;
            let delivery_id: String = required_aliased(&args, "delivery_id", "deliveryId")?;
            let result = {
                let workflow = workflow_state(host)?;
                cognia_scheduling::workflow::commands::integration_ingress_requeue_for_state(
                    workflow,
                    route_id,
                    delivery_id,
                )
            }
            .map_err(RpcError::internal)?;
            to_json(result)
        }

        // ADR-0176. Here rather than in `filesystem.rs` with the rest of the
        // task-workspace surface, because this one carries a credential: the
        // service plane is loopback-only and service-token gated, while the
        // device plane is reachable by a paired client holding a `host.admin`
        // lease. A GitHub installation token must not be addressable from
        // there, so the command that takes one is not exposed there.
        "task_workspace_remote_source_ensure" => {
            // `input`, matching the rest of the task-workspace surface in
            // `filesystem.rs`, not the `args` the github_workspace_* commands
            // beside it use. The Tauri handler takes `input` too, so one wire
            // shape serves the desktop invoke and the loopback RPC.
            let input: cognia_task_workspace::EnsureRemoteSource = required(&args, "input")?;
            cognia_task_workspace_host::host_surface::task_workspace_remote_source_ensure(input)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }

        // ADR-0224 A11: where a project's work runs on an always-on host, a
        // clone of its repository when none of its folders exists here.
        // Service-only for the same reason as the arm above: it clones with
        // the host's stored git credential.
        "task_workspace_project_source_ensure" => {
            let input: cognia_task_workspace::EnsureProjectSource = required(&args, "input")?;
            cognia_task_workspace_host::host_surface::task_workspace_project_source_ensure(input)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }

        "task_workspace_session_scratch_ensure" => {
            let input: cognia_task_workspace::EnsureSessionScratchWorkspace =
                required(&args, "input")?;
            cognia_task_workspace_host::host_surface::task_workspace_session_scratch_ensure(input)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }

        // ADR-0224 A11b: the checkout a handed-over conversation works in.
        // Service-only, so the brain resolves it by id and no device ever
        // names a path on this host.
        "code_snapshot_checkout_get" => {
            let checkout_id: String = required(&args, "checkoutId")?;
            cognia_task_workspace_host::host_surface::code_snapshot_checkout_get(checkout_id)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }

        "github_workspace_clone" => {
            let command_args: cognia_git::github::workspace::CloneArgs = required(&args, "args")?;
            cognia_git::github::workspace::github_workspace_clone(command_args)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }

        "github_workspace_commit_and_push" => {
            let command_args: cognia_git::github::workspace::CommitAndPushArgs =
                required(&args, "args")?;
            cognia_git::github::workspace::github_workspace_commit_and_push(command_args)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }

        "github_workspace_remove" => {
            let path: String = required(&args, "path")?;
            cognia_git::github::workspace::github_workspace_remove(path)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }

        "github_workspace_stat" => {
            let path: String = required(&args, "path")?;
            cognia_git::github::workspace::github_workspace_stat(path)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }

        "integration_ingress_ack" | "integration_ingress_nack" => {
            let route_id: String = required_aliased(&args, "route_id", "routeId")?;
            let delivery_id: String = required_aliased(&args, "delivery_id", "deliveryId")?;
            let result = {
                let workflow = workflow_state(host)?;
                if name == "integration_ingress_ack" {
                    cognia_scheduling::workflow::commands::integration_ingress_ack_for_state(
                        workflow,
                        route_id,
                        delivery_id,
                    )
                } else {
                    cognia_scheduling::workflow::commands::integration_ingress_nack_for_state(
                        workflow,
                        route_id,
                        delivery_id,
                    )
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
            let snapshot: cognia_agent_state::provider_profiles::CatalogSnapshotDoc =
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
            let staging_token = services.connectors.inner.lock().staging_token.clone();
            // On the headless front door the `/connectors` ingress router is
            // mounted by the companion server itself — there is no separately
            // started local axum server (and thus no distinct bound address).
            to_json(cognia_connectors::types::ConnectorsHealth {
                server_running: true,
                bound_addr: None,
                registered_adapter_count: count,
                staging_token: Some(staging_token),
            })
        }

        // ── Keyring arms: host-neutral on purpose (ADR-0152 D6) ──
        // These four are the only `connectors_*` commands raised to the device
        // plane (`target: host-admin`, http/ws/webrtc transports, `host.admin`
        // capability, step-up lease). The manifest therefore advertises them to
        // every paired phone, so demanding `host.headless()` here answered 503
        // on a desktop-hosted companion server for a command the client was
        // told it could call.
        //
        // Nothing below needs `HeadlessServices`: `cognia_connectors::keyring`
        // is a process-global module over the OS keychain, the same one the
        // Tauri commands in `crates/cognia-connectors/src/commands.rs` wrap.
        // Both hosts run in the process that owns that keychain, so the arm is
        // correct on either. The authorization that actually matters already
        // ran in `remote_execution::authorize_capability`.
        "connectors_keyring_set" => {
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let credential: String = required(&args, "credential")?;
            let value: String = required(&args, "value")?;
            // Indexed under the writing device (ADR-0224 A6), so the
            // credential is listed under "Secrets on this host" and goes when
            // that device is revoked.
            let writer = secret_writer(device_id, tenant_id, scope);
            let name = cognia_connectors::keyring::account_key(&adapter_id, &credential);
            tokio::task::spawn_blocking(move || {
                cognia_connectors::keyring::set(&adapter_id, &credential, &value)?;
                cognia_secrets::host_secrets::note_written(
                    cognia_secrets::host_secrets::HostSecretKind::Connector,
                    &name,
                    writer,
                    now_ms(),
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_keyring_get" => {
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let credential: String = required(&args, "credential")?;
            let value = tokio::task::spawn_blocking(move || {
                cognia_connectors::keyring::get(&adapter_id, &credential)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            to_json(value)
        }

        "connectors_keyring_delete" => {
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let credential: String = required(&args, "credential")?;
            let name = cognia_connectors::keyring::account_key(&adapter_id, &credential);
            tokio::task::spawn_blocking(move || {
                cognia_connectors::keyring::delete(&adapter_id, &credential)?;
                cognia_secrets::host_secrets::note_deleted(
                    cognia_secrets::host_secrets::HostSecretKind::Connector,
                    &name,
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_keyring_list" => {
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let accounts: Vec<String> = required(&args, "accounts")?;
            let present = tokio::task::spawn_blocking(move || {
                cognia_connectors::keyring::list(&adapter_id, &accounts)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            to_json(present)
        }

        // ── Host secrets (ADR-0224 A6) ─────────────────────────────────────
        // Provider keys and git tokens a paired owner device seals on this
        // host for unattended work. Values go in and never come back out to a
        // device: the list carries names, kinds and who set them, and only
        // the service-only `host_provider_credentials_load` returns values, to
        // this host's own runtime. Writes are `approval: interactive`, so the
        // admin lease was checked before this arm ran.
        "org_model_credential_list" | "org_model_credential_set" | "org_model_credential_delete"
        | "org_agent_policy_get" | "org_agent_policy_set"
        | "org_member_usage_get" | "org_usage_cap_set" | "org_member_usage_cap_set" => {
            require_org_server(host.kind())?;
            cognia_companion::org_policy::dispatch(name, args, device_id, tenant_id, scope).await
        }

        "host_secret_list" => {
            // The store answers its whole (sorted) list; the page walks it.
            let page = page_request(&args)?;
            let (swept, entries) = tokio::task::spawn_blocking(move || {
                let swept = sweep_revoked_writers();
                cognia_secrets::host_secrets::list().map(|entries| (swept, entries))
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            announce_sweep(swept, host);
            cognia_companion::paging::Page::slice_all(entries, &page, 100)
                .map_err(paging_error)
                .and_then(to_json)
        }

        "host_provider_credential_set" | "host_git_credential_set" => {
            let (kind, name) = host_secret_target(name, &args)?;
            let value: String = if kind == HostSecretKind::Provider {
                required_aliased(&args, "api_key", "apiKey")?
            } else {
                required(&args, "token")?
            };
            let writer = secret_writer(device_id, tenant_id, scope);
            let stored = name.clone();
            tokio::task::spawn_blocking(move || {
                cognia_secrets::host_secrets::set(kind, &stored, &value, writer, now_ms())
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::malformed)?;
            host.publish_host_event(
                SECRETS_CHANGED_EVENT,
                json!({ "kind": kind.as_str(), "name": name, "action": "set" }),
            );
            Ok(json!({ "kind": kind.as_str(), "name": name }))
        }

        "host_provider_credential_delete" | "host_git_credential_delete" => {
            let (kind, name) = host_secret_target(name, &args)?;
            let removed = name.clone();
            tokio::task::spawn_blocking(move || {
                cognia_secrets::host_secrets::delete(kind, &removed)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            host.publish_host_event(
                SECRETS_CHANGED_EVENT,
                json!({ "kind": kind.as_str(), "name": name, "action": "deleted" }),
            );
            Ok(Value::Null)
        }

        "host_provider_credentials_load" => {
            let keys = tokio::task::spawn_blocking(move || {
                // No announcement: the caller is the runtime that would reload.
                sweep_revoked_writers();
                cognia_secrets::host_secrets::provider_keys()
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            Ok(json!({
                "keys": keys
                    .into_iter()
                    .map(|(provider_id, api_key)| json!({ "providerId": provider_id, "apiKey": api_key }))
                    .collect::<Vec<_>>()
            }))
        }

        "connectors_google_docs_auth" => {
            let input: cognia_connectors::google_docs_auth::Input = required(&args, "input")?;
            let event_host = host.to_shared();
            let notify = std::sync::Arc::new(move || {
                event_host.publish_host_event(
                    cognia_connectors::google_docs_auth::CHANGED_EVENT,
                    Value::Null,
                );
            });
            to_json(
                cognia_connectors::google_docs_auth::execute_with_notify(input, notify)
                    .await
                    .map_err(RpcError::internal)?,
            )
        }

        "connectors_http_request" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: cognia_connectors::types::TauriHttpRequest = required(&args, "req")?;
            let resp = cognia_connectors::http_client::http_request(req)
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
            // A caller-preallocated handle lets the adapter subscribe to every
            // event topic before the handshake begins, so the server's first
            // frame cannot race listener registration. The desktop command
            // branches on exactly this (`crates/cognia-connectors/src/commands.rs`);
            // dropping it here made a reconnect on the brain come back under a
            // fresh id while the adapter was still listening on the old one.
            let handle_id: Option<String> = optional_aliased(&args, "handle_id", "handleId")?;
            let emitter =
                std::sync::Arc::new(cognia_companion::connector_events::ConnectorEventEmitter(
                    std::sync::Arc::clone(&services.event_bus),
                ));
            let handle_id = match handle_id {
                Some(id) => {
                    cognia_connectors::ws_client::open_ws_with_handle(emitter, url, headers, id)
                        .await
                }
                None => cognia_connectors::ws_client::open_ws(emitter, url, headers).await,
            }
            .map_err(RpcError::internal)?;
            to_json(handle_id)
        }

        "connectors_ws_send" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let handle_id: String = required_aliased(&args, "handle_id", "handleId")?;
            // Text OR binary, never both and never neither — the same rule the
            // desktop command enforces. `lib/connectors/tauri/commands.ts`
            // sends `{ handleId, binary: Array.from(bytes) }` for a binary
            // frame, so requiring `data` here made every binary send on the
            // brain a 422: Matrix media, Lark file frames and OneBot's binary
            // protocol were text-only on a headless host.
            let data: Option<String> = optional(&args, "data")?;
            let binary: Option<Vec<u8>> = optional(&args, "binary")?;
            match (data, binary) {
                (Some(data), None) => cognia_connectors::ws_client::ws_send(&handle_id, data)
                    .await
                    .map_err(RpcError::internal)?,
                (None, Some(binary)) => {
                    cognia_connectors::ws_client::ws_send_binary(&handle_id, binary)
                        .await
                        .map_err(RpcError::internal)?
                }
                _ => {
                    return Err(RpcError::malformed(
                        "exactly one of data or binary must be provided".to_string(),
                    ))
                }
            }
            Ok(Value::Null)
        }

        "connectors_ws_close" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let handle_id: String = required_aliased(&args, "handle_id", "handleId")?;
            cognia_connectors::ws_client::ws_close(&handle_id)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_onebot_send" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let call_json: String = required_aliased(&args, "call_json", "callJson")?;
            cognia_connectors::ws_server::send(&adapter_id, call_json)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        // ADR-0131 — reverse-WS OneBot liveness probe. Deliberately NOT gated
        // on `host.headless()`: it reads the in-process WS registry, which
        // exists on the desktop shell too, and a host gate would add a
        // class-C host-parity entry (that baseline may only shrink).
        "connectors_onebot_probe" => to_json(cognia_connectors::ws_server::live_clients()),

        // ADR-0131 — Discord multipart upload. Same reasoning as the probe:
        // pure HTTP against Discord, no AppHandle, so no host gate.
        "connectors_discord_upload" => {
            let req: cognia_connectors::discord_upload::ConnectorDiscordUploadRequest =
                serde_json::from_value(args).map_err(|e| {
                    RpcError::malformed(format!("connectors_discord_upload args: {e}"))
                })?;
            let message_id = cognia_connectors::discord_upload::upload(req)
                .await
                .map_err(RpcError::internal)?;
            to_json(message_id)
        }

        "connectors_lark_ws_open" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let emitter =
                std::sync::Arc::new(cognia_companion::connector_events::ConnectorEventEmitter(
                    std::sync::Arc::clone(&services.event_bus),
                ));
            let handle_id = cognia_connectors::lark_ws::open(emitter, adapter_id)
                .await
                .map_err(RpcError::internal)?;
            to_json(handle_id)
        }

        "connectors_lark_ws_close" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let handle_id: String = required_aliased(&args, "handle_id", "handleId")?;
            cognia_connectors::lark_ws::close(&handle_id)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_lark_callback_respond" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let callback_id: String = required_aliased(&args, "callback_id", "callbackId")?;
            let response: serde_json::Value = required(&args, "response")?;
            to_json(cognia_connectors::lark_callback_reply::respond(
                &callback_id,
                response,
            ))
        }

        "connectors_reset_all_ws" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let count = cognia_connectors::commands::connectors_reset_all_ws()
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
            let attachment = cognia_connectors::attachments::fetch_attachment(
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
            let bytes = cognia_connectors::attachments::read_attachment_base64(
                &adapter_id,
                &remote_ref,
                max_bytes,
            )
            .map_err(RpcError::internal)?;
            to_json(bytes)
        }

        // Cache upkeep — the sweep `lib/connectors/housekeeping-scheduler.ts`
        // runs every cycle. Deliberately NOT gated on `host.headless()` the way
        // the two arms above are: `cognia_connectors::attachments` resolves its
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
                tokio::task::spawn_blocking(cognia_connectors::attachments::list_attachments)
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
                cognia_connectors::attachments::delete_attachments(cache_keys)
            })
            .await
            .map_err(|error| RpcError::internal(format!("attachment delete task failed: {error}")))?
            .map_err(RpcError::internal)?;
            to_json(report)
        }

        "connectors_attachment_evict_adapter" => {
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let report = tokio::task::spawn_blocking(move || {
                cognia_connectors::attachments::evict_adapter_attachments(&adapter_id)
            })
            .await
            .map_err(|error| RpcError::internal(format!("attachment evict task failed: {error}")))?
            .map_err(RpcError::internal)?;
            to_json(report)
        }

        "connectors_attachment_enforce_budget" => {
            let max_total_bytes: u64 = required_aliased(&args, "max_total_bytes", "maxTotalBytes")?;
            let report = tokio::task::spawn_blocking(move || {
                cognia_connectors::attachments::enforce_cache_budget(max_total_bytes)
            })
            .await
            .map_err(|error| RpcError::internal(format!("attachment budget task failed: {error}")))?
            .map_err(RpcError::internal)?;
            to_json(report)
        }

        "connectors_media_upload" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: cognia_connectors::types::ConnectorMediaUploadRequest =
                required(&args, "req")?;
            let uri = cognia_connectors::media_upload::upload_media(req)
                .await
                .map_err(RpcError::internal)?;
            to_json(uri)
        }

        "connectors_matrix_crypto_init" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: cognia_connectors::matrix_crypto::MatrixCryptoInitRequest =
                required(&args, "req")?;
            cognia_connectors::matrix_crypto::matrix_crypto_init(req)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_matrix_crypto_close" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            cognia_connectors::matrix_crypto::matrix_crypto_close(&adapter_id)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_matrix_crypto_outgoing_requests" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let requests =
                cognia_connectors::matrix_crypto::matrix_crypto_outgoing_requests(adapter_id)
                    .await
                    .map_err(RpcError::internal)?;
            to_json(requests)
        }

        "connectors_matrix_crypto_mark_request_sent" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: cognia_connectors::matrix_crypto::MatrixCryptoMarkSentRequest =
                required(&args, "req")?;
            cognia_connectors::matrix_crypto::matrix_crypto_mark_request_sent(req)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_matrix_crypto_receive_sync_changes" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: cognia_connectors::matrix_crypto::MatrixCryptoReceiveSyncRequest =
                required(&args, "req")?;
            cognia_connectors::matrix_crypto::matrix_crypto_receive_sync_changes(req)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_matrix_crypto_decrypt_event" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: cognia_connectors::matrix_crypto::MatrixCryptoDecryptRequest =
                required(&args, "req")?;
            let response = cognia_connectors::matrix_crypto::matrix_crypto_decrypt_event(req)
                .await
                .map_err(RpcError::internal)?;
            to_json(response)
        }

        "connectors_matrix_crypto_encrypt_event" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: cognia_connectors::matrix_crypto::MatrixCryptoEncryptRequest =
                required(&args, "req")?;
            let response = cognia_connectors::matrix_crypto::matrix_crypto_encrypt_event(req)
                .await
                .map_err(RpcError::internal)?;
            to_json(response)
        }

        "connectors_matrix_crypto_share_room_key" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: cognia_connectors::matrix_crypto::MatrixCryptoShareRoomKeyRequest =
                required(&args, "req")?;
            let requests = cognia_connectors::matrix_crypto::matrix_crypto_share_room_key(req)
                .await
                .map_err(RpcError::internal)?;
            to_json(requests)
        }

        "connectors_matrix_crypto_update_tracked_users" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: cognia_connectors::matrix_crypto::MatrixCryptoTrackUsersRequest =
                required(&args, "req")?;
            cognia_connectors::matrix_crypto::matrix_crypto_update_tracked_users(req)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_matrix_crypto_get_missing_sessions" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: cognia_connectors::matrix_crypto::MatrixCryptoMissingSessionsRequest =
                required(&args, "req")?;
            let requests =
                cognia_connectors::matrix_crypto::matrix_crypto_get_missing_sessions(req)
                    .await
                    .map_err(RpcError::internal)?;
            to_json(requests)
        }

        "connectors_matrix_encrypted_media_upload" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: cognia_connectors::types::MatrixEncryptedMediaUploadRequest =
                required(&args, "req")?;
            let response = cognia_connectors::media_upload::upload_matrix_encrypted_media(req)
                .await
                .map_err(RpcError::internal)?;
            to_json(response)
        }

        "connectors_matrix_encrypted_media_fetch" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let req: cognia_connectors::types::MatrixEncryptedMediaFetchRequest =
                required(&args, "req")?;
            let response = cognia_connectors::attachments::fetch_matrix_encrypted_attachment(req)
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
            let file_key = cognia_connectors::lark_upload::upload_file(
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
            let image_key = cognia_connectors::lark_upload::upload_image(
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
            let respond_args: cognia_automation::automation::commands::ConsentRespondArgs =
                serde_json::from_value(args).map_err(|e| {
                    RpcError::malformed(format!("automation_consent_respond args: {e}"))
                })?;
            let automation = host_automation(host, name)?;
            cognia_automation::automation::commands::automation_consent_respond_for_broker(
                &automation.state.consent,
                respond_args,
            );
            Ok(Value::Null)
        }

        "automation_consent_pending" => {
            if host.headless().is_some() {
                return Err(RpcError::headless_unsupported(name));
            }
            let pending =
                cognia_automation::automation::commands::automation_consent_pending_for_broker(
                    &host_automation(host, name)?.state.consent,
                );
            to_json(pending)
        }

        // Remote supervision of a running host. Reads, plus the one write that
        // stops everything. Driving the host (click, type, screenshot, window
        // ops) keeps the client target and never crosses the wire: a phone
        // watches and halts, it does not steer.
        //
        // `automation_kill_switch` sits in CONTROL_COMMANDS beside
        // `automation_consent_respond`. A device trusted to approve an
        // automation call is trusted to stop one, and an observe-only device
        // gets the same 403 for both.
        "automation_kill_switch_engaged" => {
            if host.headless().is_some() {
                return Err(RpcError::headless_unsupported(name));
            }
            to_json(
                host_automation(host, name)?
                    .state
                    .gate
                    .kill_switch_engaged(),
            )
        }

        "automation_settings_get" => {
            if host.headless().is_some() {
                return Err(RpcError::headless_unsupported(name));
            }
            to_json(host_automation(host, name)?.state.gate.settings())
        }

        "automation_audit_snapshot" => {
            if host.headless().is_some() {
                return Err(RpcError::headless_unsupported(name));
            }
            to_json(host_automation(host, name)?.state.audit.snapshot())
        }

        "automation_kill_switch" => {
            if host.headless().is_some() {
                return Err(RpcError::headless_unsupported(name));
            }
            let automation = host_automation(host, name)?;
            cognia_automation::automation::kill_switch::engage(
                automation.events.as_ref(),
                automation.state,
                cognia_automation::automation::kill_switch::KillSwitchCause::Renderer,
            );
            Ok(Value::Null)
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
            let (tunnel_base_url, bind_lan, data_dir) = match host.companion_server() {
                Some(server_state) => {
                    let tunnel = server_state
                        .tunnel
                        .current()
                        .map(|info| info.public_url)
                        .or_else(|| server_state.tunnel.named_public_url());
                    let bind_lan = server_state
                        .bind_mode()
                        .map(|mode| matches!(mode, cognia_companion::BindMode::Lan));
                    (
                        tunnel,
                        bind_lan,
                        server_state.data_dir().map(|d| d.to_path_buf()),
                    )
                }
                // Headless: no tunnel launcher, and the listener is bound
                // `0.0.0.0`, so leave `bind_lan` unknown (= assume LAN).
                None => (None, None, None),
            };
            let server_id = cognia_companion::healthz::derive_server_id(&state.secret.read());
            Ok(endpoints_response(
                lan_base_url(bind_lan, data_dir.as_deref()),
                tunnel_base_url,
                cognia_companion::tls_fingerprint(),
                server_id,
            ))
        }

        // Langfuse is a narrow, account-bound AI trace destination. The
        // authenticated principal determines the account; callers cannot
        // select another namespace or supply export headers at ingest time.
        "langfuse_credentials_set" => {
            let account = langfuse_account(tenant_id)?;
            let enabled: bool = required(&args, "enabled")?;
            let base_url: String = required_aliased(&args, "base_url", "baseUrl")?;
            let public_key: String = required_aliased(&args, "public_key", "publicKey")?;
            let secret_key: Option<String> = optional_aliased(&args, "secret_key", "secretKey")?;
            let environment: String = required(&args, "environment")?;
            let capture_model_content: bool =
                optional_aliased(&args, "capture_model_content", "captureModelContent")?
                    .unwrap_or(false);
            let capture_tool_content: bool =
                optional_aliased(&args, "capture_tool_content", "captureToolContent")?
                    .unwrap_or(false);
            cognia_sidecar::langfuse::credentials_set_for_account_async(
                account.to_string(),
                enabled,
                base_url,
                public_key,
                secret_key,
                environment,
                capture_model_content,
                capture_tool_content,
            )
            .await
            .map_err(RpcError::validation_failed)?;
            cognia_sidecar::supervisor::restart_sidecar_for_config(host.sidecar_state())
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "langfuse_credentials_status" => {
            let account = langfuse_account(tenant_id)?;
            let status =
                cognia_sidecar::langfuse::credentials_status_for_account_async(account.to_string())
                    .await
                    .map_err(RpcError::internal)?;
            to_json(status)
        }

        "langfuse_credentials_clear" => {
            let account = langfuse_account(tenant_id)?;
            cognia_sidecar::langfuse::credentials_clear_for_account_async(account.to_string())
                .await
                .map_err(RpcError::internal)?;
            cognia_sidecar::supervisor::restart_sidecar_for_config(host.sidecar_state())
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "langfuse_connection_test" => {
            let account = langfuse_account(tenant_id)?;
            let status = cognia_sidecar::langfuse::connection_test_for_account(account)
                .await
                .map_err(RpcError::internal)?;
            to_json(status)
        }

        "langfuse_trace_ingest" => {
            let account = langfuse_account(tenant_id)?;
            let batch: cognia_sidecar::langfuse::AgentTraceBatchV1 = required(&args, "batch")?;
            let result = cognia_sidecar::langfuse::trace_ingest_for_account(account, batch)
                .await
                .map_err(map_langfuse_ingest_error)?;
            to_json(result)
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
            let transport = cognia_companion::ws_bridge::resolve_bridge_transport(state)
                .map_err(RpcError::service_unavailable)?;
            bridge
                .dispatch(
                    transport.as_ref(),
                    name,
                    args,
                    cognia_companion::desktop_writes_bridge::DEFAULT_TIMEOUT,
                )
                .await
                .map_err(RpcError::internal)
        }
        unknown => Err(RpcError::unknown_command(unknown)),
    };
    result
}

// ---------------------------------------------------------------------------
// Host secrets (ADR-0224 A6)
// ---------------------------------------------------------------------------

use cognia_secrets::host_secrets::{HostSecretKind, SecretWriter};

/// Published when a host secret is set or removed; the host's own runtime
/// reloads its provider keys on it. Kind and name only.
const SECRETS_CHANGED_EVENT: &str = "host://secrets-changed";

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

/// The device a secret write is attributed to, or `None` for this host's own
/// loopback caller. Only an attributed secret is deleted when its writer is
/// revoked. The label is the device's name on this host at write time.
fn secret_writer(
    device_id: &str,
    tenant_id: Option<&str>,
    scope: Option<&str>,
) -> Option<SecretWriter> {
    if cognia_companion::jwt::is_service_scope(scope) || device_id.is_empty() {
        return None;
    }
    let label = tenant_id.and_then(|tenant| {
        cognia_companion::security_store::security_store()?
            .list_devices(tenant)
            .ok()?
            .into_iter()
            .find(|device| device.device_id == device_id)
            .map(|device| device.display_name)
    });
    Some(SecretWriter {
        device_id: device_id.to_string(),
        label,
    })
}

/// Which secret a provider or git command names, validated.
fn host_secret_target(
    command: &str,
    args: &Value,
) -> Result<(HostSecretKind, String), (StatusCode, Json<RpcError>)> {
    if command.starts_with("host_provider_") {
        let provider_id: String = required_aliased(args, "provider_id", "providerId")?;
        let provider_id = provider_id.trim().to_string();
        cognia_secrets::host_secrets::validate_name(HostSecretKind::Provider, &provider_id)
            .map_err(RpcError::malformed)?;
        Ok((HostSecretKind::Provider, provider_id))
    } else {
        let host: String = required(args, "host")?;
        let host =
            cognia_secrets::host_secrets::normalize_git_host(&host).map_err(RpcError::malformed)?;
        Ok((HostSecretKind::Git, host))
    }
}

/// Drop the secrets of devices revoked behind this process's back (the
/// `cognia-server devices` CLI beside a running server) before answering with
/// what is stored. Always against the host's own device registry, never the
/// caller's tenant claim (see `sweep_revoked_host_device_secrets`). Blocking:
/// run it off the async executor.
fn sweep_revoked_writers() -> usize {
    cognia_companion::device_lifecycle::sweep_revoked_host_device_secrets()
}

/// Tell the runtime its provider keys may have changed.
fn announce_sweep(swept: usize, host: &dyn crate::rpc_host::RpcHost) {
    if swept > 0 {
        host.publish_host_event(SECRETS_CHANGED_EVENT, json!({ "action": "swept" }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p6a_org_commands_never_enable_the_desktop_host() {
        for kind in ["tauri", "unknown"] {
            let (status, error) = require_org_server(kind).unwrap_err();
            assert_eq!(status, StatusCode::CONFLICT);
            assert_eq!(error.0.code, "org_scope_unavailable");
        }
        assert!(require_org_server("headless").is_ok());
    }

    #[tokio::test]
    async fn p6b_usage_commands_refuse_non_server_hosts() {
        // Single-user by env: wait out a P6e test that runs with multi-tenant set.
        let _slot = cognia_companion::ws_bridge::test_support::lock_slot().await;
        let temp = tempfile::tempdir().unwrap();
        let state = bound_state(temp.path().into());
        let host = crate::headless::HeadlessServices::stub_for_tests();
        for command in ["org_member_usage_get", "org_usage_cap_set", "org_member_usage_cap_set"] {
            let (status, error) = dispatch(command, json!({"orgId":"org_p6b_rpc"}), &state, &host, "operator", Some("tenant"), Some("service")).await.unwrap_err();
            assert_eq!(status, StatusCode::CONFLICT);
            assert_eq!(error.0.code, "org_scope_unavailable");
        }
    }

    #[tokio::test]
    async fn p6a_org_service_arms_preserve_the_single_user_refusal() {
        // Single-user by env: wait out a P6e test that runs with multi-tenant set.
        let _slot = cognia_companion::ws_bridge::test_support::lock_slot().await;
        let temp = tempfile::tempdir().unwrap();
        let state = bound_state(temp.path().into());
        let host = crate::headless::HeadlessServices::stub_for_tests();
        for command in cognia_companion::org_policy::COMMANDS {
            let (status, error) = dispatch(command, json!({"orgId":"org_p6a_rpc"}), &state, &host, "operator", Some("tenant"), Some("service")).await.unwrap_err();
            assert_eq!(status, StatusCode::CONFLICT);
            assert_eq!(error.0.code, "org_scope_unavailable");
        }
    }

    #[derive(Default)]
    struct BoundBackend {
        agents: parking_lot::Mutex<
            std::collections::HashMap<
                String,
                cognia_external_agent::process::ExternalAgentSpawnConfig,
            >,
        >,
        killed: parking_lot::Mutex<Vec<String>>,
        fail_store: parking_lot::Mutex<Option<std::path::PathBuf>>,
        writable_mount: std::sync::atomic::AtomicBool,
        sinks: parking_lot::Mutex<
            std::collections::HashMap<
                String,
                std::sync::Arc<dyn cognia_external_agent::process::ExternalAgentEventSink>,
            >,
        >,
        pause_send: std::sync::atomic::AtomicBool,
        fail_kill: std::sync::atomic::AtomicBool,
        person_keep_running_after_kill: std::sync::atomic::AtomicBool,
        send_started: tokio::sync::Notify,
        send_resume: tokio::sync::Notify,
    }
    #[async_trait::async_trait]
    impl cognia_external_agent::exec_backend::ExecBackend for BoundBackend {
        async fn spawn(
            &self,
            config: cognia_external_agent::process::ExternalAgentSpawnConfig,
            sink: std::sync::Arc<dyn cognia_external_agent::process::ExternalAgentEventSink>,
        ) -> Result<String, String> {
            if config.id == "failed" {
                return Err("fixture_spawn_failed".into());
            }
            if config.id == "early" {
                sink.exited(&config.id, Some(0), None);
            }
            if let Some(root) = self.fail_store.lock().take() {
                std::fs::create_dir_all(root.join("companion/execution-bindings.json")).unwrap();
            }
            let id = config.id.clone();
            self.sinks.lock().insert(id.clone(), sink);
            self.agents.lock().insert(id.clone(), config);
            Ok(id)
        }
        async fn send(&self, _: &str, _: &str) -> Result<(), String> {
            if self
                .pause_send
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                self.send_started.notify_one();
                self.send_resume.notified().await;
            }
            Ok(())
        }
        async fn kill(&self, id: &str) -> Result<(), String> {
            if self
                .fail_kill
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                return Err("fixture_kill_failed".into());
            }
            if !self.person_keep_running_after_kill.load(std::sync::atomic::Ordering::SeqCst) { self.agents.lock().remove(id); }
            self.killed.lock().push(id.into());
            Ok(())
        }
        async fn kill_all(&self) -> Result<(), String> {
            self.agents.lock().clear();
            Ok(())
        }
        async fn status(
            &self,
            id: &str,
        ) -> Option<cognia_external_agent::process::ExternalAgentProcessState> {
            self.agents
                .lock()
                .contains_key(id)
                .then_some(cognia_external_agent::process::ExternalAgentProcessState::Running)
        }
        async fn list(&self) -> Vec<String> {
            self.agents.lock().keys().cloned().collect()
        }
        async fn is_running(&self, id: &str) -> Result<bool, String> {
            Ok(self.agents.lock().contains_key(id))
        }
        async fn get_info(&self, id: &str) -> Result<Value, String> {
            let agents = self.agents.lock();
            let config = agents.get(id).ok_or("missing fixture agent")?;
            Ok(
                serde_json::json!({"placement":{"kind":"sandbox", "workspaceReadOnly":!self.writable_mount.load(std::sync::atomic::Ordering::SeqCst), "binding":config.sandbox.as_ref().and_then(|placement| placement.binding())}}),
            )
        }
        async fn set_running(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        async fn set_failed(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn kind(&self) -> &'static str {
            "container"
        }
        fn routes_sandboxes(&self) -> bool {
            true
        }
    }

    fn bound_state(root: std::path::PathBuf) -> SharedState {
        use cognia_companion::*;
        use std::sync::Arc;
        struct Runtime(std::path::PathBuf);
        #[async_trait::async_trait]
        impl runtime::CompanionRuntime for Runtime {
            fn execution_binding_root(&self, _: &SharedState) -> Option<std::path::PathBuf> {
                Some(self.0.clone())
            }
            fn execution_workspace_base(&self, _: &SharedState) -> Option<std::path::PathBuf> {
                self.0.parent().map(|parent| parent.join("workspaces"))
            }
            fn ide_relay_routes(&self) -> axum::Router<SharedState> {
                axum::Router::new()
            }
            fn can_dispatch(&self, _: &SharedState) -> bool {
                true
            }
            async fn dispatch(
                &self,
                _: &str,
                _: Value,
                _: &SharedState,
                _: &middleware::DeviceContext,
                _: remote_execution::ExecutionPlane,
            ) -> runtime::DispatchResult {
                unreachable!("test calls the actual service-plane arm directly")
            }
        }
        Arc::new(CompanionState {
            secret: parking_lot::RwLock::new(vec![0; 32]),
            deny_list: Arc::new(deny_list::DenyList::new()),
            renderer: None,
            runtime: Arc::new(Runtime(root)),
            idempotency: Arc::new(idempotency::IdempotencyCache::new()),
            event_bus: event_bus::EventBus::new(),
            sync_bridge: sync_bridge::SyncBridge::new(),
            desktop_messages_bridge: desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge: desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: rate_limit::RateLimiter::with_defaults(),
            push_tokens: push::PushTokenRegistry::new(),
        })
    }

    #[test]
    fn p6d_backend_credential_refusal_keeps_its_code_and_forbidden_status() {
        let error = spawn_execution_error("credential_delivery_refused: person runs require brokered credentials only".into());
        assert_eq!(error.0, StatusCode::FORBIDDEN);
        assert_eq!(error.1.code, "credential_delivery_refused");
    }

    #[tokio::test]
    async fn p6d_single_user_operator_spawn_keeps_plain_env_and_needs_no_person_lease() {
        use std::sync::Arc;
        let _slot = cognia_companion::ws_bridge::test_support::lock_slot().await;
        struct Restore(Option<std::ffi::OsString>);
        impl Drop for Restore { fn drop(&mut self) { match self.0.take() {
            Some(value) => unsafe { std::env::set_var("COGNIA_DEPLOYMENT_MODE",value) },
            None => unsafe { std::env::remove_var("COGNIA_DEPLOYMENT_MODE") },
        } } }
        let _mode = Restore(std::env::var_os("COGNIA_DEPLOYMENT_MODE"));
        unsafe { std::env::set_var("COGNIA_DEPLOYMENT_MODE","single-user"); }
        let temp = tempfile::tempdir().unwrap(); let workspace = temp.path().join("workspaces/project"); std::fs::create_dir_all(&workspace).unwrap();
        let backend = Arc::new(BoundBackend::default());
        let mut host = crate::headless::HeadlessServices::stub_for_tests(); let services = Arc::get_mut(&mut host).unwrap();
        services.exec = backend.clone(); services.spawn_policy = cognia_external_agent::presets::SpawnPolicy::new(temp.path().join("workspaces"),false);
        let state = bound_state(temp.path().join("data"));
        let result = dispatch("spawn_external_agent",serde_json::json!({"config":{"id":"p6d-operator","command":"codex-acp",
            "cwd":workspace.to_str().unwrap(),"env":{"ANTHROPIC_API_KEY":"operator-own-key"}}}),&state,&host,"operator",Some("operator"),Some("service")).await.unwrap();
        assert_eq!(result,"p6d-operator");
        let config = backend.agents.lock()["p6d-operator"].clone();
        assert_eq!(config.env["ANTHROPIC_API_KEY"],"operator-own-key"); assert!(config.sandbox.is_none());
        assert!(!config.env.contains_key("COGNIA_GATEWAY_TASK_CONFIG"));
    }

    #[tokio::test]
    async fn p6d_watchdog_kills_over_cap_and_preserves_reason_in_exit_event() {
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
        use cognia_external_agent::exec_backend::AgentEventEmitter;
        let temp = tempfile::tempdir().unwrap();
        let person = cognia_companion::person_partition::PersonPartition::new("org_p6d_quota".into(),"usr_p6d_quota".into());
        let _standing = cognia_companion::host_surface_gate::person_standing_test_support::Installed::new(&person.org_id);
        let binding = cognia_external_agent::spawn_authority::PlacementBinding { org_id:person.org_id.clone(),actor_user_id:person.user_id.clone(),
            workspace_id:format!("person:{}",person.account_id),run_id:"p6d-quota-generation".into() };
        let backend = Arc::new(BoundBackend::default());
        let config = serde_json::from_value(serde_json::json!({"id":"p6d-quota-agent","command":"pi","sandbox":{
            "kind":"container","spec":{},"isolationMandatory":true,"binding":binding}})).unwrap();
        backend.agents.lock().insert("p6d-quota-agent".into(),config);
        let file = std::fs::File::create(temp.path().join("over-cap")).unwrap();
        file.set_len(cognia_external_agent::person_workspace::person_workspace_max_bytes().unwrap()+1).unwrap();
        let bus = cognia_companion::event_bus::EventBus::new();
        struct UnexpectedEmitter;
        impl AgentEventEmitter for UnexpectedEmitter { fn emit(&self,_: &str,_: Value) { panic!("person event leaked to operator emitter"); } }
        let reason = Arc::new(parking_lot::RwLock::new(None)); let exited = Arc::new(AtomicBool::new(false));
        let emitter = Arc::new(BindingEmitter { inner:Arc::new(UnexpectedEmitter),directory:temp.path().join("data"),binding:binding.clone(),
            agent_id:"p6d-quota-agent".into(),exited:exited.clone(),runtime:tokio::runtime::Handle::current(),person_bus:Some(bus.clone()),person_reason:reason.clone() });
        person_watchdog_with_interval(temp.path().into(),"p6d-quota-agent".into(),binding,backend.clone(),emitter.clone(),exited.clone(),reason.clone(),std::time::Duration::from_millis(1));
        tokio::time::timeout(std::time::Duration::from_secs(3),async {
            while backend.killed.lock().is_empty() { tokio::time::sleep(std::time::Duration::from_millis(1)).await; }
        }).await.unwrap();
        assert_eq!(reason.read().as_deref(),Some("person_workspace_quota_exceeded"));
        assert_eq!(*backend.killed.lock(),vec!["p6d-quota-agent"]);
        emitter.emit("external-agent://exit",serde_json::json!({"agentId":"p6d-quota-agent","code":0}));
        emitter.emit("external-agent://session-event",serde_json::json!({"agentId":"p6d-quota-agent","data":"event"}));
        assert!(exited.load(Ordering::SeqCst));
        let cognia_companion::event_bus::SubscribeResult::Ok { replay,.. } = bus.subscribe(Some(0),0) else { panic!("replay"); };
        for event in replay {
            assert_eq!(event.partition_account_id.as_deref(),Some(person.account_id.as_str()));
            if event.event_type != "external-agent://session-event" { assert_eq!(event.payload["reason"],"person_workspace_quota_exceeded"); }
        }
        assert_eq!(cognia_external_agent::person_workspace::PERSON_WORKSPACE_INTERVAL,std::time::Duration::from_secs(30));
    }

    #[tokio::test]
    async fn p6d_purge_kills_only_owned_runs_and_refuses_failed_kill() {
        use std::sync::Arc;
        use cognia_external_agent::spawn_authority::{ExecutionAdmission, PlacementBinding, with_execution_admission};
        use cognia_companion::{person_partition::PersonPartition,host_surface_gate};
        let temp = tempfile::tempdir().unwrap(); let data = temp.path().join("data");
        let state = bound_state(data.clone()); let backend = Arc::new(BoundBackend::default());
        let policy = cognia_external_agent::presets::SpawnPolicy::from_env(&data);
        let a = PersonPartition::new("org_p6d_stop".into(),"usr_p6d_stop_a".into());
        let b = PersonPartition::new(a.org_id.clone(),"usr_p6d_stop_b".into());
        let mut roots = Vec::new();
        for person in [&a,&b] {
            let (root,_) = cognia_external_agent::person_workspace::person_workspace_prepare(&policy,&person.account_id,None,1024).unwrap();
            let binding = PlacementBinding { org_id:person.org_id.clone(),actor_user_id:person.user_id.clone(),workspace_id:format!("person:{}",person.account_id),run_id:person.account_id.clone() };
            let config = serde_json::from_value(serde_json::json!({"id":person.account_id,"command":"pi","cwd":root.to_str().unwrap(),
                "sandbox":{"kind":"container","spec":{},"isolationMandatory":true,"binding":binding}})).unwrap();
            backend.agents.lock().insert(person.account_id.clone(),config);
            with_execution_admission(Some(ExecutionAdmission { binding,actions:vec!["execution.request".into(),"workspace.write".into()] }),
                host_surface_gate::persist_execution_binding(&state,"spawn_external_agent",&serde_json::json!({"config":{"id":person.account_id}}),root.to_str().unwrap())).await.unwrap();
            roots.push(root);
        }
        backend.fail_kill.store(true,std::sync::atomic::Ordering::SeqCst);
        assert_eq!(host_surface_gate::person_stop_execution(Some(&data),&a,backend.as_ref(),std::time::Duration::from_secs(1)).await,Err("person_brain_busy"));
        assert!(roots[0].exists()); assert!(backend.agents.lock().contains_key(&a.account_id));
        backend.person_keep_running_after_kill.store(true,std::sync::atomic::Ordering::SeqCst);
        assert_eq!(host_surface_gate::person_stop_execution(Some(&data),&a,backend.as_ref(),std::time::Duration::from_millis(20)).await,Err("person_brain_busy"));
        assert!(roots[0].exists());
        backend.person_keep_running_after_kill.store(false,std::sync::atomic::Ordering::SeqCst);
        assert_eq!(host_surface_gate::person_stop_execution(Some(&data),&a,backend.as_ref(),std::time::Duration::from_secs(1)).await,Ok(1));
        cognia_external_agent::person_workspace::person_workspace_remove(&policy,&a.account_id).unwrap();
        host_surface_gate::person_remove_execution_records(&data,&a).unwrap();
        assert!(!roots[0].exists()); assert!(roots[1].exists());
        assert!(backend.agents.lock().contains_key(&b.account_id));
        let records: Value = serde_json::from_slice(&std::fs::read(data.join("companion/execution-bindings.json")).unwrap()).unwrap();
        assert_eq!(records.as_object().unwrap().len(),1);
        assert!(records.get(format!("external-agent:{}",b.account_id)).is_some());
    }

    #[tokio::test]
    async fn p6d_purge_stale_record_never_kills_a_foreign_replacement() {
        use cognia_companion::{host_surface_gate, person_partition::PersonPartition};
        let temp = tempfile::tempdir().unwrap();
        let a = PersonPartition::new("org_p6d_stale".into(), "usr_p6d_stale_a".into());
        let b = PersonPartition::new(a.org_id.clone(), "usr_p6d_stale_b".into());
        let binding = |person: &PersonPartition| serde_json::json!({"orgId":person.org_id,
            "workspaceId":format!("person:{}",person.account_id),"actorUserId":person.user_id,"runId":person.account_id});
        let directory = temp.path().join("companion");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("execution-bindings.json"),
            serde_json::to_vec(&serde_json::json!({"external-agent:reused":binding(&a)})).unwrap()).unwrap();
        let backend = BoundBackend::default();
        backend.agents.lock().insert("reused".into(), serde_json::from_value(serde_json::json!({
            "id":"reused","command":"pi","sandbox":{"kind":"container","spec":{},
                "isolationMandatory":true,"binding":binding(&b)}})).unwrap());
        assert_eq!(host_surface_gate::person_stop_execution(Some(temp.path()), &a, &backend,
            std::time::Duration::from_secs(1)).await, Err("person_brain_busy"));
        assert!(backend.killed.lock().is_empty());
        assert!(backend.agents.lock().contains_key("reused"));
    }

    // P6d uses the existing fake execution backend, real dispatch and replay bus.
    // Run with --features test-support,cognia-gateway/test-support: the gateway
    // publishes fixture listener facts without attempting a forbidden bind.
    fn person_p6e_lease(person: &cognia_companion::person_partition::PersonPartition, task: &str)
        -> (cognia_gateway::GatewayState, cognia_gateway::task_lease::TaskLease) {
        let gateway = cognia_gateway::GatewayState::new();
        let provider = serde_json::from_value(serde_json::json!({"id":"p6e-provider","protocol":"openai","enabled":true,
            "apiKey":"p6e-private-key","baseUrl":"https://fixture.invalid/v1","models":["model"]})).unwrap();
        let lease = gateway.person_mint_task_lease(&person.account_id,
            cognia_gateway::route_ticket::MemberBinding { org_id:person.org_id.clone(), user_id:person.user_id.clone() },
            "pi", task, gateway.status().account_generation, provider, "model".into(), "openai-chat").unwrap();
        (gateway, lease)
    }

    #[tokio::test]
    async fn p6e_operator_send_waits_for_spawn_fence_and_rechecks_person_owner() {
        use std::sync::Arc;
        let temp = tempfile::tempdir().unwrap();
        let state = bound_state(temp.path().join("data"));
        let backend = Arc::new(BoundBackend::default());
        let mut host = crate::headless::HeadlessServices::stub_for_tests();
        Arc::get_mut(&mut host).unwrap().exec = backend.clone();
        let person = cognia_companion::person_partition::PersonPartition::new("org_p6e_send_race".into(), "usr_p6e_send_race".into());
        let id = "p6e-send-spawn-race";
        let run = execution_lifecycle_lock(id).lock_owned().await;
        let args = serde_json::json!({"agentId":id,"message":"hello"});
        let mut send = Box::pin(dispatch("send_to_external_agent", args, &state, &host, "operator", None, Some("service")));
        assert!(tokio::time::timeout(std::time::Duration::from_millis(20), &mut send).await.is_err());
        backend.agents.lock().insert(id.into(), serde_json::from_value(serde_json::json!({"id":id,"command":"pi",
            "sandbox":{"kind":"container","spec":{},"isolationMandatory":true,"binding":{
                "orgId":person.org_id,"workspaceId":format!("person:{}",person.account_id),"actorUserId":person.user_id,"runId":"generation"}}})).unwrap());
        drop(run);
        assert_eq!(send.await.unwrap_err().1.code, "host_surface_forbidden");
    }

    #[tokio::test]
    async fn p6e_send_is_partition_owned_and_leases_end_at_exit_kill_purge_or_failure() {
        use cognia_companion::{person_partition::{PersonPartition, scope, person_test_support::Installed}, host_surface_gate as gate};
        use cognia_external_agent::{spawn_authority::{ExecutionAdmission, PlacementBinding, with_execution_admission}, exec_backend::AgentEventEmitter};
        use std::sync::{Arc, atomic::AtomicBool};
        let _slot = cognia_companion::ws_bridge::test_support::lock_slot().await;
        let a = PersonPartition::new("org_p6e_controls".into(), "usr_p6e_controls_a".into());
        let b = PersonPartition::new(a.org_id.clone(), "usr_p6e_controls_b".into());
        let (_fleet, _) = Installed::new(vec![a.clone(), b.clone()]);
        for ending in ["exit", "kill", "purge", "spawn-failure", "terminal-status"] {
            let standing = gate::person_standing_test_support::Installed::new(&a.org_id);
            let temp = tempfile::tempdir().unwrap(); let data = temp.path().join("data");
            let state = bound_state(data.clone()); let id = format!("p6e-{ending}");
            let policy = cognia_external_agent::presets::SpawnPolicy::from_env(&data);
            let (workspace, _) = cognia_external_agent::person_workspace::person_workspace_prepare(&policy, &a.account_id, None, 1024).unwrap();
            let (gateway, minted) = person_p6e_lease(&a, &id);
            let backend = Arc::new(BoundBackend::default());
            let mut host = crate::headless::HeadlessServices::stub_for_tests();
            let services = Arc::get_mut(&mut host).unwrap(); services.exec = backend.clone(); services.data_dir = data.clone(); services.gateway = Arc::new(gateway.clone());
            let binding = PlacementBinding { org_id:a.org_id.clone(), workspace_id:format!("person:{}",a.account_id), actor_user_id:a.user_id.clone(), run_id:id.clone() };
            let decision = ExecutionAdmission { binding:binding.clone(), actions:vec!["execution.request".into(),"workspace.write".into(),"credential.use".into()] };
            let config = serde_json::from_value(serde_json::json!({"id":id,"command":"pi","env":{"COGNIA_GATEWAY_TOKEN":minted.secret},
                "sandbox":{"kind":"container","spec":{},"isolationMandatory":true,"binding":binding}})).unwrap();
            let mut lease = with_execution_admission(Some(decision.clone()), async { crate::person_execution::person_bind_spawn_lease(&host, &config) }).await.unwrap();
            assert_eq!(with_execution_admission(Some(decision.clone()), async { crate::person_execution::person_bind_spawn_lease(&host, &config).err().unwrap().1.code.clone() }).await,"credential_delivery_refused");
            if ending == "spawn-failure" {
                drop(lease);
            } else {
                lease.commit(); backend.agents.lock().insert(id.clone(), config);
                with_execution_admission(Some(decision.clone()), gate::persist_execution_binding(&state,"spawn_external_agent",&serde_json::json!({"config":{"id":id}}),workspace.to_str().unwrap())).await.unwrap();
                scope(Some(a.clone()), with_execution_admission(Some(decision.clone()), dispatch("send_to_external_agent",
                    serde_json::json!({"agentId":id,"message":"{\"id\":1,\"method\":\"initialize\"}"}), &state,&host,"brain-a",Some(&a.account_id),Some("person-brain")))).await.unwrap();
                assert_eq!(dispatch("send_to_external_agent",serde_json::json!({"agentId":id,"message":"hello"}),&state,&host,"operator",None,Some("service")).await.unwrap_err().1.code,"host_surface_forbidden");
                let foreign = ExecutionAdmission { binding:PlacementBinding { workspace_id:format!("person:{}",b.account_id),actor_user_id:b.user_id.clone(),..binding.clone() },actions:decision.actions.clone() };
                assert_eq!(scope(Some(b.clone()), with_execution_admission(Some(foreign), dispatch("send_to_external_agent",
                    serde_json::json!({"agentId":id,"message":"hello"}),&state,&host,"brain-b",Some(&b.account_id),Some("person-brain")))).await.unwrap_err().1.code,"host_surface_forbidden");
                match ending {
                    "exit" => {
                        standing.refuse("host_surface_forbidden");
                        assert_eq!(scope(Some(a.clone()), with_execution_admission(Some(decision.clone()), dispatch("send_to_external_agent",
                            serde_json::json!({"agentId":id,"message":"standing lost"}), &state,&host,"brain-a",Some(&a.account_id),Some("person-brain")))).await.unwrap_err().1.code,"host_surface_forbidden");
                        let emitter = BindingEmitter { inner:host.agent_event_emitter(),directory:data,binding:binding.clone(),agent_id:id.clone(),
                            exited:Arc::new(AtomicBool::new(false)),runtime:tokio::runtime::Handle::current(),person_bus:Some(state.event_bus.clone()),person_reason:Arc::new(parking_lot::RwLock::new(None)) };
                        emitter.emit("external-agent://exit",serde_json::json!({"agentId":id,"code":0}));
                    }
                    "kill" => { scope(Some(a.clone()),with_execution_admission(Some(decision),dispatch("kill_external_agent",serde_json::json!({"agentId":id}),
                        &state,&host,"brain-a",Some(&a.account_id),Some("person-brain")))).await.unwrap(); }
                    "purge" => { gate::person_stop_execution(Some(&data),&a,backend.as_ref(),std::time::Duration::from_secs(1)).await.unwrap(); }
                    "terminal-status" => {
                        // A backend can discover terminal state without an exit
                        // callback (for example after reconciling a dead runner).
                        backend.agents.lock().remove(&id);
                        let error = scope(Some(a.clone()), with_execution_admission(Some(decision), dispatch("get_external_agent_status",
                            serde_json::json!({"agentId":id}), &state,&host,"brain-a",Some(&a.account_id),Some("person-brain")))).await.unwrap_err();
                        assert_eq!(error.1.code, "workspace_unresolved");
                    }
                    _ => unreachable!(),
                }
            }
            assert!(gateway.tickets.validate(&minted.secret,chrono::Utc::now().timestamp_millis()).is_err(),"{ending}");
        }
    }

    #[tokio::test]
    async fn p6e_watchdog_standing_loss_stops_run_revokes_ticket_and_preserves_reason() {
        use cognia_companion::{person_partition::PersonPartition, host_surface_gate as gate};
        use cognia_external_agent::{spawn_authority::{ExecutionAdmission, PlacementBinding, with_execution_admission}, exec_backend::AgentEventEmitter};
        use std::sync::{Arc, atomic::AtomicBool};
        let person = PersonPartition::new("org_p6e_watchdog".into(),"usr_p6e_watchdog".into());
        let standing = gate::person_standing_test_support::Installed::new(&person.org_id);
        let temp = tempfile::tempdir().unwrap(); let id = "p6e-standing-run";
        let binding = PlacementBinding { org_id:person.org_id.clone(), workspace_id:format!("person:{}",person.account_id),actor_user_id:person.user_id.clone(),run_id:id.into() };
        let decision = ExecutionAdmission { binding:binding.clone(), actions:vec![] };
        let (gateway,minted) = person_p6e_lease(&person,id);
        let config = serde_json::from_value(serde_json::json!({"id":id,"command":"pi","env":{"COGNIA_GATEWAY_TOKEN":minted.secret},
            "sandbox":{"kind":"container","spec":{},"isolationMandatory":true,"binding":binding}})).unwrap();
        let backend = Arc::new(BoundBackend::default());
        let mut host = crate::headless::HeadlessServices::stub_for_tests(); Arc::get_mut(&mut host).unwrap().gateway = Arc::new(gateway.clone());
        let mut lease = with_execution_admission(Some(decision),async { crate::person_execution::person_bind_spawn_lease(&host,&config) }).await.unwrap(); lease.commit();
        backend.agents.lock().insert(id.into(),config);
        let bus = cognia_companion::event_bus::EventBus::new(); let exited = Arc::new(AtomicBool::new(false)); let reason = Arc::new(parking_lot::RwLock::new(None));
        let emitter = Arc::new(BindingEmitter { inner:host.agent_event_emitter(), directory:temp.path().join("data"), binding:binding.clone(),agent_id:id.into(),
            exited:exited.clone(),runtime:tokio::runtime::Handle::current(),person_bus:Some(bus.clone()),person_reason:reason.clone() });
        standing.refuse("host_surface_forbidden");
        person_watchdog_with_interval(temp.path().into(),id.into(),binding,backend.clone(),emitter.clone(),exited,reason.clone(),std::time::Duration::from_millis(1));
        tokio::time::timeout(std::time::Duration::from_secs(2),async {
            while backend.killed.lock().is_empty() { tokio::time::sleep(std::time::Duration::from_millis(1)).await; }
        }).await.unwrap();
        assert_eq!(reason.read().as_deref(),Some("host_surface_forbidden"));
        assert!(gateway.tickets.validate(&minted.secret,chrono::Utc::now().timestamp_millis()).is_err());
        emitter.emit("external-agent://exit",serde_json::json!({"agentId":id,"code":0}));
        let cognia_companion::event_bus::SubscribeResult::Ok { replay,.. } = bus.subscribe(Some(0),0) else { panic!("replay"); };
        assert_eq!(replay.len(),2);
        for event in replay { assert_eq!(event.payload["reason"],"host_surface_forbidden"); assert_eq!(event.partition_account_id.as_deref(),Some(person.account_id.as_str())); }
    }

    #[cfg(feature = "test-support")]
    #[tokio::test]
    async fn p6d_person_spawn_backend_binding_brokerage_isolation_and_events() {
        use cognia_companion::{person_partition::{PersonPartition, scope as person_scope, person_test_support::Installed}, environment_pool};
        use cognia_external_agent::spawn_authority::{ExecutionAdmission, PlacementBinding, with_execution_admission};
        use std::sync::Arc;
        let _slot = cognia_companion::ws_bridge::test_support::lock_slot().await;
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        struct RestorePool(Option<environment_pool::PoolServices>);
        impl Drop for RestorePool { fn drop(&mut self) { environment_pool::uninstall(); if let Some(pool) = self.0.take() { environment_pool::install(pool); } } }
        let _pool = RestorePool(environment_pool::installed());
        environment_pool::install(environment_pool::person_pool_test_support(vec![cognia_environment::spec::IsolationTier::Gvisor]));
        let a = PersonPartition::new("org_p6d_spawn".into(), "usr_p6d_spawn_a".into());
        let b = PersonPartition::new(a.org_id.clone(), "usr_p6d_spawn_b".into());
        let _standing = cognia_companion::host_surface_gate::person_standing_test_support::Installed::new(&a.org_id);
        let (_fleet, _) = Installed::new(vec![a.clone(), b.clone()]);
        cognia_companion::org_credentials::OrgCredentials::set(&a.org_id, "p6d-provider", "p6d-upstream-org-key", "operator", 1).unwrap();
        cognia_companion::org_agent_policy::set(&a.org_id, vec!["pi".into()], Some("pi".into()), "operator", 1).unwrap();
        let gateway = cognia_gateway::GatewayState::new();
        gateway.try_set_snapshot(serde_json::from_value(serde_json::json!({"generatedAtMs":1,"providers":[{
            "id":"p6d-provider","protocol":"openai","baseUrl":"https://fixture.invalid/v1","enabled":true,"models":["p6d-model"]}]})).unwrap()).unwrap();
        gateway.person_test_listener(19384);
        let minted = crate::person_execution::person_lease_mint(&a, crate::person_execution::PersonAgentLeaseRequest {
            runtime_id:"pi".into(),provider:"p6d-provider".into(),model:"p6d-model".into(),session_id:Some("p6d-task".into()) }, &gateway).unwrap();
        let foreign = crate::person_execution::person_lease_mint(&b, crate::person_execution::PersonAgentLeaseRequest {
            runtime_id:"pi".into(),provider:"p6d-provider".into(),model:"p6d-model".into(),session_id:Some("p6d-foreign-task".into()) }, &gateway).unwrap();
        let backend = Arc::new(BoundBackend::default());
        let mut host = crate::headless::HeadlessServices::stub_for_tests();
        let services = Arc::get_mut(&mut host).unwrap(); services.exec = backend.clone(); services.data_dir = data.clone();
        services.spawn_policy = cognia_external_agent::presets::SpawnPolicy::from_env(&data);
        services.gateway = Arc::new(gateway);
        let state = bound_state(data.clone());
        let decision = ExecutionAdmission { binding:PlacementBinding { org_id:a.org_id.clone(),workspace_id:format!("person:{}",a.account_id),
            actor_user_id:a.user_id.clone(),run_id:"p6d-host-run".into() },actions:vec!["execution.request".into(),"workspace.write".into(),"credential.use".into()] };
        let args = |id: &str, lease: &Value| serde_json::json!({"runtimeId":"pi","workspaceId":"foreign-ignored","config":{
            "id":id,"command":"pi","args":["--mode","rpc"],"env":{"COGNIA_GATEWAY_TOKEN":lease["secret"],
                "COGNIA_GATEWAY_TASK_CONFIG":serde_json::json!({"taskId":lease["ticketId"],"runtime":"pi","files":{}}).to_string()},
            }});
        // AC36: isolation refusal happens before the fake backend is called.
        struct RestoreExecution(Option<std::ffi::OsString>);
        impl Drop for RestoreExecution { fn drop(&mut self) { match self.0.take() {
            Some(value) => unsafe { std::env::set_var("COGNIA_EXECUTION",value) },
            None => unsafe { std::env::remove_var("COGNIA_EXECUTION") },
        } } }
        let _execution = RestoreExecution(std::env::var_os("COGNIA_EXECUTION"));
        for (enabled, tiers) in [(true,None),(true,Some(vec![cognia_environment::spec::IsolationTier::Container])),
            (false,Some(vec![cognia_environment::spec::IsolationTier::Gvisor]))] {
            unsafe { std::env::set_var("COGNIA_EXECUTION",if enabled { "enabled" } else { "disabled" }); }
            environment_pool::uninstall(); if let Some(tiers) = tiers { environment_pool::install(environment_pool::person_pool_test_support(tiers)); }
            let error = person_scope(Some(a.clone()), with_execution_admission(Some(decision.clone()),
                dispatch("spawn_external_agent",args("p6d-no-isolation",&minted),&state,&host,&format!("brain-{}",a.account_id),Some(&a.account_id),Some("person-brain")))).await.unwrap_err();
            assert_eq!(error.0,StatusCode::SERVICE_UNAVAILABLE); assert_eq!(error.1.code,"execution_isolation_unavailable");
            assert!(backend.agents.lock().is_empty());
        }
        unsafe { std::env::set_var("COGNIA_EXECUTION","enabled"); }
        environment_pool::install(environment_pool::person_pool_test_support(vec![cognia_environment::spec::IsolationTier::Gvisor]));
        for supplied in [serde_json::json!(null), serde_json::json!({"kind":"container","spec":{},"isolationMandatory":false})] {
            let mut supplied_args = args("p6e-client-placement", &minted); supplied_args["config"]["sandbox"] = supplied;
            let error = person_scope(Some(a.clone()), with_execution_admission(Some(decision.clone()), dispatch("spawn_external_agent",supplied_args,
                &state,&host,&format!("brain-{}",a.account_id),Some(&a.account_id),Some("person-brain")))).await.unwrap_err();
            assert_eq!(error.0,StatusCode::FORBIDDEN); assert_eq!(error.1.code,"placement_client_supplied");
        }
        let mut disallowed = args("p6d-disallowed",&minted); disallowed["runtimeId"] = serde_json::json!("codex-acp");
        let error = person_scope(Some(a.clone()), with_execution_admission(Some(decision.clone()),
            dispatch("spawn_external_agent",disallowed,&state,&host,&format!("brain-{}",a.account_id),Some(&a.account_id),Some("person-brain")))).await.unwrap_err();
        assert_eq!(error.0,StatusCode::FORBIDDEN); assert_eq!(error.1.code,"org_agent_not_allowed");
        cognia_companion::org_credentials::OrgCredentials::delete(&a.org_id,"p6d-provider").unwrap();
        let error = person_scope(Some(a.clone()), with_execution_admission(Some(decision.clone()),
            dispatch("spawn_external_agent",args("p6d-no-credential",&minted),&state,&host,&format!("brain-{}",a.account_id),Some(&a.account_id),Some("person-brain")))).await.unwrap_err();
        assert_eq!(error.0,StatusCode::SERVICE_UNAVAILABLE); assert_eq!(error.1.code,"model_access_unavailable");
        cognia_companion::org_credentials::OrgCredentials::set(&a.org_id,"p6d-provider","p6d-upstream-org-key","operator",1).unwrap();
        for mut refused in [args("p6d-foreign", &foreign), args("p6d-injected", &minted), args("p6d-nolease", &minted), args("p6d-outside", &minted)] {
            match refused["config"]["id"].as_str().unwrap() {
                "p6d-injected" => refused["config"]["env"]["OPENAI_API_KEY"] = serde_json::json!("injected"),
                "p6d-nolease" => refused["config"]["env"] = serde_json::json!({}),
                "p6d-outside" => {
                    let outside = crate::person_execution::person_lease_mint(&a, crate::person_execution::PersonAgentLeaseRequest {
                        runtime_id:"pi".into(),provider:"p6d-provider".into(),model:"p6d-model".into(),session_id:None }, &host.gateway).unwrap();
                    refused = args("p6d-outside", &outside);
                    refused["config"]["cwd"] = serde_json::json!(temp.path().to_str().unwrap());
                }
                _ => (),
            }
            let error = person_scope(Some(a.clone()), with_execution_admission(Some(decision.clone()),
                dispatch("spawn_external_agent", refused, &state, &host, &format!("brain-{}",a.account_id), Some(&a.account_id), Some("person-brain")))).await.unwrap_err();
            assert_eq!(error.0, StatusCode::FORBIDDEN);
            assert!(matches!(error.1.code.as_str(), "credential_delivery_refused" | "workspace_mount_forbidden"), "{}",error.1.code);
        }
        assert!(backend.agents.lock().is_empty());
        let result = person_scope(Some(a.clone()), with_execution_admission(Some(decision.clone()),
            dispatch("spawn_external_agent", args("p6d-agent", &minted), &state, &host, &format!("brain-{}",a.account_id), Some(&a.account_id), Some("person-brain")))).await.unwrap();
        assert_eq!(result, "p6d-agent");
        let config = backend.agents.lock()["p6d-agent"].clone();
        assert_eq!(config.sandbox.as_ref().unwrap().binding(), Some(&decision.binding));
        assert!(config.sandbox.as_ref().unwrap().isolation_mandatory());
        let spec: cognia_environment::spec::EnvironmentSpec = serde_json::from_value(config.sandbox.as_ref().unwrap().spec().clone()).unwrap();
        spec.validate_with_digest().unwrap(); assert_eq!(spec.project_id,format!("person:{}",a.account_id));
        assert_eq!(spec.egress.tier,cognia_environment::spec::EgressTier::Off);

        let root = cognia_external_agent::person_workspace::person_workspace_path(&host.spawn_policy,&a.account_id).unwrap().canonicalize().unwrap();
        assert_eq!(config.cwd.as_deref(), root.to_str());
        assert_eq!(cognia_external_agent::spawn_authority::CredentialDelivery::for_env(config.env.keys().map(String::as_str)), cognia_external_agent::spawn_authority::CredentialDelivery::Brokered);
        assert!(!serde_json::to_string(&config).unwrap().contains("p6d-upstream-org-key"));
        assert_eq!(person_scope(Some(a.clone()), with_execution_admission(Some(decision.clone()),dispatch("get_external_agent_status",
            serde_json::json!({"agentId":"p6d-agent"}),&state,&host,&format!("brain-{}",a.account_id),Some(&a.account_id),Some("person-brain")))).await.unwrap(),"Running");
        // The operator's raw service path cannot control the partition run.
        for command in ["get_external_agent_status", "kill_external_agent"] {
            assert_eq!(dispatch(command, serde_json::json!({"agentId":"p6d-agent"}), &state, &host, "operator", None, Some("service")).await.unwrap_err().0, StatusCode::FORBIDDEN);
            let mut wrong = decision.clone(); wrong.binding.actor_user_id = b.user_id.clone(); wrong.binding.workspace_id = format!("person:{}",b.account_id);
            assert!(person_scope(Some(b.clone()), with_execution_admission(Some(wrong), dispatch(command, serde_json::json!({"agentId":"p6d-agent"}),
                &state, &host, &format!("brain-{}",b.account_id), Some(&b.account_id), Some("person-brain")))).await.is_err());
        }
        let sink = backend.sinks.lock()["p6d-agent"].clone();
        sink.stdout_line("p6d-agent", "output"); sink.stdout_raw("p6d-agent", "b3V0"); sink.stderr_line("p6d-agent", "err");
        sink.sandbox_placement("p6d-agent", &serde_json::json!({"kind":"sandbox"}));
        sink.workspace_published("p6d-agent", &serde_json::json!({"branch":"branch"}));
        let cognia_companion::event_bus::SubscribeResult::Ok { replay, .. } = state.event_bus.subscribe(Some(0),0) else { panic!("replay"); };
        assert!(replay.iter().any(|frame| frame.event_type == "external-agent://stdout"));
        for frame in replay {
            assert_eq!(frame.partition_account_id.as_deref(), Some(a.account_id.as_str()));
            let visible = |device: String, tenant: &str| cognia_companion::person_chat::person_connection_visible(&frame, &device, Some(tenant));
            assert!(visible(format!("brain-{}",a.account_id), &a.account_id));
            assert!(!visible("__service__".into(), "operator")); assert!(!visible(format!("brain-{}",b.account_id), &b.account_id));
        }
        person_scope(Some(a.clone()), with_execution_admission(Some(decision), dispatch("kill_external_agent", serde_json::json!({"agentId":"p6d-agent"}),
            &state, &host, &format!("brain-{}",a.account_id), Some(&a.account_id), Some("person-brain")))).await.unwrap();
        assert!(backend.agents.lock().is_empty());
        cognia_companion::org_credentials::OrgCredentials::delete(&a.org_id,"p6d-provider").unwrap();
    }

    #[tokio::test]
    async fn p4_service_dispatch_stamps_persists_after_success_and_kills_on_store_failure() {
        use cognia_external_agent::spawn_authority::{
            with_execution_admission, ExecutionAdmission, PlacementBinding,
        };
        use std::sync::Arc;
        let temp = tempfile::tempdir().unwrap();
        let workspace_root = temp.path().join("workspaces");
        let workspace = workspace_root.join("project-a");
        std::fs::create_dir_all(&workspace).unwrap();
        let backend = Arc::new(BoundBackend::default());
        let mut host = crate::headless::HeadlessServices::stub_for_tests();
        let services = Arc::get_mut(&mut host).unwrap();
        services.exec = backend.clone();
        services.spawn_policy =
            cognia_external_agent::presets::SpawnPolicy::new(workspace_root.clone(), false);
        let state = bound_state(temp.path().join("data"));
        let decision = ExecutionAdmission {
            binding: PlacementBinding {
                org_id: "org_a".into(),
                workspace_id: "w".into(),
                actor_user_id: "usr_a".into(),
                run_id: "host-run".into(),
            },
            actions: vec![
                "execution.request".into(),
                "workspace.read".into(),
                "host.global-surfaces".into(),
            ],
        };
        let args = |id: &str| serde_json::json!({"workspaceId":"w", "config":{"id":id, "command":"codex-acp", "cwd":workspace.to_string_lossy(), "sandbox":{"kind":"container", "spec":{}, "isolationMandatory":false}}});
        for channel in ["OPENCODE_CONFIG_CONTENT", "COGNIA_DEVIN_MCP_SERVERS"] {
            let mut injection = args("injected");
            injection["config"]["env"] =
                serde_json::json!({(channel):r#"{"provider":{"options":{"apiKey":"fixture"}}}"#});
            let error = with_execution_admission(
                Some(decision.clone()),
                dispatch(
                    "spawn_external_agent",
                    injection,
                    &state,
                    &host,
                    "device-a",
                    Some("tenant"),
                    Some("device"),
                ),
            )
            .await
            .unwrap_err();
            assert_eq!(error.0, StatusCode::FORBIDDEN);
            assert_eq!(error.1.code, "credential_use_forbidden");
        }
        let output = with_execution_admission(
            Some(decision.clone()),
            dispatch(
                "spawn_external_agent",
                args("agent"),
                &state,
                &host,
                "device-a",
                Some("tenant"),
                Some("device"),
            ),
        )
        .await
        .unwrap();
        assert_eq!(output, "agent");
        assert_eq!(
            backend.agents.lock()["agent"]
                .sandbox
                .as_ref()
                .unwrap()
                .binding(),
            Some(&decision.binding)
        );
        let ledger: Value = serde_json::from_slice(
            &std::fs::read(temp.path().join("data/companion/execution-bindings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            ledger["external-agent:agent"],
            serde_json::json!(decision.binding)
        );
        let status = with_execution_admission(
            Some(decision.clone()),
            dispatch(
                "get_external_agent_status",
                serde_json::json!({"agentId":"agent", "workspaceId":"forged"}),
                &state,
                &host,
                "device-b",
                Some("tenant"),
                Some("device"),
            ),
        )
        .await
        .unwrap();
        assert_eq!(status, "Running");
        backend
            .writable_mount
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let error = with_execution_admission(
            Some(decision.clone()),
            dispatch(
                "get_external_agent_status",
                serde_json::json!({"agentId":"agent"}),
                &state,
                &host,
                "device-b",
                Some("tenant"),
                Some("device"),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.1.code, "workspace_mount_forbidden",
            "a read-only caller cannot reuse a writable container"
        );
        backend
            .writable_mount
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let foreign = workspace_root.join("project-b");
        std::fs::create_dir_all(&foreign).unwrap();
        let mut forged = args("foreign");
        forged["config"]["cwd"] = serde_json::json!(foreign.to_string_lossy());
        let mut member = decision.clone();
        member
            .actions
            .retain(|action| action != "host.global-surfaces");
        let error = with_execution_admission(
            Some(member),
            dispatch(
                "spawn_external_agent",
                forged,
                &state,
                &host,
                "device-a",
                Some("tenant"),
                Some("device"),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.1.code, "workspace_mount_forbidden");
        assert!(!backend.agents.lock().contains_key("foreign"));
        assert!(with_execution_admission(
            Some(decision.clone()),
            dispatch(
                "spawn_external_agent",
                args("failed"),
                &state,
                &host,
                "device-a",
                Some("tenant"),
                Some("device")
            )
        )
        .await
        .is_err());
        let ledger: Value = serde_json::from_slice(
            &std::fs::read(temp.path().join("data/companion/execution-bindings.json")).unwrap(),
        )
        .unwrap();
        assert!(ledger.get("external-agent:failed").is_none());
        let blocked = temp.path().join("blocked");
        *backend.fail_store.lock() = Some(blocked.clone());
        let blocked_state = bound_state(blocked);
        let error = with_execution_admission(
            Some(decision),
            dispatch(
                "spawn_external_agent",
                args("cleanup"),
                &blocked_state,
                &host,
                "device-a",
                Some("tenant"),
                Some("device"),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.1.code, "execution_binding_store_unavailable");
        assert!(backend.killed.lock().contains(&"cleanup".to_string()));
        assert!(!backend.agents.lock().contains_key("cleanup"));
    }

    #[tokio::test]
    async fn p4_review_kill_exit_early_exit_and_orphan_reaping_remove_only_the_matching_generation()
    {
        use cognia_external_agent::spawn_authority::{
            with_execution_admission, ExecutionAdmission, PlacementBinding,
        };
        use std::sync::Arc;
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("workspaces");
        let workspace = base.join("project");
        std::fs::create_dir_all(&workspace).unwrap();
        let backend = Arc::new(BoundBackend::default());
        let mut host = crate::headless::HeadlessServices::stub_for_tests();
        let services = Arc::get_mut(&mut host).unwrap();
        services.exec = backend.clone();
        services.spawn_policy = cognia_external_agent::presets::SpawnPolicy::new(base, false);
        let directory = temp.path().join("data");
        let state = bound_state(directory.clone());
        let first = ExecutionAdmission {
            binding: PlacementBinding {
                org_id: "org_a".into(),
                workspace_id: "w".into(),
                actor_user_id: "usr_a".into(),
                run_id: "generation-1".into(),
            },
            actions: vec![
                "execution.request".into(),
                "workspace.read".into(),
                "host.global-surfaces".into(),
            ],
        };
        let args = |id: &str| serde_json::json!({"workspaceId":"w", "config":{"id":id,"command":"codex-acp","cwd":workspace.to_string_lossy(),"sandbox":{"kind":"container","spec":{},"isolationMandatory":false}}});
        let ledger = || -> Value {
            serde_json::from_slice(
                &std::fs::read(directory.join("companion/execution-bindings.json")).unwrap(),
            )
            .unwrap()
        };
        with_execution_admission(
            Some(first.clone()),
            dispatch(
                "spawn_external_agent",
                args("same"),
                &state,
                &host,
                "device",
                Some("tenant"),
                Some("device"),
            ),
        )
        .await
        .unwrap();
        let old_sink = backend.sinks.lock().get("same").unwrap().clone();
        backend
            .fail_kill
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(with_execution_admission(
            Some(first.clone()),
            dispatch(
                "kill_external_agent",
                serde_json::json!({"agentId":"same"}),
                &state,
                &host,
                "device",
                Some("tenant"),
                Some("device")
            )
        )
        .await
        .is_err());
        assert_eq!(
            ledger()["external-agent:same"]["runId"],
            "generation-1",
            "failed kill keeps its binding"
        );
        with_execution_admission(
            Some(first.clone()),
            dispatch(
                "kill_external_agent",
                serde_json::json!({"agentId":"same"}),
                &state,
                &host,
                "device",
                Some("tenant"),
                Some("device"),
            ),
        )
        .await
        .unwrap();
        assert!(ledger().get("external-agent:same").is_none());
        let mut second = first.clone();
        second.binding.run_id = "generation-2".into();
        with_execution_admission(
            Some(second.clone()),
            dispatch(
                "spawn_external_agent",
                args("same"),
                &state,
                &host,
                "device",
                Some("tenant"),
                Some("device"),
            ),
        )
        .await
        .unwrap();
        old_sink.exited("same", Some(0), None);
        // Wait for an explicitly queued blocking barrier, then inspect the
        // generation comparison directly as well (worker ordering is free).
        tokio::task::spawn_blocking(|| ()).await.unwrap();
        assert_eq!(ledger()["external-agent:same"]["runId"], "generation-2");
        cognia_companion::host_surface_gate::forget_execution_record(
            &directory,
            "spawn_external_agent",
            "same",
            &first.binding,
        )
        .unwrap();
        assert_eq!(ledger()["external-agent:same"]["runId"], "generation-2");
        let sink = backend.sinks.lock().get("same").unwrap().clone();
        backend.agents.lock().remove("same");
        sink.exited("same", Some(0), None);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while ledger().get("external-agent:same").is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        with_execution_admission(
            Some(first.clone()),
            dispatch(
                "spawn_external_agent",
                args("orphan"),
                &state,
                &host,
                "device",
                Some("tenant"),
                Some("device"),
            ),
        )
        .await
        .unwrap();
        backend.agents.lock().remove("orphan"); // Reaped by a restarted backend, no exit callback survives.
        cognia_companion::host_surface_gate::prune_execution_records(
            directory.clone(),
            backend.clone(),
        )
        .await
        .unwrap();
        assert!(ledger().get("external-agent:orphan").is_none());
        with_execution_admission(
            Some(first.clone()),
            dispatch(
                "spawn_external_agent",
                args("early"),
                &state,
                &host,
                "device",
                Some("tenant"),
                Some("device"),
            ),
        )
        .await
        .unwrap();
        assert!(
            ledger().get("external-agent:early").is_none(),
            "an exit before create persistence cannot leave a row"
        );
        with_execution_admission(
            Some(first.clone()),
            dispatch(
                "spawn_external_agent",
                args("unknown"),
                &state,
                &host,
                "device",
                Some("tenant"),
                Some("device"),
            ),
        )
        .await
        .unwrap();
        backend.agents.lock().remove("unknown");
        let error = with_execution_admission(
            Some(first.clone()),
            dispatch(
                "get_external_agent_status",
                serde_json::json!({"agentId":"unknown","workspaceId":"forged"}),
                &state,
                &host,
                "device",
                Some("tenant"),
                Some("device"),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.1.code, "workspace_unresolved");
        assert!(ledger().get("external-agent:unknown").is_none());
        with_execution_admission(
            Some(first.clone()),
            dispatch(
                "spawn_external_agent",
                args("race"),
                &state,
                &host,
                "device",
                Some("tenant"),
                Some("device"),
            ),
        )
        .await
        .unwrap();
        backend
            .pause_send
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let sending = {
            let state = state.clone();
            let host = host.clone();
            let first = first.clone();
            tokio::spawn(async move {
                with_execution_admission(
                    Some(first),
                    dispatch(
                        "send_to_external_agent",
                        serde_json::json!({"agentId":"race","message":"old generation"}),
                        &state,
                        &host,
                        "device",
                        Some("tenant"),
                        Some("device"),
                    ),
                )
                .await
            })
        };
        backend.send_started.notified().await;
        backend.agents.lock().remove("race");
        backend
            .sinks
            .lock()
            .get("race")
            .unwrap()
            .exited("race", Some(0), None);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while ledger().get("external-agent:race").is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let mut replacement = first;
        replacement.binding.actor_user_id = "usr_b".into();
        replacement.binding.run_id = "new-actor-generation".into();
        let mut creating = {
            let state = state.clone();
            let host = host.clone();
            let args = args("race");
            tokio::spawn(async move {
                with_execution_admission(
                    Some(replacement),
                    dispatch(
                        "spawn_external_agent",
                        args,
                        &state,
                        &host,
                        "device-b",
                        Some("tenant"),
                        Some("device"),
                    ),
                )
                .await
            })
        };
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(25), &mut creating)
                .await
                .is_err(),
            "replacement must wait for the old control operation"
        );
        assert!(!backend.agents.lock().contains_key("race"));
        backend.send_resume.notify_one();
        sending.await.unwrap().unwrap();
        creating.await.unwrap().unwrap();
        assert_eq!(
            backend.agents.lock()["race"]
                .sandbox
                .as_ref()
                .unwrap()
                .binding()
                .unwrap()
                .actor_user_id,
            "usr_b"
        );
    }

    #[test]
    fn p4_execution_refusals_keep_their_status_code_and_are_not_retryable() {
        for (code, status) in [
            ("credential_use_forbidden", StatusCode::FORBIDDEN),
            ("placement_binding_client_supplied", StatusCode::FORBIDDEN),
            ("workspace_root_unconfigured", StatusCode::FORBIDDEN),
            ("workspace_root_claimed", StatusCode::FORBIDDEN),
            (
                "execution_binding_store_full",
                StatusCode::SERVICE_UNAVAILABLE,
            ),
            (
                "execution_isolation_unavailable",
                StatusCode::SERVICE_UNAVAILABLE,
            ),
        ] {
            let (actual, error) = tenant_execution_refusal(code);
            assert_eq!(actual, status);
            assert_eq!(error.code, code);
            assert!(!error.retryable);
            let (actual, error) = spawn_execution_error(format!("{code}: refused"));
            assert_eq!(actual, status);
            assert_eq!(error.code, code);
        }
    }

    #[test]
    fn p4_a_stale_record_cannot_authorize_a_legacy_or_replacement_process() {
        use cognia_external_agent::spawn_authority::PlacementBinding;
        let binding = PlacementBinding {
            org_id: "org_a".into(),
            workspace_id: "w".into(),
            actor_user_id: "usr_a".into(),
            run_id: "run".into(),
        };
        assert!(!placement_matches_binding(
            &serde_json::json!({"id":"agent", "pid":42}),
            &binding
        ));
        assert!(!placement_matches_binding(
            &serde_json::json!({"placement":{"kind":"fallback", "binding":binding}}),
            &binding
        ));
        assert!(placement_matches_binding(
            &serde_json::json!({"placement":{"kind":"sandbox", "binding":binding}}),
            &binding
        ));
        let other = PlacementBinding {
            run_id: "replacement".into(),
            ..binding.clone()
        };
        assert!(!placement_matches_binding(
            &serde_json::json!({"placement":{"kind":"sandbox", "binding":other}}),
            &binding
        ));
    }

    #[test]
    fn command_family_is_non_empty_and_unique() {
        assert!(!COMMANDS.is_empty());
        assert!(COMMANDS.contains(&"connectors_lark_callback_respond"));
        assert!(COMMANDS.contains(&"task_workspace_session_scratch_ensure"));
        let unique: std::collections::HashSet<_> = COMMANDS.iter().copied().collect();
        assert_eq!(unique.len(), COMMANDS.len());
    }

    #[test]
    fn langfuse_commands_require_the_authenticated_account_context() {
        assert!(langfuse_account(None).is_err());
        assert_eq!(langfuse_account(Some("account-1")).unwrap(), "account-1");
    }
}
