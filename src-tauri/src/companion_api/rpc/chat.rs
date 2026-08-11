use super::*;

pub(super) const COMMANDS: &[&str] = &[
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
        "claude_send" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let prompt: Value = required(&args, "prompt")?;
            let mut options: Option<claude_commands::SendOptions> = optional(&args, "options")?;
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
                    serde_json::to_value(context)
                        .map_err(|error| RpcError::internal(error.to_string()))?,
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
                    let run = crate::task_workspace::begin_hosted_turn(
                        session_id.clone(),
                        envelope,
                        sink,
                    )
                    .map_err(RpcError::internal)?;
                    send_options.cwd = Some(run.execution_root);
                }
            }
            claude_commands::claude_send_with_host(
                host.sidecar_host(),
                host.sidecar_state(),
                session_id,
                prompt,
                options,
            )
            .await
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }

        "claude_interrupt" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            claude_commands::claude_interrupt_impl(&host.sidecar_state(), session_id)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "claude_compact" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let focus: Option<String> = args
                .get("focus")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            claude_commands::claude_compact_impl(&host.sidecar_state(), session_id, focus)
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
            claude_commands::claude_set_mode_impl(&host.sidecar_state(), session_id, mode)
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

        "claude_close_session" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            claude_commands::claude_close_session_impl(&host.sidecar_state(), session_id)
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
            host.api_keys().set_provider(api_key, base_url).await;
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
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
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
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
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
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
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
