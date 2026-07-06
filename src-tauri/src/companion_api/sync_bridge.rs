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
//!    `{ request_id, table, since, account_id }`.
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
use tokio::sync::oneshot;
use uuid::Uuid;

use super::bridge_transport::BridgeTransport;

const REQUEST_EVENT: &str = "companion://sync-pull-request";
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Payload emitted to the WebView when the Rust handler needs sync data.
#[derive(Debug, Clone, Serialize)]
pub struct SyncPullRequest {
    pub request_id: String,
    pub table: String,
    pub since: i64,
    pub account_id: String,
}

/// Payload received back from the WebView.
///
/// The alias accepts the camelCase key the TS side sends verbatim over the
/// headless bridge WS (`ws_bridge::route_respond`); the desktop Tauri command
/// path already converts to snake_case at the command boundary.
#[derive(Debug, Clone, Deserialize)]
pub struct SyncPullResponse {
    #[serde(alias = "requestId")]
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
        transport: &dyn BridgeTransport,
        table: String,
        since: i64,
        account_id: String,
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
            account_id,
        };

        // Preserve the wire shape: SyncPullRequest serializes snake_case
        // (request_id / account_id), unlike the camelCase messages/writes
        // payloads — the TS listener depends on this.
        let value = match serde_json::to_value(&payload) {
            Ok(v) => v,
            Err(err) => {
                self.pending.lock().remove(&request_id);
                return Err(format!("failed to serialize sync-pull-request: {err}"));
            }
        };
        if let Err(err) = transport.emit(REQUEST_EVENT, value) {
            self.pending.lock().remove(&request_id);
            return Err(err);
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
    async fn pull_emits_snake_case_request_through_the_transport() {
        let bridge = SyncBridge::new();
        let transport = RecordingBridgeTransport::new();
        let t = Arc::clone(&transport);
        let b = Arc::clone(&bridge);
        let handle = tokio::spawn(async move {
            b.pull(t.as_ref(), "sessions".into(), 7, "local_acct_a".into(), DEFAULT_TIMEOUT)
                .await
        });

        // Wait for the emit to land, then resolve so the pull completes.
        let (channel, payload) = loop {
            if let Some(entry) = transport.last() {
                break entry;
            }
            tokio::task::yield_now().await;
        };
        assert_eq!(channel, REQUEST_EVENT);
        assert_eq!(payload["table"], "sessions");
        assert_eq!(payload["since"], 7);
        // Snake_case on the wire — distinct from the camelCase messages/writes payloads.
        assert_eq!(payload["account_id"], "local_acct_a");
        let request_id = payload["request_id"].as_str().unwrap().to_string();

        bridge.resolve(SyncPullResponse {
            request_id,
            delta: Some(json!({ "rows": [] })),
            error: None,
        });
        assert_eq!(handle.await.unwrap().unwrap(), json!({ "rows": [] }));
    }

    #[tokio::test]
    async fn pull_emit_failure_clears_the_pending_slot() {
        let bridge = SyncBridge::new();
        let transport = RecordingBridgeTransport::failing();
        let err = Arc::clone(&bridge)
            .pull(transport.as_ref(), "sessions".into(), 0, "a".into(), DEFAULT_TIMEOUT)
            .await
            .expect_err("emit fails");
        assert!(err.contains("forced failure"));
        assert_eq!(bridge.pending_count(), 0);
    }

    #[test]
    fn sync_pull_request_serializes_account_id() {
        let payload = SyncPullRequest {
            request_id: "rid".to_string(),
            table: "sessions".to_string(),
            since: 42,
            account_id: "local_acct_a".to_string(),
        };

        let value = serde_json::to_value(payload).expect("serialize payload");
        assert_eq!(value["request_id"], "rid");
        assert_eq!(value["table"], "sessions");
        assert_eq!(value["since"], 42);
        assert_eq!(value["account_id"], "local_acct_a");
    }

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
