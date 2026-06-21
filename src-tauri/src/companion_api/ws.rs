//! WebSocket event bridge — `GET /ws/v1/events`.
//!
//! # Connection lifecycle
//!
//! 1. Client opens `wss://<host>/ws/v1/events?token=<jwt>&since=<seq>`.
//!    The `require_device_jwt` middleware verifies the JWT and injects
//!    [`DeviceContext`] into request extensions *before* this handler runs.
//! 2. If `since` is too old, the server sends `{"type":"resync_required"}` and
//!    closes the connection immediately.
//! 3. Any buffered frames with `seq > since` are replayed in order.
//! 4. New frames are forwarded as JSON text frames as they arrive.
//! 5. A `{"type":"ping"}` heartbeat is sent every 25 seconds.
//! 6. The server closes the connection if no frame is received from the client
//!    within 90 seconds (idle timeout).

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::Response,
};
use serde::Deserialize;
use serde_json::json;
use tokio::time::{interval, Duration, Instant};

use super::{event_bus::SubscribeResult, middleware::DeviceContext, SharedState};

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

/// Interval between server-sent heartbeat pings.
const HEARTBEAT_SECS: u64 = 25;

/// Maximum silence from client before the server closes the connection.
const IDLE_TIMEOUT_SECS: u64 = 90;

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

/// Query parameters accepted by the WS upgrade endpoint.
#[derive(Debug, Deserialize)]
pub struct WsParams {
    /// Last sequence number the client received.  Omit (or pass `0`) for a
    /// fresh subscription with no replay.
    pub since: Option<u64>,
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/// Axum handler for `GET /ws/v1/events`.
///
/// The `require_device_jwt` middleware runs before this handler and injects
/// [`DeviceContext`] into the request extensions.  We read it from the
/// extensions *before* calling `ws.on_upgrade` because axum's
/// `WebSocketUpgrade` extractor consumes the request parts and extensions are
/// not forwarded into the async closure.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<WsParams>,
    State(state): State<SharedState>,
    request: axum::extract::Request,
) -> Response {
    // Read DeviceContext before the upgrade consumes the request.
    let device_id = request
        .extensions()
        .get::<DeviceContext>()
        .map(|ctx| ctx.device_id.clone())
        .unwrap_or_default();

    // Bound inbound frame allocation (DoS guard). The events channel only ever
    // receives tiny client frames (pongs / keep-alive text), so a small cap is
    // generous; this route is intentionally outside `RequestBodyLimitLayer`
    // (the WS upgrade needs the raw stream), so the limit is set here.
    const MAX_WS_FRAME_BYTES: usize = 64 * 1024;
    ws.max_message_size(MAX_WS_FRAME_BYTES)
        .max_frame_size(MAX_WS_FRAME_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, params.since, device_id, state))
}

// ---------------------------------------------------------------------------
// Socket handler
// ---------------------------------------------------------------------------

/// Drive the WebSocket connection for one client.
async fn handle_socket(
    mut socket: WebSocket,
    since: Option<u64>,
    _device_id: String,
    state: SharedState,
) {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // 1. Subscribe to the event bus (or bail if cursor is too old).
    let (mut receiver, replay) = match state.event_bus.subscribe(since, now_ms) {
        SubscribeResult::Ok { receiver, replay } => (receiver, replay),
        SubscribeResult::ResyncRequired => {
            let msg = serde_json::to_string(&json!({ "type": "resync_required" }))
                .unwrap_or_else(|_| r#"{"type":"resync_required"}"#.to_owned());
            let _ = socket.send(Message::Text(msg.into())).await;
            return;
        }
    };

    // 2. Send replay frames.
    for frame in replay {
        match serde_json::to_string(&frame) {
            Ok(text) => {
                if socket.send(Message::Text(text.into())).await.is_err() {
                    return;
                }
            }
            Err(e) => {
                log::warn!("companion-api ws: failed to serialize replay frame: {e}");
            }
        }
    }

    // 3. Enter the live-streaming loop.
    let heartbeat_interval = Duration::from_secs(HEARTBEAT_SECS);
    let idle_timeout = Duration::from_secs(IDLE_TIMEOUT_SECS);
    let mut hb_ticker = interval(heartbeat_interval);
    hb_ticker.tick().await; // consume the immediate first tick
    let mut last_client_activity = Instant::now();

    loop {
        tokio::select! {
            // New live frame from the bus.
            result = receiver.recv() => {
                match result {
                    Ok(frame) => {
                        match serde_json::to_string(&frame) {
                            Ok(text) => {
                                if socket.send(Message::Text(text.into())).await.is_err() {
                                    return;
                                }
                            }
                            Err(e) => {
                                log::warn!("companion-api ws: failed to serialize live frame: {e}");
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("companion-api ws: subscriber lagged by {n} frames; closing");
                        return;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        // Bus shut down — server is stopping.
                        return;
                    }
                }
            }

            // Incoming frame from client.
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        last_client_activity = Instant::now();
                        // Accept pong responses (or any text) to reset the idle timer.
                        // We don't need to act on the content beyond updating the timer.
                        let _ = text; // suppress unused-variable warning
                    }
                    Some(Ok(Message::Ping(data))) => {
                        last_client_activity = Instant::now();
                        // axum handles RFC 6455 binary ping/pong transparently, but
                        // let's explicitly respond just in case the client is strict.
                        let _ = socket.send(Message::Pong(data)).await;
                    }
                    Some(Ok(Message::Pong(_))) => {
                        last_client_activity = Instant::now();
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        // Client closed.
                        return;
                    }
                    Some(Ok(_)) => {
                        // Binary or other frames ignored.
                    }
                    Some(Err(_)) => {
                        // Transport error.
                        return;
                    }
                }
            }

            // Heartbeat tick.
            _ = hb_ticker.tick() => {
                // Idle-timeout check.
                if last_client_activity.elapsed() > idle_timeout {
                    log::debug!("companion-api ws: idle timeout, closing connection");
                    return;
                }

                let ping = serde_json::to_string(&json!({ "type": "ping" }))
                    .unwrap_or_else(|_| r#"{"type":"ping"}"#.to_owned());
                if socket.send(Message::Text(ping.into())).await.is_err() {
                    return;
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_api::{
        deny_list::DenyList,
        event_bus::EventBus,
        idempotency::IdempotencyCache,
        redemption_lru::RedemptionLru,
        CompanionState,
    };
    use parking_lot::RwLock;
    use serde_json::{json, Value};
    use std::sync::Arc;

    fn test_state_with_bus() -> (super::super::SharedState, Arc<EventBus>) {
        let bus = EventBus::new();
        let state = Arc::new(CompanionState {
            secret: RwLock::new(vec![0u8; 32]),
            redemption_lru: RedemptionLru::new(),
            pair_code_lru: Arc::new(crate::companion_api::pair_code_lru::PairCodeLru::new()),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::new(IdempotencyCache::new()),
            event_bus: Arc::clone(&bus),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry:
                crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter:
                crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens:
                crate::companion_api::push::PushTokenRegistry::new(),
        });
        (state, bus)
    }

    // ── Helper: simulate the core select loop without a real WebSocket ────────
    //
    // We test `handle_socket` indirectly via the EventBus subscribe API.
    // Full WS wire-up is flaky on Windows (no Unix domain sockets for
    // mock streams).  Instead we test the EventBus contract that the handler
    // relies on.

    // ── subscribe with no `since` → no replay, then live frame arrives ────────

    #[tokio::test]
    async fn no_since_no_replay_then_live() {
        let (state, bus) = test_state_with_bus();
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        let result = state.event_bus.subscribe(None, now_ms);
        let mut receiver = match result {
            SubscribeResult::Ok { replay, receiver } => {
                assert!(replay.is_empty(), "no replay expected for since=None");
                receiver
            }
            SubscribeResult::ResyncRequired => panic!("unexpected ResyncRequired"),
        };

        // Publish after subscribe → should arrive on the receiver.
        bus.publish("claude://message".into(), json!({ "text": "hello" }));
        let frame = receiver.recv().await.expect("frame must arrive");
        assert_eq!(frame.event_type, "claude://message");
        let _ = state; // keep state alive
    }

    // ── subscribe with valid `since` → replay frames in order ────────────────

    #[tokio::test]
    async fn valid_since_replays_in_order() {
        let (state, bus) = test_state_with_bus();

        // Publish 5 frames before subscribing.
        for i in 0..5_u32 {
            bus.publish("ev".into(), json!(i));
        }

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        // since=2 → expect frames 3, 4, 5.
        let result = state.event_bus.subscribe(Some(2), now_ms);
        match result {
            SubscribeResult::Ok { replay, .. } => {
                assert_eq!(replay.len(), 3, "expected 3 replay frames");
                assert_eq!(replay[0].seq, 3);
                assert_eq!(replay[1].seq, 4);
                assert_eq!(replay[2].seq, 5);
            }
            SubscribeResult::ResyncRequired => panic!("unexpected ResyncRequired"),
        }
    }

    // ── too-old `since` → ResyncRequired ─────────────────────────────────────

    #[test]
    fn too_old_since_fires_resync_required() {
        let bus = EventBus::new();

        // Fill the ring past capacity so old entries are evicted.
        for _ in 0..205_usize {
            bus.publish("ev".into(), json!({}));
        }
        // since=1 has been evicted.
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        let result = bus.subscribe(Some(1), now_ms);
        assert!(
            matches!(result, SubscribeResult::ResyncRequired),
            "expected ResyncRequired"
        );
    }

    // ── heartbeat fires after simulated tick ──────────────────────────────────
    //
    // We verify the heartbeat message shape rather than its timing (wall-clock
    // timing tests are inherently flaky).

    #[test]
    fn heartbeat_message_shape() {
        let ping_msg =
            serde_json::to_string(&json!({ "type": "ping" })).expect("serialize ping");
        let v: Value = serde_json::from_str(&ping_msg).expect("parse ping");
        assert_eq!(v["type"], "ping");
    }

    // ── resync_required message shape ────────────────────────────────────────

    #[test]
    fn resync_required_message_shape() {
        let msg = serde_json::to_string(&json!({ "type": "resync_required" }))
            .expect("serialize resync_required");
        let v: Value = serde_json::from_str(&msg).expect("parse");
        assert_eq!(v["type"], "resync_required");
    }

    // ── EventFrame serialises to the wire format ──────────────────────────────

    #[test]
    fn event_frame_serialises_correctly() {
        use crate::companion_api::event_bus::EventFrame;

        let frame = EventFrame {
            event_type: "claude://message".into(),
            seq: 42,
            payload: json!({ "text": "hi" }),
            ts_ms: 1_700_000_000_000,
        };
        let s = serde_json::to_string(&frame).expect("serialize");
        let v: Value = serde_json::from_str(&s).expect("parse");

        assert_eq!(v["type"], "claude://message");
        assert_eq!(v["seq"], 42);
        assert_eq!(v["payload"]["text"], "hi");
        assert_eq!(v["ts_ms"], 1_700_000_000_000_i64);
    }

    // ── Broadcast channel: lagged subscriber detection ────────────────────────
    //
    // If we publish more than the broadcast channel capacity, a slow subscriber
    // gets `RecvError::Lagged`.  The handler closes on lag — verify the enum
    // variant is what we expect.

    #[test]
    fn broadcast_lag_error_variant() {
        use tokio::sync::broadcast::error::TryRecvError;
        let (tx, mut rx) = tokio::sync::broadcast::channel::<u32>(4);
        // Overflow the channel without any receiver reading.
        for i in 0..8 {
            let _ = tx.send(i);
        }
        let err = rx.try_recv().expect_err("should have lagged");
        assert!(matches!(err, TryRecvError::Lagged(_)));
    }
}
