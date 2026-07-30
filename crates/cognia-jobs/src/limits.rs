//! Strict-tier resource governance, in one place so the numbers are auditable
//! and testable rather than scattered as magic constants.
//!
//! Every limit here exists because an unbounded version of it has a concrete
//! failure mode: a runaway `tail -f` fleet, a build log that fills the disk, a
//! poll predicate that spins a core, or a detached job nobody ever reaps.

use std::time::Duration;

/// Max concurrently-running jobs owned by a single chat session.
pub const MAX_JOBS_PER_SESSION: usize = 8;

/// Max concurrently-running jobs across the whole host.
pub const MAX_JOBS_GLOBAL: usize = 32;

/// In-memory ring capacity per job. Serves live tail + regex matching; the
/// full history lives on disk. Chunks are dropped whole, never copied.
pub const RING_CAPACITY_BYTES: usize = 1024 * 1024;

/// Max on-disk log bytes for a single job before the log rotates its head off.
pub const MAX_LOG_BYTES_PER_JOB: u64 = 64 * 1024 * 1024;

/// Global on-disk budget for all job logs. Exceeding it evicts least-recently
/// finished jobs' logs first.
pub const MAX_LOG_BYTES_GLOBAL: u64 = 2 * 1024 * 1024 * 1024;

/// Per-job output rate ceiling. Bytes beyond this in a one-second window are
/// dropped, and the drop is recorded explicitly in the log so a reader can
/// never mistake truncation for "the program printed nothing".
pub const MAX_OUTPUT_BYTES_PER_SEC: u64 = 5 * 1024 * 1024;

/// Floor on `Monitor` shell-predicate polling. Anything faster is a spin loop.
pub const MIN_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Ceiling that exponential backoff walks a poll interval up to.
pub const MAX_POLL_INTERVAL: Duration = Duration::from_secs(60);

/// Max simultaneously-registered monitors across the host.
pub const MAX_MONITORS_GLOBAL: usize = 32;

/// How long a `detach`ed (app-owned) job may live before it is reaped.
pub const DETACHED_JOB_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// Grace period between a session closing and its jobs being killed, so a
/// reload or a brief disconnect does not destroy in-flight work.
pub const SESSION_CLOSE_GRACE: Duration = Duration::from_secs(30);

/// Longest a `Monitor` call blocks before degrading to an async watch.
pub const MONITOR_BLOCKING_THRESHOLD: Duration = Duration::from_secs(5 * 60);

/// Marker written into the log when the rate limiter drops bytes. Readers and
/// tests match on this exact prefix.
pub const TRUNCATION_MARKER_PREFIX: &str = "\n[cognia: output truncated —";

/// Render the truncation marker for `dropped` bytes.
pub fn truncation_marker(dropped: u64) -> String {
    format!("{TRUNCATION_MARKER_PREFIX} {dropped} bytes dropped by the rate limiter]\n")
}

/// Walk a poll interval up toward [`MAX_POLL_INTERVAL`], doubling each time and
/// never returning less than [`MIN_POLL_INTERVAL`].
pub fn next_poll_interval(current: Duration) -> Duration {
    let doubled = current.saturating_mul(2);
    doubled.clamp(MIN_POLL_INTERVAL, MAX_POLL_INTERVAL)
}

/// Clamp a caller-supplied poll interval into the permitted band.
pub fn clamp_poll_interval(requested: Duration) -> Duration {
    requested.clamp(MIN_POLL_INTERVAL, MAX_POLL_INTERVAL)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_marker_names_the_dropped_byte_count() {
        let marker = truncation_marker(4096);
        assert!(marker.starts_with(TRUNCATION_MARKER_PREFIX));
        assert!(marker.contains("4096 bytes dropped"));
    }

    #[test]
    fn next_poll_interval_doubles_then_saturates_at_the_ceiling() {
        assert_eq!(
            next_poll_interval(Duration::from_secs(2)),
            Duration::from_secs(4)
        );
        assert_eq!(
            next_poll_interval(Duration::from_secs(16)),
            Duration::from_secs(32)
        );
        // Doubling past the ceiling clamps rather than overshooting.
        assert_eq!(
            next_poll_interval(Duration::from_secs(40)),
            MAX_POLL_INTERVAL
        );
        assert_eq!(next_poll_interval(MAX_POLL_INTERVAL), MAX_POLL_INTERVAL);
    }

    #[test]
    fn next_poll_interval_never_returns_below_the_floor() {
        // A sub-floor current value must still come back at or above the floor,
        // otherwise a caller seeding 0 would spin.
        assert_eq!(next_poll_interval(Duration::ZERO), MIN_POLL_INTERVAL);
        assert_eq!(
            next_poll_interval(Duration::from_millis(100)),
            MIN_POLL_INTERVAL
        );
    }

    #[test]
    fn clamp_poll_interval_bounds_both_ends() {
        assert_eq!(
            clamp_poll_interval(Duration::from_millis(1)),
            MIN_POLL_INTERVAL
        );
        assert_eq!(
            clamp_poll_interval(Duration::from_secs(10)),
            Duration::from_secs(10)
        );
        assert_eq!(
            clamp_poll_interval(Duration::from_secs(3600)),
            MAX_POLL_INTERVAL
        );
    }

    #[test]
    fn per_session_cap_is_below_the_global_cap() {
        // A single session must never be able to exhaust the host budget.
        assert!(MAX_JOBS_PER_SESSION < MAX_JOBS_GLOBAL);
    }
}
