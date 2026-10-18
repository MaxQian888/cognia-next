//! A local capability terminates at this Host. The child never receives OAuth.
use super::*;
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use cognia_external_agent::{
    commands::{ExternalAgentState, TauriAgentEmitter},
    exec_backend::{self, AgentEventEmitter},
    presets::SpawnPolicy,
    process::{ExternalAgentSandboxPolicy, ExternalAgentSpawnConfig, ExternalAgentStdoutFraming},
    sandbox, state_isolation,
};
use cognia_subscription::siwc::app_server_policy::{provider_args, state_key, validate_message};
use subtle::ConstantTimeEq;
use tokio::sync::watch;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spawn {
    pub id: String,
    pub command: String,
    pub cwd: Option<String>,
    #[serde(default)]
    pub sandbox_policy: ExternalAgentSandboxPolicy,
    #[serde(default)]
    pub extra_writable_roots: Vec<String>,
    pub writable_ceiling: Option<Vec<String>>,
    #[serde(default)]
    pub framing: ExternalAgentStdoutFraming,
}

#[derive(Clone)]
struct Binding {
    profile: Arc<Profile>,
    connection: String,
    capability: Arc<String>,
    stop: watch::Receiver<bool>,
}
struct StreamGuard {
    hub: Arc<Responses>,
    id: String,
}
impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.hub.cancel(&self.id);
    }
}

fn authorized(headers: &HeaderMap, capability: &str) -> bool {
    // Reject browser-origin requests even with a guessed capability. No CORS
    // headers, redirects, URLs, cookies or caller credentials are forwarded.
    if headers.contains_key("origin") {
        return false;
    }
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|value| bool::from(value.as_bytes().ct_eq(capability.as_bytes())))
}

async fn responses(State(binding): State<Binding>, headers: HeaderMap, body: Bytes) -> Response {
    if *binding.stop.borrow() || !authorized(&headers, &binding.capability) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let body = match std::str::from_utf8(&body) {
        Ok(body) => body,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    let guard = StreamGuard {
        hub: binding.profile.responses.clone(),
        id: uuid::Uuid::new_v4().to_string(),
    };
    let mut stop = binding.stop.clone();
    let head = tokio::select! {
        biased;
        _=stop.changed()=>return StatusCode::UNAUTHORIZED.into_response(),
        head=binding.profile.responses.open(&binding.connection,&guard.id,body)=>head,
    };
    if let Err(code) = head {
        // Upstream response bodies are never relayed as diagnostics. The code
        // contains neither credentials nor the prompt/tool output.
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error":{"type":"siwc_request_error","message":code}})),
        )
            .into_response();
    }
    let stream = futures_util::stream::try_unfold((guard, stop), |(guard, mut stop)| async move {
        let next = tokio::select! {
            biased;
            _=stop.changed()=>Err("siwc_cancelled".into()),
            next=guard.hub.read(&guard.id)=>next,
        }
        .map_err(std::io::Error::other)?;
        if next.done {
            return Ok::<_, std::io::Error>(None);
        }
        let bytes = STANDARD
            .decode(
                next.chunk_base64
                    .ok_or_else(|| std::io::Error::other("siwc_invalid_stream"))?,
            )
            .map_err(|_| std::io::Error::other("siwc_invalid_stream"))?;
        Ok(Some((bytes, (guard, stop))))
    });
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-store")
        .body(Body::from_stream(stream))
        .unwrap()
}

pub async fn spawn(
    app: AppHandle,
    state: &SiwcState,
    local_account_id: &str,
    connection_id: &str,
    input: Spawn,
) -> Result<String, String> {
    if input.command != "codex" || input.id.is_empty() {
        return Err("siwc_invalid_launch".into());
    }
    let profile = state.profile(&app, local_account_id)?;
    let _gate = profile.execution_gate.lock().await;
    profile.responses.check_connection(connection_id)?;
    let lease = profile.manager.acquire_access(connection_id, false).await?;
    (profile.authority)()?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "siwc_proxy_unavailable")?;
    let base_url = format!(
        "http://127.0.0.1:{}/v1",
        listener
            .local_addr()
            .map_err(|_| "siwc_proxy_unavailable")?
            .port()
    );
    let capability = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let (stop, stop_rx) = watch::channel(false);
    let binding = Binding {
        profile: profile.clone(),
        connection: connection_id.into(),
        capability: Arc::new(capability.clone()),
        stop: stop_rx.clone(),
    };
    let router = Router::new()
        .route("/v1/responses", post(responses))
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
        .with_state(binding);
    let mut shutdown = stop_rx;
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                if !*shutdown.borrow() {
                    let _ = shutdown.changed().await;
                }
            })
            .await;
    });
    let id = format!("siwc-{}", uuid::Uuid::new_v4());
    let mut env = HashMap::from([
        ("COGNIA_AGENT_SIWC_CAPABILITY".into(), capability),
        (
            state_isolation::AGENT_STATE_KEY_ENV.into(),
            state_key(local_account_id, connection_id, &lease.host_id),
        ),
        (
            sandbox::CODEX_WRITABLE_ROOTS_ENV.into(),
            serde_json::to_string(&input.extra_writable_roots)
                .map_err(|_| "siwc_invalid_launch")?,
        ),
    ]);
    if let Some(ceiling) = input.writable_ceiling {
        env.insert(
            sandbox::CODEX_WRITABLE_CEILING_ENV.into(),
            serde_json::to_string(&ceiling).map_err(|_| "siwc_invalid_launch")?,
        );
    }
    let config = ExternalAgentSpawnConfig {
        id: id.clone(),
        command: "codex".into(),
        args: provider_args(&base_url),
        env,
        cwd: input.cwd,
        framing: input.framing,
        sandbox: None,
        sandbox_policy: input.sandbox_policy,
    };
    let result=async {
        let data_root=cognia_external_agent::dsh_runtime::host_data_root(&app)?;
        let validated=SpawnPolicy::from_env(&data_root).validate_desktop(config).map_err(|_|"siwc_launch_policy_denied")?;
        let sandboxed=sandbox::harden_desktop_spawn(validated.config,false).map_err(|_|"siwc_launch_sandbox_unavailable")?;
        (profile.authority)()?;profile.manager.validate_lease(&lease).await?;
        let backend=app.state::<ExternalAgentState>().backend();
        let emitter:Arc<dyn AgentEventEmitter>=Arc::new(TauriAgentEmitter {app:app.clone()});
        exec_backend::spawn_with_events(backend.as_ref(),emitter,sandboxed).await.map_err(|_|"siwc_process_spawn_failed")?;
        let backend:Arc<dyn cognia_external_agent::exec_backend::ExecBackend>=backend;
        if (profile.authority)().is_err() {let _=backend.kill(&id).await;return Err("siwc_account_changed".into());}
        let publish=app.state::<crate::account_auth::AccountSecuritySession>().with_unlock_generation(local_account_id,&profile.generation,||{
            state.0.processes.lock().insert(id.clone(),Process {connection:connection_id.into(),profile:local_account_id.into(),stop:stop.clone(),backend:backend.clone()});
        });
        if publish.is_err() {let _=backend.kill(&id).await;return Err("siwc_account_changed".into());}
        // Natural exit also revokes the local capability and releases listener.
        let owner=state.clone();let process_id=id.clone();let mut stopped=stop.subscribe();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::select! { _=stopped.changed()=>return, _=tokio::time::sleep(std::time::Duration::from_secs(2))=>{} }
                if !backend.list().await.contains(&process_id) {
                    if let Some(process)=owner.0.processes.lock().remove(&process_id) {process.stop.send_replace(true);}return;
                }
            }
        });
        Ok(id.clone())
    }.await;
    if result.is_err() {
        stop.send_replace(true);
    }
    result
}

pub async fn send(
    app: &AppHandle,
    state: &SiwcState,
    profile_id: &str,
    connection_id: &str,
    id: &str,
    message: &str,
) -> Result<(), String> {
    let profile = state.profile(app, profile_id)?;
    profile.responses.check_connection(connection_id)?;
    validate_message(message)?;
    {
        let processes = state.0.processes.lock();
        processes
            .get(id)
            .filter(|p| p.profile == profile_id && p.connection == connection_id)
            .ok_or("siwc_process_missing")?;
    }
    app.state::<ExternalAgentState>()
        .0
        .send_siwc(id, message)
        .await
}
pub async fn stop(
    state: &SiwcState,
    profile_id: &str,
    connection_id: &str,
    id: &str,
) -> Result<(), String> {
    let process = {
        let mut processes = state.0.processes.lock();
        if processes
            .get(id)
            .is_some_and(|p| p.profile == profile_id && p.connection == connection_id)
        {
            processes.remove(id)
        } else {
            None
        }
    };
    if let Some(process) = process {
        process.stop.send_replace(true);
        process.backend.kill(id).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capability_is_exact_and_browser_requests_are_rejected() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            "Bearer synthetic-capability".parse().unwrap(),
        );
        assert!(authorized(&headers, "synthetic-capability"));
        assert!(!authorized(&headers, "other"));
        headers.insert("origin", "http://example.test".parse().unwrap());
        assert!(!authorized(&headers, "synthetic-capability"));
    }
    #[test]
    fn launch_is_pinned_and_state_binding_separates_profiles_connections_hosts() {
        let args = provider_args("http://127.0.0.1:1234/v1").join(" ");
        assert!(args.contains("requires_openai_auth=false"));
        assert!(args.contains("supports_websockets=false"));
        assert!(args.contains("cli_auth_credentials_store=\"file\""));
        let key = state_key("a", "b", "c");
        assert!(state_isolation::state_key_valid(&key));
        assert_ne!(key, state_key("other", "b", "c"));
        assert_ne!(key, state_key("a", "other", "c"));
        assert_ne!(key, state_key("a", "b", "other"));
    }
    #[test]
    fn refuses_auth_switch_provider_override_and_imported_history() {
        for request in [
            json!({"method":"account/login/start"}),
            json!({"method":"account/logout"}),
            json!({"method":"config/value/write"}),
            json!({"method":"thread/resume","params":{"path":"other-history"}}),
            json!({"method":"thread/start","params":{"modelProvider":"openai"}}),
            json!({"method":"thread/start","params":{"config":{"model_provider":"openai"}}}),
        ] {
            assert!(validate_message(&request.to_string()).is_err());
        }
        assert!(validate_message(
            &json!({"method":"thread/resume","params":{"threadId":"thread-test"}}).to_string()
        )
        .is_ok());
        assert!(
            validate_message(&json!({"method":"account/read","params":{}}).to_string()).is_ok()
        );
    }
}
