use super::*;

pub(super) const COMMANDS: &[&str] = &[
    "terminal_list_all",
    "terminal_list_for_project",
    "terminal_kill",
    "terminal_exec",
    "terminal_complete_paths",
    "terminal_list_path_executables",
    "terminal_kill_port",
    "terminal_host_status",
    "terminal_host_configure",
    "terminal_host_sync_profiles",
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
    let _ = (state, account_id, scope);
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
        "terminal_list_path_executables" => {
            // The head-word half of remote terminal autocomplete. The scan
            // walks every `$PATH` directory, so it stays off the async runtime;
            // the 15-second cache inside means a burst of keystrokes costs one
            // walk, not one per character.
            let prefix: String = required(&args, "prefix")?;
            let limit: Option<usize> = optional(&args, "limit")?;
            tokio::task::spawn_blocking(move || {
                let path_value = std::env::var("PATH").unwrap_or_default();
                crate::terminal::path_scan::list_path_executables_inner(
                    &path_value,
                    &prefix,
                    limit.unwrap_or(50),
                )
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))
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
        // ── Terminal host administration ──────────────────────────────────
        //
        // The desktop drives these through the local `terminal_host_service`
        // command, which no remote client can reach. Without them a browser's
        // terminal settings wrote a local mirror and nothing else: the host
        // limits never moved, the remote-access switch could only be flipped by
        // restarting the server with `--allow-remote-terminal`, and profiles
        // never arrived at all — so every profile a browser picked came back
        // "unknown terminal profile".
        //
        // `provision` deliberately has no remote arm. It mints a host
        // descriptor for a device public key, and that has to stay a decision
        // made at the host.
        "terminal_host_status" => {
            // Not gated on the remote-access switch: reading that it is OFF is
            // exactly what a client needs in order to explain itself, and a
            // gate here would make the switch invisible from the only surface
            // that can turn it on.
            to_json(
                host.terminal_host_status()
                    .await
                    .map_err(RpcError::internal)?,
            )
        }
        "terminal_host_configure" => {
            // Same reason, more sharply: gating this on the switch would make
            // it impossible to ever turn on remotely. The authority is the
            // manifest's `host.admin` capability, which owner devices hold and
            // chat-only ones do not.
            let settings: crate::terminal_host_service::TerminalHostSettings =
                required(&args, "settings")?;
            to_json(
                host.terminal_host_configure(settings)
                    .await
                    .map_err(RpcError::internal)?,
            )
        }
        "terminal_host_sync_profiles" => {
            // Profiles only matter to a device that can open a terminal, so
            // this one does follow the switch.
            ensure_terminal_rpc_authorized(device_id).await?;
            let profiles: Vec<Value> = optional(&args, "profiles")?.unwrap_or_default();
            let installed = host
                .terminal_host_sync_profiles(device_id, profiles)
                .await
                .map_err(RpcError::internal)?;
            to_json(serde_json::json!({ "installed": installed }))
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
