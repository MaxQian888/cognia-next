use super::*;

pub(super) const COMMANDS: &[&str] = &[
    "terminal_list_all",
    "terminal_list_for_project",
    "terminal_kill",
    "terminal_exec",
    "terminal_complete_paths",
    "terminal_kill_port",
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
        // ── Terminal ───────────────────────────────────────────────────────
        // Live PTY streaming stays on `/ws/terminal`. These are
        // request/response only; `terminal_exec` is a one-shot command runner.
        "terminal_list_all" => {
            ensure_terminal_rpc_authorized(device_id).await?;
            to_json(
                host.terminal_list_all(device_id)
                    .await
                    .map_err(RpcError::internal)?,
            )
        }
        "terminal_list_for_project" => {
            ensure_terminal_rpc_authorized(device_id).await?;
            let project_id: String = required(&args, "projectId")?;
            to_json(
                host.terminal_list_for_project(device_id, &project_id)
                    .await
                    .map_err(RpcError::internal)?,
            )
        }
        "terminal_kill" => {
            ensure_terminal_rpc_authorized(device_id).await?;
            let id: String = required(&args, "id")?;
            host.terminal_kill(device_id, &id)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }
        "terminal_exec" => {
            let command: String = required(&args, "command")?;
            let exec_args: Vec<String> = optional(&args, "args")?.unwrap_or_default();
            let cwd: Option<String> = optional(&args, "cwd")?;
            let env: Option<std::collections::HashMap<String, String>> = optional(&args, "env")?;
            let timeout_ms: Option<u64> = optional(&args, "timeoutMs")?;
            // `shell: true` runs `command` as a full shell line (cmd /C, sh -c)
            // — what a remote client needs to replay history-style commands.
            let shell: Option<bool> = optional(&args, "shell")?;
            let (command, exec_args) = crate::terminal::exec::resolve_shell_mode(
                command,
                exec_args,
                shell.unwrap_or(false),
            )
            .map_err(RpcError::validation_failed)?;
            crate::terminal::exec::terminal_exec_inner(
                cwd, command, exec_args, env, timeout_ms, None,
            )
            .await
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "terminal_complete_paths" => {
            let cwd: String = required(&args, "cwd")?;
            let fragment: String = required(&args, "fragment")?;
            let show_hidden: Option<bool> = optional(&args, "showHidden")?;
            let limit: Option<usize> = optional(&args, "limit")?;
            tokio::task::spawn_blocking(move || {
                crate::terminal::complete::complete_paths_inner(
                    &cwd,
                    &fragment,
                    show_hidden.unwrap_or(false),
                    limit.unwrap_or(50),
                )
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "terminal_kill_port" => {
            let port: u16 = required(&args, "port")?;
            // netstat/lsof + kill shell out — keep them off the async runtime.
            tokio::task::spawn_blocking(move || crate::terminal::commands::terminal_kill_port(port))
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
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
