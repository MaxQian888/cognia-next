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

use cognia_external_agent::sandbox_routing_backend::SandboxSpawnError;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use url::{Host, Url};

use super::connect::truncate;

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
pub(super) const PAGE_LIMIT: u32 = 100;
/// A pagination loop that keeps going past this is a broken cursor.
const MAX_PAGES: usize = 1000;
const USER_AGENT: &str = concat!("cognia-sandbox-pool/", env!("CARGO_PKG_VERSION"));

/// Why a control-plane call failed. Messages are E2B's own (`{code,
/// message}` bodies), truncated, and never carry the key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ApiError {
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
    pub(super) fn status(&self) -> Option<u16> {
        match self {
            Self::Status { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// The spawn outcome for a failed call: the account's credentials are an
    /// answer (refused), capacity and reachability are faults, any other
    /// refusal of the request is an answer about the request.
    pub(super) fn to_spawn_error(&self, doing: &str) -> SandboxSpawnError {
        let message = format!("{doing}: {self}");
        match self {
            Self::Status {
                status: 401 | 403, ..
            } => SandboxSpawnError::refused("sandbox_provider_unauthorized", message),
            Self::Status { status: 429, .. } => {
                SandboxSpawnError::fault("sandbox_provider_capacity", message)
            }
            Self::Status {
                status: 500..=599, ..
            }
            | Self::Transport(_)
            | Self::Invalid(_) => SandboxSpawnError::fault("sandbox_provider_unreachable", message),
            Self::Status { .. } => SandboxSpawnError::refused("sandbox_provider_rejected", message),
        }
    }

    /// Worth retrying while polling: the provider, not the request, failed.
    pub(super) fn is_transient(&self) -> bool {
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
#[derive(Clone, Deserialize)]
pub(super) struct CreatedSandbox {
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
pub(super) struct SandboxInfo {
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
pub(super) enum PauseOutcome {
    Paused,
    /// 409: already paused, or pausing.
    Conflict,
    Gone,
}

/// `GET /templates/aliases/{alias}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum AliasLookup {
    Owned {
        template_id: String,
    },
    /// The name belongs to another team (403); building under it creates the
    /// team's own template in its namespace.
    NotOurs,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(super) struct TemplateBuild {
    #[serde(rename = "buildID")]
    pub build_id: String,
    /// `building`, `waiting`, `ready` or `error`.
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(super) struct RequestedBuild {
    #[serde(rename = "templateID")]
    pub template_id: String,
    #[serde(rename = "buildID")]
    pub build_id: String,
}

/// `GET /templates/{id}/files/{hash}`.
#[derive(Clone, Deserialize)]
pub(super) struct FileUpload {
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
pub(super) struct BuildLogEntry {
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub level: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(super) struct BuildStatusReason {
    #[serde(default)]
    pub message: String,
    #[serde(rename = "logEntries", default)]
    pub log_entries: Vec<BuildLogEntry>,
}

/// `GET /templates/{id}/builds/{build}/status`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(super) struct BuildInfo {
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
pub(super) struct ApiClient {
    base: Url,
    api_key: String,
}

impl fmt::Debug for ApiClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ApiClient")
            .field("base", &self.base.as_str())
            .field("api_key", &"<redacted>")
            .finish()
    }
}

/// Whether `url` names a loopback host, the only place plain HTTP is used.
pub(super) fn is_loopback(url: &Url) -> bool {
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
pub(super) fn metadata_query(filter: &BTreeMap<String, String>) -> String {
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
        .map_err(|error| ApiError::Invalid(format!("{what} is not the expected JSON: {error}")))
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
    pub(super) fn new(base: Url, api_key: String) -> Self {
        Self { base, api_key }
    }

    fn endpoint(&self, segments: &[&str]) -> Result<Url, ApiError> {
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
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT);
        let client = cognia_net::proxy_config::managed_client(builder, url.as_str())
            .map_err(|error| ApiError::Transport(format!("network policy: {error}")))?;
        let mut request = client
            .request(method, url)
            .header("x-api-key", self.api_key.as_str())
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
                message: error_message(&response.body),
            })
        }
    }

    /// One page of `GET /v2/sandboxes` filtered by metadata (running and
    /// paused), and the cursor of the next page.
    pub(super) async fn list_sandboxes_page(
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
    pub(super) async fn list_sandboxes(
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
    pub(super) async fn get_sandbox(&self, id: &str) -> Result<Option<SandboxInfo>, ApiError> {
        let url = self.endpoint(&["sandboxes", id])?;
        let response = self.call(reqwest::Method::GET, url, None).await?;
        match response.status {
            200 => decode(&response.body, "the sandbox").map(Some),
            404 => Ok(None),
            status => Err(ApiError::Status {
                status,
                message: error_message(&response.body),
            }),
        }
    }

    /// `POST /v2/sandboxes`.
    pub(super) async fn create_sandbox(&self, body: &Value) -> Result<CreatedSandbox, ApiError> {
        let url = self.endpoint(&["v2", "sandboxes"])?;
        let response = self.call_ok(reqwest::Method::POST, url, Some(body)).await?;
        decode(&response.body, "the created sandbox")
    }

    /// `DELETE /sandboxes/{id}`; `false` when it was already gone.
    pub(super) async fn delete_sandbox(&self, id: &str) -> Result<bool, ApiError> {
        let url = self.endpoint(&["sandboxes", id])?;
        let response = self.call(reqwest::Method::DELETE, url, None).await?;
        match response.status {
            200..=299 => Ok(true),
            404 => Ok(false),
            status => Err(ApiError::Status {
                status,
                message: error_message(&response.body),
            }),
        }
    }

    /// `POST /sandboxes/{id}/pause` with a full memory snapshot, so the
    /// processes inside (the supervisor) survive a resume.
    pub(super) async fn pause_sandbox(&self, id: &str) -> Result<PauseOutcome, ApiError> {
        let url = self.endpoint(&["sandboxes", id, "pause"])?;
        let body = json!({ "memory": true });
        let response = self.call(reqwest::Method::POST, url, Some(&body)).await?;
        match response.status {
            200..=299 => Ok(PauseOutcome::Paused),
            409 => Ok(PauseOutcome::Conflict),
            404 => Ok(PauseOutcome::Gone),
            status => Err(ApiError::Status {
                status,
                message: error_message(&response.body),
            }),
        }
    }

    /// `POST /v2/sandboxes/{id}/connect`: resumes a paused sandbox and
    /// returns its envd token. The TTL is only ever extended, to `timeout`
    /// seconds from now at most. `None` when the sandbox does not exist.
    pub(super) async fn connect_sandbox(
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
                message: error_message(&response.body),
            }),
        }
    }

    /// `GET /templates/aliases/{alias}`.
    pub(super) async fn template_by_alias(&self, alias: &str) -> Result<AliasLookup, ApiError> {
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
                message: error_message(&response.body),
            }),
        }
    }

    /// Every build of a template (`GET /templates/{id}`), across pages.
    pub(super) async fn template_builds(
        &self,
        template_id: &str,
    ) -> Result<Vec<TemplateBuild>, ApiError> {
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
    pub(super) async fn request_build(
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
    pub(super) async fn file_upload(
        &self,
        template_id: &str,
        files_hash: &str,
    ) -> Result<FileUpload, ApiError> {
        let url = self.endpoint(&["templates", template_id, "files", files_hash])?;
        let response = self.call_ok(reqwest::Method::GET, url, None).await?;
        decode(&response.body, "the file upload link")
    }

    /// `POST /v2/templates/{id}/builds/{build}`.
    pub(super) async fn start_build(
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
    pub(super) async fn build_status(
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
    pub(super) async fn upload(
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
        let file = tokio::fs::File::open(path)
            .await
            .map_err(|error| ApiError::Invalid(format!("reading the archive: {error}")))?;
        let builder = reqwest::Client::builder()
            .user_agent(USER_AGENT)
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
            request = request.header(name.as_str(), value.as_str());
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
        let body = response.bytes().await.unwrap_or_default();
        Err(ApiError::Status {
            status,
            message: error_message(&body),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_server::FakeE2b;
    use super::*;

    #[test]
    fn metadata_filters_survive_the_servers_three_unescapes() {
        let filter = BTreeMap::from([
            (
                "cognia.owner".to_string(),
                "cognia-external-agent".to_string(),
            ),
            ("odd key=&%".to_string(), "value with spaces+&=".to_string()),
        ]);
        let encoded = metadata_query(&filter);
        assert!(
            encoded
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._~%".contains(&b)),
            "{encoded}"
        );
        // The server: framework unescape (done by the URL layer in the
        // fake), QueryUnescape of the whole value, split, unescape each.
        let decoded = super::super::test_server::parse_metadata_filter(&encoded).unwrap();
        assert_eq!(decoded, filter);
    }

    #[test]
    fn errors_map_to_spawn_outcomes() {
        let status = |status: u16| ApiError::Status {
            status,
            message: "m".into(),
        };
        for (error, kind_refused, code) in [
            (status(401), true, "sandbox_provider_unauthorized"),
            (status(403), true, "sandbox_provider_unauthorized"),
            (status(429), false, "sandbox_provider_capacity"),
            (status(500), false, "sandbox_provider_unreachable"),
            (status(503), false, "sandbox_provider_unreachable"),
            (
                ApiError::Transport("reset".into()),
                false,
                "sandbox_provider_unreachable",
            ),
            (
                ApiError::Invalid("junk".into()),
                false,
                "sandbox_provider_unreachable",
            ),
            (status(400), true, "sandbox_provider_rejected"),
            (status(404), true, "sandbox_provider_rejected"),
        ] {
            let spawn = error.to_spawn_error("creating");
            assert_eq!(spawn.code, code, "{error}");
            assert_eq!(
                spawn.kind
                    == cognia_external_agent::sandbox_routing_backend::SandboxErrorKind::Refused,
                kind_refused,
                "{error}"
            );
            assert!(spawn.message.starts_with("creating: "));
        }
        assert!(status(429).is_transient());
        assert!(status(502).is_transient());
        assert!(!status(400).is_transient());
    }

    #[test]
    fn debug_output_redacts_every_secret() {
        let client = ApiClient::new(Url::parse("https://api.e2b.app").unwrap(), "e2b_key".into());
        assert!(!format!("{client:?}").contains("e2b_key"));
        let created = CreatedSandbox {
            sandbox_id: "i1".into(),
            envd_access_token: Some("envd-secret".into()),
            domain: None,
        };
        assert!(!format!("{created:?}").contains("envd-secret"));
        let upload = FileUpload {
            present: false,
            url: Some("https://s3.example.com/x?X-Amz-Signature=sig".into()),
            headers: None,
        };
        assert!(!format!("{upload:?}").contains("Signature"));
    }

    #[tokio::test]
    async fn every_call_carries_the_key_and_lists_follow_cursors() {
        let fake = FakeE2b::start().await;
        fake.set_page_size(2);
        let owner = BTreeMap::from([("cognia.owner".to_string(), "x".to_string())]);
        for _ in 0..5 {
            fake.add_sandbox("running", owner.clone());
        }
        fake.add_sandbox(
            "running",
            BTreeMap::from([("other".to_string(), "y".to_string())]),
        );
        let api = fake.api();
        let listed = api.list_sandboxes(&owner).await.unwrap();
        assert_eq!(listed.len(), 5);
        let pages = fake.requests_to("/v2/sandboxes");
        assert_eq!(pages.len(), 3);
        assert!(pages
            .iter()
            .all(|request| request.header("x-api-key") == Some(FakeE2b::API_KEY)));
        assert!(pages[1].query.as_deref().unwrap().contains("nextToken="));

        fake.fail_next("/v2/sandboxes", 401, "Invalid API key");
        let error = api.list_sandboxes(&owner).await.unwrap_err();
        assert_eq!(error.status(), Some(401));
        assert!(error.to_string().contains("Invalid API key"));
        assert!(!error.to_string().contains(FakeE2b::API_KEY));
    }

    #[tokio::test]
    async fn missing_sandboxes_are_none_not_errors() {
        let fake = FakeE2b::start().await;
        let api = fake.api();
        assert!(api.get_sandbox("nosuch").await.unwrap().is_none());
        assert!(!api.delete_sandbox("nosuch").await.unwrap());
        assert_eq!(
            api.pause_sandbox("nosuch").await.unwrap(),
            PauseOutcome::Gone
        );
        assert!(api.connect_sandbox("nosuch", 5).await.unwrap().is_none());

        let id = fake.add_sandbox("running", BTreeMap::new());
        let info = api.get_sandbox(&id).await.unwrap().unwrap();
        assert_eq!(info.state, "running");
        assert_eq!(
            info.envd_access_token.as_deref(),
            Some(fake.token(&id).as_str())
        );
        assert_eq!(api.pause_sandbox(&id).await.unwrap(), PauseOutcome::Paused);
        assert_eq!(
            fake.last_request(&format!("/sandboxes/{id}/pause")).json(),
            json!({ "memory": true })
        );
        assert_eq!(
            api.pause_sandbox(&id).await.unwrap(),
            PauseOutcome::Conflict
        );
        let resumed = api.connect_sandbox(&id, 90).await.unwrap().unwrap();
        assert_eq!(resumed.sandbox_id, id);
        assert_eq!(
            fake.last_request(&format!("/v2/sandboxes/{id}/connect"))
                .json(),
            json!({ "timeout": 90 })
        );
        assert!(api.delete_sandbox(&id).await.unwrap());
    }

    #[tokio::test]
    async fn uploads_send_an_exact_length_and_the_returned_headers() {
        let fake = FakeE2b::start().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("archive.tar.gz");
        let bytes = vec![7u8; 300_000];
        std::fs::write(&path, &bytes).unwrap();
        let api = fake.api();
        let url = fake.url("/upload/hash1");
        let headers = BTreeMap::from([
            ("x-amz-meta-test".to_string(), "yes".to_string()),
            ("Content-Length".to_string(), "1".to_string()),
        ]);
        api.upload(url.as_str(), &headers, &path, bytes.len() as u64)
            .await
            .unwrap();
        let upload = fake.last_request("/upload/hash1");
        assert_eq!(upload.method, "PUT");
        assert_eq!(upload.header("content-length"), Some("300000"));
        assert_eq!(upload.header("transfer-encoding"), None);
        assert_eq!(upload.header("x-amz-meta-test"), Some("yes"));
        assert_eq!(
            upload.header("x-api-key"),
            None,
            "the key stays with E2B's API"
        );
        assert_eq!(upload.body.len(), 300_000);

        let error = api
            .upload(
                "https://user:pw@s3.example.com/x",
                &BTreeMap::new(),
                &path,
                1,
            )
            .await
            .unwrap_err();
        assert!(matches!(error, ApiError::Invalid(_)));
        let error = api
            .upload("http://s3.example.com/x", &BTreeMap::new(), &path, 1)
            .await
            .unwrap_err();
        assert!(
            matches!(error, ApiError::Invalid(_)),
            "plain http off loopback"
        );
    }
}
