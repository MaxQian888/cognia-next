//! Host-side SQLite backing for the Claude Agent SDK `SessionStore`
//! (ADR-0090 SDK-parity plan, Stage 4).
//!
//! # Why this lives in Rust
//!
//! The SDK's `sessionStore` is a live object with `append`/`load` methods, so
//! it must be constructed inside the sidecar. What it talks TO is this module,
//! reached over `host_rpc` — the channel Rust answers directly
//! (`claude/sidecar.rs::answer_host_rpc`). That choice is what makes the store
//! work identically on the desktop, under `cognia-server` (no renderer at all),
//! and when a phone is driving the desktop. Routing it through the renderer
//! instead would have made session persistence a desktop-only feature.
//!
//! # What is stored
//!
//! A MIRROR of the CLI's own JSONL transcripts, nothing more. ADR-0090 R1: we
//! do not fabricate private Claude session files, and there is no
//! create-from-external-messages path here — `append` only ever receives what
//! the subprocess already wrote to disk. Losing this database costs history
//! browsing, never a session.
//!
//! # Isolation
//!
//! The SDK's `SessionKey` carries only `projectKey` / `sessionId` / `subpath`.
//! Tenant and workspace are supplied SEPARATELY by the sidecar from the
//! session's own context and form the leading columns of every primary key, so
//! they cannot be spoofed through a crafted `projectKey`: a caller that lies
//! about `projectKey` still cannot read another tenant's rows, because it never
//! gets to name the tenant.
//!
//! # At rest
//!
//! Rows are plaintext JSON, and the file is created 0600 on unix. This matches
//! the CLI's own transcripts, which are plaintext under `~/.claude` — encrypting
//! the mirror while the original sits unencrypted next to it would buy nothing.
//! Secrets never reach here in the first place: transcript entries carry
//! messages, and credentials travel as refs (ADR-0090 constraint 4).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use rusqlite::{
    params, types::Type, Connection, OpenFlags, OptionalExtension, Row, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

mod dispatch;
pub use dispatch::configured_store;
pub use dispatch::{configure_path, dispatch_host_rpc, is_session_store_method};

/// Default retention for mirrored sessions. Deliberately generous: this is a
/// browse-history convenience, and a user who resumes a months-old session
/// would be very surprised to find it gone. Overridable per open.
pub const DEFAULT_RETENTION_DAYS: u32 = 180;

/// Scope columns the sidecar supplies alongside every SDK `SessionKey`.
///
/// `tenant` and `workspace` are NOT part of the SDK key — see the module
/// docblock. Both default to `"default"` on a single-tenant desktop install so
/// the schema is identical everywhere and a deployment can start scoping
/// without a migration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreScope {
    #[serde(default = "default_scope_part")]
    pub tenant: String,
    #[serde(default = "default_scope_part")]
    pub workspace: String,
}

fn default_scope_part() -> String {
    "default".to_string()
}

impl Default for StoreScope {
    fn default() -> Self {
        Self {
            tenant: default_scope_part(),
            workspace: default_scope_part(),
        }
    }
}

/// The SDK's `SessionKey`, plus the host-supplied scope.
///
/// `subpath` is `None` for the main transcript and `Some("subagents/agent-…")`
/// for a subagent's. It is stored as `""` rather than NULL so it can sit in a
/// primary key without the NULL-never-equals-NULL problem, which would let the
/// same main transcript be inserted twice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionKey {
    #[serde(flatten, default)]
    pub scope: StoreScope,
    pub project_key: String,
    pub session_id: String,
    #[serde(default)]
    pub subpath: Option<String>,
}

impl SessionKey {
    /// Storage form of `subpath`. Empty string = main transcript.
    fn subpath_column(&self) -> &str {
        match self.subpath.as_deref() {
            // An empty `subpath` is invalid per the SDK contract ("omit the
            // field for the main transcript"), and treating it as a distinct
            // key would silently split one transcript in two.
            Some("") | None => "",
            Some(s) => s,
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.project_key.is_empty() {
            return Err("sessionStore: projectKey must be non-empty".into());
        }
        if self.session_id.is_empty() {
            return Err("sessionStore: sessionId must be non-empty".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListRow {
    pub session_id: String,
    pub mtime: i64,
}

/// A `SessionSummaryEntry` as the SDK defines it, plus the CAS version.
///
/// `data` is opaque SDK-owned state: the store persists it verbatim and never
/// interprets it. `version` is ours — see [`SessionStore::write_summary`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryRow {
    pub session_id: String,
    pub mtime: i64,
    pub data: Value,
    pub version: i64,
}

/// Persisted ACP-to-SDK session catalog row. This is additive to the SDK
/// transcript mirror and intentionally uses the same tenant/workspace scope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpSessionRow {
    pub acp_session_id: String,
    pub sdk_session_id: Option<String>,
    pub cwd: String,
    pub additional_directories: Vec<String>,
    pub title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub config_values: Value,
    pub lifecycle: String,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn decode_acp_session_row(row: &Row<'_>) -> rusqlite::Result<AcpSessionRow> {
    let additional: String = row.get(3)?;
    let config: String = row.get(7)?;
    let additional_directories = serde_json::from_str(&additional).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(3, Type::Text, Box::new(error))
    })?;
    let config_values = serde_json::from_str(&config).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(7, Type::Text, Box::new(error))
    })?;
    Ok(AcpSessionRow {
        acp_session_id: row.get(0)?,
        sdk_session_id: row.get(1)?,
        cwd: row.get(2)?,
        additional_directories,
        title: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        config_values,
        lifecycle: row.get(8)?,
    })
}

const SCHEMA_SQL: &str = "
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS entries (
        tenant      TEXT    NOT NULL,
        workspace   TEXT    NOT NULL,
        project_key TEXT    NOT NULL,
        session_id  TEXT    NOT NULL,
        subpath     TEXT    NOT NULL,
        sequence    INTEGER NOT NULL,
        uuid        TEXT,
        entry_type  TEXT    NOT NULL,
        payload     TEXT    NOT NULL,
        written_at  INTEGER NOT NULL,
        PRIMARY KEY (tenant, workspace, project_key, session_id, subpath, sequence)
    );

    -- Idempotency, per the SDK contract: `uuid` is an upsert key so retries and
    -- `importSessionToStore()` replays cannot duplicate a row. PARTIAL, because
    -- entries legitimately without a uuid (titles, tags, mode markers) must
    -- still append — a plain UNIQUE would collapse all of them into one row.
    CREATE UNIQUE INDEX IF NOT EXISTS entries_uuid_idem
        ON entries (tenant, workspace, project_key, session_id, subpath, uuid)
        WHERE uuid IS NOT NULL;

    CREATE INDEX IF NOT EXISTS entries_session
        ON entries (tenant, workspace, project_key, session_id, written_at DESC);

    CREATE TABLE IF NOT EXISTS summaries (
        tenant      TEXT    NOT NULL,
        workspace   TEXT    NOT NULL,
        project_key TEXT    NOT NULL,
        session_id  TEXT    NOT NULL,
        mtime       INTEGER NOT NULL,
        data        TEXT    NOT NULL,
        version     INTEGER NOT NULL,
        PRIMARY KEY (tenant, workspace, project_key, session_id)
    );

    CREATE TABLE IF NOT EXISTS acp_sessions (
        tenant                 TEXT NOT NULL,
        workspace              TEXT NOT NULL,
        acp_session_id         TEXT NOT NULL,
        sdk_session_id         TEXT,
        cwd                    TEXT NOT NULL,
        additional_directories TEXT NOT NULL,
        title                  TEXT,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL,
        config_values          TEXT NOT NULL,
        lifecycle              TEXT NOT NULL,
        PRIMARY KEY (tenant, workspace, acp_session_id)
    );

    CREATE INDEX IF NOT EXISTS acp_sessions_visible
        ON acp_sessions (tenant, workspace, cwd, updated_at DESC);
";

/// SQLite-backed session mirror.
///
/// One serialized writer and one serialized reader, not an unbounded pool.
/// WAL lets a long transcript restore or backup proceed without holding up
/// appends. Multi-statement reads use snapshots; read-modify-write transactions
/// acquire the SQLite writer reservation before reading, including across hosts
/// sharing the same local file. Neither connection relaxes commit durability.
pub struct SessionStore {
    conn: Arc<Mutex<Connection>>,
    read_conn: Arc<Mutex<Connection>>,
    path: Option<PathBuf>,
    #[cfg(test)]
    read_started: Mutex<Option<ReadStartSignal>>,
}

#[cfg(test)]
type ReadStartSignal = (
    std::sync::mpsc::SyncSender<()>,
    Option<std::sync::mpsc::Receiver<()>>,
);

impl SessionStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Arc<Self>, String> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("sessionStore: mkdir: {e}"))?;
        }
        let conn = Connection::open(&path).map_err(|e| format!("sessionStore: open: {e}"))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| format!("sessionStore: busy timeout: {e}"))?;
        conn.execute_batch(SCHEMA_SQL)
            .map_err(|e| format!("sessionStore: schema: {e}"))?;
        restrict_permissions(&path);
        let reader = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| format!("sessionStore: open reader: {e}"))?;
        reader
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| format!("sessionStore: reader busy timeout: {e}"))?;
        Ok(Arc::new(Self {
            conn: Arc::new(Mutex::new(conn)),
            read_conn: Arc::new(Mutex::new(reader)),
            path: Some(path),
            #[cfg(test)]
            read_started: Mutex::new(None),
        }))
    }

    /// In-memory store for tests. Same schema, no retention timer.
    #[cfg(test)]
    pub fn in_memory() -> Result<Arc<Self>, String> {
        let conn = Connection::open_in_memory().map_err(|e| format!("sessionStore: open: {e}"))?;
        conn.execute_batch(SCHEMA_SQL)
            .map_err(|e| format!("sessionStore: schema: {e}"))?;
        let conn = Arc::new(Mutex::new(conn));
        Ok(Arc::new(Self {
            read_conn: Arc::clone(&conn),
            conn,
            path: None,
            read_started: Mutex::new(None),
        }))
    }

    pub fn upsert_acp_session(
        &self,
        scope: &StoreScope,
        row: &AcpSessionRow,
    ) -> Result<(), String> {
        let additional = serde_json::to_string(&row.additional_directories)
            .map_err(|e| format!("sessionStore: encode ACP directories: {e}"))?;
        let config = serde_json::to_string(&row.config_values)
            .map_err(|e| format!("sessionStore: encode ACP config: {e}"))?;
        self.conn
            .lock()
            .execute(
                "INSERT INTO acp_sessions (
                    tenant, workspace, acp_session_id, sdk_session_id, cwd,
                    additional_directories, title, created_at, updated_at,
                    config_values, lifecycle
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT (tenant, workspace, acp_session_id) DO UPDATE SET
                    sdk_session_id = excluded.sdk_session_id,
                    cwd = excluded.cwd,
                    additional_directories = excluded.additional_directories,
                    title = excluded.title,
                    updated_at = excluded.updated_at,
                    config_values = excluded.config_values,
                    lifecycle = excluded.lifecycle",
                params![
                    scope.tenant,
                    scope.workspace,
                    row.acp_session_id,
                    row.sdk_session_id,
                    row.cwd,
                    additional,
                    row.title,
                    row.created_at,
                    row.updated_at,
                    config,
                    row.lifecycle,
                ],
            )
            .map_err(|e| format!("sessionStore: upsert ACP session: {e}"))?;
        Ok(())
    }

    pub fn get_acp_session(
        &self,
        scope: &StoreScope,
        acp_session_id: &str,
    ) -> Result<Option<AcpSessionRow>, String> {
        self.read_conn
            .lock()
            .query_row(
                "SELECT acp_session_id, sdk_session_id, cwd, additional_directories,
                        title, created_at, updated_at, config_values, lifecycle
                   FROM acp_sessions
                  WHERE tenant = ?1 AND workspace = ?2 AND acp_session_id = ?3",
                params![scope.tenant, scope.workspace, acp_session_id],
                decode_acp_session_row,
            )
            .optional()
            .map_err(|e| format!("sessionStore: get ACP session: {e}"))
    }

    pub fn list_acp_sessions(
        &self,
        scope: &StoreScope,
        cwd: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<AcpSessionRow>, String> {
        let guard = self.read_conn.lock();
        let sql = if cwd.is_some() {
            "SELECT acp_session_id, sdk_session_id, cwd, additional_directories,
                    title, created_at, updated_at, config_values, lifecycle
               FROM acp_sessions
              WHERE tenant = ?1 AND workspace = ?2 AND cwd = ?3
              ORDER BY updated_at DESC LIMIT ?4 OFFSET ?5"
        } else {
            "SELECT acp_session_id, sdk_session_id, cwd, additional_directories,
                    title, created_at, updated_at, config_values, lifecycle
               FROM acp_sessions
              WHERE tenant = ?1 AND workspace = ?2
              ORDER BY updated_at DESC LIMIT ?3 OFFSET ?4"
        };
        let mut statement = guard
            .prepare(sql)
            .map_err(|e| format!("sessionStore: prepare ACP list: {e}"))?;
        let rows = if let Some(cwd) = cwd {
            statement.query_map(
                params![
                    scope.tenant,
                    scope.workspace,
                    cwd,
                    limit as i64,
                    offset as i64
                ],
                decode_acp_session_row,
            )
        } else {
            statement.query_map(
                params![scope.tenant, scope.workspace, limit as i64, offset as i64],
                decode_acp_session_row,
            )
        }
        .map_err(|e| format!("sessionStore: list ACP sessions: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("sessionStore: decode ACP sessions: {e}"))
    }

    pub fn delete_acp_session(
        &self,
        scope: &StoreScope,
        acp_session_id: &str,
    ) -> Result<bool, String> {
        self.conn
            .lock()
            .execute(
                "DELETE FROM acp_sessions WHERE tenant = ?1 AND workspace = ?2 AND acp_session_id = ?3",
                params![scope.tenant, scope.workspace, acp_session_id],
            )
            .map(|removed| removed > 0)
            .map_err(|e| format!("sessionStore: delete ACP session: {e}"))
    }

    /// Mirror a batch. Returns how many rows were actually inserted.
    ///
    /// The whole batch is ONE transaction: a partially-applied batch would
    /// leave a transcript with a hole in the middle, which resume cannot
    /// detect and the user experiences as the model forgetting one exchange.
    ///
    /// Duplicates (same `uuid` in the same key) are ignored rather than
    /// rejected — the SDK retries a failed `append` up to three times, so a
    /// batch that partly landed before a timeout WILL be re-sent, and treating
    /// that as an error would turn a successful mirror into a `mirror_error`.
    pub fn append(&self, key: &SessionKey, entries: &[Value]) -> Result<usize, String> {
        key.validate()?;
        if entries.is_empty() {
            return Ok(0);
        }
        let subpath = key.subpath_column().to_string();
        let written_at = now_ms();

        let conn = Arc::clone(&self.conn);
        let mut guard = conn.lock();
        let tx = guard
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("sessionStore: begin: {e}"))?;

        // Next sequence is read INSIDE the transaction. Reading it outside
        // would let two concurrent batches pick the same number and collide on
        // the primary key.
        let mut next: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(sequence), -1) + 1 FROM entries
                 WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
                   AND session_id = ?4 AND subpath = ?5",
                params![
                    key.scope.tenant,
                    key.scope.workspace,
                    key.project_key,
                    key.session_id,
                    subpath
                ],
                |row| row.get(0),
            )
            .map_err(|e| format!("sessionStore: sequence: {e}"))?;

        let mut inserted = 0usize;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT OR IGNORE INTO entries
                       (tenant, workspace, project_key, session_id, subpath,
                        sequence, uuid, entry_type, payload, written_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                )
                .map_err(|e| format!("sessionStore: prepare: {e}"))?;

            for entry in entries {
                let uuid = entry.get("uuid").and_then(|v| v.as_str());
                let entry_type = entry.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let payload = serde_json::to_string(entry)
                    .map_err(|e| format!("sessionStore: serialize: {e}"))?;
                let changed = stmt
                    .execute(params![
                        key.scope.tenant,
                        key.scope.workspace,
                        key.project_key,
                        key.session_id,
                        subpath,
                        next,
                        uuid,
                        entry_type,
                        payload,
                        written_at
                    ])
                    .map_err(|e| format!("sessionStore: insert: {e}"))?;
                // Only advance on a real insert, so a re-sent batch does not
                // punch a gap into the sequence for every duplicate it carries.
                if changed > 0 {
                    inserted += 1;
                    next += 1;
                }
            }
        }

        tx.commit()
            .map_err(|e| format!("sessionStore: commit: {e}"))?;
        Ok(inserted)
    }

    /// Load a full transcript in append order.
    ///
    /// `None` means "never written", which is what the SDK uses to decide there
    /// is nothing to resume. An emptied session reports `Some(vec![])` — the
    /// distinction is cheap here and the SDK explicitly allows adapters that
    /// cannot make it, so making it is strictly better.
    pub fn load(&self, key: &SessionKey) -> Result<Option<Vec<Value>>, String> {
        key.validate()?;
        let subpath = key.subpath_column().to_string();
        let mut reader = self.read_conn.lock();
        let guard = reader
            .transaction()
            .map_err(|e| format!("sessionStore: read snapshot: {e}"))?;

        let mut stmt = guard
            .prepare(
                "SELECT payload FROM entries
                 WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
                   AND session_id = ?4 AND subpath = ?5
                 ORDER BY sequence ASC",
            )
            .map_err(|e| format!("sessionStore: prepare: {e}"))?;
        let rows = stmt
            .query_map(
                params![
                    key.scope.tenant,
                    key.scope.workspace,
                    key.project_key,
                    key.session_id,
                    subpath
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(|e| format!("sessionStore: query: {e}"))?;

        let mut out = Vec::new();
        for row in rows {
            let raw = row.map_err(|e| format!("sessionStore: row: {e}"))?;
            #[cfg(test)]
            if out.is_empty() {
                self.notify_read_started();
            }
            out.push(
                serde_json::from_str(&raw)
                    .map_err(|e| format!("sessionStore: deserialize: {e}"))?,
            );
        }
        if out.is_empty() {
            // Distinguish "no rows because never written" from "emptied".
            let known: i64 = guard
                .query_row(
                    "SELECT COUNT(*) FROM summaries
                     WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3 AND session_id = ?4",
                    params![
                        key.scope.tenant,
                        key.scope.workspace,
                        key.project_key,
                        key.session_id
                    ],
                    |row| row.get(0),
                )
                .map_err(|e| format!("sessionStore: probe: {e}"))?;
            if known == 0 {
                return Ok(None);
            }
        }
        Ok(Some(out))
    }

    /// Sessions in a project, newest write first.
    pub fn list_sessions(
        &self,
        scope: &StoreScope,
        project_key: &str,
    ) -> Result<Vec<SessionListRow>, String> {
        let mut reader = self.read_conn.lock();
        let guard = reader
            .transaction()
            .map_err(|e| format!("sessionStore: list snapshot: {e}"))?;
        let query = |sql: &str| -> Result<Vec<SessionListRow>, String> {
            let mut stmt = guard
                .prepare(sql)
                .map_err(|e| format!("sessionStore: prepare: {e}"))?;
            let rows = stmt
                .query_map(params![scope.tenant, scope.workspace, project_key], |row| {
                    Ok(SessionListRow {
                        session_id: row.get(0)?,
                        mtime: row.get(1)?,
                    })
                })
                .map_err(|e| format!("sessionStore: query: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("sessionStore: row: {e}"))
        };
        // Seek between session ids in the existing covering index instead of
        // visiting every transcript entry in projects with <=128 sessions.
        // The ids are enumerated first, without their mtimes: a 129th id
        // signals a larger catalog, which falls back to the original grouped
        // scan having paid only the bounded seeks — never 129 per-session
        // mtime lookups that would then be thrown away.
        // Reading the existing index avoids maintaining a second catalog that
        // could become stale after deletion, retention, or a crash.
        const SMALL_CATALOG: usize = 128;
        let ids = {
            let mut stmt = guard
                .prepare(
                    "WITH RECURSIVE session_ids(session_id, position) AS (
                         SELECT MIN(session_id), 1 FROM entries
                         WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
                         UNION ALL
                         SELECT (SELECT MIN(session_id) FROM entries
                                 WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
                                   AND session_id > session_ids.session_id), position + 1
                         FROM session_ids WHERE session_id IS NOT NULL AND position < ?4
                     )
                     SELECT session_id FROM session_ids WHERE session_id IS NOT NULL",
                )
                .map_err(|e| format!("sessionStore: prepare: {e}"))?;
            let rows = stmt
                .query_map(
                    params![
                        scope.tenant,
                        scope.workspace,
                        project_key,
                        (SMALL_CATALOG + 1) as i64
                    ],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|e| format!("sessionStore: query: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("sessionStore: row: {e}"))?
        };
        if ids.len() > SMALL_CATALOG {
            return query(
                "SELECT session_id, MAX(written_at) AS mtime FROM entries
                 WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
                 GROUP BY session_id ORDER BY mtime DESC",
            );
        }
        let mut latest = guard
            .prepare(
                "SELECT written_at FROM entries
                 WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3 AND session_id = ?4
                 ORDER BY written_at DESC LIMIT 1",
            )
            .map_err(|e| format!("sessionStore: prepare: {e}"))?;
        let mut heads = ids
            .into_iter()
            .map(|session_id| {
                let mtime = latest
                    .query_row(
                        params![scope.tenant, scope.workspace, project_key, session_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(|e| format!("sessionStore: row: {e}"))?;
                Ok(SessionListRow { session_id, mtime })
            })
            .collect::<Result<Vec<_>, String>>()?;
        heads.sort_by_key(|row| std::cmp::Reverse(row.mtime));
        Ok(heads)
    }

    /// Every `subpath` under a session — the subagent transcripts resume needs.
    /// The main transcript's empty subpath is excluded: it is not a subkey.
    pub fn list_subkeys(
        &self,
        scope: &StoreScope,
        project_key: &str,
        session_id: &str,
    ) -> Result<Vec<String>, String> {
        let guard = self.read_conn.lock();
        let mut stmt = guard
            .prepare(
                "SELECT DISTINCT subpath FROM entries
                 WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
                   AND session_id = ?4 AND subpath <> ''
                 ORDER BY subpath ASC",
            )
            .map_err(|e| format!("sessionStore: prepare: {e}"))?;
        let rows = stmt
            .query_map(
                params![scope.tenant, scope.workspace, project_key, session_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|e| format!("sessionStore: query: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("sessionStore: row: {e}"))
    }

    /// Read one session's summary, or `None` when it has never been folded.
    pub fn read_summary(
        &self,
        scope: &StoreScope,
        project_key: &str,
        session_id: &str,
    ) -> Result<Option<SummaryRow>, String> {
        let guard = self.read_conn.lock();
        guard
            .query_row(
                "SELECT session_id, mtime, data, version FROM summaries
                 WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3 AND session_id = ?4",
                params![scope.tenant, scope.workspace, project_key, session_id],
                |row| {
                    let raw: String = row.get(2)?;
                    Ok(SummaryRow {
                        session_id: row.get(0)?,
                        mtime: row.get(1)?,
                        data: serde_json::from_str(&raw).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                2,
                                Type::Text,
                                Box::new(error),
                            )
                        })?,
                        version: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(|e| format!("sessionStore: summary read: {e}"))
    }

    /// Compare-and-set a folded summary.
    ///
    /// `foldSessionSummary` is a pure JS function shipped by the SDK, so the
    /// FOLD has to happen in the sidecar; only the read and the write can live
    /// here. That splits an operation the SDK requires to be atomic
    /// ("stores that maintain summaries inside `append()` MUST serialize"), so
    /// the version counter closes the gap: the sidecar sends back the version
    /// it folded from, and a mismatch means someone else wrote in between.
    ///
    /// Returns `Ok(None)` on conflict — the caller re-reads and re-folds. Not
    /// an `Err`, because a conflict is an expected outcome of concurrency, and
    /// callers that treat every error as a mirror failure would raise a false
    /// durability alarm.
    pub fn write_summary(
        &self,
        scope: &StoreScope,
        project_key: &str,
        session_id: &str,
        data: &Value,
        expected_version: Option<i64>,
    ) -> Result<Option<SummaryRow>, String> {
        let serialized =
            serde_json::to_string(data).map_err(|e| format!("sessionStore: summary: {e}"))?;
        let mtime = now_ms();
        let conn = Arc::clone(&self.conn);
        let mut guard = conn.lock();
        let tx = guard
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("sessionStore: begin: {e}"))?;

        let current: Option<i64> = tx
            .query_row(
                "SELECT version FROM summaries
                 WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3 AND session_id = ?4",
                params![scope.tenant, scope.workspace, project_key, session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("sessionStore: summary probe: {e}"))?;

        // `None` expected means "I folded from nothing", so a row already
        // existing is a conflict just as much as a version mismatch is.
        if current != expected_version {
            return Ok(None);
        }
        let next_version = current.unwrap_or(0) + 1;

        tx.execute(
            "INSERT INTO summaries
               (tenant, workspace, project_key, session_id, mtime, data, version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (tenant, workspace, project_key, session_id) DO UPDATE SET
               mtime = excluded.mtime, data = excluded.data, version = excluded.version",
            params![
                scope.tenant,
                scope.workspace,
                project_key,
                session_id,
                mtime,
                serialized,
                next_version
            ],
        )
        .map_err(|e| format!("sessionStore: summary write: {e}"))?;
        tx.commit()
            .map_err(|e| format!("sessionStore: commit: {e}"))?;

        Ok(Some(SummaryRow {
            session_id: session_id.to_string(),
            mtime,
            data: data.clone(),
            version: next_version,
        }))
    }

    /// Every summary in a project — one round-trip for `listSessions`.
    pub fn list_summaries(
        &self,
        scope: &StoreScope,
        project_key: &str,
    ) -> Result<Vec<SummaryRow>, String> {
        let guard = self.read_conn.lock();
        let mut stmt = guard
            .prepare(
                "SELECT session_id, mtime, data, version FROM summaries
                 WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
                 ORDER BY mtime DESC",
            )
            .map_err(|e| format!("sessionStore: prepare: {e}"))?;
        let rows = stmt
            .query_map(params![scope.tenant, scope.workspace, project_key], |row| {
                let raw: String = row.get(2)?;
                Ok(SummaryRow {
                    session_id: row.get(0)?,
                    mtime: row.get(1)?,
                    data: serde_json::from_str(&raw).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(2, Type::Text, Box::new(error))
                    })?,
                    version: row.get(3)?,
                })
            })
            .map_err(|e| format!("sessionStore: query: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("sessionStore: row: {e}"))
    }

    /// Delete a transcript.
    ///
    /// Deleting the MAIN key (no subpath) cascades to every subagent transcript
    /// and drops the summary — the SDK contract requires it, and a store that
    /// kept the subkeys would resurrect a "deleted" session's subagent history
    /// on the next resume. Deleting a single subkey touches only that subkey.
    pub fn delete(&self, key: &SessionKey) -> Result<usize, String> {
        key.validate()?;
        let conn = Arc::clone(&self.conn);
        let mut guard = conn.lock();
        let tx = guard
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("sessionStore: begin: {e}"))?;

        let removed = match key.subpath.as_deref() {
            Some(sub) if !sub.is_empty() => tx
                .execute(
                    "DELETE FROM entries
                     WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
                       AND session_id = ?4 AND subpath = ?5",
                    params![
                        key.scope.tenant,
                        key.scope.workspace,
                        key.project_key,
                        key.session_id,
                        sub
                    ],
                )
                .map_err(|e| format!("sessionStore: delete: {e}"))?,
            _ => {
                let n = tx
                    .execute(
                        "DELETE FROM entries
                         WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
                           AND session_id = ?4",
                        params![
                            key.scope.tenant,
                            key.scope.workspace,
                            key.project_key,
                            key.session_id
                        ],
                    )
                    .map_err(|e| format!("sessionStore: delete: {e}"))?;
                tx.execute(
                    "DELETE FROM summaries
                     WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3 AND session_id = ?4",
                    params![
                        key.scope.tenant,
                        key.scope.workspace,
                        key.project_key,
                        key.session_id
                    ],
                )
                .map_err(|e| format!("sessionStore: delete summary: {e}"))?;
                n
            }
        };

        tx.commit()
            .map_err(|e| format!("sessionStore: commit: {e}"))?;
        Ok(removed)
    }

    /// Drop sessions untouched for longer than `retention_days`.
    ///
    /// Scoped by whole session (not by row): expiring individual entries would
    /// leave a truncated transcript that still looks resumable and would resume
    /// having lost its beginning — strictly worse than not having it.
    pub fn prune(&self, retention_days: u32) -> Result<usize, String> {
        if retention_days == 0 {
            return Ok(0);
        }
        let cutoff = now_ms() - (retention_days as i64) * 24 * 60 * 60 * 1000;
        let conn = Arc::clone(&self.conn);
        let mut guard = conn.lock();
        let tx = guard
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("sessionStore: begin: {e}"))?;

        // Activity in either the transcript (including subagents) or its
        // summary keeps the whole session. Their writes need not happen at
        // the same time, so neither table may expire independently.
        let removed = tx
            .execute(
                "DELETE FROM entries WHERE (tenant, workspace, project_key, session_id) IN (
                     SELECT tenant, workspace, project_key, session_id FROM entries AS candidate
                     GROUP BY tenant, workspace, project_key, session_id
                     HAVING MAX(written_at) < ?1
                        AND NOT EXISTS (
                            SELECT 1 FROM summaries
                            WHERE summaries.tenant = candidate.tenant
                              AND summaries.workspace = candidate.workspace
                              AND summaries.project_key = candidate.project_key
                              AND summaries.session_id = candidate.session_id
                              AND summaries.mtime >= ?1
                        )
                 )",
                params![cutoff],
            )
            .map_err(|e| format!("sessionStore: prune: {e}"))?;
        tx.execute(
            "DELETE FROM summaries WHERE mtime < ?1 AND NOT EXISTS (
                 SELECT 1 FROM entries
                 WHERE entries.tenant = summaries.tenant
                   AND entries.workspace = summaries.workspace
                   AND entries.project_key = summaries.project_key
                   AND entries.session_id = summaries.session_id
             )",
            params![cutoff],
        )
        .map_err(|e| format!("sessionStore: prune summaries: {e}"))?;

        tx.commit()
            .map_err(|e| format!("sessionStore: commit: {e}"))?;
        Ok(removed)
    }

    /// Snapshot the database to `dest` using SQLite's online backup API, so a
    /// backup taken during an active turn is still a consistent database rather
    /// than a torn file copy.
    pub fn backup_to(&self, dest: impl AsRef<Path>) -> Result<(), String> {
        let dest = dest.as_ref();
        let source = self
            .path
            .as_deref()
            .ok_or_else(|| "sessionStore: in-memory stores cannot be backed up".to_string())?;
        let backup_root = source
            .parent()
            .ok_or_else(|| "sessionStore: database has no managed parent".to_string())?
            .join("backups");
        if dest.parent() != Some(backup_root.as_path()) || dest.file_name().is_none() {
            return Err(
                "sessionStore: backup path must be inside the managed backups directory"
                    .to_string(),
            );
        }
        std::fs::create_dir_all(&backup_root).map_err(|e| format!("sessionStore: mkdir: {e}"))?;
        let mut reader = self.read_conn.lock();
        let guard = reader
            .transaction()
            .map_err(|e| format!("sessionStore: backup snapshot: {e}"))?;
        // Pin the WAL snapshot before stepping the backup. Otherwise concurrent
        // appends can restart each backup step indefinitely on a busy host.
        guard
            .query_row("SELECT COUNT(*) FROM sqlite_schema", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|e| format!("sessionStore: backup snapshot: {e}"))?;
        #[cfg(test)]
        self.notify_read_started();
        guard
            .backup(rusqlite::MAIN_DB, dest, None)
            .map_err(|e| format!("sessionStore: backup: {e}"))?;
        restrict_permissions(dest);
        Ok(())
    }

    /// Row counts per table — for the settings diagnostics panel.
    pub fn stats(&self) -> Result<HashMap<String, i64>, String> {
        let mut reader = self.read_conn.lock();
        let guard = reader
            .transaction()
            .map_err(|e| format!("sessionStore: stats snapshot: {e}"))?;
        let mut out = HashMap::new();
        for (label, sql) in [
            ("entries", "SELECT COUNT(*) FROM entries"),
            ("sessions", "SELECT COUNT(DISTINCT session_id) FROM entries"),
            ("summaries", "SELECT COUNT(*) FROM summaries"),
        ] {
            let n: i64 = guard
                .query_row(sql, [], |row| row.get(0))
                .map_err(|e| format!("sessionStore: stats: {e}"))?;
            out.insert(label.to_string(), n);
        }
        Ok(out)
    }

    /// Test synchronization only: notify after SQLite establishes the snapshot,
    /// so contention measurements never infer overlap from a scheduling sleep.
    #[cfg(test)]
    fn notify_read_started(&self) {
        if let Some((started, resume)) = self.read_started.lock().take() {
            let _ = started.send(());
            if let Some(resume) = resume {
                resume
                    .recv_timeout(std::time::Duration::from_secs(30))
                    .unwrap();
            }
        }
    }
}

/// Owner-only permissions on unix. A no-op elsewhere — Windows inherits the
/// app-data ACL, which is already per-user.
fn restrict_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// JSON projection used by the host_rpc layer.
pub fn summary_json(row: &SummaryRow) -> Value {
    json!({
        "sessionId": row.session_id,
        "mtime": row.mtime,
        "data": row.data,
        "version": row.version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(session: &str) -> SessionKey {
        SessionKey {
            scope: StoreScope::default(),
            project_key: "proj".into(),
            session_id: session.into(),
            subpath: None,
        }
    }

    fn entry(uuid: Option<&str>, text: &str) -> Value {
        let mut v = json!({ "type": "user", "text": text });
        if let Some(u) = uuid {
            v["uuid"] = json!(u);
        }
        v
    }

    #[test]
    fn append_and_load_round_trips_in_order() {
        let store = SessionStore::in_memory().expect("store");
        let k = key("s1");
        store
            .append(&k, &[entry(Some("a"), "one"), entry(Some("b"), "two")])
            .expect("append");
        store
            .append(&k, &[entry(Some("c"), "three")])
            .expect("append");

        let loaded = store.load(&k).expect("load").expect("some");
        let texts: Vec<_> = loaded
            .iter()
            .map(|v| v["text"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(texts, ["one", "two", "three"]);
    }

    #[test]
    fn append_waits_for_another_connection_instead_of_upgrading_a_stale_snapshot() {
        let dir = std::env::temp_dir().join(format!(
            "cognia-store-busy-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let path = dir.join("db.sqlite");
        let store = SessionStore::open(&path).unwrap();
        let mut other = Connection::open(&path).unwrap();
        let tx = other
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        tx.execute("INSERT INTO entries VALUES ('default','default','proj','s1','',0,'first','user','{}',0)", []).unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            send.send(store.append(&key("s1"), &[entry(Some("second"), "second")]))
                .unwrap();
        });
        let early = receive.recv_timeout(std::time::Duration::from_millis(100));
        tx.commit().unwrap();
        worker.join().unwrap();
        assert!(
            matches!(early, Err(std::sync::mpsc::RecvTimeoutError::Timeout)),
            "must wait for writer: {early:?}"
        );
        assert_eq!(receive.recv().unwrap().unwrap(), 1);
        drop(other);
        let store = SessionStore::open(&path).unwrap();
        assert_eq!(store.load(&key("s1")).unwrap().unwrap().len(), 2);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrupt_summary_is_an_error_not_a_valid_null_summary() {
        let store = SessionStore::in_memory().unwrap();
        store
            .conn
            .lock()
            .execute(
                "INSERT INTO summaries VALUES ('default','default','proj','s1',0,'{broken',1)",
                [],
            )
            .unwrap();
        assert!(store
            .read_summary(&StoreScope::default(), "proj", "s1")
            .is_err());
        assert!(store
            .list_summaries(&StoreScope::default(), "proj")
            .is_err());
    }

    #[test]
    fn a_read_snapshot_does_not_block_appends_and_never_observes_a_partial_batch() {
        let dir = std::env::temp_dir().join(format!(
            "cognia-snapshot-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let path = dir.join("db.sqlite");
        let store = SessionStore::open(&path).unwrap();
        store
            .append(&key("s1"), &[entry(Some("old"), "old")])
            .unwrap();
        let mut reader = store.read_conn.lock();
        assert!(
            reader.execute("DELETE FROM entries", []).is_err(),
            "reader must be read-only"
        );
        let tx = reader.transaction().unwrap();
        let count = |conn: &Connection| {
            conn.query_row("SELECT COUNT(*) FROM entries", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap()
        };
        assert_eq!(count(&tx), 1);
        let writer = Arc::clone(&store);
        let (send, receive) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            send.send(writer.append(
                &key("s1"),
                &[entry(Some("new1"), "new1"), entry(Some("new2"), "new2")],
            ))
            .unwrap();
        });
        let result = receive.recv_timeout(std::time::Duration::from_secs(5));
        assert_eq!(
            count(&tx),
            1,
            "snapshot must stay unchanged during concurrent commit"
        );
        tx.commit().unwrap();
        drop(reader);
        worker.join().unwrap();
        assert_eq!(
            result.unwrap().unwrap(),
            2,
            "append must finish before reader releases snapshot"
        );
        assert_eq!(store.load(&key("s1")).unwrap().unwrap().len(), 3);
        // Once the reader finishes there is no leaked transaction pinning WAL.
        let checkpoint: (i64, i64, i64) = store
            .conn
            .lock()
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(checkpoint, (0, 0, 0));
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_batch_rolls_back_all_rows_and_can_be_retried() {
        let store = SessionStore::in_memory().unwrap();
        store
            .conn
            .lock()
            .execute_batch(
                "CREATE TRIGGER fail_batch BEFORE INSERT ON entries WHEN NEW.uuid = 'fail'
             BEGIN SELECT RAISE(ABORT, 'injected disk write failure'); END;",
            )
            .unwrap();
        let batch = [entry(Some("ok"), "first"), entry(Some("fail"), "second")];
        assert!(store
            .append(&key("s1"), &batch)
            .unwrap_err()
            .contains("injected disk write failure"));
        assert!(store.load(&key("s1")).unwrap().is_none());
        store
            .conn
            .lock()
            .execute_batch("DROP TRIGGER fail_batch")
            .unwrap();
        assert_eq!(store.append(&key("s1"), &batch).unwrap(), 2);
        assert_eq!(store.load(&key("s1")).unwrap().unwrap(), batch);
    }

    #[test]
    fn sqlite_full_rolls_back_the_batch_and_preserves_previous_history() {
        let dir =
            std::env::temp_dir().join(format!("cognia-full-{}-{}", std::process::id(), now_ms()));
        let path = dir.join("db.sqlite");
        let store = SessionStore::open(&path).unwrap();
        let original = [entry(Some("original"), "already acknowledged")];
        store.append(&key("s1"), &original).unwrap();
        {
            let writer = store.conn.lock();
            let pages: i64 = writer
                .query_row("PRAGMA page_count", [], |r| r.get(0))
                .unwrap();
            writer.pragma_update(None, "max_page_count", pages).unwrap();
        }
        let result = store.append(
            &key("s1"),
            &[
                entry(Some("small"), "part of failed batch"),
                entry(Some("too-large"), &"x".repeat(1024 * 1024)),
            ],
        );
        assert!(result.unwrap_err().contains("database or disk is full"));
        assert_eq!(store.load(&key("s1")).unwrap().unwrap(), original);
        // The error must not leave a transaction or lock behind.
        store
            .conn
            .lock()
            .pragma_update(None, "max_page_count", 1_000_000)
            .unwrap();
        assert_eq!(
            store
                .append(&key("s1"), &[entry(Some("small"), "retry")])
                .unwrap(),
            1
        );
        drop(store);
        let reopened = SessionStore::open(&path).unwrap();
        assert_eq!(reopened.load(&key("s1")).unwrap().unwrap().len(), 2);
        drop(reopened);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn repeated_restore_write_cycles_allow_wal_to_checkpoint() {
        let dir = std::env::temp_dir().join(format!(
            "cognia-wal-cycles-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let path = dir.join("db.sqlite");
        let store = SessionStore::open(&path).unwrap();
        store
            .conn
            .lock()
            .pragma_update(None, "wal_autocheckpoint", 8)
            .unwrap();
        for i in 0..100 {
            store
                .append(
                    &key("s1"),
                    &[entry(Some(&format!("u{i}")), &"x".repeat(4096))],
                )
                .unwrap();
            assert_eq!(store.load(&key("s1")).unwrap().unwrap().len(), i + 1);
        }
        let (busy, frames, copied): (i64, i64, i64) = store
            .conn
            .lock()
            .query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(busy, 0);
        assert_eq!(
            frames, copied,
            "completed restores must release their WAL snapshots"
        );
        // A leaked read transaction would accumulate ~100 batches here.
        assert!(
            frames < 32,
            "WAL frame count grew with completed restores: {frames}"
        );
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn independent_connections_compete_on_summary_version_without_losing_writes() {
        let dir =
            std::env::temp_dir().join(format!("cognia-cas-{}-{}", std::process::id(), now_ms()));
        let path = dir.join("db.sqlite");
        let a = SessionStore::open(&path).unwrap();
        let b = SessionStore::open(&path).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = [a, b]
            .into_iter()
            .enumerate()
            .map(|(i, store)| {
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store.write_summary(
                        &StoreScope::default(),
                        "proj",
                        "s1",
                        &json!({"writer": i}),
                        None,
                    )
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|w| w.join().unwrap().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|r| r.is_some()).count(), 1);
        let store = SessionStore::open(&path).unwrap();
        assert_eq!(
            store
                .read_summary(&StoreScope::default(), "proj", "s1")
                .unwrap()
                .unwrap()
                .version,
            1
        );
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    // Invoked only by the parent test in a separate process. No unsafe fork of
    // a multithreaded SQLite runtime and no process-global environment mutation.
    #[test]
    fn crash_writer_child() {
        use std::io::{Read, Write};
        let Some(path) = std::env::var_os("COGNIA_SESSION_CRASH_FIXTURE") else {
            return;
        };
        let store = SessionStore::open(path).unwrap();
        store
            .append(&key("s1"), &[entry(Some("committed"), "durable")])
            .unwrap();
        let sub = SessionKey {
            subpath: Some("subagents/a".into()),
            ..key("s1")
        };
        store
            .append(&sub, &[entry(Some("committed"), "subagent")])
            .unwrap();
        let tenant = SessionKey {
            scope: StoreScope {
                tenant: "other".into(),
                ..StoreScope::default()
            },
            ..key("s1")
        };
        store
            .append(&tenant, &[entry(Some("committed"), "other tenant")])
            .unwrap();
        store
            .write_summary(
                &StoreScope::default(),
                "proj",
                "s1",
                &json!({"title": "durable"}),
                None,
            )
            .unwrap();
        let mut conn = store.conn.lock();
        conn.execute_batch("PRAGMA cache_size=10; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        for i in 1..1000 {
            tx.execute(
                "INSERT INTO entries VALUES ('default','default','proj','s1','',?1,?2,'user',?3,0)",
                params![i, format!("partial-{i}"), "x".repeat(4096)],
            )
            .unwrap();
        }
        tx.execute("UPDATE summaries SET data='null', version=2", [])
            .unwrap();
        println!("COGNIA_CRASH_READY");
        std::io::stdout().flush().unwrap();
        // Keep the uncommitted transaction and both connections alive until kill.
        let _ = std::io::stdin().read_exact(&mut [0_u8]);
        panic!("parent must kill the process before it exits normally");
    }

    #[test]
    fn killed_process_recovers_committed_wal_and_discards_partial_batch() {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        let dir =
            std::env::temp_dir().join(format!("cognia-kill-{}-{}", std::process::id(), now_ms()));
        let path = dir.join("db.sqlite");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "agent_session_store::tests::crash_writer_child",
                "--nocapture",
            ])
            .env("COGNIA_SESSION_CRASH_FIXTURE", &path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let output = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if line.unwrap().contains("COGNIA_CRASH_READY") {
                    let _ = send.send(());
                    break;
                }
            }
        });
        let ready = receive.recv_timeout(std::time::Duration::from_secs(30));
        let killed = child.kill();
        let status = child.wait().unwrap();
        output.join().unwrap();
        ready.expect("child reached uncommitted transaction");
        killed.unwrap();
        assert!(!status.success());
        assert!(
            path.with_extension("sqlite-wal").exists(),
            "kill must leave a WAL to recover"
        );
        for _ in 0..3 {
            let store = SessionStore::open(&path).unwrap();
            assert_eq!(
                store
                    .conn
                    .lock()
                    .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                    .unwrap(),
                "ok"
            );
            let batch = [entry(Some("committed"), "durable")];
            assert_eq!(store.load(&key("s1")).unwrap().unwrap(), batch);
            assert_eq!(
                store.append(&key("s1"), &batch).unwrap(),
                0,
                "replay after crash must be idempotent"
            );
            assert_eq!(
                store
                    .list_subkeys(&StoreScope::default(), "proj", "s1")
                    .unwrap(),
                ["subagents/a"]
            );
            assert_eq!(store.stats().unwrap()["entries"], 3);
            let summary = store
                .read_summary(&StoreScope::default(), "proj", "s1")
                .unwrap()
                .unwrap();
            assert_eq!(summary.version, 1);
            assert_eq!(summary.data["title"], "durable");
            let tenant = SessionKey {
                scope: StoreScope {
                    tenant: "other".into(),
                    ..StoreScope::default()
                },
                ..key("s1")
            };
            assert_eq!(
                store.load(&tenant).unwrap().unwrap()[0]["text"],
                "other tenant"
            );
            assert_eq!(store.prune(DEFAULT_RETENTION_DAYS).unwrap(), 0);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Explicit file-backed native recovery workload. No wall-clock CI gate.
    #[test]
    #[ignore = "explicit file-backed recovery and concurrent append measurements"]
    fn benchmark_recovery_contention() {
        use std::time::{Duration, Instant};
        let dir = std::env::temp_dir().join(format!(
            "cognia-recovery-bench-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let path = dir.join("db.sqlite");
        let store = SessionStore::open(&path).unwrap();
        let payload = "x".repeat(4096);
        for batch in 0..200 {
            let entries: Vec<_> = (0..100)
                .map(|i| entry(Some(&format!("u{}", batch * 100 + i)), &payload))
                .collect();
            store.append(&key("long"), &entries).unwrap();
        }
        for i in 0..1000 {
            store
                .append(&key(&format!("short-{i}")), &[entry(Some("u"), "short")])
                .unwrap();
        }
        let mut results: HashMap<&str, Vec<f64>> = HashMap::new();
        let mut measure = |name, round, duration: Duration| {
            if round > 0 {
                results
                    .entry(name)
                    .or_default()
                    .push(duration.as_secs_f64() * 1000.0);
            }
        };
        for round in 0..11 {
            let start = Instant::now();
            assert_eq!(store.load(&key("long")).unwrap().unwrap().len(), 20_000);
            measure("load", round, start.elapsed());
            let start = Instant::now();
            store
                .append(
                    &key("writer"),
                    &[entry(Some(&format!("solo-{round}")), "write")],
                )
                .unwrap();
            measure("append", round, start.elapsed());
            let start = Instant::now();
            assert_eq!(
                store
                    .list_sessions(&StoreScope::default(), "proj")
                    .unwrap()
                    .len(),
                1002
            );
            measure("list", round, start.elapsed());
            let start = Instant::now();
            let reopened = SessionStore::open(&path).unwrap();
            assert_eq!(reopened.prune(DEFAULT_RETENTION_DAYS).unwrap(), 0);
            assert_eq!(reopened.load(&key("long")).unwrap().unwrap().len(), 20_000);
            measure("reopen_prune_load", round, start.elapsed());
            drop(reopened);
            for backup in [false, true] {
                let reader = Arc::clone(&store);
                let dest = dir.join("backups").join("snapshot.sqlite");
                let (send, receive) = std::sync::mpsc::sync_channel(0);
                *store.read_started.lock() = Some((send, None));
                let (finished, completion) = std::sync::mpsc::channel();
                let worker = std::thread::spawn(move || {
                    let start = Instant::now();
                    if backup {
                        reader.backup_to(&dest).unwrap();
                    } else {
                        assert_eq!(reader.load(&key("long")).unwrap().unwrap().len(), 20_000);
                    }
                    finished.send(start.elapsed()).unwrap();
                });
                receive.recv_timeout(Duration::from_secs(30)).unwrap();
                assert!(
                    matches!(
                        completion.try_recv(),
                        Err(std::sync::mpsc::TryRecvError::Empty)
                    ),
                    "read must still be active when append starts"
                );
                let start = Instant::now();
                store
                    .append(
                        &key("writer"),
                        &[entry(Some(&format!("race-{round}-{backup}")), "write")],
                    )
                    .unwrap();
                measure(
                    if backup {
                        "append_during_backup"
                    } else {
                        "append_during_load"
                    },
                    round,
                    start.elapsed(),
                );
                measure(
                    if backup { "backup" } else { "concurrent_load" },
                    round,
                    completion.recv_timeout(Duration::from_secs(30)).unwrap(),
                );
                worker.join().unwrap();
            }
        }
        for (name, values) in results {
            let mut sorted = values.clone();
            sorted.sort_by(f64::total_cmp);
            let median = (sorted[4] + sorted[5]) / 2.0;
            let mut deviations: Vec<_> = values.iter().map(|v| (v - median).abs()).collect();
            deviations.sort_by(f64::total_cmp);
            println!(
                "{}",
                json!({"metric": name, "samplesMs": values, "medianMs": median, "madMs": (deviations[4] + deviations[5])/2.0, "sqliteVersion": rusqlite::version()})
            );
        }
        println!(
            "{}",
            json!({"databaseBytes": std::fs::metadata(&path).unwrap().len(), "walBytes": std::fs::metadata(path.with_extension("sqlite-wal")).map(|m|m.len()).unwrap_or(0)})
        );
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn load_distinguishes_never_written_from_emptied() {
        let store = SessionStore::in_memory().expect("store");
        assert!(store.load(&key("ghost")).expect("load").is_none());

        let k = key("s1");
        store
            .append(&k, &[entry(Some("a"), "one")])
            .expect("append");
        store
            .write_summary(&k.scope, &k.project_key, &k.session_id, &json!({}), None)
            .expect("summary");
        store
            .delete(&SessionKey {
                subpath: Some("subagents/x".into()),
                ..k.clone()
            })
            .expect("delete subkey");
        assert!(store.load(&k).expect("load").is_some());
    }

    #[test]
    fn a_replayed_batch_does_not_duplicate_rows() {
        // The SDK retries append up to three times, and importSessionToStore
        // replays whole transcripts — both MUST be idempotent by uuid.
        let store = SessionStore::in_memory().expect("store");
        let k = key("s1");
        let batch = [entry(Some("a"), "one"), entry(Some("b"), "two")];
        assert_eq!(store.append(&k, &batch).expect("append"), 2);
        assert_eq!(store.append(&k, &batch).expect("replay"), 0);
        assert_eq!(store.load(&k).expect("load").expect("some").len(), 2);
    }

    #[test]
    fn entries_without_a_uuid_always_append() {
        // Titles, tags and mode markers carry no uuid. A non-partial unique
        // index would collapse every one of them into a single row.
        let store = SessionStore::in_memory().expect("store");
        let k = key("s1");
        store
            .append(&k, &[entry(None, "title-1"), entry(None, "title-2")])
            .expect("append");
        store.append(&k, &[entry(None, "title-1")]).expect("append");
        assert_eq!(store.load(&k).expect("load").expect("some").len(), 3);
    }

    #[test]
    fn a_partly_duplicate_batch_keeps_the_sequence_dense() {
        let store = SessionStore::in_memory().expect("store");
        let k = key("s1");
        store
            .append(&k, &[entry(Some("a"), "one")])
            .expect("append");
        // "a" is already there; only "b" is new.
        assert_eq!(
            store
                .append(&k, &[entry(Some("a"), "one"), entry(Some("b"), "two")])
                .expect("append"),
            1
        );
        let loaded = store.load(&k).expect("load").expect("some");
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[1]["text"], "two");
    }

    #[test]
    fn tenants_and_workspaces_cannot_read_each_others_rows() {
        // The isolation that matters: `projectKey` comes from the caller, the
        // scope does not, so a crafted projectKey still cannot cross a tenant.
        let store = SessionStore::in_memory().expect("store");
        let a = SessionKey {
            scope: StoreScope {
                tenant: "t-a".into(),
                workspace: "w".into(),
            },
            ..key("shared-id")
        };
        let b = SessionKey {
            scope: StoreScope {
                tenant: "t-b".into(),
                workspace: "w".into(),
            },
            ..key("shared-id")
        };
        store
            .append(&a, &[entry(Some("a"), "secret")])
            .expect("append");

        assert!(store.load(&b).expect("load").is_none());
        assert!(store
            .list_sessions(&b.scope, "proj")
            .expect("list")
            .is_empty());
        assert_eq!(
            store.list_sessions(&a.scope, "proj").expect("list").len(),
            1
        );
    }

    #[test]
    fn the_main_transcript_and_a_subagent_are_separate_keys() {
        let store = SessionStore::in_memory().expect("store");
        let main = key("s1");
        let sub = SessionKey {
            subpath: Some("subagents/agent-1".into()),
            ..main.clone()
        };
        store
            .append(&main, &[entry(Some("a"), "main")])
            .expect("append");
        store
            .append(&sub, &[entry(Some("b"), "sub")])
            .expect("append");

        assert_eq!(store.load(&main).expect("load").expect("some").len(), 1);
        assert_eq!(store.load(&sub).expect("load").expect("some").len(), 1);
        assert_eq!(
            store
                .list_subkeys(&main.scope, "proj", "s1")
                .expect("subkeys"),
            ["subagents/agent-1"]
        );
    }

    #[test]
    fn an_empty_subpath_is_the_main_transcript_not_a_third_key() {
        // The SDK says an empty subpath is invalid. Treating it as distinct
        // would split one transcript across two keys with no visible cause.
        let store = SessionStore::in_memory().expect("store");
        let main = key("s1");
        let empty = SessionKey {
            subpath: Some(String::new()),
            ..main.clone()
        };
        store
            .append(&main, &[entry(Some("a"), "one")])
            .expect("append");
        store
            .append(&empty, &[entry(Some("b"), "two")])
            .expect("append");
        assert_eq!(store.load(&main).expect("load").expect("some").len(), 2);
        assert!(store
            .list_subkeys(&main.scope, "proj", "s1")
            .expect("subkeys")
            .is_empty());
    }

    #[test]
    fn deleting_the_main_key_cascades_to_subagents_and_the_summary() {
        let store = SessionStore::in_memory().expect("store");
        let main = key("s1");
        let sub = SessionKey {
            subpath: Some("subagents/agent-1".into()),
            ..main.clone()
        };
        store
            .append(&main, &[entry(Some("a"), "main")])
            .expect("append");
        store
            .append(&sub, &[entry(Some("b"), "sub")])
            .expect("append");
        store
            .write_summary(&main.scope, "proj", "s1", &json!({ "n": 2 }), None)
            .expect("summary");

        store.delete(&main).expect("delete");
        assert!(store.load(&main).expect("load").is_none());
        assert!(store.load(&sub).expect("load").is_none());
        assert!(store
            .read_summary(&main.scope, "proj", "s1")
            .expect("summary")
            .is_none());
    }

    #[test]
    fn deleting_one_subkey_leaves_the_main_transcript_alone() {
        let store = SessionStore::in_memory().expect("store");
        let main = key("s1");
        let sub = SessionKey {
            subpath: Some("subagents/agent-1".into()),
            ..main.clone()
        };
        store
            .append(&main, &[entry(Some("a"), "main")])
            .expect("append");
        store
            .append(&sub, &[entry(Some("b"), "sub")])
            .expect("append");

        store.delete(&sub).expect("delete");
        assert_eq!(store.load(&main).expect("load").expect("some").len(), 1);
        assert!(store
            .list_subkeys(&main.scope, "proj", "s1")
            .expect("subkeys")
            .is_empty());
    }

    #[test]
    fn summary_writes_are_compare_and_set() {
        let store = SessionStore::in_memory().expect("store");
        let scope = StoreScope::default();
        let first = store
            .write_summary(&scope, "proj", "s1", &json!({ "n": 1 }), None)
            .expect("write")
            .expect("accepted");
        assert_eq!(first.version, 1);

        // Folding from a stale read is refused, not silently applied — that is
        // the whole point of splitting read-fold-write across two processes.
        assert!(store
            .write_summary(&scope, "proj", "s1", &json!({ "n": 99 }), None)
            .expect("write")
            .is_none());

        let second = store
            .write_summary(&scope, "proj", "s1", &json!({ "n": 2 }), Some(1))
            .expect("write")
            .expect("accepted");
        assert_eq!(second.version, 2);
        assert_eq!(
            store
                .read_summary(&scope, "proj", "s1")
                .expect("read")
                .expect("some")
                .data["n"],
            2
        );
    }

    #[test]
    fn summaries_are_stored_verbatim_and_never_interpreted() {
        // `data` is opaque SDK-owned state; a store that normalised it would
        // corrupt the SDK's own staleness bookkeeping.
        let store = SessionStore::in_memory().expect("store");
        let scope = StoreScope::default();
        let weird = json!({ "z": 1, "a": [null, {"nested": true}], "": "empty-key" });
        store
            .write_summary(&scope, "proj", "s1", &weird, None)
            .expect("write");
        assert_eq!(
            store
                .read_summary(&scope, "proj", "s1")
                .expect("read")
                .expect("some")
                .data,
            weird
        );
    }

    #[test]
    fn list_sessions_reports_the_last_write_and_orders_by_it() {
        let store = SessionStore::in_memory().expect("store");
        let scope = StoreScope::default();
        store
            .append(&key("old"), &[entry(Some("a"), "x")])
            .expect("append");
        store
            .append(&key("new"), &[entry(Some("b"), "y")])
            .expect("append");

        let rows = store.list_sessions(&scope, "proj").expect("list");
        assert_eq!(rows.len(), 2);
        assert!(rows[0].mtime >= rows[1].mtime);
    }

    #[test]
    fn list_sessions_preserves_grouping_across_the_index_seek_boundary() {
        for count in [0, 1, 127, 128, 129, 257, 513] {
            let store = SessionStore::in_memory().expect("store");
            let scope = StoreScope::default();
            let mut expected = std::collections::BTreeMap::new();
            {
                let mut guard = store.conn.lock();
                let tx = guard.transaction().expect("transaction");
                for i in 0..count {
                    let session_id = format!("session-{i:04}");
                    // Include tied and negative timestamps; subagents can hold
                    // the newest entry and must contribute to the session mtime.
                    let latest = i64::from(i / 2) - 100;
                    for (subpath, written_at) in [("", latest - 1), ("subagents/a", latest)] {
                        tx.execute(
                            "INSERT INTO entries VALUES (?1, ?2, 'proj', ?3, ?4, 0, 'uuid', 'user', '{}', ?5)",
                            params![scope.tenant, scope.workspace, session_id, subpath, written_at],
                        )
                        .expect("fixture");
                    }
                    expected.insert(session_id, latest);
                }
                for (tenant, workspace, project) in [
                    ("other", "default", "proj"),
                    ("default", "other", "proj"),
                    ("default", "default", "other"),
                ] {
                    tx.execute(
                        "INSERT INTO entries VALUES (?1, ?2, ?3, 'isolated', '', 0, 'uuid', 'user', '{}', 999999)",
                        params![tenant, workspace, project],
                    )
                    .expect("isolated fixture");
                }
                tx.commit().expect("commit");
            }

            let rows = store.list_sessions(&scope, "proj").expect("list");
            assert_eq!(rows.len(), count as usize);
            assert!(rows.windows(2).all(|pair| pair[0].mtime >= pair[1].mtime));
            let actual: std::collections::BTreeMap<_, _> = rows
                .into_iter()
                .map(|row| (row.session_id, row.mtime))
                .collect();
            assert_eq!(actual, expected, "session count {count}");
        }
    }

    #[test]
    fn list_sessions_survives_retries_deletions_and_reopening() {
        let dir = std::env::temp_dir().join(format!(
            "cognia-store-list-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let path = dir.join("db.sqlite");
        let main = key("main");
        let sub = SessionKey {
            subpath: Some("subagents/a".into()),
            ..main.clone()
        };
        let other = key("other");
        let list = |store: &SessionStore| {
            store
                .list_sessions(&main.scope, "proj")
                .expect("list")
                .into_iter()
                .map(|row| (row.session_id, row.mtime))
                .collect::<Vec<_>>()
        };
        {
            let store = SessionStore::open(&path).expect("open");
            for (key, timestamp) in [(&main, 100), (&other, 200), (&sub, 300)] {
                store
                    .append(key, &[entry(Some("uuid"), "message")])
                    .expect("append");
                store
                    .conn
                    .lock()
                    .execute(
                        "UPDATE entries SET written_at = ?1 WHERE session_id = ?2 AND subpath = ?3",
                        params![timestamp, key.session_id, key.subpath_column()],
                    )
                    .expect("backdate");
            }
            assert_eq!(
                store
                    .append(&sub, &[entry(Some("uuid"), "message")])
                    .expect("retry"),
                0
            );
            assert_eq!(
                list(&store),
                vec![("main".into(), 300), ("other".into(), 200)]
            );
            store.delete(&sub).expect("delete subagent");
            assert_eq!(
                list(&store),
                vec![("other".into(), 200), ("main".into(), 100)]
            );
        }
        {
            let store = SessionStore::open(&path).expect("reopen");
            assert_eq!(
                list(&store),
                vec![("other".into(), 200), ("main".into(), 100)]
            );
            store.delete(&main).expect("delete main");
            assert_eq!(list(&store), vec![("other".into(), 200)]);
        }
        {
            let store = SessionStore::open(&path).expect("reopen after delete");
            assert_eq!(list(&store), vec![("other".into(), 200)]);
        }
        std::fs::remove_dir_all(dir).expect("cleanup");
    }

    /// Run explicitly with `cargo test -p cognia-agent-state
    /// benchmark_list_sessions -- --ignored --nocapture --test-threads=1`.
    /// Uses the production method and bundled SQLite; timings are observations,
    /// not assertions that would make CI depend on host load.
    #[test]
    #[ignore = "explicit long-history and sparse-session performance measurement"]
    fn benchmark_list_sessions() {
        for (entries, sessions) in [
            (100_000, 100),
            (100_000, 1_000),
            (10_000, 10_000),
            (100_000, 100_000),
        ] {
            let store = SessionStore::in_memory().expect("store");
            let scope = StoreScope::default();
            {
                let mut guard = store.conn.lock();
                let tx = guard.transaction().expect("transaction");
                {
                    let mut insert = tx.prepare(
                        "INSERT INTO entries VALUES ('default', 'default', 'proj', ?1, '', ?2, ?3, 'user', '{}', ?4)",
                    ).expect("prepare fixture");
                    for i in 0..entries {
                        insert
                            .execute(params![
                                format!("s{:08}", i % sessions),
                                i / sessions,
                                format!("u{i}"),
                                i
                            ])
                            .expect("fixture");
                    }
                }
                tx.commit().expect("commit");
            }
            let baseline = || {
                let guard = store.conn.lock();
                let mut statement = guard
                    .prepare(
                        "SELECT session_id, MAX(written_at) AS mtime FROM entries
                     WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
                     GROUP BY session_id ORDER BY mtime DESC",
                    )
                    .expect("baseline");
                let rows = statement
                    .query_map(params![scope.tenant, scope.workspace, "proj"], |row| {
                        Ok(SessionListRow {
                            session_id: row.get(0)?,
                            mtime: row.get(1)?,
                        })
                    })
                    .expect("baseline query");
                rows.collect::<Result<Vec<_>, _>>().expect("baseline rows")
            };
            let expected = baseline();
            let actual = store.list_sessions(&scope, "proj").expect("warmup");
            assert_eq!(
                serde_json::to_value(&actual).unwrap(),
                serde_json::to_value(&expected).unwrap()
            );
            let mut samples = [Vec::new(), Vec::new()];
            for pair in 0..10 {
                // Alternate AB/BA to reduce systematic warm-cache/order bias.
                for method in if pair % 2 == 0 { [0, 1] } else { [1, 0] } {
                    let started = std::time::Instant::now();
                    let rows = if method == 0 {
                        baseline()
                    } else {
                        store.list_sessions(&scope, "proj").expect("list")
                    };
                    samples[method].push(started.elapsed().as_secs_f64() * 1_000.0);
                    assert_eq!(rows.len(), sessions as usize);
                }
            }
            let stats = |values: &[f64]| {
                let mut sorted = values.to_vec();
                sorted.sort_by(f64::total_cmp);
                let median = (sorted[4] + sorted[5]) / 2.0;
                let mut deviations: Vec<_> =
                    values.iter().map(|value| (value - median).abs()).collect();
                deviations.sort_by(f64::total_cmp);
                json!({ "medianMs": median, "madMs": (deviations[4] + deviations[5]) / 2.0, "samplesMs": values })
            };
            println!(
                "{}",
                json!({
                    "sqliteVersion": rusqlite::version(), "entries": entries, "sessions": sessions,
                    "baseline": stats(&samples[0]), "current": stats(&samples[1]),
                })
            );
        }
    }

    #[test]
    fn prune_drops_whole_sessions_and_keeps_recent_ones() {
        let store = SessionStore::in_memory().expect("store");
        let scope = StoreScope::default();
        store
            .append(&key("keep"), &[entry(Some("a"), "x")])
            .expect("append");

        // Nothing is old enough yet, and a zero retention is "never prune".
        assert_eq!(store.prune(0).expect("prune"), 0);
        assert_eq!(store.prune(1).expect("prune"), 0);
        assert_eq!(store.list_sessions(&scope, "proj").expect("list").len(), 1);

        // Backdate the row rather than sleeping.
        {
            let guard = store.conn.lock();
            guard
                .execute("UPDATE entries SET written_at = 0", [])
                .expect("backdate");
        }
        assert_eq!(store.prune(1).expect("prune"), 1);
        assert!(store
            .list_sessions(&scope, "proj")
            .expect("list")
            .is_empty());
    }

    #[test]
    fn prune_keeps_a_session_whose_last_write_is_recent() {
        // Row-level expiry would truncate the START of an active transcript,
        // leaving something that still looks resumable but has lost its head.
        let store = SessionStore::in_memory().expect("store");
        let k = key("s1");
        store
            .append(&k, &[entry(Some("old"), "first")])
            .expect("append");
        {
            let guard = store.conn.lock();
            guard
                .execute("UPDATE entries SET written_at = 0", [])
                .expect("backdate");
        }
        store
            .append(&k, &[entry(Some("new"), "second")])
            .expect("append");

        assert_eq!(store.prune(1).expect("prune"), 0);
        assert_eq!(store.load(&k).expect("load").expect("some").len(), 2);
    }

    #[test]
    fn prune_preserves_history_when_only_the_summary_is_recent() {
        let store = SessionStore::in_memory().expect("store");
        let main = key("s1");
        let sub = SessionKey {
            subpath: Some("subagents/a".into()),
            ..main.clone()
        };
        for key in [&main, &sub] {
            store
                .append(key, &[entry(Some("uuid"), "old history")])
                .expect("append");
        }
        store
            .conn
            .lock()
            .execute("UPDATE entries SET written_at = 0", [])
            .expect("backdate");
        store
            .write_summary(
                &main.scope,
                "proj",
                "s1",
                &json!({ "title": "recent activity" }),
                None,
            )
            .expect("summary");

        assert_eq!(store.prune(1).expect("prune"), 0);
        assert_eq!(store.load(&main).expect("load").expect("main").len(), 1);
        assert_eq!(store.load(&sub).expect("load").expect("subagent").len(), 1);
        assert!(store
            .read_summary(&main.scope, "proj", "s1")
            .expect("summary")
            .is_some());
    }

    #[test]
    fn prune_preserves_the_summary_when_only_a_subagent_is_recent() {
        let store = SessionStore::in_memory().expect("store");
        let main = key("s1");
        store
            .append(&main, &[entry(Some("main"), "old main")])
            .expect("append");
        store
            .write_summary(
                &main.scope,
                "proj",
                "s1",
                &json!({ "title": "old summary" }),
                None,
            )
            .expect("summary");
        {
            let guard = store.conn.lock();
            guard
                .execute("UPDATE entries SET written_at = 0", [])
                .expect("backdate entries");
            guard
                .execute("UPDATE summaries SET mtime = 0", [])
                .expect("backdate summary");
        }
        let sub = SessionKey {
            subpath: Some("subagents/a".into()),
            ..main.clone()
        };
        store
            .append(&sub, &[entry(Some("subagent"), "recent subagent")])
            .expect("append");

        assert_eq!(store.prune(1).expect("prune"), 0);
        assert_eq!(store.load(&main).expect("load").expect("main").len(), 1);
        assert_eq!(store.load(&sub).expect("load").expect("subagent").len(), 1);
        let summary = store
            .read_summary(&main.scope, "proj", "s1")
            .expect("summary")
            .expect("retained summary");
        assert_eq!(summary.data["title"], "old summary");
        assert_eq!(summary.version, 1);
    }

    #[test]
    fn prune_expiry_is_scoped_and_removes_both_old_tables() {
        let store = SessionStore::in_memory().expect("store");
        let recent = now_ms();
        // All rows deliberately reuse the same session id. Activity in any
        // other tenant, workspace, or project must not preserve an expired one.
        let fixtures = [
            ("default", "default", "proj", 0, 0, false),
            ("other", "default", "proj", 0, recent, true),
            ("default", "other", "proj", recent, 0, true),
            ("default", "default", "other", 0, recent, true),
        ];
        {
            let guard = store.conn.lock();
            for (tenant, workspace, project, written_at, mtime, _) in fixtures {
                for subpath in ["", "subagents/a"] {
                    guard.execute(
                        "INSERT INTO entries VALUES (?1, ?2, ?3, 's1', ?4, 0, 'uuid', 'user', '{}', ?5)",
                        params![tenant, workspace, project, subpath, written_at],
                    ).expect("entry fixture");
                }
                guard
                    .execute(
                        "INSERT INTO summaries VALUES (?1, ?2, ?3, 's1', ?4, '{}', 1)",
                        params![tenant, workspace, project, mtime],
                    )
                    .expect("summary fixture");
            }
        }
        // Disabling retention must preserve even completely expired sessions.
        assert_eq!(store.prune(0).expect("disabled prune"), 0);
        assert_eq!(store.stats().expect("stats")["entries"], 8);
        assert_eq!(store.stats().expect("stats")["summaries"], 4);
        assert_eq!(store.prune(1).expect("prune"), 2);
        for (tenant, workspace, project, _, _, keep) in fixtures {
            let scope = StoreScope {
                tenant: tenant.into(),
                workspace: workspace.into(),
            };
            let main = SessionKey {
                scope: scope.clone(),
                project_key: project.into(),
                session_id: "s1".into(),
                subpath: None,
            };
            let sub = SessionKey {
                subpath: Some("subagents/a".into()),
                ..main.clone()
            };
            for key in [&main, &sub] {
                let rows = store.load(key).expect("load");
                if keep {
                    assert_eq!(rows.expect("retained history").len(), 1);
                } else {
                    assert!(
                        rows.is_none(),
                        "expired history and summary must be removed"
                    );
                }
            }
            assert_eq!(
                store
                    .read_summary(&scope, project, "s1")
                    .expect("summary")
                    .is_some(),
                keep
            );
        }
    }

    #[test]
    fn prune_expires_old_summary_only_sessions_but_keeps_recent_ones() {
        let store = SessionStore::in_memory().expect("store");
        let scope = StoreScope::default();
        store
            .write_summary(&scope, "proj", "old", &json!({}), None)
            .expect("old summary");
        store
            .conn
            .lock()
            .execute("UPDATE summaries SET mtime = 0", [])
            .expect("backdate");
        store
            .write_summary(&scope, "proj", "recent", &json!({}), None)
            .expect("recent summary");
        assert_eq!(store.prune(1).expect("prune"), 0);
        assert!(store
            .read_summary(&scope, "proj", "old")
            .expect("old summary")
            .is_none());
        assert!(store
            .read_summary(&scope, "proj", "recent")
            .expect("recent summary")
            .is_some());
    }

    #[test]
    fn prune_rolls_back_history_deletion_if_summary_deletion_fails() {
        let store = SessionStore::in_memory().expect("store");
        let main = key("s1");
        store
            .append(&main, &[entry(Some("uuid"), "history")])
            .expect("append");
        store
            .write_summary(&main.scope, "proj", "s1", &json!({}), None)
            .expect("summary");
        store
            .conn
            .lock()
            .execute_batch(
                "UPDATE entries SET written_at = 0;
             UPDATE summaries SET mtime = 0;
             CREATE TRIGGER reject_summary_delete BEFORE DELETE ON summaries
             BEGIN SELECT RAISE(ABORT, 'injected summary delete failure'); END;",
            )
            .expect("inject failure");
        assert!(store
            .prune(1)
            .expect_err("failed cleanup")
            .contains("injected summary delete failure"));
        assert_eq!(
            store
                .load(&main)
                .expect("load")
                .expect("retained history")
                .len(),
            1
        );
        assert!(store
            .read_summary(&main.scope, "proj", "s1")
            .expect("retained summary")
            .is_some());
    }

    #[test]
    fn a_key_without_ids_is_refused_before_it_reaches_sql() {
        let store = SessionStore::in_memory().expect("store");
        let mut k = key("s1");
        k.session_id = String::new();
        assert!(store.append(&k, &[entry(None, "x")]).is_err());
        assert!(store.load(&k).is_err());
    }

    #[test]
    fn an_empty_batch_is_a_no_op_rather_than_an_error() {
        let store = SessionStore::in_memory().expect("store");
        assert_eq!(store.append(&key("s1"), &[]).expect("append"), 0);
    }

    #[test]
    fn backup_produces_a_readable_database() {
        let dir = std::env::temp_dir().join(format!("cognia-store-{}", now_ms()));
        let store = SessionStore::open(dir.join("db.sqlite")).expect("open");
        store
            .append(&key("s1"), &[entry(Some("a"), "one")])
            .expect("append");

        let dest = dir.join("backups").join("backup.sqlite");
        store.backup_to(&dest).expect("backup");

        let restored = SessionStore::open(&dest).expect("reopen");
        assert_eq!(
            restored
                .load(&key("s1"))
                .expect("load")
                .expect("some")
                .len(),
            1
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_finishes_with_continuous_appends_and_restores_one_snapshot() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::time::Duration;
        let dir = std::env::temp_dir().join(format!(
            "cognia-live-backup-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let path = dir.join("db.sqlite");
        let store = SessionStore::open(&path).unwrap();
        let initial: Vec<_> = (0..2000)
            .map(|i| entry(Some(&format!("initial-{i}")), &"x".repeat(4096)))
            .collect();
        store.append(&key("s1"), &initial).unwrap();
        let dest = dir.join("backups/snapshot.sqlite");
        let (ready, started) = std::sync::mpsc::sync_channel(0);
        let (resume, paused) = std::sync::mpsc::channel();
        *store.read_started.lock() = Some((ready, Some(paused)));
        let (finished, completion) = std::sync::mpsc::channel();
        let backup = Arc::clone(&store);
        let backup_path = dest.clone();
        let worker = std::thread::spawn(move || {
            finished.send(backup.backup_to(backup_path)).unwrap();
        });
        started.recv_timeout(Duration::from_secs(30)).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let count = Arc::new(AtomicUsize::new(0));
        let writer = Arc::clone(&store);
        let writing = Arc::clone(&stop);
        let writes = Arc::clone(&count);
        let (committed, first_write) = std::sync::mpsc::channel();
        let appender = std::thread::spawn(move || {
            let mut i = 0;
            // At least one acknowledged append; bounded to avoid filling disk
            // even if a future regression makes the backup fail to finish.
            while i < 100_000 && (i == 0 || !writing.load(Ordering::Acquire)) {
                writer
                    .append(
                        &key("s1"),
                        &[entry(Some(&format!("live-{i}")), "concurrent")],
                    )
                    .unwrap();
                writes.fetch_add(1, Ordering::Release);
                if i == 0 {
                    committed.send(()).unwrap();
                }
                i += 1;
            }
        });
        first_write.recv_timeout(Duration::from_secs(30)).unwrap();
        // The snapshot is still pinned and backup stepping is paused. This
        // committed append must never leak into the restored database.
        resume.send(()).unwrap();
        let result = completion.recv_timeout(Duration::from_secs(30));
        let exhausted = count.load(Ordering::Acquire) == 100_000;
        stop.store(true, Ordering::Release);
        appender.join().unwrap();
        result
            .expect("backup must finish under continued writes")
            .unwrap();
        worker.join().unwrap();
        assert!(
            !exhausted,
            "backup must finish while writes continue, not after the safety cap"
        );
        assert!(count.load(Ordering::Acquire) > 0);
        let restored = SessionStore::open(&dest).unwrap();
        assert_eq!(
            restored.load(&key("s1")).unwrap().unwrap(),
            initial,
            "backup must contain the pinned snapshot, not later appends"
        );
        assert_eq!(
            restored
                .conn
                .lock()
                .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert_eq!(
            store.load(&key("s1")).unwrap().unwrap().len(),
            2000 + count.load(Ordering::Acquire)
        );
        let (busy, frames, copied): (i64, i64, i64) = store
            .conn
            .lock()
            .query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(busy, 0);
        assert_eq!(frames, copied);
        drop(restored);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn backup_rejects_a_sidecar_selected_path_outside_managed_storage() {
        let dir = std::env::temp_dir().join(format!("cognia-store-deny-{}", now_ms()));
        let store = SessionStore::open(dir.join("db.sqlite")).expect("open");
        let outside = dir
            .parent()
            .expect("temp parent")
            .join("sidecar-selected.sqlite");

        assert!(store.backup_to(&outside).is_err());
        assert!(!outside.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stats_counts_sessions_not_just_rows() {
        let store = SessionStore::in_memory().expect("store");
        store
            .append(&key("a"), &[entry(Some("1"), "x")])
            .expect("append");
        store
            .append(&key("a"), &[entry(Some("2"), "y")])
            .expect("append");
        store
            .append(&key("b"), &[entry(Some("3"), "z")])
            .expect("append");
        let stats = store.stats().expect("stats");
        assert_eq!(stats["entries"], 3);
        assert_eq!(stats["sessions"], 2);
    }

    #[test]
    fn acp_catalog_is_additive_scoped_and_deletable() {
        let store = SessionStore::in_memory().expect("store");
        let owner = StoreScope {
            tenant: "tenant-a".into(),
            workspace: "workspace-a".into(),
        };
        let other = StoreScope {
            tenant: "tenant-b".into(),
            workspace: "workspace-a".into(),
        };
        let row = AcpSessionRow {
            acp_session_id: "acp-1".into(),
            sdk_session_id: Some("sdk-1".into()),
            cwd: "/repo".into(),
            additional_directories: vec!["/shared".into()],
            title: Some("Session".into()),
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:01Z".into(),
            config_values: json!({ "model": "default" }),
            lifecycle: "active".into(),
        };
        store.upsert_acp_session(&owner, &row).expect("upsert");

        assert_eq!(
            store
                .get_acp_session(&owner, "acp-1")
                .expect("get")
                .expect("row")
                .additional_directories,
            vec!["/shared"]
        );
        assert!(store
            .get_acp_session(&other, "acp-1")
            .expect("isolated")
            .is_none());
        assert_eq!(
            store
                .list_acp_sessions(&owner, Some("/repo"), 0, 50)
                .expect("list")
                .len(),
            1
        );
        assert!(store.delete_acp_session(&owner, "acp-1").expect("delete"));
        assert!(store
            .get_acp_session(&owner, "acp-1")
            .expect("deleted")
            .is_none());
    }
}
