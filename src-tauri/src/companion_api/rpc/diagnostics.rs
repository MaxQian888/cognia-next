use super::*;

fn fleet_event_payload(tenant_id: &str) -> Result<Value, (StatusCode, Json<RpcError>)> {
    let mut payload = serde_json::to_value(crate::fleet::runtime().snapshot_for_tenant(tenant_id))
        .map_err(|error| RpcError::internal(error.to_string()))?;
    payload
        .as_object_mut()
        .ok_or_else(|| {
            RpcError::internal("fleet snapshot must serialize as an object".to_string())
        })?
        .insert("tenantId".to_string(), Value::String(tenant_id.to_string()));
    Ok(payload)
}

pub(super) const COMMANDS: &[&str] = &[
    "logs_query",
    "logs_list_files",
    "fleet_get_snapshot",
    "fleet_worker_enrollment_create",
    "fleet_worker_list",
    "fleet_worker_set",
    "fleet_project_managed_session",
    "fleet_project_worker_load",
    "fleet_remove_managed_session",
    "fleet_permission_respond",
    "fleet_question_respond",
    "fleet_question_reject",
    "fleet_opencode_send_message",
    "fleet_focus_terminal",
    "fleet_interrupt_session",
    "lark_entry_issue",
    "lark_result_complete",
    "lark_metrics_record",
];

fn require_owner(
    security: &super::super::security_store::SecurityStore,
    tenant_id: &str,
    device_id: &str,
) -> Result<(), (StatusCode, Json<RpcError>)> {
    let devices = security
        .list_devices(tenant_id)
        .map_err(|error| RpcError::internal(error.to_string()))?;
    if is_active_owner(&devices, device_id) {
        Ok(())
    } else {
        Err(RpcError::forbidden(
            "only an active owner may administer execution workers",
        ))
    }
}

fn is_active_owner(
    devices: &[super::super::security_store::DeviceSummary],
    device_id: &str,
) -> bool {
    devices.iter().any(|device| {
        device.device_id == device_id && device.role == "owner" && device.status == "active"
    })
}

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
        // ── Native log read-back ────────────────────────────────────────────
        // Free functions over the log directory — no Tauri state needed, so
        // these also work from the headless `cognia-server` process.
        "logs_query" => {
            // Accept both the Tauri arg shape `{ query: {...} }` (what
            // `transport.call("logs_query", { query })` sends on every
            // platform) and a bare flattened query object.
            let raw = args.get("query").cloned().unwrap_or_else(|| args.clone());
            let query: crate::logging::query::NativeLogQuery = serde_json::from_value(raw)
                .map_err(|e| RpcError::malformed(format!("invalid logs query: {e}")))?;
            let result = tokio::task::spawn_blocking(move || {
                crate::logging::query::query_native_logs(&query)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            to_json(result)
        }
        "logs_list_files" => {
            let files = tokio::task::spawn_blocking(crate::logging::query::list_native_log_files)
                .await
                .map_err(|error| RpcError::internal(error.to_string()))?
                .map_err(RpcError::internal)?;
            to_json(files)
        }

        // ── Agent Fleet (ADR-0009) ──────────────────────────────────────────
        // Host-generic: these reach the process-global fleet runtime directly
        // (no AppHandle / desktop_writes_bridge), so they also serve a headless
        // server (which returns an empty snapshot). camelCase arg keys mirror
        // the TS wrappers in `lib/fleet/fleet-remote-actions.ts`.
        "fleet_get_snapshot" => {
            let tenant_id = account_id.ok_or_else(|| {
                RpcError::forbidden("fleet snapshot requires an authenticated tenant")
            })?;
            to_json(crate::fleet::runtime().snapshot_for_tenant(tenant_id))
        }
        "fleet_worker_enrollment_create" => {
            let tenant_id = account_id.ok_or_else(|| {
                RpcError::forbidden("worker enrollment requires an authenticated tenant")
            })?;
            let security = super::super::security_store::security_store().ok_or_else(|| {
                RpcError::internal("companion security store is unavailable".to_string())
            })?;
            require_owner(&security, tenant_id, device_id)?;
            let base_url: String = required(&args, "baseUrl")?;
            if !(base_url.starts_with("https://") || base_url.starts_with("http://127.0.0.1")) {
                return Err(RpcError::malformed(
                    "worker enrollment baseUrl must use HTTPS".to_string(),
                ));
            }
            let fingerprint: String = required(&args, "fingerprint")?;
            let now = super::super::security_store::unix_time_secs();
            let ttl = 10 * 60;
            let enrollment = security
                .create_worker_enrollment(tenant_id, device_id, now, ttl)
                .map_err(|error| RpcError::internal(error.to_string()))?;
            Ok(serde_json::json!({
                "enrollment": enrollment,
                "expiresAtMs": now.saturating_add(ttl) * 1_000,
                "baseUrl": base_url,
                "fingerprint": fingerprint,
                "tenantId": tenant_id,
            }))
        }
        "fleet_worker_list" => {
            let tenant_id = account_id.ok_or_else(|| {
                RpcError::forbidden("worker listing requires an authenticated tenant")
            })?;
            let security = super::super::security_store::security_store().ok_or_else(|| {
                RpcError::internal("companion security store is unavailable".to_string())
            })?;
            require_owner(&security, tenant_id, device_id)?;
            let devices = security
                .list_worker_devices(tenant_id)
                .map_err(|error| RpcError::internal(error.to_string()))?;
            to_json(super::super::ws_worker::worker_device_summaries(
                tenant_id, devices,
            ))
        }
        "fleet_worker_set" => {
            let tenant_id = account_id.ok_or_else(|| {
                RpcError::forbidden("worker administration requires an authenticated tenant")
            })?;
            let security = super::super::security_store::security_store().ok_or_else(|| {
                RpcError::internal("companion security store is unavailable".to_string())
            })?;
            require_owner(&security, tenant_id, device_id)?;
            let target_device_id: String = required(&args, "deviceId")?;
            let allowed: bool = required(&args, "allowed")?;
            let mut capabilities = security
                .capability_snapshot(tenant_id, &target_device_id)
                .map_err(|error| RpcError::internal(error.to_string()))?
                .ok_or_else(|| RpcError::malformed("worker device is unavailable".to_string()))?;
            capabilities.retain(|capability| capability != "agent.worker");
            if allowed {
                capabilities.push("agent.worker".to_string());
            }
            security
                .replace_device_capabilities(
                    tenant_id,
                    device_id,
                    &target_device_id,
                    &capabilities,
                    super::super::security_store::unix_time_secs(),
                )
                .map_err(|error| RpcError::internal(error.to_string()))?;
            Ok(Value::Null)
        }
        "fleet_project_managed_session" => {
            let tenant_id = account_id.ok_or_else(|| {
                RpcError::forbidden("fleet projection requires an authenticated tenant")
            })?;
            let input: crate::fleet::registry::ManagedFleetSession = required(&args, "input")?;
            crate::fleet::runtime().project_managed_session(input);
            state.event_bus.publish(
                crate::fleet::UPDATE_EVENT.to_string(),
                fleet_event_payload(tenant_id)?,
            );
            Ok(Value::Null)
        }
        "fleet_project_worker_load" => {
            let loads: Vec<super::super::ws_worker::WorkerLoadProjection> =
                required(&args, "loads")?;
            super::super::ws_worker::project_worker_load(
                account_id.ok_or_else(|| {
                    RpcError::forbidden("worker load projection requires an authenticated tenant")
                })?,
                loads,
            );
            state.event_bus.publish(
                crate::fleet::UPDATE_EVENT.to_string(),
                fleet_event_payload(account_id.ok_or_else(|| {
                    RpcError::forbidden("fleet projection requires an authenticated tenant")
                })?)?,
            );
            Ok(Value::Null)
        }
        "fleet_remove_managed_session" => {
            let tenant_id = account_id.ok_or_else(|| {
                RpcError::forbidden("fleet projection requires an authenticated tenant")
            })?;
            let session_id: String = required(&args, "sessionId")?;
            let removed = crate::fleet::runtime().remove_managed_session(&session_id);
            if removed {
                state.event_bus.publish(
                    crate::fleet::UPDATE_EVENT.to_string(),
                    fleet_event_payload(tenant_id)?,
                );
            }
            to_json(removed)
        }
        "fleet_permission_respond" => {
            let request_id: String = required(&args, "requestId")?;
            let behavior: crate::fleet::PermissionBehavior = required(&args, "behavior")?;
            to_json(crate::fleet::runtime().respond_permission(&request_id, behavior))
        }
        "fleet_question_respond" => {
            // Without this arm an AskUserQuestion stranded anyone who wasn't at
            // the desktop island: the phone could see the question in the
            // snapshot but had no way to answer it, so it simply timed out.
            let request_id: String = required(&args, "requestId")?;
            let selections: Vec<Vec<u32>> = required(&args, "selections")?;
            to_json(crate::fleet::runtime().respond_question(&request_id, selections))
        }
        "fleet_question_reject" => {
            let request_id: String = required(&args, "requestId")?;
            to_json(crate::fleet::runtime().reject_question(&request_id))
        }
        "fleet_opencode_send_message" => {
            let session_id: String = required(&args, "sessionId")?;
            let text: String = required(&args, "text")?;
            if text.trim().is_empty() {
                return Err(RpcError::malformed("text must not be empty".to_string()));
            }
            crate::fleet::fleet_opencode_send_message(session_id, text)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "fleet_focus_terminal" => {
            let agent: String = required(&args, "agent")?;
            let session_id: String = required(&args, "sessionId")?;
            crate::fleet::control::focus_session_terminal(&agent, &session_id)
                .await
                .map(|()| Value::Null)
                .map_err(RpcError::internal)
        }
        "fleet_interrupt_session" => {
            let agent: String = required(&args, "agent")?;
            let session_id: String = required(&args, "sessionId")?;
            crate::fleet::control::interrupt_session(&agent, &session_id)
                .await
                .map(|()| Value::Null)
                .map_err(RpcError::internal)
        }

        // ── Lark dual-entry (plan 2026-07-24, service scope) ─────────────────
        "lark_entry_issue" => {
            super::super::lark_entry::rpc_entry_issue(state, &args).map_err(RpcError::internal)
        }
        "lark_result_complete" => {
            super::super::lark_entry::rpc_result_complete(&args).map_err(RpcError::internal)
        }
        "lark_metrics_record" => {
            super::super::lark_entry::rpc_metrics_record(&args).map_err(RpcError::internal)
        }
        unknown => Err(RpcError::unknown_command(unknown)),
    };
    result
}

#[cfg(test)]
mod tests {
    use super::super::super::security_store::DeviceSummary;
    use super::*;

    #[test]
    fn command_family_is_non_empty_and_unique() {
        assert!(!COMMANDS.is_empty());
        let unique: std::collections::HashSet<_> = COMMANDS.iter().copied().collect();
        assert_eq!(unique.len(), COMMANDS.len());
    }

    #[test]
    fn worker_administration_requires_the_active_owner_identity() {
        let devices = vec![DeviceSummary {
            device_id: "owner-a".into(),
            display_name: "Owner".into(),
            role: "owner".into(),
            status: "active".into(),
            user_id: None,
            created_at: 1,
            updated_at: 1,
            capabilities: vec!["host.admin".into()],
        }];
        assert!(is_active_owner(&devices, "owner-a"));
        assert!(!is_active_owner(&devices, "worker-a"));
    }
}
