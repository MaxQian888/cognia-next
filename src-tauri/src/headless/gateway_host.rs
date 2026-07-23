//! Headless Gateway host adapter (ADR-0090 Phase 2).
//!
//! Bridges the gateway's host seam onto the companion EventBus so
//! `gateway://request-log` / `gateway://request-outcome` /
//! `gateway://translation-loss` ride `/ws/v1/events` exactly like
//! `claude://message` does. There is no renderer routing engine headless, so
//! live decisions are disabled — the snapshot's pre-ordered candidates are
//! used immediately.

use std::sync::Arc;

use crate::companion_api::event_bus::EventBus;

pub struct HeadlessGatewayHost {
    pub event_bus: Arc<EventBus>,
}

impl cognia_gateway::host::GatewayHost for HeadlessGatewayHost {
    fn emit(&self, event: &str, payload: serde_json::Value) -> bool {
        self.event_bus.publish(event.to_string(), payload);
        true
    }

    fn supports_live_decisions(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_gateway::host::GatewayHost;

    #[test]
    fn emits_into_the_companion_bus_and_disables_live_decisions() {
        let bus = EventBus::new();
        let host = HeadlessGatewayHost {
            event_bus: Arc::clone(&bus),
        };
        assert!(!host.supports_live_decisions());
        assert!(host.emit(
            "gateway://request-log",
            serde_json::json!({ "status": 200 })
        ));

        match bus.subscribe(Some(0), 0) {
            crate::companion_api::event_bus::SubscribeResult::Ok { replay, .. } => {
                assert_eq!(replay.len(), 1);
                assert_eq!(replay[0].event_type, "gateway://request-log");
                assert_eq!(replay[0].payload["status"], 200);
            }
            _ => panic!("subscribe failed"),
        }
    }
}
