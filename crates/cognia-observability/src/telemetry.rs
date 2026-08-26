use std::collections::HashMap;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::RwLock;

const TELEMETRY_SECRET_NAMESPACE: &str = "telemetry";
const GRAFANA_API_TOKEN_KEY: &str = "grafana-cloud-api-token";
const LANGFUSE_SECRET_KEY: &str = "langfuse-secret-key";
const EXPORT_TIMEOUT: Duration = Duration::from_secs(15);
static TELEMETRY_EXPORT_CANCELLATIONS: Lazy<
    cognia_net::request_cancellation::RequestCancellationRegistry,
> = Lazy::new(Default::default);

#[cfg(any(test, feature = "otel-export"))]
fn resolve_otlp_trace_endpoint(specific: Option<&str>, base: Option<&str>) -> Option<String> {
    specific
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            base.map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| format!("{}/v1/traces", value.trim_end_matches('/')))
        })
}

#[cfg(any(test, feature = "otel-export"))]
fn parse_otlp_headers(value: &str) -> Result<HashMap<String, String>, String> {
    let mut headers = HashMap::new();
    for entry in value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        let (name, encoded_value) = entry
            .split_once('=')
            .ok_or_else(|| "OTEL_EXPORTER_OTLP_HEADERS entries must use name=value".to_string())?;
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty()
            || !name.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(
                        byte,
                        b'!' | b'#'
                            | b'$'
                            | b'%'
                            | b'&'
                            | b'\''
                            | b'*'
                            | b'+'
                            | b'-'
                            | b'.'
                            | b'^'
                            | b'_'
                            | b'`'
                            | b'|'
                            | b'~'
                    )
            })
        {
            return Err("invalid OTLP header name".to_string());
        }
        let form = format!("value={}", encoded_value.trim());
        let decoded = url::form_urlencoded::parse(form.as_bytes())
            .find_map(|(key, value)| (key == "value").then(|| value.into_owned()))
            .unwrap_or_default();
        if decoded.contains(['\r', '\n']) {
            return Err("invalid OTLP header value".to_string());
        }
        headers.insert(name, decoded);
    }
    Ok(headers)
}

/// `pub` across the crate boundary (ADR-0067 Tier C): `companion_api`'s
/// remote-execution path validates inbound traceparents and stayed app-side.
pub fn validate_traceparent(value: &str) -> Option<String> {
    let value = value.trim();
    let mut parts = value.split('-');
    let version = parts.next()?;
    let trace_id = parts.next()?;
    let parent_id = parts.next()?;
    let flags = parts.next()?;
    if parts.next().is_some()
        || version != "00"
        || trace_id.len() != 32
        || parent_id.len() != 16
        || flags.len() != 2
        || ![version, trace_id, parent_id, flags]
            .iter()
            .all(|part| part.bytes().all(|byte| byte.is_ascii_hexdigit()))
        || trace_id.bytes().all(|byte| byte == b'0')
        || parent_id.bytes().all(|byte| byte == b'0')
    {
        return None;
    }
    Some(value.to_ascii_lowercase())
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum TelemetryCredential {
    None,
    GrafanaCloud { instance_id: String },
    Posthog { project_token: String },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PostHogDestinationConfig {
    id: String,
    host: String,
    project_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SidecarTelemetryConfig {
    otlp_enabled: bool,
    endpoint: String,
    headers: HashMap<String, String>,
    service_name: String,
    environment: String,
    credential: TelemetryCredential,
    posthog_destinations: Vec<PostHogDestinationConfig>,
    installation_id: String,
}

static SIDECAR_CONFIG: Lazy<RwLock<Option<SidecarTelemetryConfig>>> =
    Lazy::new(|| RwLock::new(None));

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TelemetrySecretKind {
    GrafanaCloudApiToken,
    LangfuseSecretKey,
}

impl TelemetrySecretKind {
    fn key(self) -> &'static str {
        match self {
            Self::GrafanaCloudApiToken => GRAFANA_API_TOKEN_KEY,
            Self::LangfuseSecretKey => LANGFUSE_SECRET_KEY,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryExportResult {
    pub status: u16,
    pub accepted: bool,
}

fn validate_endpoint(endpoint: &str) -> Result<url::Url, String> {
    let parsed =
        url::Url::parse(endpoint).map_err(|e| format!("invalid telemetry endpoint: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("telemetry endpoint must use http or https".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("telemetry endpoint must not embed credentials".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("telemetry endpoint must not include a query or fragment".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("telemetry endpoint must include a host".to_string());
    }
    Ok(parsed)
}

fn validate_credential_destination(
    endpoint: &url::Url,
    credential: &TelemetryCredential,
) -> Result<(), String> {
    if matches!(credential, TelemetryCredential::GrafanaCloud { .. }) {
        let host = endpoint.host_str().unwrap_or_default().to_ascii_lowercase();
        let path = endpoint.path().trim_end_matches('/');
        if endpoint.scheme() != "https"
            || !host.ends_with(".grafana.net")
            || !matches!(path, "/otlp/v1/traces" | "/otlp/v1/logs")
        {
            return Err(
                "Grafana Cloud credentials require an approved grafana.net OTLP endpoint"
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn is_sensitive_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization" | "proxy-authorization" | "cookie" | "set-cookie" | "x-api-key"
    )
}

fn sanitize_renderer_headers(
    headers: HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    for (name, value) in headers {
        if !name.eq_ignore_ascii_case("content-type")
            || !value.eq_ignore_ascii_case("application/json")
        {
            return Err(format!(
                "renderer-supplied telemetry header is not allowed: {name}"
            ));
        }
    }
    // The Host sets Content-Type itself. All authentication is injected below
    // from a credential reference resolved inside the native secret store.
    Ok(HashMap::new())
}

fn is_valid_otlp_id(value: &str, hex_length: usize, byte_length: usize) -> bool {
    if value.len() == hex_length
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        && value.bytes().any(|byte| byte != b'0')
    {
        return true;
    }
    BASE64
        .decode(value)
        .is_ok_and(|decoded| decoded.len() == byte_length && decoded.iter().any(|byte| *byte != 0))
}

fn telemetry_payload_has_no_leaking_pii(value: &serde_json::Value, field: &str) -> bool {
    match value {
        serde_json::Value::String(text) => {
            match field {
                "traceId" => return is_valid_otlp_id(text, 32, 16),
                "spanId" | "parentSpanId" => return is_valid_otlp_id(text, 16, 8),
                "timeUnixNano"
                | "observedTimeUnixNano"
                | "startTimeUnixNano"
                | "endTimeUnixNano"
                | "intValue" => {
                    return text.parse::<i128>().is_ok();
                }
                _ => {}
            }
            if field == "api_key"
                && text.starts_with("phc_")
                && text.len() <= 512
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            {
                return true;
            }
            cognia_net::outbound_pii::has_no_leaking_pii(&format!("{field}: {text}"))
        }
        serde_json::Value::Array(items) => items
            .iter()
            .all(|item| telemetry_payload_has_no_leaking_pii(item, field)),
        serde_json::Value::Object(items) => items.iter().all(|(key, item)| {
            cognia_net::outbound_pii::has_no_leaking_pii(key)
                && telemetry_payload_has_no_leaking_pii(item, key)
        }),
        _ => true,
    }
}

fn build_headers(
    headers: HashMap<String, String>,
    credential: TelemetryCredential,
) -> Result<HashMap<String, String>, String> {
    let secret = match &credential {
        TelemetryCredential::None => None,
        TelemetryCredential::GrafanaCloud { .. } => {
            cognia_secrets::secret_store::get(TELEMETRY_SECRET_NAMESPACE, GRAFANA_API_TOKEN_KEY)?
        }
        TelemetryCredential::Posthog { .. } => None,
    };
    build_headers_with_secret(headers, credential, secret.as_deref())
}

fn build_headers_with_secret(
    headers: HashMap<String, String>,
    credential: TelemetryCredential,
    secret: Option<&str>,
) -> Result<HashMap<String, String>, String> {
    let mut out = HashMap::with_capacity(headers.len() + 1);
    for (name, value) in headers {
        if is_sensitive_header(&name) {
            return Err(format!(
                "renderer-supplied sensitive header is not allowed: {name}"
            ));
        }
        let normalized = name.trim().to_ascii_lowercase();
        if normalized.is_empty() || value.contains(['\r', '\n']) {
            return Err("invalid telemetry header".to_string());
        }
        out.insert(normalized, value);
    }

    match credential {
        TelemetryCredential::None => {}
        TelemetryCredential::GrafanaCloud { instance_id } => {
            let token = secret.filter(|value| !value.is_empty()).ok_or_else(|| {
                "Grafana Cloud API token is not available in the secret store".to_string()
            })?;
            if instance_id.trim().is_empty() {
                return Err("Grafana Cloud instance ID is required".to_string());
            }
            let encoded = BASE64.encode(format!("{}:{token}", instance_id.trim()));
            out.insert("authorization".to_string(), format!("Basic {encoded}"));
        }
        TelemetryCredential::Posthog { project_token } => {
            let project_token = project_token.trim();
            if !project_token.starts_with("phc_") || project_token.len() > 512 {
                return Err("PostHog project token is invalid".to_string());
            }
            out.insert(
                "authorization".to_string(),
                format!("Bearer {project_token}"),
            );
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn telemetry_secret_set(kind: TelemetrySecretKind, value: String) -> Result<(), String> {
    if value.is_empty() {
        return Err("telemetry secret must not be empty".to_string());
    }
    cognia_secrets::secret_store::set(TELEMETRY_SECRET_NAMESPACE, kind.key(), &value)
}

#[tauri::command]
pub async fn telemetry_secret_has(kind: TelemetrySecretKind) -> Result<bool, String> {
    Ok(cognia_secrets::secret_store::get(TELEMETRY_SECRET_NAMESPACE, kind.key())?.is_some())
}

#[tauri::command]
pub async fn telemetry_secret_clear(kind: TelemetrySecretKind) -> Result<(), String> {
    cognia_secrets::secret_store::delete(TELEMETRY_SECRET_NAMESPACE, kind.key())
}

/// Read the pre-v4 Langfuse secret only for the account-scoped Host migration.
/// It is never exposed through a command or serialized back to the renderer.
pub fn legacy_langfuse_secret() -> Result<Option<String>, String> {
    cognia_secrets::secret_store::get(TELEMETRY_SECRET_NAMESPACE, LANGFUSE_SECRET_KEY)
}

/// Remove the pre-v4 secret after it has been committed to the account store.
pub fn clear_legacy_langfuse_secret() -> Result<(), String> {
    cognia_secrets::secret_store::delete(TELEMETRY_SECRET_NAMESPACE, LANGFUSE_SECRET_KEY)
}

#[tauri::command]
pub async fn telemetry_otlp_export(
    request_id: String,
    endpoint: String,
    body: String,
    headers: HashMap<String, String>,
    credential: TelemetryCredential,
    traceparent: Option<String>,
) -> Result<TelemetryExportResult, String> {
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("telemetry request id is invalid".to_string());
    }
    let traceparent = match traceparent {
        Some(value) => Some(
            validate_traceparent(&value)
                .ok_or_else(|| "telemetry traceparent is invalid".to_string())?,
        ),
        None => None,
    };
    let payload = serde_json::from_str::<serde_json::Value>(&body)
        .map_err(|error| format!("telemetry payload must be valid JSON: {error}"))?;
    if !telemetry_payload_has_no_leaking_pii(&payload, "payload") {
        return Err("telemetry payload rejected by outbound PII gate".to_string());
    }
    let endpoint = validate_endpoint(&endpoint)?;
    validate_credential_destination(&endpoint, &credential)?;
    if matches!(&credential, TelemetryCredential::Posthog { .. })
        && endpoint.path().trim_end_matches('/') != "/i/v0/ai/otel"
    {
        return Err("PostHog telemetry must use the /i/v0/ai/otel endpoint".to_string());
    }
    let headers = build_headers(sanitize_renderer_headers(headers)?, credential)?;
    let builder = reqwest::Client::builder().timeout(EXPORT_TIMEOUT);
    let (builder, _) = cognia_net::proxy_config::apply_reqwest_policy(builder, endpoint.as_str())
        .map_err(|error| error.to_string())?;
    let client = builder
        .build()
        .map_err(|e| format!("telemetry client build failed: {e}"))?;
    let mut request = client
        .post(endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(value) = traceparent {
        request = request.header("traceparent", value);
    }
    let (generation, cancelled) = TELEMETRY_EXPORT_CANCELLATIONS.register(&request_id);
    let request_task = tauri::async_runtime::spawn(async move { request.send().await });
    let abort_handle = request_task.inner().abort_handle();
    let cancellation_task = tauri::async_runtime::spawn(async move {
        if cancelled.await.is_ok() {
            abort_handle.abort();
        }
    });
    let response = request_task.await;
    TELEMETRY_EXPORT_CANCELLATIONS.finish(&request_id, generation);
    cancellation_task.abort();
    let response = response
        .map_err(|_| "telemetry export cancelled".to_string())?
        .map_err(|e| format!("telemetry export failed: {e}"))?;
    let status = response.status().as_u16();
    Ok(TelemetryExportResult {
        status,
        accepted: response.status().is_success(),
    })
}

#[tauri::command]
pub fn telemetry_otlp_cancel(request_id: String) -> bool {
    TELEMETRY_EXPORT_CANCELLATIONS.cancel(&request_id)
}

#[cfg(feature = "otel-export")]
mod native_otel {
    use std::collections::HashMap;
    use std::sync::{OnceLock, RwLock};
    use std::time::Duration;

    use once_cell::sync::Lazy;
    use opentelemetry::global;
    use opentelemetry::metrics::{Counter, Histogram};
    use opentelemetry::trace::TracerProvider as _;
    use opentelemetry::{KeyValue, Value};
    use opentelemetry_otlp::{WithExportConfig, WithHttpConfig};
    use opentelemetry_sdk::metrics::SdkMeterProvider;
    use opentelemetry_sdk::propagation::TraceContextPropagator;
    use opentelemetry_sdk::trace::{SdkTracer, SdkTracerProvider};
    use tracing_opentelemetry::OpenTelemetrySpanExt;

    struct NativeMetrics {
        histogram: Histogram<f64>,
        errors: Counter<u64>,
    }

    static METRICS: Lazy<RwLock<Option<NativeMetrics>>> = Lazy::new(|| RwLock::new(None));
    static OBSERVER_INSTALLED: OnceLock<()> = OnceLock::new();

    pub fn init_tracer() -> Result<SdkTracer, String> {
        let traces_endpoint = std::env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT").ok();
        let base_endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok();
        let endpoint = super::resolve_otlp_trace_endpoint(
            traces_endpoint.as_deref(),
            base_endpoint.as_deref(),
        )
        .ok_or_else(|| {
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT is not configured"
                .to_string()
        })?;
        let raw_headers = std::env::var("OTEL_EXPORTER_OTLP_TRACES_HEADERS")
            .ok()
            .or_else(|| std::env::var("OTEL_EXPORTER_OTLP_HEADERS").ok())
            .unwrap_or_default();
        let headers = super::parse_otlp_headers(&raw_headers)?;
        init_tracer_with(&endpoint, headers)
    }

    fn init_tracer_with(
        endpoint: &str,
        headers: HashMap<String, String>,
    ) -> Result<SdkTracer, String> {
        global::set_text_map_propagator(TraceContextPropagator::new());
        let exporter = opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .with_endpoint(endpoint)
            .with_headers(headers.clone())
            .build()
            .map_err(|error| format!("OTLP span exporter build failed: {error}"))?;
        let provider = SdkTracerProvider::builder()
            .with_batch_exporter(exporter)
            .build();
        let tracer = provider.tracer("cognia-native");
        let metrics_endpoint = endpoint.replace("/v1/traces", "/v1/metrics");
        let metric_exporter = opentelemetry_otlp::MetricExporter::builder()
            .with_http()
            .with_endpoint(metrics_endpoint)
            .with_headers(headers)
            .build()
            .map_err(|error| format!("OTLP metric exporter build failed: {error}"))?;
        let meter_provider = SdkMeterProvider::builder()
            .with_periodic_exporter(metric_exporter)
            .build();
        global::set_meter_provider(meter_provider.clone());
        let meter = global::meter("cognia.native.metrics");
        let metrics = NativeMetrics {
            histogram: meter
                .f64_histogram("cognia.operation.duration")
                .with_unit("ms")
                .build(),
            errors: meter.u64_counter("cognia.operation.errors").build(),
        };
        *METRICS
            .write()
            .map_err(|_| "native metrics lock poisoned".to_string())? = Some(metrics);
        if OBSERVER_INSTALLED.set(()).is_ok() {
            let _ = cognia_instrument::registry::set_metrics_observer(observe_metric);
        }
        global::set_tracer_provider(provider);
        Ok(tracer)
    }

    pub fn configure_exporter(
        endpoint: &str,
        headers: HashMap<String, String>,
    ) -> Result<(), String> {
        let tracer = init_tracer_with(endpoint, headers)?;
        crate::logging::tracing_setup::configure_otel_tracer(Some(tracer))
    }

    pub fn disable_exporter() -> Result<(), String> {
        if let Ok(mut metrics) = METRICS.write() {
            *metrics = None;
        }
        crate::logging::tracing_setup::configure_otel_tracer(None)
    }

    pub fn set_parent(span: &tracing::Span, traceparent: Option<&str>) {
        let Some(traceparent) = traceparent.filter(|value| !value.is_empty()) else {
            return;
        };
        let carrier = HashMap::from([("traceparent".to_string(), traceparent.to_string())]);
        let parent = global::get_text_map_propagator(|propagator| propagator.extract(&carrier));
        let _ = span.set_parent(parent);
    }

    fn observe_metric(name: &'static str, elapsed: Duration, ok: bool) {
        let Ok(metrics) = METRICS.read() else {
            return;
        };
        let Some(metrics) = metrics.as_ref() else {
            return;
        };
        let attrs = [KeyValue::new("operation", Value::from(name))];
        metrics
            .histogram
            .record(elapsed.as_secs_f64() * 1000.0, &attrs);
        if !ok {
            metrics.errors.add(1, &attrs);
        }
    }
}

#[cfg(feature = "otel-export")]
pub use native_otel::{configure_exporter, disable_exporter, init_tracer, set_parent};

#[cfg(not(feature = "otel-export"))]
pub fn set_parent(_span: &tracing::Span, _traceparent: Option<&str>) {}

// The argument list is the IPC contract: the renderer invokes this command
// with these exact named keys, so collapsing them into a struct would change
// the payload shape rather than simplify anything.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn telemetry_configure_sidecar(
    enabled: bool,
    endpoint: String,
    headers: HashMap<String, String>,
    service_name: String,
    environment: String,
    credential: TelemetryCredential,
    posthog_destinations: Option<Vec<PostHogDestinationConfig>>,
    installation_id: Option<String>,
) -> Result<bool, String> {
    let headers = if enabled {
        sanitize_renderer_headers(headers)?
    } else {
        // Disabling must always be possible, even when persisted legacy state
        // still contains renderer-owned headers that are no longer accepted.
        HashMap::new()
    };
    let posthog_destinations = posthog_destinations.unwrap_or_default();
    for destination in &posthog_destinations {
        validate_endpoint(&destination.host)?;
        if destination.id != "managed" && destination.id != "byo" {
            return Err("PostHog destination id must be managed or byo".to_string());
        }
        if !destination.project_token.trim().starts_with("phc_")
            || destination.project_token.len() > 512
        {
            return Err("PostHog project token is invalid".to_string());
        }
    }
    let any_enabled = enabled || !posthog_destinations.is_empty();
    let next = if any_enabled {
        if enabled {
            let parsed_endpoint = validate_endpoint(&endpoint)?;
            validate_credential_destination(&parsed_endpoint, &credential)?;
            // Validate both non-sensitive headers and the referenced keyring
            // credential before replacing the active sidecar configuration.
            let resolved_headers = build_headers(headers.clone(), credential.clone())?;
            #[cfg(feature = "otel-export")]
            configure_exporter(&endpoint, resolved_headers)?;
            #[cfg(not(feature = "otel-export"))]
            let _ = resolved_headers;
        } else {
            #[cfg(feature = "otel-export")]
            disable_exporter()?;
        }
        Some(SidecarTelemetryConfig {
            otlp_enabled: enabled,
            endpoint,
            headers,
            service_name,
            environment,
            credential,
            posthog_destinations,
            installation_id: installation_id.unwrap_or_default(),
        })
    } else {
        #[cfg(feature = "otel-export")]
        disable_exporter()?;
        None
    };
    let mut current = SIDECAR_CONFIG
        .write()
        .map_err(|_| "telemetry sidecar config lock poisoned".to_string())?;
    let changed = *current != next;
    *current = next;
    Ok(changed)
}

pub fn sidecar_env() -> Result<HashMap<String, String>, String> {
    let config = SIDECAR_CONFIG
        .read()
        .map_err(|_| "telemetry sidecar config lock poisoned".to_string())?
        .clone();
    let Some(config) = config else {
        return Ok(HashMap::new());
    };
    let mut env = HashMap::from([("OTEL_SERVICE_NAME".to_string(), config.service_name)]);
    let headers = if config.otlp_enabled {
        env.insert(
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT".to_string(),
            config.endpoint,
        );
        build_headers(config.headers, config.credential)?
    } else {
        HashMap::new()
    };
    if !config.environment.trim().is_empty() {
        env.insert(
            "OTEL_RESOURCE_ATTRIBUTES".to_string(),
            format!("deployment.environment.name={}", config.environment.trim()),
        );
    }
    if !headers.is_empty() {
        let encoded = serde_json::to_string(&headers)
            .map_err(|error| format!("telemetry headers serialization failed: {error}"))?;
        env.insert("COGNIA_OTEL_EXPORTER_HEADERS_JSON".to_string(), encoded);
    }
    if !config.posthog_destinations.is_empty() {
        let encoded = serde_json::to_string(&config.posthog_destinations)
            .map_err(|error| format!("PostHog configuration serialization failed: {error}"))?;
        env.insert("COGNIA_POSTHOG_DESTINATIONS_JSON".to_string(), encoded);
    }
    if !config.installation_id.trim().is_empty() {
        env.insert(
            "COGNIA_OBSERVABILITY_INSTALLATION_ID".to_string(),
            config.installation_id,
        );
    }
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn accepts_http_and_https_otlp_endpoints() {
        assert!(validate_endpoint("http://localhost:4318/v1/traces").is_ok());
        assert!(validate_endpoint("https://example.com/v1/logs").is_ok());
    }

    #[test]
    fn rejects_non_http_endpoints_and_embedded_credentials() {
        assert!(validate_endpoint("file:///tmp/collector").is_err());
        assert!(validate_endpoint("https://user:pass@example.com/v1/traces").is_err());
        assert!(validate_endpoint("https://example.com/v1/traces?api_key=secret").is_err());
        assert!(validate_endpoint("https://example.com/v1/traces#secret").is_err());
    }

    #[test]
    fn grafana_credentials_are_bound_to_approved_otlp_destinations() {
        let credential = TelemetryCredential::GrafanaCloud {
            instance_id: "1234567".to_string(),
        };
        let approved =
            validate_endpoint("https://otlp-gateway-prod-us-central-0.grafana.net/otlp/v1/logs")
                .expect("approved endpoint");
        let attacker =
            validate_endpoint("https://attacker.example/otlp/v1/logs").expect("valid URL");

        assert!(validate_credential_destination(&approved, &credential).is_ok());
        assert!(validate_credential_destination(&attacker, &credential).is_err());
    }

    #[test]
    fn standard_otlp_trace_endpoint_prefers_signal_specific_configuration() {
        assert_eq!(
            resolve_otlp_trace_endpoint(
                Some("https://collector.example/custom"),
                Some("https://collector.example/base"),
            )
            .unwrap(),
            "https://collector.example/custom"
        );
        assert_eq!(
            resolve_otlp_trace_endpoint(None, Some("https://collector.example/base/")).unwrap(),
            "https://collector.example/base/v1/traces"
        );
        assert!(resolve_otlp_trace_endpoint(None, None).is_none());
    }

    #[test]
    fn standard_otlp_headers_decode_values_and_reject_line_breaks() {
        let headers = parse_otlp_headers("authorization=Bearer%20token,x-tenant=tenant-a")
            .expect("valid OTLP headers");
        assert_eq!(headers.get("authorization").unwrap(), "Bearer token");
        assert_eq!(headers.get("x-tenant").unwrap(), "tenant-a");
        assert!(parse_otlp_headers("authorization=Bearer%0D%0Aleaked").is_err());
    }

    #[test]
    fn renderer_cannot_supply_sensitive_headers() {
        let headers = HashMap::from([
            ("Content-Type".to_string(), "application/json".to_string()),
            ("Authorization".to_string(), "Bearer leaked".to_string()),
        ]);
        let err = build_headers(headers, TelemetryCredential::None).unwrap_err();
        assert!(err.contains("sensitive header"));
    }

    #[test]
    fn renderer_cannot_supply_vendor_or_custom_headers() {
        assert!(sanitize_renderer_headers(HashMap::from([(
            "X-Honeycomb-Team".to_string(),
            "renderer-secret".to_string(),
        )]))
        .is_err());
        assert!(sanitize_renderer_headers(HashMap::from([(
            "Content-Type".to_string(),
            "application/json".to_string(),
        )]))
        .expect("standard content type")
        .is_empty());
    }

    #[test]
    fn native_payload_gate_validates_structural_and_public_token_shapes() {
        assert!(telemetry_payload_has_no_leaking_pii(
            &serde_json::json!({
                "traceId": "aabbccddeeff00112233445566778899",
                "spanId": "aabbccddeeff0011",
                "timeUnixNano": "1700000000000000000",
                "api_key": "phc_public-project-token",
            }),
            "payload",
        ));
        assert!(!telemetry_payload_has_no_leaking_pii(
            &serde_json::json!({ "traceId": "alice@example.com" }),
            "payload",
        ));
        assert!(!telemetry_payload_has_no_leaking_pii(
            &serde_json::json!({ "api_key": "phc_alice@example.com" }),
            "payload",
        ));
        assert!(telemetry_payload_has_no_leaking_pii(
            &serde_json::json!({
                "traceId": "qrvM3e7/ABEiM0RVZneImQ==",
                "spanId": "qrvM3e7/ABE=",
            }),
            "payload",
        ));
    }

    #[test]
    fn grafana_authorization_is_injected_from_rust_secret() {
        let headers = build_headers_with_secret(
            HashMap::from([("X-Scope-OrgID".to_string(), "tenant-a".to_string())]),
            TelemetryCredential::GrafanaCloud {
                instance_id: "1234567".to_string(),
            },
            Some("glc_secret"),
        )
        .expect("headers");

        assert_eq!(
            headers.get("authorization").expect("authorization"),
            "Basic MTIzNDU2NzpnbGNfc2VjcmV0"
        );
        assert_eq!(headers.get("x-scope-orgid").expect("tenant"), "tenant-a");
    }

    #[test]
    fn posthog_authorization_uses_the_public_project_token() {
        let headers = build_headers_with_secret(
            HashMap::new(),
            TelemetryCredential::Posthog {
                project_token: "phc_project".to_string(),
            },
            None,
        )
        .expect("headers");
        assert_eq!(
            headers.get("authorization"),
            Some(&"Bearer phc_project".to_string())
        );
        assert!(build_headers_with_secret(
            HashMap::new(),
            TelemetryCredential::Posthog {
                project_token: "phx_personal".to_string(),
            },
            None,
        )
        .is_err());
    }

    #[test]
    fn disabled_sidecar_config_has_no_environment() {
        *SIDECAR_CONFIG.write().expect("config") = None;
        assert!(sidecar_env().expect("environment").is_empty());
    }

    #[test]
    fn sidecar_header_json_preserves_auth_padding() {
        let headers = HashMap::from([("authorization".to_string(), "Basic dGVzdA==".to_string())]);
        let encoded = serde_json::to_string(&headers).expect("headers");
        let decoded: HashMap<String, String> = serde_json::from_str(&encoded).expect("headers");
        assert_eq!(
            decoded.get("authorization"),
            Some(&"Basic dGVzdA==".to_string())
        );
    }

    #[tokio::test]
    async fn native_export_reaches_a_local_collector_with_trace_context() {
        cognia_net::proxy_config::apply_current(cognia_net::proxy_config::ProxyConfig::default())
            .expect("initialize proxy policy");
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let address = listener.local_addr().expect("address");
        let collector = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("connection");
            let mut request = vec![0; 4096];
            let size = stream.read(&mut request).await.expect("request");
            let request = String::from_utf8_lossy(&request[..size]).to_string();
            stream
                .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n")
                .await
                .expect("response");
            request
        });
        let traceparent = format!("00-{}-{}-01", "a".repeat(32), "b".repeat(16));

        let result = telemetry_otlp_export(
            "request-success".to_string(),
            format!("http://{address}/v1/traces"),
            "{\"resourceSpans\":[]}".to_string(),
            HashMap::new(),
            TelemetryCredential::None,
            Some(traceparent.clone()),
        )
        .await
        .expect("export");
        let request = collector.await.expect("collector");

        assert_eq!(result.status, 202);
        assert!(request.contains("POST /v1/traces"));
        assert!(request
            .to_ascii_lowercase()
            .contains("content-type: application/json"));
        assert!(request
            .to_ascii_lowercase()
            .contains(&format!("traceparent: {traceparent}")));
        assert!(request.contains("{\"resourceSpans\":[]}"));
    }

    #[tokio::test]
    async fn native_export_rejects_non_json_before_networking() {
        let error = telemetry_otlp_export(
            "request-invalid-json".to_string(),
            "http://127.0.0.1:1/v1/traces".to_string(),
            "not-json".to_string(),
            HashMap::new(),
            TelemetryCredential::None,
            None,
        )
        .await
        .expect_err("invalid payload");
        assert!(error.contains("valid JSON"));
    }

    #[tokio::test]
    async fn native_export_rejects_invalid_traceparent_before_networking() {
        let error = telemetry_otlp_export(
            "request-invalid-traceparent".to_string(),
            "http://127.0.0.1:1/v1/traces".to_string(),
            r#"{"resourceSpans":[]}"#.to_string(),
            HashMap::new(),
            TelemetryCredential::None,
            Some("not-a-traceparent".to_string()),
        )
        .await
        .expect_err("invalid traceparent");
        assert!(error.contains("traceparent is invalid"));
    }

    #[tokio::test]
    async fn native_export_rejects_pii_before_networking() {
        let error = telemetry_otlp_export(
            "request-pii".to_string(),
            "http://127.0.0.1:1/v1/logs".to_string(),
            r#"{"message":"alice@example.com"}"#.to_string(),
            HashMap::new(),
            TelemetryCredential::None,
            None,
        )
        .await
        .expect_err("PII payload");
        assert!(error.contains("PII gate"));
    }

    #[tokio::test]
    async fn native_export_rejects_grafana_secret_repointing() {
        let error = telemetry_otlp_export(
            "request-attacker".to_string(),
            "https://attacker.example/otlp/v1/logs".to_string(),
            r#"{"resourceLogs":[]}"#.to_string(),
            HashMap::new(),
            TelemetryCredential::GrafanaCloud {
                instance_id: "1234567".to_string(),
            },
            None,
        )
        .await
        .expect_err("attacker destination");
        assert!(error.contains("approved grafana.net"));
    }

    #[tokio::test]
    async fn sidecar_config_rejects_grafana_secret_repointing() {
        let error = telemetry_configure_sidecar(
            true,
            "https://attacker.example/otlp/v1/traces".to_string(),
            HashMap::new(),
            "cognia-sidecar".to_string(),
            "test".to_string(),
            TelemetryCredential::GrafanaCloud {
                instance_id: "1234567".to_string(),
            },
            None,
            None,
        )
        .await
        .expect_err("attacker destination");
        assert!(error.contains("approved grafana.net"));
    }

    #[tokio::test]
    async fn disabling_sidecar_ignores_legacy_renderer_headers() {
        telemetry_configure_sidecar(
            false,
            "http://localhost".to_string(),
            HashMap::from([(
                "Authorization".to_string(),
                "Bearer legacy-renderer-secret".to_string(),
            )]),
            "cognia-sidecar".to_string(),
            "".to_string(),
            TelemetryCredential::None,
            None,
            None,
        )
        .await
        .expect("disable telemetry");
        assert!(sidecar_env().expect("environment").is_empty());
    }

    #[tokio::test]
    async fn native_export_can_be_cancelled_by_request_id() {
        cognia_net::proxy_config::apply_current(cognia_net::proxy_config::ProxyConfig::default())
            .expect("initialize proxy policy");
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let address = listener.local_addr().expect("address");
        let export = tokio::spawn(telemetry_otlp_export(
            "request-cancel".to_string(),
            format!("http://{address}/v1/traces"),
            "{\"resourceSpans\":[]}".to_string(),
            HashMap::new(),
            TelemetryCredential::None,
            None,
        ));

        let (mut stream, _) = listener.accept().await.expect("connection");
        let mut request = vec![0; 4096];
        let _ = stream.read(&mut request).await.expect("request");
        assert!(telemetry_otlp_cancel("request-cancel".to_string()));

        let error = export
            .await
            .expect("export task")
            .expect_err("cancelled export");
        assert!(error.contains("cancelled"));
    }
}
