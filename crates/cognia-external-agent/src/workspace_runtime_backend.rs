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
/// Single-runtime override: one base URL and one secret serve every workspace.
/// Loopback only — see [`LoopbackWorkspaceRuntimeLocator`].
pub const WORKSPACE_RUNTIME_URL_ENV: &str = "COGNIA_WORKSPACE_RUNTIME_URL";
/// Shared secret for [`WORKSPACE_RUNTIME_URL_ENV`]. Deliberately the same
/// variable the runtime process itself reads
/// (`services/workspace-runtime/src/main.mjs`), so one value configures both
/// halves of a single-machine topology.
pub const WORKSPACE_RUNTIME_SECRET_ENV: &str = "COGNIA_WORKSPACE_RUNTIME_SECRET";

#[derive(Clone)]
pub struct WorkspaceRuntimeEndpoint {
    pub base_url: String,
    pub secret: String,
}

/// Hand-written for the same reason as [`LoopbackWorkspaceRuntimeLocator`]'s:
/// this struct carries the runtime's bearer secret, and a derived `Debug`
/// would leak it into the first log line that formatted an endpoint.
impl std::fmt::Debug for WorkspaceRuntimeEndpoint {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkspaceRuntimeEndpoint")
            .field("base_url", &self.base_url)
            .field("secret", &"<redacted>")
            .finish()
    }
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

    /// URL for this workspace plus the secret files to try, in order.
    ///
    /// `<dir>/<workspace_id>` comes first because it is the name both shipped
    /// deployments actually write: the runtime container's `entrypoint.sh`
    /// writes `/runtime-secrets/$COGNIA_WORKSPACE_ID`, and a k8s Secret built
    /// with `--from-literal=<workspace-id>=…` projects that same bare key.
    /// This locator used to accept only `<workspace_id>.secret`, which matched
    /// neither, so a T2/T3 deployment following the documented steps could
    /// never resolve a runtime. The suffixed name stays as a fallback for
    /// anyone who hand-placed files to satisfy the old code.
    fn endpoint_paths(&self, workspace_id: &str) -> Result<(String, Vec<PathBuf>), String> {
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
            vec![
                self.secret_dir.join(workspace_id),
                self.secret_dir.join(format!("{workspace_id}.secret")),
            ],
        ))
    }
}

/// A runtime secret is a bearer credential for a process that drives a real
/// browser — anything shorter than the runtime's own floor
/// (`COGNIA_WORKSPACE_RUNTIME_SECRET must be at least 32 chars`) is refused
/// here too, so the two halves cannot disagree about what counts as a secret.
fn validate_secret(secret: &str, source: &str) -> Result<String, String> {
    let secret = secret.trim().to_string();
    if secret.len() < 32 {
        return Err(format!(
            "runtime secret {source} must be at least 32 characters"
        ));
    }
    Ok(secret)
}

#[async_trait]
impl WorkspaceRuntimeLocator for EnvironmentWorkspaceRuntimeLocator {
    async fn locate(&self, workspace_id: &str) -> Result<WorkspaceRuntimeEndpoint, String> {
        let (base_url, secret_paths) = self.endpoint_paths(workspace_id)?;
        let mut last_error = None;
        for secret_path in &secret_paths {
            match tokio::fs::read_to_string(secret_path).await {
                Ok(raw) => {
                    let secret = validate_secret(&raw, &secret_path.display().to_string())?;
                    return Ok(WorkspaceRuntimeEndpoint { base_url, secret });
                }
                Err(error) => last_error = Some(error),
            }
        }
        Err(format!(
            "cannot read runtime secret from {}: {}",
            secret_paths
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(" or "),
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "no candidate path".into())
        ))
    }
}

/// One runtime, addressed directly, serving every workspace id.
///
/// The templated locator above is the deployment contract: one runtime per
/// workspace, reached by name, each with its own secret file. A single machine
/// cannot satisfy it — `{workspace_id}` has to resolve in DNS, and the
/// workspace id a client sends is a project id minted at runtime, so nothing
/// can pre-place its secret file. This locator is the development topology
/// instead: one runtime process on loopback, one shared secret.
///
/// Loopback is the whole safety argument, so it is enforced rather than
/// documented: a non-loopback host here would hand every workspace in a
/// deployment the same credential and the same browser, which is exactly the
/// isolation the templated locator exists to provide.
pub struct LoopbackWorkspaceRuntimeLocator {
    base_url: String,
    secret: String,
}

impl LoopbackWorkspaceRuntimeLocator {
    pub fn new(base_url: String, secret: String) -> Result<Arc<Self>, String> {
        let host = loopback_host(&base_url)?;
        if !is_loopback_host(host) {
            return Err(format!(
                "{WORKSPACE_RUNTIME_URL_ENV} must address a loopback host (got {host}); use \
                 {WORKSPACE_RUNTIME_URL_TEMPLATE_ENV} for a deployed runtime"
            ));
        }
        let secret = validate_secret(&secret, WORKSPACE_RUNTIME_SECRET_ENV)?;
        Ok(Arc::new(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            secret,
        }))
    }
}

/// Written by hand, not derived: this type holds a bearer credential, and a
/// derived `Debug` would put it in the first log line or panic message that
/// ever formatted the locator.
impl std::fmt::Debug for LoopbackWorkspaceRuntimeLocator {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LoopbackWorkspaceRuntimeLocator")
            .field("base_url", &self.base_url)
            .field("secret", &"<redacted>")
            .finish()
    }
}

#[async_trait]
impl WorkspaceRuntimeLocator for LoopbackWorkspaceRuntimeLocator {
    async fn locate(&self, _workspace_id: &str) -> Result<WorkspaceRuntimeEndpoint, String> {
        Ok(WorkspaceRuntimeEndpoint {
            base_url: self.base_url.clone(),
            secret: self.secret.clone(),
        })
    }
}

/// Host of an `http(s)` URL, with no dependency on a URL parser: this runs in
/// the default build, where `reqwest` is not compiled in.
fn loopback_host(base_url: &str) -> Result<&str, String> {
    let rest = base_url
        .strip_prefix("http://")
        .or_else(|| base_url.strip_prefix("https://"))
        .ok_or_else(|| format!("{WORKSPACE_RUNTIME_URL_ENV} must be an http(s) URL"))?;
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{WORKSPACE_RUNTIME_URL_ENV} has no host"))?;
    if authority.contains('@') {
        return Err(format!(
            "{WORKSPACE_RUNTIME_URL_ENV} must not carry credentials"
        ));
    }
    // `[::1]:27910` keeps its brackets so the port split below cannot cut an
    // IPv6 address in half.
    if let Some(end) = authority.find(']') {
        return Ok(&authority[..=end]);
    }
    Ok(authority.split(':').next().unwrap_or(authority))
}

fn is_loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.trim_matches(|c| c == '[' || c == ']')
        .parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.is_loopback())
}

/// The one place either half of the runtime plane — the browser gateway and
/// the exec backend — decides how a runtime is addressed. `Ok(None)` means
/// "nothing is configured", which is a valid state for both callers; `Err`
/// means a caller asked for a runtime and the configuration is wrong.
pub fn locator_from_env() -> Result<Option<Arc<dyn WorkspaceRuntimeLocator>>, String> {
    let single_url = std::env::var(WORKSPACE_RUNTIME_URL_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(base_url) = single_url {
        let secret = std::env::var(WORKSPACE_RUNTIME_SECRET_ENV).map_err(|_| {
            format!("{WORKSPACE_RUNTIME_SECRET_ENV} is required with {WORKSPACE_RUNTIME_URL_ENV}")
        })?;
        return Ok(Some(LoopbackWorkspaceRuntimeLocator::new(
            base_url, secret,
        )?));
    }
    let url_template = std::env::var(WORKSPACE_RUNTIME_URL_TEMPLATE_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let secret_dir = std::env::var(WORKSPACE_RUNTIME_SECRET_DIR_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    match (url_template, secret_dir) {
        (Some(url_template), Some(secret_dir)) => Ok(Some(EnvironmentWorkspaceRuntimeLocator::new(
            url_template,
            PathBuf::from(secret_dir),
        ))),
        (None, None) => Ok(None),
        (Some(_), None) => Err(format!(
            "{WORKSPACE_RUNTIME_SECRET_DIR_ENV} is required with {WORKSPACE_RUNTIME_URL_TEMPLATE_ENV}"
        )),
        (None, Some(_)) => Err(format!(
            "{WORKSPACE_RUNTIME_URL_TEMPLATE_ENV} is required with {WORKSPACE_RUNTIME_SECRET_DIR_ENV}"
        )),
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
    let locator = locator_from_env()?.ok_or_else(|| {
        format!(
            "{WORKSPACE_RUNTIME_URL_TEMPLATE_ENV} and {WORKSPACE_RUNTIME_SECRET_DIR_ENV} (or \
             {WORKSPACE_RUNTIME_URL_ENV} and {WORKSPACE_RUNTIME_SECRET_ENV} on loopback) are \
             required for workspace runtimes"
        )
    })?;
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

    #[tokio::test]
    async fn environment_locator_reads_the_secret_name_deployments_actually_write() {
        // `entrypoint.sh` writes `/runtime-secrets/$COGNIA_WORKSPACE_ID` and a
        // k8s Secret projects `--from-literal=<workspace-id>=…` under that same
        // bare key. Requiring `<id>.secret` — as this locator once did — made
        // both documented deployments unable to resolve a runtime at all.
        let dir = tempfile::tempdir().expect("tempdir");
        let locator = EnvironmentWorkspaceRuntimeLocator::new(
            "http://runtime-{workspace_id}:27910".into(),
            dir.path().to_path_buf(),
        );
        std::fs::write(dir.path().join("ws-a"), format!("{}\n", "s".repeat(40))).expect("write");
        let endpoint = locator.locate("ws-a").await.expect("locate");
        assert_eq!(endpoint.base_url, "http://runtime-ws-a:27910");
        assert_eq!(endpoint.secret, "s".repeat(40));

        // The suffixed name stays readable for anyone who placed files to
        // satisfy the old code.
        std::fs::write(dir.path().join("ws-b.secret"), "t".repeat(40)).expect("write");
        assert_eq!(
            locator.locate("ws-b").await.expect("locate").secret,
            "t".repeat(40)
        );

        let error = locator.locate("ws-c").await.unwrap_err();
        assert!(error.contains("ws-c"), "{error}");
        assert!(error.contains("ws-c.secret"), "{error}");
    }

    #[tokio::test]
    async fn environment_locator_refuses_a_short_secret() {
        let dir = tempfile::tempdir().expect("tempdir");
        let locator = EnvironmentWorkspaceRuntimeLocator::new(
            "http://runtime-{workspace_id}:27910".into(),
            dir.path().to_path_buf(),
        );
        std::fs::write(dir.path().join("ws-a"), "too-short").expect("write");
        let error = locator.locate("ws-a").await.unwrap_err();
        assert!(error.contains("at least 32 characters"), "{error}");
    }

    #[test]
    fn loopback_locator_refuses_anything_a_lan_could_reach() {
        let secret = "s".repeat(40);
        for routable in [
            "http://runtime-a:27910",
            "http://10.0.0.5:27910",
            "http://0.0.0.0:27910",
            "https://runtime.example.com",
            "http://192.168.1.20:27910",
        ] {
            let error = LoopbackWorkspaceRuntimeLocator::new(routable.into(), secret.clone())
                .expect_err(routable);
            assert!(error.contains("loopback"), "{routable}: {error}");
        }
        for loopback in [
            "http://127.0.0.1:27910",
            "http://127.2.3.4:27910",
            "http://localhost:27910",
            "http://LOCALHOST:27910",
            "http://[::1]:27910",
        ] {
            LoopbackWorkspaceRuntimeLocator::new(loopback.into(), secret.clone()).expect(loopback);
        }
        assert!(LoopbackWorkspaceRuntimeLocator::new(
            "ws://127.0.0.1:27910".into(),
            secret.clone()
        )
        .is_err());
        assert!(LoopbackWorkspaceRuntimeLocator::new(
            "http://user:pass@127.0.0.1:27910".into(),
            secret.clone()
        )
        .is_err());
        assert!(LoopbackWorkspaceRuntimeLocator::new(
            "http://127.0.0.1:27910".into(),
            "short".into()
        )
        .is_err());
    }

    #[tokio::test]
    async fn loopback_locator_serves_every_workspace_from_one_runtime() {
        // The single-runtime topology is the point: a dev machine has one
        // browser process and the workspace id is a project id minted at run
        // time, so there is nothing to look up per workspace.
        let locator =
            LoopbackWorkspaceRuntimeLocator::new("http://127.0.0.1:27910/".into(), "s".repeat(40))
                .expect("locator");
        let first = locator.locate("default").await.expect("locate");
        let second = locator
            .locate("019217ab-0000-7000-8000-000000000000")
            .await
            .expect("locate");
        assert_eq!(first.base_url, "http://127.0.0.1:27910");
        assert_eq!(second.base_url, first.base_url);
        assert_eq!(second.secret, first.secret);
    }

    #[tokio::test]
    async fn locator_from_env_prefers_the_single_url_and_reports_half_configurations() {
        let _guard = crate::test_env_lock::env_lock().await;
        // `Arc<dyn WorkspaceRuntimeLocator>` is not `Debug`, so `unwrap_err`
        // is unavailable on this Result.
        fn env_error() -> String {
            match locator_from_env() {
                Err(error) => error,
                Ok(_) => panic!("expected a configuration error"),
            }
        }
        for key in [
            WORKSPACE_RUNTIME_URL_ENV,
            WORKSPACE_RUNTIME_SECRET_ENV,
            WORKSPACE_RUNTIME_URL_TEMPLATE_ENV,
            WORKSPACE_RUNTIME_SECRET_DIR_ENV,
        ] {
            std::env::remove_var(key);
        }
        assert!(matches!(locator_from_env(), Ok(None)));

        std::env::set_var(
            WORKSPACE_RUNTIME_URL_TEMPLATE_ENV,
            "http://rt-{workspace_id}:27910",
        );
        let error = env_error();
        assert!(error.contains(WORKSPACE_RUNTIME_SECRET_DIR_ENV), "{error}");
        std::env::set_var(WORKSPACE_RUNTIME_SECRET_DIR_ENV, "/run/secrets");
        assert!(matches!(locator_from_env(), Ok(Some(_))));

        // The loopback pair wins when both are present: it is the development
        // override, and a dev machine also carries the deployment defaults in
        // its environment more often than not.
        std::env::set_var(WORKSPACE_RUNTIME_URL_ENV, "http://127.0.0.1:27910");
        let error = env_error();
        assert!(error.contains(WORKSPACE_RUNTIME_SECRET_ENV), "{error}");
        std::env::set_var(WORKSPACE_RUNTIME_SECRET_ENV, "s".repeat(40));
        let locator = match locator_from_env() {
            Ok(Some(locator)) => locator,
            _ => panic!("the loopback pair must configure a locator"),
        };
        assert_eq!(
            locator.locate("anything").await.expect("locate").base_url,
            "http://127.0.0.1:27910"
        );

        std::env::set_var(WORKSPACE_RUNTIME_URL_ENV, "http://runtime-a:27910");
        assert!(env_error().contains("loopback"));

        for key in [
            WORKSPACE_RUNTIME_URL_ENV,
            WORKSPACE_RUNTIME_SECRET_ENV,
            WORKSPACE_RUNTIME_URL_TEMPLATE_ENV,
            WORKSPACE_RUNTIME_SECRET_DIR_ENV,
        ] {
            std::env::remove_var(key);
        }
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
