//! Tiny fixed-window rate limiter. The remote-control inbound listener
//! authenticates every request with a single bearer token, so per-token
//! is the same as global — we keep one window keyed only by the request
//! count and reset on the minute boundary.
//!
//! Returning `false` from `try_acquire` means "over the limit, send a 429".

use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct FixedWindowRateLimiter {
    inner: Mutex<RateLimiterInner>,
}

struct RateLimiterInner {
    window_started_at: Instant,
    count: u32,
    /// Maximum requests per 60-second window.
    limit: u32,
}

impl FixedWindowRateLimiter {
    pub fn new(limit_per_min: u32) -> Self {
        Self {
            inner: Mutex::new(RateLimiterInner {
                window_started_at: Instant::now(),
                count: 0,
                limit: limit_per_min,
            }),
        }
    }

    #[allow(dead_code)] // reserved — used once the rate-limit UI ships hot-update
    pub fn set_limit(&self, limit_per_min: u32) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.limit = limit_per_min;
        }
    }

    pub fn try_acquire(&self) -> bool {
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return true, // poisoned mutex shouldn't lock out users
        };
        if inner.window_started_at.elapsed() >= Duration::from_secs(60) {
            inner.window_started_at = Instant::now();
            inner.count = 0;
        }
        if inner.count >= inner.limit {
            return false;
        }
        inner.count += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_up_to_limit_then_blocks() {
        let rl = FixedWindowRateLimiter::new(3);
        assert!(rl.try_acquire());
        assert!(rl.try_acquire());
        assert!(rl.try_acquire());
        assert!(!rl.try_acquire());
    }

    #[test]
    fn set_limit_updates_threshold() {
        let rl = FixedWindowRateLimiter::new(1);
        assert!(rl.try_acquire());
        assert!(!rl.try_acquire());
        rl.set_limit(10);
        // Window hasn't reset, but the threshold did. Existing count (1) is
        // below the new limit, so the next acquire passes.
        assert!(rl.try_acquire());
    }

    #[test]
    fn limit_zero_blocks_everything() {
        let rl = FixedWindowRateLimiter::new(0);
        assert!(!rl.try_acquire());
    }
}
