//! Desktop-message-mutation bridge between the Rust HTTP server and the
//! desktop webview (Phase 2 of the mobile completeness plan, mirrors
//! [`super::sync_bridge`]).
//!
//! The phone hits `POST /api/_rpc/message_update`, `_rpc/message_delete`,
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
use tokio::sync::oneshot;
use uuid::Uuid;

use super::bridge_transport::{BridgeRequestGuard, BridgeTransport};

type PendingBridgeRequest = (
    String,
    oneshot::Receiver<Result<Value, String>>,
    BridgeRequestGuard,
);

/// Serialize a typed bridge payload and emit it, cleaning up the pending slot
/// on either serialization or transport failure. Shared by all five methods.
fn emit_or_cleanup<T: Serialize>(
    bridge: &DesktopMessagesBridge,
    transport: &dyn BridgeTransport,
    request_id: &str,
    event: &str,
    payload: T,
) -> Result<(), String> {
    let value = match serde_json::to_value(&payload) {
        Ok(v) => v,
        Err(err) => {
            bridge.pending.lock().remove(request_id);
            return Err(format!("failed to serialize {event}: {err}"));
        }
    };
    if let Err(err) = transport.emit(event, value) {
        bridge.pending.lock().remove(request_id);
        return Err(err);
    }
    Ok(())
}

const UPDATE_EVENT: &str = "companion://message-update-request";
const DELETE_EVENT: &str = "companion://message-delete-request";
const LIST_EVENT: &str = "companion://session-list-request";
const GET_BY_SESSION_EVENT: &str = "companion://message-get-by-session-request";
const SEND_EVENT: &str = "companion://message-send-request";
const TRANSCRIPT_CAPABILITIES_EVENT: &str = "companion://transcript-capabilities-request";
const SESSION_TIMELINE_EVENT: &str = "companion://session-timeline-request";
const SESSION_TURN_MESSAGES_EVENT: &str = "companion://session-turn-messages-request";
const SESSION_MEDIA_EVENT: &str = "companion://session-media-request";
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptCapabilitiesRequest {
    pub request_id: String,
    pub kind: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTimelineRequest {
    pub request_id: String,
    pub kind: &'static str,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTurnMessagesRequest {
    pub request_id: String,
    pub kind: &'static str,
    pub session_id: String,
    pub turn_key: String,
    pub revision: u64,
    pub detail_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMediaRequest {
    pub request_id: String,
    pub kind: &'static str,
    pub session_id: String,
    pub hash: String,
    pub variant: String,
}

#[derive(Debug, Clone)]
pub struct MediaBridgeResponse {
    pub request_id: String,
    pub bytes: Vec<u8>,
    pub media_type: String,
    pub etag: Option<String>,
    pub error: Option<String>,
}

/// Generic response from the WebView. The TS-side handler always sets
/// `result` for success and leaves `error` for failure (or vice-versa);
/// both being `None` is a malformed bridge state and is reported as an
/// error.
///
/// The alias accepts the camelCase key the TS side sends verbatim over the
/// headless bridge WS (`ws_bridge::route_respond`).
#[derive(Debug, Clone, Deserialize)]
pub struct MessageBridgeResponse {
    #[serde(alias = "requestId")]
    pub request_id: String,
    pub result: Option<Value>,
    pub error: Option<String>,
}

/// In-memory pool of pending requests. Each Rust HTTP handler registers a
/// oneshot receiver under its request_id, then awaits.
pub struct DesktopMessagesBridge {
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    pending_media: Mutex<HashMap<String, oneshot::Sender<Result<MediaBridgeResponse, String>>>>,
}

impl DesktopMessagesBridge {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            pending: Mutex::new(HashMap::new()),
            pending_media: Mutex::new(HashMap::new()),
        })
    }

    /// Run a `message_update` round-trip through the bridge.
    pub async fn update_message(
        self: Arc<Self>,
        transport: &dyn BridgeTransport,
        session_id: String,
        message_id: String,
        updates: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (request_id, rx, request_guard) = self.register(transport)?;
        let payload = MessageUpdateRequest {
            request_id: request_id.clone(),
            kind: "update",
            session_id,
            message_id,
            updates,
        };
        emit_or_cleanup(&self, transport, &request_id, UPDATE_EVENT, payload)?;
        self.await_response(request_id, rx, timeout, request_guard)
            .await
    }

    /// Run a `message_delete` round-trip through the bridge.
    pub async fn delete_message(
        self: Arc<Self>,
        transport: &dyn BridgeTransport,
        session_id: String,
        message_id: String,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (request_id, rx, request_guard) = self.register(transport)?;
        let payload = MessageDeleteRequest {
            request_id: request_id.clone(),
            kind: "delete",
            session_id,
            message_id,
        };
        emit_or_cleanup(&self, transport, &request_id, DELETE_EVENT, payload)?;
        self.await_response(request_id, rx, timeout, request_guard)
            .await
    }

    /// Run a `session_list` round-trip through the bridge.
    pub async fn list_sessions(
        self: Arc<Self>,
        transport: &dyn BridgeTransport,
        limit: u32,
        offset: u32,
        before: Option<i64>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (request_id, rx, request_guard) = self.register(transport)?;
        let payload = SessionListRequest {
            request_id: request_id.clone(),
            kind: "session_list",
            limit,
            offset,
            before,
        };
        emit_or_cleanup(&self, transport, &request_id, LIST_EVENT, payload)?;
        self.await_response(request_id, rx, timeout, request_guard)
            .await
    }

    /// Run a `message_get_by_session` round-trip through the bridge (Phase A1).
    pub async fn get_messages_by_session(
        self: Arc<Self>,
        transport: &dyn BridgeTransport,
        session_id: String,
        limit: Option<u32>,
        offset: Option<u32>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (request_id, rx, request_guard) = self.register(transport)?;
        let payload = GetMessagesRequest {
            request_id: request_id.clone(),
            kind: "message_get_by_session",
            session_id,
            limit,
            offset,
        };
        emit_or_cleanup(&self, transport, &request_id, GET_BY_SESSION_EVENT, payload)?;
        self.await_response(request_id, rx, timeout, request_guard)
            .await
    }

    /// Run a `message_send` round-trip through the bridge (Phase A2).
    pub async fn send_message(
        self: Arc<Self>,
        transport: &dyn BridgeTransport,
        session_id: String,
        content: String,
        role: Option<String>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (request_id, rx, request_guard) = self.register(transport)?;
        let payload = SendMessageRequest {
            request_id: request_id.clone(),
            kind: "message_send",
            session_id,
            content,
            role,
        };
        emit_or_cleanup(&self, transport, &request_id, SEND_EVENT, payload)?;
        self.await_response(request_id, rx, timeout, request_guard)
            .await
    }

    pub async fn transcript_capabilities(
        self: Arc<Self>,
        transport: &dyn BridgeTransport,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (request_id, rx, request_guard) = self.register(transport)?;
        let payload = TranscriptCapabilitiesRequest {
            request_id: request_id.clone(),
            kind: "transcript_capabilities",
        };
        emit_or_cleanup(
            &self,
            transport,
            &request_id,
            TRANSCRIPT_CAPABILITIES_EVENT,
            payload,
        )?;
        self.await_response(request_id, rx, timeout, request_guard)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn session_timeline(
        self: Arc<Self>,
        transport: &dyn BridgeTransport,
        session_id: String,
        direction: Option<String>,
        cursor: Option<String>,
        limit: Option<u32>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (request_id, rx, request_guard) = self.register(transport)?;
        let payload = SessionTimelineRequest {
            request_id: request_id.clone(),
            kind: "session_timeline",
            session_id,
            direction,
            cursor,
            limit,
        };
        emit_or_cleanup(
            &self,
            transport,
            &request_id,
            SESSION_TIMELINE_EVENT,
            payload,
        )?;
        self.await_response(request_id, rx, timeout, request_guard)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn session_turn_messages(
        self: Arc<Self>,
        transport: &dyn BridgeTransport,
        session_id: String,
        turn_key: String,
        revision: u64,
        detail_revision: u64,
        cursor: Option<String>,
        limit: Option<u32>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (request_id, rx, request_guard) = self.register(transport)?;
        let payload = SessionTurnMessagesRequest {
            request_id: request_id.clone(),
            kind: "session_turn_messages",
            session_id,
            turn_key,
            revision,
            detail_revision,
            cursor,
            limit,
        };
        emit_or_cleanup(
            &self,
            transport,
            &request_id,
            SESSION_TURN_MESSAGES_EVENT,
            payload,
        )?;
        self.await_response(request_id, rx, timeout, request_guard)
            .await
    }

    pub async fn session_media(
        self: Arc<Self>,
        transport: &dyn BridgeTransport,
        session_id: String,
        hash: String,
        variant: String,
        timeout: Duration,
    ) -> Result<MediaBridgeResponse, String> {
        let mut request_guard = transport.reserve_request()?;
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending_media.lock().insert(request_id.clone(), tx);
        let payload = SessionMediaRequest {
            request_id: request_id.clone(),
            kind: "session_media",
            session_id,
            hash,
            variant,
        };
        let value = serde_json::to_value(payload).map_err(|error| {
            self.pending_media.lock().remove(&request_id);
            error.to_string()
        })?;
        if let Err(error) = transport.emit(SESSION_MEDIA_EVENT, value) {
            self.pending_media.lock().remove(&request_id);
            return Err(error);
        }
        tokio::select! {
            biased;
            () = request_guard.disconnected() => {
                self.pending_media.lock().remove(&request_id);
                Err("brain bridge disconnected".to_string())
            },
            result = tokio::time::timeout(timeout, rx) => match result {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => {
                    self.pending_media.lock().remove(&request_id);
                    Err("desktop media responder dropped".to_string())
                }
                Err(_) => {
                    self.pending_media.lock().remove(&request_id);
                    Err("desktop media request timed out".to_string())
                }
            },
        }
    }

    fn register(&self, transport: &dyn BridgeTransport) -> Result<PendingBridgeRequest, String> {
        let request_guard = transport.reserve_request()?;
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        self.pending.lock().insert(request_id.clone(), tx);
        Ok((request_id, rx, request_guard))
    }

    async fn await_response(
        self: Arc<Self>,
        request_id: String,
        rx: oneshot::Receiver<Result<Value, String>>,
        timeout: Duration,
        mut request_guard: BridgeRequestGuard,
    ) -> Result<Value, String> {
        tokio::select! {
            biased;
            () = request_guard.disconnected() => {
                self.pending.lock().remove(&request_id);
                Err("brain bridge disconnected".to_string())
            },
            result = tokio::time::timeout(timeout, rx) => match result {
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
            },
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

    pub fn resolve_media(&self, response: MediaBridgeResponse) {
        let sender = self.pending_media.lock().remove(&response.request_id);
        let Some(sender) = sender else { return };
        let result = match response.error.as_ref() {
            Some(error) => Err(error.clone()),
            None => Ok(response),
        };
        let _ = sender.send(result);
    }

    /// Test-only — number of in-flight requests.
    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        self.pending.lock().len()
    }
}

#[cfg(test)]
mod tests {
    use super::super::bridge_transport::test_support::RecordingBridgeTransport;
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn list_sessions_emits_camel_case_request_through_the_transport() {
        let bridge = DesktopMessagesBridge::new();
        let transport = RecordingBridgeTransport::new();
        let t = Arc::clone(&transport);
        let b = Arc::clone(&bridge);
        let handle = tokio::spawn(async move {
            b.list_sessions(t.as_ref(), 10, 0, None, DEFAULT_TIMEOUT)
                .await
        });
        let (channel, payload) = loop {
            if let Some(entry) = transport.last() {
                break entry;
            }
            tokio::task::yield_now().await;
        };
        assert_eq!(channel, LIST_EVENT);
        assert_eq!(payload["kind"], "session_list");
        // camelCase on the wire (requestId).
        let request_id = payload["requestId"].as_str().unwrap().to_string();
        bridge.resolve(MessageBridgeResponse {
            request_id,
            result: Some(json!({ "rows": [] })),
            error: None,
        });
        assert_eq!(handle.await.unwrap().unwrap(), json!({ "rows": [] }));
    }

    #[tokio::test]
    async fn session_timeline_emits_revision_bound_request_fields() {
        let bridge = DesktopMessagesBridge::new();
        let transport = RecordingBridgeTransport::new();
        let t = Arc::clone(&transport);
        let b = Arc::clone(&bridge);
        let handle = tokio::spawn(async move {
            b.session_timeline(
                t.as_ref(),
                "s1".into(),
                Some("backward".into()),
                Some("opaque".into()),
                Some(30),
                DEFAULT_TIMEOUT,
            )
            .await
        });
        let (channel, payload) = loop {
            if let Some(entry) = transport.last() {
                break entry;
            }
            tokio::task::yield_now().await;
        };
        assert_eq!(channel, SESSION_TIMELINE_EVENT);
        assert_eq!(payload["kind"], "session_timeline");
        assert_eq!(payload["sessionId"], "s1");
        assert_eq!(payload["direction"], "backward");
        assert_eq!(payload["cursor"], "opaque");
        assert_eq!(payload["limit"], 30);
        let request_id = payload["requestId"].as_str().unwrap().to_string();
        bridge.resolve(MessageBridgeResponse {
            request_id,
            result: Some(json!({ "items": [], "revision": 1, "hasMore": false })),
            error: None,
        });
        assert_eq!(
            handle.await.unwrap().unwrap(),
            json!({ "items": [], "revision": 1, "hasMore": false })
        );
    }

    #[tokio::test]
    async fn session_media_round_trips_raw_bytes_without_json_encoding() {
        let bridge = DesktopMessagesBridge::new();
        let transport = RecordingBridgeTransport::new();
        let t = Arc::clone(&transport);
        let b = Arc::clone(&bridge);
        let handle = tokio::spawn(async move {
            b.session_media(
                t.as_ref(),
                "s1".into(),
                "a".repeat(64),
                "thumbnail".into(),
                DEFAULT_TIMEOUT,
            )
            .await
        });
        let (channel, payload) = loop {
            if let Some(entry) = transport.last() {
                break entry;
            }
            tokio::task::yield_now().await;
        };
        assert_eq!(channel, SESSION_MEDIA_EVENT);
        assert_eq!(payload["sessionId"], "s1");
        assert_eq!(payload["variant"], "thumbnail");
        let request_id = payload["requestId"].as_str().unwrap().to_string();
        bridge.resolve_media(MediaBridgeResponse {
            request_id,
            bytes: vec![1, 2, 3],
            media_type: "image/png".into(),
            etag: Some("etag".into()),
            error: None,
        });
        let response = handle.await.unwrap().unwrap();
        assert_eq!(response.bytes, vec![1, 2, 3]);
        assert_eq!(response.media_type, "image/png");
    }

    #[tokio::test]
    async fn send_message_emit_failure_clears_the_pending_slot() {
        let bridge = DesktopMessagesBridge::new();
        let transport = RecordingBridgeTransport::failing();
        let err = Arc::clone(&bridge)
            .send_message(
                transport.as_ref(),
                "s1".into(),
                "hi".into(),
                None,
                DEFAULT_TIMEOUT,
            )
            .await
            .expect_err("emit fails");
        assert!(err.contains("forced failure"));
        assert_eq!(bridge.pending_count(), 0);
    }

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
        let transport = RecordingBridgeTransport::new();
        let (_id1, _rx1, _guard1) = bridge.register(transport.as_ref()).unwrap();
        let (_id2, _rx2, _guard2) = bridge.register(transport.as_ref()).unwrap();
        assert_eq!(bridge.pending_count(), 2);
    }
}
