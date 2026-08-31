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
//! Read-only commands get a second, far wider bucket, because a paired
//! client's first act is a burst this one cannot fit. `runSyncDown`
//! walks 25 sync handlers back to back, and each one pages until the
//! server stops setting `has_more` — so a first pairing is 25 calls at
//! the floor and considerably more once `sessions` and `messages`
//! paginate. Against a 10-token bucket refilling at 1/s, everything
//! past the tenth call is rejected, and the client's three-attempt
//! sub-second backoff expires long before the bucket recovers: the tail
//! tables end up empty, silently, since `runSyncDown` records the error
//! per table and moves on.
//!
//! This is the same reasoning that already exempts the `service`
//! principal at the RPC gate ("performs a large deterministic bootstrap
//! burst, so charging it against a 10-request device bucket leaves
//! runtimes half-initialized") — a paired device performs that burst
//! too. Splitting by class keeps the strict bucket where it earns its
//! keep, on the mutating commands.
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

impl RateLimitConfig {
    /// The read-only bucket: 600 rpm with a 120 burst.
    ///
    /// Sized from the one burst that actually exists rather than a round
    /// number. The sync bootstrap is 25 handlers, each paging while the
    /// server sets `has_more`; 120 leaves roughly four pages per table
    /// before anything is refused, and the 10/s refill means even a much
    /// larger first pull drains at a rate no human notices. Reads are
    /// cheap and idempotent — the bucket that has to stay tight is the
    /// mutating one, and it does.
    pub fn read_only_default() -> Self {
        Self {
            capacity: 120.0,
            refill_per_sec: 10.0,
        }
    }
}

/// Which bucket a request is charged to.
///
/// The split is by cost and blast radius, not by endpoint: a read cannot
/// change anything, so a client burst of them is a throughput question.
/// A write can, so it stays on the strict bucket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestClass {
    /// Charged to the wide bucket — `READ_ONLY_COMMANDS_SET` members.
    ReadOnly,
    /// Charged to the strict bucket. The default for anything unclassified.
    Mutating,
}

pub struct RateLimiter {
    config: RateLimitConfig,
    read_config: RateLimitConfig,
    buckets: Mutex<HashMap<String, Bucket>>,
    read_buckets: Mutex<HashMap<String, Bucket>>,
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
        Self::with_classes(config, RateLimitConfig::read_only_default())
    }

    /// Both buckets, for tests that need to drive them independently.
    pub fn with_classes(config: RateLimitConfig, read_config: RateLimitConfig) -> Arc<Self> {
        Arc::new(Self {
            config,
            read_config,
            buckets: Mutex::new(HashMap::new()),
            read_buckets: Mutex::new(HashMap::new()),
        })
    }

    pub fn with_defaults() -> Arc<Self> {
        Self::new(RateLimitConfig::default())
    }

    /// Take one token for `device_id` from the strict bucket.
    ///
    /// Kept as the unclassified entry point so a caller that has not
    /// reasoned about cost gets the conservative answer.
    pub fn check(&self, device_id: &str) -> RateLimitDecision {
        self.check_class(device_id, RequestClass::Mutating)
    }

    /// Take one token from the bucket this request's class is charged to.
    pub fn check_class(&self, device_id: &str, class: RequestClass) -> RateLimitDecision {
        self.check_class_at(device_id, class, Instant::now())
    }

    #[cfg(test)]
    fn check_at(&self, device_id: &str, now: Instant) -> RateLimitDecision {
        self.check_class_at(device_id, RequestClass::Mutating, now)
    }

    fn check_class_at(
        &self,
        device_id: &str,
        class: RequestClass,
        now: Instant,
    ) -> RateLimitDecision {
        let (cfg, mut buckets) = match class {
            RequestClass::ReadOnly => (self.read_config, self.read_buckets.lock()),
            RequestClass::Mutating => (self.config, self.buckets.lock()),
        };
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

    /// Test-only — the same count for the read-only bucket.
    #[cfg(test)]
    pub fn read_bucket_count(&self) -> usize {
        self.read_buckets.lock().len()
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
            assert!(
                matches!(d, RateLimitDecision::Accept),
                "request {i} accepted"
            );
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
        assert!(matches!(
            limiter.check_at("dev", t0),
            RateLimitDecision::Accept
        ));
        // Same instant: bucket empty.
        assert!(matches!(
            limiter.check_at("dev", t0),
            RateLimitDecision::Reject { .. }
        ));
        // 2 seconds later: should be back at capacity.
        let t1 = t0 + Duration::from_secs(2);
        assert!(matches!(
            limiter.check_at("dev", t1),
            RateLimitDecision::Accept
        ));
    }

    // The regression this class split exists for: a paired client's first
    // act is `runSyncDown`, 25 sync_pull calls back to back (more once a
    // table pages). On the strict bucket everything past the tenth was
    // refused, and the tail tables silently stayed empty.
    #[test]
    fn a_sync_bootstrap_burst_fits_in_the_read_only_bucket() {
        let limiter = RateLimiter::with_defaults();
        let now = Instant::now();
        // 25 handlers, four pages each — comfortably past what the strict
        // bucket holds, and still inside the read-only one.
        for i in 0..100 {
            assert!(
                matches!(
                    limiter.check_class_at("dev", RequestClass::ReadOnly, now),
                    RateLimitDecision::Accept
                ),
                "read {i} of the bootstrap burst must be accepted"
            );
        }
    }

    #[test]
    fn the_same_burst_is_still_refused_on_the_mutating_bucket() {
        let limiter = RateLimiter::with_defaults();
        let now = Instant::now();
        for _ in 0..10 {
            assert!(matches!(
                limiter.check_class_at("dev", RequestClass::Mutating, now),
                RateLimitDecision::Accept
            ));
        }
        assert!(
            matches!(
                limiter.check_class_at("dev", RequestClass::Mutating, now),
                RateLimitDecision::Reject { .. }
            ),
            "writes keep the strict 10-token ceiling"
        );
    }

    #[test]
    fn the_two_classes_do_not_spend_each_others_tokens() {
        let limiter = RateLimiter::with_defaults();
        let now = Instant::now();
        // Drain the strict bucket entirely.
        for _ in 0..10 {
            let _ = limiter.check_class_at("dev", RequestClass::Mutating, now);
        }
        assert!(matches!(
            limiter.check_class_at("dev", RequestClass::Mutating, now),
            RateLimitDecision::Reject { .. }
        ));
        // A read is unaffected, and vice versa.
        assert!(matches!(
            limiter.check_class_at("dev", RequestClass::ReadOnly, now),
            RateLimitDecision::Accept
        ));
        assert_eq!(limiter.bucket_count(), 1);
        assert_eq!(limiter.read_bucket_count(), 1);
    }

    #[test]
    fn the_read_only_bucket_still_has_a_ceiling() {
        let limiter = RateLimiter::with_classes(
            RateLimitConfig::default(),
            RateLimitConfig {
                capacity: 2.0,
                refill_per_sec: 10.0,
            },
        );
        let now = Instant::now();
        for _ in 0..2 {
            assert!(matches!(
                limiter.check_class_at("dev", RequestClass::ReadOnly, now),
                RateLimitDecision::Accept
            ));
        }
        match limiter.check_class_at("dev", RequestClass::ReadOnly, now) {
            RateLimitDecision::Reject { retry_after } => {
                // Never sub-second: the wait is what the client is told to
                // sleep, and HTTP only carries whole seconds.
                assert!(retry_after.as_secs() >= 1);
            }
            RateLimitDecision::Accept => panic!("the read bucket must still bound a burst"),
        }
    }

    #[test]
    fn plain_check_stays_on_the_strict_bucket() {
        let limiter = RateLimiter::with_defaults();
        let now = Instant::now();
        for _ in 0..10 {
            let _ = limiter.check_at("dev", now);
        }
        assert!(
            matches!(
                limiter.check_at("dev", now),
                RateLimitDecision::Reject { .. }
            ),
            "an unclassified caller must not silently get the wide bucket"
        );
        assert_eq!(limiter.read_bucket_count(), 0);
    }

    #[test]
    fn distinct_devices_have_independent_buckets() {
        let limiter = RateLimiter::new(RateLimitConfig {
            capacity: 1.0,
            refill_per_sec: 1.0,
        });
        let t0 = Instant::now();
        assert!(matches!(
            limiter.check_at("a", t0),
            RateLimitDecision::Accept
        ));
        assert!(matches!(
            limiter.check_at("b", t0),
            RateLimitDecision::Accept
        ));
        // Each device has its own bucket — neither blocks the other on
        // first call.
        assert!(matches!(
            limiter.check_at("a", t0),
            RateLimitDecision::Reject { .. }
        ));
        assert!(matches!(
            limiter.check_at("b", t0),
            RateLimitDecision::Reject { .. }
        ));
        assert_eq!(limiter.bucket_count(), 2);
    }
}
