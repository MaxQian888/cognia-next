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
//!   `ErrorResponse`: code, message, retryable, details, trace_id. That holds
//!   for the gateway's own refusals on these paths too — a missing or invalid
//!   key, an exhausted quota, a rate limit, a body over the size limit, an
//!   unknown sub-path or a wrong method — and only on these paths: every other
//!   endpoint keeps the shape its clients already parse (ADR-0188 D37).
//! - **A read link names this gateway, not whatever the caller typed.** The
//!   artifact `read_url` origin comes from the Host header only when that header
//!   is a loopback name or the very address the connection arrived on; a LAN
//!   listener otherwise answers with its own address.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::rejection::{JsonRejection, PathRejection};
use axum::extract::{OriginalUri, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

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
/// How many `cognia/*` compat callers may wait for their run's answer at once,
/// per gateway. Each waiter holds a connection open and polls the brain; past
/// this a caller is told to come back (`429 RUN_WAITERS_EXHAUSTED`) before any
/// run exists, rather than creating work nobody can wait for.
pub const MAX_COMPAT_WAITERS: usize = 64;
/// The path prefixes the Run API owns. Only requests under these get the
/// contract's error shape from the gateway's own layers (ADR-0188 D37).
pub const RUN_SURFACE_PREFIXES: [&str; 3] = ["/v1/runs", "/v1/sessions", "/v1/artifacts"];
/// How much of a failure body the envelope reads to recover its message.
const FOREIGN_ERROR_BODY_LIMIT: usize = 64 * 1024;
/// The longest message the envelope carries over from a foreign body.
const FOREIGN_ERROR_MESSAGE_CHARS: usize = 512;

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
    /// One permit per `cognia/*` compat caller waiting on its answer, shared by
    /// every clone of this state, so the cap is per gateway.
    compat_waiters: Arc<Semaphore>,
}

impl RunsState {
    pub fn new(bridge: Arc<dyn BrainBridge>) -> Self {
        Self {
            bridge: Arc::new(RwLock::new(bridge)),
            switches: Arc::new(RwLock::new(RouterFusionGatewaySwitches::default())),
            compat_waiters: Arc::new(Semaphore::new(MAX_COMPAT_WAITERS)),
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

    /// A slot for one compat caller to wait on its run's answer, or `None`
    /// when all [`MAX_COMPAT_WAITERS`] are taken. The permit is held until the
    /// answer or the refusal has been produced, or the caller has gone away.
    pub fn try_compat_waiter(&self) -> Option<OwnedSemaphorePermit> {
        Arc::clone(&self.compat_waiters).try_acquire_owned().ok()
    }

    /// How many compat waiters could start right now.
    pub fn idle_compat_waiters(&self) -> usize {
        self.compat_waiters.available_permits()
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

/// Carried by every response whose body already is the contract's
/// `ErrorResponse`, so [`contract_error_envelope`] leaves it exactly as built.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContractErrorBody;

pub fn error_response(
    status: StatusCode,
    code: &str,
    message: &str,
    details: Option<Value>,
) -> Response {
    contract_response(status, error_body(status, code, message, details))
}

/// A contract `ErrorResponse` body on the wire, marked as such.
fn contract_response(status: StatusCode, body: Value) -> Response {
    let mut response = (status, Json(body)).into_response();
    response.extensions_mut().insert(ContractErrorBody);
    response
}

/// Whether `path` is one the Run API owns: `/v1/runs`, `/v1/sessions`,
/// `/v1/artifacts`, or anything beneath them. `/v1/runsx` is not.
pub fn is_run_surface_path(path: &str) -> bool {
    RUN_SURFACE_PREFIXES.iter().any(|prefix| {
        path.strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    })
}

/// A contract code for a failure that arrived with nothing but its status:
/// the status's own name (`PAYLOAD_TOO_LARGE`, `NOT_FOUND`, …).
pub fn status_code_name(status: StatusCode) -> String {
    match status.canonical_reason() {
        Some(reason) => reason
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_uppercase()
                } else {
                    '_'
                }
            })
            .collect(),
        None => format!("HTTP_{}", status.as_u16()),
    }
}

/// The contract code for one of the gateway middleware's own refusals, by
/// the message it has always carried. A message this table does not know
/// still gets a code, from its status.
pub fn gateway_refusal_code(status: StatusCode, message: &str) -> String {
    let code = match message {
        "invalid host" => "HOST_NOT_ALLOWED",
        "cross-origin not allowed" => "CROSS_ORIGIN_NOT_ALLOWED",
        "ipv6 not supported" | "origin not allowed" => "CLIENT_NOT_ALLOWED",
        "the local account is locked" => "ACCOUNT_LOCKED",
        "invalid token" => "INVALID_API_KEY",
        "route tickets cannot be used on this route" => "ROUTE_TICKET_NOT_PERMITTED",
        "per-key rate limit exceeded" => "KEY_RATE_LIMITED",
        "rate limit exceeded" => "RATE_LIMITED",
        "request body too large" => "PAYLOAD_TOO_LARGE",
        other if other.starts_with("missing credentials") => "AUTH_REQUIRED",
        other if other.starts_with("insufficient_quota") => "KEY_QUOTA_EXHAUSTED",
        _ => return status_code_name(status),
    };
    code.to_string()
}

/// A gateway middleware refusal on a Run API path, in the contract's shape.
/// The status and message are the ones every other path answers with. An
/// exhausted key quota is the one 429 that is not retryable: it stays
/// exhausted until someone resets it, however long the caller waits.
pub fn gateway_refusal(status: StatusCode, message: &str) -> Response {
    let code = gateway_refusal_code(status, message);
    let mut body = error_body(status, &code, message, None);
    if code == "KEY_QUOTA_EXHAUSTED" {
        body["error"]["retryable"] = Value::Bool(false);
    }
    contract_response(status, body)
}

/// The account the gateway serves changed while a Run API request was in
/// flight. Retryable: the next request is answered under the new account.
pub fn account_context_changed() -> Response {
    error_response(
        StatusCode::SERVICE_UNAVAILABLE,
        "ACCOUNT_CONTEXT_CHANGED",
        "gateway account context changed",
        None,
    )
}

/// The last word on a Run API failure's shape (ADR-0188 B3 hardening).
///
/// Mounted outermost on the authenticated router. For any path outside the
/// Run API it is a pass-through: the response is returned untouched, so every
/// legacy endpoint keeps its bytes (D37). On a Run API path, a failure whose
/// body was not built by [`error_response`] — the body-size limit's plain-text
/// 413, a default 404 no route claimed — is rebuilt as the contract's
/// `ErrorResponse`, keeping its status, its message and its `Allow` or
/// `Retry-After` header.
pub async fn contract_error_envelope(request: axum::extract::Request, next: Next) -> Response {
    if !is_run_surface_path(request.uri().path()) {
        return next.run(request).await;
    }
    let response = next.run(request).await;
    let status = response.status();
    let failed = status.is_client_error() || status.is_server_error();
    if !failed || response.extensions().get::<ContractErrorBody>().is_some() {
        return response;
    }
    let (parts, body) = response.into_parts();
    let message = axum::body::to_bytes(body, FOREIGN_ERROR_BODY_LIMIT)
        .await
        .ok()
        .and_then(|bytes| foreign_error_message(&bytes))
        .unwrap_or_else(|| {
            status
                .canonical_reason()
                .unwrap_or("the request failed")
                .to_string()
        });
    let mut rebuilt = error_response(status, &status_code_name(status), &message, None);
    for name in [header::ALLOW, header::RETRY_AFTER] {
        if let Some(value) = parts.headers.get(&name) {
            rebuilt.headers_mut().insert(name, value.clone());
        }
    }
    rebuilt
}

/// The human message in a failure body the contract did not shape:
/// `{"error":{"message":…}}`, `{"error":"…"}`, `{"message":…}` or plain text.
fn foreign_error_message(bytes: &[u8]) -> Option<String> {
    if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
        let error = &value["error"];
        return error["message"]
            .as_str()
            .or_else(|| error.as_str())
            .or_else(|| value["message"].as_str())
            .map(|message| message.chars().take(FOREIGN_ERROR_MESSAGE_CHARS).collect());
    }
    let text = std::str::from_utf8(bytes).ok()?.trim();
    (!text.is_empty()).then(|| text.chars().take(FOREIGN_ERROR_MESSAGE_CHARS).collect())
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

/// The request body as JSON, or the contract's refusal. Anything the JSON
/// extractor rejects — no body, a body that is not JSON, a `Content-Type` that
/// is not JSON — is `422 SCHEMA_INVALID` with the extractor's own words in
/// `details.reason`. A body over the gateway's size limit keeps its `413`.
/// The refusal is boxed: a `Response` is too large to travel in an `Err`.
fn json_body(body: Result<Json<Value>, JsonRejection>) -> Result<Value, Box<Response>> {
    match body {
        Ok(Json(value)) => Ok(value),
        Err(rejection) if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE => {
            Err(Box::new(error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "PAYLOAD_TOO_LARGE",
                "the request body is larger than this gateway accepts",
                Some(json!({ "reason": rejection.body_text(), "location": "body" })),
            )))
        }
        Err(rejection) => Err(Box::new(error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "SCHEMA_INVALID",
            "the request body must be JSON, sent as application/json",
            Some(json!({ "reason": rejection.body_text(), "location": "body" })),
        ))),
    }
}

/// The one path parameter a Run API route names, or the contract's refusal
/// when it cannot be read (a percent-escape that is not UTF-8).
fn path_param(path: Result<Path<String>, PathRejection>) -> Result<String, Box<Response>> {
    path.map(|Path(value)| value).map_err(|rejection| {
        Box::new(error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "SCHEMA_INVALID",
            "the path does not name a resource this API can read",
            Some(json!({ "reason": rejection.body_text(), "location": "path" })),
        ))
    })
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
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    if let Some(refusal) = guard(&state, &actor, scope::CREATE) {
        return refusal;
    }
    let body = match json_body(body) {
        Ok(body) => body,
        Err(refusal) => return *refusal,
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
    run_id: Result<Path<String>, PathRejection>,
) -> Response {
    if let Some(refusal) = guard(&state, &actor, scope::READ) {
        return refusal;
    }
    let run_id = match path_param(run_id) {
        Ok(run_id) => run_id,
        Err(refusal) => return *refusal,
    };
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
    run_id: Result<Path<String>, PathRejection>,
) -> Response {
    if let Some(refusal) = guard(&state, &actor, scope::CANCEL) {
        return refusal;
    }
    let run_id = match path_param(run_id) {
        Ok(run_id) => run_id,
        Err(refusal) => return *refusal,
    };
    let payload = json!({ "actor": actor.as_payload(), "runId": run_id });
    match ask(&state, command::RUN_CANCEL, payload).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(response) => response,
    }
}

async fn resume_run(
    State(state): State<RunsState>,
    Extension(actor): Extension<RunActor>,
    run_id: Result<Path<String>, PathRejection>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    if let Some(refusal) = guard(&state, &actor, scope::APPROVE) {
        return refusal;
    }
    let run_id = match path_param(run_id) {
        Ok(run_id) => run_id,
        Err(refusal) => return *refusal,
    };
    let body = match json_body(body) {
        Ok(body) => body,
        Err(refusal) => return *refusal,
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
    run_id: Result<Path<String>, PathRejection>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    if let Some(refusal) = guard(&state, &actor, scope::FEEDBACK) {
        return refusal;
    }
    let run_id = match path_param(run_id) {
        Ok(run_id) => run_id,
        Err(refusal) => return *refusal,
    };
    let feedback = match json_body(body) {
        Ok(feedback) => feedback,
        Err(refusal) => return *refusal,
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
    session_id: Result<Path<String>, PathRejection>,
) -> Response {
    if let Some(refusal) = guard(&state, &actor, scope::READ) {
        return refusal;
    }
    let session_id = match path_param(session_id) {
        Ok(session_id) => session_id,
        Err(refusal) => return *refusal,
    };
    let payload = json!({ "actor": actor.as_payload(), "sessionId": session_id });
    match ask(&state, command::SESSION_GET, payload).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(response) => response,
    }
}

/// Where the listener accepted a request: whether it is bound to every
/// interface (LAN mode), and the local address the connection arrived on. The
/// server inserts it into every request; a request without it is treated as
/// reaching a loopback-bound listener at an unknown address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListenerOrigin {
    /// The listener takes connections from other machines, so the Host header
    /// is whatever a peer chose to send (the middleware checks it only on a
    /// loopback-bound listener).
    pub lan: bool,
    /// The socket address this connection was accepted on, when the socket
    /// could report it. A peer cannot forge it.
    pub local_addr: Option<SocketAddr>,
    /// `GatewayConfig::public_origin`, read live per request: the origin the
    /// operator says callers reach this gateway at, when that is not the
    /// address the connection arrived on (a reverse proxy, a tunnel, a
    /// container port map). `None` — the default — leaves the derived
    /// behaviour untouched.
    pub public_origin: Option<String>,
}

/// A Host header's host and port. `[::1]:8787`, `127.0.0.1`, `localhost:1`.
fn split_authority(authority: &str) -> (&str, Option<&str>) {
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, tail) = rest.split_once(']').unwrap_or((rest, ""));
        return (host, tail.strip_prefix(':'));
    }
    match authority.rsplit_once(':') {
        // More than one colon without brackets is a bare IPv6 address.
        Some((host, port)) if !host.contains(':') => (host, Some(port)),
        _ => (authority, None),
    }
}

/// A loopback name, as the gateway's Host check accepts it.
fn is_loopback_authority(authority: &str) -> bool {
    matches!(
        split_authority(authority).0,
        "127.0.0.1" | "localhost" | "::1"
    )
}

/// Whether `authority` spells exactly `addr`: the same IP, and the same port
/// (80 when the header names none).
fn authority_names(authority: &str, addr: SocketAddr) -> bool {
    let (host, port) = split_authority(authority);
    let Ok(ip) = host.parse::<IpAddr>() else {
        return false;
    };
    let port = match port {
        Some(port) => port.parse::<u16>().ok(),
        None => Some(80),
    };
    ip == addr.ip() && port == Some(addr.port())
}

/// The origin a read link should point back at: this gateway, as the caller
/// can reach it — never a host the caller merely claimed.
///
/// A configured `publicOrigin` wins outright. It is the operator's own
/// statement of where this gateway answers, which is the only thing that can
/// be right behind a reverse proxy or a tunnel: there the address the
/// connection arrived on is the proxy's back end, which no caller can dial.
/// It is normalised again here, so a config written by an older build can
/// never produce a malformed link.
///
/// With none configured — the default — nothing below changes. The Host
/// header is used only when it is a loopback name, or, on a LAN listener,
/// when it spells the exact address the connection arrived on. Anything
/// else — a spoofed or unknown name — is ignored, and the link names the
/// listener's own address instead (or `127.0.0.1` when that is unknown).
/// The scheme honours `X-Forwarded-Proto` only for `http` and `https`.
pub fn public_base_url(headers: &HeaderMap, origin: Option<&ListenerOrigin>) -> String {
    if let Some(configured) = origin
        .and_then(|origin| origin.public_origin.as_deref())
        .and_then(crate::types::normalize_public_origin)
    {
        return configured;
    }
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .filter(|proto| *proto == "https" || *proto == "http")
        .unwrap_or("http");
    let claimed = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|host| !host.is_empty());
    let lan = origin.is_some_and(|origin| origin.lan);
    let local = origin.and_then(|origin| origin.local_addr);
    let authority = match claimed {
        Some(host) if is_loopback_authority(host) => host.to_string(),
        Some(host) if lan && local.is_some_and(|addr| authority_names(host, addr)) => {
            host.to_string()
        }
        _ => match local {
            Some(addr) if lan || addr.ip().is_loopback() => addr.to_string(),
            _ => "127.0.0.1".to_string(),
        },
    };
    format!("{scheme}://{authority}")
}

async fn get_artifact(
    State(state): State<RunsState>,
    Extension(actor): Extension<RunActor>,
    origin: Option<Extension<ListenerOrigin>>,
    artifact_id: Result<Path<String>, PathRejection>,
    headers: HeaderMap,
) -> Response {
    if let Some(refusal) = guard(&state, &actor, scope::ARTIFACTS_READ) {
        return refusal;
    }
    let artifact_id = match path_param(artifact_id) {
        Ok(artifact_id) => artifact_id,
        Err(refusal) => return *refusal,
    };
    let origin = origin.map(|Extension(origin)| origin);
    let payload = json!({
        "actor": actor.as_payload(),
        "artifactId": artifact_id,
        "baseUrl": public_base_url(&headers, origin.as_ref()),
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
    artifact_id: Result<Path<String>, PathRejection>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if let Some(refusal) = guard(&state, &actor, scope::ARTIFACTS_READ) {
        return refusal;
    }
    let artifact_id = match path_param(artifact_id) {
        Ok(artifact_id) => artifact_id,
        Err(refusal) => return *refusal,
    };
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
/// Both fields are required: a page without them is not a page, and is never
/// read as an empty one.
#[derive(Debug, Clone, Deserialize)]
struct EventsPage {
    events: Vec<Value>,
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
    run_id: Result<Path<String>, PathRejection>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Some(refusal) = guard(&state, &actor, scope::READ) {
        return refusal;
    }
    let run_id = match path_param(run_id) {
        Ok(run_id) => run_id,
        Err(refusal) => return *refusal,
    };
    let after = resume_from(&headers, &query).unwrap_or(0);

    // One eager read before the stream opens, so a run the caller may not see,
    // or a seq whose history is gone, is an HTTP status (the brain's own 404 or
    // 410) rather than a stream that immediately ends. A first page this
    // gateway cannot read is a 503 for the same reason.
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
    let Ok(first) = serde_json::from_value::<EventsPage>(first) else {
        return unreadable_answer("a run event read");
    };

    let stream = futures_util::stream::unfold(
        StreamState {
            state,
            actor,
            run_id,
            after,
            pending: Some(first),
            last_frame: tokio::time::Instant::now(),
            done: false,
        },
        |mut stream_state| async move {
            loop {
                if stream_state.done {
                    return None;
                }
                let page = match stream_state.pending.take() {
                    Some(page) => page,
                    None => {
                        tokio::time::sleep(EVENT_POLL_INTERVAL).await;
                        // Silence is measured on the clock since the last frame
                        // went out, so a brain that is slow to answer each poll
                        // cannot stretch the limit by the time its answers take.
                        if stream_state.last_frame.elapsed() >= SSE_MAX_SILENCE {
                            return None;
                        }
                        let payload = events_payload(
                            &stream_state.actor,
                            &stream_state.run_id,
                            stream_state.after,
                        );
                        let answer = match stream_state
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
                        };
                        match serde_json::from_value::<EventsPage>(answer) {
                            Ok(page) => page,
                            // A page in a shape this gateway does not read
                            // ends the stream. Read as empty, it would keep
                            // polling a brain nobody here understands and pass
                            // over whatever events it held; the client
                            // reconnects from its Last-Event-ID instead.
                            Err(_) => return None,
                        }
                    }
                };
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
                stream_state.last_frame = tokio::time::Instant::now();
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
    pending: Option<EventsPage>,
    /// When the last event frame went out (or the stream opened).
    last_frame: tokio::time::Instant,
    done: bool,
}

/// A path under the Run API that no route serves.
async fn route_not_found(method: Method, OriginalUri(uri): OriginalUri) -> Response {
    error_response(
        StatusCode::NOT_FOUND,
        "ROUTE_NOT_FOUND",
        "no Run API route serves this path",
        Some(json!({ "method": method.as_str(), "path": uri.path() })),
    )
}

/// A Run API route asked for with a method it does not serve.
async fn method_not_allowed(method: Method, OriginalUri(uri): OriginalUri) -> Response {
    error_response(
        StatusCode::METHOD_NOT_ALLOWED,
        "METHOD_NOT_ALLOWED",
        &format!("{method} is not served on this Run API route"),
        Some(json!({ "method": method.as_str(), "path": uri.path() })),
    )
}

/// The contract's 404 and 405 for one Run API prefix. Set per nested prefix,
/// never on the merged router: a fallback there would become the fallback of
/// every gateway path, and legacy paths keep axum's own 404 (D37).
fn contract_fallbacks(router: Router<RunsState>) -> Router<RunsState> {
    router
        .fallback(route_not_found)
        .method_not_allowed_fallback(method_not_allowed)
}

/// The Run API routes. Merged into the gateway's authenticated router, so the
/// same Host, origin, allowlist, key and rate-limit checks run first.
pub fn routes() -> Router<RunsState> {
    let runs = Router::new()
        .route("/", post(create_run))
        .route("/{run_id}", get(get_run))
        .route("/{run_id}/cancel", post(cancel_run))
        .route("/{run_id}/resume", post(resume_run))
        .route("/{run_id}/feedback", post(run_feedback))
        .route("/{run_id}/events", get(run_events));
    let sessions = Router::new().route("/{session_id}", get(get_session));
    let artifacts = Router::new()
        .route("/{artifact_id}", get(get_artifact))
        .route("/{artifact_id}/content", get(read_artifact));
    Router::new()
        .nest("/v1/runs", contract_fallbacks(runs))
        .nest("/v1/sessions", contract_fallbacks(sessions))
        .nest("/v1/artifacts", contract_fallbacks(artifacts))
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
            assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY, "{uri}");
            assert_error_shape(&body_json(response).await, "SCHEMA_INVALID");
        }
        assert!(bridge.calls().is_empty());
    }

    #[tokio::test]
    async fn a_body_the_json_extractor_rejects_is_schema_invalid_with_its_reason() {
        let bridge = RecordingBrainBridge::new();
        let (router, _) = app(
            bridge.clone(),
            actor_with(&[scope::CREATE, scope::APPROVE, scope::FEEDBACK]),
            true,
        );
        for uri in [
            "/v1/runs",
            "/v1/runs/run-1/resume",
            "/v1/runs/run-1/feedback",
        ] {
            for (content_type, body) in [
                ("application/json", "{not json"),
                ("application/json", ""),
                ("text/plain", "{}"),
            ] {
                let response = router
                    .clone()
                    .oneshot(
                        Request::builder()
                            .method("POST")
                            .uri(uri)
                            .header("content-type", content_type)
                            .body(Body::from(body))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(
                    response.status(),
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "{uri} {content_type} {body:?}"
                );
                let parsed = body_json(response).await;
                assert_error_shape(&parsed, "SCHEMA_INVALID");
                assert_eq!(parsed["error"]["details"]["location"], "body");
                assert!(
                    !parsed["error"]["details"]["reason"]
                        .as_str()
                        .unwrap_or("")
                        .is_empty(),
                    "{uri} {content_type} {body:?}"
                );
            }
        }
        assert!(bridge.calls().is_empty());
    }

    #[tokio::test]
    async fn a_path_that_cannot_be_decoded_is_schema_invalid_not_a_plain_400() {
        let bridge = RecordingBrainBridge::new();
        let (router, _) = app(bridge.clone(), actor_with(&[scope::READ]), true);
        let response = router.oneshot(get_req("/v1/runs/%FF%FE")).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let parsed = body_json(response).await;
        assert_error_shape(&parsed, "SCHEMA_INVALID");
        assert_eq!(parsed["error"]["details"]["location"], "path");
        assert!(bridge.calls().is_empty());
    }

    #[tokio::test]
    async fn an_unknown_run_api_path_or_method_answers_in_the_contracts_shape() {
        let bridge = RecordingBrainBridge::new();
        let (router, _) = app(
            bridge.clone(),
            actor_with(&[scope::CREATE, scope::READ]),
            true,
        );
        for (method, uri, status, code) in [
            (
                "GET",
                "/v1/runs",
                StatusCode::METHOD_NOT_ALLOWED,
                "METHOD_NOT_ALLOWED",
            ),
            (
                "DELETE",
                "/v1/runs/r-1",
                StatusCode::METHOD_NOT_ALLOWED,
                "METHOD_NOT_ALLOWED",
            ),
            (
                "GET",
                "/v1/runs/r-1/cancel",
                StatusCode::METHOD_NOT_ALLOWED,
                "METHOD_NOT_ALLOWED",
            ),
            (
                "PUT",
                "/v1/sessions/s-1",
                StatusCode::METHOD_NOT_ALLOWED,
                "METHOD_NOT_ALLOWED",
            ),
            (
                "POST",
                "/v1/artifacts/a-1/content",
                StatusCode::METHOD_NOT_ALLOWED,
                "METHOD_NOT_ALLOWED",
            ),
            (
                "GET",
                "/v1/runs/r-1/nope",
                StatusCode::NOT_FOUND,
                "ROUTE_NOT_FOUND",
            ),
            (
                "GET",
                "/v1/runs/r-1/events/more",
                StatusCode::NOT_FOUND,
                "ROUTE_NOT_FOUND",
            ),
            (
                "GET",
                "/v1/sessions",
                StatusCode::NOT_FOUND,
                "ROUTE_NOT_FOUND",
            ),
            (
                "GET",
                "/v1/artifacts",
                StatusCode::NOT_FOUND,
                "ROUTE_NOT_FOUND",
            ),
        ] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(uri)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), status, "{method} {uri}");
            let parsed = body_json(response).await;
            assert_error_shape(&parsed, code);
            assert_eq!(parsed["error"]["details"]["path"], uri, "{method} {uri}");
            assert_eq!(parsed["error"]["details"]["method"], method);
        }
        assert!(bridge.calls().is_empty());
    }

    #[test]
    fn only_the_run_apis_own_paths_are_run_surface_paths() {
        for path in [
            "/v1/runs",
            "/v1/runs/r-1",
            "/v1/runs/r-1/events",
            "/v1/sessions/s-1",
            "/v1/artifacts",
            "/v1/artifacts/a-1/content",
        ] {
            assert!(is_run_surface_path(path), "{path}");
        }
        for path in [
            "/v1/runsx",
            "/v1/run",
            "/v1/models",
            "/v1/models/cognia/auto",
            "/v1/chat/completions",
            "/v1/sessionsz/x",
            "/",
        ] {
            assert!(!is_run_surface_path(path), "{path}");
        }
    }

    #[test]
    fn each_gateway_refusal_has_its_own_code_and_an_unknown_one_keeps_its_status() {
        for (status, message, code) in [
            (StatusCode::FORBIDDEN, "invalid host", "HOST_NOT_ALLOWED"),
            (
                StatusCode::FORBIDDEN,
                "cross-origin not allowed",
                "CROSS_ORIGIN_NOT_ALLOWED",
            ),
            (
                StatusCode::FORBIDDEN,
                "ipv6 not supported",
                "CLIENT_NOT_ALLOWED",
            ),
            (
                StatusCode::FORBIDDEN,
                "origin not allowed",
                "CLIENT_NOT_ALLOWED",
            ),
            (
                StatusCode::UNAUTHORIZED,
                "the local account is locked",
                "ACCOUNT_LOCKED",
            ),
            (
                StatusCode::UNAUTHORIZED,
                "missing credentials (Authorization: Bearer or x-api-key)",
                "AUTH_REQUIRED",
            ),
            (StatusCode::UNAUTHORIZED, "invalid token", "INVALID_API_KEY"),
            (
                StatusCode::FORBIDDEN,
                "route tickets cannot be used on this route",
                "ROUTE_TICKET_NOT_PERMITTED",
            ),
            (
                StatusCode::TOO_MANY_REQUESTS,
                "insufficient_quota: key token quota exhausted",
                "KEY_QUOTA_EXHAUSTED",
            ),
            (
                StatusCode::TOO_MANY_REQUESTS,
                "per-key rate limit exceeded",
                "KEY_RATE_LIMITED",
            ),
            (
                StatusCode::TOO_MANY_REQUESTS,
                "rate limit exceeded",
                "RATE_LIMITED",
            ),
            (
                StatusCode::PAYLOAD_TOO_LARGE,
                "request body too large",
                "PAYLOAD_TOO_LARGE",
            ),
            (StatusCode::FORBIDDEN, "something new", "FORBIDDEN"),
        ] {
            assert_eq!(gateway_refusal_code(status, message), code, "{message}");
        }
    }

    #[tokio::test]
    async fn a_gateway_refusal_is_retryable_by_its_status_except_an_exhausted_quota() {
        let limited = gateway_refusal(StatusCode::TOO_MANY_REQUESTS, "rate limit exceeded");
        assert!(limited.extensions().get::<ContractErrorBody>().is_some());
        let body = body_json(limited).await;
        assert_error_shape(&body, "RATE_LIMITED");
        assert_eq!(body["error"]["retryable"], true);
        assert_eq!(body["error"]["message"], "rate limit exceeded");

        let drained = body_json(gateway_refusal(
            StatusCode::TOO_MANY_REQUESTS,
            "insufficient_quota: key token quota exhausted",
        ))
        .await;
        assert_error_shape(&drained, "KEY_QUOTA_EXHAUSTED");
        assert_eq!(drained["error"]["retryable"], false);

        let unknown = body_json(gateway_refusal(StatusCode::UNAUTHORIZED, "invalid token")).await;
        assert_error_shape(&unknown, "INVALID_API_KEY");
        assert_eq!(unknown["error"]["retryable"], false);
    }

    #[test]
    fn a_status_alone_names_its_own_code() {
        assert_eq!(
            status_code_name(StatusCode::PAYLOAD_TOO_LARGE),
            "PAYLOAD_TOO_LARGE"
        );
        assert_eq!(status_code_name(StatusCode::NOT_FOUND), "NOT_FOUND");
        assert_eq!(
            status_code_name(StatusCode::METHOD_NOT_ALLOWED),
            "METHOD_NOT_ALLOWED"
        );
        assert_eq!(
            status_code_name(StatusCode::from_u16(599).unwrap()),
            "HTTP_599"
        );
    }

    #[test]
    fn a_foreign_failure_body_gives_up_its_message() {
        assert_eq!(
            foreign_error_message(br#"{"error":{"message":"invalid token"}}"#).as_deref(),
            Some("invalid token")
        );
        assert_eq!(
            foreign_error_message(br#"{"error":"gateway account context changed"}"#).as_deref(),
            Some("gateway account context changed")
        );
        assert_eq!(
            foreign_error_message(b"length limit exceeded").as_deref(),
            Some("length limit exceeded")
        );
        assert_eq!(foreign_error_message(b"  "), None);
        assert_eq!(foreign_error_message(br#"{"other":1}"#), None);
        let long = "x".repeat(4_000);
        assert_eq!(
            foreign_error_message(long.as_bytes()).map(|m| m.chars().count()),
            Some(FOREIGN_ERROR_MESSAGE_CHARS)
        );
    }

    /// A router whose routes answer the way the gateway's outer layers do —
    /// plain text, a legacy error object, a contract error — under the
    /// envelope that the server mounts outermost.
    fn enveloped() -> Router {
        async fn plain_413() -> Response {
            (StatusCode::PAYLOAD_TOO_LARGE, "length limit exceeded").into_response()
        }
        async fn legacy_429() -> Response {
            let mut response = (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({ "error": { "message": "rate limit exceeded" } })),
            )
                .into_response();
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("7"));
            response
        }
        async fn contract_409() -> Response {
            error_response(StatusCode::CONFLICT, "IDEMPOTENCY_CONFLICT", "m", None)
        }
        async fn ok() -> Response {
            Json(json!({ "ok": true })).into_response()
        }
        Router::new()
            .route("/v1/runs/big", post(plain_413))
            .route("/v1/models/big", post(plain_413))
            .route("/v1/sessions/busy", get(legacy_429))
            .route("/v1/chat/busy", get(legacy_429))
            .route("/v1/runs/conflict", post(contract_409))
            .route("/v1/runs/fine", get(ok))
            .layer(axum::middleware::from_fn(contract_error_envelope))
    }

    #[tokio::test]
    async fn the_envelope_reshapes_only_run_api_failures_the_contract_did_not_build() {
        let router = enveloped();

        let big = router
            .clone()
            .oneshot(post_json("/v1/runs/big", "{}"))
            .await
            .unwrap();
        assert_eq!(big.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let parsed = body_json(big).await;
        assert_error_shape(&parsed, "PAYLOAD_TOO_LARGE");
        assert_eq!(parsed["error"]["message"], "length limit exceeded");

        let busy = router
            .clone()
            .oneshot(get_req("/v1/sessions/busy"))
            .await
            .unwrap();
        assert_eq!(busy.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(busy.headers().get(header::RETRY_AFTER).unwrap(), "7");
        let parsed = body_json(busy).await;
        assert_error_shape(&parsed, "TOO_MANY_REQUESTS");
        assert_eq!(parsed["error"]["message"], "rate limit exceeded");
        assert_eq!(parsed["error"]["retryable"], true);

        // A contract body passes untouched: same trace id, same code.
        let conflict = router
            .clone()
            .oneshot(post_json("/v1/runs/conflict", "{}"))
            .await
            .unwrap();
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        assert_error_shape(&body_json(conflict).await, "IDEMPOTENCY_CONFLICT");

        let fine = router
            .clone()
            .oneshot(get_req("/v1/runs/fine"))
            .await
            .unwrap();
        assert_eq!(body_json(fine).await, json!({ "ok": true }));

        // D37: a legacy path keeps its bytes exactly.
        let legacy_big = router
            .clone()
            .oneshot(post_json("/v1/models/big", "{}"))
            .await
            .unwrap();
        assert_eq!(legacy_big.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let bytes = axum::body::to_bytes(legacy_big.into_body(), 1 << 20)
            .await
            .unwrap();
        assert_eq!(&bytes[..], b"length limit exceeded");
        let legacy_busy = router.oneshot(get_req("/v1/chat/busy")).await.unwrap();
        assert_eq!(
            body_json(legacy_busy).await,
            json!({ "error": { "message": "rate limit exceeded" } })
        );
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
        assert_eq!(public_base_url(&headers, None), "http://127.0.0.1");
        headers.insert(header::HOST, "localhost:8787".parse().unwrap());
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        assert_eq!(public_base_url(&headers, None), "https://localhost:8787");
        headers.insert("x-forwarded-proto", "javascript".parse().unwrap());
        assert_eq!(public_base_url(&headers, None), "http://localhost:8787");
    }

    fn host(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, value.parse().unwrap());
        headers
    }

    fn lan_origin(local: &str) -> ListenerOrigin {
        ListenerOrigin {
            lan: true,
            local_addr: Some(local.parse().unwrap()),
            public_origin: None,
        }
    }

    #[test]
    fn a_spoofed_host_never_becomes_the_read_links_origin_on_a_lan_listener() {
        let origin = lan_origin("192.168.1.5:8787");
        for spoofed in [
            "evil.example",
            "evil.example:8787",
            "192.168.1.66:8787",
            // The right address on another port is still not this listener.
            "192.168.1.5:9999",
            "192.168.1.5",
            "gateway.local:8787",
        ] {
            assert_eq!(
                public_base_url(&host(spoofed), Some(&origin)),
                "http://192.168.1.5:8787",
                "{spoofed}"
            );
        }
        // The address the connection really arrived on, and loopback names,
        // are the allowlist.
        for (trusted, expected) in [
            ("192.168.1.5:8787", "http://192.168.1.5:8787"),
            ("localhost:8787", "http://localhost:8787"),
            ("127.0.0.1:8787", "http://127.0.0.1:8787"),
            ("[::1]:8787", "http://[::1]:8787"),
        ] {
            assert_eq!(
                public_base_url(&host(trusted), Some(&origin)),
                expected,
                "{trusted}"
            );
        }
        // No Host at all is the listener's own address.
        assert_eq!(
            public_base_url(&HeaderMap::new(), Some(&origin)),
            "http://192.168.1.5:8787"
        );
    }

    #[test]
    fn a_configured_public_origin_names_the_read_link_even_behind_a_proxy() {
        // The proxy's back end is 127.0.0.1:8787; no caller can dial that, so
        // the operator's origin is the only correct answer.
        let proxied = ListenerOrigin {
            lan: true,
            local_addr: Some("10.0.0.5:8787".parse().unwrap()),
            public_origin: Some("https://gw.example.com/".into()),
        };
        // Trailing slash normalised away; the derived address is not used.
        assert_eq!(
            public_base_url(&HeaderMap::new(), Some(&proxied)),
            "https://gw.example.com"
        );
        // A spoofed Host does not get a say either.
        assert_eq!(
            public_base_url(&host("evil.example"), Some(&proxied)),
            "https://gw.example.com"
        );
        // Nor does a forwarded scheme override the operator's own.
        let mut headers = host("gw.example.com");
        headers.insert("x-forwarded-proto", "http".parse().unwrap());
        assert_eq!(
            public_base_url(&headers, Some(&proxied)),
            "https://gw.example.com"
        );
    }

    #[test]
    fn an_unusable_configured_origin_leaves_todays_behaviour_untouched() {
        // `GatewayConfig::validate` refuses these, so this is the defence for
        // a config written by an older build or edited by hand: fall back to
        // exactly what the gateway answered before the setting existed.
        for raw in ["", "   ", "gw.example.com", "https://gw.example.com/v1"] {
            let origin = ListenerOrigin {
                lan: true,
                local_addr: Some("192.168.1.5:8787".parse().unwrap()),
                public_origin: Some(raw.into()),
            };
            assert_eq!(
                public_base_url(&host("evil.example"), Some(&origin)),
                "http://192.168.1.5:8787",
                "{raw:?}"
            );
        }
    }

    #[test]
    fn a_listener_that_cannot_name_itself_falls_back_to_loopback_never_to_the_header() {
        let unknown = ListenerOrigin {
            lan: true,
            local_addr: None,
            public_origin: None,
        };
        assert_eq!(
            public_base_url(&host("evil.example"), Some(&unknown)),
            "http://127.0.0.1"
        );
        // A loopback-bound listener names itself when the header does not.
        let loopback = ListenerOrigin {
            lan: false,
            local_addr: Some("127.0.0.1:8787".parse().unwrap()),
            public_origin: None,
        };
        assert_eq!(
            public_base_url(&host("evil.example"), Some(&loopback)),
            "http://127.0.0.1:8787"
        );
        assert_eq!(
            public_base_url(&host("localhost:8787"), Some(&loopback)),
            "http://localhost:8787"
        );
        // Without any listener origin the header still has to be loopback.
        assert_eq!(
            public_base_url(&host("evil.example"), None),
            "http://127.0.0.1"
        );
    }

    #[test]
    fn host_authorities_are_split_and_compared_exactly() {
        assert_eq!(split_authority("[::1]:8787"), ("::1", Some("8787")));
        assert_eq!(split_authority("::1"), ("::1", None));
        assert_eq!(split_authority("localhost:1"), ("localhost", Some("1")));
        assert_eq!(split_authority("10.0.0.2"), ("10.0.0.2", None));
        let addr: SocketAddr = "10.0.0.2:80".parse().unwrap();
        assert!(authority_names("10.0.0.2", addr));
        assert!(authority_names("10.0.0.2:80", addr));
        assert!(!authority_names("10.0.0.2:81", addr));
        assert!(!authority_names("10.0.0.3:80", addr));
        assert!(!authority_names("host.example:80", addr));
        assert!(!authority_names("10.0.0.2:notaport", addr));
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
    async fn an_unreadable_first_page_is_a_503_before_any_stream_opens() {
        for unreadable in [
            json!("not a page"),
            json!({ "events": "nope", "terminal": false }),
            json!({ "terminal": true }),
            json!({ "events": [] }),
        ] {
            let bridge = RecordingBrainBridge::new();
            bridge.ok(command::RUN_EVENTS, unreadable.clone());
            let (router, _) = app(bridge.clone(), actor_with(&[scope::READ]), true);
            let response = router
                .oneshot(get_req("/v1/runs/run-1/events"))
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::SERVICE_UNAVAILABLE,
                "{unreadable}"
            );
            assert_error_shape(&body_json(response).await, "BRAIN_ANSWER_UNREADABLE");
            assert_eq!(bridge.payloads_for(command::RUN_EVENTS).len(), 1);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn an_unreadable_page_mid_stream_ends_the_stream_instead_of_reading_as_empty() {
        let bridge = RecordingBrainBridge::new();
        bridge.ok(
            command::RUN_EVENTS,
            json!({ "events": [event(1, "run.queued")], "terminal": false }),
        );
        bridge.ok(
            command::RUN_EVENTS,
            json!({ "events": { "seq": 2 }, "terminal": false }),
        );
        // Never asked for: the stream is over once a page cannot be read.
        bridge.ok(
            command::RUN_EVENTS,
            json!({ "events": [event(2, "run.completed")], "terminal": true }),
        );
        let (router, _) = app(bridge.clone(), actor_with(&[scope::READ]), true);
        let started = tokio::time::Instant::now();
        let response = router
            .oneshot(get_req("/v1/runs/run-1/events"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let text = String::from_utf8_lossy(&bytes);
        let ids: Vec<&str> = text
            .lines()
            .filter_map(|line| line.strip_prefix("id: "))
            .collect();
        assert_eq!(ids, ["1"]);
        assert_eq!(bridge.payloads_for(command::RUN_EVENTS).len(), 2);
        // Ended at once, not after five minutes of reading nothing.
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "{:?}",
            started.elapsed()
        );
    }

    /// A brain that is there but has nothing to say, and is slow saying it:
    /// every events poll answers an empty, non-terminal page after `delay`.
    struct SlowQuietBrain {
        delay: Duration,
        polls: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl BrainBridge for SlowQuietBrain {
        fn call(
            &self,
            _command: &'static str,
            _payload: Value,
        ) -> crate::brain_bridge::BrainFuture {
            let delay = self.delay;
            let polls = self.polls.clone();
            Box::pin(async move {
                polls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::time::sleep(delay).await;
                Ok(json!({ "events": [], "terminal": false }))
            })
        }
    }

    #[tokio::test(start_paused = true)]
    async fn silence_is_measured_on_the_clock_so_a_slow_brain_cannot_stretch_it() {
        let polls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let delay = Duration::from_secs(10);
        let state = RunsState::new(Arc::new(SlowQuietBrain {
            delay,
            polls: polls.clone(),
        }));
        state.switches.write().runs_enabled = true;
        let router = routes()
            .layer(Extension(actor_with(&[scope::READ])))
            .with_state(state);
        let response = router
            .oneshot(get_req("/v1/runs/run-1/events"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        // The eager read is not part of the stream's silence.
        let opened = tokio::time::Instant::now();
        axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("a silent stream ends on its own");
        let silent_for = opened.elapsed();
        assert!(silent_for >= SSE_MAX_SILENCE, "{silent_for:?}");
        assert!(
            silent_for <= SSE_MAX_SILENCE + delay + EVENT_POLL_INTERVAL,
            "{silent_for:?}"
        );
        // Counting polls instead of time would have taken 1 200 of them, and
        // over three hours of this brain's answers.
        let in_stream = polls.load(std::sync::atomic::Ordering::SeqCst) - 1;
        let bound =
            (SSE_MAX_SILENCE.as_millis() / (delay + EVENT_POLL_INTERVAL).as_millis()) as usize + 1;
        assert!(in_stream <= bound, "{in_stream} polls");
    }

    #[test]
    fn compat_waiters_are_capped_per_gateway_and_shared_by_every_clone() {
        let state = RunsState::new(Arc::new(RecordingBrainBridge::new()));
        let clone = state.clone();
        assert_eq!(state.idle_compat_waiters(), MAX_COMPAT_WAITERS);
        let held: Vec<_> = (0..MAX_COMPAT_WAITERS)
            .map(|_| clone.try_compat_waiter().expect("a free slot"))
            .collect();
        assert!(state.try_compat_waiter().is_none());
        assert_eq!(state.idle_compat_waiters(), 0);
        drop(held);
        assert_eq!(state.idle_compat_waiters(), MAX_COMPAT_WAITERS);
        assert!(state.try_compat_waiter().is_some());
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
