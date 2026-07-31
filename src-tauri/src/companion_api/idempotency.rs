//! Durable, cross-transport idempotency ledger for companion RPC writes.
//!
//! Entries are uniquely identified by `(device_id, method, idempotency_key)`.
//! The request parameter digest is stored with the entry so reusing a key for
//! different arguments is rejected. A request is recorded as pending before
//! dispatch and completed only after a successful result is available. Pending
//! entries are never replayed: after a crash, or while another transport is
//! executing the same command, callers receive `idempotency_indeterminate`.

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DEFAULT_CAPACITY: usize = 10_000;
const DEFAULT_TTL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Debug, Clone, PartialEq)]
pub enum IdempotencyDecision {
    Execute,
    Cached(Value),
    Conflict,
    Indeterminate,
}

#[derive(Debug, thiserror::Error)]
pub enum IdempotencyError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("stored idempotency response is invalid JSON: {0}")]
    InvalidResponse(#[from] serde_json::Error),
    #[error("idempotency ledger is full of in-flight commands")]
    Capacity,
    #[error("idempotency reservation disappeared before completion")]
    MissingReservation,
}

#[derive(Clone)]
struct MemoryEntry {
    params_digest: String,
    status: EntryStatus,
    response: Option<Value>,
    updated_at_ms: i64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EntryStatus {
    Pending,
    Complete,
}

struct LedgerInner {
    memory: HashMap<(String, String, String), MemoryEntry>,
    order: VecDeque<(String, String, String)>,
    database: Option<Connection>,
}

/// Thread-safe ledger shared by the HTTPS and WebRTC dispatch paths.
pub struct IdempotencyCache {
    inner: Mutex<LedgerInner>,
    capacity: usize,
    ttl: Duration,
}

impl IdempotencyCache {
    /// In-memory ledger for tests and short-lived harnesses.
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_CAPACITY, DEFAULT_TTL)
    }

    pub fn with_capacity(capacity: usize, ttl: Duration) -> Self {
        Self {
            inner: Mutex::new(LedgerInner {
                memory: HashMap::new(),
                order: VecDeque::new(),
                database: None,
            }),
            capacity,
            ttl,
        }
    }

    /// Open a persistent ledger. Schema creation is additive and idempotent.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, IdempotencyError> {
        let connection = Connection::open(path)?;
        Self::from_connection(connection, DEFAULT_CAPACITY, DEFAULT_TTL)
    }

    #[cfg(test)]
    fn in_memory_persistent() -> Result<Self, IdempotencyError> {
        Self::from_connection(Connection::open_in_memory()?, DEFAULT_CAPACITY, DEFAULT_TTL)
    }

    fn from_connection(
        connection: Connection,
        capacity: usize,
        ttl: Duration,
    ) -> Result<Self, IdempotencyError> {
        connection.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS rpc_idempotency (
                device_id TEXT NOT NULL,
                method TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                params_digest TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending', 'complete')),
                response_json TEXT,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY (device_id, method, idempotency_key)
            );
            CREATE INDEX IF NOT EXISTS rpc_idempotency_updated_at
                ON rpc_idempotency(updated_at_ms);
            ",
        )?;
        Ok(Self {
            inner: Mutex::new(LedgerInner {
                memory: HashMap::new(),
                order: VecDeque::new(),
                database: Some(connection),
            }),
            capacity,
            ttl,
        })
    }

    /// Atomically reserve a command before it is dispatched.
    pub fn begin(
        &self,
        device_id: &str,
        method: &str,
        key: &str,
        params: &Value,
    ) -> Result<IdempotencyDecision, IdempotencyError> {
        let digest = params_digest(params);
        let now_ms = unix_time_ms();
        let expires_before = now_ms.saturating_sub(duration_ms(self.ttl));
        let mut inner = self.inner.lock();

        if let Some(database) = inner.database.as_mut() {
            database.execute(
                "DELETE FROM rpc_idempotency WHERE updated_at_ms <= ?1",
                [expires_before],
            )?;
            let stored = database
                .query_row(
                    "SELECT params_digest, status, response_json
                     FROM rpc_idempotency
                     WHERE device_id = ?1 AND method = ?2 AND idempotency_key = ?3",
                    params![device_id, method, key],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .optional()?;
            if let Some((stored_digest, status, response_json)) = stored {
                if stored_digest != digest {
                    return Ok(IdempotencyDecision::Conflict);
                }
                if status == "complete" {
                    let response =
                        serde_json::from_str(response_json.as_deref().unwrap_or("null"))?;
                    return Ok(IdempotencyDecision::Cached(response));
                }
                return Ok(IdempotencyDecision::Indeterminate);
            }

            enforce_database_capacity(database, self.capacity)?;
            database.execute(
                "INSERT INTO rpc_idempotency
                 (device_id, method, idempotency_key, params_digest, status,
                  response_json, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, 'pending', NULL, ?5, ?5)",
                params![device_id, method, key, digest, now_ms],
            )?;
            return Ok(IdempotencyDecision::Execute);
        }

        purge_memory_expired(&mut inner, expires_before);
        let map_key = (device_id.to_owned(), method.to_owned(), key.to_owned());
        if let Some(entry) = inner.memory.get(&map_key) {
            if entry.params_digest != digest {
                return Ok(IdempotencyDecision::Conflict);
            }
            return Ok(match entry.status {
                EntryStatus::Pending => IdempotencyDecision::Indeterminate,
                EntryStatus::Complete => {
                    IdempotencyDecision::Cached(entry.response.clone().unwrap_or(Value::Null))
                }
            });
        }

        while inner.memory.len() >= self.capacity {
            let Some(index) = inner.order.iter().position(|candidate| {
                inner
                    .memory
                    .get(candidate)
                    .is_some_and(|entry| entry.status == EntryStatus::Complete)
            }) else {
                return Err(IdempotencyError::Capacity);
            };
            if let Some(oldest_complete) = inner.order.remove(index) {
                inner.memory.remove(&oldest_complete);
            }
        }
        inner.order.push_back(map_key.clone());
        inner.memory.insert(
            map_key,
            MemoryEntry {
                params_digest: digest,
                status: EntryStatus::Pending,
                response: None,
                updated_at_ms: now_ms,
            },
        );
        Ok(IdempotencyDecision::Execute)
    }

    /// Commit the successful result for a previously reserved command.
    pub fn complete(
        &self,
        device_id: &str,
        method: &str,
        key: &str,
        response: &Value,
    ) -> Result<(), IdempotencyError> {
        let now_ms = unix_time_ms();
        let mut inner = self.inner.lock();
        if let Some(database) = inner.database.as_mut() {
            let response_json = serde_json::to_string(response)?;
            let updated = database.execute(
                "UPDATE rpc_idempotency
                 SET status = 'complete', response_json = ?4, updated_at_ms = ?5
                 WHERE device_id = ?1 AND method = ?2 AND idempotency_key = ?3",
                params![device_id, method, key, response_json, now_ms],
            )?;
            if updated == 0 {
                return Err(IdempotencyError::MissingReservation);
            }
            return Ok(());
        }

        let Some(entry) =
            inner
                .memory
                .get_mut(&(device_id.to_owned(), method.to_owned(), key.to_owned()))
        else {
            return Err(IdempotencyError::MissingReservation);
        };
        entry.status = EntryStatus::Complete;
        entry.response = Some(response.clone());
        entry.updated_at_ms = now_ms;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        let inner = self.inner.lock();
        if let Some(database) = inner.database.as_ref() {
            return database
                .query_row("SELECT COUNT(*) FROM rpc_idempotency", [], |row| row.get(0))
                .unwrap_or(0);
        }
        inner.memory.len()
    }
}

impl Default for IdempotencyCache {
    fn default() -> Self {
        Self::new()
    }
}

fn params_digest(value: &Value) -> String {
    let mut bytes = Vec::new();
    write_canonical_json(value, &mut bytes);
    hex::encode(Sha256::digest(bytes))
}

fn write_canonical_json(value: &Value, output: &mut Vec<u8>) {
    match value {
        Value::Null => output.push(b'n'),
        Value::Bool(value) => {
            output.push(b'b');
            output.push(u8::from(*value));
        }
        Value::Number(value) => {
            output.push(b'#');
            write_length_prefixed(value.to_string().as_bytes(), output);
        }
        Value::String(value) => {
            output.push(b's');
            write_length_prefixed(value.as_bytes(), output);
        }
        Value::Array(values) => {
            output.push(b'[');
            output.extend_from_slice(&(values.len() as u64).to_be_bytes());
            for value in values {
                write_canonical_json(value, output);
            }
        }
        Value::Object(values) => {
            output.push(b'{');
            output.extend_from_slice(&(values.len() as u64).to_be_bytes());
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            for key in keys {
                write_length_prefixed(key.as_bytes(), output);
                write_canonical_json(&values[key], output);
            }
        }
    }
}

fn write_length_prefixed(value: &[u8], output: &mut Vec<u8>) {
    output.extend_from_slice(&(value.len() as u64).to_be_bytes());
    output.extend_from_slice(value);
}

fn unix_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn duration_ms(duration: Duration) -> i64 {
    duration.as_millis().try_into().unwrap_or(i64::MAX)
}

fn purge_memory_expired(inner: &mut LedgerInner, expires_before: i64) {
    inner
        .memory
        .retain(|_, entry| entry.updated_at_ms > expires_before);
    inner.order.retain(|key| inner.memory.contains_key(key));
}

fn enforce_database_capacity(
    database: &Connection,
    capacity: usize,
) -> Result<(), IdempotencyError> {
    let count: usize =
        database.query_row("SELECT COUNT(*) FROM rpc_idempotency", [], |row| row.get(0))?;
    if count >= capacity {
        let remove_count = count - capacity + 1;
        let removed = database.execute(
            "DELETE FROM rpc_idempotency
             WHERE rowid IN (
                 SELECT rowid FROM rpc_idempotency
                 WHERE status = 'complete'
                 ORDER BY updated_at_ms ASC
                 LIMIT ?1
             )",
            [remove_count],
        )?;
        if removed < remove_count {
            return Err(IdempotencyError::Capacity);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reserves_then_replays_completed_result() {
        let cache = IdempotencyCache::new();
        assert_eq!(
            cache
                .begin("dev", "write", "k1", &json!({"value": 1}))
                .unwrap(),
            IdempotencyDecision::Execute
        );
        cache
            .complete("dev", "write", "k1", &json!({"ok": true}))
            .unwrap();
        assert_eq!(
            cache
                .begin("dev", "write", "k1", &json!({"value": 1}))
                .unwrap(),
            IdempotencyDecision::Cached(json!({"ok": true}))
        );
    }

    #[test]
    fn same_key_with_different_params_conflicts() {
        let cache = IdempotencyCache::new();
        cache
            .begin("dev", "write", "k1", &json!({"value": 1}))
            .unwrap();
        assert_eq!(
            cache
                .begin("dev", "write", "k1", &json!({"value": 2}))
                .unwrap(),
            IdempotencyDecision::Conflict
        );
    }

    #[test]
    fn pending_entry_is_indeterminate() {
        let cache = IdempotencyCache::new();
        cache.begin("dev", "write", "k1", &json!({})).unwrap();
        assert_eq!(
            cache.begin("dev", "write", "k1", &json!({})).unwrap(),
            IdempotencyDecision::Indeterminate
        );
    }

    #[test]
    fn method_is_part_of_unique_key() {
        let cache = IdempotencyCache::new();
        assert_eq!(
            cache.begin("dev", "write-a", "k1", &json!({})).unwrap(),
            IdempotencyDecision::Execute
        );
        assert_eq!(
            cache.begin("dev", "write-b", "k1", &json!({})).unwrap(),
            IdempotencyDecision::Execute
        );
    }

    #[test]
    fn capacity_evicts_oldest_completed_entry() {
        let cache = IdempotencyCache::with_capacity(2, Duration::from_secs(60));
        cache.begin("dev", "write", "k1", &json!({})).unwrap();
        cache.complete("dev", "write", "k1", &json!(1)).unwrap();
        cache.begin("dev", "write", "k2", &json!({})).unwrap();
        cache.begin("dev", "write", "k3", &json!({})).unwrap();
        assert_eq!(cache.len(), 2);
        cache.complete("dev", "write", "k2", &json!(2)).unwrap();
        assert_eq!(
            cache.begin("dev", "write", "k1", &json!({})).unwrap(),
            IdempotencyDecision::Execute
        );
    }

    #[test]
    fn capacity_never_evicts_pending_entries() {
        let cache = IdempotencyCache::with_capacity(2, Duration::from_secs(60));
        cache.begin("dev", "write", "k1", &json!({})).unwrap();
        cache.begin("dev", "write", "k2", &json!({})).unwrap();
        assert!(matches!(
            cache.begin("dev", "write", "k3", &json!({})),
            Err(IdempotencyError::Capacity)
        ));
        assert_eq!(cache.len(), 2);
        assert_eq!(
            cache.begin("dev", "write", "k1", &json!({})).unwrap(),
            IdempotencyDecision::Indeterminate
        );
    }

    #[test]
    fn persistent_capacity_never_evicts_pending_entries() {
        let cache = IdempotencyCache::from_connection(
            Connection::open_in_memory().unwrap(),
            1,
            Duration::from_secs(60),
        )
        .unwrap();
        cache.begin("dev", "write", "k1", &json!({})).unwrap();
        assert!(matches!(
            cache.begin("dev", "write", "k2", &json!({})),
            Err(IdempotencyError::Capacity)
        ));
        assert_eq!(
            cache.begin("dev", "write", "k1", &json!({})).unwrap(),
            IdempotencyDecision::Indeterminate
        );
    }

    #[test]
    fn object_key_order_does_not_change_parameter_identity() {
        let cache = IdempotencyCache::new();
        cache
            .begin(
                "dev",
                "write",
                "k1",
                &json!({"a": 1, "b": {"x": 2, "y": 3}}),
            )
            .unwrap();
        cache
            .complete("dev", "write", "k1", &json!({"ok": true}))
            .unwrap();

        let reordered: Value = serde_json::from_str(r#"{"b":{"y":3,"x":2},"a":1}"#).unwrap();
        assert_eq!(
            cache.begin("dev", "write", "k1", &reordered).unwrap(),
            IdempotencyDecision::Cached(json!({"ok": true}))
        );
    }

    #[test]
    fn completing_unknown_reservation_is_rejected() {
        let cache = IdempotencyCache::new();
        assert!(matches!(
            cache.complete("dev", "write", "missing", &json!(null)),
            Err(IdempotencyError::MissingReservation)
        ));
    }

    #[test]
    fn expired_entry_can_be_reserved_again() {
        let cache = IdempotencyCache::with_capacity(10, Duration::ZERO);
        cache.begin("dev", "write", "k1", &json!({})).unwrap();
        std::thread::sleep(Duration::from_millis(2));
        assert_eq!(
            cache.begin("dev", "write", "k1", &json!({})).unwrap(),
            IdempotencyDecision::Execute
        );
    }

    #[test]
    fn persistent_pending_survives_restart_and_is_indeterminate() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("idempotency.sqlite");
        {
            let cache = IdempotencyCache::open(&path).unwrap();
            cache.begin("dev", "write", "k1", &json!({"a": 1})).unwrap();
        }
        let reopened = IdempotencyCache::open(&path).unwrap();
        assert_eq!(
            reopened
                .begin("dev", "write", "k1", &json!({"a": 1}))
                .unwrap(),
            IdempotencyDecision::Indeterminate
        );
    }

    #[test]
    fn persistent_completed_result_survives_restart() {
        let cache = IdempotencyCache::in_memory_persistent().unwrap();
        cache.begin("dev", "write", "k1", &json!({})).unwrap();
        cache.complete("dev", "write", "k1", &json!(42)).unwrap();
        assert_eq!(
            cache.begin("dev", "write", "k1", &json!({})).unwrap(),
            IdempotencyDecision::Cached(json!(42))
        );
    }
}
