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

/// Data-lane bytes one room may relay per quota window (ADR-0170 amendment).
///
/// The frame buckets above bound a burst; they do not bound a day. A room
/// whose DataChannel never opens relays everything, and a pair of admitted
/// peers could otherwise use the rendezvous as free bandwidth. 2 GiB a day is
/// several times what a phone mirroring its Host consumes, including media.
pub const DATA_LANE_ROOM_QUOTA_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Length of one quota window.
pub const DATA_LANE_QUOTA_WINDOW_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
/// Env var both deployments read to override [`DATA_LANE_ROOM_QUOTA_BYTES`].
pub const DATA_LANE_ROOM_QUOTA_ENV: &str = "SIGNALING_RELAY_ROOM_QUOTA_BYTES";

/// What [`RelayByteQuota::try_charge`] decided.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum QuotaDecision {
    /// The bytes were charged; `remaining` is what the window still allows.
    Allowed { remaining: u64 },
    /// The frame would cross the limit and was not charged. The window
    /// resets `retry_after_ms` from now.
    Exceeded { retry_after_ms: u64 },
}

/// A fixed-window byte budget for one room's data lane.
///
/// Room-scoped rather than connection-scoped: a reconnect must not reset it.
/// The clock is injected like [`TokenBucket`]'s, and the struct round-trips
/// through serde so the Worker can persist it in Durable Object storage.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RelayByteQuota {
    limit_bytes: u64,
    window_ms: f64,
    /// Start of the current window; `None` until the first charge.
    window_start_ms: Option<f64>,
    used_bytes: u64,
}

impl RelayByteQuota {
    pub fn new(limit_bytes: u64) -> Self {
        Self::with_window(limit_bytes, DATA_LANE_QUOTA_WINDOW_MS)
    }

    pub fn with_window(limit_bytes: u64, window_ms: f64) -> Self {
        Self {
            limit_bytes,
            window_ms,
            window_start_ms: None,
            used_bytes: 0,
        }
    }

    /// Charge `bytes` at `now_ms`. A frame that would cross the limit is
    /// refused whole rather than partly charged, so a peer that backs off and
    /// retries after the reset is not already in debt.
    pub fn try_charge(&mut self, bytes: u64, now_ms: f64) -> QuotaDecision {
        self.roll(now_ms);
        let start = *self.window_start_ms.get_or_insert(now_ms);
        let next = self.used_bytes.saturating_add(bytes);
        if next > self.limit_bytes {
            let reset_at = start + self.window_ms;
            return QuotaDecision::Exceeded {
                retry_after_ms: (reset_at - now_ms).max(0.0).ceil() as u64,
            };
        }
        self.used_bytes = next;
        QuotaDecision::Allowed {
            remaining: self.limit_bytes - next,
        }
    }

    /// Bytes charged in the current window.
    pub fn used_bytes(&self) -> u64 {
        self.used_bytes
    }

    pub fn limit_bytes(&self) -> u64 {
        self.limit_bytes
    }

    /// Whether the window has ended, so a holder may drop this entry: a fresh
    /// quota would behave identically.
    pub fn is_expired(&self, now_ms: f64) -> bool {
        match self.window_start_ms {
            Some(start) => now_ms >= start + self.window_ms,
            None => true,
        }
    }

    fn roll(&mut self, now_ms: f64) {
        if let Some(start) = self.window_start_ms {
            if now_ms >= start + self.window_ms {
                self.window_start_ms = None;
                self.used_bytes = 0;
            }
        }
    }
}

/// Error code both deployments send when a data-lane frame hits the quota.
/// The socket stays open: the signal lane still works, so the peers can go on
/// negotiating the DataChannel that would take the traffic off the relay.
pub const RELAY_QUOTA_EXCEEDED_CODE: &str = "relay_quota_exceeded";

/// The `message` for [`RELAY_QUOTA_EXCEEDED_CODE`], carrying the reset time
/// in a stable machine-readable suffix (`retry_after_ms=<n>`).
pub fn relay_quota_message(retry_after_ms: u64) -> String {
    format!("room relay quota exhausted; retry_after_ms={retry_after_ms}")
}

/// Read the reset time back out of a [`relay_quota_message`].
pub fn parse_relay_quota_retry_after_ms(message: &str) -> Option<u64> {
    let (_, tail) = message.split_once("retry_after_ms=")?;
    let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// Parse an override for [`DATA_LANE_ROOM_QUOTA_BYTES`]. Unset, empty, zero or
/// unparsable values fall back to the default; the quota cannot be switched
/// off, only resized.
pub fn room_quota_bytes_from(value: Option<&str>) -> u64 {
    value
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|bytes| *bytes > 0)
        .unwrap_or(DATA_LANE_ROOM_QUOTA_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quota_charges_until_the_limit_and_refuses_the_crossing_frame_whole() {
        let mut q = RelayByteQuota::with_window(100, 1_000.0);
        assert_eq!(q.try_charge(60, 0.0), QuotaDecision::Allowed { remaining: 40 });
        assert_eq!(q.try_charge(40, 10.0), QuotaDecision::Allowed { remaining: 0 });
        assert_eq!(
            q.try_charge(1, 250.0),
            QuotaDecision::Exceeded { retry_after_ms: 750 }
        );
        // The refused frame was not charged.
        assert_eq!(q.used_bytes(), 100);
    }

    #[test]
    fn quota_resets_when_the_window_ends() {
        let mut q = RelayByteQuota::with_window(10, 1_000.0);
        assert!(matches!(q.try_charge(10, 0.0), QuotaDecision::Allowed { .. }));
        assert!(matches!(q.try_charge(1, 999.0), QuotaDecision::Exceeded { .. }));
        assert!(!q.is_expired(999.0));
        assert!(q.is_expired(1_000.0));
        assert_eq!(q.try_charge(10, 1_000.0), QuotaDecision::Allowed { remaining: 0 });
    }

    #[test]
    fn a_fresh_quota_is_expired_and_starts_its_window_on_first_charge() {
        let mut q = RelayByteQuota::with_window(10, 1_000.0);
        assert!(q.is_expired(0.0));
        assert!(matches!(q.try_charge(1, 5_000.0), QuotaDecision::Allowed { .. }));
        assert!(!q.is_expired(5_999.0));
    }

    #[test]
    fn quota_round_trips_through_serde_with_its_usage() {
        let mut q = RelayByteQuota::new(DATA_LANE_ROOM_QUOTA_BYTES);
        q.try_charge(4_096, 0.0);
        let restored: RelayByteQuota =
            serde_json::from_str(&serde_json::to_string(&q).unwrap()).unwrap();
        assert_eq!(restored, q);
        assert_eq!(restored.used_bytes(), 4_096);
    }

    #[test]
    fn quota_message_round_trips_its_reset_time() {
        assert_eq!(
            parse_relay_quota_retry_after_ms(&relay_quota_message(90_000)),
            Some(90_000)
        );
        assert_eq!(parse_relay_quota_retry_after_ms("no reset time"), None);
    }

    #[test]
    fn quota_override_cannot_disable_the_quota() {
        assert_eq!(room_quota_bytes_from(None), DATA_LANE_ROOM_QUOTA_BYTES);
        assert_eq!(room_quota_bytes_from(Some("")), DATA_LANE_ROOM_QUOTA_BYTES);
        assert_eq!(room_quota_bytes_from(Some("0")), DATA_LANE_ROOM_QUOTA_BYTES);
        assert_eq!(room_quota_bytes_from(Some("nope")), DATA_LANE_ROOM_QUOTA_BYTES);
        assert_eq!(room_quota_bytes_from(Some(" 1048576 ")), 1_048_576);
    }

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
