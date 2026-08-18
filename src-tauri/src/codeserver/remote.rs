//! Headless-owned code-server lifecycle and authenticated companion relay.
//!
//! A paired desktop never installs or upgrades code-server on the remote host.
//! The companion resolves only the pinned, preloaded binary, owns both isolated
//! profiles, and exposes a device-bound opaque relay path. The actual loopback
//! port and broker credentials never leave the host.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Path as AxumPath, Request};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::json;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use uuid::Uuid;

use super::download::CODE_SERVER_VERSION;
use super::profile::{IdeProfile, ProfilePaths};

pub const CODE_SERVER_BINARY_ENV: &str = "COGNIA_CODE_SERVER_BIN";
pub const CODE_SERVER_AGENT_VSIX_ENV: &str = "COGNIA_CODE_SERVER_AGENT_VSIX";
const STARTUP_BUDGET: Duration = Duration::from_secs(30);
const COMMAND_BUDGET: Duration = Duration::from_secs(60);
const MAX_RELAY_REQUEST_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCodeServerStatus {
    pub running: bool,
    /// Always `None` across the companion boundary; only the host relay knows
    /// the actual loopback port.
    pub port: Option<u16>,
    pub version: String,
    pub profile: Option<IdeProfile>,
    pub relay_path: Option<String>,
}

struct RemoteInstance {
    port: u16,
    profile: IdeProfile,
    child: Child,
    relay_id: String,
    allowed_devices: HashSet<String>,
}

impl RemoteInstance {
    fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn retire(&mut self) {
        let _ = self.child.start_kill();
    }
}

/// Process-owned registry installed in [`crate::headless::HeadlessServices`].
pub struct RemoteCodeServerState {
    data_dir: PathBuf,
    host_id: String,
    instances: Mutex<HashMap<String, RemoteInstance>>,
    operation_lock: Mutex<()>,
}

impl RemoteCodeServerState {
    pub fn new(data_dir: PathBuf) -> Arc<Self> {
        let host_id = load_or_create_host_id(&data_dir);
        Arc::new(Self {
            data_dir,
            host_id,
            instances: Mutex::new(HashMap::new()),
            operation_lock: Mutex::new(()),
        })
    }

    pub fn host_id(&self) -> &str {
        &self.host_id
    }

    pub async fn ensure(
        self: &Arc<Self>,
        root: &str,
        profile: IdeProfile,
        device_id: &str,
    ) -> Result<RemoteCodeServerStatus, String> {
        if !super::managed_platform_enabled() && profile == IdeProfile::Managed {
            return Err("IDE_PLATFORM_DISABLED".to_string());
        }
        let canonical = canonicalize_workspace(root)?;
        if let Some(status) = self.authorize_live(&canonical, profile, device_id).await {
            return Ok(status);
        }

        let _guard = self.operation_lock.lock().await;
        if let Some(status) = self.authorize_live(&canonical, profile, device_id).await {
            return Ok(status);
        }

        // Opposite profiles are never allowed against one workspace at once.
        self.stop(&canonical).await;
        super::download::resolve_platform().map_err(|_| {
            "unsupported_platform: managed Pro IDE requires Linux/macOS amd64/arm64"
        })?;
        let binary = resolve_preloaded_binary(&self.data_dir)?;
        verify_pinned_binary(&binary).await?;

        let code_server_root = self.data_dir.join("code-server");
        super::profile::migrate_legacy_profile_state(&code_server_root)?;
        super::profile::sync_portable_preferences_once(&code_server_root, profile)?;
        let paths = ProfilePaths::new(&code_server_root, profile);
        std::fs::create_dir_all(&paths.user_data_dir)
            .map_err(|error| format!("create {}: {error}", paths.user_data_dir.display()))?;
        std::fs::create_dir_all(&paths.extensions_dir)
            .map_err(|error| format!("create {}: {error}", paths.extensions_dir.display()))?;

        let broker_enabled = profile.allows_broker() && super::managed_platform_enabled();
        if broker_enabled {
            install_managed_extensions(&binary, &self.data_dir, &paths).await;
        }

        let port = reserve_loopback_port()?;
        let relay_id = Uuid::new_v4().simple().to_string();
        let args = code_server_args(&canonical, port, &paths, profile);
        let mut envs = Vec::new();
        if broker_enabled {
            let channel = super::agent_channel::global();
            let (broker_port, broker_token) = channel
                .register_instance_for_host(&canonical, &self.host_id)
                .await?;
            let content_port = channel.content_port().await?;
            envs.extend([
                ("COGNIA_CS_AGENT_PORT", broker_port.to_string()),
                ("COGNIA_CS_AGENT_TOKEN", broker_token),
                ("COGNIA_CS_CONTENT_PORT", content_port.to_string()),
                ("COGNIA_CS_BROKER_PROTOCOL", "1".to_string()),
                (
                    "COGNIA_CS_CATALOG_HASH",
                    super::broker_protocol::DEFAULT_CATALOG_HASH.to_string(),
                ),
                ("COGNIA_CS_HOST_ID", self.host_id.clone()),
                ("COGNIA_CS_WORKSPACE", canonical.clone()),
            ]);
        }

        let child = spawn_code_server(&binary, &args, &envs).map_err(|error| {
            if broker_enabled {
                super::agent_channel::global().deregister(&canonical);
            }
            error
        })?;
        let mut allowed_devices = HashSet::new();
        allowed_devices.insert(device_id.to_string());
        self.instances.lock().await.insert(
            canonical.clone(),
            RemoteInstance {
                port,
                profile,
                child,
                relay_id: relay_id.clone(),
                allowed_devices,
            },
        );
        if let Err(error) = wait_healthy(port, STARTUP_BUDGET).await {
            self.stop(&canonical).await;
            return Err(error);
        }
        Ok(running_status(profile, &relay_id))
    }

    pub fn build_proxy(
        &self,
        request: super::proxy::ProxyBuildRequest,
    ) -> Result<super::proxy::ProxyArtifact, String> {
        super::proxy::build_proxy_at_root(
            &self.data_dir.join("code-server"),
            &broker_vsix_path(&self.data_dir),
            request,
        )
    }

    pub fn list_proxies(&self) -> Result<Vec<super::proxy::ProxyArtifact>, String> {
        super::proxy::list_artifacts_at_root(&self.data_dir.join("code-server"))
    }

    /// Transactionally activate a verified proxy in every live managed
    /// workspace on this host. A failed handshake restores the previously
    /// marked proxy (or removes a first install), then rebuilds each affected
    /// extension-host generation before returning an error.
    pub async fn install_proxy_artifact(
        &self,
        artifact: &super::proxy::ProxyArtifact,
    ) -> Result<bool, String> {
        let cache_root = self.data_dir.join("code-server");
        super::proxy::verify_artifact_at_root(&cache_root, artifact)?;
        let _guard = self.operation_lock.lock().await;
        let roots = {
            let mut instances = self.instances.lock().await;
            instances
                .iter_mut()
                .filter_map(|(root, instance)| {
                    (instance.profile == IdeProfile::Managed && instance.is_alive())
                        .then(|| root.clone())
                })
                .collect::<Vec<_>>()
        };
        if roots.is_empty() {
            return Ok(false);
        }

        let binary = resolve_preloaded_binary(&self.data_dir)?;
        let paths = ProfilePaths::new(&cache_root, IdeProfile::Managed);
        let marker = managed_proxy_marker(&paths.extensions_dir, &artifact.plugin_id);
        let previous_sha = tokio::fs::read_to_string(&marker).await.ok();
        let previous = previous_sha.as_deref().and_then(|sha| {
            self.list_proxies()
                .ok()?
                .into_iter()
                .find(|candidate| candidate.sha256 == sha.trim())
        });

        install_remote_proxy(&binary, &paths, artifact).await?;
        let channel = super::agent_channel::global();
        if let Err(error) = activate_remote_proxy(&channel, &roots, artifact).await {
            if let Some(previous) = previous {
                install_remote_proxy(&binary, &paths, &previous)
                    .await
                    .map_err(|rollback| {
                        format!(
                            "proxy {} handshake failed ({error}); rollback install failed: {rollback}",
                            artifact.plugin_id
                        )
                    })?;
                activate_remote_proxy_after_restart(&channel, &roots, &previous)
                    .await
                    .map_err(|rollback| {
                        format!(
                            "proxy {} handshake failed ({error}); rollback verification failed: {rollback}",
                            artifact.plugin_id
                        )
                    })?;
            } else {
                uninstall_remote_proxy(&binary, &paths, &artifact.plugin_id)
                    .await
                    .map_err(|rollback| {
                        format!(
                            "proxy {} handshake failed ({error}); uninstall rollback failed: {rollback}",
                            artifact.plugin_id
                        )
                    })?;
                restart_remote_extension_hosts(&channel, &roots)
                    .await
                    .map_err(|rollback| {
                        format!(
                            "proxy {} handshake failed ({error}); extension-host cleanup failed: {rollback}",
                            artifact.plugin_id
                        )
                    })?;
            }
            return Err(format!(
                "proxy {} activation handshake failed and was rolled back: {error}",
                artifact.plugin_id
            ));
        }
        Ok(true)
    }

    pub async fn status(
        &self,
        root: &str,
        device_id: &str,
    ) -> Result<RemoteCodeServerStatus, String> {
        let canonical = canonicalize_workspace(root)?;
        let mut instances = self.instances.lock().await;
        let Some(instance) = instances.get_mut(&canonical) else {
            return Ok(stopped_status());
        };
        if !instance.is_alive() {
            instance.retire();
            instances.remove(&canonical);
            super::agent_channel::global().deregister(&canonical);
            return Ok(stopped_status());
        }
        if !instance.allowed_devices.contains(device_id) {
            return Ok(stopped_status());
        }
        Ok(running_status(instance.profile, &instance.relay_id))
    }

    pub async fn stop(&self, root: &str) -> bool {
        let canonical = canonicalize_workspace(root).unwrap_or_else(|_| root.to_string());
        let mut instance = self.instances.lock().await.remove(&canonical);
        if let Some(instance) = instance.as_mut() {
            instance.retire();
            super::agent_channel::global().deregister(&canonical);
            true
        } else {
            false
        }
    }

    pub async fn stop_all(&self) {
        let mut instances = self.instances.lock().await;
        for (root, instance) in instances.iter_mut() {
            instance.retire();
            super::agent_channel::global().deregister(root);
        }
        instances.clear();
    }

    async fn authorize_live(
        &self,
        canonical: &str,
        profile: IdeProfile,
        device_id: &str,
    ) -> Option<RemoteCodeServerStatus> {
        let mut instances = self.instances.lock().await;
        let instance = instances.get_mut(canonical)?;
        if !instance.is_alive() || instance.profile != profile {
            instance.retire();
            instances.remove(canonical);
            super::agent_channel::global().deregister(canonical);
            return None;
        }
        instance.allowed_devices.insert(device_id.to_string());
        Some(running_status(instance.profile, &instance.relay_id))
    }

    async fn relay_port(&self, relay_id: &str, device_id: &str) -> Option<u16> {
        let mut instances = self.instances.lock().await;
        for instance in instances.values_mut() {
            if instance.relay_id == relay_id
                && instance.allowed_devices.contains(device_id)
                && instance.is_alive()
            {
                return Some(instance.port);
            }
        }
        None
    }
}

fn running_status(profile: IdeProfile, relay_id: &str) -> RemoteCodeServerStatus {
    RemoteCodeServerStatus {
        running: true,
        port: None,
        version: CODE_SERVER_VERSION.to_string(),
        profile: Some(profile),
        relay_path: Some(format!("/ide/relay/{relay_id}/")),
    }
}

fn stopped_status() -> RemoteCodeServerStatus {
    RemoteCodeServerStatus {
        running: false,
        port: None,
        version: CODE_SERVER_VERSION.to_string(),
        profile: None,
        relay_path: None,
    }
}

fn canonicalize_workspace(root: &str) -> Result<String, String> {
    Path::new(root)
        .canonicalize()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| format!("resolve project root {root}: {error}"))
}

fn load_or_create_host_id(data_dir: &Path) -> String {
    if let Ok(explicit) = std::env::var("COGNIA_HOST_ID") {
        if !explicit.trim().is_empty() {
            return explicit;
        }
    }
    let path = data_dir.join("cognia").join("managed-ide-host-id");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        if !existing.trim().is_empty() {
            return existing.trim().to_string();
        }
    }
    let generated = format!("host-{}", Uuid::new_v4().simple());
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
        let _ = std::fs::write(path, format!("{generated}\n"));
    }
    generated
}

fn resolve_preloaded_binary(data_dir: &Path) -> Result<String, String> {
    let path = std::env::var_os(CODE_SERVER_BINARY_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            data_dir
                .join("code-server")
                .join(CODE_SERVER_VERSION)
                .join("bin")
                .join("code-server")
        });
    let canonical = path.canonicalize().map_err(|_| {
        format!(
            "REMOTE_CODE_SERVER_UPGRADE_REQUIRED: preload code-server {CODE_SERVER_VERSION} at {} or set {CODE_SERVER_BINARY_ENV}",
            path.display()
        )
    })?;
    if !canonical.is_file() {
        return Err(format!(
            "REMOTE_CODE_SERVER_UPGRADE_REQUIRED: {} is not a code-server executable",
            canonical.display()
        ));
    }
    Ok(canonical.to_string_lossy().into_owned())
}

async fn verify_pinned_binary(binary: &str) -> Result<(), String> {
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        Command::new(binary)
            .arg("--version")
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| "REMOTE_CODE_SERVER_VERSION_CHECK_TIMEOUT".to_string())?
    .map_err(|error| format!("REMOTE_CODE_SERVER_VERSION_CHECK_FAILED: {error}"))?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() || !version_output_matches(&text) {
        return Err(format!(
            "REMOTE_CODE_SERVER_UPGRADE_REQUIRED: expected code-server {CODE_SERVER_VERSION} / Code 1.128.0, found {}",
            text.trim()
        ));
    }
    Ok(())
}

fn version_output_matches(output: &str) -> bool {
    let first = output.lines().find(|line| !line.trim().is_empty());
    first.is_some_and(|line| {
        line.split_whitespace().next() == Some(CODE_SERVER_VERSION) && output.contains("1.128.0")
    })
}

fn code_server_args(
    root: &str,
    port: u16,
    paths: &ProfilePaths,
    profile: IdeProfile,
) -> Vec<String> {
    let mut args = vec![
        "--bind-addr".to_string(),
        format!("127.0.0.1:{port}"),
        "--auth".to_string(),
        "none".to_string(),
        "--disable-telemetry".to_string(),
        "--disable-update-check".to_string(),
    ];
    if profile == IdeProfile::Managed {
        args.push("--disable-workspace-trust".to_string());
    }
    args.extend([
        "--user-data-dir".to_string(),
        paths.user_data_dir.to_string_lossy().into_owned(),
        "--extensions-dir".to_string(),
        paths.extensions_dir.to_string_lossy().into_owned(),
        root.to_string(),
    ]);
    args
}

fn reserve_loopback_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("reserve loopback port: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("read reserved port: {error}"))
}

fn spawn_code_server(
    binary: &str,
    args: &[String],
    envs: &[(&str, String)],
) -> Result<Child, String> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for (key, value) in envs {
        command.env(key, value);
    }
    command
        .spawn()
        .map_err(|error| format!("spawn remote code-server: {error}"))
}

async fn wait_healthy(port: u16, budget: Duration) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .no_proxy()
        .build()
        .map_err(|error| format!("build code-server health client: {error}"))?;
    let deadline = Instant::now() + budget;
    let url = format!("http://127.0.0.1:{port}/healthz");
    loop {
        if matches!(client.get(&url).send().await, Ok(response) if response.status().is_success()) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "remote code-server did not become healthy within {}s",
                budget.as_secs()
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn install_managed_extensions(binary: &str, data_dir: &Path, paths: &ProfilePaths) {
    let broker = broker_vsix_path(data_dir);
    if broker.is_file() {
        if let Err(error) = install_vsix(binary, &broker, paths).await {
            log::warn!("remote managed broker install failed; base IDE remains available: {error}");
        }
    } else {
        log::warn!(
            "remote managed broker missing at {}; base IDE remains available",
            broker.display()
        );
    }
    let cache_root = data_dir.join("code-server");
    match super::proxy::list_artifacts_at_root(&cache_root) {
        Ok(artifacts) => {
            for artifact in artifacts {
                let marker = managed_proxy_marker(&paths.extensions_dir, &artifact.plugin_id);
                let marker_contents = tokio::fs::read_to_string(&marker).await.ok();
                if !super::proxy::activation_marker_selects(marker_contents.as_deref(), &artifact) {
                    continue;
                }
                if let Err(error) = install_remote_proxy(binary, paths, &artifact).await {
                    log::warn!(
                        "remote managed proxy {} install failed: {error}",
                        artifact.plugin_id
                    );
                }
            }
        }
        Err(error) => log::warn!("remote managed proxy discovery failed: {error}"),
    }
}

async fn install_remote_proxy(
    binary: &str,
    paths: &ProfilePaths,
    artifact: &super::proxy::ProxyArtifact,
) -> Result<(), String> {
    let marker = managed_proxy_marker(&paths.extensions_dir, &artifact.plugin_id);
    if tokio::fs::read_to_string(&marker)
        .await
        .ok()
        .as_deref()
        .map(str::trim)
        == Some(artifact.sha256.as_str())
    {
        return Ok(());
    }
    install_vsix(binary, Path::new(&artifact.vsix_path), paths).await?;
    tokio::fs::write(&marker, &artifact.sha256)
        .await
        .map_err(|error| format!("proxy {} marker write failed: {error}", artifact.plugin_id))
}

async fn uninstall_remote_proxy(
    binary: &str,
    paths: &ProfilePaths,
    plugin_id: &str,
) -> Result<(), String> {
    let extension_id = format!("cognia-managed.{}", super::proxy::proxy_name(plugin_id));
    let output = tokio::time::timeout(
        COMMAND_BUDGET,
        Command::new(binary)
            .arg("--uninstall-extension")
            .arg(&extension_id)
            .arg("--extensions-dir")
            .arg(&paths.extensions_dir)
            .arg("--user-data-dir")
            .arg(&paths.user_data_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| format!("proxy {plugin_id} uninstall timed out"))?
    .map_err(|error| format!("proxy {plugin_id} uninstall failed: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "proxy {plugin_id} uninstall failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    match tokio::fs::remove_file(managed_proxy_marker(&paths.extensions_dir, plugin_id)).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("proxy {plugin_id} marker cleanup failed: {error}")),
    }
}

fn managed_proxy_marker(extensions_dir: &Path, plugin_id: &str) -> PathBuf {
    extensions_dir.join(format!(
        ".cognia-proxy-{}",
        plugin_id
            .chars()
            .map(|character| if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            })
            .collect::<String>()
    ))
}

fn proxy_handshake(artifact: &super::proxy::ProxyArtifact) -> serde_json::Value {
    json!({
        "pluginId": artifact.plugin_id,
        "pluginVersion": artifact.plugin_version,
        "manifestHash": artifact.manifest_hash,
        "catalogHash": artifact.catalog_hash,
        "platformVersion": artifact.platform_version,
    })
}

async fn activate_remote_proxy(
    channel: &super::agent_channel::AgentChannel,
    roots: &[String],
    artifact: &super::proxy::ProxyArtifact,
) -> Result<(), String> {
    for root in roots {
        let generation = channel.connection_generation(root);
        let mut handshake = channel
            .send(root, "managedProxyHandshake", proxy_handshake(artifact))
            .await;
        if handshake.is_err() {
            if let Some(generation) = generation {
                let _ = channel
                    .send(root, "restartManagedExtensionHost", json!({}))
                    .await;
                if channel
                    .wait_for_new_generation(root, generation, Duration::from_secs(30))
                    .await
                    .is_ok()
                {
                    handshake = channel
                        .send(root, "managedProxyHandshake", proxy_handshake(artifact))
                        .await;
                }
            }
        }
        handshake.map_err(|error| format!("{root}: {error}"))?;
    }
    Ok(())
}

async fn restart_remote_extension_hosts(
    channel: &super::agent_channel::AgentChannel,
    roots: &[String],
) -> Result<(), String> {
    for root in roots {
        let generation = channel
            .connection_generation(root)
            .ok_or_else(|| format!("{root}: managed extension host is disconnected"))?;
        let _ = channel
            .send(root, "restartManagedExtensionHost", json!({}))
            .await;
        channel
            .wait_for_new_generation(root, generation, Duration::from_secs(30))
            .await
            .map_err(|error| format!("{root}: {error}"))?;
    }
    Ok(())
}

async fn activate_remote_proxy_after_restart(
    channel: &super::agent_channel::AgentChannel,
    roots: &[String],
    artifact: &super::proxy::ProxyArtifact,
) -> Result<(), String> {
    restart_remote_extension_hosts(channel, roots).await?;
    for root in roots {
        channel
            .send(root, "managedProxyHandshake", proxy_handshake(artifact))
            .await
            .map_err(|error| format!("{root}: {error}"))?;
    }
    Ok(())
}

fn broker_vsix_path(data_dir: &Path) -> PathBuf {
    std::env::var_os(CODE_SERVER_AGENT_VSIX_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            data_dir
                .join("sidecar")
                .join("codeserver-agent-ext")
                .join("cognia-agent-bridge.vsix")
        })
}

async fn install_vsix(binary: &str, vsix: &Path, paths: &ProfilePaths) -> Result<(), String> {
    let output = tokio::time::timeout(
        COMMAND_BUDGET,
        Command::new(binary)
            .arg("--install-extension")
            .arg(vsix)
            .arg("--force")
            .arg("--extensions-dir")
            .arg(&paths.extensions_dir)
            .arg("--user-data-dir")
            .arg(&paths.user_data_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| format!("install {} timed out", vsix.display()))?
    .map_err(|error| format!("install {}: {error}", vsix.display()))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Authenticated HTTP/WebSocket reverse proxy from the companion front door to
/// the host-only code-server port. Device authorization is checked again on
/// every request/upgrade, including after reconnection.
pub async fn relay_handler(
    AxumPath((relay_id, tail)): AxumPath<(String, String)>,
    request: Request,
) -> Response {
    relay_request(relay_id, tail, request).await
}

/// Axum's catch-all route does not match the relay mount itself. Keep an
/// explicit root handler so code-server's initial `/` navigation is relayed
/// rather than returning the companion's 404 response.
pub async fn relay_root_handler(
    AxumPath(relay_id): AxumPath<String>,
    request: Request,
) -> Response {
    relay_request(relay_id, String::new(), request).await
}

async fn relay_request(relay_id: String, tail: String, request: Request) -> Response {
    let (mut parts, body) = request.into_parts();
    let ws = WebSocketUpgrade::from_request_parts(&mut parts, &())
        .await
        .ok();
    let request = Request::from_parts(parts, body);
    let device_id = request
        .extensions()
        .get::<crate::companion_api::middleware::DeviceContext>()
        .map(|context| context.device_id.clone())
        .unwrap_or_default();
    let Some(services) = crate::headless::headless_services() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "headless IDE unavailable").into_response();
    };
    if !crate::companion_api::rpc::device_can_control(&device_id) {
        return (StatusCode::FORBIDDEN, "remote control grant required").into_response();
    }
    let Some(port) = services.code_server.relay_port(&relay_id, &device_id).await else {
        return (StatusCode::NOT_FOUND, "managed IDE relay unavailable").into_response();
    };
    if let Some(ws) = ws {
        let query = request
            .uri()
            .query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default();
        let upstream = format!("ws://127.0.0.1:{port}/{tail}{query}");
        let requested_protocol = request
            .headers()
            .get(axum::http::header::SEC_WEBSOCKET_PROTOCOL)
            .and_then(|value| value.to_str().ok())
            .map(ToString::to_string);
        let protocols = requested_protocol
            .as_deref()
            .map(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut upgrade = ws.max_message_size(MAX_RELAY_REQUEST_BYTES);
        if !protocols.is_empty() {
            upgrade = upgrade.protocols(protocols);
        }
        return upgrade
            .on_upgrade(move |socket| {
                relay_websocket(socket, upstream, requested_protocol, device_id)
            })
            .into_response();
    }
    relay_http(port, &tail, request).await
}

async fn relay_http(port: u16, tail: &str, request: Request) -> Response {
    let query = request
        .uri()
        .query()
        .map(|query| format!("?{query}"))
        .unwrap_or_default();
    let url = format!("http://127.0.0.1:{port}/{tail}{query}");
    let method = request.method().clone();
    let headers = filtered_headers(request.headers());
    let stream = request.into_body().into_data_stream();
    let client = match reqwest::Client::builder().no_proxy().build() {
        Ok(client) => client,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("build loopback relay client: {error}"),
            )
                .into_response();
        }
    };
    let mut upstream = client
        .request(method, url)
        .body(reqwest::Body::wrap_stream(stream));
    for (name, value) in headers {
        upstream = upstream.header(name, value);
    }
    match upstream.send().await {
        Ok(response) => {
            let status = response.status();
            let headers = filtered_headers(response.headers());
            let mut output = Response::builder().status(status);
            for (name, value) in headers {
                output = output.header(name, value);
            }
            output
                .body(Body::from_stream(response.bytes_stream()))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
        }
        Err(error) => {
            log::warn!("managed IDE upstream HTTP failed: {error}");
            StatusCode::BAD_GATEWAY.into_response()
        }
    }
}

async fn relay_websocket(
    mut downstream: WebSocket,
    upstream_url: String,
    requested_protocol: Option<String>,
    device_id: String,
) {
    let Ok(mut request) = upstream_url.into_client_request() else {
        let _ = downstream.close().await;
        return;
    };
    if let Some(protocol) = requested_protocol.and_then(|value| HeaderValue::from_str(&value).ok())
    {
        request
            .headers_mut()
            .insert(axum::http::header::SEC_WEBSOCKET_PROTOCOL, protocol);
    }
    let Ok((upstream, _)) = tokio_tungstenite::connect_async(request).await else {
        let _ = downstream.close().await;
        return;
    };
    let (mut upstream_tx, mut upstream_rx) = upstream.split();
    let mut authorization_tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        if !crate::companion_api::rpc::device_can_control(&device_id) {
            break;
        }
        tokio::select! {
            _ = authorization_tick.tick() => {
                if !crate::companion_api::rpc::device_can_control(&device_id) { break; }
            }
            message = downstream.recv() => {
                let Some(Ok(message)) = message else { break };
                let Some(message) = to_tungstenite(message) else { continue };
                if upstream_tx.send(message).await.is_err() { break; }
            }
            message = upstream_rx.next() => {
                let Some(Ok(message)) = message else { break };
                let Some(message) = to_axum(message) else { continue };
                if downstream.send(message).await.is_err() { break; }
            }
        }
    }
    let _ = upstream_tx.close().await;
    let _ = downstream.close().await;
}

fn filtered_headers(headers: &HeaderMap) -> Vec<(HeaderName, HeaderValue)> {
    headers
        .iter()
        .filter(|(name, _)| {
            !matches!(
                name.as_str(),
                "authorization"
                    | "connection"
                    | "host"
                    | "keep-alive"
                    | "proxy-authenticate"
                    | "proxy-authorization"
                    | "te"
                    | "trailer"
                    | "transfer-encoding"
                    | "upgrade"
            )
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

fn to_tungstenite(message: Message) -> Option<tokio_tungstenite::tungstenite::Message> {
    use tokio_tungstenite::tungstenite::Message as Target;
    match message {
        Message::Text(value) => Some(Target::Text(value.to_string().into())),
        Message::Binary(value) => Some(Target::Binary(value)),
        Message::Ping(value) => Some(Target::Ping(value)),
        Message::Pong(value) => Some(Target::Pong(value)),
        Message::Close(frame) => Some(Target::Close(frame.map(|frame| {
            tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: frame.code.into(),
                reason: frame.reason.to_string().into(),
            }
        }))),
    }
}

fn to_axum(message: tokio_tungstenite::tungstenite::Message) -> Option<Message> {
    use tokio_tungstenite::tungstenite::Message as Source;
    match message {
        Source::Text(value) => Some(Message::Text(value.to_string().into())),
        Source::Binary(value) => Some(Message::Binary(value.into())),
        Source::Ping(value) => Some(Message::Ping(value.into())),
        Source::Pong(value) => Some(Message::Pong(value.into())),
        Source::Close(frame) => Some(Message::Close(frame.map(|frame| {
            axum::extract::ws::CloseFrame {
                code: frame.code.into(),
                reason: frame.reason.to_string().into(),
            }
        }))),
        Source::Frame(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preloaded_path_is_pinned_and_never_uses_npm_fallback() {
        let root = Path::new("/srv/cognia");
        let expected = root
            .join("code-server")
            .join(CODE_SERVER_VERSION)
            .join("bin")
            .join("code-server");
        assert!(expected.ends_with("4.128.0/bin/code-server"));
    }

    #[test]
    fn version_gate_rejects_other_code_server_versions() {
        assert!(version_output_matches("4.128.0 abcdef with Code 1.128.0\n"));
        assert!(!version_output_matches(
            "4.127.1 abcdef with Code 1.127.1\n"
        ));
    }

    #[test]
    fn relay_status_never_exposes_the_loopback_port() {
        let status = running_status(IdeProfile::Managed, "opaque");
        let value = serde_json::to_value(status).unwrap();
        assert_eq!(value["relayPath"], "/ide/relay/opaque/");
        assert!(value["port"].is_null());
    }

    #[test]
    fn managed_profile_grants_full_workspace_access_but_native_keeps_trust() {
        let paths = ProfilePaths::new(Path::new("/srv/cognia/code-server"), IdeProfile::Managed);
        let managed = code_server_args("/work/proj", 43117, &paths, IdeProfile::Managed);
        let native = code_server_args("/work/proj", 43117, &paths, IdeProfile::Native);

        assert!(managed.iter().any(|arg| arg == "--disable-workspace-trust"));
        assert!(!native.iter().any(|arg| arg == "--disable-workspace-trust"));
    }

    #[test]
    fn hop_by_hop_and_credentials_are_removed() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer secret"));
        headers.insert("connection", HeaderValue::from_static("upgrade"));
        headers.insert("x-cognia-test", HeaderValue::from_static("kept"));
        let filtered = filtered_headers(&headers);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].0, "x-cognia-test");
    }

    #[test]
    fn proxy_transaction_marker_and_handshake_are_version_bound() {
        let marker = managed_proxy_marker(Path::new("/cache/extensions"), "acme.tools/unsafe");
        assert_eq!(
            marker,
            Path::new("/cache/extensions/.cognia-proxy-acme-tools-unsafe")
        );
        let artifact = super::super::proxy::ProxyArtifact {
            plugin_id: "acme.tools".to_string(),
            plugin_version: "2.0.0".to_string(),
            manifest_hash: "sha256:manifest".to_string(),
            catalog_hash: "sha256:catalog".to_string(),
            platform_version: "1.0.0".to_string(),
            sha256: "proxy-digest".to_string(),
            signature: "signature".to_string(),
            public_key: "key".to_string(),
            vsix_path: "/cache/proxy.vsix".to_string(),
            executables: Vec::new(),
        };
        assert_eq!(
            proxy_handshake(&artifact),
            json!({
                "pluginId": "acme.tools",
                "pluginVersion": "2.0.0",
                "manifestHash": "sha256:manifest",
                "catalogHash": "sha256:catalog",
                "platformVersion": "1.0.0",
            })
        );
    }
}
