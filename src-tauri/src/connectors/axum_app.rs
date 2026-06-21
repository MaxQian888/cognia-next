//! Connectors axum router.
//!
//! Routes:
//!   GET  /health                            → 200 {"ok":true}
//!   POST /webhook/:adapter_type/:adapter_id → verifies platform signature
//!                                              then emits the parsed body on
//!                                              `connectors://webhook/<adapter_id>`
//!   *    /ws/onebot/:adapter_id             → OneBot reverse-WS (ws_server.rs)
//!
//! The webhook handler dispatches by the *registered* `adapter_type` (looked
//! up in `ConnectorsState`), not the URL segment, so a wrong/spoofed URL
//! component cannot bypass verification.
//!
//! Per-adapter credential conventions in the OS keyring (service
//! `com.cognia.platforms`, account `<adapter_id>:<name>`):
//!
//!   telegram → secretToken
//!   slack    → signingSecret
//!   discord  → publicKey
//!   lark     → verificationToken (+ optional encryptKey for encrypted events)

use axum::{
    body::Body,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, Method, StatusCode},
    response::Response,
    routing::{any, get},
    Extension, Router,
};
use bytes::Bytes;
use std::collections::HashMap;
use std::sync::Arc;

use super::state::ConnectorsState;
use super::ws_server;

/// Sink for `connectors://webhook/<adapter_id>` events. The live impl wraps a
/// `tauri::AppHandle`; tests substitute a recording mock.
pub trait EventEmitter: Send + Sync + 'static {
    fn emit_webhook(&self, adapter_id: &str, payload: &serde_json::Value);
}

/// Production emitter — forwards to the renderer via Tauri events.
pub struct AppHandleEmitter(pub tauri::AppHandle);

impl EventEmitter for AppHandleEmitter {
    fn emit_webhook(&self, adapter_id: &str, payload: &serde_json::Value) {
        use tauri::Emitter;
        let _ = self
            .0
            .emit(&format!("connectors://webhook/{adapter_id}"), payload);
    }
}

/// Cheap wrapper so `Arc<dyn EventEmitter>` can ride an axum `Extension`
/// (which requires `Clone`).
#[derive(Clone)]
pub struct EmitterExt(pub Arc<dyn EventEmitter>);

/// Carries the live `tauri::AppHandle` to the OneBot reverse-WS handler, which
/// needs both `Emitter` (open/event/response/close) and `Listener` (the
/// outbound `/send` channel) — capabilities the `EventEmitter` trait does not
/// expose. Layered only by `build_router` (production); absent in the
/// `build_unresolved_router` test path, where the WS handler falls back to
/// auth-only frame draining.
#[derive(Clone)]
pub struct AppHandleExt(pub tauri::AppHandle);

/// Build the connectors axum `Router<ConnectorsState>` (state not yet
/// resolved). Used by tests in `ws_server.rs` that compose extra routes.
pub fn build_unresolved_router() -> Router<ConnectorsState> {
    let base = Router::new()
        .route("/health", get(health_handler))
        .route("/webhook/{adapter_type}/{adapter_id}", any(webhook_handler));
    ws_server::register_routes(base)
}

/// Compose the resolved router with state + emitter. Used by
/// `server_lifecycle::start_server`. `app` carries the live `AppHandle` for the
/// OneBot reverse-WS bridge; production passes `Some(...)`, tests pass `None`
/// (the WS handler then drains frames after auth, preserving prior behaviour).
pub fn build_router(
    state: ConnectorsState,
    emitter: Arc<dyn EventEmitter>,
    app: Option<tauri::AppHandle>,
) -> Router {
    let mut router = build_unresolved_router()
        .with_state(state)
        .layer(Extension(EmitterExt(emitter)));
    if let Some(app) = app {
        router = router.layer(Extension(AppHandleExt(app)));
    }
    router
}

async fn health_handler() -> &'static str {
    r#"{"ok":true}"#
}

/// Webhook router — verifies the platform signature, then emits the parsed
/// body to the renderer. The URL `:adapter_type` segment is informational;
/// the registered adapter's type is the source of truth.
async fn webhook_handler(
    State(state): State<ConnectorsState>,
    Extension(EmitterExt(emitter)): Extension<EmitterExt>,
    Path((_url_adapter_type, adapter_id)): Path<(String, String)>,
    method: Method,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // Resolve the registered adapter type up front so WeChat OA — which needs a
    // bespoke GET echostr handshake + an encrypted reply protocol the
    // fire-and-forget `verify_webhook` flow can't express — can branch off.
    let adapter_type = {
        let inner = state.inner.lock();
        inner
            .registered_adapters
            .get(&adapter_id)
            .map(|reg| reg.adapter_type.clone())
    };
    let adapter_type = match adapter_type {
        Some(t) => t,
        None => return error_response(StatusCode::NOT_FOUND, "adapter not registered"),
    };

    if adapter_type == "wechat-oa" {
        return wechat_oa_handler(
            &adapter_id,
            &method,
            raw_query.as_deref().unwrap_or(""),
            &body,
            emitter.as_ref(),
        )
        .await;
    }

    match verify_webhook(&state, &adapter_id, &headers, &body).await {
        Ok(payload) => {
            emitter.emit_webhook(&adapter_id, &payload);
            ok_response()
        }
        Err((status, msg)) => error_response(status, msg),
    }
}

/// Parse a `&`-separated, percent-encoded query string into a map.
fn parse_query(raw: &str) -> HashMap<String, String> {
    serde_urlencoded::from_str::<Vec<(String, String)>>(raw)
        .map(|pairs| pairs.into_iter().collect())
        .unwrap_or_default()
}

/// Pull the inner text of a CDATA-wrapped XML field, e.g.
/// `<Encrypt><![CDATA[abc]]></Encrypt>` → `abc`. Falls back to a bare
/// `<Encrypt>abc</Encrypt>` when CDATA is absent.
fn extract_xml_field(xml: &str, field: &str) -> Option<String> {
    let open = format!("<{field}>");
    let close = format!("</{field}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    let inner = xml[start..end].trim();
    let inner = inner
        .strip_prefix("<![CDATA[")
        .and_then(|s| s.strip_suffix("]]>"))
        .unwrap_or(inner);
    Some(inner.trim().to_string())
}

/// WeChat Official Account webhook handler.
///
/// GET  → URL verification: verify `signature` over (token, timestamp, nonce)
///        and echo `echostr` back verbatim.
/// POST → message callback: verify `msg_signature`, decrypt the `<Encrypt>`
///        field (safe mode), emit the inner XML as `{"xml": ...}`, and reply
///        `success` so WeChat does not retry (the bot replies asynchronously
///        via the 客服 message API).
async fn wechat_oa_handler(
    adapter_id: &str,
    method: &Method,
    raw_query: &str,
    body: &[u8],
    emitter: &dyn EventEmitter,
) -> Response {
    let params = parse_query(raw_query);
    let timestamp = params.get("timestamp").map(String::as_str).unwrap_or("");
    let nonce = params.get("nonce").map(String::as_str).unwrap_or("");

    let token = match super::keyring::get(adapter_id, "token") {
        Ok(Some(t)) => t,
        Ok(None) => return error_response(StatusCode::UNAUTHORIZED, "token not configured"),
        Err(_) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "keyring read failed"),
    };

    if method == Method::GET {
        let signature = params.get("signature").map(String::as_str).unwrap_or("");
        let echostr = params.get("echostr").cloned().unwrap_or_default();
        return match super::sigverify::wechat::verify_signature(&token, timestamp, nonce, signature)
        {
            Ok(()) => text_response(echostr),
            Err(_) => error_response(StatusCode::UNAUTHORIZED, "signature verification failed"),
        };
    }

    // POST — message callback.
    let xml = match std::str::from_utf8(body) {
        Ok(s) => s,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "body is not UTF-8"),
    };

    if let Some(encrypt) = extract_xml_field(xml, "Encrypt") {
        let msg_signature = params.get("msg_signature").map(String::as_str).unwrap_or("");
        if super::sigverify::wechat::verify_msg_signature(
            &token,
            timestamp,
            nonce,
            &encrypt,
            msg_signature,
        )
        .is_err()
        {
            return error_response(StatusCode::UNAUTHORIZED, "signature verification failed");
        }
        let aes_key = match super::keyring::get(adapter_id, "encodingAesKey") {
            Ok(Some(k)) => k,
            Ok(None) => {
                return error_response(StatusCode::UNAUTHORIZED, "encoding aes key not configured")
            }
            Err(_) => {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, "keyring read failed")
            }
        };
        match super::sigverify::wechat::decrypt(&aes_key, &encrypt) {
            Ok((msg_xml, _appid)) => {
                emitter.emit_webhook(adapter_id, &serde_json::json!({ "xml": msg_xml }));
                text_response("success".to_string())
            }
            Err(_) => error_response(StatusCode::UNAUTHORIZED, "decryption failed"),
        }
    } else {
        // Plaintext mode — verify the plain signature, emit the raw XML.
        let signature = params.get("signature").map(String::as_str).unwrap_or("");
        if super::sigverify::wechat::verify_signature(&token, timestamp, nonce, signature).is_err() {
            return error_response(StatusCode::UNAUTHORIZED, "signature verification failed");
        }
        emitter.emit_webhook(adapter_id, &serde_json::json!({ "xml": xml }));
        text_response("success".to_string())
    }
}

fn text_response(body: String) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/plain; charset=utf-8")
        .body(Body::from(body))
        .unwrap()
}

/// Pure verification function — no `AppHandle`, no event emission. Returns
/// the JSON payload to forward (already decrypted for Lark events).
pub async fn verify_webhook(
    state: &ConnectorsState,
    adapter_id: &str,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<serde_json::Value, (StatusCode, &'static str)> {
    let adapter_type = {
        let inner = state.inner.lock();
        match inner.registered_adapters.get(adapter_id) {
            Some(reg) => reg.adapter_type.clone(),
            None => return Err((StatusCode::NOT_FOUND, "adapter not registered")),
        }
    };

    match adapter_type.as_str() {
        "telegram" => verify_telegram(adapter_id, headers, body).await,
        "slack" => verify_slack(adapter_id, headers, body).await,
        "discord" => verify_discord(adapter_id, headers, body).await,
        "lark" => verify_lark(adapter_id, body).await,
        _ => Err((StatusCode::BAD_REQUEST, "unsupported adapter type")),
    }
}

async fn verify_telegram(
    adapter_id: &str,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<serde_json::Value, (StatusCode, &'static str)> {
    let expected = super::keyring::get(adapter_id, "secretToken")
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "keyring read failed"))?
        .ok_or((StatusCode::UNAUTHORIZED, "secret token not configured"))?;

    let provided = headers
        .get("X-Telegram-Bot-Api-Secret-Token")
        .and_then(|v| v.to_str().ok());

    super::sigverify::telegram::verify_secret_token(provided, &expected)
        .map_err(|_| (StatusCode::UNAUTHORIZED, "signature verification failed"))?;

    serde_json::from_slice(body).map_err(|_| (StatusCode::BAD_REQUEST, "invalid JSON body"))
}

async fn verify_slack(
    adapter_id: &str,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<serde_json::Value, (StatusCode, &'static str)> {
    let expected = super::keyring::get(adapter_id, "signingSecret")
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "keyring read failed"))?
        .ok_or((StatusCode::UNAUTHORIZED, "signing secret not configured"))?;

    let timestamp = headers
        .get("X-Slack-Request-Timestamp")
        .and_then(|v| v.to_str().ok())
        .ok_or((StatusCode::UNAUTHORIZED, "missing timestamp header"))?;

    let signature = headers
        .get("X-Slack-Signature")
        .and_then(|v| v.to_str().ok())
        .ok_or((StatusCode::UNAUTHORIZED, "missing signature header"))?;

    let now = chrono::Utc::now().timestamp();
    super::sigverify::slack::verify_v0(timestamp, body, signature, &expected, now)
        .map_err(|_| (StatusCode::UNAUTHORIZED, "signature verification failed"))?;

    serde_json::from_slice(body).map_err(|_| (StatusCode::BAD_REQUEST, "invalid JSON body"))
}

async fn verify_discord(
    adapter_id: &str,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<serde_json::Value, (StatusCode, &'static str)> {
    let public_key = super::keyring::get(adapter_id, "publicKey")
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "keyring read failed"))?
        .ok_or((StatusCode::UNAUTHORIZED, "public key not configured"))?;

    let timestamp = headers
        .get("X-Signature-Timestamp")
        .and_then(|v| v.to_str().ok())
        .ok_or((StatusCode::UNAUTHORIZED, "missing timestamp header"))?;

    let signature = headers
        .get("X-Signature-Ed25519")
        .and_then(|v| v.to_str().ok())
        .ok_or((StatusCode::UNAUTHORIZED, "missing signature header"))?;

    super::sigverify::discord::verify_ed25519(timestamp, body, signature, &public_key)
        .map_err(|_| (StatusCode::UNAUTHORIZED, "signature verification failed"))?;

    // Replay protection: the signature stays valid forever, so reject stale
    // timestamps (Discord always sends `X-Signature-Timestamp`).
    let now = chrono::Utc::now().timestamp();
    super::sigverify::discord::check_timestamp(timestamp, now)
        .map_err(|_| (StatusCode::UNAUTHORIZED, "stale request timestamp"))?;

    serde_json::from_slice(body).map_err(|_| (StatusCode::BAD_REQUEST, "invalid JSON body"))
}

async fn verify_lark(
    adapter_id: &str,
    body: &[u8],
) -> Result<serde_json::Value, (StatusCode, &'static str)> {
    let expected_token = super::keyring::get(adapter_id, "verificationToken")
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "keyring read failed"))?
        .ok_or((StatusCode::UNAUTHORIZED, "verification token not configured"))?;

    let outer: serde_json::Value = serde_json::from_slice(body)
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid JSON body"))?;

    // Encrypted events arrive as `{"encrypt":"<base64>"}` — decrypt then
    // re-parse before reading the token field.
    let payload = if let Some(enc) = outer.get("encrypt").and_then(|v| v.as_str()) {
        let encrypt_key = super::keyring::get(adapter_id, "encryptKey")
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "keyring read failed"))?
            .ok_or((StatusCode::UNAUTHORIZED, "encrypt key not configured"))?;
        let plaintext = super::sigverify::lark::decrypt_body(enc, &encrypt_key)
            .map_err(|_| (StatusCode::UNAUTHORIZED, "decryption failed"))?;
        serde_json::from_slice(&plaintext)
            .map_err(|_| (StatusCode::BAD_REQUEST, "decrypted body is not JSON"))?
    } else {
        outer
    };

    // Schema 2.0 puts the token at `header.token`; legacy schema 1.0 at the
    // top-level `token`.
    let provided_token = payload
        .get("header")
        .and_then(|h| h.get("token"))
        .or_else(|| payload.get("token"))
        .and_then(|v| v.as_str());

    super::sigverify::lark::verify_token(provided_token, &expected_token)
        .map_err(|_| (StatusCode::UNAUTHORIZED, "signature verification failed"))?;

    lark_replay_check(adapter_id, &payload)?;

    Ok(payload)
}

/// Replay protection for verified Lark events. Lark authenticates inbound
/// events only with a static token (no per-body HMAC), so a captured valid
/// event could be replayed indefinitely. Real schema-2.0 events carry
/// `header.create_time` (epoch ms) and `header.event_id`; we enforce a
/// freshness window on the former and de-duplicate on the latter.
///
/// The URL-verification handshake (`type == "url_verification"` / top-level
/// `challenge`) carries neither field and must still pass — it is skipped.
/// When a non-challenge event is *missing* both fields we fall back to
/// token-only (lenient) rather than reject, so legacy/edge payloads are not
/// broken; captured real events — which always include the fields — are still
/// fully protected.
fn lark_replay_check(
    adapter_id: &str,
    payload: &serde_json::Value,
) -> Result<(), (StatusCode, &'static str)> {
    // URL-verification handshake — no replay state, let it through.
    let is_url_verification = payload.get("challenge").is_some()
        || payload.get("type").and_then(|v| v.as_str()) == Some("url_verification");
    if is_url_verification {
        return Ok(());
    }

    let header = payload.get("header");
    let create_time = header
        .and_then(|h| h.get("create_time"))
        .and_then(|v| v.as_str());
    let event_id = header
        .and_then(|h| h.get("event_id"))
        .and_then(|v| v.as_str());

    if let Some(create_time) = create_time {
        let now_ms = chrono::Utc::now().timestamp_millis();
        super::sigverify::lark::check_create_time(Some(create_time), now_ms)
            .map_err(|_| (StatusCode::UNAUTHORIZED, "stale event timestamp"))?;
    }

    if let Some(event_id) = event_id {
        let key = format!("lark:{adapter_id}:{event_id}");
        if !super::replay_guard::global().check_and_record(key) {
            return Err((StatusCode::UNAUTHORIZED, "duplicate event (replay)"));
        }
    }

    Ok(())
}

fn ok_response() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(r#"{"ok":true}"#))
        .unwrap()
}

fn error_response(status: StatusCode, msg: &str) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::json!({ "error": msg }).to_string(),
        ))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::types::AdapterRegistration;
    use axum::body::to_bytes;
    use axum::http::Request;
    use parking_lot::Mutex;
    use tower::ServiceExt;

    /// Recording emitter for tests — captures every webhook event so assertions
    /// can verify the payload that *would* have been sent to the renderer.
    #[derive(Default)]
    struct RecordingEmitter {
        events: Mutex<Vec<(String, serde_json::Value)>>,
    }

    impl EventEmitter for RecordingEmitter {
        fn emit_webhook(&self, adapter_id: &str, payload: &serde_json::Value) {
            self.events
                .lock()
                .push((adapter_id.to_string(), payload.clone()));
        }
    }

    fn test_router_with(state: ConnectorsState) -> (Router, Arc<RecordingEmitter>) {
        let emitter = Arc::new(RecordingEmitter::default());
        let router = build_router(state, emitter.clone(), None);
        (router, emitter)
    }

    fn register(state: &ConnectorsState, adapter_id: &str, adapter_type: &str) {
        state.inner.lock().registered_adapters.insert(
            adapter_id.into(),
            AdapterRegistration {
                adapter_id: adapter_id.into(),
                adapter_type: adapter_type.into(),
                webhook_path: None,
            },
        );
    }

    #[tokio::test]
    async fn health_returns_ok() {
        let state = ConnectorsState::new();
        let (app, _) = test_router_with(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = to_bytes(resp.into_body(), 1024).await.unwrap();
        assert_eq!(&body[..], b"{\"ok\":true}");
    }

    #[tokio::test]
    async fn unregistered_webhook_returns_404() {
        let state = ConnectorsState::new();
        let (app, emitter) = test_router_with(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/webhook/telegram/x")
                    .method("POST")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert!(emitter.events.lock().is_empty());
    }

    // -----------------------------------------------------------------------
    // verify_webhook — pure-function tests. These do NOT exercise the HTTP
    // path; they target the verification logic directly so they don't need a
    // running server. The adapter type is read from the registered adapter.
    // -----------------------------------------------------------------------

    fn keyring_available() -> bool {
        crate::connectors::keyring_available()
    }

    #[tokio::test]
    async fn verify_returns_404_when_adapter_unregistered() {
        let state = ConnectorsState::new();
        let err = verify_webhook(&state, "ghost", &HeaderMap::new(), b"{}")
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn verify_returns_400_for_unknown_adapter_type() {
        let state = ConnectorsState::new();
        register(&state, "weird-1", "yahoo");
        let err = verify_webhook(&state, "weird-1", &HeaderMap::new(), b"{}")
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn verify_telegram_happy_path() {
        if !keyring_available() {
            return;
        }
        let adapter_id = "tg-happy";
        super::super::keyring::set(adapter_id, "secretToken", "shh-correct").unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "telegram");

        let mut headers = HeaderMap::new();
        headers.insert(
            "X-Telegram-Bot-Api-Secret-Token",
            "shh-correct".parse().unwrap(),
        );
        let payload =
            verify_webhook(&state, adapter_id, &headers, br#"{"update_id":1}"#)
                .await
                .unwrap();
        assert_eq!(payload["update_id"], 1);

        super::super::keyring::delete(adapter_id, "secretToken").unwrap();
    }

    #[tokio::test]
    async fn verify_telegram_wrong_token_returns_401() {
        if !keyring_available() {
            return;
        }
        let adapter_id = "tg-bad";
        super::super::keyring::set(adapter_id, "secretToken", "expected").unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "telegram");

        let mut headers = HeaderMap::new();
        headers.insert(
            "X-Telegram-Bot-Api-Secret-Token",
            "wrong".parse().unwrap(),
        );
        let err = verify_webhook(&state, adapter_id, &headers, b"{}")
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);

        super::super::keyring::delete(adapter_id, "secretToken").unwrap();
    }

    #[tokio::test]
    async fn verify_telegram_missing_keyring_returns_401() {
        if !keyring_available() {
            return;
        }
        let adapter_id = "tg-no-secret";
        super::super::keyring::delete(adapter_id, "secretToken").ok();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "telegram");

        let err = verify_webhook(&state, adapter_id, &HeaderMap::new(), b"{}")
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn verify_slack_happy_path() {
        if !keyring_available() {
            return;
        }
        use hmac::{Hmac, KeyInit, Mac};
        use sha2::Sha256;
        type HmacSha256 = Hmac<Sha256>;

        let adapter_id = "slack-happy";
        let secret = "8f742231b10e8888abcd99yyyzzz85a5";
        super::super::keyring::set(adapter_id, "signingSecret", secret).unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "slack");

        let body = br#"{"type":"event_callback"}"#;
        let timestamp = chrono::Utc::now().timestamp().to_string();
        let base = format!("v0:{}:{}", timestamp, std::str::from_utf8(body).unwrap());
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(base.as_bytes());
        let sig = format!("v0={}", hex::encode(mac.finalize().into_bytes()));

        let mut headers = HeaderMap::new();
        headers.insert("X-Slack-Request-Timestamp", timestamp.parse().unwrap());
        headers.insert("X-Slack-Signature", sig.parse().unwrap());

        let payload = verify_webhook(&state, adapter_id, &headers, body).await.unwrap();
        assert_eq!(payload["type"], "event_callback");

        super::super::keyring::delete(adapter_id, "signingSecret").unwrap();
    }

    #[tokio::test]
    async fn verify_discord_happy_path() {
        if !keyring_available() {
            return;
        }
        use ed25519_dalek::{Signer, SigningKey};

        let adapter_id = "discord-happy";
        let signing = SigningKey::from_bytes(&[0x42u8; 32]);
        let public_hex = hex::encode(signing.verifying_key().as_bytes());
        super::super::keyring::set(adapter_id, "publicKey", &public_hex).unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "discord");

        // Use a current timestamp so the replay-freshness check passes.
        let timestamp = chrono::Utc::now().timestamp().to_string();
        let body = br#"{"type":1}"#;
        let mut message = timestamp.as_bytes().to_vec();
        message.extend_from_slice(body);
        let signature = signing.sign(&message);
        let sig_hex = hex::encode(signature.to_bytes());

        let mut headers = HeaderMap::new();
        headers.insert("X-Signature-Timestamp", timestamp.parse().unwrap());
        headers.insert("X-Signature-Ed25519", sig_hex.parse().unwrap());

        let payload = verify_webhook(&state, adapter_id, &headers, body).await.unwrap();
        assert_eq!(payload["type"], 1);

        super::super::keyring::delete(adapter_id, "publicKey").unwrap();
    }

    #[tokio::test]
    async fn verify_discord_stale_timestamp_returns_401() {
        if !keyring_available() {
            return;
        }
        use ed25519_dalek::{Signer, SigningKey};

        let adapter_id = "discord-stale";
        let signing = SigningKey::from_bytes(&[0x42u8; 32]);
        let public_hex = hex::encode(signing.verifying_key().as_bytes());
        super::super::keyring::set(adapter_id, "publicKey", &public_hex).unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "discord");

        // A correctly-signed request, but 10 minutes old → rejected as a replay.
        let timestamp = (chrono::Utc::now().timestamp() - 600).to_string();
        let body = br#"{"type":1}"#;
        let mut message = timestamp.as_bytes().to_vec();
        message.extend_from_slice(body);
        let signature = signing.sign(&message);
        let sig_hex = hex::encode(signature.to_bytes());

        let mut headers = HeaderMap::new();
        headers.insert("X-Signature-Timestamp", timestamp.parse().unwrap());
        headers.insert("X-Signature-Ed25519", sig_hex.parse().unwrap());

        let err = verify_webhook(&state, adapter_id, &headers, body)
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);

        super::super::keyring::delete(adapter_id, "publicKey").unwrap();
    }

    #[tokio::test]
    async fn verify_lark_plaintext_happy_path() {
        if !keyring_available() {
            return;
        }
        let adapter_id = "lark-plain";
        super::super::keyring::set(adapter_id, "verificationToken", "vtok-1").unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "lark");

        let body = br#"{"schema":"2.0","header":{"token":"vtok-1","event_type":"x"}}"#;
        let payload = verify_webhook(&state, adapter_id, &HeaderMap::new(), body)
            .await
            .unwrap();
        assert_eq!(payload["header"]["token"], "vtok-1");

        super::super::keyring::delete(adapter_id, "verificationToken").unwrap();
    }

    #[tokio::test]
    async fn verify_lark_token_mismatch_returns_401() {
        if !keyring_available() {
            return;
        }
        let adapter_id = "lark-bad";
        super::super::keyring::set(adapter_id, "verificationToken", "expected").unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "lark");

        let body = br#"{"schema":"2.0","header":{"token":"wrong"}}"#;
        let err = verify_webhook(&state, adapter_id, &HeaderMap::new(), body)
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);

        super::super::keyring::delete(adapter_id, "verificationToken").unwrap();
    }

    #[tokio::test]
    async fn verify_lark_encrypted_round_trip() {
        if !keyring_available() {
            return;
        }
        use aes::cipher::{block_padding::Pkcs7, BlockModeEncrypt, KeyIvInit};
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
        use rand::RngCore;
        use sha2::{Digest, Sha256};
        type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;

        let adapter_id = "lark-enc";
        super::super::keyring::set(adapter_id, "verificationToken", "vtok-2").unwrap();
        super::super::keyring::set(adapter_id, "encryptKey", "the-encrypt-key").unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "lark");

        let plaintext = br#"{"schema":"2.0","header":{"token":"vtok-2"}}"#;
        let key_bytes = Sha256::digest(b"the-encrypt-key");
        let key_arr: [u8; 32] = key_bytes.as_slice().try_into().unwrap();
        let mut iv = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut iv);
        let ciphertext = Aes256CbcEnc::new(&key_arr.into(), &iv.into())
            .encrypt_padded_vec::<Pkcs7>(plaintext);
        let mut combined = iv.to_vec();
        combined.extend_from_slice(&ciphertext);
        let encoded = BASE64.encode(combined);
        let outer = serde_json::json!({ "encrypt": encoded }).to_string();

        let payload = verify_webhook(&state, adapter_id, &HeaderMap::new(), outer.as_bytes())
            .await
            .unwrap();
        assert_eq!(payload["header"]["token"], "vtok-2");

        super::super::keyring::delete(adapter_id, "verificationToken").unwrap();
        super::super::keyring::delete(adapter_id, "encryptKey").unwrap();
    }

    fn lark_event_body(token: &str, event_id: &str, create_time_ms: i64) -> Vec<u8> {
        serde_json::json!({
            "schema": "2.0",
            "header": {
                "token": token,
                "event_id": event_id,
                "create_time": create_time_ms.to_string(),
                "event_type": "im.message.receive_v1",
            },
        })
        .to_string()
        .into_bytes()
    }

    #[tokio::test]
    async fn verify_lark_fresh_event_passes_then_replay_is_rejected() {
        if !keyring_available() {
            return;
        }
        let adapter_id = "lark-replay";
        super::super::keyring::set(adapter_id, "verificationToken", "vtok-r").unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "lark");

        let now_ms = chrono::Utc::now().timestamp_millis();
        let body = lark_event_body("vtok-r", "evt-replay-1", now_ms);

        // First delivery is accepted.
        verify_webhook(&state, adapter_id, &HeaderMap::new(), &body)
            .await
            .expect("fresh event should pass");

        // A byte-identical replay is rejected by the event_id dedup.
        let err = verify_webhook(&state, adapter_id, &HeaderMap::new(), &body)
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);

        super::super::keyring::delete(adapter_id, "verificationToken").unwrap();
    }

    #[tokio::test]
    async fn verify_lark_stale_event_is_rejected() {
        if !keyring_available() {
            return;
        }
        let adapter_id = "lark-stale";
        super::super::keyring::set(adapter_id, "verificationToken", "vtok-s").unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "lark");

        // create_time 10 minutes in the past → outside the 5-minute window.
        let old_ms = chrono::Utc::now().timestamp_millis() - 10 * 60 * 1000;
        let body = lark_event_body("vtok-s", "evt-stale-1", old_ms);

        let err = verify_webhook(&state, adapter_id, &HeaderMap::new(), &body)
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);

        super::super::keyring::delete(adapter_id, "verificationToken").unwrap();
    }

    #[tokio::test]
    async fn verify_lark_url_verification_challenge_skips_replay() {
        if !keyring_available() {
            return;
        }
        let adapter_id = "lark-challenge";
        super::super::keyring::set(adapter_id, "verificationToken", "vtok-c").unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "lark");

        // The url_verification handshake has no header/create_time/event_id and
        // must still pass (and be re-sendable — it carries no replay state).
        let body = br#"{"challenge":"abc123","token":"vtok-c","type":"url_verification"}"#;
        verify_webhook(&state, adapter_id, &HeaderMap::new(), body)
            .await
            .expect("challenge should pass");
        verify_webhook(&state, adapter_id, &HeaderMap::new(), body)
            .await
            .expect("challenge should remain re-sendable");

        super::super::keyring::delete(adapter_id, "verificationToken").unwrap();
    }
}
