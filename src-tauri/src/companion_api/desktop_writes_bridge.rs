//! Desktop-write bridge for Wave 2 mutating RPCs.
//!
//! Symmetric to [`super::desktop_messages_bridge`] but generic over the
//! command name. The phone hits `_rpc/<command>` and the bridge carries it.
//!
//! There is no list of commands here on purpose. This docblock used to name
//! eight, which was true when it was written and drifted to a third of the
//! real set: the bridged family is now 133 commands, spanning character and
//! skill and plugin writes, host state, performance leases, the mobile
//! outbound queue, connector drafts, workflow triggers, remote session
//! attach and detach, and chunked attachment upload. The authority is the
//! `match name` in `rpc/data_sync.rs`, and the TypeScript half is the `case`
//! arms plus five delegated families in
//! `lib/companion/desktop-write-source.ts`. A list here could only ever be a
//! second copy going stale again.
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
//!
//! A request's pending slot is owned by a drop guard from the moment it is
//! registered: whatever ends the wait without an answer — a timeout, a
//! disconnect, a failed emit, or the waiting future simply being dropped
//! because its HTTP caller went away (the gateway's Run API, ADR-0188) —
//! removes the slot, so nothing outlives the request it was made for.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;
use uuid::Uuid;

use super::bridge_transport::{BridgeRequestGuard, BridgeTransport};

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
///
/// The alias accepts the camelCase key the TS side sends verbatim over the
/// headless bridge WS (`ws_bridge::route_respond`).
#[derive(Debug, Clone, Deserialize)]
pub struct DesktopWriteResponse {
    #[serde(alias = "requestId")]
    pub request_id: String,
    #[serde(default, deserialize_with = "deserialize_present_result")]
    pub result: Option<Value>,
    pub error: Option<String>,
}

// Successful void handlers return an explicit JSON null. Serde's ordinary
// Option decoder collapses that into a missing result on the Headless WS path.
fn deserialize_present_result<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Value::deserialize(deserializer).map(Some)
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
    ///
    /// Cancel-safe: dropping the returned future at any point leaves no
    /// pending slot behind (see `PendingSlot`).
    pub async fn dispatch(
        self: Arc<Self>,
        transport: &dyn BridgeTransport,
        command: &str,
        payload: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let request_guard = transport.reserve_request()?;
        let (request_id, rx) = self.register();
        // From here on every way out — an error below, the wait's own
        // outcome, or this future being dropped — goes through the slot.
        let slot = PendingSlot {
            bridge: Arc::clone(&self),
            request_id: request_id.clone(),
            answered: false,
        };
        let event_payload = DesktopWriteRequest {
            request_id,
            command: command.to_string(),
            payload,
        };
        let value = match serde_json::to_value(&event_payload) {
            Ok(v) => v,
            Err(err) => {
                return Err(format!("failed to serialize desktop-write-request: {err}"));
            }
        };
        transport.emit(REQUEST_EVENT, value)?;
        Self::await_response(slot, rx, timeout, request_guard).await
    }

    fn register(&self) -> (String, oneshot::Receiver<Result<Value, String>>) {
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        self.pending.lock().insert(request_id.clone(), tx);
        (request_id, rx)
    }

    /// Wait for the WebView's answer. Every unanswered outcome — and a drop
    /// of this future mid-wait — releases the slot through its guard.
    async fn await_response(
        mut slot: PendingSlot,
        rx: oneshot::Receiver<Result<Value, String>>,
        timeout: Duration,
        mut request_guard: BridgeRequestGuard,
    ) -> Result<Value, String> {
        let outcome = tokio::select! {
            biased;
            _ = request_guard.disconnected() => None,
            outcome = tokio::time::timeout(timeout, rx) => Some(outcome),
        };
        match outcome {
            Some(Ok(Ok(answer))) => {
                // `resolve` already took the slot out of the map.
                slot.answered = true;
                answer
            }
            Some(Ok(Err(_recv_err))) => {
                Err("desktop-write-response sender dropped before responding".to_string())
            }
            Some(Err(_)) => Err(format!(
                "desktop-write request timed out after {} ms",
                timeout.as_millis()
            )),
            None => Err("brain bridge disconnected".to_string()),
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
            (_, Some(err)) => Err(err),
            (Some(value), None) => Ok(value),
            (None, None) => Err("desktop-write-response had neither result nor error".to_string()),
        };
        let _ = sender.send(payload);
    }

    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        self.pending.lock().len()
    }
}

/// A registered request's claim on the pending map. Dropped without an answer
/// — the wait timed out, the brain disconnected, the emit failed, or the
/// waiting future was dropped because its caller went away — it removes the
/// request's entry, which would otherwise hold its sender until the process
/// exits. An answered request's entry was already taken out by `resolve`.
struct PendingSlot {
    bridge: Arc<DesktopWritesBridge>,
    request_id: String,
    answered: bool,
}

impl Drop for PendingSlot {
    fn drop(&mut self) {
        if !self.answered {
            self.bridge.pending.lock().remove(&self.request_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::bridge_transport::test_support::RecordingBridgeTransport;
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn wire_null_result_succeeds_but_error_and_missing_result_do_not() {
        for (payload, expected) in [
            (json!({"result": null, "error": null}), Ok(Value::Null)),
            (
                json!({"result": null, "error": "plugin refused"}),
                Err("plugin refused"),
            ),
            (
                json!({}),
                Err("desktop-write-response had neither result nor error"),
            ),
        ] {
            let bridge = DesktopWritesBridge::new();
            let (request_id, receiver) = bridge.register();
            let mut wire = payload;
            wire["requestId"] = Value::String(request_id);
            bridge.resolve(serde_json::from_value(wire).unwrap());
            assert_eq!(receiver.await.unwrap(), expected.map_err(str::to_owned));
        }
    }

    #[tokio::test]
    async fn dispatch_emits_camel_case_request_through_the_transport() {
        let bridge = DesktopWritesBridge::new();
        let transport = RecordingBridgeTransport::new();
        let t = Arc::clone(&transport);
        let b = Arc::clone(&bridge);
        let handle = tokio::spawn(async move {
            b.dispatch(
                t.as_ref(),
                "character_upsert",
                json!({ "id": "c1" }),
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
        assert_eq!(channel, REQUEST_EVENT);
        assert_eq!(payload["command"], "character_upsert");
        assert_eq!(payload["payload"]["id"], "c1");
        // camelCase on the wire (requestId, not request_id).
        let request_id = payload["requestId"].as_str().unwrap().to_string();
        bridge.resolve(DesktopWriteResponse {
            request_id,
            result: Some(json!({ "ok": true })),
            error: None,
        });
        assert_eq!(handle.await.unwrap().unwrap(), json!({ "ok": true }));
    }

    #[tokio::test]
    async fn dispatch_emit_failure_clears_the_pending_slot() {
        let bridge = DesktopWritesBridge::new();
        let transport = RecordingBridgeTransport::failing();
        let err = Arc::clone(&bridge)
            .dispatch(
                transport.as_ref(),
                "character_upsert",
                json!({}),
                DEFAULT_TIMEOUT,
            )
            .await
            .expect_err("emit fails");
        assert!(err.contains("forced failure"));
        assert_eq!(bridge.pending_count(), 0);
    }

    #[tokio::test]
    async fn a_wait_dropped_mid_flight_leaves_no_pending_slot_behind() {
        // The gateway's Run API awaits `dispatch` inside an HTTP handler; a
        // caller that disconnects makes axum drop that future mid-wait.
        let bridge = DesktopWritesBridge::new();
        let transport = RecordingBridgeTransport::new();
        let mut waiting = Box::pin(Arc::clone(&bridge).dispatch(
            transport.as_ref(),
            "router_fusion_run_get",
            json!({ "runId": "r-1" }),
            DEFAULT_TIMEOUT,
        ));
        tokio::select! {
            biased;
            _ = &mut waiting => panic!("nothing answered, so the wait cannot finish"),
            _ = tokio::task::yield_now() => {}
        }
        // The request went out and is waiting for its answer…
        assert_eq!(
            transport.last().unwrap().1["command"],
            "router_fusion_run_get"
        );
        assert_eq!(bridge.pending_count(), 1);
        // …and the caller goes away.
        drop(waiting);
        assert_eq!(bridge.pending_count(), 0);
    }

    #[tokio::test]
    async fn a_wait_that_times_out_releases_its_slot() {
        let bridge = DesktopWritesBridge::new();
        let transport = RecordingBridgeTransport::new();
        let err = Arc::clone(&bridge)
            .dispatch(
                transport.as_ref(),
                "character_upsert",
                json!({}),
                Duration::from_millis(5),
            )
            .await
            .expect_err("nothing answers");
        assert!(err.contains("timed out"), "{err}");
        assert_eq!(bridge.pending_count(), 0);
    }

    #[tokio::test]
    async fn an_answered_wait_resolves_once_and_leaves_nothing_behind() {
        let bridge = DesktopWritesBridge::new();
        let transport = RecordingBridgeTransport::new();
        let mut waiting = Box::pin(Arc::clone(&bridge).dispatch(
            transport.as_ref(),
            "character_upsert",
            json!({}),
            DEFAULT_TIMEOUT,
        ));
        tokio::select! {
            biased;
            _ = &mut waiting => panic!("nothing answered yet"),
            _ = tokio::task::yield_now() => {}
        }
        let request_id = transport.last().unwrap().1["requestId"]
            .as_str()
            .unwrap()
            .to_string();
        bridge.resolve(DesktopWriteResponse {
            request_id: request_id.clone(),
            result: Some(json!({ "ok": true })),
            error: None,
        });
        assert_eq!(waiting.await.unwrap(), json!({ "ok": true }));
        assert_eq!(bridge.pending_count(), 0);
        // A late duplicate answer for the same id is a no-op.
        bridge.resolve(DesktopWriteResponse {
            request_id,
            result: Some(json!({ "ok": false })),
            error: None,
        });
        assert_eq!(bridge.pending_count(), 0);
    }

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
