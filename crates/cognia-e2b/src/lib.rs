//! E2B's control-plane REST API (`https://api.e2b.app`, `X-API-Key`).
//!
//! Only what the provider needs: sandbox create/inspect/list/kill/pause/
//! connect, and the Build System 2.0 template calls (create, file cache,
//! start, status). Every client is built per request through the Host's proxy
//! policy (`cognia_net::proxy_config::managed_client`). The API key and the
//! tokens E2B returns are never written to an error or a log.

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

#[doc(hidden)]
pub mod connect;
pub mod envd;
mod exact;
pub use exact::{
    ExactBuild, ExactSandboxRequest, ImageBuildRequest, SandboxEgress, PRIVATE_EGRESS_DENY,
};
use serde_json::{json, Value};
use url::{Host, Url};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Whole-exchange ceiling for one control-plane call. Sandbox creation is
/// the slowest (the SDK allows 60 s too).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// Uploading the bundle archive to the presigned URL: large, so bounded by
/// a stall, not by its total duration.
const UPLOAD_READ_TIMEOUT: Duration = Duration::from_secs(120);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(3600);
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
/// `GET /v2/sandboxes` and the build list page at most 100 items.
pub const PAGE_LIMIT: u32 = 100;
/// A pagination loop that keeps going past this is a broken cursor.
const MAX_PAGES: usize = 1000;
const USER_AGENT: &str = concat!("cognia-sandbox-pool/", env!("CARGO_PKG_VERSION"));

/// Why a control-plane call failed. Messages are E2B's own (`{code,
/// message}` bodies), truncated, and never carry the key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiError {
    Status { status: u16, message: String },
    Transport(String),
    Invalid(String),
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Status { status, message } if message.is_empty() => {
                write!(f, "E2B answered HTTP {status}")
            }
            Self::Status { status, message } => write!(f, "E2B answered HTTP {status}: {message}"),
            Self::Transport(message) => write!(f, "E2B is unreachable: {message}"),
            Self::Invalid(message) => write!(f, "E2B answered unexpectedly: {message}"),
        }
    }
}

impl ApiError {
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Status { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// Worth retrying while polling: the provider, not the request, failed.
    pub fn is_transient(&self) -> bool {
        matches!(
            self,
            Self::Status {
                status: 429 | 500..=599,
                ..
            } | Self::Transport(_)
        )
    }
}

/// `POST /v2/sandboxes`, `/connect` and `/resume` answer this.
#[derive(Clone, Deserialize, Default)]
pub struct CreatedSandbox {
    #[serde(rename = "trafficAccessToken", default)]
    pub traffic_access_token: Option<String>,
    #[serde(rename = "templateID", default)]
    pub template_id: Option<String>,
    #[serde(rename = "sandboxID")]
    pub sandbox_id: String,
    #[serde(rename = "envdAccessToken", default)]
    pub envd_access_token: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
}

impl fmt::Debug for CreatedSandbox {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CreatedSandbox")
            .field("sandbox_id", &self.sandbox_id)
            .field(
                "traffic_access_token",
                &self.traffic_access_token.as_ref().map(|_| "<redacted>"),
            )
            .field(
                "envd_access_token",
                &self.envd_access_token.as_ref().map(|_| "<redacted>"),
            )
            .field("domain", &self.domain)
            .finish()
    }
}

/// `GET /sandboxes/{id}` (`SandboxDetail`) and the items of `GET
/// /v2/sandboxes` (`ListedSandbox`, which has no token or domain).
#[derive(Clone, Deserialize)]
pub struct SandboxInfo {
    #[serde(rename = "templateID", default)]
    pub template_id: Option<String>,
    #[serde(rename = "startedAt", default)]
    pub started_at: Option<String>,
    #[serde(rename = "endAt", default)]
    pub end_at: Option<String>,
    #[serde(default)]
    pub lifecycle: Option<SandboxLifecycle>,
    #[serde(default)]
    pub network: Option<SandboxNetwork>,
    #[serde(rename = "sandboxID")]
    pub sandbox_id: String,
    /// `running` or `paused`.
    pub state: String,
    #[serde(default)]
    pub metadata: Option<BTreeMap<String, String>>,
    #[serde(rename = "envdAccessToken", default)]
    pub envd_access_token: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
}

impl fmt::Debug for SandboxInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SandboxInfo")
            .field("sandbox_id", &self.sandbox_id)
            .field("state", &self.state)
            .field("metadata", &self.metadata)
            .field(
                "envd_access_token",
                &self.envd_access_token.as_ref().map(|_| "<redacted>"),
            )
            .field("domain", &self.domain)
            .finish()
    }
}

/// What `POST /sandboxes/{id}/pause` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PauseOutcome {
    Paused,
    /// 409: already paused, or pausing.
    Conflict,
    Gone,
}

/// `GET /templates/aliases/{alias}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AliasLookup {
    Owned {
        template_id: String,
    },
    /// The name belongs to another team (403); building under it creates the
    /// team's own template in its namespace.
    NotOurs,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TemplateBuild {
    #[serde(rename = "buildID")]
    pub build_id: String,
    /// `building`, `waiting`, `ready` or `error`.
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RequestedBuild {
    #[serde(rename = "templateID")]
    pub template_id: String,
    #[serde(rename = "buildID")]
    pub build_id: String,
}

/// `GET /templates/{id}/files/{hash}`.
#[derive(Clone, Deserialize)]
pub struct FileUpload {
    pub present: bool,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: Option<BTreeMap<String, String>>,
}

impl fmt::Debug for FileUpload {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // A presigned URL is a bearer credential for the upload.
        f.debug_struct("FileUpload")
            .field("present", &self.present)
            .field("url", &self.url.as_ref().map(|_| "<presigned>"))
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BuildLogEntry {
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub level: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BuildStatusReason {
    #[serde(default)]
    pub message: String,
    #[serde(rename = "logEntries", default)]
    pub log_entries: Vec<BuildLogEntry>,
}

/// `GET /templates/{id}/builds/{build}/status`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BuildInfo {
    pub status: String,
    #[serde(rename = "logEntries", default)]
    pub log_entries: Vec<BuildLogEntry>,
    #[serde(default)]
    pub reason: Option<BuildStatusReason>,
}

struct ApiResponse {
    status: u16,
    next_token: Option<String>,
    body: Vec<u8>,
}

/// The control-plane client: a base URL and the account's key.
#[derive(Clone)]
pub struct ApiClient {
    base: Url,
    api_key: String,
}

impl fmt::Debug for ApiClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ApiClient")
            .field("base", &self.base.origin().ascii_serialization())
            .field("api_key", &"<redacted>")
            .finish()
    }
}

/// Whether `url` names a loopback host, the only place plain HTTP is used.
pub fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// `pct(k)=pct(v)&…`, itself escaped once more: E2B unescapes the
/// `metadata` parameter once as a whole, splits it on `&` and `=`, then
/// unescapes each key and value (`parseFilters` in the API), so keys and
/// values may contain any character.
pub fn metadata_query(filter: &BTreeMap<String, String>) -> String {
    let pairs = filter
        .iter()
        .map(|(key, value)| format!("{}={}", escape(key), escape(value)))
        .collect::<Vec<_>>()
        .join("&");
    escape(&pairs)
}

/// Percent-encodes everything but RFC 3986's unreserved characters.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn decode<T: DeserializeOwned>(body: &[u8], what: &str) -> Result<T, ApiError> {
    serde_json::from_slice(body)
        .map_err(|_| ApiError::Invalid(format!("{what} is not the expected JSON")))
}

/// E2B's `{code, message}` error body, or the start of whatever came back.
fn error_message(body: &[u8]) -> String {
    #[derive(Deserialize)]
    struct WireError {
        #[serde(default)]
        message: String,
    }
    if let Ok(error) = serde_json::from_slice::<WireError>(body) {
        if !error.message.is_empty() {
            return truncate(&error.message, 512);
        }
    }
    truncate(String::from_utf8_lossy(body).trim(), 512)
}

impl ApiClient {
    fn error_message(&self, body: &[u8]) -> String {
        if self.api_key.is_empty() {
            return error_message(body);
        }
        // Redact before truncation so a reflected key cannot leak a prefix.
        error_message(
            String::from_utf8_lossy(body)
                .replace(&self.api_key, "<redacted>")
                .as_bytes(),
        )
    }
    pub fn new(base: Url, api_key: String) -> Self {
        Self { base, api_key }
    }

    fn endpoint(&self, segments: &[&str]) -> Result<Url, ApiError> {
        if !(self.base.scheme() == "https"
            || (self.base.scheme() == "http" && is_loopback(&self.base)))
            || !self.base.username().is_empty()
            || self.base.password().is_some()
            || self.base.query().is_some()
            || self.base.fragment().is_some()
        {
            return Err(ApiError::Invalid(
                "the API origin must be HTTPS without credentials, query or fragment".into(),
            ));
        }
        let mut url = self.base.clone();
        url.path_segments_mut()
            .map_err(|()| ApiError::Invalid(format!("{} cannot be a base URL", self.base)))?
            .pop_if_empty()
            .extend(segments);
        Ok(url)
    }

    async fn call(
        &self,
        method: reqwest::Method,
        url: Url,
        body: Option<&Value>,
    ) -> Result<ApiResponse, ApiError> {
        let builder = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT);
        let client = cognia_net::proxy_config::managed_client(builder, url.as_str())
            .map_err(|error| ApiError::Transport(format!("network policy: {error}")))?;
        let mut credential = reqwest::header::HeaderValue::from_str(&self.api_key)
            .map_err(|_| ApiError::Invalid("the API credential is not a valid header".into()))?;
        credential.set_sensitive(true);
        let mut request = client
            .request(method, url)
            .header("x-api-key", credential)
            .header("accept", "application/json");
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(serde_json::to_vec(body).expect("a JSON value serializes"));
        }
        let mut response = request
            .send()
            .await
            .map_err(|error| ApiError::Transport(error.without_url().to_string()))?;
        let status = response.status().as_u16();
        let next_token = response
            .headers()
            .get("x-next-token")
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(ApiError::Invalid(format!(
                "a response larger than {MAX_RESPONSE_BYTES} bytes"
            )));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| ApiError::Transport(error.without_url().to_string()))?
        {
            if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(ApiError::Invalid(format!(
                    "a response larger than {MAX_RESPONSE_BYTES} bytes"
                )));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(ApiResponse {
            status,
            next_token,
            body,
        })
    }

    /// `call`, with every non-2xx answer an error.
    async fn call_ok(
        &self,
        method: reqwest::Method,
        url: Url,
        body: Option<&Value>,
    ) -> Result<ApiResponse, ApiError> {
        let response = self.call(method, url, body).await?;
        if (200..300).contains(&response.status) {
            Ok(response)
        } else {
            Err(ApiError::Status {
                status: response.status,
                message: self.error_message(&response.body),
            })
        }
    }

    /// One page of `GET /v2/sandboxes` filtered by metadata (running and
    /// paused), and the cursor of the next page.
    pub async fn list_sandboxes_page(
        &self,
        filter: &BTreeMap<String, String>,
        limit: u32,
        next_token: Option<&str>,
    ) -> Result<(Vec<SandboxInfo>, Option<String>), ApiError> {
        let mut url = self.endpoint(&["v2", "sandboxes"])?;
        {
            let mut query = url.query_pairs_mut();
            if !filter.is_empty() {
                query.append_pair("metadata", &metadata_query(filter));
            }
            query.append_pair("limit", &limit.to_string());
            if let Some(token) = next_token {
                query.append_pair("nextToken", token);
            }
        }
        let response = self.call_ok(reqwest::Method::GET, url, None).await?;
        let items: Vec<SandboxInfo> = decode(&response.body, "the sandbox list")?;
        Ok((items, response.next_token))
    }

    /// Every sandbox matching `filter`, across pages.
    pub async fn list_sandboxes(
        &self,
        filter: &BTreeMap<String, String>,
    ) -> Result<Vec<SandboxInfo>, ApiError> {
        let mut all = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let (items, next) = self
                .list_sandboxes_page(filter, PAGE_LIMIT, cursor.as_deref())
                .await?;
            all.extend(items);
            match next {
                Some(next) if Some(&next) == cursor.as_ref() => {
                    return Err(ApiError::Invalid(
                        "the sandbox list repeated its cursor".into(),
                    ))
                }
                Some(next) => cursor = Some(next),
                None => return Ok(all),
            }
        }
        Err(ApiError::Invalid(format!(
            "the sandbox list did not end after {MAX_PAGES} pages"
        )))
    }

    /// `GET /sandboxes/{id}`; `None` when it does not exist.
    pub async fn get_sandbox(&self, id: &str) -> Result<Option<SandboxInfo>, ApiError> {
        let url = self.endpoint(&["sandboxes", id])?;
        let response = self.call(reqwest::Method::GET, url, None).await?;
        match response.status {
            200 => decode(&response.body, "the sandbox").map(Some),
            404 => Ok(None),
            status => Err(ApiError::Status {
                status,
                message: self.error_message(&response.body),
            }),
        }
    }

    /// `POST /v2/sandboxes`.
    pub async fn create_sandbox(&self, body: &Value) -> Result<CreatedSandbox, ApiError> {
        let url = self.endpoint(&["v2", "sandboxes"])?;
        let response = self.call_ok(reqwest::Method::POST, url, Some(body)).await?;
        decode(&response.body, "the created sandbox")
    }

    /// `DELETE /sandboxes/{id}`; `false` when it was already gone.
    pub async fn delete_sandbox(&self, id: &str) -> Result<bool, ApiError> {
        let url = self.endpoint(&["sandboxes", id])?;
        let response = self.call(reqwest::Method::DELETE, url, None).await?;
        match response.status {
            200..=299 => Ok(true),
            404 => Ok(false),
            status => Err(ApiError::Status {
                status,
                message: self.error_message(&response.body),
            }),
        }
    }

    /// `POST /sandboxes/{id}/pause` with a full memory snapshot, so the
    /// processes inside (the supervisor) survive a resume.
    pub async fn pause_sandbox(&self, id: &str) -> Result<PauseOutcome, ApiError> {
        let url = self.endpoint(&["sandboxes", id, "pause"])?;
        let body = json!({ "memory": true });
        let response = self.call(reqwest::Method::POST, url, Some(&body)).await?;
        match response.status {
            200..=299 => Ok(PauseOutcome::Paused),
            409 => Ok(PauseOutcome::Conflict),
            404 => Ok(PauseOutcome::Gone),
            status => Err(ApiError::Status {
                status,
                message: self.error_message(&response.body),
            }),
        }
    }

    /// `POST /v2/sandboxes/{id}/connect`: resumes a paused sandbox and
    /// returns its envd token. The TTL is only ever extended, to `timeout`
    /// seconds from now at most. `None` when the sandbox does not exist.
    pub async fn connect_sandbox(
        &self,
        id: &str,
        timeout_secs: u64,
    ) -> Result<Option<CreatedSandbox>, ApiError> {
        let url = self.endpoint(&["v2", "sandboxes", id, "connect"])?;
        let body = json!({ "timeout": timeout_secs.clamp(1, i32::MAX as u64) });
        let response = self.call(reqwest::Method::POST, url, Some(&body)).await?;
        match response.status {
            200 | 201 => decode(&response.body, "the connected sandbox").map(Some),
            404 => Ok(None),
            status => Err(ApiError::Status {
                status,
                message: self.error_message(&response.body),
            }),
        }
    }

    /// `GET /templates/aliases/{alias}`.
    pub async fn template_by_alias(&self, alias: &str) -> Result<AliasLookup, ApiError> {
        #[derive(Deserialize)]
        struct Wire {
            #[serde(rename = "templateID")]
            template_id: String,
        }
        let url = self.endpoint(&["templates", "aliases", alias])?;
        let response = self.call(reqwest::Method::GET, url, None).await?;
        match response.status {
            200 => {
                let wire: Wire = decode(&response.body, "the template alias")?;
                Ok(AliasLookup::Owned {
                    template_id: wire.template_id,
                })
            }
            403 => Ok(AliasLookup::NotOurs),
            404 => Ok(AliasLookup::Missing),
            status => Err(ApiError::Status {
                status,
                message: self.error_message(&response.body),
            }),
        }
    }

    /// Every build of a template (`GET /templates/{id}`), across pages.
    pub async fn template_builds(&self, template_id: &str) -> Result<Vec<TemplateBuild>, ApiError> {
        #[derive(Deserialize)]
        struct Wire {
            #[serde(default)]
            builds: Vec<TemplateBuild>,
        }
        let mut all = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let mut url = self.endpoint(&["templates", template_id])?;
            {
                let mut query = url.query_pairs_mut();
                query.append_pair("limit", &PAGE_LIMIT.to_string());
                if let Some(token) = &cursor {
                    query.append_pair("nextToken", token);
                }
            }
            let response = self.call_ok(reqwest::Method::GET, url, None).await?;
            let wire: Wire = decode(&response.body, "the template")?;
            all.extend(wire.builds);
            match response.next_token {
                Some(next) if Some(&next) == cursor.as_ref() => {
                    return Err(ApiError::Invalid(
                        "the build list repeated its cursor".into(),
                    ))
                }
                Some(next) => cursor = Some(next),
                None => return Ok(all),
            }
        }
        Err(ApiError::Invalid(format!(
            "the build list did not end after {MAX_PAGES} pages"
        )))
    }

    /// `POST /v3/templates`: a new build of the template named `name`
    /// (creating the template when the team has none by that name).
    pub async fn request_build(
        &self,
        name: &str,
        cpu_count: u32,
        memory_mb: u32,
    ) -> Result<RequestedBuild, ApiError> {
        let url = self.endpoint(&["v3", "templates"])?;
        let body = json!({ "name": name, "cpuCount": cpu_count, "memoryMB": memory_mb });
        let response = self
            .call_ok(reqwest::Method::POST, url, Some(&body))
            .await?;
        decode(&response.body, "the requested build")
    }

    /// `GET /templates/{id}/files/{hash}`.
    pub async fn file_upload(
        &self,
        template_id: &str,
        files_hash: &str,
    ) -> Result<FileUpload, ApiError> {
        let url = self.endpoint(&["templates", template_id, "files", files_hash])?;
        let response = self.call_ok(reqwest::Method::GET, url, None).await?;
        decode(&response.body, "the file upload link")
    }

    /// `POST /v2/templates/{id}/builds/{build}`.
    pub async fn start_build(
        &self,
        template_id: &str,
        build_id: &str,
        body: &Value,
    ) -> Result<(), ApiError> {
        let url = self.endpoint(&["v2", "templates", template_id, "builds", build_id])?;
        self.call_ok(reqwest::Method::POST, url, Some(body)).await?;
        Ok(())
    }

    /// `GET /templates/{id}/builds/{build}/status`, logs from `logs_offset`.
    pub async fn build_status(
        &self,
        template_id: &str,
        build_id: &str,
        logs_offset: usize,
    ) -> Result<BuildInfo, ApiError> {
        let mut url = self.endpoint(&["templates", template_id, "builds", build_id, "status"])?;
        url.query_pairs_mut()
            .append_pair("logsOffset", &logs_offset.to_string());
        let response = self.call_ok(reqwest::Method::GET, url, None).await?;
        decode(&response.body, "the build status")
    }

    /// PUTs the file at `path` (`size` bytes) to a presigned upload URL with
    /// the headers E2B returned and an exact `Content-Length`: object
    /// stores refuse chunked uploads to presigned URLs.
    pub async fn upload(
        &self,
        upload_url: &str,
        headers: &BTreeMap<String, String>,
        path: &Path,
        size: u64,
    ) -> Result<(), ApiError> {
        let url = Url::parse(upload_url)
            .map_err(|error| ApiError::Invalid(format!("the upload URL is invalid: {error}")))?;
        let plain_allowed = is_loopback(&self.base) && is_loopback(&url);
        match url.scheme() {
            "https" => {}
            "http" if plain_allowed => {}
            scheme => {
                return Err(ApiError::Invalid(format!(
                    "the upload URL uses {scheme}, not https"
                )))
            }
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(ApiError::Invalid(
                "the upload URL carries credentials".into(),
            ));
        }
        if headers.iter().any(|(name, value)| {
            name.eq_ignore_ascii_case("x-api-key")
                || (!self.api_key.is_empty() && value.contains(&self.api_key))
        }) {
            return Err(ApiError::Invalid(
                "provider credentials cannot be sent to an upload endpoint".into(),
            ));
        }
        let file = tokio::fs::File::open(path)
            .await
            .map_err(|error| ApiError::Invalid(format!("reading the archive: {error}")))?;
        let builder = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(UPLOAD_READ_TIMEOUT)
            .timeout(UPLOAD_TIMEOUT);
        let client = cognia_net::proxy_config::managed_client(builder, url.as_str())
            .map_err(|error| ApiError::Transport(format!("network policy: {error}")))?;
        let mut request = client.put(url);
        for (name, value) in headers {
            if name.eq_ignore_ascii_case("content-length")
                || name.eq_ignore_ascii_case("host")
                || name.eq_ignore_ascii_case("transfer-encoding")
            {
                continue;
            }
            let mut value = reqwest::header::HeaderValue::from_str(value)
                .map_err(|_| ApiError::Invalid("an upload header is invalid".into()))?;
            value.set_sensitive(true);
            request = request.header(name.as_str(), value);
        }
        let response = request
            .header("content-length", size.to_string())
            .body(reqwest::Body::from(file))
            .send()
            .await
            .map_err(|error| ApiError::Transport(error.without_url().to_string()))?;
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(());
        }
        Err(ApiError::Status {
            status,
            // Object-storage error pages can reflect their signed URL and
            // credentials. The status is sufficient to diagnose a retry.
            message: "the presigned upload was refused".into(),
        })
    }
}

fn truncate(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

impl std::error::Error for ApiError {}

/// Effective policy returned by sandbox inspection, not the create wire shape.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SandboxLifecycle {
    pub on_timeout: String,
    pub auto_resume: bool,
}

/// Relevant network settings returned by E2B. Missing values remain unknown.
#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SandboxNetwork {
    #[serde(default)]
    pub allow_public_traffic: Option<bool>,
    #[serde(default)]
    pub allow_out: Vec<String>,
    #[serde(default)]
    pub deny_out: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        extract::{Request, State},
        http::StatusCode,
        response::Response,
        Router,
    };
    use std::sync::{Arc, Mutex};

    fn init_test_network() {
        let _ = cognia_net::proxy_config::apply_current(
            cognia_net::proxy_config::ProxyConfig::default(),
        );
    }

    const BUILD: &str = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    type Calls = Arc<Mutex<Vec<(String, String, Value)>>>;

    struct Fixture {
        api: ApiClient,
        calls: Calls,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn handler(State((calls, reply)): State<(Calls, Value)>, request: Request) -> Response {
        let path = request.uri().path().to_string();
        let key = request
            .headers()
            .get("x-api-key")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_string();
        let bytes = to_bytes(request.into_body(), 1024 * 1024).await.unwrap();
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        calls.lock().unwrap().push((path, key, body));
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(reply.to_string()))
            .unwrap()
    }

    async fn fixture(reply: Value) -> Fixture {
        init_test_network();
        let calls = Calls::default();
        let router = Router::new()
            .fallback(handler)
            .with_state((calls.clone(), reply));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Fixture {
            api: ApiClient::new(base, "test-api-secret".into()),
            calls,
            task,
        }
    }

    #[tokio::test]
    async fn exact_build_never_accepts_another_ready_build_or_missing_identity() {
        init_test_network();
        let build = ExactBuild {
            template_id: "desktop123".into(),
            build_id: BUILD.into(),
        };
        for reply in [
            json!({"templateID":"desktop123","buildID":BUILD,"status":"waiting"}),
            json!({"templateID":"other","buildID":BUILD,"status":"ready"}),
            json!({"templateID":"desktop123","buildID":"00000000-0000-4000-8000-000000000001","status":"ready"}),
            json!({"status":"ready"}),
        ] {
            let f = fixture(reply).await;
            assert!(f.api.validate_exact_build(&build).await.is_err());
        }
        let f = fixture(json!({"templateID":"desktop123","buildID":BUILD,"status":"ready"})).await;
        assert_eq!(
            f.api.validate_exact_build(&build).await.unwrap().status,
            "ready"
        );
        let calls = f.calls.lock().unwrap();
        assert_eq!(
            calls[0].0,
            format!("/templates/desktop123/builds/{BUILD}/status")
        );
        assert_eq!(calls[0].1, "test-api-secret");
    }

    #[tokio::test]
    async fn exact_create_posts_a_single_protected_request_and_keeps_tokens_private() {
        init_test_network();
        let f = fixture(json!({"sandboxID":"s1","templateID":"desktop123","envdAccessToken":"envd-secret","trafficAccessToken":"traffic-secret"})).await;
        let request = ExactSandboxRequest {
            build: ExactBuild {
                template_id: "desktop123".into(),
                build_id: BUILD.into(),
            },
            timeout_secs: 60,
            metadata: BTreeMap::from([("operation".into(), "intent-1".into())]),
            env_vars: BTreeMap::from([("GUEST_TOKEN".into(), "guest-secret".into())]),
            egress: SandboxEgress::Off,
        };
        let sandbox = f.api.create_exact_sandbox(&request).await.unwrap();
        assert_eq!(
            sandbox.traffic_access_token.as_deref(),
            Some("traffic-secret")
        );
        assert!(!format!("{sandbox:?}").contains("traffic-secret"));
        assert!(!format!("{sandbox:?}").contains("envd-secret"));
        let calls = f.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "/v2/sandboxes");
        assert_eq!(calls[0].2["templateID"], format!("desktop123:{BUILD}"));
        assert_eq!(calls[0].2["timeout"], 60);
        assert_eq!(calls[0].2["autoPause"], false);
        assert_eq!(calls[0].2["autoResume"], json!({"enabled":false}));
        assert_eq!(calls[0].2["network"]["allowPublicTraffic"], false);
        assert!(!calls[0].2.to_string().contains("test-api-secret"));
    }

    #[tokio::test]
    async fn build_registration_and_start_are_separate_durable_boundaries() {
        init_test_network();
        let f = fixture(json!({"templateID":"desktop123","buildID":BUILD})).await;
        let request = ImageBuildRequest {
            name: "owner/desktop".into(),
            image: format!("ghcr.io/cognia/desktop@sha256:{}", "a".repeat(64)),
            cpu_count: 2,
            memory_mb: 4096,
            start_cmd: "/start".into(),
            ready_cmd: "/ready".into(),
        };
        let registered = f.api.request_image_build(&request).await.unwrap();
        assert_eq!(
            f.calls.lock().unwrap().len(),
            1,
            "registration does not start an unjournalled build"
        );
        let build = ExactBuild {
            template_id: registered.template_id,
            build_id: registered.build_id,
        };
        f.api.start_image_build(&build, &request).await.unwrap();
        let calls = f.calls.lock().unwrap();
        assert_eq!(calls[0].0, "/v3/templates");
        assert_eq!(calls[0].2["name"], "owner/desktop");
        assert_eq!(
            calls[1].0,
            format!("/v2/templates/desktop123/builds/{BUILD}")
        );
        assert_eq!(calls[1].2["fromImage"], request.image);
        assert!(calls[1].2.get("fromImageRegistry").is_none());
    }

    #[tokio::test]
    async fn redirects_are_not_followed_with_api_or_upload_credentials() {
        init_test_network();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let captured = hits.clone();
        let router = Router::new().fallback(move || {
            let hits = captured.clone();
            async move {
                hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Response::builder()
                    .status(307)
                    .header("location", "/redirected")
                    .body(Body::empty())
                    .unwrap()
            }
        });
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let f = Fixture {
            api: ApiClient::new(base.clone(), "secret".into()),
            calls: Calls::default(),
            task,
        };
        assert_eq!(
            f.api.get_sandbox("s1").await.unwrap_err().status(),
            Some(307)
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("upload");
        std::fs::write(&path, b"x").unwrap();
        assert_eq!(
            f.api
                .upload(base.as_str(), &BTreeMap::new(), &path, 1)
                .await
                .unwrap_err()
                .status(),
            Some(307)
        );
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn provider_key_in_upload_headers_is_refused_before_network_access() {
        init_test_network();
        let f = fixture(json!({})).await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("upload");
        std::fs::write(&path, b"x").unwrap();
        for headers in [
            BTreeMap::from([("X-API-Key".into(), "another-key".into())]),
            BTreeMap::from([("authorization".into(), "Bearer test-api-secret".into())]),
        ] {
            assert!(f
                .api
                .upload(f.api.base.as_str(), &headers, &path, 1)
                .await
                .is_err());
        }
        assert!(f.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn inspection_retains_unknown_policy_instead_of_inventing_effective_security() {
        let info: SandboxInfo =
            serde_json::from_value(json!({"sandboxID":"s1","state":"running"})).unwrap();
        assert!(info.lifecycle.is_none());
        assert!(info.network.is_none());
        let info: SandboxInfo = serde_json::from_value(json!({"sandboxID":"s1","state":"running","templateID":"t1","startedAt":"2026-10-15T00:00:00Z","endAt":"2026-10-15T01:00:00Z","lifecycle":{"onTimeout":"kill","autoResume":false},"network":{"allowPublicTraffic":false}})).unwrap();
        assert_eq!(info.lifecycle.unwrap().on_timeout, "kill");
        assert_eq!(info.network.unwrap().allow_public_traffic, Some(false));
    }

    #[test]
    fn credentials_are_redacted_before_truncation_and_origins_are_validated() {
        let key = "a".repeat(600);
        let api = ApiClient::new(Url::parse("https://api.e2b.app").unwrap(), key.clone());
        let message = api.error_message(json!({"message":key}).to_string().as_bytes());
        assert_eq!(message, "<redacted>");
        let api = ApiClient::new(
            Url::parse("https://user:password@api.e2b.app?token=bad").unwrap(),
            "secret".into(),
        );
        assert!(api.endpoint(&["sandboxes"]).is_err());
        assert!(!format!("{api:?}").contains("password"));
        assert!(!format!("{api:?}").contains("bad"));
        let api = ApiClient::new(Url::parse("http://api.e2b.app").unwrap(), "secret".into());
        assert!(api.endpoint(&["sandboxes"]).is_err());
    }
}
