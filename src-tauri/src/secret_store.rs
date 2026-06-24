//! Single-keychain secret store.
//!
//! Historically every subsystem (`subscription`, `gateway`, `remote_control`,
//! `tts`, `connectors`, `mcp_oauth`, `companion_api`, …) stored its secrets as
//! its own OS-keyring item with a distinct `(service, account)` pair. On macOS
//! that meant a cold launch touched ~10 distinct Keychain items, and an
//! ad-hoc-signed (dev) binary gets a separate password prompt for **each**
//! item whose ACL doesn't trust the current signature. The result: the user
//! types their Keychain password many times per launch.
//!
//! This module collapses all of that behind a single Keychain item — a 32-byte
//! **master key** (service `com.cognia.secret-store`, account `master-key`).
//! Every other secret lives encrypted-at-rest in one file
//! (`<dataDir>/cognia/secret-store.enc`, AES-256-GCM) keyed by the *same*
//! `(service, account)` strings the subsystems already use. Only the master
//! key touches the OS keyring at runtime, so a launch prompts **once** (and
//! zero times once code signing is stable).
//!
//! Crypto recipe mirrors [`crate::connectors::attachments`]: `Aes256Gcm`, a
//! random 12-byte nonce prepended to the ciphertext, master key auto-generated
//! with `OsRng` on first use. Atomic disk writes reuse [`crate::fs_atomic`].
//!
//! ## Legacy migration
//!
//! On a `get` miss the store falls back to reading the legacy per-subsystem
//! Keychain item directly. If found it is copied into the encrypted store and
//! the legacy item is deleted, so each pre-existing secret prompts at most
//! once ever (the one-time migration), then never again. Absent legacy items
//! return `errSecItemNotFound` with no prompt, so a fresh install only ever
//! sees the master-key prompt.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::OnceLock;

use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use parking_lot::RwLock;
use rand::RngCore;

/// Keyring service holding the single master key. (Only the production global
/// touches the keyring; the test global is in-memory.)
#[cfg(not(test))]
const MASTER_KEY_SERVICE: &str = "com.cognia.secret-store";
/// Keyring account holding the single master key.
#[cfg(not(test))]
const MASTER_KEY_ACCOUNT: &str = "master-key";
/// File name under `<dataDir>/cognia/` for the encrypted blob.
#[cfg(not(test))]
const STORE_FILE_NAME: &str = "secret-store.enc";
/// NUL separator joining `(service, account)` into one map key. NUL can never
/// appear in a service/account string, so the composite key is unambiguous.
const COMPOSITE_SEP: char = '\u{0}';

/// Compose a stable map key from a `(service, account)` pair.
fn composite(service: &str, account: &str) -> String {
    format!("{service}{COMPOSITE_SEP}{account}")
}

// ---------------------------------------------------------------------------
// Crypto (mirrors connectors::attachments)
// ---------------------------------------------------------------------------

fn random_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    key
}

fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("secret-store encrypt failed: {e}"))?;
    // Prepend the nonce so decrypt can reconstruct it.
    let mut out = nonce_bytes.to_vec();
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn decrypt(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 12 {
        return Err("secret-store blob too short".to_string());
    }
    let (nonce_bytes, ciphertext) = data.split_at(12);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("secret-store decrypt failed: {e}"))
}

// ---------------------------------------------------------------------------
// SecretStore — the in-memory cache + (optional) encrypted file backing it
// ---------------------------------------------------------------------------

/// One encrypted secret store. When `path` is `Some`, mutations are persisted
/// to that file; when `None` the store is purely in-memory (used by the
/// `#[cfg(test)]` process global so unit tests never touch disk or the OS
/// keyring).
struct SecretStore {
    path: Option<PathBuf>,
    key: [u8; 32],
    cache: BTreeMap<String, String>,
}

impl SecretStore {
    /// Open (or initialize) a file-backed store. An existing file is decrypted
    /// and parsed; a missing file yields an empty store. A present-but-corrupt
    /// or wrong-key file surfaces as `Err` so we never silently wipe secrets.
    fn open(path: PathBuf, key: [u8; 32]) -> Result<Self, String> {
        let cache = if path.exists() {
            let data = std::fs::read(&path).map_err(|e| format!("read secret-store: {e}"))?;
            if data.is_empty() {
                BTreeMap::new()
            } else {
                let plaintext = decrypt(&key, &data)?;
                serde_json::from_slice(&plaintext)
                    .map_err(|e| format!("parse secret-store: {e}"))?
            }
        } else {
            BTreeMap::new()
        };
        Ok(Self {
            path: Some(path),
            key,
            cache,
        })
    }

    /// A purely in-memory store with no disk or keyring side effects.
    fn in_memory(key: [u8; 32]) -> Self {
        Self {
            path: None,
            key,
            cache: BTreeMap::new(),
        }
    }

    /// Read a value straight from the in-memory cache (no migration).
    fn peek(&self, service: &str, account: &str) -> Option<String> {
        self.cache.get(&composite(service, account)).cloned()
    }

    /// Read with one-time legacy fallback: on a cache miss, consult `legacy`
    /// (the OS keyring in production). A hit is copied into the store and
    /// persisted so subsequent reads stay in-memory.
    fn get_or_migrate(
        &mut self,
        service: &str,
        account: &str,
        legacy: impl Fn(&str, &str) -> Result<Option<String>, String>,
    ) -> Result<MigrationOutcome, String> {
        if let Some(value) = self.peek(service, account) {
            return Ok(MigrationOutcome::Cached(value));
        }
        match legacy(service, account)? {
            Some(value) => {
                self.set(service, account, &value)?;
                Ok(MigrationOutcome::Migrated(value))
            }
            None => Ok(MigrationOutcome::Missing),
        }
    }

    /// Upsert a value and persist. Empty values are allowed (parity with the
    /// raw keyring `set_password`); subsystems keep their own validation.
    fn set(&mut self, service: &str, account: &str, value: &str) -> Result<(), String> {
        self.cache
            .insert(composite(service, account), value.to_string());
        self.persist()
    }

    /// Remove a value. Idempotent — a missing key is a no-op (and skips the
    /// disk write).
    fn delete(&mut self, service: &str, account: &str) -> Result<(), String> {
        if self.cache.remove(&composite(service, account)).is_some() {
            self.persist()?;
        }
        Ok(())
    }

    /// Encrypt the whole cache and atomically publish it. No-op for in-memory
    /// stores.
    fn persist(&self) -> Result<(), String> {
        let Some(path) = self.path.as_ref() else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create secret-store dir: {e}"))?;
        }
        let plaintext =
            serde_json::to_vec(&self.cache).map_err(|e| format!("serialize secret-store: {e}"))?;
        let ciphertext = encrypt(&self.key, &plaintext)?;
        let plan = crate::fs_atomic::AtomicWritePlan {
            path: path.clone(),
            expected_mtime: None,
            tmp_suffix: "tmp".into(),
            backup_suffix: "bak".into(),
        };
        crate::fs_atomic::atomic_write_with_mtime_check(&plan, &ciphertext)
            .map_err(|e| format!("persist secret-store: {e}"))?;
        // One encrypted backup is plenty for recovery; prune the rest.
        crate::fs_atomic::rotate_backups(path, 1);
        Ok(())
    }
}

/// Result of [`SecretStore::get_or_migrate`], distinguishing an in-cache hit
/// from a freshly migrated legacy item so the caller knows whether to clear
/// the legacy keyring entry.
#[derive(Debug)]
enum MigrationOutcome {
    Cached(String),
    Migrated(String),
    Missing,
}

// ---------------------------------------------------------------------------
// Process-global instance
// ---------------------------------------------------------------------------

static GLOBAL: OnceLock<RwLock<SecretStore>> = OnceLock::new();

fn global() -> &'static RwLock<SecretStore> {
    GLOBAL.get_or_init(|| RwLock::new(build_global()))
}

/// Production global: file-backed, master key from the OS keyring. Any failure
/// resolving the key or opening the file degrades to an empty **in-memory**
/// store (path `None`) — that keeps the app running and, crucially, never
/// overwrites a good on-disk store with data encrypted under a fallback key.
#[cfg(not(test))]
fn build_global() -> SecretStore {
    let key = match load_or_create_master_key() {
        Ok(key) => key,
        Err(e) => {
            log::error!("secret-store master key unavailable ({e}); running in-memory this session");
            return SecretStore::in_memory(random_key());
        }
    };
    match default_store_path() {
        Some(path) => SecretStore::open(path, key).unwrap_or_else(|e| {
            log::error!("secret-store open failed ({e}); running in-memory this session");
            SecretStore::in_memory(key)
        }),
        None => {
            log::error!("secret-store data dir unavailable; running in-memory this session");
            SecretStore::in_memory(key)
        }
    }
}

/// Test global: in-memory, fixed key, no disk or keyring. Every rerouted
/// module's tests run against this so the suite stays hermetic.
#[cfg(test)]
fn build_global() -> SecretStore {
    SecretStore::in_memory([7u8; 32])
}

#[cfg(not(test))]
fn default_store_path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("cognia").join(STORE_FILE_NAME))
}

/// Resolve the master key from the OS keyring, generating + storing one on
/// first use. This is the single runtime keyring touch.
#[cfg(not(test))]
fn load_or_create_master_key() -> Result<[u8; 32], String> {
    let entry = keyring::Entry::new(MASTER_KEY_SERVICE, MASTER_KEY_ACCOUNT)
        .map_err(|e| format!("master key keyring init: {e}"))?;
    match entry.get_password() {
        Ok(hex_key) => {
            let bytes =
                hex::decode(hex_key.trim()).map_err(|e| format!("master key decode: {e}"))?;
            bytes
                .try_into()
                .map_err(|_| "master key must be 32 bytes".to_string())
        }
        Err(keyring::Error::NoEntry) => {
            let key = random_key();
            entry
                .set_password(&hex::encode(key))
                .map_err(|e| format!("master key store: {e}"))?;
            Ok(key)
        }
        Err(e) => Err(format!("master key read: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Legacy per-subsystem keyring fallback (production) / stub (tests)
// ---------------------------------------------------------------------------

#[cfg(not(test))]
fn legacy_keyring_get(service: &str, account: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(service, account)
        .map_err(|e| format!("legacy keyring init: {e}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("legacy keyring read: {e}")),
    }
}

#[cfg(not(test))]
fn legacy_keyring_delete(service: &str, account: &str) {
    if let Ok(entry) = keyring::Entry::new(service, account) {
        let _ = entry.delete_credential();
    }
}

#[cfg(test)]
fn legacy_keyring_get(_service: &str, _account: &str) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(test)]
fn legacy_keyring_delete(_service: &str, _account: &str) {}

// ---------------------------------------------------------------------------
// Public API — drop-in for the old per-subsystem keyring helpers
// ---------------------------------------------------------------------------

/// Read a secret. Returns `Ok(None)` when nothing is stored under
/// `(service, account)`. On a store miss, the legacy OS-keyring item (if any)
/// is migrated in and then removed.
pub fn get(service: &str, account: &str) -> Result<Option<String>, String> {
    // Fast path: read lock, no migration.
    if let Some(value) = global().read().peek(service, account) {
        return Ok(Some(value));
    }
    // Slow path: take the write lock and attempt one-time legacy migration.
    let outcome = global()
        .write()
        .get_or_migrate(service, account, legacy_keyring_get)?;
    match outcome {
        MigrationOutcome::Cached(value) => Ok(Some(value)),
        MigrationOutcome::Migrated(value) => {
            // The value now lives in the encrypted store; drop the legacy item
            // so it can never re-surface or prompt again.
            legacy_keyring_delete(service, account);
            Ok(Some(value))
        }
        MigrationOutcome::Missing => Ok(None),
    }
}

/// Upsert a secret.
pub fn set(service: &str, account: &str, value: &str) -> Result<(), String> {
    global().write().set(service, account, value)
}

/// Remove a secret. Idempotent. Also clears any lingering legacy keyring item
/// so a deleted secret can't be resurrected by a later `get` migration.
pub fn delete(service: &str, account: &str) -> Result<(), String> {
    global().write().delete(service, account)?;
    legacy_keyring_delete(service, account);
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn tmp_path() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "cognia-secret-store-{}-{nanos}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("secret-store.enc")
    }

    // ---- pure helpers ----

    #[test]
    fn composite_is_nul_separated() {
        assert_eq!(composite("svc", "acct"), "svc\u{0}acct");
        // Distinct pairs never collide.
        assert_ne!(composite("a", "bc"), composite("ab", "c"));
    }

    #[test]
    fn encrypt_decrypt_round_trip() {
        let key = [3u8; 32];
        let blob = encrypt(&key, b"hello secret").unwrap();
        // Ciphertext is nonce (12) + GCM output; never the plaintext.
        assert!(blob.len() > 12);
        assert_ne!(&blob[12..], b"hello secret");
        assert_eq!(decrypt(&key, &blob).unwrap(), b"hello secret");
    }

    #[test]
    fn decrypt_rejects_short_blob() {
        assert!(decrypt(&[0u8; 32], b"short").is_err());
    }

    #[test]
    fn decrypt_rejects_wrong_key() {
        let blob = encrypt(&[1u8; 32], b"data").unwrap();
        assert!(decrypt(&[2u8; 32], &blob).is_err());
    }

    #[test]
    fn random_key_is_32_bytes_and_varies() {
        let a = random_key();
        let b = random_key();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b, "two random keys must differ");
    }

    // ---- file-backed SecretStore ----

    #[test]
    fn open_missing_file_is_empty() {
        let store = SecretStore::open(tmp_path(), [1u8; 32]).unwrap();
        assert!(store.peek("svc", "acct").is_none());
    }

    #[test]
    fn set_get_delete_persists_across_reopen() {
        let path = tmp_path();
        let key = [9u8; 32];
        {
            let mut s = SecretStore::open(path.clone(), key).unwrap();
            s.set("com.cognia.gateway", "bearer-token", "tok-123")
                .unwrap();
            assert_eq!(
                s.peek("com.cognia.gateway", "bearer-token"),
                Some("tok-123".to_string())
            );
        }
        // Reopen with the same key — value survives the round-trip to disk.
        {
            let mut s = SecretStore::open(path.clone(), key).unwrap();
            assert_eq!(
                s.peek("com.cognia.gateway", "bearer-token"),
                Some("tok-123".to_string())
            );
            s.delete("com.cognia.gateway", "bearer-token").unwrap();
            assert!(s.peek("com.cognia.gateway", "bearer-token").is_none());
        }
        // Deletion is durable too.
        let s = SecretStore::open(path, key).unwrap();
        assert!(s.peek("com.cognia.gateway", "bearer-token").is_none());
    }

    #[test]
    fn delete_missing_is_noop() {
        let mut s = SecretStore::open(tmp_path(), [4u8; 32]).unwrap();
        s.delete("svc", "absent").unwrap();
        assert!(s.peek("svc", "absent").is_none());
    }

    #[test]
    fn empty_value_is_storable() {
        let mut s = SecretStore::open(tmp_path(), [5u8; 32]).unwrap();
        s.set("svc", "k", "").unwrap();
        assert_eq!(s.peek("svc", "k"), Some(String::new()));
    }

    #[test]
    fn open_rejects_corrupt_file() {
        let path = tmp_path();
        std::fs::write(&path, b"not a valid encrypted blob at all").unwrap();
        assert!(SecretStore::open(path, [6u8; 32]).is_err());
    }

    #[test]
    fn open_wrong_key_errors_rather_than_wiping() {
        let path = tmp_path();
        {
            let mut s = SecretStore::open(path.clone(), [1u8; 32]).unwrap();
            s.set("svc", "k", "v").unwrap();
        }
        // Opening with the wrong key must error, not silently drop the secret.
        assert!(SecretStore::open(path, [2u8; 32]).is_err());
    }

    // ---- legacy migration ----

    #[test]
    fn get_or_migrate_pulls_from_legacy_then_caches() {
        let mut s = SecretStore::open(tmp_path(), [8u8; 32]).unwrap();
        let outcome = s
            .get_or_migrate("svc", "acct", |svc, acct| {
                assert_eq!((svc, acct), ("svc", "acct"));
                Ok(Some("legacy-value".to_string()))
            })
            .unwrap();
        assert!(matches!(outcome, MigrationOutcome::Migrated(v) if v == "legacy-value"));
        // Now cached — a second call hits the cache, not legacy.
        let outcome = s
            .get_or_migrate("svc", "acct", |_, _| {
                panic!("legacy must not be consulted after migration")
            })
            .unwrap();
        assert!(matches!(outcome, MigrationOutcome::Cached(v) if v == "legacy-value"));
    }

    #[test]
    fn get_or_migrate_missing_when_legacy_empty() {
        let mut s = SecretStore::open(tmp_path(), [8u8; 32]).unwrap();
        let outcome = s.get_or_migrate("svc", "acct", |_, _| Ok(None)).unwrap();
        assert!(matches!(outcome, MigrationOutcome::Missing));
    }

    #[test]
    fn get_or_migrate_propagates_legacy_error() {
        let mut s = SecretStore::open(tmp_path(), [8u8; 32]).unwrap();
        let err = s
            .get_or_migrate("svc", "acct", |_, _| Err("boom".to_string()))
            .unwrap_err();
        assert_eq!(err, "boom");
    }

    // ---- public API against the in-memory global ----

    #[test]
    fn public_api_round_trip() {
        // Unique key so this test never collides with another in the shared
        // process-global.
        let acct = "public-api-round-trip";
        assert_eq!(get("test-secret-store", acct).unwrap(), None);
        set("test-secret-store", acct, "value-1").unwrap();
        assert_eq!(
            get("test-secret-store", acct).unwrap(),
            Some("value-1".to_string())
        );
        set("test-secret-store", acct, "value-2").unwrap();
        assert_eq!(
            get("test-secret-store", acct).unwrap(),
            Some("value-2".to_string())
        );
        delete("test-secret-store", acct).unwrap();
        assert_eq!(get("test-secret-store", acct).unwrap(), None);
        // Deleting again is a no-op.
        delete("test-secret-store", acct).unwrap();
    }
}
