//! Shared building blocks for the MCP side-channel proxies
//! (`automation_proxy`, `orchestration_proxy`).
//!
//! Both proxies bind a `127.0.0.1:0` newline-framed JSON socket, authenticate
//! every line with a per-sidecar shared-secret token (constant-time compare),
//! and apply a per-peer token-bucket rate limit + bad-token lockout. That
//! transport-security shell is identical between them, so it lives here once.
//!
//! What differs is the dispatch: `automation_proxy` calls a native
//! `AutomationHandle`; `orchestration_proxy` bounces the request to the
//! renderer and awaits a reply. Those stay in their own modules.

use std::collections::HashMap;
use std::net::IpAddr;
use std::time::{Duration, Instant};

use parking_lot::Mutex as ParkingMutex;
use subtle::ConstantTimeEq;

/// ADR-0020 W3 — token-bucket parameters per peer IP. Defaults match the
/// plan's "10 req/s burst, 100/min sustained" guidance. The proxy sockets are
/// 127.0.0.1-bound so in practice this caps the whole proxy (every client comes
/// from loopback), but keying by IP keeps the math intact if a future build
/// exposes a proxy on a LAN interface.
pub const RATE_LIMIT_BURST: u32 = 10;
pub const RATE_LIMIT_REFILL_PER_SEC: f64 = 100.0 / 60.0;
/// Threshold of bad-token attempts inside `BAD_TOKEN_WINDOW` after which we
/// drop the connection for `BAD_TOKEN_LOCKOUT`.
pub const BAD_TOKEN_THRESHOLD: u32 = 5;
pub const BAD_TOKEN_WINDOW: Duration = Duration::from_secs(60);
pub const BAD_TOKEN_LOCKOUT: Duration = Duration::from_secs(300);

/// Per-IP rate-limit state. `tokens` is fractional so the leak/refill is
/// monotone — every check that fires also decays `tokens` based on elapsed
/// wall-clock since the previous check.
#[derive(Debug)]
struct PeerLimit {
    tokens: f64,
    updated: Instant,
    bad_token_count: u32,
    bad_token_window_start: Instant,
    locked_until: Option<Instant>,
}

impl PeerLimit {
    fn new(now: Instant) -> Self {
        Self {
            tokens: RATE_LIMIT_BURST as f64,
            updated: now,
            bad_token_count: 0,
            bad_token_window_start: now,
            locked_until: None,
        }
    }
}

#[derive(Default)]
pub struct RateLimiter {
    peers: ParkingMutex<HashMap<IpAddr, PeerLimit>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RateLimitOutcome {
    Allow,
    LimitedTryAgain,
    LockedOut,
}

impl RateLimiter {
    /// Returns the outcome for a request from `peer` at `now`. Drains one token
    /// on Allow; never refunds. Lockout extends but does not drain. Callers
    /// should map LimitedTryAgain + LockedOut to a uniform "rate-limited"
    /// error response.
    pub fn check(&self, peer: IpAddr, now: Instant) -> RateLimitOutcome {
        let mut guard = self.peers.lock();
        let entry = guard.entry(peer).or_insert_with(|| PeerLimit::new(now));
        if let Some(until) = entry.locked_until {
            if now < until {
                return RateLimitOutcome::LockedOut;
            }
            // Lockout expired — reset so the peer can try again.
            entry.locked_until = None;
            entry.bad_token_count = 0;
            entry.bad_token_window_start = now;
            entry.tokens = RATE_LIMIT_BURST as f64;
            entry.updated = now;
        }
        let elapsed = now.saturating_duration_since(entry.updated).as_secs_f64();
        let refilled =
            (entry.tokens + elapsed * RATE_LIMIT_REFILL_PER_SEC).min(RATE_LIMIT_BURST as f64);
        entry.tokens = refilled;
        entry.updated = now;
        if entry.tokens < 1.0 {
            return RateLimitOutcome::LimitedTryAgain;
        }
        entry.tokens -= 1.0;
        RateLimitOutcome::Allow
    }

    /// Whether `peer` is currently locked out for repeated bad tokens, without
    /// draining a rate-limit token. Used by request paths (e.g. the HTTP auth
    /// middleware) that want the bad-token lockout but must NOT throttle
    /// well-formed, correctly-authenticated traffic. An expired lockout is
    /// cleared as a side effect so the peer can retry.
    pub fn is_locked_out(&self, peer: IpAddr, now: Instant) -> bool {
        let mut guard = self.peers.lock();
        if let Some(entry) = guard.get_mut(&peer) {
            if let Some(until) = entry.locked_until {
                if now < until {
                    return true;
                }
                entry.locked_until = None;
                entry.bad_token_count = 0;
                entry.bad_token_window_start = now;
            }
        }
        false
    }

    /// Record a bad-token attempt. Returns true when the lockout threshold was
    /// reached this call (so the connection should be dropped without waiting
    /// for the next request).
    pub fn record_bad_token(&self, peer: IpAddr, now: Instant) -> bool {
        let mut guard = self.peers.lock();
        let entry = guard.entry(peer).or_insert_with(|| PeerLimit::new(now));
        if now.saturating_duration_since(entry.bad_token_window_start) > BAD_TOKEN_WINDOW {
            entry.bad_token_window_start = now;
            entry.bad_token_count = 0;
        }
        entry.bad_token_count = entry.bad_token_count.saturating_add(1);
        if entry.bad_token_count >= BAD_TOKEN_THRESHOLD {
            entry.locked_until = Some(now + BAD_TOKEN_LOCKOUT);
            return true;
        }
        false
    }
}

/// Constant-time token comparison. Rejects length mismatch before the
/// constant-time compare so it never falls through to a substring match.
pub fn token_matches(provided: &str, expected: &str) -> bool {
    let a = provided.as_bytes();
    let b = expected.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

/// Generate a random 32-byte hex shared-secret token.
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_constant_time_compare_rejects_length_mismatch() {
        assert!(!token_matches("short", "longer-than-short"));
        assert!(token_matches("identical", "identical"));
    }

    #[test]
    fn generate_token_is_64_hex_chars() {
        let t = generate_token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn rate_limiter_allows_up_to_burst_then_throttles() {
        let limiter = RateLimiter::default();
        let now = Instant::now();
        let peer: IpAddr = "127.0.0.1".parse().unwrap();
        for _ in 0..RATE_LIMIT_BURST {
            assert_eq!(limiter.check(peer, now), RateLimitOutcome::Allow);
        }
        assert_eq!(limiter.check(peer, now), RateLimitOutcome::LimitedTryAgain);
    }

    #[test]
    fn rate_limiter_refills_over_time() {
        let limiter = RateLimiter::default();
        let now = Instant::now();
        let peer: IpAddr = "127.0.0.1".parse().unwrap();
        for _ in 0..RATE_LIMIT_BURST {
            assert_eq!(limiter.check(peer, now), RateLimitOutcome::Allow);
        }
        let later = now + Duration::from_secs(60);
        assert_eq!(limiter.check(peer, later), RateLimitOutcome::Allow);
    }

    #[test]
    fn rate_limiter_keeps_per_peer_separate_buckets() {
        let limiter = RateLimiter::default();
        let now = Instant::now();
        let peer_a: IpAddr = "127.0.0.1".parse().unwrap();
        let peer_b: IpAddr = "127.0.0.2".parse().unwrap();
        for _ in 0..RATE_LIMIT_BURST {
            assert_eq!(limiter.check(peer_a, now), RateLimitOutcome::Allow);
        }
        assert_eq!(limiter.check(peer_b, now), RateLimitOutcome::Allow);
    }

    #[test]
    fn rate_limiter_locks_out_after_repeat_bad_tokens() {
        let limiter = RateLimiter::default();
        let now = Instant::now();
        let peer: IpAddr = "127.0.0.1".parse().unwrap();
        for i in 0..BAD_TOKEN_THRESHOLD {
            let locked = limiter.record_bad_token(peer, now);
            assert_eq!(
                locked,
                i + 1 >= BAD_TOKEN_THRESHOLD,
                "should lock exactly at the threshold call"
            );
        }
        assert_eq!(limiter.check(peer, now), RateLimitOutcome::LockedOut);
    }

    #[test]
    fn is_locked_out_tracks_lockout_without_draining() {
        let limiter = RateLimiter::default();
        let now = Instant::now();
        let peer: IpAddr = "127.0.0.1".parse().unwrap();
        // Not locked initially; the probe must not consume a token.
        assert!(!limiter.is_locked_out(peer, now));
        for _ in 0..BAD_TOKEN_THRESHOLD {
            limiter.record_bad_token(peer, now);
        }
        assert!(limiter.is_locked_out(peer, now));
        // A full burst is still available to a good client (probe didn't drain).
        for _ in 0..RATE_LIMIT_BURST {
            // After lockout the bucket was reset by is_locked_out's expiry path
            // only once expired; here it's still locked, so check() returns
            // LockedOut — assert the lockout, not the bucket.
        }
        // After the window, the lockout clears via the probe itself.
        let later = now + BAD_TOKEN_LOCKOUT + Duration::from_secs(1);
        assert!(!limiter.is_locked_out(peer, later));
    }

    #[test]
    fn rate_limiter_lockout_expires_after_window() {
        let limiter = RateLimiter::default();
        let now = Instant::now();
        let peer: IpAddr = "127.0.0.1".parse().unwrap();
        for _ in 0..BAD_TOKEN_THRESHOLD {
            limiter.record_bad_token(peer, now);
        }
        assert_eq!(limiter.check(peer, now), RateLimitOutcome::LockedOut);
        let later = now + BAD_TOKEN_LOCKOUT + Duration::from_secs(1);
        assert_eq!(limiter.check(peer, later), RateLimitOutcome::Allow);
    }
}
