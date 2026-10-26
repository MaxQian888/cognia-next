//! Tauri commands exposing proxy configuration to the frontend.
//!
//! - `proxy_apply` — resolve keyring credentials and atomically publish policy.
//!   subsequent reqwest builders pick it up. Idempotent.
//! - `proxy_detect` — port-probe + Clash API; returns the candidate list
//!   the Detection tab renders.
//! - `proxy_identify_clash` — single cheap probe of Clash/Mihomo's default
//!   controller; powers the Detection tab's quick status line on mount.
//! - `proxy_test` — issue a one-off request through the *current* config
//!   and report status + latency.
//! - `proxy_get_active` — debug aid; returns the live config snapshot.
//! - `network_interface_counters` / `network_latency_probe` — the status
//!   bar's live network readout (`cognia_net::net_meter`): cumulative
//!   interface byte counters, and a connection-reusing round-trip probe that
//!   goes through the same live policy as every other request here.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::detect::{identify_clash, probe_all, ProxyCandidate};
use super::{
    apply_current, block_current, runtime_status, ProxyConfig, ProxyError, ProxyErrorCode,
    ProxyMode, ProxyProtocol, ProxyRouteSummary, ProxyRuntimeStatus,
};

const PROXY_CREDENTIAL_NAMESPACE: &str = "cognia-network-proxy";
const PROXY_CREDENTIAL_KEY: &str = "manual-password";

#[derive(Debug, Serialize)]
pub struct ProxyTestResult {
    pub ok: bool,
    pub status: Option<u16>,
    #[serde(rename = "latencyMs")]
    pub latency_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "errorCode", skip_serializing_if = "Option::is_none")]
    pub error_code: Option<ProxyErrorCode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<ProxyRouteSummary>,
}

#[derive(Debug, Deserialize)]
pub struct ProxyApplyInput {
    pub mode: ProxyMode,
    pub protocol: ProxyProtocol,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub bypass: Vec<String>,
    #[serde(default = "default_proxy_websockets")]
    pub proxy_websockets: bool,
}

fn default_proxy_websockets() -> bool {
    true
}

/// Atomically resolve the keyring credential, validate, and publish runtime
/// policy. Any failure places the process in Blocked rather than retaining a
/// stale or direct configuration.
#[tauri::command]
pub async fn proxy_apply(input: ProxyApplyInput) -> Result<(), ProxyError> {
    // Preserve apply order while credential lookup yields to the worker pool.
    static APPLY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _apply_guard = APPLY_LOCK.lock().await;
    let password = if !matches!(input.mode, ProxyMode::Off)
        && input
            .username
            .as_deref()
            .is_some_and(|username| !username.is_empty())
    {
        let credential = tauri::async_runtime::spawn_blocking(|| {
            cognia_secrets::keyring_secrets::get(PROXY_CREDENTIAL_NAMESPACE, PROXY_CREDENTIAL_KEY)
        })
        .await
        .unwrap_or_else(|_| Err("proxy credential worker failed".into()));
        match credential {
            Ok(Some(password)) if !password.is_empty() => Some(password),
            Ok(_) => {
                let error = ProxyError::new(
                    ProxyErrorCode::ProxyCredentialUnavailable,
                    "proxy password is unavailable in the system keyring",
                );
                block_current(error.clone());
                super::install_uninitialized_proxy_environment();
                return Err(error);
            }
            Err(_) => {
                let error = ProxyError::new(
                    ProxyErrorCode::ProxyCredentialUnavailable,
                    "system keyring could not be accessed",
                );
                block_current(error.clone());
                super::install_uninitialized_proxy_environment();
                return Err(error);
            }
        }
    } else {
        None
    };

    let config = ProxyConfig {
        mode: input.mode,
        protocol: input.protocol,
        host: input.host,
        port: input.port,
        username: input.username,
        password,
        bypass: input.bypass,
        proxy_websockets: input.proxy_websockets,
    };
    if let Err(error) = config.validate() {
        block_current(error.clone());
        super::install_uninitialized_proxy_environment();
        return Err(error);
    }
    super::install_process_proxy_environment(&config);
    apply_current(config)
}

/// Sanitized runtime diagnostics. Credentials are represented by presence only.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyActiveStatus {
    #[serde(flatten)]
    runtime: ProxyRuntimeStatus,
    download_policy_version: u8,
    request_admission_version: u8,
}

impl std::ops::Deref for ProxyActiveStatus {
    type Target = ProxyRuntimeStatus;
    fn deref(&self) -> &Self::Target {
        &self.runtime
    }
}

#[tauri::command]
pub async fn proxy_get_active() -> Result<ProxyActiveStatus, String> {
    Ok(ProxyActiveStatus {
        runtime: runtime_status(),
        download_policy_version: 2,
        request_admission_version: 1,
    })
}

/// Probe local ports + Clash controller; return the candidate list.
#[tauri::command]
pub async fn proxy_detect() -> Result<Vec<ProxyCandidate>, String> {
    Ok(probe_all().await)
}

/// Lightweight probe of Clash/Mihomo's default controller (127.0.0.1:9090).
/// Returns the core version when the controller answers openly, `None` when
/// it is absent or secret-protected. Far cheaper than `proxy_detect` (no
/// process snapshot, config reads, or port sweep) — the Detection tab fires
/// it on mount for an instant "a Clash core is running" status line.
#[tauri::command]
pub async fn proxy_identify_clash() -> Result<Option<String>, String> {
    Ok(identify_clash().await)
}

/// Test the *current* proxy by issuing a request to the supplied URL.
/// Returns latency, status, and any reqwest error in a structured payload.
#[derive(Debug, Deserialize)]
pub struct ProxyTestInput {
    pub url: String,
    /// Optional timeout in milliseconds. Defaults to 10 000.
    #[serde(default, rename = "timeoutMs")]
    pub timeout_ms: Option<u64>,
}

#[tauri::command]
pub async fn proxy_test(input: ProxyTestInput) -> Result<ProxyTestResult, String> {
    let timeout = Duration::from_millis(input.timeout_ms.unwrap_or(10_000));
    let (builder, route) =
        super::apply_reqwest_policy(reqwest::Client::builder().timeout(timeout), &input.url)
            .map_err(|error| serde_json::to_string(&error).unwrap_or_else(|_| error.to_string()))?;
    let client = builder
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;

    let started = Instant::now();
    let result = client.get(&input.url).send().await;
    let latency_ms = started.elapsed().as_millis();

    Ok(match result {
        Ok(resp) => ProxyTestResult {
            ok: resp.status().is_success() || resp.status().is_redirection(),
            status: Some(resp.status().as_u16()),
            latency_ms,
            error: None,
            error_code: None,
            route: Some(route.clone()),
        },
        Err(e) => ProxyTestResult {
            ok: false,
            status: None,
            latency_ms,
            error: Some(e.without_url().to_string()),
            error_code: Some(ProxyErrorCode::ProxyConnectFailed),
            route: Some(route),
        },
    })
}

// ---------------------------------------------------------------------------
// Live network meter — the status bar's speed / latency readout.
// ---------------------------------------------------------------------------

/// Cumulative receive / transmit bytes over the machine's physical
/// interfaces. The renderer samples twice and divides by the interval.
#[tauri::command]
pub async fn network_interface_counters() -> Result<cognia_net::net_meter::NetworkCounters, String>
{
    // A handful of syscalls, but blocking ones: keep them off the async
    // workers that carry IPC.
    tokio::task::spawn_blocking(cognia_net::net_meter::read_interface_counters)
        .await
        .map_err(|error| format!("interface counter read failed: {error}"))
}

#[derive(Debug, Deserialize)]
pub struct NetworkLatencyProbeInput {
    pub url: String,
    #[serde(default, rename = "timeoutMs")]
    pub timeout_ms: Option<u64>,
}

/// One HTTP round trip to `url` through the live proxy policy, on the shared
/// prober's kept-alive connection.
#[tauri::command]
pub async fn network_latency_probe(
    input: NetworkLatencyProbeInput,
) -> Result<cognia_net::net_meter::LatencySample, String> {
    let timeout = input
        .timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(cognia_net::net_meter::DEFAULT_PROBE_TIMEOUT);
    Ok(cognia_net::net_meter::shared_latency_probe()
        .probe(&input.url, timeout)
        .await)
}

// ---------------------------------------------------------------------------
// Generic proxied HTTP request — used by `lib/network/proxy-fetch.ts` so
// browser-blocked / region-blocked endpoints (Anthropic OAuth token URL,
// arbitrary user-supplied URLs from chat) can still go out through the
// configured proxy.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyHttpRequestInput {
    pub request_id: String,
    #[serde(default)]
    pub admission_token: Option<String>,
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub body_base64: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub redirect: Option<String>,
    /// Defense-in-depth SSRF guard. When `Some(true)`, reject private /
    /// loopback / link-local targets (localhost, 10./192.168., 169.254.x cloud
    /// metadata, …). Off by default so existing callers (Anthropic OAuth,
    /// localhost companion server) are unaffected; the agent `web_fetch` path
    /// sets it based on the user's "allow private hosts" setting.
    #[serde(default, rename = "blockPrivate")]
    pub block_private: Option<bool>,
    #[serde(default)]
    pub download_policy: Option<cognia_net::guarded_http::DownloadPolicy>,
}

pub(super) use cognia_net::guarded_http::host_is_private;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyHttpRequestOutput {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body_base64: String,
}

const MAX_PROXY_HTTP_BODY_BYTES: usize = 64 * 1024 * 1024;

fn download_slots() -> &'static tokio::sync::Semaphore {
    static SLOTS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    SLOTS.get_or_init(|| tokio::sync::Semaphore::new(2))
}

fn proxy_http_cancellations(
) -> &'static cognia_net::request_cancellation::RequestCancellationRegistry {
    static CANCELLATIONS: std::sync::OnceLock<
        cognia_net::request_cancellation::RequestCancellationRegistry,
    > = std::sync::OnceLock::new();
    CANCELLATIONS.get_or_init(Default::default)
}

fn proxy_http_admissions() -> &'static cognia_net::request_cancellation::RequestAdmissionRegistry {
    static ADMISSIONS: std::sync::OnceLock<
        cognia_net::request_cancellation::RequestAdmissionRegistry,
    > = std::sync::OnceLock::new();
    ADMISSIONS.get_or_init(Default::default)
}

/// Reserve a bounded cancellation owner before the caller dispatches any HTTP.
#[tauri::command]
pub fn proxy_http_prepare(request_id: String) -> Result<String, String> {
    let token = uuid::Uuid::new_v4().to_string();
    proxy_http_admissions()
        .prepare(&request_id, &token)
        .map_err(|error| error.to_string())?;
    Ok(token)
}

#[tauri::command]
pub fn proxy_http_cancel(request_id: String, admission_token: Option<String>) -> bool {
    if let Some(token) = admission_token {
        proxy_http_admissions().cancel(&request_id, &token)
    } else {
        proxy_http_cancellations().cancel(&request_id)
    }
}

#[tauri::command]
pub async fn proxy_http_request(
    input: ProxyHttpRequestInput,
) -> Result<ProxyHttpRequestOutput, String> {
    let (admission_guard, admitted_cancelled) = if let Some(token) = &input.admission_token {
        let (guard, cancelled) = proxy_http_admissions()
            .claim(&input.request_id, token)
            .map_err(|_| "request cancelled".to_string())?;
        (Some(guard), Some(cancelled))
    } else {
        (None, None)
    };
    let strict = input.download_policy.is_some();
    if let Some(policy) = &input.download_policy {
        let url = reqwest::Url::parse(&input.url)
            .map_err(|_| "download_destination_denied".to_string())?;
        policy.validate(&url)?;
        if input.method.as_deref().unwrap_or("GET") != "GET"
            || input.body_base64.is_some()
            || input
                .redirect
                .as_deref()
                .is_some_and(|mode| mode != "follow")
        {
            return Err("download_request_invalid".into());
        }
    }
    if input.block_private == Some(true) && host_is_private(&input.url) {
        return Err(format!(
            "refusing to fetch a private/loopback address: {}",
            input.url
        ));
    }

    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    let timeout = Duration::from_millis(if strict {
        input.timeout_ms.unwrap_or(60_000).clamp(1, 60_000)
    } else {
        input.timeout_ms.unwrap_or(30_000)
    });
    let make_builder = |url: &str| {
        let builder = reqwest::Client::builder().timeout(timeout).redirect(
            cognia_net::guarded_http::redirect_policy(input.redirect.as_deref())?,
        );
        let (builder, route) = super::apply_reqwest_policy(builder, url).map_err(|error| {
            if strict {
                "download_proxy_policy_failed".to_string()
            } else {
                serde_json::to_string(&error).unwrap_or_else(|_| error.to_string())
            }
        })?;
        if strict && matches!(route, ProxyRouteSummary::Proxy { .. }) {
            return Err("download_proxy_unsupported".into());
        }
        Ok(builder)
    };
    let builder = make_builder(&input.url)?;
    let client = builder
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;

    let method = input
        .method
        .as_deref()
        .unwrap_or("GET")
        .parse::<reqwest::Method>()
        .map_err(|e| format!("invalid HTTP method: {e}"))?;

    let mut req = client.request(method, &input.url);
    if let Some(headers) = &input.headers {
        for (k, v) in headers {
            if k.eq_ignore_ascii_case("proxy-authorization") {
                return Err(
                    "Proxy-Authorization is reserved for the native proxy connector".into(),
                );
            }
            req = req.header(k.as_str(), v.as_str());
        }
    }
    if let Some(body) = input.body_base64 {
        let bytes = B64
            .decode(body)
            .map_err(|_| "request body is not valid base64".to_string())?;
        if bytes.len() > MAX_PROXY_HTTP_BODY_BYTES {
            return Err("request body exceeds proxy bridge byte limit".to_string());
        }
        req = req.body(bytes);
    }

    if strict && input.admission_token.is_none() {
        return Err("request_admission_required".into());
    }
    let (generation, cancelled) = if let Some(cancelled) = admitted_cancelled {
        (None, cancelled)
    } else {
        let (generation, cancelled) = proxy_http_cancellations().register(&input.request_id);
        (Some(generation), cancelled)
    };
    let request_id = input.request_id.clone();
    let operation = async {
        let _slot = if strict {
            Some(
                download_slots()
                    .acquire()
                    .await
                    .map_err(|_| "download_unavailable".to_string())?,
            )
        } else {
            None
        };
        let resp = if let Some(policy) = &input.download_policy {
            cognia_net::guarded_http::send_download(req, policy, make_builder, timeout).await?
        } else {
            cognia_net::guarded_http::send(
                req,
                input.block_private,
                input.redirect.as_deref(),
                make_builder,
                Some(timeout),
            )
            .await?
        };
        if strict && !resp.status().is_success() {
            return Err("download_http_error".into());
        }
        let status = resp.status().as_u16();
        let headers: HashMap<String, String> = resp
            .headers()
            .iter()
            .filter(|(k, _)| {
                !strict
                    || matches!(
                        k.as_str(),
                        "content-type" | "content-length" | "etag" | "last-modified"
                    )
            })
            .filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string())))
            .collect();
        let max_bytes = input
            .download_policy
            .as_ref()
            .map_or(MAX_PROXY_HTTP_BODY_BYTES, |policy| policy.max_bytes);
        let body = cognia_net::http_download::read_bounded_response(resp, max_bytes)
            .await
            .map_err(|error| {
                // Existing video callers classify this as a non-retryable size failure.
                if !strict && error == "download_body_too_large" {
                    "response body exceeds proxy bridge byte limit".to_string()
                } else {
                    error
                }
            })?;
        Ok(ProxyHttpRequestOutput {
            status,
            headers,
            body_base64: B64.encode(body),
        })
    };

    let result = tokio::select! {
        biased;
        _ = cancelled => Err("request cancelled".to_string()),
        result = async {
            if strict || input.block_private == Some(true) {
                // Bound DNS, every redirect and the body by the original budget.
                tokio::time::timeout(timeout, operation)
                    .await
                    .map_err(|_| "request failed: operation timed out".to_string())?
            } else {
                operation.await
            }
        } => result,
    };
    if let Some(generation) = generation {
        proxy_http_cancellations().finish(&request_id, generation);
    }
    drop(admission_guard);

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy_config::{ProxyMode, ProxyProtocol};

    #[tokio::test]
    async fn pre_entry_cancel_and_stale_tokens_cannot_start_http_or_cancel_a_replacement() {
        apply_current(ProxyConfig::default()).unwrap();
        let server = wiremock::MockServer::start().await;
        let bytes = vec![0, 255, 128, 80, 75];
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_bytes(bytes.clone()))
            .mount(&server)
            .await;
        let id = "pre-entry-generation".to_string();
        let old = proxy_http_prepare(id.clone()).unwrap();
        assert!(proxy_http_cancel(id.clone(), Some(old.clone())));
        let make_input = |token: String| {
            serde_json::from_value(serde_json::json!({
                "requestId": id, "admissionToken": token, "url": server.uri(), "timeoutMs": 1000
            }))
            .unwrap()
        };
        assert_eq!(
            proxy_http_request(make_input(old.clone()))
                .await
                .unwrap_err(),
            "request cancelled"
        );
        assert!(server.received_requests().await.unwrap().is_empty());
        let current = proxy_http_prepare(id.clone()).unwrap();
        assert!(!proxy_http_cancel(id.clone(), Some(old.clone())));
        assert_eq!(
            proxy_http_request(make_input(old.clone()))
                .await
                .unwrap_err(),
            "request cancelled"
        );
        assert!(server.received_requests().await.unwrap().is_empty());
        let response = proxy_http_request(make_input(current.clone()))
            .await
            .unwrap();
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        assert_eq!(B64.decode(response.body_base64).unwrap(), bytes);
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
        assert!(!proxy_http_cancel(id.clone(), Some(current)));
        let invalid_token = proxy_http_prepare(id.clone()).unwrap();
        let mut invalid = make_input(invalid_token.clone());
        invalid.url = "https://files.example/binary".into();
        invalid.method = Some("POST".into());
        invalid.download_policy = Some(cognia_net::guarded_http::DownloadPolicy {
            allowed_origins: vec!["https://files.example".into()],
            max_bytes: 1024,
        });
        assert_eq!(
            proxy_http_request(invalid).await.unwrap_err(),
            "download_request_invalid"
        );
        assert!(!proxy_http_cancel(id, Some(invalid_token)));
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn active_proxy_body_read_can_be_cancelled_without_a_late_result() {
        for admitted in [false, true] {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            apply_current(ProxyConfig::default()).unwrap();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let (started, receiving) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 4096];
                socket.read(&mut buffer).await.unwrap();
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\n\0",
                    )
                    .await
                    .unwrap();
                started.send(()).unwrap();
                tokio::time::timeout(Duration::from_secs(2), socket.read(&mut buffer))
                    .await
                    .unwrap()
            });
            let token = if admitted {
                Some(proxy_http_prepare("active-body-cancel".into()).unwrap())
            } else {
                None
            };
            let input = serde_json::from_value(serde_json::json!({
            "requestId": "active-body-cancel", "url": format!("http://{addr}/binary"), "timeoutMs": 5000
            , "admissionToken": token
        })).unwrap();
            let request = tokio::spawn(proxy_http_request(input));
            tokio::time::timeout(Duration::from_secs(2), receiving)
                .await
                .unwrap()
                .unwrap();
            assert!(proxy_http_cancel(
                "active-body-cancel".into(),
                token.clone()
            ));
            assert_eq!(request.await.unwrap().unwrap_err(), "request cancelled");
            match server.await.unwrap() {
                Ok(0) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                    ) => {}
                result => panic!("cancel must close the unfinished body socket: {result:?}"),
            }
            assert!(!proxy_http_cancel("active-body-cancel".into(), token));
        }
    }

    #[tokio::test]
    async fn ordinary_download_retains_the_video_body_limit_error_contract() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        apply_current(ProxyConfig::default()).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            socket.read(&mut request).await.unwrap();
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        MAX_PROXY_HTTP_BODY_BYTES + 1
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let input = serde_json::from_value(serde_json::json!({
            "requestId": "ordinary-limit-compat", "url": format!("http://{addr}/video"), "timeoutMs": 1000
        })).unwrap();
        let error = proxy_http_request(input).await.unwrap_err();
        server.await.unwrap();
        assert_eq!(error, "response body exceeds proxy bridge byte limit");
    }

    fn strict_fixture_input(id: &str, timeout: u64) -> ProxyHttpRequestInput {
        let token = proxy_http_prepare(id.to_string()).unwrap();
        serde_json::from_value(serde_json::json!({
            "requestId": id, "url": "https://public.test/opaque?token=secret",
            "admissionToken": token,
            "timeoutMs": timeout,
            "downloadPolicy": { "allowedOrigins": ["https://public.test"], "maxBytes": 4 }
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn strict_download_cancellation_and_deadline_include_slot_wait() {
        apply_current(ProxyConfig::default()).unwrap();
        let first = download_slots().acquire().await.unwrap();
        let second = download_slots().acquire().await.unwrap();
        let input = strict_fixture_input("strict-slot-cancel", 1000);
        let token = input.admission_token.clone();
        let mut request = Box::pin(proxy_http_request(input));
        // Poll through claim into the blocked slot acquire before cancelling.
        assert!(futures_util::poll!(&mut request).is_pending());
        assert!(proxy_http_cancel("strict-slot-cancel".into(), token));
        let error = tokio::time::timeout(Duration::from_secs(2), request)
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(error, "request cancelled");
        let input = strict_fixture_input("strict-slot-timeout", 1);
        let timeout_token = input.admission_token.clone();
        let error = proxy_http_request(input).await.unwrap_err();
        assert_eq!(error, "request failed: operation timed out");
        drop(first);
        drop(second);
        assert_eq!(download_slots().available_permits(), 2);
        assert!(!proxy_http_cancel(
            "strict-slot-timeout".into(),
            timeout_token
        ));
    }

    #[tokio::test]
    async fn strict_download_does_not_bypass_a_configured_proxy() {
        apply_current(ProxyConfig {
            mode: ProxyMode::Manual,
            protocol: ProxyProtocol::Http,
            host: "127.0.0.1".into(),
            port: 1,
            bypass: vec![],
            ..ProxyConfig::default()
        })
        .unwrap();
        let result = proxy_http_request(strict_fixture_input("strict-proxy", 1000)).await;
        apply_current(ProxyConfig::default()).unwrap();
        assert_eq!(result.unwrap_err(), "download_proxy_unsupported");
    }

    #[tokio::test]
    async fn download_capability_is_explicit_without_changing_status_shape() {
        let status = serde_json::to_value(proxy_get_active().await.unwrap()).unwrap();
        assert_eq!(status["downloadPolicyVersion"], 2);
        assert_eq!(status["requestAdmissionVersion"], 1);
        assert!(status.get("state").is_some());
        assert!(status.get("credentialConfigured").is_some());
    }

    #[tokio::test]
    async fn strict_download_rejects_insecure_private_destination_without_leaking_url() {
        apply_current(ProxyConfig::default()).unwrap();
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_bytes(vec![0, 255, 80, 75]))
            .mount(&server)
            .await;
        let input: ProxyHttpRequestInput = serde_json::from_value(serde_json::json!({
            "requestId": "strict-reject", "url": format!("{}/secret-path?token=secret", server.uri()),
            "timeoutMs": 1000,
            "downloadPolicy": { "allowedOrigins": ["https://public.test"], "maxBytes": 4 }
        })).unwrap();
        let error = proxy_http_request(input).await.unwrap_err();
        assert_eq!(error, "download_destination_denied");
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn proxy_apply_and_get_roundtrip_is_sanitized() {
        proxy_apply(ProxyApplyInput {
            mode: ProxyMode::Manual,
            protocol: ProxyProtocol::Http,
            host: "10.0.0.1".to_string(),
            port: 1080,
            username: None,
            bypass: vec!["localhost".into()],
            proxy_websockets: true,
        })
        .await
        .unwrap();
        let got = proxy_get_active().await.unwrap();
        assert_eq!(got.state, "ready");
        assert!(matches!(
            got.route,
            Some(ProxyRouteSummary::Proxy { ref host, port: 1080, .. }) if host == "10.0.0.1"
        ));
        assert!(!got.credential_configured);
    }

    #[tokio::test]
    async fn proxy_apply_off_does_not_require_a_stale_username_password() {
        proxy_apply(ProxyApplyInput {
            mode: ProxyMode::Off,
            protocol: ProxyProtocol::Http,
            host: "proxy.example".into(),
            port: 8080,
            username: Some("stale-user".into()),
            bypass: vec!["localhost".into()],
            proxy_websockets: true,
        })
        .await
        .unwrap();
        assert_eq!(proxy_get_active().await.unwrap().state, "ready");
    }

    #[tokio::test]
    async fn authenticated_proxy_rejects_missing_credentials_after_worker_lookup() {
        let error = proxy_apply(ProxyApplyInput {
            mode: ProxyMode::Manual,
            protocol: ProxyProtocol::Http,
            host: "proxy.example".into(),
            port: 8080,
            username: Some("requires-password".into()),
            bypass: vec![],
            proxy_websockets: true,
        })
        .await
        .unwrap_err();
        assert_eq!(error.code, ProxyErrorCode::ProxyCredentialUnavailable);
    }

    #[tokio::test]
    async fn proxy_test_reports_error_for_unreachable_host() {
        // Reset to off so the test bypasses any leftover state.
        apply_current(ProxyConfig::default()).unwrap();

        let result = proxy_test(ProxyTestInput {
            url: "http://127.0.0.1:1/should-fail".to_string(),
            timeout_ms: Some(500),
        })
        .await
        .unwrap();
        assert!(!result.ok);
        assert!(result.error.is_some());
    }

    #[tokio::test]
    async fn network_interface_counters_reports_counted_interfaces() {
        let counters = network_interface_counters().await.unwrap();
        assert!(counters.at_ms > 0);
        let rx: u64 = counters.interfaces.iter().map(|i| i.rx_bytes).sum();
        assert_eq!(rx, counters.rx_bytes);
    }

    #[tokio::test]
    async fn network_latency_probe_reports_an_unreachable_target() {
        apply_current(ProxyConfig::default()).unwrap();
        let sample = network_latency_probe(NetworkLatencyProbeInput {
            url: "http://127.0.0.1:1/".into(),
            timeout_ms: Some(500),
        })
        .await
        .unwrap();
        assert!(!sample.ok);
        assert!(sample.error.is_some());
        assert_eq!(sample.host, "127.0.0.1");
    }

    #[tokio::test]
    async fn proxy_detect_returns_vec() {
        // Port 1 is unreachable; result is implementation-dependent but the
        // call should always return Ok.
        let result = proxy_detect().await.unwrap();
        for c in &result {
            assert!(c.port > 0);
        }
    }

    #[tokio::test]
    async fn proxy_identify_clash_completes() {
        // The dev machine may or may not run Clash on 9090 — Ok(None) and
        // Ok(Some(version)) are both valid; the call must never error.
        let result = proxy_identify_clash().await.unwrap();
        if let Some(version) = result {
            assert!(!version.is_empty());
        }
    }

    #[tokio::test]
    async fn proxy_http_request_rejects_invalid_url() {
        apply_current(ProxyConfig::default()).unwrap();
        let res = proxy_http_request(ProxyHttpRequestInput {
            request_id: "invalid-url".into(),
            admission_token: None,
            url: "not a url".to_string(),
            method: None,
            body_base64: None,
            headers: None,
            timeout_ms: Some(1_000),
            redirect: None,
            block_private: None,
            download_policy: None,
        })
        .await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn proxy_http_request_rejects_invalid_method() {
        let res = proxy_http_request(ProxyHttpRequestInput {
            request_id: "invalid-method".into(),
            admission_token: None,
            url: "http://127.0.0.1:1/".to_string(),
            method: Some("@@@bad".to_string()),
            body_base64: None,
            headers: None,
            timeout_ms: Some(1_000),
            redirect: None,
            block_private: None,
            download_policy: None,
        })
        .await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn proxy_http_request_blocks_private_host_when_guarded() {
        for url in [
            "http://169.254.169.254/latest/meta-data/",
            "http://localhost/",
            "http://[::ffff:127.0.0.1]/",
        ] {
            let request_id = format!("blocked-private-{url}");
            let error = proxy_http_request(ProxyHttpRequestInput {
                request_id: request_id.clone(),
                admission_token: None,
                url: url.into(),
                method: None,
                body_base64: None,
                headers: None,
                timeout_ms: Some(1_000),
                redirect: None,
                block_private: Some(true),
                download_policy: None,
            })
            .await
            .unwrap_err();
            assert!(error.starts_with("refusing to fetch a private/loopback address"));
            assert!(!proxy_http_cancel(request_id, None));
        }
    }

    #[test]
    fn host_is_private_matrix() {
        for url in [
            "http://localhost/",
            "http://app.localhost/",
            "http://127.0.0.1/",
            "http://10.1.2.3/",
            "http://172.16.0.1/",
            "http://192.168.1.1/",
            "http://169.254.169.254/",
            "http://100.64.0.1/",
            "http://[::1]/",
            "http://[fe80::1]/",
            "http://[fc00::1]/",
        ] {
            assert!(host_is_private(url), "expected private: {url}");
        }
        for url in [
            "https://example.com/",
            "http://8.8.8.8/",
            "http://172.32.0.1/",
            "https://[2606:4700::1111]/",
        ] {
            assert!(!host_is_private(url), "expected public: {url}");
        }
    }
}
