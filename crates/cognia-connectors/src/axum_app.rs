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
    extract::{DefaultBodyLimit, Path, RawQuery, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Extension, Json, Router,
};
use bytes::Bytes;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use subtle::ConstantTimeEq;

use super::sigverify::declarative::{DeclarativeRequest, WebhookVerificationSpec};
use super::state::ConnectorsState;
use super::ws_server;

/// Sink for connector events. The live impl wraps a `tauri::AppHandle`;
/// headless installs publish through the companion event bus.
pub trait EventEmitter: Send + Sync + 'static {
    fn emit(&self, topic: &str, payload: serde_json::Value);

    /// Deliver a sensitive, single-use event to the trusted headless brain.
    /// Desktop emitters remain process-local; the companion emitter overrides
    /// this to target the service principal and omit replay buffering.
    fn emit_ephemeral_to_brain(&self, topic: &str, payload: serde_json::Value) {
        self.emit(topic, payload);
    }

    fn emit_webhook(&self, adapter_id: &str, payload: &serde_json::Value) {
        self.emit(
            &format!("connectors://webhook/{adapter_id}"),
            payload.clone(),
        );
    }
}

/// Production emitter — forwards to the renderer via Tauri events.
pub struct AppHandleEmitter(pub tauri::AppHandle);

impl EventEmitter for AppHandleEmitter {
    fn emit(&self, topic: &str, payload: serde_json::Value) {
        use tauri::Emitter;
        let _ = self.0.emit(topic, payload);
    }
}

/// Cheap wrapper so `Arc<dyn EventEmitter>` can ride an axum `Extension`
/// (which requires `Clone`).
#[derive(Clone)]
pub struct EmitterExt(pub Arc<dyn EventEmitter>);

/// Hard cap on inbound request bodies. axum's implicit default is already
/// 2 MiB, but we pin it explicitly so an axum upgrade cannot silently change
/// the limit. Platform webhook payloads are far below this.
const MAX_REQUEST_BODY_BYTES: usize = 2 * 1024 * 1024;

/// Build the connectors axum `Router<ConnectorsState>` (state not yet
/// resolved). Used by tests in `ws_server.rs` that compose extra routes.
pub fn build_unresolved_router() -> Router<ConnectorsState> {
    let base = Router::new()
        .route("/health", get(health_handler))
        .route("/oauth/lark/callback", get(oauth_lark_callback))
        .route(
            "/oauth/connector/{kind}/callback",
            get(oauth_connector_callback),
        )
        .route("/oauth/docs/{provider}/callback", get(oauth_docs_callback))
        .route("/internal/lark/app-avatar", post(lark_app_avatar_stage))
        .route("/lark/app-avatar/{token}", get(lark_app_avatar_serve))
        .route("/webhook/{adapter_type}/{adapter_id}", any(webhook_handler));
    ws_server::register_routes(base).layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
}

/// Compose the resolved router with state + emitter.
pub fn build_router(state: ConnectorsState, emitter: Arc<dyn EventEmitter>) -> Router {
    build_unresolved_router()
        .with_state(state)
        .layer(Extension(EmitterExt(emitter)))
}

async fn health_handler() -> &'static str {
    r#"{"ok":true}"#
}

// ---------------------------------------------------------------------------
// Lark app-avatar staging
//
// `appPreset.avatar` on the registration confirm page must be a publicly
// reachable image URL. A Cognia avatar (a `data:` URL or a bundled static
// asset) is not one, so the caller parks the bytes here and hands Feishu the
// `/lark/app-avatar/{token}` URL, which resolves through the same
// tunnel/`/connectors` ingress that already serves webhooks.
//
// The stage POST is bearer-authenticated by the per-process `staging_token`
// disclosed only via `connectors_health` — the token is the authorization,
// not the network position, so the route is safe to mount on both the
// loopback desktop server and the public headless `/connectors` nest.
// ---------------------------------------------------------------------------

/// Content types Feishu accepts for an app avatar.
const STAGED_AVATAR_CONTENT_TYPES: [&str; 4] = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LarkAppAvatarStageBody {
    /// Base64-encoded image bytes.
    bytes_b64: String,
    content_type: String,
    /// Lifetime in seconds; clamped to the state.rs bounds.
    ttl_secs: Option<u64>,
}

async fn lark_app_avatar_stage(
    State(state): State<ConnectorsState>,
    headers: HeaderMap,
    Json(body): Json<LarkAppAvatarStageBody>,
) -> Response {
    let expected = state.inner.lock().staging_token.clone();
    let provided = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    // Constant-time compare — the bearer is unguessable anyway, but a timing
    // oracle on a publicly mounted route is cheap to rule out.
    let authorized: bool = provided.as_bytes().ct_eq(expected.as_bytes()).into();
    if !authorized {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if !STAGED_AVATAR_CONTENT_TYPES.contains(&body.content_type.as_str()) {
        return (
            StatusCode::BAD_REQUEST,
            format!(
                "contentType must be one of {}",
                STAGED_AVATAR_CONTENT_TYPES.join(", ")
            ),
        )
            .into_response();
    }
    use base64::Engine;
    let bytes = match base64::engine::general_purpose::STANDARD.decode(body.bytes_b64.as_bytes())
    {
        Ok(bytes) => bytes,
        Err(_) => return (StatusCode::BAD_REQUEST, "bytesB64 is not valid base64").into_response(),
    };
    match state.stage_lark_app_avatar(
        bytes,
        body.content_type,
        body.ttl_secs
            .unwrap_or(super::state::STAGED_AVATAR_DEFAULT_TTL_SECS),
    ) {
        Ok((token, expires_at_ms)) => Json(serde_json::json!({
            "token": token,
            "expiresAtMs": expires_at_ms,
        }))
        .into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, err).into_response(),
    }
}

async fn lark_app_avatar_serve(
    State(state): State<ConnectorsState>,
    Path(token): Path<String>,
) -> Response {
    match state.staged_lark_app_avatar(&token) {
        Some((bytes, content_type)) => (
            [
                (header::CONTENT_TYPE, content_type),
                (header::CACHE_CONTROL, "public, max-age=600".to_string()),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
            ],
            bytes,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Lark send-as-user OAuth relay.
///
/// Feishu's console only accepts http/https redirect URLs, so the desktop OAuth
/// flow registers `${tunnel}/oauth/lark/callback` (this route, reachable via the
/// same Cloudflared tunnel as the webhook route). We bounce the `code` + `state`
/// onto the connector event bus for a headless brain and also bounce the fields
/// into the desktop app's `cognia://connector/oauth/lark` custom scheme. Both
/// consumers validate state and PKCE before exchanging the code.
///
/// Returns a 200 HTML page that launches the scheme (meta-refresh + JS) with a
/// manual link fallback, which is more reliable across browsers than a 302 to a
/// non-http scheme.
async fn oauth_lark_callback(
    RawQuery(raw_query): RawQuery,
    Extension(EmitterExt(emitter)): Extension<EmitterExt>,
) -> Response {
    let params = parse_query(raw_query.as_deref().unwrap_or(""));
    let payload = ["code", "state", "error", "error_description"]
        .into_iter()
        .filter_map(|key| {
            params
                .get(key)
                .map(|value| (key.to_string(), serde_json::Value::String(value.clone())))
        })
        .collect();
    emitter.emit_ephemeral_to_brain(
        "connectors://lark-oauth/callback",
        serde_json::Value::Object(payload),
    );
    let deep_link = build_lark_oauth_deep_link(&params);
    oauth_callback_page(&deep_link)
}

/// Generic platform-connector OAuth relay.
///
/// The Lark route above is the same idea nailed to one platform. Every IM
/// platform that speaks OAuth has the same constraint — Slack, like Feishu,
/// only accepts http/https redirect URLs and will not register a custom scheme
/// — so the relay belongs to the subsystem, not to one adapter. A connector's
/// authorize step registers `{ingressBase}/oauth/connector/{kind}/callback` and
/// this route fans the result out to both hosts:
///
///   - headless: `connectors://connector-oauth/callback`, carrying `kind` so
///     the brain can pick the handler out of `oauthRegistry` without a route
///     per platform;
///   - desktop: a bounce page into `cognia://connector/oauth/{kind}`, which is
///     the scheme `ConnectorDeepLinkRouter` already claims.
///
/// `/oauth/lark/callback` stays as it is: that exact path is registered
/// byte-for-byte in every existing install's Feishu console, and moving it
/// would break them for no gain.
///
/// `kind` is validated against the same strict slug charset as the docs
/// provider before it reaches the rendered page — it arrives from the URL path
/// and the bounce page embeds the deep link in an HTML attribute and a JS
/// string literal.
async fn oauth_connector_callback(
    Path(kind): Path<String>,
    RawQuery(raw_query): RawQuery,
    Extension(EmitterExt(emitter)): Extension<EmitterExt>,
) -> Response {
    if !is_docs_provider_slug(&kind) {
        return error_response(StatusCode::NOT_FOUND, "unknown connector kind");
    }
    let params = parse_query(raw_query.as_deref().unwrap_or(""));
    let mut payload: serde_json::Map<String, serde_json::Value> = OAUTH_FIELDS
        .iter()
        .filter_map(|&key| {
            params
                .get(key)
                .map(|value| (key.to_string(), serde_json::Value::String(value.clone())))
        })
        .collect();
    payload.insert("kind".to_string(), serde_json::Value::String(kind.clone()));
    emitter.emit_ephemeral_to_brain(
        "connectors://connector-oauth/callback",
        serde_json::Value::Object(payload),
    );
    let base = format!("cognia://connector/oauth/{kind}");
    oauth_callback_page(&build_oauth_deep_link(&base, &params))
}

/// Remote document provider OAuth relay (ADR-0134).
///
/// Google's installed-app clients accept only a loopback `http://127.0.0.1:<port>`
/// redirect — no custom scheme, no OOB — so the provider registers
/// `http://127.0.0.1:7842/oauth/docs/google/callback` and this route bounces the
/// authorization code into the desktop app the same way the Lark relay does.
/// That is also the reason the document providers are desktop-only: without this
/// listener there is nowhere for Google to redirect to.
///
/// `provider` is validated against a strict slug charset before it reaches the
/// rendered page — it arrives from the URL path, and the bounce page embeds the
/// deep link in both an HTML attribute and a JS string literal.
async fn oauth_docs_callback(
    Path(provider): Path<String>,
    RawQuery(raw_query): RawQuery,
    Extension(EmitterExt(emitter)): Extension<EmitterExt>,
) -> Response {
    if !is_docs_provider_slug(&provider) {
        return error_response(StatusCode::NOT_FOUND, "unknown docs provider");
    }
    let params = parse_query(raw_query.as_deref().unwrap_or(""));
    let mut payload: serde_json::Map<String, serde_json::Value> = OAUTH_FIELDS
        .iter()
        .filter_map(|&key| {
            params
                .get(key)
                .map(|value| (key.to_string(), serde_json::Value::String(value.clone())))
        })
        .collect();
    payload.insert(
        "provider".to_string(),
        serde_json::Value::String(provider.clone()),
    );
    emitter.emit_ephemeral_to_brain(
        "connectors://docs-oauth/callback",
        serde_json::Value::Object(payload),
    );
    let base = format!("cognia://docs-provider/oauth/{provider}");
    oauth_callback_page(&build_oauth_deep_link(&base, &params))
}

/// OAuth query fields we forward. Anything else the provider appends is dropped.
const OAUTH_FIELDS: [&str; 4] = ["code", "state", "error", "error_description"];

/// Lowercase alphanumerics and dashes, 1..=32 chars. Mirrors the `DocsProvider.id`
/// contract on the TypeScript side.
fn is_docs_provider_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Build the `cognia://connector/oauth/lark?…` deep link, forwarding only the
/// OAuth fields we recognise (success `code`+`state`, or `error` details).
fn build_lark_oauth_deep_link(params: &HashMap<String, String>) -> String {
    build_oauth_deep_link("cognia://connector/oauth/lark", params)
}

/// Append the recognised OAuth fields to `base` as a query string, or return
/// `base` unchanged when none are present.
fn build_oauth_deep_link(base: &str, params: &HashMap<String, String>) -> String {
    let pairs: Vec<(&str, &str)> = OAUTH_FIELDS
        .iter()
        .filter_map(|&k| params.get(k).map(|v| (k, v.as_str())))
        .collect();
    if pairs.is_empty() {
        return base.to_string();
    }
    let query = serde_urlencoded::to_string(&pairs).unwrap_or_default();
    format!("{base}?{query}")
}

/// Render the bounce page. The forwarded fields are percent-encoded (no quotes
/// or angle brackets), so the only HTML-sensitive char is `&`, escaped for the
/// attribute contexts; the JS string embeds the raw link safely.
fn oauth_callback_page(deep_link: &str) -> Response {
    let attr = deep_link.replace('&', "&amp;");
    let html = format!(
        "<!doctype html>\n<html><head><meta charset=\"utf-8\">\
<meta http-equiv=\"refresh\" content=\"0;url={attr}\">\
<title>Cognia</title></head>\
<body style=\"font-family:system-ui,sans-serif;padding:2rem;text-align:center\">\
<p>Returning to Cognia…</p>\
<p><a href=\"{attr}\">Open Cognia</a> if you are not redirected automatically.</p>\
<script>location.replace(\"{js}\")</script>\
</body></html>",
        attr = attr,
        js = deep_link
    );
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/html; charset=utf-8")
        .body(Body::from(html))
        .unwrap()
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

    // Discord Interactions Endpoint — like WeChat, Discord requires the
    // InteractionResponse (PONG / deferred ACK) IN THE HTTP BODY, which the
    // fire-and-forget emit-and-200 flow below cannot express.
    if adapter_type == "discord" {
        return discord_webhook_handler(&adapter_id, &headers, &body, emitter.as_ref()).await;
    }

    // Slack — like Discord, Slack needs in-band responses the generic flow
    // cannot express: the `url_verification` challenge must be echoed in the
    // HTTP body, and interactivity arrives form-encoded rather than as JSON.
    if adapter_type == "slack" {
        return slack_webhook_handler(&adapter_id, &headers, &body, emitter.as_ref()).await;
    }

    // QQ Official Bot — in-band responses again: the op-13 URL-validation
    // challenge must be answered with a seeded-Ed25519 signature, and ordinary
    // pushes are ACK'd with `{"op":12}` (HTTP Callback ACK).
    if adapter_type == "qq-official" {
        return qq_official_webhook_handler(&adapter_id, &headers, &body, emitter.as_ref()).await;
    }

    match verify_webhook(&state, &adapter_id, &headers, &body).await {
        Ok(payload) => {
            // Lark's URL-verification handshake requires the challenge echoed
            // in the response body — without it the console URL save fails.
            // A handshake carries no event, so it is not emitted.
            if let Some(resp) = url_verification_challenge_response(&payload) {
                return resp;
            }
            emitter.emit_webhook(&adapter_id, &payload);
            ok_response()
        }
        Err((status, msg)) => error_response(status, msg),
    }
}

/// If `payload` is a `url_verification` handshake with a `challenge` string,
/// build the `{"challenge": ...}` echo response the platform expects (Slack
/// and Lark share this exact shape). Returns `None` for ordinary events.
fn url_verification_challenge_response(payload: &serde_json::Value) -> Option<Response> {
    if payload.get("type").and_then(|v| v.as_str()) != Some("url_verification") {
        return None;
    }
    let challenge = payload.get("challenge").and_then(|v| v.as_str())?;
    Some(json_response(
        StatusCode::OK,
        &serde_json::json!({ "challenge": challenge }),
    ))
}

/// Body shapes Slack delivers to a single webhook URL.
enum SlackBody {
    /// Events API — raw JSON body (includes the `url_verification` handshake).
    Json(serde_json::Value),
    /// Interactivity — `application/x-www-form-urlencoded` with a `payload`
    /// field whose value is the URL-decoded JSON interaction.
    Interactivity(serde_json::Value),
    /// Slash-command form post (form-encoded, no `payload` field).
    SlashCommand(serde_json::Value),
    /// Slack periodically probes public slash-command endpoints.
    SslCheck,
    /// Neither JSON nor a recognisable form body.
    Invalid,
}

/// Classify a Slack webhook body AFTER signature verification. Signature
/// verification always runs over the raw body bytes; this only decides how to
/// decode + route the verified payload.
fn classify_slack_body(body: &[u8]) -> SlackBody {
    if let Ok(json) = serde_json::from_slice::<serde_json::Value>(body) {
        return SlackBody::Json(json);
    }
    let Ok(pairs) = serde_urlencoded::from_bytes::<Vec<(String, String)>>(body) else {
        return SlackBody::Invalid;
    };
    match pairs.iter().find(|(k, _)| k == "payload") {
        Some((_, payload)) => match serde_json::from_str::<serde_json::Value>(payload) {
            Ok(inner) => SlackBody::Interactivity(inner),
            Err(_) => SlackBody::Invalid,
        },
        None => {
            let mut fields: serde_json::Map<String, serde_json::Value> = pairs
                .into_iter()
                .map(|(key, value)| (key, serde_json::Value::String(value)))
                .collect();
            if fields.get("ssl_check").and_then(|v| v.as_str()) == Some("1") {
                return SlackBody::SslCheck;
            }
            if !["command", "channel_id", "user_id"].iter().all(|key| {
                fields
                    .get(*key)
                    .and_then(|v| v.as_str())
                    .is_some_and(|value| !value.is_empty())
            }) {
                return SlackBody::Invalid;
            }
            fields.insert("type".into(), serde_json::json!("slash_command"));
            SlackBody::SlashCommand(serde_json::Value::Object(fields))
        }
    }
}

/// Slack webhook handler — verifies the v0 signature over the RAW body bytes,
/// then answers the `url_verification` challenge in-band, decodes form-encoded
/// interactivity posts, and ACKs slash-command posts.
async fn slack_webhook_handler(
    adapter_id: &str,
    headers: &HeaderMap,
    body: &[u8],
    emitter: &dyn EventEmitter,
) -> Response {
    if let Err((status, msg)) = verify_slack_signature(adapter_id, headers, body).await {
        return error_response(status, msg);
    }

    match classify_slack_body(body) {
        SlackBody::Json(payload) => {
            // Events API URL save: echo the challenge, do not emit (handshake
            // only — there is nothing for the renderer to run).
            if let Some(resp) = url_verification_challenge_response(&payload) {
                return resp;
            }
            emitter.emit_webhook(adapter_id, &payload);
            ok_response()
        }
        SlackBody::Interactivity(inner) => {
            // Forward the decoded inner interaction JSON on the same
            // `connectors://webhook/<adapterId>` channel the Events API uses;
            // the TS router detects block_actions / view_submission /
            // shortcut / message_action shapes there. An empty 200 tells
            // Slack "acknowledged, no message replacement".
            emitter.emit_webhook(adapter_id, &inner);
            empty_ok_response()
        }
        SlackBody::SlashCommand(payload) => {
            emitter.emit_webhook(adapter_id, &payload);
            empty_ok_response()
        }
        SlackBody::SslCheck => empty_ok_response(),
        SlackBody::Invalid => error_response(StatusCode::BAD_REQUEST, "invalid body"),
    }
}

/// QQ Official Bot webhook handler.
///
/// QQ signs every callback with an Ed25519 key derived from the bot secret
/// (keyring `clientSecret` — the same entry the TS adapter's token minting
/// uses): headers `X-Signature-Ed25519` (hex) + `X-Signature-Timestamp`,
/// message = `timestamp ++ raw body`. See `sigverify::qq` for the seed
/// derivation.
///
/// After verification, the envelope's `op` decides the in-band response:
///   - op 13 (callback URL validation) → `{"plain_token", "signature"}` where
///     signature = hex(sign(event_ts ++ plain_token)) with the same seeded
///     key. Not emitted — the console handshake carries no event.
///   - op 0 (DISPATCH) → emit the raw envelope on
///     `connectors://webhook/<adapterId>` and ACK with `{"op":12}` (the
///     documented HTTP Callback ACK opcode).
///   - anything else → ACK `{"op":12}` without emitting (nothing else is
///     defined for the webhook channel; forwarding would dead-letter).
async fn qq_official_webhook_handler(
    adapter_id: &str,
    headers: &HeaderMap,
    body: &[u8],
    emitter: &dyn EventEmitter,
) -> Response {
    let secret = match super::keyring::get(adapter_id, "clientSecret") {
        Ok(Some(s)) => s,
        Ok(None) => {
            return error_response(StatusCode::UNAUTHORIZED, "client secret not configured")
        }
        Err(_) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "keyring read failed"),
    };

    let timestamp = match headers
        .get("X-Signature-Timestamp")
        .and_then(|v| v.to_str().ok())
    {
        Some(t) => t,
        None => return error_response(StatusCode::UNAUTHORIZED, "missing timestamp header"),
    };
    let signature = match headers
        .get("X-Signature-Ed25519")
        .and_then(|v| v.to_str().ok())
    {
        Some(s) => s,
        None => return error_response(StatusCode::UNAUTHORIZED, "missing signature header"),
    };

    if super::sigverify::qq::verify_ed25519(&secret, timestamp, body, signature).is_err() {
        return error_response(StatusCode::UNAUTHORIZED, "signature verification failed");
    }

    let payload: serde_json::Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "invalid JSON body"),
    };

    match payload.get("op").and_then(|v| v.as_u64()) {
        // Callback URL validation — answer in-band, never emitted.
        Some(13) => {
            let d = payload.get("d");
            let plain_token = d
                .and_then(|d| d.get("plain_token"))
                .and_then(|v| v.as_str());
            let event_ts = d.and_then(|d| d.get("event_ts")).and_then(|v| v.as_str());
            let (Some(plain_token), Some(event_ts)) = (plain_token, event_ts) else {
                return error_response(StatusCode::BAD_REQUEST, "missing validation fields");
            };
            match super::sigverify::qq::sign_challenge(&secret, event_ts, plain_token) {
                Ok(signature) => json_response(
                    StatusCode::OK,
                    &serde_json::json!({ "plain_token": plain_token, "signature": signature }),
                ),
                // Unreachable with a non-empty secret; guard anyway.
                Err(_) => error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "challenge signing failed",
                ),
            }
        }
        // DISPATCH — forward the raw envelope to the renderer.
        Some(0) => {
            emitter.emit_webhook(adapter_id, &payload);
            json_response(StatusCode::OK, &serde_json::json!({ "op": 12 }))
        }
        // Unknown / undocumented op over webhook — ACK, do not forward.
        _ => json_response(StatusCode::OK, &serde_json::json!({ "op": 12 })),
    }
}

/// Select an initial response compatible with the actual interaction type.
/// Immediate ephemeral acknowledgments for commands and standalone modals
/// leave no deferred loading state; their work continues through the event bus.
fn discord_ack_for_interaction(payload: &serde_json::Value) -> Option<(serde_json::Value, bool)> {
    match payload.get("type").and_then(|v| v.as_u64())? {
        1 => Some((serde_json::json!({ "type": 1 }), false)),
        3 => Some((serde_json::json!({ "type": 6 }), true)),
        5 if payload
            .get("message")
            .is_some_and(|value| value.is_object()) =>
        {
            Some((serde_json::json!({ "type": 6 }), true))
        }
        2 | 5 => {
            let content = match payload.get("locale").and_then(|v| v.as_str()) {
                Some("zh-CN") => "已收到。",
                Some("zh-TW") => "已收到。",
                _ => "Received.",
            };
            Some((
                serde_json::json!({ "type": 4, "data": { "content": content, "flags": 64 } }),
                true,
            ))
        }
        4 => Some((
            serde_json::json!({ "type": 8, "data": { "choices": [] } }),
            false,
        )),
        _ => None,
    }
}

/// Discord Interactions Endpoint handler — verifies the Ed25519 signature, then
/// answers PING with PONG (no emit) or interactions with a deferred ACK while
/// emitting the interaction to the renderer for the actual reply.
async fn discord_webhook_handler(
    adapter_id: &str,
    headers: &HeaderMap,
    body: &[u8],
    emitter: &dyn EventEmitter,
) -> Response {
    let payload = match verify_discord(adapter_id, headers, body).await {
        Ok(p) => p,
        Err((status, msg)) => return error_response(status, msg),
    };

    let Some((response, should_emit)) = discord_ack_for_interaction(&payload) else {
        return error_response(StatusCode::BAD_REQUEST, "unsupported interaction type");
    };
    if should_emit {
        emitter.emit_webhook(adapter_id, &payload);
    }
    json_response(StatusCode::OK, &response)
}

/// 200 OK with a JSON body (`application/json`).
fn json_response(status: StatusCode, value: &serde_json::Value) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(value.to_string()))
        .unwrap()
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
        let msg_signature = params
            .get("msg_signature")
            .map(String::as_str)
            .unwrap_or("");
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
            Ok((msg_xml, appid)) => {
                // Cross-check the decrypted appid against the adapter's stored
                // `appId` when one is configured. This is a secondary check on
                // top of the msg_signature + AES decrypt (both already keyed to
                // this adapter), so a missing entry — or a transient keyring
                // read failure — skips the check rather than dropping messages.
                match super::keyring::get(adapter_id, "appId") {
                    Ok(Some(expected)) if expected != appid => {
                        return error_response(StatusCode::UNAUTHORIZED, "appid mismatch");
                    }
                    Ok(Some(_)) => {}
                    Ok(None) => {
                        log::debug!("wechat-oa {adapter_id}: no appId in keyring, skipping check");
                    }
                    Err(e) => {
                        log::debug!("wechat-oa {adapter_id}: appId keyring read failed ({e})");
                    }
                }
                emitter.emit_webhook(adapter_id, &serde_json::json!({ "xml": msg_xml }));
                text_response("success".to_string())
            }
            Err(_) => error_response(StatusCode::UNAUTHORIZED, "decryption failed"),
        }
    } else {
        // Plaintext mode — verify the plain signature, emit the raw XML.
        let signature = params.get("signature").map(String::as_str).unwrap_or("");
        if super::sigverify::wechat::verify_signature(&token, timestamp, nonce, signature).is_err()
        {
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
    let (adapter_type, declared) = {
        let inner = state.inner.lock();
        match inner.registered_adapters.get(adapter_id) {
            Some(reg) => (reg.adapter_type.clone(), reg.verification.clone()),
            None => return Err((StatusCode::NOT_FOUND, "adapter not registered")),
        }
    };

    match adapter_type.as_str() {
        "telegram" => verify_telegram(adapter_id, headers, body).await,
        "slack" => verify_slack(adapter_id, headers, body).await,
        "discord" => verify_discord(adapter_id, headers, body).await,
        "lark" => verify_lark(adapter_id, headers, body).await,
        // Any other kind is a plugin connector. It has no hand-written arm
        // here, so it verifies through the scheme its manifest declared. With
        // no declaration this still refuses, which is the safe direction: an
        // endpoint that answers nothing is a broken connector, while one that
        // emits an unverified body is an open relay into the event bus.
        _ => verify_declared(adapter_id, declared.as_ref(), headers, body).await,
    }
}

/// Verify one inbound request against a plugin connector's declared scheme.
///
/// The secret is read from THIS adapter's keyring entry, named by the spec.
/// A manifest never carries the key itself: it is world-readable inside the
/// install directory, so a spec that could hold one would be a spec that
/// leaks one.
async fn verify_declared(
    adapter_id: &str,
    spec: Option<&WebhookVerificationSpec>,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<serde_json::Value, (StatusCode, &'static str)> {
    let spec = spec.ok_or((
        StatusCode::BAD_REQUEST,
        "adapter type declares no webhook verification",
    ))?;

    let secret = super::keyring::get(adapter_id, spec.secret_key())
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "keyring read failed"))?
        .ok_or((
            StatusCode::UNAUTHORIZED,
            "verification secret not configured",
        ))?;

    let lookup = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let request = DeclarativeRequest {
        body,
        header: &lookup,
        secret: &secret,
        now_unix_secs: chrono::Utc::now().timestamp(),
    };

    spec.verify(&request)
        .map_err(|_| (StatusCode::UNAUTHORIZED, "signature verification failed"))?;

    serde_json::from_slice(body).map_err(|_| (StatusCode::BAD_REQUEST, "invalid JSON body"))
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

/// Verify Slack's v0 HMAC signature over the RAW request body bytes. Shared
/// by the Events API path (JSON bodies) and the interactivity path
/// (form-encoded bodies) — Slack signs the raw bytes in both cases.
async fn verify_slack_signature(
    adapter_id: &str,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<(), (StatusCode, &'static str)> {
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
        .map_err(|_| (StatusCode::UNAUTHORIZED, "signature verification failed"))
}

async fn verify_slack(
    adapter_id: &str,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<serde_json::Value, (StatusCode, &'static str)> {
    verify_slack_signature(adapter_id, headers, body).await?;
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
    headers: &HeaderMap,
    body: &[u8],
) -> Result<serde_json::Value, (StatusCode, &'static str)> {
    let expected_token = super::keyring::get(adapter_id, "verificationToken")
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "keyring read failed"))?
        .ok_or((
            StatusCode::UNAUTHORIZED,
            "verification token not configured",
        ))?;

    let outer: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| (StatusCode::BAD_REQUEST, "invalid JSON body"))?;

    let encrypt_key = super::keyring::get(adapter_id, "encryptKey")
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "keyring read failed"))?
        .filter(|key| !key.is_empty());

    // Signatures cover the raw outer body; decryption only reveals the token
    // and whether this is the URL verification exception.
    let payload = if let Some(enc) = outer.get("encrypt").and_then(|v| v.as_str()) {
        let encrypt_key = encrypt_key
            .as_deref()
            .ok_or((StatusCode::UNAUTHORIZED, "encrypt key not configured"))?;
        let plaintext = super::sigverify::lark::decrypt_body(enc, encrypt_key)
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

    let is_challenge = payload.get("type").and_then(|v| v.as_str()) == Some("url_verification")
        && payload.get("challenge").and_then(|v| v.as_str()).is_some();
    if !is_challenge {
        if let Some(key) = encrypt_key.as_deref() {
            let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
            super::sigverify::lark::verify_signature(
                header("x-lark-request-timestamp"),
                header("x-lark-request-nonce"),
                header("x-lark-signature"),
                key,
                body,
                chrono::Utc::now().timestamp(),
            )
            .map_err(|_| (StatusCode::UNAUTHORIZED, "signature verification failed"))?;
        }
    }

    lark_replay_check(adapter_id, &payload, encrypt_key.is_some())?;

    Ok(payload)
}

/// Deduplicate authenticated events. For signed requests, freshness has already
/// been checked against the signed HTTP timestamp, permitting delivery retries
/// whose event creation time is old. Token-only legacy events retain their
/// existing creation-time window. Exact URL verification payloads are exempt.
fn lark_replay_check(
    adapter_id: &str,
    payload: &serde_json::Value,
    signed_request: bool,
) -> Result<(), (StatusCode, &'static str)> {
    // URL-verification handshake — no replay state, let it through.
    let is_url_verification = payload.get("type").and_then(|v| v.as_str())
        == Some("url_verification")
        && payload.get("challenge").and_then(|v| v.as_str()).is_some();
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

    if let Some(create_time) = create_time.filter(|_| !signed_request) {
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

/// 200 OK with an intentionally empty body — Slack interactivity and
/// slash-command ACKs treat any response body as message content to render,
/// so the ACK must stay empty.
fn empty_ok_response() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .body(Body::empty())
        .unwrap()
}

fn error_response(status: StatusCode, msg: &str) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::json!({ "error": msg }).to_string()))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AdapterRegistration;
    use axum::body::to_bytes;
    use axum::http::Request;
    use parking_lot::Mutex;
    use std::time::{Duration, Instant};
    use tower::ServiceExt;

    /// Recording emitter for tests — captures every webhook event so assertions
    /// can verify the payload that *would* have been sent to the renderer.
    #[derive(Default)]
    struct RecordingEmitter {
        events: Mutex<Vec<(String, serde_json::Value)>>,
    }

    impl EventEmitter for RecordingEmitter {
        fn emit(&self, topic: &str, payload: serde_json::Value) {
            self.events.lock().push((topic.to_string(), payload));
        }
    }

    #[test]
    fn webhook_events_use_the_canonical_topic() {
        let emitter = RecordingEmitter::default();
        emitter.emit_webhook("adapter-a", &serde_json::json!({ "ok": true }));

        assert_eq!(
            emitter.events.lock().as_slice(),
            &[(
                "connectors://webhook/adapter-a".to_string(),
                serde_json::json!({ "ok": true }),
            )]
        );
    }

    fn test_router_with(state: ConnectorsState) -> (Router, Arc<RecordingEmitter>) {
        let emitter = Arc::new(RecordingEmitter::default());
        let router = build_router(state, emitter.clone());
        (router, emitter)
    }

    fn register(state: &ConnectorsState, adapter_id: &str, adapter_type: &str) {
        register_with(state, adapter_id, adapter_type, None)
    }

    fn register_with(
        state: &ConnectorsState,
        adapter_id: &str,
        adapter_type: &str,
        verification: Option<WebhookVerificationSpec>,
    ) {
        state.inner.lock().registered_adapters.insert(
            adapter_id.into(),
            AdapterRegistration {
                adapter_id: adapter_id.into(),
                adapter_type: adapter_type.into(),
                webhook_path: None,
                verification,
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
    async fn oauth_lark_callback_publishes_code_and_state_and_keeps_desktop_bounce() {
        let state = ConnectorsState::new();
        let (app, emitter) = test_router_with(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/oauth/lark/callback?code=abc123&state=lark:lk1:nonce")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = to_bytes(resp.into_body(), 65536).await.unwrap();
        let text = std::str::from_utf8(&body).unwrap();
        // The bounce targets the app scheme and forwards code + state.
        assert!(text.contains("cognia://connector/oauth/lark?"));
        assert!(text.contains("code=abc123"));
        assert!(text.contains("state=lark")); // `:` is percent-encoded downstream
        assert_eq!(
            emitter.events.lock().as_slice(),
            &[(
                "connectors://lark-oauth/callback".to_string(),
                serde_json::json!({ "code": "abc123", "state": "lark:lk1:nonce" }),
            )]
        );
    }

    #[tokio::test]
    async fn oauth_lark_callback_passes_through_errors() {
        let state = ConnectorsState::new();
        let (app, _) = test_router_with(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/oauth/lark/callback?error=access_denied&error_description=nope")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = to_bytes(resp.into_body(), 65536).await.unwrap();
        let text = std::str::from_utf8(&body).unwrap();
        assert!(text.contains("error=access_denied"));
    }

    #[tokio::test]
    async fn oauth_connector_callback_names_the_kind_for_the_brain_and_bounces_to_the_scheme() {
        let state = ConnectorsState::new();
        let (app, emitter) = test_router_with(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/oauth/connector/slack/callback?code=abc123&state=slack:sl1:nonce")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = to_bytes(resp.into_body(), 65536).await.unwrap();
        let text = std::str::from_utf8(&body).unwrap();
        // Same scheme the desktop deep-link router already claims.
        assert!(text.contains("cognia://connector/oauth/slack?"));
        assert!(text.contains("code=abc123"));
        // `kind` is what lets the brain pick a handler without a route per platform.
        assert_eq!(
            emitter.events.lock().as_slice(),
            &[(
                "connectors://connector-oauth/callback".to_string(),
                serde_json::json!({
                    "code": "abc123",
                    "state": "slack:sl1:nonce",
                    "kind": "slack",
                }),
            )]
        );
    }

    #[tokio::test]
    async fn oauth_connector_callback_forwards_platform_errors() {
        let state = ConnectorsState::new();
        let (app, _) = test_router_with(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/oauth/connector/slack/callback?error=access_denied&error_description=nope")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = to_bytes(resp.into_body(), 65536).await.unwrap();
        assert!(std::str::from_utf8(&body)
            .unwrap()
            .contains("error=access_denied"));
    }

    #[tokio::test]
    async fn oauth_connector_callback_rejects_a_kind_outside_the_slug_charset() {
        let state = ConnectorsState::new();
        let (app, emitter) = test_router_with(state);
        // The kind is interpolated into an HTML attribute and a JS string on
        // the bounce page, so anything outside the slug charset is a 404 before
        // it can reach either.
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/oauth/connector/sl%22ack/callback?code=abc")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert!(emitter.events.lock().is_empty());
    }

    #[tokio::test]
    async fn oauth_lark_callback_keeps_its_own_path_and_topic() {
        // The generic route did not replace it: the Feishu console of every
        // existing install has `/oauth/lark/callback` registered byte-for-byte.
        let state = ConnectorsState::new();
        let (app, emitter) = test_router_with(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/oauth/lark/callback?code=abc123&state=lark:lk1:nonce")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            emitter.events.lock()[0].0,
            "connectors://lark-oauth/callback".to_string()
        );
    }

    #[tokio::test]
    async fn oauth_docs_callback_bounces_to_the_provider_scheme_and_names_the_provider() {
        let state = ConnectorsState::new();
        let (app, emitter) = test_router_with(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/oauth/docs/google/callback?code=abc123&state=google:nonce")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = to_bytes(resp.into_body(), 65536).await.unwrap();
        let text = std::str::from_utf8(&body).unwrap();
        assert!(text.contains("cognia://docs-provider/oauth/google?"));
        assert!(text.contains("code=abc123"));
        assert_eq!(
            emitter.events.lock().as_slice(),
            &[(
                "connectors://docs-oauth/callback".to_string(),
                serde_json::json!({
                    "code": "abc123",
                    "state": "google:nonce",
                    "provider": "google",
                }),
            )]
        );
    }

    #[tokio::test]
    async fn oauth_docs_callback_forwards_provider_errors() {
        let state = ConnectorsState::new();
        let (app, _) = test_router_with(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/oauth/docs/google/callback?error=access_denied&error_description=nope")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = to_bytes(resp.into_body(), 65536).await.unwrap();
        assert!(std::str::from_utf8(&body)
            .unwrap()
            .contains("error=access_denied"));
    }

    #[tokio::test]
    async fn oauth_docs_callback_rejects_a_provider_slug_that_could_escape_the_page() {
        let state = ConnectorsState::new();
        let (app, emitter) = test_router_with(state);
        for slug in ["Google", "a%22b", "with.dot", "x".repeat(33).as_str()] {
            let resp = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/oauth/docs/{slug}/callback?code=a"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                resp.status(),
                StatusCode::NOT_FOUND,
                "slug {slug} must be rejected"
            );
        }
        assert!(emitter.events.lock().is_empty());
    }

    #[test]
    fn docs_provider_slug_accepts_only_lowercase_alnum_and_dash() {
        assert!(is_docs_provider_slug("google"));
        assert!(is_docs_provider_slug("google-workspace"));
        assert!(is_docs_provider_slug("m365"));
        assert!(!is_docs_provider_slug(""));
        assert!(!is_docs_provider_slug("Google"));
        assert!(!is_docs_provider_slug("goo gle"));
        assert!(!is_docs_provider_slug("goo/gle"));
        assert!(!is_docs_provider_slug(&"x".repeat(33)));
    }

    #[test]
    fn oauth_deep_link_omits_the_query_when_no_recognised_field_is_present() {
        let params: HashMap<String, String> =
            HashMap::from([("junk".to_string(), "x".to_string())]);
        assert_eq!(
            build_oauth_deep_link("cognia://docs-provider/oauth/google", &params),
            "cognia://docs-provider/oauth/google"
        );
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
    // Secrets go through the hermetic in-memory store (`test-inmemory`).
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn verify_returns_404_when_adapter_unregistered() {
        let state = ConnectorsState::new();
        let err = verify_webhook(&state, "ghost", &HeaderMap::new(), b"{}")
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn verify_refuses_a_plugin_kind_that_declared_no_verification() {
        // Fails CLOSED. A connector that receives nothing is a broken
        // connector, and one that emitted an unverified body would be an open
        // relay into the event bus.
        let state = ConnectorsState::new();
        register(&state, "weird-1", "yahoo");
        let err = verify_webhook(&state, "weird-1", &HeaderMap::new(), b"{}")
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "adapter type declares no webhook verification");
    }

    fn plugin_hmac_spec() -> WebhookVerificationSpec {
        WebhookVerificationSpec::HmacSha256 {
            secret_key: "signingSecret".into(),
            signature_header: "X-Acme-Signature".into(),
            signature_prefix: None,
            digest: super::super::sigverify::declarative::SignatureDigest::Sha256,
            encoding: super::super::sigverify::declarative::SignatureEncoding::Hex,
            basestring: "{body}".into(),
            timestamp_header: None,
            tolerance_secs: 300,
        }
    }

    fn acme_signature(secret: &str, body: &[u8]) -> String {
        use hmac::{Hmac, KeyInit, Mac};
        use sha2::Sha256;
        let mut mac =
            <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes()).expect("any key size");
        mac.update(body);
        hex::encode(mac.finalize().into_bytes())
    }

    #[tokio::test]
    async fn verify_accepts_a_plugin_kind_through_its_declared_scheme() {
        // The whole point of C4: before this, a plugin connector declaring
        // `transportModes: ["webhook"]` got 400 on every inbound POST and
        // could not receive at all.
        let adapter_id = "acme-ok";
        super::super::keyring::set(adapter_id, "signingSecret", "sk_live").unwrap();

        let state = ConnectorsState::new();
        register_with(&state, adapter_id, "acme-chat", Some(plugin_hmac_spec()));

        let body = br#"{"type":"message","text":"hi"}"#;
        let mut headers = HeaderMap::new();
        headers.insert(
            "X-Acme-Signature",
            acme_signature("sk_live", body).parse().unwrap(),
        );

        let payload = verify_webhook(&state, adapter_id, &headers, body)
            .await
            .expect("declared scheme verifies");
        assert_eq!(payload["text"], "hi");
    }

    #[tokio::test]
    async fn verify_rejects_a_plugin_kind_whose_signature_does_not_match() {
        let adapter_id = "acme-bad";
        super::super::keyring::set(adapter_id, "signingSecret", "sk_live").unwrap();

        let state = ConnectorsState::new();
        register_with(&state, adapter_id, "acme-chat", Some(plugin_hmac_spec()));

        let mut headers = HeaderMap::new();
        headers.insert(
            "X-Acme-Signature",
            acme_signature("sk_live", b"a different body")
                .parse()
                .unwrap(),
        );

        let err = verify_webhook(&state, adapter_id, &headers, b"{}")
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn verify_reports_a_plugin_secret_that_was_never_stored() {
        // Distinct from a mismatch: nothing was configured, so the operator's
        // next step is to set the credential rather than to check the platform.
        let state = ConnectorsState::new();
        register_with(&state, "acme-unset", "acme-chat", Some(plugin_hmac_spec()));
        let err = verify_webhook(&state, "acme-unset", &HeaderMap::new(), b"{}")
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
        assert_eq!(err.1, "verification secret not configured");
    }

    #[tokio::test]
    async fn declared_verification_reaches_the_bus_through_the_real_route() {
        // End to end over the router, so the emit half is covered too and not
        // just the predicate.
        let adapter_id = "acme-routed";
        super::super::keyring::set(adapter_id, "signingSecret", "sk_live").unwrap();

        let state = ConnectorsState::new();
        register_with(&state, adapter_id, "acme-chat", Some(plugin_hmac_spec()));
        let (app, emitter) = test_router_with(state);

        let body = br#"{"type":"message","text":"routed"}"#;
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/webhook/acme-chat/{adapter_id}"))
                    .header("X-Acme-Signature", acme_signature("sk_live", body))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let seen = emitter.events.lock().clone();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, format!("connectors://webhook/{adapter_id}"));
        assert_eq!(seen[0].1["text"], "routed");
    }

    #[tokio::test]
    async fn verify_telegram_happy_path() {
        let adapter_id = "tg-happy";
        super::super::keyring::set(adapter_id, "secretToken", "shh-correct").unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "telegram");

        let mut headers = HeaderMap::new();
        headers.insert(
            "X-Telegram-Bot-Api-Secret-Token",
            "shh-correct".parse().unwrap(),
        );
        let payload = verify_webhook(&state, adapter_id, &headers, br#"{"update_id":1}"#)
            .await
            .unwrap();
        assert_eq!(payload["update_id"], 1);

        super::super::keyring::delete(adapter_id, "secretToken").unwrap();
    }

    #[tokio::test]
    async fn verify_telegram_wrong_token_returns_401() {
        let adapter_id = "tg-bad";
        super::super::keyring::set(adapter_id, "secretToken", "expected").unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "telegram");

        let mut headers = HeaderMap::new();
        headers.insert("X-Telegram-Bot-Api-Secret-Token", "wrong".parse().unwrap());
        let err = verify_webhook(&state, adapter_id, &headers, b"{}")
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);

        super::super::keyring::delete(adapter_id, "secretToken").unwrap();
    }

    #[tokio::test]
    async fn verify_telegram_missing_keyring_returns_401() {
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

        let payload = verify_webhook(&state, adapter_id, &headers, body)
            .await
            .unwrap();
        assert_eq!(payload["type"], "event_callback");

        super::super::keyring::delete(adapter_id, "signingSecret").unwrap();
    }

    #[tokio::test]
    async fn verify_discord_happy_path() {
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

        let payload = verify_webhook(&state, adapter_id, &headers, body)
            .await
            .unwrap();
        assert_eq!(payload["type"], 1);

        super::super::keyring::delete(adapter_id, "publicKey").unwrap();
    }

    #[tokio::test]
    async fn verify_discord_stale_timestamp_returns_401() {
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

    #[test]
    fn discord_ack_selects_valid_callback_for_each_interaction() {
        for (kind, message, expected_type, emitted) in [
            (1, false, 1, false),
            (2, false, 4, true),
            (3, true, 6, true),
            (4, false, 8, false),
            (5, true, 6, true),
            (5, false, 4, true),
        ] {
            let mut payload = serde_json::json!({ "type": kind });
            if message {
                payload["message"] = serde_json::json!({ "id": "m1" });
            }
            let (ack, should_emit) = discord_ack_for_interaction(&payload).unwrap();
            assert_eq!(ack["type"], expected_type);
            assert_eq!(should_emit, emitted);
            if expected_type == 4 {
                assert_eq!(ack["data"]["flags"], 64);
                assert!(!ack["data"]["content"].as_str().unwrap().is_empty());
            }
            if expected_type == 8 {
                assert_eq!(ack["data"]["choices"], serde_json::json!([]));
            }
        }
        assert!(discord_ack_for_interaction(&serde_json::json!({ "type": 99 })).is_none());
        assert!(discord_ack_for_interaction(&serde_json::json!({})).is_none());
    }

    #[tokio::test]
    async fn discord_http_ack_and_emit_match_interaction_type() {
        use ed25519_dalek::{Signer, SigningKey};
        let id = "discord-http-response-types";
        let signing = SigningKey::from_bytes(&[0x61; 32]);
        super::super::keyring::set(
            id,
            "publicKey",
            &hex::encode(signing.verifying_key().as_bytes()),
        )
        .unwrap();
        for (kind, from_message, expected_type, emitted) in [
            (1, false, 1, false),
            (2, false, 4, true),
            (3, true, 6, true),
            (4, false, 8, false),
            (5, true, 6, true),
            (5, false, 4, true),
            (99, false, 0, false),
        ] {
            let state = ConnectorsState::new();
            register(&state, id, "discord");
            let (app, emitter) = test_router_with(state);
            let mut payload = serde_json::json!({ "type": kind, "id": "interaction-1" });
            if from_message {
                payload["message"] = serde_json::json!({ "id": "m1" });
            }
            let body = payload.to_string();
            let timestamp = chrono::Utc::now().timestamp().to_string();
            let mut signed = timestamp.as_bytes().to_vec();
            signed.extend_from_slice(body.as_bytes());
            let response = post_webhook(
                app,
                &format!("/webhook/discord/{id}"),
                vec![
                    ("x-signature-timestamp", timestamp),
                    (
                        "x-signature-ed25519",
                        hex::encode(signing.sign(&signed).to_bytes()),
                    ),
                ],
                body,
            )
            .await;
            assert_eq!(
                response.status(),
                if kind == 99 {
                    StatusCode::BAD_REQUEST
                } else {
                    StatusCode::OK
                }
            );
            if kind != 99 {
                let ack: serde_json::Value =
                    serde_json::from_str(&body_string(response).await).unwrap();
                assert_eq!(ack["type"], expected_type);
            }
            let events = emitter.events.lock();
            assert_eq!(events.len(), usize::from(emitted));
            if emitted {
                assert_eq!(events[0].1, payload);
            }
        }
        super::super::keyring::delete(id, "publicKey").unwrap();
    }

    #[tokio::test]
    async fn verify_lark_plaintext_happy_path() {
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
        use aes::cipher::{block_padding::Pkcs7, BlockModeEncrypt, KeyIvInit};
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
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
        rand::fill(&mut iv);
        let ciphertext =
            Aes256CbcEnc::new(&key_arr.into(), &iv.into()).encrypt_padded_vec::<Pkcs7>(plaintext);
        let mut combined = iv.to_vec();
        combined.extend_from_slice(&ciphertext);
        let encoded = BASE64.encode(combined);
        let outer = serde_json::json!({ "encrypt": encoded }).to_string();

        let payload = verify_webhook(
            &state,
            adapter_id,
            &lark_signature_headers(outer.as_bytes()),
            outer.as_bytes(),
        )
        .await
        .unwrap();
        assert_eq!(payload["header"]["token"], "vtok-2");

        super::super::keyring::delete(adapter_id, "verificationToken").unwrap();
        super::super::keyring::delete(adapter_id, "encryptKey").unwrap();
    }

    fn lark_signature_headers(body: &[u8]) -> HeaderMap {
        use sha2::{Digest, Sha256};
        let timestamp = chrono::Utc::now().timestamp().to_string();
        let nonce = "test-nonce";
        let mut digest = Sha256::new();
        digest.update(format!("{timestamp}{nonce}the-encrypt-key"));
        digest.update(body);
        let mut headers = HeaderMap::new();
        headers.insert("x-lark-request-timestamp", timestamp.parse().unwrap());
        headers.insert("x-lark-request-nonce", nonce.parse().unwrap());
        headers.insert(
            "x-lark-signature",
            hex::encode(digest.finalize()).parse().unwrap(),
        );
        headers
    }

    #[tokio::test]
    async fn verify_lark_configured_key_requires_body_signature() {
        let id = "lark-requires-signature";
        super::super::keyring::set(id, "verificationToken", "vtok").unwrap();
        super::super::keyring::set(id, "encryptKey", "the-encrypt-key").unwrap();
        let state = ConnectorsState::new();
        register(&state, id, "lark");
        let body = br#"{"schema":"2.0","header":{"token":"vtok"}}"#;
        assert!(verify_webhook(&state, id, &HeaderMap::new(), body)
            .await
            .is_err());
        let headers = lark_signature_headers(body);
        assert!(verify_webhook(&state, id, &headers, body).await.is_ok());
        let tampered = br#"{"schema":"2.0","header":{"token":"vtok"},"challenge":"bypass"}"#;
        assert!(verify_webhook(&state, id, &headers, tampered)
            .await
            .is_err());
        super::super::keyring::delete(id, "verificationToken").unwrap();
        super::super::keyring::delete(id, "encryptKey").unwrap();
    }

    #[tokio::test]
    async fn verify_lark_url_validation_with_key_still_requires_token_but_not_signature() {
        let id = "lark-signed-challenge";
        super::super::keyring::set(id, "verificationToken", "vtok").unwrap();
        super::super::keyring::set(id, "encryptKey", "the-encrypt-key").unwrap();
        let state = ConnectorsState::new();
        register(&state, id, "lark");
        let body = br#"{"type":"url_verification","challenge":"abc","token":"vtok"}"#;
        assert!(verify_webhook(&state, id, &HeaderMap::new(), body)
            .await
            .is_ok());
        let wrong = br#"{"type":"url_verification","challenge":"abc","token":"wrong"}"#;
        assert!(verify_webhook(&state, id, &HeaderMap::new(), wrong)
            .await
            .is_err());
        super::super::keyring::delete(id, "verificationToken").unwrap();
        super::super::keyring::delete(id, "encryptKey").unwrap();
    }

    #[tokio::test]
    async fn verify_lark_signed_retry_uses_request_time_not_event_creation_time() {
        let id = "lark-signed-retry";
        super::super::keyring::set(id, "verificationToken", "vtok").unwrap();
        super::super::keyring::set(id, "encryptKey", "the-encrypt-key").unwrap();
        let state = ConnectorsState::new();
        register(&state, id, "lark");
        let body = lark_event_body(
            "vtok",
            "signed-old-event",
            chrono::Utc::now().timestamp_millis() - 3600_000,
        );
        assert!(
            verify_webhook(&state, id, &lark_signature_headers(&body), &body)
                .await
                .is_ok()
        );
        super::super::keyring::delete(id, "verificationToken").unwrap();
        super::super::keyring::delete(id, "encryptKey").unwrap();
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

    // -----------------------------------------------------------------------
    // HTTP-level webhook tests — drive the full router with `oneshot` so the
    // in-band responses (challenges, ACK bodies) are asserted end to end.
    // -----------------------------------------------------------------------

    async fn post_webhook(
        app: Router,
        uri: &str,
        headers: Vec<(&str, String)>,
        body: impl Into<Body>,
    ) -> Response {
        let mut builder = Request::builder().uri(uri).method("POST");
        for (k, v) in headers {
            builder = builder.header(k, v);
        }
        app.oneshot(builder.body(body.into()).unwrap())
            .await
            .unwrap()
    }

    async fn body_string(resp: Response) -> String {
        let bytes = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    /// Slack v0 signature headers for `body`, freshly timestamped.
    fn slack_sig_headers(secret: &str, body: &[u8]) -> Vec<(&'static str, String)> {
        use hmac::{Hmac, KeyInit, Mac};
        use sha2::Sha256;
        type HmacSha256 = Hmac<Sha256>;

        let timestamp = chrono::Utc::now().timestamp().to_string();
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(b"v0:");
        mac.update(timestamp.as_bytes());
        mac.update(b":");
        mac.update(body);
        let sig = format!("v0={}", hex::encode(mac.finalize().into_bytes()));
        vec![
            ("X-Slack-Request-Timestamp", timestamp),
            ("X-Slack-Signature", sig),
        ]
    }

    #[tokio::test]
    async fn slack_url_verification_challenge_is_echoed_and_not_emitted() {
        let adapter_id = "slack-challenge-http";
        let secret = "slack-secret-challenge";
        super::super::keyring::set(adapter_id, "signingSecret", secret).unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "slack");
        let (app, emitter) = test_router_with(state);

        let body: &[u8] = br#"{"token":"t","challenge":"ch4ll","type":"url_verification"}"#;
        let resp = post_webhook(
            app,
            &format!("/webhook/slack/{adapter_id}"),
            slack_sig_headers(secret, body),
            body.to_vec(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()["content-type"].to_str().unwrap(),
            "application/json"
        );
        let text = body_string(resp).await;
        assert_eq!(text, r#"{"challenge":"ch4ll"}"#);
        assert!(
            emitter.events.lock().is_empty(),
            "handshake must not be emitted"
        );

        super::super::keyring::delete(adapter_id, "signingSecret").unwrap();
    }

    #[tokio::test]
    async fn slack_event_callback_is_emitted_over_http() {
        let adapter_id = "slack-event-http";
        let secret = "slack-secret-event";
        super::super::keyring::set(adapter_id, "signingSecret", secret).unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "slack");
        let (app, emitter) = test_router_with(state);

        let body: &[u8] = br#"{"type":"event_callback","event":{"type":"message"}}"#;
        let resp = post_webhook(
            app,
            &format!("/webhook/slack/{adapter_id}"),
            slack_sig_headers(secret, body),
            body.to_vec(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        let events = emitter.events.lock();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, format!("connectors://webhook/{adapter_id}"));
        assert_eq!(events[0].1["type"], "event_callback");

        super::super::keyring::delete(adapter_id, "signingSecret").unwrap();
    }

    #[tokio::test]
    async fn slack_form_encoded_interactivity_emits_inner_json() {
        let adapter_id = "slack-interactivity-http";
        let secret = "slack-secret-interactivity";
        super::super::keyring::set(adapter_id, "signingSecret", secret).unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "slack");
        let (app, emitter) = test_router_with(state);

        let inner = serde_json::json!({
            "type": "block_actions",
            "actions": [{ "action_id": "approve", "value": "yes" }],
        });
        let form_body = serde_urlencoded::to_string([("payload", inner.to_string())]).unwrap();
        let resp = post_webhook(
            app,
            &format!("/webhook/slack/{adapter_id}"),
            slack_sig_headers(secret, form_body.as_bytes()),
            form_body.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        // Interactivity ACK body must be empty (any body would be rendered
        // as a message replacement by Slack).
        assert_eq!(body_string(resp).await, "");

        let events = emitter.events.lock();
        assert_eq!(events.len(), 1, "decoded inner payload must be emitted");
        assert_eq!(events[0].1, inner);

        super::super::keyring::delete(adapter_id, "signingSecret").unwrap();
    }

    #[tokio::test]
    async fn slack_form_encoded_with_bad_signature_returns_401() {
        let adapter_id = "slack-badsig-http";
        super::super::keyring::set(adapter_id, "signingSecret", "the-real-secret").unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "slack");
        let (app, emitter) = test_router_with(state);

        let form_body =
            serde_urlencoded::to_string([("payload", r#"{"type":"block_actions"}"#)]).unwrap();
        // Sign with the WRONG secret — must be rejected before any decode.
        let resp = post_webhook(
            app,
            &format!("/webhook/slack/{adapter_id}"),
            slack_sig_headers("wrong-secret", form_body.as_bytes()),
            form_body,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert!(emitter.events.lock().is_empty());

        super::super::keyring::delete(adapter_id, "signingSecret").unwrap();
    }

    #[tokio::test]
    async fn slack_slash_command_form_is_acked_and_forwarded() {
        let adapter_id = "slack-slash-http";
        let secret = "slack-secret-slash";
        super::super::keyring::set(adapter_id, "signingSecret", secret).unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "slack");
        let (app, emitter) = test_router_with(state);

        let form_body = serde_urlencoded::to_string([
            ("command", "/cognia"),
            ("text", "hello"),
            ("user_id", "U123"),
            ("channel_id", "C123"),
            ("trigger_id", "trigger-1"),
        ])
        .unwrap();
        let resp = post_webhook(
            app,
            &format!("/webhook/slack/{adapter_id}"),
            slack_sig_headers(secret, form_body.as_bytes()),
            form_body,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_string(resp).await, "");
        let events = emitter.events.lock();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].1["type"], "slash_command");
        assert_eq!(events[0].1["command"], "/cognia");
        assert_eq!(events[0].1["text"], "hello");
        assert_eq!(events[0].1["channel_id"], "C123");
        assert_eq!(events[0].1["trigger_id"], "trigger-1");

        super::super::keyring::delete(adapter_id, "signingSecret").unwrap();
    }

    #[test]
    fn slack_incomplete_slash_forms_are_invalid() {
        assert!(matches!(
            classify_slack_body(b"ssl_check=1&token=legacy"),
            SlackBody::SslCheck
        ));
        for body in [
            b"random=value".as_slice(),
            b"command=%2Fcognia&channel_id=C1",
            b"command=&user_id=U1&channel_id=C1",
        ] {
            assert!(matches!(classify_slack_body(body), SlackBody::Invalid));
        }
    }

    #[test]
    fn classify_slack_body_shapes() {
        assert!(matches!(
            classify_slack_body(br#"{"type":"event_callback"}"#),
            SlackBody::Json(_)
        ));
        assert!(matches!(
            classify_slack_body(b"payload=%7B%22type%22%3A%22block_actions%22%7D"),
            SlackBody::Interactivity(_)
        ));
        assert!(matches!(
            classify_slack_body(b"command=%2Fcognia&text=hi&channel_id=C1&user_id=U1"),
            SlackBody::SlashCommand(_)
        ));
        // `payload` present but not JSON → invalid.
        assert!(matches!(
            classify_slack_body(b"payload=not-json"),
            SlackBody::Invalid
        ));
    }

    #[tokio::test]
    async fn lark_url_verification_challenge_is_echoed_over_http() {
        let adapter_id = "lark-challenge-http";
        super::super::keyring::set(adapter_id, "verificationToken", "vtok-http").unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "lark");
        let (app, emitter) = test_router_with(state);

        let body: &[u8] =
            br#"{"challenge":"lk-ch4ll","token":"vtok-http","type":"url_verification"}"#;
        let resp = post_webhook(
            app,
            &format!("/webhook/lark/{adapter_id}"),
            vec![],
            body.to_vec(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_string(resp).await, r#"{"challenge":"lk-ch4ll"}"#);
        assert!(
            emitter.events.lock().is_empty(),
            "handshake must not be emitted"
        );

        super::super::keyring::delete(adapter_id, "verificationToken").unwrap();
    }

    #[tokio::test]
    async fn lark_ordinary_event_still_returns_ok_true() {
        let adapter_id = "lark-event-http";
        super::super::keyring::set(adapter_id, "verificationToken", "vtok-evt").unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "lark");
        let (app, emitter) = test_router_with(state);

        let now_ms = chrono::Utc::now().timestamp_millis();
        let body = lark_event_body("vtok-evt", "evt-http-1", now_ms);
        let resp = post_webhook(app, &format!("/webhook/lark/{adapter_id}"), vec![], body).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_string(resp).await, r#"{"ok":true}"#);
        assert_eq!(emitter.events.lock().len(), 1);

        super::super::keyring::delete(adapter_id, "verificationToken").unwrap();
    }

    #[tokio::test]
    async fn oversized_body_is_rejected_with_413() {
        let state = ConnectorsState::new();
        register(&state, "tg-big", "telegram");
        let (app, emitter) = test_router_with(state);

        // 1 byte over the 2 MiB cap → rejected during extraction, before any
        // signature verification runs.
        let big = vec![b'a'; MAX_REQUEST_BODY_BYTES + 1];
        let resp = post_webhook(app, "/webhook/telegram/tg-big", vec![], big).await;
        assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(emitter.events.lock().is_empty());
    }

    // -----------------------------------------------------------------------
    // WeChat OA handler — GET echostr handshake, plaintext POST, safe-mode
    // POST round-trip (incl. the appid cross-check), missing credentials.
    // -----------------------------------------------------------------------

    /// SHA-1 hex over the sorted-and-concatenated parts (WeChat's scheme).
    fn wechat_sig(parts: &mut [&str]) -> String {
        use sha1::{Digest, Sha1};
        parts.sort_unstable();
        let mut hasher = Sha1::new();
        hasher.update(parts.concat().as_bytes());
        hex::encode(hasher.finalize())
    }

    /// 43-char EncodingAESKey whose `+"="` decodes to 32 zero bytes.
    fn wechat_test_aes_key() -> String {
        "A".repeat(43)
    }

    /// Encrypt `msg` the way WeChat OA safe mode does (mirrors the helper in
    /// `sigverify::wechat` tests): `random(16) ++ len(4) ++ msg ++ appid`,
    /// block-32 PKCS#7, AES-256-CBC with IV = key[..16].
    fn wechat_encrypt(encoding_aes_key: &str, msg: &str, appid: &str) -> String {
        use aes::cipher::{block_padding::NoPadding, BlockModeEncrypt, KeyIvInit};
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
        type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;

        let key = BASE64.decode(format!("{encoding_aes_key}=")).unwrap();
        let key_arr: [u8; 32] = key.as_slice().try_into().unwrap();
        let iv_arr: [u8; 16] = key[..16].try_into().unwrap();

        let mut buf = Vec::new();
        buf.extend_from_slice(&[0u8; 16]); // random prefix
        buf.extend_from_slice(&(msg.len() as u32).to_be_bytes());
        buf.extend_from_slice(msg.as_bytes());
        buf.extend_from_slice(appid.as_bytes());
        let block = 32usize;
        let mut pad = block - (buf.len() % block);
        if pad == 0 {
            pad = block;
        }
        for _ in 0..pad {
            buf.push(pad as u8);
        }

        let ct = Aes256CbcEnc::new(&key_arr.into(), &iv_arr.into())
            .encrypt_padded_vec::<NoPadding>(&buf);
        BASE64.encode(ct)
    }

    #[tokio::test]
    async fn wechat_get_echostr_handshake_echoes_verbatim() {
        let adapter_id = "wc-echostr";
        super::super::keyring::set(adapter_id, "token", "wtok").unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "wechat-oa");
        let (app, emitter) = test_router_with(state);

        let ts = "1700000000";
        let nonce = "n0nce";
        let sig = wechat_sig(&mut ["wtok", ts, nonce]);
        let uri = format!(
            "/webhook/wechat-oa/{adapter_id}?signature={sig}&timestamp={ts}&nonce={nonce}&echostr=hello-echo"
        );
        let resp = app
            .oneshot(Request::builder().uri(&uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_string(resp).await, "hello-echo");
        assert!(emitter.events.lock().is_empty());

        super::super::keyring::delete(adapter_id, "token").unwrap();
    }

    #[tokio::test]
    async fn wechat_get_with_bad_signature_returns_401() {
        let adapter_id = "wc-echostr-bad";
        super::super::keyring::set(adapter_id, "token", "wtok").unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "wechat-oa");
        let (app, _) = test_router_with(state);

        let uri = format!(
            "/webhook/wechat-oa/{adapter_id}?signature=deadbeef&timestamp=1&nonce=n&echostr=x"
        );
        let resp = app
            .oneshot(Request::builder().uri(&uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        super::super::keyring::delete(adapter_id, "token").unwrap();
    }

    #[tokio::test]
    async fn wechat_post_plaintext_mode_emits_xml() {
        let adapter_id = "wc-plain";
        super::super::keyring::set(adapter_id, "token", "wtok-p").unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "wechat-oa");
        let (app, emitter) = test_router_with(state);

        let ts = "1700000001";
        let nonce = "pn0nce";
        let sig = wechat_sig(&mut ["wtok-p", ts, nonce]);
        let xml = "<xml><Content><![CDATA[hi]]></Content></xml>";
        let uri =
            format!("/webhook/wechat-oa/{adapter_id}?signature={sig}&timestamp={ts}&nonce={nonce}");
        let resp = post_webhook(app, &uri, vec![], xml.to_string()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_string(resp).await, "success");

        let events = emitter.events.lock();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].1["xml"], xml);

        super::super::keyring::delete(adapter_id, "token").unwrap();
    }

    #[tokio::test]
    async fn wechat_post_safe_mode_round_trip_with_appid_check() {
        let adapter_id = "wc-safe";
        let aes_key = wechat_test_aes_key();
        super::super::keyring::set(adapter_id, "token", "wtok-s").unwrap();
        super::super::keyring::set(adapter_id, "encodingAesKey", &aes_key).unwrap();
        super::super::keyring::set(adapter_id, "appId", "wx-good-appid").unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "wechat-oa");
        let (app, emitter) = test_router_with(state);

        let inner_xml = "<xml><Content><![CDATA[safe hi]]></Content></xml>";
        let encrypt = wechat_encrypt(&aes_key, inner_xml, "wx-good-appid");
        let ts = "1700000002";
        let nonce = "sn0nce";
        let msg_sig = wechat_sig(&mut ["wtok-s", ts, nonce, encrypt.as_str()]);
        let body = format!("<xml><Encrypt><![CDATA[{encrypt}]]></Encrypt></xml>");
        let uri = format!(
            "/webhook/wechat-oa/{adapter_id}?timestamp={ts}&nonce={nonce}&msg_signature={msg_sig}"
        );
        let resp = post_webhook(app, &uri, vec![], body).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_string(resp).await, "success");

        let events = emitter.events.lock();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].1["xml"], inner_xml);

        super::super::keyring::delete(adapter_id, "token").unwrap();
        super::super::keyring::delete(adapter_id, "encodingAesKey").unwrap();
        super::super::keyring::delete(adapter_id, "appId").unwrap();
    }

    #[tokio::test]
    async fn wechat_post_safe_mode_rejects_appid_mismatch() {
        let adapter_id = "wc-safe-mismatch";
        let aes_key = wechat_test_aes_key();
        super::super::keyring::set(adapter_id, "token", "wtok-m").unwrap();
        super::super::keyring::set(adapter_id, "encodingAesKey", &aes_key).unwrap();
        super::super::keyring::set(adapter_id, "appId", "wx-expected").unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "wechat-oa");
        let (app, emitter) = test_router_with(state);

        // Correctly signed + encrypted, but for a DIFFERENT appid.
        let encrypt = wechat_encrypt(&aes_key, "<xml>x</xml>", "wx-other");
        let ts = "1700000003";
        let nonce = "mn0nce";
        let msg_sig = wechat_sig(&mut ["wtok-m", ts, nonce, encrypt.as_str()]);
        let body = format!("<xml><Encrypt><![CDATA[{encrypt}]]></Encrypt></xml>");
        let uri = format!(
            "/webhook/wechat-oa/{adapter_id}?timestamp={ts}&nonce={nonce}&msg_signature={msg_sig}"
        );
        let resp = post_webhook(app, &uri, vec![], body).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert!(emitter.events.lock().is_empty());

        super::super::keyring::delete(adapter_id, "token").unwrap();
        super::super::keyring::delete(adapter_id, "encodingAesKey").unwrap();
        super::super::keyring::delete(adapter_id, "appId").unwrap();
    }

    #[tokio::test]
    async fn wechat_post_safe_mode_skips_appid_check_when_unset() {
        let adapter_id = "wc-safe-noappid";
        let aes_key = wechat_test_aes_key();
        super::super::keyring::set(adapter_id, "token", "wtok-n").unwrap();
        super::super::keyring::set(adapter_id, "encodingAesKey", &aes_key).unwrap();
        super::super::keyring::delete(adapter_id, "appId").ok();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "wechat-oa");
        let (app, emitter) = test_router_with(state);

        let encrypt = wechat_encrypt(&aes_key, "<xml>y</xml>", "wx-whatever");
        let ts = "1700000004";
        let nonce = "nn0nce";
        let msg_sig = wechat_sig(&mut ["wtok-n", ts, nonce, encrypt.as_str()]);
        let body = format!("<xml><Encrypt><![CDATA[{encrypt}]]></Encrypt></xml>");
        let uri = format!(
            "/webhook/wechat-oa/{adapter_id}?timestamp={ts}&nonce={nonce}&msg_signature={msg_sig}"
        );
        let resp = post_webhook(app, &uri, vec![], body).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(emitter.events.lock().len(), 1);

        super::super::keyring::delete(adapter_id, "token").unwrap();
        super::super::keyring::delete(adapter_id, "encodingAesKey").unwrap();
    }

    // -----------------------------------------------------------------------
    // QQ Official Bot — seeded-Ed25519 verification, op-13 challenge,
    // op-0 dispatch emit + {"op":12} ACK.
    // -----------------------------------------------------------------------

    const QQ_TEST_SECRET: &str = "DG5g3B4j9X2KOErG";

    /// Sign `timestamp ++ body` the way the QQ platform does (same seeded key
    /// on both ends) and return the two signature headers.
    fn qq_sig_headers(secret: &str, timestamp: &str, body: &[u8]) -> Vec<(&'static str, String)> {
        use ed25519_dalek::{Signer, SigningKey};
        let seed = crate::sigverify::qq::seed_from_secret(secret).unwrap();
        let key = SigningKey::from_bytes(&seed);
        let mut msg = timestamp.as_bytes().to_vec();
        msg.extend_from_slice(body);
        vec![
            ("X-Signature-Timestamp", timestamp.to_string()),
            (
                "X-Signature-Ed25519",
                hex::encode(key.sign(&msg).to_bytes()),
            ),
        ]
    }

    #[tokio::test]
    async fn qq_challenge_round_trip_signs_event_ts_plus_plain_token() {
        use ed25519_dalek::{Signature, SigningKey, Verifier};

        let adapter_id = "qq-challenge";
        super::super::keyring::set(adapter_id, "clientSecret", QQ_TEST_SECRET).unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "qq-official");
        let (app, emitter) = test_router_with(state);

        let body = serde_json::json!({
            "op": 13,
            "d": { "plain_token": "Arq0D5A61EgUu4OxUvOp", "event_ts": "1725442341" },
        })
        .to_string();
        let resp = post_webhook(
            app,
            &format!("/webhook/qq-official/{adapter_id}"),
            qq_sig_headers(QQ_TEST_SECRET, "1725442341", body.as_bytes()),
            body,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let json: serde_json::Value =
            serde_json::from_str(&body_string(resp).await).expect("challenge reply is JSON");
        assert_eq!(json["plain_token"], "Arq0D5A61EgUu4OxUvOp");

        // The returned signature must verify against the seed-derived public
        // key over event_ts ++ plain_token (deterministic Ed25519).
        let sig_hex = json["signature"].as_str().expect("signature present");
        let sig_bytes = <[u8; 64]>::try_from(hex::decode(sig_hex).unwrap().as_slice()).unwrap();
        let seed = crate::sigverify::qq::seed_from_secret(QQ_TEST_SECRET).unwrap();
        let vk = SigningKey::from_bytes(&seed).verifying_key();
        assert!(vk
            .verify(
                b"1725442341Arq0D5A61EgUu4OxUvOp",
                &Signature::from_bytes(&sig_bytes)
            )
            .is_ok());

        // Handshake only — nothing reaches the renderer.
        assert!(emitter.events.lock().is_empty());

        super::super::keyring::delete(adapter_id, "clientSecret").unwrap();
    }

    #[tokio::test]
    async fn qq_dispatch_event_is_emitted_and_acked_with_op_12() {
        let adapter_id = "qq-dispatch";
        super::super::keyring::set(adapter_id, "clientSecret", QQ_TEST_SECRET).unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "qq-official");
        let (app, emitter) = test_router_with(state);

        let body = serde_json::json!({
            "op": 0,
            "t": "C2C_MESSAGE_CREATE",
            "id": "evt-1",
            "d": { "id": "msg-1", "content": "hi", "author": { "user_openid": "u1" } },
        })
        .to_string();
        let resp = post_webhook(
            app,
            &format!("/webhook/qq-official/{adapter_id}"),
            qq_sig_headers(QQ_TEST_SECRET, "1725442342", body.as_bytes()),
            body.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_string(resp).await, r#"{"op":12}"#);

        let events = emitter.events.lock();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, format!("connectors://webhook/{adapter_id}"));
        // The RAW envelope is forwarded (TS re-parses via parseQQDispatch).
        assert_eq!(events[0].1["t"], "C2C_MESSAGE_CREATE");
        assert_eq!(events[0].1["d"]["id"], "msg-1");

        super::super::keyring::delete(adapter_id, "clientSecret").unwrap();
    }

    #[tokio::test]
    async fn qq_bad_signature_returns_401_and_emits_nothing() {
        let adapter_id = "qq-badsig";
        super::super::keyring::set(adapter_id, "clientSecret", QQ_TEST_SECRET).unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "qq-official");
        let (app, emitter) = test_router_with(state);

        let body = r#"{"op":0,"t":"C2C_MESSAGE_CREATE","d":{"id":"m"}}"#;
        // Signed with the WRONG secret → derived public key mismatch.
        let resp = post_webhook(
            app,
            &format!("/webhook/qq-official/{adapter_id}"),
            qq_sig_headers("wrong-secret-here", "1725442343", body.as_bytes()),
            body.to_string(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert!(emitter.events.lock().is_empty());

        super::super::keyring::delete(adapter_id, "clientSecret").unwrap();
    }

    #[tokio::test]
    async fn qq_missing_signature_headers_return_401() {
        let adapter_id = "qq-noheaders";
        super::super::keyring::set(adapter_id, "clientSecret", QQ_TEST_SECRET).unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "qq-official");
        let (app, emitter) = test_router_with(state);

        let resp = post_webhook(
            app,
            &format!("/webhook/qq-official/{adapter_id}"),
            vec![],
            r#"{"op":0}"#.to_string(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert!(emitter.events.lock().is_empty());

        super::super::keyring::delete(adapter_id, "clientSecret").unwrap();
    }

    #[tokio::test]
    async fn qq_missing_client_secret_returns_401() {
        let adapter_id = "qq-nosecret";
        super::super::keyring::delete(adapter_id, "clientSecret").ok();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "qq-official");
        let (app, emitter) = test_router_with(state);

        let resp = post_webhook(
            app,
            &format!("/webhook/qq-official/{adapter_id}"),
            vec![],
            r#"{"op":0}"#.to_string(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert!(emitter.events.lock().is_empty());
    }

    #[tokio::test]
    async fn qq_unknown_op_is_acked_but_not_emitted() {
        let adapter_id = "qq-unknown-op";
        super::super::keyring::set(adapter_id, "clientSecret", QQ_TEST_SECRET).unwrap();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "qq-official");
        let (app, emitter) = test_router_with(state);

        let body = r#"{"op":11}"#;
        let resp = post_webhook(
            app,
            &format!("/webhook/qq-official/{adapter_id}"),
            qq_sig_headers(QQ_TEST_SECRET, "1725442344", body.as_bytes()),
            body.to_string(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_string(resp).await, r#"{"op":12}"#);
        assert!(emitter.events.lock().is_empty());

        super::super::keyring::delete(adapter_id, "clientSecret").unwrap();
    }

    #[tokio::test]
    async fn wechat_missing_token_keyring_returns_401() {
        let adapter_id = "wc-no-token";
        super::super::keyring::delete(adapter_id, "token").ok();

        let state = ConnectorsState::new();
        register(&state, adapter_id, "wechat-oa");
        let (app, emitter) = test_router_with(state);

        let uri =
            format!("/webhook/wechat-oa/{adapter_id}?signature=x&timestamp=1&nonce=n&echostr=e");
        let resp = app
            .oneshot(Request::builder().uri(&uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert!(emitter.events.lock().is_empty());
    }

    // -----------------------------------------------------------------
    // Lark app-avatar staging (appPreset.avatar public URL)
    // -----------------------------------------------------------------

    fn stage_body() -> String {
        use base64::Engine;
        serde_json::json!({
            "bytesB64": base64::engine::general_purpose::STANDARD.encode(b"fake-webp"),
            "contentType": "image/webp",
            "ttlSecs": 900,
        })
        .to_string()
    }

    #[tokio::test]
    async fn app_avatar_stage_requires_the_staging_bearer() {
        let state = ConnectorsState::new();
        let (app, _) = test_router_with(state);

        // No Authorization header at all.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/internal/lark/app-avatar")
                    .header("content-type", "application/json")
                    .body(Body::from(stage_body()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        // Wrong bearer.
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/internal/lark/app-avatar")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer wrong")
                    .body(Body::from(stage_body()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn app_avatar_stage_then_serve_round_trip() {
        let state = ConnectorsState::new();
        let token = state.inner.lock().staging_token.clone();
        let (app, _) = test_router_with(state);

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/internal/lark/app-avatar")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::from(stage_body()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(resp.into_body(), 4096).await.unwrap()).unwrap();
        let avatar_token = body["token"].as_str().unwrap().to_string();
        assert!(body["expiresAtMs"].as_u64().unwrap() > 0);

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/lark/app-avatar/{avatar_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "image/webp"
        );
        assert_eq!(
            resp.headers().get("x-content-type-options").unwrap(),
            "nosniff"
        );
        let body = to_bytes(resp.into_body(), 4096).await.unwrap();
        assert_eq!(&body[..], b"fake-webp");

        // Unknown token → 404.
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/lark/app-avatar/does-not-exist")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn app_avatar_stage_rejects_unsupported_content_type() {
        let state = ConnectorsState::new();
        let token = state.inner.lock().staging_token.clone();
        let (app, _) = test_router_with(state);

        let body = serde_json::json!({
            "bytesB64": "AAAA",
            "contentType": "application/octet-stream",
        })
        .to_string();
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/internal/lark/app-avatar")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn staged_avatar_expiry_is_reported_missing() {
        let state = ConnectorsState::new();
        // TTL clamps to the 60s floor — so drive expiry directly in state for
        // a deterministic test rather than sleeping.
        let (token, _) = state
            .stage_lark_app_avatar(b"x".to_vec(), "image/png".into(), 60)
            .unwrap();
        state
            .inner
            .lock()
            .staged_avatars
            .get_mut(&token)
            .unwrap()
            .expires_at = Instant::now() - Duration::from_secs(1);
        assert!(state.staged_lark_app_avatar(&token).is_none());
    }
}
