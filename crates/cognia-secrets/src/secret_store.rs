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
//! key is resolved without prompting during startup. If access requires user
//! authorization, an explicit recovery Retry can request it on a worker.
//!
//! ## Readiness
//!
//! Initialization is a small state machine (see "Readiness" below): callers
//! that arrive while another thread resolves the master key wait for it with a
//! bounded budget (never on the UI thread), a failed attempt is cached as a
//! typed `SECRET_STORE_LOCKED` error until [`retry_failed_initialization`], and
//! only success is cached permanently.
//!
//! Crypto recipe mirrors `connectors::attachments` (app-side): `Aes256Gcm`, a
//! random 12-byte nonce prepended to the ciphertext, master key auto-generated
//! with `OsRng` on first use. Atomic disk writes reuse [`cognia_core::fs_atomic`].
//!
//! ## Legacy migration
//!
//! On a `get` miss the store checks the legacy per-subsystem Keychain without
//! allowing a system dialog. Accessible credentials are durably copied before
//! legacy cleanup. Missing or denied reads are remembered for this process;
//! access denial is an error, never a missing credential to regenerate.

//! ## Development builds
//!
//! A debug build keeps its master key in a plain `0600` file under
//! `<dataDir>/cognia/dev/` and its encrypted blob beside it, and never touches
//! the Keychain, the legacy per-item migration included. Every `pnpm tauri dev`
//! rebuild re-signs the binary, and a Keychain item's access list does not
//! follow it: the passive master-key read then failed with `errSecAuthFailed`
//! on each launch, locking every credential (and the device unlock of the
//! local profile) behind a prompt the developer could not reach. The dev store
//! is deliberately separate from the release one, so a dev build can neither
//! read nor clobber a shipped install's credentials. `COGNIA_DEV_KEYCHAIN=1`
//! sends a debug build back to the Keychain path; a configured
//! `COGNIA_MASTER_KEY`(`_FILE`) keeps its existing meaning and store path.

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
use std::time::{Duration, Instant};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use parking_lot::{Condvar, Mutex, RwLock};

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
/// Env var that sends a debug build back to the OS keychain (`1`/`true`).
pub const DEV_KEYCHAIN_ENV: &str = "COGNIA_DEV_KEYCHAIN";
/// Directory under `<dataDir>/cognia/` holding a debug build's key and store.
const DEV_DIR_NAME: &str = "dev";
/// File name of a debug build's master key inside [`DEV_DIR_NAME`].
const DEV_MASTER_KEY_FILE_NAME: &str = "master-key";
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
    rand::fill(&mut key);
    key
}

fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let key = Key::<Aes256Gcm>::from(*key);
    let cipher = Aes256Gcm::new(&key);
    let mut nonce_bytes = [0u8; 12];
    rand::fill(&mut nonce_bytes);
    let nonce = Nonce::from(nonce_bytes);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
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
    let key = Key::<Aes256Gcm>::from(*key);
    let cipher = Aes256Gcm::new(&key);
    let nonce = Nonce::try_from(nonce_bytes)
        .map_err(|_| "secret-store nonce has invalid length".to_string())?;
    cipher
        .decrypt(&nonce, ciphertext)
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
    legacy_reads: BTreeMap<String, Result<Option<String>, String>>,
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
            legacy_reads: BTreeMap::new(),
        })
    }

    /// A purely in-memory store with no disk or keyring side effects.
    #[cfg(any(test, feature = "test-inmemory"))]
    fn in_memory(key: [u8; 32]) -> Self {
        Self {
            path: None,
            key,
            cache: BTreeMap::new(),
            legacy_reads: BTreeMap::new(),
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
        let key = composite(service, account);
        let result = self
            .legacy_reads
            .entry(key)
            .or_insert_with(|| legacy(service, account))
            .clone();
        match result? {
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
        let key = composite(service, account);
        let previous = self.cache.insert(key.clone(), value.to_string());
        if let Err(error) = self.persist() {
            match previous {
                Some(value) => {
                    self.cache.insert(key, value);
                }
                None => {
                    self.cache.remove(&key);
                }
            }
            return Err(error);
        }
        self.legacy_reads.remove(&key);
        Ok(())
    }

    /// Forget cached legacy reads that FAILED, so the next `get` asks the
    /// Keychain again. Misses stay cached. Only an explicit recovery calls
    /// this: a failed passive read (a keychain locked at launch) is otherwise
    /// remembered for the whole process.
    fn forget_failed_legacy_reads(&mut self) {
        self.legacy_reads.retain(|_, read| read.is_ok());
    }

    /// Remove a value. Idempotent — a missing key is a no-op (and skips the
    /// disk write).
    fn delete(&mut self, service: &str, account: &str) -> Result<(), String> {
        let key = composite(service, account);
        if let Some(previous) = self.cache.remove(&key) {
            if let Err(error) = self.persist() {
                self.cache.insert(key, previous);
                return Err(error);
            }
        }
        self.legacy_reads.insert(key, Ok(None));
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
// Readiness — the process-global initialization state machine
// ---------------------------------------------------------------------------
//
// Uninitialized ──first access──▶ Initializing ──ok──▶ Ready   (terminal)
//                                      │
//                                      └──err──▶ Failed ──explicit retry──▶ Initializing
//
// * **Initializing is transient.** A caller that arrives while another thread
//   is resolving the master key waits (bounded) for the outcome instead of
//   failing — except on the UI thread, which never blocks behind the OS.
// * **Failed is terminal until an explicit retry.** Passive callers get the
//   cached, typed failure immediately; they never re-run the Keychain read, so
//   one locked Keychain produces one native attempt instead of one per caller.
// * **Ready is terminal.** Only success is cached.
//
// Every failure a caller sees carries a stable code prefix
// ([`INITIALIZING_CODE`] / [`LOCKED_CODE`]) so wrappers that format the error
// into their own message stay classifiable across IPC.

/// Stable error code: initialization is still in flight after the caller's
/// wait budget. Transient — the same call can succeed moments later.
pub const INITIALIZING_CODE: &str = "SECRET_STORE_INITIALIZING";
/// Stable error code: the last initialization attempt failed (Keychain
/// locked, access denied or cancelled, master key missing, unreadable store).
/// Terminal until an explicit [`retry_failed_initialization`].
pub const LOCKED_CODE: &str = "SECRET_STORE_LOCKED";

/// How long a non-UI caller waits for an in-flight initialization. A passive
/// initialization never shows UI, so it normally settles in milliseconds; the
/// budget only matters when the Keychain itself is busy (for example behind
/// another process's authorization dialog).
pub const INITIALIZATION_WAIT: Duration = Duration::from_secs(10);

/// Why the store cannot serve a request right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unavailable {
    /// Initialization is in flight; retry shortly.
    Initializing,
    /// Initialization failed; only an explicit retry can recover.
    Locked,
}

impl Unavailable {
    /// The stable wire code carried by the error message.
    pub fn code(self) -> &'static str {
        match self {
            Self::Initializing => INITIALIZING_CODE,
            Self::Locked => LOCKED_CODE,
        }
    }
}

/// Classify an error string produced by this module, including when a caller
/// wrapped it (`"secrets:get: SECRET_STORE_LOCKED: …"`). `None` for every other
/// error, so callers keep their existing handling for real per-entry failures.
pub fn unavailable_reason(error: &str) -> Option<Unavailable> {
    if error.contains(LOCKED_CODE) {
        Some(Unavailable::Locked)
    } else if error.contains(INITIALIZING_CODE) {
        Some(Unavailable::Initializing)
    } else {
        None
    }
}

fn initializing_error() -> String {
    format!("{INITIALIZING_CODE}: secret-store initialization in progress; retry later")
}

fn locked_error(cause: &str) -> String {
    format!("{LOCKED_CODE}: {cause}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Phase {
    Uninitialized,
    Initializing,
    Ready,
    Failed(String),
}

/// The state machine's storage. `Condvar` wakes waiters when an initializer
/// publishes its outcome; the phase mutex is never held across the build.
struct InitGate {
    phase: Mutex<Phase>,
    settled: Condvar,
}

impl InitGate {
    const fn new() -> Self {
        Self {
            phase: Mutex::new(Phase::Uninitialized),
            settled: Condvar::new(),
        }
    }
}

static GLOBAL: OnceLock<RwLock<SecretStore>> = OnceLock::new();
static INIT: InitGate = InitGate::new();

/// Run a blocking wait without starving the async runtime. On a multi-thread
/// tokio worker (every Tauri `async fn` command) `block_in_place` hands the
/// worker's queue to another thread first; everywhere else — blocking-pool
/// workers, plain threads, current-thread runtimes whose initializer runs on
/// another OS thread — a plain blocking wait is already correct.
fn wait_blocking<R>(wait: impl FnOnce() -> R) -> R {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(wait)
        }
        _ => wait(),
    }
}

/// Wait while `phase` is `Initializing`, up to `deadline`. Returns with the
/// guard re-acquired; the caller re-evaluates the phase.
fn wait_for_settlement(
    gate: &InitGate,
    phase: &mut parking_lot::MutexGuard<'_, Phase>,
    deadline: Instant,
) {
    wait_blocking(|| {
        while **phase == Phase::Initializing {
            if gate.settled.wait_until(phase, deadline).timed_out() {
                break;
            }
        }
    });
}

/// Publishes a failure if the initializer unwinds, so a panicking build can
/// never leave every later caller waiting on an `Initializing` that no thread
/// will ever settle.
struct SettleOnUnwind<'a> {
    gate: &'a InitGate,
    armed: bool,
}

impl Drop for SettleOnUnwind<'_> {
    fn drop(&mut self) {
        if self.armed {
            *self.gate.phase.lock() = Phase::Failed("secret-store initializer panicked".into());
            self.gate.settled.notify_all();
        }
    }
}

/// Run `build` as the single initializer and publish its outcome. The caller
/// has already moved the phase to `Initializing` under the lock.
fn run_initializer<'a>(
    cell: &'a OnceLock<RwLock<SecretStore>>,
    gate: &InitGate,
    build: impl FnOnce() -> Result<SecretStore, String>,
) -> Result<&'a RwLock<SecretStore>, String> {
    let mut unwind = SettleOnUnwind { gate, armed: true };
    let outcome = build();
    unwind.armed = false;
    let mut phase = gate.phase.lock();
    let result = match outcome {
        Ok(store) => {
            let store = cell.get_or_init(|| RwLock::new(store));
            *phase = Phase::Ready;
            Ok(store)
        }
        Err(cause) => {
            *phase = Phase::Failed(cause.clone());
            Err(locked_error(&cause))
        }
    };
    gate.settled.notify_all();
    result
}

/// Passive access: become the initializer when nobody has tried yet, wait
/// (bounded by `wait`) for an in-flight initializer, and return a cached
/// failure without touching the Keychain again. `wait: None` never blocks.
fn acquire<'a>(
    cell: &'a OnceLock<RwLock<SecretStore>>,
    gate: &InitGate,
    wait: Option<Duration>,
    build: impl FnOnce() -> Result<SecretStore, String>,
) -> Result<&'a RwLock<SecretStore>, String> {
    if let Some(store) = cell.get() {
        return Ok(store);
    }
    let deadline = wait.map(|budget| Instant::now() + budget);
    let mut phase = gate.phase.lock();
    loop {
        match &*phase {
            Phase::Ready => {
                return cell
                    .get()
                    .ok_or_else(|| locked_error("secret-store ready without a store"));
            }
            Phase::Failed(cause) => return Err(locked_error(cause)),
            Phase::Uninitialized => {
                *phase = Phase::Initializing;
                break;
            }
            Phase::Initializing => {
                let Some(deadline) = deadline else {
                    return Err(initializing_error());
                };
                if Instant::now() >= deadline {
                    return Err(initializing_error());
                }
                wait_for_settlement(gate, &mut phase, deadline);
            }
        }
    }
    drop(phase);
    run_initializer(cell, gate, build)
}

/// Explicit recovery: wait for an in-flight attempt, then re-run `build`
/// (which may show OS UI) from `Uninitialized` or `Failed`.
fn retry<'a>(
    cell: &'a OnceLock<RwLock<SecretStore>>,
    gate: &InitGate,
    wait: Duration,
    build: impl FnOnce() -> Result<SecretStore, String>,
) -> Result<&'a RwLock<SecretStore>, String> {
    if let Some(store) = cell.get() {
        return Ok(store);
    }
    let deadline = Instant::now() + wait;
    let mut phase = gate.phase.lock();
    loop {
        match &*phase {
            Phase::Ready => {
                return cell
                    .get()
                    .ok_or_else(|| locked_error("secret-store ready without a store"));
            }
            Phase::Uninitialized | Phase::Failed(_) => {
                *phase = Phase::Initializing;
                break;
            }
            Phase::Initializing => {
                if Instant::now() >= deadline {
                    return Err(initializing_error());
                }
                wait_for_settlement(gate, &mut phase, deadline);
            }
        }
    }
    drop(phase);
    run_initializer(cell, gate, build)
}

/// The UI (main) thread must never block behind an initializer: it gets the
/// transient [`INITIALIZING_CODE`] instead. Rust names the process's main
/// thread `"main"`, and Tauri runs its event loop — and every synchronous
/// command — on it.
fn caller_wait_budget() -> Option<Duration> {
    if std::thread::current().name() == Some("main") {
        None
    } else {
        Some(INITIALIZATION_WAIT)
    }
}

fn global() -> Result<&'static RwLock<SecretStore>, String> {
    acquire(&GLOBAL, &INIT, caller_wait_budget(), || build_global(false))
}

/// The store's initialization state as the frontend sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Readiness {
    /// Nothing has touched the store yet in this process.
    Uninitialized,
    /// An initializer is resolving the master key right now.
    Initializing,
    /// The store is open; every call can succeed.
    Ready,
    /// The last attempt failed; only [`retry_failed_initialization`] recovers.
    Locked,
}

fn readiness_of(gate: &InitGate) -> Readiness {
    match &*gate.phase.lock() {
        Phase::Uninitialized => Readiness::Uninitialized,
        Phase::Initializing => Readiness::Initializing,
        Phase::Ready => Readiness::Ready,
        Phase::Failed(_) => Readiness::Locked,
    }
}

/// The current state, without side effects.
pub fn readiness() -> Readiness {
    readiness_of(&INIT)
}

/// Settle the passive initialization and report the outcome: start it when no
/// caller has yet, wait (bounded, never on the UI thread) for one in flight,
/// and never prompt. Boot diagnostics call this on a blocking worker so a
/// locked store is detected up front instead of by the first consumer to fail.
pub fn ensure_initialized() -> Readiness {
    ensure_initialized_with(&GLOBAL, &INIT, caller_wait_budget(), || build_global(false))
}

fn ensure_initialized_with(
    cell: &OnceLock<RwLock<SecretStore>>,
    gate: &InitGate,
    wait: Option<Duration>,
    build: impl FnOnce() -> Result<SecretStore, String>,
) -> Readiness {
    match acquire(cell, gate, wait, build) {
        Ok(_) => Readiness::Ready,
        Err(error) => {
            // The cause stays in the native log; the wire carries only the
            // stable state (the cause can name local paths).
            if unavailable_reason(&error) == Some(Unavailable::Locked) {
                log::warn!("secret store unavailable: {error}");
            }
            readiness_of(gate)
        }
    }
}

/// Called only from an explicit recovery action, on a blocking worker. Passive
/// reads never prompt; a denied attempt remains retryable in this process, and
/// a successful retry makes every later passive read succeed.
///
/// On a store that is (or just became) ready it is also the recovery for
/// legacy items whose passive read failed: those failures are forgotten so the
/// next `get` reads the Keychain again instead of replaying the cached error.
pub fn retry_failed_initialization() -> Result<(), String> {
    let store = retry(&GLOBAL, &INIT, INITIALIZATION_WAIT, || build_global(true))?;
    store.write().forget_failed_legacy_reads();
    Ok(())
}

/// Production initialization fails closed, without caching transient failures.
#[cfg(not(any(test, feature = "test-inmemory")))]
fn build_global(allow_interaction: bool) -> Result<SecretStore, String> {
    if dev_key_file_mode() {
        let dev_dir = dirs::data_dir()
            .map(|d| dev_dir_in(&d))
            .ok_or_else(|| "secret-store data dir unavailable".to_string())?;
        let key = load_or_create_dev_master_key(&dev_dir)?;
        return SecretStore::open(dev_dir.join(STORE_FILE_NAME), key);
    }
    let key = load_or_create_master_key(allow_interaction)?;
    let path =
        default_store_path().ok_or_else(|| "secret-store data dir unavailable".to_string())?;
    SecretStore::open(path, key)
}

/// Pure decision: does this build keep its master key in the dev key file?
///
/// Only a debug build, only when no headless-style master key is configured
/// (that keeps its documented meaning and store path), and not when
/// [`DEV_KEYCHAIN_ENV`] asks for the Keychain back.
#[cfg_attr(feature = "test-inmemory", allow(dead_code))]
fn dev_key_file_mode_for(
    debug_build: bool,
    dev_keychain_override: Option<&str>,
    master_key_env_configured: bool,
) -> bool {
    if !debug_build || master_key_env_configured {
        return false;
    }
    !matches!(
        dev_keychain_override.map(str::trim),
        Some("1") | Some("true")
    )
}

/// [`dev_key_file_mode_for`] for this process.
#[cfg(not(any(test, feature = "test-inmemory")))]
fn dev_key_file_mode() -> bool {
    let configured = |name: &str| std::env::var(name).is_ok_and(|value| !value.trim().is_empty());
    let dev_keychain_override = std::env::var(DEV_KEYCHAIN_ENV).ok();
    dev_key_file_mode_for(
        cfg!(debug_assertions),
        dev_keychain_override.as_deref(),
        configured(MASTER_KEY_ENV) || configured(MASTER_KEY_FILE_ENV),
    )
}

/// The hermetic test global has no keychain and no dev file either.
#[cfg(any(test, feature = "test-inmemory"))]
fn dev_key_file_mode() -> bool {
    false
}

/// `<dataDir>/cognia/dev`, where a debug build keeps its key and store.
#[cfg_attr(feature = "test-inmemory", allow(dead_code))]
fn dev_dir_in(data_dir: &Path) -> PathBuf {
    data_dir.join("cognia").join(DEV_DIR_NAME)
}

/// Read a debug build's master key, creating it on first use.
///
/// Fails closed exactly like the Keychain path: an existing dev store with no
/// key file is data this key cannot open, so a new key is refused rather than
/// minted over it. The key is written to a private temporary file and then
/// hard-linked into place, which is atomic and refuses to replace an existing
/// file, so two processes racing a fresh profile both end up reading whichever
/// complete key landed first, never a half-written one.
#[cfg_attr(feature = "test-inmemory", allow(dead_code))]
fn load_or_create_dev_master_key(dev_dir: &Path) -> Result<[u8; 32], String> {
    let key_path = dev_dir.join(DEV_MASTER_KEY_FILE_NAME);
    let read_existing = |path: &Path| -> Result<Option<[u8; 32]>, String> {
        match std::fs::read_to_string(path) {
            Ok(raw) => parse_hex_key(&raw)
                .map(Some)
                .map_err(|error| format!("dev master key {}: {error}", path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("read dev master key ({}): {error}", path.display())),
        }
    };
    if let Some(key) = read_existing(&key_path)? {
        return Ok(key);
    }
    if dev_dir.join(STORE_FILE_NAME).exists() {
        return Err(format!(
            "dev master key {} is missing for an existing dev secret store; restore it or delete {} to start over",
            key_path.display(),
            dev_dir.display()
        ));
    }
    std::fs::create_dir_all(dev_dir)
        .map_err(|error| format!("create {}: {error}", dev_dir.display()))?;
    let key = random_key();
    let staged = dev_dir.join(format!(
        "{DEV_MASTER_KEY_FILE_NAME}.{}-{}.tmp",
        std::process::id(),
        hex::encode(random_key())
    ));
    let write_staged = || -> std::io::Result<()> {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&staged)?;
        file.write_all(hex::encode(key).as_bytes())?;
        file.sync_all()
    };
    let published = write_staged().and_then(|()| std::fs::hard_link(&staged, &key_path));
    let _ = std::fs::remove_file(&staged);
    match published {
        Ok(()) => Ok(key),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_existing(&key_path)?.ok_or_else(|| {
                format!(
                    "dev master key {} vanished while it was created",
                    key_path.display()
                )
            })
        }
        Err(error) => Err(format!(
            "create dev master key ({}): {error}",
            key_path.display()
        )),
    }
}

/// Test global: in-memory, fixed key, no disk or keyring. Every rerouted
/// module's tests run against this so the suite stays hermetic.
#[cfg(any(test, feature = "test-inmemory"))]
fn build_global(_allow_interaction: bool) -> Result<SecretStore, String> {
    Ok(SecretStore::in_memory([7u8; 32]))
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
fn load_or_create_master_key(allow_interaction: bool) -> Result<[u8; 32], String> {
    if let Some(key) = resolve_master_key_from_env()? {
        return Ok(key);
    }
    let read = crate::keychain_access::with_keychain_interaction(allow_interaction, || {
        keyring::Entry::new(MASTER_KEY_SERVICE, MASTER_KEY_ACCOUNT)?.get_password()
    });
    match read {
        Ok(hex_key) => parse_hex_key(&hex_key),
        Err(keyring::Error::NoEntry) => {
            if default_store_path().is_some_and(|path| path.exists()) {
                return Err("secret-store master key is missing for an existing encrypted store; restore Keychain access before retrying".into());
            }
            let key = random_key();
            crate::keychain_access::with_keychain_interaction(allow_interaction, || {
                keyring::Entry::new(MASTER_KEY_SERVICE, MASTER_KEY_ACCOUNT)?
                    .set_password(&hex::encode(key))
            })
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
    init_headless_with(&GLOBAL, &INIT, || build_headless_store(data_dir))?;
    HEADLESS_MODE.store(true, Ordering::SeqCst);
    Ok(())
}

/// [`init_headless`] against an explicit cell/gate. Holding the phase lock for
/// the whole build is deliberate: headless boot runs before any other secret
/// access, and a concurrent caller must not start a desktop Keychain init. A
/// failed headless build is published as `Failed`, so a process that keeps
/// running after the fatal error never falls back to the OS keyring.
fn init_headless_with(
    cell: &OnceLock<RwLock<SecretStore>>,
    gate: &InitGate,
    build: impl FnOnce() -> Result<SecretStore, String>,
) -> Result<(), String> {
    let mut phase = gate.phase.lock();
    if *phase != Phase::Uninitialized || cell.get().is_some() {
        return Err("secret store already initialized; init_headless must run first".to_string());
    }
    let result = match build() {
        Ok(store) => cell
            .set(RwLock::new(store))
            .map(|()| Phase::Ready)
            .map_err(|_| {
                "secret store already initialized; init_headless must run first".to_string()
            }),
        Err(cause) => Err(cause),
    };
    *phase = match &result {
        Ok(ready) => ready.clone(),
        Err(cause) => Phase::Failed(cause.clone()),
    };
    gate.settled.notify_all();
    result.map(|_| ())
}

/// Whether the legacy keyring paths are live: not in headless mode, and not in
/// a debug build on the dev key file, which must never touch the Keychain.
fn legacy_enabled() -> bool {
    !HEADLESS_MODE.load(Ordering::SeqCst) && !dev_key_file_mode()
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
    match crate::keychain_access::read_password_without_prompt(service, account) {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("legacy keyring read: {e}")),
    }
}

#[cfg(not(any(test, feature = "test-inmemory")))]
fn legacy_keyring_delete(service: &str, account: &str) -> Result<(), String> {
    match crate::keychain_access::with_keychain_interaction(false, || {
        keyring::Entry::new(service, account)?.delete_credential()
    }) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("legacy keyring delete: {error}")),
    }
}

#[cfg(any(test, feature = "test-inmemory"))]
fn legacy_keyring_get(_service: &str, _account: &str) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(any(test, feature = "test-inmemory"))]
fn legacy_keyring_delete(_service: &str, _account: &str) -> Result<(), String> {
    Ok(())
}

// ---------------------------------------------------------------------------
// Public API — drop-in for the old per-subsystem keyring helpers
// ---------------------------------------------------------------------------

/// Read a secret. Returns `Ok(None)` when nothing is stored under
/// `(service, account)`. On a store miss, the legacy OS-keyring item (if any)
/// is migrated in and then removed — desktop only; headless installs have no
/// keyring and skip migration entirely.
pub fn get(service: &str, account: &str) -> Result<Option<String>, String> {
    // Fast path: read lock, no migration.
    if let Some(value) = global()?.read().peek(service, account) {
        return Ok(Some(value));
    }
    if !legacy_enabled() {
        return Ok(None);
    }
    // Slow path: take the write lock and attempt one-time legacy migration.
    let outcome = global()?
        .write()
        .get_or_migrate(service, account, legacy_keyring_get)?;
    match outcome {
        MigrationOutcome::Cached(value) => Ok(Some(value)),
        MigrationOutcome::Migrated(value) => {
            // The value now lives in the encrypted store; drop the legacy item
            // so it can never re-surface or prompt again.
            if let Err(error) = legacy_keyring_delete(service, account) {
                log::warn!("secret migrated but legacy cleanup deferred: {error}");
            }
            Ok(Some(value))
        }
        MigrationOutcome::Missing => Ok(None),
    }
}

/// List account identifiers within exactly one encrypted service. This reads
/// metadata only and never enumerates legacy OS-keyring entries or values.
pub fn list_accounts(service: &str) -> Result<Vec<String>, String> {
    let prefix = format!("{service}{COMPOSITE_SEP}");
    Ok(global()?
        .read()
        .cache
        .keys()
        .filter_map(|key| key.strip_prefix(&prefix).map(str::to_owned))
        .collect())
}

/// Upsert a secret.
pub fn set(service: &str, account: &str, value: &str) -> Result<(), String> {
    global()?.write().set(service, account, value)
}

/// Remove a secret. Idempotent. Also clears any lingering legacy keyring item
/// so a deleted secret can't be resurrected by a later `get` migration.
///
/// The legacy cleanup is best-effort and runs after the store lock is
/// released: an item the no-prompt policy cannot touch (an ACL bound to an
/// older signature) must not keep the encrypted value alive, and readers must
/// not wait behind a Keychain call. The store records the deletion in
/// `legacy_reads`, so this process never migrates the item back either way.
pub fn delete(service: &str, account: &str) -> Result<(), String> {
    global()?.write().delete(service, account)?;
    if legacy_enabled() {
        if let Err(error) = legacy_keyring_delete(service, account) {
            log::warn!("secret deleted but legacy cleanup deferred: {error}");
        }
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

    // ---- readiness state machine ----

    type Cell = OnceLock<RwLock<SecretStore>>;

    fn leak_cell_and_gate() -> (&'static Cell, &'static InitGate) {
        (
            Box::leak(Box::new(OnceLock::new())),
            Box::leak(Box::new(InitGate::new())),
        )
    }

    fn memory_store() -> Result<SecretStore, String> {
        Ok(SecretStore::in_memory([7; 32]))
    }

    fn phase_of(gate: &InitGate) -> Phase {
        gate.phase.lock().clone()
    }

    /// Start an initializer on another thread that blocks inside `build` until
    /// released, and return once it is provably in flight.
    fn start_blocked_initializer(
        cell: &'static Cell,
        gate: &'static InitGate,
        outcome: Result<(), String>,
    ) -> (
        std::sync::mpsc::Sender<()>,
        std::thread::JoinHandle<Result<(), String>>,
    ) {
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
        let handle = std::thread::spawn(move || {
            acquire(cell, gate, Some(INITIALIZATION_WAIT), move || {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                outcome.map(|()| SecretStore::in_memory([7; 32]))
            })
            .map(|_| ())
        });
        entered_rx.recv().unwrap();
        assert_eq!(phase_of(gate), Phase::Initializing);
        (release_tx, handle)
    }

    #[test]
    fn a_passive_failure_is_terminal_and_typed_until_an_explicit_retry() {
        let (cell, gate) = leak_cell_and_gate();
        let error = acquire(cell, gate, Some(INITIALIZATION_WAIT), || {
            Err("master key read: Platform failure: passphrase not correct".into())
        })
        .err()
        .unwrap();
        assert_eq!(
            error,
            "SECRET_STORE_LOCKED: master key read: Platform failure: passphrase not correct"
        );
        assert_eq!(unavailable_reason(&error), Some(Unavailable::Locked));
        // Later passive callers get the cached failure without a second
        // Keychain read — the fan-out that produced one native attempt (and
        // one rejection) per consumer.
        for _ in 0..3 {
            let again = acquire(cell, gate, Some(INITIALIZATION_WAIT), || {
                panic!("a passive caller must not re-run a failed initialization")
            })
            .err()
            .unwrap();
            assert_eq!(again, error);
        }
        assert!(cell.get().is_none());
    }

    #[test]
    fn failed_then_retry_then_ready_and_only_success_is_cached() {
        let (cell, gate) = leak_cell_and_gate();
        assert!(acquire(cell, gate, None, || Err("User canceled".into())).is_err());
        // A cancelled retry keeps the store failed — and still retryable.
        let cancelled = retry(cell, gate, INITIALIZATION_WAIT, || {
            Err("User canceled".into())
        })
        .err()
        .unwrap();
        assert_eq!(unavailable_reason(&cancelled), Some(Unavailable::Locked));
        assert!(matches!(phase_of(gate), Phase::Failed(_)));

        let store = retry(cell, gate, INITIALIZATION_WAIT, memory_store).unwrap();
        store.write().set("test", "token", "preserved").unwrap();
        assert_eq!(phase_of(gate), Phase::Ready);

        let again = acquire(cell, gate, None, || panic!("must not rebuild")).unwrap();
        assert_eq!(again.read().peek("test", "token"), Some("preserved".into()));
        // Retrying a ready store is a no-op, never a second key read.
        retry(cell, gate, INITIALIZATION_WAIT, || {
            panic!("must not rebuild")
        })
        .unwrap();
    }

    #[test]
    fn concurrent_passive_callers_wait_for_the_in_flight_initializer() {
        let (cell, gate) = leak_cell_and_gate();
        let (release, initializer) = start_blocked_initializer(cell, gate, Ok(()));
        let waiters: Vec<_> = (0..4)
            .map(|_| {
                std::thread::spawn(move || {
                    acquire(cell, gate, Some(INITIALIZATION_WAIT), || {
                        panic!("a waiting caller must not create another key")
                    })
                    .map(|_| ())
                })
            })
            .collect();
        // Give the waiters time to park on the condvar before releasing.
        std::thread::sleep(Duration::from_millis(50));
        release.send(()).unwrap();
        initializer.join().unwrap().unwrap();
        for waiter in waiters {
            waiter.join().unwrap().unwrap();
        }
        assert_eq!(phase_of(gate), Phase::Ready);
    }

    #[test]
    fn concurrent_waiters_observe_a_failed_initializer_as_locked() {
        let (cell, gate) = leak_cell_and_gate();
        let (release, initializer) =
            start_blocked_initializer(cell, gate, Err("access denied".into()));
        let waiter = std::thread::spawn(move || {
            acquire(cell, gate, Some(INITIALIZATION_WAIT), || {
                panic!("must not retry passively")
            })
            .map(|_| ())
        });
        std::thread::sleep(Duration::from_millis(50));
        release.send(()).unwrap();
        assert!(initializer.join().unwrap().is_err());
        let error = waiter.join().unwrap().unwrap_err();
        assert_eq!(error, "SECRET_STORE_LOCKED: access denied");
    }

    #[test]
    fn the_ui_thread_and_expired_budgets_get_the_transient_code_without_blocking() {
        let (cell, gate) = leak_cell_and_gate();
        let (release, initializer) = start_blocked_initializer(cell, gate, Ok(()));

        let started = Instant::now();
        let no_wait = acquire(cell, gate, None, || panic!("must not initialize twice"))
            .err()
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(
            unavailable_reason(&no_wait),
            Some(Unavailable::Initializing)
        );

        let short = acquire(cell, gate, Some(Duration::from_millis(20)), || {
            panic!("must not initialize twice")
        })
        .err()
        .unwrap();
        assert!(short.starts_with(INITIALIZING_CODE));

        release.send(()).unwrap();
        initializer.join().unwrap().unwrap();
        assert!(acquire(cell, gate, None, || panic!("ready")).is_ok());
    }

    #[test]
    fn an_explicit_retry_waits_for_an_in_flight_passive_attempt_instead_of_prompting() {
        let (cell, gate) = leak_cell_and_gate();
        let (release, initializer) = start_blocked_initializer(cell, gate, Ok(()));
        let retrier = std::thread::spawn(move || {
            retry(cell, gate, INITIALIZATION_WAIT, || {
                panic!("the passive attempt succeeded; no interactive build")
            })
            .map(|_| ())
        });
        std::thread::sleep(Duration::from_millis(50));
        release.send(()).unwrap();
        initializer.join().unwrap().unwrap();
        retrier.join().unwrap().unwrap();
    }

    #[test]
    fn an_explicit_retry_after_an_in_flight_failure_runs_the_interactive_build() {
        let (cell, gate) = leak_cell_and_gate();
        let (release, initializer) =
            start_blocked_initializer(cell, gate, Err("interaction not allowed".into()));
        let retrier = std::thread::spawn(move || {
            retry(cell, gate, INITIALIZATION_WAIT, memory_store).map(|_| ())
        });
        std::thread::sleep(Duration::from_millis(50));
        release.send(()).unwrap();
        assert!(initializer.join().unwrap().is_err());
        retrier.join().unwrap().unwrap();
        assert_eq!(phase_of(gate), Phase::Ready);
    }

    #[test]
    fn a_panicking_initializer_never_wedges_later_callers() {
        let (cell, gate) = leak_cell_and_gate();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = acquire(cell, gate, None, || -> Result<SecretStore, String> {
                panic!("keyring backend bug")
            });
        }));
        assert!(outcome.is_err());
        let error = acquire(cell, gate, Some(Duration::from_millis(20)), || {
            panic!("a panic is a failure, not a reason to retry passively")
        })
        .err()
        .unwrap();
        assert_eq!(unavailable_reason(&error), Some(Unavailable::Locked));
        retry(cell, gate, INITIALIZATION_WAIT, memory_store).unwrap();
    }

    #[test]
    fn a_waiting_async_command_does_not_starve_the_runtime() {
        let (cell, gate) = leak_cell_and_gate();
        let (release, initializer) = start_blocked_initializer(cell, gate, Ok(()));
        // One worker: without block_in_place the waiting task would occupy
        // the only worker and the ticker below could never run.
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async move {
            let waiter = tokio::spawn(async move {
                acquire(cell, gate, Some(INITIALIZATION_WAIT), || {
                    panic!("must wait")
                })
                .map(|_| ())
            });
            let ticker = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                release.send(()).unwrap();
            });
            ticker.await.unwrap();
            waiter.await.unwrap().unwrap();
        });
        initializer.join().unwrap().unwrap();
    }

    #[test]
    fn only_the_thread_named_main_skips_the_wait() {
        assert_eq!(caller_wait_budget(), Some(INITIALIZATION_WAIT));
        let on_main = std::thread::Builder::new()
            .name("main".into())
            .spawn(caller_wait_budget)
            .unwrap()
            .join()
            .unwrap();
        assert_eq!(on_main, None);
    }

    #[test]
    fn unavailable_reasons_survive_caller_wrapping_and_ignore_other_errors() {
        assert_eq!(
            unavailable_reason(&format!("secrets:get: {}", locked_error("denied"))),
            Some(Unavailable::Locked)
        );
        assert_eq!(
            unavailable_reason(&format!("vault: {}", initializing_error())),
            Some(Unavailable::Initializing)
        );
        assert_eq!(unavailable_reason("legacy keyring read: denied"), None);
        assert_eq!(Unavailable::Locked.code(), LOCKED_CODE);
        assert_eq!(Unavailable::Initializing.code(), INITIALIZING_CODE);
    }

    #[test]
    fn ensure_initialized_reports_each_state_without_prompting_twice() {
        let (cell, gate) = leak_cell_and_gate();
        assert_eq!(readiness_of(gate), Readiness::Uninitialized);
        assert_eq!(
            ensure_initialized_with(cell, gate, None, || Err("denied".into())),
            Readiness::Locked
        );
        assert_eq!(
            ensure_initialized_with(cell, gate, None, || panic!("cached failure")),
            Readiness::Locked
        );
        retry(cell, gate, INITIALIZATION_WAIT, memory_store).unwrap();
        assert_eq!(
            ensure_initialized_with(cell, gate, None, || panic!("ready")),
            Readiness::Ready
        );

        let (cell, gate) = leak_cell_and_gate();
        let (release, initializer) = start_blocked_initializer(cell, gate, Ok(()));
        assert_eq!(
            ensure_initialized_with(cell, gate, None, || panic!("in flight")),
            Readiness::Initializing
        );
        release.send(()).unwrap();
        initializer.join().unwrap().unwrap();
        assert_eq!(readiness_of(gate), Readiness::Ready);
        assert_eq!(
            serde_json::to_string(&Readiness::Locked).unwrap(),
            "\"locked\""
        );
    }

    #[test]
    fn headless_init_publishes_ready_or_a_terminal_failure() {
        let (cell, gate) = leak_cell_and_gate();
        init_headless_with(cell, gate, memory_store).unwrap();
        assert_eq!(phase_of(gate), Phase::Ready);
        assert!(init_headless_with(cell, gate, memory_store).is_err());

        let (cell, gate) = leak_cell_and_gate();
        assert!(init_headless_with(cell, gate, || Err("no master key".into())).is_err());
        let error = acquire(cell, gate, None, || {
            panic!("headless must never fall back to the OS keyring")
        })
        .err()
        .unwrap();
        assert_eq!(error, "SECRET_STORE_LOCKED: no master key");
    }

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

    // ---- development key file ----

    fn tmp_data_dir() -> PathBuf {
        tmp_path().parent().unwrap().to_path_buf()
    }

    #[test]
    fn dev_key_file_mode_only_in_debug_builds() {
        assert!(dev_key_file_mode_for(true, None, false));
        assert!(!dev_key_file_mode_for(false, None, false));
    }

    #[test]
    fn dev_key_file_mode_yields_to_an_explicit_master_key() {
        assert!(!dev_key_file_mode_for(true, None, true));
    }

    #[test]
    fn dev_key_file_mode_can_be_sent_back_to_the_keychain() {
        assert!(!dev_key_file_mode_for(true, Some("1"), false));
        assert!(!dev_key_file_mode_for(true, Some(" true "), false));
        assert!(dev_key_file_mode_for(true, Some("0"), false));
        assert!(dev_key_file_mode_for(true, Some(""), false));
    }

    #[test]
    fn dev_dir_sits_under_the_cognia_store_root() {
        let data = Path::new("/data");
        assert_eq!(dev_dir_in(data), Path::new("/data/cognia/dev"));
    }

    #[test]
    fn dev_master_key_is_created_once_and_then_reused() {
        let dev_dir = dev_dir_in(&tmp_data_dir());
        let first = load_or_create_dev_master_key(&dev_dir).unwrap();
        let second = load_or_create_dev_master_key(&dev_dir).unwrap();
        assert_eq!(first, second);
        let on_disk = std::fs::read_to_string(dev_dir.join(DEV_MASTER_KEY_FILE_NAME)).unwrap();
        assert_eq!(on_disk, hex::encode(first));
        // No staging file is left behind.
        let leftovers: Vec<_> = std::fs::read_dir(&dev_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn dev_master_key_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dev_dir = dev_dir_in(&tmp_data_dir());
        load_or_create_dev_master_key(&dev_dir).unwrap();
        let mode = std::fs::metadata(dev_dir.join(DEV_MASTER_KEY_FILE_NAME))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn dev_master_key_refuses_to_mint_over_an_existing_store() {
        let dev_dir = dev_dir_in(&tmp_data_dir());
        std::fs::create_dir_all(&dev_dir).unwrap();
        std::fs::write(dev_dir.join(STORE_FILE_NAME), b"ciphertext").unwrap();
        let error = load_or_create_dev_master_key(&dev_dir).unwrap_err();
        assert!(
            error.contains("missing for an existing dev secret store"),
            "{error}"
        );
        assert!(!dev_dir.join(DEV_MASTER_KEY_FILE_NAME).exists());
    }

    #[test]
    fn dev_master_key_rejects_a_corrupt_key_file() {
        let dev_dir = dev_dir_in(&tmp_data_dir());
        std::fs::create_dir_all(&dev_dir).unwrap();
        std::fs::write(dev_dir.join(DEV_MASTER_KEY_FILE_NAME), "not-hex").unwrap();
        assert!(load_or_create_dev_master_key(&dev_dir).is_err());
    }

    #[test]
    fn dev_master_key_opens_the_store_it_created() {
        let dev_dir = dev_dir_in(&tmp_data_dir());
        let key = load_or_create_dev_master_key(&dev_dir).unwrap();
        let path = dev_dir.join(STORE_FILE_NAME);
        let mut store = SecretStore::open(path.clone(), key).unwrap();
        store.set("svc", "acct", "value").unwrap();
        let reopened_key = load_or_create_dev_master_key(&dev_dir).unwrap();
        let reopened = SecretStore::open(path, reopened_key).unwrap();
        assert_eq!(reopened.peek("svc", "acct"), Some("value".to_string()));
    }

    #[test]
    fn concurrent_first_use_agrees_on_one_dev_key() {
        let dev_dir = dev_dir_in(&tmp_data_dir());
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let dir = dev_dir.clone();
                std::thread::spawn(move || load_or_create_dev_master_key(&dir).unwrap())
            })
            .collect();
        let keys: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert!(keys.windows(2).all(|pair| pair[0] == pair[1]));
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
    fn enumeration_returns_only_keys_from_the_exact_service() {
        set("inventory-test", "custom:one", "private-one").unwrap();
        set("inventory-test/nested", "custom:two", "private-two").unwrap();
        assert_eq!(list_accounts("inventory-test").unwrap(), vec!["custom:one"]);
        assert!(list_accounts("inventory-other").unwrap().is_empty());
        delete("inventory-test", "custom:one").unwrap();
        delete("inventory-test/nested", "custom:two").unwrap();
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

    #[test]
    fn legacy_missing_and_denied_reads_are_not_repeated_in_a_session() {
        let mut store = SecretStore::open(tmp_path(), [8u8; 32]).unwrap();
        store
            .get_or_migrate("svc", "missing", |_, _| Ok(None))
            .unwrap();
        assert!(matches!(
            store
                .get_or_migrate("svc", "missing", |_, _| panic!("duplicate legacy read"))
                .unwrap(),
            MigrationOutcome::Missing
        ));
        assert_eq!(
            store
                .get_or_migrate("svc", "denied", |_, _| Err("access denied".into()))
                .unwrap_err(),
            "access denied"
        );
        assert_eq!(
            store
                .get_or_migrate("svc", "denied", |_, _| panic!("duplicate denied read"))
                .unwrap_err(),
            "access denied"
        );
        store.set("svc", "denied", "replacement").unwrap();
        assert!(
            matches!(store.get_or_migrate("svc", "denied", |_, _| panic!("explicit set must win")).unwrap(), MigrationOutcome::Cached(v) if v == "replacement")
        );
    }

    #[test]
    fn forgetting_failed_legacy_reads_retries_only_the_failures() {
        let mut store = SecretStore::open(tmp_path(), [8u8; 32]).unwrap();
        store
            .get_or_migrate("svc", "missing", |_, _| Ok(None))
            .unwrap();
        assert!(store
            .get_or_migrate("svc", "locked", |_, _| Err("keychain locked".into()))
            .is_err());
        store.forget_failed_legacy_reads();
        // The failure is read again, and now migrates.
        assert!(matches!(
            store
                .get_or_migrate("svc", "locked", |_, _| Ok(Some("recovered".into())))
                .unwrap(),
            MigrationOutcome::Migrated(v) if v == "recovered"
        ));
        // A cached miss is still not re-read.
        assert!(matches!(
            store
                .get_or_migrate("svc", "missing", |_, _| panic!("a miss stays cached"))
                .unwrap(),
            MigrationOutcome::Missing
        ));
    }

    #[test]
    fn failed_persistence_does_not_publish_an_uncommitted_secret() {
        let parent = tmp_path();
        std::fs::write(&parent, b"not a directory").unwrap();
        let mut store = SecretStore::open(parent.join("store.enc"), [8u8; 32]).unwrap();
        assert!(store
            .get_or_migrate("svc", "account", |_, _| Ok(Some("legacy".into())))
            .is_err());
        assert_eq!(store.peek("svc", "account"), None);
        assert!(store.set("svc", "account", "new").is_err());
        assert_eq!(store.peek("svc", "account"), None);
        store
            .cache
            .insert(composite("svc", "existing"), "keep".into());
        assert!(store.set("svc", "existing", "replacement").is_err());
        assert_eq!(store.peek("svc", "existing"), Some("keep".into()));
        assert!(store.delete("svc", "existing").is_err());
        assert_eq!(store.peek("svc", "existing"), Some("keep".into()));
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
