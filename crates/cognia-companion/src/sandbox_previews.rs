//! Local-owner preview security boundary. A grant has a separate loopback
//! listener/origin, one-shot bootstrap and process-salted, hash-only secrets.
use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use cognia_sandbox_pool::{
    boot::PoolServices,
    runtime::{RuntimePort, SandboxRuntimeControl},
};
pub use cognia_task_workspace::{PreviewAudience, PreviewGrantV1, PreviewPort};
use cognia_task_workspace::{
    StoredPreviewGrant, TaskWorkspaceService, WorkspacePortLease, WorkspaceState,
    HOST_LOOPBACK_NAMESPACE,
};
use hmac::{Hmac, KeyInit, Mac};
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use rand::TryRng;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::{watch, Mutex};

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PreviewOriginMode {
    #[default]
    Localhost,
    /// Inert until the embedded browser supplies per-grant cookie storage.
    /// Different ports on 127.0.0.1 do not isolate browser cookies.
    Loopback,
}
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSandboxPreview {
    pub project_id: String,
    pub workspace_id: String,
    pub provider: String,
    pub container_id: String,
    pub port: PreviewPort,
    pub expires_in_seconds: Option<u32>,
    pub audience: Option<PreviewAudience>,
    #[serde(default)]
    pub origin_mode: PreviewOriginMode,
}
#[derive(Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct CreatedSandboxPreview {
    pub grant: PreviewGrantV1,
    pub bootstrap_url: String,
}
impl std::fmt::Debug for CreatedSandboxPreview {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreatedSandboxPreview")
            .field("grant", &self.grant)
            .field("bootstrap_url", &"[redacted]")
            .finish()
    }
}
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct SandboxPreviewTarget {
    pub workspace_id: String,
    pub provider: String,
    pub container_id: String,
    pub execution_root: String,
    pub ports: Vec<RuntimePort>,
    pub workspace_state: WorkspaceState,
    pub port_lease: Option<WorkspacePortLease>,
}
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct SandboxPreviewContext {
    pub targets: Vec<SandboxPreviewTarget>,
    pub snapshot_usage_bytes: u64,
    pub sandbox_snapshot_budget_bytes: u64,
}

pub struct PreviewService {
    workspaces: Arc<TaskWorkspaceService>,
    runtime: Arc<dyn SandboxRuntimeControl>,
    deployment: String,
    salt: [u8; 32],
    operation: Mutex<()>,
    live: RwLock<HashMap<String, watch::Sender<bool>>>,
}
static SERVICE: Lazy<RwLock<Option<Arc<PreviewService>>>> = Lazy::new(|| RwLock::new(None));
pub fn installed() -> Result<Arc<PreviewService>, String> {
    SERVICE
        .read()
        .clone()
        .ok_or_else(|| "preview_unavailable".into())
}
fn random_secret() -> Result<[u8; 32], String> {
    let mut value = [0; 32];
    rand::rngs::SysRng
        .try_fill_bytes(&mut value)
        .map_err(|_| "preview_entropy_unavailable")?;
    Ok(value)
}
fn token() -> Result<String, String> {
    Ok(URL_SAFE_NO_PAD.encode(random_secret()?))
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn duration(seconds: Option<u32>) -> Result<u32, String> {
    match seconds.unwrap_or(900) {
        0 => Err("preview_expiry_invalid".into()),
        n if n > 3600 => Err("preview_expiry_maximum_one_hour".into()),
        n => Ok(n),
    }
}
fn require_owner() -> Result<(), String> {
    if super::workspace_access::host_owner() {
        Ok(())
    } else {
        Err("preview_local_owner_required".into())
    }
}
fn require_audience(audience: &PreviewAudience) -> Result<(), String> {
    match audience {
        PreviewAudience::LocalOwner => Ok(()),
        PreviewAudience::PairedDevice { .. } => Err("preview_paired_device_phase_2".into()),
    }
}
fn mac(salt: &[u8; 32], id: &str, purpose: &str, token: &str) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(salt).expect("HMAC accepts 256 bit key");
    mac.update(id.as_bytes());
    mac.update(&[0]);
    mac.update(purpose.as_bytes());
    mac.update(&[0]);
    mac.update(token.as_bytes());
    mac
}
fn hash(salt: &[u8; 32], id: &str, purpose: &str, token: &str) -> String {
    hex::encode(mac(salt, id, purpose, token).finalize().into_bytes())
}
fn matches(salt: &[u8; 32], id: &str, purpose: &str, token: &str, expected: Option<&str>) -> bool {
    let Some(expected) = expected.and_then(|value| hex::decode(value).ok()) else {
        return false;
    };
    mac(salt, id, purpose, token)
        .verify_slice(&expected)
        .is_ok()
}
fn active(grant: &PreviewGrantV1, time: i64) -> bool {
    grant.version == 1
        && !grant.revoked
        && time < grant.expires_at
        && require_audience(&grant.audience).is_ok()
        && grant
            .origin
            .strip_prefix(&format!("http://p-{}.localhost:", grant.id))
            .and_then(|port| port.parse::<u16>().ok())
            .is_some_and(|port| port != 0)
}

/// Called before snapshot maintenance starts. Restart rotates the salt and
/// tombstones old grants; no listener or cookie survives Host restart.
pub fn install(
    workspaces: Arc<TaskWorkspaceService>,
    pool: PoolServices,
) -> Result<Option<Arc<PreviewService>>, String> {
    let Some(runtime) = pool.runtime else {
        return Ok(None);
    };
    let deployment = pool.status.deployment_id().to_string();
    invalidate_persisted(&workspaces, &deployment)?;
    let service = Arc::new(PreviewService {
        workspaces,
        runtime,
        deployment,
        salt: random_secret()?,
        operation: Mutex::new(()),
        live: RwLock::new(HashMap::new()),
    });
    if let Some(previous) = SERVICE.write().replace(service.clone()) {
        for cancel in previous.live.read().values() {
            cancel.send_replace(true);
        }
    }
    Ok(Some(service))
}
fn invalidate_persisted(workspaces: &TaskWorkspaceService, deployment: &str) -> Result<(), String> {
    for mut record in workspaces.preview_grants(deployment)? {
        let previous = record.grant.revision;
        record.grant.revision += 1;
        record.grant.revoked = true;
        record.bootstrap_hash = None;
        record.session_hash = None;
        workspaces.store_preview_grant(deployment, &record, Some(previous))?;
    }
    Ok(())
}
impl PreviewService {
    pub async fn context(&self, project: &str) -> Result<SandboxPreviewContext, String> {
        require_owner()?;
        let ports = self
            .runtime
            .list_ports(project)
            .await
            .map_err(|e| e.message)?;
        let mut targets = Vec::new();
        for workspace in self.workspaces.list_managed_workspaces()? {
            if workspace.project_id.as_deref() != Some(project)
                || workspace.state != WorkspaceState::Active
            {
                continue;
            }
            let Some(container_id) = self
                .runtime
                .snapshot_runtime_for_workspace("local", &workspace.execution_root)
                .await
                .map_err(|e| e.message)?
            else {
                continue;
            };
            if self
                .runtime
                .inspect_snapshot_source("local", &container_id, project, &workspace.execution_root)
                .await
                .is_err()
            {
                continue;
            }
            let port_lease = self
                .workspaces
                .read_workspace_port_lease(&workspace.workspace_id, HOST_LOOPBACK_NAMESPACE)
                .map_err(|e| e.to_string())?;
            targets.push(SandboxPreviewTarget {
                workspace_id: workspace.workspace_id,
                provider: "local".into(),
                ports: ports
                    .iter()
                    .filter(|port| port.container_id == container_id)
                    .cloned()
                    .collect(),
                container_id,
                execution_root: workspace.execution_root,
                workspace_state: workspace.state,
                port_lease,
            });
        }
        Ok(SandboxPreviewContext {
            targets,
            snapshot_usage_bytes: self
                .workspaces
                .sandbox_snapshot_usage_bytes(&self.deployment)?,
            sandbox_snapshot_budget_bytes: self
                .workspaces
                .workspace_lifecycle_policy()
                .sandbox_snapshot_budget_bytes,
        })
    }
    pub fn list(
        &self,
        project: &str,
        workspace: Option<&str>,
    ) -> Result<Vec<PreviewGrantV1>, String> {
        require_owner()?;
        Ok(self
            .workspaces
            .preview_grants(&self.deployment)?
            .into_iter()
            .map(|record| record.grant)
            .filter(|grant| {
                grant.project_id == project && workspace.is_none_or(|id| grant.workspace_id == id)
            })
            .collect())
    }
    async fn validate(&self, grant: &PreviewGrantV1) -> Result<(), String> {
        let remaining = grant.expires_at.saturating_sub(now()).max(0) as u64;
        tokio::time::timeout(
            Duration::from_millis(remaining.min(2000)),
            self.validate_inner(grant),
        )
        .await
        .map_err(|_| "preview_admission_timeout".to_string())?
    }
    async fn validate_inner(&self, grant: &PreviewGrantV1) -> Result<(), String> {
        require_owner()?;
        if !active(grant, now()) {
            return Err("preview_expired_or_revoked".into());
        }
        let workspace = self
            .workspaces
            .get_managed_workspace(&grant.workspace_id)?
            .ok_or("preview_workspace_missing")?;
        if workspace.project_id.as_deref() != Some(&grant.project_id)
            || workspace.state != WorkspaceState::Active
        {
            return Err("preview_workspace_owner_changed".into());
        }
        let lease = self
            .workspaces
            .read_workspace_port_lease(&grant.workspace_id, HOST_LOOPBACK_NAMESPACE)
            .map_err(|e| e.to_string())?;
        if grant
            .port_lease
            .as_ref()
            .map(|lease| (&lease.lease_id, lease.base_port, lease.port_count))
            != lease
                .as_ref()
                .map(|lease| (&lease.lease_id, lease.base_port, lease.port_count))
            || grant.port.resolve(lease.as_ref())? != grant.resolved_port
        {
            return Err("preview_port_lease_changed".into());
        }
        let generation = self
            .runtime
            .preview_runtime_generation(
                &grant.provider,
                &grant.container_id,
                &grant.project_id,
                &workspace.execution_root,
            )
            .await
            .map_err(|e| e.message)?;
        if generation != grant.runtime_generation {
            return Err("preview_runtime_generation_changed".into());
        }
        if !self
            .runtime
            .port_allowed(&grant.project_id, &grant.container_id, grant.resolved_port)
            .await
            .map_err(|e| e.message)?
        {
            return Err("preview_port_not_approved".into());
        }
        Ok(())
    }
    pub async fn create(
        self: &Arc<Self>,
        request: CreateSandboxPreview,
    ) -> Result<CreatedSandboxPreview, String> {
        require_owner()?;
        // Preserve the fallback wire variant, but never issue a capability on
        // a shared cookie host until browser storage isolation is available.
        if matches!(request.origin_mode, PreviewOriginMode::Loopback) {
            return Err("preview_origin_isolation_unavailable".into());
        }
        let lifetime = duration(request.expires_in_seconds)?;
        let audience = request.audience.unwrap_or(PreviewAudience::LocalOwner);
        require_audience(&audience)?;
        if request.provider != "local" {
            return Err("preview_provider_unsupported".into());
        }
        let workspace = self
            .workspaces
            .get_managed_workspace(&request.workspace_id)?
            .ok_or("preview_workspace_missing")?;
        if workspace.project_id.as_deref() != Some(&request.project_id)
            || workspace.state != WorkspaceState::Active
        {
            return Err("preview_workspace_owner_changed".into());
        }
        let port_lease = self
            .workspaces
            .read_workspace_port_lease(&request.workspace_id, HOST_LOOPBACK_NAMESPACE)
            .map_err(|e| e.to_string())?;
        let resolved_port = request.port.resolve(port_lease.as_ref())?;
        let runtime_generation = self
            .runtime
            .preview_runtime_generation(
                &request.provider,
                &request.container_id,
                &request.project_id,
                &workspace.execution_root,
            )
            .await
            .map_err(|e| e.message)?;
        let id = uuid::Uuid::new_v4().simple().to_string();
        // Separate listener from the Companion API. The fallback address is
        // intentionally inert until it can preserve per-grant cookie isolation.
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| format!("preview_listener_failed: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let host = format!("p-{id}.localhost");
        let time = now();
        let grant = PreviewGrantV1 {
            version: 1,
            id: id.clone(),
            project_id: request.project_id,
            workspace_id: request.workspace_id,
            provider: request.provider,
            container_id: request.container_id,
            runtime_generation,
            port: request.port,
            resolved_port,
            port_lease,
            audience,
            created_at: time,
            expires_at: time + i64::from(lifetime) * 1000,
            revision: 1,
            revoked: false,
            origin: format!("http://{host}:{port}"),
        };
        self.validate(&grant).await?;
        let secret = token()?;
        let record = StoredPreviewGrant {
            bootstrap_hash: Some(hash(&self.salt, &id, "bootstrap", &secret)),
            bootstrap_expires_at: time + 60_000,
            session_hash: None,
            grant: grant.clone(),
        };
        let _guard = self.operation.lock().await;
        self.workspaces
            .store_preview_grant(&self.deployment, &record, None)?;
        let (cancel, shutdown) = watch::channel(false);
        self.live.write().insert(id.clone(), cancel);
        tokio::spawn(self.clone().monitor(id.clone(), shutdown));
        let mut shutdown = self.live.read()[&id].subscribe();
        let app = Router::new()
            .fallback(preview_handler)
            .with_state((self.clone(), id));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    if !*shutdown.borrow() {
                        let _ = shutdown.changed().await;
                    }
                })
                .await;
        });
        Ok(CreatedSandboxPreview {
            bootstrap_url: format!("{}/__cognia_bootstrap#{secret}", grant.origin),
            grant,
        })
    }
    async fn monitor(self: Arc<Self>, monitor_id: String, mut shutdown: watch::Receiver<bool>) {
        loop {
            tokio::select! {_ = shutdown.changed()=>break,_ = tokio::time::sleep(Duration::from_millis(250))=>{}}
            let valid = match self.workspaces.preview_grant(&self.deployment, &monitor_id) {
                Ok(record) => {
                    let remaining = record.grant.expires_at.saturating_sub(now()).max(0) as u64;
                    tokio::select! {
                        _=shutdown.changed()=>break,
                        result=tokio::time::timeout(Duration::from_millis(remaining.min(2000)),self.validate(&record.grant))=>result.is_ok_and(|result|result.is_ok()),
                    }
                }
                Err(_) => false,
            };
            if !valid {
                let _ = self.revoke_internal(&monitor_id).await;
                break;
            }
        }
    }
    pub async fn open(&self, id: &str) -> Result<CreatedSandboxPreview, String> {
        require_owner()?;
        let _guard = self.operation.lock().await;
        let mut record = self.workspaces.preview_grant(&self.deployment, id)?;
        self.validate(&record.grant).await?;
        if !self.live.read().contains_key(id) {
            return Err("preview_restart_invalidated".into());
        }
        let secret = token()?;
        let previous = record.grant.revision;
        record.grant.revision += 1;
        record.bootstrap_hash = Some(hash(&self.salt, id, "bootstrap", &secret));
        record.bootstrap_expires_at = (now() + 60_000).min(record.grant.expires_at);
        self.workspaces
            .store_preview_grant(&self.deployment, &record, Some(previous))?;
        Ok(CreatedSandboxPreview {
            bootstrap_url: format!("{}/__cognia_bootstrap#{secret}", record.grant.origin),
            grant: record.grant,
        })
    }
    pub async fn revoke(&self, id: &str) -> Result<PreviewGrantV1, String> {
        require_owner()?;
        self.revoke_internal(id).await
    }
    async fn revoke_internal(&self, id: &str) -> Result<PreviewGrantV1, String> {
        // Cancellation must not queue behind admission/Docker awaits in redeem.
        if let Some(cancel) = self.live.write().remove(id) {
            cancel.send_replace(true);
        }
        let _guard = self.operation.lock().await;
        let mut record = self.workspaces.preview_grant(&self.deployment, id)?;
        if !record.grant.revoked {
            let previous = record.grant.revision;
            record.grant.revoked = true;
            record.grant.revision += 1;
            record.bootstrap_hash = None;
            record.session_hash = None;
            self.workspaces
                .store_preview_grant(&self.deployment, &record, Some(previous))?;
        }
        Ok(record.grant)
    }
    async fn redeem(&self, id: &str, secret: &str) -> Result<(PreviewGrantV1, String), String> {
        let _guard = self.operation.lock().await;
        let mut record = self.workspaces.preview_grant(&self.deployment, id)?;
        self.validate(&record.grant).await?;
        if !self.live.read().contains_key(id) {
            return Err("preview_revoked".into());
        }
        if now() >= record.bootstrap_expires_at
            || !matches(
                &self.salt,
                id,
                "bootstrap",
                secret,
                record.bootstrap_hash.as_deref(),
            )
        {
            return Err("preview_bootstrap_invalid".into());
        }
        let session = token()?;
        let previous = record.grant.revision;
        record.grant.revision += 1;
        record.bootstrap_hash = None;
        record.session_hash = Some(hash(&self.salt, id, "session", &session));
        self.workspaces
            .store_preview_grant(&self.deployment, &record, Some(previous))?;
        Ok((record.grant, session))
    }
}
#[async_trait::async_trait]
impl super::sandbox_snapshots::SnapshotPreviewRevoker for PreviewService {
    async fn revoke_snapshot(&self, deployment: &str, snapshot_id: &str) -> Result<(), String> {
        if deployment != self.deployment {
            return Err("preview_deployment_mismatch".into());
        }
        let snapshot = self
            .workspaces
            .list_sandbox_snapshots(deployment)?
            .into_iter()
            .find(|snapshot| snapshot.snapshot_id == snapshot_id)
            .ok_or("snapshot_not_found")?;
        let references = self
            .workspaces
            .list_sandbox_snapshot_references(deployment, snapshot_id)?;
        for record in self.workspaces.preview_grants(deployment)? {
            let grant = record.grant;
            if grant.revoked {
                continue;
            }
            let workspace = self.workspaces.get_managed_workspace(&grant.workspace_id)?;
            let source = workspace
                .is_some_and(|workspace| workspace.execution_root == snapshot.workspace_root);
            if source
                || references.iter().any(|(kind, owner)| {
                    (kind == "runtime" && owner == &grant.container_id)
                        || (kind == "fork" && owner == &grant.workspace_id)
                })
            {
                self.revoke_internal(&grant.id).await?;
            }
        }
        Ok(())
    }
}
const BOOTSTRAP: &str = r#"<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><body><output id="status"></output><script>(async()=>{const token=location.hash.slice(1);history.replaceState(null,'','/__cognia_bootstrap');const response=await fetch('/__cognia_bootstrap',{method:'POST',headers:{'content-type':'text/plain'},credentials:'same-origin',body:token});if(response.ok)location.replace('/');else document.getElementById('status').textContent='preview_unavailable';})().catch(()=>{document.getElementById('status').textContent='preview_unavailable';});</script>"#;
fn cookie_name(id: &str) -> String {
    format!("cognia_preview_{id}")
}
fn security_headers(response: &mut Response) {
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
}
fn host_matches(headers: &HeaderMap, origin: &str) -> bool {
    let mut hosts = headers.get_all("host").iter();
    hosts.next().and_then(|value| value.to_str().ok()) == origin.strip_prefix("http://")
        && hosts.next().is_none()
}
fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<_> = headers
        .get_all("cookie")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .filter(|(key, _)| *key == name)
        .map(|(_, value)| value.to_string())
        .collect();
    if values.len() == 1 {
        values.into_iter().next()
    } else {
        None
    }
}
fn strip_preview_cookies(headers: &mut HeaderMap) {
    let cookies = headers
        .get_all("cookie")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .map(str::trim)
        .filter(|pair| {
            pair.split_once('=')
                .is_some_and(|(name, _)| !name.starts_with("cognia_preview_"))
        })
        .collect::<Vec<_>>()
        .join("; ");
    headers.remove("cookie");
    if !cookies.is_empty() {
        if let Ok(value) = HeaderValue::from_str(&cookies) {
            headers.insert("cookie", value);
        }
    }
}
fn strip_preview_credentials(headers: &mut HeaderMap) {
    // The caller has already checked this origin against this grant. Preserve
    // it for application CSRF/WebSocket checks, while removing Host authority.
    let origin = headers.get("origin").cloned();
    strip_preview_cookies(headers);
    super::environment_ports::strip_private_headers(headers, true);
    if let Some(origin) = origin {
        headers.insert("origin", origin);
    }
}
async fn preview_handler(
    State((service, id)): State<(Arc<PreviewService>, String)>,
    mut request: Request,
) -> Response {
    let cancellation = service.live.read().get(&id).map(watch::Sender::subscribe);
    let mut response = match cancellation {
        Some(mut cancel) if !*cancel.borrow() => tokio::select! {
            response=handle(&service,&id,&mut request)=>response,
            _=cancel.changed()=>StatusCode::GONE.into_response(),
        },
        _ => StatusCode::GONE.into_response(),
    };
    security_headers(&mut response);
    response
}
async fn handle(service: &PreviewService, id: &str, request: &mut Request) -> Response {
    let record = match service.workspaces.preview_grant(&service.deployment, id) {
        Ok(record) => record,
        Err(_) => return StatusCode::GONE.into_response(),
    };
    if !host_matches(request.headers(), &record.grant.origin) {
        return StatusCode::MISDIRECTED_REQUEST.into_response();
    }
    if service.validate(&record.grant).await.is_err() {
        return StatusCode::GONE.into_response();
    }
    if request.uri().path() == "/__cognia_bootstrap" {
        if request.uri().query().is_some() {
            return StatusCode::BAD_REQUEST.into_response();
        }
        if request.method() == Method::GET {
            let mut response = axum::response::Html(BOOTSTRAP).into_response();
            response.headers_mut().insert("content-security-policy",HeaderValue::from_static("default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"));
            return response;
        }
        if request.method() != Method::POST {
            return StatusCode::METHOD_NOT_ALLOWED.into_response();
        }
        if request
            .headers()
            .get("origin")
            .and_then(|v| v.to_str().ok())
            != Some(record.grant.origin.as_str())
            || request
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                != Some("text/plain")
        {
            return StatusCode::FORBIDDEN.into_response();
        }
        let body = std::mem::replace(request.body_mut(), Body::empty());
        let bytes = match axum::body::to_bytes(body, 128).await {
            Ok(bytes) => bytes,
            Err(_) => return StatusCode::BAD_REQUEST.into_response(),
        };
        let secret = match std::str::from_utf8(&bytes) {
            Ok(secret) => secret,
            Err(_) => return StatusCode::BAD_REQUEST.into_response(),
        };
        let (grant, session) = match service.redeem(id, secret).await {
            Ok(value) => value,
            Err(_) => return StatusCode::GONE.into_response(),
        };
        let mut response = StatusCode::NO_CONTENT.into_response();
        response.headers_mut().insert(
            "set-cookie",
            HeaderValue::from_str(&format!(
                "{}={session}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}",
                cookie_name(id),
                (grant.expires_at - now()).max(0) / 1000
            ))
            .expect("generated cookie"),
        );
        return response;
    }
    let Some(session) = cookie(request.headers(), &cookie_name(id)) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !matches(
        &service.salt,
        id,
        "session",
        &session,
        record.session_hash.as_deref(),
    ) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(cancel) = service.live.read().get(id).map(watch::Sender::subscribe) else {
        return StatusCode::GONE.into_response();
    };
    // WS handshakes carry Origin; ordinary same-origin navigations may omit it.
    if request
        .headers()
        .get("origin")
        .is_some_and(|origin| origin.to_str().ok() != Some(record.grant.origin.as_str()))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    strip_preview_credentials(request.headers_mut());
    let request = std::mem::replace(request, Request::new(Body::empty()));
    let mut response = super::environment_ports::preview_relay(
        record.grant.project_id,
        record.grant.container_id,
        record.grant.resolved_port,
        request,
        cancel,
    )
    .await;
    // The application cannot overwrite a Host cookie or broaden its cookie
    // domain to another grant. Application cookies remain host-only.
    let cookies: Vec<_> = response
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter(|value| !value.trim_start().starts_with("cognia_preview_"))
        .map(|value| {
            value
                .split(';')
                .filter(|part| {
                    !part
                        .split_once('=')
                        .is_some_and(|(name, _)| name.trim().eq_ignore_ascii_case("domain"))
                })
                .collect::<Vec<_>>()
                .join(";")
        })
        .filter_map(|value| HeaderValue::from_str(&value).ok())
        .collect();
    response.headers_mut().remove("set-cookie");
    for cookie in cookies {
        response.headers_mut().append("set-cookie", cookie);
    }
    response
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use cognia_external_agent::sandbox_routing_backend::SandboxSpawnError;
    use cognia_task_workspace::{BeginSandboxSnapshot, ServiceConfig};
    use std::sync::atomic::{AtomicBool, Ordering};
    pub(crate) struct TestRuntime {
        generation: RwLock<String>,
        allowed: AtomicBool,
        stalled: AtomicBool,
    }
    #[async_trait::async_trait]
    impl SandboxRuntimeControl for TestRuntime {
        async fn inspect_snapshot_image(
            &self,
            _: &str,
            _: &str,
        ) -> Result<Option<cognia_sandbox_pool::runtime::SnapshotImage>, SandboxSpawnError>
        {
            Ok(None)
        }
        async fn preview_runtime_generation(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &str,
        ) -> Result<String, SandboxSpawnError> {
            if self.stalled.load(Ordering::SeqCst) {
                std::future::pending::<()>().await;
            }
            Ok(self.generation.read().clone())
        }
        async fn list_ports(&self, _: &str) -> Result<Vec<RuntimePort>, SandboxSpawnError> {
            Ok(Vec::new())
        }
        async fn port_allowed(&self, _: &str, _: &str, _: u16) -> Result<bool, SandboxSpawnError> {
            Ok(self.allowed.load(Ordering::SeqCst))
        }
        async fn open_port(
            &self,
            _: &str,
            _: &str,
            _: u16,
        ) -> Result<tokio::io::DuplexStream, SandboxSpawnError> {
            Err(SandboxSpawnError::refused(
                "test",
                "No socket in bootstrap fixture",
            ))
        }
    }
    pub(crate) struct Fixture {
        pub(crate) dir: tempfile::TempDir,
        pub(crate) service: Arc<PreviewService>,
        runtime: Arc<TestRuntime>,
        pub(crate) record: StoredPreviewGrant,
        secret: String,
    }
    impl Fixture {
        pub(crate) fn workspaces(&self) -> Arc<TaskWorkspaceService> {
            self.service.workspaces.clone()
        }
        pub(crate) fn runtime(&self) -> Arc<dyn SandboxRuntimeControl> {
            self.runtime.clone()
        }
        pub(crate) fn cancellation(&self) -> watch::Receiver<bool> {
            self.service.live.read()[&self.record.grant.id].subscribe()
        }
        pub(crate) fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let data = dir.path().join("data");
            let workspaces =
                Arc::new(TaskWorkspaceService::open(ServiceConfig::new(data.clone())).unwrap());
            let root = dir.path().join("workspace");
            std::fs::create_dir(&root).unwrap();
            let root = root.canonicalize().unwrap();
            // Seed a real Host ledger registry row without allocating/probing a socket.
            let connection =
                rusqlite::Connection::open(data.join("task-workspaces/task-workspaces.sqlite"))
                    .unwrap();
            connection.execute("INSERT INTO workspace_registry(workspace_id,project_id,owner_type,state,source_root,base_kind,isolation_kind,execution_root,last_used_at,created_at) VALUES ('workspace','project','user','active',?1,'workingState','shadow',?1,0,0)",[root.to_str().unwrap()]).unwrap();
            let runtime = Arc::new(TestRuntime {
                generation: RwLock::new("generation-1".into()),
                allowed: AtomicBool::new(true),
                stalled: AtomicBool::new(false),
            });
            let service = Arc::new(PreviewService {
                workspaces,
                runtime: runtime.clone(),
                deployment: "deployment".into(),
                salt: random_secret().unwrap(),
                operation: Mutex::new(()),
                live: RwLock::new(HashMap::new()),
            });
            let id = uuid::Uuid::new_v4().simple().to_string();
            let secret = token().unwrap();
            let grant = PreviewGrantV1 {
                version: 1,
                id: id.clone(),
                project_id: "project".into(),
                workspace_id: "workspace".into(),
                provider: "local".into(),
                container_id: "container".into(),
                runtime_generation: "generation-1".into(),
                port: PreviewPort::Fixed { port: 3000 },
                resolved_port: 3000,
                port_lease: None,
                audience: PreviewAudience::LocalOwner,
                created_at: now(),
                expires_at: now() + 900_000,
                revision: 1,
                revoked: false,
                origin: format!("http://p-{id}.localhost:42000"),
            };
            let record = StoredPreviewGrant {
                bootstrap_hash: Some(hash(&service.salt, &id, "bootstrap", &secret)),
                bootstrap_expires_at: now() + 60_000,
                session_hash: None,
                grant,
            };
            service
                .workspaces
                .store_preview_grant(&service.deployment, &record, None)
                .unwrap();
            let (cancel, _) = watch::channel(false);
            service.live.write().insert(id, cancel);
            Self {
                dir,
                service,
                runtime,
                record,
                secret,
            }
        }
        fn request(&self, method: Method, body: &str) -> Request {
            Request::builder()
                .method(method)
                .uri("/__cognia_bootstrap")
                .header(
                    "host",
                    self.record.grant.origin.strip_prefix("http://").unwrap(),
                )
                .header("origin", &self.record.grant.origin)
                .header("content-type", "text/plain")
                .body(Body::from(body.to_string()))
                .unwrap()
        }
    }
    #[test]
    fn preview_duration_and_phase_two_audience_are_bounded() {
        assert_eq!(duration(None).unwrap(), 900);
        assert_eq!(duration(Some(3600)).unwrap(), 3600);
        assert!(duration(Some(3601)).is_err());
        assert!(duration(Some(0)).is_err());
        assert!(require_audience(&PreviewAudience::PairedDevice {
            device_id: "paired".into()
        })
        .unwrap_err()
        .contains("phase_2"));
    }
    #[test]
    fn preview_hash_is_process_salted_domain_separated_and_256_bit_random() {
        let salt = random_secret().unwrap();
        let secret = token().unwrap();
        assert_eq!(URL_SAFE_NO_PAD.decode(&secret).unwrap().len(), 32);
        let digest = hash(&salt, "id", "bootstrap", &secret);
        assert!(!digest.contains(&secret));
        assert!(matches(&salt, "id", "bootstrap", &secret, Some(&digest)));
        assert!(!matches(
            &random_secret().unwrap(),
            "id",
            "bootstrap",
            &secret,
            Some(&digest)
        ));
        assert!(!matches(
            &salt,
            "other",
            "bootstrap",
            &secret,
            Some(&digest)
        ));
        assert!(!matches(&salt, "id", "session", &secret, Some(&digest)));
    }
    #[tokio::test]
    async fn preview_bootstrap_exchange_is_single_use_host_bound_and_hash_only() {
        let fixture = Fixture::new();
        let id = &fixture.record.grant.id;
        let mut wrong = fixture.request(Method::POST, &fixture.secret);
        wrong
            .headers_mut()
            .insert("host", HeaderValue::from_static("attacker.example:42000"));
        assert_eq!(
            handle(&fixture.service, id, &mut wrong).await.status(),
            StatusCode::MISDIRECTED_REQUEST
        );
        let mut cross = fixture.request(Method::POST, &fixture.secret);
        cross
            .headers_mut()
            .insert("origin", HeaderValue::from_static("http://evil.localhost"));
        assert_eq!(
            handle(&fixture.service, id, &mut cross).await.status(),
            StatusCode::FORBIDDEN
        );
        let mut good = fixture.request(Method::POST, &fixture.secret);
        let response = handle(&fixture.service, id, &mut good).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let cookie = response.headers()["set-cookie"].to_str().unwrap();
        assert!(cookie.contains("HttpOnly; SameSite=Strict; Path=/"));
        assert!(!cookie.contains("Domain"));
        let session = cookie.split(';').next().unwrap().split_once('=').unwrap().1;
        assert_eq!(
            handle(
                &fixture.service,
                id,
                &mut fixture.request(Method::POST, &fixture.secret)
            )
            .await
            .status(),
            StatusCode::GONE
        );
        let record = fixture
            .service
            .workspaces
            .preview_grant("deployment", id)
            .unwrap();
        assert!(record.bootstrap_hash.is_none());
        assert_eq!(record.grant.revision, 2);
        let connection = rusqlite::Connection::open(
            fixture
                .dir
                .path()
                .join("data/task-workspaces/task-workspaces.sqlite"),
        )
        .unwrap();
        let payload: String = connection
            .query_row(
                "SELECT payload FROM sandbox_preview_grants WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!payload.contains(&fixture.secret));
        assert!(!payload.contains(session));
        assert!(matches(
            &fixture.service.salt,
            id,
            "session",
            session,
            record.session_hash.as_deref()
        ));
        assert!(!matches(
            &random_secret().unwrap(),
            id,
            "session",
            session,
            record.session_hash.as_deref()
        ));
        let response = CreatedSandboxPreview {
            grant: record.grant,
            bootstrap_url: format!("http://local/#{}", fixture.secret),
        };
        assert!(!format!("{response:?}").contains(&fixture.secret));
    }
    #[tokio::test]
    async fn preview_restart_tombstones_ledger_and_discards_all_secret_hashes() {
        let fixture = Fixture::new();
        let id = &fixture.record.grant.id;
        fixture.service.redeem(id, &fixture.secret).await.unwrap();
        let before = fixture
            .service
            .workspaces
            .preview_grant("deployment", id)
            .unwrap();
        assert!(before.session_hash.is_some());
        invalidate_persisted(&fixture.service.workspaces, "deployment").unwrap();
        let after = fixture
            .service
            .workspaces
            .preview_grant("deployment", id)
            .unwrap();
        assert!(after.grant.revoked);
        assert_eq!(after.grant.revision, before.grant.revision + 1);
        assert!(after.bootstrap_hash.is_none());
        assert!(after.session_hash.is_none());
        assert!(fixture.service.open(id).await.is_err());
    }
    #[tokio::test]
    async fn preview_bootstrap_expiry_grant_expiry_generation_and_approval_are_rechecked() {
        let fixture = Fixture::new();
        let mut record = fixture.record.clone();
        let id = &record.grant.id;
        record.grant.revision += 1;
        record.bootstrap_expires_at = now() - 1;
        fixture
            .service
            .workspaces
            .store_preview_grant("deployment", &record, Some(1))
            .unwrap();
        assert!(fixture.service.redeem(id, &fixture.secret).await.is_err());
        assert!(fixture.service.validate(&record.grant).await.is_ok());
        *fixture.runtime.generation.write() = "generation-2".into();
        assert!(fixture
            .service
            .validate(&record.grant)
            .await
            .unwrap_err()
            .contains("generation"));
        *fixture.runtime.generation.write() = "generation-1".into();
        fixture.runtime.allowed.store(false, Ordering::SeqCst);
        assert!(fixture
            .service
            .validate(&record.grant)
            .await
            .unwrap_err()
            .contains("approved"));
        fixture.runtime.allowed.store(true, Ordering::SeqCst);
        record.grant.expires_at = now();
        assert!(!active(&record.grant, now()));
        let mut cancel = fixture.service.live.read()[id].subscribe();
        fixture.service.revoke(id).await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), cancel.changed())
            .await
            .unwrap()
            .unwrap();
        assert!(*cancel.borrow());
        assert!(fixture.service.open(id).await.is_err());
    }
    #[tokio::test]
    async fn preview_reaper_hook_revokes_source_and_fork_grants() {
        use super::super::sandbox_snapshots::SnapshotPreviewRevoker;
        let fixture = Fixture::new();
        let source = fixture.dir.path().join("workspace");
        fixture
            .service
            .workspaces
            .begin_sandbox_snapshot(&BeginSandboxSnapshot {
                snapshot_id: "018ef64a-84d0-7000-8000-000000000001".into(),
                deployment_id: "deployment".into(),
                project_id: "project".into(),
                task_id: "task".into(),
                workspace_root: source.to_string_lossy().into(),
                runtime: serde_json::json!({"provider":"local"}),
                exclusions: Vec::new(),
            })
            .unwrap();
        let snapshot_id = "018ef64a-84d0-7000-8000-000000000001";
        std::fs::write(source.join("index.html"), "preview source").unwrap();
        fixture
            .service
            .workspaces
            .capture_sandbox_snapshot_checkpoint("deployment", snapshot_id)
            .unwrap();
        fixture
            .service
            .workspaces
            .record_sandbox_snapshot_image("deployment", snapshot_id, "sha256:preview-fixture", 1)
            .unwrap();
        fixture
            .service
            .workspaces
            .complete_sandbox_snapshot("deployment", snapshot_id)
            .unwrap();
        let mut cancel = fixture.service.live.read()[&fixture.record.grant.id].subscribe();
        fixture
            .service
            .revoke_snapshot("deployment", "018ef64a-84d0-7000-8000-000000000001")
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), cancel.changed())
            .await
            .unwrap()
            .unwrap();
        assert!(*cancel.borrow());
        assert!(
            fixture
                .service
                .workspaces
                .preview_grant("deployment", &fixture.record.grant.id)
                .unwrap()
                .grant
                .revoked
        );
        // Fork provenance is a durable artifact reference, never inferred from labels.
        let mut fork = fixture.record.clone();
        fork.grant.id = "fork-preview".into();
        fork.grant.workspace_id = "fork-workspace".into();
        fork.grant.container_id = "fork-container".into();
        fixture
            .service
            .workspaces
            .store_preview_grant("deployment", &fork, None)
            .unwrap();
        fixture
            .service
            .workspaces
            .add_sandbox_snapshot_reference(
                "deployment",
                "018ef64a-84d0-7000-8000-000000000001",
                "runtime",
                "fork-container",
            )
            .unwrap();
        fixture
            .service
            .revoke_snapshot("deployment", "018ef64a-84d0-7000-8000-000000000001")
            .await
            .unwrap();
        assert!(
            fixture
                .service
                .workspaces
                .preview_grant("deployment", "fork-preview")
                .unwrap()
                .grant
                .revoked
        );
    }
    #[tokio::test]
    async fn preview_revoke_cancels_before_a_stalled_redemption_releases_the_mutex() {
        let fixture = Fixture::new();
        fixture.runtime.stalled.store(true, Ordering::SeqCst);
        let service = fixture.service.clone();
        let id = fixture.record.grant.id.clone();
        let secret = fixture.secret.clone();
        let redeem = tokio::spawn(async move { service.redeem(&id, &secret).await });
        tokio::task::yield_now().await;
        let mut cancel = fixture.service.live.read()[&fixture.record.grant.id].subscribe();
        let service = fixture.service.clone();
        let id = fixture.record.grant.id.clone();
        let revoke = tokio::spawn(async move { service.revoke(&id).await });
        tokio::time::timeout(Duration::from_millis(100), cancel.changed())
            .await
            .unwrap()
            .unwrap();
        assert!(*cancel.borrow());
        assert!(redeem.await.unwrap().is_err());
        assert!(revoke.await.unwrap().unwrap().revoked);
    }
    #[tokio::test]
    async fn preview_expiry_monitor_cancels_even_when_runtime_inspection_stalls() {
        let fixture = Fixture::new();
        fixture.runtime.stalled.store(true, Ordering::SeqCst);
        let mut record = fixture.record.clone();
        record.grant.expires_at = now() + 400;
        record.grant.revision = 2;
        fixture
            .service
            .workspaces
            .store_preview_grant("deployment", &record, Some(1))
            .unwrap();
        let mut cancel = fixture.service.live.read()[&record.grant.id].subscribe();
        let monitor = tokio::spawn(
            fixture
                .service
                .clone()
                .monitor(record.grant.id, cancel.clone()),
        );
        tokio::time::timeout(Duration::from_secs(1), cancel.changed())
            .await
            .unwrap()
            .unwrap();
        assert!(*cancel.borrow());
        monitor.await.unwrap();
    }
    #[tokio::test]
    async fn preview_revocation_interrupts_a_slow_bootstrap_body() {
        let fixture = Fixture::new();
        let id = fixture.record.grant.id.clone();
        let mut request = fixture.request(Method::POST, "");
        *request.body_mut() = Body::from_stream(futures_util::stream::pending::<
            Result<bytes::Bytes, std::io::Error>,
        >());
        let service = fixture.service.clone();
        let request_id = id.clone();
        let handler =
            tokio::spawn(
                async move { preview_handler(State((service, request_id)), request).await },
            );
        tokio::task::yield_now().await;
        fixture.service.revoke(&id).await.unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(100), handler)
                .await
                .unwrap()
                .unwrap()
                .status(),
            StatusCode::GONE
        );
    }
    #[test]
    fn preview_credentials_and_cross_grant_cookies_are_removed() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "cookie",
            HeaderValue::from_static(
                "app=ok; cognia_preview_this=secret; cognia_preview_other=secret2",
            ),
        );
        strip_preview_cookies(&mut headers);
        assert_eq!(headers["cookie"], "app=ok");
        headers.insert(
            "origin",
            HeaderValue::from_static("http://p-id.localhost:123"),
        );
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer host-secret"),
        );
        headers.insert("x-cognia-device-id", HeaderValue::from_static("owner"));
        strip_preview_credentials(&mut headers);
        assert_eq!(headers["origin"], "http://p-id.localhost:123");
        assert!(!headers.contains_key("authorization"));
        assert!(!headers.contains_key("x-cognia-device-id"));
        headers.append("host", HeaderValue::from_static("p-id.localhost:123"));
        headers.append("host", HeaderValue::from_static("p-id.localhost:123"));
        assert!(!host_matches(&headers, "http://p-id.localhost:123"));
        assert!(BOOTSTRAP.contains("history.replaceState"));
        assert!(!BOOTSTRAP.contains("?token"));
    }
    #[tokio::test]
    async fn preview_loopback_fallback_is_inert_without_cookie_storage_isolation() {
        let fixture = Fixture::new();
        let error = fixture
            .service
            .create(CreateSandboxPreview {
                project_id: "project".into(),
                workspace_id: "workspace".into(),
                provider: "local".into(),
                container_id: "container".into(),
                port: PreviewPort::Fixed { port: 3000 },
                expires_in_seconds: None,
                audience: None,
                origin_mode: PreviewOriginMode::Loopback,
            })
            .await
            .unwrap_err();
        assert_eq!(error, "preview_origin_isolation_unavailable");
        assert_eq!(fixture.service.list("project", None).unwrap().len(), 1);
        let mut stored = fixture.record.grant.clone();
        assert!(active(&stored, now()));
        stored.origin = "http://127.0.0.1:42000".into();
        assert!(!active(&stored, now()));
        assert!(fixture.service.validate(&stored).await.is_err());
    }
    #[tokio::test]
    async fn preview_create_starts_dedicated_origin_and_default_expiry() {
        let fixture = Fixture::new();
        let created = fixture
            .service
            .create(CreateSandboxPreview {
                project_id: "project".into(),
                workspace_id: "workspace".into(),
                provider: "local".into(),
                container_id: "container".into(),
                port: PreviewPort::Fixed { port: 3000 },
                expires_in_seconds: None,
                audience: None,
                origin_mode: PreviewOriginMode::Localhost,
            })
            .await
            .unwrap();
        assert_eq!(created.grant.expires_at - created.grant.created_at, 900_000);
        assert!(created.grant.origin.starts_with("http://p-"));
        assert!(created.bootstrap_url.contains("/__cognia_bootstrap#"));
        fixture.service.revoke(&created.grant.id).await.unwrap();
    }
}
