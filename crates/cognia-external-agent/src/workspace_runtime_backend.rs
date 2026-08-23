//! Persistent per-workspace runtime backend.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::exec_backend::ExecBackend;
use crate::process::{ExternalAgentEventSink, ExternalAgentProcessState, ExternalAgentSpawnConfig};

pub const WORKSPACE_RUNTIME_WORKSPACES_ENV: &str = "COGNIA_WORKSPACE_RUNTIME_WORKSPACES";
pub const WORKSPACE_RUNTIME_URL_TEMPLATE_ENV: &str = "COGNIA_WORKSPACE_RUNTIME_URL_TEMPLATE";
pub const WORKSPACE_RUNTIME_SECRET_DIR_ENV: &str = "COGNIA_WORKSPACE_RUNTIME_SECRET_DIR";

#[derive(Clone)]
pub struct WorkspaceRuntimeEndpoint {
    pub base_url: String,
    pub secret: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRuntimeEvent {
    pub sequence: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub agent_id: Option<String>,
    pub data: Option<String>,
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub state: Option<String>,
}

#[async_trait]
pub trait WorkspaceRuntimeLocator: Send + Sync + 'static {
    async fn locate(&self, workspace_id: &str) -> Result<WorkspaceRuntimeEndpoint, String>;
}

#[async_trait]
pub trait WorkspaceRuntimeClient: Send + Sync + 'static {
    async fn control(
        &self,
        endpoint: &WorkspaceRuntimeEndpoint,
        operation: &str,
        payload: Value,
    ) -> Result<Value, String>;

    async fn events(
        &self,
        endpoint: &WorkspaceRuntimeEndpoint,
        after: u64,
    ) -> Result<Vec<WorkspaceRuntimeEvent>, String>;

    async fn media(
        &self,
        _endpoint: &WorkspaceRuntimeEndpoint,
        _session_id: &str,
        _after: u64,
    ) -> Result<Option<(u64, Vec<u8>)>, String> {
        Ok(None)
    }

    async fn healthy(&self, _endpoint: &WorkspaceRuntimeEndpoint) -> Result<bool, String> {
        Ok(true)
    }
}

pub struct EnvironmentWorkspaceRuntimeLocator {
    url_template: String,
    secret_dir: PathBuf,
}

impl EnvironmentWorkspaceRuntimeLocator {
    pub fn new(url_template: String, secret_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            url_template,
            secret_dir,
        })
    }

    fn endpoint_paths(&self, workspace_id: &str) -> Result<(String, PathBuf), String> {
        let safe = !workspace_id.is_empty()
            && workspace_id.len() <= 128
            && workspace_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
            && workspace_id != "."
            && workspace_id != "..";
        if !safe {
            return Err("unsafe workspace id for runtime lookup".into());
        }
        if !self.url_template.contains("{workspace_id}") {
            return Err("workspace runtime URL template is missing {workspace_id}".into());
        }
        Ok((
            self.url_template.replace("{workspace_id}", workspace_id),
            self.secret_dir.join(format!("{workspace_id}.secret")),
        ))
    }
}

#[async_trait]
impl WorkspaceRuntimeLocator for EnvironmentWorkspaceRuntimeLocator {
    async fn locate(&self, workspace_id: &str) -> Result<WorkspaceRuntimeEndpoint, String> {
        let (base_url, secret_path) = self.endpoint_paths(workspace_id)?;
        let secret = tokio::fs::read_to_string(&secret_path)
            .await
            .map_err(|error| {
                format!(
                    "cannot read runtime secret {}: {error}",
                    secret_path.display()
                )
            })?
            .trim()
            .to_string();
        if secret.len() < 32 {
            return Err(format!(
                "runtime secret {} must be at least 32 characters",
                secret_path.display()
            ));
        }
        Ok(WorkspaceRuntimeEndpoint { base_url, secret })
    }
}

/// HTTP client for the workspace runtime's control plane.
///
/// Stateless on purpose. It used to hold a single `reqwest::Client::new()`
/// built at construction, which is wrong here twice over: that client captures
/// the ambient proxy environment at the instant it is built — during the
/// renderer hydration window that is
/// `install_uninitialized_proxy_environment`'s deliberate black hole
/// (`http://127.0.0.1:9`) — and it never sees a later Off/Manual/Auto change.
/// Each call now builds a client bound to the live policy for its own target,
/// which also lets the bypass list route a loopback runtime direct while a
/// remote one goes through the proxy.
#[cfg(feature = "workspace-runtime-exec")]
pub struct HttpWorkspaceRuntimeClient;

#[cfg(feature = "workspace-runtime-exec")]
impl HttpWorkspaceRuntimeClient {
    pub fn new() -> Arc<Self> {
        Arc::new(Self)
    }

    fn client_for(target: &str) -> Result<reqwest::Client, String> {
        cognia_net::proxy_config::managed_client(reqwest::Client::builder(), target)
            .map_err(|error| format!("runtime proxy policy: {error}"))
    }
}

#[cfg(feature = "workspace-runtime-exec")]
#[async_trait]
impl WorkspaceRuntimeClient for HttpWorkspaceRuntimeClient {
    async fn control(
        &self,
        endpoint: &WorkspaceRuntimeEndpoint,
        operation: &str,
        payload: Value,
    ) -> Result<Value, String> {
        let url = format!("{}/v1/control", endpoint.base_url.trim_end_matches('/'));
        let response = Self::client_for(&url)?
            .post(&url)
            .bearer_auth(&endpoint.secret)
            .json(&json!({
                "version": 1,
                "type": operation,
                "payload": payload,
            }))
            .send()
            .await
            .map_err(|error| format!("runtime control request failed: {error}"))?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|error| format!("runtime control response was not JSON: {error}"))?;
        if !status.is_success() {
            let code = body
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("runtime_error");
            return Err(format!(
                "runtime_code={code}; control {operation} failed ({})",
                status.as_u16()
            ));
        }
        Ok(body.get("payload").cloned().unwrap_or(Value::Null))
    }

    async fn events(
        &self,
        endpoint: &WorkspaceRuntimeEndpoint,
        after: u64,
    ) -> Result<Vec<WorkspaceRuntimeEvent>, String> {
        let url = format!(
            "{}/v1/events?after={after}",
            endpoint.base_url.trim_end_matches('/')
        );
        let response = Self::client_for(&url)?
            .get(&url)
            .bearer_auth(&endpoint.secret)
            .send()
            .await
            .map_err(|error| format!("runtime events request failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "runtime events request failed with {}",
                response.status().as_u16()
            ));
        }
        let body: Value = response
            .json()
            .await
            .map_err(|error| format!("runtime events response was not JSON: {error}"))?;
        serde_json::from_value(body.get("payload").cloned().unwrap_or_else(|| json!([])))
            .map_err(|error| format!("runtime events payload was invalid: {error}"))
    }

    async fn media(
        &self,
        endpoint: &WorkspaceRuntimeEndpoint,
        session_id: &str,
        after: u64,
    ) -> Result<Option<(u64, Vec<u8>)>, String> {
        let url = format!(
            "{}/v1/media/{}?after={after}",
            endpoint.base_url.trim_end_matches('/'),
            session_id
        );
        let response = Self::client_for(&url)?
            .get(&url)
            .bearer_auth(&endpoint.secret)
            .send()
            .await
            .map_err(|error| format!("runtime media request failed: {error}"))?;
        if response.status().as_u16() == 204 {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!(
                "runtime media request failed with {}",
                response.status().as_u16()
            ));
        }
        let sequence = response
            .headers()
            .get("x-cognia-media-sequence")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| "runtime media response omitted sequence".to_string())?;
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("runtime media body failed: {error}"))?;
        Ok(Some((sequence, bytes.to_vec())))
    }

    async fn healthy(&self, endpoint: &WorkspaceRuntimeEndpoint) -> Result<bool, String> {
        let url = format!("{}/v1/health", endpoint.base_url.trim_end_matches('/'));
        let response = Self::client_for(&url)?
            .get(&url)
            .bearer_auth(&endpoint.secret)
            .send()
            .await
            .map_err(|error| format!("runtime health request failed: {error}"))?;
        Ok(response.status().is_success())
    }
}

struct RuntimeAgentEntry {
    workspace_id: String,
    endpoint: WorkspaceRuntimeEndpoint,
    state: ExternalAgentProcessState,
    config: ExternalAgentSpawnConfig,
    cancel_events: Arc<AtomicBool>,
}

pub struct WorkspaceRuntimeBackend {
    locator: Arc<dyn WorkspaceRuntimeLocator>,
    client: Arc<dyn WorkspaceRuntimeClient>,
    workspaces_root: PathBuf,
    agents: Arc<Mutex<HashMap<String, RuntimeAgentEntry>>>,
    endpoint_cache: Arc<Mutex<HashMap<String, WorkspaceRuntimeEndpoint>>>,
}

impl WorkspaceRuntimeBackend {
    pub fn new(
        locator: Arc<dyn WorkspaceRuntimeLocator>,
        client: Arc<dyn WorkspaceRuntimeClient>,
        workspaces_root: PathBuf,
    ) -> Arc<Self> {
        Arc::new(Self {
            locator,
            client,
            workspaces_root,
            agents: Arc::new(Mutex::new(HashMap::new())),
            endpoint_cache: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    fn workspace_and_runtime_cwd(&self, cwd: &str) -> Result<(String, String), String> {
        let relative = Path::new(cwd)
            .strip_prefix(&self.workspaces_root)
            .map_err(|_| {
                format!(
                    "cwd {cwd} is outside the workspace root {}",
                    self.workspaces_root.display()
                )
            })?;
        let components: Vec<_> = relative.components().collect();
        let workspace_id = match components.first() {
            Some(Component::Normal(value)) => value.to_string_lossy().to_string(),
            _ => return Err("workspace cwd must identify a workspace subpath".into()),
        };
        if components.iter().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err("workspace cwd contains unsafe path components".into());
        }
        let nested: PathBuf = components.iter().skip(1).collect();
        let runtime_cwd = if nested.as_os_str().is_empty() {
            "/workspace".to_string()
        } else {
            format!("/workspace/{}", nested.to_string_lossy().replace('\\', "/"))
        };
        Ok((workspace_id, runtime_cwd))
    }

    async fn endpoint(&self, workspace_id: &str) -> Result<WorkspaceRuntimeEndpoint, String> {
        if let Some(endpoint) = self.endpoint_cache.lock().get(workspace_id).cloned() {
            return Ok(endpoint);
        }
        let endpoint = self.locator.locate(workspace_id).await?;
        self.endpoint_cache
            .lock()
            .insert(workspace_id.to_string(), endpoint.clone());
        Ok(endpoint)
    }

    fn start_event_pump(
        &self,
        agent_id: String,
        endpoint: WorkspaceRuntimeEndpoint,
        sink: Arc<dyn ExternalAgentEventSink>,
        cancel: Arc<AtomicBool>,
    ) {
        let client = Arc::clone(&self.client);
        let agents = Arc::clone(&self.agents);
        tokio::spawn(async move {
            let mut cursor = 0;
            while !cancel.load(Ordering::Relaxed) {
                match client.events(&endpoint, cursor).await {
                    Ok(events) => {
                        for event in events {
                            cursor = cursor.max(event.sequence);
                            if event.agent_id.as_deref() != Some(agent_id.as_str()) {
                                continue;
                            }
                            match event.kind.as_str() {
                                "stdout" => sink.stdout_line(
                                    &agent_id,
                                    event.data.as_deref().unwrap_or_default(),
                                ),
                                "stderr" => sink.stderr_line(
                                    &agent_id,
                                    event.data.as_deref().unwrap_or_default(),
                                ),
                                "exit" => {
                                    if let Some(entry) = agents.lock().get_mut(&agent_id) {
                                        entry.state = ExternalAgentProcessState::Stopped;
                                    }
                                    sink.exited(&agent_id, event.code, event.signal);
                                    cancel.store(true, Ordering::Relaxed);
                                }
                                _ => {}
                            }
                        }
                    }
                    Err(error) => log::warn!("workspace runtime event poll failed: {error}"),
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        });
    }

    fn entry_snapshot(&self, id: &str) -> Result<(WorkspaceRuntimeEndpoint, String), String> {
        let agents = self.agents.lock();
        let entry = agents
            .get(id)
            .ok_or_else(|| format!("Agent {id} not found"))?;
        Ok((entry.endpoint.clone(), entry.workspace_id.clone()))
    }
}

fn state_from_wire(value: &str) -> ExternalAgentProcessState {
    match value.to_ascii_lowercase().as_str() {
        "starting" => ExternalAgentProcessState::Starting,
        "running" => ExternalAgentProcessState::Running,
        "stopping" => ExternalAgentProcessState::Stopping,
        "stopped" | "not_found" => ExternalAgentProcessState::Stopped,
        _ => ExternalAgentProcessState::Failed,
    }
}

#[async_trait]
impl ExecBackend for WorkspaceRuntimeBackend {
    async fn spawn(
        &self,
        config: ExternalAgentSpawnConfig,
        sink: Arc<dyn ExternalAgentEventSink>,
    ) -> Result<String, String> {
        if self.agents.lock().contains_key(&config.id) {
            return Err(format!("Agent {} already exists", config.id));
        }
        let cwd = config
            .cwd
            .as_deref()
            .ok_or_else(|| "workspace runtime requires a workspace cwd".to_string())?;
        let (workspace_id, runtime_cwd) = self.workspace_and_runtime_cwd(cwd)?;
        let endpoint = self.endpoint(&workspace_id).await?;
        self.client
            .control(
                &endpoint,
                "agent.spawn",
                json!({
                    "id": config.id,
                    "command": config.command,
                    "args": config.args,
                    "env": config.env,
                    "cwd": runtime_cwd,
                }),
            )
            .await?;
        let id = config.id.clone();
        let cancel_events = Arc::new(AtomicBool::new(false));
        self.agents.lock().insert(
            id.clone(),
            RuntimeAgentEntry {
                workspace_id,
                endpoint: endpoint.clone(),
                state: ExternalAgentProcessState::Running,
                config,
                cancel_events: Arc::clone(&cancel_events),
            },
        );
        self.start_event_pump(id.clone(), endpoint, sink, cancel_events);
        Ok(id)
    }

    async fn send(&self, id: &str, message: &str) -> Result<(), String> {
        let (endpoint, _) = self.entry_snapshot(id)?;
        self.client
            .control(
                &endpoint,
                "agent.send",
                json!({ "id": id, "message": message }),
            )
            .await?;
        Ok(())
    }

    async fn kill(&self, id: &str) -> Result<(), String> {
        let (endpoint, _) = self.entry_snapshot(id)?;
        self.client
            .control(&endpoint, "agent.kill", json!({ "id": id }))
            .await?;
        if let Some(entry) = self.agents.lock().get_mut(id) {
            entry.state = ExternalAgentProcessState::Stopped;
            entry.cancel_events.store(true, Ordering::Relaxed);
        }
        Ok(())
    }

    async fn kill_all(&self) -> Result<(), String> {
        let ids: Vec<_> = self.agents.lock().keys().cloned().collect();
        for id in ids {
            self.kill(&id).await?;
        }
        Ok(())
    }

    async fn status(&self, id: &str) -> Option<ExternalAgentProcessState> {
        let (endpoint, _) = self.entry_snapshot(id).ok()?;
        match self
            .client
            .control(&endpoint, "agent.status", json!({ "id": id }))
            .await
        {
            Ok(value) => value
                .get("state")
                .and_then(Value::as_str)
                .map(state_from_wire),
            Err(_) => Some(ExternalAgentProcessState::Failed),
        }
    }

    async fn list(&self) -> Vec<String> {
        self.agents.lock().keys().cloned().collect()
    }

    async fn is_running(&self, id: &str) -> Result<bool, String> {
        Ok(matches!(
            self.status(id).await,
            Some(ExternalAgentProcessState::Running)
        ))
    }

    async fn get_info(&self, id: &str) -> Result<Value, String> {
        let agents = self.agents.lock();
        let entry = agents
            .get(id)
            .ok_or_else(|| format!("Agent {id} not found"))?;
        Ok(json!({
            "id": id,
            "workspaceId": entry.workspace_id,
            "state": format!("{:?}", entry.state),
            "command": entry.config.command,
            "args": entry.config.args,
            "cwd": entry.config.cwd,
            "backend": "workspace-runtime",
        }))
    }

    async fn set_running(&self, id: &str) -> Result<(), String> {
        let mut agents = self.agents.lock();
        let entry = agents
            .get_mut(id)
            .ok_or_else(|| format!("Agent {id} not found"))?;
        entry.state = ExternalAgentProcessState::Running;
        Ok(())
    }

    async fn set_failed(&self, id: &str) -> Result<(), String> {
        let mut agents = self.agents.lock();
        let entry = agents
            .get_mut(id)
            .ok_or_else(|| format!("Agent {id} not found"))?;
        entry.state = ExternalAgentProcessState::Failed;
        Ok(())
    }

    fn kind(&self) -> &'static str {
        "workspace-runtime"
    }
}

pub struct WorkspaceRoutingBackend {
    legacy: Arc<dyn ExecBackend>,
    runtime: Arc<dyn ExecBackend>,
    workspaces_root: PathBuf,
    enabled_workspaces: HashSet<String>,
    owners: Mutex<HashMap<String, bool>>,
}

impl WorkspaceRoutingBackend {
    pub fn new(
        legacy: Arc<dyn ExecBackend>,
        runtime: Arc<dyn ExecBackend>,
        workspaces_root: PathBuf,
        enabled_workspaces: HashSet<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            legacy,
            runtime,
            workspaces_root,
            enabled_workspaces,
            owners: Mutex::new(HashMap::new()),
        })
    }

    fn use_runtime(&self, config: &ExternalAgentSpawnConfig) -> bool {
        let Some(cwd) = config.cwd.as_deref() else {
            return false;
        };
        workspace_id_from_cwd(&self.workspaces_root, cwd).is_some_and(|id| {
            self.enabled_workspaces.contains("*") || self.enabled_workspaces.contains(&id)
        })
    }

    fn owner(&self, id: &str) -> Result<Arc<dyn ExecBackend>, String> {
        match self.owners.lock().get(id).copied() {
            Some(true) => Ok(Arc::clone(&self.runtime)),
            Some(false) => Ok(Arc::clone(&self.legacy)),
            None => Err(format!("Agent {id} not found")),
        }
    }
}

fn workspace_id_from_cwd(root: &Path, cwd: &str) -> Option<String> {
    let relative = Path::new(cwd).strip_prefix(root).ok()?;
    match relative.components().next()? {
        Component::Normal(value) => Some(value.to_string_lossy().to_string()),
        _ => None,
    }
}

#[async_trait]
impl ExecBackend for WorkspaceRoutingBackend {
    async fn spawn(
        &self,
        config: ExternalAgentSpawnConfig,
        sink: Arc<dyn ExternalAgentEventSink>,
    ) -> Result<String, String> {
        let runtime = self.use_runtime(&config);
        let backend = if runtime { &self.runtime } else { &self.legacy };
        let id = backend.spawn(config, sink).await?;
        self.owners.lock().insert(id.clone(), runtime);
        Ok(id)
    }

    async fn send(&self, id: &str, message: &str) -> Result<(), String> {
        self.owner(id)?.send(id, message).await
    }

    async fn kill(&self, id: &str) -> Result<(), String> {
        self.owner(id)?.kill(id).await
    }

    async fn kill_all(&self) -> Result<(), String> {
        self.legacy.kill_all().await?;
        self.runtime.kill_all().await
    }

    async fn status(&self, id: &str) -> Option<ExternalAgentProcessState> {
        let backend = self.owner(id).ok()?;
        backend.status(id).await
    }

    async fn list(&self) -> Vec<String> {
        let mut ids = self.legacy.list().await;
        ids.extend(self.runtime.list().await);
        ids.sort();
        ids.dedup();
        ids
    }

    async fn is_running(&self, id: &str) -> Result<bool, String> {
        self.owner(id)?.is_running(id).await
    }

    async fn get_info(&self, id: &str) -> Result<Value, String> {
        self.owner(id)?.get_info(id).await
    }

    async fn set_running(&self, id: &str) -> Result<(), String> {
        self.owner(id)?.set_running(id).await
    }

    async fn set_failed(&self, id: &str) -> Result<(), String> {
        self.owner(id)?.set_failed(id).await
    }

    fn kind(&self) -> &'static str {
        "workspace-routing"
    }
}

#[cfg(feature = "workspace-runtime-exec")]
pub fn wrap_with_workspace_runtime_from_env(
    legacy: Arc<dyn ExecBackend>,
) -> Result<Arc<dyn ExecBackend>, String> {
    let enabled: HashSet<String> = std::env::var(WORKSPACE_RUNTIME_WORKSPACES_ENV)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect();
    if enabled.is_empty() {
        return Ok(legacy);
    }
    let workspaces_root = std::env::var(super::container_backend::WORKSPACES_DIR_ENV)
        .map(PathBuf::from)
        .map_err(|_| {
            format!(
                "{} is required when {} is set",
                super::container_backend::WORKSPACES_DIR_ENV,
                WORKSPACE_RUNTIME_WORKSPACES_ENV
            )
        })?;
    let url_template = std::env::var(WORKSPACE_RUNTIME_URL_TEMPLATE_ENV).map_err(|_| {
        format!("{WORKSPACE_RUNTIME_URL_TEMPLATE_ENV} is required for workspace runtimes")
    })?;
    let secret_dir = std::env::var(WORKSPACE_RUNTIME_SECRET_DIR_ENV)
        .map(PathBuf::from)
        .map_err(|_| {
            format!("{WORKSPACE_RUNTIME_SECRET_DIR_ENV} is required for workspace runtimes")
        })?;
    let locator = EnvironmentWorkspaceRuntimeLocator::new(url_template, secret_dir);
    let runtime = WorkspaceRuntimeBackend::new(
        locator,
        HttpWorkspaceRuntimeClient::new(),
        workspaces_root.clone(),
    );
    Ok(WorkspaceRoutingBackend::new(
        legacy,
        runtime,
        workspaces_root,
        enabled,
    ))
}

#[cfg(not(feature = "workspace-runtime-exec"))]
pub fn wrap_with_workspace_runtime_from_env(
    legacy: Arc<dyn ExecBackend>,
) -> Result<Arc<dyn ExecBackend>, String> {
    if std::env::var(WORKSPACE_RUNTIME_WORKSPACES_ENV)
        .ok()
        .is_some_and(|value| !value.trim().is_empty())
    {
        return Err(format!(
            "{WORKSPACE_RUNTIME_WORKSPACES_ENV} is set but this binary was built without `workspace-runtime-exec`"
        ));
    }
    Ok(legacy)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::{ExternalAgentEventSink, ExternalAgentSpawnConfig};
    use async_trait::async_trait;
    use parking_lot::Mutex;
    use serde_json::{json, Value};
    use std::{collections::HashMap, path::PathBuf, sync::Arc};

    /// The HTTP client is stateless by design (see `HttpWorkspaceRuntimeClient`).
    /// This pins the reason, because the obvious "cache one client in a field"
    /// refactor silently reintroduces the bug.
    ///
    /// One test, not two: the proxy policy is process-wide, so separate tests
    /// in the same binary would race each other's `apply`/`block`.
    #[cfg(feature = "workspace-runtime-exec")]
    #[test]
    fn builds_a_client_per_target_and_fails_closed_without_a_policy() {
        use cognia_net::proxy_config::{
            apply_current, block_current, ProxyConfig, ProxyError, ProxyErrorCode,
        };

        use super::HttpWorkspaceRuntimeClient;

        // Fail-closed: a blocked policy must not yield a client that quietly
        // goes direct around the proxy the user configured.
        block_current(ProxyError::new(
            ProxyErrorCode::ProxyCredentialUnavailable,
            "test",
        ));
        let error = HttpWorkspaceRuntimeClient::client_for("http://runtime-a:27910/v1/health")
            .expect_err("a blocked policy must not yield a client");
        assert!(error.contains("runtime proxy policy"), "got: {error}");

        apply_current(ProxyConfig::default()).unwrap();
        assert!(HttpWorkspaceRuntimeClient::client_for("http://runtime-a:27910/v1/health").is_ok());
        // A different workspace is a different target, and the bypass list is
        // evaluated per host — which is exactly why this is not cached.
        assert!(HttpWorkspaceRuntimeClient::client_for("http://runtime-b:27910/v1/health").is_ok());
    }

    #[derive(Default)]
    struct FakeLocator {
        requested: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl WorkspaceRuntimeLocator for FakeLocator {
        async fn locate(&self, workspace_id: &str) -> Result<WorkspaceRuntimeEndpoint, String> {
            self.requested.lock().push(workspace_id.to_string());
            Ok(WorkspaceRuntimeEndpoint {
                base_url: format!("http://runtime-{workspace_id}:27910"),
                secret: "s".repeat(32),
            })
        }
    }

    #[derive(Default)]
    struct FakeClient {
        calls: Mutex<Vec<(String, String, Value)>>,
    }

    #[async_trait]
    impl WorkspaceRuntimeClient for FakeClient {
        async fn control(
            &self,
            endpoint: &WorkspaceRuntimeEndpoint,
            operation: &str,
            payload: Value,
        ) -> Result<Value, String> {
            self.calls.lock().push((
                endpoint.base_url.clone(),
                operation.to_string(),
                payload.clone(),
            ));
            Ok(match operation {
                "agent.spawn" => json!({ "id": payload["id"], "state": "running" }),
                "agent.status" => json!({ "id": payload["id"], "state": "running" }),
                "agent.list" => json!([]),
                _ => Value::Null,
            })
        }

        async fn events(
            &self,
            _endpoint: &WorkspaceRuntimeEndpoint,
            _after: u64,
        ) -> Result<Vec<WorkspaceRuntimeEvent>, String> {
            Ok(Vec::new())
        }
    }

    #[derive(Default)]
    struct Sink;
    impl ExternalAgentEventSink for Sink {
        fn stdout_line(&self, _agent_id: &str, _line: &str) {}
        fn stderr_line(&self, _agent_id: &str, _line: &str) {}
        fn exited(&self, _agent_id: &str, _code: Option<i32>, _signal: Option<String>) {}
    }

    fn config(id: &str, cwd: &str) -> ExternalAgentSpawnConfig {
        ExternalAgentSpawnConfig {
            id: id.into(),
            command: "codex-acp".into(),
            args: vec!["--stdio".into()],
            env: HashMap::from([("TOKEN".into(), "secret".into())]),
            cwd: Some(cwd.into()),
            framing: Default::default(),
        }
    }

    #[tokio::test]
    async fn routes_full_agent_lifecycle_to_one_persistent_workspace_runtime() {
        let locator = Arc::new(FakeLocator::default());
        let client = Arc::new(FakeClient::default());
        let backend = WorkspaceRuntimeBackend::new(
            locator.clone(),
            client.clone(),
            PathBuf::from("/workspaces"),
        );
        let sink: Arc<dyn ExternalAgentEventSink> = Arc::new(Sink);

        backend
            .spawn(config("agent-1", "/workspaces/ws-a"), sink.clone())
            .await
            .expect("spawn first agent");
        backend
            .spawn(config("agent-2", "/workspaces/ws-a/subdir"), sink)
            .await
            .expect("spawn second agent");
        backend.send("agent-1", "hello").await.expect("send");
        assert_eq!(
            backend.status("agent-1").await,
            Some(crate::process::ExternalAgentProcessState::Running)
        );
        backend.kill("agent-1").await.expect("kill");

        let calls = client.calls.lock();
        assert_eq!(calls[0].1, "agent.spawn");
        assert_eq!(calls[0].2["command"], "codex-acp");
        assert_eq!(calls[1].1, "agent.spawn");
        assert_eq!(calls[2].1, "agent.send");
        assert!(calls.iter().any(|(_, op, _)| op == "agent.kill"));
        assert!(locator.requested.lock().iter().all(|id| id == "ws-a"));
        assert_eq!(backend.kind(), "workspace-runtime");
    }

    #[tokio::test]
    async fn rejects_cwd_outside_the_workspace_root() {
        let backend = WorkspaceRuntimeBackend::new(
            Arc::new(FakeLocator::default()),
            Arc::new(FakeClient::default()),
            PathBuf::from("/workspaces"),
        );
        let result = backend
            .spawn(config("agent-1", "/tmp/escape"), Arc::new(Sink))
            .await;
        assert!(result.unwrap_err().contains("outside the workspace root"));
    }

    #[test]
    fn environment_locator_rejects_unsafe_workspace_ids() {
        let locator = EnvironmentWorkspaceRuntimeLocator::new(
            "http://runtime-{workspace_id}:27910".into(),
            PathBuf::from("/run/secrets/workspace-runtimes"),
        );
        assert!(locator.endpoint_paths("../escape").is_err());
        assert!(locator.endpoint_paths("ws-safe_1").is_ok());
    }

    #[test]
    fn gradual_router_selects_only_explicitly_enabled_workspaces() {
        struct KindBackend(&'static str);
        #[async_trait]
        impl crate::exec_backend::ExecBackend for KindBackend {
            async fn spawn(
                &self,
                config: ExternalAgentSpawnConfig,
                _sink: Arc<dyn ExternalAgentEventSink>,
            ) -> Result<String, String> {
                Ok(config.id)
            }
            async fn send(&self, _id: &str, _message: &str) -> Result<(), String> {
                Ok(())
            }
            async fn kill(&self, _id: &str) -> Result<(), String> {
                Ok(())
            }
            async fn kill_all(&self) -> Result<(), String> {
                Ok(())
            }
            async fn status(&self, _id: &str) -> Option<crate::process::ExternalAgentProcessState> {
                Some(crate::process::ExternalAgentProcessState::Running)
            }
            async fn list(&self) -> Vec<String> {
                Vec::new()
            }
            async fn is_running(&self, _id: &str) -> Result<bool, String> {
                Ok(true)
            }
            async fn get_info(&self, _id: &str) -> Result<Value, String> {
                Ok(json!({ "kind": self.0 }))
            }
            async fn set_running(&self, _id: &str) -> Result<(), String> {
                Ok(())
            }
            async fn set_failed(&self, _id: &str) -> Result<(), String> {
                Ok(())
            }
            fn kind(&self) -> &'static str {
                self.0
            }
        }
        let router = WorkspaceRoutingBackend::new(
            Arc::new(KindBackend("legacy")),
            Arc::new(KindBackend("runtime")),
            PathBuf::from("/workspaces"),
            HashSet::from(["ws-enabled".to_string()]),
        );
        assert!(router.use_runtime(&config("a", "/workspaces/ws-enabled")));
        assert!(!router.use_runtime(&config("b", "/workspaces/ws-legacy")));
    }
}
