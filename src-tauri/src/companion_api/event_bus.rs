//! Event bus: bridges Tauri's internal event emitter to connected WebSocket clients.
//!
//! # Architecture
//!
//! ```text
//! Tauri app.emit("claude://message", …)
//!        │
//!        ▼  (via app.listen + EventBus::publish)
//!   EventBus ──broadcast──► WS client A
//!        │    (tokio::sync::broadcast::Sender<EventFrame>)
//!        │    ──broadcast──► WS client B
//!        │
//!        └─ VecDeque<EventFrame> (ring buffer, cap 10,000, 24 h retention)
//!             ▲
//!             └── on reconnect: subscribe(since) → replay
//! ```
//!
//! # Design decisions
//!
//! - **`broadcast::channel`** (capacity 256): slow receivers lag behind and
//!   get `RecvError::Lagged` — treated as a disconnect on the WS side.
//! - **Ring buffer**: capped at [`BUFFER_CAPACITY`] entries *and* entries
//!   older than [`RETENTION_MS`] are pruned periodically and on subscribe.
//!   This keeps the replay window bounded in both count and time without an
//!   O(n) scan on every publish.
//! - **Atomic `seq_counter`**: each published frame gets a monotonically
//!   increasing sequence number. The replay cursor `since` lets reconnecting
//!   clients request only frames they haven't seen.

use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicI64, AtomicU64, Ordering},
        Arc,
    },
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum number of frames retained in the replay buffer.
pub(super) const BUFFER_CAPACITY: usize = 10_000;

/// How long (ms) to retain a frame in the replay buffer.
const RETENTION_MS: i64 = 24 * 60 * 60 * 1000;
/// Controller-proxy payloads can contain tool arguments or provider requests.
/// Retain them only for a brief reconnect grace, never the general event
/// history window.
const REQUEST_SCOPED_RETENTION_MS: i64 = 2 * 60 * 1000;
/// Amortize retention pruning so high-frequency event streams do not scan the
/// full replay buffer while holding its mutex on every publish.
const PRUNE_INTERVAL_MS: i64 = 1000;

/// Broadcast channel depth — must be a power of two per tokio's requirement.
/// 256 slots give a comfortable burst margin before slow subscribers lag.
const BROADCAST_CAPACITY: usize = 256;

// ---------------------------------------------------------------------------
// EventFrame
// ---------------------------------------------------------------------------

/// A single event frame forwarded to WebSocket clients.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EventFrame {
    /// The Tauri event channel name, e.g. `"claude://message"`.
    #[serde(rename = "type")]
    pub event_type: String,
    /// Monotonically increasing sequence number (starts at 1).
    pub seq: u64,
    /// Arbitrary JSON payload from the Tauri event.
    pub payload: Value,
    /// Unix timestamp (milliseconds) when the frame was published.
    pub ts_ms: i64,
    /// Request-scoped controller destination. This routing field is never
    /// serialized to clients; transports use it to suppress delivery to
    /// non-origin devices.
    #[serde(skip)]
    pub target_device_id: Option<String>,
}

impl EventFrame {
    pub fn visible_to(&self, device_id: &str) -> bool {
        self.target_device_id
            .as_deref()
            .is_none_or(|target| target == device_id)
    }
}

// ---------------------------------------------------------------------------
// SubscribeResult
// ---------------------------------------------------------------------------

/// Returned by [`EventBus::subscribe`].
pub enum SubscribeResult {
    /// The subscription was established successfully.
    Ok {
        /// Live receiver — forward every new frame to the WS client.
        receiver: tokio::sync::broadcast::Receiver<EventFrame>,
        /// Frames with `seq > since` still within the retention window.
        replay: Vec<EventFrame>,
    },
    /// The requested `since` cursor is older than the oldest retained frame,
    /// so a full resync is required.
    ResyncRequired,
}

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

/// Shared bridge between Tauri events and WebSocket subscribers.
pub struct EventBus {
    tx: tokio::sync::broadcast::Sender<EventFrame>,
    buffer: Mutex<VecDeque<EventFrame>>,
    seq_counter: AtomicU64,
    last_prune_ms: AtomicI64,
}

/// Connector event sink shared by the public ingress router and connector
/// command-plane RPC arms in headless mode.
pub struct ConnectorEventEmitter(pub Arc<EventBus>);

impl crate::connectors::axum_app::EventEmitter for ConnectorEventEmitter {
    fn emit(&self, topic: &str, payload: Value) {
        self.0.publish(topic.to_string(), payload);
    }
}

impl EventBus {
    /// Create a new `EventBus` and return it wrapped in an [`Arc`].
    pub fn new() -> Arc<Self> {
        let (tx, _) = tokio::sync::broadcast::channel(BROADCAST_CAPACITY);
        Arc::new(Self {
            tx,
            buffer: Mutex::new(VecDeque::with_capacity(BUFFER_CAPACITY)),
            seq_counter: AtomicU64::new(0),
            last_prune_ms: AtomicI64::new(0),
        })
    }

    /// Current global sequence high-water mark. A client advances to this
    /// value only after its authoritative resync completes.
    pub fn high_water_seq(&self) -> u64 {
        self.seq_counter.load(Ordering::Relaxed)
    }

    /// Publish an event to all current subscribers and append it to the
    /// replay buffer.
    ///
    /// Returns the [`EventFrame`] that was broadcast (useful in tests).
    pub fn publish(&self, event_type: String, payload: Value) -> EventFrame {
        let seq = self.seq_counter.fetch_add(1, Ordering::Relaxed) + 1;
        let ts_ms = now_ms();
        register_remote_pending_request(&payload);

        let frame = EventFrame {
            event_type,
            seq,
            target_device_id: payload
                .get("remoteExecutionContext")
                .and_then(Value::as_object)
                .and_then(|context| context.get("originDeviceId"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            payload,
            ts_ms,
        };

        // Append to ring buffer, enforce capacity, and amortize retention
        // pruning to at most once per interval across concurrent publishers.
        {
            let mut buf = self.buffer.lock();
            let last_prune = self.last_prune_ms.load(Ordering::Relaxed);
            let prune_due = ts_ms.saturating_sub(last_prune) >= PRUNE_INTERVAL_MS
                && self
                    .last_prune_ms
                    .compare_exchange(last_prune, ts_ms, Ordering::Relaxed, Ordering::Relaxed)
                    .is_ok();
            if prune_due {
                retain_unexpired(&mut buf, ts_ms);
            }
            // Enforce capacity cap.
            if buf.len() >= BUFFER_CAPACITY {
                buf.pop_front();
            }
            buf.push_back(frame.clone());
        }

        // Broadcast — errors only occur when no receivers exist (fine).
        let _ = self.tx.send(frame.clone());

        frame
    }

    /// Subscribe to the bus.
    ///
    /// - `since`: the last sequence number the client has seen.  Pass `None`
    ///   (or `Some(0)`) to receive only new frames.
    /// - `now_ms`: the current wall clock in milliseconds (split out so tests
    ///   can pass a fixed value).
    ///
    /// Returns [`SubscribeResult::ResyncRequired`] when the oldest retained
    /// frame is *newer* than the client's cursor but still older than the
    /// retention window — meaning we've lost events the client expects.
    /// In practice this fires when `since < oldest_seq_in_buffer` *and* the
    /// buffer is non-empty (i.e. the ring has wrapped or expired those frames).
    pub fn subscribe(&self, since: Option<u64>, now_ms: i64) -> SubscribeResult {
        // Acquire the receiver first so we don't miss frames published between
        // snapshot and subscribe.
        let receiver = self.tx.subscribe();

        // `since=None` means the client wants only new frames — anchor at
        // the current high-water mark so the buffer's existing entries are
        // not replayed. `since=Some(0)` keeps the legacy "replay everything
        // we still have" semantics for explicit cold-starts.
        let since_seq = match since {
            Some(s) => s,
            None => self.seq_counter.load(Ordering::Relaxed),
        };
        let mut buf = self.buffer.lock();
        retain_unexpired(&mut buf, now_ms);

        // Determine the oldest retained seq.
        let oldest_seq = buf.front().map(|f| f.seq);
        // If the client is behind the oldest retained frame, we cannot replay
        // faithfully — signal a full resync.
        if since_seq > 0 {
            if let Some(oldest) = oldest_seq {
                if since_seq < oldest {
                    // The oldest retained frame has a higher seq than what the
                    // client last saw — gap detected.
                    return SubscribeResult::ResyncRequired;
                }
            }
        }

        // Collect frames with seq > since and ts_ms within the retention window.
        let replay: Vec<EventFrame> = buf
            .iter()
            .filter(|frame| frame.seq > since_seq)
            .cloned()
            .collect();

        SubscribeResult::Ok { receiver, replay }
    }

    /// Current number of frames in the replay buffer (test helper).
    #[cfg(test)]
    pub fn buffer_len(&self) -> usize {
        self.buffer.lock().len()
    }

    /// Oldest retained sequence number, or `None` if the buffer is empty (test helper).
    #[cfg(test)]
    pub fn oldest_seq(&self) -> Option<u64> {
        self.buffer.lock().front().map(|f| f.seq)
    }
}

fn retain_unexpired(buffer: &mut VecDeque<EventFrame>, at_ms: i64) {
    let general_cutoff = at_ms - RETENTION_MS;
    let request_cutoff = at_ms - REQUEST_SCOPED_RETENTION_MS;
    buffer.retain(|frame| {
        frame.ts_ms
            >= if frame.target_device_id.is_some() {
                request_cutoff
            } else {
                general_cutoff
            }
    });
}

fn register_remote_pending_request(payload: &Value) {
    let Some(context_value) = payload.get("remoteExecutionContext") else {
        return;
    };
    let Ok(context) = serde_json::from_value::<super::remote_execution::RemoteExecutionContext>(
        context_value.clone(),
    ) else {
        return;
    };
    let response_id = match payload.get("type").and_then(Value::as_str) {
        Some("permission_request") => payload.get("requestId"),
        Some("plugin_tool_exec") => payload.get("toolUseId"),
        Some("tool_result_review") => payload.get("reviewId"),
        Some("protocol_adapter_exec") => payload.get("execId"),
        _ => None,
    }
    .and_then(Value::as_str);
    if let Some(response_id) = response_id {
        let _ = super::remote_execution::global().register_pending(&context, response_id);
    }
}

// ---------------------------------------------------------------------------
// register_tauri_event
// ---------------------------------------------------------------------------

/// Register a Tauri event channel so all payloads are forwarded into `bus`.
///
/// Idempotent within the lifetime of one `AppHandle` — calling twice for the
/// same channel simply attaches a second listener (both forward the same
/// event, harmless but wasteful).  The caller is responsible for deduplication
/// if needed.
pub fn register_tauri_event(app: &tauri::AppHandle, bus: Arc<EventBus>, channel: &'static str) {
    use tauri::Listener as _;
    app.listen(channel, move |event| {
        let raw = event.payload();
        let payload: Value = serde_json::from_str(raw).unwrap_or(Value::String(raw.to_owned()));
        bus.publish(channel.to_owned(), payload);
    });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── publish increments seq, buffers frame, broadcasts ────────────────────

    #[test]
    fn publish_increments_seq() {
        let bus = EventBus::new();
        let mut rx = bus.tx.subscribe();

        let f1 = bus.publish("test://a".into(), json!(1));
        let f2 = bus.publish("test://b".into(), json!(2));

        assert_eq!(f1.seq, 1);
        assert_eq!(f2.seq, 2);
        assert_eq!(bus.buffer_len(), 2);

        // Both frames must be receivable.
        let r1 = rx.try_recv().expect("frame 1");
        let r2 = rx.try_recv().expect("frame 2");
        assert_eq!(r1.seq, 1);
        assert_eq!(r2.seq, 2);
    }

    // ── subscribe(None) → empty replay + active receiver ─────────────────────

    #[test]
    fn subscribe_none_returns_empty_replay() {
        let bus = EventBus::new();
        bus.publish("ev".into(), json!({}));

        // subscribe AFTER first publish with since=None → no replay.
        let result = bus.subscribe(None, now_ms());
        match result {
            SubscribeResult::Ok { replay, .. } => {
                assert!(replay.is_empty(), "since=None should yield empty replay");
            }
            SubscribeResult::ResyncRequired => panic!("unexpected ResyncRequired"),
        }
    }

    // ── subscribe(Some(0)) after 5 publishes → 5-event replay ────────────────

    #[tokio::test]
    async fn subscribe_since_zero_replays_all() {
        let bus = EventBus::new();
        for i in 0..5 {
            bus.publish("ev".into(), json!(i));
        }

        // Subscribe with since=Some(0) before new frames → get 5 replay events.
        let result = bus.subscribe(Some(0), now_ms());
        match result {
            SubscribeResult::Ok {
                replay,
                mut receiver,
            } => {
                assert_eq!(replay.len(), 5, "expected 5 replay frames");
                // Receiver is live: publish a new frame and it arrives.
                bus.publish("ev".into(), json!(99));
                let live = receiver.recv().await.expect("live frame");
                assert_eq!(live.seq, 6);
            }
            SubscribeResult::ResyncRequired => panic!("unexpected ResyncRequired"),
        }
    }

    // ── subscribe with too-old cursor → ResyncRequired ───────────────────────

    #[test]
    fn subscribe_too_old_returns_resync_required() {
        let bus = EventBus::new();
        // Publish a few frames.
        for _ in 0..5 {
            bus.publish("ev".into(), json!({}));
        }
        // since=1 means the client last saw seq=1; oldest retained is seq=1,
        // so since < oldest is false here. Simulate a gap by publishing past
        // the configured capacity so seq=1 is evicted from the ring.
        for _ in 0..BUFFER_CAPACITY {
            bus.publish("ev".into(), json!({}));
        }
        // Now oldest retained seq > 1.
        let oldest = bus.oldest_seq().unwrap();
        assert!(oldest > 1, "oldest should have advanced past seq=1");

        let result = bus.subscribe(Some(1), now_ms());
        assert!(
            matches!(result, SubscribeResult::ResyncRequired),
            "expected ResyncRequired when since < oldest retained seq"
        );
    }

    // ── ring buffer capacity eviction ─────────────────────────────────────────

    #[test]
    fn ring_buffer_evicts_oldest_at_capacity() {
        let bus = EventBus::new();
        // Publish BUFFER_CAPACITY + 5 frames.
        for i in 0..(BUFFER_CAPACITY + 5) {
            bus.publish("ev".into(), json!(i));
        }
        assert_eq!(
            bus.buffer_len(),
            BUFFER_CAPACITY,
            "buffer must not exceed capacity"
        );
        // Oldest seq should be 6 (the first 5 were evicted).
        let oldest = bus.oldest_seq().unwrap();
        assert_eq!(oldest, 6, "first 5 frames must be evicted");
    }

    // ── retention eviction: old entries pruned on next publish ────────────────

    #[test]
    fn retention_evicts_expired_entries() {
        // We cannot easily fake the clock inside `publish`, so we verify the
        // retention logic by abusing the buffer directly.
        //
        // Strategy: publish 3 frames normally, then manually inject a frame
        // with an ancient ts_ms, then publish one more to trigger eviction.
        let bus = EventBus::new();
        let _f1 = bus.publish("a".into(), json!(1));
        let _f2 = bus.publish("b".into(), json!(2));

        // Manually inject an ancient entry.
        {
            let mut buf = bus.buffer.lock();
            buf.push_back(EventFrame {
                event_type: "ancient".into(),
                seq: 9999,
                payload: json!({}),
                ts_ms: 1, // epoch + 1 ms → definitely expired
                target_device_id: None,
            });
        }
        assert_eq!(bus.buffer_len(), 3);

        // A new publish triggers eviction of entries older than RETENTION_MS.
        bus.last_prune_ms.store(0, Ordering::Relaxed);
        bus.publish("c".into(), json!(3));

        // The ancient entry should be gone.
        let buf = bus.buffer.lock();
        let has_ancient = buf.iter().any(|f| f.event_type == "ancient");
        assert!(
            !has_ancient,
            "ancient entry must be evicted by retention logic"
        );
    }

    // ── subscribe replays only frames newer than `since` ─────────────────────

    #[test]
    fn subscribe_with_valid_since_replays_tail() {
        let bus = EventBus::new();
        for i in 0..10 {
            bus.publish("ev".into(), json!(i));
        }
        // since=7 → expect frames with seq 8, 9, 10.
        let result = bus.subscribe(Some(7), now_ms());
        match result {
            SubscribeResult::Ok { replay, .. } => {
                assert_eq!(replay.len(), 3);
                assert_eq!(replay[0].seq, 8);
                assert_eq!(replay[2].seq, 10);
            }
            SubscribeResult::ResyncRequired => panic!("unexpected ResyncRequired"),
        }
    }

    #[test]
    fn request_scoped_frames_are_visible_only_to_the_origin_device() {
        let bus = EventBus::new();
        let frame = bus.publish(
            "claude://message".into(),
            json!({
                "type": "plugin_tool_exec",
                "remoteExecutionContext": {
                    "originDeviceId": "device-a"
                }
            }),
        );

        assert!(frame.visible_to("device-a"));
        assert!(!frame.visible_to("device-b"));
        assert!(
            serde_json::to_value(&frame)
                .unwrap()
                .get("target_device_id")
                .is_none(),
            "routing metadata must remain host-internal"
        );
    }

    #[test]
    fn publishing_a_proxy_request_registers_its_pending_response_id() {
        let context = crate::companion_api::remote_execution::global().register(
            "host-a",
            "device-a",
            "event-bus-pending-session",
            now_ms() as u64,
        );
        let bus = EventBus::new();
        bus.publish(
            "claude://message".into(),
            json!({
                "type": "plugin_tool_exec",
                "sessionId": context.session_id,
                "toolUseId": "tool-1",
                "remoteExecutionContext": context.clone(),
            }),
        );

        assert!(crate::companion_api::remote_execution::global()
            .validate_and_consume(
                &context,
                "device-a",
                "event-bus-pending-session",
                "tool-1",
                now_ms() as u64,
            )
            .is_ok());
    }

    #[test]
    fn request_scoped_payloads_expire_before_general_event_history() {
        let bus = EventBus::new();
        let now = now_ms();
        {
            let mut buffer = bus.buffer.lock();
            buffer.push_back(EventFrame {
                event_type: "claude://message".into(),
                seq: 100,
                payload: json!({ "secret": "short-lived" }),
                ts_ms: now - REQUEST_SCOPED_RETENTION_MS - 1,
                target_device_id: Some("device-a".into()),
            });
            buffer.push_back(EventFrame {
                event_type: "sync://updated".into(),
                seq: 101,
                payload: json!({ "table": "settings" }),
                ts_ms: now - REQUEST_SCOPED_RETENTION_MS - 1,
                target_device_id: None,
            });
        }

        bus.last_prune_ms.store(0, Ordering::Relaxed);
        bus.publish("test://tick".into(), json!({}));
        let buffer = bus.buffer.lock();
        assert!(!buffer.iter().any(|frame| frame.seq == 100));
        assert!(buffer.iter().any(|frame| frame.seq == 101));
    }
}
