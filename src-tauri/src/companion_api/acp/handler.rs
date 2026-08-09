//! ACP server WebSocket handler — `GET /ws/acp`.
//!
//! Speaks the Agent Client Protocol (agentclientprotocol.com, JSON-RPC 2.0,
//! one message per WS text frame) and translates it onto the companion RPC
//! dispatch surface:
//!
//! | ACP method                      | binding                                   |
//! |---------------------------------|-------------------------------------------|
//! | `initialize`                    | static capabilities                        |
//! | `session/new`                   | mint UUID, stash cwd                       |
//! | `session/prompt`                | `remote_execution("claude_send", …)`; the |
//! |                                 | JSON-RPC result is deferred to turn end    |
//! | `session/cancel` (notification) | `remote_execution("claude_interrupt", …)` |
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
//! `/ws/events`) — every text frame on this socket must be a JSON-RPC
//! message or clients would choke on non-protocol frames.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::Response,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Component, Path};
use tokio::time::{interval, Duration, Instant};

use super::super::{
    event_bus::SubscribeResult,
    middleware::DeviceContext,
    remote_execution::{self, ExecutionOutcome, ExecutionRequest, ExecutionTransport},
    SharedState,
};
use super::registry::{
    list_catalog, lookup_catalog, lookup_resume_info, record_resume_info, remove_catalog,
    update_catalog, upsert_catalog, AcpCatalogEntry, ConnectionSessions, PendingPrompt, ResumeInfo,
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

fn normalize_workspace_path(path: &str) -> Result<String, &'static str> {
    let candidate = Path::new(path);
    if !candidate.is_absolute()
        || candidate
            .components()
            .any(|part| part == Component::ParentDir)
    {
        return Err("workspace paths must be absolute and traversal-free");
    }
    let normalized = candidate
        .canonicalize()
        .unwrap_or_else(|_| candidate.to_path_buf())
        .to_string_lossy()
        .into_owned();
    if !crate::files::is_remote_workspace_path_allowed(&normalized) {
        return Err("workspace path is outside the registered workspace roots");
    }
    Ok(normalized)
}

#[derive(Deserialize)]
pub struct AcpTicketQuery {
    ticket: String,
}

/// Axum handler for `GET /ws/acp`. The upgrade redeems the same durable,
/// path-bound, single-use socket-ticket authority as the event, terminal, and
/// browser channels; no bearer credential enters the WebSocket URL.
pub async fn acp_handler(
    Query(query): Query<AcpTicketQuery>,
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
) -> Response {
    let Some(store) = super::super::security_store::security_store() else {
        return super::super::api::public_error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "security_store_unavailable",
            "the security database is unavailable",
            true,
            json!({}),
        );
    };
    let identity =
        match store.redeem_socket_ticket(&query.ticket, "/ws/acp", "acp", unix_time_secs()) {
            Ok(identity) => identity,
            Err(_) => {
                return super::super::api::public_error_response(
                    StatusCode::UNAUTHORIZED,
                    "invalid_socket_ticket",
                    "the ACP socket ticket is invalid, expired, or already used",
                    false,
                    json!({}),
                );
            }
        };
    let capabilities = match store.capability_snapshot(&identity.tenant_id, &identity.device_id) {
        Ok(Some(capabilities)) => capabilities,
        Ok(None) => {
            return super::super::api::public_error_response(
                StatusCode::UNAUTHORIZED,
                "device_unavailable",
                "the ACP principal is unknown or revoked",
                false,
                json!({}),
            );
        }
        Err(_) => {
            return super::super::api::public_error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "security_store_unavailable",
                "the security database is unavailable",
                true,
                json!({}),
            );
        }
    };
    let workspace_scope = format!("device:{}", identity.device_id);

    ws.max_message_size(MAX_WS_FRAME_BYTES)
        .max_frame_size(MAX_WS_FRAME_BYTES)
        .on_upgrade(move |socket| {
            handle_acp_socket(
                socket,
                state,
                identity.device_id,
                Some(identity.tenant_id),
                Some(workspace_scope),
                Some(capabilities),
            )
        })
}

/// Everything one ACP connection needs to service requests.
struct AcpConnection {
    state: SharedState,
    device_id: String,
    account_id: Option<String>,
    scope: Option<String>,
    authorization_capabilities: Option<Vec<String>>,
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
        authorization_capabilities: Option<Vec<String>>,
    ) -> Self {
        Self {
            state,
            device_id,
            account_id,
            scope,
            authorization_capabilities,
            sessions: ConnectionSessions::new(),
            initialized: false,
            next_out_id: 1,
            pending_permissions: HashMap::new(),
        }
    }

    /// Run one companion RPC through the shared dispatch surface, flattening
    /// the error into a plain message string.
    async fn dispatch(&self, name: &str, args: Value) -> Result<Value, String> {
        self.dispatch_with_request_id(name, args, None).await
    }

    async fn dispatch_with_request_id(
        &self,
        name: &str,
        args: Value,
        wire_request_id: Option<&Value>,
    ) -> Result<Value, String> {
        let principal = DeviceContext {
            device_id: self.device_id.clone(),
            account_id: self.account_id.clone().unwrap_or_default(),
            scope: "device".to_string(),
            granted_scopes: Vec::new(),
            authorization_capabilities: self.authorization_capabilities.clone(),
        };
        let idempotency_key =
            remote_execution::protocol_idempotency_key(name, &principal, "acp", wire_request_id);
        let request = ExecutionRequest::new(
            name,
            args,
            principal,
            ExecutionTransport::WebSocket,
            idempotency_key,
        );
        match remote_execution::execute(&self.state, request).await {
            Ok(ExecutionOutcome::Completed { result, .. }) => Ok(result),
            Ok(ExecutionOutcome::Accepted { operation_id, .. }) => {
                Ok(json!({ "operationId": operation_id, "status": "running" }))
            }
            Err(error) => Err(error.message),
        }
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
            return self.handle_notification(&method, &params).await;
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
            "session/new" => self.handle_session_new(id, params).await,
            "session/load" => self.handle_session_load(id, params).await,
            "session/list" => self.handle_session_list(id, params).await,
            "session/resume" => self.handle_session_resume(id, params).await,
            "session/close" => self.handle_session_close(id, params).await,
            "session/delete" => self.handle_session_delete(id, params).await,
            "session/set_mode" => self.handle_session_set_mode(id, params).await,
            "session/set_config_option" => self.handle_session_set_config_option(id, params).await,
            "session/set_model" => self.handle_session_set_model(id, params).await,
            "session/prompt" => self.handle_session_prompt(id, params).await,
            "authenticate" => vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                "Cognia ACP uses transport authentication and advertises no protocol auth methods",
            )],
            "logout" => vec![types::rpc_response(id, json!({}))],
            _ => vec![types::rpc_error(
                id,
                rpc_error_code::METHOD_NOT_FOUND,
                &format!("method \"{method}\" is not supported"),
            )],
        }
    }

    async fn handle_session_new(&mut self, id: &Value, params: &Value) -> Vec<Value> {
        let Some(cwd) = params.get("cwd").and_then(Value::as_str) else {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                "session/new requires `cwd`",
            )];
        };
        let cwd = match normalize_workspace_path(cwd) {
            Ok(cwd) => cwd,
            Err(message) => {
                return vec![types::rpc_error(
                    id,
                    rpc_error_code::INVALID_PARAMS,
                    message,
                )]
            }
        };
        let additional_directories = match params.get("additionalDirectories") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(paths)) => {
                let mut normalized = Vec::with_capacity(paths.len());
                for path in paths {
                    let Some(path) = path.as_str() else {
                        return vec![types::rpc_error(
                            id,
                            rpc_error_code::INVALID_PARAMS,
                            "additionalDirectories must contain only paths",
                        )];
                    };
                    match normalize_workspace_path(path) {
                        Ok(path) => normalized.push(path),
                        Err(message) => {
                            return vec![types::rpc_error(
                                id,
                                rpc_error_code::INVALID_PARAMS,
                                message,
                            )]
                        }
                    }
                }
                normalized
            }
            Some(_) => {
                return vec![types::rpc_error(
                    id,
                    rpc_error_code::INVALID_PARAMS,
                    "additionalDirectories must be an array",
                )]
            }
        };
        let session_id = uuid::Uuid::new_v4().to_string();
        let entry = SessionEntry {
            cwd: Some(cwd.clone()),
            additional_directories: additional_directories.clone(),
            ..Default::default()
        };
        self.sessions.insert(&session_id, entry);
        record_resume_info(
            &session_id,
            ResumeInfo {
                cwd: Some(cwd.clone()),
                sdk_session_id: None,
            },
        );
        let now = chrono::Utc::now().to_rfc3339();
        if let Err(error) = upsert_catalog(AcpCatalogEntry {
            session_id: session_id.clone(),
            sdk_session_id: None,
            cwd,
            additional_directories,
            title: None,
            created_at: now.clone(),
            updated_at: now,
            selected_mode_id: None,
            selected_model_id: None,
            lifecycle: "active".to_string(),
            account_id: self.account_id.clone(),
            workspace_scope: self.scope.clone(),
        })
        .await
        {
            self.sessions.remove(&session_id);
            return vec![types::rpc_error(id, rpc_error_code::INTERNAL_ERROR, &error)];
        }
        vec![types::rpc_response(
            id,
            types::session_new_result(&session_id),
        )]
    }

    async fn handle_session_set_mode(&mut self, id: &Value, params: &Value) -> Vec<Value> {
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
        let mode_id = mode_id.to_string();
        if let Err(error) = update_catalog(
            session_id.to_string(),
            self.account_id.clone(),
            self.scope.clone(),
            {
                let mode_id = mode_id.clone();
                move |catalog| catalog.selected_mode_id = Some(mode_id)
            },
        )
        .await
        {
            return vec![types::rpc_error(id, rpc_error_code::INTERNAL_ERROR, &error)];
        }
        entry.selected_mode_id = Some(mode_id);
        vec![types::rpc_response(id, Value::Null)]
    }

    async fn handle_session_set_config_option(&mut self, id: &Value, params: &Value) -> Vec<Value> {
        let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                "session/set_config_option requires `sessionId`",
            )];
        };
        let Some(config_id) = params.get("configId").and_then(Value::as_str) else {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                "session/set_config_option requires `configId`",
            )];
        };
        if config_id != "model" {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                &format!("unknown config option \"{config_id}\""),
            )];
        }
        let Some(model_id) = params.get("value").and_then(Value::as_str) else {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                "model config value must be a string",
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
        let model_id = model_id.to_string();
        if let Err(error) = update_catalog(
            session_id.to_string(),
            self.account_id.clone(),
            self.scope.clone(),
            {
                let model_id = model_id.clone();
                move |catalog| catalog.selected_model_id = Some(model_id)
            },
        )
        .await
        {
            return vec![types::rpc_error(id, rpc_error_code::INTERNAL_ERROR, &error)];
        }
        entry.selected_model_id = Some(model_id.clone());
        vec![types::rpc_response(
            id,
            json!({ "configOptions": types::session_config_options(&model_id) }),
        )]
    }

    async fn handle_session_set_model(&mut self, id: &Value, params: &Value) -> Vec<Value> {
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
        let model_id = model_id.to_string();
        if let Err(error) = update_catalog(
            session_id.to_string(),
            self.account_id.clone(),
            self.scope.clone(),
            {
                let model_id = model_id.clone();
                move |catalog| catalog.selected_model_id = Some(model_id)
            },
        )
        .await
        {
            return vec![types::rpc_error(id, rpc_error_code::INTERNAL_ERROR, &error)];
        }
        entry.selected_model_id = Some(model_id);
        vec![types::rpc_response(id, Value::Null)]
    }

    async fn handle_session_list(&self, id: &Value, params: &Value) -> Vec<Value> {
        let cursor = match params.get("cursor") {
            None | Some(Value::Null) => 0,
            Some(Value::String(cursor)) => match cursor.parse::<usize>() {
                Ok(cursor) => cursor,
                Err(_) => {
                    return vec![types::rpc_error(
                        id,
                        rpc_error_code::INVALID_PARAMS,
                        "invalid session cursor",
                    )]
                }
            },
            Some(_) => {
                return vec![types::rpc_error(
                    id,
                    rpc_error_code::INVALID_PARAMS,
                    "invalid session cursor",
                )]
            }
        };
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string);
        let (sessions, next) = match list_catalog(
            self.account_id.clone(),
            self.scope.clone(),
            cwd,
            cursor,
            50,
        )
        .await
        {
            Ok(page) => page,
            Err(error) => {
                return vec![types::rpc_error(id, rpc_error_code::INTERNAL_ERROR, &error)]
            }
        };
        let sessions: Vec<Value> = sessions
            .into_iter()
            .map(|entry| {
                json!({
                    "sessionId": entry.session_id,
                    "cwd": entry.cwd,
                    "additionalDirectories": entry.additional_directories,
                    "title": entry.title,
                    "createdAt": entry.created_at,
                    "updatedAt": entry.updated_at,
                })
            })
            .collect();
        vec![types::rpc_response(
            id,
            json!({
                "sessions": sessions,
                "nextCursor": next.map(|next| next.to_string()),
            }),
        )]
    }

    async fn restore_catalog_session(&mut self, id: &Value, params: &Value) -> Vec<Value> {
        let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                "session lifecycle request requires `sessionId`",
            )];
        };
        if self.sessions.contains(session_id) {
            let entry = self.sessions.get_mut(session_id).unwrap();
            return vec![types::rpc_response(
                id,
                types::session_state_result(
                    entry
                        .selected_mode_id
                        .as_deref()
                        .unwrap_or(types::DEFAULT_MODE_ID),
                    entry
                        .selected_model_id
                        .as_deref()
                        .unwrap_or(types::DEFAULT_MODEL_ID),
                ),
            )];
        }
        let legacy_resume = lookup_resume_info(session_id);
        let catalog = match lookup_catalog(
            session_id.to_string(),
            self.account_id.clone(),
            self.scope.clone(),
        )
        .await
        {
            Err(error) => {
                return vec![types::rpc_error(id, rpc_error_code::INTERNAL_ERROR, &error)]
            }
            Ok(Some(catalog)) => catalog,
            // Pre-catalog compatibility is limited to unauthenticated test
            // connections. Production connections never consult unscoped rows.
            Ok(None) if self.account_id.is_none() => {
                let Some(info) = legacy_resume.clone() else {
                    return vec![types::rpc_error(
                        id,
                        rpc_error_code::INVALID_PARAMS,
                        &format!("unknown session \"{session_id}\""),
                    )];
                };
                let now = chrono::Utc::now().to_rfc3339();
                AcpCatalogEntry {
                    session_id: session_id.to_string(),
                    sdk_session_id: info.sdk_session_id,
                    cwd: params
                        .get("cwd")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or(info.cwd)
                        .unwrap_or_else(|| "/".to_string()),
                    additional_directories: Vec::new(),
                    title: None,
                    created_at: now.clone(),
                    updated_at: now,
                    selected_mode_id: None,
                    selected_model_id: None,
                    lifecycle: "active".to_string(),
                    account_id: None,
                    workspace_scope: self.scope.clone(),
                }
            }
            Ok(None) => {
                return vec![types::rpc_error(
                    id,
                    rpc_error_code::INVALID_PARAMS,
                    &format!("unknown session \"{session_id}\""),
                )]
            }
        };
        let resume = legacy_resume
            .and_then(|info| info.sdk_session_id)
            .or_else(|| catalog.sdk_session_id.clone());
        let selected_model_id = catalog.selected_model_id.clone();
        let selected_mode_id = catalog.selected_mode_id.clone();
        self.sessions.insert(
            session_id,
            SessionEntry {
                cwd: Some(catalog.cwd),
                additional_directories: catalog.additional_directories,
                sdk_session_id: resume.clone(),
                resume_session_id: resume,
                selected_mode_id: selected_mode_id.clone(),
                selected_model_id: selected_model_id.clone(),
                ..Default::default()
            },
        );
        if let Err(error) = update_catalog(
            session_id.to_string(),
            self.account_id.clone(),
            self.scope.clone(),
            |entry| entry.lifecycle = "active".to_string(),
        )
        .await
        {
            self.sessions.remove(session_id);
            return vec![types::rpc_error(id, rpc_error_code::INTERNAL_ERROR, &error)];
        }
        vec![types::rpc_response(
            id,
            types::session_state_result(
                selected_mode_id
                    .as_deref()
                    .unwrap_or(types::DEFAULT_MODE_ID),
                selected_model_id
                    .as_deref()
                    .unwrap_or(types::DEFAULT_MODEL_ID),
            ),
        )]
    }

    async fn handle_session_resume(&mut self, id: &Value, params: &Value) -> Vec<Value> {
        self.restore_catalog_session(id, params).await
    }

    async fn handle_session_close(&mut self, id: &Value, params: &Value) -> Vec<Value> {
        let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                "session/close requires `sessionId`",
            )];
        };
        let Some(entry) = self.sessions.remove(session_id) else {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                &format!("unknown session \"{session_id}\""),
            )];
        };
        let mut messages = Vec::new();
        if let Some(pending) = entry.pending_prompt {
            let _ = self
                .dispatch("claude_interrupt", json!({ "session_id": session_id }))
                .await;
            messages.push(types::rpc_error(
                &pending.rpc_id,
                rpc_error_code::REQUEST_CANCELLED,
                "request cancelled because the session was closed",
            ));
        }
        if let Err(error) = update_catalog(
            session_id.to_string(),
            self.account_id.clone(),
            self.scope.clone(),
            |catalog| catalog.lifecycle = "closed".to_string(),
        )
        .await
        {
            messages.push(types::rpc_error(id, rpc_error_code::INTERNAL_ERROR, &error));
            return messages;
        }
        messages.push(types::rpc_response(id, json!({})));
        messages
    }

    async fn handle_session_delete(&mut self, id: &Value, params: &Value) -> Vec<Value> {
        let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                "session/delete requires `sessionId`",
            )];
        };
        let catalog = match lookup_catalog(
            session_id.to_string(),
            self.account_id.clone(),
            self.scope.clone(),
        )
        .await
        {
            Ok(catalog) => catalog,
            Err(error) => {
                return vec![types::rpc_error(id, rpc_error_code::INTERNAL_ERROR, &error)]
            }
        };
        if catalog.is_none() {
            return vec![types::rpc_error(
                id,
                rpc_error_code::INVALID_PARAMS,
                &format!("unknown session \"{session_id}\""),
            )];
        }
        let pending = self
            .sessions
            .remove(session_id)
            .and_then(|entry| entry.pending_prompt);
        let mut messages = Vec::new();
        if let Some(pending) = pending {
            messages.push(types::rpc_error(
                &pending.rpc_id,
                rpc_error_code::REQUEST_CANCELLED,
                "request cancelled because the session was deleted",
            ));
        }
        let _ = self
            .dispatch("claude_close_session", json!({ "session_id": session_id }))
            .await;
        if let Err(error) = remove_catalog(
            session_id.to_string(),
            self.account_id.clone(),
            self.scope.clone(),
        )
        .await
        {
            messages.push(types::rpc_error(id, rpc_error_code::INTERNAL_ERROR, &error));
            return messages;
        }
        messages.push(types::rpc_response(id, json!({})));
        messages
    }

    async fn handle_session_load(&mut self, id: &Value, params: &Value) -> Vec<Value> {
        self.restore_catalog_session(id, params).await
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
        let (cwd, additional_directories, resume_session_id, selected_mode_id, selected_model_id) = {
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
                entry.additional_directories.clone(),
                entry.resume_session_id.take(),
                entry.selected_mode_id.clone(),
                entry.selected_model_id.clone(),
            )
        };

        let mut options = serde_json::Map::new();
        if let Some(cwd) = cwd {
            options.insert("cwd".to_string(), json!(cwd));
        }
        if !additional_directories.is_empty() {
            options.insert(
                "additionalDirectories".to_string(),
                json!(additional_directories),
            );
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
        if let Err(message) = self
            .dispatch_with_request_id("claude_send", args, Some(id))
            .await
        {
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

    async fn handle_notification(&mut self, method: &str, params: &Value) -> Vec<Value> {
        if method == "$/cancel_request" {
            return self.handle_request_cancellation(params).await;
        }
        if method != "session/cancel" {
            return Vec::new();
        }
        let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
            return Vec::new();
        };
        let session_id = session_id.to_string();
        if let Some(entry) = self.sessions.get_mut(&session_id) {
            if let Some(pending) = entry.pending_prompt.as_mut() {
                pending.cancelled = true;
            }
        } else {
            return Vec::new();
        }
        if let Err(message) = self
            .dispatch("claude_interrupt", json!({ "session_id": session_id }))
            .await
        {
            log::warn!("companion-api acp: claude_interrupt failed: {message}");
        }
        Vec::new()
    }

    async fn handle_request_cancellation(&mut self, params: &Value) -> Vec<Value> {
        let Some(request_id) = params.get("requestId") else {
            return Vec::new();
        };

        let mut cancelled_prompt = None;
        for (session_id, entry) in self.sessions.iter_mut() {
            let matches = entry
                .pending_prompt
                .as_ref()
                .is_some_and(|pending| pending.rpc_id == *request_id);
            if matches {
                cancelled_prompt = entry
                    .pending_prompt
                    .take()
                    .map(|pending| (session_id.clone(), pending.rpc_id));
                break;
            }
        }
        if let Some((session_id, rpc_id)) = cancelled_prompt {
            if let Err(message) = self
                .dispatch("claude_interrupt", json!({ "session_id": session_id }))
                .await
            {
                log::warn!("companion-api acp: request cancellation interrupt failed: {message}");
            }
            return vec![types::rpc_error(
                &rpc_id,
                rpc_error_code::REQUEST_CANCELLED,
                "Request cancelled",
            )];
        }

        let Some(out_id) = as_response_id(request_id) else {
            return Vec::new();
        };
        let Some((session_id, sidecar_request_id)) = self.pending_permissions.remove(&out_id)
        else {
            return Vec::new();
        };
        if let Err(message) = self
            .dispatch(
                "claude_approve",
                json!({
                    "session_id": session_id,
                    "request_id": sidecar_request_id,
                    "decision": "deny",
                }),
            )
            .await
        {
            log::warn!("companion-api acp: cancelled permission denial failed: {message}");
        }
        Vec::new()
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
                            sdk_session_id: Some(sdk_id.clone()),
                        },
                    );
                    if let Err(error) = update_catalog(
                        session_id.clone(),
                        self.account_id.clone(),
                        self.scope.clone(),
                        move |catalog| catalog.sdk_session_id = Some(sdk_id),
                    )
                    .await
                    {
                        log::warn!("ACP catalog SDK session update failed: {error}");
                    }
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
    authorization_capabilities: Option<Vec<String>>,
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

    let mut conn = AcpConnection::new(
        state,
        device_id,
        account_id,
        scope,
        authorization_capabilities,
    );

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

fn unix_time_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
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

    fn test_conn() -> AcpConnection {
        AcpConnection::new(
            test_state(),
            "dev-1".to_string(),
            None,
            Some("device".into()),
            Some(vec!["agent.run".into()]),
        )
    }

    fn scoped_test_conn(account_id: &str, workspace: &str) -> AcpConnection {
        AcpConnection::new(
            test_state(),
            format!("device-{account_id}"),
            Some(account_id.to_string()),
            Some(workspace.to_string()),
            Some(vec!["agent.run".into()]),
        )
    }

    async fn initialize(conn: &mut AcpConnection) {
        let out = conn
            .handle_message(r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}"#)
            .await;
        assert_eq!(out[0]["result"]["protocolVersion"], 1);
    }

    async fn new_session(conn: &mut AcpConnection) -> String {
        let cwd = std::env::current_dir()
            .expect("current dir")
            .to_string_lossy()
            .to_string();
        crate::files::set_allowed_roots(vec![cwd.clone()]);
        let message = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "session/new",
            "params": { "cwd": cwd },
        })
        .to_string();
        let out = conn.handle_message(&message).await;
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
    async fn session_new_mints_id_and_tracks_cwd() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let session_id = new_session(&mut conn).await;
        assert!(conn.sessions.contains(&session_id));
        let cwd = conn.sessions.get_mut(&session_id).unwrap().cwd.clone();
        assert_eq!(
            cwd,
            Some(
                std::env::current_dir()
                    .expect("current dir")
                    .to_string_lossy()
                    .to_string()
            )
        );
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
        let cwd = std::env::current_dir()
            .expect("current dir")
            .to_string_lossy()
            .to_string();
        crate::files::set_allowed_roots(vec![cwd.clone()]);
        let out = conn
            .handle_message(
                &json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "session/new",
                    "params": { "cwd": cwd },
                })
                .to_string(),
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

    #[tokio::test]
    async fn stable_set_config_option_updates_model_and_returns_full_options() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let session_id = new_session(&mut conn).await;
        let msg = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"session/set_config_option","params":{{"sessionId":"{session_id}","configId":"model","value":"claude-opus-4-8"}}}}"#
        );
        let out = conn.handle_message(&msg).await;
        assert_eq!(
            out[0]["result"]["configOptions"][0]["currentValue"],
            "claude-opus-4-8"
        );
        assert_eq!(
            conn.sessions
                .get_mut(&session_id)
                .unwrap()
                .selected_model_id,
            Some("claude-opus-4-8".to_string())
        );
    }

    #[tokio::test]
    async fn stable_list_close_resume_and_delete_lifecycle() {
        super::super::registry::reset_catalog_for_tests();
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let session_id = new_session(&mut conn).await;

        let listed = conn
            .handle_message(r#"{"jsonrpc":"2.0","id":2,"method":"session/list","params":{}}"#)
            .await;
        assert!(listed[0]["result"]["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|session| session["sessionId"] == session_id));

        let close = format!(
            r#"{{"jsonrpc":"2.0","id":3,"method":"session/close","params":{{"sessionId":"{session_id}"}}}}"#
        );
        let closed = conn.handle_message(&close).await;
        assert!(closed[0]["result"].is_object());
        assert!(!conn.sessions.contains(&session_id));

        let resume = format!(
            r#"{{"jsonrpc":"2.0","id":4,"method":"session/resume","params":{{"sessionId":"{session_id}"}}}}"#
        );
        let resumed = conn.handle_message(&resume).await;
        assert_eq!(
            resumed[0]["result"]["configOptions"][0]["category"],
            "model_config"
        );
        assert!(conn.sessions.contains(&session_id));

        let delete = format!(
            r#"{{"jsonrpc":"2.0","id":5,"method":"session/delete","params":{{"sessionId":"{session_id}"}}}}"#
        );
        let deleted = conn.handle_message(&delete).await;
        assert!(deleted[0]["result"].is_object());
        let listed = conn
            .handle_message(r#"{"jsonrpc":"2.0","id":6,"method":"session/list","params":{}}"#)
            .await;
        assert!(!listed[0]["result"]["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|session| session["sessionId"] == session_id));
    }

    #[tokio::test]
    async fn close_settles_the_parked_prompt_as_request_cancelled() {
        super::super::registry::reset_catalog_for_tests();
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let session_id = new_session(&mut conn).await;
        conn.sessions.get_mut(&session_id).unwrap().pending_prompt = Some(PendingPrompt {
            rpc_id: json!(41),
            cancelled: false,
        });

        let closed = conn
            .handle_message(
                &json!({
                    "jsonrpc": "2.0",
                    "id": 42,
                    "method": "session/close",
                    "params": { "sessionId": session_id },
                })
                .to_string(),
            )
            .await;

        assert_eq!(closed.len(), 2);
        assert_eq!(closed[0]["id"], 41);
        assert_eq!(
            closed[0]["error"]["code"],
            rpc_error_code::REQUEST_CANCELLED
        );
        assert_eq!(closed[1]["id"], 42);
        assert!(closed[1]["result"].is_object());
    }

    #[tokio::test]
    async fn delete_settles_the_parked_prompt_as_request_cancelled() {
        super::super::registry::reset_catalog_for_tests();
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let session_id = new_session(&mut conn).await;
        conn.sessions.get_mut(&session_id).unwrap().pending_prompt = Some(PendingPrompt {
            rpc_id: json!(51),
            cancelled: false,
        });

        let deleted = conn
            .handle_message(
                &json!({
                    "jsonrpc": "2.0",
                    "id": 52,
                    "method": "session/delete",
                    "params": { "sessionId": session_id },
                })
                .to_string(),
            )
            .await;

        assert_eq!(deleted.len(), 2);
        assert_eq!(deleted[0]["id"], 51);
        assert_eq!(
            deleted[0]["error"]["code"],
            rpc_error_code::REQUEST_CANCELLED
        );
        assert_eq!(deleted[1]["id"], 52);
        assert!(deleted[1]["result"].is_object());
    }

    #[tokio::test]
    async fn session_catalog_never_crosses_account_or_workspace_scope() {
        let mut owner = scoped_test_conn("account-owner", "workspace-a");
        initialize(&mut owner).await;
        let session_id = new_session(&mut owner).await;

        let mut other_account = scoped_test_conn("account-other", "workspace-a");
        initialize(&mut other_account).await;
        let listed = other_account
            .handle_message(
                r#"{"jsonrpc":"2.0","id":2,"method":"session/list","params":{"cwd":"/repo"}}"#,
            )
            .await;
        assert!(!listed[0]["result"]["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|session| session["sessionId"] == session_id));
        let resume = format!(
            r#"{{"jsonrpc":"2.0","id":3,"method":"session/resume","params":{{"sessionId":"{session_id}"}}}}"#
        );
        let denied = other_account.handle_message(&resume).await;
        assert_eq!(denied[0]["error"]["code"], rpc_error_code::INVALID_PARAMS);

        let mut other_workspace = scoped_test_conn("account-owner", "workspace-b");
        initialize(&mut other_workspace).await;
        let denied = other_workspace.handle_message(&resume).await;
        assert_eq!(denied[0]["error"]["code"], rpc_error_code::INVALID_PARAMS);
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
    async fn request_cancellation_interrupts_matching_prompt_and_returns_minus_32800() {
        let mut conn = test_conn();
        initialize(&mut conn).await;
        let session_id = new_session(&mut conn).await;
        conn.sessions.get_mut(&session_id).unwrap().pending_prompt = Some(PendingPrompt {
            rpc_id: json!(42),
            cancelled: false,
        });
        let out = conn
            .handle_message(
                r#"{"jsonrpc":"2.0","method":"$/cancel_request","params":{"requestId":42}}"#,
            )
            .await;

        assert_eq!(out[0]["id"], 42);
        assert_eq!(out[0]["error"]["code"], rpc_error_code::REQUEST_CANCELLED);
        assert!(conn
            .sessions
            .get_mut(&session_id)
            .unwrap()
            .pending_prompt
            .is_none());
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
        let _guard = super::super::registry::resume_test_lock();
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
