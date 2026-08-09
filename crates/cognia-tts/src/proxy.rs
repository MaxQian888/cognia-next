// Generic HTTPS proxy for TTS provider REST calls.
//
// Browser fetches to OpenAI / ElevenLabs / Cartesia / Deepgram / LMNT / Hume /
// Gemini / Xiaomi / Mistral fail under static export: some providers reject browser
// Origins outright (CORS), and a browser-side call would expose the API key to
// any other renderer code. So the frontend builds the request — URL, headers
// (INCLUDING the provider key) and body — and hands it to this command, which
// relays it from the Tauri host and returns the raw audio bytes.
//
// ON THE KEY — two modes:
//
//  - **Caller-supplied (legacy TTS path).** With no `provider` set, the key
//    rides in `headers`, exactly as the TTS provider adapters have always sent
//    it. Behaviour here is unchanged.
//
//  - **Host-injected (`provider` set).** The frontend sends a placeholder
//    credential — enough for an SDK to build a well-formed request — and this
//    command discards it, looks the real key up from the keyring, and injects
//    it. The key never crosses the IPC boundary. This is the hardening the
//    original note tracked against ADR-0075, and it is what the live-voice
//    layer uses so AI SDK adapters can mint realtime session tokens on desktop
//    without ever seeing a provider key.
//
// Requests are constrained to a fixed https allowlist of provider hosts so this
// can never be used as a general SSRF primitive (reaching link-local, loopback,
// or cloud-metadata endpoints). Host-injected requests are pinned harder still:
// each provider's key may only be sent to that provider's own domain, so a
// renderer bug cannot aim the OpenAI key at Google.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use futures_util::{future::Either, FutureExt, StreamExt};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};

use crate::keyring::get_provider_key;

const PII_BLOCKED: &str = "pii-blocked";

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
    "mistral.ai",
    // xAI — realtime session tokens for the live-voice layer.
    "x.ai",
];

/// Header names that may carry a credential. When the host injects the key,
/// every one of these is stripped from the caller's map first: the renderer
/// only ever holds a placeholder, and letting a placeholder through would
/// either leak it or (worse) authenticate as something unintended.
const CREDENTIAL_HEADERS: &[&str] = &[
    "authorization",
    "api-key",
    "x-api-key",
    "x-goog-api-key",
    "xi-api-key",
    "x-hume-api-key",
];

/// How a provider expects its credential to travel.
enum CredentialScheme {
    /// `Authorization: Bearer <key>` — OpenAI, xAI.
    BearerHeader,
    /// `Authorization: Token <key>` — Deepgram.
    TokenHeader,
    /// Provider-specific key header.
    Header(&'static str),
    /// A query parameter. Google's auth-tokens endpoint takes `?key=`.
    QueryParam(&'static str),
}

/// A provider's credential scheme plus the single registrable domain its key
/// may be sent to. The pin is the point: injection alone would still let a
/// mis-tagged request hand one vendor's key to another.
struct CredentialBinding {
    host_suffix: &'static str,
    scheme: CredentialScheme,
}

fn credential_binding(provider: &str) -> Option<CredentialBinding> {
    match provider {
        "openai" => Some(CredentialBinding {
            host_suffix: "openai.com",
            scheme: CredentialScheme::BearerHeader,
        }),
        "xai" => Some(CredentialBinding {
            host_suffix: "x.ai",
            scheme: CredentialScheme::BearerHeader,
        }),
        "google" => Some(CredentialBinding {
            host_suffix: "googleapis.com",
            scheme: CredentialScheme::QueryParam("key"),
        }),
        "elevenlabs" => Some(CredentialBinding {
            host_suffix: "elevenlabs.io",
            scheme: CredentialScheme::Header("xi-api-key"),
        }),
        "lmnt" => Some(CredentialBinding {
            host_suffix: "lmnt.com",
            scheme: CredentialScheme::Header("x-api-key"),
        }),
        "hume" => Some(CredentialBinding {
            host_suffix: "hume.ai",
            scheme: CredentialScheme::Header("x-hume-api-key"),
        }),
        "cartesia" => Some(CredentialBinding {
            host_suffix: "cartesia.ai",
            scheme: CredentialScheme::Header("x-api-key"),
        }),
        "deepgram" => Some(CredentialBinding {
            host_suffix: "deepgram.com",
            scheme: CredentialScheme::TokenHeader,
        }),
        "xiaomi" => Some(CredentialBinding {
            host_suffix: "xiaomimimo.com",
            scheme: CredentialScheme::BearerHeader,
        }),
        "mistral" => Some(CredentialBinding {
            host_suffix: "mistral.ai",
            scheme: CredentialScheme::BearerHeader,
        }),
        _ => None,
    }
}

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
    /// Opt in to host-side credential injection. When set, the key is read from
    /// the keyring and any caller-supplied credential header is discarded, and
    /// the target is pinned to this provider's own domain. Omit it to keep the
    /// legacy behaviour of trusting `headers`.
    #[serde(default)]
    pub provider: Option<String>,
    /// Stable request id used by `tts_proxy_cancel`.
    #[serde(default)]
    pub request_id: Option<String>,
    /// Per-request total timeout. Clamped to 1s..=300s.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
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

/// Exact-or-subdomain match. Written as its own function so the general
/// allowlist and the per-provider pin can never drift into different matching
/// rules — a looser pin would be a credential-leak path.
fn host_matches(host: &str, suffix: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == suffix || host.ends_with(&format!(".{suffix}"))
}

fn host_is_allowed(host: &str) -> bool {
    ALLOWED_HOST_SUFFIXES
        .iter()
        .any(|suffix| host_matches(host, suffix))
}

/// Swap the caller's placeholder credential for the real one from the keyring.
///
/// Returns the URL to actually request, which differs from the input for
/// query-parameter schemes. Errors never echo the URL — Google carries the key
/// in `?key=`.
fn apply_provider_credentials(
    provider: &str,
    url: &str,
    headers: &mut HashMap<String, String>,
) -> Result<String, String> {
    let binding = credential_binding(provider)
        .ok_or_else(|| format!("provider '{provider}' does not support host-injected keys"))?;

    let mut parsed = reqwest::Url::parse(url).map_err(|_| "invalid url".to_string())?;
    if parsed.scheme() != "https" {
        return Err("only https targets are allowed".into());
    }
    if !parsed
        .host_str()
        .is_some_and(|host| host_matches(host, binding.host_suffix))
    {
        return Err(format!(
            "target host is not valid for provider '{provider}'"
        ));
    }

    let key = get_provider_key(provider)?
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| format!("no API key is configured for '{provider}'"))?;
    let key = key.trim();

    headers.retain(|name, _| {
        let name = name.to_ascii_lowercase();
        !CREDENTIAL_HEADERS.contains(&name.as_str())
    });

    match binding.scheme {
        CredentialScheme::BearerHeader => {
            headers.insert("authorization".into(), format!("Bearer {key}"));
        }
        CredentialScheme::TokenHeader => {
            headers.insert("authorization".into(), format!("Token {key}"));
        }
        CredentialScheme::Header(name) => {
            headers.insert(name.into(), key.to_string());
        }
        CredentialScheme::QueryParam(param) => {
            // Collect before taking the mutable borrow, and drop any existing
            // value for `param` so a caller's placeholder cannot survive as a
            // duplicate the upstream might prefer.
            let carried: Vec<(String, String)> = parsed
                .query_pairs()
                .filter(|(name, _)| name != param)
                .map(|(name, value)| (name.into_owned(), value.into_owned()))
                .collect();
            let mut query = parsed.query_pairs_mut();
            query.clear();
            for (name, value) in &carried {
                query.append_pair(name, value);
            }
            query.append_pair(param, key);
        }
    }

    Ok(parsed.to_string())
}

/// Validate the target: https scheme + host on the allowlist. The error never
/// echoes the URL (Gemini carries the key in `?key=`).
fn is_loopback_target(url: &reqwest::Url) -> bool {
    url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .trim_matches(|c| c == '[' || c == ']')
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    })
}

fn validate_url(raw: &str, provider: Option<&str>) -> Result<(), String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "invalid url".to_string())?;
    if provider == Some("local-openai-compatible") {
        if !matches!(url.scheme(), "http" | "https") || !is_loopback_target(&url) {
            return Err("local TTS targets must use http(s) on a loopback address".into());
        }
        return Ok(());
    }
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
        let mut val =
            HeaderValue::from_str(v).map_err(|e| format!("invalid header value for '{k}': {e}"))?;
        // Keeps the credential out of the HPACK dynamic table on HTTP/2 and out
        // of any header-dumping debug output.
        if CREDENTIAL_HEADERS.contains(&name.as_str()) {
            val.set_sensitive(true);
        }
        headers.insert(name, val);
    }
    Ok(headers)
}

fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .user_agent("cognia-next-tts/1.0")
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
}

fn build_policy_client(url: &str) -> Result<reqwest::Client, String> {
    let (builder, _) = cognia_net::proxy_config::apply_reqwest_policy(client_builder(), url)
        .map_err(|error| error.to_string())?;
    builder
        .build()
        .map_err(|error| format!("client build failed: {error}"))
}

fn cancellations() -> &'static cognia_net::request_cancellation::RequestCancellationRegistry {
    static CANCELLATIONS: OnceLock<cognia_net::request_cancellation::RequestCancellationRegistry> =
        OnceLock::new();
    CANCELLATIONS.get_or_init(Default::default)
}

#[tauri::command]
pub fn tts_proxy_cancel(request_id: String) -> bool {
    cancellations().cancel(&request_id)
}

async fn execute_proxy_request(request: ProxyRequest) -> Result<ProxyResponse, String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

    enforce_cloud_pii_boundary(&request)?;

    let mut headers = request.headers;
    // Injection validates https + the per-provider host pin itself; the general
    // allowlist then runs over the rewritten URL as a second, independent check.
    let url = match request.provider.as_deref() {
        Some("local-openai-compatible") => {
            validate_url(&request.url, request.provider.as_deref())?;
            headers.retain(|name, _| {
                let name = name.to_ascii_lowercase();
                !CREDENTIAL_HEADERS.contains(&name.as_str())
            });
            if let Some(key) =
                get_provider_key("local-openai-compatible")?.filter(|key| !key.trim().is_empty())
            {
                headers.insert("authorization".into(), format!("Bearer {}", key.trim()));
            }
            request.url.clone()
        }
        Some(provider) => apply_provider_credentials(provider, &request.url, &mut headers)?,
        None => request.url.clone(),
    };
    validate_url(&url, request.provider.as_deref())?;

    let client = build_policy_client(&url)?;

    let method = match request.method.to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        other => return Err(format!("unsupported method '{other}'")),
    };

    let mut req = client.request(method, &url);
    req = req.headers(build_headers(&headers)?);
    let timeout_ms = request
        .timeout_ms
        .unwrap_or(REQUEST_TIMEOUT.as_millis() as u64)
        .clamp(1_000, 300_000);
    req = req.timeout(Duration::from_millis(timeout_ms));

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

fn enforce_cloud_pii_boundary(request: &ProxyRequest) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

    if request.provider.as_deref() == Some("local-openai-compatible") {
        return Ok(());
    }
    if request
        .json
        .as_ref()
        .is_some_and(|body| !cognia_net::outbound_pii::has_no_leaking_pii(&body.to_string()))
    {
        return Err(PII_BLOCKED.into());
    }
    if let Some(body) = request.body_b64.as_deref() {
        let bytes = B64
            .decode(body)
            .map_err(|_| "body_b64 decode failed".to_string())?;
        if let Ok(text) = std::str::from_utf8(&bytes) {
            if !cognia_net::outbound_pii::has_no_leaking_pii(text) {
                return Err(PII_BLOCKED.into());
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn tts_proxy_fetch(request: ProxyRequest) -> Result<ProxyResponse, String> {
    let Some(request_id) = request
        .request_id
        .clone()
        .filter(|id| !id.trim().is_empty())
    else {
        return execute_proxy_request(request).await;
    };
    let (generation, cancel_rx) = cancellations().register(&request_id);
    let result = match futures_util::future::select(
        execute_proxy_request(request).boxed(),
        cancel_rx.map(|_| ()).boxed(),
    )
    .await
    {
        Either::Left((result, _)) => result,
        Either::Right(((), _)) => Err("request cancelled".into()),
    };
    cancellations().finish(&request_id, generation);
    result
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
        assert!(validate_url("https://api.openai.com/v1/audio/speech", None).is_ok());
        assert!(validate_url("https://api.elevenlabs.io/v1/text-to-speech", None).is_ok());
        assert!(validate_url("https://generativelanguage.googleapis.com/v1beta/x", None).is_ok());
        assert!(validate_url("https://api.xiaomimimo.com/x", None).is_ok());
        assert!(validate_url("https://platform.xiaomimimo.com/x", None).is_ok());
        assert!(validate_url("https://api.mistral.ai/v1/audio/speech", None).is_ok());
    }

    #[test]
    fn rejects_ssrf_targets_and_non_https() {
        // The exact payloads the old unrestricted proxy would have relayed.
        assert!(validate_url("http://169.254.169.254/latest/meta-data/", None).is_err());
        assert!(validate_url("http://localhost:11434/api/generate", None).is_err());
        assert!(validate_url("https://localhost/x", None).is_err());
        assert!(validate_url("http://127.0.0.1/x", None).is_err());
        // https required even for an allowed host.
        assert!(validate_url("http://api.openai.com/x", None).is_err());
        // Not an allowed host.
        assert!(validate_url("https://evil.com/x", None).is_err());
    }

    #[test]
    fn local_provider_accepts_only_literal_loopback_targets() {
        let provider = Some("local-openai-compatible");
        assert!(validate_url("http://localhost:8880/v1/audio/speech", provider).is_ok());
        assert!(validate_url("http://127.9.8.7:8080/v1/audio/speech", provider).is_ok());
        assert!(validate_url("https://[::1]:8080/v1/audio/speech", provider).is_ok());
        assert!(validate_url("http://192.168.1.10:8080/v1/audio/speech", provider).is_err());
        assert!(validate_url("http://169.254.169.254/latest/meta-data", provider).is_err());
        assert!(validate_url("https://local.example/v1/audio/speech", provider).is_err());
    }

    #[test]
    fn xai_realtime_host_is_allowlisted() {
        assert!(validate_url("https://api.x.ai/v1/realtime/client_secrets", None).is_ok());
        assert!(!host_is_allowed("x.ai.attacker.com"));
    }

    #[test]
    fn provider_is_optional_so_legacy_tts_calls_are_unchanged() {
        let req: ProxyRequest =
            serde_json::from_str(r#"{"url":"https://api.openai.com/v1/audio/speech"}"#).unwrap();
        assert!(req.provider.is_none());
    }

    #[test]
    fn cloud_pii_gate_blocks_json_and_raw_text_before_dispatch() {
        let json_request: ProxyRequest = serde_json::from_value(serde_json::json!({
            "url": "https://api.openai.com/v1/audio/speech",
            "provider": "openai",
            "json": { "input": "Email user@example.com" }
        }))
        .unwrap();
        assert_eq!(
            enforce_cloud_pii_boundary(&json_request),
            Err(PII_BLOCKED.into())
        );

        let raw_request: ProxyRequest = serde_json::from_value(serde_json::json!({
            "url": "https://api.openai.com/v1/audio/speech",
            "body_b64": "U1NOIDEyMy00NS02Nzg5"
        }))
        .unwrap();
        assert_eq!(
            enforce_cloud_pii_boundary(&raw_request),
            Err(PII_BLOCKED.into())
        );
    }

    #[test]
    fn cloud_pii_gate_allows_safe_text_and_exempts_loopback_tts() {
        let safe_request: ProxyRequest = serde_json::from_value(serde_json::json!({
            "url": "https://api.openai.com/v1/audio/speech",
            "provider": "openai",
            "json": { "input": "Read the release notes" }
        }))
        .unwrap();
        assert_eq!(enforce_cloud_pii_boundary(&safe_request), Ok(()));

        let local_request: ProxyRequest = serde_json::from_value(serde_json::json!({
            "url": "http://localhost:8880/v1/audio/speech",
            "provider": "local-openai-compatible",
            "json": { "input": "Email user@example.com" }
        }))
        .unwrap();
        assert_eq!(enforce_cloud_pii_boundary(&local_request), Ok(()));
    }

    #[test]
    fn credential_headers_are_marked_sensitive() {
        let mut map = HashMap::new();
        map.insert("Authorization".to_string(), "Bearer xyz".to_string());
        map.insert("Content-Type".to_string(), "application/json".to_string());
        let headers = build_headers(&map).unwrap();
        assert!(headers.get("authorization").unwrap().is_sensitive());
        assert!(!headers.get("content-type").unwrap().is_sensitive());
    }

    #[test]
    fn a_providers_key_is_pinned_to_its_own_domain() {
        let mut headers = HashMap::new();
        // Each of these would otherwise hand one vendor's key to another. The
        // pin is checked before the keyring is read, so no key is even loaded.
        assert!(apply_provider_credentials(
            "openai",
            "https://generativelanguage.googleapis.com/v1/x",
            &mut headers
        )
        .is_err());
        assert!(
            apply_provider_credentials("google", "https://api.openai.com/v1/x", &mut headers)
                .is_err()
        );
        assert!(
            apply_provider_credentials("xai", "https://api.openai.com/v1/x", &mut headers).is_err()
        );
        // https is required even on the pinned host.
        assert!(
            apply_provider_credentials("openai", "http://api.openai.com/v1/x", &mut headers)
                .is_err()
        );
        // A provider with no binding never reaches the keyring at all.
        assert!(apply_provider_credentials(
            "elevenlabs",
            "https://api.elevenlabs.io/x",
            &mut headers
        )
        .is_err());
        assert!(headers.is_empty(), "a rejected request injects nothing");
    }

    #[test]
    fn injection_errors_never_echo_the_url() {
        let mut headers = HashMap::new();
        let err =
            apply_provider_credentials("google", "https://evil.com/v1?key=leaked", &mut headers)
                .unwrap_err();
        assert!(
            !err.contains("leaked"),
            "error leaked the query string: {err}"
        );
    }

    // The in-memory secret store is a process global and cargo runs tests in
    // parallel threads, so each keyring-touching test owns a provider entry no
    // other test in this crate writes to.

    #[tokio::test]
    async fn bearer_credentials_come_from_the_keyring_not_the_caller() {
        let mut headers = HashMap::new();
        let url = "https://api.x.ai/v1/realtime/client_secrets";

        // Nothing configured yet: refuse rather than send an unauthenticated
        // request and surface the vendor's 401 as a mystery.
        assert!(apply_provider_credentials("xai", url, &mut headers).is_err());

        crate::keyring::tts_keyring_set("xai".into(), "xai-real".into())
            .await
            .unwrap();
        headers.insert("Authorization".into(), "Bearer placeholder".into());
        headers.insert("Content-Type".into(), "application/json".into());

        let resolved = apply_provider_credentials("xai", url, &mut headers).unwrap();

        assert_eq!(resolved, url, "bearer schemes leave the URL alone");
        assert_eq!(
            headers.get("authorization").map(String::as_str),
            Some("Bearer xai-real")
        );
        assert!(
            !headers.contains_key("Authorization"),
            "the caller's placeholder must be stripped, not shadowed"
        );
        assert_eq!(
            headers.get("Content-Type").map(String::as_str),
            Some("application/json"),
            "non-credential headers must survive"
        );

        crate::keyring::tts_keyring_delete("xai".into())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn google_credentials_replace_the_key_query_parameter() {
        crate::keyring::tts_keyring_set("google".into(), "goog-real".into())
            .await
            .unwrap();
        let mut headers = HashMap::new();
        headers.insert("x-goog-api-key".to_string(), "placeholder".to_string());

        let resolved = apply_provider_credentials(
            "google",
            "https://generativelanguage.googleapis.com/v1alpha/auth_tokens?key=placeholder&alt=json",
            &mut headers,
        )
        .unwrap();

        assert!(resolved.contains("key=goog-real"));
        assert!(
            resolved.contains("alt=json"),
            "other params must be carried"
        );
        assert!(
            !resolved.contains("placeholder"),
            "the placeholder must not survive as a duplicate: {resolved}"
        );
        assert!(
            headers.is_empty(),
            "the placeholder api-key header must not be forwarded"
        );

        crate::keyring::tts_keyring_delete("google".into())
            .await
            .unwrap();
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
