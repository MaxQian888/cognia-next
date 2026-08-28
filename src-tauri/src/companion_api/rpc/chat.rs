use super::*;

pub(super) const COMMANDS: &[&str] = &[
    // ADR-0090 canonical names. Their deprecated `claude_*` aliases below run
    // the same impl bodies; the canonical four additionally carry the caller's
    // `commandId` idempotency key, which is the only behavioural difference.
    "agent_send",
    "agent_interrupt",
    "agent_compact",
    "agent_close_session",
    "agent_resolve_permission",
    "claude_send",
    "claude_interrupt",
    "claude_compact",
    "claude_restore",
    "claude_set_mode",
    "claude_approve",
    "claude_close_session",
    "claude_plugin_tool_response",
    "claude_tool_result_decision",
    "claude_protocol_adapter_message",
    "claude_sidecar_status",
    "claude_set_oauth_bearer",
    "claude_set_api_key",
    "claude_set_provider_env",
    "claude_has_api_key",
    "claude_has_oauth_bearer",
    "claude_restart_sidecar",
    "read_agent_config",
    "agent_vendor_roots",
    "read_project_mcp_config",
    "write_agent_config",
    "secret_store_get",
    "keyring_secret_get",
    "secret_store_set",
    "keyring_secret_set",
    "secret_store_delete",
    "keyring_secret_clear",
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
        // ── Chat session ─────────────────────────────────────────────────────

        // The chat-session arms are host-generic (ADR-0059 R7): the sidecar
        // state + host resolve from either the Tauri app or the headless
        // services registry, so a cloud cognia-server executes chat turns.
        // Two arms, one body (`send_arm` below). They are not folded into a
        // single `"a" | "b"` arm on purpose: the generated request contracts are
        // inferred per arm from the `required(...)` calls in its body
        // (`extractCommandArgumentSchemas` in scripts/build/gen-companion-api.mjs),
        // so a shared arm would publish one command's schema for both — and
        // these two genuinely differ, since only the canonical name carries the
        // caller's `commandId`.
        "claude_send" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let prompt: Value = required(&args, "prompt")?;
            let options: Option<claude_commands::SendOptions> = optional(&args, "options")?;
            send_arm(state, host, device_id, session_id, prompt, options, None).await
        }

        // The canonical send adds exactly what the desktop `agent_send` command
        // adds over its alias: the frozen execution-spec skew guard, and the
        // renderer's idempotency key.
        "agent_send" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let prompt: Value = required(&args, "prompt")?;
            let options: Option<claude_commands::SendOptions> = optional(&args, "options")?;
            let command_id: Option<String> = optional_aliased(&args, "command_id", "commandId")?;
            if let Some(execution) = options.as_ref().and_then(|o| o.extra.get("execution")) {
                if !claude_commands::execution_spec_is_acceptable(execution) {
                    return Err(RpcError::malformed(
                        "agent_send: malformed execution spec (specVersion/runtimeAdapter)".into(),
                    ));
                }
            }
            send_arm(
                state, host, device_id, session_id, prompt, options, command_id,
            )
            .await
        }

        "claude_interrupt" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            claude_commands::claude_interrupt_impl_with_id(&host.sidecar_state(), session_id, None)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "agent_interrupt" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let command_id: Option<String> = optional_aliased(&args, "command_id", "commandId")?;
            claude_commands::claude_interrupt_impl_with_id(
                &host.sidecar_state(),
                session_id,
                command_id,
            )
            .await
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }

        "claude_compact" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let focus: Option<String> = optional(&args, "focus")?;
            claude_commands::claude_compact_impl_with_id(
                &host.sidecar_state(),
                session_id,
                focus,
                None,
            )
            .await
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }

        "agent_compact" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let focus: Option<String> = optional(&args, "focus")?;
            let command_id: Option<String> = optional_aliased(&args, "command_id", "commandId")?;
            claude_commands::claude_compact_impl_with_id(
                &host.sidecar_state(),
                session_id,
                focus,
                command_id,
            )
            .await
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }

        "claude_restore" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let messages: Value = required(&args, "messages")?;
            claude_commands::claude_restore_impl(&host.sidecar_state(), session_id, messages)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "claude_set_mode" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let mode: String = required(&args, "mode")?;
            // Forward the correlation id just like the desktop command so the
            // caller can match the sidecar acknowledgement to this request.
            let command_id: Option<String> = optional_aliased(&args, "command_id", "commandId")?;
            claude_commands::claude_set_mode_impl_with_id(
                &host.sidecar_state(),
                session_id,
                mode,
                command_id,
            )
            .await
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }

        "claude_approve" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let request_id: String = required_aliased(&args, "request_id", "requestId")?;
            let decision: String = required(&args, "decision")?;
            let message: Option<String> = optional(&args, "message")?;
            let updated_input: Option<Value> =
                optional_aliased(&args, "updated_input", "updatedInput")?;
            let context: super::super::remote_execution::RemoteExecutionContext =
                required_aliased(&args, "remote_execution_context", "remoteExecutionContext")?;
            super::super::remote_execution::global()
                .validate_and_consume(
                    &context,
                    device_id,
                    &session_id,
                    &request_id,
                    unix_time_ms(),
                )
                .map_err(remote_context_error)?;
            claude_commands::claude_approve_impl(
                &host.sidecar_state(),
                session_id,
                request_id,
                decision,
                message,
                updated_input,
            )
            .await
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }

        "agent_resolve_permission" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let request_id: String = required_aliased(&args, "request_id", "requestId")?;
            let decision: String = required(&args, "decision")?;
            let message: Option<String> = optional(&args, "message")?;
            let updated_input: Option<Value> =
                optional_aliased(&args, "updated_input", "updatedInput")?;
            let command_id: Option<String> = optional_aliased(&args, "command_id", "commandId")?;
            let interrupt: Option<bool> = optional(&args, "interrupt")?;
            let context: super::super::remote_execution::RemoteExecutionContext =
                required_aliased(&args, "remote_execution_context", "remoteExecutionContext")?;
            super::super::remote_execution::global()
                .validate_and_consume(
                    &context,
                    device_id,
                    &session_id,
                    &request_id,
                    unix_time_ms(),
                )
                .map_err(remote_context_error)?;
            claude_commands::claude_approve_impl_with_id(
                &host.sidecar_state(),
                session_id,
                request_id,
                decision,
                message,
                updated_input,
                command_id,
                interrupt,
            )
            .await
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }

        "claude_close_session" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            claude_commands::claude_close_session_impl_with_id(
                &host.sidecar_state(),
                session_id,
                None,
            )
            .await
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }

        "agent_close_session" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let command_id: Option<String> = optional_aliased(&args, "command_id", "commandId")?;
            claude_commands::claude_close_session_impl_with_id(
                &host.sidecar_state(),
                session_id,
                command_id,
            )
            .await
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }

        "claude_plugin_tool_response" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let tool_use_id: String = required_aliased(&args, "tool_use_id", "toolUseId")?;
            let context: super::super::remote_execution::RemoteExecutionContext =
                required_aliased(&args, "remote_execution_context", "remoteExecutionContext")?;
            super::super::remote_execution::global()
                .validate_and_consume(
                    &context,
                    device_id,
                    &session_id,
                    &tool_use_id,
                    unix_time_ms(),
                )
                .map_err(remote_context_error)?;
            let result: Option<Value> = optional(&args, "result")?;
            let error: Option<String> = optional(&args, "error")?;
            claude_commands::claude_plugin_tool_response_impl(
                &host.sidecar_state(),
                session_id,
                tool_use_id,
                result,
                error,
            )
            .await
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }

        "claude_tool_result_decision" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let review_id: String = required_aliased(&args, "review_id", "reviewId")?;
            let context: super::super::remote_execution::RemoteExecutionContext =
                required_aliased(&args, "remote_execution_context", "remoteExecutionContext")?;
            super::super::remote_execution::global()
                .validate_and_consume(&context, device_id, &session_id, &review_id, unix_time_ms())
                .map_err(remote_context_error)?;
            let updated_tool_output: Option<Value> = args
                .get("updated_tool_output")
                .or_else(|| args.get("updatedToolOutput"))
                .cloned();
            claude_commands::claude_tool_result_decision_impl(
                &host.sidecar_state(),
                session_id,
                review_id,
                updated_tool_output,
            )
            .await
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }

        "claude_protocol_adapter_message" => {
            let message: Value = required(&args, "message")?;
            let context: super::super::remote_execution::RemoteExecutionContext =
                required_aliased(&args, "remote_execution_context", "remoteExecutionContext")?;
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let exec_id = message
                .get("execId")
                .or_else(|| message.get("exec_id"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    RpcError::malformed(
                        "claude_protocol_adapter_message.message.execId is required".into(),
                    )
                })?;
            let message_id = message
                .get("messageId")
                .or_else(|| message.get("message_id"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    RpcError::malformed(
                        "claude_protocol_adapter_message.message.messageId is required".into(),
                    )
                })?;
            let terminal = matches!(
                message.get("type").and_then(Value::as_str),
                Some("protocol_adapter_done" | "protocol_adapter_error")
            );
            super::super::remote_execution::global()
                .validate_pending_message(
                    &context,
                    device_id,
                    &session_id,
                    exec_id,
                    message_id,
                    terminal,
                    unix_time_ms(),
                )
                .map_err(remote_context_error)?;
            claude_commands::claude_protocol_adapter_message_impl(&host.sidecar_state(), message)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "claude_sidecar_status" => {
            claude_commands::claude_sidecar_status_impl(&host.sidecar_state())
                .await
                .map_err(RpcError::internal)
                .and_then(|s| {
                    serde_json::to_value(s).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        // ── Subscription / OAuth (ADR-0025) ──────────────────────────────────
        // Subscription account management (`subscription_*`) is deliberately
        // **desktop-only**: it reads and writes the provider credential vault,
        // so it is not exposed to remote/mobile clients. The desktop UI reaches
        // those operations through `transport-tauri` → the real `#[tauri::command]`
        // functions directly, never through this companion dispatch table. The
        // legacy `claude_sub_*` token RPCs are likewise gone.
        "claude_set_oauth_bearer" => {
            let token: Option<String> = optional(&args, "token")?;
            host.api_keys().set_oauth_bearer(token).await;
            Ok(Value::Null)
        }

        // ── Provider env ─────────────────────────────────────────────────────
        "claude_set_api_key" => {
            let key: Option<String> = optional(&args, "key")?;
            host.api_keys().set(key).await;
            Ok(Value::Null)
        }

        "claude_set_provider_env" => {
            let api_key: Option<String> = optional(&args, "api_key")?;
            let base_url: Option<String> = optional(&args, "base_url")?;
            // Ordered `[name, value]` pairs forwarded as
            // `ANTHROPIC_CUSTOM_HEADER_*` at spawn. The arm used to stop at
            // `base_url`, so a remote caller could set a provider but never the
            // headers that gate 1M context behind `anthropic-beta` — the
            // desktop command's third parameter had no wire path at all.
            // `None` leaves the existing set untouched; `Some([])` clears it.
            let custom_headers: Option<Vec<(String, String)>> =
                optional_aliased(&args, "custom_headers", "customHeaders")?;
            let keys = host.api_keys();
            keys.set_provider(api_key, base_url).await;
            if let Some(headers) = custom_headers {
                keys.set_custom_headers(headers).await;
            }
            Ok(Value::Null)
        }

        "claude_has_api_key" => {
            let has = host.api_keys().get().await.is_some();
            Ok(Value::Bool(has))
        }

        "claude_has_oauth_bearer" => {
            let has = host.api_keys().get_oauth_bearer().await.is_some();
            Ok(Value::Bool(has))
        }

        "claude_restart_sidecar" => {
            kill_sidecar(host.sidecar_state()).await;
            Ok(Value::Null)
        }

        // ── Multi-agent config ────────────────────────────────────────────────
        "read_agent_config" => {
            let agent: String = required(&args, "agent")?;
            tokio::task::spawn_blocking(move || agent_commands::read_agent_config(agent))
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map_err(RpcError::internal)
                .and_then(|r| {
                    serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        "agent_vendor_roots" => to_json(agent_commands::agent_vendor_roots()),

        "read_project_mcp_config" => {
            let cwd = authorize_workspace_root(host, required(&args, "cwd")?)?;
            tokio::task::spawn_blocking(move || agent_commands::read_project_mcp_config(cwd))
                .await
                .map_err(|error| RpcError::internal(error.to_string()))?
                .map_err(RpcError::internal)
                .and_then(|result| {
                    let mut value = serde_json::to_value(result)
                        .map_err(|error| RpcError::internal(error.to_string()))?;
                    if let Some(object) = value.as_object_mut() {
                        object.insert("path".to_string(), Value::String(".mcp.json".to_string()));
                    }
                    Ok(value)
                })
        }

        "write_agent_config" => {
            let agent: String = required(&args, "agent")?;
            let value: Value = required(&args, "value")?;
            tokio::task::spawn_blocking(move || agent_commands::write_agent_config(agent, value))
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map_err(RpcError::internal)
                .and_then(|r| {
                    serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        // ── Generic server secret store ──────────────────────────────────────
        "secret_store_get" | "keyring_secret_get" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let input: crate::keyring_secrets::SecretStoreInput = required(&args, "input")?;
            let value = tokio::task::spawn_blocking(move || {
                crate::keyring_secrets::get(&input.namespace, &input.key)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            to_json(value)
        }

        "secret_store_set" | "keyring_secret_set" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let input: crate::keyring_secrets::SecretStoreInput = required(&args, "input")?;
            let value = input
                .value
                .clone()
                .ok_or_else(|| RpcError::malformed(format!("{name}.input.value is required")))?;
            tokio::task::spawn_blocking(move || {
                crate::keyring_secrets::set(&input.namespace, &input.key, &value)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "secret_store_delete" | "keyring_secret_clear" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_host_required(name))?;
            let input: crate::keyring_secrets::SecretStoreInput = required(&args, "input")?;
            tokio::task::spawn_blocking(move || {
                crate::keyring_secrets::clear(&input.namespace, &input.key)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }
        unknown => Err(RpcError::unknown_command(unknown)),
    };
    result
}

/// The body both send arms share.
///
/// Registers this device's remote-execution context so the approval it will be
/// asked for can be validated back to *this* turn, materialises a hosted task
/// workspace when the caller sent one, and hands the result to the same
/// host-generic send the desktop uses. `command_id` is the caller's idempotency
/// key — present only on the canonical `agent_send`, because nothing that calls
/// the deprecated alias stamps one.
#[allow(clippy::too_many_arguments)]
async fn send_arm(
    state: &SharedState,
    host: &super::super::dispatch_host::DispatchHost,
    device_id: &str,
    session_id: String,
    prompt: Value,
    options: Option<claude_commands::SendOptions>,
    command_id: Option<String>,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    let mut options = options;
    let context = super::super::remote_execution::global().register(
        &opaque_host_id(state),
        device_id,
        &session_id,
        unix_time_ms(),
    );
    options
        .get_or_insert_with(claude_commands::SendOptions::default)
        .extra
        .insert(
            "remoteExecutionContext".to_string(),
            serde_json::to_value(context).map_err(|error| RpcError::internal(error.to_string()))?,
        );
    if let Some(send_options) = options.as_mut() {
        if let Some(envelope) = send_options.extra.remove("taskWorkspace") {
            let envelope: crate::task_workspace::TaskWorkspaceTurnEnvelope =
                serde_json::from_value(envelope)
                    .map_err(|error| RpcError::malformed(error.to_string()))?;
            let sink: std::sync::Arc<dyn cognia_task_workspace::TaskWorkspaceEventSink> =
                std::sync::Arc::new(crate::task_workspace::BusResourceEventSink(
                    std::sync::Arc::clone(&state.event_bus),
                ));
            let run = crate::task_workspace::begin_hosted_turn(session_id.clone(), envelope, sink)
                .map_err(RpcError::internal)?;
            send_options.cwd = Some(run.execution_root);
        }
    }
    claude_commands::claude_send_with_host_and_id(
        host.sidecar_host(),
        host.sidecar_state(),
        session_id,
        prompt,
        options,
        command_id,
    )
    .await
    .map(|_| Value::Null)
    .map_err(RpcError::internal)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ADR-0090 names `agent_*` canonical and `claude_*` deprecated. The four
    /// canonical control verbs were nonetheless stranded on `target: client` /
    /// `transports: ["internal"]` while their deprecated aliases were already
    /// reachable over http/ws/webrtc — so a paired device running the canonical
    /// path (any session with a frozen execution spec) got
    /// `404 unknown_command` on every send.
    ///
    /// Pin the two halves together: whatever authority the alias carries, the
    /// canonical name carries, and no more. Drift in either direction is the
    /// bug this test exists to catch.
    #[test]
    fn canonical_control_verbs_carry_exactly_their_alias_authority() {
        use super::super::super::command_manifest::descriptor;
        for (canonical, alias) in [
            ("agent_send", "claude_send"),
            ("agent_interrupt", "claude_interrupt"),
            ("agent_compact", "claude_compact"),
            ("agent_close_session", "claude_close_session"),
        ] {
            let a = descriptor(canonical)
                .unwrap_or_else(|| panic!("{canonical} is missing from the command manifest"));
            let b = descriptor(alias)
                .unwrap_or_else(|| panic!("{alias} is missing from the command manifest"));
            assert_eq!(a.target, b.target, "{canonical} target");
            assert_eq!(a.operation, b.operation, "{canonical} operation");
            assert_eq!(a.capability, b.capability, "{canonical} capability");
            assert_eq!(a.risk, b.risk, "{canonical} risk");
            assert_eq!(a.approval, b.approval, "{canonical} approval");
            assert_eq!(a.idempotency, b.idempotency, "{canonical} idempotency");
            assert_eq!(a.transports, b.transports, "{canonical} transports");
            // Reachability is decided by the transport list, not by intent.
            assert!(
                !a.transports
                    .contains(&super::super::super::command_manifest::CommandTransport::Internal),
                "{canonical} is still confined to the internal transport"
            );
            // And the arm has to exist on both sides, or the manifest is
            // promising a command the dispatcher will 404.
            assert!(COMMANDS.contains(&canonical), "{canonical} has no arm");
            assert!(COMMANDS.contains(&alias), "{alias} has no arm");
        }
    }

    #[test]
    fn command_family_is_non_empty_and_unique() {
        assert!(!COMMANDS.is_empty());
        let unique: std::collections::HashSet<_> = COMMANDS.iter().copied().collect();
        assert_eq!(unique.len(), COMMANDS.len());
    }
}
