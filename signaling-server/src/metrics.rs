//! Lightweight metrics for the signaling rendezvous.
//!
//! Plain atomic counters + a hand-rolled Prometheus text exposition. Kept
//! dependency-free on purpose — the alternative (`prometheus` crate) pulls
//! in `protobuf` transitively and we only need four counters.
//!
//! Wired into:
//!   - `ws::handle_frame` increments the per-action counters.
//!   - `server::metrics_handler` reads the counters into a single
//!     `text/plain` body suitable for `prom-client` / `node-exporter` /
//!     Grafana scrape.
//!   - `server::healthz` exposes a JSON snapshot for fly.io / k8s probes.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use crate::room::RoomRegistryStats;

/// Process-wide metric counters. Cloneable via `Arc<Metrics>` in
/// `AppState`. Counters use `Relaxed` ordering — they're observability,
/// not synchronization primitives.
pub struct Metrics {
    pub frames_in_total: AtomicU64,
    pub frames_relayed_total: AtomicU64,
    pub frames_rejected_replay: AtomicU64,
    pub frames_rejected_hmac: AtomicU64,
    pub frames_rejected_malformed: AtomicU64,
    pub frames_rejected_rate: AtomicU64,
    pub frames_rejected_not_subscribed: AtomicU64,
    pub frames_rejected_too_large: AtomicU64,
    pub frames_rejected_room_full: AtomicU64,
    pub frames_rejected_role_taken: AtomicU64,
    pub frames_rejected_origin: AtomicU64,
    /// `Instant` is sufficient because we only ever subtract from a single
    /// process — no clock-skew concerns vs. a wall clock here.
    pub started_at: Instant,
}

impl Metrics {
    pub fn new() -> Self {
        Self {
            frames_in_total: AtomicU64::new(0),
            frames_relayed_total: AtomicU64::new(0),
            frames_rejected_replay: AtomicU64::new(0),
            frames_rejected_hmac: AtomicU64::new(0),
            frames_rejected_malformed: AtomicU64::new(0),
            frames_rejected_rate: AtomicU64::new(0),
            frames_rejected_not_subscribed: AtomicU64::new(0),
            frames_rejected_too_large: AtomicU64::new(0),
            frames_rejected_room_full: AtomicU64::new(0),
            frames_rejected_role_taken: AtomicU64::new(0),
            frames_rejected_origin: AtomicU64::new(0),
            started_at: Instant::now(),
        }
    }

    pub fn frame_in(&self) {
        self.frames_in_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn frame_relayed(&self, fanout: u64) {
        // Each `relay` frame may fan out to N peers; count each delivered
        // copy so the Grafana panel reflects egress, not ingress.
        self.frames_relayed_total
            .fetch_add(fanout, Ordering::Relaxed);
    }

    pub fn frame_rejected(&self, reason: RejectReason) {
        let counter = match reason {
            RejectReason::Replay => &self.frames_rejected_replay,
            RejectReason::Hmac => &self.frames_rejected_hmac,
            RejectReason::Malformed => &self.frames_rejected_malformed,
            RejectReason::Rate => &self.frames_rejected_rate,
            RejectReason::NotSubscribed => &self.frames_rejected_not_subscribed,
            RejectReason::TooLarge => &self.frames_rejected_too_large,
            RejectReason::RoomFull => &self.frames_rejected_room_full,
            RejectReason::RoleTaken => &self.frames_rejected_role_taken,
            RejectReason::OriginRejected => &self.frames_rejected_origin,
        };
        counter.fetch_add(1, Ordering::Relaxed);
    }

    pub fn uptime_seconds(&self) -> u64 {
        self.started_at.elapsed().as_secs()
    }

    /// Render the Prometheus 0.0.4 text exposition format. Static format —
    /// no allocations beyond the result `String`. Stable enough that the
    /// integration test asserts the line ordering byte-for-byte.
    pub fn render_prometheus(&self, registry: RoomRegistryStats) -> String {
        let frames_in = self.frames_in_total.load(Ordering::Relaxed);
        let frames_relayed = self.frames_relayed_total.load(Ordering::Relaxed);
        let rej_replay = self.frames_rejected_replay.load(Ordering::Relaxed);
        let rej_hmac = self.frames_rejected_hmac.load(Ordering::Relaxed);
        let rej_malformed = self.frames_rejected_malformed.load(Ordering::Relaxed);
        let rej_rate = self.frames_rejected_rate.load(Ordering::Relaxed);
        let rej_not_sub = self.frames_rejected_not_subscribed.load(Ordering::Relaxed);
        let rej_too_large = self.frames_rejected_too_large.load(Ordering::Relaxed);
        let rej_room_full = self.frames_rejected_room_full.load(Ordering::Relaxed);
        let rej_role_taken = self.frames_rejected_role_taken.load(Ordering::Relaxed);
        let rej_origin = self.frames_rejected_origin.load(Ordering::Relaxed);
        let mut out = String::with_capacity(1024);
        out.push_str("# HELP signaling_frames_in_total Inbound client frames accepted for processing.\n");
        out.push_str("# TYPE signaling_frames_in_total counter\n");
        out.push_str(&format!("signaling_frames_in_total {}\n", frames_in));
        out.push_str(
            "# HELP signaling_frames_relayed_total Frames delivered to peers (1 per delivery, not per relay frame).\n",
        );
        out.push_str("# TYPE signaling_frames_relayed_total counter\n");
        out.push_str(&format!(
            "signaling_frames_relayed_total {}\n",
            frames_relayed
        ));
        out.push_str("# HELP signaling_frames_rejected_total Frames rejected, partitioned by reason.\n");
        out.push_str("# TYPE signaling_frames_rejected_total counter\n");
        out.push_str(&format!(
            "signaling_frames_rejected_total{{reason=\"replay\"}} {}\n",
            rej_replay
        ));
        out.push_str(&format!(
            "signaling_frames_rejected_total{{reason=\"hmac\"}} {}\n",
            rej_hmac
        ));
        out.push_str(&format!(
            "signaling_frames_rejected_total{{reason=\"malformed\"}} {}\n",
            rej_malformed
        ));
        out.push_str(&format!(
            "signaling_frames_rejected_total{{reason=\"rate\"}} {}\n",
            rej_rate
        ));
        out.push_str(&format!(
            "signaling_frames_rejected_total{{reason=\"not_subscribed\"}} {}\n",
            rej_not_sub
        ));
        out.push_str(&format!(
            "signaling_frames_rejected_total{{reason=\"too_large\"}} {}\n",
            rej_too_large
        ));
        out.push_str(&format!(
            "signaling_frames_rejected_total{{reason=\"room_full\"}} {}\n",
            rej_room_full
        ));
        out.push_str(&format!(
            "signaling_frames_rejected_total{{reason=\"role_taken\"}} {}\n",
            rej_role_taken
        ));
        out.push_str(&format!(
            "signaling_frames_rejected_total{{reason=\"origin\"}} {}\n",
            rej_origin
        ));
        out.push_str("# HELP signaling_rooms_active Currently-tracked rendezvous rooms.\n");
        out.push_str("# TYPE signaling_rooms_active gauge\n");
        out.push_str(&format!("signaling_rooms_active {}\n", registry.rooms));
        out.push_str("# HELP signaling_peers_active Total peers across all rooms.\n");
        out.push_str("# TYPE signaling_peers_active gauge\n");
        out.push_str(&format!("signaling_peers_active {}\n", registry.peers));
        out.push_str("# HELP signaling_uptime_seconds Process uptime in seconds.\n");
        out.push_str("# TYPE signaling_uptime_seconds gauge\n");
        out.push_str(&format!(
            "signaling_uptime_seconds {}\n",
            self.uptime_seconds()
        ));
        out
    }
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}

/// Discrete buckets used by `frames_rejected_total{reason=…}`. The server
/// only mints these from a handful of sites; keeping the enum closed makes
/// the cardinality of the Grafana panel obvious.
#[derive(Debug, Clone, Copy)]
pub enum RejectReason {
    Replay,
    Hmac,
    Malformed,
    Rate,
    NotSubscribed,
    TooLarge,
    /// `Subscribe` past the room peer cap.
    RoomFull,
    /// Second `Desktop` `Subscribe` into a room that already has one.
    RoleTaken,
    /// WS upgrade carrying an `Origin` not on the configured allowlist.
    OriginRejected,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn stats(rooms: usize, peers: usize) -> RoomRegistryStats {
        RoomRegistryStats { rooms, peers }
    }

    #[test]
    fn fresh_metrics_render_zero_counters() {
        let m = Metrics::new();
        let s = m.render_prometheus(stats(0, 0));
        assert!(s.contains("signaling_frames_in_total 0\n"));
        assert!(s.contains("signaling_frames_relayed_total 0\n"));
        assert!(s.contains("signaling_rooms_active 0\n"));
        assert!(s.contains("signaling_peers_active 0\n"));
        // Uptime line is always present (gauge — value depends on the
        // platform clock; just check the line exists).
        assert!(s.contains("signaling_uptime_seconds"));
    }

    #[test]
    fn increments_partition_by_reason() {
        let m = Metrics::new();
        m.frame_in();
        m.frame_in();
        m.frame_relayed(3);
        m.frame_rejected(RejectReason::Replay);
        m.frame_rejected(RejectReason::Hmac);
        m.frame_rejected(RejectReason::Hmac);
        m.frame_rejected(RejectReason::Malformed);
        m.frame_rejected(RejectReason::Rate);
        m.frame_rejected(RejectReason::NotSubscribed);
        m.frame_rejected(RejectReason::TooLarge);
        m.frame_rejected(RejectReason::RoomFull);
        m.frame_rejected(RejectReason::RoleTaken);
        m.frame_rejected(RejectReason::OriginRejected);
        let s = m.render_prometheus(stats(2, 5));
        assert!(s.contains("signaling_frames_in_total 2\n"));
        assert!(s.contains("signaling_frames_relayed_total 3\n"));
        assert!(s.contains("signaling_frames_rejected_total{reason=\"replay\"} 1\n"));
        assert!(s.contains("signaling_frames_rejected_total{reason=\"hmac\"} 2\n"));
        assert!(s.contains("signaling_frames_rejected_total{reason=\"malformed\"} 1\n"));
        assert!(s.contains("signaling_frames_rejected_total{reason=\"rate\"} 1\n"));
        assert!(s.contains("signaling_frames_rejected_total{reason=\"not_subscribed\"} 1\n"));
        assert!(s.contains("signaling_frames_rejected_total{reason=\"too_large\"} 1\n"));
        assert!(s.contains("signaling_frames_rejected_total{reason=\"room_full\"} 1\n"));
        assert!(s.contains("signaling_frames_rejected_total{reason=\"role_taken\"} 1\n"));
        assert!(s.contains("signaling_frames_rejected_total{reason=\"origin\"} 1\n"));
        assert!(s.contains("signaling_rooms_active 2\n"));
        assert!(s.contains("signaling_peers_active 5\n"));
    }

    #[test]
    fn exposition_has_help_and_type_lines() {
        let m = Metrics::new();
        let s = m.render_prometheus(stats(0, 0));
        // One HELP + TYPE per metric. Cheap check by counting line starts.
        let help_lines = s.matches("# HELP ").count();
        let type_lines = s.matches("# TYPE ").count();
        // frames_in, frames_relayed, frames_rejected, rooms_active,
        // peers_active, uptime_seconds.
        assert_eq!(help_lines, 6, "6 distinct metric families");
        assert_eq!(type_lines, 6);
    }

    #[test]
    fn reject_reason_is_debug_formattable() {
        // The enum is surfaced through `tracing` fields; keep its Debug repr
        // stable and ensure every arm is constructible.
        assert_eq!(format!("{:?}", RejectReason::Replay), "Replay");
        assert_eq!(format!("{:?}", RejectReason::Hmac), "Hmac");
        assert_eq!(format!("{:?}", RejectReason::TooLarge), "TooLarge");
    }

    #[test]
    fn default_matches_new() {
        let s = Metrics::default().render_prometheus(stats(0, 0));
        assert!(s.contains("signaling_frames_in_total 0\n"));
    }

    #[test]
    fn uptime_is_non_decreasing() {
        let m = Metrics::new();
        let first = m.uptime_seconds();
        // We don't sleep — Instant::elapsed is monotonic by spec, so
        // verifying it is >= the first reading is enough.
        let second = m.uptime_seconds();
        assert!(second >= first);
    }
}
