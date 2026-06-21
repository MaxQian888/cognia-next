//! Global brute-force guard for the numeric pair-code redeem endpoint.
//!
//! `POST /api/v1/auth/pair/redeem-code` accepts a short numeric code (currently
//! 6 digits ≈ 9×10⁵ values). A correct guess yields a full device credential,
//! so the endpoint must resist online brute force. The per-IP `pre_auth` rate
//! limiter is insufficient here: it exempts loopback entirely and an attacker
//! can rotate source IPs, so neither bounds the *total* number of guesses
//! against a live code.
//!
//! This guard is a process-global, source-independent counter: after
//! [`FAIL_THRESHOLD`] failed redemptions within [`WINDOW`], the endpoint is
//! locked for [`LOCKOUT`] regardless of origin (loopback included). With the
//! defaults a brute-force tops out at ~20 guesses/minute — covering the 6-digit
//! space would take on the order of a year, while a legitimately-typed code
//! (one or two attempts) never trips it. A successful redemption resets the
//! counter. Mirrors the singleton style of [`super::control_allow_list`].

use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;

/// Failed redemptions within `WINDOW` before the endpoint locks.
pub const FAIL_THRESHOLD: u32 = 20;
/// Rolling window over which failures accumulate.
pub const WINDOW: Duration = Duration::from_secs(60);
/// How long the endpoint stays locked once the threshold is crossed.
pub const LOCKOUT: Duration = Duration::from_secs(60);

static GLOBAL: Lazy<PairCodeGuard> = Lazy::new(PairCodeGuard::new);

/// Accessor for the process-global pair-code brute-force guard.
pub fn global() -> &'static PairCodeGuard {
    &GLOBAL
}

struct Inner {
    fails: u32,
    window_start: Instant,
    locked_until: Option<Instant>,
}

pub struct PairCodeGuard {
    inner: Mutex<Inner>,
}

impl PairCodeGuard {
    fn new() -> Self {
        // `window_start` is overwritten on first failure; a placeholder `now`
        // is fine and avoids needing a clock at construction.
        Self {
            inner: Mutex::new(Inner {
                fails: 0,
                window_start: Instant::now(),
                locked_until: None,
            }),
        }
    }

    /// Whether a redeem attempt is currently allowed. Returns `false` while
    /// locked out; clears an expired lockout (and resets the counter) as a side
    /// effect so the endpoint reopens after `LOCKOUT`.
    pub fn allow(&self, now: Instant) -> bool {
        let mut g = self.inner.lock();
        if let Some(until) = g.locked_until {
            if now < until {
                return false;
            }
            g.locked_until = None;
            g.fails = 0;
            g.window_start = now;
        }
        true
    }

    /// Record a failed redemption (unknown / expired code). Locks the endpoint
    /// when `FAIL_THRESHOLD` is reached within `WINDOW`. Returns `true` if this
    /// call triggered the lockout.
    pub fn record_failure(&self, now: Instant) -> bool {
        let mut g = self.inner.lock();
        if now.saturating_duration_since(g.window_start) > WINDOW {
            g.window_start = now;
            g.fails = 0;
        }
        g.fails = g.fails.saturating_add(1);
        if g.fails >= FAIL_THRESHOLD {
            g.locked_until = Some(now + LOCKOUT);
            return true;
        }
        false
    }

    /// Reset the counter after a successful redemption.
    pub fn record_success(&self) {
        let mut g = self.inner.lock();
        g.fails = 0;
        g.locked_until = None;
    }

    /// Test helper: clear all state on the process-global instance.
    #[cfg(test)]
    pub fn reset_for_test(&self) {
        let mut g = self.inner.lock();
        g.fails = 0;
        g.locked_until = None;
        g.window_start = Instant::now();
    }
}

impl Default for PairCodeGuard {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_until_threshold_then_locks() {
        let guard = PairCodeGuard::new();
        let now = Instant::now();
        for i in 0..FAIL_THRESHOLD {
            assert!(guard.allow(now), "should be open before the threshold");
            let locked = guard.record_failure(now);
            assert_eq!(locked, i + 1 >= FAIL_THRESHOLD, "locks exactly at threshold");
        }
        assert!(!guard.allow(now), "locked out after threshold failures");
    }

    #[test]
    fn lockout_expires_after_window() {
        let guard = PairCodeGuard::new();
        let now = Instant::now();
        for _ in 0..FAIL_THRESHOLD {
            guard.record_failure(now);
        }
        assert!(!guard.allow(now));
        let later = now + LOCKOUT + Duration::from_secs(1);
        assert!(guard.allow(later), "reopens after the lockout elapses");
    }

    #[test]
    fn failures_outside_window_do_not_accumulate() {
        let guard = PairCodeGuard::new();
        let t0 = Instant::now();
        // One failure now…
        guard.record_failure(t0);
        // …and the next far outside the window resets the count, so a slow
        // drip never locks the endpoint.
        let t1 = t0 + WINDOW + Duration::from_secs(1);
        for _ in 0..(FAIL_THRESHOLD - 1) {
            assert!(!guard.record_failure(t1), "slow drip must not lock");
        }
    }

    #[test]
    fn success_resets_the_counter() {
        let guard = PairCodeGuard::new();
        let now = Instant::now();
        for _ in 0..(FAIL_THRESHOLD - 1) {
            guard.record_failure(now);
        }
        guard.record_success();
        // After a success the next failure starts a fresh count.
        assert!(!guard.record_failure(now));
        assert!(guard.allow(now));
    }
}
