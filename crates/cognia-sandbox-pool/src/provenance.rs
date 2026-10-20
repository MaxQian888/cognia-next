//! Durable admission authority for deliveries. A source is minted before spawn,
//! never reconstructed from a reused agent id or the handoff caller's labels.
use cognia_external_agent::spawn_authority::{DeliverySource, DeliverySourceDeclaration};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::{Path, PathBuf}};

// All SourceStore handles in this Host share one admission/deletion lock.
static WRITER: Mutex<()> = Mutex::new(());
const DIRECTORY: &str = "sandbox-sources";

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ledger {
    sources: Vec<DeliverySource>,
    /// Tombstones are permanent: a delayed spawn cannot revive a deleted source.
    revoked_conversations: Vec<(String, String, String)>,
    revoked_tasks: Vec<(String, String, String)>,
}

#[derive(Clone)]
pub struct SourceStore { path: PathBuf }
impl SourceStore {
    pub fn new(data_dir: &Path) -> Self { Self { path: data_dir.join(DIRECTORY).join("admissions.json") } }

    /// `owner`, `host` and `device` must come from authenticated Host context.
    /// Declared references are captured once; they never grant source authority.
    pub fn admit(
        &self, owner: &str, host: &str, task: &str, device: &str,
        declaration: DeliverySourceDeclaration,
        repository: &str, base_ref: &str, branch: &str, credential_ref: Option<String>,
    ) -> Result<DeliverySource, String> {
        self.admit_bound(owner, host, task, device, declaration, repository, base_ref, branch, credential_ref, None)
    }

    /// Binding is passed explicitly: persistence runs on a blocking worker
    /// outside the request's task-local context.
    pub fn admit_bound(
        &self, owner: &str, host: &str, task: &str, device: &str,
        declaration: DeliverySourceDeclaration,
        repository: &str, base_ref: &str, branch: &str, credential_ref: Option<String>,
        binding: Option<cognia_external_agent::spawn_authority::PlacementBinding>,
    ) -> Result<DeliverySource, String> {
        for value in [owner, host, task, device, &declaration.conversation_id, &declaration.origin_run_ref] {
            validate_id(value)?;
        }
        let repository_url = normalize_repository(repository)?;
        if base_ref.is_empty() || branch.is_empty() || base_ref.len() > 1024 || branch.len() > 1024 {
            return Err("delivery_source_invalid_repository_ref".into());
        }
        if credential_ref.as_ref().is_some_and(|reference| !(reference.starts_with("delivery-source:") || reference.starts_with("git-helper:")) || validate_id(reference).is_err()) {
            return Err("delivery_source_invalid_credential_reference".into());
        }
        let _guard = WRITER.lock();
        let mut ledger = self.read()?;
        reject_revoked(&ledger, owner, host, task, &declaration.conversation_id)?;
        // Reusing an origin run within an owner/Host cannot retarget its task,
        // repository or declaring principal, even after process restart.
        if let Some(existing) = ledger.sources.iter().find(|s| s.owner_account_id == owner && s.host_id == host && s.origin_run_ref == declaration.origin_run_ref) {
            if existing.task_id != task || existing.device_id != device
                || existing.conversation_id != declaration.conversation_id
                || existing.repository_url != repository_url || existing.base_ref != base_ref
                || existing.branch != branch || existing.credential_ref != credential_ref || existing.binding != binding {
                return Err("delivery_source_immutable_binding_conflict".into());
            }
            return Ok(existing.clone());
        }
        let source = DeliverySource {
            binding,
            version: 1, id: uuid::Uuid::new_v4().to_string(),
            owner_account_id: owner.into(), host_id: host.into(), task_id: task.into(), device_id: device.into(),
            conversation_id: declaration.conversation_id,
            coding_run_id: uuid::Uuid::new_v4().to_string(), origin_run_ref: declaration.origin_run_ref,
            repository_url, base_ref: base_ref.into(), branch: branch.into(), credential_ref,
        };
        ledger.sources.push(source.clone());
        self.write(&ledger)?;
        Ok(source)
    }

    pub fn authorize(&self, id: &str, owner: &str, host: &str) -> Result<DeliverySource, String> {
        let _guard = WRITER.lock();
        let ledger = self.read()?;
        let source = ledger.sources.iter().find(|s| s.id == id)
            .ok_or("delivery_source_missing")?;
        if source.version != 1 || source.owner_account_id != owner || source.host_id != host {
            return Err("delivery_source_forbidden".into());
        }
        reject_revoked(&ledger, owner, host, &source.task_id, &source.conversation_id)?;
        Ok(source.clone())
    }

    pub fn has_task(&self, task: &str) -> Result<bool, String> {
        let _guard = WRITER.lock();
        Ok(self.read()?.sources.iter().any(|source| source.task_id == task))
    }
    /// Minimal task identities for canonical deletion, including revoked rows.
    /// A client-provided gateway link never selects a different Host's task.
    pub fn tasks_for_conversations(&self, owner: &str, host: &str, conversations: &[String]) -> Result<Vec<String>, String> {
        let _guard = WRITER.lock();
        let mut tasks: Vec<_> = self.read()?.sources.iter().filter(|s| s.owner_account_id == owner && s.host_id == host
            && conversations.contains(&s.conversation_id)).map(|s| s.task_id.clone()).collect();
        tasks.sort(); tasks.dedup(); Ok(tasks)
    }
    /// Historical ownership remains verifiable after source revocation. This
    /// never restores execution authority; it protects native deletion retries.
    pub fn verify_task_owner(&self, owner: &str, host: &str, task: &str) -> Result<(), String> {
        let _guard = WRITER.lock();
        let ledger = self.read()?;
        let sources: Vec<_> = ledger.sources.iter().filter(|s| s.task_id == task).collect();
        if sources.is_empty() || sources.iter().any(|s| s.owner_account_id != owner || s.host_id != host) {
            return Err("delivery_source_forbidden".into());
        }
        Ok(())
    }
    /// Called after read-only process/device preflight and before destructive deletion.
    pub fn revoke_owned_task(&self, owner: &str, host: &str, task: &str, device: Option<&str>) -> Result<(), String> {
        let _guard = WRITER.lock();
        let mut ledger = self.read()?;
        let sources: Vec<_> = ledger.sources.iter().filter(|s| s.task_id == task).collect();
        if sources.iter().any(|source| source.owner_account_id != owner || source.host_id != host || device.is_some_and(|device| source.device_id != device)) {
            return Err("delivery_source_forbidden".into());
        }
        if sources.is_empty() { return Ok(()); }
        let key = (owner.into(), host.into(), task.into());
        if !ledger.revoked_tasks.contains(&key) { ledger.revoked_tasks.push(key); }
        self.write(&ledger)
    }

    pub fn revoke_conversation(&self, owner: &str, host: &str, conversation: &str) -> Result<(), String> {
        self.revoke(owner, host, conversation, false)
    }
    pub fn revoke_task(&self, owner: &str, host: &str, task: &str) -> Result<(), String> {
        self.revoke(owner, host, task, true)
    }
    fn revoke(&self, owner: &str, host: &str, id: &str, task: bool) -> Result<(), String> {
        for value in [owner, host, id] { validate_id(value)?; }
        let _guard = WRITER.lock();
        let mut ledger = self.read()?;
        let tombstones = if task { &mut ledger.revoked_tasks } else { &mut ledger.revoked_conversations };
        let key = (owner.into(), host.into(), id.into());
        if !tombstones.contains(&key) { tombstones.push(key); }
        self.write(&ledger)
    }
    fn read(&self) -> Result<Ledger, String> {
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "delivery_source_corrupt".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Ledger::default()),
            Err(_) => Err("delivery_source_unavailable".into()),
        }
    }
    fn write(&self, ledger: &Ledger) -> Result<(), String> {
        let directory = self.path.parent().ok_or("delivery_source_unavailable")?;
        fs::create_dir_all(directory).map_err(|_| "delivery_source_unavailable")?;
        let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|_| "delivery_source_unavailable")?;
        let bytes = serde_json::to_vec(ledger).map_err(|_| "delivery_source_unavailable")?;
        file.write_all(&bytes).and_then(|_| file.as_file().sync_all()).map_err(|_| "delivery_source_unavailable")?;
        file.persist(&self.path).map_err(|_| "delivery_source_unavailable")?;
        fs::File::open(directory).and_then(|f| f.sync_all()).map_err(|_| "delivery_source_unavailable".into())
    }
}
fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 256 || value.chars().any(|c| c.is_control()) {
        Err("delivery_source_invalid_identity".into())
    } else { Ok(()) }
}
fn reject_revoked(ledger: &Ledger, owner: &str, host: &str, task: &str, conversation: &str) -> Result<(), String> {
    let matches = |row: &(String, String, String), id: &str| row.0 == owner && row.1 == host && row.2 == id;
    if ledger.revoked_tasks.iter().any(|row| matches(row, task)) || ledger.revoked_conversations.iter().any(|row| matches(row, conversation)) {
        Err("delivery_source_revoked".into())
    } else { Ok(()) }
}
pub fn normalize_repository(value: &str) -> Result<String, String> {
    let mut url = url::Url::parse(value).map_err(|_| "delivery_source_invalid_repository")?;
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty()
        || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
        || url.path() == "/" || url.path().contains("%") {
        return Err("delivery_source_invalid_repository".into());
    }
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&path);
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn p4_delivery_binding_is_durable_and_cannot_be_retargeted() {
        use cognia_external_agent::spawn_authority::PlacementBinding;
        let directory = tempfile::tempdir().unwrap();
        let store = SourceStore::new(directory.path());
        let binding = PlacementBinding { org_id: "org_a".into(), workspace_id: "w".into(), actor_user_id: "usr_a".into(), run_id: "run".into() };
        let declare = || DeliverySourceDeclaration { conversation_id: "conversation".into(), origin_run_ref: "origin".into() };
        let source = store.admit_bound("owner", "host", "task", "device", declare(), "https://example.com/repo.git", "main", "branch", None, Some(binding.clone())).unwrap();
        assert_eq!(SourceStore::new(directory.path()).authorize(&source.id, "owner", "host").unwrap().binding, Some(binding));
        assert_eq!(store.admit_bound("owner", "host", "task", "device", declare(), "https://example.com/repo.git", "main", "branch", None, None).unwrap_err(), "delivery_source_immutable_binding_conflict");
        assert!(serde_json::to_value(admit(&store, "legacy")).unwrap().get("binding").is_none());
    }
    fn admit(store: &SourceStore, run: &str) -> DeliverySource {
        store.admit("owner", "host", "task", "device", DeliverySourceDeclaration { conversation_id: "conversation".into(), origin_run_ref: run.into() }, "https://example.com/repo.git", "main", "task/branch", None).unwrap()
    }
    #[test]
    fn restart_identity_reuse_and_account_changes_cannot_rebind_a_source() {
        let directory = tempfile::tempdir().unwrap();
        let source = admit(&SourceStore::new(directory.path()), "origin");
        assert_ne!(source.coding_run_id, source.origin_run_ref);
        let reopened = SourceStore::new(directory.path());
        assert_eq!(reopened.authorize(&source.id, "owner", "host").unwrap(), source);
        assert_eq!(admit(&reopened, "origin"), source);
        assert_ne!(admit(&reopened, "another-run").id, source.id);
        assert!(reopened.authorize(&source.id, "another-owner", "host").is_err());
        assert!(reopened.authorize(&source.id, "owner", "another-host").is_err());
        assert!(reopened.admit("owner", "host", "forged-task", "device", DeliverySourceDeclaration { conversation_id: "conversation".into(), origin_run_ref: "origin".into() }, "https://example.com/repo.git", "main", "task/branch", None).is_err());
    }
    #[test]
    fn deletion_tombstone_survives_restart_and_prevents_delayed_admission() {
        let directory = tempfile::tempdir().unwrap();
        let store = SourceStore::new(directory.path());
        let source = admit(&store, "run");
        store.revoke_conversation("owner", "host", "conversation").unwrap();
        let reopened = SourceStore::new(directory.path());
        assert!(reopened.authorize(&source.id, "owner", "host").is_err());
        assert!(reopened.admit("owner", "host", "task", "device", DeliverySourceDeclaration { conversation_id: "conversation".into(), origin_run_ref: "late".into() }, "https://example.com/repo.git", "main", "task/branch", None).is_err());
    }
    #[test]
    fn task_deletion_is_scoped_and_corruption_fails_closed() {
        let directory = tempfile::tempdir().unwrap();
        let store = SourceStore::new(directory.path());
        let source = admit(&store, "run");
        store.revoke_task("other", "host", "task").unwrap();
        assert!(store.authorize(&source.id, "owner", "host").is_ok());
        store.revoke_task("owner", "host", "task").unwrap();
        assert!(store.authorize(&source.id, "owner", "host").is_err());
        fs::write(&store.path, "{").unwrap();
        assert!(store.authorize(&source.id, "owner", "host").is_err());
    }
    #[test]
    fn repository_identity_never_contains_credentials_or_query_secrets() {
        for value in ["https://user:secret@example.com/repo", "https://example.com/repo?token=secret", "file:///tmp/repo", "https://example.com/%2frepo"] {
            assert!(normalize_repository(value).is_err());
        }
        assert_eq!(normalize_repository("https://EXAMPLE.com/repo/").unwrap(), "https://example.com/repo");
    }
    #[test]
    fn deletion_owner_cannot_change_after_revocation() {
        let directory = tempfile::tempdir().unwrap(); let store = SourceStore::new(directory.path());
        admit(&store,"run"); store.revoke_owned_task("owner","host","task",None).unwrap();
        assert!(store.verify_task_owner("owner","host","task").is_ok());
        assert!(store.verify_task_owner("other","host","task").is_err());
        assert!(store.verify_task_owner("owner","other","task").is_err());
    }
    #[test]
    fn unauthorized_task_deletion_never_mutates_source_authority() {
        let directory = tempfile::tempdir().unwrap();
        let store = SourceStore::new(directory.path());
        let source = admit(&store, "run");
        assert!(store.revoke_owned_task("owner", "host", "task", Some("other-device")).is_err());
        assert!(store.revoke_owned_task("other-owner", "host", "task", Some("device")).is_err());
        assert!(store.authorize(&source.id, "owner", "host").is_ok());
        store.revoke_owned_task("owner", "host", "task", Some("device")).unwrap();
        assert!(store.authorize(&source.id, "owner", "host").is_err());
    }

}
