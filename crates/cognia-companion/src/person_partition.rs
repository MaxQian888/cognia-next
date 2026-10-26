//! P5 person authority and the server-installed fleet boundary.
//! Never deserialized from RPC arguments. Desktop Hosts install no fleet and
//! retain host_data_unpartitioned. Model-backed pet arms are intentionally
//! dormant until P6 supplies partition-scoped credentials.
use std::{future::Future, sync::Arc};
use parking_lot::RwLock;
use serde::Serialize;
pub use async_trait::async_trait;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PersonPartition {
    pub org_id: String,
    pub user_id: String,
    pub account_id: String,
}

impl PersonPartition {
    pub fn new(org_id: String, user_id: String) -> Self {
        let mut hash = Sha256::new();
        hash.update(org_id.as_bytes());
        hash.update([0]);
        hash.update(user_id.as_bytes());
        let account_id = format!("pb_{}", &hex::encode(hash.finalize())[..24]);
        Self { org_id, user_id, account_id }
    }
}

tokio::task_local! { static PARTITION: Option<PersonPartition>; }
pub fn current() -> Option<PersonPartition> {
    PARTITION.try_with(Clone::clone).ok().flatten()
}
pub async fn scope<T>(partition: Option<PersonPartition>, future: impl Future<Output = T>) -> T {
    PARTITION.scope(partition, future).await
}

pub use crate::security_store::PersonReceiptScope;
tokio::task_local! { static RECEIPT_SCOPE: Option<PersonReceiptScope>; }
pub fn receipt_scope() -> Option<PersonReceiptScope> { RECEIPT_SCOPE.try_with(Clone::clone).ok().flatten() }
pub async fn scope_receipts<T>(scope: Option<PersonReceiptScope>, future: impl Future<Output = T>) -> T {
    RECEIPT_SCOPE.scope(scope, future).await
}

/// One supervisor's live child authority. The read fence spans socket install;
/// invalidation takes the write fence and disconnects the slot before return.
/// Neither this state nor its random child generation is persisted.
pub struct PersonBrainAuthority {
    account_id: String,
    generation: RwLock<Option<String>>,
    stopped: std::sync::atomic::AtomicBool,
}
impl PersonBrainAuthority {
    pub fn new(account_id: String) -> Arc<Self> { Arc::new(Self { account_id, generation: RwLock::new(None), stopped: std::sync::atomic::AtomicBool::new(false) }) }
    pub fn begin_child(self: &Arc<Self>) -> Option<PersonChildGeneration> {
        let mut current = self.generation.write();
        if self.stopped.load(std::sync::atomic::Ordering::SeqCst) { return None; }
        crate::ws_bridge::disconnect_account(&self.account_id);
        let generation = uuid::Uuid::new_v4().to_string();
        *current = Some(generation.clone());
        Some(PersonChildGeneration { authority: self.clone(), generation })
    }
    pub fn current(&self) -> Option<String> { self.generation.read().clone() }
    pub fn accepts(&self, generation: &str) -> bool { self.generation.read().as_deref() == Some(generation) }
    pub fn admit(&self, generation: &str, install: impl FnOnce()) -> bool {
        let current = self.generation.read();
        if current.as_deref() != Some(generation) { return false; }
        install();
        true
    }
    pub fn invalidate(&self) {
        let mut current = self.generation.write();
        *current = None;
        crate::ws_bridge::disconnect_account(&self.account_id);
    }
    pub fn stop(&self) {
        self.stopped.store(true, std::sync::atomic::Ordering::SeqCst);
        self.invalidate();
    }
}
pub struct PersonChildGeneration { authority: Arc<PersonBrainAuthority>, generation: String }
impl Drop for PersonChildGeneration {
    fn drop(&mut self) {
        let mut current = self.authority.generation.write();
        if current.as_deref() == Some(&self.generation) {
            *current = None;
            crate::ws_bridge::disconnect_account(&self.authority.account_id);
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonBrainStatus {
    pub account_id: String,
    pub last_used_ms: i64,
    pub running: bool,
    pub parked: bool,
    pub restart_count: u64,
    pub ready: bool,
    pub in_flight: usize,
    pub rss_bytes: u64,
}

/// Held across the entire admitted dispatch, including cancellation. Dropping
/// the guard releases the request; no child can be evicted while it is held.
pub trait PersonRequest: Send + Sync { fn receipt_scope(&self) -> PersonReceiptScope; }
#[async_trait::async_trait]
pub trait PersonBrainFleet: Send + Sync {
    async fn acquire(&self, person: &PersonPartition) -> Result<Box<dyn PersonRequest>, &'static str>;
    fn accepts_bridge(&self, account_id: &str, generation: &str) -> bool;
    fn bridge_authority(&self, account_id: &str) -> Option<Arc<PersonBrainAuthority>>;
    fn receipt_scope(&self, account_id: &str) -> Option<PersonReceiptScope>;
    fn person(&self, account_id: &str) -> Option<PersonPartition>;
    fn statuses(&self) -> Vec<PersonBrainStatus>;
    /// Known org people, including parked brains; no server dependency.
    fn org_people(&self, org: &str) -> Vec<String> {
        self.statuses().iter().filter_map(|status| self.person(&status.account_id))
            .filter(|person| person.org_id == org).map(|person| person.user_id).collect()
    }
    async fn list(&self) -> Result<serde_json::Value, String>;
    async fn purge(&self, person: &PersonPartition) -> Result<(), &'static str>;
}
static FLEET: RwLock<Option<Arc<dyn PersonBrainFleet>>> = RwLock::new(None);
pub fn install(fleet: Option<Arc<dyn PersonBrainFleet>>) { *FLEET.write() = fleet; }
pub fn fleet() -> Option<Arc<dyn PersonBrainFleet>> { FLEET.read().clone() }

/// Match live person binding for both live and replayed events. A device
/// reassignment or a duplicated device id must not inherit the old audience.
pub fn event_visible(frame: &crate::event_bus::EventFrame, device: &str, tenant: Option<&str>) -> bool {
    if frame.partition_account_id.is_none() { return true; }
    let Some(store) = crate::security_store::security_store() else { return false; };
    event_visible_in_store(frame, device, tenant, &store)
}
fn event_visible_in_store(frame: &crate::event_bus::EventFrame, device: &str, tenant: Option<&str>, store: &crate::security_store::SecurityStore) -> bool {
    let Some(account) = frame.partition_account_id.as_deref() else { return true; };
    if !frame.visible_to(device) { return false; }
    if device == format!("brain-{account}") && tenant == Some(account) { return true; }
    let person = match tenant {
        Some(tenant) => store.active_oidc_device_person(tenant, device),
        None => store.person_for_account_device(device),
    };
    person.ok().flatten().is_some_and(|person| PersonPartition::new(person.org_id.to_string(), person.user_id.to_string()).account_id == account)
}

/// The devices a person-partition event may wake by push. One frame stands
/// for every device bound to the person when it is delivered
/// (`person_chat::person_publish_to`), so the partition's push registry is
/// screened against that binding, as the event stream screens its sockets. A
/// frame a producer addressed to one device stays with that device.
pub fn push_devices(frame: &crate::event_bus::EventFrame, registry: &crate::push::PushTokenRegistry) -> Vec<String> {
    let Some(store) = crate::security_store::security_store() else { return Vec::new(); };
    push_devices_in_store(frame, registry, &store)
}
fn push_devices_in_store(frame: &crate::event_bus::EventFrame, registry: &crate::push::PushTokenRegistry,
    store: &crate::security_store::SecurityStore) -> Vec<String> {
    if frame.partition_account_id.is_none() { return Vec::new(); }
    let candidates = match frame.target_device_id.as_deref() {
        Some(device) => vec![device.to_string()],
        None => registry.device_ids(),
    };
    let mut devices: Vec<String> = candidates.into_iter()
        .filter(|device| event_visible_in_store(frame, device, None, store)).collect();
    devices.sort();
    devices
}

pub async fn list_handler() -> Result<axum::Json<serde_json::Value>, cognia_problem::Problem> {
    let fleet = fleet().ok_or_else(|| unavailable("host_data_unpartitioned"))?;
    fleet.list().await.map(axum::Json).map_err(|_| unavailable("person_brain_unavailable"))
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PurgePerson { org: String, user: String }
pub async fn purge_handler(axum::Json(body): axum::Json<PurgePerson>) -> Result<axum::Json<serde_json::Value>, cognia_problem::Problem> {
    let fleet = fleet().ok_or_else(|| unavailable("host_data_unpartitioned"))?;
    let person = PersonPartition::new(body.org, body.user);
    fleet.purge(&person).await.map_err(unavailable)?;
    Ok(axum::Json(serde_json::json!({ "accountId": person.account_id, "purged": true })))
}
pub fn unavailable(code: &'static str) -> cognia_problem::Problem {
    cognia_problem::Problem::with_status(axum::http::StatusCode::SERVICE_UNAVAILABLE, code, code)
        .retryable(true)
}

/// P6c shared fake fleet: tests exercise the actual middleware/dispatcher
/// without spawning a brain or opening a listener.
#[cfg(any(test, feature = "test-support"))]
pub mod person_test_support {
    use super::*;
    pub struct PersonFleet {
        pub people: Vec<PersonPartition>,
        pub generation: String,
        pub active: std::sync::atomic::AtomicBool,
    }
    struct Request(PersonReceiptScope);
    impl PersonRequest for Request { fn receipt_scope(&self) -> PersonReceiptScope { self.0.clone() } }
    #[async_trait::async_trait]
    impl PersonBrainFleet for PersonFleet {
        async fn acquire(&self, person: &PersonPartition) -> Result<Box<dyn PersonRequest>, &'static str> {
            if self.person(&person.account_id).is_none() { return Err("person_brain_unavailable"); }
            Ok(Box::new(Request(PersonReceiptScope { account_id:person.account_id.clone(), data_generation:"p6c-data".into() })))
        }
        fn accepts_bridge(&self, account: &str, generation: &str) -> bool {
            self.active.load(std::sync::atomic::Ordering::SeqCst) && generation == self.generation && self.person(account).is_some()
        }
        fn bridge_authority(&self, _: &str) -> Option<Arc<PersonBrainAuthority>> { None }
        fn receipt_scope(&self, account: &str) -> Option<PersonReceiptScope> {
            self.person(account).map(|person| PersonReceiptScope { account_id:person.account_id, data_generation:"p6c-data".into() })
        }
        fn person(&self, account: &str) -> Option<PersonPartition> { self.people.iter().find(|p| p.account_id == account).cloned() }
        fn statuses(&self) -> Vec<PersonBrainStatus> { vec![] }
        async fn list(&self) -> Result<serde_json::Value, String> { Ok(serde_json::json!({"persons":[]})) }
        async fn purge(&self, _: &PersonPartition) -> Result<(), &'static str> { Ok(()) }
    }
    pub struct Installed(Option<Arc<dyn PersonBrainFleet>>);
    impl Installed {
        pub fn new(people: Vec<PersonPartition>) -> (Self, Arc<PersonFleet>) {
            let previous = fleet();
            let fleet = Arc::new(PersonFleet { people, generation:"p6c-generation".into(), active:std::sync::atomic::AtomicBool::new(true) });
            install(Some(fleet.clone()));
            (Self(previous), fleet)
        }
    }
    impl Drop for Installed { fn drop(&mut self) { install(self.0.take()); } }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn p5_event_replay_requires_current_person_binding_and_hides_routing_metadata() {
        use crate::security_store::{SecurityStore, VerifiedDevicePerson};
        use cognia_tenant_auth::{OrgId, UserId};
        let store = SecurityStore::in_memory().unwrap();
        let person = VerifiedDevicePerson { org_id: OrgId::parse("org_p5a").unwrap(), user_id: UserId::parse("usr_p5a").unwrap() };
        let challenge = store.issue_challenge("tenant-p5", 100, 60).unwrap();
        store.register_oidc_device("tenant-p5", "subject", &person, &challenge.id, &challenge.nonce,
            "p5-device", "Web", "pem", "thumb", "member", 101).unwrap();
        let partition = PersonPartition::new(person.org_id.to_string(), person.user_id.to_string());
        let bus = crate::event_bus::EventBus::new();
        let frame = bus.publish_person_to("sync://invalidate".into(), serde_json::json!({"table":"messages"}), "p5-device".into(), partition.account_id);
        assert!(event_visible_in_store(&frame, "p5-device", Some("tenant-p5"), &store));
        assert!(event_visible_in_store(&frame, "p5-device", None, &store));
        assert!(!event_visible_in_store(&frame, "someone-else", Some("tenant-p5"), &store));
        assert!(!event_visible_in_store(&frame, "p5-device", Some("tenant-other"), &store));
        let wire = serde_json::to_value(&frame).unwrap();
        assert!(wire.get("partition_account_id").is_none());
        store.assign_device_user("tenant-p5", "p5-device", Some("usr_p5b"), 102).unwrap();
        assert!(!event_visible_in_store(&frame, "p5-device", Some("tenant-p5"), &store));
        let legacy = bus.publish("sync://invalidate".into(), serde_json::json!({"table":"messages"}));
        assert!(event_visible(&legacy, "any-device", None));
        assert!(unavailable("person_brain_capacity").retryable);
    }

    #[test]
    fn push_wakes_only_the_persons_currently_bound_devices() {
        use crate::push::{PushProvider, PushTokenRecord, PushTokenRegistry};
        use crate::security_store::{SecurityStore, VerifiedDevicePerson};
        use cognia_tenant_auth::{OrgId, UserId};
        let store = SecurityStore::in_memory().unwrap();
        let ada = VerifiedDevicePerson { org_id: OrgId::parse("org_push").unwrap(), user_id: UserId::parse("usr_push_ada").unwrap() };
        let bob = VerifiedDevicePerson { org_id: ada.org_id.clone(), user_id: UserId::parse("usr_push_bob").unwrap() };
        for (device, person) in [("ada-phone", &ada), ("ada-tablet", &ada), ("bob-phone", &bob)] {
            let challenge = store.issue_challenge("tenant-push", 100, 60).unwrap();
            store.register_oidc_device("tenant-push", device, person, &challenge.id, &challenge.nonce,
                device, "Web", "pem", device, "member", 101).unwrap();
        }
        let partition = PersonPartition::new(ada.org_id.to_string(), ada.user_id.to_string());
        let registry = PushTokenRegistry::new().for_account(&partition.account_id);
        // A token the registry kept for a device now someone else's, and one never paired.
        for device in ["ada-phone", "ada-tablet", "bob-phone", "unpaired"] {
            registry.register(PushTokenRecord { device_id: device.into(), provider: PushProvider::Fcm,
                token: format!("token-{device}"), app_version: None, device_locale: None, registered_at: 1 });
        }
        let bus = crate::event_bus::EventBus::new();
        let event = bus.publish_person("claude://message-added".into(), serde_json::json!({"sessionId":"s"}), partition.account_id.clone());
        assert_eq!(push_devices_in_store(&event, &registry, &store), vec!["ada-phone", "ada-tablet"]);
        let addressed = bus.publish_person_to("claude://message-added".into(), serde_json::json!({}), "ada-tablet".into(), partition.account_id.clone());
        assert_eq!(push_devices_in_store(&addressed, &registry, &store), vec!["ada-tablet"]);
        let misaddressed = bus.publish_person_to("claude://message-added".into(), serde_json::json!({}), "bob-phone".into(), partition.account_id.clone());
        assert!(push_devices_in_store(&misaddressed, &registry, &store).is_empty());
        // A device moved to someone else stops being woken by this partition.
        store.assign_device_user("tenant-push", "ada-tablet", Some(bob.user_id.as_str()), 102).unwrap();
        assert_eq!(push_devices_in_store(&event, &registry, &store), vec!["ada-phone"]);
        let host = bus.publish("claude://message-added".into(), serde_json::json!({}));
        assert!(push_devices_in_store(&host, &registry, &store).is_empty());
    }

    #[tokio::test]
    async fn p5_partition_identity_and_task_local_are_not_caller_args() {
        let a = PersonPartition::new("org".into(), "user".into());
        assert_eq!(a.account_id, "pb_693259bd42dbe0fbdd073e21");
        assert_ne!(a.account_id, PersonPartition::new("orgu".into(), "ser".into()).account_id);
        assert!(current().is_none());
        scope(Some(a.clone()), async {
            assert_eq!(current(), Some(a));
            assert!(tokio::spawn(async { current() }).await.unwrap().is_none());
        }).await;
        assert!(current().is_none());
    }
}
