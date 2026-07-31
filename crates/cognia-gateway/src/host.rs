//! Host seam (ADR-0090 Phase 2).
//!
//! The gateway's ONLY host coupling is event emission (`gateway://request-log`,
//! `gateway://request-outcome`, the `gateway://decide` round-trip). This trait
//! abstracts it so the same server runs under Tauri (desktop renderer events)
//! and under `cognia-server` (companion EventBus → `/ws/v1/events`), without
//! duplicating any gateway logic.

use serde_json::Value;

pub trait GatewayHost: Send + Sync + 'static {
    /// Fire-and-forget event emission. Returns `false` when the host could
    /// not accept the event (the decide round-trip treats that as "no live
    /// decision available").
    fn emit(&self, event: &str, payload: Value) -> bool;

    /// Whether a renderer-style routing engine is listening on
    /// `gateway://decide`. Headless hosts return `false`, which short-circuits
    /// the decide wait entirely — the snapshot's pre-ordered candidates are
    /// used immediately instead of burning the decide timeout per request.
    fn supports_live_decisions(&self) -> bool {
        true
    }
}

/// Host that swallows events — fixtures and the crate's integration tests.
pub struct NoopGatewayHost;

impl GatewayHost for NoopGatewayHost {
    fn emit(&self, _event: &str, _payload: Value) -> bool {
        true
    }

    fn supports_live_decisions(&self) -> bool {
        false
    }
}

/// Desktop adapter: events ride Tauri's app-wide emitter exactly as before.
#[cfg(feature = "tauri-host")]
pub struct TauriGatewayHost(pub tauri::AppHandle);

#[cfg(feature = "tauri-host")]
impl GatewayHost for TauriGatewayHost {
    fn emit(&self, event: &str, payload: Value) -> bool {
        use tauri::Emitter;
        self.0.emit(event, payload).is_ok()
    }
}

/// Test/observability host that records every emitted event in memory.
pub struct RecordingGatewayHost {
    pub events: parking_lot::Mutex<Vec<(String, Value)>>,
    live_decisions: bool,
}

impl RecordingGatewayHost {
    pub fn new(live_decisions: bool) -> Self {
        Self {
            events: parking_lot::Mutex::new(Vec::new()),
            live_decisions,
        }
    }
}

impl GatewayHost for RecordingGatewayHost {
    fn emit(&self, event: &str, payload: Value) -> bool {
        self.events.lock().push((event.to_string(), payload));
        true
    }

    fn supports_live_decisions(&self) -> bool {
        self.live_decisions
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noop_swallows_and_disables_live_decisions() {
        let host = NoopGatewayHost;
        assert!(host.emit("gateway://request-log", serde_json::json!({})));
        assert!(!host.supports_live_decisions());
    }

    #[test]
    fn recording_host_captures_events_in_order() {
        let host = RecordingGatewayHost::new(true);
        assert!(host.supports_live_decisions());
        host.emit("a", serde_json::json!({ "n": 1 }));
        host.emit("b", serde_json::json!({ "n": 2 }));
        let events = host.events.lock();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, "a");
        assert_eq!(events[1].1["n"], 2);
    }
}
