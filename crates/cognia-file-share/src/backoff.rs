//! Persisted authentication backoff (ADR-0222 §7.1).
//!
//! Keyed by `(username, remote address)`: five failures are free, then each
//! further failure locks the key for 30 seconds, doubling up to 15 minutes. A
//! key with no failure for 30 minutes starts over. Only failures are charged:
//! a client that authenticates correctly on every request never slows down,
//! however busy it is. The state lives in `file-share.sqlite`, so restarting
//! the host does not reset an attacker's budget.

use crate::store::FailureRecord;

/// Failures allowed before the first lock.
pub const FREE_FAILURES: u32 = 5;
/// The first lock's length.
pub const INITIAL_LOCK_MS: i64 = 30_000;
/// The longest lock.
pub const MAX_LOCK_MS: i64 = 15 * 60_000;
/// A key with no failure for this long starts over.
pub const RESET_AFTER_MS: i64 = 30 * 60_000;

/// Milliseconds until `record` may try again, or `None` when it may now.
pub fn retry_after(record: &FailureRecord, now: i64) -> Option<i64> {
    (record.locked_until > now).then(|| record.locked_until - now)
}

/// The record after one more failure at `now`.
pub fn after_failure(record: &FailureRecord, now: i64) -> FailureRecord {
    let previous = if now - record.last_failure_at > RESET_AFTER_MS {
        0
    } else {
        record.failures
    };
    let failures = previous.saturating_add(1);
    let locked_until = if failures > FREE_FAILURES {
        let doublings = (failures - FREE_FAILURES - 1).min(16);
        let lock = INITIAL_LOCK_MS
            .saturating_mul(1_i64 << doublings)
            .min(MAX_LOCK_MS);
        now + lock
    } else {
        record.locked_until.min(now)
    };
    FailureRecord {
        failures,
        locked_until,
        last_failure_at: now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fail(times: u32, start: i64, step: i64) -> FailureRecord {
        let mut record = FailureRecord::default();
        for i in 0..times {
            record = after_failure(&record, start + i as i64 * step);
        }
        record
    }

    #[test]
    fn five_failures_are_free() {
        let record = fail(5, 1_000_000, 10);
        assert_eq!(record.failures, 5);
        assert_eq!(retry_after(&record, 1_000_050), None);
    }

    #[test]
    fn the_sixth_failure_locks_for_thirty_seconds_then_doubles_to_a_cap() {
        let now = 1_000_000;
        let sixth = fail(6, now, 0);
        assert_eq!(retry_after(&sixth, now), Some(INITIAL_LOCK_MS));
        let seventh = after_failure(&sixth, now);
        assert_eq!(retry_after(&seventh, now), Some(2 * INITIAL_LOCK_MS));
        let many = fail(40, now, 0);
        assert_eq!(retry_after(&many, now), Some(MAX_LOCK_MS));
    }

    #[test]
    fn a_quiet_half_hour_starts_over() {
        let now = 1_000_000;
        let locked = fail(8, now, 0);
        let later = now + RESET_AFTER_MS + 1;
        let fresh = after_failure(&locked, later);
        assert_eq!(fresh.failures, 1);
        assert_eq!(retry_after(&fresh, later), None);
    }
}
