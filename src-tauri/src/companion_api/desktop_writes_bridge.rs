//! Desktop-write bridge for Wave 2 mutating RPCs.
//!
//! Symmetric to [`super::desktop_messages_bridge`] but generic over the
//! command name. The phone hits `_rpc/<command>` for any of:
//!
//!   - `character_upsert` / `character_delete` / `character_bind_twin`
//!   - `skill_set_enabled`
//!   - `plugin_set_enabled`
//!   - `adapter_update_policy`
//!   - `app_settings_update`
//!   - `twin_profile_get` (read-only, but routes through the same bridge
//!     because the projection requires a Dexie scan)
//!
//! Rather than emit a bespoke Tauri event per command (the messages-
//! bridge approach), this bridge emits one unified
//! `companion://desktop-write-request` carrying `{ request_id, command,
//! payload }`. The desktop WebView dispatches on `command` and hands the
//! result back via the shared `companion_desktop_write_response` Tauri
//! command.
//!
//! Default timeout is 30 seconds — same as `sync_bridge` /
//! `desktop_messages_bridge`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use uuid::Uuid;

const REQUEST_EVENT: &str = "companion://desktop-write-request";
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Unified payload emitted to the WebView for every Wave 2 mutating RPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWriteRequest {
    pub request_id: String,
    pub command: String,
    pub payload: Value,
}

/// Generic response from the WebView. Same shape as the messages bridge.
#[derive(Debug, Clone, Deserialize)]
pub struct DesktopWriteResponse {
    pub request_id: String,
    pub result: Option<Value>,
    pub error: Option<String>,
}

/// Pending-request pool keyed by request_id.
pub struct DesktopWritesBridge {
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
}

impl DesktopWritesBridge {
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
        let event_payload = DesktopWriteRequest {
            request_id: request_id.clone(),
            command: command.to_string(),
            payload,
        };
        if let Err(err) = app.emit(REQUEST_EVENT, event_payload) {
            self.pending.lock().remove(&request_id);
            return Err(format!("failed to emit desktop-write-request: {err}"));
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
                Err("desktop-write-response sender dropped before responding".to_string())
            }
            Err(_) => {
                self.pending.lock().remove(&request_id);
                Err(format!(
                    "desktop-write request timed out after {} ms",
                    timeout.as_millis()
                ))
            }
        }
    }

    /// Resolve a pending request from the WebView. No-op for unknown ids.
    pub fn resolve(&self, response: DesktopWriteResponse) {
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
            (None, None) => Err("desktop-write-response had neither result nor error".to_string()),
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
        let bridge = DesktopWritesBridge::new();
        let request_id = "rid-1".to_string();
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        bridge.pending.lock().insert(request_id.clone(), tx);

        bridge.resolve(DesktopWriteResponse {
            request_id,
            result: Some(json!({"id": "char-1"})),
            error: None,
        });

        assert_eq!(bridge.pending_count(), 0);
        let result = rx.await.unwrap();
        assert_eq!(result.unwrap(), json!({"id": "char-1"}));
    }

    #[tokio::test]
    async fn resolve_propagates_error_field() {
        let bridge = DesktopWritesBridge::new();
        let request_id = "rid-err".to_string();
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        bridge.pending.lock().insert(request_id.clone(), tx);

        bridge.resolve(DesktopWriteResponse {
            request_id,
            result: None,
            error: Some("dexie offline".to_string()),
        });

        let result = rx.await.unwrap();
        assert_eq!(result.unwrap_err(), "dexie offline");
    }

    #[test]
    fn resolve_for_unknown_request_id_is_noop() {
        let bridge = DesktopWritesBridge::new();
        bridge.resolve(DesktopWriteResponse {
            request_id: "no-such-id".to_string(),
            result: Some(json!({})),
            error: None,
        });
        assert_eq!(bridge.pending_count(), 0);
    }

    #[tokio::test]
    async fn resolve_with_neither_result_nor_error_returns_a_generic_error() {
        let bridge = DesktopWritesBridge::new();
        let request_id = "rid-malformed".to_string();
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        bridge.pending.lock().insert(request_id.clone(), tx);

        bridge.resolve(DesktopWriteResponse {
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
        let bridge = DesktopWritesBridge::new();
        let (_id1, _rx1) = bridge.register();
        let (_id2, _rx2) = bridge.register();
        assert_eq!(bridge.pending_count(), 2);
    }
}
