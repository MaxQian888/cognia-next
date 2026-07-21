//! Local axum HTTP server exposing OpenAI- and Anthropic-compatible chat
//! endpoints backed by the user's configured providers + routing snapshot.
//!
//! Layout:
//!   - GET  /healthz                  → liveness (no auth)
//!   - GET  /v1/models                → aliases + provider models (exposure-filtered)
//!   - POST /v1/chat/completions      → OpenAI-format chat (stream + non-stream)
//!   - POST /v1/messages              → Anthropic-format chat (Claude Code CLI)
//!   - POST /v1/embeddings            → OpenAI-format embeddings
//!   - POST /v1/responses             → OpenAI Responses API (non-stream)
//!
//! Middleware mirrors `remote_control::server` (the audited reference), with
//! the gateway's own additions: Host check (skipped for LAN peers when LAN
//! binding is on) → Origin/Referer rejection → IPv4 allowlist → scoped API-key
//! auth (constant-time; accepts BOTH `Authorization: Bearer` and `x-api-key`)
//! → per-key rate limit → global rate limit. The listener binds 127.0.0.1 by
//! default, 0.0.0.0 when the LAN interface is selected.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    body::Body,
    extract::{ConnectInfo, Extension, State},
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
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, watch};
use tower_http::limit::RequestBodyLimitLayer;

use cognia_remote_control::allowlist::ParsedAllowlist;
use cognia_remote_control::rate_limit::FixedWindowRateLimiter;

use super::api_keys::{self, GatewayApiKey};
use super::concurrency::{ConcurrencyLimiter, InFlightGuard, InFlightTracker, Slot};
use super::cooldown::{self, KeyCooldownMap};
use super::execute::{
    candidates_from_entries, embeddings_url, expand_key_pools, is_executable_protocol,
    record_key_success, resolve_candidates, rewrite_model, strip_request_fields, upstream_headers,
    upstream_url, Candidate, KeyRotationMap, SseDeframer,
};
use super::keyed_rate_limit::KeyedRateLimiter;
use super::session_key::derive_session_id;
use super::snapshot::{AliasSnapshot, RoutingSnapshot};
use super::translate::errors::{error_body, InboundFormat};
use super::translate::responses as responses_translate;
use super::translate::stream::{Direction, SseOut, StreamTranscoder};
use super::translate::{request_from_ir, request_to_ir, response_from_ir, response_to_ir};
use super::types::{BindInterface, GatewayConfig, GatewayError};
use super::DecisionRegistry;

pub const REQUEST_LOG_EVENT: &str = "gateway://request-log";
pub const REQUEST_OUTCOME_EVENT: &str = "gateway://request-outcome";
pub const DECIDE_EVENT: &str = "gateway://decide";

/// How long the gateway waits for the renderer's live routing decision before
/// falling back to the snapshot's pre-ordered candidates.
const DECIDE_TIMEOUT_MS: u64 = 800;

/// Chat bodies can be large (long histories); 16 MiB is generous without
/// being a memory hazard.
const BODY_LIMIT_BYTES: usize = 16 * 1024 * 1024;

/// How long an SSE pump tolerates total silence from the upstream before giving
/// up on the stream.
///
/// Streaming requests deliberately skip `apply_timeout` (a long generation is
/// not a hung one) and `reqwest` here sets only a connect timeout, so an
/// upstream that accepts the connection and then never writes or closes would
/// park the pump task forever — holding its concurrency slots AND its in-flight
/// tally. The tally drives least-busy routing, so a single hung stream would
/// steer traffic away from that provider permanently, with nothing in the UI to
/// explain it.
///
/// Five minutes of *zero bytes* is well past any real generation: both upstream
/// protocols emit keepalives (Anthropic `event: ping`, OpenAI incremental
/// chunks) far more often than that, so this fires only on a genuinely dead
/// connection.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone)]
pub struct ServerHandle {
    pub bound_port: u16,
    pub shutdown: watch::Sender<()>,
}

/// Hook fired on every request (post-middleware / on reject) for the durable
/// status counters (calls_total + last_call_at).
pub trait RequestObserver: Send + Sync + 'static {
    fn on_call(&self, route: &str, status: StatusCode, remote_ip: IpAddr);
}

/// Per-request context threaded from the auth middleware into the handlers so
/// they can enforce the matched key's model allowlist and stamp the durable
/// request log.
#[derive(Clone)]
struct ReqCtx {
    route: String,
    remote_ip: String,
    key_id: Option<String>,
    key_model_allowlist: Vec<String>,
    /// Client User-Agent, captured for the W1.3 fallback session key (all
    /// loopback callers share `remote_ip`, so the UA carries the distinctness).
    user_agent: String,
}

#[derive(Clone)]
struct AppState {
    app_handle: AppHandle,
    keys: Arc<RwLock<Vec<GatewayApiKey>>>,
    /// Request-time config (timeouts, retry policy, model exposure) — read live
    /// so an `update_config` applies without a restart.
    config: Arc<RwLock<GatewayConfig>>,
    allowlist: Arc<ParsedAllowlist>,
    rate_limiter: Arc<FixedWindowRateLimiter>,
    key_rate_limiter: Arc<KeyedRateLimiter>,
    /// Bind-time: whether the Host-loopback check is relaxed for LAN peers.
    bind_is_lan: bool,
    on_request: Arc<dyn RequestObserver>,
    snapshot: Arc<RwLock<Option<RoutingSnapshot>>>,
    decisions: Arc<DecisionRegistry>,
    /// Per-provider upstream key-pool rotation cursors (shared with the state).
    key_rotation: Arc<KeyRotationMap>,
    /// Per-upstream-key cooldown / permanent-disable state (W1.1 + W3.1).
    key_cooldown: Arc<KeyCooldownMap>,
    /// In-flight concurrency caps (W1.2).
    concurrency: Arc<ConcurrencyLimiter>,
    /// Per-provider in-flight tally, counted regardless of whether a cap is set.
    /// Serialized into each decide request so the renderer's `least-busy`
    /// strategy can see the load the gateway itself is generating.
    in_flight: Arc<InFlightTracker>,
    http: reqwest::Client,
}

#[allow(clippy::too_many_arguments)]
pub async fn spawn_server(
    app_handle: AppHandle,
    config: Arc<RwLock<GatewayConfig>>,
    keys: Arc<RwLock<Vec<GatewayApiKey>>>,
    snapshot: Arc<RwLock<Option<RoutingSnapshot>>>,
    decisions: Arc<DecisionRegistry>,
    key_rotation: Arc<KeyRotationMap>,
    key_cooldown: Arc<KeyCooldownMap>,
    concurrency: Arc<ConcurrencyLimiter>,
    on_request: Arc<dyn RequestObserver>,
) -> Result<ServerHandle, GatewayError> {
    // Snapshot the bind-time config (these apply only on start).
    let (port, bind_interface, allowlist_raw, rate_limit_per_min, connect_timeout_secs) = {
        let cfg = config.read();
        (
            cfg.port,
            cfg.bind_interface,
            cfg.allowlist.clone(),
            cfg.rate_limit_per_min,
            cfg.connect_timeout_secs,
        )
    };

    let parsed_allowlist =
        ParsedAllowlist::parse(&allowlist_raw).map_err(GatewayError::InvalidConfig)?;

    let bind_ip = match bind_interface {
        BindInterface::Loopback => IpAddr::V4(Ipv4Addr::LOCALHOST),
        BindInterface::Lan => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
    };
    let bind_addr = SocketAddr::new(bind_ip, port);
    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .map_err(|source| GatewayError::Bind {
            addr: bind_addr.to_string(),
            source,
        })?;
    let bound_port = listener
        .local_addr()
        .map_err(|source| GatewayError::Bind {
            addr: bind_addr.to_string(),
            source,
        })?
        .port();

    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(connect_timeout_secs.max(1) as u64))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    // Clone the key handle for the periodic quota-flush task before the
    // original moves into `AppState`.
    let keys_for_flush = keys.clone();
    let state = AppState {
        app_handle,
        keys,
        config,
        allowlist: Arc::new(parsed_allowlist),
        rate_limiter: Arc::new(FixedWindowRateLimiter::new(rate_limit_per_min)),
        key_rate_limiter: Arc::new(KeyedRateLimiter::new()),
        bind_is_lan: bind_interface.is_lan(),
        on_request,
        snapshot,
        decisions,
        key_rotation,
        key_cooldown,
        concurrency,
        // Transient by nature — nothing is in flight when a listener starts, so
        // this is built per-spawn rather than threaded through from the state.
        in_flight: Arc::new(InFlightTracker::default()),
        http,
    };

    let protected = Router::new()
        .route("/v1/models", get(list_models))
        .route("/v1/chat/completions", post(openai_chat))
        .route("/v1/messages", post(anthropic_messages))
        .route("/v1/embeddings", post(openai_embeddings))
        .route("/v1/responses", post(openai_responses))
        .layer(from_fn_with_state(state.clone(), middleware))
        .layer(RequestBodyLimitLayer::new(BODY_LIMIT_BYTES));

    let app = Router::new()
        .route("/healthz", get(healthz))
        // W3.4: real-relay upstream self-check (loopback-only). Probes each
        // resolved candidate through the actual resolve + upstream path.
        .route("/healthz/upstream", post(healthz_upstream))
        .merge(protected)
        .with_state(state);

    let (tx, mut rx) = watch::channel(());

    // Periodic key flush: per-key quota draw-down + last-used timestamps live on
    // the shared in-memory key list and are otherwise only persisted on stop.
    // A ~60s flush bounds crash-loss of quota accounting to one interval. Tied
    // to the same shutdown signal so it exits with the listener.
    let flush_keys = keys_for_flush;
    let mut flush_rx = tx.subscribe();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        interval.tick().await; // consume the immediate first tick
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    let _ = api_keys::save_keys(&flush_keys.read());
                }
                _ = flush_rx.changed() => break,
            }
        }
    });

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

/// Loopback-only upstream self-check (W3.4). Resolves the requested model to its
/// candidates through the REAL resolve path and fires one minimal (`max_tokens`
/// = 1) upstream call per candidate, reporting each candidate's ok/status/
/// latency. "Test is the production path": it exercises candidate resolution,
/// pool expansion (cooldown-aware), field stripping, headers and the timeout —
/// the same plumbing a live chat request walks — without the renderer-side
/// batch tester's separate code path.
#[derive(serde::Deserialize)]
struct UpstreamProbeRequest {
    model: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamProbeResult {
    provider_id: String,
    model_id: String,
    ok: bool,
    status: Option<u16>,
    latency_ms: u64,
    error: Option<String>,
}

async fn healthz_upstream(
    State(state): State<AppState>,
    ConnectInfo(connect_info): ConnectInfo<SocketAddr>,
    Json(req): Json<UpstreamProbeRequest>,
) -> Response {
    // A diagnostic that makes real (billable) upstream calls must never be
    // reachable off-box, even under LAN binding.
    if !connect_info.ip().is_loopback() {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "self-check is loopback-only" })),
        )
            .into_response();
    }
    let cfg = state.config.read().clone();
    let Some(snapshot) = state.snapshot.read().clone() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "no routing snapshot yet" })),
        )
            .into_response();
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    let candidates = expand_key_pools(
        resolve_candidates(&snapshot, &req.model),
        &state.key_rotation,
        &state.key_cooldown,
        now_ms,
    );
    if candidates.is_empty() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("model \"{}\" resolves to no candidate", req.model) })),
        )
            .into_response();
    }
    let mut results = Vec::new();
    for candidate in candidates.iter().take(cfg.attempt_budget(candidates.len())) {
        let started = Instant::now();
        // A probe is a real (billed) upstream call, so it counts toward the
        // in-flight tally that now drives least-busy routing — otherwise a
        // self-check would be invisible to the very decisions it runs beside.
        let _in_flight = state.in_flight.enter(&candidate.provider.id);
        let (ok, status, error) = probe_candidate(&state, &cfg, candidate).await;
        results.push(UpstreamProbeResult {
            provider_id: candidate.provider.id.clone(),
            model_id: candidate.model_id.clone(),
            ok,
            status,
            latency_ms: started.elapsed().as_millis() as u64,
            error,
        });
    }
    Json(json!({ "model": req.model, "results": results })).into_response()
}

/// Fire one minimal upstream call for a candidate and classify the outcome.
async fn probe_candidate(
    state: &AppState,
    cfg: &GatewayConfig,
    candidate: &Candidate,
) -> (bool, Option<u16>, Option<String>) {
    let mut body = minimal_probe_body(&candidate.provider.protocol, &candidate.model_id);
    strip_request_fields(
        &mut body,
        &candidate.provider.id,
        &cfg.stripped_request_fields,
        &cfg.field_strip_allow,
    );
    let url = upstream_url(&candidate.provider.protocol, &candidate.provider.base_url);
    let mut rb = apply_timeout(state.http.post(&url).json(&body), cfg);
    for (name, value) in upstream_headers(
        &candidate.provider.protocol,
        candidate.provider.api_key.as_deref(),
    ) {
        rb = rb.header(name, value);
    }
    match rb.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if status < 400 {
                (true, Some(status), None)
            } else {
                let text = resp.text().await.unwrap_or_default();
                (
                    false,
                    Some(status),
                    Some(text.chars().take(200).collect::<String>()),
                )
            }
        }
        Err(err) => (false, None, Some(format!("connect error: {err}"))),
    }
}

/// A one-token probe body in the candidate's wire protocol.
fn minimal_probe_body(protocol: &str, model_id: &str) -> Value {
    let mut body = json!({
        "model": model_id,
        "max_tokens": 1,
        "messages": [{ "role": "user", "content": "ping" }],
    });
    if protocol != "anthropic" {
        // OpenAI-compatible chat completions don't require max_tokens, but a
        // 1-token cap keeps the probe cheap; leave the shape otherwise shared.
        body["max_tokens"] = json!(1);
    }
    body
}

// ---- middleware -------------------------------------------------------------

/// Accept only loopback Host headers (DNS-rebinding mitigation).
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
    mut request: axum::extract::Request,
    next: Next,
) -> Response {
    let route = request.uri().path().to_string();
    let remote_ip = connect_info.ip();

    let reject = |status: StatusCode, message: &str, key_id: Option<String>| -> Response {
        state.on_request.on_call(&route, status, remote_ip);
        emit_request_log(
            &state.app_handle,
            &route,
            &remote_ip.to_string(),
            key_id.as_deref(),
            None,
            None,
            status.as_u16(),
            0,
            None,
            None,
            Some(message),
            false,
        );
        (status, Json(json!({ "error": { "message": message } }))).into_response()
    };

    // 0. Host-header allowlist. Loopback binding requires a loopback Host; LAN
    // binding accepts LAN peers whose Host is this machine's LAN authority.
    // The cross-origin rejection below still blocks browser DNS-rebinding in
    // both modes (real CLI clients never send Origin/Referer).
    if !state.bind_is_lan {
        let host_ok = headers
            .get(axum::http::header::HOST)
            .and_then(|v| v.to_str().ok())
            .map(host_is_local)
            .unwrap_or(false);
        if !host_ok {
            return reject(StatusCode::FORBIDDEN, "invalid host", None);
        }
    }
    if headers.contains_key(axum::http::header::ORIGIN)
        || headers.contains_key(axum::http::header::REFERER)
    {
        return reject(StatusCode::FORBIDDEN, "cross-origin not allowed", None);
    }

    // 1. IPv4 allowlist (the real LAN gate — defaults loopback-only).
    let canonical = match remote_ip {
        IpAddr::V4(v4) => v4,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4,
            None => return reject(StatusCode::FORBIDDEN, "ipv6 not supported", None),
        },
    };
    if !state.allowlist.contains(canonical) {
        return reject(StatusCode::FORBIDDEN, "origin not allowed", None);
    }

    // 2. Scoped API-key auth — constant-time, dual header support.
    let Some(supplied) = supplied_token(&headers) else {
        return reject(
            StatusCode::UNAUTHORIZED,
            "missing credentials (Authorization: Bearer or x-api-key)",
            None,
        );
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    let matched = {
        let keys = state.keys.read();
        api_keys::match_index(&keys, supplied, now_ms).map(|i| {
            let k = &keys[i];
            (
                i,
                k.id.clone(),
                k.model_allowlist.clone(),
                k.rate_limit_per_min,
                k.is_over_quota(),
            )
        })
    };
    let Some((idx, key_id, key_model_allowlist, key_rate_limit, over_quota)) = matched else {
        return reject(StatusCode::UNAUTHORIZED, "invalid token", None);
    };

    // Quota gate: a key that has drawn down its entire token budget is rejected
    // before any upstream work (drawn down after each request; see `log_success`).
    if over_quota {
        return reject(
            StatusCode::TOO_MANY_REQUESTS,
            "insufficient_quota: key token quota exhausted",
            Some(key_id),
        );
    }

    // Bump last-used on the shared key list (persisted on next save/stop).
    if let Some(k) = state.keys.write().get_mut(idx) {
        k.last_used_at_ms = Some(now_ms);
    }

    // 3. Per-key rate limit (only when the key sets its own budget).
    if let Some(limit) = key_rate_limit {
        if !state.key_rate_limiter.try_acquire(&key_id, limit) {
            return reject(
                StatusCode::TOO_MANY_REQUESTS,
                "per-key rate limit exceeded",
                Some(key_id.clone()),
            );
        }
    }

    // 4. Global rate limit.
    if !state.rate_limiter.try_acquire() {
        return reject(
            StatusCode::TOO_MANY_REQUESTS,
            "rate limit exceeded",
            Some(key_id.clone()),
        );
    }

    let user_agent = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    request.extensions_mut().insert(ReqCtx {
        route: route.clone(),
        remote_ip: remote_ip.to_string(),
        key_id: Some(key_id),
        key_model_allowlist,
        user_agent,
    });

    let response = next.run(request).await;
    state
        .on_request
        .on_call(&route, response.status(), remote_ip);
    response
}

// ---- /v1/models -------------------------------------------------------------

async fn list_models(State(state): State<AppState>, Extension(ctx): Extension<ReqCtx>) -> Response {
    let snapshot = state.snapshot.read().clone();
    let Some(snapshot) = snapshot else {
        return no_snapshot_error(InboundFormat::OpenAiChat);
    };
    let cfg = state.config.read().clone();

    // A model is listed only if the gateway exposes it AND the calling key may
    // use it AND the gateway can actually execute it. That last clause is why
    // `resolve_candidates` is consulted for aliases below: without it a provider
    // on a non-executable protocol (anything but openai / anthropic — see
    // `is_executable_protocol`) was advertised here and then 404'd on the very
    // next /v1/chat/completions call.
    let visible = |model: &str| -> bool { cfg.model_is_exposed(model) && ctx_allows(&ctx, model) };

    let data = listable_models(&snapshot, cfg.hide_raw_provider_models, &visible);
    Json(json!({ "object": "list", "data": data })).into_response()
}

/// The `/v1/models` payload for a caller, given a per-model visibility
/// predicate. Pure (no `AppHandle`) so the executability rule is unit-testable —
/// this crate does not use `tauri::test::mock_app`.
fn listable_models(
    snapshot: &RoutingSnapshot,
    hide_raw_provider_models: bool,
    visible: &dyn Fn(&str) -> bool,
) -> Vec<Value> {
    // An alias is executable if ANY of its entries points at an enabled provider
    // on a protocol the gateway can drive. Deliberately not `resolve_candidates`:
    // that clones every matching `ProviderSnapshot` — credentials included —
    // onto the heap just to answer a yes/no, once per alias per request.
    let alias_is_executable = |alias: &AliasSnapshot| -> bool {
        alias.entries.iter().any(|entry| {
            snapshot
                .provider(&entry.provider_id)
                .is_some_and(|p| is_executable_protocol(&p.protocol))
        })
    };

    let mut data: Vec<Value> = Vec::new();
    for alias in &snapshot.aliases {
        if visible(&alias.alias) && alias_is_executable(alias) {
            data.push(json!({
                "id": alias.alias,
                "object": "model",
                "owned_by": "cognia-routing",
            }));
        }
    }
    if !hide_raw_provider_models {
        for provider in &snapshot.providers {
            if !provider.enabled || !is_executable_protocol(&provider.protocol) {
                continue;
            }
            for model in &provider.models {
                if visible(model) {
                    data.push(json!({
                        "id": model,
                        "object": "model",
                        "owned_by": provider.id,
                    }));
                }
            }
        }
    }
    data
}

fn ctx_allows(ctx: &ReqCtx, model: &str) -> bool {
    ctx.key_model_allowlist.is_empty() || ctx.key_model_allowlist.iter().any(|m| m == model)
}

// ---- chat handlers ----------------------------------------------------------

async fn openai_chat(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    Json(body): Json<Value>,
) -> Response {
    handle_chat(state, ctx, InboundFormat::OpenAiChat, body).await
}

async fn anthropic_messages(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    Json(body): Json<Value>,
) -> Response {
    handle_chat(state, ctx, InboundFormat::AnthropicMessages, body).await
}

// ---- embeddings handler -----------------------------------------------------

async fn openai_embeddings(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    Json(body): Json<Value>,
) -> Response {
    let _perf = cognia_instrument::guard("gateway.embeddings");
    let format = InboundFormat::OpenAiChat;
    let cfg = state.config.read().clone();
    let snapshot = state.snapshot.read().clone();
    let Some(snapshot) = snapshot else {
        return logged_error(
            &state,
            &ctx,
            format,
            StatusCode::SERVICE_UNAVAILABLE,
            "overloaded_error",
            "no routing snapshot yet — open the Cognia window once so it can publish providers",
            None,
        );
    };

    let Some(model) = body["model"].as_str().map(|s| s.to_string()) else {
        return logged_error(
            &state,
            &ctx,
            format,
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "model is required",
            None,
        );
    };
    if body.get("input").map(Value::is_null).unwrap_or(true) {
        return logged_error(
            &state,
            &ctx,
            format,
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "input is required",
            Some(&model),
        );
    }
    if let Some(resp) = exposure_guard(&state, &ctx, format, &cfg, &model) {
        return resp;
    }

    // W1.2: gateway-key in-flight cap. Embeddings responses are always buffered,
    // so the slot lives in this handler's scope — no SSE-pump hand-off needed.
    // The key is byte-identical to the chat path's so a single configured cap is
    // one shared budget across endpoints, not one budget per endpoint.
    let wait = Duration::from_millis(cfg.concurrency_wait_ms as u64);
    let _gw_slot = match state
        .concurrency
        .acquire(&gw_gate_key(&ctx), cfg.max_concurrent_per_key, wait)
        .await
    {
        Ok(slot) => slot,
        Err(()) => return concurrency_rejected(&state, &ctx, format, Some(&model)),
    };

    // Only OpenAI-compatible providers expose `/embeddings`. Expand each
    // provider's upstream key pool so a rate-limited account fails over, and
    // skip pooled keys the upstream just parked (W1.1) / permanently disabled
    // (W3.1) — the same cooldown state the chat path records.
    let now_ms = chrono::Utc::now().timestamp_millis();
    let all = resolve_candidates(&snapshot, &model);
    let candidates: Vec<Candidate> = expand_key_pools(
        all.into_iter()
            .filter(|c| c.provider.protocol == "openai")
            .collect(),
        &state.key_rotation,
        &state.key_cooldown,
        now_ms,
    );
    if candidates.is_empty() {
        return logged_error(
            &state,
            &ctx,
            format,
            StatusCode::NOT_FOUND,
            "invalid_request_error",
            &format!("embeddings model \"{model}\" matches no enabled OpenAI-compatible provider"),
            Some(&model),
        );
    }

    let mut failures: Vec<String> = Vec::new();
    for candidate in candidates.iter().take(cfg.attempt_budget(candidates.len())) {
        let started = Instant::now();

        // W1.2: per-upstream-key cap for THIS attempt; released when the loop
        // iteration ends (failover) or the handler returns (success).
        let _up_slot = match state
            .concurrency
            .acquire(
                &up_gate_key(candidate),
                cfg.max_concurrent_per_upstream_key,
                wait,
            )
            .await
        {
            Ok(slot) => slot,
            Err(()) => {
                failures.push(format!(
                    "{}: upstream concurrency limit reached",
                    candidate.provider.id
                ));
                continue;
            }
        };
        // Counted whether or not a cap is set — this is the least-busy signal.
        let _in_flight = state.in_flight.enter(&candidate.provider.id);

        let mut upstream_body = rewrite_model(&body, &candidate.model_id);
        strip_request_fields(
            &mut upstream_body,
            &candidate.provider.id,
            &cfg.stripped_request_fields,
            &cfg.field_strip_allow,
        );
        let url = embeddings_url(&candidate.provider.base_url);
        let mut req = state.http.post(&url).json(&upstream_body);
        req = apply_timeout(req, &cfg);
        for (name, value) in upstream_headers("openai", candidate.provider.api_key.as_deref()) {
            req = req.header(name, value);
        }

        let resp = match req.send().await {
            Ok(resp) => resp,
            Err(err) => {
                let message = format!("connect error: {err}");
                // Embeddings traffic trains the same health / breaker / cost
                // stores as chat. `session_id` is None: embeddings must never
                // pin a chat session's affinity (same rule as /v1/responses).
                emit_outcome(
                    &state.app_handle,
                    candidate,
                    false,
                    started,
                    None,
                    Some(&message),
                    None,
                    None,
                );
                failures.push(format!("{}: {message}", candidate.provider.id));
                continue;
            }
        };

        let status = resp.status().as_u16();
        if status >= 400 {
            let headers = resp.headers().clone();
            let retry_after = headers.get("retry-after").and_then(|v| v.to_str().ok());
            let unified = headers
                .get("anthropic-ratelimit-unified-reset")
                .and_then(|v| v.to_str().ok());
            let text = resp.text().await.unwrap_or_default();
            // W1.1 + W3.1: park / disable the pooled key so later requests (any
            // endpoint) stop re-selecting it.
            let retry_after_ms = record_upstream_cooldown(
                &state,
                &cfg,
                candidate,
                status,
                retry_after,
                unified,
                &text,
                now_ms,
            );
            let message = format!(
                "HTTP {status}: {}",
                text.chars().take(500).collect::<String>()
            );
            // Forward the cooldown window so the renderer breaker gets the same
            // dynamic backoff the chat path already feeds it.
            emit_outcome(
                &state.app_handle,
                candidate,
                false,
                started,
                None,
                Some(&message),
                retry_after_ms,
                None,
            );
            if cfg.should_retry(status) {
                failures.push(format!("{}: {message}", candidate.provider.id));
                continue;
            }
            return logged_error(
                &state,
                &ctx,
                format,
                StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST),
                "invalid_request_error",
                &message,
                Some(&model),
            );
        }

        let upstream: Value = match resp.json().await {
            Ok(value) => value,
            Err(err) => {
                // A 200 the provider can't serialize is still the provider's
                // fault — the chat path already reports this (see
                // `buffered_response`), so embeddings must too or the breaker
                // never sees a provider that reliably returns garbage.
                let message = format!("invalid upstream JSON: {err}");
                emit_outcome(
                    &state.app_handle,
                    candidate,
                    false,
                    started,
                    None,
                    Some(&message),
                    None,
                    None,
                );
                return logged_error(
                    &state,
                    &ctx,
                    format,
                    StatusCode::BAD_GATEWAY,
                    "api_error",
                    &message,
                    Some(&model),
                );
            }
        };
        // Embeddings report only prompt tokens (no completion side).
        let input_tokens = upstream["usage"]["prompt_tokens"]
            .as_u64()
            .or_else(|| upstream["usage"]["total_tokens"].as_u64());
        emit_outcome(
            &state.app_handle,
            candidate,
            true,
            started,
            Some((input_tokens, None)),
            None,
            None,
            None,
        );
        log_success(
            &state,
            &ctx,
            &model,
            candidate,
            started.elapsed().as_millis() as u64,
            input_tokens,
            None,
            false,
        );
        return Json(upstream).into_response();
    }

    all_failed(&state, &ctx, format, &model, &failures)
}

// ---- responses handler ------------------------------------------------------

async fn openai_responses(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    Json(body): Json<Value>,
) -> Response {
    let _perf = cognia_instrument::guard("gateway.responses");
    let format = InboundFormat::OpenAiChat;
    let cfg = state.config.read().clone();

    if let Some(reason) = responses_translate::unsupported_feature(&body) {
        return logged_error(
            &state,
            &ctx,
            format,
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            &reason,
            None,
        );
    }

    let snapshot = state.snapshot.read().clone();
    let Some(snapshot) = snapshot else {
        return logged_error(
            &state,
            &ctx,
            format,
            StatusCode::SERVICE_UNAVAILABLE,
            "overloaded_error",
            "no routing snapshot yet — open the Cognia window once so it can publish providers",
            None,
        );
    };

    let ir = match responses_translate::request_to_ir(&body) {
        Ok(ir) => ir,
        Err(err) => {
            return logged_error(
                &state,
                &ctx,
                format,
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
                &err.reason,
                None,
            )
        }
    };
    let model = ir.model.clone();
    if let Some(resp) = exposure_guard(&state, &ctx, format, &cfg, &model) {
        return resp;
    }

    // W1.2: gateway-key in-flight cap. `/v1/responses` rejects `stream` up front
    // (see `responses_translate::unsupported_feature`), so the slot is always
    // scope-held. Key matches the chat path's — one shared budget.
    let wait = Duration::from_millis(cfg.concurrency_wait_ms as u64);
    let _gw_slot = match state
        .concurrency
        .acquire(&gw_gate_key(&ctx), cfg.max_concurrent_per_key, wait)
        .await
    {
        Ok(slot) => slot,
        Err(()) => return concurrency_rejected(&state, &ctx, format, Some(&model)),
    };

    let now_ms = chrono::Utc::now().timestamp_millis();
    let candidates = expand_key_pools(
        resolve_candidates(&snapshot, &model),
        &state.key_rotation,
        &state.key_cooldown,
        now_ms,
    );
    if candidates.is_empty() {
        return logged_error(
            &state,
            &ctx,
            format,
            StatusCode::NOT_FOUND,
            "invalid_request_error",
            &format!(
                "model \"{model}\" matches no alias, provider:model, or enabled provider model"
            ),
            Some(&model),
        );
    }

    let mut failures: Vec<String> = Vec::new();
    for candidate in candidates.iter().take(cfg.attempt_budget(candidates.len())) {
        let started = Instant::now();

        // W1.2: per-upstream-key cap for THIS attempt.
        let _up_slot = match state
            .concurrency
            .acquire(
                &up_gate_key(candidate),
                cfg.max_concurrent_per_upstream_key,
                wait,
            )
            .await
        {
            Ok(slot) => slot,
            Err(()) => {
                failures.push(format!(
                    "{}: upstream concurrency limit reached",
                    candidate.provider.id
                ));
                continue;
            }
        };
        let _in_flight = state.in_flight.enter(&candidate.provider.id);

        let mut candidate_ir = ir.clone();
        candidate_ir.model = candidate.model_id.clone();
        let mut upstream_body = match request_from_ir(&candidate.provider.protocol, &candidate_ir) {
            Ok(body) => body,
            Err(err) => {
                failures.push(format!("{}: {}", candidate.provider.id, err.reason));
                continue;
            }
        };
        strip_request_fields(
            &mut upstream_body,
            &candidate.provider.id,
            &cfg.stripped_request_fields,
            &cfg.field_strip_allow,
        );

        let url = upstream_url(&candidate.provider.protocol, &candidate.provider.base_url);
        let mut req = state.http.post(&url).json(&upstream_body);
        req = apply_timeout(req, &cfg);
        for (name, value) in upstream_headers(
            &candidate.provider.protocol,
            candidate.provider.api_key.as_deref(),
        ) {
            req = req.header(name, value);
        }

        let resp = match req.send().await {
            Ok(resp) => resp,
            Err(err) => {
                let message = format!("connect error: {err}");
                // The success path already emitted; the failure paths did not,
                // so a provider failing every Responses call never opened its
                // breaker. `session_id` stays None (no chat-affinity key here).
                emit_outcome(
                    &state.app_handle,
                    candidate,
                    false,
                    started,
                    None,
                    Some(&message),
                    None,
                    None,
                );
                failures.push(format!("{}: {message}", candidate.provider.id));
                continue;
            }
        };

        let status = resp.status().as_u16();
        if status >= 400 {
            let headers = resp.headers().clone();
            let retry_after = headers.get("retry-after").and_then(|v| v.to_str().ok());
            let unified = headers
                .get("anthropic-ratelimit-unified-reset")
                .and_then(|v| v.to_str().ok());
            let text = resp.text().await.unwrap_or_default();
            let retry_after_ms = record_upstream_cooldown(
                &state,
                &cfg,
                candidate,
                status,
                retry_after,
                unified,
                &text,
                now_ms,
            );
            let message = format!(
                "HTTP {status}: {}",
                text.chars().take(500).collect::<String>()
            );
            emit_outcome(
                &state.app_handle,
                candidate,
                false,
                started,
                None,
                Some(&message),
                retry_after_ms,
                None,
            );
            if cfg.should_retry(status) {
                failures.push(format!("{}: {message}", candidate.provider.id));
                continue;
            }
            return logged_error(
                &state,
                &ctx,
                format,
                StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST),
                "invalid_request_error",
                &message,
                Some(&model),
            );
        }

        let upstream: Value = match resp.json().await {
            Ok(value) => value,
            Err(err) => {
                // Same rule as the chat path: an unserializable 200 is a
                // provider-health signal, not a client error.
                let message = format!("invalid upstream JSON: {err}");
                emit_outcome(
                    &state.app_handle,
                    candidate,
                    false,
                    started,
                    None,
                    Some(&message),
                    None,
                    None,
                );
                return logged_error(
                    &state,
                    &ctx,
                    format,
                    StatusCode::BAD_GATEWAY,
                    "api_error",
                    &message,
                    Some(&model),
                );
            }
        };
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
                    None,
                    // Responses API has no chat-affinity session key.
                    None,
                );
                log_success(
                    &state,
                    &ctx,
                    &model,
                    candidate,
                    started.elapsed().as_millis() as u64,
                    Some(ir_resp.usage.input_tokens),
                    Some(ir_resp.usage.output_tokens),
                    false,
                );
                let created = chrono::Utc::now().timestamp();
                return Json(responses_translate::response_from_ir(
                    &ir_resp, &model, created,
                ))
                .into_response();
            }
            Err(err) => {
                // The provider answered 200 with a body we can't read as a
                // response — a provider-health signal, so it is reported even
                // though the walk continues to the next candidate. (A
                // `request_from_ir` failure above is NOT reported: that is the
                // gateway's own translation limit, not the provider's fault —
                // the chat path draws the same line.)
                let message = format!("unreadable upstream response: {}", err.reason);
                emit_outcome(
                    &state.app_handle,
                    candidate,
                    false,
                    started,
                    None,
                    Some(&message),
                    None,
                    None,
                );
                failures.push(format!("{}: {}", candidate.provider.id, err.reason));
                continue;
            }
        }
    }

    all_failed(&state, &ctx, format, &model, &failures)
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

/// Emit a durable request-log row for a terminal error and return the inbound
/// error response in one call.
#[allow(clippy::too_many_arguments)]
fn logged_error(
    state: &AppState,
    ctx: &ReqCtx,
    format: InboundFormat,
    status: StatusCode,
    err_code: &str,
    message: &str,
    model: Option<&str>,
) -> Response {
    emit_request_log_ctx(
        &state.app_handle,
        ctx,
        model,
        None,
        status.as_u16(),
        0,
        None,
        None,
        Some(message),
        false,
    );
    (status, Json(error_body(format, err_code, message))).into_response()
}

/// The "every candidate failed" 502 terminal.
fn all_failed(
    state: &AppState,
    ctx: &ReqCtx,
    format: InboundFormat,
    model: &str,
    failures: &[String],
) -> Response {
    let message = format!("every candidate failed: {}", failures.join(" | "));
    emit_request_log_ctx(
        &state.app_handle,
        ctx,
        Some(model),
        None,
        StatusCode::BAD_GATEWAY.as_u16(),
        0,
        None,
        None,
        Some(&message),
        false,
    );
    (
        StatusCode::BAD_GATEWAY,
        Json(error_body(format, "api_error", &message)),
    )
        .into_response()
}

/// Enforce gateway model exposure + the calling key's allowlist. Returns
/// `Some(response)` when the model is denied.
fn exposure_guard(
    state: &AppState,
    ctx: &ReqCtx,
    format: InboundFormat,
    cfg: &GatewayConfig,
    model: &str,
) -> Option<Response> {
    if !cfg.model_is_exposed(model) {
        return Some(logged_error(
            state,
            ctx,
            format,
            StatusCode::NOT_FOUND,
            "invalid_request_error",
            &format!("model \"{model}\" is not exposed by this gateway"),
            Some(model),
        ));
    }
    if !ctx_allows(ctx, model) {
        return Some(logged_error(
            state,
            ctx,
            format,
            StatusCode::FORBIDDEN,
            "invalid_request_error",
            &format!("this key is not permitted to use model \"{model}\""),
            Some(model),
        ));
    }
    None
}

/// Apply the configured total timeout to a NON-streaming upstream request.
fn apply_timeout(req: reqwest::RequestBuilder, cfg: &GatewayConfig) -> reqwest::RequestBuilder {
    if cfg.request_timeout_secs > 0 {
        req.timeout(Duration::from_secs(cfg.request_timeout_secs as u64))
    } else {
        req
    }
}

/// Parse an upstream error response's account-level cooldown signal, record it
/// against the pooled key (temporary cooldown or permanent disable — W1.1 +
/// W3.1), and return the cooldown window (ms) to surface on the outcome event
/// (the renderer breaker's dynamic-cooldown path consumes it). A no-op for
/// keyless / single-key providers with no pooled key to park.
#[allow(clippy::too_many_arguments)]
fn record_upstream_cooldown(
    state: &AppState,
    cfg: &GatewayConfig,
    candidate: &Candidate,
    status: u16,
    retry_after: Option<&str>,
    unified_reset: Option<&str>,
    body: &str,
    now_ms: i64,
) -> Option<i64> {
    let api_key = candidate.provider.api_key.as_deref()?;
    if let Some(reason) = cooldown::permanent_failure_reason(status, body, &cfg.disable_keywords) {
        cooldown::record_permanent(
            &state.key_cooldown,
            &candidate.provider.id,
            api_key,
            &reason,
        );
        return None;
    }
    let ms = cooldown::cooldown_ms_from_headers(
        status,
        retry_after,
        unified_reset,
        cfg.cooldown_fallback_secs,
        cfg.overload_cooldown_secs,
        now_ms,
    )?;
    cooldown::record_cooldown(
        &state.key_cooldown,
        &candidate.provider.id,
        api_key,
        now_ms + ms,
        &format!("HTTP {status}"),
    );
    Some(ms)
}

/// Concurrency-gate key for the calling gateway API key (W1.2).
///
/// Chat, embeddings and responses MUST derive this identically — a single
/// configured `maxConcurrentPerKey` is one budget shared across every endpoint,
/// and three hand-copied `format!` literals would silently split it into three.
fn gw_gate_key(ctx: &ReqCtx) -> String {
    format!("gw:{}", ctx.key_id.as_deref().unwrap_or("_"))
}

/// Concurrency-gate key for one pooled upstream account (W1.2). Same
/// shared-budget invariant as [`gw_gate_key`].
///
/// Note this embeds the upstream secret and therefore must never be serialized;
/// the renderer-facing in-flight tally keys on `provider.id` alone.
fn up_gate_key(candidate: &Candidate) -> String {
    format!(
        "up:{}:{}",
        candidate.provider.id,
        candidate.provider.api_key.as_deref().unwrap_or("")
    )
}

/// The "in-flight concurrency cap reached" 429 terminal (W1.2).
fn concurrency_rejected(
    state: &AppState,
    ctx: &ReqCtx,
    format: InboundFormat,
    model: Option<&str>,
) -> Response {
    logged_error(
        state,
        ctx,
        format,
        StatusCode::TOO_MANY_REQUESTS,
        "rate_limit_error",
        "concurrency limit reached — too many in-flight requests for this key",
        model,
    )
}

/// Ask the renderer for a live routing decision (full engine).
async fn live_decision(
    state: &AppState,
    snapshot: &RoutingSnapshot,
    model: &str,
    body: &Value,
    session_id: &str,
) -> Option<Vec<Candidate>> {
    let request_id = format!("gwd_{}", uuid::Uuid::new_v4().simple());
    let (tx, rx) = oneshot::channel::<Vec<super::snapshot::SnapshotEntry>>();
    state.decisions.lock().insert(request_id.clone(), tx);

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
        json!({
            "requestId": request_id,
            "model": model,
            "promptText": prompt_text,
            "sessionId": session_id,
            // W1.2b: gateway-generated load, per provider. This runs BEFORE the
            // candidate walk, so the snapshot is exactly "what other requests
            // are in flight" — the signal the renderer's least-busy strategy
            // otherwise reads as a constant zero for gateway traffic.
            "inFlight": state.in_flight.snapshot(),
        }),
    );
    if emitted.is_err() {
        state.decisions.lock().remove(&request_id);
        return None;
    }

    let entries = match tokio::time::timeout(Duration::from_millis(DECIDE_TIMEOUT_MS), rx).await {
        Ok(Ok(entries)) if !entries.is_empty() => entries,
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

async fn handle_chat(state: AppState, ctx: ReqCtx, format: InboundFormat, body: Value) -> Response {
    let _perf = cognia_instrument::guard("gateway.chat");
    let cfg = state.config.read().clone();
    let snapshot = state.snapshot.read().clone();
    let Some(snapshot) = snapshot else {
        return logged_error(
            &state,
            &ctx,
            format,
            StatusCode::SERVICE_UNAVAILABLE,
            "overloaded_error",
            "no routing snapshot yet — open the Cognia window once so it can publish providers",
            None,
        );
    };

    let Some(model) = body["model"].as_str().map(|s| s.to_string()) else {
        return logged_error(
            &state,
            &ctx,
            format,
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "model is required",
            None,
        );
    };
    if let Some(resp) = exposure_guard(&state, &ctx, format, &cfg, &model) {
        return resp;
    }
    let stream = body["stream"].as_bool().unwrap_or(false);
    let now_ms = chrono::Utc::now().timestamp_millis();

    // W1.3: derive a stable affinity key for this request and thread it through
    // the live decision (so the routing engine's session-affinity filter sticks
    // this conversation to one deployment) and the outcome event (so a
    // successful turn pins it — the same machinery the chat plane already uses).
    let session_id = derive_session_id(
        &body,
        &ctx.remote_ip,
        &ctx.user_agent,
        ctx.key_id.as_deref().unwrap_or(""),
    );

    // W1.2: gateway-key in-flight cap for the whole request. Held until the
    // response completes — moved into the streaming task below so it releases at
    // stream end, not at this handler's return.
    let wait = Duration::from_millis(cfg.concurrency_wait_ms as u64);
    let gw_slot = match state
        .concurrency
        .acquire(&gw_gate_key(&ctx), cfg.max_concurrent_per_key, wait)
        .await
    {
        Ok(slot) => slot,
        Err(()) => return concurrency_rejected(&state, &ctx, format, Some(&model)),
    };

    let candidates = expand_key_pools(
        match live_decision(&state, &snapshot, &model, &body, &session_id).await {
            Some(candidates) => candidates,
            None => resolve_candidates(&snapshot, &model),
        },
        &state.key_rotation,
        &state.key_cooldown,
        now_ms,
    );
    if candidates.is_empty() {
        return logged_error(
            &state,
            &ctx,
            format,
            StatusCode::NOT_FOUND,
            "invalid_request_error",
            &format!(
                "model \"{model}\" matches no alias, provider:model, or enabled provider model"
            ),
            Some(&model),
        );
    }

    let needs_translation = candidates
        .iter()
        .any(|c| c.provider.protocol != format.protocol_name());
    let ir = if needs_translation {
        match request_to_ir(format, &body) {
            Ok(ir) => Some(ir),
            Err(err) => {
                return logged_error(
                    &state,
                    &ctx,
                    format,
                    StatusCode::BAD_REQUEST,
                    "invalid_request_error",
                    &err.reason,
                    Some(&model),
                )
            }
        }
    } else {
        None
    };

    let mut failures: Vec<String> = Vec::new();
    for candidate in candidates.iter().take(cfg.attempt_budget(candidates.len())) {
        let started = Instant::now();

        // W1.2: per-upstream-key in-flight cap for THIS attempt. On failover the
        // slot drops here (released); on success it is kept alive (buffered) or
        // moved into the streaming task.
        let up_slot = match state
            .concurrency
            .acquire(
                &up_gate_key(candidate),
                cfg.max_concurrent_per_upstream_key,
                wait,
            )
            .await
        {
            Ok(slot) => slot,
            Err(()) => {
                failures.push(format!(
                    "{}: upstream concurrency limit reached",
                    candidate.provider.id
                ));
                continue;
            }
        };
        // Counted whether or not a cap is set. Tracks `up_slot`'s lifetime
        // exactly — including the move into the streaming task below.
        let in_flight = state.in_flight.enter(&candidate.provider.id);

        let passthrough = candidate.provider.protocol == format.protocol_name();
        let mut upstream_body = if passthrough {
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
        // W3.2: strip client-supplied billing/privacy/behaviour toggles from the
        // outbound body (both passthrough AND translated paths).
        strip_request_fields(
            &mut upstream_body,
            &candidate.provider.id,
            &cfg.stripped_request_fields,
            &cfg.field_strip_allow,
        );

        let url = upstream_url(&candidate.provider.protocol, &candidate.provider.base_url);
        let mut req = state.http.post(&url).json(&upstream_body);
        if !stream {
            req = apply_timeout(req, &cfg);
        }
        for (name, value) in upstream_headers(
            &candidate.provider.protocol,
            candidate.provider.api_key.as_deref(),
        ) {
            req = req.header(name, value);
        }

        let resp = match req.send().await {
            Ok(resp) => resp,
            Err(err) => {
                let message = format!("connect error: {err}");
                emit_outcome(
                    &state.app_handle,
                    candidate,
                    false,
                    started,
                    None,
                    Some(&message),
                    None,
                    Some(&session_id),
                );
                failures.push(format!("{}: {message}", candidate.provider.id));
                continue;
            }
        };

        let status = resp.status().as_u16();
        if status >= 400 {
            let headers = resp.headers().clone();
            let retry_after = headers.get("retry-after").and_then(|v| v.to_str().ok());
            let unified = headers
                .get("anthropic-ratelimit-unified-reset")
                .and_then(|v| v.to_str().ok());
            let text = resp.text().await.unwrap_or_default();
            // W1.1 + W3.1: park (or permanently disable) the pooled key and get
            // the cooldown window to forward to the renderer breaker.
            let retry_after_ms = record_upstream_cooldown(
                &state,
                &cfg,
                candidate,
                status,
                retry_after,
                unified,
                &text,
                now_ms,
            );
            let mut message = format!("HTTP {status}");
            if let Some(ra) = retry_after {
                message.push_str(&format!(" retry-after: {ra}"));
            }
            message.push_str(&format!(": {}", text.chars().take(500).collect::<String>()));
            emit_outcome(
                &state.app_handle,
                candidate,
                false,
                started,
                None,
                Some(&message),
                retry_after_ms,
                Some(&session_id),
            );
            if cfg.should_retry(status) {
                failures.push(format!("{}: {message}", candidate.provider.id));
                continue;
            }
            return logged_error(
                &state,
                &ctx,
                format,
                StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST),
                "invalid_request_error",
                &message,
                Some(&model),
            );
        }

        if stream {
            return stream_response(
                state, ctx, format, candidate, resp, started, &model, session_id, gw_slot, up_slot,
                in_flight,
            )
            .await;
        }
        // Buffered path: `gw_slot` / `up_slot` / `in_flight` carry Drop glue, so
        // they release only when this handler returns — i.e. after the awaited
        // response below completes — holding the concurrency slots and the
        // in-flight tally for the whole non-streaming request without being
        // passed down.
        return buffered_response(
            state,
            ctx,
            format,
            candidate,
            resp,
            started,
            passthrough,
            &model,
            &session_id,
        )
        .await;
    }

    all_failed(&state, &ctx, format, &model, &failures)
}

#[allow(clippy::too_many_arguments)]
async fn buffered_response(
    state: AppState,
    ctx: ReqCtx,
    format: InboundFormat,
    candidate: &Candidate,
    resp: reqwest::Response,
    started: Instant,
    passthrough: bool,
    model: &str,
    session_id: &str,
) -> Response {
    let upstream: Value = match resp.json().await {
        Ok(v) => v,
        Err(err) => {
            let message = format!("invalid upstream JSON: {err}");
            emit_outcome(
                &state.app_handle,
                candidate,
                false,
                started,
                None,
                Some(&message),
                None,
                Some(session_id),
            );
            return logged_error(
                &state,
                &ctx,
                format,
                StatusCode::BAD_GATEWAY,
                "api_error",
                &message,
                Some(model),
            );
        }
    };

    if passthrough {
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
        emit_outcome(
            &state.app_handle,
            candidate,
            true,
            started,
            Some(usage),
            None,
            None,
            Some(session_id),
        );
        log_success(
            &state,
            &ctx,
            model,
            candidate,
            started.elapsed().as_millis() as u64,
            usage.0,
            usage.1,
            false,
        );
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
                None,
                Some(session_id),
            );
            log_success(
                &state,
                &ctx,
                model,
                candidate,
                started.elapsed().as_millis() as u64,
                Some(ir_resp.usage.input_tokens),
                Some(ir_resp.usage.output_tokens),
                false,
            );
            let created = chrono::Utc::now().timestamp();
            Json(response_from_ir(format, &ir_resp, created)).into_response()
        }
        Err(err) => {
            emit_outcome(
                &state.app_handle,
                candidate,
                false,
                started,
                None,
                Some(&err.reason),
                None,
                Some(session_id),
            );
            logged_error(
                &state,
                &ctx,
                format,
                StatusCode::BAD_GATEWAY,
                "api_error",
                &err.reason,
                Some(model),
            )
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn stream_response(
    state: AppState,
    ctx: ReqCtx,
    format: InboundFormat,
    candidate: &Candidate,
    resp: reqwest::Response,
    started: Instant,
    model: &str,
    session_id: String,
    gw_slot: Slot,
    up_slot: Slot,
    in_flight: InFlightGuard,
) -> Response {
    let passthrough = candidate.provider.protocol == format.protocol_name();
    if passthrough {
        // Forward upstream bytes to the client UNCHANGED while sniffing the SSE
        // frames for token usage, so streaming passthrough still draws down
        // quota and records the account's success at stream end.
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(32);
        let task_state = state.clone();
        let candidate = candidate.clone();
        let ctx = ctx.clone();
        let model = model.to_string();
        tokio::spawn(async move {
            // Hold the W1.2 concurrency slots + the in-flight tally for the
            // WHOLE stream — they release when this task ends, not at the
            // handler's return.
            let _slots = (gw_slot, up_slot, in_flight);
            let mut deframer = SseDeframer::default();
            let mut input: Option<u64> = None;
            let mut output: Option<u64> = None;
            let mut upstream = resp.bytes_stream();
            let mut stalled = false;
            'pump: loop {
                let chunk = match tokio::time::timeout(STREAM_IDLE_TIMEOUT, upstream.next()).await {
                    Ok(Some(chunk)) => chunk,
                    Ok(None) => break 'pump, // clean end of stream
                    Err(_) => {
                        stalled = true;
                        break 'pump;
                    }
                };
                let Ok(bytes) = chunk else { break };
                for data in deframer.push(&bytes) {
                    if data == "[DONE]" {
                        continue;
                    }
                    if let Ok(value) = serde_json::from_str::<Value>(&data) {
                        sniff_passthrough_usage(format, &value, &mut input, &mut output);
                    }
                }
                if tx.send(Ok(bytes)).await.is_err() {
                    break 'pump;
                }
            }
            if let Some(data) = deframer.finish() {
                if let Ok(value) = serde_json::from_str::<Value>(&data) {
                    sniff_passthrough_usage(format, &value, &mut input, &mut output);
                }
            }
            // A stall is a provider failure, not a completed turn — reporting it
            // as success would both mis-train the breaker and leave a stuck
            // upstream looking healthy.
            let stall_error = stalled.then(|| {
                format!(
                    "upstream stream stalled: no data for {}s",
                    STREAM_IDLE_TIMEOUT.as_secs()
                )
            });
            emit_outcome(
                &task_state.app_handle,
                &candidate,
                !stalled,
                started,
                Some((input, output)),
                stall_error.as_deref(),
                None,
                Some(&session_id),
            );
            log_success(
                &task_state,
                &ctx,
                &model,
                &candidate,
                started.elapsed().as_millis() as u64,
                input,
                output,
                true,
            );
        });
        let stream = futures_util::stream::unfold(rx, |mut rx| async move {
            rx.recv().await.map(|item| (item, rx))
        });
        return sse_response(Body::from_stream(stream));
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
    let task_state = state.clone();
    let candidate = candidate.clone();
    let ctx = ctx.clone();
    let model = model.to_string();
    tokio::spawn(async move {
        // Hold the W1.2 concurrency slots + in-flight tally for the WHOLE
        // transcoded stream.
        let _slots = (gw_slot, up_slot, in_flight);
        let mut deframer = SseDeframer::default();
        let mut upstream = resp.bytes_stream();
        let mut stalled = false;
        'pump: loop {
            let chunk = match tokio::time::timeout(STREAM_IDLE_TIMEOUT, upstream.next()).await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break 'pump, // clean end of stream
                Err(_) => {
                    stalled = true;
                    break 'pump;
                }
            };
            let Ok(bytes) = chunk else { break };
            for frame in transcode_upstream_sse_bytes(&mut deframer, &mut transcoder, &bytes) {
                if tx.send(Ok(Bytes::from(frame.to_frame()))).await.is_err() {
                    break 'pump;
                }
            }
        }
        for frame in finish_upstream_sse_stream(&mut deframer, &mut transcoder) {
            if tx.send(Ok(Bytes::from(frame.to_frame()))).await.is_err() {
                break;
            }
        }
        let usage = transcoder.usage();
        let stall_error = stalled.then(|| {
            format!(
                "upstream stream stalled: no data for {}s",
                STREAM_IDLE_TIMEOUT.as_secs()
            )
        });
        emit_outcome(
            &task_state.app_handle,
            &candidate,
            !stalled,
            started,
            Some((Some(usage.input_tokens), Some(usage.output_tokens))),
            stall_error.as_deref(),
            None,
            Some(&session_id),
        );
        log_success(
            &task_state,
            &ctx,
            &model,
            &candidate,
            started.elapsed().as_millis() as u64,
            Some(usage.input_tokens),
            Some(usage.output_tokens),
            true,
        );
    });

    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    });
    sse_response(Body::from_stream(stream))
}

fn transcode_upstream_sse_bytes(
    deframer: &mut SseDeframer,
    transcoder: &mut StreamTranscoder,
    bytes: &[u8],
) -> Vec<SseOut> {
    let mut out = Vec::new();
    for data in deframer.push(bytes) {
        push_upstream_sse_payload(transcoder, &data, &mut out);
    }
    out
}

fn finish_upstream_sse_stream(
    deframer: &mut SseDeframer,
    transcoder: &mut StreamTranscoder,
) -> Vec<SseOut> {
    let mut out = Vec::new();
    if let Some(data) = deframer.finish() {
        push_upstream_sse_payload(transcoder, &data, &mut out);
    }
    out.extend(transcoder.finish());
    out
}

fn push_upstream_sse_payload(transcoder: &mut StreamTranscoder, data: &str, out: &mut Vec<SseOut>) {
    if data == "[DONE]" {
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return;
    };
    out.extend(transcoder.push(&value));
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
/// `recordProviderOutcome` so gateway traffic feeds the same health / breaker /
/// cost stores the chat plane reads.
#[allow(clippy::too_many_arguments)]
fn emit_outcome(
    app_handle: &AppHandle,
    candidate: &Candidate,
    ok: bool,
    started: Instant,
    usage: Option<(Option<u64>, Option<u64>)>,
    error: Option<&str>,
    // `retry_after_ms`: upstream-derived cooldown window (W1.1) — feeds the
    // renderer breaker's dynamic cooldown. `None` on success / non-rate-limit
    // failures. `session_id`: affinity key (W1.3) — a successful outcome pins
    // the session to this deployment; a permanent failure releases the pin.
    retry_after_ms: Option<i64>,
    session_id: Option<&str>,
) {
    let payload = outcome_payload(
        candidate,
        ok,
        started.elapsed().as_millis() as u64,
        usage,
        error,
        retry_after_ms,
        session_id,
    );
    let _ = app_handle.emit(REQUEST_OUTCOME_EVENT, payload);
}

/// The `gateway://request-outcome` body. Split out from [`emit_outcome`] so the
/// renderer contract — above all the rule that a non-chat endpoint sends a null
/// `sessionId` and therefore cannot pin chat affinity — is unit-testable
/// without an `AppHandle`.
#[allow(clippy::too_many_arguments)]
fn outcome_payload(
    candidate: &Candidate,
    ok: bool,
    latency_ms: u64,
    usage: Option<(Option<u64>, Option<u64>)>,
    error: Option<&str>,
    retry_after_ms: Option<i64>,
    session_id: Option<&str>,
) -> Value {
    let (input_tokens, output_tokens) = usage.unwrap_or((None, None));
    json!({
        "providerId": candidate.provider.id,
        "modelId": candidate.model_id,
        "ok": ok,
        "latencyMs": latency_ms,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "errorMessage": error,
        "retryAfterMs": retry_after_ms,
        "sessionId": session_id,
    })
}

/// One durable request-log row per request (success, error, or middleware
/// rejection). Persisted renderer-side into Dexie + shown in the live panel.
#[allow(clippy::too_many_arguments)]
fn emit_request_log(
    app_handle: &AppHandle,
    route: &str,
    remote_ip: &str,
    key_id: Option<&str>,
    model: Option<&str>,
    provider_id: Option<&str>,
    status: u16,
    latency_ms: u64,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    error: Option<&str>,
    stream: bool,
) {
    let payload = json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "at": chrono::Utc::now().to_rfc3339(),
        "route": route,
        "remoteIp": remote_ip,
        "keyId": key_id,
        "model": model,
        "providerId": provider_id,
        "status": status,
        "latencyMs": latency_ms,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "error": error,
        "stream": stream,
    });
    let _ = app_handle.emit(REQUEST_LOG_EVENT, payload);
}

/// Success terminal: emit the durable log row, draw the consumed tokens down
/// against the calling key's token quota, and record the pooled upstream key's
/// success (feeds `least-used` rotation + the per-account usage surface). One
/// call replaces the plain log emit at every success path.
#[allow(clippy::too_many_arguments)]
fn log_success(
    state: &AppState,
    ctx: &ReqCtx,
    model: &str,
    candidate: &Candidate,
    latency_ms: u64,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    stream: bool,
) {
    emit_request_log_ctx(
        &state.app_handle,
        ctx,
        Some(model),
        Some(&candidate.provider.id),
        200,
        latency_ms,
        input_tokens,
        output_tokens,
        None,
        stream,
    );
    // Draw the consumed tokens down against the calling key's quota.
    let consumed = input_tokens
        .unwrap_or(0)
        .saturating_add(output_tokens.unwrap_or(0)) as i64;
    if consumed > 0 {
        if let Some(key_id) = ctx.key_id.as_deref() {
            let _ = api_keys::add_quota_usage(&mut state.keys.write(), key_id, consumed);
        }
    }
    // Record the upstream account's success for rotation + per-account usage.
    record_key_success(
        &state.key_rotation,
        &candidate.provider.id,
        candidate.provider.api_key.as_deref(),
    );
}

/// Extract token usage from one passthrough SSE payload so streaming passthrough
/// requests still draw down quota. Anthropic reports input on `message_start`
/// and cumulative output on `message_delta`; OpenAI reports both on a trailing
/// `usage` object (present only when the client asked for it).
fn sniff_passthrough_usage(
    format: InboundFormat,
    value: &Value,
    input: &mut Option<u64>,
    output: &mut Option<u64>,
) {
    match format {
        InboundFormat::AnthropicMessages => {
            if let Some(v) = value["message"]["usage"]["input_tokens"].as_u64() {
                *input = Some(v);
            }
            if let Some(v) = value["usage"]["output_tokens"].as_u64() {
                *output = Some(v);
            }
        }
        InboundFormat::OpenAiChat => {
            if let Some(v) = value["usage"]["prompt_tokens"].as_u64() {
                *input = Some(v);
            }
            if let Some(v) = value["usage"]["completion_tokens"].as_u64() {
                *output = Some(v);
            }
        }
    }
}

/// Convenience wrapper that pulls route/remoteIp/keyId off a [`ReqCtx`].
#[allow(clippy::too_many_arguments)]
fn emit_request_log_ctx(
    app_handle: &AppHandle,
    ctx: &ReqCtx,
    model: Option<&str>,
    provider_id: Option<&str>,
    status: u16,
    latency_ms: u64,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    error: Option<&str>,
    stream: bool,
) {
    emit_request_log(
        app_handle,
        &ctx.route,
        &ctx.remote_ip,
        ctx.key_id.as_deref(),
        model,
        provider_id,
        status,
        latency_ms,
        input_tokens,
        output_tokens,
        error,
        stream,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> ReqCtx {
        ReqCtx {
            route: "/v1/chat/completions".into(),
            remote_ip: "127.0.0.1".into(),
            key_id: Some("k1".into()),
            key_model_allowlist: vec![],
            user_agent: "test-agent".into(),
        }
    }

    #[test]
    fn body_limit_fits_chat_histories() {
        assert_eq!(BODY_LIMIT_BYTES, 16 * 1024 * 1024);
    }

    #[test]
    fn event_names_match_frontend_listeners() {
        assert_eq!(REQUEST_LOG_EVENT, "gateway://request-log");
        assert_eq!(REQUEST_OUTCOME_EVENT, "gateway://request-outcome");
        assert_eq!(DECIDE_EVENT, "gateway://decide");
    }

    #[test]
    fn decide_timeout_is_bounded() {
        assert_eq!(DECIDE_TIMEOUT_MS, 800);
    }

    #[test]
    fn minimal_probe_body_is_one_token_per_protocol() {
        let oa = minimal_probe_body("openai", "gpt-4o-mini");
        assert_eq!(oa["model"], "gpt-4o-mini");
        assert_eq!(oa["max_tokens"], 1);
        assert_eq!(oa["messages"][0]["role"], "user");

        let an = minimal_probe_body("anthropic", "claude-haiku");
        assert_eq!(an["model"], "claude-haiku");
        assert_eq!(an["max_tokens"], 1);
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

        let mut both = HeaderMap::new();
        both.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer tok-1".parse().unwrap(),
        );
        both.insert("x-api-key", "tok-2".parse().unwrap());
        assert_eq!(supplied_token(&both), Some("tok-1"));

        assert_eq!(supplied_token(&HeaderMap::new()), None);
    }

    /// A snapshot mixing executable (openai / anthropic) providers with a
    /// non-executable one, plus an alias that points ONLY at the latter.
    fn models_snapshot() -> RoutingSnapshot {
        serde_json::from_value(serde_json::json!({
            "aliases": [
                { "alias": "fast", "entries": [
                    { "providerId": "groq", "modelId": "llama-3.3-70b" }
                ]},
                { "alias": "vision", "entries": [
                    { "providerId": "weird", "modelId": "gemini-pro" }
                ]}
            ],
            "providers": [
                { "id": "groq", "protocol": "openai", "baseUrl": "https://api.groq.com/openai/v1",
                  "apiKey": "sk-g", "enabled": true, "models": ["llama-3.3-70b"] },
                { "id": "weird", "protocol": "gemini", "baseUrl": "https://g",
                  "apiKey": "sk-w", "enabled": true, "models": ["gemini-pro"] },
                { "id": "off", "protocol": "openai", "baseUrl": "https://o",
                  "apiKey": "sk-o", "enabled": false, "models": ["hidden-model"] }
            ],
            "generatedAtMs": 1
        }))
        .unwrap()
    }

    fn listed_ids(data: &[Value]) -> Vec<String> {
        data.iter()
            .filter_map(|m| m["id"].as_str().map(str::to_string))
            .collect()
    }

    #[test]
    fn list_models_hides_models_the_gateway_cannot_execute() {
        let ids = listed_ids(&listable_models(&models_snapshot(), false, &|_| true));
        // Executable + enabled only.
        assert!(ids.contains(&"fast".to_string()));
        assert!(ids.contains(&"llama-3.3-70b".to_string()));
        // The gemini-protocol provider would 404 on the very next chat call, so
        // neither it nor the alias that only points at it may be advertised.
        assert!(!ids.contains(&"gemini-pro".to_string()));
        assert!(!ids.contains(&"vision".to_string()));
        // Disabled providers stay hidden as before.
        assert!(!ids.contains(&"hidden-model".to_string()));
    }

    #[test]
    fn list_models_still_honours_exposure_and_key_allowlist() {
        let ids = listed_ids(&listable_models(&models_snapshot(), false, &|m| {
            m == "fast"
        }));
        assert_eq!(ids, vec!["fast".to_string()]);

        // hide_raw_provider_models keeps aliases and drops bare provider models.
        let ids = listed_ids(&listable_models(&models_snapshot(), true, &|_| true));
        assert_eq!(ids, vec!["fast".to_string()]);
    }

    #[test]
    fn gate_keys_are_endpoint_independent() {
        // The shared-budget invariant: chat, embeddings and responses all reach
        // the limiter through these two helpers, so a single configured cap is
        // ONE budget across endpoints. If someone re-inlines a `format!` in one
        // handler this test won't catch it — but the helpers existing at all is
        // what makes that a visible edit rather than an invisible one.
        let mut c = ctx();
        c.key_id = Some("key-abc".into());
        assert_eq!(gw_gate_key(&c), "gw:key-abc");

        // An unauthenticated caller still shares one bucket rather than each
        // getting its own unlimited gate.
        c.key_id = None;
        assert_eq!(gw_gate_key(&c), "gw:_");

        let candidate = resolve_candidates(&models_snapshot(), "llama-3.3-70b")
            .into_iter()
            .next()
            .expect("groq candidate");
        assert_eq!(up_gate_key(&candidate), "up:groq:sk-g");
    }

    #[tokio::test(start_paused = true)]
    async fn a_silent_upstream_stream_is_abandoned_rather_than_parked_forever() {
        // Streaming skips `apply_timeout` and reqwest sets no read timeout, so
        // without this the pump task would park forever holding its concurrency
        // slots AND its in-flight tally — and the tally drives least-busy, so
        // one hung stream would steer traffic off that provider permanently.
        let mut silent = futures_util::stream::pending::<Result<Bytes, ()>>();
        assert!(
            tokio::time::timeout(STREAM_IDLE_TIMEOUT, silent.next())
                .await
                .is_err(),
            "a stream that never yields must time out, not park the pump"
        );

        // …and a stall must be reported as a FAILURE. Both pumps used to emit
        // `ok: true` unconditionally at stream end, which would have logged a
        // hung upstream as a healthy turn.
        let candidate = resolve_candidates(&models_snapshot(), "llama-3.3-70b")
            .into_iter()
            .next()
            .expect("groq candidate");
        let stalled = outcome_payload(
            &candidate,
            false,
            1,
            None,
            Some("upstream stream stalled: no data for 300s"),
            None,
            Some("sess-1"),
        );
        assert_eq!(stalled["ok"], false);
        assert!(stalled["errorMessage"]
            .as_str()
            .unwrap_or_default()
            .contains("stalled"));
    }

    #[test]
    fn a_non_chat_outcome_can_never_pin_chat_affinity() {
        // `sessionId` drives `pinSessionDeployment` on the renderer. Embeddings
        // and /v1/responses have no chat session, so they MUST send null —
        // otherwise their traffic would stick a real conversation to whatever
        // deployment happened to serve an embedding.
        let candidate = resolve_candidates(&models_snapshot(), "llama-3.3-70b")
            .into_iter()
            .next()
            .expect("groq candidate");

        let embeddings = outcome_payload(
            &candidate,
            true,
            12,
            Some((Some(7), None)),
            None,
            None,
            None,
        );
        assert!(embeddings["sessionId"].is_null());
        assert_eq!(embeddings["inputTokens"], 7);
        assert!(embeddings["outputTokens"].is_null());
        assert_eq!(embeddings["providerId"], "groq");

        // A failure carries the cooldown window through to the breaker.
        let failed = outcome_payload(
            &candidate,
            false,
            3,
            None,
            Some("HTTP 429"),
            Some(4_000),
            None,
        );
        assert_eq!(failed["ok"], false);
        assert_eq!(failed["retryAfterMs"], 4_000);
        assert_eq!(failed["errorMessage"], "HTTP 429");
        assert!(failed["sessionId"].is_null());

        // The chat path, by contrast, does thread one through.
        let chat = outcome_payload(&candidate, true, 5, None, None, None, Some("sess-1"));
        assert_eq!(chat["sessionId"], "sess-1");
    }

    #[test]
    fn in_flight_snapshot_never_carries_a_credential() {
        // `up_gate_key` deliberately embeds the API key, and the decide payload
        // is serialized to the renderer — so the tally MUST key on the provider
        // id alone. Working rule 7: pin the intentional invariant.
        let tracker = InFlightTracker::default();
        let candidate = resolve_candidates(&models_snapshot(), "llama-3.3-70b")
            .into_iter()
            .next()
            .expect("groq candidate");
        assert!(
            up_gate_key(&candidate).contains("sk-"),
            "fixture has a secret"
        );

        let _guard = tracker.enter(&candidate.provider.id);
        let snapshot = tracker.snapshot();
        assert_eq!(snapshot.get("groq"), Some(&1));
        for key in snapshot.keys() {
            assert!(
                !key.contains("sk-"),
                "credential leaked into snapshot: {key}"
            );
        }
        // And it is a plain provider id, not the gate key.
        assert!(!snapshot.contains_key(&up_gate_key(&candidate)));
    }

    #[test]
    fn ctx_allows_respects_key_allowlist() {
        let mut c = ctx();
        assert!(ctx_allows(&c, "anything")); // empty = all
        c.key_model_allowlist = vec!["fast".into()];
        assert!(ctx_allows(&c, "fast"));
        assert!(!ctx_allows(&c, "slow"));
    }

    #[test]
    fn sniff_usage_reads_both_protocol_shapes() {
        // Anthropic: input on message_start, cumulative output on message_delta.
        let (mut i, mut o) = (None, None);
        sniff_passthrough_usage(
            InboundFormat::AnthropicMessages,
            &json!({ "type": "message_start", "message": { "usage": { "input_tokens": 42 } } }),
            &mut i,
            &mut o,
        );
        sniff_passthrough_usage(
            InboundFormat::AnthropicMessages,
            &json!({ "type": "message_delta", "usage": { "output_tokens": 17 } }),
            &mut i,
            &mut o,
        );
        assert_eq!((i, o), (Some(42), Some(17)));

        // OpenAI: both on a trailing usage object.
        let (mut i2, mut o2) = (None, None);
        sniff_passthrough_usage(
            InboundFormat::OpenAiChat,
            &json!({ "usage": { "prompt_tokens": 5, "completion_tokens": 9 } }),
            &mut i2,
            &mut o2,
        );
        assert_eq!((i2, o2), (Some(5), Some(9)));

        // A frame without usage leaves the accumulators untouched.
        let (mut i3, mut o3) = (Some(1), Some(2));
        sniff_passthrough_usage(
            InboundFormat::OpenAiChat,
            &json!({ "choices": [{ "delta": { "content": "hi" } }] }),
            &mut i3,
            &mut o3,
        );
        assert_eq!((i3, o3), (Some(1), Some(2)));
    }

    #[test]
    fn apply_timeout_only_sets_when_positive() {
        // Can't easily inspect RequestBuilder; assert the config gate instead.
        let mut cfg = GatewayConfig::default();
        cfg.request_timeout_secs = 0;
        assert_eq!(cfg.request_timeout_secs, 0);
        cfg.request_timeout_secs = 10;
        assert!(cfg.request_timeout_secs > 0);
    }

    #[test]
    fn error_helpers_render_inbound_shapes() {
        let resp = no_snapshot_error(InboundFormat::OpenAiChat);
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn transcoded_stream_flushes_final_sse_payload_without_newline() {
        let upstream_payload = json!({
            "choices": [{
                "delta": { "content": "tail text" },
                "finish_reason": null,
            }],
            "usage": { "prompt_tokens": 7, "completion_tokens": 3 },
        });
        let upstream_bytes = format!("data: {upstream_payload}");
        let mut deframer = SseDeframer::default();
        let mut transcoder =
            StreamTranscoder::new(Direction::OpenAiToAnthropic, "client-model", "msg_tail");

        assert!(transcode_upstream_sse_bytes(
            &mut deframer,
            &mut transcoder,
            upstream_bytes.as_bytes()
        )
        .is_empty());

        let frames = finish_upstream_sse_stream(&mut deframer, &mut transcoder);
        assert!(frames.iter().any(|frame| {
            frame.event.as_deref() == Some("content_block_delta")
                && serde_json::from_str::<Value>(&frame.data)
                    .map(|data| data["delta"]["text"] == "tail text")
                    .unwrap_or(false)
        }));
    }
}
