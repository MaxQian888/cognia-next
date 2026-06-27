//! Local axum HTTP server for the remote-control inbound listener.
//!
//! Layout:
//!   - GET  /api/v1/health         → `{ ok: true, version }`
//!   - POST /api/v1/tasks/:id/run  → emits `remote-control://run-task` to the
//!                                   renderer (which calls `runTaskNow`)
//!   - POST /api/v1/events         → emits `remote-control://emit-event`
//!
//! Middleware (outer → inner):
//!   1. body-size limit (8 KiB) via `tower_http::limit::RequestBodyLimitLayer`
//!   2. bearer auth (constant-time compare via `subtle`)
//!   3. IP allowlist (CIDR match against `ConnectInfo<SocketAddr>`)
//!   4. fixed-window rate limit (per-token, default 60 req/min)
//!
//! The listener binds 127.0.0.1 only — the allowlist is defence-in-depth.
//! Graceful shutdown is driven by a `tokio::sync::watch` channel: dropping
//! the sender triggers the `with_graceful_shutdown` future to resolve.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, Method, StatusCode},
    middleware::{from_fn_with_state, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use serde_json::{json, Value};
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, watch};
use tower_http::limit::RequestBodyLimitLayer;

use super::allowlist::ParsedAllowlist;
use super::idempotency::IdempotencyCache;
use super::rate_limit::FixedWindowRateLimiter;
use super::types::{
    Capability, CommandEvent, CommandRequestBody, EmitEvent, EmitEventRequestBody,
    RemoteControlError, RunTaskEvent, TriggerTaskRequestBody,
};
use super::QueryRegistry;

pub const RUN_TASK_EVENT: &str = "remote-control://run-task";
pub const EMIT_EVENT_EVENT: &str = "remote-control://emit-event";
pub const COMMAND_EVENT: &str = "remote-control://command";
pub const QUERY_EVENT: &str = "remote-control://query";

/// How long a GET read waits for the renderer's Dexie read before giving up.
/// Dexie list reads are single-digit ms; 2s absorbs a busy renderer. A closed
/// window costs one bounded stall (then 503), never a hang.
const QUERY_TIMEOUT_MS: u64 = 2000;

/// Generic command targets accepted by `POST /api/v1/commands/:target`. The
/// renderer's dispatch registry owns the actual routing — this list only
/// rejects unknown targets early so a typo doesn't emit a dead event.
const KNOWN_TARGETS: &[&str] = &[
    "scheduler.task.run",
    "scheduler.event",
    "workflow.run",
    "workflow.cancel",
    "goal.create",
    "goal.continue",
    "goal.pause",
    "goal.resume",
    "goal.stop",
    "team.dispatch",
    "team.stop",
    "plan.run",
    "chat.send",
    "connector.send",
    "terminal.exec",
    "plugin.enable",
    "plugin.disable",
];

/// Targets that cause model-cost or off-device side effects. Dispatch requires
/// `RemoteControlInboundConfig.allow_sensitive_targets = true` in addition to a
/// `write` token. Mirrors `SENSITIVE_REMOTE_COMMAND_TARGETS` in
/// `types/remote-control/index.ts`.
const SENSITIVE_TARGETS: &[&str] = &[
    "chat.send",
    "connector.send",
    "goal.create",
    "terminal.exec",
];

fn is_sensitive_target(target: &str) -> bool {
    SENSITIVE_TARGETS.contains(&target)
}

/// Accessor for the `KNOWN_TARGETS` allowlist. Used by the OpenAPI
/// `spec_parity` test to assert the Rust allowlist and the
/// `RemoteCommandTarget` enum in `docs/api/remote-control.openapi.yaml`
/// stay in lockstep (both directions).
#[allow(dead_code)] // referenced from `spec_parity::tests` only.
pub fn known_targets() -> &'static [&'static str] {
    KNOWN_TARGETS
}

const BODY_LIMIT_BYTES: usize = 8 * 1024;

#[derive(Clone)]
pub struct ServerHandle {
    pub bound_port: u16,
    pub shutdown: watch::Sender<()>,
}

#[derive(Clone)]
struct AppState {
    app_handle: AppHandle,
    token: Arc<String>,
    allowlist: Arc<ParsedAllowlist>,
    rate_limiter: Arc<FixedWindowRateLimiter>,
    on_request: Arc<dyn RequestObserver>,
    idempotency: Arc<IdempotencyCache>,
    capability: Capability,
    allow_sensitive_targets: bool,
    queries: Arc<QueryRegistry>,
}

/// Capability tiering: a `read` token may hit the health probe + any `GET` read
/// endpoint; only mutating methods (`POST`) require a `write` token. Health is
/// `GET` so it falls into the read tier naturally.
fn route_needs_write(method: &Method) -> bool {
    method != Method::GET
}

/// Hook fired on every successful (post-auth, post-allowlist, post-rate-limit)
/// request. Allows the orchestrating state to update counters / call logs.
pub trait RequestObserver: Send + Sync + 'static {
    fn on_call(&self, route: &str, status: StatusCode, remote_ip: IpAddr);
}

/// Spawn the axum server on `127.0.0.1:<port>`. Returns the bound port (so
/// the caller can record `port: 0` → OS-assigned ephemeral) plus the
/// shutdown channel.
#[allow(clippy::too_many_arguments)]
pub async fn spawn_server(
    app_handle: AppHandle,
    port: u16,
    token: String,
    allowlist: Vec<String>,
    rate_limit_per_min: u32,
    capability: Capability,
    allow_sensitive_targets: bool,
    queries: Arc<QueryRegistry>,
    on_request: Arc<dyn RequestObserver>,
) -> Result<ServerHandle, RemoteControlError> {
    let parsed_allowlist =
        ParsedAllowlist::parse(&allowlist).map_err(RemoteControlError::InvalidConfig)?;

    let bind_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .map_err(|source| RemoteControlError::Bind { port, source })?;
    let bound_port = listener
        .local_addr()
        .map_err(|source| RemoteControlError::Bind { port, source })?
        .port();

    let state = AppState {
        app_handle,
        token: Arc::new(token),
        allowlist: Arc::new(parsed_allowlist),
        rate_limiter: Arc::new(FixedWindowRateLimiter::new(rate_limit_per_min)),
        on_request,
        idempotency: Arc::new(IdempotencyCache::new()),
        capability,
        allow_sensitive_targets,
        queries,
    };

    let app = Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/tasks/:id/run", post(run_task))
        .route("/api/v1/events", post(emit_event))
        .route("/api/v1/commands/:target", post(run_command))
        // Read surface (GET). `read` capability is sufficient.
        .route("/api/v1/targets", get(get_targets))
        .route("/api/v1/tasks", get(get_tasks))
        .route("/api/v1/workflows", get(get_workflows))
        .route("/api/v1/workflows/:id/runs", get(get_workflow_runs))
        .route("/api/v1/goals", get(get_goals))
        .route("/api/v1/audit", get(get_audit))
        .route("/api/v1/runs", get(get_runs))
        .route("/api/v1/runs/:runId", get(get_run_status))
        .route("/api/v1/teams", get(get_teams))
        .route("/api/v1/teams/:id", get(get_team))
        .route("/api/v1/plugins", get(get_plugins))
        .route("/api/v1/connectors", get(get_connectors))
        .route("/api/v1/backups", get(get_backups))
        .route("/api/v1/ocr/cache", get(get_ocr_cache))
        .route("/api/v1/sessions/:id/messages", get(get_session_messages))
        .layer(from_fn_with_state(state.clone(), middleware))
        .layer(axum::middleware::map_response(add_csp_header))
        .layer(RequestBodyLimitLayer::new(BODY_LIMIT_BYTES))
        .with_state(state);

    let (tx, mut rx) = watch::channel(());

    tokio::spawn(async move {
        let server = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        );
        let result = server
            .with_graceful_shutdown(async move {
                // Returns when the only sender is dropped (or `tx.send(())` fires).
                let _ = rx.changed().await;
            })
            .await;
        if let Err(error) = result {
            log::warn!("remote-control server exited with error: {error}");
        }
    });

    Ok(ServerHandle {
        bound_port,
        shutdown: tx,
    })
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    version: String,
}

async fn health(State(_state): State<AppState>) -> impl IntoResponse {
    Json(HealthResponse {
        ok: true,
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

async fn run_task(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    payload: Option<Json<TriggerTaskRequestBody>>,
) -> impl IntoResponse {
    let body = payload.map(|Json(b)| b).unwrap_or_default();
    let event = RunTaskEvent {
        task_id,
        payload: body.payload,
    };
    if let Err(error) = state.app_handle.emit(RUN_TASK_EVENT, event) {
        log::warn!("remote-control failed to emit run-task event: {error}");
        return error_body(StatusCode::INTERNAL_SERVER_ERROR, "emit failed");
    }
    accepted()
}

async fn emit_event(
    State(state): State<AppState>,
    payload: Option<Json<EmitEventRequestBody>>,
) -> impl IntoResponse {
    let Some(Json(body)) = payload else {
        return error_body(StatusCode::BAD_REQUEST, "request body required");
    };
    if body.event_type.trim().is_empty() {
        return error_body(StatusCode::BAD_REQUEST, "eventType required");
    }
    let event = EmitEvent {
        event_type: body.event_type,
        event_source: body.event_source,
        data: body.data,
    };
    if let Err(error) = state.app_handle.emit(EMIT_EVENT_EVENT, event) {
        log::warn!("remote-control failed to emit emit-event event: {error}");
        return error_body(StatusCode::INTERNAL_SERVER_ERROR, "emit failed");
    }
    accepted()
}

async fn run_command(
    State(state): State<AppState>,
    Path(target): Path<String>,
    headers: HeaderMap,
    payload: Option<Json<CommandRequestBody>>,
) -> impl IntoResponse {
    if !KNOWN_TARGETS.contains(&target.as_str()) {
        return error_body(StatusCode::NOT_FOUND, "unknown command target");
    }
    // Sensitivity guardrail: model-cost / off-device targets need an explicit
    // opt-in beyond the binary write capability.
    if is_sensitive_target(&target) && !state.allow_sensitive_targets {
        return error_body(StatusCode::FORBIDDEN, "sensitive_target_disabled");
    }
    let body = payload.map(|Json(b)| b).unwrap_or_default();
    let idempotency_key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // Idempotency: a replay within the TTL returns the original runId without
    // re-emitting, so a cron/CI double-fire doesn't double-execute.
    if let Some(key) = &idempotency_key {
        if let Some(prev) = state.idempotency.get(key) {
            let mut resp = (
                StatusCode::ACCEPTED,
                Json(json!({ "accepted": true, "runId": prev })),
            )
                .into_response();
            resp.headers_mut().insert(
                "idempotent-replayed",
                axum::http::HeaderValue::from_static("true"),
            );
            return resp;
        }
    }

    let run_id = format!("run_{}", uuid::Uuid::new_v4());
    let event = CommandEvent {
        target,
        args: body.args,
        run_id: run_id.clone(),
        idempotency_key: idempotency_key.clone(),
    };
    if let Err(error) = state.app_handle.emit(COMMAND_EVENT, event) {
        log::warn!("remote-control failed to emit command event: {error}");
        return error_body(StatusCode::INTERNAL_SERVER_ERROR, "emit failed");
    }
    if let Some(key) = idempotency_key {
        state.idempotency.put(key, run_id.clone());
    }
    (
        StatusCode::ACCEPTED,
        Json(json!({ "accepted": true, "runId": run_id })),
    )
        .into_response()
}

fn accepted() -> Response {
    (StatusCode::ACCEPTED, Json(json!({ "accepted": true }))).into_response()
}

// ── Read surface (GET) ───────────────────────────────────────────────────────

/// `GET /api/v1/targets` — the dispatchable command allowlist. Rust-native: the
/// data already lives here, so no renderer round-trip is needed (answerable
/// even with the window closed).
async fn get_targets() -> impl IntoResponse {
    Json(json!({ "targets": KNOWN_TARGETS, "sensitive": SENSITIVE_TARGETS }))
}

/// `GET /api/v1/tasks` — scheduler task catalog (renderer Dexie read).
async fn get_tasks(State(state): State<AppState>) -> Response {
    run_query(&state, "tasks", json!({})).await
}

/// `GET /api/v1/workflows/:id/runs` — run history for a workflow.
async fn get_workflow_runs(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    run_query(&state, "workflow.runs", json!({ "workflowId": id })).await
}

/// `GET /api/v1/goals?sessionId=…` — goals for a background session.
async fn get_goals(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let session_id = params.get("sessionId").cloned();
    if session_id.as_deref().unwrap_or("").is_empty() {
        return error_body(StatusCode::BAD_REQUEST, "sessionId required");
    }
    run_query(&state, "goals", json!({ "sessionId": session_id })).await
}

/// `GET /api/v1/audit` — recent inbound remote-control audit entries.
async fn get_audit(State(state): State<AppState>) -> Response {
    run_query(&state, "audit", json!({})).await
}

/// `GET /api/v1/runs/:runId` — outcome of a dispatched command run. Reads the
/// run-status projection, falling back to the durable `workflowRuns` row for
/// workflow targets (which share the same runId).
async fn get_run_status(State(state): State<AppState>, Path(run_id): Path<String>) -> Response {
    run_query(&state, "run.status", json!({ "runId": run_id })).await
}

/// `GET /api/v1/runs` — most-recent dispatched command runs + their status.
async fn get_runs(State(state): State<AppState>) -> Response {
    run_query(&state, "runs", json!({})).await
}

/// `GET /api/v1/workflows` — visual workflow definitions (id / name / size).
async fn get_workflows(State(state): State<AppState>) -> Response {
    run_query(&state, "workflows", json!({})).await
}

/// `GET /api/v1/teams` — agent-team roster + status.
async fn get_teams(State(state): State<AppState>) -> Response {
    run_query(&state, "teams", json!({})).await
}

/// `GET /api/v1/teams/:id` — a single agent team's detail.
async fn get_team(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    run_query(&state, "team", json!({ "teamId": id })).await
}

/// `GET /api/v1/plugins` — installed plugin catalog + enabled state.
async fn get_plugins(State(state): State<AppState>) -> Response {
    run_query(&state, "plugins", json!({})).await
}

/// `GET /api/v1/connectors` — configured platform-connector adapter instances.
async fn get_connectors(State(state): State<AppState>) -> Response {
    run_query(&state, "connectors", json!({})).await
}

/// `GET /api/v1/backups` — recent backup history rows.
async fn get_backups(State(state): State<AppState>) -> Response {
    run_query(&state, "backups", json!({})).await
}

/// `GET /api/v1/ocr/cache` — OCR result-cache stats (row count + bytes).
async fn get_ocr_cache(State(state): State<AppState>) -> Response {
    run_query(&state, "ocr.cache", json!({})).await
}

/// `GET /api/v1/sessions/:id/messages` — per-session chat text (PII-gated row by
/// row in the renderer; non-conformant rows are dropped, never partially sent).
async fn get_session_messages(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    run_query(&state, "messages", json!({ "sessionId": id })).await
}

/// Round-trip a read to the renderer: register a oneshot, emit
/// `remote-control://query`, await the renderer's `remote_control_query_response`
/// for at most `QUERY_TIMEOUT_MS`. A closed/busy window → `503
/// window_unavailable`. The registry entry is removed on every exit path so a
/// timed-out read never leaks.
async fn run_query(state: &AppState, kind: &str, params: Value) -> Response {
    let request_id = format!("rcq_{}", uuid::Uuid::new_v4().simple());
    let (tx, rx) = oneshot::channel::<Value>();
    state.queries.lock().insert(request_id.clone(), tx);

    let emitted = state.app_handle.emit(
        QUERY_EVENT,
        json!({ "requestId": request_id, "kind": kind, "params": params }),
    );
    if emitted.is_err() {
        state.queries.lock().remove(&request_id);
        return error_body(StatusCode::SERVICE_UNAVAILABLE, "window_unavailable");
    }

    match tokio::time::timeout(Duration::from_millis(QUERY_TIMEOUT_MS), rx).await {
        Ok(Ok(value)) => (StatusCode::OK, Json(value)).into_response(),
        // timeout or sender dropped (renderer never answered / window closed)
        _ => {
            state.queries.lock().remove(&request_id);
            error_body(StatusCode::SERVICE_UNAVAILABLE, "window_unavailable")
        }
    }
}

fn error_body(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

/// Accept only loopback Host headers (DNS-rebinding / `0.0.0.0-day`
/// mitigation). A rebound request carries `Host: evil.com` and is rejected.
/// The port suffix is ignored — any canonical loopback host spelling passes.
fn host_is_local(host: &str) -> bool {
    let host = host.trim();
    if host == "[::1]" || host == "::1" {
        return true;
    }
    let without_port = match host.strip_prefix('[') {
        // bracketed IPv6 literal, e.g. "[::1]:8080"
        Some(rest) => rest.split(']').next().unwrap_or(rest),
        None => host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host),
    };
    matches!(without_port, "127.0.0.1" | "localhost" | "::1")
}

/// Attach `Content-Security-Policy: default-src 'none'` to every response so a
/// reflected-content abuse vector is neutered. Applied as an outer
/// `map_response` layer so it covers auth-middleware rejections too.
async fn add_csp_header(mut response: Response) -> Response {
    response.headers_mut().insert(
        axum::http::header::CONTENT_SECURITY_POLICY,
        axum::http::HeaderValue::from_static("default-src 'none'"),
    );
    response
}

async fn middleware(
    State(state): State<AppState>,
    ConnectInfo(connect_info): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let route = request.uri().path().to_string();
    let method = request.method().clone();
    let remote_ip = connect_info.ip();

    // 0. Host-header allowlist + cross-origin rejection (DNS-rebinding /
    // `0.0.0.0-day` mitigation). A loopback bind does NOT make us
    // browser-unreachable, so a rebound request (`Host: evil.com`) or any
    // browser-originated call (which carries `Origin`/`Referer`; a real CLI
    // client never sets them) is rejected before auth.
    let host_ok = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(host_is_local)
        .unwrap_or(false);
    if !host_ok {
        state
            .on_request
            .on_call(&route, StatusCode::FORBIDDEN, remote_ip);
        return error_body(StatusCode::FORBIDDEN, "invalid host");
    }
    if headers.contains_key(axum::http::header::ORIGIN)
        || headers.contains_key(axum::http::header::REFERER)
    {
        state
            .on_request
            .on_call(&route, StatusCode::FORBIDDEN, remote_ip);
        return error_body(StatusCode::FORBIDDEN, "cross-origin not allowed");
    }

    // 1. Allowlist — only IPv4 entries are supported. IPv6 callers (which
    // can include ::1 from a client that opened an AF_INET6 socket against
    // 127.0.0.1) are mapped through `to_canonical` first.
    let canonical = match remote_ip {
        IpAddr::V4(v4) => v4,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4,
            None => {
                state
                    .on_request
                    .on_call(&route, StatusCode::FORBIDDEN, remote_ip);
                return error_body(StatusCode::FORBIDDEN, "ipv6 not supported");
            }
        },
    };
    if !state.allowlist.contains(canonical) {
        state
            .on_request
            .on_call(&route, StatusCode::FORBIDDEN, remote_ip);
        return error_body(StatusCode::FORBIDDEN, "origin not allowed");
    }

    // 2. Bearer auth.
    let supplied_token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let Some(supplied_token) = supplied_token else {
        state
            .on_request
            .on_call(&route, StatusCode::UNAUTHORIZED, remote_ip);
        return error_body(StatusCode::UNAUTHORIZED, "missing bearer token");
    };
    let expected = state.token.as_bytes();
    let supplied = supplied_token.as_bytes();
    if expected.len() != supplied.len() || expected.ct_eq(supplied).unwrap_u8() == 0 {
        state
            .on_request
            .on_call(&route, StatusCode::UNAUTHORIZED, remote_ip);
        return error_body(StatusCode::UNAUTHORIZED, "invalid token");
    }

    // 2b. Capability gate — a `read` token may hit the health probe + every GET
    // read endpoint; mutating methods (POST) require `write`.
    if route_needs_write(&method) && state.capability != Capability::Write {
        state
            .on_request
            .on_call(&route, StatusCode::FORBIDDEN, remote_ip);
        return error_body(StatusCode::FORBIDDEN, "insufficient capability");
    }

    // 3. Rate limit.
    if !state.rate_limiter.try_acquire() {
        state
            .on_request
            .on_call(&route, StatusCode::TOO_MANY_REQUESTS, remote_ip);
        return error_body(StatusCode::TOO_MANY_REQUESTS, "rate limit exceeded");
    }

    let response = next.run(request).await;
    state
        .on_request
        .on_call(&route, response.status(), remote_ip);
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    // We can't easily build a real `AppHandle` in unit tests (Tauri integration
    // tests require `tauri::test::mock_app`, which is more weight than these
    // tests warrant). Instead we verify the pure helpers here and let the
    // axum integration tests in `src-tauri/tests/` (if added) cover the wired
    // server. The middleware logic is exercised through the allowlist and
    // rate-limiter unit tests in their respective files.

    #[test]
    fn body_limit_constant_is_eight_kib() {
        assert_eq!(BODY_LIMIT_BYTES, 8 * 1024);
    }

    #[test]
    fn event_names_match_frontend_listeners() {
        assert_eq!(RUN_TASK_EVENT, "remote-control://run-task");
        assert_eq!(EMIT_EVENT_EVENT, "remote-control://emit-event");
        assert_eq!(COMMAND_EVENT, "remote-control://command");
    }

    #[test]
    fn capability_gate_reads_are_get_writes_are_mutating() {
        // GET (health + read surface) is read-tier; POST/DELETE need write.
        assert!(!route_needs_write(&Method::GET));
        assert!(route_needs_write(&Method::POST));
        assert!(route_needs_write(&Method::DELETE));
        assert!(route_needs_write(&Method::PUT));
    }

    #[test]
    fn host_allowlist_accepts_loopback() {
        assert!(host_is_local("127.0.0.1:47821"));
        assert!(host_is_local("127.0.0.1"));
        assert!(host_is_local("localhost"));
        assert!(host_is_local("localhost:47821"));
        assert!(host_is_local("[::1]:8080"));
        assert!(host_is_local("[::1]"));
        assert!(host_is_local("::1"));
    }

    #[test]
    fn host_allowlist_rejects_remote() {
        assert!(!host_is_local("evil.com"));
        assert!(!host_is_local("evil.com:47821"));
        assert!(!host_is_local("169.254.1.1"));
        assert!(!host_is_local("0.0.0.0"));
        assert!(!host_is_local(""));
    }

    #[test]
    fn known_targets_cover_all_subsystems() {
        for t in [
            "scheduler.task.run",
            "scheduler.event",
            "workflow.run",
            "workflow.cancel",
            "goal.create",
            "goal.continue",
            "goal.pause",
            "goal.resume",
            "goal.stop",
            "team.dispatch",
            "team.stop",
            "plan.run",
            "chat.send",
            "connector.send",
            "terminal.exec",
            "plugin.enable",
            "plugin.disable",
        ] {
            assert!(KNOWN_TARGETS.contains(&t), "missing target {t}");
        }
        assert_eq!(KNOWN_TARGETS.len(), 17);
    }

    #[test]
    fn sensitive_targets_are_a_subset_of_known_targets() {
        // Every sensitive target must be dispatchable, else the gate guards a
        // command that 404s anyway.
        for t in SENSITIVE_TARGETS {
            assert!(KNOWN_TARGETS.contains(t), "sensitive target {t} not in KNOWN_TARGETS");
            assert!(is_sensitive_target(t));
        }
        // Side-effect-free targets must NOT be flagged sensitive.
        assert!(!is_sensitive_target("workflow.run"));
        assert!(!is_sensitive_target("goal.pause"));
        assert!(!is_sensitive_target("plugin.enable"));
        // terminal.exec runs an arbitrary shell command — it MUST be sensitive.
        assert!(is_sensitive_target("terminal.exec"));
        assert_eq!(SENSITIVE_TARGETS.len(), 4);
    }
}
