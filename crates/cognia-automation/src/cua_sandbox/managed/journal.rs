//! Crash-safe Host state. Secrets are deliberately absent from both files.
use super::contracts::*;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_STATE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedDesktopJournal {
    pub version: u32,
    pub host_id: String,
    pub revision: u64,
    pub last_observed_at: i64,
    pub quotes: BTreeMap<String, ManagedDesktopQuote>,
    pub authorizations: BTreeMap<String, DesktopAuthorization>,
    pub templates: BTreeMap<String, TemplateRecord>,
    pub qualifications: BTreeMap<String, QualificationReceipt>,
    /// Partial v2 lifecycle evidence is retained without enabling production.
    #[serde(default)]
    pub lifecycle_diagnostics: BTreeMap<String, QualificationReceipt>,
    #[serde(default)]
    pub workload_boundaries: BTreeMap<String, HostBoundaryBinding>,
    pub desktops: BTreeMap<String, DesktopRecord>,
    #[serde(default)]
    pub control_quarantines: std::collections::BTreeSet<String>,
    #[serde(default)]
    pub control_qualifications:
        BTreeMap<String, super::service::control::ControlQualificationReceipt>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedDesktopRegistry {
    pub version: u32,
    pub providers: Vec<ManagedDesktopConfig>,
}
impl Default for ManagedDesktopRegistry {
    fn default() -> Self {
        Self {
            version: 1,
            providers: Vec::new(),
        }
    }
}

pub struct JournalStore {
    directory: PathBuf,
    // A process-level file lock also excludes a second service in the same
    // process. An OS-released lock, unlike a sentinel, survives crash recovery.
    _lock: File,
}
impl JournalStore {
    pub fn open(directory: &Path) -> Result<Self> {
        use fs2::FileExt;
        private_directory(directory)?;
        let lock = private_open(&directory.join("managed-desktops.lock"))?;
        lock.try_lock_exclusive()
            .map_err(|_| refused("managed_desktop_journal_in_use"))?;
        Ok(Self {
            directory: directory.to_owned(),
            _lock: lock,
        })
    }
    pub fn load(&self, host: &str) -> Result<ManagedDesktopJournal> {
        let file = self.directory.join("managed-desktops-journal.json");
        let mut journal: ManagedDesktopJournal = match read_json(&file)? {
            Some(value) => value,
            None => ManagedDesktopJournal {
                version: 1,
                host_id: host.into(),
                ..Default::default()
            },
        };
        if journal.version != 1 || journal.host_id != host {
            return Err(refused("managed_desktop_journal_identity_mismatch"));
        }
        for (key, row) in &journal.desktops {
            if row.desktop.id != *key || row.config.host_id != host {
                return Err(refused("managed_desktop_journal_invalid"));
            }
        }
        // Creating/registering is an unknown outcome after process death,
        // never permission to repeat a billable operation.
        for row in journal.templates.values_mut() {
            if row.state == TemplateState::Registering {
                row.state = TemplateState::Unknown;
            }
        }
        Ok(journal)
    }
    pub fn registry(&self) -> Result<ManagedDesktopRegistry> {
        let registry: ManagedDesktopRegistry =
            read_json(&self.directory.join("managed-desktops.json"))?.unwrap_or_default();
        if registry.version != 1 {
            return Err(refused("managed_desktop_config_version"));
        }
        let mut ids = std::collections::BTreeSet::new();
        if registry
            .providers
            .iter()
            .any(|c| !ids.insert((&c.owner_principal_id, &c.id)))
        {
            return Err(refused("managed_desktop_config_duplicate"));
        }
        Ok(registry)
    }
    pub fn save_registry(&self, registry: &ManagedDesktopRegistry) -> Result<()> {
        write_json(&self.directory.join("managed-desktops.json"), registry)
    }
    pub fn save(&self, journal: &ManagedDesktopJournal) -> Result<()> {
        write_json(
            &self.directory.join("managed-desktops-journal.json"),
            journal,
        )
    }
}

pub(crate) fn private_directory(path: &Path) -> Result<()> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(refused("managed_desktop_storage_invalid"));
    }
    fs::create_dir_all(path).map_err(|_| retryable("managed_desktop_storage_unavailable"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| retryable("managed_desktop_storage_unavailable"))?;
    }
    Ok(())
}
fn private_open(path: &Path) -> Result<File> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(refused("managed_desktop_storage_invalid"));
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| retryable("managed_desktop_storage_unavailable"))
}
pub(crate) fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(refused("managed_desktop_storage_invalid"));
    }
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(retryable("managed_desktop_storage_unavailable")),
    };
    if file
        .metadata()
        .map_err(|_| retryable("managed_desktop_storage_unavailable"))?
        .len()
        > MAX_STATE_BYTES
    {
        return Err(refused("managed_desktop_storage_limit"));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_STATE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| retryable("managed_desktop_storage_unavailable"))?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err(refused("managed_desktop_storage_limit"));
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| refused("managed_desktop_storage_corrupt"))
}
pub(crate) fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| refused("managed_desktop_storage_invalid"))?;
    let bytes =
        serde_json::to_vec(value).map_err(|_| refused("managed_desktop_storage_invalid"))?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err(refused("managed_desktop_storage_limit"));
    }
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| retryable("managed_desktop_storage_unavailable"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| retryable("managed_desktop_storage_unavailable"))?;
    }
    temp.write_all(&bytes)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| retryable("managed_desktop_storage_unavailable"))?;
    temp.persist(path)
        .map_err(|_| retryable("managed_desktop_storage_unavailable"))?;
    File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| retryable("managed_desktop_storage_unavailable"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn journal_round_trip_lock_and_corruption_fail_closed() {
        let tmp = tempfile::tempdir().unwrap();
        let store = JournalStore::open(tmp.path()).unwrap();
        assert!(JournalStore::open(tmp.path()).is_err());
        let mut state = store.load("host").unwrap();
        state.revision = 5;
        store.save(&state).unwrap();
        assert_eq!(store.load("host").unwrap().revision, 5);
        let mut legacy = serde_json::to_value(&state).unwrap();
        legacy.as_object_mut().unwrap().remove("workloadBoundaries");
        legacy.as_object_mut().unwrap().remove("lifecycleDiagnostics");
        write_json(&tmp.path().join("managed-desktops-journal.json"), &legacy).unwrap();
        let restored = store.load("host").unwrap();
        assert!(restored.workload_boundaries.is_empty());
        assert!(restored.lifecycle_diagnostics.is_empty());
        assert!(store.load("other").is_err());
        fs::write(tmp.path().join("managed-desktops-journal.json"), b"partial").unwrap();
        assert!(store.load("host").is_err());
        drop(store);
        assert!(JournalStore::open(tmp.path()).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn storage_refuses_symlink_and_keeps_private_permissions() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("root");
        let store = JournalStore::open(&root).unwrap();
        store.save(&store.load("h").unwrap()).unwrap();
        assert_eq!(
            fs::metadata(root.join("managed-desktops-journal.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        symlink(&root, tmp.path().join("link")).unwrap();
        assert!(JournalStore::open(&tmp.path().join("link")).is_err());
    }
}
