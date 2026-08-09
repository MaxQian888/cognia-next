//! Cognia-native workflow HTTP/SSE API v1.
//!
//! The Axum gateway remains transport-only: every operation round-trips to
//! the connected Desktop/Headless TypeScript brain, where ExecutionAuthority,
//! the deployment pointer, Dexie durability, and cancellation registry live.

use std::{collections::VecDeque, convert::Infallible, sync::Arc, time::Duration};

use axum::{
    extract::{rejection::JsonRejection, Extension, Path, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Response, Sse,
    },
    Json,
};
use futures_util::stream;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use super::{middleware::DeviceContext, SharedState};

const WORKFLOW_RUN_SCOPE: &str = "workflow:run";
const WORKFLOW_READ_SCOPE: &str = "workflow:read";
const WORKFLOW_ADMIN_SCOPE: &str = "workflow:admin";
const SSE_POLL_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateRunRequest {
    #[serde(default)]
    input: Value,
}

#[derive(Debug, Deserialize)]
struct BridgeEnvelope {
    ok: bool,
    data: Option<Value>,
    error: Option<BridgeError>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct BridgeError {
    code: String,
    status: u16,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct EventsPage {
    events: Vec<Value>,
    terminal: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    code: String,
    message: String,
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    body: ErrorBody,
}

impl ApiError {
    fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            body: ErrorBody {
                code: code.to_string(),
                message: message.into(),
                request_id: Uuid::new_v4().to_string(),
                details: None,
            },
        }
    }

    fn from_bridge(error: BridgeError) -> Self {
        Self {
            status: StatusCode::from_u16(error.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            body: ErrorBody {
                code: error.code,
                message: error.message,
                request_id: Uuid::new_v4().to_string(),
                details: error.details,
            },
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let request_id = self.body.request_id.clone();
        let mut response = (self.status, Json(self.body)).into_response();
        if let Ok(value) = HeaderValue::from_str(&request_id) {
            response.headers_mut().insert("x-request-id", value);
        }
        response
    }
}

fn has_scope(context: &DeviceContext, required: &str) -> bool {
    // Legacy paired-device and loopback service tokens retain their existing
    // permission model. OIDC access tokens are least-privilege per route.
    context.scope != "oidc"
        || context
            .granted_scopes
            .iter()
            .any(|scope| scope == required || scope == WORKFLOW_ADMIN_SCOPE)
}

fn require_scope(context: &DeviceContext, required: &str) -> Result<(), ApiError> {
    if has_scope(context, required) {
        return Ok(());
    }
    Err(ApiError::new(
        StatusCode::FORBIDDEN,
        "scope_denied",
        format!("{required} scope is required"),
    ))
}

fn effective_scopes(context: &DeviceContext) -> Vec<String> {
    if context.scope == "oidc" {
        return context.granted_scopes.clone();
    }
    vec![
        WORKFLOW_RUN_SCOPE.to_string(),
        WORKFLOW_READ_SCOPE.to_string(),
        WORKFLOW_ADMIN_SCOPE.to_string(),
    ]
}

fn caller(context: &DeviceContext) -> String {
    format!("{}:{}", context.scope, context.device_id)
}

async fn audit_request(context: &DeviceContext, action: &str, decision: &str, fields: Value) {
    super::audit::record_async(action, &context.device_id, &context.scope, decision, fields).await;
}

async fn dispatch_bridge(
    state: &SharedState,
    command: &str,
    payload: Value,
) -> Result<Value, ApiError> {
    let transport = super::ws_bridge::resolve_bridge_transport(state).map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "workflow_service_unavailable",
            "The workflow brain is not connected",
        )
    })?;
    let result = Arc::clone(&state.desktop_writes_bridge)
        .dispatch(
            transport.as_ref(),
            command,
            payload,
            super::desktop_writes_bridge::DEFAULT_TIMEOUT,
        )
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "workflow_service_unavailable",
                "The workflow brain did not answer the request",
            )
        })?;
    super::metrics::record_rpc_call(true);
    let envelope: BridgeEnvelope = serde_json::from_value(result).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            "workflow_service_protocol_error",
            "The workflow brain returned an invalid response",
        )
    })?;
    if envelope.ok {
        envelope.data.ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_GATEWAY,
                "workflow_service_protocol_error",
                "The workflow brain returned no response data",
            )
        })
    } else {
        Err(envelope
            .error
            .map(ApiError::from_bridge)
            .unwrap_or_else(|| {
                ApiError::new(
                    StatusCode::BAD_GATEWAY,
                    "workflow_service_protocol_error",
                    "The workflow brain returned an incomplete error",
                )
            }))
    }
}

fn json_response(status: StatusCode, value: Value) -> Response {
    let request_id = Uuid::new_v4().to_string();
    let mut response = (status, Json(value)).into_response();
    if let Ok(header) = HeaderValue::from_str(&request_id) {
        response.headers_mut().insert("x-request-id", header);
    }
    response
}

fn parse_idempotency_key(headers: &HeaderMap) -> Result<Option<String>, ApiError> {
    let Some(value) = headers.get("idempotency-key") else {
        return Ok(None);
    };
    let value = value.to_str().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_idempotency_key",
            "Idempotency-Key must be valid UTF-8 and at most 255 bytes",
        )
    })?;
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > 255 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_idempotency_key",
            "Idempotency-Key must be valid UTF-8 and at most 255 bytes",
        ));
    }
    Ok(Some(value.to_owned()))
}

pub async fn create_run_handler(
    Path(deployment_id): Path<String>,
    Extension(context): Extension<DeviceContext>,
    headers: HeaderMap,
    State(state): State<SharedState>,
    body: Result<Json<CreateRunRequest>, JsonRejection>,
) -> Response {
    if let Err(error) = require_scope(&context, WORKFLOW_RUN_SCOPE) {
        audit_request(
            &context,
            "workflow_api_run_create",
            "deny",
            json!({ "deployment_id": deployment_id, "code": error.body.code.clone() }),
        )
        .await;
        return error.into_response();
    }
    let Json(body) = match body {
        Ok(body) => body,
        Err(_) => {
            let error = ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "The request body must be valid workflow run JSON",
            );
            audit_request(
                &context,
                "workflow_api_run_create",
                "deny",
                json!({ "deployment_id": deployment_id, "code": error.body.code.clone() }),
            )
            .await;
            return error.into_response();
        }
    };
    let idempotency_key = match parse_idempotency_key(&headers) {
        Ok(key) => key,
        Err(error) => {
            audit_request(
                &context,
                "workflow_api_run_create",
                "deny",
                json!({ "deployment_id": deployment_id, "code": error.body.code.clone() }),
            )
            .await;
            return error.into_response();
        }
    };
    let payload = json!({
        "accountId": context.account_id,
        "deploymentId": deployment_id,
        "caller": caller(&context),
        "scopes": effective_scopes(&context),
        "input": body.input,
        "idempotencyKey": idempotency_key,
    });
    match dispatch_bridge(&state, "workflow_api_run_create", payload).await {
        Ok(data) => {
            audit_request(
                &context,
                "workflow_api_run_create",
                "allow",
                json!({ "deployment_id": deployment_id }),
            )
            .await;
            json_response(StatusCode::ACCEPTED, data)
        }
        Err(error) => {
            audit_request(
                &context,
                "workflow_api_run_create",
                "deny",
                json!({ "deployment_id": deployment_id, "code": error.body.code.clone() }),
            )
            .await;
            error.into_response()
        }
    }
}

pub async fn get_run_handler(
    Path(run_id): Path<String>,
    Extension(context): Extension<DeviceContext>,
    State(state): State<SharedState>,
) -> Response {
    if let Err(error) = require_scope(&context, WORKFLOW_READ_SCOPE) {
        audit_request(
            &context,
            "workflow_api_run_get",
            "deny",
            json!({ "run_id": run_id, "code": error.body.code.clone() }),
        )
        .await;
        return error.into_response();
    }
    let payload = json!({
        "accountId": context.account_id,
        "runId": run_id,
        "scopes": effective_scopes(&context),
    });
    match dispatch_bridge(&state, "workflow_api_run_get", payload).await {
        Ok(data) => {
            audit_request(
                &context,
                "workflow_api_run_get",
                "allow",
                json!({ "run_id": run_id }),
            )
            .await;
            json_response(StatusCode::OK, data)
        }
        Err(error) => {
            audit_request(
                &context,
                "workflow_api_run_get",
                "deny",
                json!({ "run_id": run_id, "code": error.body.code.clone() }),
            )
            .await;
            error.into_response()
        }
    }
}

pub async fn cancel_run_handler(
    Path(run_id): Path<String>,
    Extension(context): Extension<DeviceContext>,
    State(state): State<SharedState>,
) -> Response {
    if let Err(error) = require_scope(&context, WORKFLOW_RUN_SCOPE) {
        audit_request(
            &context,
            "workflow_api_run_cancel",
            "deny",
            json!({ "run_id": run_id, "code": error.body.code.clone() }),
        )
        .await;
        return error.into_response();
    }
    let payload = json!({
        "accountId": context.account_id,
        "runId": run_id,
        "caller": caller(&context),
        "scopes": effective_scopes(&context),
    });
    match dispatch_bridge(&state, "workflow_api_run_cancel", payload).await {
        Ok(data) => {
            audit_request(
                &context,
                "workflow_api_run_cancel",
                "allow",
                json!({ "run_id": run_id }),
            )
            .await;
            json_response(StatusCode::ACCEPTED, data)
        }
        Err(error) => {
            audit_request(
                &context,
                "workflow_api_run_cancel",
                "deny",
                json!({ "run_id": run_id, "code": error.body.code.clone() }),
            )
            .await;
            error.into_response()
        }
    }
}

fn parse_last_event_id(headers: &HeaderMap) -> Result<u64, ApiError> {
    let Some(raw) = headers.get("last-event-id") else {
        return Ok(0);
    };
    let raw = raw.to_str().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_event_cursor",
            "Last-Event-ID must be a non-negative safe integer",
        )
    })?;
    let cursor = raw.parse::<u64>().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_event_cursor",
            "Last-Event-ID must be a non-negative safe integer",
        )
    })?;
    if cursor > 9_007_199_254_740_991 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_event_cursor",
            "Last-Event-ID must be a non-negative safe integer",
        ));
    }
    Ok(cursor)
}

async fn load_events(
    state: &SharedState,
    context: &DeviceContext,
    run_id: &str,
    after_sequence: u64,
) -> Result<EventsPage, ApiError> {
    let data = dispatch_bridge(
        state,
        "workflow_api_events_list",
        json!({
            "accountId": context.account_id,
            "runId": run_id,
            "scopes": effective_scopes(context),
            "afterSequence": after_sequence,
        }),
    )
    .await?;
    parse_events_page(data, run_id, after_sequence)
}

fn parse_events_page(
    data: Value,
    run_id: &str,
    after_sequence: u64,
) -> Result<EventsPage, ApiError> {
    let page: EventsPage = serde_json::from_value(data).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            "workflow_service_protocol_error",
            "The workflow brain returned invalid event data",
        )
    })?;
    let mut cursor = after_sequence;
    for event in &page.events {
        let valid = event.get("runId").and_then(Value::as_str) == Some(run_id)
            && event.get("type").and_then(Value::as_str).is_some()
            && event.get("timestamp").and_then(Value::as_str).is_some()
            && event
                .get("sequence")
                .and_then(Value::as_u64)
                .is_some_and(|sequence| sequence > cursor);
        if !valid {
            return Err(ApiError::new(
                StatusCode::BAD_GATEWAY,
                "workflow_service_protocol_error",
                "The workflow brain returned invalid event data",
            ));
        }
        cursor = event["sequence"]
            .as_u64()
            .expect("validated event sequence");
    }
    Ok(page)
}

struct EventStreamState {
    state: SharedState,
    context: DeviceContext,
    run_id: String,
    cursor: u64,
    queue: VecDeque<Value>,
    terminal: bool,
    request_id: String,
}

fn sse_event(value: Value) -> Event {
    let sequence = value.get("sequence").and_then(Value::as_u64).unwrap_or(0);
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("workflow_event");
    Event::default()
        .id(sequence.to_string())
        .event(event_type)
        .data(value.to_string())
}

pub async fn events_handler(
    Path(run_id): Path<String>,
    Extension(context): Extension<DeviceContext>,
    headers: HeaderMap,
    State(state): State<SharedState>,
) -> Response {
    if let Err(error) = require_scope(&context, WORKFLOW_READ_SCOPE) {
        audit_request(
            &context,
            "workflow_api_events",
            "deny",
            json!({ "run_id": run_id, "code": error.body.code.clone() }),
        )
        .await;
        return error.into_response();
    }
    let cursor = match parse_last_event_id(&headers) {
        Ok(cursor) => cursor,
        Err(error) => {
            audit_request(
                &context,
                "workflow_api_events",
                "deny",
                json!({ "run_id": run_id, "code": error.body.code.clone() }),
            )
            .await;
            return error.into_response();
        }
    };
    // Resolve ownership and the first durable page before committing the HTTP
    // response to SSE, so 404/403/protocol failures retain their JSON status.
    let first = match load_events(&state, &context, &run_id, cursor).await {
        Ok(page) => page,
        Err(error) => {
            audit_request(
                &context,
                "workflow_api_events",
                "deny",
                json!({ "run_id": run_id, "code": error.body.code.clone() }),
            )
            .await;
            return error.into_response();
        }
    };
    audit_request(
        &context,
        "workflow_api_events",
        "allow",
        json!({ "run_id": run_id }),
    )
    .await;
    let request_id = Uuid::new_v4().to_string();
    let stream_state = EventStreamState {
        state,
        context,
        run_id,
        cursor,
        queue: first.events.into(),
        terminal: first.terminal,
        request_id: request_id.clone(),
    };
    let events = stream::unfold(stream_state, |mut stream_state| async move {
        loop {
            if let Some(value) = stream_state.queue.pop_front() {
                if let Some(sequence) = value.get("sequence").and_then(Value::as_u64) {
                    stream_state.cursor = stream_state.cursor.max(sequence);
                }
                return Some((Ok::<Event, Infallible>(sse_event(value)), stream_state));
            }
            if stream_state.terminal {
                return None;
            }
            tokio::time::sleep(SSE_POLL_INTERVAL).await;
            match load_events(
                &stream_state.state,
                &stream_state.context,
                &stream_state.run_id,
                stream_state.cursor,
            )
            .await
            {
                Ok(page) => {
                    stream_state.queue = page.events.into();
                    stream_state.terminal = page.terminal;
                }
                Err(error) => {
                    let payload = json!({
                        "runId": stream_state.run_id,
                        "sequence": stream_state.cursor,
                        "type": "error",
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                        "payload": {
                            "code": error.body.code,
                            "message": error.body.message,
                            "requestId": stream_state.request_id,
                        }
                    });
                    stream_state.queue.push_back(payload);
                    stream_state.terminal = true;
                }
            }
        }
    });
    let mut response = Sse::new(events)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("keep-alive"),
        )
        .into_response();
    if let Ok(header) = HeaderValue::from_str(&request_id) {
        response.headers_mut().insert("x-request-id", header);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(scope: &str, granted_scopes: &[&str]) -> DeviceContext {
        DeviceContext {
            device_id: "caller-1".to_string(),
            account_id: "account-1".to_string(),
            scope: scope.to_string(),
            granted_scopes: granted_scopes
                .iter()
                .map(|scope| scope.to_string())
                .collect(),
            authorization_capabilities: None,
        }
    }

    #[test]
    fn oidc_scopes_are_least_privilege_and_admin_is_a_superset() {
        let read = context("oidc", &[WORKFLOW_READ_SCOPE]);
        assert!(has_scope(&read, WORKFLOW_READ_SCOPE));
        assert!(!has_scope(&read, WORKFLOW_RUN_SCOPE));
        let admin = context("oidc", &[WORKFLOW_ADMIN_SCOPE]);
        assert!(has_scope(&admin, WORKFLOW_READ_SCOPE));
        assert!(has_scope(&admin, WORKFLOW_RUN_SCOPE));
        assert!(has_scope(&context("device", &[]), WORKFLOW_RUN_SCOPE));
    }

    #[test]
    fn create_run_body_rejects_unknown_top_level_fields() {
        assert!(serde_json::from_value::<CreateRunRequest>(json!({ "input": {} })).is_ok());
        assert!(serde_json::from_value::<CreateRunRequest>(json!({
            "input": {},
            "versionId": "caller-selected-version"
        }))
        .is_err());
    }

    #[test]
    fn last_event_id_accepts_monotonic_safe_integers_only() {
        let mut headers = HeaderMap::new();
        assert_eq!(parse_last_event_id(&headers).unwrap(), 0);
        headers.insert("last-event-id", "42".parse().unwrap());
        assert_eq!(parse_last_event_id(&headers).unwrap(), 42);
        headers.insert("last-event-id", "-1".parse().unwrap());
        assert_eq!(
            parse_last_event_id(&headers).unwrap_err().body.code,
            "invalid_event_cursor"
        );
        headers.insert("last-event-id", "9007199254740992".parse().unwrap());
        assert_eq!(
            parse_last_event_id(&headers).unwrap_err().status,
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn idempotency_key_rejects_invalid_utf8_and_oversized_values() {
        let mut headers = HeaderMap::new();
        assert_eq!(parse_idempotency_key(&headers).unwrap(), None);
        headers.insert("idempotency-key", "request-1".parse().unwrap());
        assert_eq!(
            parse_idempotency_key(&headers).unwrap().as_deref(),
            Some("request-1")
        );
        headers.insert(
            "idempotency-key",
            HeaderValue::from_bytes(&[0xff]).expect("opaque invalid UTF-8 header"),
        );
        assert_eq!(
            parse_idempotency_key(&headers).unwrap_err().body.code,
            "invalid_idempotency_key"
        );
        headers.insert("idempotency-key", "x".repeat(256).parse().unwrap());
        assert_eq!(
            parse_idempotency_key(&headers).unwrap_err().status,
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn sse_event_uses_sequence_as_id_and_preserves_the_envelope() {
        let rendered = sse_event(json!({
            "runId": "run-1",
            "sequence": 17,
            "type": "step_completed",
            "timestamp": "2026-08-06T00:00:00Z",
            "payload": { "ok": true }
        }));
        let debug = format!("{rendered:?}");
        assert!(debug.contains("17"));
        assert!(debug.contains("step_completed"));
        assert!(debug.contains("run-1"));
    }

    #[test]
    fn event_pages_require_ordered_events_for_the_requested_run() {
        let page = json!({
            "events": [{
                "runId": "run-1",
                "sequence": 2,
                "type": "step_completed",
                "timestamp": "2026-08-06T00:00:00Z"
            }],
            "terminal": false
        });
        assert_eq!(
            parse_events_page(page.clone(), "run-1", 1)
                .unwrap()
                .events
                .len(),
            1
        );
        assert_eq!(
            parse_events_page(page, "run-other", 1)
                .unwrap_err()
                .body
                .code,
            "workflow_service_protocol_error"
        );
        assert!(parse_events_page(
            json!({
                "events": [{
                    "runId": "run-1",
                    "sequence": 1,
                    "type": "step_completed",
                    "timestamp": "2026-08-06T00:00:00Z"
                }],
                "terminal": false
            }),
            "run-1",
            1
        )
        .is_err());
    }
}
