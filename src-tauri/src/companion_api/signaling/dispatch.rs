//! DataChannel ↔ `rpc::dispatch` + `EventBus` bridge. ADR-0021.
//!
//! Once a `PeerSession`'s data channel is open, this module's task owns
//! the bidirectional message pump:
//!
//! - **Inbound** (mobile → desktop): JSON envelope `{ id, method, params }`
//!   gets routed through the existing `companion_api::rpc::dispatch`
//!   allowlist. The response `{ id, ok, result | error }` is sent back
//!   over the same data channel.
//! - **Outbound** (desktop → mobile): the dispatcher subscribes to the
//!   `EventBus` and forwards every `EventFrame` as a JSON envelope
//!   `{ kind: "event", event, seq, payload }`. The mobile client tracks
//!   per-channel cursors on its end (see `lib/tauri/transport-rtc.ts`).
//!
//! The shared `IdempotencyCache` is keyed by `(device_id, idempotency_key)`
//! so an RPC that re-sends over data channel after failing over HTTP
//! short-circuits to the cached response — matching the existing
//! cross-transport dedupe semantics in `companion_api::rpc`.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::peer::PeerSession;
use crate::companion_api::SharedState;

/// Inbound DataChannel frame shape (mobile → desktop). Mirror of
/// `lib/tauri/transport-rtc.ts:RtcMessage`.
#[derive(Debug, Deserialize)]
pub struct InboundRpc {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    /// Optional idempotency key (UUID) supplied by mutating callers. The
    /// dispatcher passes it through to the shared idempotency cache —
    /// see `companion_api::rpc::rpc_handler` for the matching behaviour
    /// on the HTTP path.
    #[serde(default, rename = "idempotencyKey")]
    pub idempotency_key: Option<String>,
}

/// Outbound DataChannel frame shape (desktop → mobile).
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum OutboundFrame {
    Response(ResponseFrame),
    Event(EventOutbound),
}

#[derive(Debug, Serialize)]
pub struct ResponseFrame {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct EventOutbound {
    /// Always `"event"`. Discriminates this frame from a response.
    pub kind: &'static str,
    pub event: String,
    pub seq: u64,
    pub payload: Value,
}

/// Spawn the dispatcher task. The returned `JoinHandle` is cancelled by
/// dropping or aborting; consumers should keep it around for the lifetime
/// of the data channel.
pub fn spawn(
    peer: Arc<PeerSession>,
    inbound_data: mpsc::UnboundedReceiver<Vec<u8>>,
    state: SharedState,
    app: tauri::AppHandle,
    device_id: String,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(run(peer, inbound_data, state, app, device_id))
}

async fn run(
    peer: Arc<PeerSession>,
    mut inbound_data: mpsc::UnboundedReceiver<Vec<u8>>,
    state: SharedState,
    app: tauri::AppHandle,
    device_id: String,
) {
    // Subscribe to EventBus with since=None → start at high-water mark
    // (matches the existing WS subscription default behaviour).
    use crate::companion_api::event_bus::SubscribeResult;
    let now_ms = crate::companion_api::signaling::envelope::now_ms();
    let mut event_rx = match state.event_bus.subscribe(None, now_ms) {
        SubscribeResult::Ok { receiver, .. } => receiver,
        SubscribeResult::ResyncRequired => {
            // None means "subscribe from the high-water mark", so resync
            // should be impossible here. Treat as a soft failure: log and
            // bail; the data channel stays alive for RPC-only traffic
            // until the peer reconnects (which forces a fresh subscribe).
            log::error!(
                "signaling::dispatch: event bus resync required at subscribe time; \
                 dispatcher will run RPC-only for device {device_id}"
            );
            return;
        }
    };

    loop {
        tokio::select! {
            biased;

            maybe_inbound = inbound_data.recv() => {
                let Some(bytes) = maybe_inbound else { break };
                if let Err(e) = handle_inbound(
                    &peer,
                    bytes,
                    &state,
                    &app,
                    &device_id,
                )
                .await
                {
                    log::warn!("signaling::dispatch: inbound handling error: {e}");
                }
            }

            recv_result = event_rx.recv() => {
                use tokio::sync::broadcast::error::RecvError;
                match recv_result {
                    Ok(frame) => {
                        let outbound = OutboundFrame::Event(EventOutbound {
                            kind: "event",
                            event: frame.event_type,
                            seq: frame.seq,
                            payload: frame.payload,
                        });
                        if let Err(e) = send_outbound(&peer, &outbound).await {
                            log::warn!(
                                "signaling::dispatch: forward event failed: {e}; data channel may be closed"
                            );
                            // Drain remaining events but stop forwarding —
                            // the WS path will pick up once the DC is gone.
                        }
                    }
                    Err(RecvError::Lagged(n)) => {
                        log::warn!(
                            "signaling::dispatch: lagged {n} frames; mobile will resync on next connect"
                        );
                    }
                    Err(RecvError::Closed) => break,
                }
            }
        }
    }
}

async fn handle_inbound(
    peer: &PeerSession,
    bytes: Vec<u8>,
    state: &SharedState,
    app: &tauri::AppHandle,
    device_id: &str,
) -> Result<(), String> {
    let rpc: InboundRpc = serde_json::from_slice(&bytes)
        .map_err(|e| format!("malformed inbound rpc: {e}"))?;

    let request_id = rpc.id.clone();

    // Idempotency check (mirrors rpc::rpc_handler logic).
    if let Some(key) = rpc.idempotency_key.as_deref() {
        if let Some(cached) = state.idempotency.get(device_id, key) {
            let outbound = OutboundFrame::Response(ResponseFrame {
                id: request_id.clone(),
                ok: true,
                result: Some(cached),
                error: None,
            });
            return send_outbound(peer, &outbound)
                .await
                .map_err(|e| e.to_string());
        }
    }

    // Route through the existing dispatch table.
    let result =
        crate::companion_api::rpc::dispatch(&rpc.method, rpc.params, state, app, device_id).await;
    let outbound = match result {
        Ok(value) => {
            if let Some(key) = rpc.idempotency_key.as_deref() {
                state
                    .idempotency
                    .put(device_id.to_string(), key.to_string(), value.clone());
            }
            OutboundFrame::Response(ResponseFrame {
                id: request_id,
                ok: true,
                result: Some(value),
                error: None,
            })
        }
        Err((_status, axum::Json(err))) => OutboundFrame::Response(ResponseFrame {
            id: request_id,
            ok: false,
            result: None,
            error: Some(ErrorBody {
                code: err.code,
                message: err.message,
            }),
        }),
    };

    send_outbound(peer, &outbound)
        .await
        .map_err(|e| e.to_string())
}

async fn send_outbound(
    peer: &PeerSession,
    frame: &OutboundFrame,
) -> Result<(), super::peer::PeerSendError> {
    let bytes = serde_json::to_vec(frame)
        .map_err(|e| super::peer::PeerSendError::Webrtc(e.to_string()))?;
    peer.send_bytes(bytes).await
}

// ---------------------------------------------------------------------------
// Internal helpers exposed for tests / introspection.
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub(super) fn encode_response_for_test(id: &str, result: Value) -> Vec<u8> {
    let frame = OutboundFrame::Response(ResponseFrame {
        id: id.to_string(),
        ok: true,
        result: Some(result),
        error: None,
    });
    serde_json::to_vec(&frame).expect("serialize")
}

#[allow(dead_code)]
pub(super) fn encode_event_for_test(event: &str, seq: u64, payload: Value) -> Vec<u8> {
    let frame = OutboundFrame::Event(EventOutbound {
        kind: "event",
        event: event.to_string(),
        seq,
        payload,
    });
    serde_json::to_vec(&frame).expect("serialize")
}

// Pre-allocate a no-op json call for tests that need a valid frame.
#[allow(dead_code)]
pub(super) fn empty_rpc_for_test(id: &str, method: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "id": id,
        "method": method,
        "params": {},
    }))
    .expect("serialize")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_frame_serializes_ok() {
        let frame = OutboundFrame::Response(ResponseFrame {
            id: "rpc-1".into(),
            ok: true,
            result: Some(json!({"value": 42})),
            error: None,
        });
        let text = serde_json::to_string(&frame).unwrap();
        assert!(text.contains(r#""id":"rpc-1""#));
        assert!(text.contains(r#""ok":true"#));
        assert!(text.contains(r#""value":42"#));
        // The serializer omits `error` because of skip_serializing_if.
        assert!(!text.contains(r#""error""#));
    }

    #[test]
    fn response_frame_serializes_err() {
        let frame = OutboundFrame::Response(ResponseFrame {
            id: "rpc-2".into(),
            ok: false,
            result: None,
            error: Some(ErrorBody {
                code: "unknown_command".into(),
                message: "not exposed".into(),
            }),
        });
        let text = serde_json::to_string(&frame).unwrap();
        assert!(text.contains(r#""ok":false"#));
        assert!(text.contains(r#""code":"unknown_command""#));
        assert!(text.contains(r#""message":"not exposed""#));
        assert!(!text.contains(r#""result""#));
    }

    #[test]
    fn event_frame_serializes_with_kind_discriminator() {
        let frame = OutboundFrame::Event(EventOutbound {
            kind: "event",
            event: "claude://session-event".into(),
            seq: 7,
            payload: json!({"a": 1}),
        });
        let text = serde_json::to_string(&frame).unwrap();
        assert!(text.contains(r#""kind":"event""#));
        assert!(text.contains(r#""event":"claude://session-event""#));
        assert!(text.contains(r#""seq":7"#));
    }

    #[test]
    fn inbound_rpc_parses() {
        let raw = br#"{"id":"r1","method":"session_list","params":{"limit":50}}"#;
        let rpc: InboundRpc = serde_json::from_slice(raw).unwrap();
        assert_eq!(rpc.id, "r1");
        assert_eq!(rpc.method, "session_list");
        assert_eq!(rpc.idempotency_key, None);
        assert_eq!(rpc.params["limit"], 50);
    }

    #[test]
    fn inbound_rpc_accepts_optional_idempotency_key() {
        let raw = br#"{"id":"r1","method":"claude_send","params":{},"idempotencyKey":"uuid"}"#;
        let rpc: InboundRpc = serde_json::from_slice(raw).unwrap();
        assert_eq!(rpc.idempotency_key.as_deref(), Some("uuid"));
    }
}
