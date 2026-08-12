use super::*;

pub(super) const COMMANDS: &[&str] = &[
    "codex_app_runtime_status",
    "codex_app_task_list",
    "codex_app_task_read",
    "codex_app_task_create",
    "codex_app_task_send",
    "codex_app_task_interrupt",
    "codex_app_task_open",
    "codex_app_inventory",
];

fn authorize_cwd(
    host: &super::super::dispatch_host::DispatchHost,
    cwd: &mut Option<String>,
) -> Result<(), (StatusCode, Json<RpcError>)> {
    if let Some(value) = cwd.take() {
        *cwd = Some(authorize_workspace_root(host, value)?);
    }
    Ok(())
}

async fn authorized_thread_cwd(
    app: &tauri::AppHandle,
    host: &super::super::dispatch_host::DispatchHost,
    thread_id: &str,
) -> Result<String, (StatusCode, Json<RpcError>)> {
    let metadata = crate::codex_app_dispatch::codex_app_task_read_impl(
        app,
        crate::codex_app_dispatch::CodexAppTaskReadRequest {
            thread_id: thread_id.to_string(),
            include_turns: Some(false),
        },
    )
    .await
    .map_err(|error| RpcError::internal(format!("{error:#}")))?;
    let cwd = metadata
        .get("thread")
        .and_then(|thread| thread.get("cwd"))
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::internal("Codex App task omitted its workspace".to_string()))?;
    authorize_workspace_root(host, cwd.to_string())
}

fn path_within(path: &std::path::Path, root: &std::path::Path) -> bool {
    path == root || path.starts_with(root)
}

fn authorize_inputs(
    cwd: Option<&str>,
    input: &[crate::codex_app_dispatch::CodexAppTurnInput],
) -> Result<(), (StatusCode, Json<RpcError>)> {
    let cwd = cwd.ok_or_else(|| {
        RpcError::forbidden("remote Codex App sends with local context require an authorized cwd")
    })?;
    let cwd = std::path::Path::new(cwd);
    let home = dirs::home_dir();
    let context_roots = home
        .as_ref()
        .map(|home| {
            [
                home.join(".codex/skills"),
                home.join(".codex/plugins"),
                home.join(".codex/installed_plugins"),
            ]
        })
        .into_iter()
        .flatten()
        .chain([cwd.join(".agents/skills")])
        .filter_map(|path| path.canonicalize().ok())
        .collect::<Vec<_>>();

    for input in input {
        let (path, context_only) = match input {
            crate::codex_app_dispatch::CodexAppTurnInput::LocalImage { path, .. }
            | crate::codex_app_dispatch::CodexAppTurnInput::LocalAudio { path } => {
                (Some(path), false)
            }
            crate::codex_app_dispatch::CodexAppTurnInput::Skill { path, .. }
            | crate::codex_app_dispatch::CodexAppTurnInput::Mention { path, .. } => {
                (Some(path), true)
            }
            crate::codex_app_dispatch::CodexAppTurnInput::Text { .. }
            | crate::codex_app_dispatch::CodexAppTurnInput::Image { .. }
            | crate::codex_app_dispatch::CodexAppTurnInput::Audio { .. } => (None, false),
        };
        let Some(path) = path else { continue };
        let canonical = std::path::Path::new(path).canonicalize().map_err(|error| {
            RpcError::malformed(format!("context path does not resolve: {error}"))
        })?;
        if path_within(&canonical, cwd)
            || (context_only
                && context_roots
                    .iter()
                    .any(|root| path_within(&canonical, root)))
        {
            continue;
        }
        return Err(RpcError::forbidden(
            "Codex App context path is outside the authorized workspace and installed context roots",
        ));
    }
    Ok(())
}

fn authorize_turn_inputs(
    request: &crate::codex_app_dispatch::CodexAppTaskSendRequest,
) -> Result<(), (StatusCode, Json<RpcError>)> {
    authorize_inputs(request.cwd.as_deref(), &request.input)
}

pub(super) async fn dispatch(
    name: &str,
    args: Value,
    _state: &SharedState,
    host: &super::super::dispatch_host::DispatchHost,
    _device_id: &str,
    _account_id: Option<&str>,
    _scope: Option<&str>,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    let app = host.tauri_app(name)?;
    match name {
        "codex_app_runtime_status" => crate::codex_app_dispatch::codex_app_runtime_status_impl(app)
            .await
            .map_err(|error| RpcError::service_unavailable(format!("{error:#}"))),
        "codex_app_task_list" => {
            let mut request: crate::codex_app_dispatch::CodexAppTaskListRequest =
                required(&args, "request")?;
            if request.cwd.is_none() {
                return Err(RpcError::forbidden(
                    "remote Codex App task listing requires an authorized workspace",
                ));
            }
            authorize_cwd(host, &mut request.cwd)?;
            crate::codex_app_dispatch::codex_app_task_list_impl(app, request)
                .await
                .map_err(|error| RpcError::internal(format!("{error:#}")))
        }
        "codex_app_task_read" => {
            let request: crate::codex_app_dispatch::CodexAppTaskReadRequest =
                required(&args, "request")?;
            authorized_thread_cwd(app, host, &request.thread_id).await?;
            crate::codex_app_dispatch::codex_app_task_read_impl(app, request)
                .await
                .map_err(|error| RpcError::internal(format!("{error:#}")))
        }
        "codex_app_task_create" => {
            let mut request: crate::codex_app_dispatch::CodexAppTaskCreateRequest =
                required(&args, "request")?;
            request.cwd = authorize_workspace_root(host, request.cwd)?;
            authorize_inputs(Some(&request.cwd), &request.input)?;
            crate::codex_app_dispatch::codex_app_task_create_impl(app, request)
                .await
                .map_err(|error| RpcError::internal(format!("{error:#}")))
        }
        "codex_app_task_send" => {
            let mut request: crate::codex_app_dispatch::CodexAppTaskSendRequest =
                required(&args, "request")?;
            request.cwd = Some(authorized_thread_cwd(app, host, &request.thread_id).await?);
            authorize_turn_inputs(&request)?;
            crate::codex_app_dispatch::codex_app_task_send_impl(app, request)
                .await
                .map_err(|error| RpcError::internal(format!("{error:#}")))
        }
        "codex_app_task_interrupt" => {
            let request: crate::codex_app_dispatch::CodexAppTaskInterruptRequest =
                required(&args, "request")?;
            authorized_thread_cwd(app, host, &request.thread_id).await?;
            crate::codex_app_dispatch::codex_app_task_interrupt_impl(app, request)
                .await
                .map_err(|error| RpcError::internal(format!("{error:#}")))
        }
        "codex_app_task_open" => {
            let thread_id: String = required(&args, "threadId")?;
            authorized_thread_cwd(app, host, &thread_id).await?;
            crate::codex_app_dispatch::codex_app_task_open_impl(app, thread_id)
                .await
                .map_err(|error| RpcError::internal(format!("{error:#}")))
        }
        "codex_app_inventory" => {
            let mut request: crate::codex_app_dispatch::CodexAppInventoryRequest =
                required(&args, "request")?;
            if request.cwd.is_none() {
                return Err(RpcError::forbidden(
                    "remote Codex App inventory requires an authorized workspace",
                ));
            }
            authorize_cwd(host, &mut request.cwd)?;
            if let Some(thread_id) = request.thread_id.as_deref() {
                request.cwd = Some(authorized_thread_cwd(app, host, thread_id).await?);
            }
            crate::codex_app_dispatch::codex_app_inventory_impl(app, request)
                .await
                .and_then(|inventory| serde_json::to_value(inventory).map_err(anyhow::Error::from))
                .map_err(|error| RpcError::internal(format!("{error:#}")))
        }
        unknown => Err(RpcError::unknown_command(unknown)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_family_is_unique_and_complete() {
        assert_eq!(COMMANDS.len(), 8);
        assert_eq!(
            COMMANDS
                .iter()
                .copied()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            COMMANDS.len()
        );
    }

    #[test]
    fn remote_context_paths_must_stay_inside_the_authorized_workspace() {
        let cwd = tempfile::tempdir().unwrap();
        let inside = tempfile::NamedTempFile::new_in(cwd.path()).unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        let request = |path: &std::path::Path| crate::codex_app_dispatch::CodexAppTaskSendRequest {
            thread_id: "01989a8f-7b2b-7aa2-a8b8-c859418ac18f".into(),
            input: vec![crate::codex_app_dispatch::CodexAppTurnInput::LocalImage {
                path: path.display().to_string(),
                detail: None,
            }],
            cwd: Some(cwd.path().canonicalize().unwrap().display().to_string()),
            model: None,
            effort: None,
            approval_policy: None,
            context_label: None,
        };

        assert!(authorize_turn_inputs(&request(inside.path())).is_ok());
        assert!(authorize_turn_inputs(&request(outside.path())).is_err());
    }
}
