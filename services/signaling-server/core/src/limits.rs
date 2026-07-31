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
    fn round_trips_through_serde() {
        // The Worker persists the bucket into a WebSocket attachment and
        // restores it on the next message after hibernation.
        let b = TokenBucket::new(5, 10);
        let json = serde_json::to_string(&b).unwrap();
        let mut restored: TokenBucket = serde_json::from_str(&json).unwrap();
        assert!(restored.try_take(0.0));
    }
}
