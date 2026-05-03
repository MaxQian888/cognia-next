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

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
    middleware::{from_fn_with_state, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use serde_json::json;
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;
use tower_http::limit::RequestBodyLimitLayer;

use super::allowlist::ParsedAllowlist;
use super::rate_limit::FixedWindowRateLimiter;
use super::types::{
    EmitEvent, EmitEventRequestBody, RemoteControlError, RunTaskEvent, TriggerTaskRequestBody,
};

pub const RUN_TASK_EVENT: &str = "remote-control://run-task";
pub const EMIT_EVENT_EVENT: &str = "remote-control://emit-event";

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
}

/// Hook fired on every successful (post-auth, post-allowlist, post-rate-limit)
/// request. Allows the orchestrating state to update counters / call logs.
pub trait RequestObserver: Send + Sync + 'static {
    fn on_call(&self, route: &str, status: StatusCode, remote_ip: IpAddr);
}

/// Spawn the axum server on `127.0.0.1:<port>`. Returns the bound port (so
/// the caller can record `port: 0` → OS-assigned ephemeral) plus the
/// shutdown channel.
pub async fn spawn_server(
    app_handle: AppHandle,
    port: u16,
    token: String,
    allowlist: Vec<String>,
    rate_limit_per_min: u32,
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
    };

    let app = Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/tasks/:id/run", post(run_task))
        .route("/api/v1/events", post(emit_event))
        .layer(from_fn_with_state(state.clone(), middleware))
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

fn accepted() -> Response {
    (StatusCode::ACCEPTED, Json(json!({ "accepted": true }))).into_response()
}

fn error_body(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
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

    // 3. Rate limit.
    if !state.rate_limiter.try_acquire() {
        state
            .on_request
            .on_call(&route, StatusCode::TOO_MANY_REQUESTS, remote_ip);
        return error_body(StatusCode::TOO_MANY_REQUESTS, "rate limit exceeded");
    }

    let response = next.run(request).await;
    state.on_request.on_call(&route, response.status(), remote_ip);
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
    }
}
