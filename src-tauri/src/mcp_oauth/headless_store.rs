//! Account-scoped attempt state and serialized token storage for Headless OAuth.

use std::collections::{HashMap, HashSet};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use rand::{rngs::OsRng, RngCore};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{clear, load, save, McpAuthEntry};

const HEADLESS_ATTEMPT_TTL_MS: i64 = 180_000;
const MAX_HEADLESS_ATTEMPTS: usize = 64;

#[derive(Clone)]
pub(super) struct HeadlessAttempt {
    pub(super) attempt_id: String,
    pub(super) account_id: String,
    pub(super) server_name: String,
    pub(super) storage_key: String,
    pub(super) server: Value,
    pub(super) state: String,
    state_hash: String,
    pub(super) redirect_url: String,
    pub(super) authorization_url: String,
    pub(super) expires_at_ms: i64,
    pub(super) status: String,
}

impl HeadlessAttempt {
    pub(super) fn pending(
        attempt_id: String,
        account_id: String,
        server_name: String,
        storage_key: String,
        server: Value,
        state: String,
        redirect_url: String,
        authorization_url: String,
        expires_at_ms: i64,
    ) -> Self {
        let state_hash = hash_state(&state);
        Self {
            attempt_id,
            account_id,
            server_name,
            storage_key,
            server,
            state,
            state_hash,
            redirect_url,
            authorization_url,
            expires_at_ms,
            status: "pending".to_string(),
        }
    }
}

#[derive(Default)]
struct HeadlessAttemptStore {
    by_id: HashMap<String, HeadlessAttempt>,
    by_state: HashMap<String, String>,
    by_owner: HashMap<(String, String), String>,
    inflight: HashMap<(String, String), HashSet<String>>,
}

impl HeadlessAttemptStore {
    fn remove(&mut self, attempt_id: &str) -> Option<HeadlessAttempt> {
        let attempt = self.by_id.remove(attempt_id)?;
        self.by_state.remove(&attempt.state_hash);
        self.by_owner
            .remove(&(attempt.account_id.clone(), attempt.server_name.clone()));
        Some(attempt)
    }

    fn expire(&mut self, current_ms: i64) {
        let expired = self
            .by_id
            .values()
            .filter(|attempt| attempt.expires_at_ms <= current_ms)
            .map(|attempt| attempt.attempt_id.clone())
            .collect::<Vec<_>>();
        for attempt_id in expired {
            self.remove(&attempt_id);
        }
    }

    fn insert(&mut self, attempt: HeadlessAttempt) -> Result<(), String> {
        self.expire(now_ms());
        if let Some(previous) = self
            .by_owner
            .get(&(attempt.account_id.clone(), attempt.server_name.clone()))
            .cloned()
        {
            self.remove(&previous);
        }
        if self.by_id.len() >= MAX_HEADLESS_ATTEMPTS {
            return Err("too many concurrent MCP OAuth attempts".to_string());
        }
        self.by_state
            .insert(attempt.state_hash.clone(), attempt.attempt_id.clone());
        self.by_owner.insert(
            (attempt.account_id.clone(), attempt.server_name.clone()),
            attempt.attempt_id.clone(),
        );
        self.by_id.insert(attempt.attempt_id.clone(), attempt);
        Ok(())
    }

    fn begin_inflight(
        &mut self,
        account_id: &str,
        server_name: &str,
        token: &str,
    ) -> Result<(), String> {
        self.expire(now_ms());
        let inflight_count = self.inflight.values().map(HashSet::len).sum::<usize>();
        if self.by_id.len().saturating_add(inflight_count) >= MAX_HEADLESS_ATTEMPTS {
            return Err("too many concurrent MCP OAuth attempts".to_string());
        }
        self.inflight
            .entry((account_id.to_string(), server_name.to_string()))
            .or_default()
            .insert(token.to_string());
        Ok(())
    }

    fn is_inflight(&self, account_id: &str, server_name: &str, token: &str) -> bool {
        self.inflight
            .get(&(account_id.to_string(), server_name.to_string()))
            .is_some_and(|tokens| tokens.contains(token))
    }

    fn finish_inflight(&mut self, account_id: &str, server_name: &str, token: &str) {
        let owner = (account_id.to_string(), server_name.to_string());
        let remove_owner = self.inflight.get_mut(&owner).is_some_and(|tokens| {
            tokens.remove(token);
            tokens.is_empty()
        });
        if remove_owner {
            self.inflight.remove(&owner);
        }
    }

    fn cancel_owner(&mut self, account_id: &str, server_name: &str) {
        let owner = (account_id.to_string(), server_name.to_string());
        self.inflight.remove(&owner);
        if let Some(attempt_id) = self.by_owner.get(&owner).cloned() {
            self.remove(&attempt_id);
        }
    }

    fn consume_state(&mut self, state: &str, current_ms: i64) -> Option<HeadlessAttempt> {
        self.expire(current_ms);
        let attempt_id = self.by_state.remove(&hash_state(state))?;
        let attempt = self.by_id.get_mut(&attempt_id)?;
        if attempt.state != state || attempt.status != "pending" {
            return None;
        }
        attempt.status = "exchanging".to_string();
        Some(attempt.clone())
    }
}

static ATTEMPTS: Lazy<Mutex<HeadlessAttemptStore>> =
    Lazy::new(|| Mutex::new(HeadlessAttemptStore::default()));

pub(super) struct HeadlessInflightGuard {
    account_id: String,
    server_name: String,
    pub(super) token: String,
}

impl HeadlessInflightGuard {
    pub(super) fn begin(account_id: &str, server_name: &str) -> Result<Self, String> {
        let token = uuid::Uuid::new_v4().to_string();
        ATTEMPTS
            .lock()
            .begin_inflight(account_id, server_name, &token)?;
        Ok(Self {
            account_id: account_id.to_string(),
            server_name: server_name.to_string(),
            token,
        })
    }
}

impl Drop for HeadlessInflightGuard {
    fn drop(&mut self) {
        ATTEMPTS
            .lock()
            .finish_inflight(&self.account_id, &self.server_name, &self.token);
    }
}

const OWNER_STORAGE_LOCK_SHARDS: usize = 32;
static OWNER_STORAGE_LOCKS: Lazy<Vec<tokio::sync::Mutex<()>>> = Lazy::new(|| {
    (0..OWNER_STORAGE_LOCK_SHARDS)
        .map(|_| tokio::sync::Mutex::new(()))
        .collect()
});

pub(super) fn owner_storage_lock(
    account_id: &str,
    server_name: &str,
) -> &'static tokio::sync::Mutex<()> {
    let digest = Sha256::digest(format!("{account_id}\0{server_name}").as_bytes());
    &OWNER_STORAGE_LOCKS[usize::from(digest[0]) % OWNER_STORAGE_LOCK_SHARDS]
}

pub(super) fn current_attempt(account_id: &str, server_name: &str) -> Option<HeadlessAttempt> {
    let mut attempts = ATTEMPTS.lock();
    attempts.expire(now_ms());
    attempts
        .by_owner
        .get(&(account_id.to_string(), server_name.to_string()))
        .and_then(|attempt_id| attempts.by_id.get(attempt_id))
        .cloned()
}

pub(super) fn cancel_owner(account_id: &str, server_name: &str) {
    ATTEMPTS.lock().cancel_owner(account_id, server_name);
}

pub(super) fn ensure_inflight(
    account_id: &str,
    server_name: &str,
    token: &str,
) -> Result<(), String> {
    ATTEMPTS
        .lock()
        .is_inflight(account_id, server_name, token)
        .then_some(())
        .ok_or_else(|| "OAuth attempt was cleared".to_string())
}

pub(super) fn insert_if_inflight(
    account_id: &str,
    server_name: &str,
    token: &str,
    attempt: HeadlessAttempt,
) -> Result<(), String> {
    let mut attempts = ATTEMPTS.lock();
    if !attempts.is_inflight(account_id, server_name, token) {
        return Err("OAuth attempt was cleared".to_string());
    }
    attempts.insert(attempt)
}

pub(super) fn consume_state(state: &str) -> Option<HeadlessAttempt> {
    ATTEMPTS.lock().consume_state(state, now_ms())
}

pub(super) fn remove_attempt(attempt_id: &str) {
    ATTEMPTS.lock().remove(attempt_id);
}

pub(super) fn attempt_exists(attempt_id: &str) -> bool {
    ATTEMPTS.lock().by_id.contains_key(attempt_id)
}

pub(super) async fn load_entry(storage_key: String) -> Result<Option<McpAuthEntry>, String> {
    tokio::task::spawn_blocking(move || load(&storage_key))
        .await
        .map_err(|error| format!("OAuth storage task failed: {error}"))?
}

pub(super) async fn save_entry(storage_key: String, entry: McpAuthEntry) -> Result<(), String> {
    tokio::task::spawn_blocking(move || save(&storage_key, &entry))
        .await
        .map_err(|error| format!("OAuth storage task failed: {error}"))?
}

pub(super) async fn clear_entry(storage_key: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || clear(&storage_key))
        .await
        .map_err(|error| format!("OAuth storage task failed: {error}"))?
}

pub(super) fn new_state() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub(super) fn storage_key(account_id: &str, server_name: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update((account_id.len() as u64).to_be_bytes());
    hasher.update(account_id.as_bytes());
    hasher.update((server_name.len() as u64).to_be_bytes());
    hasher.update(server_name.as_bytes());
    format!("headless-{}", hex::encode(hasher.finalize()))
}

pub(super) fn expires_at_ms() -> i64 {
    now_ms().saturating_add(HEADLESS_ATTEMPT_TTL_MS)
}

fn hash_state(state: &str) -> String {
    hex::encode(Sha256::digest(state.as_bytes()))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attempt(account: &str, server: &str, id: &str, state: &str, expiry: i64) -> HeadlessAttempt {
        HeadlessAttempt::pending(
            id.to_string(),
            account.to_string(),
            server.to_string(),
            storage_key(account, server),
            serde_json::json!({"transport":"http","config":{"url":"https://mcp.example"}}),
            state.to_string(),
            "https://brain.example/integrations/mcp/oauth/callback".to_string(),
            "https://issuer.example/authorize".to_string(),
            expiry,
        )
    }

    #[test]
    fn state_is_256_bit_and_storage_is_account_scoped() {
        let first = new_state();
        let second = new_state();
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
        assert_ne!(
            storage_key("account-a", "server-a"),
            storage_key("account-b", "server-a")
        );
    }

    #[test]
    fn attempts_are_single_use_single_owner_and_expiring() {
        let future = now_ms().saturating_add(10_000);
        let mut store = HeadlessAttemptStore::default();
        store
            .insert(attempt("account-a", "server-a", "attempt-a", "a", future))
            .unwrap();
        store
            .insert(attempt("account-a", "server-a", "attempt-b", "b", future))
            .unwrap();
        assert!(!store.by_id.contains_key("attempt-a"));
        assert!(store.consume_state("a", now_ms()).is_none());
        assert_eq!(
            store.consume_state("b", now_ms()).unwrap().attempt_id,
            "attempt-b"
        );
        assert!(store.consume_state("b", now_ms()).is_none());

        store
            .insert(attempt("account-a", "server-b", "expired", "c", 1))
            .unwrap();
        assert!(store.consume_state("c", now_ms()).is_none());
    }

    #[test]
    fn clearing_an_owner_cancels_inflight_and_pending_attempts() {
        let mut store = HeadlessAttemptStore::default();
        store
            .begin_inflight("account-a", "server-a", "prepare-token")
            .unwrap();
        store
            .insert(attempt(
                "account-a",
                "server-a",
                "attempt-a",
                "state-a",
                now_ms().saturating_add(10_000),
            ))
            .unwrap();
        store.cancel_owner("account-a", "server-a");
        assert!(!store.is_inflight("account-a", "server-a", "prepare-token"));
        assert!(!store.by_id.contains_key("attempt-a"));
    }

    #[tokio::test]
    async fn storage_helpers_round_trip_off_the_async_worker() {
        let key = storage_key(
            "__cognia_test_headless_account__",
            &uuid::Uuid::new_v4().to_string(),
        );
        clear_entry(key.clone()).await.unwrap();
        let entry = McpAuthEntry {
            tokens: Some(serde_json::json!({ "access_token": "headless-round-trip" })),
            ..Default::default()
        };
        save_entry(key.clone(), entry).await.unwrap();
        assert_eq!(
            load_entry(key.clone())
                .await
                .unwrap()
                .and_then(|entry| entry.access_token()),
            Some("headless-round-trip".to_string())
        );
        clear_entry(key).await.unwrap();
    }
}
