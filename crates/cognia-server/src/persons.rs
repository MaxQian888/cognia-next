//! P5 server-only process fleet. Reuses BrainSupervisor, including its crash
//! backoff and shutdown. The companion owns admission and the task-local;
//! this module owns keys, capacity, process lifetime and operator purge.
use std::{collections::BTreeMap, sync::{Arc, atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering}}, time::Duration};
use cognia_companion::{person_partition::{PersonPartition, PersonBrainAuthority, PersonBrainFleet, PersonBrainStatus, PersonReceiptScope, PersonRequest}, ws_bridge, SharedState};
use tokio::{sync::Mutex, task::JoinHandle};
use crate::brain::{BrainConfig, BrainSupervisor};

const METADATA_SERVICE: &str = "com.cognia.person-brains";
const CONTENT_KEY_SERVICE: &str = "com.cognia.account-content";

#[derive(serde::Serialize, serde::Deserialize)]
struct Metadata { org: String, user: String, #[serde(default)] data_generation: Option<String> }
struct Usage { in_flight: AtomicUsize, last_used_ms: AtomicI64 }
struct RequestGuard(Arc<Usage>, PersonReceiptScope);
impl PersonRequest for RequestGuard { fn receipt_scope(&self) -> PersonReceiptScope { self.1.clone() } }
impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.0.last_used_ms.store(now_ms(), Ordering::SeqCst);
        self.0.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}
struct Entry {
    person: PersonPartition,
    usage: Arc<Usage>,
    supervisor: Option<Arc<BrainSupervisor>>,
    task: Option<JoinHandle<()>>,
    persisted_last_used_ms: i64,
}
impl Entry {
    async fn stop(&mut self) {
        if let Some(supervisor) = &self.supervisor { supervisor.shutdown(); }
        // Keep the handle in the entry while awaiting it. Cancellation leaves
        // a stopping entry that the next lifecycle operation can finish joining.
        if let Some(task) = self.task.as_mut() { let _ = task.await; }
        self.task = None;
        self.supervisor = None;
        ws_bridge::disconnect_account(&self.person.account_id);
    }
}

pub struct Fleet {
    template: BrainConfig,
    state: SharedState,
    ledger: Arc<cognia_companion::security_store::SecurityStore>,
    entries: Mutex<BTreeMap<String, Entry>>,
    // Snapshots never block an HTTP /healthz reader on lifecycle I/O.
    snapshots: parking_lot::RwLock<Vec<PersonBrainStatus>>,
    people: parking_lot::RwLock<BTreeMap<String, PersonPartition>>,
    active_accounts: parking_lot::RwLock<BTreeMap<String, Arc<PersonBrainAuthority>>>,
    data_scopes: parking_lot::RwLock<BTreeMap<String, PersonReceiptScope>>,
    idle: Duration,
    maximum: usize,
    stopping: AtomicBool,
}
fn now_ms() -> i64 { chrono::Utc::now().timestamp_millis() }
fn positive_env(name: &str, default: u64) -> Result<u64, String> {
    match std::env::var(name) {
        Ok(value) => value.parse::<u64>().ok().filter(|n| *n > 0).ok_or_else(|| format!("{name} must be a positive integer")),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(_) => Err(format!("{name} is not valid Unicode")),
    }
}
fn valid_account(id: &str) -> bool {
    id.len() == 27 && id.starts_with("pb_") && id[3..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl Fleet {
    pub fn new(template: BrainConfig, state: SharedState) -> Result<Arc<Self>, String> {
        Self::with_limits(template, state, Duration::from_secs(positive_env("COGNIA_PERSON_BRAIN_IDLE_SECS", 900)?),
            usize::try_from(positive_env("COGNIA_PERSON_BRAINS_MAX", 8)?).map_err(|_| "person brain cap is too large")?,
            cognia_companion::security_store::security_store().ok_or("person receipt ledger unavailable")?)
    }
    fn with_limits(template: BrainConfig, state: SharedState, idle: Duration, maximum: usize,
        ledger: Arc<cognia_companion::security_store::SecurityStore>) -> Result<Arc<Self>, String> {
        if valid_account(&template.account_id) { return Err("operator account uses the reserved person namespace".into()); }
        let mut entries = BTreeMap::new();
        let mut data_scopes = BTreeMap::new();
        let root = template.data_dir.join("persons");
        if root.exists() {
            for directory in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
                let directory = directory.map_err(|e| e.to_string())?;
                let account = directory.file_name().to_string_lossy().into_owned();
                if !valid_account(&account) { continue; }
                if let Some(value) = cognia_secrets::secret_store::get(METADATA_SERVICE, &account)? {
                    let metadata: Metadata = serde_json::from_str(&value).map_err(|e| e.to_string())?;
                    let person = PersonPartition::new(metadata.org, metadata.user);
                    if person.account_id != account { return Err("person partition identity mismatch".into()); }
                    if let Some(generation) = metadata.data_generation {
                        uuid::Uuid::parse_str(&generation).map_err(|_| "invalid person data generation")?;
                        data_scopes.insert(account.clone(), PersonReceiptScope { account_id: account.clone(), data_generation: generation });
                    }
                    let last = std::fs::read_to_string(directory.path().join("last-used"))
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(0);
                    entries.insert(account, Self::entry(person, last));
                }
            }
        }
        let people = entries.iter().map(|(account, entry)| (account.clone(), entry.person.clone())).collect();
        let fleet = Arc::new(Self { template, state, ledger, entries: Mutex::new(entries), snapshots: Default::default(),
            people: parking_lot::RwLock::new(people), active_accounts: Default::default(), data_scopes: parking_lot::RwLock::new(data_scopes), idle, maximum, stopping: AtomicBool::new(false) });
        Ok(fleet)
    }
    fn entry(person: PersonPartition, last: i64) -> Entry {
        Entry { person, usage: Arc::new(Usage { in_flight: AtomicUsize::new(0), last_used_ms: AtomicI64::new(last) }), supervisor: None, task: None, persisted_last_used_ms: last }
    }
    pub fn start_idle_reaper(self: &Arc<Self>) -> JoinHandle<()> {
        let fleet = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let Some(fleet) = fleet.upgrade() else { break; };
                if fleet.stopping.load(Ordering::SeqCst) { break; }
                fleet.reap().await;
            }
        })
    }
    fn refresh(&self, entries: &BTreeMap<String, Entry>) {
        *self.snapshots.write() = entries.values().map(|entry| PersonBrainStatus {
            account_id: entry.person.account_id.clone(), last_used_ms: entry.usage.last_used_ms.load(Ordering::SeqCst),
            running: entry.supervisor.as_ref().is_some_and(|sup| sup.status().running),
            parked: entry.supervisor.as_ref().is_some_and(|sup| sup.status().parked),
            restart_count: entry.supervisor.as_ref().map_or(0, |sup| sup.status().restart_count),
            ready: ws_bridge::account_connected(&entry.person.account_id), in_flight: entry.usage.in_flight.load(Ordering::SeqCst),
            rss_bytes: ws_bridge::account_rss_bytes(&entry.person.account_id),
        }).collect();
    }
    async fn stop_entry(&self, entry: &mut Entry) {
        if let Some(authority) = self.active_accounts.write().remove(&entry.person.account_id) { authority.stop(); }
        entry.stop().await;
    }

    fn persist_usage(&self, entry: &mut Entry) {
        let last = entry.usage.last_used_ms.load(Ordering::SeqCst);
        if last == entry.persisted_last_used_ms { return; }
        let path = self.template.data_dir.join("persons").join(&entry.person.account_id).join("last-used");
        match std::fs::write(path, last.to_string()) {
            Ok(()) => entry.persisted_last_used_ms = last,
            Err(error) => log::warn!("person last-use persistence failed: {error}"),
        }
    }

    async fn reap(&self) {
        let mut entries = self.entries.lock().await;
        for entry in entries.values_mut() {
            let last = entry.usage.last_used_ms.load(Ordering::SeqCst);
            self.persist_usage(entry);
            if entry.task.is_some() && entry.usage.in_flight.load(Ordering::SeqCst) == 0
                && now_ms().saturating_sub(last) as u128 >= self.idle.as_millis() { self.stop_entry(entry).await; }
        }
        self.refresh(&entries);
    }
    pub async fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        for authority in self.active_accounts.read().values() { authority.stop(); }
        let mut entries = self.entries.lock().await;
        // Server drain precedes this call. Remaining requests are allowed to
        // finish before their children are stopped.
        loop {
            if entries.values().all(|entry| entry.usage.in_flight.load(Ordering::SeqCst) == 0) { break; }
            drop(entries);
            tokio::time::sleep(Duration::from_millis(25)).await;
            entries = self.entries.lock().await;
        }
        for entry in entries.values_mut() { self.persist_usage(entry); self.stop_entry(entry).await; }
        self.refresh(&entries);
    }
}

#[cognia_companion::person_partition::async_trait]
impl PersonBrainFleet for Fleet {
    async fn acquire(&self, person: &PersonPartition) -> Result<Box<dyn PersonRequest>, &'static str> {
        if self.stopping.load(Ordering::SeqCst) { return Err("person_brain_unavailable"); }
        let guard = {
            let mut entries = self.entries.lock().await;
            if self.stopping.load(Ordering::SeqCst) { return Err("person_brain_unavailable"); }
            let running = entries.get(&person.account_id).is_some_and(|entry| entry.task.is_some()
                && entry.supervisor.as_ref().is_some_and(|sup| !sup.is_stopping()));
            if !running {
                if let Some(entry) = entries.get_mut(&person.account_id) {
                    if entry.task.is_some() { self.stop_entry(entry).await; }
                }
                if entries.values().filter(|entry| entry.task.is_some()).count() >= self.maximum {
                    let oldest = entries.iter().filter(|(_, entry)| entry.task.is_some() && entry.usage.in_flight.load(Ordering::SeqCst) == 0)
                        .min_by_key(|(_, entry)| entry.usage.last_used_ms.load(Ordering::SeqCst)).map(|(key, _)| key.clone());
                    let Some(oldest) = oldest else { return Err("person_brain_capacity"); };
                    self.stop_entry(entries.get_mut(&oldest).expect("selected entry")).await;
                }
                let root = self.template.data_dir.join("persons").join(&person.account_id);
                std::fs::create_dir_all(&root).map_err(|_| "person_brain_unavailable")?;
                let key_existed = cognia_secrets::secret_store::get(CONTENT_KEY_SERVICE, &person.account_id).map_err(|_| "person_brain_unavailable")?.is_some();
                let key = cognia_companion_rpc::headless::get_or_create_account_content_key(&person.account_id).map_err(|_| "person_brain_unavailable")?;
                let receipt_scope = if key_existed { self.data_scopes.read().get(&person.account_id).cloned() } else { None }
                    .unwrap_or_else(|| PersonReceiptScope { account_id: person.account_id.clone(), data_generation: uuid::Uuid::new_v4().to_string() });
                let metadata = serde_json::to_string(&Metadata { org: person.org_id.clone(), user: person.user_id.clone(), data_generation: Some(receipt_scope.data_generation.clone()) }).map_err(|_| "person_brain_unavailable")?;
                cognia_secrets::secret_store::set(METADATA_SERVICE, &person.account_id, &metadata).map_err(|_| "person_brain_unavailable")?;
                self.data_scopes.write().insert(person.account_id.clone(), receipt_scope);
                let mut config = self.template.clone();
                config.account_id = person.account_id.clone(); config.account_content_key = key; config.data_dir = root;
                let supervisor = BrainSupervisor::new_person(config, self.state.clone());
                self.people.write().insert(person.account_id.clone(), person.clone());
                self.active_accounts.write().insert(person.account_id.clone(), supervisor.person_authority().expect("person supervisor authority"));
                let task = supervisor.start();
                let entry = entries.entry(person.account_id.clone()).or_insert_with(|| Self::entry(person.clone(), now_ms()));
                entry.supervisor = Some(supervisor); entry.task = Some(task);
                entry.persisted_last_used_ms = 0;
            }
            let entry = entries.get(&person.account_id).expect("started entry");
            entry.usage.in_flight.fetch_add(1, Ordering::SeqCst);
            entry.usage.last_used_ms.store(now_ms(), Ordering::SeqCst);
            let guard = RequestGuard(entry.usage.clone(), self.data_scopes.read().get(&person.account_id).expect("persisted person data generation").clone());
            self.refresh(&entries);
            guard
        };
        let deadline = tokio::time::Instant::now() + self.template.ready_timeout;
        loop {
            if ws_bridge::account_connected(&person.account_id) { return Ok(Box::new(guard)); }
            if tokio::time::Instant::now() >= deadline || self.stopping.load(Ordering::SeqCst) { return Err("person_brain_unavailable"); }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    fn accepts_bridge(&self, account_id: &str, generation: &str) -> bool {
        self.bridge_authority(account_id).is_some_and(|active| active.accepts(generation))
    }
    fn bridge_authority(&self, account_id: &str) -> Option<Arc<PersonBrainAuthority>> {
        if self.stopping.load(Ordering::SeqCst) { None } else { self.active_accounts.read().get(account_id).cloned() }
    }
    fn receipt_scope(&self, account_id: &str) -> Option<PersonReceiptScope> { self.data_scopes.read().get(account_id).cloned() }
    fn person(&self, account_id: &str) -> Option<PersonPartition> {
        self.people.read().get(account_id).cloned()
    }
    fn statuses(&self) -> Vec<PersonBrainStatus> { self.snapshots.read().clone() }
    async fn list(&self) -> Result<serde_json::Value, String> {
        let entries = self.entries.lock().await;
        self.refresh(&entries);
        let people: Vec<_> = entries.values().map(|entry| entry.person.clone()).collect();
        drop(entries);
        let mut list = Vec::new();
        for person in people {
            let standing = match cognia_companion::workspace_access::standing_actions(&person.org_id, None, &person.user_id).await {
                Ok(_) => "member", Err(cognia_companion::workspace_access::WorkspaceAccessError::Upstream { status: 404 }) => "not-member",
                Err(_) => "unresolved",
            };
            if let Some(status) = self.statuses().into_iter().find(|status| status.account_id == person.account_id) {
                let mut value = serde_json::to_value(status).map_err(|e| e.to_string())?;
                value["standing"] = standing.into(); list.push(value);
            }
        }
        Ok(serde_json::json!({ "persons": list }))
    }
    async fn purge(&self, person: &PersonPartition) -> Result<(), &'static str> {
        let mut entries = self.entries.lock().await;
        if let Some(entry) = entries.get_mut(&person.account_id) {
            if entry.usage.in_flight.load(Ordering::SeqCst) != 0 { return Err("person_brain_busy"); }
            self.stop_entry(entry).await;
        }
        self.ledger.purge_person_receipts(&person.account_id).map_err(|_| "person_brain_unavailable")?;
        // Destroy the DEK before removing any data; a partially failed purge
        // remains inaccessible and may be retried idempotently.
        cognia_secrets::secret_store::delete(CONTENT_KEY_SERVICE, &person.account_id).map_err(|_| "person_brain_unavailable")?;
        self.state.push_tokens.forget_account(&person.account_id);
        let root = self.template.data_dir.join("persons").join(&person.account_id);
        match std::fs::remove_dir_all(&root) {
            Ok(()) => {}, Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}, Err(_) => return Err("person_brain_unavailable"),
        }
        cognia_secrets::secret_store::delete(METADATA_SERVICE, &person.account_id).map_err(|_| "person_brain_unavailable")?;
        entries.remove(&person.account_id);
        self.people.write().remove(&person.account_id);
        self.data_scopes.write().remove(&person.account_id);
        self.refresh(&entries);
        cognia_companion::audit::record_async("person_partition_purge", "local-operator", "service", "allow",
            serde_json::json!({ "accountId": person.account_id })).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_companion::ws_bridge::test_support::{lock_slot, clear_socket_for_testing, install_person_socket_for_testing};
    fn fixture(root: &std::path::Path, maximum: usize) -> Arc<Fleet> {
        let mut config = crate::brain::tests::test_config(root.join("missing-brain.mjs"), Duration::from_millis(100));
        config.data_dir = root.into();
        Fleet::with_limits(config, crate::brain::tests::test_state(), Duration::from_secs(1), maximum,
            cognia_companion::security_store::SecurityStore::in_memory().unwrap()).unwrap()
    }
    fn person(user: &str) -> PersonPartition { PersonPartition::new("p5-test-org".into(), user.into()) }

    #[tokio::test]
    async fn p5_eviction_and_server_restart_revoke_child_tokens_but_keep_data_generation() {
        let _slot = lock_slot().await; clear_socket_for_testing();
        let temp = tempfile::tempdir().unwrap(); let fleet = fixture(temp.path(), 1);
        let a = person("generation-a"); let b = person("generation-b");
        let _socket = install_person_socket_for_testing(&fleet.state, &a.account_id);
        let request = fleet.acquire(&a).await.unwrap();
        let scope = request.receipt_scope();
        let authority = fleet.bridge_authority(&a.account_id).unwrap();
        let _child = authority.begin_child().unwrap();
        let old = authority.current().unwrap();
        assert!(fleet.accepts_bridge(&a.account_id, &old));
        drop(request);
        let _b = install_person_socket_for_testing(&fleet.state, &b.account_id);
        drop(fleet.acquire(&b).await.unwrap()); // capacity eviction
        assert!(!fleet.accepts_bridge(&a.account_id, &old));
        assert!(!authority.accepts(&old));
        let _socket = install_person_socket_for_testing(&fleet.state, &a.account_id);
        let request = fleet.acquire(&a).await.unwrap();
        assert_eq!(request.receipt_scope(), scope);
        let next_authority = fleet.bridge_authority(&a.account_id).unwrap();
        let _child = next_authority.begin_child().unwrap();
        let next = next_authority.current().unwrap();
        assert_ne!(next, old);
        assert!(!fleet.accepts_bridge(&a.account_id, &old));
        drop(request); fleet.shutdown().await;
        assert!(!next_authority.accepts(&next));
        let restarted = fixture(temp.path(), 1);
        assert_eq!(restarted.receipt_scope(&a.account_id), Some(scope));
        assert!(!restarted.accepts_bridge(&a.account_id, &next));
        restarted.shutdown().await;
    }

    #[tokio::test]
    async fn p5_fleet_capacity_never_evicts_in_flight_and_uses_idle_lru() {
        let _slot = lock_slot().await; clear_socket_for_testing();
        let temp = tempfile::tempdir().unwrap(); let fleet = fixture(temp.path(), 1);
        let a = person("capacity-a"); let b = person("capacity-b");
        let _a_socket = install_person_socket_for_testing(&fleet.state, &a.account_id);
        let a_request = fleet.acquire(&a).await.unwrap();
        assert!(matches!(fleet.acquire(&b).await, Err("person_brain_capacity")));
        assert!(ws_bridge::account_connected(&a.account_id));
        // Even an artificially old last use cannot stop an in-flight brain.
        fleet.entries.lock().await.get(&a.account_id).unwrap().usage.last_used_ms.store(0, Ordering::SeqCst);
        fleet.reap().await;
        assert!(ws_bridge::account_connected(&a.account_id));
        drop(a_request);
        let _b_socket = install_person_socket_for_testing(&fleet.state, &b.account_id);
        let b_request = fleet.acquire(&b).await.unwrap();
        assert!(!ws_bridge::account_connected(&a.account_id));
        assert!(ws_bridge::account_connected(&b.account_id));
        drop(b_request);
        fleet.entries.lock().await.get(&b.account_id).unwrap().usage.last_used_ms.store(0, Ordering::SeqCst);
        fleet.reap().await;
        assert!(!ws_bridge::account_connected(&b.account_id));
        fleet.shutdown().await;
    }

    #[tokio::test]
    async fn p5_fleet_chooses_oldest_idle_partition_and_coalesces_same_person() {
        let _slot = lock_slot().await; clear_socket_for_testing();
        let temp = tempfile::tempdir().unwrap(); let fleet = fixture(temp.path(), 2);
        let a = person("lru-a"); let b = person("lru-b"); let c = person("lru-c");
        let _a = install_person_socket_for_testing(&fleet.state, &a.account_id);
        let first = fleet.acquire(&a).await.unwrap();
        let original_task = fleet.entries.lock().await.get(&a.account_id).unwrap().task.as_ref().unwrap().id();
        let second = fleet.acquire(&a).await.unwrap();
        assert_eq!(fleet.entries.lock().await.get(&a.account_id).unwrap().task.as_ref().unwrap().id(), original_task);
        drop(first); drop(second);
        let _b = install_person_socket_for_testing(&fleet.state, &b.account_id);
        drop(fleet.acquire(&b).await.unwrap());
        fleet.entries.lock().await.get(&a.account_id).unwrap().usage.last_used_ms.store(now_ms() - 100, Ordering::SeqCst);
        let _c = install_person_socket_for_testing(&fleet.state, &c.account_id);
        let request = fleet.acquire(&c).await.unwrap();
        assert!(!ws_bridge::account_connected(&a.account_id));
        assert!(ws_bridge::account_connected(&b.account_id));
        assert!(ws_bridge::account_connected(&c.account_id));
        let health = serde_json::to_string(&fleet.statuses()).unwrap();
        assert!(!health.contains("p5-test-org") && !health.contains("lru-c"));
        drop(request); fleet.shutdown().await;
    }

    #[tokio::test]
    async fn p5_fleet_readiness_timeout_and_cancel_release_request_leases() {
        let _slot = lock_slot().await; clear_socket_for_testing();
        let temp = tempfile::tempdir().unwrap(); let fleet = fixture(temp.path(), 1);
        let a = person("timeout-a");
        assert!(matches!(fleet.acquire(&a).await, Err("person_brain_unavailable")));
        assert_eq!(fleet.entries.lock().await.get(&a.account_id).unwrap().usage.in_flight.load(Ordering::SeqCst), 0);
        let attempt = { let fleet = fleet.clone(); let a = a.clone(); tokio::spawn(async move { fleet.acquire(&a).await }) };
        tokio::time::sleep(Duration::from_millis(20)).await;
        attempt.abort(); let _ = attempt.await;
        assert_eq!(fleet.entries.lock().await.get(&a.account_id).unwrap().usage.in_flight.load(Ordering::SeqCst), 0);
        fleet.shutdown().await;
    }

    #[tokio::test]
    async fn p5_purge_refuses_busy_destroys_key_and_data_and_rejoin_is_empty() {
        let _slot = lock_slot().await; clear_socket_for_testing();
        let temp = tempfile::tempdir().unwrap(); let fleet = fixture(temp.path(), 1);
        let a = person("purge-a");
        let _socket = install_person_socket_for_testing(&fleet.state, &a.account_id);
        let request = fleet.acquire(&a).await.unwrap();
        let old_scope = request.receipt_scope();
        let receipt_key = old_scope.key("purge-receipt");
        let cognia_companion::security_store::IdempotencyDecision::Started { operation_id } =
            fleet.ledger.begin_idempotent_operation("tenant", "device", "host", &receipt_key, "hash", 100).unwrap() else { panic!("new operation"); };
        fleet.ledger.mark_operation_running("tenant", &operation_id, 101).unwrap();
        fleet.ledger.complete_idempotent_operation("tenant", "device", &receipt_key, "{\"result\":\"old\"}", true, 102).unwrap();
        let key = cognia_secrets::secret_store::get(CONTENT_KEY_SERVICE, &a.account_id).unwrap().unwrap();
        let root = temp.path().join("persons").join(&a.account_id);
        std::fs::write(root.join("encrypted-data"), "old ciphertext").unwrap();
        assert_eq!(fleet.purge(&a).await, Err("person_brain_busy"));
        assert!(root.exists()); drop(request);
        fleet.purge(&a).await.unwrap(); fleet.purge(&a).await.unwrap();
        assert!(!root.exists());
        assert!(cognia_secrets::secret_store::get(CONTENT_KEY_SERVICE, &a.account_id).unwrap().is_none());
        assert!(fleet.person(&a.account_id).is_none());
        assert!(fleet.receipt_scope(&a.account_id).is_none());
        assert!(fleet.ledger.operation("tenant", "device", &operation_id).unwrap().is_none());
        let _new_socket = install_person_socket_for_testing(&fleet.state, &a.account_id);
        let request = fleet.acquire(&a).await.unwrap();
        let new_key = cognia_secrets::secret_store::get(CONTENT_KEY_SERVICE, &a.account_id).unwrap().unwrap();
        let new_scope = request.receipt_scope();
        assert_ne!(new_scope.data_generation, old_scope.data_generation);
        assert_ne!(new_key, key); assert!(!root.join("encrypted-data").exists());
        drop(request); fleet.shutdown().await;
        // Metadata is encrypted and survives restart, never exposed in health.
        let loaded = fixture(temp.path(), 1);
        assert_eq!(loaded.receipt_scope(&a.account_id), Some(new_scope));
        assert_eq!(loaded.person(&a.account_id), Some(a));
        loaded.shutdown().await;
    }
}
