// Generic HTTPS proxy for TTS provider REST calls.
//
// Browser fetches to OpenAI / ElevenLabs / Cartesia / Deepgram / LMNT / Hume /
// Gemini / Xiaomi fail under static export: some providers reject browser
// Origins outright (CORS), and a browser-side call would expose the API key to
// any other renderer code. So the frontend builds the request — URL, headers
// (INCLUDING the provider key) and body — and hands it to this command, which
// relays it from the Tauri host and returns the raw audio bytes.
//
// NOTE ON THE KEY: it is supplied by the frontend in `headers`; this proxy does
// not itself hold or inject it (an earlier comment claimed otherwise). A
// hardening follow-up could sink key injection into Rust — look it up from
// `secret_store` by provider id so it never crosses the IPC boundary — tracked
// in ADR-0075.
//
// Requests are constrained to a fixed https allowlist of provider hosts so this
// can never be used as a general SSRF primitive (reaching link-local, loopback,
// or cloud-metadata endpoints).

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};

/// Total and connect budgets. TTS chunks are small; a stuck socket must not
/// pend forever (this command has no other cancellation path).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Hard cap on a relayed response body. Audio for a single chunk is far under
/// this; the cap stops a hostile or runaway endpoint from OOM-ing the host,
/// aggravated by the +33% base64 expansion on the way back.
const MAX_BODY_BYTES: usize = 25 * 1024 * 1024;

/// Registrable domains of the TTS providers that route through this proxy. A
/// URL is allowed only over https and only if its host equals one of these or
/// is a subdomain of it. Keep in sync with the provider adapters' endpoints.
const ALLOWED_HOST_SUFFIXES: &[&str] = &[
    "openai.com",
    "elevenlabs.io",
    "cartesia.ai",
    "deepgram.com",
    "lmnt.com",
    "hume.ai",
    "googleapis.com",
    "xiaomimimo.com",
];

#[derive(Debug, Deserialize)]
pub struct ProxyRequest {
    /// Fully-qualified URL (e.g., "https://api.openai.com/v1/audio/speech").
    pub url: String,
    /// HTTP method — "POST" / "GET" / etc. Defaults to POST.
    #[serde(default = "default_method")]
    pub method: String,
    /// Header map — keys are lowercased before sending.
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// Optional JSON body. Mutually exclusive with `body_b64`.
    #[serde(default)]
    pub json: Option<serde_json::Value>,
    /// Optional raw body — base64-encoded so the bridge stays JSON-safe.
    #[serde(default)]
    pub body_b64: Option<String>,
}

fn default_method() -> String {
    "POST".to_string()
}

#[derive(Debug, Serialize)]
pub struct ProxyResponse {
    pub status: u16,
    pub mime: String,
    /// Base64-encoded body bytes.
    pub body_b64: String,
}

fn host_is_allowed(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    ALLOWED_HOST_SUFFIXES
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

/// Validate the target: https scheme + host on the allowlist. The error never
/// echoes the URL (Gemini carries the key in `?key=`).
fn validate_url(raw: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "invalid url".to_string())?;
    if url.scheme() != "https" {
        return Err("only https targets are allowed".into());
    }
    match url.host_str() {
        Some(h) if host_is_allowed(h) => Ok(()),
        _ => Err("target host is not an allowed TTS provider".into()),
    }
}

/// Map a reqwest error to a message that never leaks the URL or key.
fn safe_err(context: &str, e: &reqwest::Error) -> String {
    let kind = if e.is_timeout() {
        "timed out"
    } else if e.is_connect() {
        "connection failed"
    } else if e.is_body() || e.is_decode() {
        "response read failed"
    } else {
        "request failed"
    };
    format!("{context}: {kind}")
}

fn build_headers(map: &HashMap<String, String>) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    for (k, v) in map {
        let name = HeaderName::from_bytes(k.to_lowercase().as_bytes())
            .map_err(|e| format!("invalid header name '{k}': {e}"))?;
        let val =
            HeaderValue::from_str(v).map_err(|e| format!("invalid header value for '{k}': {e}"))?;
        headers.insert(name, val);
    }
    Ok(headers)
}

fn build_client(proxy: Option<reqwest::Proxy>) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder()
        .user_agent("cognia-next-tts/1.0")
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT);
    if let Some(p) = proxy {
        b = b.proxy(p);
    }
    b.build().map_err(|e| format!("client build failed: {e}"))
}

/// Cached direct (no-proxy) client so repeated chunk synthesis reuses the
/// connection pool and TLS session instead of re-handshaking every call. Its
/// config is static, so it never needs invalidation; the proxied path (rare)
/// builds fresh to keep this client proxy-free.
fn direct_client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| build_client(None).unwrap_or_else(|_| reqwest::Client::new()))
        .clone()
}

#[tauri::command]
pub async fn tts_proxy_fetch(request: ProxyRequest) -> Result<ProxyResponse, String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

    validate_url(&request.url)?;

    let proxy_cfg = cognia_net::proxy_config::current();
    let client = if proxy_cfg.is_active() && !proxy_cfg.should_bypass(&request.url) {
        match proxy_cfg.build_reqwest_proxy() {
            Some(proxy) => build_client(Some(proxy))?,
            None => direct_client(),
        }
    } else {
        direct_client()
    };

    let method = match request.method.to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        other => return Err(format!("unsupported method '{other}'")),
    };

    let mut req = client.request(method, &request.url);
    req = req.headers(build_headers(&request.headers)?);

    if let Some(json) = request.json {
        req = req.json(&json);
    } else if let Some(b64) = request.body_b64 {
        let bytes = B64
            .decode(b64)
            .map_err(|e| format!("body_b64 decode failed: {e}"))?;
        req = req.body(bytes);
    }

    let response = req.send().await.map_err(|e| safe_err("send failed", &e))?;

    let status = response.status().as_u16();
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    // Reject an over-large declared body up front, then stream with a running
    // cap so a chunked response with no Content-Length can't balloon past it.
    if let Some(len) = response.content_length() {
        if len as usize > MAX_BODY_BYTES {
            return Err(format!("response exceeds {MAX_BODY_BYTES} byte cap"));
        }
    }
    let mut stream = response.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| safe_err("body read failed", &e))?;
        if buf.len() + chunk.len() > MAX_BODY_BYTES {
            return Err(format!("response exceeds {MAX_BODY_BYTES} byte cap"));
        }
        buf.extend_from_slice(&chunk);
    }

    Ok(ProxyResponse {
        status,
        mime,
        body_b64: B64.encode(&buf),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_headers_lowercased() {
        let mut map = HashMap::new();
        map.insert("Authorization".to_string(), "Bearer xyz".to_string());
        let headers = build_headers(&map).unwrap();
        assert!(headers.contains_key("authorization"));
    }

    #[test]
    fn rejects_invalid_header_name() {
        let mut map = HashMap::new();
        map.insert("invalid header".to_string(), "v".to_string());
        assert!(build_headers(&map).is_err());
    }

    #[test]
    fn default_method_is_post() {
        let req: ProxyRequest = serde_json::from_str(r#"{"url":"https://example.com"}"#).unwrap();
        assert_eq!(req.method, "POST");
    }

    #[test]
    fn allows_known_provider_hosts_over_https() {
        assert!(validate_url("https://api.openai.com/v1/audio/speech").is_ok());
        assert!(validate_url("https://api.elevenlabs.io/v1/text-to-speech").is_ok());
        assert!(validate_url("https://generativelanguage.googleapis.com/v1beta/x").is_ok());
        assert!(validate_url("https://api.xiaomimimo.com/x").is_ok());
        assert!(validate_url("https://platform.xiaomimimo.com/x").is_ok());
    }

    #[test]
    fn rejects_ssrf_targets_and_non_https() {
        // The exact payloads the old unrestricted proxy would have relayed.
        assert!(validate_url("http://169.254.169.254/latest/meta-data/").is_err());
        assert!(validate_url("http://localhost:11434/api/generate").is_err());
        assert!(validate_url("https://localhost/x").is_err());
        assert!(validate_url("http://127.0.0.1/x").is_err());
        // https required even for an allowed host.
        assert!(validate_url("http://api.openai.com/x").is_err());
        // Not an allowed host.
        assert!(validate_url("https://evil.com/x").is_err());
    }

    #[test]
    fn host_allowlist_resists_suffix_tricks() {
        assert!(host_is_allowed("api.openai.com"));
        assert!(host_is_allowed("openai.com"));
        // Attacker-controlled domain that merely contains an allowed one.
        assert!(!host_is_allowed("api.openai.com.attacker.com"));
        assert!(!host_is_allowed("notopenai.com"));
        assert!(!host_is_allowed("openai.com.evil.com"));
    }
}
