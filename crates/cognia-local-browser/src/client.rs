//! Loopback HTTP client for the local workspace-runtime browser service.
//!
//! The service speaks the private protocol of ADR-0085
//! (`services/workspace-runtime/src/runtime-server.mjs`):
//!
//! - `POST /v1/control` with the envelope `{version: 1, type, requestId?, payload}`;
//!   the reply is `{version, type: "result", requestId?, payload}` on success and
//!   `{code, message}` with a 4xx status on failure;
//! - `GET /v1/media/:session?after=<sequence>` returns the latest 24-byte framed
//!   JPEG newer than `after` (`200` + `x-cognia-media-sequence`) or `204`;
//! - `GET /v1/events?after=<sequence>` returns `{..., payload: [event]}` from the
//!   runtime's event journal.
//!
//! Every request carries `Authorization: Bearer <secret>`. The secret and the
//! port come from [`crate::supervisor`] and never leave Rust.

use std::time::Duration;

use serde_json::{json, Value};

/// The private protocol version both halves speak (`PRIVATE_PROTOCOL_VERSION`).
pub const PRIVATE_PROTOCOL_VERSION: u64 = 1;

/// Longest a control operation may take. Navigation and `browser.wait.*` ops
/// legitimately run for tens of seconds; the runtime enforces its own
/// per-operation timeouts below this.
const CONTROL_TIMEOUT: Duration = Duration::from_secs(180);
/// Media and event polls are cheap reads of in-memory state.
const POLL_TIMEOUT: Duration = Duration::from_secs(15);

/// Where the running service listens and the bearer secret it accepts.
///
/// `generation` increments every time the supervisor spawns a new process, so
/// pollers can tell that sequences (and sessions) from an earlier process are
/// gone.
#[derive(Clone, PartialEq, Eq)]
pub struct RuntimeEndpoint {
    pub base_url: String,
    pub secret: String,
    pub generation: u64,
}

/// Written by hand: a derived `Debug` would print the bearer secret.
impl std::fmt::Debug for RuntimeEndpoint {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeEndpoint")
            .field("base_url", &self.base_url)
            .field("secret", &"<redacted>")
            .field("generation", &self.generation)
            .finish()
    }
}

/// A failed call. `code` is the runtime's own error code when it sent one
/// (`browser_session_not_found`, `unknown_operation`, …), otherwise one of
/// `runtime_unreachable`, `runtime_unauthorized`, `runtime_protocol_error`.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{code}: {message}")]
pub struct ClientError {
    pub code: String,
    pub message: String,
}

impl ClientError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// One media frame: the journal sequence (for the `after` cursor) and the
/// framed bytes exactly as the runtime encoded them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaFrame {
    pub sequence: u64,
    pub bytes: Vec<u8>,
}

/// Build the control envelope (mirrors `protocolEnvelope` in `protocol.mjs`).
pub fn envelope(operation: &str, payload: Value, request_id: Option<&str>) -> Value {
    let mut value = json!({
        "version": PRIVATE_PROTOCOL_VERSION,
        "type": operation,
        "payload": payload,
    });
    if let Some(request_id) = request_id {
        value["requestId"] = Value::String(request_id.to_string());
    }
    value
}

/// Unwrap a control reply: `payload` of a `result` envelope, or the runtime's
/// `{code, message}` error.
pub fn decode_control_reply(status: u16, body: &[u8]) -> Result<Value, ClientError> {
    let value: Value = serde_json::from_slice(body).map_err(|error| {
        ClientError::new(
            "runtime_protocol_error",
            format!("runtime reply was not JSON (status {status}): {error}"),
        )
    })?;
    if status == 401 {
        return Err(ClientError::new(
            "runtime_unauthorized",
            "the local browser runtime rejected the secret",
        ));
    }
    if !(200..300).contains(&status) {
        let code = value
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("runtime_error");
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("the local browser runtime rejected the operation");
        return Err(ClientError::new(code, message));
    }
    if value.get("version").and_then(Value::as_u64) != Some(PRIVATE_PROTOCOL_VERSION)
        || value.get("type").and_then(Value::as_str) != Some("result")
    {
        return Err(ClientError::new(
            "runtime_protocol_error",
            "runtime reply was not a result envelope",
        ));
    }
    Ok(value.get("payload").cloned().unwrap_or(Value::Null))
}

/// Unwrap an events reply into the raw journal entries.
pub fn decode_events_reply(status: u16, body: &[u8]) -> Result<Vec<Value>, ClientError> {
    if status == 401 {
        return Err(ClientError::new(
            "runtime_unauthorized",
            "the local browser runtime rejected the secret",
        ));
    }
    if !(200..300).contains(&status) {
        return Err(ClientError::new(
            "runtime_protocol_error",
            format!("events request failed with status {status}"),
        ));
    }
    let value: Value = serde_json::from_slice(body).map_err(|error| {
        ClientError::new(
            "runtime_protocol_error",
            format!("events reply was not JSON: {error}"),
        )
    })?;
    match value.get("payload") {
        Some(Value::Array(events)) => Ok(events.clone()),
        _ => Err(ClientError::new(
            "runtime_protocol_error",
            "events reply carried no event list",
        )),
    }
}

fn media_path(session_id: &str, after: u64) -> String {
    format!(
        "/v1/media/{}?after={after}",
        percent_encode_segment(session_id)
    )
}

/// Percent-encode one path segment (RFC 3986 unreserved characters pass).
fn percent_encode_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// The HTTP client. Loopback only: it is built with `.no_proxy()` because the
/// runtime is a child process on `127.0.0.1` that a user proxy must never
/// intercept (and a proxy would see the bearer secret).
#[derive(Clone, Debug)]
pub struct RuntimeClient {
    http: reqwest::Client,
}

impl RuntimeClient {
    pub fn new() -> Result<Self, ClientError> {
        cognia_net::proxy_config::ensure_crypto_provider();
        let http = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|error| ClientError::new("runtime_unreachable", error.to_string()))?;
        Ok(Self { http })
    }

    fn url(endpoint: &RuntimeEndpoint, path: &str) -> String {
        format!("{}{path}", endpoint.base_url.trim_end_matches('/'))
    }

    fn unreachable(error: reqwest::Error) -> ClientError {
        ClientError::new("runtime_unreachable", error.to_string())
    }

    /// Issue one control operation and return the reply's `payload`.
    pub async fn control(
        &self,
        endpoint: &RuntimeEndpoint,
        operation: &str,
        payload: Value,
    ) -> Result<Value, ClientError> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let response = self
            .http
            .post(Self::url(endpoint, "/v1/control"))
            .bearer_auth(&endpoint.secret)
            .timeout(CONTROL_TIMEOUT)
            .json(&envelope(operation, payload, Some(&request_id)))
            .send()
            .await
            .map_err(Self::unreachable)?;
        let status = response.status().as_u16();
        let body = response.bytes().await.map_err(Self::unreachable)?;
        decode_control_reply(status, &body)
    }

    /// The latest frame newer than `after`, or `None` when there is none yet.
    pub async fn media(
        &self,
        endpoint: &RuntimeEndpoint,
        session_id: &str,
        after: u64,
    ) -> Result<Option<MediaFrame>, ClientError> {
        let response = self
            .http
            .get(Self::url(endpoint, &media_path(session_id, after)))
            .bearer_auth(&endpoint.secret)
            .timeout(POLL_TIMEOUT)
            .send()
            .await
            .map_err(Self::unreachable)?;
        let status = response.status().as_u16();
        if status == 204 {
            return Ok(None);
        }
        if status == 401 {
            return Err(ClientError::new(
                "runtime_unauthorized",
                "the local browser runtime rejected the secret",
            ));
        }
        if status != 200 {
            return Err(ClientError::new(
                "runtime_protocol_error",
                format!("media request failed with status {status}"),
            ));
        }
        let sequence = response
            .headers()
            .get("x-cognia-media-sequence")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| {
                ClientError::new(
                    "runtime_protocol_error",
                    "media reply carried no sequence header",
                )
            })?;
        let bytes = response.bytes().await.map_err(Self::unreachable)?;
        Ok(Some(MediaFrame {
            sequence,
            bytes: bytes.to_vec(),
        }))
    }

    /// Journal events with a sequence greater than `after`.
    pub async fn events(
        &self,
        endpoint: &RuntimeEndpoint,
        after: u64,
    ) -> Result<Vec<Value>, ClientError> {
        let response = self
            .http
            .get(Self::url(endpoint, &format!("/v1/events?after={after}")))
            .bearer_auth(&endpoint.secret)
            .timeout(POLL_TIMEOUT)
            .send()
            .await
            .map_err(Self::unreachable)?;
        let status = response.status().as_u16();
        let body = response.bytes().await.map_err(Self::unreachable)?;
        decode_events_reply(status, &body)
    }

    /// Whether `/v1/health` answers `ready`.
    pub async fn health(&self, endpoint: &RuntimeEndpoint) -> Result<bool, ClientError> {
        let response = self
            .http
            .get(Self::url(endpoint, "/v1/health"))
            .bearer_auth(&endpoint.secret)
            .timeout(POLL_TIMEOUT)
            .send()
            .await
            .map_err(Self::unreachable)?;
        if !response.status().is_success() {
            return Ok(false);
        }
        let body: Value = response
            .json()
            .await
            .map_err(|error| ClientError::new("runtime_protocol_error", error.to_string()))?;
        Ok(body.get("status").and_then(Value::as_str) == Some("ready"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_partial_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const SECRET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";

    fn endpoint(server: &MockServer) -> RuntimeEndpoint {
        RuntimeEndpoint {
            base_url: server.uri(),
            secret: SECRET.into(),
            generation: 1,
        }
    }

    #[test]
    fn envelope_matches_the_runtime_protocol() {
        let value = envelope("browser.navigate", json!({"sessionId": "s1"}), Some("r1"));
        assert_eq!(
            value,
            json!({
                "version": 1,
                "type": "browser.navigate",
                "requestId": "r1",
                "payload": {"sessionId": "s1"},
            })
        );
        let bare = envelope("browser.pages", json!({}), None);
        assert!(bare.get("requestId").is_none());
    }

    #[test]
    fn control_reply_decodes_payload_and_errors() {
        let ok = br#"{"version":1,"type":"result","requestId":"r","payload":{"id":"s1"}}"#;
        assert_eq!(decode_control_reply(200, ok).unwrap(), json!({"id": "s1"}));

        let null_payload = br#"{"version":1,"type":"result"}"#;
        assert_eq!(decode_control_reply(200, null_payload).unwrap(), Value::Null);

        let failed = br#"{"code":"browser_session_not_found","message":"no session"}"#;
        let error = decode_control_reply(400, failed).unwrap_err();
        assert_eq!(error.code, "browser_session_not_found");
        assert_eq!(error.message, "no session");

        let unauthorized = decode_control_reply(401, br#"{"code":"unauthorized"}"#).unwrap_err();
        assert_eq!(unauthorized.code, "runtime_unauthorized");

        let wrong_version = decode_control_reply(200, br#"{"version":2,"type":"result"}"#);
        assert_eq!(wrong_version.unwrap_err().code, "runtime_protocol_error");

        let not_json = decode_control_reply(200, b"<html>");
        assert_eq!(not_json.unwrap_err().code, "runtime_protocol_error");
    }

    #[test]
    fn events_reply_decodes_the_journal() {
        let body = br#"{"version":1,"type":"events","payload":[{"sequence":3,"type":"pages.changed"}]}"#;
        let events = decode_events_reply(200, body).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["sequence"], 3);
        assert_eq!(
            decode_events_reply(200, br#"{"payload":{}}"#)
                .unwrap_err()
                .code,
            "runtime_protocol_error"
        );
        assert_eq!(
            decode_events_reply(401, b"{}").unwrap_err().code,
            "runtime_unauthorized"
        );
    }

    #[test]
    fn media_path_encodes_the_session_segment() {
        assert_eq!(media_path("abc-1", 4), "/v1/media/abc-1?after=4");
        assert_eq!(media_path("a/b c", 0), "/v1/media/a%2Fb%20c?after=0");
    }

    #[test]
    fn endpoint_debug_redacts_the_secret() {
        let endpoint = RuntimeEndpoint {
            base_url: "http://127.0.0.1:1".into(),
            secret: SECRET.into(),
            generation: 2,
        };
        let printed = format!("{endpoint:?}");
        assert!(!printed.contains(SECRET));
        assert!(printed.contains("<redacted>"));
    }

    #[tokio::test]
    async fn control_posts_an_authorized_envelope() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/control"))
            .and(header("authorization", format!("Bearer {SECRET}").as_str()))
            .and(body_partial_json(json!({
                "version": 1,
                "type": "browser.navigate",
                "payload": {"sessionId": "s1", "url": "https://example.com"},
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "version": 1,
                "type": "result",
                "payload": {"url": "https://example.com/"},
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = RuntimeClient::new().unwrap();
        let result = client
            .control(
                &endpoint(&server),
                "browser.navigate",
                json!({"sessionId": "s1", "url": "https://example.com"}),
            )
            .await
            .unwrap();
        assert_eq!(result, json!({"url": "https://example.com/"}));
    }

    #[tokio::test]
    async fn control_surfaces_runtime_error_codes() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/control"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                "code": "unknown_operation",
                "message": "unknown control operation",
            })))
            .mount(&server)
            .await;
        let client = RuntimeClient::new().unwrap();
        let error = client
            .control(&endpoint(&server), "browser.nope", json!({}))
            .await
            .unwrap_err();
        assert_eq!(error.code, "unknown_operation");
    }

    #[tokio::test]
    async fn media_reads_frames_and_empty_replies() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/media/s1"))
            .and(query_param("after", "0"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("x-cognia-media-sequence", "7")
                    .set_body_bytes(vec![1u8, 2, 3]),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/media/s1"))
            .and(query_param("after", "7"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let client = RuntimeClient::new().unwrap();
        let frame = client
            .media(&endpoint(&server), "s1", 0)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(frame.sequence, 7);
        assert_eq!(frame.bytes, vec![1, 2, 3]);
        assert!(client
            .media(&endpoint(&server), "s1", 7)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn events_and_health_round_trip() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/events"))
            .and(query_param("after", "2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "version": 1,
                "type": "events",
                "payload": [{"sequence": 3, "type": "session.closed", "sessionId": "s1"}],
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/health"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "version": 1,
                "status": "ready",
            })))
            .mount(&server)
            .await;
        let client = RuntimeClient::new().unwrap();
        let events = client.events(&endpoint(&server), 2).await.unwrap();
        assert_eq!(events[0]["type"], "session.closed");
        assert!(client.health(&endpoint(&server)).await.unwrap());
    }

    #[tokio::test]
    async fn unreachable_runtime_is_typed() {
        let client = RuntimeClient::new().unwrap();
        let dead = RuntimeEndpoint {
            base_url: "http://127.0.0.1:9".into(),
            secret: SECRET.into(),
            generation: 1,
        };
        let error = client
            .control(&dead, "browser.pages", json!({}))
            .await
            .unwrap_err();
        assert_eq!(error.code, "runtime_unreachable");
    }
}
