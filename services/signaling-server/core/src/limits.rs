//! Per-connection rate limiting (token bucket).
//!
//! Gates inbound frames so a misbehaving client can't flood a room or burn
//! CPU on the rendezvous service. Shared between the native axum server and
//! the Cloudflare Worker, so the clock is **injected** (`now_ms`) rather than
//! read from `std::time::Instant`: `Instant` does not exist on `wasm32`, and
//! the Worker must persist/restore bucket state across Durable Object
//! hibernation (hence the `Serialize`/`Deserialize` derives).
//!
//! Numbers (per connection): capacity 20 frames, refill 10 frames/sec. In
//! normal operation (one offer, a handful of ICE candidates, a few pings) we
//! never trip this. Misbehaving clients drop below their refill rate and the
//! bucket eventually depletes; the server returns `rate_limited` and closes
//! the connection.

use serde::{Deserialize, Serialize};

use crate::proto::RelayLane;

/// Signal-lane budget: SDP / ICE / `hello`. One offer, a handful of ICE
/// candidates, a few pings — never trips this in normal operation.
pub const SIGNAL_RATE_CAPACITY: u32 = 20;
pub const SIGNAL_RATE_REFILL_PER_SEC: u32 = 10;
/// Soft per-frame cap on the signal lane. SDP/ICE envelopes sit well under.
pub const SIGNAL_MAX_FRAME_BYTES: usize = 8 * 1024;

/// Data-lane budget: application frames relayed in place of a DataChannel.
/// Sized for the peers' own framing — a 1 MiB logical message is 32 chunks
/// of 32 KiB, a 10 MiB media resource is 512 chunks of 20 KiB — so one
/// burst fits the bucket and sustained traffic settles at the refill rate.
pub const DATA_RATE_CAPACITY: u32 = 256;
pub const DATA_RATE_REFILL_PER_SEC: u32 = 64;
/// Per-frame cap on the data lane. A 32 KiB text chunk grows to ~45 KiB
/// once base64'd twice (AES-GCM ciphertext inside a JSON envelope inside a
/// JSON frame); a 20 KiB binary chunk to ~40 KiB. This is also the hard
/// `max_message_size` on the WS upgrade, so nothing larger ever parses.
pub const DATA_MAX_FRAME_BYTES: usize = 64 * 1024;

/// The soft per-frame cap for a lane, in bytes.
pub fn max_frame_bytes(lane: RelayLane) -> usize {
    match lane {
        RelayLane::Signal => SIGNAL_MAX_FRAME_BYTES,
        RelayLane::Data => DATA_MAX_FRAME_BYTES,
    }
}

/// One bucket per lane. A data burst cannot starve the handshake and a
/// chatty handshake cannot eat the data budget.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaneBuckets {
    signal: TokenBucket,
    data: TokenBucket,
}

impl LaneBuckets {
    pub fn new() -> Self {
        Self {
            signal: TokenBucket::new(SIGNAL_RATE_CAPACITY, SIGNAL_RATE_REFILL_PER_SEC),
            data: TokenBucket::new(DATA_RATE_CAPACITY, DATA_RATE_REFILL_PER_SEC),
        }
    }

    /// Try to consume one token from `lane`'s bucket at wall-clock `now_ms`.
    pub fn try_take(&mut self, lane: RelayLane, now_ms: f64) -> bool {
        match lane {
            RelayLane::Signal => self.signal.try_take(now_ms),
            RelayLane::Data => self.data.try_take(now_ms),
        }
    }
}

impl Default for LaneBuckets {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenBucket {
    capacity: f64,
    tokens: f64,
    refill_per_sec: f64,
    /// Wall-clock (ms) of the last refill. `0.0` until the first `try_take`,
    /// which is harmless: the bucket starts full and refill is capped at
    /// `capacity`, so the initial (large) elapsed delta is a no-op.
    last_ms: f64,
}

impl TokenBucket {
    /// Create a full bucket. The clock is supplied per call to
    /// [`try_take`](Self::try_take), so construction needs no timestamp —
    /// keeping the native server's call site unchanged.
    pub fn new(capacity: u32, refill_per_sec: u32) -> Self {
        Self {
            capacity: capacity as f64,
            tokens: capacity as f64,
            refill_per_sec: refill_per_sec as f64,
            last_ms: 0.0,
        }
    }

    /// Try to consume one token at wall-clock `now_ms`. Returns `true` if
    /// accepted, `false` if the bucket is empty.
    pub fn try_take(&mut self, now_ms: f64) -> bool {
        self.refill(now_ms);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    fn refill(&mut self, now_ms: f64) {
        let elapsed = (now_ms - self.last_ms).max(0.0) / 1000.0;
        if elapsed > 0.0 {
            self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity);
            self.last_ms = now_ms;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_bucket_accepts_capacity_calls() {
        let mut b = TokenBucket::new(3, 10);
        // All calls at the same instant — no refill between them.
        assert!(b.try_take(1_000.0));
        assert!(b.try_take(1_000.0));
        assert!(b.try_take(1_000.0));
        assert!(!b.try_take(1_000.0), "bucket drained");
    }

    #[test]
    fn bucket_refills_over_time() {
        let mut b = TokenBucket::new(1, 100); // capacity 1, fast refill
        assert!(b.try_take(0.0));
        assert!(!b.try_take(0.0));
        // 100 tokens/sec → one token after 10 ms.
        assert!(b.try_take(10.0), "should have refilled within 10ms");
    }

    #[test]
    fn refill_is_capped_at_capacity() {
        let mut b = TokenBucket::new(2, 10);
        // A long idle gap must not over-fill beyond capacity.
        assert!(b.try_take(1_000_000.0));
        assert!(b.try_take(1_000_000.0));
        assert!(!b.try_take(1_000_000.0), "never exceeds capacity");
    }

    #[test]
    fn lanes_draw_from_separate_buckets() {
        let mut lanes = LaneBuckets::new();
        // Drain the signal lane completely...
        for _ in 0..SIGNAL_RATE_CAPACITY {
            assert!(lanes.try_take(RelayLane::Signal, 0.0));
        }
        assert!(!lanes.try_take(RelayLane::Signal, 0.0));
        // ...and the data lane is untouched, with its own (wider) capacity.
        for _ in 0..DATA_RATE_CAPACITY {
            assert!(lanes.try_take(RelayLane::Data, 0.0));
        }
        assert!(!lanes.try_take(RelayLane::Data, 0.0));
    }

    #[test]
    fn data_lane_admits_a_full_media_burst() {
        // 10 MiB at 20 KiB per chunk is 512 frames; with the 64/s refill a
        // burst of that size clears in well under the peers' 15 s chunk
        // timeout instead of tripping `rate_limited` half-way through.
        let mut lanes = LaneBuckets::new();
        let mut accepted = 0;
        for i in 0..512 {
            // ~8 s of wall clock for the whole burst.
            if lanes.try_take(RelayLane::Data, i as f64 * 16.0) {
                accepted += 1;
            }
        }
        assert_eq!(accepted, 512);
    }

    #[test]
    fn frame_caps_follow_the_lane() {
        assert_eq!(max_frame_bytes(RelayLane::Signal), 8 * 1024);
        assert_eq!(max_frame_bytes(RelayLane::Data), 64 * 1024);
    }

    #[test]
    fn lane_buckets_round_trip_through_serde() {
        let lanes = LaneBuckets::new();
        let json = serde_json::to_string(&lanes).unwrap();
        let mut restored: LaneBuckets = serde_json::from_str(&json).unwrap();
        assert!(restored.try_take(RelayLane::Data, 0.0));
    }

    #[test]
    fn round_trips_through_serde() {
        // The Worker persists the bucket into a WebSocket attachment and
        // restores it on the next message after hibernation.
        let b = TokenBucket::new(5, 10);
        let json = serde_json::to_string(&b).unwrap();
        let mut restored: TokenBucket = serde_json::from_str(&json).unwrap();
        assert!(restored.try_take(0.0));
    }
}
