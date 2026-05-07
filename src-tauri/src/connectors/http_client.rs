//! Outbound HTTP client for platform connectors.
//!
//! Wraps `reqwest::Client` with a 30-second default timeout and a simple
//! per-host token-bucket rate limiter (hand-rolled with `Arc<Mutex<...>>`
//! to avoid pulling in extra tower layers). The Tauri command surface lives
//! in `commands.rs`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::{Client, Method};

use super::types::{TauriHttpRequest, TauriHttpResponse};
use crate::proxy_config;

// ---------------------------------------------------------------------------
// Simple token-bucket rate limiter (per host)
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS: u32 = 30;
const REFILL_INTERVAL: Duration = Duration::from_secs(1);

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

    fn try_acquire(&mut self) -> bool {
        let elapsed = self.last_refill.elapsed();
        if elapsed >= REFILL_INTERVAL {
            let refills = (elapsed.as_secs_f64() / REFILL_INTERVAL.as_secs_f64()) as u32;
            self.tokens = (self.tokens + refills).min(self.max_tokens);
            self.last_refill = Instant::now();
        }
        if self.tokens > 0 {
            self.tokens -= 1;
            true
        } else {
            false
        }
    }
}

/// Per-host rate-limit buckets.
static RATE_LIMITS: std::sync::OnceLock<Arc<Mutex<HashMap<String, TokenBucket>>>> =
    std::sync::OnceLock::new();

fn rate_limits() -> &'static Arc<Mutex<HashMap<String, TokenBucket>>> {
    RATE_LIMITS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn check_rate_limit(host: &str) -> bool {
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

    if !check_rate_limit(&host) {
        return Err(format!("rate limit exceeded for host: {host}"));
    }

    let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(30_000));
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

    let method = req
        .method
        .parse::<Method>()
        .map_err(|e| format!("invalid HTTP method: {e}"))?;

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
