//! A2A axum handlers.
//!
//! - [`a2a_agent_card_handler`] — public `GET /.well-known/agent-card.json`.
//! - [`a2a_rpc_handler`] — DPoP device-access gated `POST /a2a`, dispatching the A2A
//!   JSON-RPC methods (`message/send`, `tasks/get`, `tasks/cancel`).
//!
//! `message/send` runs the turn synchronously: subscribe to the EventBus,
//! `claude_send`, then fold every `claude://message` frame through
//! [`A2aTurn`](super::turn::A2aTurn) until the turn terminates. The terminal
//! `Task` is stored so a later `tasks/get` resolves.

use axum::{
    extract::{rejection::JsonRejection, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::broadcast::Receiver;
use tokio::time::{timeout, Duration, Instant};

use super::super::acp::types::{self, rpc_error_code};
use super::super::event_bus::{EventFrame, SubscribeResult};
use super::super::{
    dispatch_host::DispatchHost,
    middleware::DeviceContext,
    remote_execution::{self, ExecutionOutcome, ExecutionRequest, ExecutionTransport},
    SharedState,
};
use super::store;
use super::turn::{A2aTurn, TurnOutcome};
use super::wire::{self, a2a_error_code, TaskState};

/// Hard ceiling on how long a single `message/send` turn may run before the
/// server interrupts the session and returns a failed task.
const TURN_TIMEOUT_SECS: u64 = 300;

/// Public Agent Card handler. Builds the advertised origin from the request
/// `Host` header (the front door is always HTTPS).
pub async fn a2a_agent_card_handler(headers: HeaderMap) -> Response {
    let Some(host) = headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .filter(|host| !host.is_empty())
    else {
        return super::super::api::public_error_response(
            axum::http::StatusCode::BAD_REQUEST,
            "host_header_required",
            "a valid Host header is required for A2A discovery",
            false,
            json!({}),
        );
    };
    Json(super::agent_card(&format!("https://{host}"))).into_response()
}

/// A2A JSON-RPC dispatch. Always replies with a JSON-RPC envelope (never a bare
/// HTTP error) so A2A clients can parse the failure.
pub async fn a2a_rpc_handler(
    State(state): State<SharedState>,
    Extension(ctx): Extension<DeviceContext>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match body {
        Ok(body) => body,
        Err(rejection) => {
            return super::super::api::public_error_response(
                rejection.status(),
                "invalid_a2a_request",
                "the A2A request body must be valid JSON",
                false,
                json!({}),
            )
        }
    };
    let id = body.get("id").cloned().unwrap_or(Value::Null);
    let method = body
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let params = body.get("params").cloned().unwrap_or(Value::Null);

    let result = match method.as_str() {
        "message/send" => handle_message_send(&state, &ctx, &id, &params).await,
        "tasks/get" => handle_tasks_get(&params),
        "tasks/cancel" => handle_tasks_cancel(&state, &ctx, &id, &params).await,
        "message/stream" => Err((
            a2a_error_code::UNSUPPORTED_OPERATION,
            "streaming is not supported by this agent (Agent Card advertises streaming:false)"
                .to_string(),
        )),
        other => Err((
            rpc_error_code::METHOD_NOT_FOUND,
            format!("method \"{other}\" is not supported"),
        )),
    };

    match result {
        Ok(value) => Json(types::rpc_response(&id, value)).into_response(),
        Err((code, message)) => Json(types::rpc_error(&id, code, &message)).into_response(),
    }
}

/// Run one companion RPC through the shared dispatch surface.
async fn dispatch(
    state: &SharedState,
    _host: &DispatchHost,
    ctx: &DeviceContext,
    name: &str,
    args: Value,
    wire_request_id: Option<&Value>,
) -> Result<Value, String> {
    let idempotency_key =
        remote_execution::protocol_idempotency_key(name, ctx, "a2a", wire_request_id);
    let request = ExecutionRequest::new(
        name,
        args,
        ctx.clone(),
        ExecutionTransport::Http,
        idempotency_key,
    );
    match remote_execution::execute(state, request).await {
        Ok(ExecutionOutcome::Completed { result, .. }) => Ok(result),
        Ok(ExecutionOutcome::Accepted { operation_id, .. }) => {
            Ok(json!({ "operationId": operation_id, "status": "running" }))
        }
        Err(error) => Err(error.message),
    }
}

async fn handle_message_send(
    state: &SharedState,
    ctx: &DeviceContext,
    request_id: &Value,
    params: &Value,
) -> Result<Value, (i64, String)> {
    let message = params.get("message").ok_or((
        rpc_error_code::INVALID_PARAMS,
        "message/send requires `message`".to_string(),
    ))?;
    let send_content = wire::message_parts_to_send_content(message)
        .map_err(|reason| (rpc_error_code::INVALID_PARAMS, reason))?;
    let idempotency_seed = a2a_request_seed(message, request_id);

    let Some(host) = DispatchHost::from_state(state) else {
        return Err((
            rpc_error_code::INTERNAL_ERROR,
            "no dispatch host available".to_string(),
        ));
    };

    // Continue the client's context when supplied, else mint a fresh session.
    let context_id = message
        .get("contextId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            remote_execution::derive_protocol_request_uuid(
                ctx,
                "a2a",
                idempotency_seed,
                "message-context",
            )
        });
    let task_id = remote_execution::derive_protocol_request_uuid(
        ctx,
        "a2a",
        idempotency_seed,
        "message-task",
    );
    if let Some(existing) = store::lookup_task(&task_id) {
        return Ok(existing);
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let receiver = match state.event_bus.subscribe(None, now_ms) {
        SubscribeResult::Ok { receiver, .. } => receiver,
        SubscribeResult::ResyncRequired => {
            return Err((
                rpc_error_code::INTERNAL_ERROR,
                "event bus resync required".to_string(),
            ))
        }
    };

    let args = json!({
        "session_id": context_id,
        "prompt": send_content,
        "options": { "includePartialMessages": true },
    });
    store::record_task(
        &task_id,
        wire::build_task(
            &task_id,
            &context_id,
            TaskState::Submitted,
            Vec::new(),
            None,
        ),
    );
    if let Err(message) = dispatch(
        state,
        &host,
        ctx,
        "claude_send",
        args,
        Some(idempotency_seed),
    )
    .await
    {
        store::record_task(
            &task_id,
            wire::build_task(
                &task_id,
                &context_id,
                TaskState::Failed,
                Vec::new(),
                Some(wire::agent_message(&context_id, &task_id, &message)),
            ),
        );
        return Err((rpc_error_code::INTERNAL_ERROR, message));
    }

    let task = drive_turn(state, Some(&host), ctx, receiver, &context_id, &task_id).await;
    store::record_task(&task_id, task.clone());
    Ok(task)
}

fn a2a_request_seed<'a>(message: &'a Value, json_rpc_id: &'a Value) -> &'a Value {
    message
        .get("messageId")
        .filter(|value| value.as_str().is_some_and(|id| !id.is_empty()))
        .unwrap_or(json_rpc_id)
}

/// Fold EventBus frames into an A2A turn until it terminates, returning the
/// final `Task`. `host` is `Option` so the loop is exercisable in tests
/// (a `None` host skips the deny/interrupt dispatches).
async fn drive_turn(
    state: &SharedState,
    host: Option<&DispatchHost>,
    ctx: &DeviceContext,
    mut receiver: Receiver<EventFrame>,
    context_id: &str,
    task_id: &str,
) -> Value {
    let mut turn = A2aTurn::new();
    let deadline = Instant::now() + Duration::from_secs(TURN_TIMEOUT_SECS);

    let outcome = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            interrupt(state, host, ctx, context_id).await;
            break TurnOutcome::Failed("turn timed out".to_string());
        }
        match timeout(remaining, receiver.recv()).await {
            Err(_) => {
                interrupt(state, host, ctx, context_id).await;
                break TurnOutcome::Failed("turn timed out".to_string());
            }
            Ok(Ok(frame)) => {
                if frame.event_type != "claude://message" {
                    continue;
                }
                let mut done = None;
                for action in turn.translate(context_id, &frame.payload) {
                    let step = turn.apply(action);
                    if let (Some(request_id), Some(host)) = (step.deny_permission, host) {
                        let _ = dispatch(
                            state,
                            host,
                            ctx,
                            "claude_approve",
                            json!({
                                "session_id": context_id,
                                "request_id": request_id,
                                "decision": "deny",
                            }),
                            None,
                        )
                        .await;
                    }
                    if let Some(outcome) = step.outcome {
                        done = Some(outcome);
                        break;
                    }
                }
                if let Some(outcome) = done {
                    break outcome;
                }
            }
            Ok(Err(RecvError::Lagged(n))) => {
                log::warn!("companion-api a2a: subscriber lagged by {n} frames; ending turn");
                interrupt(state, host, ctx, context_id).await;
                break TurnOutcome::Failed("event stream lagged".to_string());
            }
            Ok(Err(RecvError::Closed)) => {
                break TurnOutcome::Failed("event stream closed".to_string());
            }
        }
    };

    turn.final_task(task_id, context_id, &outcome)
}

async fn interrupt(
    state: &SharedState,
    host: Option<&DispatchHost>,
    ctx: &DeviceContext,
    context_id: &str,
) {
    if let Some(host) = host {
        let _ = dispatch(
            state,
            host,
            ctx,
            "claude_interrupt",
            json!({ "session_id": context_id }),
            None,
        )
        .await;
    }
}

fn handle_tasks_get(params: &Value) -> Result<Value, (i64, String)> {
    let id = params.get("id").and_then(Value::as_str).ok_or((
        rpc_error_code::INVALID_PARAMS,
        "tasks/get requires `id`".to_string(),
    ))?;
    store::lookup_task(id).ok_or((
        a2a_error_code::TASK_NOT_FOUND,
        format!("task \"{id}\" not found"),
    ))
}

async fn handle_tasks_cancel(
    state: &SharedState,
    ctx: &DeviceContext,
    request_id: &Value,
    params: &Value,
) -> Result<Value, (i64, String)> {
    let id = params.get("id").and_then(Value::as_str).ok_or((
        rpc_error_code::INVALID_PARAMS,
        "tasks/cancel requires `id`".to_string(),
    ))?;
    let Some(task) = store::lookup_task(id) else {
        return Err((
            a2a_error_code::TASK_NOT_FOUND,
            format!("task \"{id}\" not found"),
        ));
    };
    let state_str = task
        .get("status")
        .and_then(|status| status.get("state"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if matches!(state_str, "completed" | "failed" | "canceled") {
        return Err((
            a2a_error_code::TASK_NOT_CANCELABLE,
            format!("task \"{id}\" is in terminal state \"{state_str}\""),
        ));
    }
    let context_id = task
        .get("contextId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if let Some(host) = DispatchHost::from_state(state) {
        let _ = dispatch(
            state,
            &host,
            ctx,
            "claude_interrupt",
            json!({ "session_id": context_id }),
            Some(request_id),
        )
        .await;
    }
    let canceled = wire::build_task(id, &context_id, TaskState::Canceled, Vec::new(), None);
    store::record_task(id, canceled.clone());
    Ok(canceled)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_api::{
        deny_list::DenyList, event_bus::EventBus, idempotency::IdempotencyCache, CompanionState,
    };
    use parking_lot::RwLock;
    use std::sync::Arc;

    fn test_state() -> SharedState {
        Arc::new(CompanionState {
            secret: RwLock::new(vec![0u8; 32]),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
        })
    }

    fn test_ctx() -> DeviceContext {
        DeviceContext {
            device_id: "dev-1".into(),
            account_id: "acct-1".into(),
            scope: "device".into(),
            granted_scopes: Vec::new(),
            authorization_capabilities: None,
        }
    }

    #[tokio::test]
    async fn agent_card_handler_uses_host_header() {
        let mut headers = HeaderMap::new();
        headers.insert("host", "example.com:47820".parse().unwrap());
        let resp = a2a_agent_card_handler(headers).await;
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn agent_card_handler_rejects_a_missing_host_header_canonically() {
        let resp = a2a_agent_card_handler(HeaderMap::new()).await;
        assert_eq!(resp.status(), axum::http::StatusCode::BAD_REQUEST);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("response body");
        let body: Value = serde_json::from_slice(&bytes).expect("JSON error");
        assert_eq!(body["error"]["code"], "host_header_required");
    }

    #[tokio::test]
    async fn message_send_without_dispatch_host_errors() {
        let state = test_state();
        let params = json!({ "message": { "parts": [{ "kind": "text", "text": "hi" }] } });
        let result = handle_message_send(&state, &test_ctx(), &json!(1), &params).await;
        let (code, _) = result.unwrap_err();
        assert_eq!(code, rpc_error_code::INTERNAL_ERROR);
    }

    #[tokio::test]
    async fn message_send_rejects_missing_message() {
        let state = test_state();
        let result = handle_message_send(&state, &test_ctx(), &json!(1), &json!({})).await;
        assert_eq!(result.unwrap_err().0, rpc_error_code::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn message_send_rejects_bad_parts() {
        let state = test_state();
        let params = json!({ "message": { "parts": [] } });
        let result = handle_message_send(&state, &test_ctx(), &json!(1), &params).await;
        assert_eq!(result.unwrap_err().0, rpc_error_code::INVALID_PARAMS);
    }

    #[test]
    fn message_id_is_the_stable_a2a_idempotency_seed() {
        let message = json!({ "messageId": "message-a" });
        assert_eq!(a2a_request_seed(&message, &json!(9)), "message-a");

        let without_message_id = json!({});
        assert_eq!(a2a_request_seed(&without_message_id, &json!(9)), 9);
    }

    #[tokio::test]
    async fn drive_turn_accumulates_and_completes() {
        let state = test_state();
        let bus = Arc::clone(&state.event_bus);
        let now_ms = 0;
        let receiver = match bus.subscribe(None, now_ms) {
            SubscribeResult::Ok { receiver, .. } => receiver,
            SubscribeResult::ResyncRequired => panic!("unexpected resync"),
        };

        let driver = tokio::spawn({
            let state = Arc::clone(&state);
            async move { drive_turn(&state, None, &test_ctx(), receiver, "ctx-1", "task-1").await }
        });

        // Give the driver a moment to start awaiting, then publish frames.
        tokio::task::yield_now().await;
        bus.publish(
            "claude://message".into(),
            json!({
                "type": "event",
                "sessionId": "ctx-1",
                "event": {
                    "type": "stream_event",
                    "event": {
                        "type": "content_block_delta",
                        "delta": { "type": "text_delta", "text": "answer" },
                    },
                },
            }),
        );
        bus.publish(
            "claude://message".into(),
            json!({ "type": "event", "sessionId": "ctx-1", "event": { "type": "result", "subtype": "success" } }),
        );

        let task = driver.await.unwrap();
        assert_eq!(task["status"]["state"], "completed");
        assert_eq!(task["artifacts"][0]["parts"][0]["text"], "answer");
    }

    #[tokio::test]
    async fn drive_turn_maps_failure() {
        let state = test_state();
        let bus = Arc::clone(&state.event_bus);
        let receiver = match bus.subscribe(None, 0) {
            SubscribeResult::Ok { receiver, .. } => receiver,
            SubscribeResult::ResyncRequired => panic!("unexpected resync"),
        };
        let driver = tokio::spawn({
            let state = Arc::clone(&state);
            async move { drive_turn(&state, None, &test_ctx(), receiver, "ctx-2", "task-2").await }
        });
        tokio::task::yield_now().await;
        bus.publish(
            "claude://message".into(),
            json!({ "type": "event", "sessionId": "ctx-2", "event": { "type": "result", "subtype": "error", "is_error": true, "result": "nope" } }),
        );
        let task = driver.await.unwrap();
        assert_eq!(task["status"]["state"], "failed");
        assert_eq!(task["status"]["message"]["parts"][0]["text"], "nope");
    }

    #[tokio::test]
    async fn drive_turn_ignores_non_message_frames() {
        let state = test_state();
        let bus = Arc::clone(&state.event_bus);
        let receiver = match bus.subscribe(None, 0) {
            SubscribeResult::Ok { receiver, .. } => receiver,
            SubscribeResult::ResyncRequired => panic!("unexpected resync"),
        };
        let driver = tokio::spawn({
            let state = Arc::clone(&state);
            async move { drive_turn(&state, None, &test_ctx(), receiver, "ctx-3", "task-3").await }
        });
        tokio::task::yield_now().await;
        // A frame on another channel is ignored.
        bus.publish("some://other".into(), json!({ "sessionId": "ctx-3" }));
        bus.publish(
            "claude://message".into(),
            json!({ "type": "event", "sessionId": "ctx-3", "event": { "type": "result", "subtype": "success" } }),
        );
        let task = driver.await.unwrap();
        assert_eq!(task["status"]["state"], "completed");
    }

    #[test]
    fn tasks_get_missing_and_present() {
        let _guard = store::test_store_guard();
        store::reset_task_store_for_tests();
        let missing = handle_tasks_get(&json!({ "id": "unknown" }));
        assert_eq!(missing.unwrap_err().0, a2a_error_code::TASK_NOT_FOUND);

        assert_eq!(
            handle_tasks_get(&json!({})).unwrap_err().0,
            rpc_error_code::INVALID_PARAMS
        );

        store::record_task(
            "task-9",
            wire::build_task("task-9", "ctx-9", TaskState::Completed, Vec::new(), None),
        );
        let found = handle_tasks_get(&json!({ "id": "task-9" })).unwrap();
        assert_eq!(found["id"], "task-9");
        store::reset_task_store_for_tests();
    }

    #[tokio::test]
    async fn tasks_cancel_paths() {
        let _guard = store::test_store_guard();
        store::reset_task_store_for_tests();
        let state = test_state();

        // Unknown task.
        let unknown =
            handle_tasks_cancel(&state, &test_ctx(), &json!(1), &json!({ "id": "x" })).await;
        assert_eq!(unknown.unwrap_err().0, a2a_error_code::TASK_NOT_FOUND);

        // Missing id.
        assert_eq!(
            handle_tasks_cancel(&state, &test_ctx(), &json!(1), &json!({}))
                .await
                .unwrap_err()
                .0,
            rpc_error_code::INVALID_PARAMS
        );

        // Terminal task cannot be canceled.
        store::record_task(
            "done",
            wire::build_task("done", "ctx", TaskState::Completed, Vec::new(), None),
        );
        let terminal =
            handle_tasks_cancel(&state, &test_ctx(), &json!(1), &json!({ "id": "done" })).await;
        assert_eq!(terminal.unwrap_err().0, a2a_error_code::TASK_NOT_CANCELABLE);

        // A working task is cancelable (no dispatch host → interrupt skipped).
        store::record_task(
            "live",
            wire::build_task("live", "ctx-live", TaskState::Working, Vec::new(), None),
        );
        let canceled =
            handle_tasks_cancel(&state, &test_ctx(), &json!(1), &json!({ "id": "live" }))
                .await
                .unwrap();
        assert_eq!(canceled["status"]["state"], "canceled");
        assert_eq!(
            store::lookup_task("live").unwrap()["status"]["state"],
            "canceled"
        );
        store::reset_task_store_for_tests();
    }

    #[tokio::test]
    async fn rpc_handler_reports_unsupported_and_unknown_methods() {
        let state = test_state();
        let unsupported = a2a_rpc_handler(
            State(Arc::clone(&state)),
            Extension(test_ctx()),
            Ok(Json(
                json!({ "jsonrpc": "2.0", "id": 1, "method": "message/stream", "params": {} }),
            )),
        )
        .await;
        assert_eq!(unsupported.status(), 200);

        let unknown = a2a_rpc_handler(
            State(state),
            Extension(test_ctx()),
            Ok(Json(
                json!({ "jsonrpc": "2.0", "id": 2, "method": "frobnicate" }),
            )),
        )
        .await;
        assert_eq!(unknown.status(), 200);
    }

    #[tokio::test]
    async fn rpc_handler_rejects_invalid_json_with_the_public_error_envelope() {
        use tower::ServiceExt as _;

        let router = axum::Router::new()
            .route("/a2a", axum::routing::post(a2a_rpc_handler))
            .layer(axum::Extension(test_ctx()))
            .with_state(test_state());
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/a2a")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from("{"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        let body: Value = serde_json::from_slice(&bytes).expect("JSON error");
        assert_eq!(body["error"]["code"], "invalid_a2a_request");
        assert!(body["error"]["requestId"].as_str().is_some());
    }
}
