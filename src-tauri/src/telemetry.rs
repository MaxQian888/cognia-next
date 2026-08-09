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

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum TelemetryCredential {
    None,
    GrafanaCloud { instance_id: String },
    Langfuse { public_key: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SidecarTelemetryConfig {
    endpoint: String,
    headers: HashMap<String, String>,
    service_name: String,
    environment: String,
    credential: TelemetryCredential,
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
    if parsed.host_str().is_none() {
        return Err("telemetry endpoint must include a host".to_string());
    }
    Ok(parsed)
}

fn is_sensitive_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization" | "proxy-authorization" | "cookie" | "set-cookie" | "x-api-key"
    )
}

fn build_headers(
    headers: HashMap<String, String>,
    credential: TelemetryCredential,
) -> Result<HashMap<String, String>, String> {
    let secret = match &credential {
        TelemetryCredential::None => None,
        TelemetryCredential::GrafanaCloud { .. } => {
            crate::secret_store::get(TELEMETRY_SECRET_NAMESPACE, GRAFANA_API_TOKEN_KEY)?
        }
        TelemetryCredential::Langfuse { .. } => {
            crate::secret_store::get(TELEMETRY_SECRET_NAMESPACE, LANGFUSE_SECRET_KEY)?
        }
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
        TelemetryCredential::Langfuse { public_key } => {
            let secret = secret.filter(|value| !value.is_empty()).ok_or_else(|| {
                "Langfuse secret key is not available in the secret store".to_string()
            })?;
            if public_key.trim().is_empty() {
                return Err("Langfuse public key is required".to_string());
            }
            let encoded = BASE64.encode(format!("{}:{secret}", public_key.trim()));
            out.insert("authorization".to_string(), format!("Basic {encoded}"));
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn telemetry_secret_set(kind: TelemetrySecretKind, value: String) -> Result<(), String> {
    if value.is_empty() {
        return Err("telemetry secret must not be empty".to_string());
    }
    crate::secret_store::set(TELEMETRY_SECRET_NAMESPACE, kind.key(), &value)
}

#[tauri::command]
pub async fn telemetry_secret_has(kind: TelemetrySecretKind) -> Result<bool, String> {
    Ok(crate::secret_store::get(TELEMETRY_SECRET_NAMESPACE, kind.key())?.is_some())
}

#[tauri::command]
pub async fn telemetry_secret_clear(kind: TelemetrySecretKind) -> Result<(), String> {
    crate::secret_store::delete(TELEMETRY_SECRET_NAMESPACE, kind.key())
}

#[tauri::command]
pub async fn telemetry_otlp_export(
    endpoint: String,
    body: String,
    headers: HashMap<String, String>,
    credential: TelemetryCredential,
    traceparent: Option<String>,
) -> Result<TelemetryExportResult, String> {
    serde_json::from_str::<serde_json::Value>(&body)
        .map_err(|error| format!("telemetry payload must be valid JSON: {error}"))?;
    let endpoint = validate_endpoint(&endpoint)?;
    let headers = build_headers(headers, credential)?;
    let builder = reqwest::Client::builder().timeout(EXPORT_TIMEOUT);
    let (builder, _) = crate::proxy_config::apply_reqwest_policy(builder, endpoint.as_str())
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
    let response = request
        .send()
        .await
        .map_err(|e| format!("telemetry export failed: {e}"))?;
    let status = response.status().as_u16();
    Ok(TelemetryExportResult {
        status,
        accepted: response.status().is_success(),
    })
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
        let endpoint = std::env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
            .map_err(|_| "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is not configured".to_string())?;
        init_tracer_with(&endpoint, HashMap::new())
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

#[tauri::command]
pub async fn telemetry_configure_sidecar(
    enabled: bool,
    endpoint: String,
    headers: HashMap<String, String>,
    service_name: String,
    environment: String,
    credential: TelemetryCredential,
) -> Result<bool, String> {
    let next = if enabled {
        validate_endpoint(&endpoint)?;
        // Validate both non-sensitive headers and the referenced keyring
        // credential before replacing the active sidecar configuration.
        let resolved_headers = build_headers(headers.clone(), credential.clone())?;
        #[cfg(feature = "otel-export")]
        configure_exporter(&endpoint, resolved_headers)?;
        #[cfg(not(feature = "otel-export"))]
        let _ = resolved_headers;
        Some(SidecarTelemetryConfig {
            endpoint,
            headers,
            service_name,
            environment,
            credential,
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
    let headers = build_headers(config.headers, config.credential)?;
    let mut env = HashMap::from([
        (
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT".to_string(),
            config.endpoint,
        ),
        ("OTEL_SERVICE_NAME".to_string(), config.service_name),
    ]);
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
    fn langfuse_authorization_is_injected_from_rust_secret() {
        let headers = build_headers_with_secret(
            HashMap::new(),
            TelemetryCredential::Langfuse {
                public_key: "pk-project".to_string(),
            },
            Some("sk-project"),
        )
        .expect("headers");
        assert_eq!(
            headers.get("authorization"),
            Some(&format!("Basic {}", BASE64.encode("pk-project:sk-project")))
        );
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
}
