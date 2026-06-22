// ADR-0028 / Phase 14 — Anthropic credential watcher.
//
// Per-account `CLAUDE_CONFIG_DIR` directories eliminate the cross-process
// OAuth refresh race (each account owns its own `.credentials.json`),
// but the CLI subprocess rotates the refresh token IN-FILE without
// surfacing the new value back to our keyring vault. Result: long-lived
// multi-account sessions would silently drift toward forced re-login as
// the vault's refresh_token goes stale.
//
// `watch_configdir_credentials(account_id, configdir)` opens a debounced
// `notify` watcher over `<configdir>/.credentials.json`. On mtime change
// it reparses the file, diffs the refresh token against the vault entry
// for `account_id`, and (on diff) calls
// `vault::update_anthropic_refresh_token` so the next sidecar spawn
// picks up the rotation. Burst writes are coalesced via a 500 ms debounce
// so a single rotation doesn't fire the writeback twice.

#[allow(unused_imports)]
pub use crate::subscription::vault::AnthropicCredentialData;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use notify::{recommended_watcher, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Deserialize;

use std::collections::HashMap;

use crate::subscription::provider::ProviderId;
use crate::subscription::vault::{self, ProviderCredential};

/// Default debounce window — collapses burst writes so a single
/// rotation maps to one writeback.
pub const DEFAULT_DEBOUNCE_MS: u64 = 500;

/// Subset of the CLI's `.credentials.json` we care about. The CLI may
/// add fields in future releases; serde ignores unknown keys so this
/// stays forward-compatible.
#[derive(Debug, Clone, Deserialize)]
pub struct ClaudeConfigCredentials {
    #[serde(rename = "refreshToken", alias = "refresh_token", default)]
    refresh_token: String,
    #[serde(rename = "accessToken", alias = "access_token", default)]
    access_token: String,
    #[serde(rename = "expiresAtMs", alias = "expires_at_ms", default)]
    expires_at_ms: i64,
}

/// Returned to the caller — dropping it stops the watcher.
pub struct WatcherHandle {
    _watcher: RecommendedWatcher,
    pub local_account_id: String,
    pub account_id: String,
    pub configdir: PathBuf,
    /// Diagnostic counter, useful for tests and the Diagnostics tab.
    pub events_observed: Arc<AtomicU64>,
    pub rotations_applied: Arc<AtomicU64>,
}

/// Persistence sink — production calls `vault::*`; tests substitute a
/// no-op closure. Keeping it injectable also lets a future "watch but
/// don't write" diagnostic mode reuse the same machinery.
pub trait CredentialSink: Send + Sync + 'static {
    fn update(
        &self,
        local_account_id: &str,
        account_id: &str,
        fresh: &ClaudeConfigCredentials,
    ) -> Result<(), String>;
}

/// Default sink — reads the Anthropic vault, finds the matching account,
/// replaces the refresh token + access token + expiry, writes the vault
/// back. No-op when the account isn't found in the vault (account may
/// have been deleted between rotations).
pub struct VaultSink;

impl CredentialSink for VaultSink {
    fn update(
        &self,
        local_account_id: &str,
        account_id: &str,
        fresh: &ClaudeConfigCredentials,
    ) -> Result<(), String> {
        let mut vault_value =
            match vault::load_for_account(local_account_id, ProviderId::Anthropic)? {
                Some(v) => v,
                None => return Ok(()),
            };
        let mut changed = false;
        for account in &mut vault_value.accounts {
            if account.id != account_id {
                continue;
            }
            if let ProviderCredential::Anthropic(data) = &mut account.credential {
                if !fresh.refresh_token.is_empty() && data.refresh_token != fresh.refresh_token {
                    data.refresh_token = fresh.refresh_token.clone();
                    if !fresh.access_token.is_empty() {
                        data.access_token = fresh.access_token.clone();
                    }
                    if fresh.expires_at_ms > 0 {
                        data.expires_at_ms = fresh.expires_at_ms;
                    }
                    data.stored_at_ms = chrono::Utc::now().timestamp_millis();
                    changed = true;
                }
            }
        }
        if changed {
            vault::save_for_account(local_account_id, ProviderId::Anthropic, &vault_value)?;
        }
        Ok(())
    }
}

/// Build a watcher with the production `VaultSink`.
pub fn watch_configdir_credentials(
    local_account_id: String,
    account_id: String,
    configdir: PathBuf,
) -> Result<WatcherHandle, String> {
    watch_configdir_with(
        local_account_id,
        account_id,
        configdir,
        Arc::new(VaultSink),
        DEFAULT_DEBOUNCE_MS,
    )
}

/// Build a watcher with an injected sink + debounce. Used by tests.
pub fn watch_configdir_with<S: CredentialSink + 'static>(
    local_account_id: String,
    account_id: String,
    configdir: PathBuf,
    sink: Arc<S>,
    debounce_ms: u64,
) -> Result<WatcherHandle, String> {
    if !configdir.exists() {
        std::fs::create_dir_all(&configdir)
            .map_err(|e| format!("create_dir_all {configdir:?} failed: {e}"))?;
    }
    let credentials_path = configdir.join(".credentials.json");
    let events_observed = Arc::new(AtomicU64::new(0));
    let rotations_applied = Arc::new(AtomicU64::new(0));
    let last_fire = Arc::new(Mutex::new(
        std::time::Instant::now() - std::time::Duration::from_secs(60),
    ));

    let local_account_clone = local_account_id.clone();
    let account_clone = account_id.clone();
    let path_clone = credentials_path.clone();
    let observed_clone = Arc::clone(&events_observed);
    let applied_clone = Arc::clone(&rotations_applied);
    let last_clone = Arc::clone(&last_fire);
    let sink_clone: Arc<S> = Arc::clone(&sink);

    let mut watcher = recommended_watcher(move |res: Result<Event, notify::Error>| {
        let event = match res {
            Ok(e) => e,
            Err(err) => {
                log::warn!("credential watcher error: {err}");
                return;
            }
        };
        observed_clone.fetch_add(1, Ordering::SeqCst);
        if !matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
            return;
        }
        if !event.paths.iter().any(|p| p == &path_clone) {
            return;
        }
        // Debounce — collapse burst writes within the window.
        {
            let mut last = last_clone.lock();
            let now = std::time::Instant::now();
            if now.duration_since(*last) < std::time::Duration::from_millis(debounce_ms) {
                return;
            }
            *last = now;
        }
        match read_credentials(&path_clone) {
            Ok(fresh) => {
                if let Err(err) = sink_clone.update(&local_account_clone, &account_clone, &fresh) {
                    log::warn!("credential vault writeback failed: {err}");
                } else {
                    let applied = applied_clone.fetch_add(1, Ordering::SeqCst) + 1;
                    let observed = observed_clone.load(Ordering::SeqCst);
                    log::info!(
                        "credential rotation applied for account={} (observed={} applied={})",
                        account_clone,
                        observed,
                        applied
                    );
                }
            }
            Err(err) => log::warn!("credential read failed: {err}"),
        }
    })
    .map_err(|e| format!("watcher init failed: {e}"))?;

    watcher
        .watch(&configdir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch {configdir:?} failed: {e}"))?;

    Ok(WatcherHandle {
        _watcher: watcher,
        local_account_id,
        account_id,
        configdir,
        events_observed,
        rotations_applied,
    })
}

fn read_credentials(path: &Path) -> Result<ClaudeConfigCredentials, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {path:?} failed: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {path:?} failed: {e}"))
}

/// Idempotent per-account watcher registry. The Tauri layer holds one
/// instance behind `Mutex` and calls `ensure_watching` from
/// `claude_env_for_account` so the watcher is alive for the lifetime
/// of any session that touches that account. Dropping the account
/// (via `subscription_delete_account`) drops the watcher.
#[derive(Default)]
pub struct WatcherRegistry {
    inner: Mutex<HashMap<String, WatcherHandle>>,
}

impl WatcherRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start (or no-op if already running) a watcher over the given
    /// configdir. Errors surface verbatim so the caller can decide
    /// whether to ignore them.
    pub fn ensure_watching(
        &self,
        local_account_id: &str,
        account_id: &str,
        configdir: PathBuf,
    ) -> Result<(), String> {
        let mut guard = self.inner.lock();
        let key = watcher_key(local_account_id, account_id);
        if guard.contains_key(&key) {
            return Ok(());
        }
        let handle = watch_configdir_credentials(
            local_account_id.to_string(),
            account_id.to_string(),
            configdir,
        )?;
        let total_watchers = guard.len() + 1;
        log::info!(
            "credential watcher started for local_account={} account={} configdir={:?} (total watchers={})",
            handle.local_account_id,
            handle.account_id,
            handle.configdir,
            total_watchers
        );
        guard.insert(key, handle);
        Ok(())
    }

    /// Stop watching `account_id` if a watcher is registered. No-op
    /// otherwise.
    pub fn stop_watching(&self, local_account_id: &str, account_id: &str) {
        let mut guard = self.inner.lock();
        if let Some(handle) = guard.remove(&watcher_key(local_account_id, account_id)) {
            let obs = handle.events_observed.load(Ordering::SeqCst);
            let rot = handle.rotations_applied.load(Ordering::SeqCst);
            let remaining = guard.len();
            let empty = guard.is_empty();
            log::info!(
                "credential watcher stopped for local_account={} account={} (observed={} rotations={} remaining={} empty={})",
                handle.local_account_id,
                handle.account_id,
                obs,
                rot,
                remaining,
                empty
            );
        }
    }

    /// Diagnostic — how many watchers are alive right now.
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.inner.lock().len()
    }

    /// Diagnostic — true when no watchers are registered.
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.inner.lock().is_empty()
    }
}

fn watcher_key(local_account_id: &str, account_id: &str) -> String {
    format!("{local_account_id}\0{account_id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    use std::sync::Mutex as StdMutex;

    /// Recording sink for tests — counts updates and stores the last
    /// payload so assertions can verify the writeback path.
    #[derive(Default)]
    struct RecordingSink {
        records: StdMutex<Vec<(String, ClaudeConfigCredentials)>>,
    }

    impl CredentialSink for RecordingSink {
        fn update(
            &self,
            local_account_id: &str,
            account_id: &str,
            fresh: &ClaudeConfigCredentials,
        ) -> Result<(), String> {
            let mut guard = self.records.lock().unwrap();
            guard.push((format!("{local_account_id}/{account_id}"), fresh.clone()));
            Ok(())
        }
    }

    fn write_credentials(path: &Path, refresh: &str) {
        let payload = format!(
            r#"{{"refreshToken":"{refresh}","accessToken":"at-{refresh}","expiresAtMs":1700000000000}}"#
        );
        std::fs::write(path, payload).unwrap();
    }

    fn wait_for(observed: &Arc<AtomicU64>, min: u64, deadline: std::time::Duration) {
        let started = std::time::Instant::now();
        while observed.load(Ordering::SeqCst) < min {
            if started.elapsed() > deadline {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    #[test]
    fn writeback_fires_on_credentials_change() {
        let dir = tempfile::tempdir().unwrap();
        let cred_path = dir.path().join(".credentials.json");
        write_credentials(&cred_path, "rt-original");

        let sink = Arc::new(RecordingSink::default());
        let handle = watch_configdir_with(
            "local-a".into(),
            "acc-a".into(),
            dir.path().to_path_buf(),
            Arc::clone(&sink),
            0, // disable debounce for the test
        )
        .unwrap();

        // Trigger a write — this should land in the sink.
        write_credentials(&cred_path, "rt-rotated");
        // Notify is async — give it up to 2s on slow filesystems.
        wait_for(
            &handle.events_observed,
            1,
            std::time::Duration::from_secs(2),
        );
        wait_for(
            &handle.rotations_applied,
            1,
            std::time::Duration::from_secs(2),
        );

        let records = sink.records.lock().unwrap();
        assert!(records
            .iter()
            .any(|(acc, c)| acc == "local-a/acc-a" && c.refresh_token == "rt-rotated"));
        drop(handle);
    }

    #[test]
    fn read_credentials_parses_both_camel_and_snake_case() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".credentials.json");
        std::fs::write(
            &path,
            r#"{"refresh_token":"rt-snake","access_token":"at-snake","expires_at_ms":42}"#,
        )
        .unwrap();
        let got = read_credentials(&path).unwrap();
        assert_eq!(got.refresh_token, "rt-snake");
        assert_eq!(got.access_token, "at-snake");
        assert_eq!(got.expires_at_ms, 42);
    }

    #[test]
    fn watcher_skips_unrelated_files() {
        let dir = tempfile::tempdir().unwrap();
        let cred_path = dir.path().join(".credentials.json");
        write_credentials(&cred_path, "rt-init");
        let sink = Arc::new(RecordingSink::default());
        let handle = watch_configdir_with(
            "local-a".into(),
            "acc-b".into(),
            dir.path().to_path_buf(),
            Arc::clone(&sink),
            0,
        )
        .unwrap();

        // Touching an unrelated file must not fire the writeback.
        let unrelated = dir.path().join("scratch.txt");
        std::fs::write(&unrelated, b"hi").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(150));
        let records = sink.records.lock().unwrap();
        assert!(
            records.is_empty(),
            "unexpected writeback for unrelated file"
        );
        drop(handle);
    }

    #[test]
    fn debounce_collapses_burst_writes() {
        let dir = tempfile::tempdir().unwrap();
        let cred_path = dir.path().join(".credentials.json");
        write_credentials(&cred_path, "rt-init");

        let sink = Arc::new(RecordingSink::default());
        let handle = watch_configdir_with(
            "local-a".into(),
            "acc-c".into(),
            dir.path().to_path_buf(),
            Arc::clone(&sink),
            500, // 500ms debounce
        )
        .unwrap();

        // Two rapid writes within the debounce window should collapse to 1.
        write_credentials(&cred_path, "rt-r1");
        write_credentials(&cred_path, "rt-r2");
        std::thread::sleep(std::time::Duration::from_millis(150));
        let records = sink.records.lock().unwrap();
        assert!(
            records.len() <= 1,
            "debounce failed: {} writebacks",
            records.len()
        );
        drop(handle);
    }
}
