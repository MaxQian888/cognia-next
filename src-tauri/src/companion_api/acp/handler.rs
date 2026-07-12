//! ACP server WebSocket handler — `GET /ws/v1/acp`.
//!
//! Speaks the Agent Client Protocol (agentclientprotocol.com, JSON-RPC 2.0,
//! one message per WS text frame) and translates it onto the companion RPC
//! dispatch surface:
//!
//! | ACP method                      | binding                                   |
//! |---------------------------------|-------------------------------------------|
//! | `initialize`                    | static capabilities                        |
//! | `session/new`                   | mint UUID, stash cwd                       |
//! | `session/prompt`                | `rpc::dispatch("claude_send", …)`; the     |
//! |                                 | JSON-RPC result is deferred to turn end    |
//! | `session/cancel` (notification) | `rpc::dispatch("claude_interrupt", …)`     |
//! | `session/load`                  | resume via the global resume index         |
//! | `session/request_permission` ⟵  | sidecar `permission_request` events; the   |
//! |   client response               | response maps to `claude_approve`          |
//! | `session/update` ⟶              | EventBus `claude://message` frames         |
//!
//! Because `claude_send` / `claude_interrupt` / `claude_approve` are
//! host-generic dispatch arms (ADR-0059 R7), this endpoint works both on the
//! desktop Tauri app and on the headless `cognia-server`.
//!
//! Heartbeats use RFC 6455 ping frames (NOT the `{"type":"ping"}` JSON of
//! `/ws/v1/events`) — every text frame on this socket must be a JSON-RPC
//! message or clients would choke on non-protocol frames.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Response,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::time::{interval, Duration, Instant};

use super::super::{
    dispatch_host::DispatchHost, event_bus::SubscribeResult, middleware::DeviceContext, rpc,
    SharedState,
};
use super::registry::{
    lookup_resume_info, record_resume_info, ConnectionSessions, PendingPrompt, ResumeInfo,
    SessionEntry,
};
use super::translate::{translate_frame, AcpOutbound};
use super::types::{self, rpc_error_code, JsonRpcIncoming, StopReason};

/// Interval between server-sent RFC 6455 ping frames.
const HEARTBEAT_SECS: u64 = 25;

/// Maximum client silence before the connection is closed. Editors keep the
/// socket open across long idle stretches; ping/pong keeps the timer fresh.
const IDLE_TIMEOUT_SECS: u64 = 90;

/// Inbound frame cap. Prompts can embed base64 images/resources, so this is
/// larger than the events channel's 64 KiB but still bounds a hostile peer.
const MAX_WS_FRAME_BYTES: usize = 256 * 1024;

/// Coerce a JSON-RPC response `id` back to the `u64` this server minted for a
/// server→client request. We always send numeric ids, but a strict-but-quirky
/// client may echo them stringified (`"5"`); accept that too rather than
/// silently dropping the response.
fn as_response_id(id: &Value) -> Option<u64> {
    id.as_u64()
        .or_else(|| id.as_str().and_then(|s| s.parse::<u64>().ok()))
}

/// Axum handler for `GET /ws/v1/acp`. Mounted inside the protected block, so
/// `require_device_jwt` has already verified the token; the [`DeviceContext`]
/// is read off the request extensions *before* the upgrade consumes them
/// (extensions do not survive into the upgrade closure).
pub async fn acp_handler(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
    request: axum::extract::Request,
) -> Response {
    let ctx = request.extensions().get::<DeviceContext>().cloned();
    let (device_id, account_id, scope) = match ctx {
        Some(ctx) => (ctx.device_id, Some(ctx.account_id), Some(ctx.scope)),
        None => (String::new(), None, None),
    };

    ws.max_message_size(MAX_WS_FRAME_BYTES)
        .max_frame_size(MAX_WS_FRAME_BYTES)
        .on_upgrade(move |socket| handle_acp_socket(socket, state, device_id, account_id, scope))
}

/// Everything one ACP connection needs to service requests.
struct AcpConnection {
    state: SharedState,
    host: Option<DispatchHost>,
    device_id: String,
    account_id: Option<String>,
    scope: Option<String>,
    sessions: ConnectionSessions,
    initialized: bool,
    /// Next id for server→client requests (`session/request_permission`).
    next_out_id: u64,
    /// Outstanding server→client permission requests:
    /// out id → (acp session id, sidecar request id).
    pending_permissions: HashMap<u64, (String, String)>,
}

impl AcpConnection {
    fn new(
        state: SharedState,
        device_id: String,
        account_id: Option<String>,
        scope: Option<String>,
    ) -> Self {
        let host = DispatchHost::from_state(&state);
        Self {
            state,
            host,
            device_id,
            account_id,
            scope,
            sessions: ConnectionSessions::new(),
            initialized: false,
            next_out_id: 1,
            pending_permissions: HashMap::new(),
        }
    }

    /// Run one companion RPC through the shared dispatch surface, flattening
    /// the error into a plain message string.
    async fn dispatch(&self, name: &str, args: Value) -> Result<Value, String> {
        let Some(host) = self.host.as_ref() else {
            return Err("no dispatch host available (test mode)".to_string());
        };
        rpc::dispatch(
            name,
            args,
            &self.state,
            host,
            &self.device_id,
            self.account_id.as_deref(),
            self.scope.as_deref(),
        )
        .await
        .map_err(|(_status, err)| err.0.message)
    }

    /// Handle one inbound JSON-RPC message; returns the outbound messages to
    /// write to the socket (responses, notifications, server→client requests).
    async fn handle_message(&mut self, raw: &str) -> Vec<Value> {
        let msg: JsonRpcIncoming = match serde_json::from_str(raw) {
            Ok(msg) => msg,
            Err(_) => {
                return vec![types::rpc_error(
                    &Value::Null,
                    rpc_error_code::PARSE_ERROR,
                    "invalid JSON",
                )];
            }
        };

        if msg.is_response() {
            return self.handle_permission_response(&msg).await;
        }
        let Some(method) = msg.method.clone() else {
            return vec![types::rpc_error(
                &msg.id.unwrap_or(Value::Null),
                rpc_error_code::INVALID_REQUEST,
                "message is neither request, notification, nor response",
            )];
        };
        let params = msg.params.clone().unwrap_or(Value::Null);

        if msg.is_notification() {
            self.handle_notification(&method, &params).await;
            return Vec::new();
        }

        let id = msg.id.clone().unwrap_or(Value::Null);
        self.handle_request(&id, &method, &params).await
    }

    async fn handle_request(&mut self, id: &Value, method: &str, params: &Value) -> Vec<Value> {
        match method {
            "initialize" => {
                self.initialized = true;
                vec![types::rpc_response(id, types::initialize_result())]
            }
            _ if !self.initialized => vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_REQUEST,
                "initialize must be called first",
            )],
            "session/new" => self.handle_session_new(id, params),
            "session/load" => self.handle_session_load(id, params),
            "session/set_mode" => self.handle_session_set_mode(id, params),
            "session/set_model" => self.handle_session_set_model(id, params),
            "session/prompt" => self.handle_session_prompt(id, params).await,
            _ => vec![types::rpc_error(
                id,
                rpc_error_code::METHOD_NOT_FOUND,
                &format!("method \"{method}\" is not supported"),
            )],
        }
    }

    fn handle_session_new(&mut self, id: &Value, params: &Value) -> Vec<Value> {
        let Some(cwd) = params.get("cwd").and_then(Value::as_str) else {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                "session/new requires `cwd`",
            )];
        };
        let session_id = uuid::Uuid::new_v4().to_string();
        let entry = SessionEntry {
            cwd: Some(cwd.to_string()),
            ..Default::default()
        };
        self.sessions.insert(&session_id, entry);
        record_resume_info(
            &session_id,
            ResumeInfo {
                cwd: Some(cwd.to_string()),
                sdk_session_id: None,
            },
        );
        vec![types::rpc_response(
            id,
            types::session_new_result(&session_id),
        )]
    }

    fn handle_session_set_mode(&mut self, id: &Value, params: &Value) -> Vec<Value> {
        let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                "session/set_mode requires `sessionId`",
            )];
        };
        let Some(mode_id) = params.get("modeId").and_then(Value::as_str) else {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                "session/set_mode requires `modeId`",
            )];
        };
        if !types::is_valid_mode(mode_id) {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                &format!("unknown mode \"{mode_id}\""),
            )];
        }
        let Some(entry) = self.sessions.get_mut(session_id) else {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                &format!("unknown session \"{session_id}\""),
            )];
        };
        entry.selected_mode_id = Some(mode_id.to_string());
        vec![types::rpc_response(id, Value::Null)]
    }

    fn handle_session_set_model(&mut self, id: &Value, params: &Value) -> Vec<Value> {
        let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                "session/set_model requires `sessionId`",
            )];
        };
        let Some(model_id) = params.get("modelId").and_then(Value::as_str) else {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                "session/set_model requires `modelId`",
            )];
        };
        if !types::is_valid_model(model_id) {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                &format!("unknown model \"{model_id}\""),
            )];
        }
        let Some(entry) = self.sessions.get_mut(session_id) else {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                &format!("unknown session \"{session_id}\""),
            )];
        };
        entry.selected_model_id = Some(model_id.to_string());
        vec![types::rpc_response(id, Value::Null)]
    }

    fn handle_session_load(&mut self, id: &Value, params: &Value) -> Vec<Value> {
        let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                "session/load requires `sessionId`",
            )];
        };
        if self.sessions.contains(session_id) {
            // Already live on this connection — nothing to restore.
            return vec![types::rpc_response(id, Value::Null)];
        }
        let Some(info) = lookup_resume_info(session_id) else {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                &format!("unknown session \"{session_id}\""),
            )];
        };
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or(info.cwd);
        let entry = SessionEntry {
            cwd,
            resume_session_id: info.sdk_session_id.clone(),
            sdk_session_id: info.sdk_session_id,
            ..Default::default()
        };
        self.sessions.insert(session_id, entry);
        vec![types::rpc_response(id, Value::Null)]
    }

    async fn handle_session_prompt(&mut self, id: &Value, params: &Value) -> Vec<Value> {
        let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                "session/prompt requires `sessionId`",
            )];
        };
        let session_id = session_id.to_string();
        let prompt = params.get("prompt").cloned().unwrap_or(Value::Null);
        let send_content = match types::prompt_blocks_to_send_content(&prompt) {
            Ok(content) => content,
            Err(reason) => {
                return vec![types::rpc_error(
                    id,
                    rpc_error_code::INVALID_PARAMS,
                    &reason,
                )];
            }
        };

        // Validate session + single-turn invariant, and collect send options.
        let (cwd, resume_session_id, selected_mode_id, selected_model_id) = {
            let Some(entry) = self.sessions.get_mut(&session_id) else {
                return vec![types::rpc_error(
                    id,
                    rpc_error_code::INVALID_PARAMS,
                    &format!("unknown session \"{session_id}\""),
                )];
            };
            if entry.pending_prompt.is_some() {
                return vec![types::rpc_error(
                    id,
                    rpc_error_code::INVALID_REQUEST,
                    "a prompt turn is already in flight for this session",
                )];
            }
            (
                entry.cwd.clone(),
                entry.resume_session_id.take(),
                entry.selected_mode_id.clone(),
                entry.selected_model_id.clone(),
            )
        };

        let mut options = serde_json::Map::new();
        if let Some(cwd) = cwd {
            options.insert("cwd".to_string(), json!(cwd));
        }
        if let Some(resume) = resume_session_id {
            options.insert("resumeSessionId".to_string(), json!(resume));
        }
        // `session/set_mode` selection → SendOptions.permission_mode (identity).
        if let Some(mode_id) = selected_mode_id {
            options.insert(
                "permissionMode".to_string(),
                json!(types::map_acp_mode_to_send(&mode_id)),
            );
        }
        // `session/set_model` selection → SendOptions.model. The `default`
        // pseudo-id injects nothing so the account default stands.
        if let Some(model_id) = selected_model_id {
            if model_id != types::DEFAULT_MODEL_ID {
                options.insert("model".to_string(), json!(model_id));
            }
        }
        // Streaming deltas are what agent_message_chunk forwarding rides on.
        options.insert("includePartialMessages".to_string(), json!(true));

        let args = json!({
            "session_id": session_id,
            "prompt": send_content,
            "options": Value::Object(options),
        });
        if let Err(message) = self.dispatch("claude_send", args).await {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INTERNAL_ERROR,
                &message,
            )];
        }

        // Park the request; the EventBus branch resolves it at turn end.
        if let Some(entry) = self.sessions.get_mut(&session_id) {
            entry.turn.reset();
            entry.prompted = true;
            entry.pending_prompt = Some(PendingPrompt {
                rpc_id: id.clone(),
                cancelled: false,
            });
        }
        Vec::new()
    }

    async fn handle_notification(&mut self, method: &str, params: &Value) {
        if method != "session/cancel" {
            return;
        }
        let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
            return;
        };
        let session_id = session_id.to_string();
        if let Some(entry) = self.sessions.get_mut(&session_id) {
            if let Some(pending) = entry.pending_prompt.as_mut() {
                pending.cancelled = true;
            }
        } else {
            return;
        }
        if let Err(message) = self
            .dispatch("claude_interrupt", json!({ "session_id": session_id }))
            .await
        {
            log::warn!("companion-api acp: claude_interrupt failed: {message}");
        }
    }

    /// A response to a server→client `session/request_permission` request.
    async fn handle_permission_response(&mut self, msg: &JsonRpcIncoming) -> Vec<Value> {
        let Some(out_id) = msg.id.as_ref().and_then(as_response_id) else {
            return Vec::new();
        };
        let Some((session_id, request_id)) = self.pending_permissions.remove(&out_id) else {
            return Vec::new();
        };
        // An error response (client could not answer) denies — fail closed.
        let decision = match (&msg.result, &msg.error) {
            (Some(result), _) => types::outcome_to_decision(result),
            (None, _) => "deny".to_string(),
        };
        if let Err(message) = self
            .dispatch(
                "claude_approve",
                json!({
                    "session_id": session_id,
                    "request_id": request_id,
                    "decision": decision,
                }),
            )
            .await
        {
            log::warn!("companion-api acp: claude_approve failed: {message}");
        }
        Vec::new()
    }

    /// Translate one EventBus frame payload into outbound socket messages.
    async fn handle_event_payload(&mut self, payload: &Value) -> Vec<Value> {
        let Some(session_id) = payload
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return Vec::new();
        };
        if !self.sessions.contains(&session_id) {
            return Vec::new();
        }

        let outbound = {
            let entry = self
                .sessions
                .get_mut(&session_id)
                .expect("checked contains above");
            translate_frame(&session_id, payload, &mut entry.turn)
        };

        let mut messages = Vec::new();
        for action in outbound {
            match action {
                AcpOutbound::Update(update) => {
                    messages.push(types::session_update_notification(&session_id, &update));
                }
                AcpOutbound::PermissionRequest {
                    request_id,
                    tool_call_id,
                    title,
                    kind,
                    raw_input,
                } => {
                    let out_id = self.next_out_id;
                    self.next_out_id += 1;
                    self.pending_permissions
                        .insert(out_id, (session_id.clone(), request_id));
                    messages.push(types::rpc_request(
                        out_id,
                        "session/request_permission",
                        types::permission_request_params(
                            &session_id,
                            &tool_call_id,
                            &title,
                            &kind,
                            &raw_input,
                        ),
                    ));
                }
                AcpOutbound::TurnEnded(reason) => {
                    if let Some(msg) = self.resolve_pending(&session_id, reason, None) {
                        messages.push(msg);
                    }
                }
                AcpOutbound::TurnFailed(message) => {
                    if let Some(msg) =
                        self.resolve_pending(&session_id, StopReason::EndTurn, Some(message))
                    {
                        messages.push(msg);
                    }
                }
                AcpOutbound::SdkSessionId(sdk_id) => {
                    let cwd = if let Some(entry) = self.sessions.get_mut(&session_id) {
                        entry.sdk_session_id = Some(sdk_id.clone());
                        entry.cwd.clone()
                    } else {
                        None
                    };
                    record_resume_info(
                        &session_id,
                        ResumeInfo {
                            cwd,
                            sdk_session_id: Some(sdk_id),
                        },
                    );
                }
            }
        }
        messages
    }

    /// Resolve the parked `session/prompt`. A cancelled turn always resolves
    /// as `cancelled` (per spec, not as an error); `error` otherwise rejects.
    fn resolve_pending(
        &mut self,
        session_id: &str,
        reason: StopReason,
        error: Option<String>,
    ) -> Option<Value> {
        let entry = self.sessions.get_mut(session_id)?;
        let pending = entry.pending_prompt.take()?;
        if pending.cancelled {
            return Some(types::rpc_response(
                &pending.rpc_id,
                types::prompt_result(StopReason::Cancelled),
            ));
        }
        match error {
            Some(message) => Some(types::rpc_error(
                &pending.rpc_id,
                rpc_error_code::INTERNAL_ERROR,
                &message,
            )),
            None => Some(types::rpc_response(
                &pending.rpc_id,
                types::prompt_result(reason),
            )),
        }
    }

    /// Disconnect cleanup: interrupt + close every session that dispatched a
    /// prompt, and fail any parked prompts locally (socket is gone anyway).
    async fn cleanup(&mut self) {
        for (_, entry) in self.sessions.iter_mut() {
            entry.pending_prompt = None;
        }
        for session_id in self.sessions.prompted_session_ids() {
            let _ = self
                .dispatch("claude_interrupt", json!({ "session_id": session_id }))
                .await;
            let _ = self
                .dispatch("claude_close_session", json!({ "session_id": session_id }))
                .await;
        }
    }
}

/// Drive one ACP WebSocket connection.
async fn handle_acp_socket(
    mut socket: WebSocket,
    state: SharedState,
    device_id: String,
    account_id: Option<String>,
    scope: Option<String>,
) {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // Live subscription only — ACP has no replay cursor semantics.
    let mut receiver = match state.event_bus.subscribe(None, now_ms) {
        SubscribeResult::Ok { receiver, .. } => receiver,
        SubscribeResult::ResyncRequired => return, // unreachable with since=None
    };

    let mut conn = AcpConnection::new(state, device_id, account_id, scope);

    let mut hb_ticker = interval(Duration::from_secs(HEARTBEAT_SECS));
    hb_ticker.tick().await; // consume the immediate first tick
    let idle_timeout = Duration::from_secs(IDLE_TIMEOUT_SECS);
    let mut last_client_activity = Instant::now();

    loop {
        tokio::select! {
            // Sidecar events → session/update etc.
            result = receiver.recv() => {
                match result {
                    Ok(frame) => {
                        if frame.event_type != "claude://message" {
                            continue;
                        }
                        for msg in conn.handle_event_payload(&frame.payload).await {
                            if send_json(&mut socket, &msg).await.is_err() {
                                conn.cleanup().await;
                                return;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("companion-api acp: subscriber lagged by {n} frames; closing");
                        conn.cleanup().await;
                        return;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        conn.cleanup().await;
                        return;
                    }
                }
            }

            // Inbound client frames.
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        last_client_activity = Instant::now();
                        for out in conn.handle_message(&text).await {
                            if send_json(&mut socket, &out).await.is_err() {
                                conn.cleanup().await;
                                return;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        last_client_activity = Instant::now();
                        let _ = socket.send(Message::Pong(data)).await;
                    }
                    Some(Ok(Message::Pong(_))) => {
                        last_client_activity = Instant::now();
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        conn.cleanup().await;
                        return;
                    }
                    Some(Ok(_)) => { /* binary frames ignored */ }
                    Some(Err(_)) => {
                        conn.cleanup().await;
                        return;
                    }
                }
            }

            // RFC 6455 heartbeat + idle enforcement.
            _ = hb_ticker.tick() => {
                if last_client_activity.elapsed() > idle_timeout {
                    log::debug!("companion-api acp: idle timeout, closing connection");
                    conn.cleanup().await;
                    return;
                }
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    conn.cleanup().await;
                    return;
                }
            }
        }
    }
}

async fn send_json(socket: &mut WebSocket, value: &Value) -> Result<(), ()> {
    let text = serde_json::to_string(value).map_err(|_| ())?;
    socket
        .send(Message::Text(text.into()))
        .await
        .map_err(|_| ())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_api::{
        deny_list::DenyList, event_bus::EventBus, idempotency::IdempotencyCache,
        pair_code_lru::PairCodeLru, redemption_lru::RedemptionLru, CompanionState,
    };
    use parking_lot::RwLock;
    use std::sync::Arc;

    fn test_state() -> SharedState {
        Arc::new(CompanionState {
            secret: RwLock::new(vec![0u8; 32]),
            redemption_lru: RedemptionLru::new(),
            pair_code_lru: Arc::new(PairCodeLru::new()),
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

    fn test_conn() -> AcpConnection {
        AcpConnection::new(
            test_state(),
            "dev-1".to_string(),
            None,
            Some("device".into()),
        )
    }

    async fn initialize(conn: &mut AcpConnection) {
        let out = conn
            .handle_message(r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}"#)
            .await;
        assert_eq!(out[0]["result"]["protocolVersion"], 1);
    }

    async fn new_session(conn: &mut AcpConnection) -> String {
        let out = conn
            .handle_message(
                r#"{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/repo"}}"#,
            )
            .await;
        out[0]["result"]["sessionId"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn initialize_returns_capabilities() {
        let mut conn = test_conn();
        let out = conn
            .handle_message(r#"{"jsonrpc":"2.0","id":5,"method":"initialize","params":{}}"#)
            .await;
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["id"], 5);
        assert_eq!(out[0]["result"]["agentInfo"]["name"], "cognia");
        assert_eq!(out[0]["result"]["agentCapabilities"]["loadSession"], true);
    }

    #[tokio::test]
    async fn requests_before_initialize_are_rejected() {
        let mut conn = test_conn();
        let out = conn
            .handle_message(
                r#"{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/x"}}"#,
            )
            .await;
        assert_eq!(out[0]["error"]["code"], rpc_error_code::INVALID_REQUEST);
    }

    #[tokio::test]
    async fn session_new_mints_id_and_records_resume_info() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let session_id = new_session(&mut conn).await;
        assert!(conn.sessions.contains(&session_id));
        let info = lookup_resume_info(&session_id).unwrap();
        assert_eq!(info.cwd, Some("/repo".to_string()));
    }

    #[tokio::test]
    async fn session_new_requires_cwd() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let out = conn
            .handle_message(r#"{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}"#)
            .await;
        assert_eq!(out[0]["error"]["code"], rpc_error_code::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn unknown_method_yields_method_not_found() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let out = conn
            .handle_message(r#"{"jsonrpc":"2.0","id":9,"method":"session/fork","params":{}}"#)
            .await;
        assert_eq!(out[0]["error"]["code"], rpc_error_code::METHOD_NOT_FOUND);
    }

    #[tokio::test]
    async fn session_new_advertises_modes_and_models() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let out = conn
            .handle_message(
                r#"{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/repo"}}"#,
            )
            .await;
        let result = &out[0]["result"];
        assert!(result["sessionId"].as_str().is_some());
        assert_eq!(result["modes"]["currentModeId"], types::DEFAULT_MODE_ID);
        assert!(!result["modes"]["availableModes"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(result["models"]["currentModelId"], types::DEFAULT_MODEL_ID);
        assert!(!result["models"]["availableModels"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn set_mode_persists_and_validates() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let session_id = new_session(&mut conn).await;

        // Valid mode is stored on the session entry.
        let msg = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"session/set_mode","params":{{"sessionId":"{session_id}","modeId":"plan"}}}}"#
        );
        let out = conn.handle_message(&msg).await;
        assert!(out[0].get("result").is_some());
        assert_eq!(
            conn.sessions.get_mut(&session_id).unwrap().selected_mode_id,
            Some("plan".to_string())
        );

        // Unknown mode → INVALID_PARAMS.
        let msg = format!(
            r#"{{"jsonrpc":"2.0","id":3,"method":"session/set_mode","params":{{"sessionId":"{session_id}","modeId":"bogus"}}}}"#
        );
        let out = conn.handle_message(&msg).await;
        assert_eq!(out[0]["error"]["code"], rpc_error_code::INVALID_PARAMS);

        // Unknown session → INVALID_PARAMS.
        let out = conn
            .handle_message(
                r#"{"jsonrpc":"2.0","id":4,"method":"session/set_mode","params":{"sessionId":"nope","modeId":"plan"}}"#,
            )
            .await;
        assert_eq!(out[0]["error"]["code"], rpc_error_code::INVALID_PARAMS);

        // Missing modeId → INVALID_PARAMS.
        let msg = format!(
            r#"{{"jsonrpc":"2.0","id":5,"method":"session/set_mode","params":{{"sessionId":"{session_id}"}}}}"#
        );
        let out = conn.handle_message(&msg).await;
        assert_eq!(out[0]["error"]["code"], rpc_error_code::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn set_model_persists_and_validates() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let session_id = new_session(&mut conn).await;

        let msg = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"session/set_model","params":{{"sessionId":"{session_id}","modelId":"claude-opus-4-8"}}}}"#
        );
        let out = conn.handle_message(&msg).await;
        assert!(out[0].get("result").is_some());
        assert_eq!(
            conn.sessions
                .get_mut(&session_id)
                .unwrap()
                .selected_model_id,
            Some("claude-opus-4-8".to_string())
        );

        // Unknown model → INVALID_PARAMS.
        let msg = format!(
            r#"{{"jsonrpc":"2.0","id":3,"method":"session/set_model","params":{{"sessionId":"{session_id}","modelId":"gpt-4"}}}}"#
        );
        let out = conn.handle_message(&msg).await;
        assert_eq!(out[0]["error"]["code"], rpc_error_code::INVALID_PARAMS);
    }

    #[test]
    fn response_id_accepts_numeric_and_stringified() {
        // Numeric ids (what we mint) and a strict client's stringified echo both
        // resolve; garbage does not.
        assert_eq!(as_response_id(&json!(5)), Some(5));
        assert_eq!(as_response_id(&json!("7")), Some(7));
        assert_eq!(as_response_id(&json!("nan")), None);
        assert_eq!(as_response_id(&json!(-1)), None);
        assert_eq!(as_response_id(&Value::Null), None);
    }

    #[tokio::test]
    async fn malformed_json_yields_parse_error() {
        let mut conn = test_conn();
        let out = conn.handle_message("{nope").await;
        assert_eq!(out[0]["error"]["code"], rpc_error_code::PARSE_ERROR);
    }

    #[tokio::test]
    async fn prompt_on_unknown_session_is_rejected() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let out = conn
            .handle_message(
                r#"{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":"ghost","prompt":[{"type":"text","text":"hi"}]}}"#,
            )
            .await;
        assert_eq!(out[0]["error"]["code"], rpc_error_code::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn prompt_with_bad_blocks_is_rejected() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let session_id = new_session(&mut conn).await;
        let msg = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{{"sessionId":"{session_id}","prompt":[]}}}}"#
        );
        let out = conn.handle_message(&msg).await;
        assert_eq!(out[0]["error"]["code"], rpc_error_code::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn prompt_without_dispatch_host_errors_cleanly() {
        // Test states have no Tauri app and no headless registry, so
        // dispatch fails — the prompt must surface a JSON-RPC error rather
        // than hang the parked request forever.
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let session_id = new_session(&mut conn).await;
        let msg = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{{"sessionId":"{session_id}","prompt":[{{"type":"text","text":"hi"}}]}}}}"#
        );
        let out = conn.handle_message(&msg).await;
        assert_eq!(out[0]["error"]["code"], rpc_error_code::INTERNAL_ERROR);
        // No pending prompt was parked.
        assert!(conn
            .sessions
            .get_mut(&session_id)
            .unwrap()
            .pending_prompt
            .is_none());
    }

    #[tokio::test]
    async fn second_prompt_while_pending_is_rejected() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let session_id = new_session(&mut conn).await;
        // Park a pending prompt manually (dispatch is unavailable in tests).
        conn.sessions.get_mut(&session_id).unwrap().pending_prompt = Some(PendingPrompt {
            rpc_id: json!(2),
            cancelled: false,
        });
        let msg = format!(
            r#"{{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{{"sessionId":"{session_id}","prompt":[{{"type":"text","text":"hi"}}]}}}}"#
        );
        let out = conn.handle_message(&msg).await;
        assert_eq!(out[0]["error"]["code"], rpc_error_code::INVALID_REQUEST);
    }

    #[tokio::test]
    async fn session_load_unknown_session_errors() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let out = conn
            .handle_message(
                r#"{"jsonrpc":"2.0","id":4,"method":"session/load","params":{"sessionId":"missing-load"}}"#,
            )
            .await;
        assert_eq!(out[0]["error"]["code"], rpc_error_code::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn session_load_restores_resume_target() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        record_resume_info(
            "acp-load-1",
            ResumeInfo {
                cwd: Some("/old".into()),
                sdk_session_id: Some("sdk-77".into()),
            },
        );
        let out = conn
            .handle_message(
                r#"{"jsonrpc":"2.0","id":4,"method":"session/load","params":{"sessionId":"acp-load-1"}}"#,
            )
            .await;
        assert!(out[0].get("error").is_none());
        let entry = conn.sessions.get_mut("acp-load-1").unwrap();
        assert_eq!(entry.resume_session_id, Some("sdk-77".to_string()));
        assert_eq!(entry.cwd, Some("/old".to_string()));
    }

    #[tokio::test]
    async fn cancel_marks_pending_prompt() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let session_id = new_session(&mut conn).await;
        conn.sessions.get_mut(&session_id).unwrap().pending_prompt = Some(PendingPrompt {
            rpc_id: json!(2),
            cancelled: false,
        });
        let msg = format!(
            r#"{{"jsonrpc":"2.0","method":"session/cancel","params":{{"sessionId":"{session_id}"}}}}"#
        );
        let out = conn.handle_message(&msg).await;
        assert!(out.is_empty(), "cancel is a notification — no response");
        assert!(
            conn.sessions
                .get_mut(&session_id)
                .unwrap()
                .pending_prompt
                .as_ref()
                .unwrap()
                .cancelled
        );
    }

    #[tokio::test]
    async fn turn_end_resolves_parked_prompt() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let session_id = new_session(&mut conn).await;
        conn.sessions.get_mut(&session_id).unwrap().pending_prompt = Some(PendingPrompt {
            rpc_id: json!(2),
            cancelled: false,
        });

        let payload = json!({
            "type": "event",
            "sessionId": session_id,
            "event": { "type": "result", "subtype": "success" },
        });
        let out = conn.handle_event_payload(&payload).await;
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["id"], 2);
        assert_eq!(out[0]["result"]["stopReason"], "end_turn");
    }

    #[tokio::test]
    async fn cancelled_turn_resolves_as_cancelled() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let session_id = new_session(&mut conn).await;
        conn.sessions.get_mut(&session_id).unwrap().pending_prompt = Some(PendingPrompt {
            rpc_id: json!(2),
            cancelled: true,
        });

        // Even an error result resolves as `cancelled` once cancel was seen.
        let payload = json!({
            "type": "event",
            "sessionId": session_id,
            "event": { "type": "result", "subtype": "error", "is_error": true, "result": "x" },
        });
        let out = conn.handle_event_payload(&payload).await;
        assert_eq!(out[0]["result"]["stopReason"], "cancelled");
    }

    #[tokio::test]
    async fn failed_turn_rejects_parked_prompt() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let session_id = new_session(&mut conn).await;
        conn.sessions.get_mut(&session_id).unwrap().pending_prompt = Some(PendingPrompt {
            rpc_id: json!(2),
            cancelled: false,
        });

        let payload = json!({
            "type": "session_ended",
            "sessionId": session_id,
            "error": "provider 500",
        });
        let out = conn.handle_event_payload(&payload).await;
        assert_eq!(out[0]["error"]["code"], rpc_error_code::INTERNAL_ERROR);
        assert_eq!(out[0]["error"]["message"], "provider 500");
    }

    #[tokio::test]
    async fn stream_deltas_forward_as_session_updates() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let session_id = new_session(&mut conn).await;

        let payload = json!({
            "type": "event",
            "sessionId": session_id,
            "event": {
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": { "type": "text_delta", "text": "hi" },
                },
            },
        });
        let out = conn.handle_event_payload(&payload).await;
        assert_eq!(out[0]["method"], "session/update");
        assert_eq!(out[0]["params"]["sessionId"], session_id);
        assert_eq!(
            out[0]["params"]["update"]["sessionUpdate"],
            "agent_message_chunk"
        );
    }

    #[tokio::test]
    async fn frames_for_unknown_sessions_are_ignored() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let payload = json!({
            "type": "event",
            "sessionId": "not-ours",
            "event": { "type": "result", "subtype": "success" },
        });
        assert!(conn.handle_event_payload(&payload).await.is_empty());
    }

    #[tokio::test]
    async fn permission_request_becomes_server_request_and_response_maps_back() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let session_id = new_session(&mut conn).await;

        let payload = json!({
            "type": "permission_request",
            "sessionId": session_id,
            "requestId": "req-9",
            "toolUseID": "toolu_9",
            "toolName": "Bash",
            "input": { "command": "ls" },
        });
        let out = conn.handle_event_payload(&payload).await;
        assert_eq!(out[0]["method"], "session/request_permission");
        let out_id = out[0]["id"].as_u64().unwrap();
        assert_eq!(out[0]["params"]["toolCall"]["toolCallId"], "toolu_9");
        assert!(conn.pending_permissions.contains_key(&out_id));

        // Client answers. Dispatch fails in test mode (no host), but the
        // pending entry must be consumed either way.
        let response = format!(
            r#"{{"jsonrpc":"2.0","id":{out_id},"result":{{"outcome":{{"outcome":"selected","optionId":"allow"}}}}}}"#
        );
        let out = conn.handle_message(&response).await;
        assert!(out.is_empty());
        assert!(!conn.pending_permissions.contains_key(&out_id));
    }

    #[tokio::test]
    async fn sdk_session_id_updates_resume_index() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let session_id = new_session(&mut conn).await;

        let payload = json!({
            "type": "sdk_session_id",
            "sessionId": session_id,
            "sdkSessionId": "sdk-321",
        });
        let out = conn.handle_event_payload(&payload).await;
        assert!(out.is_empty(), "sdk_session_id emits no client messages");
        assert_eq!(
            lookup_resume_info(&session_id).unwrap().sdk_session_id,
            Some("sdk-321".to_string())
        );
        assert_eq!(
            conn.sessions.get_mut(&session_id).unwrap().sdk_session_id,
            Some("sdk-321".to_string())
        );
    }

    #[tokio::test]
    async fn cleanup_clears_pending_prompts() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let session_id = new_session(&mut conn).await;
        {
            let entry = conn.sessions.get_mut(&session_id).unwrap();
            entry.prompted = true;
            entry.pending_prompt = Some(PendingPrompt {
                rpc_id: json!(2),
                cancelled: false,
            });
        }
        conn.cleanup().await;
        assert!(conn
            .sessions
            .get_mut(&session_id)
            .unwrap()
            .pending_prompt
            .is_none());
    }
}
