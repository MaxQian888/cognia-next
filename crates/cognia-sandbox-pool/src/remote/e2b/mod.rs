//! The E2B remote provider (ADR-0221).
//!
//! An E2B sandbox is a Firecracker microVM created from a template. The
//! provider implements both halves of the remote seam:
//!
//! - [`RemoteProvisioner`]: a template per (user image digest, bundle digest,
//!   size class) with the agent bundle installed at `/cognia` ([`template`]),
//!   then a sandbox of it whose TTL is the request's hard lifetime, whose
//!   egress is E2B's own network policy (enforced for every tier), and whose
//!   metadata carries the driver's labels verbatim.
//! - [`SandboxDockerApi`]: exec as envd process streams ([`envd`]), labels and
//!   ownership as sandbox metadata, inspection and deletion through the REST
//!   API ([`api`]), retained runtimes as pause and resume.
//!
//! Every process runs as root (E2B's `user: 'root'`). The account's API key is
//! resolved by the Host and never logged; envd access tokens live only in the
//! in-memory connection cache, filled from the create response or, for a
//! sandbox found after a Host restart, from its detail.

mod api;
mod bundle;
mod connect;
mod envd;
mod template;
#[cfg(test)]
mod test_server;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use cognia_environment::spec::{EgressTier, IsolationTier};
use cognia_external_agent::container_backend::{
    is_owned, validate_deployment_id, ContainerApi, OwnedContainer, OwnedVolume, RegistryAuth,
    RunnerEvent, RunnerExecSpec, RunnerRunError, RunnerSpec, RunningRunner, RuntimeContainerState,
    SandboxDockerApi, VolumeRemoval, DEPLOYMENT_LABEL, OWNER_LABEL, OWNER_VALUE,
};
use cognia_external_agent::sandbox_routing_backend::SandboxSpawnError;
use cognia_sandboxd::layout::{BIN_DIR, INJECTION_ROOT, WORKSPACE_ROOT};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};
use url::Url;

use self::api::{ApiClient, ApiError, CreatedSandbox, PauseOutcome, SandboxInfo};
use self::bundle::BundleSource;
use self::envd::{
    EndStatus, EnvdEndpoint, EnvdError, ProcessEvent, ProcessInput, ProcessStream, StartSpec,
};
use self::template::{
    ensure_template, from_image_registry, resources, template_name, TemplatePlan,
};
use super::{ProvisionRequest, RemoteProvisioner, START_MARKER};

/// The provider kind, as the console labels the driver.
pub const KIND: &str = "e2b";
/// Metadata key the provider adds beside the driver's labels: the Unix second
/// the request's lifetime ends at, so a resume never outlives it. Stripped
/// from every label set the provider returns.
const DEADLINE_KEY: &str = "cognia-e2b.deadline";
/// Docker Hub's spellings, all meaning `docker.io`.
const DOCKER_HUB_ALIASES: [&str; 3] = ["docker.io", "index.docker.io", "registry-1.docker.io"];
/// Bounded queues between envd and the driver, so a slow consumer exerts
/// backpressure on envd (and envd on the process's pipe).
const EVENT_QUEUE: usize = 64;
const STDIN_QUEUE: usize = 16;
/// Output kept for an error message.
const MAX_ERROR_OUTPUT: usize = 4096;

fn default_api_url() -> String {
    "https://api.e2b.app".to_string()
}

fn default_domain() -> String {
    "e2b.app".to_string()
}

fn default_template_prefix() -> String {
    "cognia".to_string()
}

fn default_build_timeout() -> u64 {
    1800
}

/// One E2B provider's settings, from the providers file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct E2bSettings {
    /// The control-plane API (`https://api.e2b.app`).
    #[serde(default = "default_api_url")]
    pub api_url: String,
    /// The domain sandbox traffic is served under (`e2b.app`); a create
    /// response that names its own domain wins.
    #[serde(default = "default_domain")]
    pub domain: String,
    /// Registries whose pull credentials may be handed to E2B's template build
    /// (G12). Matched case-insensitively against the image registry host.
    #[serde(default)]
    pub delegated_registries: Vec<String>,
    /// The first part of every template name.
    #[serde(default = "default_template_prefix")]
    pub template_prefix: String,
    /// How long a template build (bundle upload included) may take, 60 to
    /// 7200 seconds.
    #[serde(default = "default_build_timeout")]
    pub template_build_timeout_secs: u64,
}

impl Default for E2bSettings {
    fn default() -> Self {
        Self {
            api_url: default_api_url(),
            domain: default_domain(),
            delegated_registries: Vec::new(),
            template_prefix: default_template_prefix(),
            template_build_timeout_secs: default_build_timeout(),
        }
    }
}

/// `docker.io` for every Docker Hub spelling, lowercase otherwise.
fn normalize_registry(registry: &str) -> String {
    let lowered = registry.trim().to_ascii_lowercase();
    if DOCKER_HUB_ALIASES.contains(&lowered.as_str()) {
        "docker.io".to_string()
    } else {
        lowered
    }
}

/// `host[:port]`, as an image reference names a registry.
fn is_valid_registry(registry: &str) -> bool {
    let (host, port) = match registry.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (registry, None),
    };
    if let Some(port) = port {
        if port.is_empty() || port.parse::<u16>().is_err() {
            return false;
        }
    }
    host == "localhost" || (host.contains('.') && cognia_net::egress::is_valid_hostname(host))
}

/// Tunables the tests shorten; production uses the defaults.
#[derive(Clone, Debug)]
struct Tuning {
    /// Between template build status polls.
    poll_interval: Duration,
    /// How long a released supervisor is watched for an immediate exit.
    supervisor_grace: Duration,
    /// How long an exec may take to report its start.
    start_timeout: Duration,
    /// The post-create check that exec works.
    verify_timeout: Duration,
    /// Plain HTTP to the bundle registry (a loopback test registry only).
    bundle_registry_insecure: bool,
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_secs(2),
            supervisor_grace: Duration::from_secs(1),
            start_timeout: Duration::from_secs(60),
            verify_timeout: Duration::from_secs(120),
            bundle_registry_insecure: false,
        }
    }
}

/// Derives envd's base URL from a sandbox id and its traffic domain.
type EnvdBase = Arc<dyn Fn(&str, &str) -> Result<Url, String> + Send + Sync>;

/// How to reach one sandbox's envd.
#[derive(Clone)]
struct Connection {
    access_token: Option<String>,
    domain: String,
}

/// The E2B provider. Construct with [`E2bProvider::new`].
pub struct E2bProvider {
    settings: E2bSettings,
    delegated: BTreeSet<String>,
    deployment_id: String,
    api: ApiClient,
    envd_base: EnvdBase,
    connections: parking_lot::Mutex<HashMap<String, Connection>>,
    build_locks: parking_lot::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    tuning: Tuning,
}

impl fmt::Debug for E2bProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("E2bProvider")
            .field("settings", &self.settings)
            .field("deployment_id", &self.deployment_id)
            .field("api", &self.api)
            .finish_non_exhaustive()
    }
}

/// E2B's sandbox ids are lowercase alphanumerics; anything else is not one
/// and never reaches a URL or a hostname.
fn validate_sandbox_id(id: &str) -> Result<(), String> {
    if !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    {
        Ok(())
    } else {
        Err(format!("{id:?} is not an E2B sandbox id"))
    }
}

/// `KEY=VALUE` lines as a map; a later line wins, as in Docker.
fn parse_env(lines: &[String]) -> Result<BTreeMap<String, String>, String> {
    let mut envs = BTreeMap::new();
    for line in lines {
        let (key, value) = line
            .split_once('=')
            .filter(|(key, _)| !key.is_empty())
            .ok_or_else(|| format!("environment entry {:?} is not KEY=VALUE", key_of(line)))?;
        envs.insert(key.to_string(), value.to_string());
    }
    Ok(envs)
}

/// An entry's name only, so a malformed secret value is never echoed.
fn key_of(line: &str) -> &str {
    line.split('=').next().unwrap_or_default()
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// The driver's labels from stored metadata.
fn decode_labels(metadata: Option<BTreeMap<String, String>>) -> BTreeMap<String, String> {
    let mut labels = metadata.unwrap_or_default();
    labels.remove(DEADLINE_KEY);
    labels
}

/// Seconds left of the lifetime recorded in `metadata`.
fn remaining_secs(metadata: Option<&BTreeMap<String, String>>) -> Result<u64, Remaining> {
    let deadline = metadata
        .and_then(|metadata| metadata.get(DEADLINE_KEY))
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or(Remaining::Unknown)?;
    match deadline.checked_sub(unix_now()) {
        Some(left) if left > 0 => Ok(left),
        _ => Err(Remaining::Elapsed),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Remaining {
    Unknown,
    Elapsed,
}

/// The `POST /v2/sandboxes` body.
fn sandbox_body(
    template_id: &str,
    timeout_secs: u64,
    metadata: &BTreeMap<String, String>,
    request: &ProvisionRequest,
) -> Value {
    let mut body = json!({
        "templateID": template_id,
        "timeout": timeout_secs,
        "autoPause": false,
        "metadata": metadata,
    });
    match request.egress.tier {
        EgressTier::Off => {
            body["allow_internet_access"] = json!(false);
        }
        EgressTier::Allowlist => {
            body["allow_internet_access"] = json!(true);
            body["network"] = json!({
                "allowOut": request.egress.domains,
                "denyOut": ["0.0.0.0/0"],
            });
        }
        EgressTier::On => {
            body["allow_internet_access"] = json!(true);
        }
    }
    body
}

/// A failed `POST /v2/sandboxes`, as a spawn outcome.
fn create_error(error: &ApiError) -> SandboxSpawnError {
    if let ApiError::Status {
        status: 400,
        message,
    } = error
    {
        let lowered = message.to_ascii_lowercase();
        if lowered.contains("timeout") && lowered.contains("greater") {
            return SandboxSpawnError::refused(
                "sandbox_lifetime_exceeds_plan",
                format!("E2B refused the sandbox lifetime: {message}"),
            );
        }
    }
    error.to_spawn_error("creating the E2B sandbox")
}

/// The script that proves a new sandbox can run the bundle: as root, the
/// supervisor is installed, the workspace exists and is writable, and the
/// supervisor's control directory exists (`/tmp` may be a fresh tmpfs).
fn verify_script() -> String {
    let control_dir = std::path::Path::new(START_MARKER)
        .parent()
        .and_then(|dir| dir.to_str())
        .expect("the start marker lives in a directory");
    format!(
        "mkdir -p {control_dir} && test -x {INJECTION_ROOT}/{BIN_DIR}/cognia-sandboxd && test -d {WORKSPACE_ROOT} && test -w {WORKSPACE_ROOT}"
    )
}

/// Waits for a process's start event.
async fn wait_start(stream: &mut ProcessStream) -> Result<u32, EnvdError> {
    loop {
        match stream.next_event().await? {
            Some(ProcessEvent::Start { pid }) => return Ok(pid),
            Some(ProcessEvent::Keepalive) => continue,
            Some(other) => {
                return Err(EnvdError::Protocol(format!(
                    "the process reported {other:?} before it started"
                )))
            }
            None => {
                return Err(EnvdError::Protocol(
                    "the call ended before the process started".into(),
                ))
            }
        }
    }
}

fn extend_capped(buffer: &mut Vec<u8>, bytes: &[u8]) {
    let room = MAX_ERROR_OUTPUT.saturating_sub(buffer.len());
    buffer.extend_from_slice(&bytes[..bytes.len().min(room)]);
}

/// Forwards a process's events to the driver until it ends. A stream that
/// breaks or ends without an end event is an exit with no known code.
async fn forward_events(
    mut stream: ProcessStream,
    events: mpsc::Sender<RunnerEvent>,
    ended: watch::Sender<bool>,
) {
    let code = loop {
        let event = match stream.next_event().await {
            Ok(Some(ProcessEvent::Stdout(bytes))) if !bytes.is_empty() => {
                RunnerEvent::Stdout(bytes)
            }
            Ok(Some(ProcessEvent::Stderr(bytes))) if !bytes.is_empty() => {
                RunnerEvent::Stderr(bytes)
            }
            Ok(Some(ProcessEvent::End(end))) => break end.code(),
            Ok(Some(_)) => continue,
            Ok(None) => break None,
            Err(error) => {
                log::debug!("e2b: exec stream ended without an exit: {error}");
                break None;
            }
        };
        if events.send(event).await.is_err() {
            // The driver let go of the exec; the process keeps running, as
            // a Docker exec does when its attach is dropped.
            return;
        }
    };
    let _ = ended.send(true);
    let _ = events.send(RunnerEvent::Exited { code }).await;
}

/// Writes the driver's stdin chunks to the process in order, one call at a
/// time, and closes its stdin when the driver drops the sender.
async fn pump_stdin(
    input: ProcessInput,
    pid: u32,
    mut chunks: mpsc::Receiver<Vec<u8>>,
    mut ended: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            biased;
            chunk = chunks.recv() => match chunk {
                Some(bytes) if bytes.is_empty() => continue,
                Some(bytes) => {
                    if let Err(error) = input.send(&bytes).await {
                        log::debug!("e2b: stdin of process {pid} is closed: {error}");
                        return;
                    }
                }
                None => {
                    if let Err(error) = input.close().await {
                        if !*ended.borrow() {
                            log::debug!("e2b: closing stdin of process {pid}: {error}");
                        }
                    }
                    return;
                }
            },
            changed = ended.changed() => {
                if changed.is_err() || *ended.borrow() {
                    return;
                }
            }
        }
    }
}

/// Kills a just-created sandbox unless disarmed — so a provision that fails,
/// or whose caller goes away, never leaves a billed sandbox behind.
struct KillOnDrop {
    api: Option<ApiClient>,
    id: String,
}

impl KillOnDrop {
    fn disarm(&mut self) {
        self.api = None;
    }
}

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let Some(api) = self.api.take() else {
            return;
        };
        let id = std::mem::take(&mut self.id);
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(async move {
                    if let Err(error) = api.delete_sandbox(&id).await {
                        log::warn!("e2b: cleaning up abandoned sandbox {id}: {error}");
                    }
                });
            }
            Err(_) => {
                log::warn!("e2b: sandbox {id} was abandoned outside a runtime; its TTL will end it")
            }
        }
    }
}

impl E2bProvider {
    /// `api_key` is resolved by the Host (secret store, environment, file)
    /// and never logged.
    pub fn new(
        settings: E2bSettings,
        api_key: String,
        deployment_id: &str,
    ) -> Result<Arc<Self>, String> {
        Self::build(
            settings,
            api_key,
            deployment_id,
            Tuning::default(),
            Arc::new(envd::default_envd_base),
        )
        .map(Arc::new)
    }

    fn build(
        settings: E2bSettings,
        api_key: String,
        deployment_id: &str,
        tuning: Tuning,
        envd_base: EnvdBase,
    ) -> Result<Self, String> {
        Self::validate(&settings)?;
        let api_key = api_key.trim().to_string();
        if api_key.is_empty() {
            return Err("the E2B API key is empty".into());
        }
        if api_key.len() > 4096 || !api_key.bytes().all(|b| b.is_ascii_graphic()) {
            return Err("the E2B API key contains characters a header cannot carry".into());
        }
        let deployment_id = validate_deployment_id(deployment_id)?;
        let base = Url::parse(&settings.api_url)
            .map_err(|error| format!("apiUrl {:?} is invalid: {error}", settings.api_url))?;
        let delegated = settings
            .delegated_registries
            .iter()
            .map(|registry| normalize_registry(registry))
            .collect();
        Ok(Self {
            api: ApiClient::new(base, api_key),
            delegated,
            deployment_id,
            envd_base,
            connections: parking_lot::Mutex::new(HashMap::new()),
            build_locks: parking_lot::Mutex::new(HashMap::new()),
            tuning,
            settings,
        })
    }

    /// Checks settings without building a provider.
    pub fn validate(settings: &E2bSettings) -> Result<(), String> {
        let url = Url::parse(&settings.api_url)
            .map_err(|error| format!("apiUrl {:?} is invalid: {error}", settings.api_url))?;
        match url.scheme() {
            "https" => {}
            "http" if api::is_loopback(&url) => {}
            _ => {
                return Err(format!(
                    "apiUrl {:?} must use https (plain http only on a loopback host)",
                    settings.api_url
                ))
            }
        }
        if url.host().is_none() || url.cannot_be_a_base() {
            return Err(format!("apiUrl {:?} names no host", settings.api_url));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err("apiUrl must not carry credentials".into());
        }
        if url.query().is_some() || url.fragment().is_some() {
            return Err("apiUrl must not carry a query or fragment".into());
        }
        let domain = settings.domain.trim();
        if domain != settings.domain
            || !domain.contains('.')
            || domain.parse::<std::net::IpAddr>().is_ok()
            || !cognia_net::egress::is_valid_hostname(domain)
        {
            return Err(format!("domain {:?} is not a DNS name", settings.domain));
        }
        for registry in &settings.delegated_registries {
            if !is_valid_registry(&registry.to_ascii_lowercase()) {
                return Err(format!(
                    "delegatedRegistries entry {registry:?} is not a registry host"
                ));
            }
        }
        let prefix = settings.template_prefix.as_bytes();
        let prefix_ok = !prefix.is_empty()
            && prefix.len() <= 32
            && (prefix[0].is_ascii_lowercase() || prefix[0].is_ascii_digit())
            && prefix
                .iter()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-' || *b == b'_');
        if !prefix_ok {
            return Err(format!(
                "templatePrefix {:?} must be 1 to 32 characters of [a-z0-9_-], starting with a letter or digit",
                settings.template_prefix
            ));
        }
        if !(60..=7200).contains(&settings.template_build_timeout_secs) {
            return Err(format!(
                "templateBuildTimeoutSecs must be between 60 and 7200, not {}",
                settings.template_build_timeout_secs
            ));
        }
        Ok(())
    }

    /// The metadata filter that finds this deployment's sandboxes.
    fn owner_filter(&self) -> BTreeMap<String, String> {
        BTreeMap::from([
            (OWNER_LABEL.to_string(), OWNER_VALUE.to_string()),
            (DEPLOYMENT_LABEL.to_string(), self.deployment_id.clone()),
        ])
    }

    fn remember(&self, sandbox: &CreatedSandbox) {
        let domain = sandbox
            .domain
            .clone()
            .filter(|domain| !domain.is_empty())
            .unwrap_or_else(|| self.settings.domain.clone());
        self.connections.lock().insert(
            sandbox.sandbox_id.clone(),
            Connection {
                access_token: sandbox.envd_access_token.clone().filter(|t| !t.is_empty()),
                domain,
            },
        );
    }

    fn forget(&self, id: &str) {
        self.connections.lock().remove(id);
    }

    /// The connection of a sandbox this process did not create: from its
    /// detail, or — when the detail carries no envd token — from a connect
    /// whose timeout is what is left of the recorded lifetime, so the TTL is
    /// never extended past it.
    async fn fetch_connection(&self, id: &str) -> Result<Connection, String> {
        let info = self
            .api
            .get_sandbox(id)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("E2B sandbox {id} does not exist"))?;
        if info.state != "running" {
            return Err(format!("E2B sandbox {id} is {}", info.state));
        }
        let domain = info
            .domain
            .clone()
            .filter(|domain| !domain.is_empty())
            .unwrap_or_else(|| self.settings.domain.clone());
        let access_token = match info.envd_access_token.clone().filter(|t| !t.is_empty()) {
            Some(token) => Some(token),
            None => {
                let left = remaining_secs(info.metadata.as_ref()).map_err(|why| match why {
                    Remaining::Unknown => {
                        format!("E2B sandbox {id} has no envd token and no recorded lifetime")
                    }
                    Remaining::Elapsed => format!("E2B sandbox {id} is past its lifetime"),
                })?;
                let connected = self
                    .api
                    .connect_sandbox(id, left)
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| format!("E2B sandbox {id} does not exist"))?;
                connected.envd_access_token.filter(|t| !t.is_empty())
            }
        };
        let connection = Connection {
            access_token,
            domain,
        };
        self.connections
            .lock()
            .insert(id.to_string(), connection.clone());
        Ok(connection)
    }

    async fn envd_endpoint(&self, id: &str) -> Result<EnvdEndpoint, String> {
        validate_sandbox_id(id)?;
        let cached = self.connections.lock().get(id).cloned();
        let connection = match cached {
            Some(connection) => connection,
            None => self.fetch_connection(id).await?,
        };
        let base = (self.envd_base)(id, &connection.domain)?;
        Ok(EnvdEndpoint {
            base,
            sandbox_id: id.to_string(),
            access_token: connection.access_token,
        })
    }

    /// Starts a process, refetching the connection once when envd refuses a
    /// cached token, and waits for its start event.
    async fn start_process(
        &self,
        id: &str,
        spec: &StartSpec,
    ) -> Result<(EnvdEndpoint, ProcessStream, u32), EnvdError> {
        let mut endpoint = self.envd_endpoint(id).await.map_err(EnvdError::Transport)?;
        let mut stream = match envd::start(&endpoint, spec).await {
            Err(EnvdError::Unauthorized(_)) => {
                self.forget(id);
                endpoint = self.envd_endpoint(id).await.map_err(EnvdError::Transport)?;
                envd::start(&endpoint, spec).await?
            }
            other => other?,
        };
        let pid = tokio::time::timeout(self.tuning.start_timeout, wait_start(&mut stream))
            .await
            .map_err(|_| {
                EnvdError::Transport(format!(
                    "no start event within {}s",
                    self.tuning.start_timeout.as_secs()
                ))
            })??;
        Ok((endpoint, stream, pid))
    }

    /// Runs the verification script and reads it to its end.
    async fn verify(&self, id: &str) -> Result<(), SandboxSpawnError> {
        let spec = StartSpec {
            cmd: "/bin/sh".into(),
            args: vec!["-c".into(), verify_script()],
            envs: BTreeMap::new(),
            cwd: Some("/".into()),
            stdin: false,
        };
        let unreachable = |error: String| {
            SandboxSpawnError::fault(
                "sandbox_provider_unreachable",
                format!("running a command in E2B sandbox {id}: {error}"),
            )
        };
        let outcome = tokio::time::timeout(self.tuning.verify_timeout, async {
            let (_, mut stream, _) = self
                .start_process(id, &spec)
                .await
                .map_err(|error| error.to_string())?;
            let mut output = Vec::new();
            loop {
                match stream
                    .next_event()
                    .await
                    .map_err(|error| error.to_string())?
                {
                    Some(ProcessEvent::Stderr(bytes)) | Some(ProcessEvent::Stdout(bytes)) => {
                        extend_capped(&mut output, &bytes)
                    }
                    Some(ProcessEvent::End(end)) => return Ok::<_, String>((end, output)),
                    Some(_) => {}
                    None => return Err("the check ended without an exit".to_string()),
                }
            }
        })
        .await
        .map_err(|_| unreachable("the check timed out".into()))?
        .map_err(unreachable)?;
        let (end, output): (EndStatus, Vec<u8>) = outcome;
        if end.code() == Some(0) {
            return Ok(());
        }
        Err(SandboxSpawnError::refused(
            "sandbox_template_invalid",
            format!(
                "E2B sandbox {id} cannot run the agent bundle ({}): {}",
                end.status,
                String::from_utf8_lossy(&output).trim()
            ),
        ))
    }

    fn build_lock(&self, name: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.build_locks
            .lock()
            .entry(name.to_string())
            .or_default()
            .clone()
    }

    /// Drops the lock entry of `name` once nobody else holds it.
    fn release_build_lock(&self, name: &str, lock: Arc<tokio::sync::Mutex<()>>) {
        let mut locks = self.build_locks.lock();
        drop(lock);
        if locks
            .get(name)
            .is_some_and(|entry| Arc::strong_count(entry) == 1)
        {
            locks.remove(name);
        }
    }

    fn plan(&self, request: &ProvisionRequest) -> Result<TemplatePlan, SandboxSpawnError> {
        let invalid =
            |message: String| SandboxSpawnError::refused("sandbox_request_invalid", message);
        request
            .image
            .validate()
            .map_err(|error| invalid(format!("the image: {error}")))?;
        request
            .bundle
            .validate()
            .map_err(|error| invalid(format!("the agent bundle: {error}")))?;
        if request.labels.contains_key(DEADLINE_KEY) {
            return Err(invalid(format!("the label {DEADLINE_KEY} is reserved")));
        }
        let (cpu_count, memory_mb) = resources(&request.size);
        Ok(TemplatePlan {
            name: template_name(
                &self.settings.template_prefix,
                &request.image,
                &request.bundle,
                &request.size,
            ),
            from_image: request.image.canonical(),
            registry: from_image_registry(request.registry_auth.as_ref())?,
            cpu_count,
            memory_mb,
            bundle: BundleSource {
                image: request.bundle.clone(),
                auth: request.bundle_registry_auth.clone(),
                insecure: self.tuning.bundle_registry_insecure,
            },
        })
    }
}

#[async_trait]
impl RemoteProvisioner for E2bProvider {
    fn kind(&self) -> &'static str {
        KIND
    }

    async fn tiers(&self) -> Result<Vec<IsolationTier>, SandboxSpawnError> {
        self.api
            .list_sandboxes_page(&self.owner_filter(), 1, None)
            .await
            .map_err(|error| error.to_spawn_error("reaching E2B"))?;
        // Every E2B sandbox is a Firecracker microVM.
        Ok(vec![IsolationTier::Vm])
    }

    fn egress_enforced(&self, _tier: EgressTier) -> bool {
        // `off` and `allowlist` are E2B's own network policy, applied outside
        // the VM; `on` needs nothing enforced.
        true
    }

    fn may_receive_registry_credentials(&self, registry: &str) -> bool {
        self.delegated.contains(&normalize_registry(registry))
    }

    async fn provision(&self, request: &ProvisionRequest) -> Result<String, SandboxSpawnError> {
        let plan = self.plan(request)?;
        let lock = self.build_lock(&plan.name);
        let template = {
            let _building = lock.lock().await;
            ensure_template(
                &self.api,
                &plan,
                self.tuning.poll_interval,
                Duration::from_secs(self.settings.template_build_timeout_secs),
            )
            .await
        };
        self.release_build_lock(&plan.name, lock);
        let template_id = template?;

        let lifetime = request.lifetime;
        let timeout_secs =
            (lifetime.as_secs() + u64::from(lifetime.subsec_nanos() > 0)).clamp(1, i32::MAX as u64);
        let mut metadata = request.labels.clone();
        metadata.insert(
            DEADLINE_KEY.to_string(),
            (unix_now() + timeout_secs).to_string(),
        );
        let body = sandbox_body(&template_id, timeout_secs, &metadata, request);
        let created = self
            .api
            .create_sandbox(&body)
            .await
            .map_err(|error| create_error(&error))?;
        let mut guard = KillOnDrop {
            api: Some(self.api.clone()),
            id: created.sandbox_id.clone(),
        };
        if let Err(error) = validate_sandbox_id(&created.sandbox_id) {
            return Err(SandboxSpawnError::fault(
                "sandbox_provider_unreachable",
                format!("E2B answered an unusable sandbox id: {error}"),
            ));
        }
        self.remember(&created);
        let id = created.sandbox_id.clone();
        match self.verify(&id).await {
            Ok(()) => {
                guard.disarm();
                log::info!(
                    "e2b: sandbox {id} of template {} is ready ({}s lifetime)",
                    plan.name,
                    timeout_secs
                );
                Ok(id)
            }
            Err(error) => {
                guard.disarm();
                self.forget(&id);
                if let Err(kill) = self.api.delete_sandbox(&id).await {
                    log::warn!("e2b: removing sandbox {id} after a failed provision: {kill}");
                }
                Err(error)
            }
        }
    }

    async fn release_supervisor(
        &self,
        instance: &str,
        request: &ProvisionRequest,
    ) -> Result<(), SandboxSpawnError> {
        let invalid =
            |message: String| SandboxSpawnError::refused("sandbox_request_invalid", message);
        let (cmd, args) = request
            .supervisor
            .split_first()
            .ok_or_else(|| invalid("the supervisor command is empty".into()))?;
        let envs = parse_env(&request.supervisor_env).map_err(invalid)?;
        let spec = StartSpec {
            cmd: cmd.clone(),
            args: args.to_vec(),
            envs,
            cwd: Some(WORKSPACE_ROOT.to_string()),
            stdin: false,
        };
        let (_, mut stream, pid) =
            self.start_process(instance, &spec)
                .await
                .map_err(|error| match error {
                    EnvdError::Rpc(rpc) => SandboxSpawnError::refused(
                        "sandbox_supervisor_failed",
                        format!("E2B could not start the supervisor in {instance}: {rpc}"),
                    ),
                    other => SandboxSpawnError::fault(
                        "sandbox_provider_unreachable",
                        format!("starting the supervisor in E2B sandbox {instance}: {other}"),
                    ),
                })?;
        // The supervisor is detached once started: envd keeps a process
        // whose Start stream is dropped. Watch it briefly for a crash on
        // start, which the health poll would otherwise only see as silence.
        let mut output = Vec::new();
        let watched = tokio::time::timeout(self.tuning.supervisor_grace, async {
            loop {
                match stream.next_event().await {
                    Ok(Some(ProcessEvent::Stderr(bytes)))
                    | Ok(Some(ProcessEvent::Stdout(bytes))) => extend_capped(&mut output, &bytes),
                    Ok(Some(ProcessEvent::End(end))) => return Some(end),
                    Ok(Some(_)) => {}
                    Ok(None) | Err(_) => return None,
                }
            }
        })
        .await;
        match watched {
            Ok(Some(end)) => Err(SandboxSpawnError::refused(
                "sandbox_supervisor_failed",
                format!(
                    "the supervisor in E2B sandbox {instance} exited as it started ({}): {}",
                    end.status,
                    String::from_utf8_lossy(&output).trim()
                ),
            )),
            Ok(None) => {
                // The stream broke, not necessarily the process; the
                // driver's health poll decides.
                log::warn!("e2b: lost the supervisor stream of {instance} (pid {pid}) while watching it start");
                Ok(())
            }
            Err(_) => {
                log::debug!("e2b: supervisor of {instance} is running as pid {pid}");
                Ok(())
            }
        }
    }
}

#[async_trait]
impl ContainerApi for E2bProvider {
    async fn run(&self, _spec: RunnerSpec) -> Result<RunningRunner, RunnerRunError> {
        Err(RunnerRunError::Other(
            "remote providers provision instances; they do not run containers".into(),
        ))
    }

    async fn pull_image(&self, _image: &str) -> Result<(), String> {
        Err("E2B pulls images while building templates".into())
    }

    async fn kill(&self, container_id: &str) -> Result<(), String> {
        self.remove(container_id).await
    }

    async fn remove(&self, container_id: &str) -> Result<(), String> {
        if validate_sandbox_id(container_id).is_err() {
            // Not an E2B id: no such sandbox exists to remove.
            return Ok(());
        }
        self.forget(container_id);
        self.api
            .delete_sandbox(container_id)
            .await
            .map(|_| ())
            .map_err(|error| format!("removing E2B sandbox {container_id}: {error}"))
    }

    async fn labels(&self, container_id: &str) -> Result<Option<BTreeMap<String, String>>, String> {
        if validate_sandbox_id(container_id).is_err() {
            return Ok(None);
        }
        let info = self
            .api
            .get_sandbox(container_id)
            .await
            .map_err(|error| format!("reading E2B sandbox {container_id}: {error}"))?;
        Ok(info.map(|info| decode_labels(info.metadata)))
    }

    async fn list_owned(&self) -> Result<Vec<OwnedContainer>, String> {
        let sandboxes = self
            .api
            .list_sandboxes(&self.owner_filter())
            .await
            .map_err(|error| format!("listing E2B sandboxes: {error}"))?;
        Ok(sandboxes
            .into_iter()
            .map(|sandbox: SandboxInfo| OwnedContainer {
                id: sandbox.sandbox_id,
                labels: decode_labels(sandbox.metadata),
            })
            .filter(|owned| is_owned(&owned.labels))
            .collect())
    }
}

#[async_trait]
impl SandboxDockerApi for E2bProvider {
    async fn inspect_runtime(&self, id: &str) -> Result<Option<RuntimeContainerState>, String> {
        if validate_sandbox_id(id).is_err() {
            return Ok(None);
        }
        let info = self
            .api
            .get_sandbox(id)
            .await
            .map_err(|error| format!("reading E2B sandbox {id}: {error}"))?;
        Ok(info.map(|info| RuntimeContainerState {
            running: info.state == "running",
            labels: decode_labels(info.metadata),
            network_mode: None,
            network_attachments: Default::default(),
        }))
    }

    async fn start_runtime(&self, id: &str) -> Result<(), String> {
        validate_sandbox_id(id)?;
        let info = self
            .api
            .get_sandbox(id)
            .await
            .map_err(|error| format!("reading E2B sandbox {id}: {error}"))?
            .ok_or_else(|| format!("E2B sandbox {id} does not exist"))?;
        if info.state == "running" {
            return Ok(());
        }
        let left = match remaining_secs(info.metadata.as_ref()) {
            Ok(left) => left,
            Err(Remaining::Unknown) => {
                return Err(format!(
                    "E2B sandbox {id} has no recorded lifetime; it is not resumed"
                ))
            }
            Err(Remaining::Elapsed) => {
                self.forget(id);
                if let Err(error) = self.api.delete_sandbox(id).await {
                    log::warn!("e2b: removing expired sandbox {id}: {error}");
                }
                return Err(format!(
                    "E2B sandbox {id} is past its lifetime and was removed"
                ));
            }
        };
        let resumed = self
            .api
            .connect_sandbox(id, left)
            .await
            .map_err(|error| format!("resuming E2B sandbox {id}: {error}"))?
            .ok_or_else(|| format!("E2B sandbox {id} does not exist"))?;
        self.remember(&resumed);
        Ok(())
    }

    async fn stop_runtime(&self, id: &str) -> Result<(), String> {
        validate_sandbox_id(id)?;
        match self
            .api
            .pause_sandbox(id)
            .await
            .map_err(|error| format!("pausing E2B sandbox {id}: {error}"))?
        {
            PauseOutcome::Paused => Ok(()),
            PauseOutcome::Gone => Err(format!("E2B sandbox {id} does not exist")),
            PauseOutcome::Conflict => {
                let state = self
                    .api
                    .get_sandbox(id)
                    .await
                    .map_err(|error| format!("reading E2B sandbox {id}: {error}"))?
                    .map(|info| info.state);
                match state.as_deref() {
                    Some("paused") => Ok(()),
                    Some(other) => Err(format!(
                        "E2B refused to pause sandbox {id}, which is {other}"
                    )),
                    None => Err(format!("E2B sandbox {id} does not exist")),
                }
            }
        }
    }

    async fn exec_runtime(&self, spec: RunnerExecSpec) -> Result<RunningRunner, String> {
        let id = spec.container_id.clone();
        let (cmd, args) = spec
            .command
            .split_first()
            .ok_or_else(|| "an exec needs a command".to_string())?;
        let start = StartSpec {
            cmd: cmd.clone(),
            args: args.to_vec(),
            envs: {
                let mut env = parse_env(&spec.env)?;
                env.extend(spec.workspace_env.clone());
                env
            },
            cwd: (!spec.working_dir.is_empty()).then(|| spec.working_dir.clone()),
            stdin: true,
        };
        let (endpoint, stream, pid) = self
            .start_process(&id, &start)
            .await
            .map_err(|error| format!("exec in E2B sandbox {id}: {error}"))?;
        let input = ProcessInput::new(endpoint, pid)
            .map_err(|error| format!("exec in E2B sandbox {id}: {error}"))?;
        let (event_tx, event_rx) = mpsc::channel(EVENT_QUEUE);
        let (stdin_tx, stdin_rx) = mpsc::channel(STDIN_QUEUE);
        let (ended_tx, ended_rx) = watch::channel(false);
        tokio::spawn(forward_events(stream, event_tx, ended_tx));
        tokio::spawn(pump_stdin(input, pid, stdin_rx, ended_rx));
        Ok(RunningRunner {
            container_id: id,
            events: event_rx.into(),
            stdin: stdin_tx.into(),
        })
    }

    async fn runtimes(&self) -> Result<Vec<String>, String> {
        // The tier is the VM itself; there are no runtimes to choose.
        Ok(Vec::new())
    }

    async fn ensure_volume(
        &self,
        name: &str,
        _labels: &BTreeMap<String, String>,
    ) -> Result<(), String> {
        Err(format!(
            "E2B has no named volumes ({name}); the bundle is part of the template"
        ))
    }

    async fn list_owned_volumes(&self) -> Result<Vec<OwnedVolume>, String> {
        Ok(Vec::new())
    }

    async fn remove_volume(&self, _name: &str) -> Result<VolumeRemoval, String> {
        Ok(VolumeRemoval::Gone)
    }

    async fn pull_image_with_auth(
        &self,
        _image: &str,
        _auth: Option<RegistryAuth>,
    ) -> Result<(), String> {
        Err("E2B pulls images while building templates".into())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use cognia_environment::catalog::SizeClass;
    use cognia_environment::image::PinnedImage;
    use cognia_external_agent::container_backend::{ownership_labels, AGENT_ID_LABEL};
    use cognia_external_agent::sandbox_routing_backend::SandboxErrorKind;

    use super::test_server::{FakeE2b, FakeRegistry, ProcessScript, ScriptFrame, TarEntry};
    use super::*;
    use crate::remote::EgressPlan;

    const DEPLOYMENT: &str = "dep-1";

    fn settings_for(fake: &FakeE2b) -> E2bSettings {
        E2bSettings {
            api_url: fake.base.to_string(),
            delegated_registries: vec!["GHCR.io".into(), "index.docker.io".into()],
            template_build_timeout_secs: 60,
            ..E2bSettings::default()
        }
    }

    fn tuning() -> Tuning {
        Tuning {
            poll_interval: Duration::from_millis(5),
            supervisor_grace: Duration::from_millis(300),
            start_timeout: Duration::from_secs(10),
            verify_timeout: Duration::from_secs(10),
            bundle_registry_insecure: true,
        }
    }

    /// A provider pointed at `fake`, envd included, recording the domains
    /// envd addresses are derived from.
    fn provider(fake: &FakeE2b) -> (E2bProvider, Arc<parking_lot::Mutex<Vec<String>>>) {
        let domains = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let seen = domains.clone();
        let base = fake.base.clone();
        let provider = E2bProvider::build(
            settings_for(fake),
            FakeE2b::API_KEY.into(),
            DEPLOYMENT,
            tuning(),
            Arc::new(move |_, domain| {
                seen.lock().push(domain.to_string());
                Ok(base.clone())
            }),
        )
        .unwrap();
        (provider, domains)
    }

    fn size() -> SizeClass {
        SizeClass {
            id: "small".into(),
            label: "Small".into(),
            cpu_millis: 1500,
            memory_mib: 2048,
            ephemeral_storage_mib: 10_240,
            volume_mib: 10_240,
            gpu: None,
        }
    }

    fn request(bundle: &PinnedImage, tier: EgressTier) -> ProvisionRequest {
        let mut labels = ownership_labels("agent-1", "instance-1", DEPLOYMENT);
        labels.insert("cognia.runtime-key".into(), "k".repeat(64));
        ProvisionRequest {
            name: "cognia-e2b-abc".into(),
            labels,
            image: PinnedImage {
                registry: "docker.io".into(),
                repository: "library/node".into(),
                digest: format!("sha256:{}", "a".repeat(64)),
            },
            registry_auth: None,
            bundle: bundle.clone(),
            bundle_registry_auth: Some(RegistryAuth {
                server_address: bundle.registry.clone(),
                username: Some(FakeRegistry::USER.into()),
                password: Some(FakeRegistry::PASSWORD.into()),
                ..RegistryAuth::default()
            }),
            bundle_release_tag: "v1.2.3".into(),
            tier: IsolationTier::Vm,
            size: size(),
            egress: EgressPlan {
                tier,
                domains: if tier == EgressTier::Allowlist {
                    vec!["registry.npmjs.org".into(), "*.github.com".into()]
                } else {
                    Vec::new()
                },
            },
            lifetime: Duration::from_secs(7200),
            supervisor: vec![
                "/cognia/bin/cognia-sandboxd".into(),
                "serve".into(),
                "--socket".into(),
                "/tmp/cognia-sandboxd/control.sock".into(),
            ],
            supervisor_env: vec!["COGNIA_SANDBOXD_BOOT=e30".into()],
        }
    }

    async fn bundle_registry() -> FakeRegistry {
        FakeRegistry::start_bundle(&[TarEntry::file(
            "opt/cognia/bin/cognia-sandboxd",
            b"#!sandboxd",
            0o755,
        )])
        .await
    }

    #[test]
    fn settings_default_and_round_trip_camel_case() {
        let parsed: E2bSettings = serde_json::from_value(json!({})).unwrap();
        assert_eq!(parsed, E2bSettings::default());
        assert_eq!(parsed.api_url, "https://api.e2b.app");
        assert_eq!(parsed.domain, "e2b.app");
        assert_eq!(parsed.template_prefix, "cognia");
        assert_eq!(parsed.template_build_timeout_secs, 1800);
        assert!(E2bProvider::validate(&parsed).is_ok());

        let full = json!({
            "apiUrl": "https://api.example.com/e2b",
            "domain": "sandbox.example.com",
            "delegatedRegistries": ["ghcr.io", "registry.example.com:5000"],
            "templatePrefix": "team_a",
            "templateBuildTimeoutSecs": 600,
        });
        let parsed: E2bSettings = serde_json::from_value(full.clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), full);
        assert!(E2bProvider::validate(&parsed).is_ok());
        assert!(serde_json::from_value::<E2bSettings>(json!({ "apiKey": "x" })).is_err());
    }

    #[test]
    fn settings_validation_refuses_what_cannot_work() {
        let ok = E2bSettings::default();
        let with = |change: &dyn Fn(&mut E2bSettings)| {
            let mut settings = ok.clone();
            change(&mut settings);
            E2bProvider::validate(&settings)
        };
        assert!(with(&|s| s.api_url = "http://api.e2b.app".into()).is_err());
        assert!(with(&|s| s.api_url = "http://127.0.0.1:3000".into()).is_ok());
        assert!(with(&|s| s.api_url = "http://localhost:3000/".into()).is_ok());
        assert!(with(&|s| s.api_url = "https://user:pw@api.e2b.app".into()).is_err());
        assert!(with(&|s| s.api_url = "https://api.e2b.app/?x=1".into()).is_err());
        assert!(with(&|s| s.api_url = "ftp://api.e2b.app".into()).is_err());
        assert!(with(&|s| s.api_url = "not a url".into()).is_err());
        assert!(with(&|s| s.domain = "e2b".into()).is_err());
        assert!(with(&|s| s.domain = "e2b.app/x".into()).is_err());
        assert!(with(&|s| s.domain = "1.2.3.4".into()).is_err());
        assert!(with(&|s| s.domain = " e2b.app".into()).is_err());
        assert!(with(&|s| s.delegated_registries = vec!["ghcr.io/x".into()]).is_err());
        assert!(with(&|s| s.delegated_registries = vec!["ghcr".into()]).is_err());
        assert!(with(&|s| s.delegated_registries = vec!["localhost:5000".into()]).is_ok());
        assert!(with(&|s| s.template_prefix = String::new()).is_err());
        assert!(with(&|s| s.template_prefix = "Cognia".into()).is_err());
        assert!(with(&|s| s.template_prefix = "-x".into()).is_err());
        assert!(with(&|s| s.template_prefix = "x".repeat(33)).is_err());
        assert!(with(&|s| s.template_build_timeout_secs = 59).is_err());
        assert!(with(&|s| s.template_build_timeout_secs = 7201).is_err());
        assert!(with(&|s| s.template_build_timeout_secs = 7200).is_ok());
    }

    #[test]
    fn construction_checks_the_key_and_deployment_and_never_shows_the_key() {
        let settings = E2bSettings::default();
        assert!(E2bProvider::new(settings.clone(), "  ".into(), DEPLOYMENT).is_err());
        assert!(E2bProvider::new(settings.clone(), "bad key".into(), DEPLOYMENT).is_err());
        assert!(E2bProvider::new(settings.clone(), "e2b_ok".into(), "bad id!").is_err());
        let provider = E2bProvider::new(settings, "e2b_secret_key".into(), DEPLOYMENT).unwrap();
        assert_eq!(provider.kind(), "e2b");
        let debug = format!("{provider:?}");
        assert!(!debug.contains("e2b_secret_key"), "{debug}");
        assert!(provider.egress_enforced(EgressTier::Off));
        assert!(provider.egress_enforced(EgressTier::Allowlist));
        assert!(provider.egress_enforced(EgressTier::On));
    }

    #[tokio::test]
    async fn only_delegated_registries_receive_credentials() {
        let fake = FakeE2b::start().await;
        let (provider, _) = provider(&fake);
        assert!(provider.may_receive_registry_credentials("ghcr.io"));
        assert!(provider.may_receive_registry_credentials("GHCR.IO"));
        assert!(
            provider.may_receive_registry_credentials("docker.io"),
            "hub aliases match"
        );
        assert!(!provider.may_receive_registry_credentials("quay.io"));
        assert!(!provider.may_receive_registry_credentials("ghcr.io.evil.com"));
    }

    #[test]
    fn env_lines_parse_without_echoing_values() {
        let envs = parse_env(&["A=1".into(), "B=x=y".into(), "A=2".into(), "E=".into()]).unwrap();
        assert_eq!(
            envs,
            BTreeMap::from([
                ("A".into(), "2".into()),
                ("B".into(), "x=y".into()),
                ("E".into(), String::new()),
            ])
        );
        let error = parse_env(&["SECRET_WITHOUT_EQUALS".into()]).unwrap_err();
        assert!(error.contains("SECRET_WITHOUT_EQUALS"));
        assert!(parse_env(&["=value".into()]).is_err());
        assert!(validate_sandbox_id("abc123").is_ok());
        assert!(validate_sandbox_id("ABC").is_err());
        assert!(validate_sandbox_id("a/b").is_err());
        assert!(validate_sandbox_id("").is_err());
    }

    #[test]
    fn deadlines_bound_resumes() {
        let future = BTreeMap::from([(DEADLINE_KEY.to_string(), (unix_now() + 100).to_string())]);
        let left = remaining_secs(Some(&future)).unwrap();
        assert!((99..=100).contains(&left), "{left}");
        let past = BTreeMap::from([(DEADLINE_KEY.to_string(), (unix_now() - 1).to_string())]);
        assert_eq!(remaining_secs(Some(&past)), Err(Remaining::Elapsed));
        assert_eq!(remaining_secs(None), Err(Remaining::Unknown));
        let labels = decode_labels(Some(future.clone()));
        assert!(
            labels.is_empty(),
            "the deadline is the provider's, not a label"
        );
    }

    #[tokio::test]
    async fn tiers_need_a_working_authenticated_api() {
        let fake = FakeE2b::start().await;
        let (provider, _) = provider(&fake);
        assert_eq!(provider.tiers().await.unwrap(), vec![IsolationTier::Vm]);
        let probe = fake.last_request("/v2/sandboxes");
        assert_eq!(probe.header("x-api-key"), Some(FakeE2b::API_KEY));
        assert!(probe.query.as_deref().unwrap().contains("limit=1"));

        fake.fail_next("/v2/sandboxes", 401, "Invalid API key");
        let error = provider.tiers().await.unwrap_err();
        assert_eq!(error.code, "sandbox_provider_unauthorized");
        assert_eq!(error.kind, SandboxErrorKind::Refused);

        fake.fail_next("/v2/sandboxes", 503, "maintenance");
        let error = provider.tiers().await.unwrap_err();
        assert_eq!(error.code, "sandbox_provider_unreachable");
        assert_eq!(error.kind, SandboxErrorKind::Fault);

        let base = fake.base.clone();
        drop(fake);
        let offline = E2bProvider::build(
            E2bSettings {
                api_url: base.to_string(),
                ..E2bSettings::default()
            },
            FakeE2b::API_KEY.into(),
            DEPLOYMENT,
            tuning(),
            Arc::new(envd::default_envd_base),
        )
        .unwrap();
        let error = offline.tiers().await.unwrap_err();
        assert_eq!(error.code, "sandbox_provider_unreachable");
        assert_eq!(error.kind, SandboxErrorKind::Fault);
    }

    #[tokio::test]
    async fn provisioning_builds_the_template_and_creates_a_labelled_sandbox() {
        let fake = FakeE2b::start().await;
        let registry = bundle_registry().await;
        let (provider, domains) = provider(&fake);
        let request = request(&registry.image, EgressTier::Allowlist);
        let id = provider.provision(&request).await.unwrap();

        let template_name =
            template::template_name("cognia", &request.image, &request.bundle, &request.size);
        let template_id = fake.template_id(&template_name).unwrap();
        let create = fake
            .requests()
            .into_iter()
            .find(|r| r.method == "POST" && r.path == "/v2/sandboxes")
            .unwrap()
            .json();
        assert_eq!(create["templateID"], template_id);
        assert_eq!(create["timeout"], 7200);
        assert_eq!(create["autoPause"], false);
        assert_eq!(create["allow_internet_access"], true);
        assert_eq!(
            create["network"],
            json!({ "allowOut": ["registry.npmjs.org", "*.github.com"], "denyOut": ["0.0.0.0/0"] })
        );
        let deadline: u64 = create["metadata"][DEADLINE_KEY]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        assert!(deadline >= unix_now() + 7190);
        assert_eq!(
            fake.requests_to("/v3/templates")[0].json(),
            json!({ "name": template_name, "cpuCount": 2, "memoryMB": 2048 })
        );
        assert!(
            registry.served_with_auth(),
            "the bundle was pulled with its credentials"
        );

        // The labels come back verbatim, the deadline stripped.
        assert_eq!(
            provider.labels(&id).await.unwrap(),
            Some(request.labels.clone())
        );
        let stored = fake.sandbox_metadata(&id).unwrap();
        assert!(stored.contains_key(DEADLINE_KEY));

        // Exec works, as root, against the domain the create answered.
        let verify = fake.last_request("/process.Process/Start");
        assert_eq!(verify.header("authorization"), Some("Basic cm9vdDo="));
        assert_eq!(
            verify.header("x-access-token"),
            Some(fake.token(&id).as_str())
        );
        let body = verify.envelope_json();
        assert_eq!(body["process"]["cmd"], "/bin/sh");
        assert_eq!(body["process"]["args"][1], verify_script());
        assert_eq!(body["stdin"], false);
        assert_eq!(domains.lock().as_slice(), &["fake.e2b.test".to_string()]);
    }

    #[tokio::test]
    async fn without_a_domain_in_the_create_answer_the_settings_domain_is_used() {
        let fake = FakeE2b::start().await;
        let registry = bundle_registry().await;
        fake.set_create_domain(None);
        let (provider, domains) = provider(&fake);
        provider
            .provision(&request(&registry.image, EgressTier::On))
            .await
            .unwrap();
        assert_eq!(domains.lock().as_slice(), &["e2b.app".to_string()]);
    }

    #[tokio::test]
    async fn a_name_another_team_owns_is_built_in_this_teams_namespace() {
        let fake = FakeE2b::start().await;
        let registry = bundle_registry().await;
        let request = request(&registry.image, EgressTier::On);
        let name =
            template::template_name("cognia", &request.image, &request.bundle, &request.size);
        fake.add_foreign_alias(&name);
        let (provider, _) = provider(&fake);
        provider.provision(&request).await.unwrap();
        assert_eq!(fake.requests_to("/v3/templates").len(), 1);
    }

    #[tokio::test]
    async fn egress_tiers_map_to_e2b_network_settings() {
        let fake = FakeE2b::start().await;
        let registry = bundle_registry().await;
        let (provider, _) = provider(&fake);
        for (tier, internet) in [(EgressTier::Off, false), (EgressTier::On, true)] {
            provider
                .provision(&request(&registry.image, tier))
                .await
                .unwrap();
            let create = fake
                .requests()
                .into_iter()
                .rev()
                .find(|r| r.method == "POST" && r.path == "/v2/sandboxes")
                .unwrap()
                .json();
            assert_eq!(create["allow_internet_access"], internet, "{tier:?}");
            assert!(create.get("network").is_none(), "{tier:?}");
        }
    }

    #[tokio::test]
    async fn concurrent_provisions_share_one_template_build() {
        let fake = FakeE2b::start().await;
        let registry = bundle_registry().await;
        fake.script_build_statuses(&["building", "building", "ready"]);
        let (provider, _) = provider(&fake);
        let first = request(&registry.image, EgressTier::On);
        let second = first.clone();
        let (a, b) = tokio::join!(provider.provision(&first), provider.provision(&second));
        assert_ne!(a.unwrap(), b.unwrap());
        assert_eq!(fake.requests_to("/v3/templates").len(), 1);
        assert!(
            provider.build_locks.lock().is_empty(),
            "lock entries are pruned"
        );
    }

    #[tokio::test]
    async fn a_sandbox_that_cannot_run_the_bundle_is_removed() {
        let fake = FakeE2b::start().await;
        let registry = bundle_registry().await;
        fake.script(
            "/bin/sh",
            ProcessScript::Fixed {
                frames: vec![
                    ScriptFrame::Stderr(b"test: /cognia/bin/cognia-sandboxd: not found".to_vec()),
                    ScriptFrame::End {
                        code: 1,
                        status: "exit status 1".into(),
                    },
                ],
                chunk: 7,
            },
        );
        let (provider, _) = provider(&fake);
        let error = provider
            .provision(&request(&registry.image, EgressTier::On))
            .await
            .unwrap_err();
        assert_eq!(error.code, "sandbox_template_invalid");
        assert_eq!(error.kind, SandboxErrorKind::Refused);
        assert!(error.message.contains("not found"), "{}", error.message);
        assert!(
            fake.sandbox_ids().is_empty(),
            "the failed sandbox was killed"
        );
    }

    #[tokio::test]
    async fn create_failures_map_to_their_outcomes() {
        let fake = FakeE2b::start().await;
        let registry = bundle_registry().await;
        let (provider, _) = provider(&fake);
        let request = request(&registry.image, EgressTier::On);
        // Build the template first so only creation is under test.
        provider.provision(&request).await.unwrap();

        for (status, message, code, refused) in [
            (
                400,
                "Timeout cannot be greater than 1 hours",
                "sandbox_lifetime_exceeds_plan",
                true,
            ),
            (
                429,
                "You have reached the maximum number of concurrent E2B sandboxes",
                "sandbox_provider_capacity",
                false,
            ),
            (
                401,
                "Invalid API key",
                "sandbox_provider_unauthorized",
                true,
            ),
            (500, "internal", "sandbox_provider_unreachable", false),
        ] {
            // The template lookup comes first; fail creation only.
            let created_before = fake.requests_to("/v2/sandboxes").len();
            fake.fail_next("/v2/sandboxes", status, message);
            let error = provider.provision(&request).await.unwrap_err();
            assert_eq!(error.code, code, "{status}");
            assert_eq!(error.kind == SandboxErrorKind::Refused, refused, "{status}");
            assert_eq!(fake.requests_to("/v2/sandboxes").len(), created_before + 1);
        }

        let mut token_auth = request.clone();
        token_auth.registry_auth = Some(RegistryAuth {
            server_address: "docker.io".into(),
            identity_token: Some("refresh".into()),
            ..RegistryAuth::default()
        });
        let error = provider.provision(&token_auth).await.unwrap_err();
        assert_eq!(error.code, "sandbox_registry_auth_unsupported");

        let mut reserved = request.clone();
        reserved.labels.insert(DEADLINE_KEY.into(), "1".into());
        let error = provider.provision(&reserved).await.unwrap_err();
        assert_eq!(error.code, "sandbox_request_invalid");
    }

    #[tokio::test]
    async fn delegated_credentials_reach_the_template_build() {
        let fake = FakeE2b::start().await;
        let registry = bundle_registry().await;
        let (provider, _) = provider(&fake);
        let mut private = request(&registry.image, EgressTier::On);
        private.image.registry = "ghcr.io".into();
        private.image.repository = "acme/app".into();
        private.registry_auth = Some(RegistryAuth {
            server_address: "ghcr.io".into(),
            username: Some("acme-bot".into()),
            password: Some("pull-secret".into()),
            ..RegistryAuth::default()
        });
        provider.provision(&private).await.unwrap();
        let start = fake
            .requests()
            .into_iter()
            .find(|r| r.method == "POST" && r.path.starts_with("/v2/templates/"))
            .unwrap()
            .json();
        assert_eq!(start["fromImage"], private.image.canonical());
        assert_eq!(
            start["fromImageRegistry"],
            json!({ "type": "registry", "username": "acme-bot", "password": "pull-secret" })
        );
    }

    async fn collect(mut running: RunningRunner) -> (Vec<u8>, Vec<u8>, Option<i64>, Vec<String>) {
        let (mut stdout, mut stderr, mut order) = (Vec::new(), Vec::new(), Vec::new());
        while let Some(event) = running.events.recv().await {
            match event {
                RunnerEvent::Stdout(bytes) => {
                    order.push(format!("out:{}", String::from_utf8_lossy(&bytes)));
                    stdout.extend(bytes);
                }
                RunnerEvent::Stderr(bytes) => {
                    order.push(format!("err:{}", String::from_utf8_lossy(&bytes)));
                    stderr.extend(bytes);
                }
                RunnerEvent::Exited { code } => return (stdout, stderr, code, order),
            }
        }
        panic!("the events ended without an exit");
    }

    #[tokio::test]
    async fn exec_streams_output_in_order_and_maps_the_exit() {
        let fake = FakeE2b::start().await;
        let id = fake.add_sandbox("running", BTreeMap::new());
        fake.script(
            "/cognia/bin/cognia-sandboxd",
            ProcessScript::Fixed {
                frames: vec![
                    ScriptFrame::Stdout(b"one".to_vec()),
                    ScriptFrame::Keepalive,
                    ScriptFrame::Stderr(b"two".to_vec()),
                    ScriptFrame::Stdout(vec![0, 159, 146, 150]),
                    ScriptFrame::End {
                        code: -1,
                        status: "signal: killed".into(),
                    },
                ],
                chunk: 1,
            },
        );
        let (provider, domains) = provider(&fake);
        let running = provider
            .exec_runtime(RunnerExecSpec {
                workspace_env: BTreeMap::from([
                    ("PORT".into(), "41000".into()),
                    ("COGNIA_PORT".into(), "41000".into()),
                    ("COGNIA_PORT_COUNT".into(), "10".into()),
                ]),
                container_id: id.clone(),
                command: vec!["/cognia/bin/cognia-sandboxd".into(), "health".into()],
                env: vec!["A=1".into(), "PORT=9999".into()],
                working_dir: "/".into(),
            })
            .await
            .unwrap();
        assert_eq!(running.container_id, id);
        let (stdout, stderr, code, order) = collect(running).await;
        assert_eq!(stdout, [b"one".as_slice(), &[0, 159, 146, 150]].concat());
        assert_eq!(stderr, b"two");
        assert_eq!(code, Some(137));
        assert_eq!(order[..2], ["out:one".to_string(), "err:two".to_string()]);
        let start = fake.last_request("/process.Process/Start").envelope_json();
        assert_eq!(
            start,
            json!({
                "process": {
                    "cmd": "/cognia/bin/cognia-sandboxd",
                    "args": ["health"],
                    "envs": { "A": "1", "PORT": "41000", "COGNIA_PORT": "41000", "COGNIA_PORT_COUNT": "10" },
                    "cwd": "/",
                },
                "stdin": true,
            })
        );
        assert_eq!(
            domains.lock().as_slice(),
            &["detail.e2b.test".to_string()],
            "an adopted sandbox's connection comes from its detail"
        );
    }

    #[tokio::test]
    async fn real_provider_frontend_leases_reach_e2b_exec_unchanged() {
        for kind in ["project-root", "desktop-session"] {
            let (cwd, expected) = crate::docker::tests::real_workspace_env_fixture(kind);
            let workspace_env = cognia_core::workspace_env::resolve_workspace_env_async(
                cognia_core::workspace_env::WorkspaceEnvQuery {
                    cwd: cwd.path().to_path_buf(),
                    workspace_id: None,
                    namespace: cognia_core::workspace_env::HOST_LOOPBACK_NAMESPACE.into(),
                },
            )
            .await
            .unwrap()
            .unwrap();
            let fake = FakeE2b::start().await;
            let id = fake.add_sandbox("running", BTreeMap::new());
            fake.script(
                "env",
                ProcessScript::Fixed {
                    frames: vec![ScriptFrame::End {
                        code: 0,
                        status: "".into(),
                    }],
                    chunk: 1,
                },
            );
            let (provider, _) = provider(&fake);
            let running = provider
                .exec_runtime(RunnerExecSpec {
                    container_id: id,
                    command: vec!["env".into()],
                    env: vec!["PORT=9999".into()],
                    workspace_env,
                    working_dir: "/workspace".into(),
                })
                .await
                .unwrap();
            collect(running).await;
            let start = fake.last_request("/process.Process/Start").envelope_json();
            for (key, value) in expected {
                assert_eq!(start["process"]["envs"][key], value);
            }
        }
    }

    #[tokio::test]
    async fn stdin_is_written_in_order_and_closed_when_dropped() {
        let fake = FakeE2b::start().await;
        let id = fake.add_sandbox("running", BTreeMap::new());
        fake.script("/cognia/bin/cognia-sandboxd", ProcessScript::Echo);
        let (provider, _) = provider(&fake);
        let running = provider
            .exec_runtime(RunnerExecSpec {
                workspace_env: BTreeMap::new(),
                container_id: id.clone(),
                command: vec![
                    "/cognia/bin/cognia-sandboxd".into(),
                    "bridge-service".into(),
                ],
                env: Vec::new(),
                working_dir: String::new(),
            })
            .await
            .unwrap();
        let RunningRunner { events, stdin, .. } = running;
        for chunk in [
            b"alpha".to_vec(),
            Vec::new(),
            b"beta".to_vec(),
            vec![0, 1, 2, 255],
        ] {
            stdin.send(chunk).await.unwrap();
        }
        drop(stdin);
        let (stdout, _, code, _) = collect(RunningRunner {
            container_id: id,
            events,
            stdin: mpsc::channel(1).0.into(),
        })
        .await;
        assert_eq!(stdout, [b"alphabeta".as_slice(), &[0, 1, 2, 255]].concat());
        assert_eq!(code, Some(0));
        let inputs = fake.requests_to("/process.Process/SendInput");
        assert_eq!(inputs.len(), 3, "empty chunks are not sent");
        assert!(fake.requests_to("/process.Process/CloseStdin").len() == 1);
        let start = fake.last_request("/process.Process/Start").envelope_json();
        assert!(
            start["process"].get("cwd").is_none(),
            "no working dir: envd's default"
        );
    }

    #[tokio::test]
    async fn a_stream_without_an_end_is_an_unknown_exit() {
        let fake = FakeE2b::start().await;
        let id = fake.add_sandbox("running", BTreeMap::new());
        fake.script(
            "/x",
            ProcessScript::Fixed {
                frames: vec![ScriptFrame::Stdout(b"partial".to_vec()), ScriptFrame::Cut],
                chunk: 4096,
            },
        );
        let (provider, _) = provider(&fake);
        let running = provider
            .exec_runtime(RunnerExecSpec {
                workspace_env: BTreeMap::new(),
                container_id: id,
                command: vec!["/x".into()],
                env: Vec::new(),
                working_dir: "/".into(),
            })
            .await
            .unwrap();
        let (stdout, _, code, _) = collect(running).await;
        assert_eq!(stdout, b"partial");
        assert_eq!(code, None);
    }

    #[tokio::test]
    async fn exec_errors_are_reported_before_any_stream() {
        let fake = FakeE2b::start().await;
        let (provider, _) = provider(&fake);
        let spec = |id: &str, command: Vec<String>| RunnerExecSpec {
            workspace_env: BTreeMap::new(),
            container_id: id.into(),
            command,
            env: Vec::new(),
            working_dir: "/".into(),
        };
        let error = provider
            .exec_runtime(spec("nosuch", vec!["true".into()]))
            .await
            .err()
            .unwrap();
        assert!(error.contains("does not exist"), "{error}");
        assert!(provider
            .exec_runtime(spec("Bad/Id", vec!["true".into()]))
            .await
            .is_err());
        let id = fake.add_sandbox("running", BTreeMap::new());
        assert!(provider.exec_runtime(spec(&id, Vec::new())).await.is_err());
        fake.script(
            "/nope",
            ProcessScript::Fixed {
                frames: vec![ScriptFrame::EndStreamError {
                    code: "invalid_argument".into(),
                    message: "cwd '/missing' does not exist".into(),
                }],
                chunk: 4096,
            },
        );
        let error = provider
            .exec_runtime(spec(&id, vec!["/nope".into()]))
            .await
            .err()
            .unwrap();
        assert!(error.contains("cwd '/missing' does not exist"), "{error}");
        let paused = fake.add_sandbox("paused", BTreeMap::new());
        let error = provider
            .exec_runtime(spec(&paused, vec!["true".into()]))
            .await
            .err()
            .unwrap();
        assert!(error.contains("paused"), "{error}");
    }

    #[tokio::test]
    async fn the_supervisor_is_started_detached_without_stdin() {
        let fake = FakeE2b::start().await;
        let registry = bundle_registry().await;
        let (provider, _) = provider(&fake);
        let request = request(&registry.image, EgressTier::On);
        let id = provider.provision(&request).await.unwrap();
        fake.script("/cognia/bin/cognia-sandboxd", ProcessScript::Linger);
        let started = Instant::now();
        provider.release_supervisor(&id, &request).await.unwrap();
        assert!(started.elapsed() < Duration::from_secs(5));
        let pids: Vec<u32> = fake
            .requests_to("/process.Process/Start")
            .len()
            .checked_sub(1)
            .map(|_| fake.live_pids())
            .unwrap_or_default();
        assert_eq!(pids.len(), 1, "the supervisor is still running: {pids:?}");
        assert!(fake.is_live(pids[0]));
        let start = fake.last_request("/process.Process/Start").envelope_json();
        assert_eq!(
            start,
            json!({
                "process": {
                    "cmd": "/cognia/bin/cognia-sandboxd",
                    "args": ["serve", "--socket", "/tmp/cognia-sandboxd/control.sock"],
                    "envs": { "COGNIA_SANDBOXD_BOOT": "e30" },
                    "cwd": "/workspace",
                },
                "stdin": false,
            })
        );

        fake.script(
            "/cognia/bin/cognia-sandboxd",
            ProcessScript::Fixed {
                frames: vec![
                    ScriptFrame::Stderr(b"postCreateCommand failed".to_vec()),
                    ScriptFrame::End {
                        code: 70,
                        status: "exit status 70".into(),
                    },
                ],
                chunk: 4096,
            },
        );
        let error = provider
            .release_supervisor(&id, &request)
            .await
            .unwrap_err();
        assert_eq!(error.code, "sandbox_supervisor_failed");
        assert!(
            error.message.contains("postCreateCommand failed"),
            "{}",
            error.message
        );

        let mut empty = request.clone();
        empty.supervisor.clear();
        let error = provider.release_supervisor(&id, &empty).await.unwrap_err();
        assert_eq!(error.code, "sandbox_request_invalid");
    }

    #[tokio::test]
    async fn ownership_listing_inspection_and_removal() {
        let fake = FakeE2b::start().await;
        fake.set_page_size(2);
        let (provider, _) = provider(&fake);
        let mine = |agent: &str| {
            let mut labels = ownership_labels(agent, "instance-1", DEPLOYMENT);
            labels.insert(DEADLINE_KEY.into(), (unix_now() + 600).to_string());
            labels
        };
        let ids: Vec<String> = (0..3)
            .map(|n| fake.add_sandbox("running", mine(&format!("agent-{n}"))))
            .collect();
        fake.add_sandbox(
            "running",
            ownership_labels("other", "i", "another-deployment"),
        );
        let mut forged = ownership_labels("forged", "i", DEPLOYMENT);
        forged.insert(OWNER_LABEL.into(), "someone-else".into());
        fake.add_sandbox("running", forged);

        let owned = provider.list_owned().await.unwrap();
        assert_eq!(
            owned.iter().map(|o| o.id.clone()).collect::<Vec<_>>(),
            ids,
            "this deployment's sandboxes, across pages"
        );
        assert!(owned.iter().all(|o| !o.labels.contains_key(DEADLINE_KEY)));
        assert_eq!(owned[1].labels[AGENT_ID_LABEL], "agent-1");
        let listing = fake.requests_to("/v2/sandboxes");
        assert_eq!(listing.len(), 2);

        let state = provider.inspect_runtime(&ids[0]).await.unwrap().unwrap();
        assert!(state.running);
        assert_eq!(state.labels[AGENT_ID_LABEL], "agent-0");
        assert!(provider.inspect_runtime("gone").await.unwrap().is_none());
        assert!(provider.labels("gone").await.unwrap().is_none());
        assert!(provider.labels("Not An Id").await.unwrap().is_none());

        provider.kill(&ids[0]).await.unwrap();
        provider.remove(&ids[0]).await.unwrap();
        provider.remove("Not An Id").await.unwrap();
        assert!(fake.sandbox_state(&ids[0]).is_none());
    }

    #[tokio::test]
    async fn retained_runtimes_pause_and_resume_within_their_lifetime() {
        let fake = FakeE2b::start().await;
        let (provider, domains) = provider(&fake);
        let labels = BTreeMap::from([(DEADLINE_KEY.to_string(), (unix_now() + 300).to_string())]);
        let id = fake.add_sandbox("running", labels);

        provider.stop_runtime(&id).await.unwrap();
        assert_eq!(fake.sandbox_state(&id).as_deref(), Some("paused"));
        provider.stop_runtime(&id).await.unwrap();
        assert!(
            !provider
                .inspect_runtime(&id)
                .await
                .unwrap()
                .unwrap()
                .running
        );

        provider.start_runtime(&id).await.unwrap();
        assert_eq!(fake.sandbox_state(&id).as_deref(), Some("running"));
        let timeout = fake
            .last_request(&format!("/v2/sandboxes/{id}/connect"))
            .json()["timeout"]
            .as_u64()
            .unwrap();
        assert!((295..=300).contains(&timeout), "{timeout}");
        provider.start_runtime(&id).await.unwrap();
        assert_eq!(
            fake.requests_to(&format!("/v2/sandboxes/{id}/connect"))
                .len(),
            1
        );

        // The resumed connection is the one exec uses.
        let running = provider
            .exec_runtime(RunnerExecSpec {
                workspace_env: BTreeMap::new(),
                container_id: id.clone(),
                command: vec!["true".into()],
                env: Vec::new(),
                working_dir: "/".into(),
            })
            .await
            .unwrap();
        assert_eq!(collect(running).await.2, Some(0));
        assert_eq!(domains.lock().as_slice(), &["connect.e2b.test".to_string()]);

        let expired = fake.add_sandbox(
            "paused",
            BTreeMap::from([(DEADLINE_KEY.to_string(), (unix_now() - 5).to_string())]),
        );
        let error = provider.start_runtime(&expired).await.unwrap_err();
        assert!(error.contains("past its lifetime"), "{error}");
        assert!(
            fake.sandbox_state(&expired).is_none(),
            "an expired runtime is destroyed"
        );

        let unknown = fake.add_sandbox("paused", BTreeMap::new());
        assert!(provider.start_runtime(&unknown).await.is_err());
        assert!(provider.start_runtime("gone").await.is_err());
        assert!(provider.stop_runtime("gone").await.is_err());
    }

    #[tokio::test]
    async fn a_detail_without_a_token_connects_within_the_lifetime() {
        let fake = FakeE2b::start().await;
        let (provider, _) = provider(&fake);
        let id = fake.add_sandbox(
            "running",
            BTreeMap::from([(DEADLINE_KEY.to_string(), (unix_now() + 120).to_string())]),
        );
        fake.hide_token(&id);
        let running = provider
            .exec_runtime(RunnerExecSpec {
                workspace_env: BTreeMap::new(),
                container_id: id.clone(),
                command: vec!["true".into()],
                env: Vec::new(),
                working_dir: "/".into(),
            })
            .await
            .unwrap();
        assert_eq!(collect(running).await.2, Some(0));
        let timeout = fake
            .last_request(&format!("/v2/sandboxes/{id}/connect"))
            .json()["timeout"]
            .as_u64()
            .unwrap();
        assert!(
            timeout <= 120,
            "the TTL is never extended past the deadline"
        );
    }

    #[tokio::test]
    async fn the_container_surface_e2b_lacks_is_refused_truthfully() {
        let fake = FakeE2b::start().await;
        let (provider, _) = provider(&fake);
        assert!(matches!(
            ContainerApi::run(&provider, RunnerSpec {
                workspace_env: BTreeMap::new(),
                name: "x".into(),
                image: "x".into(),
                cmd: Vec::new(),
                env: Vec::new(),
                working_dir: "/".into(),
                mount: None,
                seccomp_json: None,
                memory_bytes: 0,
                nano_cpus: 0,
                pids_limit: 0,
                network_mode: "none".into(),
                labels: BTreeMap::new(),
                entrypoint: None,
                user: None,
                extra_mounts: Vec::new(),
                runtime: None,
                cap_drop: Vec::new(),
                cap_add: Vec::new(),
                read_only_rootfs: false,
                tmpfs: Vec::new(),
                writable_dirs: Vec::new(),
            })
            .await,
            Err(RunnerRunError::Other(message)) if message.contains("do not run containers")
        ));
        assert!(provider.pull_image("x").await.is_err());
        assert!(provider.pull_image_with_auth("x", None).await.is_err());
        assert!(provider.ensure_volume("v", &BTreeMap::new()).await.is_err());
        assert!(provider.runtimes().await.unwrap().is_empty());
        assert!(provider.list_owned_volumes().await.unwrap().is_empty());
        assert_eq!(
            provider.remove_volume("v").await.unwrap(),
            VolumeRemoval::Gone
        );
    }
}
