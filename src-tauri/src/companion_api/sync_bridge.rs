//! Sync-pull bridge between the Rust HTTP server and the desktop webview
//! (M4.7 / #51).
//!
//! The phone hits `POST /api/v1/_rpc/sync_pull` against the desktop's Rust
//! server, but the actual data lives in the WebView's Dexie. So when the
//! Rust handler runs, it has to ask the WebView "give me the rows for
//! table X since cursor Y", await the response, and forward it to the
//! phone.
//!
//! # Wire protocol
//!
//! 1. Rust: emit Tauri event `companion://sync-pull-request` with payload
//!    `{ request_id, table, since }`.
//! 2. TS (`lib/sync/desktop-sync-source.ts`): listen for the event,
//!    query Dexie, call Tauri command `companion_sync_pull_response` with
//!    `{ request_id, delta }`.
//! 3. Rust: command resolves the matching oneshot, the HTTP handler
//!    completes with the delta in its response body.
//!
//! Default timeout is 30 seconds — enough room for a slow Dexie scan on a
//! sleeping desktop without leaving the phone hanging forever.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use uuid::Uuid;

const REQUEST_EVENT: &str = "companion://sync-pull-request";
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Payload emitted to the WebView when the Rust handler needs sync data.
#[derive(Debug, Clone, Serialize)]
pub struct SyncPullRequest {
    pub request_id: String,
    pub table: String,
    pub since: i64,
}

/// Payload received back from the WebView.
#[derive(Debug, Clone, Deserialize)]
pub struct SyncPullResponse {
    pub request_id: String,
    /// Either the full delta JSON, or null when the WebView reports an error.
    pub delta: Option<Value>,
    pub error: Option<String>,
}

/// In-memory pool of pending requests.  Each Rust HTTP handler registers a
/// oneshot receiver under its request_id, then awaits.  When the WebView
/// calls back via [`SyncBridge::resolve`], the oneshot fires and the
/// handler returns.
pub struct SyncBridge {
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
}

impl SyncBridge {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            pending: Mutex::new(HashMap::new()),
        })
    }

    /// Run a sync pull through the bridge.  Emits the request event, waits
    /// up to `timeout` for the WebView to respond, returns the delta or an
    /// error string.
    pub async fn pull(
        self: Arc<Self>,
        app: &AppHandle,
        table: String,
        since: i64,
        timeout: Duration,
    ) -> Result<Value, String> {
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();

        {
            let mut pending = self.pending.lock();
            pending.insert(request_id.clone(), tx);
        }

        let payload = SyncPullRequest {
            request_id: request_id.clone(),
            table,
            since,
        };

        if let Err(err) = app.emit(REQUEST_EVENT, payload) {
            self.pending.lock().remove(&request_id);
            return Err(format!("failed to emit sync-pull-request: {err}"));
        }

        let outcome = tokio::time::timeout(timeout, rx).await;

        match outcome {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(err))) => Err(err),
            Ok(Err(_recv_err)) => {
                self.pending.lock().remove(&request_id);
                Err("sync-pull-response sender dropped before responding".to_string())
            }
            Err(_) => {
                self.pending.lock().remove(&request_id);
                Err(format!(
                    "sync-pull-request timed out after {} ms",
                    timeout.as_millis()
                ))
            }
        }
    }

    /// Resolve a pending request from the WebView.  No-op if the request
    /// already timed out — the sender is gone, fire-and-forget.
    pub fn resolve(&self, response: SyncPullResponse) {
        let sender = {
            let mut pending = self.pending.lock();
            pending.remove(&response.request_id)
        };
        let Some(sender) = sender else {
            return;
        };
        let payload = match (response.delta, response.error) {
            (Some(value), _) => Ok(value),
            (None, Some(err)) => Err(err),
            (None, None) => Err("sync-pull-response had neither delta nor error".to_string()),
        };
        let _ = sender.send(payload);
    }

    /// Test-only — number of in-flight requests.  Production code should
    /// not depend on this.
    #[doc(hidden)]
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
        let bridge = SyncBridge::new();
        let request_id = "test-rid".to_string();
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        bridge.pending.lock().insert(request_id.clone(), tx);

        bridge.resolve(SyncPullResponse {
            request_id: request_id.clone(),
            delta: Some(json!({"rows": []})),
            error: None,
        });

        assert_eq!(bridge.pending_count(), 0);
        let result = rx.await.unwrap();
        assert_eq!(result.unwrap(), json!({"rows": []}));
    }

    #[tokio::test]
    async fn resolve_propagates_error_field() {
        let bridge = SyncBridge::new();
        let request_id = "rid-err".to_string();
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        bridge.pending.lock().insert(request_id.clone(), tx);

        bridge.resolve(SyncPullResponse {
            request_id,
            delta: None,
            error: Some("dexie schema mismatch".to_string()),
        });

        let result = rx.await.unwrap();
        assert_eq!(result.unwrap_err(), "dexie schema mismatch");
    }

    #[test]
    fn resolve_for_unknown_request_id_is_noop() {
        let bridge = SyncBridge::new();
        // No senders registered.
        bridge.resolve(SyncPullResponse {
            request_id: "no-such-id".to_string(),
            delta: Some(json!({})),
            error: None,
        });
        assert_eq!(bridge.pending_count(), 0);
    }

    #[tokio::test]
    async fn resolve_with_neither_delta_nor_error_returns_a_generic_error() {
        let bridge = SyncBridge::new();
        let request_id = "rid-malformed".to_string();
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        bridge.pending.lock().insert(request_id.clone(), tx);

        bridge.resolve(SyncPullResponse {
            request_id,
            delta: None,
            error: None,
        });

        let result = rx.await.unwrap();
        let err = result.unwrap_err();
        assert!(err.contains("neither delta nor error"));
    }
}
