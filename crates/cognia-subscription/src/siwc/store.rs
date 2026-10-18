//! A separate, freshly read encrypted envelope. Never use the legacy cached
//! provider vault for rotating SIWC credentials.
use super::{SiwcConnection, SiwcStatus};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::time::Instant;

#[derive(Clone)]
pub(super) struct Store {
    pub root: PathBuf,
    namespace: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Envelope {
    pub version: u32,
    pub host_id: String,
    pub registrations: BTreeMap<String, Registration>,
    /// Issued clients awaiting verified identity. Never enumerated as accounts.
    #[serde(default)]
    pub pending_clients: BTreeMap<String, Registration>,
    #[serde(default)]
    pub tombstones: BTreeMap<String, u64>,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Registration {
    pub id: String,
    pub issuer: String,
    pub subject: String,
    pub issued_client_id: String,
    pub email: Option<String>,
    pub label: String,
    pub revision: u64,
    pub session: Option<Session>,
    pub reauth_required: bool,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Session {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
    pub scopes: Vec<String>,
    pub expires_at_ms: i64,
    /// Kept opaque: upstream does not specify units or scheduling semantics.
    pub earliest_refresh_at: Option<Value>,
    pub refresh_pending: bool,
    #[serde(default)]
    pub refresh_retry_after_ms: Option<i64>,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}

impl Registration {
    pub fn summary(&self) -> SiwcConnection {
        let scopes = self
            .session
            .as_ref()
            .map(|s| s.scopes.clone())
            .unwrap_or_default();
        let plan_permission = scopes.iter().any(|s| s == "chatgpt.tokens.use.direct")
            && scopes.iter().any(|s| s == "resource.invoke");
        let uncertain = self.session.as_ref().is_some_and(|s| s.refresh_pending);
        SiwcConnection {
            id: self.id.clone(),
            issuer: self.issuer.clone(),
            subject: self.subject.clone(),
            issued_client_id: self.issued_client_id.clone(),
            email: self.email.clone(),
            label: self.label.clone(),
            status: if self.reauth_required || uncertain {
                SiwcStatus::ReauthRequired
            } else if self.session.is_none() {
                SiwcStatus::SignedOut
            } else if !plan_permission {
                SiwcStatus::PlanDisabled
            } else {
                SiwcStatus::Connected
            },
            scopes,
            expires_at_ms: self.session.as_ref().map(|s| s.expires_at_ms),
            plan_permission,
        }
    }
}

impl Store {
    pub fn new(root: &Path, profile: &str) -> Result<Self, String> {
        if profile.is_empty() || profile.len() > 512 {
            return Err("siwc_invalid_profile".into());
        }
        let digest = Sha256::digest(profile.as_bytes());
        let component: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        Ok(Self {
            root: root.join("chatgpt-siwc-v1").join(component),
            namespace: format!("com.cognia.siwc/v1/{profile}"),
        })
    }

    pub fn exists(&self) -> Result<bool, String> {
        self.root
            .join("envelope.bin")
            .try_exists()
            .map_err(|_| "siwc_store_unavailable".into())
    }

    pub async fn lock(&self, timeout: Duration) -> Result<File, String> {
        let store = self.clone();
        let file = tokio::task::spawn_blocking(move || store.open_lock())
            .await
            .map_err(|_| "siwc_store_task_failed")??;
        let deadline = Instant::now() + timeout;
        loop {
            match file.try_lock_exclusive() {
                Ok(()) => return Ok(file),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err("siwc_busy".into());
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                Err(_) => return Err("siwc_lock_unavailable".into()),
            }
        }
    }

    fn open_lock(&self) -> Result<File, String> {
        std::fs::create_dir_all(&self.root).map_err(|_| "siwc_store_unavailable")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.root, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "siwc_store_unavailable")?;
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(self.root.join("writer.lock"))
            .map_err(|_| "siwc_store_unavailable")?;
        Ok(file)
    }

    /// The blocking closure owns the OS lock through every disk/crypto step.
    /// Returning it allows refresh to retain single-writer ownership over I/O.
    pub async fn run_locked<T, F>(&self, file: File, operation: F) -> Result<(File, T), String>
    where
        T: Send + 'static,
        F: FnOnce(&Store) -> Result<T, String> + Send + 'static,
    {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let value = operation(&store)?;
            Ok((file, value))
        })
        .await
        .map_err(|_| "siwc_store_task_failed")?
    }

    pub async fn snapshot(&self) -> Result<Option<Envelope>, String> {
        let store = self.clone();
        if !tokio::task::spawn_blocking(move || store.exists())
            .await
            .map_err(|_| "siwc_store_task_failed")??
        {
            return Ok(None);
        }
        let file = self.lock(Duration::from_secs(30)).await?;
        Ok(self.run_locked(file, |store| store.load()).await?.1)
    }

    pub async fn persist_locked(
        &self,
        file: File,
        envelope: Envelope,
    ) -> Result<(File, Envelope), String> {
        self.run_locked(file, move |store| {
            store.save(&envelope)?;
            Ok(envelope)
        })
        .await
    }

    pub fn load(&self) -> Result<Option<Envelope>, String> {
        let path = self.root.join("envelope.bin");
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("siwc_store_unavailable".into()),
        };
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("siwc_store_invalid".into());
        }
        let plain = cognia_secrets::secret_store::open_namespace(&self.namespace, &bytes)
            .map_err(|_| "siwc_store_locked")?;
        // Inspect version before deserializing any fields. Future versions are
        // never rewritten by a binary that cannot preserve their semantics.
        let value: Value = serde_json::from_slice(&plain).map_err(|_| "siwc_store_invalid")?;
        if value.get("version").and_then(Value::as_u64) != Some(1) {
            return Err("siwc_upgrade_required".into());
        }
        serde_json::from_value(value)
            .map(Some)
            .map_err(|_| "siwc_store_invalid".into())
    }

    pub fn save(&self, envelope: &Envelope) -> Result<(), String> {
        if envelope.version != 1 {
            return Err("siwc_upgrade_required".into());
        }
        let plain = serde_json::to_vec(envelope).map_err(|_| "siwc_store_invalid")?;
        let sealed = cognia_secrets::secret_store::seal_namespace(&self.namespace, &plain)
            .map_err(|_| "siwc_store_locked")?;
        let mut temp =
            tempfile::NamedTempFile::new_in(&self.root).map_err(|_| "siwc_store_unavailable")?;
        temp.write_all(&sealed)
            .and_then(|_| temp.as_file().sync_all())
            .map_err(|_| "siwc_store_unavailable")?;
        temp.persist(self.root.join("envelope.bin"))
            .map_err(|_| "siwc_store_unavailable")?;
        #[cfg(unix)]
        File::open(&self.root)
            .and_then(|file| file.sync_all())
            .map_err(|_| "siwc_store_unavailable")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn blocking_transaction_does_not_starve_async_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path(), "blocking").unwrap();
        let file = store.lock(Duration::from_secs(1)).await.unwrap();
        let timer_done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = timer_done.clone();
        let transaction = store.run_locked(file, move |_| {
            std::thread::sleep(Duration::from_millis(100));
            assert!(observed.load(std::sync::atomic::Ordering::Acquire));
            Ok(())
        });
        let timer = async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            timer_done.store(true, std::sync::atomic::Ordering::Release);
        };
        let (result, _) = tokio::join!(transaction, timer);
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn independent_instances_contend_and_reload() {
        let dir = tempfile::tempdir().unwrap();
        let first = Store::new(dir.path(), "profile").unwrap();
        let second = first.clone();
        let guard = first.lock(Duration::from_secs(1)).await.unwrap();
        assert_eq!(
            second.lock(Duration::from_millis(30)).await.unwrap_err(),
            "siwc_busy"
        );
        first
            .save(&Envelope {
                version: 1,
                host_id: "host".into(),
                ..Default::default()
            })
            .unwrap();
        drop(guard);
        let _guard = second.lock(Duration::from_secs(1)).await.unwrap();
        assert_eq!(second.load().unwrap().unwrap().host_id, "host");
        assert!(!std::fs::read(first.root.join("envelope.bin"))
            .unwrap()
            .windows(4)
            .any(|s| s == b"host"));
    }

    #[test]
    fn lock_child_process_probe() {
        let Ok(path) = std::env::var("COGNIA_SIWC_LOCK_TEST_PATH") else {
            return;
        };
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        if std::env::var("COGNIA_SIWC_LOCK_TEST_MODE").as_deref() == Ok("exit-owner") {
            file.try_lock_exclusive().unwrap();
            // Bypass Rust destructors, as on abrupt process termination.
            std::process::exit(17);
        }
        assert_eq!(
            file.try_lock_exclusive().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[tokio::test]
    async fn os_lock_excludes_an_actual_child_process_and_releases() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path(), "child-process").unwrap();
        let guard = store.lock(Duration::from_secs(1)).await.unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "siwc::store::tests::lock_child_process_probe"])
            .env("COGNIA_SIWC_LOCK_TEST_PATH", store.root.join("writer.lock"))
            .status()
            .unwrap();
        assert!(status.success());
        drop(guard);
        assert!(store.lock(Duration::from_secs(1)).await.is_ok());
    }

    #[tokio::test]
    async fn process_death_releases_writer_ownership() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path(), "process-death").unwrap();
        drop(store.lock(Duration::from_secs(1)).await.unwrap());
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "siwc::store::tests::lock_child_process_probe"])
            .env("COGNIA_SIWC_LOCK_TEST_PATH", store.root.join("writer.lock"))
            .env("COGNIA_SIWC_LOCK_TEST_MODE", "exit-owner")
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(17));
        assert!(store.lock(Duration::from_secs(1)).await.is_ok());
    }

    #[tokio::test]
    async fn future_versions_are_never_rewritten_and_extensions_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path(), "version").unwrap();
        let _lock = store.lock(Duration::from_secs(1)).await.unwrap();
        let future = cognia_secrets::secret_store::seal_namespace(
            &store.namespace,
            br#"{"version":2,"newSecretShape":"unknown"}"#,
        )
        .unwrap();
        std::fs::write(store.root.join("envelope.bin"), &future).unwrap();
        assert_eq!(store.load().err().as_deref(), Some("siwc_upgrade_required"));
        assert_eq!(
            std::fs::read(store.root.join("envelope.bin")).unwrap(),
            future
        );
        let mut current = Envelope {
            version: 1,
            ..Default::default()
        };
        current
            .extensions
            .insert("futureField".into(), serde_json::json!({"nested":[1,2]}));
        store.save(&current).unwrap();
        let mut reloaded = store.load().unwrap().unwrap();
        reloaded.host_id = "changed".into();
        store.save(&reloaded).unwrap();
        assert_eq!(
            store.load().unwrap().unwrap().extensions,
            current.extensions
        );
    }

    #[test]
    fn profile_namespaces_cannot_read_each_others_ciphertext() {
        let dir = tempfile::tempdir().unwrap();
        let a = Store::new(dir.path(), "a").unwrap();
        let b = Store::new(dir.path(), "b").unwrap();
        std::fs::create_dir_all(&a.root).unwrap();
        std::fs::create_dir_all(&b.root).unwrap();
        a.save(&Envelope {
            version: 1,
            ..Default::default()
        })
        .unwrap();
        std::fs::copy(a.root.join("envelope.bin"), b.root.join("envelope.bin")).unwrap();
        assert!(b.load().is_err());
    }
}
