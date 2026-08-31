//! Account-scoped Langfuse v4 trace destination.
//!
//! This is intentionally narrower than the generic telemetry proxy: callers
//! cannot supply an endpoint, headers, credentials, or an arbitrary JSON body
//! to the ingest command. The host resolves the current account, loads its
//! write-only credential record, validates `AgentTraceBatchV1`, and always
//! targets Langfuse's v4 OTLP traces path.

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::host_identity;
use super::security_store::LOCAL_NAMESPACE_UNBOUND;

const SECRET_NAMESPACE: &str = "langfuse-tracing-v1";
const MAX_BATCH_SPANS: usize = 128;
const MAX_BATCH_BYTES: usize = 512 * 1024;
const MAX_PREVIEW_BYTES: usize = 4096;
const MAX_SPANS_PER_MINUTE: usize = 1_000;
const MAX_DEDUPE_KEYS: usize = 50_000;
const MAX_TRACKED_ACCOUNTS: usize = 1_024;
const ACCOUNT_STATE_TTL: Duration = Duration::from_secs(60 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredLangfuseCredentials {
    enabled: bool,
    base_url: String,
    public_key: String,
    secret_key: String,
    environment: String,
    capture_model_content: bool,
    capture_tool_content: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LangfuseCredentialsStatus {
    pub configured: bool,
    pub enabled: bool,
    pub base_url: Option<String>,
    pub public_key: Option<String>,
    pub environment: Option<String>,
    pub capture_model_content: bool,
    pub capture_tool_content: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LangfuseConnectionStatus {
    pub connected: bool,
    pub status: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTraceBatchV1 {
    pub schema_version: u8,
    pub spans: Vec<AgentTraceSpanV1>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTraceSpanV1 {
    pub id: String,
    pub project_id: Option<String>,
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: Option<String>,
    pub start_time: f64,
    pub end_time: Option<f64>,
    pub duration_ms: Option<f64>,
    pub operation_name: String,
    pub provider_name: String,
    pub request_model: Option<String>,
    pub response_model: Option<String>,
    pub tool_name: Option<String>,
    pub usage: Option<AgentTraceUsageV1>,
    pub cost_usd_estimate: Option<f64>,
    pub finish_reasons: Option<Vec<String>>,
    pub error_type: Option<String>,
    pub status: Option<String>,
    pub run_id: Option<String>,
    pub turn_id: Option<String>,
    pub attempt_id: Option<String>,
    pub session_id: String,
    pub surface: String,
    pub input_preview: Option<String>,
    pub output_preview: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTraceUsageV1 {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LangfuseTraceIngestResult {
    pub accepted_spans: usize,
    pub duplicate_spans: usize,
    pub status: u16,
}

struct DedupeState {
    order: VecDeque<String>,
    keys: HashSet<String>,
    last_seen: Instant,
}

impl Default for DedupeState {
    fn default() -> Self {
        Self {
            order: VecDeque::new(),
            keys: HashSet::new(),
            last_seen: Instant::now(),
        }
    }
}

struct RateWindow {
    started_at: Instant,
    spans: usize,
}

static DEDUPE: Lazy<Mutex<HashMap<String, DedupeState>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static RATE_LIMITS: Lazy<Mutex<HashMap<String, RateWindow>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn current_account() -> Result<String, String> {
    let context = host_identity::current().map_err(|error| error.to_string())?;
    if context.local_account_namespace == LOCAL_NAMESPACE_UNBOUND {
        return Err("Langfuse credentials require an unlocked Cognia account".to_string());
    }
    validate_account_key(&context.remote_tenant_id)?;
    Ok(context.remote_tenant_id)
}

fn validate_account_key(account: &str) -> Result<(), String> {
    if account.is_empty()
        || account.len() > 128
        || !account
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("Langfuse account binding is invalid".to_string());
    }
    Ok(())
}

fn normalize_base_url(value: &str) -> Result<String, String> {
    let mut url = url::Url::parse(value.trim())
        .map_err(|error| format!("invalid Langfuse base URL: {error}"))?;
    #[cfg(test)]
    let allow_insecure_test_loopback =
        url.scheme() == "http" && url.host_str() == Some("127.0.0.1");
    #[cfg(not(test))]
    let allow_insecure_test_loopback = false;
    if url.scheme() != "https" && !allow_insecure_test_loopback {
        return Err("Langfuse base URL must use https".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() || url.host_str().is_none() {
        return Err("Langfuse base URL must not contain credentials".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("Langfuse base URL must not contain a query or fragment".to_string());
    }
    url.set_path("");
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn otlp_endpoint(base_url: &str) -> Result<url::Url, String> {
    let mut url = url::Url::parse(&normalize_base_url(base_url)?)
        .map_err(|error| format!("invalid Langfuse base URL: {error}"))?;
    url.set_path("/api/public/otel/v1/traces");
    Ok(url)
}

fn credential_key(account: &str) -> String {
    format!("account:{account}")
}

fn save_credentials_for_account(
    account: &str,
    credentials: &StoredLangfuseCredentials,
) -> Result<(), String> {
    validate_account_key(account)?;
    let encoded = serde_json::to_string(credentials)
        .map_err(|error| format!("Langfuse credentials serialization failed: {error}"))?;
    cognia_secrets::secret_store::set(SECRET_NAMESPACE, &credential_key(account), &encoded)
}

fn load_credentials_for_account(
    account: &str,
) -> Result<Option<StoredLangfuseCredentials>, String> {
    validate_account_key(account)?;
    let Some(encoded) =
        cognia_secrets::secret_store::get(SECRET_NAMESPACE, &credential_key(account))?
    else {
        return Ok(None);
    };
    serde_json::from_str(&encoded)
        .map(Some)
        .map_err(|_| "stored Langfuse credentials are invalid".to_string())
}

async fn run_secret_store<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| format!("Langfuse secret store task failed: {error}"))?
}

async fn load_credentials_for_account_async(
    account: &str,
) -> Result<Option<StoredLangfuseCredentials>, String> {
    let account = account.to_string();
    run_secret_store(move || load_credentials_for_account(&account)).await
}

// These fields mirror the persisted Langfuse credential record one-for-one.
#[allow(clippy::too_many_arguments)]
pub(crate) fn credentials_set_for_account(
    account: &str,
    enabled: bool,
    base_url: String,
    public_key: String,
    secret_key: Option<String>,
    environment: String,
    capture_model_content: bool,
    capture_tool_content: bool,
) -> Result<(), String> {
    let base_url = normalize_base_url(&base_url)?;
    let public_key = public_key.trim().to_string();
    let supplied_secret = secret_key
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let secret_key = match supplied_secret {
        Some(value) => value,
        None => match load_credentials_for_account(account)? {
            Some(stored) if stored.base_url == base_url && stored.public_key == public_key => {
                stored.secret_key
            }
            Some(_) => {
                return Err(
                    "A fresh Langfuse secret key is required when changing the destination"
                        .to_string(),
                )
            }
            None => return Err("Langfuse secret key is required".to_string()),
        },
    };
    if public_key.is_empty() || public_key.len() > 512 {
        return Err("Langfuse public key is invalid".to_string());
    }
    if secret_key.is_empty() || secret_key.len() > 512 {
        return Err("Langfuse secret key is invalid".to_string());
    }
    let environment = environment.trim().to_string();
    if environment.len() > 64
        || !environment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Langfuse environment is invalid".to_string());
    }
    save_credentials_for_account(
        account,
        &StoredLangfuseCredentials {
            enabled,
            base_url,
            public_key,
            secret_key,
            environment,
            capture_model_content,
            capture_tool_content,
        },
    )?;
    // The new account-scoped record is durable before the legacy global key is
    // removed. Retrying this command is safe if deletion itself fails.
    crate::telemetry::clear_legacy_langfuse_secret()
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn credentials_set_for_account_async(
    account: String,
    enabled: bool,
    base_url: String,
    public_key: String,
    secret_key: Option<String>,
    environment: String,
    capture_model_content: bool,
    capture_tool_content: bool,
) -> Result<(), String> {
    run_secret_store(move || {
        credentials_set_for_account(
            &account,
            enabled,
            base_url,
            public_key,
            secret_key,
            environment,
            capture_model_content,
            capture_tool_content,
        )
    })
    .await
}

pub(crate) fn credentials_status_for_account(
    account: &str,
) -> Result<LangfuseCredentialsStatus, String> {
    let credentials = load_credentials_for_account(account)?;
    Ok(match credentials {
        Some(value) => LangfuseCredentialsStatus {
            configured: true,
            enabled: value.enabled,
            base_url: Some(value.base_url),
            public_key: Some(value.public_key),
            environment: Some(value.environment),
            capture_model_content: value.capture_model_content,
            capture_tool_content: value.capture_tool_content,
        },
        None => LangfuseCredentialsStatus {
            configured: false,
            enabled: false,
            base_url: None,
            public_key: None,
            environment: None,
            capture_model_content: false,
            capture_tool_content: false,
        },
    })
}

pub(crate) async fn credentials_status_for_account_async(
    account: String,
) -> Result<LangfuseCredentialsStatus, String> {
    run_secret_store(move || credentials_status_for_account(&account)).await
}

pub(crate) fn credentials_clear_for_account(account: &str) -> Result<(), String> {
    validate_account_key(account)?;
    cognia_secrets::secret_store::delete(SECRET_NAMESPACE, &credential_key(account))
}

pub(crate) async fn credentials_clear_for_account_async(account: String) -> Result<(), String> {
    run_secret_store(move || credentials_clear_for_account(&account)).await
}

#[tauri::command]
// Stable renderer invoke fields; grouping them would break the IPC contract.
#[allow(clippy::too_many_arguments)]
pub async fn langfuse_credentials_set(
    app: tauri::AppHandle,
    enabled: bool,
    base_url: String,
    public_key: String,
    secret_key: Option<String>,
    environment: String,
    capture_model_content: bool,
    capture_tool_content: bool,
) -> Result<(), String> {
    credentials_set_for_account_async(
        current_account()?,
        enabled,
        base_url,
        public_key,
        secret_key,
        environment,
        capture_model_content,
        capture_tool_content,
    )
    .await?;
    use tauri::Manager as _;
    crate::claude::sidecar::restart_sidecar_for_config(
        app.state::<crate::claude::sidecar::SidecarState>()
            .inner()
            .clone(),
    )
    .await?;
    Ok(())
}

pub(crate) fn sidecar_env_for_current_account() -> Result<HashMap<String, String>, String> {
    let Ok(account) = current_account() else {
        return Ok(HashMap::new());
    };
    let Some(credentials) = load_credentials_for_account(&account)? else {
        return Ok(HashMap::new());
    };
    if !credentials.enabled
        || std::env::var("COGNIA_LANGFUSE_TRACING_DISABLED").as_deref() == Ok("1")
        || std::env::var("NEXT_PUBLIC_LANGFUSE_TRACING_DISABLED").as_deref() == Ok("1")
    {
        return Ok(HashMap::new());
    }
    Ok(sidecar_env(credentials))
}

pub(crate) async fn sidecar_env_for_current_account_async(
) -> Result<HashMap<String, String>, String> {
    run_secret_store(sidecar_env_for_current_account).await
}

fn sidecar_env(credentials: StoredLangfuseCredentials) -> HashMap<String, String> {
    HashMap::from([
        ("LANGFUSE_PUBLIC_KEY".to_string(), credentials.public_key),
        ("LANGFUSE_SECRET_KEY".to_string(), credentials.secret_key),
        ("LANGFUSE_BASE_URL".to_string(), credentials.base_url),
        ("LANGFUSE_ENVIRONMENT".to_string(), credentials.environment),
        (
            "LANGFUSE_RELEASE".to_string(),
            env!("CARGO_PKG_VERSION").to_string(),
        ),
        (
            "COGNIA_LANGFUSE_CAPTURE_MODEL_CONTENT".to_string(),
            credentials.capture_model_content.to_string(),
        ),
        (
            "COGNIA_LANGFUSE_CAPTURE_TOOL_CONTENT".to_string(),
            credentials.capture_tool_content.to_string(),
        ),
    ])
}

#[tauri::command]
pub fn langfuse_credentials_status() -> Result<LangfuseCredentialsStatus, String> {
    credentials_status_for_account(&current_account()?)
}

#[tauri::command]
pub async fn langfuse_credentials_clear(app: tauri::AppHandle) -> Result<(), String> {
    credentials_clear_for_account_async(current_account()?).await?;
    use tauri::Manager as _;
    crate::claude::sidecar::restart_sidecar_for_config(
        app.state::<crate::claude::sidecar::SidecarState>()
            .inner()
            .clone(),
    )
    .await?;
    Ok(())
}

fn is_forbidden_dest_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(value) => {
            let [first, second, third, _] = value.octets();
            value.is_private()
                || value.is_loopback()
                || value.is_link_local()
                || value.is_unspecified()
                || value.is_multicast()
                || value.is_broadcast()
                || value.is_documentation()
                || first == 0
                || (first == 100 && (64..=127).contains(&second))
                || (first == 192 && second == 0 && third == 0)
                || (first == 198 && matches!(second, 18 | 19))
                || first >= 240
        }
        IpAddr::V6(value) => {
            value
                .to_ipv4_mapped()
                .is_some_and(|mapped| is_forbidden_dest_ip(IpAddr::V4(mapped)))
                || value.is_loopback()
                || value.is_unspecified()
                || value.is_multicast()
                || value.is_unique_local()
                || value.is_unicast_link_local()
                || matches!(value.segments(), [0x2001, 0x0db8, ..])
                || matches!(value.segments(), [0x0064, 0xff9b, 0, 0, 0, 0, ..])
        }
    }
}

async fn enforce_ssrf_policy(endpoint: &url::Url) -> Result<Vec<SocketAddr>, String> {
    let host = endpoint
        .host_str()
        .ok_or_else(|| "Langfuse endpoint has no host".to_string())?;
    let port = endpoint
        .port_or_known_default()
        .ok_or_else(|| "Langfuse endpoint has no port".to_string())?;
    let addresses: Vec<_> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| format!("Langfuse endpoint DNS lookup failed: {error}"))?
        .collect();
    #[cfg(test)]
    if endpoint.host_str() == Some("127.0.0.1") {
        return Ok(addresses);
    }
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| is_forbidden_dest_ip(address.ip()))
    {
        return Err(
            "Langfuse endpoint resolved to a private, loopback, or link-local address".into(),
        );
    }
    Ok(addresses)
}

fn client_for(endpoint: &url::Url, addresses: &[SocketAddr]) -> Result<reqwest::Client, String> {
    let host = endpoint
        .host_str()
        .ok_or_else(|| "Langfuse endpoint has no host".to_string())?;
    let builder = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, addresses);
    let (builder, route) =
        cognia_net::proxy_config::apply_reqwest_policy(builder, endpoint.as_str())
            .map_err(|error| error.to_string())?;
    if matches!(
        route,
        cognia_net::proxy_config::ProxyRouteSummary::Proxy { .. }
    ) {
        return Err(
            "Credentialed Langfuse export requires direct DNS-pinned routing; proxy routing is not allowed"
                .to_string(),
        );
    }
    builder
        .build()
        .map_err(|error| format!("Langfuse client build failed: {error}"))
}

async fn post_otlp(
    credentials: &StoredLangfuseCredentials,
    payload: &Value,
) -> Result<u16, String> {
    let endpoint = otlp_endpoint(&credentials.base_url)?;
    let addresses = enforce_ssrf_policy(&endpoint).await?;
    let client = client_for(&endpoint, &addresses)?;
    let authorization = BASE64.encode(format!(
        "{}:{}",
        credentials.public_key, credentials.secret_key
    ));
    let mut last_status = 0;
    for attempt in 0..=3 {
        let response = client
            .post(endpoint.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(
                reqwest::header::AUTHORIZATION,
                format!("Basic {authorization}"),
            )
            .header("x-langfuse-ingestion-version", "4")
            .json(payload)
            .send()
            .await
            .map_err(|error| format!("Langfuse trace export failed: {error}"))?;
        last_status = response.status().as_u16();
        if response.status().is_success() {
            return Ok(last_status);
        }
        if !matches!(last_status, 429 | 502 | 503 | 504) || attempt == 3 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250 * (1_u64 << attempt))).await;
    }
    Err(format!("Langfuse trace export rejected with {last_status}"))
}

pub(crate) async fn connection_test_for_account(
    account: &str,
) -> Result<LangfuseConnectionStatus, String> {
    let credentials = load_credentials_for_account_async(account)
        .await?
        .ok_or_else(|| "Langfuse credentials are not configured".to_string())?;
    let status = post_otlp(&credentials, &json!({ "resourceSpans": [] })).await?;
    Ok(LangfuseConnectionStatus {
        connected: true,
        status,
    })
}

#[tauri::command]
pub async fn langfuse_connection_test() -> Result<LangfuseConnectionStatus, String> {
    connection_test_for_account(&current_account()?).await
}

fn validate_hex_id(value: &str, bytes: usize, label: &str) -> Result<(), String> {
    if value.len() != bytes * 2 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("Langfuse trace {label} is invalid"));
    }
    Ok(())
}

fn validate_batch(batch: &AgentTraceBatchV1) -> Result<(), String> {
    if batch.schema_version != 1 {
        return Err("unsupported AgentTraceBatch schema version".to_string());
    }
    if batch.spans.is_empty() || batch.spans.len() > MAX_BATCH_SPANS {
        return Err(format!(
            "AgentTraceBatch must contain 1..={MAX_BATCH_SPANS} spans"
        ));
    }
    let bytes = serde_json::to_vec(batch)
        .map_err(|error| format!("AgentTraceBatch serialization failed: {error}"))?;
    if bytes.len() > MAX_BATCH_BYTES {
        return Err(format!("AgentTraceBatch exceeds {MAX_BATCH_BYTES} bytes"));
    }
    for span in &batch.spans {
        validate_hex_id(&span.trace_id, 16, "traceId")?;
        validate_hex_id(&span.span_id, 8, "spanId")?;
        if let Some(parent) = span.parent_span_id.as_deref() {
            validate_hex_id(parent, 8, "parentSpanId")?;
        }
        if !span.start_time.is_finite() || span.start_time < 0.0 {
            return Err("Langfuse trace startTime is invalid".to_string());
        }
        if span.session_id.is_empty()
            || span.session_id.len() > 128
            || !cognia_net::outbound_pii::has_no_leaking_pii(&span.session_id)
        {
            return Err("Langfuse trace sessionId is invalid".to_string());
        }
        if !matches!(
            span.operation_name.as_str(),
            "invoke_agent"
                | "execute_tool"
                | "chat"
                | "invoke_workflow"
                | "retrieval"
                | "embeddings"
        ) {
            return Err("Langfuse trace operationName is invalid".to_string());
        }
        if !matches!(
            span.surface.as_str(),
            "chat"
                | "agent-team"
                | "plugin-hook"
                | "connector"
                | "workflow"
                | "mcp"
                | "retrieval"
                | "embedding"
                | "plugin"
                | "agent-rpc"
        ) {
            return Err("Langfuse trace surface is invalid".to_string());
        }
    }
    Ok(())
}

fn bounded_safe(value: Option<&str>, max_bytes: usize) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() || !cognia_net::outbound_pii::has_no_leaking_pii(value) {
        return None;
    }
    if value.len() <= max_bytes {
        return Some(value.to_string());
    }
    let mut boundary = max_bytes;
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    Some(value[..boundary].to_string())
}

fn observation_name(span: &AgentTraceSpanV1) -> String {
    match span.operation_name.as_str() {
        "invoke_agent" if span.surface == "chat" => "chat.turn".to_string(),
        "invoke_agent" => "agent.run".to_string(),
        "invoke_workflow" => "workflow.run".to_string(),
        "chat" => "llm.generate".to_string(),
        "execute_tool" => format!(
            "tool.{}",
            stable_segment(
                &bounded_safe(span.tool_name.as_deref(), 128)
                    .unwrap_or_else(|| "unknown".to_string())
            )
        ),
        "retrieval" => "retrieval.query".to_string(),
        "embeddings" => "embedding.generate".to_string(),
        _ => "span".to_string(),
    }
}

fn trace_name(span: &AgentTraceSpanV1) -> &'static str {
    if span.surface == "workflow" || span.operation_name == "invoke_workflow" {
        "workflow.run"
    } else if span.surface == "chat" {
        "chat.turn"
    } else {
        "agent.run"
    }
}

fn observation_type(operation: &str) -> &'static str {
    match operation {
        "invoke_agent" => "agent",
        "invoke_workflow" => "chain",
        "chat" => "generation",
        "execute_tool" => "tool",
        "retrieval" => "retriever",
        "embeddings" => "embedding",
        _ => "span",
    }
}

fn stable_segment(value: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for character in value.trim().chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() {
            out.push(character);
            dash = false;
        } else if !out.is_empty() && !dash {
            out.push('-');
            dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "unknown".to_string()
    } else {
        out
    }
}

fn otlp_attribute(key: &str, value: impl Into<String>) -> Value {
    json!({ "key": key, "value": { "stringValue": value.into() } })
}

fn build_payload(
    spans: &[AgentTraceSpanV1],
    credentials: &StoredLangfuseCredentials,
) -> Result<Value, String> {
    let mut wire_spans = Vec::with_capacity(spans.len());
    for span in spans {
        let trace_id = BASE64.encode(hex::decode(&span.trace_id).map_err(|_| "invalid traceId")?);
        let span_id = BASE64.encode(hex::decode(&span.span_id).map_err(|_| "invalid spanId")?);
        let mut attributes = vec![
            otlp_attribute("gen_ai.operation.name", &span.operation_name),
            otlp_attribute(
                "gen_ai.provider.name",
                bounded_safe(Some(&span.provider_name), 256)
                    .unwrap_or_else(|| "unknown".to_string()),
            ),
            otlp_attribute("gen_ai.conversation.id", &span.session_id),
            otlp_attribute(
                "langfuse.observation.type",
                observation_type(&span.operation_name),
            ),
            otlp_attribute("langfuse.trace.name", trace_name(span)),
            otlp_attribute("session.id", &span.session_id),
            otlp_attribute("langfuse.environment", &credentials.environment),
            otlp_attribute("langfuse.release", env!("CARGO_PKG_VERSION")),
            otlp_attribute("langfuse.observation.metadata.surface", &span.surface),
        ];
        for (key, value) in [
            (
                "langfuse.observation.metadata.runId",
                span.run_id.as_deref(),
            ),
            (
                "langfuse.observation.metadata.turnId",
                span.turn_id.as_deref(),
            ),
            (
                "langfuse.observation.metadata.attemptId",
                span.attempt_id.as_deref(),
            ),
            (
                "langfuse.observation.metadata.projectId",
                span.project_id.as_deref(),
            ),
            (
                "langfuse.observation.metadata.requestModel",
                span.request_model.as_deref(),
            ),
            (
                "langfuse.observation.metadata.responseModel",
                span.response_model.as_deref(),
            ),
        ] {
            if let Some(value) = bounded_safe(value, 256) {
                attributes.push(otlp_attribute(key, value));
            }
        }
        if let Some(model) = bounded_safe(
            span.response_model
                .as_deref()
                .or(span.request_model.as_deref()),
            256,
        ) {
            attributes.push(otlp_attribute("langfuse.observation.model.name", model));
        }
        if let Some(usage) = &span.usage {
            attributes.push(otlp_attribute(
                "langfuse.observation.usage_details",
                json!({
                    "input": usage.input_tokens,
                    "output": usage.output_tokens,
                    "total": usage.input_tokens.saturating_add(usage.output_tokens),
                    "cache_read_input_tokens": usage.cache_read_tokens,
                    "cache_creation_input_tokens": usage.cache_creation_tokens,
                })
                .to_string(),
            ));
        }
        if let Some(cost) = span
            .cost_usd_estimate
            .filter(|value| value.is_finite() && *value >= 0.0)
        {
            attributes.push(otlp_attribute(
                "langfuse.observation.cost_details",
                json!({ "total": cost }).to_string(),
            ));
        }
        if let Some(reasons) = span.finish_reasons.as_ref() {
            let safe: Vec<_> = reasons
                .iter()
                .filter_map(|reason| bounded_safe(Some(reason), 128))
                .take(8)
                .collect();
            if !safe.is_empty() {
                attributes.push(otlp_attribute(
                    "langfuse.observation.metadata.finishReasons",
                    serde_json::to_string(&safe).unwrap_or_default(),
                ));
            }
        }
        let capture_content = match span.operation_name.as_str() {
            "execute_tool" => credentials.capture_tool_content,
            "chat" | "invoke_agent" | "invoke_workflow" => credentials.capture_model_content,
            _ => false,
        };
        if capture_content {
            if let Some(input) = bounded_safe(span.input_preview.as_deref(), MAX_PREVIEW_BYTES) {
                attributes.push(otlp_attribute("langfuse.observation.input", input));
            }
            if let Some(output) = bounded_safe(span.output_preview.as_deref(), MAX_PREVIEW_BYTES) {
                attributes.push(otlp_attribute("langfuse.observation.output", output));
            }
        }
        let end_time = span.end_time.unwrap_or_else(|| {
            span.duration_ms
                .map(|duration| span.start_time + duration.max(0.0))
                .unwrap_or(span.start_time)
        });
        let mut wire = json!({
            "traceId": trace_id,
            "spanId": span_id,
            "name": observation_name(span),
            "kind": 1,
            "startTimeUnixNano": format!("{:.0}", span.start_time * 1_000_000.0),
            "endTimeUnixNano": format!("{:.0}", end_time * 1_000_000.0),
            "attributes": attributes,
            "status": { "code": if span.error_type.is_some() || span.status.as_deref() == Some("error") { 2 } else { 1 } },
        });
        if let Some(parent) = span.parent_span_id.as_deref() {
            wire["parentSpanId"] = Value::String(
                BASE64.encode(hex::decode(parent).map_err(|_| "invalid parentSpanId")?),
            );
        }
        wire_spans.push(wire);
    }
    Ok(json!({
        "resourceSpans": [{
            "resource": { "attributes": [
                otlp_attribute("service.name", "cognia-ai"),
                otlp_attribute("service.version", env!("CARGO_PKG_VERSION")),
                otlp_attribute("deployment.environment.name", &credentials.environment),
            ] },
            "scopeSpans": [{
                "scope": { "name": "cognia.agent-trace", "version": "1" },
                "spans": wire_spans,
            }],
        }],
    }))
}

fn enforce_rate_limit(account: &str, count: usize) -> Result<(), String> {
    let mut limits = RATE_LIMITS
        .lock()
        .map_err(|_| "Langfuse rate-limit lock poisoned".to_string())?;
    let now = Instant::now();
    limits.retain(|_, window| now.duration_since(window.started_at) < ACCOUNT_STATE_TTL);
    if !limits.contains_key(account) && limits.len() >= MAX_TRACKED_ACCOUNTS {
        if let Some(evicted) = limits.keys().next().cloned() {
            limits.remove(&evicted);
        }
    }
    let window = limits.entry(account.to_string()).or_insert(RateWindow {
        started_at: now,
        spans: 0,
    });
    if now.duration_since(window.started_at) >= Duration::from_secs(60) {
        window.started_at = now;
        window.spans = 0;
    }
    if window.spans.saturating_add(count) > MAX_SPANS_PER_MINUTE {
        return Err("Langfuse trace rate limit exceeded".to_string());
    }
    window.spans += count;
    Ok(())
}

fn reserve_unique_spans(
    account: &str,
    spans: &[AgentTraceSpanV1],
) -> Result<(Vec<AgentTraceSpanV1>, Vec<String>, usize), String> {
    let mut all = DEDUPE
        .lock()
        .map_err(|_| "Langfuse dedupe lock poisoned".to_string())?;
    let now = Instant::now();
    all.retain(|_, state| now.duration_since(state.last_seen) < ACCOUNT_STATE_TTL);
    if !all.contains_key(account) && all.len() >= MAX_TRACKED_ACCOUNTS {
        if let Some(evicted) = all.keys().next().cloned() {
            all.remove(&evicted);
        }
    }
    let state = all.entry(account.to_string()).or_default();
    state.last_seen = now;
    let mut unique = Vec::new();
    let mut reserved = Vec::new();
    let mut duplicates = 0;
    for span in spans {
        let key = format!("{}:{}", span.trace_id, span.span_id);
        if state.keys.contains(&key) {
            duplicates += 1;
            continue;
        }
        state.keys.insert(key.clone());
        state.order.push_back(key.clone());
        reserved.push(key);
        unique.push(span.clone());
    }
    while state.order.len() > MAX_DEDUPE_KEYS {
        if let Some(oldest) = state.order.pop_front() {
            state.keys.remove(&oldest);
        }
    }
    Ok((unique, reserved, duplicates))
}

fn release_reserved(account: &str, reserved: &[String]) {
    let Ok(mut all) = DEDUPE.lock() else {
        return;
    };
    let Some(state) = all.get_mut(account) else {
        return;
    };
    // Set membership, not `slice::contains`. The retain below visits up to
    // MAX_DEDUPE_KEYS entries and a linear scan of `reserved` on each one is
    // O(50_000 * 128) string comparisons — all of it inside the process-global
    // DEDUPE lock that every account's ingest contends on.
    let released: HashSet<&str> = reserved.iter().map(String::as_str).collect();
    for key in &released {
        state.keys.remove(*key);
    }
    state.order.retain(|key| !released.contains(key.as_str()));
}

pub(crate) async fn trace_ingest_for_account(
    account: &str,
    batch: AgentTraceBatchV1,
) -> Result<LangfuseTraceIngestResult, String> {
    validate_account_key(account)?;
    validate_batch(&batch)?;
    enforce_rate_limit(account, batch.spans.len())?;
    let credentials = load_credentials_for_account_async(account)
        .await?
        .ok_or_else(|| "Langfuse credentials are not configured".to_string())?;
    if !credentials.enabled {
        return Err("Langfuse tracing is disabled for this account".to_string());
    }
    let (unique, reserved, duplicate_spans) = reserve_unique_spans(account, &batch.spans)?;
    if unique.is_empty() {
        return Ok(LangfuseTraceIngestResult {
            accepted_spans: 0,
            duplicate_spans,
            status: 202,
        });
    }
    let payload = build_payload(&unique, &credentials)?;
    match post_otlp(&credentials, &payload).await {
        Ok(status) => Ok(LangfuseTraceIngestResult {
            accepted_spans: unique.len(),
            duplicate_spans,
            status,
        }),
        Err(error) => {
            release_reserved(account, &reserved);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn langfuse_trace_ingest(
    batch: AgentTraceBatchV1,
) -> Result<LangfuseTraceIngestResult, String> {
    trace_ingest_for_account(&current_account()?, batch).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn credentials(base_url: String) -> StoredLangfuseCredentials {
        StoredLangfuseCredentials {
            enabled: true,
            base_url,
            public_key: "pk-project".to_string(),
            secret_key: "sk-project".to_string(),
            environment: "test".to_string(),
            capture_model_content: false,
            capture_tool_content: false,
        }
    }

    fn span(operation_name: &str) -> AgentTraceSpanV1 {
        AgentTraceSpanV1 {
            id: "1111222233334444".to_string(),
            project_id: Some("project-1".to_string()),
            trace_id: "a".repeat(32),
            span_id: "b".repeat(16),
            parent_span_id: None,
            start_time: 1_700_000_000_000.0,
            end_time: Some(1_700_000_000_100.0),
            duration_ms: Some(100.0),
            operation_name: operation_name.to_string(),
            provider_name: "openai".to_string(),
            request_model: Some("gpt-5".to_string()),
            response_model: Some("gpt-5-2026-08-01".to_string()),
            tool_name: None,
            usage: None,
            cost_usd_estimate: None,
            finish_reasons: None,
            error_type: None,
            status: Some("ok".to_string()),
            run_id: Some("run-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            attempt_id: Some("attempt-1".to_string()),
            session_id: "session-1".to_string(),
            surface: "chat".to_string(),
            input_preview: Some("private model input".to_string()),
            output_preview: Some("private model output".to_string()),
        }
    }

    #[test]
    fn fixes_the_v4_path_and_rejects_credentialed_or_non_http_urls() {
        assert_eq!(
            otlp_endpoint("https://langfuse.example/custom")
                .unwrap()
                .as_str(),
            "https://langfuse.example/api/public/otel/v1/traces"
        );
        assert!(normalize_base_url("file:///tmp/langfuse").is_err());
        assert!(normalize_base_url("http://langfuse.example").is_err());
        assert!(normalize_base_url("https://user:pass@example.com").is_err());
    }

    #[test]
    fn ssrf_policy_rejects_non_public_and_ipv4_mapped_destinations() {
        for value in [
            "127.0.0.1",
            "100.64.0.1",
            "198.18.0.1",
            "240.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "2001:db8::1",
        ] {
            assert!(
                is_forbidden_dest_ip(value.parse().expect("IP")),
                "allowed {value}"
            );
        }
        assert!(!is_forbidden_dest_ip("1.1.1.1".parse().expect("IP")));
        assert!(!is_forbidden_dest_ip(
            "2606:4700:4700::1111".parse().expect("IP")
        ));
    }

    #[test]
    fn host_content_policy_is_field_level_and_defaults_to_metadata_only() {
        let value = credentials("https://langfuse.example".to_string());
        let payload = build_payload(&[span("chat")], &value).unwrap().to_string();
        assert!(!payload.contains("private model input"));
        assert!(!payload.contains("private model output"));
        assert!(payload.contains("langfuse.observation.metadata.runId"));

        let mut opted_in = value;
        opted_in.capture_model_content = true;
        let mut unsafe_span = span("chat");
        unsafe_span.input_preview = Some("jane.doe@example.com".to_string());
        let payload = build_payload(&[unsafe_span], &opted_in)
            .unwrap()
            .to_string();
        assert!(!payload.contains("jane.doe@example.com"));
        assert!(payload.contains("private model output"));
    }

    #[test]
    fn validates_schema_ids_batch_limits_and_operation_names() {
        let valid = AgentTraceBatchV1 {
            schema_version: 1,
            spans: vec![span("chat")],
        };
        assert!(validate_batch(&valid).is_ok());
        let mut invalid = valid;
        invalid.schema_version = 2;
        assert!(validate_batch(&invalid).is_err());
        invalid.schema_version = 1;
        invalid.spans[0].trace_id = "not-hex".to_string();
        assert!(validate_batch(&invalid).is_err());
        invalid.spans[0].trace_id = "a".repeat(32);
        invalid.spans[0].surface = "jane.doe@example.com".to_string();
        assert!(validate_batch(&invalid).is_err());
    }

    #[test]
    fn status_never_serializes_the_secret_and_sidecar_env_is_destination_specific() {
        let value = credentials("https://langfuse.example".to_string());
        let env = sidecar_env(value.clone());
        assert_eq!(
            env.get("LANGFUSE_SECRET_KEY"),
            Some(&"sk-project".to_string())
        );
        assert!(!env.contains_key("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"));
        assert!(!env.contains_key("COGNIA_POSTHOG_DESTINATIONS_JSON"));

        let status = LangfuseCredentialsStatus {
            configured: true,
            enabled: value.enabled,
            base_url: Some(value.base_url),
            public_key: Some(value.public_key),
            environment: Some(value.environment),
            capture_model_content: value.capture_model_content,
            capture_tool_content: value.capture_tool_content,
        };
        assert!(!serde_json::to_string(&status)
            .unwrap()
            .contains("sk-project"));
    }

    #[tokio::test]
    async fn rejects_ingest_when_the_account_destination_is_disabled() {
        let account = "disabled-account";
        let mut value = credentials("https://langfuse.example".to_string());
        value.enabled = false;
        save_credentials_for_account(account, &value).expect("save credentials");

        let error = trace_ingest_for_account(
            account,
            AgentTraceBatchV1 {
                schema_version: 1,
                spans: vec![span("chat")],
            },
        )
        .await
        .expect_err("disabled destination must reject ingest");

        assert_eq!(error, "Langfuse tracing is disabled for this account");
        credentials_clear_for_account(account).expect("clear credentials");
    }

    #[tokio::test]
    async fn legacy_host_secret_cannot_be_bound_to_a_renderer_destination() {
        let account = "legacy-migration-account";
        crate::telemetry::telemetry_secret_set(
            crate::telemetry::TelemetrySecretKind::LangfuseSecretKey,
            "sk-legacy".to_string(),
        )
        .await
        .expect("seed legacy secret");

        let error = credentials_set_for_account(
            account,
            true,
            "https://langfuse.example".to_string(),
            "pk-project".to_string(),
            None,
            "test".to_string(),
            false,
            false,
        )
        .expect_err("legacy secret must not be rebound");
        assert!(error.contains("secret key is required"));
        assert!(load_credentials_for_account(account)
            .expect("load credentials")
            .is_none());
        assert!(crate::telemetry::legacy_langfuse_secret()
            .expect("legacy status")
            .is_some());

        credentials_set_for_account(
            account,
            true,
            "https://langfuse.example".to_string(),
            "pk-project".to_string(),
            Some("sk-fresh".to_string()),
            "test".to_string(),
            false,
            false,
        )
        .expect("save fresh credentials");
        let stored = load_credentials_for_account(account)
            .expect("load credentials")
            .expect("stored credentials");
        assert_eq!(stored.secret_key, "sk-fresh");
        assert!(crate::telemetry::legacy_langfuse_secret()
            .expect("legacy status")
            .is_none());
        credentials_clear_for_account(account).expect("clear credentials");
    }

    #[test]
    fn destination_change_requires_a_fresh_secret() {
        let account = "destination-repoint-account";
        save_credentials_for_account(
            account,
            &credentials("https://langfuse.example".to_string()),
        )
        .expect("seed credentials");

        let error = credentials_set_for_account(
            account,
            true,
            "https://attacker.example".to_string(),
            "pk-attacker".to_string(),
            None,
            "test".to_string(),
            false,
            false,
        )
        .expect_err("destination change without secret");

        assert!(error.contains("fresh Langfuse secret"));
        let stored = load_credentials_for_account(account)
            .expect("load credentials")
            .expect("stored credentials");
        assert_eq!(stored.base_url, "https://langfuse.example");
        assert_eq!(stored.public_key, "pk-project");
        credentials_clear_for_account(account).expect("clear credentials");
    }

    #[test]
    fn unchanged_destination_can_reuse_the_stored_secret() {
        let account = "same-destination-account";
        save_credentials_for_account(
            account,
            &credentials("https://langfuse.example".to_string()),
        )
        .expect("seed credentials");

        credentials_set_for_account(
            account,
            true,
            "https://langfuse.example".to_string(),
            "pk-project".to_string(),
            None,
            "production".to_string(),
            false,
            true,
        )
        .expect("reuse same destination secret");

        let stored = load_credentials_for_account(account)
            .expect("load credentials")
            .expect("stored credentials");
        assert_eq!(stored.secret_key, "sk-project");
        assert_eq!(stored.environment, "production");
        assert!(stored.capture_tool_content);
        credentials_clear_for_account(account).expect("clear credentials");
    }

    #[tokio::test]
    async fn sends_only_otlp_traces_with_v4_and_basic_auth_headers() {
        cognia_net::proxy_config::apply_current(cognia_net::proxy_config::ProxyConfig::default())
            .expect("proxy policy");
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("connection");
            let mut bytes = vec![0; 16 * 1024];
            let count = stream.read(&mut bytes).await.expect("request");
            stream
                .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n")
                .await
                .expect("response");
            String::from_utf8_lossy(&bytes[..count]).to_string()
        });
        let status = post_otlp(
            &credentials(format!("http://{address}")),
            &json!({ "resourceSpans": [] }),
        )
        .await
        .expect("export");
        let request = server.await.expect("server");

        assert_eq!(status, 202);
        assert!(request.contains("POST /api/public/otel/v1/traces"));
        assert!(request
            .to_ascii_lowercase()
            .contains("x-langfuse-ingestion-version: 4"));
        assert!(
            request.contains(&format!(
                "authorization: Basic {}",
                BASE64.encode("pk-project:sk-project")
            )) || request.contains(&format!(
                "Authorization: Basic {}",
                BASE64.encode("pk-project:sk-project")
            ))
        );
        assert!(!request.contains("/api/public/ingestion"));
        assert!(!request.contains("/v1/logs"));
        assert!(!request.contains("/v1/metrics"));
    }
}
