//! Outbound HTTP client for platform connectors.
//!
//! Wraps `reqwest::Client` with a 30-second default timeout and a simple
//! per-host token-bucket rate limiter (hand-rolled with `Arc<Mutex<...>>`
//! to avoid pulling in extra tower layers). The Tauri command surface lives
//! in `commands.rs`.
//!
//! # SSRF trust model
//!
//! `connectors_http_request` is a general-purpose HTTP proxy, but only the
//! FIRST-PARTY renderer (connector adapters in `lib/connectors/`) can invoke
//! connector commands — plugins cannot invoke them. (The plugin runtime's
//! `network:fetch` bridge does reuse [`http_request`] directly, but only
//! behind its own fail-closed per-plugin `allowedDomains` allowlist — see
//! `cognia-plugin-runtime::api_bridge::guard_network_host`.) So no untrusted
//! code gets to pick an arbitrary URL. Requests to localhost / private ranges
//! are deliberately allowed (OneBot forward-WS and local dev gateways are
//! legitimate targets). The single carve-out is the link-local cloud metadata
//! endpoint `169.254.169.254`, which is never a valid chat-platform API host
//! and is denied outright.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::Client;

use super::types::{TauriHttpRequest, TauriHttpResponse};
use cognia_net::proxy_config;

// ---------------------------------------------------------------------------
// Simple token-bucket rate limiter (per host)
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS: u32 = 30;
/// Sustained per-host request rate. 1 token/s starved chatty adapters
/// (Discord REST easily sustains >1 rps across channels); 5/s stays well
/// under every platform's own limits while preventing runaway loops.
const REFILL_TOKENS_PER_SEC: u32 = 5;

struct TokenBucket {
    tokens: u32,
    max_tokens: u32,
    last_refill: Instant,
}

impl TokenBucket {
    fn new(max_tokens: u32) -> Self {
        Self {
            tokens: max_tokens,
            max_tokens,
            last_refill: Instant::now(),
        }
    }

    /// Take one token, refilling at [`REFILL_TOKENS_PER_SEC`] first. On
    /// exhaustion returns `Err(retry_after)` — the time until the next token
    /// becomes available.
    fn try_acquire(&mut self) -> Result<(), Duration> {
        let elapsed = self.last_refill.elapsed();
        let refills = (elapsed.as_secs_f64() * f64::from(REFILL_TOKENS_PER_SEC)) as u32;
        if refills > 0 {
            self.tokens = (self.tokens + refills).min(self.max_tokens);
            // Advance only by the time the granted tokens account for, so the
            // fractional remainder keeps accumulating toward the next token.
            self.last_refill +=
                Duration::from_secs_f64(f64::from(refills) / f64::from(REFILL_TOKENS_PER_SEC));
        }
        if self.tokens > 0 {
            self.tokens -= 1;
            Ok(())
        } else {
            let since_refill = self.last_refill.elapsed();
            let per_token = Duration::from_secs_f64(1.0 / f64::from(REFILL_TOKENS_PER_SEC));
            Err(per_token.saturating_sub(since_refill))
        }
    }
}

/// Per-host rate-limit buckets.
static RATE_LIMITS: std::sync::OnceLock<Arc<Mutex<HashMap<String, TokenBucket>>>> =
    std::sync::OnceLock::new();

fn rate_limits() -> &'static Arc<Mutex<HashMap<String, TokenBucket>>> {
    RATE_LIMITS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn check_rate_limit(host: &str) -> Result<(), Duration> {
    let mut map = rate_limits().lock().unwrap();
    let bucket = map
        .entry(host.to_string())
        .or_insert_with(|| TokenBucket::new(DEFAULT_MAX_TOKENS));
    bucket.try_acquire()
}

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

/// Execute a platform HTTP request. Returns a structured response or a string
/// error that the TS side can inspect.
pub async fn http_request(req: TauriHttpRequest) -> Result<TauriHttpResponse, String> {
    // Extract host for rate-limit keying.
    let parsed = url::Url::parse(&req.url).map_err(|e| format!("invalid URL: {e}"))?;
    let host = parsed.host_str().unwrap_or("").to_string();

    // Cheap SSRF deny-list — see the module header for the trust model. Only
    // the link-local metadata endpoint is blocked; localhost must stay
    // reachable (OneBot forward-WS, local dev flows).
    if host == "169.254.169.254" {
        return Err("requests to the link-local metadata endpoint (169.254.169.254) are not allowed".to_string());
    }

    if let Err(retry_after) = check_rate_limit(&host) {
        return Err(format!(
            "rate limit exceeded for host: {host}; retry after ~{}ms",
            retry_after.as_millis().max(1)
        ));
    }

    let timeout = req.timeout_duration();
    let proxy_cfg = proxy_config::current();
    let mut builder = Client::builder().timeout(timeout);
    // Only attach the proxy when active AND the target isn't on the bypass
    // list — otherwise localhost dev servers would round-trip through the
    // user's external proxy.
    if proxy_cfg.is_active() && !proxy_cfg.should_bypass(&req.url) {
        if let Some(proxy) = proxy_cfg.build_reqwest_proxy() {
            builder = builder.proxy(proxy);
        }
    }
    let client = builder
        .build()
        .map_err(|e| format!("reqwest build failed: {e}"))?;

    let method = req.validated_method()?;

    let mut builder = client.request(method, &req.url);

    if let Some(headers) = &req.headers {
        for (k, v) in headers {
            builder = builder.header(k.as_str(), v.as_str());
        }
    }

    if let Some(body) = req.body {
        builder = builder.body(body);
    }

    let resp = builder
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status().as_u16();
    let headers: HashMap<String, String> = resp
        .headers()
        .iter()
        .filter_map(|(k, v)| {
            let key = k.as_str().to_string();
            let val = v.to_str().ok()?.to_string();
            Some((key, val))
        })
        .collect();

    let body = resp
        .text()
        .await
        .map_err(|e| format!("failed to read response body: {e}"))?;

    Ok(TauriHttpResponse {
        status,
        headers,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn bucket_starts_full_and_drains_to_exhaustion() {
        let mut bucket = TokenBucket::new(DEFAULT_MAX_TOKENS);
        for _ in 0..DEFAULT_MAX_TOKENS {
            assert!(bucket.try_acquire().is_ok());
        }
        // 31st acquire fails with a retry-after hint no larger than one
        // token period (200ms at 5 tokens/sec).
        let retry_after = bucket.try_acquire().unwrap_err();
        assert!(retry_after <= Duration::from_millis(200), "got {retry_after:?}");
    }

    #[test]
    fn bucket_refills_five_tokens_per_second() {
        let mut bucket = TokenBucket::new(DEFAULT_MAX_TOKENS);
        for _ in 0..DEFAULT_MAX_TOKENS {
            bucket.try_acquire().unwrap();
        }
        assert!(bucket.try_acquire().is_err());

        // Simulate 1 second elapsed → exactly 5 tokens refill.
        bucket.last_refill -= Duration::from_secs(1);
        for _ in 0..5 {
            assert!(bucket.try_acquire().is_ok());
        }
        assert!(bucket.try_acquire().is_err(), "6th token must not exist");
    }

    #[test]
    fn bucket_refill_caps_at_max() {
        let mut bucket = TokenBucket::new(DEFAULT_MAX_TOKENS);
        // A long idle period must not overfill past max_tokens.
        bucket.last_refill -= Duration::from_secs(3600);
        for _ in 0..DEFAULT_MAX_TOKENS {
            assert!(bucket.try_acquire().is_ok());
        }
        assert!(bucket.try_acquire().is_err());
    }

    #[test]
    fn bucket_preserves_fractional_refill_progress() {
        let mut bucket = TokenBucket::new(DEFAULT_MAX_TOKENS);
        for _ in 0..DEFAULT_MAX_TOKENS {
            bucket.try_acquire().unwrap();
        }
        // 300ms at 5 tokens/sec = 1.5 tokens → grant 1, keep the 0.5-token
        // (100ms) remainder: last_refill advances by only 200ms.
        let before = bucket.last_refill;
        bucket.last_refill -= Duration::from_millis(300);
        assert!(bucket.try_acquire().is_ok());
        let advanced = bucket.last_refill - (before - Duration::from_millis(300));
        assert_eq!(advanced, Duration::from_millis(200));
    }

    #[tokio::test]
    async fn metadata_endpoint_is_denied() {
        let err = http_request(TauriHttpRequest {
            url: "http://169.254.169.254/latest/meta-data/".to_string(),
            method: "GET".to_string(),
            headers: None,
            body: None,
            timeout_ms: None,
        })
        .await
        .unwrap_err();
        assert!(err.contains("169.254.169.254"), "got: {err}");
        assert!(err.contains("not allowed"), "got: {err}");
    }

    #[tokio::test]
    async fn get_request_returns_correct_body() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/ping"))
            .respond_with(ResponseTemplate::new(200).set_body_string("pong"))
            .mount(&mock_server)
            .await;

        let req = TauriHttpRequest {
            url: format!("{}/ping", mock_server.uri()),
            method: "GET".to_string(),
            headers: None,
            body: None,
            timeout_ms: None,
        };

        let resp = http_request(req).await.unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.body, "pong");
    }

    #[tokio::test]
    async fn post_request_with_body() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/echo"))
            .respond_with(ResponseTemplate::new(201).set_body_string("created"))
            .mount(&mock_server)
            .await;

        let req = TauriHttpRequest {
            url: format!("{}/echo", mock_server.uri()),
            method: "POST".to_string(),
            headers: None,
            body: Some(r#"{"key":"value"}"#.to_string()),
            timeout_ms: None,
        };

        let resp = http_request(req).await.unwrap();
        assert_eq!(resp.status, 201);
        assert_eq!(resp.body, "created");
    }
}
