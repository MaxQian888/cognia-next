//! Provider transport and Host-only secrets. Every public result is token-free.
use super::{
    contracts::*,
    journal::{private_directory, read_json, write_json},
};
use async_trait::async_trait;
use cognia_e2b::{
    ApiClient, ApiError, ExactBuild, ExactSandboxRequest, ImageBuildRequest, SandboxEgress,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fmt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use url::Url;

/// This secret wrapper intentionally has no Serialize implementation.
pub struct ProviderSecret(pub String);
impl fmt::Debug for ProviderSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ProviderSecret(<redacted>)")
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct DesktopSecrets {
    pub guest_token: String,
    pub traffic_token: Option<String>,
    pub domain: Option<String>,
    #[serde(default)]
    pub envd_token: Option<String>,
}
impl fmt::Debug for DesktopSecrets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DesktopSecrets(<redacted>)")
    }
}

#[async_trait]
pub trait ManagedDesktopSecrets: Send + Sync {
    async fn provider_key(&self, config: &ManagedDesktopConfig) -> Result<ProviderSecret>;
    async fn desktop(&self, id: &str) -> Result<DesktopSecrets>;
    async fn put_desktop(&self, id: &str, secrets: &DesktopSecrets) -> Result<()>;
    async fn remove_desktop(&self, id: &str) -> Result<()>;
}
/// Native private-file vault for Hosts without a keyring. Provider keys are
/// provisioned by a Host administrator, never accepted via desktop RPC. Secret
/// generations retain cleanup authority after configuration/key rotation.
pub struct FileManagedDesktopSecrets {
    root: PathBuf,
}
impl FileManagedDesktopSecrets {
    pub fn open(root: &Path) -> Result<Self> {
        private_directory(root)?;
        Ok(Self { root: root.into() })
    }
    fn path(&self, key: &str) -> PathBuf {
        self.root.join(format!(
            "{}.json",
            hex::encode(Sha256::digest(key.as_bytes()))
        ))
    }
    pub fn set_provider_key(&self, config: &ManagedDesktopConfig, key: &str) -> Result<()> {
        if key.trim().is_empty() || key.len() > 8192 || key.contains(['\r', '\n']) {
            return Err(refused("managed_desktop_secret_invalid"));
        }
        write_json(&self.path(&config.secret_ref()), &key)
    }
}
async fn secret_io<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| retryable("managed_desktop_storage_unavailable"))?
}
#[async_trait]
impl ManagedDesktopSecrets for FileManagedDesktopSecrets {
    async fn provider_key(&self, config: &ManagedDesktopConfig) -> Result<ProviderSecret> {
        let path = self.path(&config.secret_ref());
        secret_io(move || {
            let key: String =
                read_json(&path)?.ok_or_else(|| refused("managed_desktop_missing_credentials"))?;
            Ok(ProviderSecret(key))
        })
        .await
    }
    async fn desktop(&self, id: &str) -> Result<DesktopSecrets> {
        let path = self.path(&format!("desktop:{id}"));
        secret_io(move || {
            read_json(&path)?.ok_or_else(|| refused("managed_desktop_missing_endpoint_credentials"))
        })
        .await
    }
    async fn put_desktop(&self, id: &str, secrets: &DesktopSecrets) -> Result<()> {
        let path = self.path(&format!("desktop:{id}"));
        let secrets = secrets.clone();
        secret_io(move || write_json(&path, &secrets)).await
    }
    async fn remove_desktop(&self, id: &str) -> Result<()> {
        let path = self.path(&format!("desktop:{id}"));
        let root = self.root.clone();
        secret_io(move || match std::fs::remove_file(path) {
            Ok(()) => std::fs::File::open(root)
                .and_then(|dir| dir.sync_all())
                .map_err(|_| retryable("managed_desktop_secret_cleanup_failed")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(retryable("managed_desktop_secret_cleanup_failed")),
        })
        .await
    }
}
#[async_trait]
pub trait ManagedDesktopImageVerifier: Send + Sync {
    async fn verify(&self, release: &DesktopRelease) -> Result<()>;
}

#[derive(Clone, Debug)]
pub struct ProviderDesktop {
    pub resource_id: String,
    pub running: bool,
    pub metadata: BTreeMap<String, String>,
    pub template_id: Option<String>,
    pub deadline_at: Option<i64>,
    pub kill_on_timeout: bool,
    pub auto_resume: bool,
    pub private_ingress: bool,
    pub allow_out: Vec<String>,
    pub deny_out: Vec<String>,
}
pub struct CreatedDesktop {
    pub resource: ProviderDesktop,
    pub secrets: DesktopSecrets,
}
/// Rechecked after provider preflight and immediately before a paid request.
/// Cleanup deliberately does not require an interactive caller admission.
pub type LifecycleAdmission = Arc<dyn Fn() -> Result<()> + Send + Sync>;

#[async_trait]
pub trait ManagedDesktopProvider: Send + Sync {
    async fn verify_release(&self, config: &ManagedDesktopConfig) -> Result<()>;
    async fn verify_smoke_egress(
        &self,
        record: &DesktopRecord,
        secrets: &DesktopSecrets,
    ) -> Result<()>;
    async fn register_template(
        &self,
        config: &ManagedDesktopConfig,
        key: &ProviderSecret,
        name: &str,
        admission: LifecycleAdmission,
    ) -> Result<TemplateIdentity>;
    async fn start_template(
        &self,
        config: &ManagedDesktopConfig,
        key: &ProviderSecret,
        identity: &TemplateIdentity,
        admission: LifecycleAdmission,
    ) -> Result<()>;
    async fn template_status(
        &self,
        config: &ManagedDesktopConfig,
        key: &ProviderSecret,
        identity: &TemplateIdentity,
    ) -> Result<TemplateState>;
    async fn create(
        &self,
        record: &DesktopRecord,
        key: &ProviderSecret,
        secrets: &DesktopSecrets,
        remaining_seconds: u64,
        admission: LifecycleAdmission,
    ) -> Result<CreatedDesktop>;
    async fn inspect(
        &self,
        config: &ManagedDesktopConfig,
        key: &ProviderSecret,
        id: &str,
    ) -> Result<Option<ProviderDesktop>>;
    async fn list(
        &self,
        config: &ManagedDesktopConfig,
        key: &ProviderSecret,
        metadata: &BTreeMap<String, String>,
    ) -> Result<Vec<ProviderDesktop>>;
    async fn delete(
        &self,
        config: &ManagedDesktopConfig,
        key: &ProviderSecret,
        id: &str,
    ) -> Result<()>;
    async fn bootstrap(&self, record: &DesktopRecord, secrets: &DesktopSecrets) -> Result<()>;
    async fn health(&self, record: &DesktopRecord, secrets: &DesktopSecrets) -> Result<()>;
}

pub struct E2bDesktopProvider {
    base: Url,
    verifier: Arc<dyn ManagedDesktopImageVerifier>,
    verified_releases: tokio::sync::Mutex<std::collections::BTreeSet<String>>,
}
impl E2bDesktopProvider {
    pub fn new(verifier: Arc<dyn ManagedDesktopImageVerifier>) -> Self {
        Self {
            base: Url::parse("https://api.e2b.app").expect("constant URL"),
            verifier,
            verified_releases: tokio::sync::Mutex::new(std::collections::BTreeSet::new()),
        }
    }
    fn client(&self, key: &ProviderSecret) -> ApiClient {
        ApiClient::new(self.base.clone(), key.0.clone())
    }
    fn build(config: &ManagedDesktopConfig, name: &str) -> ImageBuildRequest {
        ImageBuildRequest {
            name: name.into(),
            image: config.release.image.clone(),
            cpu_count: config.shape.cpu_count,
            memory_mb: config.shape.memory_mb,
            start_cmd: config.release.start_command.clone(),
            ready_cmd: config.release.ready_command.clone(),
        }
    }
}
fn api_error(error: ApiError) -> ManagedDesktopError {
    match error.status() {
        Some(401 | 403) => refused("managed_desktop_provider_unauthorized"),
        Some(404) => refused("managed_desktop_provider_missing"),
        Some(429) => retryable("managed_desktop_provider_capacity"),
        Some(400..=499) => refused("managed_desktop_provider_rejected"),
        _ => retryable("managed_desktop_provider_unknown_outcome"),
    }
}
const CREATE_ADMISSION_SECONDS: u64 = 15;
fn provider_ttl(deadline: i64, now: i64, admitted_remaining: u64) -> Result<u64> {
    let remaining = deadline.saturating_sub(now).max(0) as u64 / 1000;
    remaining
        .min(admitted_remaining)
        .checked_sub(CREATE_ADMISSION_SECONDS)
        .filter(|ttl| *ttl > 0)
        .ok_or_else(|| refused("managed_desktop_provisioning_budget_expired"))
}
fn exact(identity: &TemplateIdentity) -> ExactBuild {
    ExactBuild {
        template_id: identity.template_id.clone(),
        build_id: identity.build_id.clone(),
    }
}
fn info(value: cognia_e2b::SandboxInfo) -> ProviderDesktop {
    ProviderDesktop {
        resource_id: value.sandbox_id,
        running: value.state == "running",
        metadata: value.metadata.unwrap_or_default(),
        template_id: value.template_id,
        deadline_at: value
            .end_at
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis()),
        kill_on_timeout: value
            .lifecycle
            .as_ref()
            .is_some_and(|l| l.on_timeout == "kill"),
        auto_resume: value.lifecycle.as_ref().is_none_or(|l| l.auto_resume),
        allow_out: value
            .network
            .as_ref()
            .map(|n| n.allow_out.clone())
            .unwrap_or_default(),
        deny_out: value
            .network
            .as_ref()
            .map(|n| n.deny_out.clone())
            .unwrap_or_default(),
        private_ingress: value
            .network
            .as_ref()
            .is_some_and(|n| n.allow_public_traffic == Some(false)),
    }
}
#[async_trait]
impl ManagedDesktopProvider for E2bDesktopProvider {
    async fn verify_release(&self, config: &ManagedDesktopConfig) -> Result<()> {
        let binding = config.binding_digest();
        let mut verified = self.verified_releases.lock().await;
        if !verified.contains(&binding) {
            self.verifier.verify(&config.release).await?;
            verified.insert(binding);
        }
        Ok(())
    }
    async fn verify_smoke_egress(
        &self,
        record: &DesktopRecord,
        secrets: &DesktopSecrets,
    ) -> Result<()> {
        if record.config.egress != DesktopEgress::Off {
            return Err(refused("managed_desktop_egress_smoke_unsupported"));
        }
        let request = bootstrap_request(record, secrets)?;
        let evidence = cognia_e2b::envd::probe_desktop_egress(&request)
            .await
            .map_err(|_| refused("managed_desktop_egress_probe_failed"))?;
        if !evidence.all_no_response() {
            return Err(refused("managed_desktop_egress_probe_failed"));
        }
        Ok(())
    }

    async fn register_template(
        &self,
        config: &ManagedDesktopConfig,
        key: &ProviderSecret,
        name: &str,
        admission: LifecycleAdmission,
    ) -> Result<TemplateIdentity> {
        self.verify_release(config).await?;
        admission()?;
        let result = self
            .client(key)
            .request_image_build(&Self::build(config, name))
            .await
            .map_err(api_error)?;
        Ok(TemplateIdentity {
            template_id: result.template_id,
            build_id: result.build_id,
            image_digest: config.release.image_digest.clone(),
            recipe_revision: config.release.recipe_revision.clone(),
            protocol: config.release.protocol.clone(),
        })
    }
    async fn start_template(
        &self,
        config: &ManagedDesktopConfig,
        key: &ProviderSecret,
        identity: &TemplateIdentity,
        admission: LifecycleAdmission,
    ) -> Result<()> {
        admission()?;
        self.client(key)
            .start_image_build(&exact(identity), &Self::build(config, "cognia-desktop"))
            .await
            .map_err(api_error)
    }
    async fn template_status(
        &self,
        _config: &ManagedDesktopConfig,
        key: &ProviderSecret,
        identity: &TemplateIdentity,
    ) -> Result<TemplateState> {
        let client = self.client(key);
        let status = client
            .build_status(&identity.template_id, &identity.build_id, 0)
            .await
            .map_err(api_error)?;
        match status.status.as_str() {
            "ready" => {
                client
                    .validate_exact_build(&exact(identity))
                    .await
                    .map_err(api_error)?;
                Ok(TemplateState::Ready)
            }
            "building" | "waiting" => Ok(TemplateState::Building),
            "error" => Ok(TemplateState::Failed),
            _ => Err(refused("managed_desktop_template_state_unknown")),
        }
    }
    async fn create(
        &self,
        record: &DesktopRecord,
        key: &ProviderSecret,
        secrets: &DesktopSecrets,
        remaining_seconds: u64,
        admission: LifecycleAdmission,
    ) -> Result<CreatedDesktop> {
        let client = self.client(key);
        client
            .validate_exact_build(&exact(&record.template))
            .await
            .map_err(api_error)?;
        let egress = match &record.config.egress {
            DesktopEgress::Off => SandboxEgress::Off,
            DesktopEgress::On => SandboxEgress::On,
            DesktopEgress::Allowlist(r) => SandboxEgress::Allowlist(r.clone()),
        };
        // Exact-build validation is a separate network exchange. Recompute
        // immediately before POST, then reserve its bounded admission window.
        let timeout_secs = provider_ttl(
            record.desktop.deadline_at,
            chrono::Utc::now().timestamp_millis(),
            remaining_seconds,
        )?;
        let request = ExactSandboxRequest {
            build: exact(&record.template),
            timeout_secs,
            metadata: record.metadata(),
            env_vars: BTreeMap::new(),
            egress,
        };
        admission()?;
        let created = tokio::time::timeout(
            Duration::from_secs(CREATE_ADMISSION_SECONDS),
            client.create_exact_sandbox(&request),
        )
        .await
        .map_err(|_| retryable("managed_desktop_provider_unknown_outcome"))?
        .map_err(api_error)?;
        // Return the resource ID before any second exchange can fail. The
        // service journals it then inspects effective TTL/ingress separately.
        Ok(CreatedDesktop {
            resource: ProviderDesktop {
                resource_id: created.sandbox_id,
                running: true,
                metadata: record.metadata(),
                template_id: created.template_id,
                deadline_at: None,
                kill_on_timeout: false,
                auto_resume: true,
                private_ingress: false,
                allow_out: Vec::new(),
                deny_out: Vec::new(),
            },
            secrets: DesktopSecrets {
                guest_token: secrets.guest_token.clone(),
                traffic_token: created.traffic_access_token,
                domain: created.domain,
                envd_token: created.envd_access_token,
            },
        })
    }
    async fn inspect(
        &self,
        _config: &ManagedDesktopConfig,
        key: &ProviderSecret,
        id: &str,
    ) -> Result<Option<ProviderDesktop>> {
        self.client(key)
            .get_sandbox(id)
            .await
            .map(|r| r.map(info))
            .map_err(api_error)
    }
    async fn list(
        &self,
        _config: &ManagedDesktopConfig,
        key: &ProviderSecret,
        metadata: &BTreeMap<String, String>,
    ) -> Result<Vec<ProviderDesktop>> {
        self.client(key)
            .list_sandboxes(metadata)
            .await
            .map(|r| r.into_iter().map(info).collect())
            .map_err(api_error)
    }
    async fn delete(
        &self,
        _config: &ManagedDesktopConfig,
        key: &ProviderSecret,
        id: &str,
    ) -> Result<()> {
        self.client(key)
            .delete_sandbox(id)
            .await
            .map(|_| ())
            .map_err(api_error)
    }
    async fn bootstrap(&self, record: &DesktopRecord, secrets: &DesktopSecrets) -> Result<()> {
        cognia_e2b::envd::start_desktop(&bootstrap_request(record, secrets)?)
            .await
            .map(|_| ())
            .map_err(|_| retryable("managed_desktop_bootstrap_unknown_outcome"))
    }
    async fn health(&self, record: &DesktopRecord, secrets: &DesktopSecrets) -> Result<()> {
        let resource = record
            .resource_id
            .as_deref()
            .ok_or_else(|| refused("managed_desktop_not_connected"))?;
        let endpoint = desktop_endpoint(resource, secrets.domain.as_deref())?;
        let token = secrets
            .traffic_token
            .as_deref()
            .ok_or_else(|| refused("managed_desktop_missing_endpoint_credentials"))?;
        let builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15));
        let client = cognia_net::proxy_config::managed_client(builder, endpoint.as_str())
            .map_err(|_| retryable("managed_desktop_network_policy"))?;
        let health = endpoint
            .join("cognia/health")
            .map_err(|_| refused("managed_desktop_endpoint_invalid"))?;
        // Both layers are proven independently: provider edge with no token,
        // then guest auth with valid edge token and absent guest credential.
        for edge_token in [None, Some(token)] {
            let mut request = client.get(health.clone());
            if let Some(token) = edge_token {
                request = request.header("e2b-traffic-access-token", sensitive(token)?);
            }
            let response = request
                .send()
                .await
                .map_err(|_| retryable("managed_desktop_health_unavailable"))?;
            if record.smoke {
                // Operator-only diagnostics: no endpoint, headers or body.
                eprintln!(
                    "smoke HTTP auth: edge_token_present={} status={}",
                    edge_token.is_some(),
                    response.status().as_u16(),
                );
            }
            require_auth_rejection(response.status().as_u16())?;
        }
        let mut response = client
            .get(health)
            .header("e2b-traffic-access-token", sensitive(token)?)
            .header("x-cognia-sandbox-token", sensitive(&secrets.guest_token)?)
            .send()
            .await
            .map_err(|_| retryable("managed_desktop_health_unavailable"))?;
        if !response.status().is_success() {
            if matches!(response.status().as_u16(), 502 | 503 | 504) {
                return Err(retryable("managed_desktop_health_unavailable"));
            }
            return Err(refused("managed_desktop_health_rejected"));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| retryable("managed_desktop_health_unavailable"))?
        {
            if body.len() + chunk.len() > 16_384 {
                return Err(refused("managed_desktop_health_invalid"));
            }
            body.extend_from_slice(&chunk);
        }
        let value: serde_json::Value =
            serde_json::from_slice(&body).map_err(|_| refused("managed_desktop_health_invalid"))?;
        if value["protocol"] != record.config.release.protocol
            || value["recipeRevision"] != record.config.release.recipe_revision
            || value["serverVersion"] != record.config.release.server_version
        {
            return Err(refused("managed_desktop_protocol_mismatch"));
        }
        screenshot_probe(endpoint, token, &secrets.guest_token).await
    }
}
fn require_auth_rejection(status: u16) -> Result<()> {
    match status {
        401 | 403 => Ok(()),
        // A process-start acknowledgement precedes the guest listener. Edge
        // upstream failures prove neither access nor denial: retry readiness
        // within the existing deadline, without restarting or extending it.
        502 | 503 | 504 => Err(retryable("managed_desktop_health_unavailable")),
        _ => Err(refused("managed_desktop_unauthenticated_endpoint")),
    }
}
pub(super) fn bootstrap_request(
    record: &DesktopRecord,
    secrets: &DesktopSecrets,
) -> Result<cognia_e2b::envd::DesktopBootstrap> {
    let resource = record
        .resource_id
        .clone()
        .ok_or_else(|| refused("managed_desktop_not_connected"))?;
    desktop_endpoint(&resource, secrets.domain.as_deref())?;
    Ok(cognia_e2b::envd::DesktopBootstrap {
        sandbox_id: resource,
        domain: secrets
            .domain
            .clone()
            .unwrap_or_else(|| "e2b.app".into()),
        envd_access_token: secrets
            .envd_token
            .clone()
            .ok_or_else(|| refused("managed_desktop_missing_endpoint_credentials"))?,
        traffic_access_token: secrets
            .traffic_token
            .clone()
            .ok_or_else(|| refused("managed_desktop_missing_endpoint_credentials"))?,
        guest_token: secrets.guest_token.clone(),
    })
}
fn sensitive(token: &str) -> Result<reqwest::header::HeaderValue> {
    let mut value = reqwest::header::HeaderValue::from_str(token)
        .map_err(|_| refused("managed_desktop_secret_invalid"))?;
    value.set_sensitive(true);
    Ok(value)
}
pub(super) fn desktop_endpoint(resource: &str, domain: Option<&str>) -> Result<Url> {
    if resource.is_empty()
        || !resource
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err(refused("managed_desktop_endpoint_invalid"));
    }
    // E2B omits/nulls the domain for its default hosted domain. Match the
    // official SDK fallback, while still rejecting any supplied foreign host.
    let domain = domain.unwrap_or("e2b.app");
    if !matches!(domain, "e2b.app" | "e2b.dev")
        && !domain.ends_with(".e2b.app")
        && !domain.ends_with(".e2b.dev")
    {
        return Err(refused("managed_desktop_endpoint_invalid"));
    }
    let url = Url::parse(&format!("https://8000-{resource}.{domain}/"))
        .map_err(|_| refused("managed_desktop_endpoint_invalid"))?;
    if url.host_str() != Some(format!("8000-{resource}.{domain}").as_str())
        || url.port().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(refused("managed_desktop_endpoint_invalid"));
    }
    Ok(url)
}
async fn screenshot_probe(mut endpoint: Url, traffic: &str, guest: &str) -> Result<()> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{
        client::IntoClientRequest,
        protocol::{Message, WebSocketConfig},
    };
    endpoint
        .set_scheme("wss")
        .map_err(|_| refused("managed_desktop_endpoint_invalid"))?;
    endpoint.set_path("/ws");
    let mut request = endpoint
        .as_str()
        .into_client_request()
        .map_err(|_| refused("managed_desktop_endpoint_invalid"))?;
    request
        .headers_mut()
        .insert("e2b-traffic-access-token", sensitive(traffic)?);
    request
        .headers_mut()
        .insert("x-cognia-sandbox-token", sensitive(guest)?);
    tokio::time::timeout(Duration::from_secs(20), async {
        // HTTP auth does not prove the WebSocket upgrade is protected.
        for edge in [None, Some(traffic)] {
            let mut probe = endpoint
                .as_str()
                .into_client_request()
                .map_err(|_| refused("managed_desktop_endpoint_invalid"))?;
            if let Some(token) = edge {
                probe
                    .headers_mut()
                    .insert("e2b-traffic-access-token", sensitive(token)?);
            }
            match tokio_tungstenite::connect_async(probe).await {
                Err(tokio_tungstenite::tungstenite::Error::Http(response))
                    if matches!(response.status().as_u16(), 401 | 403) => {}
                Ok((stream, _)) => {
                    drop(stream);
                    return Err(refused("managed_desktop_unauthenticated_endpoint"));
                }
                Err(_) => return Err(retryable("managed_desktop_health_unavailable")),
            }
        }
        let mut config = WebSocketConfig::default();
        config.max_message_size = Some(12 * 1024 * 1024);
        config.max_frame_size = Some(12 * 1024 * 1024);
        let (mut stream, _) =
            tokio_tungstenite::connect_async_with_config(request, Some(config), false)
                .await
                .map_err(|_| retryable("managed_desktop_health_unavailable"))?;
        stream
            .send(Message::Text(
                json!({"command":"screenshot","params":{}})
                    .to_string()
                    .into(),
            ))
            .await
            .map_err(|_| retryable("managed_desktop_health_unavailable"))?;
        while let Some(message) = stream.next().await {
            match message.map_err(|_| retryable("managed_desktop_health_unavailable"))? {
                Message::Text(text) => {
                    let value: serde_json::Value = serde_json::from_str(&text)
                        .map_err(|_| refused("managed_desktop_frame_invalid"))?;
                    let value = super::super::protocol::check_response(value)
                        .map_err(|_| refused("managed_desktop_frame_invalid"))?;
                    let data = value
                        .get("image_data")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| refused("managed_desktop_frame_invalid"))?;
                    validate_frame(data)?;
                    let _ = stream.close(None).await;
                    return Ok(());
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        Err(retryable("managed_desktop_health_unavailable"))
    })
    .await
    .map_err(|_| retryable("managed_desktop_health_timeout"))?
}
fn validate_frame(data: &str) -> Result<()> {
    use base64::Engine;
    if data.len() > 12 * 1024 * 1024 {
        return Err(refused("managed_desktop_frame_limit"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.strip_prefix("data:image/png;base64,").unwrap_or(data))
        .map_err(|_| refused("managed_desktop_frame_invalid"))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(refused("managed_desktop_frame_limit"));
    }
    let mut reader = xcap::image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| refused("managed_desktop_frame_invalid"))?;
    if !matches!(
        reader.format(),
        Some(xcap::image::ImageFormat::Png | xcap::image::ImageFormat::Jpeg)
    ) {
        return Err(refused("managed_desktop_frame_invalid"));
    }
    let mut limits = xcap::image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|_| refused("managed_desktop_frame_invalid"))?;
    if image.width() == 0 || image.height() == 0 {
        return Err(refused("managed_desktop_frame_invalid"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn readiness_requires_auth_denial_and_never_accepts_upstream_unavailability() {
        for status in [401, 403] {
            assert!(require_auth_rejection(status).is_ok());
        }
        for status in [502, 503, 504] {
            let error = require_auth_rejection(status).unwrap_err();
            assert!(error.retryable);
            assert_eq!(error.code, "managed_desktop_health_unavailable");
        }
        for status in [200, 204, 301, 302, 404, 500] {
            let error = require_auth_rejection(status).unwrap_err();
            assert!(!error.retryable);
            assert_eq!(error.code, "managed_desktop_unauthenticated_endpoint");
        }
    }
    struct TestImageVerifier;
    #[async_trait]
    impl ManagedDesktopImageVerifier for TestImageVerifier {
        async fn verify(&self, _: &DesktopRelease) -> Result<()> { Ok(()) }
    }
    #[tokio::test]
    async fn exact_build_response_cannot_spend_after_admission_is_revoked() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let fixture = super::super::service::tests::Fixture::new();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let provider = E2bDesktopProvider {
            base: Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap(),
            verifier: Arc::new(TestImageVerifier),
            verified_releases: tokio::sync::Mutex::new(Default::default()),
        };
        let now = chrono::Utc::now().timestamp_millis();
        let record = DesktopRecord {
            desktop: ManagedDesktop {
                id: "desktop".into(), provider_config_id: "e2b".into(), generation: 1,
                state: ManagedDesktopState::Creating, deadline_at: now + 60_000,
                idle_timeout_seconds: 600, created_at: now, updated_at: now,
                last_error_code: None, cleanup_attempts: 0, qualification: "smoke".into(),
            },
            template: TemplateIdentity {
                template_id: "template".into(), build_id: uuid::Uuid::new_v4().to_string(),
                image_digest: fixture.config.release.image_digest.clone(),
                recipe_revision: fixture.config.release.recipe_revision.clone(),
                protocol: fixture.config.release.protocol.clone(),
            },
            config: fixture.config.clone(), operation_id: "operation".into(),
            authorization_id: "authorization".into(), quote_id: "quote".into(),
            principal_id: "human".into(), source_id: None, resource_id: None,
            last_activity_at: now, next_retry_at: now, delete_requested: false, smoke: true,
            bootstrap_started: false, bootstrap_completed: false,
        };
        let live = Arc::new(AtomicBool::new(true));
        let check = live.clone();
        let admission: LifecycleAdmission = Arc::new(move || {
            if check.load(Ordering::SeqCst) { Ok(()) } else { Err(refused("managed_desktop_forbidden")) }
        });
        let serve_build = async {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 1024];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = stream.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                request.extend_from_slice(&chunk[..count]);
                assert!(request.len() < 16_384);
            }
            assert!(String::from_utf8_lossy(&request).starts_with("GET /templates/template/builds/"));
            live.store(false, Ordering::SeqCst);
            let body = serde_json::json!({"templateID":"template", "buildID":record.template.build_id, "status":"ready"}).to_string();
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}", body.len(), body);
            stream.write_all(response.as_bytes()).await.unwrap();
        };
        let key = ProviderSecret("local-test-only".into());
        let secrets = DesktopSecrets { guest_token: "guest".into(), traffic_token: None, domain: None, envd_token: None };
        let create = provider.create(&record, &key, &secrets, 60, admission);
        let ((), result) = tokio::time::timeout(Duration::from_secs(2), async { tokio::join!(serve_build, create) }).await.unwrap();
        assert_eq!(result.err().unwrap().code, "managed_desktop_forbidden");
        assert!(tokio::time::timeout(Duration::from_millis(20), listener.accept()).await.is_err());
    }
    #[test]
    fn endpoint_rejects_provider_supplied_url_poisoning() {
        assert_eq!(
            desktop_endpoint("abc", None).unwrap().as_str(),
            "https://8000-abc.e2b.app/"
        );
        assert_eq!(
            desktop_endpoint("abc", Some("e2b.app")).unwrap().as_str(),
            "https://8000-abc.e2b.app/"
        );
        for domain in [
            "",
            "evil.test",
            "e2b.app.evil.test",
            "e2b.app/path",
            "user@e2b.app",
            "e2b.app:443",
        ] {
            assert!(desktop_endpoint("abc", Some(domain)).is_err());
        }
        assert!(desktop_endpoint("abc/../../", Some("e2b.app")).is_err());
    }
    #[test]
    fn frames_are_decoded_and_secrets_are_redacted() {
        assert!(validate_frame("notbase64").is_err());
        use base64::Engine;
        assert!(
            validate_frame(&base64::engine::general_purpose::STANDARD.encode("not an image"))
                .is_err()
        );
        assert!(!format!("{:?}", ProviderSecret("credential".into())).contains("credential"));
    }
    #[test]
    fn delayed_build_validation_consumes_provisioning_budget_without_extending_deadline() {
        let deadline = 61_000;
        assert_eq!(provider_ttl(deadline, 1_000, 60).unwrap(), 45);
        // A slow exact-build GET consumed ten seconds before create POST.
        let ttl = provider_ttl(deadline, 11_000, 60).unwrap();
        assert_eq!(ttl, 35);
        // Even a POST taking its full admitted window remains within deadline.
        assert!(11_000 + (ttl + CREATE_ADMISSION_SECONDS) as i64 * 1000 <= deadline);
        assert!(provider_ttl(deadline, 46_000, 60).is_err());
    }
}
