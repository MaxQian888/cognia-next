//! Shared crash-backoff for supervised child processes (ADR-0059 R6).
//!
//! Extracted from `claude/sidecar.rs` so the sidecar supervisor and the
//! headless brain supervisor (`headless/brain.rs`, R8) escalate identically:
//! a single transient death respawns immediately; only a genuine crash loop
//! (the child keeps dying before announcing ready) escalates the delay.

use std::time::{Duration, Instant};

/// Crash-backoff delay table (ms), indexed by `consecutive_failures - 1` and
/// saturating at the last entry. Mirrors the jittered-table idiom in
/// `companion_api/signaling/client.rs`. The first failure maps to `0` so a
/// single transient death (or an intentional kill + restart) respawns
/// immediately.
pub const SPAWN_BACKOFF_MS: &[u64] = &[0, 250, 1_000, 4_000, 16_000, 30_000];

/// Backoff delay for the Nth consecutive failure. Pure — unit-tested.
pub fn backoff_delay(consecutive_failures: u32) -> Duration {
    if consecutive_failures == 0 {
        return Duration::ZERO;
    }
    let idx = ((consecutive_failures - 1) as usize).min(SPAWN_BACKOFF_MS.len() - 1);
    Duration::from_millis(SPAWN_BACKOFF_MS[idx])
}

/// Failure counters for one supervised child. Embed in the supervisor's
/// state (behind its own lock) and drive with injected `Instant`s so the
/// window math stays unit-testable.
#[derive(Debug, Clone, Default)]
pub struct CrashBackoff {
    /// Consecutive deaths-before-ready. Reset the moment the child announces
    /// ready; incremented on every observed exit.
    consecutive_failures: u32,
    /// When the most recent exit was observed.
    last_failure_at: Option<Instant>,
}

impl CrashBackoff {
    /// Record an exit at `now`.
    pub fn note_failure(&mut self, now: Instant) {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        self.last_failure_at = Some(now);
    }

    /// A successful boot clears the crash-loop counter.
    pub fn reset(&mut self) {
        self.consecutive_failures = 0;
    }

    /// Remaining backoff window at `now`, or `None` if a respawn may proceed
    /// immediately.
    pub fn remaining(&self, now: Instant) -> Option<Duration> {
        if self.consecutive_failures == 0 {
            return None;
        }
        let last = self.last_failure_at?;
        let delay = backoff_delay(self.consecutive_failures);
        if delay.is_zero() {
            return None;
        }
        let elapsed = now.saturating_duration_since(last);
        (elapsed < delay).then(|| delay - elapsed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_delay_escalates_and_saturates() {
        assert_eq!(backoff_delay(0), Duration::ZERO);
        assert_eq!(backoff_delay(1), Duration::ZERO);
        assert_eq!(backoff_delay(2), Duration::from_millis(250));
        assert_eq!(backoff_delay(3), Duration::from_millis(1_000));
        assert_eq!(backoff_delay(4), Duration::from_millis(4_000));
        assert_eq!(backoff_delay(6), Duration::from_millis(30_000));
        assert_eq!(backoff_delay(99), Duration::from_millis(30_000));
    }

    #[test]
    fn remaining_none_before_any_failure() {
        let b = CrashBackoff::default();
        assert!(b.remaining(Instant::now()).is_none());
    }

    #[test]
    fn remaining_single_failure_is_immediate() {
        let mut b = CrashBackoff::default();
        let t0 = Instant::now();
        b.note_failure(t0); // failures = 1 → delay 0 → no backoff
        assert!(b.remaining(t0).is_none());
    }

    #[test]
    fn remaining_inside_and_past_window() {
        let mut b = CrashBackoff::default();
        let t0 = Instant::now();
        b.note_failure(t0); // failures = 1
        b.note_failure(t0); // failures = 2 → delay 250ms
        let inside = b.remaining(t0 + Duration::from_millis(100));
        assert!(inside.is_some());
        assert!(inside.unwrap() <= Duration::from_millis(150));
        assert!(b.remaining(t0 + Duration::from_millis(300)).is_none());
    }

    #[test]
    fn reset_clears_the_crash_loop() {
        let mut b = CrashBackoff::default();
        let t0 = Instant::now();
        b.note_failure(t0);
        b.note_failure(t0); // failures = 2
        b.reset();
        assert!(b.remaining(t0 + Duration::from_millis(1)).is_none());
    }
}
