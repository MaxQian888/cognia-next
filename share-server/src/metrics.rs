//! Lightweight metrics for the share service.
//!
//! Plain atomic counters + a hand-rolled Prometheus text exposition, mirroring
//! the signaling server's approach (dependency-free — the `prometheus` crate
//! would pull in `protobuf` for what is a handful of counters).
//!
//! Wired into:
//!   - `handlers` increment per-action counters.
//!   - `server::metrics_handler` renders them as `text/plain`.
//!   - `server::healthz` exposes a JSON snapshot for fly.io / k8s probes.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

/// Process-wide counters. Held as `Arc<Metrics>` in `AppState`; `Relaxed`
/// ordering throughout — observability, not synchronization.
pub struct Metrics {
    pub created_total: AtomicU64,
    pub read_total: AtomicU64,
    pub deleted_total: AtomicU64,
    pub rejected_unauthorized: AtomicU64,
    pub rejected_too_large: AtomicU64,
    pub rejected_invalid: AtomicU64,
    pub rejected_not_found: AtomicU64,
    pub rejected_rate: AtomicU64,
    pub started_at: Instant,
}

impl Metrics {
    pub fn new() -> Self {
        Self {
            created_total: AtomicU64::new(0),
            read_total: AtomicU64::new(0),
            deleted_total: AtomicU64::new(0),
            rejected_unauthorized: AtomicU64::new(0),
            rejected_too_large: AtomicU64::new(0),
            rejected_invalid: AtomicU64::new(0),
            rejected_not_found: AtomicU64::new(0),
            rejected_rate: AtomicU64::new(0),
            started_at: Instant::now(),
        }
    }

    pub fn created(&self) {
        self.created_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn read(&self) {
        self.read_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn deleted(&self) {
        self.deleted_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn rejected(&self, reason: RejectReason) {
        let counter = match reason {
            RejectReason::Unauthorized => &self.rejected_unauthorized,
            RejectReason::TooLarge => &self.rejected_too_large,
            RejectReason::Invalid => &self.rejected_invalid,
            RejectReason::NotFound => &self.rejected_not_found,
            RejectReason::Rate => &self.rejected_rate,
        };
        counter.fetch_add(1, Ordering::Relaxed);
    }

    pub fn uptime_seconds(&self) -> u64 {
        self.started_at.elapsed().as_secs()
    }

    /// Render the Prometheus 0.0.4 text exposition. `active` is the current live
    /// share count (a gauge sourced from the store).
    pub fn render_prometheus(&self, active: u64) -> String {
        let created = self.created_total.load(Ordering::Relaxed);
        let read = self.read_total.load(Ordering::Relaxed);
        let deleted = self.deleted_total.load(Ordering::Relaxed);
        let rej_unauth = self.rejected_unauthorized.load(Ordering::Relaxed);
        let rej_too_large = self.rejected_too_large.load(Ordering::Relaxed);
        let rej_invalid = self.rejected_invalid.load(Ordering::Relaxed);
        let rej_not_found = self.rejected_not_found.load(Ordering::Relaxed);
        let rej_rate = self.rejected_rate.load(Ordering::Relaxed);

        let mut out = String::with_capacity(1024);
        out.push_str("# HELP share_created_total Shares created.\n");
        out.push_str("# TYPE share_created_total counter\n");
        out.push_str(&format!("share_created_total {created}\n"));
        out.push_str("# HELP share_read_total Shares served to readers.\n");
        out.push_str("# TYPE share_read_total counter\n");
        out.push_str(&format!("share_read_total {read}\n"));
        out.push_str("# HELP share_deleted_total Shares deleted by owner revoke.\n");
        out.push_str("# TYPE share_deleted_total counter\n");
        out.push_str(&format!("share_deleted_total {deleted}\n"));
        out.push_str("# HELP share_rejected_total Requests rejected, partitioned by reason.\n");
        out.push_str("# TYPE share_rejected_total counter\n");
        out.push_str(&format!(
            "share_rejected_total{{reason=\"unauthorized\"}} {rej_unauth}\n"
        ));
        out.push_str(&format!(
            "share_rejected_total{{reason=\"too_large\"}} {rej_too_large}\n"
        ));
        out.push_str(&format!(
            "share_rejected_total{{reason=\"invalid\"}} {rej_invalid}\n"
        ));
        out.push_str(&format!(
            "share_rejected_total{{reason=\"not_found\"}} {rej_not_found}\n"
        ));
        out.push_str(&format!(
            "share_rejected_total{{reason=\"rate\"}} {rej_rate}\n"
        ));
        out.push_str("# HELP share_active Currently-stored shares.\n");
        out.push_str("# TYPE share_active gauge\n");
        out.push_str(&format!("share_active {active}\n"));
        out.push_str("# HELP share_uptime_seconds Process uptime in seconds.\n");
        out.push_str("# TYPE share_uptime_seconds gauge\n");
        out.push_str(&format!("share_uptime_seconds {}\n", self.uptime_seconds()));
        out
    }
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}

/// Closed set of rejection buckets for `share_rejected_total{reason=…}`.
#[derive(Debug, Clone, Copy)]
pub enum RejectReason {
    Unauthorized,
    TooLarge,
    Invalid,
    NotFound,
    Rate,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_metrics_render_zero_counters() {
        let m = Metrics::new();
        let s = m.render_prometheus(0);
        assert!(s.contains("share_created_total 0\n"));
        assert!(s.contains("share_read_total 0\n"));
        assert!(s.contains("share_active 0\n"));
        assert!(s.contains("share_uptime_seconds"));
    }

    #[test]
    fn increments_partition_by_reason() {
        let m = Metrics::new();
        m.created();
        m.created();
        m.read();
        m.deleted();
        m.rejected(RejectReason::Unauthorized);
        m.rejected(RejectReason::TooLarge);
        m.rejected(RejectReason::Invalid);
        m.rejected(RejectReason::NotFound);
        m.rejected(RejectReason::Rate);
        let s = m.render_prometheus(3);
        assert!(s.contains("share_created_total 2\n"));
        assert!(s.contains("share_read_total 1\n"));
        assert!(s.contains("share_deleted_total 1\n"));
        assert!(s.contains("share_rejected_total{reason=\"unauthorized\"} 1\n"));
        assert!(s.contains("share_rejected_total{reason=\"too_large\"} 1\n"));
        assert!(s.contains("share_rejected_total{reason=\"invalid\"} 1\n"));
        assert!(s.contains("share_rejected_total{reason=\"not_found\"} 1\n"));
        assert!(s.contains("share_rejected_total{reason=\"rate\"} 1\n"));
        assert!(s.contains("share_active 3\n"));
    }

    #[test]
    fn exposition_has_help_and_type_lines() {
        let m = Metrics::new();
        let s = m.render_prometheus(0);
        // created, read, deleted, rejected, active, uptime → 6 families.
        assert_eq!(s.matches("# HELP ").count(), 6);
        assert_eq!(s.matches("# TYPE ").count(), 6);
    }

    #[test]
    fn default_matches_new() {
        assert!(Metrics::default().render_prometheus(0).contains("share_created_total 0\n"));
    }

    #[test]
    fn reject_reason_is_debug_formattable() {
        assert_eq!(format!("{:?}", RejectReason::Unauthorized), "Unauthorized");
        assert_eq!(format!("{:?}", RejectReason::Rate), "Rate");
    }

    #[test]
    fn uptime_is_non_decreasing() {
        let m = Metrics::new();
        let first = m.uptime_seconds();
        let second = m.uptime_seconds();
        assert!(second >= first);
    }
}
