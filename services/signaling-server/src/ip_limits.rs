//! Per-source-IP connection cap for the rendezvous service.
//!
//! Complements the existing per-CONNECTION token bucket in
//! [`crate::limits`] — that one bounds a single misbehaving client's
//! frame rate, this one bounds a single misbehaving source from
//! exhausting the server's connection table via 10k concurrent sockets.
//!
//! Numbers (overridable via env):
//!   - `SIGNALING_MAX_CONN_PER_IP` — default 50 concurrent sockets per IP.
//!
//! IPs are tracked in a plain `HashMap` behind a `parking_lot::Mutex`.
//! Entries are evicted when the count returns to zero, so the map stays
//! O(concurrent unique IPs) — not O(total IPs ever seen).
//!
//! Behind a Fly.io / Cloudflare proxy the apparent peer IP is the proxy.
//! The WS upgrade handler reads `Fly-Client-IP` / `X-Forwarded-For` only when
//! `SIGNALING_TRUST_PROXY_HEADERS=1|true|yes|on`; direct self-hosts should keep
//! that unset so clients cannot spoof the rate-limit key.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use parking_lot::Mutex;
use tracing::warn;

/// Hard cap on concurrent sockets per source IP. Overridable via
/// `SIGNALING_MAX_CONN_PER_IP` env at boot.
pub fn default_max_conn_per_ip() -> usize {
    std::env::var("SIGNALING_MAX_CONN_PER_IP")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(50)
}

/// Whether proxy-provided client-IP headers should be trusted. Disabled by
/// default because a directly exposed self-hosted server would otherwise let
/// clients spoof `X-Forwarded-For` to bypass the per-IP connection cap.
pub fn trust_proxy_headers_from_env() -> bool {
    std::env::var("SIGNALING_TRUST_PROXY_HEADERS")
        .ok()
        .map(|s| {
            matches!(
                s.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

pub struct IpLimits {
    max_per_ip: usize,
    counts: Mutex<HashMap<IpAddr, usize>>,
}

impl IpLimits {
    pub fn new(max_per_ip: usize) -> Arc<Self> {
        Arc::new(Self {
            max_per_ip,
            counts: Mutex::new(HashMap::new()),
        })
    }

    /// Try to record one more connection from `ip`. Returns
    /// [`AcquireOutcome::Accepted`] with a guard that decrements the
    /// counter on drop, or [`AcquireOutcome::Rejected`] when the cap is
    /// already reached. Holding the guard across an `await` is safe
    /// because the mutex is only locked for the increment/decrement.
    pub fn try_acquire(self: &Arc<Self>, ip: IpAddr) -> AcquireOutcome {
        let mut counts = self.counts.lock();
        let entry = counts.entry(ip).or_insert(0);
        if *entry >= self.max_per_ip {
            warn!(target: "signaling", %ip, max = self.max_per_ip, "per-ip connection cap hit");
            return AcquireOutcome::Rejected {
                current: *entry,
                max: self.max_per_ip,
            };
        }
        *entry += 1;
        AcquireOutcome::Accepted(Acquired {
            inner: Arc::clone(self),
            ip,
        })
    }

    /// Snapshot for diagnostics — total IPs currently tracked + sum of
    /// concurrent connections. O(n) over the active set.
    pub fn snapshot(&self) -> IpLimitsSnapshot {
        let counts = self.counts.lock();
        let total: usize = counts.values().sum();
        IpLimitsSnapshot {
            unique_ips: counts.len(),
            connections: total,
            max_per_ip: self.max_per_ip,
        }
    }

    fn release(&self, ip: IpAddr) {
        let mut counts = self.counts.lock();
        if let Some(n) = counts.get_mut(&ip) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                counts.remove(&ip);
            }
        }
    }
}

#[derive(Debug)]
pub enum AcquireOutcome {
    Accepted(Acquired),
    Rejected { current: usize, max: usize },
}

/// RAII guard returned by [`IpLimits::try_acquire`]. Decrements the
/// per-IP counter when dropped, regardless of normal completion vs
/// panic — the WS loop just stores it as a stack local.
pub struct Acquired {
    inner: Arc<IpLimits>,
    ip: IpAddr,
}

impl std::fmt::Debug for Acquired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Acquired").field("ip", &self.ip).finish()
    }
}

impl Drop for Acquired {
    fn drop(&mut self) {
        self.inner.release(self.ip);
    }
}

#[derive(Debug, Clone, Copy)]
pub struct IpLimitsSnapshot {
    pub unique_ips: usize,
    pub connections: usize,
    pub max_per_ip: usize,
}

/// Extract the best-known client IP from the request. Prefers
/// `Fly-Client-IP` / `X-Forwarded-For` (proxy-set), falls back to the
/// TCP-layer peer address.
///
/// Only the FIRST entry of `X-Forwarded-For` is honored; a malicious
/// client can stuff their own header on direct deployments, so proxy headers
/// are ignored unless the caller explicitly trusts them.
pub fn extract_client_ip(
    peer_addr: SocketAddr,
    headers: &axum::http::HeaderMap,
    trust_proxy_headers: bool,
) -> IpAddr {
    if trust_proxy_headers {
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
    }
    peer_addr.ip()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn ip(addr: &str) -> IpAddr {
        addr.parse().unwrap()
    }

    #[test]
    fn try_acquire_accepts_up_to_cap_per_ip() {
        // Bind each guard to a `let` so it stays alive — `matches!` would
        // drop the `Acquired` immediately and the counter would re-zero,
        // hiding the cap.
        let lim = IpLimits::new(3);
        let a = ip("10.0.0.1");
        let _g1 = match lim.try_acquire(a) {
            AcquireOutcome::Accepted(g) => g,
            other => panic!("g1: {:?}", other),
        };
        let _g2 = match lim.try_acquire(a) {
            AcquireOutcome::Accepted(g) => g,
            other => panic!("g2: {:?}", other),
        };
        let _g3 = match lim.try_acquire(a) {
            AcquireOutcome::Accepted(g) => g,
            other => panic!("g3: {:?}", other),
        };
        match lim.try_acquire(a) {
            AcquireOutcome::Rejected { current, max } => {
                assert_eq!(current, 3);
                assert_eq!(max, 3);
            }
            other => panic!("4th acquire should be rejected, got {:?}", other),
        }
    }

    #[test]
    fn debug_impls_are_exercised() {
        // These Debug reprs only ever fire from `tracing`/`panic!` paths that
        // don't run on the happy path, so exercise them directly.
        let lim = IpLimits::new(1);
        let a = ip("10.0.0.1");
        let outcome = lim.try_acquire(a);
        match &outcome {
            AcquireOutcome::Accepted(guard) => {
                assert!(format!("{guard:?}").contains("Acquired"));
            }
            AcquireOutcome::Rejected { .. } => panic!("first acquire must be accepted"),
        }
        assert!(format!("{outcome:?}").contains("Accepted"));

        // Second acquire on the same IP is rejected — covers that Debug arm.
        let rejected = lim.try_acquire(a);
        assert!(format!("{rejected:?}").contains("Rejected"));

        // Snapshot is logged on the metrics path.
        assert!(format!("{:?}", lim.snapshot()).contains("max_per_ip"));
    }

    #[test]
    fn drop_releases_a_slot() {
        let lim = IpLimits::new(2);
        let a = ip("10.0.0.1");
        let g1 = match lim.try_acquire(a) {
            AcquireOutcome::Accepted(g) => g,
            other => panic!("expected accept, got {:?}", other),
        };
        let _g2 = match lim.try_acquire(a) {
            AcquireOutcome::Accepted(g) => g,
            other => panic!("expected accept, got {:?}", other),
        };
        // Cap hit.
        assert!(matches!(
            lim.try_acquire(a),
            AcquireOutcome::Rejected { .. }
        ));
        // Drop the first → frees the slot.
        drop(g1);
        assert!(matches!(lim.try_acquire(a), AcquireOutcome::Accepted(_)));
    }

    #[test]
    fn limits_are_per_ip_independent() {
        let lim = IpLimits::new(1);
        let a = ip("10.0.0.1");
        let b = ip("10.0.0.2");
        let _ga = match lim.try_acquire(a) {
            AcquireOutcome::Accepted(g) => g,
            _ => panic!(),
        };
        let _gb = match lim.try_acquire(b) {
            AcquireOutcome::Accepted(g) => g,
            _ => panic!(),
        };
        // a is at cap.
        assert!(matches!(
            lim.try_acquire(a),
            AcquireOutcome::Rejected { .. }
        ));
        // b is also at cap (independent counter).
        assert!(matches!(
            lim.try_acquire(b),
            AcquireOutcome::Rejected { .. }
        ));
    }

    #[test]
    fn snapshot_reports_active_set() {
        let lim = IpLimits::new(10);
        let _a = lim.try_acquire(ip("10.0.0.1"));
        let _b = lim.try_acquire(ip("10.0.0.2"));
        let _c = lim.try_acquire(ip("10.0.0.2"));
        let snap = lim.snapshot();
        assert_eq!(snap.unique_ips, 2);
        assert_eq!(snap.connections, 3);
        assert_eq!(snap.max_per_ip, 10);
    }

    #[test]
    fn dropped_entry_is_evicted_from_map() {
        let lim = IpLimits::new(5);
        let g = match lim.try_acquire(ip("10.0.0.1")) {
            AcquireOutcome::Accepted(g) => g,
            _ => panic!(),
        };
        assert_eq!(lim.snapshot().unique_ips, 1);
        drop(g);
        assert_eq!(
            lim.snapshot().unique_ips,
            0,
            "IP with 0 active connections should be evicted from the map"
        );
    }

    #[test]
    fn extract_client_ip_ignores_proxy_headers_when_not_trusted() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("fly-client-ip", "203.0.113.5".parse().unwrap());
        headers.insert("x-forwarded-for", "198.51.100.7".parse().unwrap());
        let peer = SocketAddr::from((Ipv4Addr::new(192, 0, 2, 42), 12345));
        let ip = extract_client_ip(peer, &headers, false);
        assert_eq!(ip, "192.0.2.42".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn extract_client_ip_prefers_fly_client_ip() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("fly-client-ip", "203.0.113.5".parse().unwrap());
        headers.insert("x-forwarded-for", "198.51.100.7".parse().unwrap());
        let peer = SocketAddr::from((Ipv4Addr::new(127, 0, 0, 1), 12345));
        let ip = extract_client_ip(peer, &headers, true);
        assert_eq!(ip, "203.0.113.5".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn extract_client_ip_falls_back_to_x_forwarded_for() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("x-forwarded-for", "198.51.100.7, 10.0.0.1".parse().unwrap());
        let peer = SocketAddr::from((Ipv4Addr::new(127, 0, 0, 1), 12345));
        let ip = extract_client_ip(peer, &headers, true);
        assert_eq!(ip, "198.51.100.7".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn extract_client_ip_falls_back_to_peer_address() {
        let headers = axum::http::HeaderMap::new();
        let peer = SocketAddr::from((Ipv4Addr::new(192, 0, 2, 42), 12345));
        let ip = extract_client_ip(peer, &headers, true);
        assert_eq!(ip, "192.0.2.42".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn extract_client_ip_rejects_malformed_xff() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("x-forwarded-for", "not-an-ip".parse().unwrap());
        let peer = SocketAddr::from((Ipv4Addr::new(192, 0, 2, 42), 12345));
        let ip = extract_client_ip(peer, &headers, true);
        assert_eq!(
            ip,
            "192.0.2.42".parse::<IpAddr>().unwrap(),
            "malformed XFF should fall through to peer addr"
        );
    }
}
