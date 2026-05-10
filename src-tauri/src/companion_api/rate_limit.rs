//! Per-device rate limiting (Wave 3.3) — in-house token bucket.
//!
//! `tower_governor` would be the ideal off-the-shelf choice, but we
//! avoid the new crate dep and roll a focused implementation: per-
//! device buckets keyed by `DeviceContext::device_id`, refill once per
//! call from the elapsed wall-clock, and a hard burst ceiling.
//!
//! Defaults: `60 requests/minute` with a `10` request burst — i.e.
//! `1.0` token per second, max `10` tokens. Loopback / unauthenticated
//! pre-pair traffic is intentionally not rate-limited; the limiter
//! lives downstream of the JWT verifier middleware so only paired
//! clients are gated.
//!
//! On rejection the helper returns the precise wait time so the caller
//! can populate `Retry-After`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

/// Per-device token bucket. Tokens replenish at `refill_per_sec` until
/// `capacity` is reached. A successful call subtracts one token.
#[derive(Debug, Clone, Copy)]
struct Bucket {
    tokens: f64,
    last_refill: Instant,
}

impl Bucket {
    fn new(capacity: f64, now: Instant) -> Self {
        Self {
            tokens: capacity,
            last_refill: now,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct RateLimitConfig {
    /// Maximum tokens a bucket can hold (burst size).
    pub capacity: f64,
    /// Tokens added per second of wall-clock.
    pub refill_per_sec: f64,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        // 60 rpm with 10-burst.
        Self {
            capacity: 10.0,
            refill_per_sec: 1.0,
        }
    }
}

pub struct RateLimiter {
    config: RateLimitConfig,
    buckets: Mutex<HashMap<String, Bucket>>,
}

#[derive(Debug, Clone, Copy)]
pub enum RateLimitDecision {
    /// Request accepted; one token deducted.
    Accept,
    /// Request rejected; client should retry after this duration.
    Reject { retry_after: Duration },
}

impl RateLimiter {
    pub fn new(config: RateLimitConfig) -> Arc<Self> {
        Arc::new(Self {
            config,
            buckets: Mutex::new(HashMap::new()),
        })
    }

    pub fn with_defaults() -> Arc<Self> {
        Self::new(RateLimitConfig::default())
    }

    /// Take one token for `device_id`. Internal version takes a `now`
    /// for deterministic testing.
    pub fn check(&self, device_id: &str) -> RateLimitDecision {
        self.check_at(device_id, Instant::now())
    }

    fn check_at(&self, device_id: &str, now: Instant) -> RateLimitDecision {
        let cfg = self.config;
        let mut buckets = self.buckets.lock();
        let bucket = buckets
            .entry(device_id.to_string())
            .or_insert_with(|| Bucket::new(cfg.capacity, now));

        // Refill: tokens grow proportionally to elapsed seconds, capped.
        let elapsed = now.saturating_duration_since(bucket.last_refill);
        let added = elapsed.as_secs_f64() * cfg.refill_per_sec;
        bucket.tokens = (bucket.tokens + added).min(cfg.capacity);
        bucket.last_refill = now;

        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            RateLimitDecision::Accept
        } else {
            // Need (1 - tokens) more tokens, each takes 1/refill_per_sec.
            let deficit = 1.0 - bucket.tokens;
            let secs = deficit / cfg.refill_per_sec;
            // Ceil to whole seconds for Retry-After (HTTP only allows
            // integer-second precision on the spec) — minimum 1 s.
            let wait = secs.max(0.001).ceil() as u64;
            RateLimitDecision::Reject {
                retry_after: Duration::from_secs(wait.max(1)),
            }
        }
    }

    /// Test-only — count of distinct devices currently holding a bucket.
    #[cfg(test)]
    pub fn bucket_count(&self) -> usize {
        self.buckets.lock().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_request_for_a_new_device_is_accepted() {
        let limiter = RateLimiter::with_defaults();
        match limiter.check("dev-1") {
            RateLimitDecision::Accept => {}
            RateLimitDecision::Reject { .. } => panic!("first request should accept"),
        }
        assert_eq!(limiter.bucket_count(), 1);
    }

    #[test]
    fn burst_is_bounded_by_capacity() {
        let limiter = RateLimiter::new(RateLimitConfig {
            capacity: 3.0,
            refill_per_sec: 1.0,
        });
        let now = Instant::now();
        for i in 0..3 {
            let d = limiter.check_at("dev", now);
            assert!(matches!(d, RateLimitDecision::Accept), "request {i} accepted");
        }
        let denied = limiter.check_at("dev", now);
        match denied {
            RateLimitDecision::Reject { retry_after } => {
                assert!(retry_after.as_secs() >= 1);
            }
            RateLimitDecision::Accept => panic!("4th request must reject"),
        }
    }

    #[test]
    fn refill_unblocks_after_enough_wall_clock() {
        let limiter = RateLimiter::new(RateLimitConfig {
            capacity: 1.0,
            refill_per_sec: 1.0,
        });
        let t0 = Instant::now();
        assert!(matches!(limiter.check_at("dev", t0), RateLimitDecision::Accept));
        // Same instant: bucket empty.
        assert!(matches!(limiter.check_at("dev", t0), RateLimitDecision::Reject { .. }));
        // 2 seconds later: should be back at capacity.
        let t1 = t0 + Duration::from_secs(2);
        assert!(matches!(limiter.check_at("dev", t1), RateLimitDecision::Accept));
    }

    #[test]
    fn distinct_devices_have_independent_buckets() {
        let limiter = RateLimiter::new(RateLimitConfig {
            capacity: 1.0,
            refill_per_sec: 1.0,
        });
        let t0 = Instant::now();
        assert!(matches!(limiter.check_at("a", t0), RateLimitDecision::Accept));
        assert!(matches!(limiter.check_at("b", t0), RateLimitDecision::Accept));
        // Each device has its own bucket — neither blocks the other on
        // first call.
        assert!(matches!(limiter.check_at("a", t0), RateLimitDecision::Reject { .. }));
        assert!(matches!(limiter.check_at("b", t0), RateLimitDecision::Reject { .. }));
        assert_eq!(limiter.bucket_count(), 2);
    }
}
