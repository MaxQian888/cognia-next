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
//!        └─ VecDeque<EventFrame> (ring buffer, cap 200, 60 s retention)
//!             ▲
//!             └── on reconnect: subscribe(since) → replay
//! ```
//!
//! # Design decisions
//!
//! - **`broadcast::channel`** (capacity 256): slow receivers lag behind and
//!   get `RecvError::Lagged` — treated as a disconnect on the WS side.
//! - **Ring buffer**: capped at [`BUFFER_CAPACITY`] entries *and* entries
//!   older than [`RETENTION_MS`] are pruned on every publish.  This keeps
//!   the replay window bounded in both count and time.
//! - **Atomic `seq_counter`**: each published frame gets a monotonically
//!   increasing sequence number. The replay cursor `since` lets reconnecting
//!   clients request only frames they haven't seen.

use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
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
const BUFFER_CAPACITY: usize = 200;

/// How long (ms) to retain a frame in the replay buffer.
const RETENTION_MS: i64 = 60_000;

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
        })
    }

    /// Publish an event to all current subscribers and append it to the
    /// replay buffer.
    ///
    /// Returns the [`EventFrame`] that was broadcast (useful in tests).
    pub fn publish(&self, event_type: String, payload: Value) -> EventFrame {
        let seq = self.seq_counter.fetch_add(1, Ordering::Relaxed) + 1;
        let ts_ms = now_ms();

        let frame = EventFrame {
            event_type,
            seq,
            payload,
            ts_ms,
        };

        // Append to ring buffer, enforce capacity + retention.
        {
            let mut buf = self.buffer.lock();
            // Evict expired entries. In production frames arrive in
            // monotonic ts order so a `pop_front`-only sweep would
            // suffice; a full `retain` is robust to manually-injected
            // out-of-order frames (see retention_evicts_expired_entries
            // test) at the cost of one extra O(n) scan per publish.
            let cutoff = ts_ms - RETENTION_MS;
            buf.retain(|f| f.ts_ms >= cutoff);
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
        let buf = self.buffer.lock();

        // Determine the oldest retained seq.
        let oldest_seq = buf.front().map(|f| f.seq);
        let cutoff = now_ms - RETENTION_MS;

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
            .filter(|f| f.seq > since_seq && f.ts_ms >= cutoff)
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
        // so since < oldest is false here. Simulate a gap by publishing 200+
        // more frames so seq=1 is evicted from the ring.
        for _ in 0..200 {
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
            });
        }
        assert_eq!(bus.buffer_len(), 3);

        // A new publish triggers eviction of entries older than RETENTION_MS.
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
}
