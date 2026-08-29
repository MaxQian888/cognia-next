use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

/// Low-cardinality, content-free operational counters for shared chat.
#[derive(Default)]
pub struct ChatMetrics {
    authorization_denied: AtomicU64,
    event_append_failed: AtomicU64,
    stream_connections: AtomicU64,
    lease_conflicts: AtomicU64,
    approval_expired: AtomicU64,
    attachment_failed: AtomicU64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMetricsSnapshot {
    pub authorization_denied: u64,
    pub event_append_failed: u64,
    pub stream_connections: u64,
    pub lease_conflicts: u64,
    pub approval_expired: u64,
    pub attachment_failed: u64,
}

impl ChatMetrics {
    pub fn authorization_denied(&self) {
        self.authorization_denied.fetch_add(1, Ordering::Relaxed);
    }

    pub fn event_append_failed(&self) {
        self.event_append_failed.fetch_add(1, Ordering::Relaxed);
    }

    pub fn stream_connected(&self) {
        self.stream_connections.fetch_add(1, Ordering::Relaxed);
    }

    pub fn lease_conflict(&self) {
        self.lease_conflicts.fetch_add(1, Ordering::Relaxed);
    }

    pub fn approval_expired(&self) {
        self.approval_expired.fetch_add(1, Ordering::Relaxed);
    }

    pub fn attachment_failed(&self) {
        self.attachment_failed.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> ChatMetricsSnapshot {
        ChatMetricsSnapshot {
            authorization_denied: self.authorization_denied.load(Ordering::Relaxed),
            event_append_failed: self.event_append_failed.load(Ordering::Relaxed),
            stream_connections: self.stream_connections.load(Ordering::Relaxed),
            lease_conflicts: self.lease_conflicts.load(Ordering::Relaxed),
            approval_expired: self.approval_expired.load(Ordering::Relaxed),
            attachment_failed: self.attachment_failed.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_contains_only_bounded_aggregate_counters() {
        let metrics = ChatMetrics::default();
        metrics.authorization_denied();
        metrics.event_append_failed();
        metrics.stream_connected();
        metrics.lease_conflict();
        metrics.approval_expired();
        metrics.attachment_failed();

        assert_eq!(
            metrics.snapshot(),
            ChatMetricsSnapshot {
                authorization_denied: 1,
                event_append_failed: 1,
                stream_connections: 1,
                lease_conflicts: 1,
                approval_expired: 1,
                attachment_failed: 1,
            }
        );
    }
}
