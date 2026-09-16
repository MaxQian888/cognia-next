//! `/v1/runs` — the Router + Fusion Run API (ADR-0188 D8/D9/D13/D24, B2–B3).
//!
//! Every endpoint is thin. The gateway authenticates the caller, checks the
//! surface is switched on, and hands the request to the brain, which owns every
//! decision: validation, idempotency, actor isolation, budgets. What this
//! module adds is the HTTP shape the contract names (`contracts/openapi.yaml`)
//! and the event stream.
//!
//! Rules the endpoints keep, and the reasons for them:
//!
//! - **Off is a refusal, not a pretence.** With the `gatewayRuns` switch off —
//!   the default — every route answers `403 ROUTER_FUSION_DISABLED`. A caller
//!   that asked for a run must never be quietly answered by something else
//!   (D38); that guarantee is why the chat endpoints can stay untouched.
//! - **No brain, no answer.** Dexie lives in the brain, so a closed window is
//!   `503 BRAIN_UNAVAILABLE`, never a stale read.
//! - **The stream replays by seq.** Each SSE event is the contract's
//!   `RunEvent`, with its seq as the frame id, so a reconnect with
//!   `Last-Event-ID` resumes exactly where it stopped. A seq the brain no longer
//!   has is `410 EVENT_HISTORY_EXPIRED` from the brain itself; the run's
//!   snapshot is still readable (SSE-04).
//! - **A dropped stream is not a cancel.** The run belongs to the brain and
//!   carries on; a reconnect reads the rest (SSE-03).
//! - **Errors have one shape.** Every refusal is the contract's
//!   `ErrorResponse`: code, message, retryable, details, trace_id.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::brain_bridge::{command, BrainBridge, BrainBridgeError};

/// How often the stream asks the brain for new events. The brain writes them in
/// one transaction with the run's own state, so polling can never see a gap;
/// this is the latency floor, not a correctness knob.
pub const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(250);
/// Comment frames that keep a proxy from closing an idle stream.
pub const SSE_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
/// A stream that has seen nothing at all for this long gives up rather than
/// holding a connection open against a brain that stopped answering.
pub const SSE_MAX_SILENCE: Duration = Duration::from_secs(300);
/// Set on `202` when the Idempotency-Key named a run that already existed.
pub const IDEMPOTENT_REPLAYED_HEADER: &str = "idempotent-replayed";
/// Set on a snapshot whose result outlived its content window.
pub const RESULT_EXPIRED_HEADER: &str = "x-cognia-result-expired";
/// The run a response is about, for a caller that only kept the headers.
pub const RUN_ID_HEADER: &str = "x-cognia-run-id";
/// The artifact content's own hash, so a reader can check what it got.
pub const CONTENT_SHA256_HEADER: &str = "x-cognia-content-sha256";

/// The Run API scopes, mirroring `RUN_API_SCOPES` in `lib/router-fusion/api/run-api.ts`.
pub mod scope {
    pub const CREATE: &str = "runs:create";
    pub const READ: &str = "runs:read";
    pub const CANCEL: &str = "runs:cancel";
    pub const APPROVE: &str = "runs:approve";
    pub const ARTIFACTS_READ: &str = "artifacts:read";
    pub const FEEDBACK: &str = "feedback:write";
}

/// Who is calling, as the auth middleware resolved it. A legacy key carries no
/// scopes, so it reaches the chat endpoints exactly as before and no Run API
/// verb at all.
#[derive(Clone, Debug, Default)]
pub struct RunActor {
    pub key_id: Option<String>,
    pub key_name: String,
    pub scopes: Vec<String>,
}

impl RunActor {
    pub fn has(&self, scope: &str) -> bool {
        self.scopes.iter().any(|held| held == scope)
    }

    pub(crate) fn as_payload(&self) -> Value {
        json!({
            "keyId": self.key_id,
            "keyName": self.key_name,
            "scopes": self.scopes,
        })
    }
}

/// The Router + Fusion surfaces the gateway serves, as the brain last pushed
/// them. Both default to false, which is what a gateway that has never been
/// told anything runs with.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterFusionGatewaySwitches {
    /// `/v1/runs` and the `cognia/*` virtual models.
    pub runs_enabled: bool,
    /// Ledger every model call the gateway proxies (B2 passthrough).
    pub passthrough_ledger_enabled: bool,
}

/// What the run routes read: the link to the brain, and whether the surface is
/// on. Both are set by the host after the server is already listening — the
/// brain attaches when a window opens, and the switches arrive with the
/// settings snapshot — so both live behind a lock.
#[derive(Clone)]
pub struct RunsState {
    bridge: Arc<RwLock<Arc<dyn BrainBridge>>>,
    pub switches: Arc<RwLock<RouterFusionGatewaySwitches>>,
}

impl RunsState {
    pub fn new(bridge: Arc<dyn BrainBridge>) -> Self {
        Self {
            bridge: Arc::new(RwLock::new(bridge)),
            switches: Arc::new(RwLock::new(RouterFusionGatewaySwitches::default())),
        }
    }

    /// A gateway with no brain behind it. Every run route answers 503 until a
    /// host installs one.
    pub fn detached() -> Self {
        Self::new(Arc::new(crate::brain_bridge::DetachedBrainBridge))
    }

    pub fn install_bridge(&self, bridge: Arc<dyn BrainBridge>) {
        *self.bridge.write() = bridge;
    }

    pub fn set_switches(&self, switches: RouterFusionGatewaySwitches) {
        *self.switches.write() = switches;
    }

    pub fn bridge(&self) -> Arc<dyn BrainBridge> {
        self.bridge.read().clone()
    }

    pub fn runs_enabled(&self) -> bool {
        self.switches.read().runs_enabled
    }

    pub fn passthrough_ledger_enabled(&self) -> bool {
        self.switches.read().passthrough_ledger_enabled
    }
}

/// Whether a caller may simply try again: the refusal is about load or a
/// dependency, not about the request.
fn retryable(status: StatusCode) -> bool {
    matches!(status.as_u16(), 429 | 503)
}

/// The contract's `ErrorResponse`. `details` is always an object; anything
/// else the brain sent is kept under `value` rather than dropped.
pub fn error_body(status: StatusCode, code: &str, message: &str, details: Option<Value>) -> Value {
    let details = match details {
        Some(Value::Object(map)) => Value::Object(map),
        Some(Value::Null) | None => json!({}),
        Some(other) => json!({ "value": other }),
    };
    json!({
        "error": {
            "code": code,
            "message": message,
            "retryable": retryable(status),
            "details": details,
            "trace_id": uuid::Uuid::new_v4().to_string(),
        }
    })
}

pub fn error_response(
    status: StatusCode,
    code: &str,
    message: &str,
    details: Option<Value>,
) -> Response {
    (status, Json(error_body(status, code, message, details))).into_response()
}

fn disabled() -> Response {
    error_response(
        StatusCode::FORBIDDEN,
        "ROUTER_FUSION_DISABLED",
        "Router + Fusion runs are switched off for this host",
        None,
    )
}

pub(crate) fn missing_scope(scope: &str) -> Response {
    error_response(
        StatusCode::FORBIDDEN,
        "SCOPE_REQUIRED",
        &format!("this key is missing the {scope} scope"),
        Some(json!({ "scope": scope })),
    )
}

/// What a bridge failure looks like to the caller, as status, code, message
/// and details — shared by the JSON routes and by streams that can no longer
/// change their status.
pub(crate) fn bridge_failure(
    error_value: BrainBridgeError,
) -> (StatusCode, String, String, Option<Value>) {
    match error_value {
        BrainBridgeError::Unavailable(reason) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "BRAIN_UNAVAILABLE".to_string(),
            reason,
            None,
        ),
        BrainBridgeError::Refused {
            status,
            code,
            message,
            details,
        } => (
            // A refusal is an error status: a 2xx or 3xx from a confused brain
            // would tell the caller its request worked.
            StatusCode::from_u16(status)
                .ok()
                .filter(|s| s.is_client_error() || s.is_server_error())
                .unwrap_or(StatusCode::BAD_REQUEST),
            code,
            message,
            details,
        ),
    }
}

pub(crate) fn bridge_error(error_value: BrainBridgeError) -> Response {
    let (status, code, message, details) = bridge_failure(error_value);
    error_response(status, &code, &message, details)
}

/// An answer from the brain in a shape this gateway does not know. Reported as
/// unavailable: the brain and the gateway disagree, and retrying after an
/// update is the only remedy.
pub(crate) fn unreadable_answer(what: &str) -> Response {
    error_response(
        StatusCode::SERVICE_UNAVAILABLE,
        "BRAIN_ANSWER_UNREADABLE",
        &format!("the brain's answer to {what} is not in a shape this gateway reads"),
        None,
    )
}

/// Everything a run endpoint does before it can talk to the brain.
fn guard(state: &RunsState, actor: &RunActor, scope: &str) -> Option<Response> {
    if !state.runs_enabled() {
        return Some(disabled());
    }
    if !actor.has(scope) {
        return Some(missing_scope(scope));
    }
    None
}

async fn ask(
    state: &RunsState,
    command_name: &'static str,
    payload: Value,
) -> Result<Value, Response> {
    state
        .bridge()
        .call(command_name, payload)
        .await
        .map_err(bridge_error)
}

fn idempotency_key(headers: &HeaderMap) -> Option<String> {
    headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

fn with_header(mut response: Response, name: &'static str, value: &str) -> Response {
    if let Ok(value) = HeaderValue::from_str(value) {
        response.headers_mut().insert(name, value);
    }
    response
}

fn missing_body() -> Response {
    error_response(
        StatusCode::UNPROCESSABLE_ENTITY,
        "SCHEMA_INVALID",
        "the request body must be a JSON object",
        None,
    )
}

/// `202` with the contract's `RunAccepted`, from the brain's `RunCreated`, and
/// the run's id. `None` when the brain's answer is not a `RunCreated`,
/// including a run id that is not the contract's UUID: it is echoed into
/// headers and paths, so nothing else is trusted there.
pub(crate) fn accepted_response(value: &Value) -> Option<(Response, String)> {
    let accepted = value.get("accepted").filter(|v| v.is_object())?;
    let run_id = accepted.get("run_id").and_then(Value::as_str)?;
    let run_id = uuid::Uuid::parse_str(run_id).ok()?.hyphenated().to_string();
    let mut response = (StatusCode::ACCEPTED, Json(accepted.clone())).into_response();
    if value.get("replayed").and_then(Value::as_bool) == Some(true) {
        response
            .headers_mut()
            .insert(IDEMPOTENT_REPLAYED_HEADER, HeaderValue::from_static("true"));
    }
    let response = with_header(response, "location", &format!("/v1/runs/{run_id}"));
    Some((with_header(response, RUN_ID_HEADER, &run_id), run_id))
}

async fn create_run(
    State(state): State<RunsState>,
    Extension(actor): Extension<RunActor>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if let Some(refusal) = guard(&state, &actor, scope::CREATE) {
        return refusal;
    }
    let Some(Json(body)) = body else {
        return missing_body();
    };
    let payload = json!({
        "actor": actor.as_payload(),
        "body": body,
        "idempotencyKey": idempotency_key(&headers),
    });
    match ask(&state, command::RUN_CREATE, payload).await {
        Ok(value) => match accepted_response(&value) {
            Some((response, _)) => response,
            None => unreadable_answer("a run creation"),
        },
        Err(response) => response,
    }
}

async fn get_run(
    State(state): State<RunsState>,
    Extension(actor): Extension<RunActor>,
    Path(run_id): Path<String>,
) -> Response {
    if let Some(refusal) = guard(&state, &actor, scope::READ) {
        return refusal;
    }
    let payload = json!({ "actor": actor.as_payload(), "runId": run_id });
    match ask(&state, command::RUN_GET, payload).await {
        Ok(value) => {
            let Some(snapshot) = value.get("snapshot").filter(|v| v.is_object()) else {
                return unreadable_answer("a run read");
            };
            let response = Json(snapshot.clone()).into_response();
            if value.get("resultExpired").and_then(Value::as_bool) == Some(true) {
                with_header(response, RESULT_EXPIRED_HEADER, "true")
            } else {
                response
            }
        }
        Err(response) => response,
    }
}

async fn cancel_run(
    State(state): State<RunsState>,
    Extension(actor): Extension<RunActor>,
    Path(run_id): Path<String>,
) -> Response {
    if let Some(refusal) = guard(&state, &actor, scope::CANCEL) {
        return refusal;
    }
    let payload = json!({ "actor": actor.as_payload(), "runId": run_id });
    match ask(&state, command::RUN_CANCEL, payload).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(response) => response,
    }
}

async fn resume_run(
    State(state): State<RunsState>,
    Extension(actor): Extension<RunActor>,
    Path(run_id): Path<String>,
    body: Option<Json<Value>>,
) -> Response {
    if let Some(refusal) = guard(&state, &actor, scope::APPROVE) {
        return refusal;
    }
    let Some(Json(body)) = body else {
        return missing_body();
    };
    // The brain validates the resume against the contract's `ResumeRequest`.
    let payload = json!({ "actor": actor.as_payload(), "runId": run_id, "body": body });
    match ask(&state, command::RUN_RESUME, payload).await {
        Ok(snapshot) => (StatusCode::ACCEPTED, Json(snapshot)).into_response(),
        Err(response) => response,
    }
}

async fn run_feedback(
    State(state): State<RunsState>,
    Extension(actor): Extension<RunActor>,
    Path(run_id): Path<String>,
    body: Option<Json<Value>>,
) -> Response {
    if let Some(refusal) = guard(&state, &actor, scope::FEEDBACK) {
        return refusal;
    }
    let Some(Json(feedback)) = body else {
        return missing_body();
    };
    let payload = json!({ "actor": actor.as_payload(), "runId": run_id, "feedback": feedback });
    match ask(&state, command::RUN_FEEDBACK, payload).await {
        Ok(acknowledgement) => (StatusCode::CREATED, Json(acknowledgement)).into_response(),
        Err(response) => response,
    }
}

async fn get_session(
    State(state): State<RunsState>,
    Extension(actor): Extension<RunActor>,
    Path(session_id): Path<String>,
) -> Response {
    if let Some(refusal) = guard(&state, &actor, scope::READ) {
        return refusal;
    }
    let payload = json!({ "actor": actor.as_payload(), "sessionId": session_id });
    match ask(&state, command::SESSION_GET, payload).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(response) => response,
    }
}

/// The origin a read link should point back at: this gateway, as the caller
/// reached it. The Host header already passed the gateway's allowlist.
pub fn public_base_url(headers: &HeaderMap) -> String {
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("127.0.0.1");
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .filter(|proto| *proto == "https" || *proto == "http")
        .unwrap_or("http");
    format!("{scheme}://{host}")
}

async fn get_artifact(
    State(state): State<RunsState>,
    Extension(actor): Extension<RunActor>,
    Path(artifact_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Some(refusal) = guard(&state, &actor, scope::ARTIFACTS_READ) {
        return refusal;
    }
    let payload = json!({
        "actor": actor.as_payload(),
        "artifactId": artifact_id,
        "baseUrl": public_base_url(&headers),
    });
    match ask(&state, command::ARTIFACT_GET, payload).await {
        Ok(metadata) => Json(metadata).into_response(),
        Err(response) => response,
    }
}

/// The artifact itself, behind the sixty-second token the metadata issued.
/// Still an authenticated route: the token is bound to the key that asked for
/// it, so it is a second check, not a bearer credential on its own.
async fn read_artifact(
    State(state): State<RunsState>,
    Extension(actor): Extension<RunActor>,
    Path(artifact_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if let Some(refusal) = guard(&state, &actor, scope::ARTIFACTS_READ) {
        return refusal;
    }
    let payload = json!({
        "actor": actor.as_payload(),
        "artifactId": artifact_id,
        "token": query.get("token"),
    });
    let value = match ask(&state, command::ARTIFACT_READ, payload).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let Some(content) = value.get("content").and_then(Value::as_str) else {
        return unreadable_answer("an artifact read");
    };
    let media_type = value
        .get("mediaType")
        .and_then(Value::as_str)
        .and_then(|media| HeaderValue::from_str(media).ok())
        .unwrap_or_else(|| HeaderValue::from_static("application/octet-stream"));
    let mut response = (StatusCode::OK, content.to_string()).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, media_type);
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    // Evidence is model- and web-derived. Served from the gateway's origin, an
    // HTML or SVG artifact must never run as a page there: a download, in an
    // opaque sandbox if a browser renders it anyway.
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox; default-src 'none'"),
    );
    if let Some(sha) = value.get("contentSha256").and_then(Value::as_str) {
        return with_header(response, CONTENT_SHA256_HEADER, sha);
    }
    response
}

/// The seq a reconnecting client already has. `Last-Event-ID` is the standard
/// header; `?after_seq=` is the same thing for a client that cannot set one.
pub fn resume_from(headers: &HeaderMap, query: &HashMap<String, String>) -> Option<u64> {
    headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .or_else(|| query.get("after_seq").and_then(|value| value.parse().ok()))
}

/// One poll's worth of events, as the brain reports them (`RunEventsPage`).
#[derive(Debug, Clone, Deserialize)]
struct EventsPage {
    #[serde(default)]
    events: Vec<Value>,
    #[serde(default)]
    terminal: bool,
}

/// One contract `RunEvent` as an SSE frame: the seq is the id, the event type
/// is the event name, the whole event is the data.
fn event_frame(event: &Value) -> Option<(u64, Event)> {
    let seq = event.get("seq").and_then(Value::as_u64)?;
    let kind = event.get("event_type").and_then(Value::as_str)?;
    Some((
        seq,
        Event::default()
            .id(seq.to_string())
            .event(sse_event_name(kind))
            .data(event.to_string()),
    ))
}

/// The SSE event name for a contract event type. The field line cannot carry
/// a line break (the SSE writer panics on one), so anything outside the
/// contract's `word.word` alphabet is named `message` and still delivered
/// with its full event as data: a gap would be worse than a generic name.
fn sse_event_name(kind: &str) -> &str {
    let valid = !kind.is_empty()
        && kind
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if valid {
        kind
    } else {
        "message"
    }
}

fn events_payload(actor: &RunActor, run_id: &str, after: u64) -> Value {
    json!({ "actor": actor.as_payload(), "runId": run_id, "afterSeq": after })
}

async fn run_events(
    State(state): State<RunsState>,
    Extension(actor): Extension<RunActor>,
    Path(run_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Some(refusal) = guard(&state, &actor, scope::READ) {
        return refusal;
    }
    let after = resume_from(&headers, &query).unwrap_or(0);

    // One eager read before the stream opens, so a run the caller may not see,
    // or a seq whose history is gone, is an HTTP status (the brain's own 404 or
    // 410) rather than a stream that immediately ends.
    let first = match ask(
        &state,
        command::RUN_EVENTS,
        events_payload(&actor, &run_id, after),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };

    let stream = futures_util::stream::unfold(
        StreamState {
            state,
            actor,
            run_id,
            after,
            pending: Some(first),
            silence: Duration::ZERO,
            done: false,
        },
        |mut stream_state| async move {
            loop {
                if stream_state.done {
                    return None;
                }
                let page = match stream_state.pending.take() {
                    Some(value) => value,
                    None => {
                        tokio::time::sleep(EVENT_POLL_INTERVAL).await;
                        stream_state.silence += EVENT_POLL_INTERVAL;
                        if stream_state.silence >= SSE_MAX_SILENCE {
                            return None;
                        }
                        let payload = events_payload(
                            &stream_state.actor,
                            &stream_state.run_id,
                            stream_state.after,
                        );
                        match stream_state
                            .state
                            .bridge()
                            .call(command::RUN_EVENTS, payload)
                            .await
                        {
                            Ok(value) => value,
                            // The brain went away, or the history moved on,
                            // mid-stream. Ending the stream is honest; the
                            // client reconnects with its Last-Event-ID and
                            // gets either the rest or a 410 and the snapshot.
                            Err(_) => return None,
                        }
                    }
                };
                let page: EventsPage = serde_json::from_value(page).unwrap_or(EventsPage {
                    events: Vec::new(),
                    terminal: false,
                });
                let mut frames = Vec::with_capacity(page.events.len());
                for event in &page.events {
                    let Some((seq, frame)) = event_frame(event) else {
                        continue;
                    };
                    // A seq the client already has is never sent twice.
                    if seq <= stream_state.after {
                        continue;
                    }
                    stream_state.after = seq;
                    frames.push(frame);
                }
                if frames.is_empty() {
                    if page.terminal {
                        return None;
                    }
                    continue;
                }
                stream_state.silence = Duration::ZERO;
                stream_state.done = page.terminal;
                return Some((
                    futures_util::stream::iter(frames.into_iter().map(Ok::<Event, Infallible>)),
                    stream_state,
                ));
            }
        },
    );

    Sse::new(futures_util::StreamExt::flatten(stream))
        .keep_alive(KeepAlive::new().interval(SSE_KEEPALIVE_INTERVAL))
        .into_response()
}

struct StreamState {
    state: RunsState,
    actor: RunActor,
    run_id: String,
    after: u64,
    pending: Option<Value>,
    silence: Duration,
    done: bool,
}

/// The Run API routes. Merged into the gateway's authenticated router, so the
/// same Host, origin, allowlist, key and rate-limit checks run first.
pub fn routes() -> Router<RunsState> {
    Router::new()
        .route("/v1/runs", post(create_run))
        .route("/v1/runs/{run_id}", get(get_run))
        .route("/v1/runs/{run_id}/cancel", post(cancel_run))
        .route("/v1/runs/{run_id}/resume", post(resume_run))
        .route("/v1/runs/{run_id}/feedback", post(run_feedback))
        .route("/v1/runs/{run_id}/events", get(run_events))
        .route("/v1/sessions/{session_id}", get(get_session))
        .route("/v1/artifacts/{artifact_id}", get(get_artifact))
        .route("/v1/artifacts/{artifact_id}/content", get(read_artifact))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brain_bridge::RecordingBrainBridge;
    use axum::body::Body;
    use axum::http::Request;
    use futures_util::StreamExt;
    use tower::ServiceExt;

    fn app(bridge: RecordingBrainBridge, actor: RunActor, enabled: bool) -> (Router, RunsState) {
        let state = RunsState::new(Arc::new(bridge));
        state.switches.write().runs_enabled = enabled;
        let router = routes().layer(Extension(actor)).with_state(state.clone());
        (router, state)
    }

    fn actor_with(scopes: &[&str]) -> RunActor {
        RunActor {
            key_id: Some("key-a".into()),
            key_name: "CI robot".into(),
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
        }
    }

    async fn body_json(response: Response) -> Value {
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("a body");
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    }

    fn post_json(uri: &str, body: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn get_req(uri: &str) -> Request<Body> {
        Request::builder().uri(uri).body(Body::empty()).unwrap()
    }

    fn event(seq: u64, kind: &str) -> Value {
        json!({
            "schema_version": "1.0.0",
            "run_id": "11111111-1111-4111-8111-111111111111",
            "seq": seq,
            "event_type": kind,
            "timestamp": "2026-09-16T08:00:00.000Z",
            "payload": {}
        })
    }

    /// Every error body is the contract's `ErrorResponse`, nothing more.
    fn assert_error_shape(body: &Value, code: &str) {
        let error = body["error"].as_object().expect("an error object");
        let mut keys: Vec<&str> = error.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["code", "details", "message", "retryable", "trace_id"]
        );
        assert_eq!(body["error"]["code"], code);
        assert!(body["error"]["details"].is_object());
        assert!(!body["error"]["trace_id"].as_str().unwrap_or("").is_empty());
        assert_eq!(body.as_object().map(|o| o.len()), Some(1));
    }

    #[tokio::test]
    async fn every_route_refuses_while_the_surface_is_off() {
        let bridge = RecordingBrainBridge::new();
        let actor = actor_with(&[scope::CREATE, scope::READ, scope::ARTIFACTS_READ]);
        let (router, _) = app(bridge.clone(), actor, false);
        for request in [
            post_json("/v1/runs", "{}"),
            get_req("/v1/runs/run-1"),
            get_req("/v1/runs/run-1/events"),
            get_req("/v1/sessions/s-1"),
            get_req("/v1/artifacts/a-1"),
            get_req("/v1/artifacts/a-1/content?token=t"),
        ] {
            let uri = request.uri().to_string();
            let response = router.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{uri}");
            let body = body_json(response).await;
            assert_error_shape(&body, "ROUTER_FUSION_DISABLED");
            assert_eq!(body["error"]["retryable"], false);
        }
        // Nothing was asked of the brain: off means the brain is never woken.
        assert!(bridge.calls().is_empty());
    }

    #[tokio::test]
    async fn a_legacy_key_without_scopes_reaches_no_run_verb() {
        let bridge = RecordingBrainBridge::new();
        let (router, _) = app(bridge.clone(), actor_with(&[]), true);
        let response = router.oneshot(post_json("/v1/runs", "{}")).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body = body_json(response).await;
        assert_error_shape(&body, "SCOPE_REQUIRED");
        assert_eq!(body["error"]["details"]["scope"], scope::CREATE);
        assert!(bridge.calls().is_empty());
    }

    #[tokio::test]
    async fn a_created_run_answers_202_with_run_accepted_and_carries_the_idempotency_key() {
        let bridge = RecordingBrainBridge::new();
        let accepted = json!({
            "schema_version": "1.0.0",
            "run_id": "11111111-1111-4111-8111-111111111111",
            "session_id": "22222222-2222-4222-8222-222222222222",
            "session_version": 0,
            "status": "queued",
            "version": 2,
            "created_at": "2026-09-16T08:00:00.000Z"
        });
        bridge.ok(
            command::RUN_CREATE,
            json!({ "accepted": accepted, "replayed": false }),
        );
        bridge.ok(
            command::RUN_CREATE,
            json!({ "accepted": accepted, "replayed": true }),
        );
        let (router, _) = app(bridge.clone(), actor_with(&[scope::CREATE]), true);
        let request = || {
            Request::builder()
                .method("POST")
                .uri("/v1/runs")
                .header("content-type", "application/json")
                .header("idempotency-key", "k1")
                .body(Body::from(r#"{"mode":"auto"}"#))
                .unwrap()
        };
        let response = router.clone().oneshot(request()).await.unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert!(response.headers().get(IDEMPOTENT_REPLAYED_HEADER).is_none());
        assert_eq!(
            response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok()),
            Some("/v1/runs/11111111-1111-4111-8111-111111111111")
        );
        assert_eq!(body_json(response).await, accepted);

        let replay = router.oneshot(request()).await.unwrap();
        assert_eq!(replay.status(), StatusCode::ACCEPTED);
        assert_eq!(
            replay
                .headers()
                .get(IDEMPOTENT_REPLAYED_HEADER)
                .and_then(|v| v.to_str().ok()),
            Some("true")
        );

        let payload = &bridge.payloads_for(command::RUN_CREATE)[0];
        assert_eq!(payload["idempotencyKey"], "k1");
        assert_eq!(payload["body"]["mode"], "auto");
        assert_eq!(payload["actor"]["keyId"], "key-a");
        assert_eq!(payload["actor"]["scopes"][0], scope::CREATE);
    }

    #[tokio::test]
    async fn an_answer_the_gateway_cannot_read_is_not_passed_off_as_accepted() {
        let bridge = RecordingBrainBridge::new();
        bridge.ok(command::RUN_CREATE, json!({ "runId": "old-shape" }));
        let (router, _) = app(bridge, actor_with(&[scope::CREATE]), true);
        let response = router.oneshot(post_json("/v1/runs", "{}")).await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_error_shape(&body_json(response).await, "BRAIN_ANSWER_UNREADABLE");
    }

    #[tokio::test]
    async fn a_run_id_that_is_not_a_uuid_never_reaches_a_header() {
        for bad in ["r1\r\nset-cookie: x=1", "../other", ""] {
            let bridge = RecordingBrainBridge::new();
            let mut answer = json!({ "accepted": { "run_id": bad, "status": "queued" } });
            answer["replayed"] = json!(false);
            bridge.ok(command::RUN_CREATE, answer);
            let (router, _) = app(bridge, actor_with(&[scope::CREATE]), true);
            let response = router.oneshot(post_json("/v1/runs", "{}")).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::SERVICE_UNAVAILABLE,
                "{bad:?}"
            );
            assert!(response.headers().get("location").is_none(), "{bad:?}");
        }
    }

    #[test]
    fn a_brain_refusal_is_always_an_error_status() {
        for (sent, expected) in [(200, 400), (302, 400), (99, 400), (409, 409), (503, 503)] {
            let (status, ..) = bridge_failure(BrainBridgeError::Refused {
                status: sent,
                code: "X".into(),
                message: "m".into(),
                details: None,
            });
            assert_eq!(status.as_u16(), expected, "{sent}");
        }
    }

    #[test]
    fn an_event_type_that_cannot_be_an_sse_name_is_still_delivered() {
        assert_eq!(sse_event_name("run.completed"), "run.completed");
        assert_eq!(sse_event_name("answer_delta-2"), "answer_delta-2");
        assert_eq!(sse_event_name("run.x\r\nevent: forged"), "message");
        assert_eq!(sse_event_name(""), "message");
        // The frame itself builds without panicking, and keeps its seq.
        let (seq, _) = event_frame(&event(7, "bad\nname")).expect("a frame");
        assert_eq!(seq, 7);
    }

    #[tokio::test]
    async fn a_request_with_no_body_is_refused_before_the_brain() {
        let bridge = RecordingBrainBridge::new();
        let (router, _) = app(
            bridge.clone(),
            actor_with(&[scope::CREATE, scope::APPROVE]),
            true,
        );
        for uri in ["/v1/runs", "/v1/runs/run-1/resume"] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(uri)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert!(response.status().is_client_error(), "{uri}");
        }
        assert!(bridge.calls().is_empty());
    }

    #[tokio::test]
    async fn the_brains_refusal_is_the_apis_refusal() {
        let bridge = RecordingBrainBridge::new();
        bridge.refuse(command::RUN_CREATE, 409, "IDEMPOTENCY_CONFLICT");
        let (router, _) = app(bridge, actor_with(&[scope::CREATE]), true);
        let response = router.oneshot(post_json("/v1/runs", "{}")).await.unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = body_json(response).await;
        assert_error_shape(&body, "IDEMPOTENCY_CONFLICT");
        assert_eq!(body["error"]["retryable"], false);
    }

    #[tokio::test]
    async fn a_closed_window_is_a_retryable_503_rather_than_a_stale_read() {
        let bridge = RecordingBrainBridge::new();
        bridge.answer(
            command::RUN_GET,
            Err(BrainBridgeError::unavailable("no window attached")),
        );
        let (router, _) = app(bridge, actor_with(&[scope::READ]), true);
        let response = router.oneshot(get_req("/v1/runs/run-1")).await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = body_json(response).await;
        assert_error_shape(&body, "BRAIN_UNAVAILABLE");
        assert_eq!(body["error"]["retryable"], true);
    }

    #[tokio::test]
    async fn a_run_read_is_the_snapshot_and_says_when_its_result_has_expired() {
        let bridge = RecordingBrainBridge::new();
        let snapshot = json!({ "run_id": "r", "status": "succeeded", "result": null });
        bridge.ok(
            command::RUN_GET,
            json!({ "snapshot": snapshot, "resultExpired": true }),
        );
        bridge.ok(
            command::RUN_GET,
            json!({ "snapshot": snapshot, "resultExpired": false }),
        );
        let (router, _) = app(bridge, actor_with(&[scope::READ]), true);
        let expired = router.clone().oneshot(get_req("/v1/runs/r")).await.unwrap();
        assert_eq!(expired.status(), StatusCode::OK);
        assert_eq!(
            expired
                .headers()
                .get(RESULT_EXPIRED_HEADER)
                .and_then(|v| v.to_str().ok()),
            Some("true")
        );
        assert_eq!(body_json(expired).await, snapshot);
        let fresh = router.oneshot(get_req("/v1/runs/r")).await.unwrap();
        assert!(fresh.headers().get(RESULT_EXPIRED_HEADER).is_none());
    }

    #[tokio::test]
    async fn cancel_resume_and_feedback_answer_with_the_contracts_statuses() {
        let bridge = RecordingBrainBridge::new();
        bridge.ok(
            command::RUN_CANCEL,
            json!({ "run_id": "r", "status": "cancelling" }),
        );
        bridge.ok(
            command::RUN_RESUME,
            json!({ "run_id": "r", "status": "running" }),
        );
        bridge.ok(command::RUN_FEEDBACK, json!({ "accepted": true }));
        let actor = actor_with(&[scope::CANCEL, scope::APPROVE, scope::FEEDBACK]);
        let (router, _) = app(bridge.clone(), actor, true);

        let cancel = router
            .clone()
            .oneshot(post_json("/v1/runs/r/cancel", "{}"))
            .await
            .unwrap();
        assert_eq!(cancel.status(), StatusCode::OK);
        let resume_body = r#"{"schema_version":"1.0.0","kind":"input","input_messages":[{"role":"user","content":"more"}]}"#;
        let resume = router
            .clone()
            .oneshot(post_json("/v1/runs/r/resume", resume_body))
            .await
            .unwrap();
        assert_eq!(resume.status(), StatusCode::ACCEPTED);
        let feedback = router
            .oneshot(post_json("/v1/runs/r/feedback", r#"{"rating":"positive"}"#))
            .await
            .unwrap();
        assert_eq!(feedback.status(), StatusCode::CREATED);
        assert_eq!(body_json(feedback).await, json!({ "accepted": true }));

        // The resume body reaches the brain as the caller sent it.
        assert_eq!(
            bridge.payloads_for(command::RUN_RESUME)[0]["body"]["kind"],
            "input"
        );
        assert_eq!(
            bridge.payloads_for(command::RUN_FEEDBACK)[0]["feedback"]["rating"],
            "positive"
        );
    }

    #[tokio::test]
    async fn cancel_resume_feedback_and_artifacts_each_need_their_own_scope() {
        for (method, uri, scope_needed) in [
            ("POST", "/v1/runs/run-1/cancel", scope::CANCEL),
            ("POST", "/v1/runs/run-1/resume", scope::APPROVE),
            ("POST", "/v1/runs/run-1/feedback", scope::FEEDBACK),
            ("GET", "/v1/artifacts/a-1", scope::ARTIFACTS_READ),
            (
                "GET",
                "/v1/artifacts/a-1/content?token=t",
                scope::ARTIFACTS_READ,
            ),
        ] {
            let bridge = RecordingBrainBridge::new();
            let (router, _) = app(bridge.clone(), actor_with(&[scope::READ]), true);
            let response = router
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(uri)
                        .header("content-type", "application/json")
                        .body(if method == "POST" {
                            Body::from("{}")
                        } else {
                            Body::empty()
                        })
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{uri}");
            assert_eq!(
                body_json(response).await["error"]["details"]["scope"],
                scope_needed
            );
            assert!(bridge.calls().is_empty(), "{uri}");
        }
    }

    #[tokio::test]
    async fn a_session_read_asks_the_brain_for_the_actors_own_conversation() {
        let bridge = RecordingBrainBridge::new();
        bridge.ok(
            command::SESSION_GET,
            json!({ "session_id": "s-1", "session_version": 3, "messages": [] }),
        );
        bridge.refuse(command::SESSION_GET, 404, "SESSION_NOT_FOUND");
        let (router, _) = app(bridge.clone(), actor_with(&[scope::READ]), true);
        let found = router
            .clone()
            .oneshot(get_req("/v1/sessions/s-1"))
            .await
            .unwrap();
        assert_eq!(found.status(), StatusCode::OK);
        assert_eq!(body_json(found).await["session_version"], 3);
        let missing = router.oneshot(get_req("/v1/sessions/s-2")).await.unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert_error_shape(&body_json(missing).await, "SESSION_NOT_FOUND");
        assert_eq!(
            bridge.payloads_for(command::SESSION_GET)[0]["sessionId"],
            "s-1"
        );
    }

    #[tokio::test]
    async fn artifact_metadata_names_this_gateway_as_the_read_links_origin() {
        let bridge = RecordingBrainBridge::new();
        bridge.ok(
            command::ARTIFACT_GET,
            json!({ "artifact_id": "a-1", "read_url": "x" }),
        );
        let (router, _) = app(bridge.clone(), actor_with(&[scope::ARTIFACTS_READ]), true);
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/v1/artifacts/a-1")
                    .header("host", "127.0.0.1:8787")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let payload = &bridge.payloads_for(command::ARTIFACT_GET)[0];
        assert_eq!(payload["artifactId"], "a-1");
        assert_eq!(payload["baseUrl"], "http://127.0.0.1:8787");
    }

    #[test]
    fn the_read_links_origin_honours_only_a_known_forwarded_scheme() {
        let mut headers = HeaderMap::new();
        assert_eq!(public_base_url(&headers), "http://127.0.0.1");
        headers.insert(header::HOST, "gw.example".parse().unwrap());
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        assert_eq!(public_base_url(&headers), "https://gw.example");
        headers.insert("x-forwarded-proto", "javascript".parse().unwrap());
        assert_eq!(public_base_url(&headers), "http://gw.example");
    }

    #[tokio::test]
    async fn artifact_content_is_served_raw_with_its_type_and_hash_and_never_cached() {
        let bridge = RecordingBrainBridge::new();
        bridge.ok(
            command::ARTIFACT_READ,
            json!({ "content": "{\"total\":42}", "mediaType": "application/json", "contentSha256": "ab12" }),
        );
        bridge.refuse(command::ARTIFACT_READ, 410, "READ_TOKEN_EXPIRED");
        let (router, _) = app(bridge.clone(), actor_with(&[scope::ARTIFACTS_READ]), true);
        let response = router
            .clone()
            .oneshot(get_req("/v1/artifacts/a-1/content?token=abc.def"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers().clone();
        assert_eq!(
            headers.get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
        assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), "no-store");
        assert_eq!(headers.get(CONTENT_SHA256_HEADER).unwrap(), "ab12");
        assert_eq!(
            headers.get(header::CONTENT_DISPOSITION).unwrap(),
            "attachment"
        );
        assert_eq!(
            headers.get(header::CONTENT_SECURITY_POLICY).unwrap(),
            "sandbox; default-src 'none'"
        );
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        assert_eq!(&bytes[..], br#"{"total":42}"#);
        assert_eq!(
            bridge.payloads_for(command::ARTIFACT_READ)[0]["token"],
            "abc.def"
        );

        let expired = router
            .oneshot(get_req("/v1/artifacts/a-1/content?token=old"))
            .await
            .unwrap();
        assert_eq!(expired.status(), StatusCode::GONE);
        assert_error_shape(&body_json(expired).await, "READ_TOKEN_EXPIRED");
    }

    #[tokio::test]
    async fn sse_04_an_expired_seq_is_410_and_the_snapshot_is_still_readable() {
        // [ACC:SSE-04]
        let bridge = RecordingBrainBridge::new();
        bridge.refuse(command::RUN_EVENTS, 410, "EVENT_HISTORY_EXPIRED");
        bridge.ok(
            command::RUN_GET,
            json!({ "snapshot": { "run_id": "run-1", "status": "succeeded" }, "resultExpired": false }),
        );
        let (router, _) = app(bridge.clone(), actor_with(&[scope::READ]), true);
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/runs/run-1/events")
                    .header("last-event-id", "3")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::GONE);
        assert_error_shape(&body_json(response).await, "EVENT_HISTORY_EXPIRED");
        assert_eq!(bridge.payloads_for(command::RUN_EVENTS)[0]["afterSeq"], 3);

        let snapshot = router.oneshot(get_req("/v1/runs/run-1")).await.unwrap();
        assert_eq!(snapshot.status(), StatusCode::OK);
        assert_eq!(body_json(snapshot).await["status"], "succeeded");
    }

    #[tokio::test]
    async fn a_resumed_stream_of_a_run_that_is_not_there_is_a_plain_404() {
        let bridge = RecordingBrainBridge::new();
        bridge.refuse(command::RUN_EVENTS, 404, "RUN_NOT_FOUND");
        let (router, _) = app(bridge, actor_with(&[scope::READ]), true);
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/v1/runs/run-1/events")
                    .header("last-event-id", "7")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_error_shape(&body_json(response).await, "RUN_NOT_FOUND");
    }

    #[tokio::test]
    async fn the_stream_carries_each_run_event_with_its_seq_and_ends_at_the_terminal_page() {
        let bridge = RecordingBrainBridge::new();
        bridge.ok(
            command::RUN_EVENTS,
            json!({
                "events": [event(1, "run.queued"), event(2, "run.completed")],
                "lastSeq": 2,
                "terminal": true
            }),
        );
        let (router, _) = app(bridge.clone(), actor_with(&[scope::READ]), true);
        let response = router
            .oneshot(get_req("/v1/runs/run-1/events"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok()),
            Some("text/event-stream")
        );
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("the stream ends once the run is terminal");
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("id: 1\n"), "{text}");
        assert!(text.contains("event: run.queued\n"), "{text}");
        assert!(text.contains("id: 2\n"), "{text}");
        assert!(text.contains("event: run.completed\n"), "{text}");
        // The data line is the contract's whole RunEvent.
        let data: Value = serde_json::from_str(
            text.lines()
                .find_map(|line| line.strip_prefix("data: "))
                .expect("a data line"),
        )
        .unwrap();
        assert_eq!(data, event(1, "run.queued"));
        // One poll: a terminal page is the end of the stream.
        assert_eq!(bridge.payloads_for(command::RUN_EVENTS).len(), 1);
    }

    #[tokio::test]
    async fn sse_01_a_reconnect_asks_only_for_what_it_has_not_seen_and_never_repeats_a_seq() {
        // [ACC:SSE-01]
        let bridge = RecordingBrainBridge::new();
        bridge.ok(
            command::RUN_EVENTS,
            // A brain that answers with an overlap must not make the client see 12 twice.
            json!({ "events": [event(12, "phase.changed"), event(13, "answer.completed"), event(14, "run.completed")], "terminal": true }),
        );
        let (router, _) = app(bridge.clone(), actor_with(&[scope::READ]), true);
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/v1/runs/run-1/events")
                    .header("last-event-id", "12")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(bridge.payloads_for(command::RUN_EVENTS)[0]["afterSeq"], 12);
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let text = String::from_utf8_lossy(&bytes);
        let ids: Vec<&str> = text
            .lines()
            .filter_map(|line| line.strip_prefix("id: "))
            .collect();
        assert_eq!(ids, ["13", "14"]);
    }

    #[tokio::test(start_paused = true)]
    async fn rec_07_polling_alone_delivers_every_seq_across_pages_without_a_gap() {
        // [ACC:REC-07] No notification channel at all: the stream is only its polls.
        let bridge = RecordingBrainBridge::new();
        bridge.ok(
            command::RUN_EVENTS,
            json!({ "events": [event(1, "run.queued"), event(2, "phase.changed")], "terminal": false }),
        );
        bridge.ok(
            command::RUN_EVENTS,
            json!({ "events": [], "terminal": false }),
        );
        bridge.ok(
            command::RUN_EVENTS,
            json!({ "events": [event(3, "answer.completed"), event(4, "run.completed")], "terminal": true }),
        );
        let (router, _) = app(bridge.clone(), actor_with(&[scope::READ]), true);
        let response = router
            .oneshot(get_req("/v1/runs/run-1/events"))
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let text = String::from_utf8_lossy(&bytes);
        let ids: Vec<&str> = text
            .lines()
            .filter_map(|line| line.strip_prefix("id: "))
            .collect();
        assert_eq!(ids, ["1", "2", "3", "4"]);
        let after: Vec<Value> = bridge
            .payloads_for(command::RUN_EVENTS)
            .iter()
            .map(|payload| payload["afterSeq"].clone())
            .collect();
        assert_eq!(after, [json!(0), json!(2), json!(2)]);
    }

    #[tokio::test]
    async fn sse_03_a_dropped_stream_leaves_the_run_alone() {
        // [ACC:SSE-03]
        let bridge = RecordingBrainBridge::new();
        bridge.ok(
            command::RUN_EVENTS,
            json!({ "events": [event(1, "run.queued")], "terminal": false }),
        );
        let (router, _) = app(
            bridge.clone(),
            actor_with(&[scope::READ, scope::CANCEL]),
            true,
        );
        let response = router
            .oneshot(get_req("/v1/runs/run-1/events"))
            .await
            .unwrap();
        let mut body = response.into_body().into_data_stream();
        let chunk = body.next().await.expect("a first frame").expect("readable");
        let first = String::from_utf8_lossy(&chunk).to_string();
        assert!(first.contains("id: 1"), "{first}");
        drop(body);
        tokio::task::yield_now().await;
        // The client went away; nothing asked the brain to stop the run.
        assert!(bridge
            .calls()
            .iter()
            .all(|(name, _)| name != command::RUN_CANCEL));
    }

    #[test]
    fn resume_from_reads_the_header_first_and_the_query_as_a_fallback() {
        let mut headers = HeaderMap::new();
        let mut query = HashMap::new();
        assert_eq!(resume_from(&headers, &query), None);

        query.insert("after_seq".to_string(), "4".to_string());
        assert_eq!(resume_from(&headers, &query), Some(4));

        headers.insert("last-event-id", "9".parse().unwrap());
        assert_eq!(resume_from(&headers, &query), Some(9));

        // A client that sends nonsense is treated as a client that sent nothing.
        headers.insert("last-event-id", "not-a-seq".parse().unwrap());
        assert_eq!(resume_from(&headers, &query), Some(4));
    }

    #[test]
    fn an_error_keeps_details_an_object_whatever_the_brain_sent() {
        let body = error_body(StatusCode::CONFLICT, "X", "m", Some(json!(["a"])));
        assert_eq!(body["error"]["details"], json!({ "value": ["a"] }));
        let body = error_body(StatusCode::TOO_MANY_REQUESTS, "X", "m", Some(Value::Null));
        assert_eq!(body["error"]["details"], json!({}));
        assert_eq!(body["error"]["retryable"], true);
    }

    #[test]
    fn the_switches_are_off_until_the_brain_says_otherwise() {
        let state = RunsState::new(Arc::new(RecordingBrainBridge::new()));
        assert!(!state.runs_enabled());
        assert!(!state.switches.read().passthrough_ledger_enabled);
    }
}
