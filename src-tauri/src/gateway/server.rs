//! Local axum HTTP server exposing OpenAI- and Anthropic-compatible chat
//! endpoints backed by the user's configured providers + routing snapshot.
//!
//! Layout:
//!   - GET  /healthz                  → liveness (no auth)
//!   - GET  /v1/models                → aliases + provider models
//!   - POST /v1/chat/completions      → OpenAI-format chat (stream + non-stream)
//!   - POST /v1/messages              → Anthropic-format chat (Claude Code CLI)
//!
//! Middleware mirrors `remote_control::server` (the audited reference):
//! Host-loopback check → Origin/Referer rejection → IPv4 allowlist → bearer
//! auth (constant-time; accepts BOTH `Authorization: Bearer` and
//! `x-api-key`, because Anthropic clients send the latter) → fixed-window
//! rate limit. The listener binds 127.0.0.1 only.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Instant;

use axum::{
    body::Body,
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    middleware::{from_fn_with_state, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use bytes::Bytes;
use futures_util::StreamExt;
use parking_lot::RwLock;
use serde_json::{json, Value};
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, watch};
use tower_http::limit::RequestBodyLimitLayer;

use crate::remote_control::allowlist::ParsedAllowlist;
use crate::remote_control::rate_limit::FixedWindowRateLimiter;

use super::execute::{
    candidates_from_entries, resolve_candidates, rewrite_model, should_try_next, upstream_headers,
    upstream_url, Candidate, SseDeframer,
};
use super::snapshot::RoutingSnapshot;
use super::translate::errors::{error_body, InboundFormat};
use super::translate::stream::{Direction, StreamTranscoder};
use super::translate::{request_from_ir, request_to_ir, response_from_ir, response_to_ir};
use super::types::GatewayError;
use super::DecisionRegistry;

pub const INBOUND_CALL_EVENT: &str = "gateway://inbound-call";
pub const REQUEST_OUTCOME_EVENT: &str = "gateway://request-outcome";
pub const DECIDE_EVENT: &str = "gateway://decide";

/// How long the gateway waits for the renderer's live routing decision before
/// falling back to the snapshot's pre-ordered candidates. Short so a closed
/// window costs one bounded stall, not a hang.
const DECIDE_TIMEOUT_MS: u64 = 800;

/// Chat bodies can be large (long histories); 16 MiB is generous without
/// being a memory hazard.
const BODY_LIMIT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone)]
pub struct ServerHandle {
    pub bound_port: u16,
    pub shutdown: watch::Sender<()>,
}

/// Hook fired on every request (post-middleware) for the status counters +
/// renderer ring buffer.
pub trait RequestObserver: Send + Sync + 'static {
    fn on_call(&self, route: &str, status: StatusCode, remote_ip: IpAddr);
}

#[derive(Clone)]
struct AppState {
    app_handle: AppHandle,
    token: Arc<String>,
    allowlist: Arc<ParsedAllowlist>,
    rate_limiter: Arc<FixedWindowRateLimiter>,
    on_request: Arc<dyn RequestObserver>,
    snapshot: Arc<RwLock<Option<RoutingSnapshot>>>,
    decisions: Arc<DecisionRegistry>,
    http: reqwest::Client,
}

#[allow(clippy::too_many_arguments)]
pub async fn spawn_server(
    app_handle: AppHandle,
    port: u16,
    token: String,
    allowlist: Vec<String>,
    rate_limit_per_min: u32,
    snapshot: Arc<RwLock<Option<RoutingSnapshot>>>,
    decisions: Arc<DecisionRegistry>,
    on_request: Arc<dyn RequestObserver>,
) -> Result<ServerHandle, GatewayError> {
    let parsed_allowlist =
        ParsedAllowlist::parse(&allowlist).map_err(GatewayError::InvalidConfig)?;

    let bind_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .map_err(|source| GatewayError::Bind { port, source })?;
    let bound_port = listener
        .local_addr()
        .map_err(|source| GatewayError::Bind { port, source })?
        .port();

    let state = AppState {
        app_handle,
        token: Arc::new(token),
        allowlist: Arc::new(parsed_allowlist),
        rate_limiter: Arc::new(FixedWindowRateLimiter::new(rate_limit_per_min)),
        on_request,
        snapshot,
        decisions,
        http: reqwest::Client::new(),
    };

    let protected = Router::new()
        .route("/v1/models", get(list_models))
        .route("/v1/chat/completions", post(openai_chat))
        .route("/v1/messages", post(anthropic_messages))
        .layer(from_fn_with_state(state.clone(), middleware))
        .layer(RequestBodyLimitLayer::new(BODY_LIMIT_BYTES));

    let app = Router::new()
        .route("/healthz", get(healthz))
        .merge(protected)
        .with_state(state);

    let (tx, mut rx) = watch::channel(());
    tokio::spawn(async move {
        let server = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        );
        let result = server
            .with_graceful_shutdown(async move {
                let _ = rx.changed().await;
            })
            .await;
        if let Err(error) = result {
            log::warn!("gateway server exited with error: {error}");
        }
    });

    Ok(ServerHandle {
        bound_port,
        shutdown: tx,
    })
}

async fn healthz() -> impl IntoResponse {
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

// ---- middleware -------------------------------------------------------------

/// Accept only loopback Host headers (DNS-rebinding mitigation). Same logic
/// as `remote_control::server::host_is_local`.
fn host_is_local(host: &str) -> bool {
    let host = host.trim();
    if host == "[::1]" || host == "::1" {
        return true;
    }
    let without_port = match host.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(rest),
        None => host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host),
    };
    matches!(without_port, "127.0.0.1" | "localhost" | "::1")
}

/// Extract the supplied credential: `Authorization: Bearer <t>` (OpenAI
/// clients) or `x-api-key: <t>` (Anthropic clients — Claude Code CLI sends
/// this).
fn supplied_token(headers: &HeaderMap) -> Option<&str> {
    if let Some(bearer) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        return Some(bearer);
    }
    headers.get("x-api-key").and_then(|v| v.to_str().ok())
}

async fn middleware(
    State(state): State<AppState>,
    ConnectInfo(connect_info): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let route = request.uri().path().to_string();
    let remote_ip = connect_info.ip();

    let reject = |status: StatusCode, message: &str| -> Response {
        state.on_request.on_call(&route, status, remote_ip);
        (status, Json(json!({ "error": { "message": message } }))).into_response()
    };

    // 0. Host-header allowlist + cross-origin rejection. Real CLI clients
    // never send Origin/Referer; a browser-originated call always does.
    let host_ok = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(host_is_local)
        .unwrap_or(false);
    if !host_ok {
        return reject(StatusCode::FORBIDDEN, "invalid host");
    }
    if headers.contains_key(axum::http::header::ORIGIN)
        || headers.contains_key(axum::http::header::REFERER)
    {
        return reject(StatusCode::FORBIDDEN, "cross-origin not allowed");
    }

    // 1. IPv4 allowlist (defence-in-depth behind the loopback bind).
    let canonical = match remote_ip {
        IpAddr::V4(v4) => v4,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4,
            None => return reject(StatusCode::FORBIDDEN, "ipv6 not supported"),
        },
    };
    if !state.allowlist.contains(canonical) {
        return reject(StatusCode::FORBIDDEN, "origin not allowed");
    }

    // 2. Bearer auth — constant-time compare, dual header support.
    let Some(supplied) = supplied_token(&headers) else {
        return reject(
            StatusCode::UNAUTHORIZED,
            "missing credentials (Authorization: Bearer or x-api-key)",
        );
    };
    let expected = state.token.as_bytes();
    let supplied = supplied.as_bytes();
    if expected.len() != supplied.len() || expected.ct_eq(supplied).unwrap_u8() == 0 {
        return reject(StatusCode::UNAUTHORIZED, "invalid token");
    }

    // 3. Rate limit.
    if !state.rate_limiter.try_acquire() {
        return reject(StatusCode::TOO_MANY_REQUESTS, "rate limit exceeded");
    }

    let response = next.run(request).await;
    state.on_request.on_call(&route, response.status(), remote_ip);
    response
}

// ---- /v1/models -------------------------------------------------------------

async fn list_models(State(state): State<AppState>) -> Response {
    let snapshot = state.snapshot.read().clone();
    let Some(snapshot) = snapshot else {
        return no_snapshot_error(InboundFormat::OpenAiChat);
    };
    let mut data: Vec<Value> = Vec::new();
    for alias in &snapshot.aliases {
        data.push(json!({
            "id": alias.alias,
            "object": "model",
            "owned_by": "cognia-routing",
        }));
    }
    for provider in &snapshot.providers {
        if !provider.enabled {
            continue;
        }
        for model in &provider.models {
            data.push(json!({
                "id": model,
                "object": "model",
                "owned_by": provider.id,
            }));
        }
    }
    Json(json!({ "object": "list", "data": data })).into_response()
}

// ---- chat handlers ----------------------------------------------------------

async fn openai_chat(State(state): State<AppState>, Json(body): Json<Value>) -> Response {
    handle_chat(state, InboundFormat::OpenAiChat, body).await
}

async fn anthropic_messages(State(state): State<AppState>, Json(body): Json<Value>) -> Response {
    handle_chat(state, InboundFormat::AnthropicMessages, body).await
}

fn no_snapshot_error(format: InboundFormat) -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(error_body(
            format,
            "overloaded_error",
            "no routing snapshot yet — open the Cognia window once so it can publish providers",
        )),
    )
        .into_response()
}

fn format_error(format: InboundFormat, status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(error_body(format, "invalid_request_error", message)),
    )
        .into_response()
}

/// Ask the renderer for a live routing decision (full engine: difficulty
/// router, real-time strategy, health/circuit). Emits `gateway://decide` and
/// awaits a `gateway_decision_response` for at most `DECIDE_TIMEOUT_MS`; on
/// timeout (window closed / renderer busy) returns None so the caller falls
/// back to the snapshot's pre-ordered candidates.
async fn live_decision(
    state: &AppState,
    snapshot: &RoutingSnapshot,
    model: &str,
    body: &Value,
) -> Option<Vec<Candidate>> {
    let request_id = format!("gwd_{}", uuid::Uuid::new_v4().simple());
    let (tx, rx) = oneshot::channel::<Vec<super::snapshot::SnapshotEntry>>();
    state.decisions.lock().insert(request_id.clone(), tx);

    // Last user message text (cheap difficulty heuristic input).
    let prompt_text = body["messages"]
        .as_array()
        .and_then(|m| m.iter().rev().find(|msg| msg["role"] == "user"))
        .and_then(|msg| match &msg["content"] {
            Value::String(s) => Some(s.clone()),
            Value::Array(parts) => Some(
                parts
                    .iter()
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
            ),
            _ => None,
        });

    let emitted = state.app_handle.emit(
        DECIDE_EVENT,
        json!({ "requestId": request_id, "model": model, "promptText": prompt_text }),
    );
    if emitted.is_err() {
        state.decisions.lock().remove(&request_id);
        return None;
    }

    let entries = match tokio::time::timeout(
        std::time::Duration::from_millis(DECIDE_TIMEOUT_MS),
        rx,
    )
    .await
    {
        Ok(Ok(entries)) if !entries.is_empty() => entries,
        // timeout, sender dropped, or empty decision → snapshot fallback
        _ => {
            state.decisions.lock().remove(&request_id);
            return None;
        }
    };
    let candidates = candidates_from_entries(snapshot, &entries);
    if candidates.is_empty() {
        None
    } else {
        Some(candidates)
    }
}

async fn handle_chat(state: AppState, format: InboundFormat, body: Value) -> Response {
    let snapshot = state.snapshot.read().clone();
    let Some(snapshot) = snapshot else {
        return no_snapshot_error(format);
    };

    let Some(model) = body["model"].as_str().map(|s| s.to_string()) else {
        return format_error(format, StatusCode::BAD_REQUEST, "model is required");
    };
    let stream = body["stream"].as_bool().unwrap_or(false);

    // Prefer the renderer's live routing decision; fall back to the snapshot's
    // pre-ordered candidates when the window is closed / the renderer is busy.
    let candidates = match live_decision(&state, &snapshot, &model, &body).await {
        Some(candidates) => candidates,
        None => resolve_candidates(&snapshot, &model),
    };
    if candidates.is_empty() {
        return format_error(
            format,
            StatusCode::NOT_FOUND,
            &format!(
                "model \"{model}\" matches no alias, provider:model, or enabled provider model"
            ),
        );
    }

    // Parse the inbound body into the IR once — only needed for translated
    // pairs; a NotTranslatable feature fails fast with a clear 400 even if
    // the first candidate happens to be passthrough (deterministic behavior
    // regardless of provider health).
    let needs_translation = candidates
        .iter()
        .any(|c| c.provider.protocol != format.protocol_name());
    let ir = if needs_translation {
        match request_to_ir(format, &body) {
            Ok(ir) => Some(ir),
            Err(err) => return format_error(format, StatusCode::BAD_REQUEST, &err.reason),
        }
    } else {
        None
    };

    let mut failures: Vec<String> = Vec::new();
    for candidate in &candidates {
        let started = Instant::now();
        let passthrough = candidate.provider.protocol == format.protocol_name();
        let upstream_body = if passthrough {
            rewrite_model(&body, &candidate.model_id)
        } else {
            let mut ir = ir.clone().expect("ir computed for translated pairs");
            ir.model = candidate.model_id.clone();
            match request_from_ir(&candidate.provider.protocol, &ir) {
                Ok(body) => body,
                Err(err) => {
                    failures.push(format!("{}: {}", candidate.provider.id, err.reason));
                    continue;
                }
            }
        };

        let url = upstream_url(&candidate.provider.protocol, &candidate.provider.base_url);
        let mut req = state.http.post(&url).json(&upstream_body);
        for (name, value) in
            upstream_headers(&candidate.provider.protocol, candidate.provider.api_key.as_deref())
        {
            req = req.header(name, value);
        }

        let resp = match req.send().await {
            Ok(resp) => resp,
            Err(err) => {
                let message = format!("connect error: {err}");
                emit_outcome(&state.app_handle, candidate, false, started, None, Some(&message));
                failures.push(format!("{}: {message}", candidate.provider.id));
                continue;
            }
        };

        let status = resp.status().as_u16();
        if status >= 400 {
            let retry_after = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let text = resp.text().await.unwrap_or_default();
            let mut message = format!("HTTP {status}");
            if let Some(ra) = retry_after {
                message.push_str(&format!(" retry-after: {ra}"));
            }
            message.push_str(&format!(": {}", text.chars().take(500).collect::<String>()));
            emit_outcome(&state.app_handle, candidate, false, started, None, Some(&message));
            if should_try_next(status) {
                failures.push(format!("{}: {message}", candidate.provider.id));
                continue;
            }
            // Client-side error — surface immediately in the inbound shape.
            return format_error(
                format,
                StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST),
                &message,
            );
        }

        // Success — stream or buffer.
        if stream {
            return stream_response(state, format, candidate, resp, started).await;
        }
        return buffered_response(state, format, candidate, resp, started, passthrough).await;
    }

    (
        StatusCode::BAD_GATEWAY,
        Json(error_body(
            format,
            "api_error",
            &format!("every candidate failed: {}", failures.join(" | ")),
        )),
    )
        .into_response()
}

async fn buffered_response(
    state: AppState,
    format: InboundFormat,
    candidate: &Candidate,
    resp: reqwest::Response,
    started: Instant,
    passthrough: bool,
) -> Response {
    let upstream: Value = match resp.json().await {
        Ok(v) => v,
        Err(err) => {
            let message = format!("invalid upstream JSON: {err}");
            emit_outcome(&state.app_handle, candidate, false, started, None, Some(&message));
            return format_error(format, StatusCode::BAD_GATEWAY, &message);
        }
    };

    if passthrough {
        // Usage telemetry best-effort from the native shape.
        let usage = match format {
            InboundFormat::OpenAiChat => (
                upstream["usage"]["prompt_tokens"].as_u64(),
                upstream["usage"]["completion_tokens"].as_u64(),
            ),
            InboundFormat::AnthropicMessages => (
                upstream["usage"]["input_tokens"].as_u64(),
                upstream["usage"]["output_tokens"].as_u64(),
            ),
        };
        emit_outcome(&state.app_handle, candidate, true, started, Some(usage), None);
        return Json(upstream).into_response();
    }

    match response_to_ir(&candidate.provider.protocol, &upstream) {
        Ok(ir_resp) => {
            emit_outcome(
                &state.app_handle,
                candidate,
                true,
                started,
                Some((
                    Some(ir_resp.usage.input_tokens),
                    Some(ir_resp.usage.output_tokens),
                )),
                None,
            );
            let created = chrono::Utc::now().timestamp();
            Json(response_from_ir(format, &ir_resp, created)).into_response()
        }
        Err(err) => {
            emit_outcome(&state.app_handle, candidate, false, started, None, Some(&err.reason));
            format_error(format, StatusCode::BAD_GATEWAY, &err.reason)
        }
    }
}

async fn stream_response(
    state: AppState,
    format: InboundFormat,
    candidate: &Candidate,
    resp: reqwest::Response,
    started: Instant,
) -> Response {
    let passthrough = candidate.provider.protocol == format.protocol_name();
    if passthrough {
        // Byte-clean passthrough — the Claude-CLI→anthropic happy path.
        emit_outcome(&state.app_handle, candidate, true, started, None, None);
        let body = Body::from_stream(resp.bytes_stream());
        return sse_response(body);
    }

    let direction = match format {
        InboundFormat::AnthropicMessages => Direction::OpenAiToAnthropic,
        InboundFormat::OpenAiChat => Direction::AnthropicToOpenAi,
    };
    let message_id = match format {
        InboundFormat::AnthropicMessages => format!("msg_{}", uuid::Uuid::new_v4().simple()),
        InboundFormat::OpenAiChat => format!("chatcmpl-{}", uuid::Uuid::new_v4().simple()),
    };
    let mut transcoder = StreamTranscoder::new(direction, candidate.model_id.clone(), message_id);

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(32);
    let app_handle = state.app_handle.clone();
    let candidate = candidate.clone();
    // Pump task: bounded by the request — exits when the upstream ends or
    // the client hangs up (send fails). Never detached past the response.
    tokio::spawn(async move {
        let mut deframer = SseDeframer::default();
        let mut upstream = resp.bytes_stream();
        'pump: while let Some(chunk) = upstream.next().await {
            let Ok(bytes) = chunk else { break };
            for data in deframer.push(&bytes) {
                if data == "[DONE]" {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(&data) else {
                    continue;
                };
                for frame in transcoder.push(&value) {
                    if tx.send(Ok(Bytes::from(frame.to_frame()))).await.is_err() {
                        break 'pump; // client disconnected
                    }
                }
            }
        }
        for frame in transcoder.finish() {
            if tx.send(Ok(Bytes::from(frame.to_frame()))).await.is_err() {
                break;
            }
        }
        let usage = transcoder.usage();
        emit_outcome(
            &app_handle,
            &candidate,
            true,
            started,
            Some((Some(usage.input_tokens), Some(usage.output_tokens))),
            None,
        );
    });

    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    });
    sse_response(Body::from_stream(stream))
}

fn sse_response(body: Body) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Per-attempt outcome event — the renderer forwards it into
/// `recordProviderOutcome` so gateway traffic feeds the same health /
/// breaker / cost stores the chat plane reads.
fn emit_outcome(
    app_handle: &AppHandle,
    candidate: &Candidate,
    ok: bool,
    started: Instant,
    usage: Option<(Option<u64>, Option<u64>)>,
    error: Option<&str>,
) {
    let (input_tokens, output_tokens) = usage.unwrap_or((None, None));
    let payload = json!({
        "providerId": candidate.provider.id,
        "modelId": candidate.model_id,
        "ok": ok,
        "latencyMs": started.elapsed().as_millis() as u64,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "errorMessage": error,
    });
    let _ = app_handle.emit(REQUEST_OUTCOME_EVENT, payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_limit_fits_chat_histories() {
        assert_eq!(BODY_LIMIT_BYTES, 16 * 1024 * 1024);
    }

    #[test]
    fn event_names_match_frontend_listeners() {
        assert_eq!(INBOUND_CALL_EVENT, "gateway://inbound-call");
        assert_eq!(REQUEST_OUTCOME_EVENT, "gateway://request-outcome");
        assert_eq!(DECIDE_EVENT, "gateway://decide");
    }

    #[test]
    fn decide_timeout_is_bounded() {
        assert_eq!(DECIDE_TIMEOUT_MS, 800);
    }

    #[test]
    fn host_allowlist_matches_remote_control_semantics() {
        assert!(host_is_local("127.0.0.1:47823"));
        assert!(host_is_local("localhost"));
        assert!(host_is_local("[::1]:8080"));
        assert!(!host_is_local("evil.com"));
        assert!(!host_is_local("0.0.0.0"));
    }

    #[test]
    fn supplied_token_reads_both_header_families() {
        let mut bearer = HeaderMap::new();
        bearer.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer tok-1".parse().unwrap(),
        );
        assert_eq!(supplied_token(&bearer), Some("tok-1"));

        let mut anthropic_style = HeaderMap::new();
        anthropic_style.insert("x-api-key", "tok-2".parse().unwrap());
        assert_eq!(supplied_token(&anthropic_style), Some("tok-2"));

        // Bearer wins when both are present.
        let mut both = HeaderMap::new();
        both.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer tok-1".parse().unwrap(),
        );
        both.insert("x-api-key", "tok-2".parse().unwrap());
        assert_eq!(supplied_token(&both), Some("tok-1"));

        assert_eq!(supplied_token(&HeaderMap::new()), None);
    }

    #[test]
    fn error_helpers_render_inbound_shapes() {
        let resp = format_error(
            InboundFormat::AnthropicMessages,
            StatusCode::BAD_REQUEST,
            "nope",
        );
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let resp = no_snapshot_error(InboundFormat::OpenAiChat);
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
