//! Per-connection rate limiting.
//!
//! A trivial token bucket gates inbound frames to prevent a misbehaving
//! client from flooding the room or burning CPU on the rendezvous service.
//! Outbound flow is bounded by the per-peer mpsc channel capacity
//! ([`crate::room::PEER_OUTBOUND_BUFFER`]).
//!
//! Numbers (per connection):
//!   - Capacity: 20 frames
//!   - Refill: 10 frames/sec
//!
//! In normal operation (one offer, a handful of ICE candidates, a few
//! pings) we never trip this. Misbehaving clients drop below their refill
//! rate and the bucket eventually depletes; the server returns
//! `rate_limited` and closes the connection.

use std::time::Instant;

#[derive(Debug)]
pub struct TokenBucket {
    capacity: f64,
    tokens: f64,
    refill_per_sec: f64,
    last: Instant,
}

impl TokenBucket {
    pub fn new(capacity: u32, refill_per_sec: u32) -> Self {
        Self {
            capacity: capacity as f64,
            tokens: capacity as f64,
            refill_per_sec: refill_per_sec as f64,
            last: Instant::now(),
        }
    }

    /// Try to consume one token. Returns `true` if accepted, `false` if the
    /// bucket is empty.
    pub fn try_take(&mut self) -> bool {
        self.refill();
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    fn refill(&mut self) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last).as_secs_f64();
        if elapsed > 0.0 {
            self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity);
            self.last = now;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;
    use std::time::Duration;

    #[test]
    fn full_bucket_accepts_capacity_calls() {
        let mut b = TokenBucket::new(3, 10);
        assert!(b.try_take());
        assert!(b.try_take());
        assert!(b.try_take());
        assert!(!b.try_take(), "bucket drained");
    }

    #[test]
    fn bucket_refills_over_time() {
        let mut b = TokenBucket::new(1, 100); // capacity 1, fast refill
        assert!(b.try_take());
        assert!(!b.try_take());
        sleep(Duration::from_millis(50));
        assert!(b.try_take(), "should have refilled within 50ms");
    }
}
