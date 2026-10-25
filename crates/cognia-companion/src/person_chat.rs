//! P6c ephemeral chat ownership. Independent of task-local dispatch: sidecar
//! readers and replay consumers run in other tasks. Never evict bindings while
//! the shared sidecar or its replay frames can still exist.
use std::collections::HashMap;
use parking_lot::RwLock;
use once_cell::sync::Lazy;
use serde_json::Value;
use crate::{middleware::DeviceContext, person_partition::PersonPartition};

pub fn person_command_allowed(command: &str) -> bool {
    crate::host_surface_policy::POLICY.as_ref().is_ok_and(|policy| policy.person_brain_admits(command))
}

pub fn person_caller(principal: &DeviceContext, command: &str) -> Result<PersonPartition, cognia_problem::Problem> {
    let denied = || cognia_problem::Problem::with_status(axum::http::StatusCode::FORBIDDEN,
        "host_surface_forbidden", "host_surface_forbidden");
    if principal.scope != "person-brain" || !person_command_allowed(command) {
        log::warn!("person brain command refused: {command:?} is outside the closed partition channel (scope {})", principal.scope);
        return Err(denied());
    }
    crate::person_partition::fleet().and_then(|fleet| fleet.person(&principal.tenant_id)).ok_or_else(|| {
        log::warn!("person brain command refused: {command:?}, no partition for this principal");
        denied()
    })
}

#[derive(Default)]
pub struct PersonSessions(RwLock<HashMap<String, Option<PersonPartition>>>);
pub static PERSON_SESSIONS: Lazy<PersonSessions> = Lazy::new(PersonSessions::default);
impl PersonSessions {
    pub fn bind(&self, session: &str, person: Option<&PersonPartition>) -> Result<(), &'static str> {
        let mut sessions = self.0.write();
        if let Some(owner) = sessions.get(session) {
            if owner.as_ref().map(|p| &p.account_id) != person.map(|p| &p.account_id) {
                return Err("host_surface_forbidden");
            }
        } else { sessions.insert(session.into(), person.cloned()); }
        Ok(())
    }
    pub fn check(&self, session: &str, person: Option<&PersonPartition>) -> Result<(), &'static str> {
        let sessions = self.0.read();
        match sessions.get(session) {
            Some(owner) if owner.as_ref().map(|p| &p.account_id) == person.map(|p| &p.account_id) => Ok(()),
            None if person.is_none() => Ok(()),
            _ => Err("host_surface_forbidden"),
        }
    }
    fn check_existing(&self, session: &str, person: Option<&PersonPartition>) -> Result<(), &'static str> {
        let sessions = self.0.read();
        if let Some(owner) = sessions.get(session) {
            if owner.as_ref().map(|p| &p.account_id) != person.map(|p| &p.account_id) { return Err("host_surface_forbidden"); }
        }
        Ok(())
    }
    pub fn owner(&self, session: &str) -> Option<PersonPartition> { self.0.read().get(session).cloned().flatten() }
    fn observe(&self, session: &str) -> Option<PersonPartition> {
        self.0.write().entry(session.into()).or_insert(None).clone()
    }
}

/// P6c also guards legacy/service session control aliases and nested params.
fn person_control_session_ids(args: &Value) -> Vec<&str> {
    let mut ids = Vec::new();
    match args {
        Value::Object(map) => for (key, value) in map {
            if matches!(key.as_str(), "sessionId" | "session_id" | "resumeSessionId" | "forkFromSessionId" | "ownerSessionId") {
                if let Some(session) = value.as_str() { ids.push(session); }
            }
            // User prompts/messages may mention ids without driving them.
            if matches!(key.as_str(), "params" | "options" | "sendOptions" | "request" | "input" | "intent" | "payload" | "toolHost") {
                ids.extend(person_control_session_ids(value));
            }
        },
        Value::Array(values) => for value in values { ids.extend(person_control_session_ids(value)); },
        _ => (),
    }
    ids
}
pub fn person_check_session_args(args: &Value, person: Option<&PersonPartition>) -> Result<(), &'static str> {
    for session in person_control_session_ids(args) { PERSON_SESSIONS.check_existing(session, person)?; }
    Ok(())
}
/// Atomically fence operator control before any await/write. A check alone
/// would race a person's first send between validation and sidecar delivery.
pub fn person_claim_operator_control_args(args: &Value) -> Result<(), &'static str> {
    for session in person_control_session_ids(args) { PERSON_SESSIONS.bind(session, None)?; }
    Ok(())
}

pub fn person_event_session(payload: &Value) -> Option<&str> {
    payload.get("sessionId").or_else(|| payload.get("session_id")).and_then(Value::as_str)
        .or_else(|| payload.get("event").and_then(person_event_session))
}

/// Stamp audiences at publication, before the replay buffer. One targeted
/// frame for the owning brain and one per currently bound OIDC device. All
/// transports still recheck device standing at delivery (including replay).
pub fn person_publish(bus: &crate::event_bus::EventBus, channel: &str, payload: &Value) {
    if let Some(person) = person_event_session(payload).and_then(|session| PERSON_SESSIONS.observe(session)) {
        person_publish_to(bus, channel, payload, &person);
    } else { bus.publish(channel.into(), payload.clone()); }
}

/// Also used by the gateway's Host-stamped member-ticket audience, before a
/// first agent_send binds the session. Brain-supplied payloads cannot call it.
pub fn person_publish_to(bus: &crate::event_bus::EventBus, channel: &str, payload: &Value, person: &PersonPartition) {
    let devices = crate::security_store::security_store()
        .and_then(|store| store.person_devices(&person.org_id, &person.user_id).ok()).unwrap_or_default();
    person_publish_audience(bus, channel, payload, person, devices);
}
/// A member brain's live in-flight reply (`transcript://live`): one frame for
/// the person's partition, never replayed. Delivery resolves the audience to
/// the devices bound to the person at that moment (`person_partition::
/// event_visible`); the person's own brain may see it too, and never
/// subscribes to it.
pub fn person_publish_live(bus: &crate::event_bus::EventBus, channel: &str, payload: &Value, person: &PersonPartition) {
    bus.publish_person_ephemeral(channel.into(), payload.clone(), person.account_id.clone());
}
fn person_publish_audience(bus: &crate::event_bus::EventBus, channel: &str, payload: &Value,
    person: &PersonPartition, devices: Vec<String>) {
    bus.publish_person_to(channel.into(), payload.clone(), format!("brain-{}", person.account_id), person.account_id.clone());
    for device in devices {
        bus.publish_person_to(channel.into(), payload.clone(), device, person.account_id.clone());
    }
}

/// Apply before serializing replay/live frames. The service sidecar exception
/// in EventFrame::visible_to_connection must never bypass person ownership.
pub fn person_connection_visible(frame: &crate::event_bus::EventFrame, device: &str, tenant: Option<&str>) -> bool {
    if let Some(account) = tenant.filter(|account| device == format!("brain-{account}")) {
        return frame.partition_account_id.as_deref() == Some(account) && frame.visible_to(device);
    }
    // Defence for another Host publisher that retained a session id but did
    // not stamp routing. Never apply the service sidecar visibility exception.
    if frame.partition_account_id.is_none()
        && person_event_session(&frame.payload).and_then(|session| PERSON_SESSIONS.owner(session)).is_some() {
        return false;
    }
    if frame.partition_account_id.is_some() {
        return frame.visible_to(device) && crate::person_partition::event_visible(frame, device, tenant);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn p6c_live_and_replay_audiences_are_owner_brain_and_current_owner_devices_only() {
        person_test_audiences(&["claude://message", "agent://event", "a2ui://dispatch", "gateway://request-outcome"]).await;
    }
    #[tokio::test]
    async fn p6d_external_agent_live_and_replay_audiences_include_only_owner_brain_and_devices() {
        person_test_audiences(&["external-agent://spawn", "external-agent://stdout", "external-agent://stdout-raw", "external-agent://stderr",
            "external-agent://state-change", "external-agent://exit", "external-agent://placement", "external-agent://session-event", "external-agent://workspace-publish"]).await;
    }
    async fn person_test_audiences(channels: &[&str]) {
        use crate::security_store::{SecurityStore, VerifiedDevicePerson};
        use cognia_tenant_auth::{OrgId, UserId};
        let _guard = crate::security_store::test_guard();
        let previous = crate::security_store::security_store();
        struct Restore(Option<std::sync::Arc<SecurityStore>>);
        impl Drop for Restore { fn drop(&mut self) { crate::security_store::install_security_store(self.0.take()); } }
        let _restore = Restore(previous);
        let store = SecurityStore::in_memory().unwrap();
        let owner = VerifiedDevicePerson { org_id:OrgId::parse("org_p6c_audience").unwrap(), user_id:UserId::parse("usr_p6c_owner").unwrap() };
        let other = VerifiedDevicePerson { org_id:owner.org_id.clone(), user_id:UserId::parse("usr_p6c_other").unwrap() };
        for (device, person) in [("p6c-owner-phone", &owner), ("p6c-owner-web", &owner), ("p6c-other-phone", &other)] {
            let challenge = store.issue_challenge("p6c-tenant", 100, 60).unwrap();
            store.register_oidc_device("p6c-tenant", device, person, &challenge.id, &challenge.nonce,
                device, "Web", "pem", device, "member", 101).unwrap();
        }
        crate::security_store::install_security_store(Some(store.clone()));
        let person = PersonPartition::new(owner.org_id.to_string(), owner.user_id.to_string());
        let brain = format!("brain-{}", person.account_id);
        PERSON_SESSIONS.bind("p6c-audience-session", Some(&person)).unwrap();
        let bus = crate::event_bus::EventBus::new();
        let crate::event_bus::SubscribeResult::Ok { mut receiver, .. } = bus.subscribe(None, 0) else { panic!("live"); };
        for channel in channels {
            person_publish(&bus, channel, &serde_json::json!({"sessionId":"p6c-audience-session","type":"text"}));
        }
        let crate::event_bus::SubscribeResult::Ok { replay, .. } = bus.subscribe(Some(0), 0) else { panic!("replay"); };
        assert_eq!(replay.len(), channels.len() * 3);
        for frame in &replay {
            assert_eq!(receiver.try_recv().unwrap().seq, frame.seq);
            let audience: Vec<_> = [(brain.as_str(), Some(person.account_id.as_str())),
                ("p6c-owner-phone", Some("p6c-tenant")), ("p6c-owner-web", None),
                ("p6c-other-phone", Some("p6c-tenant")), ("__service__", Some("operator")),
                ("brain-other", Some("other"))].into_iter()
                .filter(|(device, tenant)| person_connection_visible(frame, device, *tenant)).map(|(device, _)| device).collect();
            assert_eq!(audience.len(), 1, "{} {:?}", frame.event_type, audience);
            assert_eq!(Some(audience[0]), frame.target_device_id.as_deref());
        }
        // A retained frame cannot follow a device reassigned to another person.
        store.assign_device_user("p6c-tenant", "p6c-owner-web", Some(other.user_id.as_str()), 102).unwrap();
        assert!(replay.iter().filter(|frame| frame.target_device_id.as_deref() == Some("p6c-owner-web"))
            .all(|frame| !person_connection_visible(frame, "p6c-owner-web", None)));
        let unmarked = bus.publish("claude://message".into(), serde_json::json!({"sessionId":"p6c-audience-session"}));
        assert!(!person_connection_visible(&unmarked, "__service__", Some("operator")));
        let legacy = bus.publish("claude://message".into(), serde_json::json!({"sessionId":"p6c-operator-event"}));
        assert!(person_connection_visible(&legacy, "__service__", Some("operator")));
        assert!(!person_connection_visible(&legacy, &brain, Some(&person.account_id)));
    }

    #[tokio::test]
    async fn p6e_live_reply_frames_reach_only_the_owners_devices_and_never_replay() {
        use crate::security_store::{SecurityStore, VerifiedDevicePerson};
        use cognia_tenant_auth::{OrgId, UserId};
        let _guard = crate::security_store::test_guard();
        let previous = crate::security_store::security_store();
        struct Restore(Option<std::sync::Arc<SecurityStore>>);
        impl Drop for Restore { fn drop(&mut self) { crate::security_store::install_security_store(self.0.take()); } }
        let _restore = Restore(previous);
        let store = SecurityStore::in_memory().unwrap();
        let owner = VerifiedDevicePerson { org_id:OrgId::parse("org_p6e_live").unwrap(), user_id:UserId::parse("usr_p6e_owner").unwrap() };
        let other = VerifiedDevicePerson { org_id:owner.org_id.clone(), user_id:UserId::parse("usr_p6e_other").unwrap() };
        for (device, person) in [("p6e-owner-phone", &owner), ("p6e-owner-web", &owner), ("p6e-other-phone", &other)] {
            let challenge = store.issue_challenge("p6e-tenant", 100, 60).unwrap();
            store.register_oidc_device("p6e-tenant", device, person, &challenge.id, &challenge.nonce,
                device, "Web", "pem", device, "member", 101).unwrap();
        }
        crate::security_store::install_security_store(Some(store.clone()));
        let person = PersonPartition::new(owner.org_id.to_string(), owner.user_id.to_string());
        let bus = crate::event_bus::EventBus::new();
        let crate::event_bus::SubscribeResult::Ok { mut receiver, .. } = bus.subscribe(None, 0) else { panic!("live"); };
        person_publish_live(&bus, "transcript://live", &serde_json::json!({"sessionId":"p6e-live","parts":[]}), &person);
        let frame = receiver.try_recv().expect("one frame");
        assert!(receiver.try_recv().is_err(), "one frame for the person, not one per device");
        let brain = format!("brain-{}", person.account_id);
        let audience = |frame: &crate::event_bus::EventFrame| -> Vec<String> {
            [(brain.clone(), Some(person.account_id.clone())),
                ("p6e-owner-phone".to_string(), Some("p6e-tenant".to_string())), ("p6e-owner-web".to_string(), None),
                ("p6e-other-phone".to_string(), Some("p6e-tenant".to_string())), ("__service__".to_string(), Some("operator".to_string())),
                ("brain-other".to_string(), Some("other".to_string()))]
                .into_iter().filter(|(device, tenant)| person_connection_visible(frame, device, tenant.as_deref())
                    && crate::person_partition::event_visible(frame, device, tenant.as_deref()))
                .map(|(device, _)| device).collect()
        };
        assert_eq!(audience(&frame), vec![brain.clone(), "p6e-owner-phone".to_string(), "p6e-owner-web".to_string()]);
        // Delivery re-reads standing: a device moved to someone else stops receiving.
        store.assign_device_user("p6e-tenant", "p6e-owner-web", Some(other.user_id.as_str()), 102).unwrap();
        assert_eq!(audience(&frame), vec![brain, "p6e-owner-phone".to_string()]);
        let crate::event_bus::SubscribeResult::Ok { replay, .. } = bus.subscribe(Some(0), 0) else { panic!("replay"); };
        assert!(replay.is_empty());
    }

    #[test]
    fn p6c_partition_data_ids_need_no_turn_but_existing_turns_keep_their_owner() {
        let a = PersonPartition::new("org".into(), "p6c-data-a".into());
        let b = PersonPartition::new("org".into(), "p6c-data-b".into());
        assert!(person_check_session_args(&serde_json::json!({"sessionId":"p6c-new-data-id"}), Some(&a)).is_ok());
        PERSON_SESSIONS.bind("p6c-data-owned", Some(&a)).unwrap();
        assert!(person_check_session_args(&serde_json::json!({"sessionId":"p6c-data-owned"}), Some(&a)).is_ok());
        assert!(person_check_session_args(&serde_json::json!({"sessionId":"p6c-data-owned"}), Some(&b)).is_err());
        assert!(person_check_session_args(&serde_json::json!({"params":{"sessionId":"p6c-data-owned"}}), None).is_err());
        assert!(person_check_session_args(&serde_json::json!({"prompt":[{"sessionId":"p6c-data-owned"}]}), None).is_ok());
    }

    #[test]
    fn p6c_session_owner_fences_other_member_operator_and_service() {
        let sessions = PersonSessions::default();
        let a = PersonPartition::new("org".into(), "a".into());
        let b = PersonPartition::new("org".into(), "b".into());
        sessions.bind("a", Some(&a)).unwrap();
        assert!(sessions.bind("a", Some(&b)).is_err());
        assert!(sessions.bind("a", None).is_err());
        assert!(sessions.check("a", None).is_err());
        assert!(sessions.check("a", Some(&a)).is_ok());
        sessions.bind("operator", None).unwrap();
        assert!(sessions.bind("operator", Some(&a)).is_err());
    }
    #[test]
    fn p6c_policy_is_the_dispatch_allowlist() {
        for command in ["person_model_ticket_mint", "agent_send", "agent_interrupt", "agent_close_session"] { assert!(person_command_allowed(command)); }
        for command in ["org_model_credential_set", "secret_store_get", "sync_pull", "session_list", "agent_start", "claude_send", "claude_close_session"] { assert!(!person_command_allowed(command)); }
    }
    #[test]
    fn p6c_partition_event_publication_and_replay_exclude_operator_and_other_brains() {
        let person = PersonPartition::new("org".into(), "event-owner".into());
        PERSON_SESSIONS.bind("p6c-event-session", Some(&person)).unwrap();
        let bus = crate::event_bus::EventBus::new();
        person_publish(&bus, "claude://message", &serde_json::json!({"sessionId":"p6c-event-session","type":"text"}));
        let crate::event_bus::SubscribeResult::Ok { replay, .. } = bus.subscribe(Some(0), 0) else { panic!("replay"); };
        assert_eq!(replay.len(), 1);
        let frame = &replay[0];
        assert!(person_connection_visible(frame, &format!("brain-{}", person.account_id), Some(&person.account_id)));
        assert!(!person_connection_visible(frame, "__service__", Some("operator")));
        assert!(!person_connection_visible(frame, "brain-other", Some("other")));
    }
}
