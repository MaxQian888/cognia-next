//! Per-source-IP rate limiting (token bucket).
//!
//! The Cloudflare Worker leans on Cloudflare's edge for abuse control; a
//! self-hosted box has no such front, so this bucket blunts share-code
//! enumeration (the 71-bit codes are unguessable, but a flood still wastes I/O).
//!
//! Same shape as `cognia-signaling-core::limits::TokenBucket`: the clock is
//! injected per call so the type is trivially testable and clock-source
//! agnostic. One bucket is kept per active IP in the server crate.

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
    /// Create a full bucket with `capacity` burst tokens refilling at
    /// `refill_per_sec`.
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

    /// Whether the bucket has refilled to capacity — i.e. it is indistinguishable
    /// from a fresh bucket and can be evicted to keep the per-IP map bounded.
    pub fn is_full(&mut self, now_ms: f64) -> bool {
        self.refill(now_ms);
        self.tokens >= self.capacity
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
        assert!(b.try_take(1_000.0));
        assert!(b.try_take(1_000.0));
        assert!(b.try_take(1_000.0));
        assert!(!b.try_take(1_000.0), "bucket drained");
    }

    #[test]
    fn bucket_refills_over_time() {
        let mut b = TokenBucket::new(1, 100);
        assert!(b.try_take(0.0));
        assert!(!b.try_take(0.0));
        assert!(b.try_take(10.0), "should have refilled within 10ms");
    }

    #[test]
    fn refill_is_capped_at_capacity() {
        let mut b = TokenBucket::new(2, 10);
        assert!(b.try_take(1_000_000.0));
        assert!(b.try_take(1_000_000.0));
        assert!(!b.try_take(1_000_000.0), "never exceeds capacity");
    }

    #[test]
    fn is_full_tracks_drain_and_refill() {
        let mut b = TokenBucket::new(2, 1000);
        assert!(b.is_full(0.0), "fresh bucket is full");
        assert!(b.try_take(0.0));
        assert!(!b.is_full(0.0), "drained one token");
        // 1000 tokens/sec → fully refilled after a few ms.
        assert!(b.is_full(100.0));
    }

    #[test]
    fn round_trips_through_serde() {
        let b = TokenBucket::new(5, 10);
        let json = serde_json::to_string(&b).unwrap();
        let mut restored: TokenBucket = serde_json::from_str(&json).unwrap();
        assert!(restored.try_take(0.0));
    }
}
