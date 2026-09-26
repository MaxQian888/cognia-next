//! Per-subscriber frame batching for the Companion event fan-out (ADR-0127 §2).
//!
//! The sidecar emits one `claude://message` frame per token; the WebSocket and
//! WebRTC send loops used to ship one JSON frame per event, uncompressed, which
//! at 100 tok/s is ~100 frames/s per subscriber and is what pushed slow phones
//! into `broadcast::Lagged` → close-and-resync.
//!
//! This batcher lives *only* in the send loops (`ws.rs`, `signaling/dispatch.rs`)
//! — never in [`super::event_bus`], so the in-process A2A consumer keeps
//! per-frame semantics. Rules:
//!
//! - **50 ms window.** An idle subscriber's first frame goes out immediately
//!   (first-token latency unchanged); frames arriving inside the window that
//!   follows accumulate and go out together when it expires. While the stream
//!   is continuous this yields ≤ 20 sends/s regardless of token rate — at
//!   100 tok/s that is the ≥ 80 % cut ADR-0127 §5 asks for (33 ms would have
//!   given ~31 sends/s, −69 %).
//! - **Same channel only.** A frame for a different channel flushes whatever
//!   is pending before it is considered, so a batch is always
//!   `frames[i].event_type == channel` and `seq` is strictly increasing.
//! - **Control frames flush.** Callers drain the batcher before `ping`,
//!   `subscribed`, `resync_required` and before closing.
//! - **A batch of one is a plain frame.** The wire only sees the batch
//!   envelope when it saves something, so servers and clients stay compatible
//!   in both directions.
//!
//! The struct is a pure state machine — time is passed in — so the policy is
//! unit-tested without a runtime; the loops feed it `tokio::time::Instant`.

use tokio::time::{Duration, Instant};

use super::event_bus::EventFrame;

/// Fixed batching window (ADR-0127 §2 decided against an adaptive window; the
/// value was raised from 33 ms to 50 ms so the §5 −80 % bar holds at 100 tok/s).
pub const BATCH_WINDOW: Duration = Duration::from_millis(50);

/// Upper bound on frames per batch so a pathological burst still produces
/// bounded envelopes.
pub const MAX_BATCH_FRAMES: usize = 256;

/// Upper bound on the serialized payload bytes per batch. The WebRTC data
/// channel refuses messages above 1 MiB (`datachannel_framing`), and a
/// refused *batch* would lose every frame in it — so a batch closes well
/// before that. Measured on `payload` only (the envelope overhead is small).
pub const MAX_BATCH_BYTES: usize = 256 * 1024;

fn payload_bytes(frame: &EventFrame) -> usize {
    serde_json::to_vec(&frame.payload)
        .map(|v| v.len())
        .unwrap_or(0)
}

/// One send-loop's batching state.
#[derive(Debug, Default)]
pub struct EventBatcher {
    /// Frames waiting for the window to expire. Invariant: all share
    /// `event_type` and have increasing `seq`.
    pending: Vec<EventFrame>,
    /// Serialized payload bytes currently in `pending`.
    pending_bytes: usize,
    /// When the current window ends. `None` ⇒ idle (next frame goes out now).
    deadline: Option<Instant>,
}

impl EventBatcher {
    pub fn new() -> Self {
        Self::default()
    }

    /// Offer a frame. Returns every batch that must be sent *now*, in order.
    ///
    /// - idle ⇒ `[frame]` is returned immediately and a window opens;
    /// - window open, same channel as pending (or nothing pending) ⇒ buffered,
    ///   nothing returned (unless the batch hit [`MAX_BATCH_FRAMES`]);
    /// - window open, different channel ⇒ the pending batch is returned first
    ///   and the new frame is buffered behind it.
    pub fn push(&mut self, frame: EventFrame, now: Instant) -> Vec<Vec<EventFrame>> {
        let mut out = Vec::new();

        // Window expired without the loop noticing (e.g. it was busy sending):
        // treat as due first so ordering stays exact.
        if let Some(due) = self.take_due(now) {
            out.push(due);
        }

        if self.deadline.is_none() {
            // Idle: first frame goes out immediately, window opens.
            self.deadline = Some(now + BATCH_WINDOW);
            out.push(vec![frame]);
            return out;
        }

        let bytes = payload_bytes(&frame);
        if let Some(last) = self.pending.last() {
            let channel_changed = last.event_type != frame.event_type;
            let too_big = self.pending_bytes + bytes > MAX_BATCH_BYTES;
            if channel_changed || too_big {
                out.push(self.take_pending());
            }
        }
        self.pending.push(frame);
        self.pending_bytes += bytes;
        if self.pending.len() >= MAX_BATCH_FRAMES || self.pending_bytes >= MAX_BATCH_BYTES {
            out.push(self.take_pending());
        }
        out
    }

    fn take_pending(&mut self) -> Vec<EventFrame> {
        self.pending_bytes = 0;
        std::mem::take(&mut self.pending)
    }

    /// The instant the loop should wake to flush, if a window is open.
    pub fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    /// Called when the window timer fires (or any time): if the window has
    /// expired, returns the pending batch (possibly empty ⇒ `None`) and either
    /// closes the window (nothing was pending ⇒ back to idle) or opens the
    /// next one (something was pending ⇒ the stream is continuous).
    pub fn take_due(&mut self, now: Instant) -> Option<Vec<EventFrame>> {
        let deadline = self.deadline?;
        if now < deadline {
            return None;
        }
        if self.pending.is_empty() {
            self.deadline = None;
            return None;
        }
        self.deadline = Some(now + BATCH_WINDOW);
        Some(self.take_pending())
    }

    /// Flush everything pending regardless of the window (control frames,
    /// shutdown). The window itself is left as-is so a stream that continues
    /// after the control frame keeps its cadence.
    pub fn drain(&mut self) -> Option<Vec<EventFrame>> {
        if self.pending.is_empty() {
            None
        } else {
            Some(self.take_pending())
        }
    }

    #[cfg(test)]
    fn pending_len(&self) -> usize {
        self.pending.len()
    }
}

/// Group an already-ordered replay burst into same-channel runs of at most
/// [`MAX_BATCH_FRAMES`] frames / [`MAX_BATCH_BYTES`] payload bytes. No timing
/// involved — replay is sent as fast as the socket accepts it, and batching
/// only cuts the frame count.
pub fn chunk_replay(frames: Vec<EventFrame>) -> Vec<Vec<EventFrame>> {
    let mut out: Vec<Vec<EventFrame>> = Vec::new();
    let mut run_bytes = 0usize;
    for frame in frames {
        let bytes = payload_bytes(&frame);
        match out.last_mut() {
            Some(run)
                if run.len() < MAX_BATCH_FRAMES
                    && run_bytes + bytes <= MAX_BATCH_BYTES
                    && run.last().is_some_and(|f| f.event_type == frame.event_type) =>
            {
                run.push(frame);
                run_bytes += bytes;
            }
            _ => {
                out.push(vec![frame]);
                run_bytes = bytes;
            }
        }
    }
    out
}

/// WebSocket wire encoding: a single frame is the plain [`EventFrame`]; two or
/// more become `{"type":"event_batch","channel","seq_from","seq_to","frames"}`.
/// The discriminator cannot collide with a channel name — real channels always
/// contain `://`.
pub fn encode_ws_batch(batch: &[EventFrame]) -> Result<String, serde_json::Error> {
    match batch {
        [single] => serde_json::to_string(single),
        _ => serde_json::to_string(&serde_json::json!({
            "type": "event_batch",
            "channel": batch.first().map(|f| f.event_type.as_str()).unwrap_or(""),
            "seq_from": batch.first().map(|f| f.seq).unwrap_or(0),
            "seq_to": batch.last().map(|f| f.seq).unwrap_or(0),
            "frames": batch,
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frame(channel: &str, seq: u64) -> EventFrame {
        EventFrame {
            event_type: channel.to_owned(),
            seq,
            payload: json!({ "seq": seq }),
            ts_ms: 0,
            target_device_id: None,
        }
    }

    #[test]
    fn idle_first_frame_is_sent_immediately_and_opens_a_window() {
        let mut b = EventBatcher::new();
        let t0 = Instant::now();
        let out = b.push(frame("claude://message", 1), t0);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].len(), 1);
        assert_eq!(out[0][0].seq, 1);
        assert_eq!(b.deadline(), Some(t0 + BATCH_WINDOW));
        assert_eq!(b.pending_len(), 0);
    }

    #[test]
    fn frames_inside_the_window_accumulate_and_flush_when_due() {
        let mut b = EventBatcher::new();
        let t0 = Instant::now();
        assert_eq!(b.push(frame("claude://message", 1), t0).len(), 1);
        for seq in 2..=10 {
            let out = b.push(
                frame("claude://message", seq),
                t0 + Duration::from_millis(seq * 2),
            );
            assert!(out.is_empty(), "frame {seq} must be buffered");
        }
        assert_eq!(b.pending_len(), 9);
        // Not due yet.
        assert!(b
            .take_due(t0 + BATCH_WINDOW - Duration::from_millis(1))
            .is_none());
        // Due: one batch of 9 (2..=10), and the window rolls forward.
        let due = b.take_due(t0 + BATCH_WINDOW).expect("batch due");
        assert_eq!(due.len(), 9);
        assert_eq!(due.first().unwrap().seq, 2);
        assert_eq!(due.last().unwrap().seq, 10);
        assert_eq!(b.deadline(), Some(t0 + BATCH_WINDOW + BATCH_WINDOW));
    }

    #[test]
    fn a_quiet_window_returns_to_idle() {
        let mut b = EventBatcher::new();
        let t0 = Instant::now();
        b.push(frame("claude://message", 1), t0);
        assert!(b.take_due(t0 + BATCH_WINDOW).is_none());
        assert!(b.deadline().is_none(), "idle again");
        // The next frame is immediate again (first-token latency preserved).
        let out = b.push(
            frame("claude://message", 2),
            t0 + Duration::from_millis(500),
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0][0].seq, 2);
    }

    #[test]
    fn a_channel_change_flushes_the_pending_batch_first() {
        let mut b = EventBatcher::new();
        let t0 = Instant::now();
        b.push(frame("claude://message", 1), t0);
        assert!(b
            .push(frame("claude://message", 2), t0 + Duration::from_millis(1))
            .is_empty());
        assert!(b
            .push(frame("claude://message", 3), t0 + Duration::from_millis(2))
            .is_empty());
        let out = b.push(frame("agent://message", 4), t0 + Duration::from_millis(3));
        // The claude batch (2,3) is emitted; the agent frame waits for the window.
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].iter().map(|f| f.seq).collect::<Vec<_>>(), vec![2, 3]);
        assert_eq!(b.pending_len(), 1);
        let due = b.take_due(t0 + BATCH_WINDOW).unwrap();
        assert_eq!(due[0].event_type, "agent://message");
    }

    #[test]
    fn a_stale_window_is_flushed_before_the_new_frame_is_placed() {
        let mut b = EventBatcher::new();
        let t0 = Instant::now();
        b.push(frame("c://x", 1), t0);
        b.push(frame("c://x", 2), t0 + Duration::from_millis(5));
        // The loop was busy; the next push arrives well after the deadline.
        let out = b.push(frame("c://x", 3), t0 + Duration::from_millis(100));
        assert_eq!(out.len(), 1, "stale pending batch flushed first");
        assert_eq!(out[0][0].seq, 2);
        assert_eq!(b.pending_len(), 1, "seq 3 buffered in the rolled window");
    }

    #[test]
    fn drain_flushes_pending_without_closing_the_window() {
        let mut b = EventBatcher::new();
        let t0 = Instant::now();
        b.push(frame("c://x", 1), t0);
        b.push(frame("c://x", 2), t0 + Duration::from_millis(1));
        assert!(b.drain().is_some());
        assert!(b.drain().is_none());
        assert!(b.deadline().is_some());
    }

    #[test]
    fn max_batch_frames_bounds_a_burst() {
        let mut b = EventBatcher::new();
        let t0 = Instant::now();
        b.push(frame("c://x", 0), t0);
        let mut emitted = 0;
        for seq in 1..=(MAX_BATCH_FRAMES as u64 * 2) {
            emitted += b
                .push(frame("c://x", seq), t0 + Duration::from_millis(1))
                .len();
        }
        assert_eq!(emitted, 2);
        assert_eq!(b.pending_len(), 0);
    }

    /// A run of large frames splits before the 1 MiB DataChannel cap would
    /// refuse the whole batch (which would silently lose every frame in it).
    #[test]
    fn byte_budget_splits_large_frames() {
        let big = |seq: u64| EventFrame {
            event_type: "claude://message".into(),
            seq,
            payload: json!({ "blob": "x".repeat(100 * 1024) }),
            ts_ms: 0,
            target_device_id: None,
        };
        let mut b = EventBatcher::new();
        let t0 = Instant::now();
        b.push(big(0), t0);
        let mut emitted: Vec<Vec<EventFrame>> = Vec::new();
        for seq in 1..=6 {
            emitted.extend(b.push(big(seq), t0 + Duration::from_millis(1)));
        }
        if let Some(rest) = b.drain() {
            emitted.push(rest);
        }
        assert!(
            emitted.len() >= 3,
            "≈100 KB frames must split into ≤ 256 KB batches"
        );
        for batch in &emitted {
            let bytes: usize = batch.iter().map(payload_bytes).sum();
            assert!(
                bytes <= MAX_BATCH_BYTES,
                "batch of {} bytes exceeds budget",
                bytes
            );
        }
        // Replay grouping honours the same budget.
        let runs = chunk_replay((0..6).map(big).collect());
        assert!(runs.len() >= 3);
        for run in &runs {
            assert!(run.iter().map(payload_bytes).sum::<usize>() <= MAX_BATCH_BYTES);
        }
    }

    #[test]
    fn chunk_replay_groups_same_channel_runs() {
        let frames = vec![
            frame("a://x", 1),
            frame("a://x", 2),
            frame("b://y", 3),
            frame("a://x", 4),
        ];
        let runs = chunk_replay(frames);
        assert_eq!(runs.len(), 3);
        assert_eq!(runs[0].len(), 2);
        assert_eq!(runs[1].len(), 1);
        assert_eq!(runs[2].len(), 1);
    }

    #[test]
    fn ws_encoding_uses_plain_frame_for_one_and_envelope_for_many() {
        let one = encode_ws_batch(&[frame("claude://message", 7)]).unwrap();
        let v: serde_json::Value = serde_json::from_str(&one).unwrap();
        assert_eq!(v["type"], "claude://message");
        assert_eq!(v["seq"], 7);

        let many =
            encode_ws_batch(&[frame("claude://message", 7), frame("claude://message", 9)]).unwrap();
        let v: serde_json::Value = serde_json::from_str(&many).unwrap();
        assert_eq!(v["type"], "event_batch");
        assert_eq!(v["channel"], "claude://message");
        assert_eq!(v["seq_from"], 7);
        assert_eq!(v["seq_to"], 9);
        assert_eq!(v["frames"].as_array().unwrap().len(), 2);
        assert_eq!(v["frames"][1]["seq"], 9);
        // Inner frames keep the plain shape so a client can reuse its handler.
        assert_eq!(v["frames"][0]["type"], "claude://message");
    }

    /// ADR-0127 §5: at 100 tok/s the wire sees ≥ 80 % fewer sends.
    #[test]
    fn hundred_tokens_per_second_cuts_sends_by_at_least_80_percent() {
        let mut b = EventBatcher::new();
        let t0 = Instant::now();
        let mut sends = 0usize;
        let mut first_latency = None;
        // 1 s of tokens, one every 10 ms; the loop wakes at each deadline.
        // Simulate the real loop: the timer arm fires exactly at each deadline.
        for i in 0..100u64 {
            let now = t0 + Duration::from_millis(i * 10);
            while let Some(w) = b.deadline() {
                if now < w {
                    break;
                }
                if b.take_due(w).is_some() {
                    sends += 1;
                }
                if b.deadline() == Some(w) {
                    break;
                }
            }
            let out = b.push(frame("claude://message", i + 1), now);
            if i == 0 {
                assert_eq!(out.len(), 1, "first token immediate");
                first_latency = Some(Duration::ZERO);
            }
            sends += out.len();
        }
        if b.drain().is_some() {
            sends += 1;
        }
        assert_eq!(first_latency, Some(Duration::ZERO));
        // Steady state is ≤ 20 sends/s (one per window) — the ≥ 80 % cut at
        // 100 tok/s — plus the one immediate first frame that keeps
        // first-token latency at zero.
        assert!(
            sends <= 1 + 100 / 5,
            "expected ≤ 21 sends for 100 tokens, got {sends}"
        );
    }
}
