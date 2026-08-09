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
    let password = if !matches!(input.mode, ProxyMode::Off)
        && input
            .username
            .as_deref()
            .is_some_and(|username| !username.is_empty())
    {
        match cognia_secrets::keyring_secrets::get(PROXY_CREDENTIAL_NAMESPACE, PROXY_CREDENTIAL_KEY)
        {
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
#[tauri::command]
pub async fn proxy_get_active() -> Result<ProxyRuntimeStatus, String> {
    Ok(runtime_status())
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
// Generic proxied HTTP request — used by `lib/network/proxy-fetch.ts` so
// browser-blocked / region-blocked endpoints (Anthropic OAuth token URL,
// arbitrary user-supplied URLs from chat) can still go out through the
// configured proxy.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyHttpRequestInput {
    pub request_id: String,
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
}

/// True when the URL's host is a private / loopback / link-local / reserved
/// address (or `localhost`) that a guarded fetch must refuse. Unparseable URLs
/// and unresolved hostnames are treated as *not* private here — the caller's
/// primary (TS) guard already rejects bad URLs; this is only a backstop against
/// the fixed IP ranges. Mirrors `lib/web/fetch-guard.ts`.
fn host_is_private(url: &str) -> bool {
    use std::net::IpAddr;

    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return true; // no host → unsafe
    };
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    if h == "localhost" || h.ends_with(".localhost") {
        return true;
    }
    // Strip brackets from an IPv6 literal host before parsing.
    let bare = h.trim_start_matches('[').trim_end_matches(']');
    match bare.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => ipv4_is_private(v4),
        Ok(IpAddr::V6(v6)) => ipv6_is_private(v6),
        Err(_) => false,
    }
}

fn ipv4_is_private(v4: std::net::Ipv4Addr) -> bool {
    if v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified() {
        return true;
    }
    if v4.is_multicast() || v4.is_broadcast() {
        return true;
    }
    let [a, b, ..] = v4.octets();
    // 100.64.0.0/10 CGNAT (std `is_shared` is unstable) + 240.0.0.0/4 reserved.
    (a == 100 && (64..=127).contains(&b)) || a >= 240
}

fn ipv6_is_private(v6: std::net::Ipv6Addr) -> bool {
    if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
        return true;
    }
    // IPv4-mapped / -compatible — defer to the embedded IPv4 range check.
    if let Some(v4) = v6.to_ipv4() {
        return ipv4_is_private(v4);
    }
    let first = v6.segments()[0];
    // fc00::/7 unique-local + fe80::/10 link-local.
    (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyHttpRequestOutput {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body_base64: String,
}

const MAX_PROXY_HTTP_BODY_BYTES: usize = 64 * 1024 * 1024;

fn proxy_http_cancellations(
) -> &'static cognia_net::request_cancellation::RequestCancellationRegistry {
    static CANCELLATIONS: std::sync::OnceLock<
        cognia_net::request_cancellation::RequestCancellationRegistry,
    > = std::sync::OnceLock::new();
    CANCELLATIONS.get_or_init(Default::default)
}

#[tauri::command]
pub fn proxy_http_cancel(request_id: String) -> bool {
    proxy_http_cancellations().cancel(&request_id)
}

#[tauri::command]
pub async fn proxy_http_request(
    input: ProxyHttpRequestInput,
) -> Result<ProxyHttpRequestOutput, String> {
    if input.block_private == Some(true) && host_is_private(&input.url) {
        return Err(format!(
            "refusing to fetch a private/loopback address: {}",
            input.url
        ));
    }

    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    use futures_util::StreamExt as _;

    let timeout = Duration::from_millis(input.timeout_ms.unwrap_or(30_000));
    let redirect = match input.redirect.as_deref().unwrap_or("follow") {
        "follow" => reqwest::redirect::Policy::limited(10),
        "manual" => reqwest::redirect::Policy::none(),
        "error" => reqwest::redirect::Policy::custom(|attempt| attempt.error("redirect blocked")),
        value => return Err(format!("invalid redirect mode: {value}")),
    };
    let (builder, _route) = super::apply_reqwest_policy(
        reqwest::Client::builder()
            .timeout(timeout)
            .redirect(redirect),
        &input.url,
    )
    .map_err(|error| serde_json::to_string(&error).unwrap_or_else(|_| error.to_string()))?;
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

    let (generation, cancelled) = proxy_http_cancellations().register(&input.request_id);
    let request_id = input.request_id.clone();
    let operation = async move {
        let resp = req
            .send()
            .await
            .map_err(|e| format!("request failed: {}", e.without_url()))?;
        if resp
            .content_length()
            .is_some_and(|length| length > MAX_PROXY_HTTP_BODY_BYTES as u64)
        {
            return Err("response body exceeds proxy bridge byte limit".to_string());
        }
        let status = resp.status().as_u16();
        let headers: HashMap<String, String> = resp
            .headers()
            .iter()
            .filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string())))
            .collect();
        let mut stream = resp.bytes_stream();
        let mut body = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("read body failed: {error}"))?;
            if body.len().saturating_add(chunk.len()) > MAX_PROXY_HTTP_BODY_BYTES {
                return Err("response body exceeds proxy bridge byte limit".to_string());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(ProxyHttpRequestOutput {
            status,
            headers,
            body_base64: B64.encode(body),
        })
    };

    let result = tokio::select! {
        result = operation => result,
        _ = cancelled => Err("request cancelled".to_string()),
    };
    proxy_http_cancellations().finish(&request_id, generation);

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy_config::{ProxyMode, ProxyProtocol};

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
            url: "not a url".to_string(),
            method: None,
            body_base64: None,
            headers: None,
            timeout_ms: Some(1_000),
            redirect: None,
            block_private: None,
        })
        .await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn proxy_http_request_rejects_invalid_method() {
        let res = proxy_http_request(ProxyHttpRequestInput {
            request_id: "invalid-method".into(),
            url: "http://127.0.0.1:1/".to_string(),
            method: Some("@@@bad".to_string()),
            body_base64: None,
            headers: None,
            timeout_ms: Some(1_000),
            redirect: None,
            block_private: None,
        })
        .await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn proxy_http_request_blocks_private_host_when_guarded() {
        let res = proxy_http_request(ProxyHttpRequestInput {
            request_id: "blocked-private".into(),
            url: "http://169.254.169.254/latest/meta-data/".to_string(),
            method: None,
            body_base64: None,
            headers: None,
            timeout_ms: Some(1_000),
            redirect: None,
            block_private: Some(true),
        })
        .await;
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("private/loopback"));
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
