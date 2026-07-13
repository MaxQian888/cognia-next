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
//! Crypto recipe mirrors `connectors::attachments` (app-side): `Aes256Gcm`, a
//! random 12-byte nonce prepended to the ciphertext, master key auto-generated
//! with `OsRng` on first use. Atomic disk writes reuse [`cognia_core::fs_atomic`].
//!
//! ## Legacy migration
//!
//! On a `get` miss the store falls back to reading the legacy per-subsystem
//! Keychain item directly. If found it is copied into the encrypted store and
//! the legacy item is deleted, so each pre-existing secret prompts at most
//! once ever (the one-time migration), then never again. Absent legacy items
//! return `errSecItemNotFound` with no prompt, so a fresh install only ever
//! sees the master-key prompt.

//! ## Headless mode (ADR-0059 R9)
//!
//! Containers have no OS keyring, and the old fallback silently generated a
//! fresh in-memory key on every keyring failure — which would invalidate the
//! companion signing secret (all JWTs) and drop every stored credential on
//! each restart. Headless installs therefore run [`init_headless`] **before
//! any secret access**: the master key comes from `COGNIA_MASTER_KEY`
//! (64 hex chars) or `COGNIA_MASTER_KEY_FILE`, boot is **fatal** without one,
//! the keyring source and legacy migration are disabled, and the store file
//! lives under the server's own data dir with `0600` perms (unix).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use parking_lot::RwLock;
use rand::RngCore;

/// Keyring service holding the single master key. (Only the production global
/// touches the keyring; the test global is in-memory.)
#[cfg(not(any(test, feature = "test-inmemory")))]
const MASTER_KEY_SERVICE: &str = "com.cognia.secret-store";
/// Keyring account holding the single master key.
#[cfg(not(any(test, feature = "test-inmemory")))]
const MASTER_KEY_ACCOUNT: &str = "master-key";
/// File name under `<dataDir>/cognia/` for the encrypted blob.
const STORE_FILE_NAME: &str = "secret-store.enc";

/// Env var carrying the 64-hex master key directly (headless installs).
pub const MASTER_KEY_ENV: &str = "COGNIA_MASTER_KEY";
/// Env var naming a file whose contents are the 64-hex master key (for
/// Docker/K8s secret mounts).
pub const MASTER_KEY_FILE_ENV: &str = "COGNIA_MASTER_KEY_FILE";
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
/// `cfg(test)` / `test-inmemory`-feature process global so unit tests never
/// touch disk or the OS keyring).
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
            std::fs::create_dir_all(parent).map_err(|e| format!("create secret-store dir: {e}"))?;
        }
        let plaintext =
            serde_json::to_vec(&self.cache).map_err(|e| format!("serialize secret-store: {e}"))?;
        let ciphertext = encrypt(&self.key, &plaintext)?;
        let plan = cognia_core::fs_atomic::AtomicWritePlan {
            path: path.clone(),
            expected_mtime: None,
            tmp_suffix: "tmp".into(),
            backup_suffix: "bak".into(),
        };
        cognia_core::fs_atomic::atomic_write_with_mtime_check(&plan, &ciphertext)
            .map_err(|e| format!("persist secret-store: {e}"))?;
        // One encrypted backup is plenty for recovery; prune the rest.
        cognia_core::fs_atomic::rotate_backups(path, 1);
        // Ciphertext or not, the blob guards every credential — keep it
        // owner-only where the platform can express that.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(path) {
                let mut perms = meta.permissions();
                perms.set_mode(0o600);
                let _ = std::fs::set_permissions(path, perms);
            }
        }
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
#[cfg(not(any(test, feature = "test-inmemory")))]
fn build_global() -> SecretStore {
    let key = match load_or_create_master_key() {
        Ok(key) => key,
        Err(e) => {
            log::error!(
                "secret-store master key unavailable ({e}); running in-memory this session"
            );
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
#[cfg(any(test, feature = "test-inmemory"))]
fn build_global() -> SecretStore {
    SecretStore::in_memory([7u8; 32])
}

#[cfg(not(any(test, feature = "test-inmemory")))]
fn default_store_path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("cognia").join(STORE_FILE_NAME))
}

/// Resolve the master key. Precedence (ADR-0059 R9):
///
/// 1. `COGNIA_MASTER_KEY` — 64 hex chars in the environment.
/// 2. `COGNIA_MASTER_KEY_FILE` — a file containing the 64 hex chars.
/// 3. The OS keyring, generating + storing one on first use (the single
///    runtime keyring touch; desktop path).
#[cfg(not(any(test, feature = "test-inmemory")))]
fn load_or_create_master_key() -> Result<[u8; 32], String> {
    if let Some(key) = resolve_master_key_from_env()? {
        return Ok(key);
    }
    let entry = keyring::Entry::new(MASTER_KEY_SERVICE, MASTER_KEY_ACCOUNT)
        .map_err(|e| format!("master key keyring init: {e}"))?;
    match entry.get_password() {
        Ok(hex_key) => parse_hex_key(&hex_key),
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

/// Parse a 64-hex-char master key.
fn parse_hex_key(raw: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(raw.trim()).map_err(|e| format!("master key decode: {e}"))?;
    bytes
        .try_into()
        .map_err(|_| "master key must be exactly 32 bytes (64 hex chars)".to_string())
}

/// Resolve the master key from the environment only (`COGNIA_MASTER_KEY` →
/// `COGNIA_MASTER_KEY_FILE`). `Ok(None)` when neither is set.
pub fn resolve_master_key_from_env() -> Result<Option<[u8; 32]>, String> {
    if let Ok(raw) = std::env::var(MASTER_KEY_ENV) {
        if !raw.trim().is_empty() {
            return parse_hex_key(&raw).map(Some);
        }
    }
    if let Ok(path) = std::env::var(MASTER_KEY_FILE_ENV) {
        if !path.trim().is_empty() {
            let raw = std::fs::read_to_string(&path)
                .map_err(|e| format!("read {MASTER_KEY_FILE_ENV} ({path}): {e}"))?;
            return parse_hex_key(&raw).map(Some);
        }
    }
    Ok(None)
}

// ---------------------------------------------------------------------------
// Headless init + rotation (ADR-0059 R9)
// ---------------------------------------------------------------------------

/// Set once by [`init_headless`]; disables the legacy keyring migration
/// (containers have no keyring — a migration attempt would error or hang).
static HEADLESS_MODE: AtomicBool = AtomicBool::new(false);

/// The store file path for a headless data dir.
fn headless_store_path(data_dir: &Path) -> PathBuf {
    data_dir.join("cognia").join(STORE_FILE_NAME)
}

/// Build the headless store: env-resolved key (fatal if absent — the silent
/// in-memory regeneration that invalidated JWTs and dropped credentials on
/// every container restart is exactly the bug this replaces), file under the
/// server's data dir. Split from [`init_headless`] so the container path is
/// unit-testable without touching the process global.
fn build_headless_store(data_dir: &Path) -> Result<SecretStore, String> {
    let key = resolve_master_key_from_env()?.ok_or_else(|| {
        format!(
            "no master key configured: set {MASTER_KEY_ENV} (64 hex chars, e.g. `openssl rand -hex 32`) \
             or {MASTER_KEY_FILE_ENV}; refusing to boot with an ephemeral key"
        )
    })?;
    SecretStore::open(headless_store_path(data_dir), key)
}

/// Strict headless initialization. MUST run before any other secret access
/// (the companion signing key, push creds, vault, connector creds all funnel
/// through this store). Errors are fatal boot errors by design.
pub fn init_headless(data_dir: &Path) -> Result<(), String> {
    let store = build_headless_store(data_dir)?;
    // Ensure perms even when nothing has been persisted yet this boot.
    let _ = &store;
    HEADLESS_MODE.store(true, Ordering::SeqCst);
    GLOBAL
        .set(RwLock::new(store))
        .map_err(|_| "secret store already initialized; init_headless must run first".to_string())
}

/// Whether headless mode disabled the legacy keyring paths.
fn legacy_enabled() -> bool {
    !HEADLESS_MODE.load(Ordering::SeqCst)
}

/// Re-encrypt the store under a new master key (ADR-0059 R9). The old key is
/// validated by decrypting the existing file; values — including the
/// companion JWT signing secret — are unchanged, so issued device JWTs
/// survive the rotation. The caller is responsible for updating
/// `COGNIA_MASTER_KEY`(_FILE) before the next boot.
pub fn rotate_master_key(
    data_dir: &Path,
    old_key: [u8; 32],
    new_key: [u8; 32],
) -> Result<(), String> {
    let path = headless_store_path(data_dir);
    if !path.exists() {
        return Err(format!(
            "no secret store at {} — nothing to rotate",
            path.display()
        ));
    }
    let mut store = SecretStore::open(path, old_key)?;
    store.key = new_key;
    store.persist()
}

/// Parse a user-supplied 64-hex key (rotate-master-key CLI). Public thin
/// wrapper over the internal parser.
pub fn parse_master_key(raw: &str) -> Result<[u8; 32], String> {
    parse_hex_key(raw)
}

/// Generate a fresh random master key (rotate-master-key CLI `--generate`).
pub fn generate_master_key() -> [u8; 32] {
    random_key()
}

// ---------------------------------------------------------------------------
// Legacy per-subsystem keyring fallback (production) / stub (tests)
// ---------------------------------------------------------------------------

#[cfg(not(any(test, feature = "test-inmemory")))]
fn legacy_keyring_get(service: &str, account: &str) -> Result<Option<String>, String> {
    let entry =
        keyring::Entry::new(service, account).map_err(|e| format!("legacy keyring init: {e}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("legacy keyring read: {e}")),
    }
}

#[cfg(not(any(test, feature = "test-inmemory")))]
fn legacy_keyring_delete(service: &str, account: &str) {
    if let Ok(entry) = keyring::Entry::new(service, account) {
        let _ = entry.delete_credential();
    }
}

#[cfg(any(test, feature = "test-inmemory"))]
fn legacy_keyring_get(_service: &str, _account: &str) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(any(test, feature = "test-inmemory"))]
fn legacy_keyring_delete(_service: &str, _account: &str) {}

// ---------------------------------------------------------------------------
// Public API — drop-in for the old per-subsystem keyring helpers
// ---------------------------------------------------------------------------

/// Read a secret. Returns `Ok(None)` when nothing is stored under
/// `(service, account)`. On a store miss, the legacy OS-keyring item (if any)
/// is migrated in and then removed — desktop only; headless installs have no
/// keyring and skip migration entirely.
pub fn get(service: &str, account: &str) -> Result<Option<String>, String> {
    // Fast path: read lock, no migration.
    if let Some(value) = global().read().peek(service, account) {
        return Ok(Some(value));
    }
    if !legacy_enabled() {
        return Ok(None);
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
    if legacy_enabled() {
        legacy_keyring_delete(service, account);
    }
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

    // ---- headless mode (ADR-0059 R9) ----

    /// Container-path simulation: master key from env, no keyring, values
    /// survive a "restart" (drop + reopen with the same env key). All env
    /// manipulation lives in this single test to avoid parallel-test races
    /// on the process environment.
    #[test]
    fn headless_container_path_env_key_and_restart_survival() {
        let dir = tmp_path().parent().unwrap().to_path_buf();
        let key_hex = hex::encode([42u8; 32]);

        let prev_key = std::env::var(MASTER_KEY_ENV).ok();
        let prev_file = std::env::var(MASTER_KEY_FILE_ENV).ok();

        // 1. No key anywhere → fatal, with an actionable message.
        std::env::remove_var(MASTER_KEY_ENV);
        std::env::remove_var(MASTER_KEY_FILE_ENV);
        let err = match build_headless_store(&dir) {
            Ok(_) => panic!("no key must be fatal"),
            Err(e) => e,
        };
        assert!(
            err.contains(MASTER_KEY_ENV),
            "message names the env var: {err}"
        );
        assert!(
            err.contains("refusing to boot"),
            "message is explicit: {err}"
        );

        // 2. Malformed key → fatal.
        std::env::set_var(MASTER_KEY_ENV, "not-hex-at-all");
        assert!(build_headless_store(&dir).is_err());

        // 3. Valid env key → store opens; writes persist.
        std::env::set_var(MASTER_KEY_ENV, &key_hex);
        {
            let mut store = build_headless_store(&dir).expect("env key opens the store");
            store
                .set("com.cognia.companion", "signing-key", "sekrit-1")
                .expect("set persists");
        }

        // 4. "Restart": a fresh open with the same env key sees the value —
        //    the silent-regeneration bug would have lost it.
        {
            let store = build_headless_store(&dir).expect("reopen with same key");
            assert_eq!(
                store.peek("com.cognia.companion", "signing-key"),
                Some("sekrit-1".to_string())
            );
        }

        // 5. Key-file source: same key via COGNIA_MASTER_KEY_FILE.
        std::env::remove_var(MASTER_KEY_ENV);
        let key_file = dir.join("master.key");
        std::fs::write(&key_file, format!("{key_hex}\n")).unwrap();
        std::env::set_var(MASTER_KEY_FILE_ENV, key_file.display().to_string());
        {
            let store = build_headless_store(&dir).expect("key file opens the store");
            assert_eq!(
                store.peek("com.cognia.companion", "signing-key"),
                Some("sekrit-1".to_string())
            );
        }

        // 6. Rotation: re-encrypt under a new key; values (and thus JWTs
        //    signed by the stored signing secret) survive; old key now fails.
        let old_key = [42u8; 32];
        let new_key = [43u8; 32];
        rotate_master_key(&dir, old_key, new_key).expect("rotate");
        let reopened = SecretStore::open(headless_store_path(&dir), new_key).expect("new key");
        assert_eq!(
            reopened.peek("com.cognia.companion", "signing-key"),
            Some("sekrit-1".to_string())
        );
        assert!(
            SecretStore::open(headless_store_path(&dir), old_key).is_err(),
            "old key must no longer decrypt"
        );

        // 7. Rotating a non-existent store errors loudly.
        let empty_dir = tmp_path().parent().unwrap().join("no-store-here");
        assert!(rotate_master_key(&empty_dir, old_key, new_key).is_err());

        // Restore the environment for other tests.
        match prev_key {
            Some(v) => std::env::set_var(MASTER_KEY_ENV, v),
            None => std::env::remove_var(MASTER_KEY_ENV),
        }
        match prev_file {
            Some(v) => std::env::set_var(MASTER_KEY_FILE_ENV, v),
            None => std::env::remove_var(MASTER_KEY_FILE_ENV),
        }
    }

    #[test]
    fn parse_master_key_validates_length_and_hex() {
        assert!(parse_master_key("zz").is_err());
        assert!(
            parse_master_key(&hex::encode([1u8; 16])).is_err(),
            "16 bytes rejected"
        );
        let key = parse_master_key(&hex::encode([9u8; 32])).expect("valid");
        assert_eq!(key, [9u8; 32]);
        // Whitespace tolerated (key files often end with a newline).
        assert_eq!(
            parse_master_key(&format!("  {}\n", hex::encode([9u8; 32]))).unwrap(),
            [9u8; 32]
        );
    }

    #[test]
    fn generate_master_key_is_32_random_bytes() {
        let a = generate_master_key();
        let b = generate_master_key();
        assert_ne!(a, b);
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
