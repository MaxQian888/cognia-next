//! Desktop-message-mutation bridge between the Rust HTTP server and the
//! desktop webview (Phase 2 of the mobile completeness plan, mirrors
//! [`super::sync_bridge`]).
//!
//! The phone hits `POST /api/v1/_rpc/message_update`, `_rpc/message_delete`,
//! or `_rpc/session_list` against the desktop's Rust server, but the
//! authoritative Dexie store lives in the WebView. So when the Rust handler
//! runs, it has to ask the WebView "apply this mutation / give me this
//! page", await the response, and forward it to the phone.
//!
//! # Wire protocol
//!
//! 1. Rust: emit one of three Tauri events
//!    - `companion://message-update-request` with `{ request_id, kind:
//!      "update", session_id, message_id, updates }`,
//!    - `companion://message-delete-request` with `{ request_id, kind:
//!      "delete", session_id, message_id }`,
//!    - `companion://session-list-request` with `{ request_id, kind:
//!      "session_list", limit, offset, before? }`.
//! 2. TS (`lib/companion/desktop-message-source.ts`): listen for the event,
//!    run the matching `messageRepository` / Dexie call, then invoke the
//!    Tauri command `companion_message_response` with `{ request_id,
//!    result?, error? }`.
//! 3. Rust: command resolves the matching oneshot, the HTTP handler
//!    completes with the result in its response body.
//!
//! Default timeout is 30 seconds — same as `sync_bridge` — so a slow
//! Dexie write doesn't strand the phone.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use uuid::Uuid;

const UPDATE_EVENT: &str = "companion://message-update-request";
const DELETE_EVENT: &str = "companion://message-delete-request";
const LIST_EVENT: &str = "companion://session-list-request";
const GET_BY_SESSION_EVENT: &str = "companion://message-get-by-session-request";
const SEND_EVENT: &str = "companion://message-send-request";
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Payload emitted to the WebView for a `message_update` RPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageUpdateRequest {
    pub request_id: String,
    pub kind: &'static str,
    pub session_id: String,
    pub message_id: String,
    pub updates: Value,
}

/// Payload emitted to the WebView for a `message_delete` RPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDeleteRequest {
    pub request_id: String,
    pub kind: &'static str,
    pub session_id: String,
    pub message_id: String,
}

/// Payload emitted to the WebView for a `session_list` RPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListRequest {
    pub request_id: String,
    pub kind: &'static str,
    pub limit: u32,
    pub offset: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<i64>,
}

/// Payload emitted to the WebView for a `message_get_by_session` RPC (Phase A1).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetMessagesRequest {
    pub request_id: String,
    pub kind: &'static str,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
}

/// Payload emitted to the WebView for a `message_send` RPC (Phase A2).
/// The TS-side handler writes a user message into the session via
/// `messageRepository.addMessage` and returns the new message id. AI reply
/// arrives asynchronously via the existing sidecar pipeline when the
/// desktop has the session open; otherwise the message sits until the
/// next session resume. See `lib/companion/desktop-message-source.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageRequest {
    pub request_id: String,
    pub kind: &'static str,
    pub session_id: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

/// Generic response from the WebView. The TS-side handler always sets
/// `result` for success and leaves `error` for failure (or vice-versa);
/// both being `None` is a malformed bridge state and is reported as an
/// error.
#[derive(Debug, Clone, Deserialize)]
pub struct MessageBridgeResponse {
    pub request_id: String,
    pub result: Option<Value>,
    pub error: Option<String>,
}

/// In-memory pool of pending requests. Each Rust HTTP handler registers a
/// oneshot receiver under its request_id, then awaits.
pub struct DesktopMessagesBridge {
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
}

impl DesktopMessagesBridge {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            pending: Mutex::new(HashMap::new()),
        })
    }

    /// Run a `message_update` round-trip through the bridge.
    pub async fn update_message(
        self: Arc<Self>,
        app: &AppHandle,
        session_id: String,
        message_id: String,
        updates: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (request_id, rx) = self.register();
        let payload = MessageUpdateRequest {
            request_id: request_id.clone(),
            kind: "update",
            session_id,
            message_id,
            updates,
        };
        if let Err(err) = app.emit(UPDATE_EVENT, payload) {
            self.pending.lock().remove(&request_id);
            return Err(format!("failed to emit message-update-request: {err}"));
        }
        self.await_response(request_id, rx, timeout).await
    }

    /// Run a `message_delete` round-trip through the bridge.
    pub async fn delete_message(
        self: Arc<Self>,
        app: &AppHandle,
        session_id: String,
        message_id: String,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (request_id, rx) = self.register();
        let payload = MessageDeleteRequest {
            request_id: request_id.clone(),
            kind: "delete",
            session_id,
            message_id,
        };
        if let Err(err) = app.emit(DELETE_EVENT, payload) {
            self.pending.lock().remove(&request_id);
            return Err(format!("failed to emit message-delete-request: {err}"));
        }
        self.await_response(request_id, rx, timeout).await
    }

    /// Run a `session_list` round-trip through the bridge.
    pub async fn list_sessions(
        self: Arc<Self>,
        app: &AppHandle,
        limit: u32,
        offset: u32,
        before: Option<i64>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (request_id, rx) = self.register();
        let payload = SessionListRequest {
            request_id: request_id.clone(),
            kind: "session_list",
            limit,
            offset,
            before,
        };
        if let Err(err) = app.emit(LIST_EVENT, payload) {
            self.pending.lock().remove(&request_id);
            return Err(format!("failed to emit session-list-request: {err}"));
        }
        self.await_response(request_id, rx, timeout).await
    }

    /// Run a `message_get_by_session` round-trip through the bridge (Phase A1).
    pub async fn get_messages_by_session(
        self: Arc<Self>,
        app: &AppHandle,
        session_id: String,
        limit: Option<u32>,
        offset: Option<u32>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (request_id, rx) = self.register();
        let payload = GetMessagesRequest {
            request_id: request_id.clone(),
            kind: "message_get_by_session",
            session_id,
            limit,
            offset,
        };
        if let Err(err) = app.emit(GET_BY_SESSION_EVENT, payload) {
            self.pending.lock().remove(&request_id);
            return Err(format!("failed to emit message-get-by-session-request: {err}"));
        }
        self.await_response(request_id, rx, timeout).await
    }

    /// Run a `message_send` round-trip through the bridge (Phase A2).
    pub async fn send_message(
        self: Arc<Self>,
        app: &AppHandle,
        session_id: String,
        content: String,
        role: Option<String>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (request_id, rx) = self.register();
        let payload = SendMessageRequest {
            request_id: request_id.clone(),
            kind: "message_send",
            session_id,
            content,
            role,
        };
        if let Err(err) = app.emit(SEND_EVENT, payload) {
            self.pending.lock().remove(&request_id);
            return Err(format!("failed to emit message-send-request: {err}"));
        }
        self.await_response(request_id, rx, timeout).await
    }

    fn register(&self) -> (String, oneshot::Receiver<Result<Value, String>>) {
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        self.pending.lock().insert(request_id.clone(), tx);
        (request_id, rx)
    }

    async fn await_response(
        self: Arc<Self>,
        request_id: String,
        rx: oneshot::Receiver<Result<Value, String>>,
        timeout: Duration,
    ) -> Result<Value, String> {
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(err))) => Err(err),
            Ok(Err(_recv_err)) => {
                self.pending.lock().remove(&request_id);
                Err("desktop-message-response sender dropped before responding".to_string())
            }
            Err(_) => {
                self.pending.lock().remove(&request_id);
                Err(format!(
                    "desktop-message request timed out after {} ms",
                    timeout.as_millis()
                ))
            }
        }
    }

    /// Resolve a pending request from the WebView.  No-op if the request
    /// already timed out — the sender is gone, fire-and-forget.
    pub fn resolve(&self, response: MessageBridgeResponse) {
        let sender = {
            let mut pending = self.pending.lock();
            pending.remove(&response.request_id)
        };
        let Some(sender) = sender else {
            return;
        };
        let payload = match (response.result, response.error) {
            (Some(value), _) => Ok(value),
            (None, Some(err)) => Err(err),
            (None, None) => {
                Err("desktop-message-response had neither result nor error".to_string())
            }
        };
        let _ = sender.send(payload);
    }

    /// Test-only — number of in-flight requests.
    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        self.pending.lock().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn resolve_completes_a_pending_request() {
        let bridge = DesktopMessagesBridge::new();
        let request_id = "test-rid".to_string();
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        bridge.pending.lock().insert(request_id.clone(), tx);

        bridge.resolve(MessageBridgeResponse {
            request_id: request_id.clone(),
            result: Some(json!({"ok": true})),
            error: None,
        });

        assert_eq!(bridge.pending_count(), 0);
        let result = rx.await.unwrap();
        assert_eq!(result.unwrap(), json!({"ok": true}));
    }

    #[tokio::test]
    async fn resolve_propagates_error_field() {
        let bridge = DesktopMessagesBridge::new();
        let request_id = "rid-err".to_string();
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        bridge.pending.lock().insert(request_id.clone(), tx);

        bridge.resolve(MessageBridgeResponse {
            request_id,
            result: None,
            error: Some("dexie offline".to_string()),
        });

        let result = rx.await.unwrap();
        assert_eq!(result.unwrap_err(), "dexie offline");
    }

    #[test]
    fn resolve_for_unknown_request_id_is_noop() {
        let bridge = DesktopMessagesBridge::new();
        bridge.resolve(MessageBridgeResponse {
            request_id: "no-such-id".to_string(),
            result: Some(json!({})),
            error: None,
        });
        assert_eq!(bridge.pending_count(), 0);
    }

    #[tokio::test]
    async fn resolve_with_neither_result_nor_error_returns_a_generic_error() {
        let bridge = DesktopMessagesBridge::new();
        let request_id = "rid-malformed".to_string();
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        bridge.pending.lock().insert(request_id.clone(), tx);

        bridge.resolve(MessageBridgeResponse {
            request_id,
            result: None,
            error: None,
        });

        let result = rx.await.unwrap();
        let err = result.unwrap_err();
        assert!(err.contains("neither result nor error"));
    }

    #[tokio::test]
    async fn register_grows_pending_count() {
        let bridge = DesktopMessagesBridge::new();
        let (_id1, _rx1) = bridge.register();
        let (_id2, _rx2) = bridge.register();
        assert_eq!(bridge.pending_count(), 2);
    }
}
