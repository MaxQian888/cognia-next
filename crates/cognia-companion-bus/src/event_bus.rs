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
//!   get `RecvError::Lagged`. A live subscriber refills that gap from the
//!   ring buffer ([`LagRecovery`], [`LiveReceiver`]) and only reports the lag
//!   when the buffer has already dropped a frame it missed: one producer's
//!   burst no longer ends every subscriber's stream.
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
pub const BUFFER_CAPACITY: usize = 10_000;

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
    /// Server-only person routing; never accepted from a brain payload.
    #[serde(skip)]
    pub partition_account_id: Option<String>,
}

/// The sidecar's output channel: every turn's frames, whoever started it.
const SIDECAR_EVENT_CHANNEL: &str = "claude://message";

impl EventFrame {
    pub fn visible_to(&self, device_id: &str) -> bool {
        self.target_device_id
            .as_deref()
            .is_none_or(|target| target == device_id)
    }

    /// Whether one event-stream connection receives this frame.
    ///
    /// A device sees untargeted frames and its own. The loopback brain also
    /// sees every device's sidecar frames: it is the host's data plane, in the
    /// place the desktop renderer holds, and Tauri hands that renderer every
    /// sidecar event. Hiding a paired device's turn from it meant the host
    /// never kept the reply and never settled the turn's work submission.
    /// Other device-targeted frames (perf samples, consent asks, OAuth
    /// callbacks) stay with the device they were addressed to.
    pub fn visible_to_connection(
        &self,
        device_id: &str,
        scope: super::event_channels::ConnectionScope,
    ) -> bool {
        self.visible_to(device_id)
            || (scope == super::event_channels::ConnectionScope::Service
                && self.event_type == SIDECAR_EVENT_CHANNEL)
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
        /// Last sequence included in the replay snapshot. The WebSocket layer
        /// publishes this as its replay/live boundary.
        replay_cursor: u64,
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
    /// Highest sequence the ring buffer has dropped, by capacity or age. A
    /// refill after a lag is exact only above it ([`EventBus::frames_after`]).
    evicted_through: AtomicU64,
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
            evicted_through: AtomicU64::new(0),
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
        self.publish_targeted(event_type, payload, None, None)
    }

    /// Person events retain server-derived routing in replay without adding
    /// routing fields to their wire payload.
    pub fn publish_person_to(&self, event_type: String, payload: Value, device_id: String, account_id: String) -> EventFrame {
        self.publish_targeted(event_type, payload, Some(device_id), Some(account_id))
    }

    /// Replayable partition-wide notification. Delivery still rechecks current
    /// person standing; no per-device frame is needed for an invalidation.
    pub fn publish_person(
        &self,
        event_type: String,
        payload: Value,
        account_id: String,
    ) -> EventFrame {
        self.publish_targeted(event_type, payload, None, Some(account_id))
    }

    fn publish_targeted(&self, event_type: String, payload: Value, destination: Option<String>, partition_account_id: Option<String>) -> EventFrame {
        let seq = self.seq_counter.fetch_add(1, Ordering::Relaxed) + 1;
        let ts_ms = now_ms();
        register_remote_pending_request(&payload);

        let target_device_id = if partition_account_id.is_some() {
            destination
        } else {
            destination.or_else(|| payload
                .get("remoteExecutionContext")
                .and_then(Value::as_object)
                .and_then(|context| context.get("originDeviceId"))
                .and_then(Value::as_str)
                .map(str::to_owned))
        };
        let frame = EventFrame {
            partition_account_id,
            event_type,
            seq,
            target_device_id,
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
                if let Some(seq) = retain_unexpired(&mut buf, ts_ms) {
                    self.evicted_through.fetch_max(seq, Ordering::Relaxed);
                }
            }
            // Enforce capacity cap.
            if buf.len() >= BUFFER_CAPACITY {
                if let Some(evicted) = buf.pop_front() {
                    self.evicted_through.fetch_max(evicted.seq, Ordering::Relaxed);
                }
            }
            buf.push_back(frame.clone());
        }

        // Broadcast — errors only occur when no receivers exist (fine).
        let _ = self.tx.send(frame.clone());

        frame
    }

    /// Broadcast a sensitive frame to one authenticated device without adding
    /// it to replay history. OAuth authorization codes use this path so paired
    /// clients and reconnect cursors can never observe or replay them.
    pub fn publish_ephemeral_to(
        &self,
        event_type: String,
        payload: Value,
        target_device_id: String,
    ) -> EventFrame {
        let frame = EventFrame {
            event_type,
            seq: self.seq_counter.fetch_add(1, Ordering::Relaxed) + 1,
            payload,
            ts_ms: now_ms(),
            target_device_id: Some(target_device_id),
            partition_account_id: None,
        };
        let _ = self.tx.send(frame.clone());
        frame
    }

    /// One frame for a whole person partition, never added to replay.
    ///
    /// Untargeted but stamped with the partition: every transport delivers a
    /// stamped frame only to connections whose device is bound to that person
    /// right now (`person_partition::event_visible`), so it reaches exactly the
    /// person's devices without one frame per device. Live in-flight replies
    /// (`transcript://live`) use it. They arrive ten times a second; a frame
    /// per device would multiply that by every device the person ever
    /// registered and push slower subscribers off the shared channel. They are
    /// superseded within a tenth of a second, and a reconnect reads the
    /// persisted transcript, so replay would only hold stale copies.
    pub fn publish_person_ephemeral(
        &self,
        event_type: String,
        payload: Value,
        account_id: String,
    ) -> EventFrame {
        let frame = EventFrame {
            event_type,
            seq: self.seq_counter.fetch_add(1, Ordering::Relaxed) + 1,
            payload,
            ts_ms: now_ms(),
            target_device_id: None,
            partition_account_id: Some(account_id),
        };
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
        let high_water = self.seq_counter.load(Ordering::Relaxed);
        let since_seq = match since {
            Some(s) => s,
            None => high_water,
        };
        // A cursor past every seq this bus ever assigned was issued by an
        // earlier bus: the Host restarted and its numbering began again. Left
        // as `Ok` with nothing to replay, the client kept that cursor and
        // dropped every new frame as already seen until the count overtook
        // it. Only a resync gives it the cursor of this bus.
        if since_seq > high_water {
            return SubscribeResult::ResyncRequired;
        }
        let mut buf = self.buffer.lock();
        if let Some(seq) = retain_unexpired(&mut buf, now_ms) {
            self.evicted_through.fetch_max(seq, Ordering::Relaxed);
        }

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
        let replay_cursor = replay.last().map_or(since_seq, |frame| frame.seq);

        SubscribeResult::Ok {
            receiver,
            replay,
            replay_cursor,
        }
    }

    /// The retained frames after `seq`, in sequence order, or `None` when the
    /// buffer may have dropped one of them. A live subscriber that fell behind
    /// the broadcast channel refills its gap from here ([`LagRecovery`]).
    /// Ephemeral frames are never retained, so a refill cannot return them:
    /// they were never meant to be replayed.
    pub fn frames_after(&self, seq: u64) -> Option<Vec<EventFrame>> {
        let buf = self.buffer.lock();
        if self.evicted_through.load(Ordering::Relaxed) > seq {
            return None;
        }
        let mut frames: Vec<EventFrame> =
            buf.iter().filter(|frame| frame.seq > seq).cloned().collect();
        // Concurrent publishers can append slightly out of sequence order.
        frames.sort_by_key(|frame| frame.seq);
        Some(frames)
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

/// Drop expired frames; returns the highest sequence dropped, if any.
fn retain_unexpired(buffer: &mut VecDeque<EventFrame>, at_ms: i64) -> Option<u64> {
    let general_cutoff = at_ms - RETENTION_MS;
    let request_cutoff = at_ms - REQUEST_SCOPED_RETENTION_MS;
    let mut dropped = None;
    buffer.retain(|frame| {
        let keep = frame.ts_ms
            >= if frame.target_device_id.is_some() {
                request_cutoff
            } else {
                general_cutoff
            };
        if !keep {
            dropped = dropped.max(Some(frame.seq));
        }
        keep
    });
    dropped
}

// ---------------------------------------------------------------------------
// Lag recovery
// ---------------------------------------------------------------------------

/// One receive, as [`LagRecovery::admit`] sees it.
pub enum Received {
    /// A frame a refill queued ([`LagRecovery::take_refilled`]).
    Refilled(EventFrame),
    /// What the broadcast receiver returned.
    Live(Result<EventFrame, tokio::sync::broadcast::error::RecvError>),
}

/// Keeps a live subscriber going through a burst.
///
/// The broadcast channel holds [`BROADCAST_CAPACITY`] frames, so one producer
/// that publishes more than that before a subscriber's next poll overruns it.
/// Every subscriber used to end its stream on that `Lagged` (the WebSocket
/// closed, the relay asked the device to resync, an A2A turn failed), so one
/// busy member's agent output disconnected everyone on the Host. Instead the
/// subscriber refills the frames it missed from the ring buffer and delivers
/// them in order ahead of anything live. It reports the lag only when the
/// buffer has dropped a frame the subscriber missed. Ephemeral frames (never
/// retained) are the one thing a refill cannot bring back; their producers
/// resend state (live transcript keyframes).
///
/// After a refill the channel still holds frames at or below the refill's
/// newest sequence: copies of refilled frames, and ephemeral frames older than
/// what was just delivered. Both are skipped, so the stream stays in order.
///
/// Receive with `take_refilled` first and the broadcast receiver second, then
/// pass the result to `admit`. [`LiveReceiver`] does exactly that for a plain
/// receiver; a loop that owns its receiver does it inline.
pub struct LagRecovery {
    /// Highest sequence handed to the subscriber.
    delivered: u64,
    backlog: VecDeque<EventFrame>,
    /// Newest sequence any refill queued; the channel's frames at or below it
    /// are stale.
    refilled_through: u64,
}

impl LagRecovery {
    /// Start after `cursor`, the last sequence the subscriber has (its
    /// replay cursor, or the high-water mark for a live-only subscription).
    pub fn new(cursor: u64) -> Self {
        Self {
            delivered: cursor,
            backlog: VecDeque::new(),
            refilled_through: 0,
        }
    }

    /// The next refilled frame, which goes ahead of anything live.
    pub fn take_refilled(&mut self) -> Option<EventFrame> {
        self.backlog.pop_front()
    }

    /// What a receive means for the subscriber: a frame to deliver, the error
    /// to act on, or `None` when there is nothing to deliver yet (a refill was
    /// queued, or a stale frame arrived after one).
    pub fn admit(
        &mut self,
        bus: &EventBus,
        received: Received,
    ) -> Option<Result<EventFrame, tokio::sync::broadcast::error::RecvError>> {
        use tokio::sync::broadcast::error::RecvError;
        match received {
            Received::Refilled(frame) => {
                self.delivered = self.delivered.max(frame.seq);
                Some(Ok(frame))
            }
            Received::Live(Ok(frame)) => {
                if frame.seq <= self.refilled_through {
                    return None;
                }
                self.delivered = self.delivered.max(frame.seq);
                Some(Ok(frame))
            }
            Received::Live(Err(RecvError::Lagged(skipped))) => {
                let Some(frames) = bus.frames_after(self.delivered) else {
                    return Some(Err(RecvError::Lagged(skipped)));
                };
                log::info!(
                    "event bus: subscriber lagged by {skipped} frames; refilled {} from the replay buffer",
                    frames.len()
                );
                // Anything still queued is after `delivered` too, so the
                // refill holds it again.
                self.backlog.clear();
                for frame in frames {
                    self.refilled_through = self.refilled_through.max(frame.seq);
                    self.backlog.push_back(frame);
                }
                None
            }
            Received::Live(Err(RecvError::Closed)) => Some(Err(RecvError::Closed)),
        }
    }
}

/// A broadcast receiver with [`LagRecovery`]: `recv` reports `Lagged` only
/// when the replay buffer cannot cover the gap, and is cancel-safe.
pub struct LiveReceiver {
    bus: Arc<EventBus>,
    receiver: tokio::sync::broadcast::Receiver<EventFrame>,
    recovery: LagRecovery,
}

impl LiveReceiver {
    /// Wrap a receiver from [`EventBus::subscribe`]; `cursor` is the replay
    /// cursor that subscription returned.
    pub fn new(
        bus: Arc<EventBus>,
        receiver: tokio::sync::broadcast::Receiver<EventFrame>,
        cursor: u64,
    ) -> Self {
        Self {
            bus,
            receiver,
            recovery: LagRecovery::new(cursor),
        }
    }

    /// The next frame for this subscriber.
    pub async fn recv(&mut self) -> Result<EventFrame, tokio::sync::broadcast::error::RecvError> {
        loop {
            let received = match self.recovery.take_refilled() {
                Some(frame) => Received::Refilled(frame),
                None => Received::Live(self.receiver.recv().await),
            };
            if let Some(result) = self.recovery.admit(&self.bus, received) {
                return result;
            }
        }
    }
}

fn register_remote_pending_request(payload: &Value) {
    let Some(context_value) = payload.get("remoteExecutionContext") else {
        return;
    };
    let Ok(context) = serde_json::from_value::<super::remote_context::RemoteExecutionContext>(
        context_value.clone(),
    ) else {
        return;
    };
    let response_id = match payload.get("type").and_then(Value::as_str) {
        Some("permission_request") => payload.get("requestId"),
        Some("plugin_tool_exec") => payload.get("toolUseId"),
        Some("tool_result_review") => payload.get("reviewId"),
        Some("protocol_adapter_exec") => payload.get("execId"),
        // ADR-0188: a Router + Fusion reservation raised on a device's turn.
        // Only that device's ledger may answer it (`claude_call_reserve_respond`).
        Some("call_reserve_request") => payload.get("requestId"),
        _ => None,
    }
    .and_then(Value::as_str);
    if let Some(response_id) = response_id {
        let _ = super::remote_context::global().register_pending(&context, response_id);
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
#[cfg(feature = "tauri-host")]
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
    fn p6e_person_ephemeral_frames_are_one_stamped_frame_never_replayed() {
        let bus = EventBus::new();
        let crate::event_bus::SubscribeResult::Ok { mut receiver, .. } = bus.subscribe(None, 0) else { panic!("live"); };
        let before = bus.buffer_len();
        let frame = bus.publish_person_ephemeral("transcript://live".into(), json!({"sessionId":"a"}),
            "pb_person_a".into());
        // Partition visibility, not a device target, decides who receives it.
        assert_eq!(frame.partition_account_id.as_deref(), Some("pb_person_a"));
        assert_eq!(frame.target_device_id, None);
        assert_eq!(receiver.try_recv().unwrap().seq, frame.seq);
        assert_eq!(bus.buffer_len(), before);
        let SubscribeResult::Ok { replay, .. } = bus.subscribe(Some(0), 0) else { panic!("replay"); };
        assert!(replay.iter().all(|retained| retained.event_type != "transcript://live"));
    }

    #[test]
    fn p5_targeted_person_events_preserve_legacy_payload_and_replay_visibility() {
        let bus = EventBus::new();
        let boundary = bus.publish("sync://invalidate".into(), serde_json::json!({"table":"seed"}));
        let event = serde_json::json!({"sessionId":"a", "revision":1});
        let frame = bus.publish_person_to("transcript://revision".into(), event.clone(), "person-a-device".into(), "pb_person_a".into());
        assert!(frame.visible_to("person-a-device"));
        assert!(!frame.visible_to("person-b-device"));
        let wire = serde_json::to_value(&frame).unwrap();
        assert_eq!(wire["payload"], event);
        assert!(wire.get("target_device_id").is_none());
        assert!(wire.get("partition_account_id").is_none());
        assert_eq!(frame.partition_account_id.as_deref(), Some("pb_person_a"));
        let legacy = bus.publish("sync://invalidate".into(), serde_json::json!({"table":"messages"}));
        assert!(legacy.visible_to("person-b-device"));
        match bus.subscribe(Some(boundary.seq), now_ms()) {
            SubscribeResult::Ok { replay, .. } => {
                assert!(replay.iter().any(|event| event.seq == frame.seq && event.partition_account_id.as_deref() == Some("pb_person_a")));
                assert!(replay.iter().filter(|event| event.visible_to("person-b-device")).all(|event| event.event_type != "transcript://revision"));
            },
            _ => panic!("replay unavailable"),
        }
    }

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

    #[test]
    fn ephemeral_targeted_frames_are_live_only_and_device_scoped() {
        let bus = EventBus::new();
        let mut rx = bus.tx.subscribe();

        let frame = bus.publish_ephemeral_to(
            "connectors://lark-oauth/callback".into(),
            json!({ "code": "secret" }),
            "brain-local".into(),
        );

        assert!(frame.visible_to("brain-local"));
        assert!(!frame.visible_to("paired-phone"));
        assert_eq!(bus.buffer_len(), 0);
        assert_eq!(rx.try_recv().expect("live frame").seq, frame.seq);
        match bus.subscribe(Some(0), now_ms()) {
            SubscribeResult::Ok { replay, .. } => assert!(replay.is_empty()),
            SubscribeResult::ResyncRequired => panic!("empty replay cannot require resync"),
        }
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

    // ── a cursor from before a Host restart → resync, not a silent Ok ────────

    #[test]
    fn a_cursor_past_the_high_water_mark_requires_a_resync() {
        // The phone kept cursor 3850 from the Host's previous process; this bus
        // has only reached 2. An `Ok` here left it dropping every new frame.
        let bus = EventBus::new();
        bus.publish("ev".into(), json!(1));
        bus.publish("ev".into(), json!(2));
        assert!(matches!(
            bus.subscribe(Some(3850), now_ms()),
            SubscribeResult::ResyncRequired
        ));
        // At or below the high-water mark is an ordinary resume.
        match bus.subscribe(Some(2), now_ms()) {
            SubscribeResult::Ok { replay, .. } => assert!(replay.is_empty()),
            SubscribeResult::ResyncRequired => panic!("a current cursor resumes"),
        }
        match bus.subscribe(Some(1), now_ms()) {
            SubscribeResult::Ok { replay, .. } => assert_eq!(replay.len(), 1),
            SubscribeResult::ResyncRequired => panic!("a current cursor resumes"),
        }
        // A fresh bus has assigned nothing yet: any non-zero cursor is stale.
        assert!(matches!(
            EventBus::new().subscribe(Some(1), now_ms()),
            SubscribeResult::ResyncRequired
        ));
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
                ..
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
                partition_account_id: None,
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
    fn subscribe_reports_the_exact_replay_boundary() {
        let bus = EventBus::new();
        for value in 0..5 {
            bus.publish("event".into(), json!({ "value": value }));
        }

        match bus.subscribe(Some(2), now_ms()) {
            SubscribeResult::Ok {
                replay,
                replay_cursor,
                ..
            } => {
                assert_eq!(
                    replay.iter().map(|frame| frame.seq).collect::<Vec<_>>(),
                    vec![3, 4, 5]
                );
                assert_eq!(replay_cursor, 5);
            }
            SubscribeResult::ResyncRequired => panic!("unexpected resync requirement"),
        }
    }

    #[test]
    fn the_service_stream_sees_every_device_turn_but_nothing_else_addressed_to_one() {
        use crate::event_channels::ConnectionScope;
        let bus = EventBus::new();
        let turn = bus.publish(
            "claude://message".into(),
            json!({
                "type": "session_ended",
                "sessionId": "s1",
                "remoteExecutionContext": {
                    "requestId": "r1",
                    "hostId": "h",
                    "originDeviceId": "device-a",
                    "sessionId": "s1",
                    "createdAt": 1
                }
            }),
        );
        assert!(turn.visible_to_connection("device-a", ConnectionScope::Device));
        assert!(!turn.visible_to_connection("device-b", ConnectionScope::Device));
        assert!(turn.visible_to_connection("service", ConnectionScope::Service));

        let perf = bus.publish_ephemeral_to("perf://frame".into(), json!({}), "device-a".into());
        assert!(!perf.visible_to_connection("service", ConnectionScope::Service));
        assert!(perf.visible_to_connection("device-a", ConnectionScope::Device));
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
        let context = crate::remote_context::global().register(
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

        assert!(crate::remote_context::global()
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
    fn publishing_a_call_reserve_request_binds_it_to_the_origin_device() {
        let context = crate::remote_context::global().register(
            "host-a",
            "device-a",
            "event-bus-reserve-session",
            now_ms() as u64,
        );
        let bus = EventBus::new();
        let frame = bus.publish(
            "claude://message".into(),
            json!({
                "type": "call_reserve_request",
                "sessionId": context.session_id,
                "requestId": "reserve-1",
                "remoteExecutionContext": context.clone(),
            }),
        );

        assert!(frame.visible_to("device-a"));
        assert!(!frame.visible_to("device-b"));
        let registry = crate::remote_context::global();
        assert_eq!(
            registry.session_response_origin(
                "device-b",
                "event-bus-reserve-session",
                "reserve-1",
                now_ms() as u64,
            ),
            Err("REMOTE_SCOPE_DENIED")
        );
        assert!(registry
            .consume_session_response(
                "device-a",
                "event-bus-reserve-session",
                "reserve-1",
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
                partition_account_id: None,
            });
            buffer.push_back(EventFrame {
                event_type: "sync://updated".into(),
                seq: 101,
                payload: json!({ "table": "settings" }),
                ts_ms: now - REQUEST_SCOPED_RETENTION_MS - 1,
                target_device_id: None,
                partition_account_id: None,
            });
        }

        bus.last_prune_ms.store(0, Ordering::Relaxed);
        bus.publish("test://tick".into(), json!({}));
        let buffer = bus.buffer.lock();
        assert!(!buffer.iter().any(|frame| frame.seq == 100));
        assert!(buffer.iter().any(|frame| frame.seq == 101));
        drop(buffer);
        // The expired request frame is a drop a lag refill must not paper over.
        assert!(bus.frames_after(99).is_none());
        assert!(bus.frames_after(100).is_some());
    }

    // ── lag recovery ─────────────────────────────────────────────────────────

    fn live(bus: &Arc<EventBus>) -> LiveReceiver {
        let SubscribeResult::Ok {
            receiver,
            replay_cursor,
            ..
        } = bus.subscribe(None, now_ms())
        else {
            panic!("live subscription");
        };
        LiveReceiver::new(bus.clone(), receiver, replay_cursor)
    }

    async fn next(receiver: &mut LiveReceiver) -> Option<EventFrame> {
        tokio::time::timeout(std::time::Duration::from_millis(50), receiver.recv())
            .await
            .ok()
            .map(|result| result.expect("no lag"))
    }

    #[tokio::test]
    async fn a_burst_beyond_the_channel_is_refilled_in_order_without_duplicates() {
        let bus = EventBus::new();
        bus.publish("before".into(), json!({}));
        let mut receiver = live(&bus);
        for i in 0..(BROADCAST_CAPACITY * 4) {
            bus.publish("burst".into(), json!({ "i": i }));
        }
        for i in 0..(BROADCAST_CAPACITY * 4) {
            let frame = next(&mut receiver).await.expect("refilled frame");
            assert_eq!(frame.payload["i"], i);
            assert_eq!(frame.seq, i as u64 + 2);
        }
        assert!(next(&mut receiver).await.is_none(), "no channel copy repeats");
        // The stream goes on live after the refill.
        let after = bus.publish("after".into(), json!({}));
        assert_eq!(next(&mut receiver).await.map(|frame| frame.seq), Some(after.seq));
    }

    #[tokio::test]
    async fn stale_ephemeral_frames_never_arrive_after_newer_refilled_ones() {
        let bus = EventBus::new();
        let mut receiver = live(&bus);
        for _ in 0..(BROADCAST_CAPACITY * 2) {
            bus.publish_person_ephemeral("transcript://live".into(), json!({}), "pb".into());
        }
        let kept = bus.publish("sync://invalidate".into(), json!({}));
        for _ in 0..(BROADCAST_CAPACITY / 2) {
            bus.publish_person_ephemeral("transcript://live".into(), json!({}), "pb".into());
        }
        let newest = bus.publish_person_ephemeral("transcript://live".into(), json!({}), "pb".into());
        // The persisted frame comes back; the ephemeral ones before it are
        // gone, and the ones after it still arrive in order.
        let first = next(&mut receiver).await.expect("refilled frame");
        assert_eq!(first.seq, kept.seq);
        let mut last = first.seq;
        while let Some(frame) = next(&mut receiver).await {
            assert!(frame.seq > last, "in order");
            last = frame.seq;
        }
        assert_eq!(last, newest.seq);
    }

    #[tokio::test]
    async fn the_lag_is_reported_when_the_buffer_dropped_a_missed_frame() {
        let bus = EventBus::new();
        let mut receiver = live(&bus);
        for i in 0..(BUFFER_CAPACITY + BROADCAST_CAPACITY) {
            bus.publish("flood".into(), json!({ "i": i }));
        }
        assert!(matches!(
            receiver.recv().await,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_))
        ));
    }

    #[tokio::test]
    async fn a_second_lag_while_refilled_frames_wait_neither_repeats_nor_skips() {
        let bus = EventBus::new();
        let SubscribeResult::Ok {
            mut receiver,
            replay_cursor,
            ..
        } = bus.subscribe(None, now_ms())
        else {
            panic!("live subscription");
        };
        let mut recovery = LagRecovery::new(replay_cursor);
        for i in 0..(BROADCAST_CAPACITY * 2) {
            bus.publish("one".into(), json!({ "i": i }));
        }
        let mut seen = Vec::new();
        let mut receive = |recovery: &mut LagRecovery,
                           receiver: &mut tokio::sync::broadcast::Receiver<EventFrame>| {
            loop {
                let received = match recovery.take_refilled() {
                    Some(frame) => Received::Refilled(frame),
                    None => match receiver.try_recv() {
                        Ok(frame) => Received::Live(Ok(frame)),
                        Err(tokio::sync::broadcast::error::TryRecvError::Lagged(n)) => {
                            Received::Live(Err(tokio::sync::broadcast::error::RecvError::Lagged(n)))
                        }
                        Err(_) => return None,
                    },
                };
                if let Some(result) = recovery.admit(&bus, received) {
                    return Some(result.expect("covered").seq);
                }
            }
        };
        for _ in 0..10 {
            seen.push(receive(&mut recovery, &mut receiver).unwrap());
        }
        // A second burst lands while most of the first refill still waits.
        for i in 0..(BROADCAST_CAPACITY * 2) {
            bus.publish("two".into(), json!({ "i": i }));
        }
        while let Some(seq) = receive(&mut recovery, &mut receiver) {
            seen.push(seq);
        }
        let expected: Vec<u64> = (1..=(BROADCAST_CAPACITY as u64 * 4)).collect();
        assert_eq!(seen, expected);
    }
}
