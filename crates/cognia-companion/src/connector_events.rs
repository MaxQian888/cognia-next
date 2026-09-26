//! The connector event sink over the companion [`EventBus`].
//!
//! `cognia-connectors` publishes ingress and command-plane events through its
//! `EventEmitter` trait. On the companion host that sink is the event bus. The
//! adapter lives here rather than beside the bus because the bus sits below
//! the connectors crate in the layer map (ADR-0196).

use std::sync::Arc;

use serde_json::Value;

use super::event_bus::EventBus;

/// Connector event sink shared by the public ingress router and connector
/// command-plane RPC arms in headless mode.
pub struct ConnectorEventEmitter(pub Arc<EventBus>);

impl cognia_connectors::axum_app::EventEmitter for ConnectorEventEmitter {
    fn emit(&self, topic: &str, payload: Value) {
        self.0.publish(topic.to_string(), payload);
    }

    fn emit_ephemeral_to_brain(&self, topic: &str, payload: Value) {
        self.0.publish_ephemeral_to(
            topic.to_string(),
            payload,
            super::jwt::SERVICE_DEVICE_ID.to_string(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::super::event_bus::SubscribeResult;
    use super::super::jwt::SERVICE_DEVICE_ID;
    use super::*;
    use cognia_connectors::axum_app::EventEmitter as _;
    use serde_json::json;

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    }

    #[test]
    fn emit_publishes_a_replayable_frame_every_device_sees() {
        let bus = EventBus::new();
        ConnectorEventEmitter(Arc::clone(&bus)).emit("connectors://message", json!({"id": 1}));

        let SubscribeResult::Ok { replay, .. } = bus.subscribe(Some(0), now_ms()) else {
            panic!("a fresh bus never asks for a resync");
        };
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].event_type, "connectors://message");
        assert_eq!(replay[0].payload, json!({"id": 1}));
        assert!(replay[0].visible_to("any-device"));
    }

    #[test]
    fn brain_events_reach_only_the_service_principal_and_are_never_replayed() {
        let bus = EventBus::new();
        let SubscribeResult::Ok { mut receiver, .. } = bus.subscribe(None, now_ms()) else {
            panic!("a fresh bus never asks for a resync");
        };
        ConnectorEventEmitter(Arc::clone(&bus))
            .emit_ephemeral_to_brain("connectors://oauth-callback", json!({"code": "c"}));

        let frame = receiver.try_recv().expect("delivered live");
        assert_eq!(frame.event_type, "connectors://oauth-callback");
        assert_eq!(frame.target_device_id.as_deref(), Some(SERVICE_DEVICE_ID));
        assert!(!frame.visible_to("phone"));

        let SubscribeResult::Ok { replay, .. } = bus.subscribe(Some(0), now_ms()) else {
            panic!("a fresh bus never asks for a resync");
        };
        assert!(
            replay.is_empty(),
            "single-use events stay out of the replay buffer"
        );
    }
}
