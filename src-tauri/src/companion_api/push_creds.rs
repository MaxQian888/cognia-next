//! Persistent push-dispatcher credential storage (Phase B follow-up + D3).
//!
//! Two storage backends, both honoring the same [`PushCredStore`] surface:
//!
//! - [`KeyringPushCredStore`] — OS keyring under
//!   `com.cognia.companion-push/v1`, accounts `fcm` and `apns`. Default for
//!   the Tauri desktop build.
//! - [`FilePushCredStore`] — JSON files at `<data_dir>/push-credentials.{fcm,apns}.json`.
//!   Default for the headless `cognia-server` binary, where the host
//!   typically has no GNOME-keyring / Windows Credential Locker service.
//!
//! Credentials are loaded on demand by [`reinstall_persisted_dispatchers`]
//! at server start so the user's last upload survives a restart without
//! re-pasting the service account / `.p8` key.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::dispatchers::{ApnsCredentials, ApnsDispatcher, FcmDispatcher, FcmServiceAccount};
use super::push_dispatchers;

const SERVICE: &str = "com.cognia.companion-push/v1";
const FCM_ACCOUNT: &str = "fcm";
const APNS_ACCOUNT: &str = "apns";
const FCM_FILE: &str = "push-credentials.fcm.json";
const APNS_FILE: &str = "push-credentials.apns.json";

/// Serialized APNs credential — `ApnsCredentials` mirrored as Serialize so
/// the file backend can round-trip it. Mirrors the Tauri command input
/// shape so `companion_push_configure_apns` and the persisted record share
/// one schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedApns {
    pub key_id: String,
    pub team_id: String,
    pub bundle_id: String,
    pub private_key_pem: String,
    #[serde(default)]
    pub production: bool,
}

impl From<PersistedApns> for ApnsCredentials {
    fn from(p: PersistedApns) -> Self {
        ApnsCredentials {
            key_id: p.key_id,
            team_id: p.team_id,
            bundle_id: p.bundle_id,
            private_key_pem: p.private_key_pem,
            production: p.production,
        }
    }
}

impl PersistedApns {
    pub fn from_creds(c: ApnsCredentials) -> Self {
        Self {
            key_id: c.key_id,
            team_id: c.team_id,
            bundle_id: c.bundle_id,
            private_key_pem: c.private_key_pem,
            production: c.production,
        }
    }
}

/// Common interface across keyring + file backends.
pub trait PushCredStore: Send + Sync {
    fn load_fcm(&self) -> Result<Option<FcmServiceAccount>, String>;
    fn store_fcm(&self, account: &FcmServiceAccount) -> Result<(), String>;
    fn clear_fcm(&self) -> Result<(), String>;
    fn load_apns(&self) -> Result<Option<PersistedApns>, String>;
    fn store_apns(&self, creds: &PersistedApns) -> Result<(), String>;
    fn clear_apns(&self) -> Result<(), String>;
}

// ---------------------------------------------------------------------------
// Keyring backend
// ---------------------------------------------------------------------------

pub struct KeyringPushCredStore;

impl KeyringPushCredStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self)
    }
}

impl PushCredStore for KeyringPushCredStore {
    fn load_fcm(&self) -> Result<Option<FcmServiceAccount>, String> {
        match keyring_get(FCM_ACCOUNT)? {
            Some(raw) => serde_json::from_str(&raw)
                .map(Some)
                .map_err(|e| format!("FCM parse: {e}")),
            None => Ok(None),
        }
    }

    fn store_fcm(&self, account: &FcmServiceAccount) -> Result<(), String> {
        let raw = serde_json::to_string(account).map_err(|e| format!("FCM serialize: {e}"))?;
        keyring_set(FCM_ACCOUNT, &raw)
    }

    fn clear_fcm(&self) -> Result<(), String> {
        keyring_delete(FCM_ACCOUNT)
    }

    fn load_apns(&self) -> Result<Option<PersistedApns>, String> {
        match keyring_get(APNS_ACCOUNT)? {
            Some(raw) => serde_json::from_str(&raw)
                .map(Some)
                .map_err(|e| format!("APNs parse: {e}")),
            None => Ok(None),
        }
    }

    fn store_apns(&self, creds: &PersistedApns) -> Result<(), String> {
        let raw = serde_json::to_string(creds).map_err(|e| format!("APNs serialize: {e}"))?;
        keyring_set(APNS_ACCOUNT, &raw)
    }

    fn clear_apns(&self) -> Result<(), String> {
        keyring_delete(APNS_ACCOUNT)
    }
}

fn keyring_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| format!("keyring entry: {e}"))
}

fn keyring_get(account: &str) -> Result<Option<String>, String> {
    match keyring_entry(account)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring read: {e}")),
    }
}

fn keyring_set(account: &str, raw: &str) -> Result<(), String> {
    keyring_entry(account)?
        .set_password(raw)
        .map_err(|e| format!("keyring write: {e}"))
}

fn keyring_delete(account: &str) -> Result<(), String> {
    match keyring_entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete: {e}")),
    }
}

// ---------------------------------------------------------------------------
// File backend (headless)
// ---------------------------------------------------------------------------

pub struct FilePushCredStore {
    fcm_path: PathBuf,
    apns_path: PathBuf,
}

impl FilePushCredStore {
    pub fn new(data_dir: &Path) -> Arc<Self> {
        Arc::new(Self {
            fcm_path: data_dir.join(FCM_FILE),
            apns_path: data_dir.join(APNS_FILE),
        })
    }
}

impl PushCredStore for FilePushCredStore {
    fn load_fcm(&self) -> Result<Option<FcmServiceAccount>, String> {
        load_json(&self.fcm_path)
    }

    fn store_fcm(&self, account: &FcmServiceAccount) -> Result<(), String> {
        store_json(&self.fcm_path, account)
    }

    fn clear_fcm(&self) -> Result<(), String> {
        clear_file(&self.fcm_path)
    }

    fn load_apns(&self) -> Result<Option<PersistedApns>, String> {
        load_json(&self.apns_path)
    }

    fn store_apns(&self, creds: &PersistedApns) -> Result<(), String> {
        store_json(&self.apns_path, creds)
    }

    fn clear_apns(&self) -> Result<(), String> {
        clear_file(&self.apns_path)
    }
}

fn load_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|e| format!("parse {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

fn store_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(value).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(path, raw).map_err(|e| format!("write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)
            .map_err(|e| format!("stat: {e}"))?
            .permissions();
        perms.set_mode(0o600);
        let _ = std::fs::set_permissions(path, perms);
    }
    Ok(())
}

fn clear_file(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(path).map_err(|e| format!("remove {}: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// Process-wide selection + reinstall
// ---------------------------------------------------------------------------

static ACTIVE_STORE: once_cell::sync::Lazy<parking_lot::RwLock<Option<Arc<dyn PushCredStore>>>> =
    once_cell::sync::Lazy::new(|| parking_lot::RwLock::new(None));

/// Install the process-wide [`PushCredStore`]. Tauri build calls with
/// `KeyringPushCredStore::new()`; the headless binary calls with
/// `FilePushCredStore::new(data_dir)`.
pub fn install(store: Arc<dyn PushCredStore>) {
    *ACTIVE_STORE.write() = Some(store);
}

pub fn active() -> Option<Arc<dyn PushCredStore>> {
    ACTIVE_STORE.read().clone()
}

/// Load every persisted credential from the active store and install the
/// matching dispatchers into `push_dispatchers`. Called at server start.
pub fn reinstall_persisted_dispatchers() -> Result<(), String> {
    let Some(store) = active() else {
        return Ok(());
    };
    if let Some(fcm) = store.load_fcm()? {
        let dispatcher = FcmDispatcher::new(fcm);
        push_dispatchers().set_fcm(dispatcher);
    }
    if let Some(apns) = store.load_apns()? {
        let dispatcher = ApnsDispatcher::new(apns.into())?;
        push_dispatchers().set_apns(dispatcher);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample_fcm() -> FcmServiceAccount {
        FcmServiceAccount {
            client_email: "svc@example.com".into(),
            private_key: "fake-key".into(),
            project_id: "p".into(),
            private_key_id: None,
        }
    }

    fn sample_apns() -> PersistedApns {
        PersistedApns {
            key_id: "ABC1234DEF".into(),
            team_id: "TEAM1234DE".into(),
            bundle_id: "com.cognia.mobile".into(),
            private_key_pem: "fake-p8".into(),
            production: false,
        }
    }

    #[test]
    fn file_store_roundtrip_fcm() {
        let tmp = tempdir().unwrap();
        let store = FilePushCredStore::new(tmp.path());
        assert!(store.load_fcm().unwrap().is_none());
        store.store_fcm(&sample_fcm()).unwrap();
        let loaded = store.load_fcm().unwrap().expect("loaded");
        assert_eq!(loaded.client_email, "svc@example.com");
        store.clear_fcm().unwrap();
        assert!(store.load_fcm().unwrap().is_none());
    }

    #[test]
    fn file_store_roundtrip_apns() {
        let tmp = tempdir().unwrap();
        let store = FilePushCredStore::new(tmp.path());
        store.store_apns(&sample_apns()).unwrap();
        let loaded = store.load_apns().unwrap().expect("loaded");
        assert_eq!(loaded.key_id, "ABC1234DEF");
        assert!(!loaded.production);
        store.clear_apns().unwrap();
        assert!(store.load_apns().unwrap().is_none());
    }

    #[test]
    fn file_store_corrupt_json_surfaces_error() {
        let tmp = tempdir().unwrap();
        let store = FilePushCredStore::new(tmp.path());
        std::fs::write(tmp.path().join(FCM_FILE), "garbage").unwrap();
        let err = store.load_fcm().expect_err("corrupt should error");
        assert!(err.contains("parse"));
    }

    #[test]
    fn install_then_active_returns_same() {
        let tmp = tempdir().unwrap();
        let store: Arc<dyn PushCredStore> = FilePushCredStore::new(tmp.path());
        install(Arc::clone(&store));
        assert!(active().is_some());
    }
}
