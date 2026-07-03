//! Per-key fixed-window rate limiter.
//!
//! The global [`crate::remote_control::rate_limit::FixedWindowRateLimiter`]
//! bounds total inbound traffic; this bounds each API key independently so one
//! noisy key can't starve the others. Keyed by the key id, one 60-second
//! window each. `limit == 0` blocks the key entirely (a hard pause).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct KeyedRateLimiter {
    inner: Mutex<HashMap<String, Window>>,
}

struct Window {
    started_at: Instant,
    count: u32,
}

impl KeyedRateLimiter {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Try to consume one unit of `key`'s per-minute budget. Returns `false`
    /// (→ 429) when the key is over `limit_per_min` in the current window.
    pub fn try_acquire(&self, key: &str, limit_per_min: u32) -> bool {
        let now = Instant::now();
        let mut map = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return true, // a poisoned lock must not lock users out
        };
        let window = map.entry(key.to_string()).or_insert(Window {
            started_at: now,
            count: 0,
        });
        if now.duration_since(window.started_at) >= Duration::from_secs(60) {
            window.started_at = now;
            window.count = 0;
        }
        if window.count >= limit_per_min {
            return false;
        }
        window.count += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_key_windows_are_independent() {
        let rl = KeyedRateLimiter::new();
        assert!(rl.try_acquire("a", 2));
        assert!(rl.try_acquire("a", 2));
        assert!(!rl.try_acquire("a", 2)); // "a" exhausted
        // "b" has its own budget.
        assert!(rl.try_acquire("b", 2));
        assert!(rl.try_acquire("b", 2));
        assert!(!rl.try_acquire("b", 2));
    }

    #[test]
    fn zero_limit_blocks_the_key() {
        let rl = KeyedRateLimiter::new();
        assert!(!rl.try_acquire("a", 0));
    }

    #[test]
    fn a_raised_limit_is_honoured_within_the_same_window() {
        let rl = KeyedRateLimiter::new();
        assert!(rl.try_acquire("a", 1));
        assert!(!rl.try_acquire("a", 1));
        // The same window, but a higher limit lets the next call through.
        assert!(rl.try_acquire("a", 5));
    }
}
