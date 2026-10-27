//! Durable ownership and unfinished-operation recovery. One Host owns the lock.
use super::contracts::*;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileIdentity {
    pub device: u64,
    pub inode: u64,
}

pub fn identity(path: &Path) -> Result<FileIdentity, String> {
    let metadata = path
        .symlink_metadata()
        .map_err(|_| "lume_identity_missing")?;
    if metadata.file_type().is_symlink() {
        return Err("lume_identity_symlink".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if !metadata.is_file() || metadata.nlink() != 1 {
            return Err("lume_identity_file_type".into());
        }
        Ok(FileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        Err("lume_platform_unsupported".into())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OwnedResource {
    pub projection: Resource,
    pub disk: Option<FileIdentity>,
    pub nvram: Option<FileIdentity>,
    pub immutable_config_hash: Option<String>,
    pub ssh_host_key: Option<String>,
    pub ssh_user: Option<String>,
    pub instance_nonce: Option<String>,
    pub driver_version: Option<String>,
    #[serde(default)]
    pub driver_schema_hash: Option<String>,
    #[serde(default)]
    pub driver_identity: Option<cognia_desktop_guest::lume::DriverIdentity>,
    #[serde(default)]
    pub driver_identity_epoch: Option<String>,
    pub helper_hash: Option<String>,
    #[serde(default)]
    pub approved_session_id: Option<String>,
    #[serde(default)]
    pub unmanaged_writers: bool,
    #[serde(default)]
    pub(super) workspace: Option<super::workspace::Source>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Binding {
    pub reference: BindingRef,
    pub session_id: String,
    pub policy: BindingPolicy,
    #[serde(default)]
    pub account_generation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Data {
    pub version: u32,
    pub enabled: bool,
    pub binary: Option<PathBuf>,
    pub binary_hash: Option<String>,
    pub resources: BTreeMap<String, OwnedResource>,
    pub operations: BTreeMap<String, OperationStatus>,
    pub bindings: BTreeMap<String, Binding>,
}

impl Default for Data {
    fn default() -> Self {
        Self {
            version: CONTRACT_VERSION,
            enabled: false,
            binary: None,
            binary_hash: None,
            resources: BTreeMap::new(),
            operations: BTreeMap::new(),
            bindings: BTreeMap::new(),
        }
    }
}

pub struct Journal {
    pub root: PathBuf,
    pub data: Data,
    _lock: Arc<HostLock>,
    writes: Arc<DurableWrites>,
}

struct HostLock(File);

impl Drop for HostLock {
    fn drop(&mut self) {
        // A fork on another thread can retain a descriptor until exec. Only
        // authoritative owners share this Arc; their final release explicitly
        // ends authority even while a child still holds an inherited raw fd.
        let _ = FileExt::unlock(&self.0);
    }
}

struct DurableWrites {
    next: AtomicU64,
    committed: Mutex<u64>,
}

impl Journal {
    pub fn open(root: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&root).map_err(|_| "lume_journal_directory")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "lume_journal_permissions")?;
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("host.lock"))
            .map_err(|_| "lume_journal_lock")?;
        lock.try_lock_exclusive()
            .map_err(|_| "lume_host_already_running")?;
        let lock = Arc::new(HostLock(lock));
        let file = root.join("journal.json");
        let read = File::open(&file).and_then(|file| {
            let mut bytes = Vec::new();
            file.take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
            Ok(bytes)
        });
        let mut data: Data = match read {
            Ok(bytes) if bytes.len() <= 8 * 1024 * 1024 => {
                let mut durable: serde_json::Value =
                    serde_json::from_slice(&bytes).map_err(|_| "lume_journal_corrupt")?;
                if durable["version"] != CONTRACT_VERSION {
                    return Err("lume_journal_version".into());
                }
                // Bindings never survive restart. Discard their old wire shape
                // before deserialization so recovery can open v1 journals.
                durable
                    .as_object_mut()
                    .ok_or("lume_journal_corrupt")?
                    .insert("bindings".into(), serde_json::json!({}));
                serde_json::from_value(durable).map_err(|_| "lume_journal_corrupt")?
            }
            Ok(_) => return Err("lume_journal_limit".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Data::default(),
            Err(_) => return Err("lume_journal_read".into()),
        };
        if data.version != CONTRACT_VERSION {
            return Err("lume_journal_version".into());
        }
        // Restart never replays commands, bindings, frames or qualifications.
        data.bindings.clear();
        for operation in data
            .operations
            .values_mut()
            .filter(|op| op.state == "running")
        {
            operation.state = "failed".into();
            operation.error_code = Some("lume_host_restarted".into());
            if let Some(resource) = operation
                .resource
                .as_ref()
                .and_then(|r| data.resources.get_mut(&r.reference.resource_id))
            {
                resource.projection.quarantine = true;
            }
        }
        for resource in data.resources.values_mut() {
            resource.projection.readiness = Readiness::default();
            resource.projection.reference.boot_epoch = uuid::Uuid::new_v4().to_string();
            if resource.projection.state != "stopped"
                && resource.projection.state != "uninitialized"
            {
                resource.projection.quarantine = true;
            }
        }
        let journal = Self {
            root,
            data,
            _lock: lock,
            writes: Arc::new(DurableWrites {
                next: AtomicU64::new(0),
                committed: Mutex::new(0),
            }),
        };
        journal.save()?;
        Ok(journal)
    }

    fn encoded(&self) -> Result<Vec<u8>, String> {
        let mut durable = self.data.clone();
        for operation in durable.operations.values_mut() {
            operation.output = None;
        }
        let bytes = serde_json::to_vec(&durable).map_err(|_| "lume_journal_encode")?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("lume_journal_limit".into());
        }
        Ok(bytes)
    }

    pub fn save(&self) -> Result<(), String> {
        let bytes = self.encoded()?;
        let revision = self.writes.next.fetch_add(1, Ordering::SeqCst) + 1;
        commit_snapshot(&self.root, &bytes, &self.writes, revision)
    }

    /// Disk stalls cannot hold the async service mutex indefinitely. A timed-
    /// out writer retains the OS lock and finishes only its atomic snapshot;
    /// sequence checks prevent it from overwriting a newer recovery snapshot.
    pub async fn save_async(&self) -> Result<(), String> {
        let bytes = self.encoded()?;
        let root = self.root.clone();
        let writes = self.writes.clone();
        let host_lock = self._lock.clone();
        let revision = writes.next.fetch_add(1, Ordering::SeqCst) + 1;
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            tokio::task::spawn_blocking(move || {
                let _host_lock = host_lock;
                commit_snapshot(&root, &bytes, &writes, revision)
            }),
        )
        .await
        .map_err(|_| "lume_journal_timeout".to_string())?
        .map_err(|_| "lume_journal_worker".to_string())?
    }

    pub fn resource(&self, reference: &ResourceRef) -> Result<&OwnedResource, String> {
        let resource = self
            .data
            .resources
            .get(&reference.resource_id)
            .ok_or("lume_resource_missing")?;
        if resource.projection.reference != *reference {
            return Err("lume_stale_resource".into());
        }
        Ok(resource)
    }
}

fn commit_snapshot(
    root: &Path,
    bytes: &[u8],
    writes: &DurableWrites,
    revision: u64,
) -> Result<(), String> {
    let mut committed = writes.committed.lock().map_err(|_| "lume_journal_worker")?;
    if revision <= *committed {
        return Ok(());
    }
    let temporary = root.join("journal.pending");
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temporary)
        .map_err(|_| "lume_journal_write")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "lume_journal_permissions")?;
    }
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "lume_journal_sync")?;
    std::fs::rename(temporary, root.join("journal.json")).map_err(|_| "lume_journal_commit")?;
    File::open(root)
        .and_then(|f| f.sync_all())
        .map_err(|_| "lume_journal_sync".to_string())?;
    *committed = revision;
    Ok(())
}

#[cfg(test)]
pub(crate) fn test_resource() -> OwnedResource {
    serde_json::from_value(serde_json::json!({"projection":{"resourceId":"r","generation":1,"bootEpoch":"boot","connectionId":"c","vmName":"cognia-test","state":"running","readiness":{"vm":true,"ssh":true,"helper":true,"gui":true},"quarantine":false,"memoryMb":8192,"lastErrorCode":null,"groupId":null},"disk":null,"nvram":null,"immutable_config_hash":null,"ssh_host_key":null,"ssh_user":null,"instance_nonce":null,"driver_version":null,"helper_hash":null})).unwrap()
}

#[cfg(test)]
mod tests {
    #[test]
    fn legacy_binding_shapes_are_discarded_before_loading_owned_resources() {
        let root = tempfile::tempdir().unwrap();
        let mut journal = super::Journal::open(root.path().into()).unwrap();
        journal
            .data
            .resources
            .insert("r".into(), super::test_resource());
        journal.save().unwrap();
        drop(journal);
        let path = root.path().join("journal.json");
        let mut data: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        data["bindings"] = serde_json::json!({"old":{"reference":{"resourceId":"r","generation":1,"bootEpoch":"boot","bindingId":"old"},"session_id":"session","policy":{}}});
        std::fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
        let recovered = super::Journal::open(root.path().into()).unwrap();
        assert!(recovered.data.bindings.is_empty());
        assert!(recovered.data.resources.contains_key("r"));
        assert!(recovered.data.resources["r"].projection.quarantine);
    }
    use super::*;
    #[cfg(unix)]
    #[test]
    fn disk_identity_rejects_shared_hardlinks_and_directories() {
        let root = tempfile::tempdir().unwrap();
        let disk = root.path().join("disk.img");
        std::fs::write(&disk, b"disk").unwrap();
        assert!(identity(&disk).is_ok());
        std::fs::hard_link(&disk, root.path().join("alias.img")).unwrap();
        assert!(identity(&disk).is_err());
        assert!(identity(root.path()).is_err());
    }
    #[test]
    fn late_snapshot_cannot_overwrite_newer_stop_recovery() {
        let root = tempfile::tempdir().unwrap();
        let journal = Journal::open(root.path().to_path_buf()).unwrap();
        commit_snapshot(root.path(), b"newer-stopped", &journal.writes, 3).unwrap();
        commit_snapshot(root.path(), b"older-running", &journal.writes, 2).unwrap();
        assert_eq!(
            std::fs::read(root.path().join("journal.json")).unwrap(),
            b"newer-stopped"
        );
    }
    #[test]
    fn lock_is_exclusive_and_unknown_journals_are_preserved() {
        let root = tempfile::tempdir().unwrap();
        let journal = Journal::open(root.path().to_path_buf()).unwrap();
        assert!(Journal::open(root.path().to_path_buf()).is_err());
        drop(journal);
        std::fs::write(root.path().join("journal.json"), b"{\"version\":999}").unwrap();
        assert!(Journal::open(root.path().to_path_buf()).is_err());
        assert_eq!(
            std::fs::read(root.path().join("journal.json")).unwrap(),
            b"{\"version\":999}"
        );
    }
    #[test]
    fn inherited_descriptor_does_not_extend_host_authority() {
        let root = tempfile::tempdir().unwrap();
        let journal = Journal::open(root.path().to_path_buf()).unwrap();
        let inherited = journal._lock.0.try_clone().unwrap();
        drop(journal);
        let recovered = Journal::open(root.path().to_path_buf()).unwrap();
        drop(inherited);
        assert!(Journal::open(root.path().to_path_buf()).is_err());
        drop(recovered);
    }
    #[test]
    fn pending_writer_retains_host_authority_until_last_release() {
        let root = tempfile::tempdir().unwrap();
        let journal = Journal::open(root.path().to_path_buf()).unwrap();
        let writer = journal._lock.clone();
        drop(journal);
        assert!(Journal::open(root.path().to_path_buf()).is_err());
        drop(writer);
        assert!(Journal::open(root.path().to_path_buf()).is_ok());
    }
    #[test]
    fn stale_boot_and_unknown_resource_never_grant_authority() {
        let root = tempfile::tempdir().unwrap();
        let journal = Journal::open(root.path().to_path_buf()).unwrap();
        assert!(journal
            .resource(&ResourceRef {
                resource_id: "legacy".into(),
                generation: 1,
                boot_epoch: "old".into()
            })
            .is_err());
    }

    #[test]
    fn restart_revokes_authority_without_persisting_file_or_exec_contents() {
        let root = tempfile::tempdir().unwrap();
        let mut journal = Journal::open(root.path().to_path_buf()).unwrap();
        let resource = test_resource();
        let reference = resource.projection.reference.clone();
        journal.data.resources.insert("r".into(), resource.clone());
        journal.data.operations.insert(
            "op".into(),
            OperationStatus {
                id: "op".into(),
                request_key: "key".into(),
                request_hash: "hash".into(),
                state: "running".into(),
                stage: "executing".into(),
                resource: Some(resource.projection),
                error_code: None,
                output: Some(serde_json::json!({"body":"sensitive-body".repeat(1024*1024)})),
            },
        );
        journal.save().unwrap();
        let bytes = std::fs::read(root.path().join("journal.json")).unwrap();
        assert!(bytes.len() < 4096);
        assert!(!String::from_utf8(bytes).unwrap().contains("sensitive-body"));
        drop(journal);
        let recovered = Journal::open(root.path().to_path_buf()).unwrap();
        assert!(recovered.data.resources["r"].projection.quarantine);
        assert!(!recovered.data.resources["r"].projection.readiness.helper);
        assert!(recovered.resource(&reference).is_err());
        assert_eq!(
            recovered.data.operations["op"].error_code.as_deref(),
            Some("lume_host_restarted")
        );
    }
}
