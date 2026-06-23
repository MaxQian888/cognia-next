//! Background TTL reaper.
//!
//! The read/stats paths already delete expired shares lazily on access; this
//! task sweeps shares that expire without ever being read again (the
//! self-hosted equivalent of Cloudflare KV's TTL auto-expiry). It also prunes
//! idle per-IP rate-limit buckets so that map stays bounded.

use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinHandle;
use tracing::{debug, warn};

use crate::ip_limits::IpRateLimiter;
use crate::server::{now_ms_f64, now_ms_i64};
use crate::store::Store;

/// Spawn the periodic reaper. Returns the join handle (the caller may drop it;
/// the task lives for the process and stops when the runtime shuts down).
pub fn spawn(store: Arc<Store>, rate: Arc<IpRateLimiter>, interval_secs: u64) -> JoinHandle<()> {
    let period = Duration::from_secs(interval_secs.max(1));
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(period);
        // Skip the immediate first tick so startup isn't a no-op sweep.
        tick.tick().await;
        loop {
            tick.tick().await;
            let now = now_ms_i64();
            let store = store.clone();
            match tokio::task::spawn_blocking(move || store.reap_expired(now)).await {
                Ok(Ok(n)) if n > 0 => debug!(target: "share", reaped = n, "expired shares pruned"),
                Ok(Ok(_)) => {}
                other => warn!(target: "share", ?other, "reaper sweep failed"),
            }
            rate.prune(now_ms_f64());
        }
    })
}
