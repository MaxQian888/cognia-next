//! Tauri commands exposing proxy configuration to the frontend.
//!
//! - `proxy_set` — push a fresh `ProxyConfig` into the in-process state so
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
use super::{set_current, ProxyConfig};

#[derive(Debug, Serialize)]
pub struct ProxyTestResult {
    pub ok: bool,
    pub status: Option<u16>,
    #[serde(rename = "latencyMs")]
    pub latency_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "proxyUrl", skip_serializing_if = "Option::is_none")]
    pub proxy_url: Option<String>,
}

/// Replace the in-process proxy config. Called from the frontend after
/// every settings save and once at app boot.
#[tauri::command]
pub async fn proxy_set(cfg: ProxyConfig) -> Result<(), String> {
    set_current(cfg);
    Ok(())
}

/// Debug aid — return the live `ProxyConfig` snapshot.
#[tauri::command]
pub async fn proxy_get_active() -> Result<ProxyConfig, String> {
    Ok(super::current())
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
    let cfg = super::current();
    let timeout = Duration::from_millis(input.timeout_ms.unwrap_or(10_000));
    let mut builder = reqwest::Client::builder().timeout(timeout);
    if let Some(proxy) = cfg.build_reqwest_proxy() {
        builder = builder.proxy(proxy);
    }
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
            proxy_url: cfg.proxy_url(),
        },
        Err(e) => ProxyTestResult {
            ok: false,
            status: None,
            latency_ms,
            error: Some(e.to_string()),
            proxy_url: cfg.proxy_url(),
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
pub struct ProxyHttpRequestInput {
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    /// Overrides the active proxy URL for this single request. When `None`,
    /// falls back to `proxy_config::current()`.
    #[serde(default)]
    pub proxy_url: Option<String>,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
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
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

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
pub struct ProxyHttpRequestOutput {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
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

    let timeout = Duration::from_secs(input.timeout_secs.unwrap_or(30));
    let mut builder = reqwest::Client::builder().timeout(timeout);

    let cfg = super::current();
    let bypass = cfg.should_bypass(&input.url);
    if !bypass {
        if let Some(override_url) = input.proxy_url.as_deref() {
            // Caller supplied a one-off proxy override.
            let proxy = reqwest::Proxy::all(override_url)
                .map_err(|e| format!("invalid proxy override URL: {e}"))?;
            builder = builder.proxy(proxy);
        } else if let Some(proxy) = cfg.build_reqwest_proxy() {
            builder = builder.proxy(proxy);
        }
    }
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
            req = req.header(k.as_str(), v.as_str());
        }
    }
    if let Some(body) = input.body {
        req = req.body(body);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status().as_u16();
    let headers: HashMap<String, String> = resp
        .headers()
        .iter()
        .filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string())))
        .collect();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("read body failed: {e}"))?;

    Ok(ProxyHttpRequestOutput {
        status,
        headers,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy_config::{ProxyMode, ProxyProtocol};

    #[tokio::test]
    async fn proxy_set_and_get_roundtrip() {
        let prev = super::super::current();
        let cfg = ProxyConfig {
            mode: ProxyMode::Manual,
            protocol: ProxyProtocol::Http,
            host: "10.0.0.1".to_string(),
            port: 1080,
            ..ProxyConfig::default()
        };
        proxy_set(cfg.clone()).await.unwrap();
        let got = proxy_get_active().await.unwrap();
        assert_eq!(got.host, "10.0.0.1");
        assert_eq!(got.port, 1080);
        // Restore for other tests in the file.
        super::super::set_current(prev);
    }

    #[tokio::test]
    async fn proxy_test_reports_error_for_unreachable_host() {
        // Reset to off so the test bypasses any leftover state.
        let prev = super::super::current();
        super::super::set_current(ProxyConfig::default());

        let result = proxy_test(ProxyTestInput {
            url: "http://127.0.0.1:1/should-fail".to_string(),
            timeout_ms: Some(500),
        })
        .await
        .unwrap();
        assert!(!result.ok);
        assert!(result.error.is_some());
        super::super::set_current(prev);
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
        let prev = super::super::current();
        super::super::set_current(ProxyConfig::default());
        let res = proxy_http_request(ProxyHttpRequestInput {
            url: "not a url".to_string(),
            method: None,
            body: None,
            headers: None,
            proxy_url: None,
            timeout_secs: Some(1),
            block_private: None,
        })
        .await;
        assert!(res.is_err());
        super::super::set_current(prev);
    }

    #[tokio::test]
    async fn proxy_http_request_rejects_invalid_method() {
        let res = proxy_http_request(ProxyHttpRequestInput {
            url: "http://127.0.0.1:1/".to_string(),
            method: Some("@@@bad".to_string()),
            body: None,
            headers: None,
            proxy_url: None,
            timeout_secs: Some(1),
            block_private: None,
        })
        .await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn proxy_http_request_blocks_private_host_when_guarded() {
        let res = proxy_http_request(ProxyHttpRequestInput {
            url: "http://169.254.169.254/latest/meta-data/".to_string(),
            method: None,
            body: None,
            headers: None,
            proxy_url: None,
            timeout_secs: Some(1),
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
