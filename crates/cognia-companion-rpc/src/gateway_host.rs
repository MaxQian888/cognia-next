//! Headless Gateway host adapter (ADR-0090 Phase 2).
//!
//! Bridges the gateway's host seam onto the companion EventBus so
//! `gateway://request-log` / `gateway://request-outcome` /
//! `gateway://translation-loss` ride `/ws/v1/events` exactly like
//! `claude://message` does. There is no renderer routing engine headless, so
//! live decisions are disabled — the snapshot's pre-ordered candidates are
//! used immediately.

use std::sync::Arc;

use cognia_companion::event_bus::EventBus;

pub struct HeadlessGatewayHost {
    pub event_bus: Arc<EventBus>,
}

impl cognia_gateway::host::GatewayHost for HeadlessGatewayHost {
    fn emit(&self, event: &str, payload: serde_json::Value) -> bool {
        // P6c: AccountBoundHost stamps this from the redeemed member ticket.
        // Never infer a member from request arguments or provider identifiers.
        let person = payload.get("personPartitionAccountId").and_then(serde_json::Value::as_str)
            .and_then(|account| cognia_companion::person_partition::fleet().and_then(|fleet| fleet.person(account)));
        let mut payload = payload;
        let partitioned = payload.as_object_mut().and_then(|map| map.remove("personPartitionAccountId")).is_some();
        if partitioned {
            if let Some(person) = person {
                cognia_companion::person_chat::person_publish_to(&self.event_bus, event, &payload, &person);
            }
        } else { cognia_companion::person_chat::person_publish(&self.event_bus, event, &payload); }
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

    #[tokio::test]
    async fn p6c_gateway_member_audience_is_stamped_and_unknown_partitions_fail_closed() {
        use cognia_gateway::host::GatewayHost;
        let _slot = cognia_companion::ws_bridge::test_support::lock_slot().await;
        let person = cognia_companion::person_partition::PersonPartition::new("org_p6c_gateway".into(), "usr_p6c_gateway".into());
        let (_installed, _) = cognia_companion::person_partition::person_test_support::Installed::new(vec![person.clone()]);
        let bus = EventBus::new(); let host = HeadlessGatewayHost { event_bus:bus.clone() };
        host.emit("gateway://request-log", serde_json::json!({"personPartitionAccountId":person.account_id,"sessionId":"p6c-gateway"}));
        host.emit("gateway://request-log", serde_json::json!({"personPartitionAccountId":"unknown","sessionId":"p6c-gateway"}));
        let cognia_companion::event_bus::SubscribeResult::Ok { replay, .. } = bus.subscribe(Some(0), 0) else { panic!("replay"); };
        assert!(!replay.is_empty());
        assert!(replay.iter().all(|frame| frame.partition_account_id.as_deref() == Some(person.account_id.as_str())));
        assert!(replay.iter().all(|frame| frame.payload.get("personPartitionAccountId").is_none()));
    }

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
            cognia_companion::event_bus::SubscribeResult::Ok { replay, .. } => {
                assert_eq!(replay.len(), 1);
                assert_eq!(replay[0].event_type, "gateway://request-log");
                assert_eq!(replay[0].payload["status"], 200);
            }
            _ => panic!("subscribe failed"),
        }
    }
}
