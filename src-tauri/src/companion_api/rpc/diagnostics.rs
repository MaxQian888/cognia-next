use super::*;

pub(super) const COMMANDS: &[&str] = &[
    "logs_query",
    "logs_list_files",
    "fleet_get_snapshot",
    "fleet_permission_respond",
    "fleet_question_respond",
    "fleet_opencode_send_message",
    "fleet_focus_terminal",
    "fleet_interrupt_session",
    "lark_entry_issue",
    "lark_result_complete",
    "lark_metrics_record",
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
        "fleet_get_snapshot" => to_json(crate::fleet::runtime().snapshot()),
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
        "fleet_opencode_send_message" => {
            let session_id: String = required(&args, "sessionId")?;
            let text: String = required(&args, "text")?;
            if text.trim().is_empty() {
                return Err(RpcError::malformed("text must not be empty".to_string()));
            }
            to_json(crate::fleet::runtime().queue_opencode_command(session_id, text))
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
    use super::*;

    #[test]
    fn command_family_is_non_empty_and_unique() {
        assert!(!COMMANDS.is_empty());
        let unique: std::collections::HashSet<_> = COMMANDS.iter().copied().collect();
        assert_eq!(unique.len(), COMMANDS.len());
    }
}
