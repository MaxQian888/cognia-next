//! Renderer round-trip bridge for the CLI dev server.
//!
//! Some CLI bridge endpoints need data that lives ONLY in the renderer —
//! twin retrieval reads Dexie + the vector store, agent teams live in the
//! renderer's Zustand store. Mirrors
//! [`crate::companion_api::desktop_writes_bridge`]: the axum handler calls
//! [`RendererBridge::dispatch`], we emit one unified
//! `cli-bridge://renderer-request` event carrying `{ requestId, command,
//! payload }`, the WebView dispatches on `command` and posts the result
//! back through the `cli_bridge_renderer_response` Tauri command.
//!
//! Default timeout is 30 seconds — same as the companion bridges. Individual
//! callers may choose a shorter bound; plugin activation uses 25 seconds so
//! the HTTP client can retain a larger end-to-end timeout.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use uuid::Uuid;

const REQUEST_EVENT: &str = "cli-bridge://renderer-request";
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Unified payload emitted to the WebView for every renderer-backed route.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererRequest {
    pub request_id: String,
    pub command: String,
    pub payload: Value,
}

/// Generic response from the WebView (same shape as the companion bridges).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererResponse {
    pub request_id: String,
    pub result: Option<Value>,
    pub error: Option<String>,
}

/// Pending-request pool keyed by request_id.
pub struct RendererBridge {
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
}

impl RendererBridge {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            pending: Mutex::new(HashMap::new()),
        })
    }

    /// Round-trip a single command through the desktop WebView.
    pub async fn dispatch(
        self: Arc<Self>,
        app: &AppHandle,
        command: &str,
        payload: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (request_id, rx) = self.register();
        let event_payload = RendererRequest {
            request_id: request_id.clone(),
            command: command.to_string(),
            payload,
        };
        if let Err(err) = app.emit(REQUEST_EVENT, event_payload) {
            self.pending.lock().remove(&request_id);
            return Err(format!("failed to emit renderer-request: {err}"));
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
                Err("renderer-response sender dropped before responding".to_string())
            }
            Err(_) => {
                self.pending.lock().remove(&request_id);
                Err(format!(
                    "renderer request timed out after {} ms",
                    timeout.as_millis()
                ))
            }
        }
    }

    /// Resolve a pending request from the WebView. No-op for unknown ids.
    pub fn resolve(&self, response: RendererResponse) {
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
            (None, None) => Err("renderer-response had neither result nor error".to_string()),
        };
        let _ = sender.send(payload);
    }

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
        let bridge = RendererBridge::new();
        let request_id = "rid-1".to_string();
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        bridge.pending.lock().insert(request_id.clone(), tx);

        bridge.resolve(RendererResponse {
            request_id,
            result: Some(json!({"applied": {"systemPrompt": "sp"}})),
            error: None,
        });

        assert_eq!(bridge.pending_count(), 0);
        let result = rx.await.unwrap();
        assert_eq!(result.unwrap(), json!({"applied": {"systemPrompt": "sp"}}));
    }

    #[tokio::test]
    async fn resolve_propagates_error_field() {
        let bridge = RendererBridge::new();
        let request_id = "rid-err".to_string();
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        bridge.pending.lock().insert(request_id.clone(), tx);

        bridge.resolve(RendererResponse {
            request_id,
            result: None,
            error: Some("team not found".to_string()),
        });

        let result = rx.await.unwrap();
        assert_eq!(result.unwrap_err(), "team not found");
    }

    #[test]
    fn resolve_for_unknown_request_id_is_noop() {
        let bridge = RendererBridge::new();
        bridge.resolve(RendererResponse {
            request_id: "no-such-id".to_string(),
            result: Some(json!({})),
            error: None,
        });
        assert_eq!(bridge.pending_count(), 0);
    }

    #[tokio::test]
    async fn resolve_with_neither_result_nor_error_returns_a_generic_error() {
        let bridge = RendererBridge::new();
        let request_id = "rid-malformed".to_string();
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        bridge.pending.lock().insert(request_id.clone(), tx);

        bridge.resolve(RendererResponse {
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
        let bridge = RendererBridge::new();
        let (_id1, _rx1) = bridge.register();
        let (_id2, _rx2) = bridge.register();
        assert_eq!(bridge.pending_count(), 2);
    }
}
