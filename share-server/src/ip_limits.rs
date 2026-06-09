//! Per-source-IP request rate limiting for the share service.
//!
//! One [`TokenBucket`] per active IP, kept in a `HashMap` behind a
//! `parking_lot::Mutex`. Buckets that have refilled to capacity are evicted by
//! [`IpRateLimiter::prune`] (called from the reaper) so the map stays O(active
//! IPs), not O(IPs ever seen).
//!
//! Client-IP resolution prefers proxy-set headers (`Fly-Client-IP`, first
//! `X-Forwarded-For`) and falls back to the TCP peer — copied from the signaling
//! server so the two behave identically behind the same edge.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use cognia_share_core::limits::TokenBucket;
use parking_lot::Mutex;

pub struct IpRateLimiter {
    rate_per_sec: u32,
    burst: u32,
    buckets: Mutex<HashMap<IpAddr, TokenBucket>>,
}

impl IpRateLimiter {
    pub fn new(rate_per_sec: u32, burst: u32) -> Arc<Self> {
        Arc::new(Self {
            rate_per_sec: rate_per_sec.max(1),
            burst: burst.max(1),
            buckets: Mutex::new(HashMap::new()),
        })
    }

    /// Try to admit one request from `ip` at wall-clock `now_ms`. Returns
    /// `false` when the IP's bucket is empty.
    pub fn check(&self, ip: IpAddr, now_ms: f64) -> bool {
        let mut buckets = self.buckets.lock();
        let bucket = buckets
            .entry(ip)
            .or_insert_with(|| TokenBucket::new(self.burst, self.rate_per_sec));
        bucket.try_take(now_ms)
    }

    /// Drop buckets that have refilled to capacity (idle IPs). Keeps the map
    /// bounded under churn.
    pub fn prune(&self, now_ms: f64) {
        let mut buckets = self.buckets.lock();
        buckets.retain(|_, bucket| !bucket.is_full(now_ms));
    }

    /// Number of IPs currently tracked (diagnostics).
    pub fn tracked(&self) -> usize {
        self.buckets.lock().len()
    }
}

/// Extract the best-known client IP from the request. Prefers `Fly-Client-IP` /
/// the first `X-Forwarded-For` hop (proxy-set), falls back to the TCP peer.
pub fn extract_client_ip(peer_addr: SocketAddr, headers: &axum::http::HeaderMap) -> IpAddr {
    if let Some(fly_ip) = headers.get("fly-client-ip").and_then(|v| v.to_str().ok()) {
        if let Ok(ip) = fly_ip.parse::<IpAddr>() {
            return ip;
        }
    }
    if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first) = xff.split(',').next() {
            if let Ok(ip) = first.trim().parse::<IpAddr>() {
                return ip;
            }
        }
    }
    peer_addr.ip()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn ip(addr: &str) -> IpAddr {
        addr.parse().unwrap()
    }

    #[test]
    fn admits_up_to_burst_then_rejects() {
        let lim = IpRateLimiter::new(1, 2);
        let a = ip("10.0.0.1");
        assert!(lim.check(a, 0.0));
        assert!(lim.check(a, 0.0));
        assert!(!lim.check(a, 0.0), "burst exhausted");
    }

    #[test]
    fn limits_are_per_ip_independent() {
        let lim = IpRateLimiter::new(1, 1);
        let a = ip("10.0.0.1");
        let b = ip("10.0.0.2");
        assert!(lim.check(a, 0.0));
        assert!(!lim.check(a, 0.0));
        // b has its own bucket.
        assert!(lim.check(b, 0.0));
    }

    #[test]
    fn refills_over_time() {
        let lim = IpRateLimiter::new(100, 1); // 100 tokens/sec, burst 1
        let a = ip("10.0.0.1");
        assert!(lim.check(a, 0.0));
        assert!(!lim.check(a, 0.0));
        assert!(lim.check(a, 10.0), "one token back after 10ms");
    }

    #[test]
    fn prune_evicts_idle_buckets() {
        let lim = IpRateLimiter::new(1000, 2);
        let a = ip("10.0.0.1");
        assert!(lim.check(a, 0.0));
        assert_eq!(lim.tracked(), 1);
        // After enough time the bucket is full again → eviction.
        lim.prune(10_000.0);
        assert_eq!(lim.tracked(), 0);
    }

    #[test]
    fn prune_keeps_active_buckets() {
        let lim = IpRateLimiter::new(1, 2);
        let a = ip("10.0.0.1");
        assert!(lim.check(a, 0.0));
        assert!(lim.check(a, 0.0)); // drained
        lim.prune(0.0);
        assert_eq!(lim.tracked(), 1, "drained bucket must survive pruning");
    }

    #[test]
    fn zero_config_is_clamped_to_one() {
        let lim = IpRateLimiter::new(0, 0);
        let a = ip("10.0.0.1");
        assert!(lim.check(a, 0.0), "clamped burst of 1 admits the first request");
        assert!(!lim.check(a, 0.0));
    }

    #[test]
    fn extract_client_ip_prefers_fly_then_xff_then_peer() {
        let peer = SocketAddr::from((Ipv4Addr::new(127, 0, 0, 1), 5000));

        let mut h = axum::http::HeaderMap::new();
        h.insert("fly-client-ip", "203.0.113.5".parse().unwrap());
        h.insert("x-forwarded-for", "198.51.100.7".parse().unwrap());
        assert_eq!(extract_client_ip(peer, &h), ip("203.0.113.5"));

        let mut h = axum::http::HeaderMap::new();
        h.insert("x-forwarded-for", "198.51.100.7, 10.0.0.1".parse().unwrap());
        assert_eq!(extract_client_ip(peer, &h), ip("198.51.100.7"));

        let h = axum::http::HeaderMap::new();
        assert_eq!(extract_client_ip(peer, &h), ip("127.0.0.1"));

        let mut h = axum::http::HeaderMap::new();
        h.insert("x-forwarded-for", "garbage".parse().unwrap());
        assert_eq!(extract_client_ip(peer, &h), ip("127.0.0.1"));
    }
}
