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
use rusqlite::{params, types::Type, Connection, OptionalExtension, Row};
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
/// One connection behind a mutex rather than a pool: appends arrive at ~100ms
/// cadence per active turn, which a single writer absorbs easily, and SQLite
/// serialises writers anyway. The mutex is what makes the read-fold-write
/// around summaries a real critical section instead of a hopeful one.
pub struct SessionStore {
    conn: Arc<Mutex<Connection>>,
    path: Option<PathBuf>,
}

impl SessionStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Arc<Self>, String> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("sessionStore: mkdir: {e}"))?;
        }
        let conn = Connection::open(&path).map_err(|e| format!("sessionStore: open: {e}"))?;
        conn.execute_batch(SCHEMA_SQL)
            .map_err(|e| format!("sessionStore: schema: {e}"))?;
        restrict_permissions(&path);
        Ok(Arc::new(Self {
            conn: Arc::new(Mutex::new(conn)),
            path: Some(path),
        }))
    }

    /// In-memory store for tests. Same schema, no retention timer.
    #[cfg(test)]
    pub fn in_memory() -> Result<Arc<Self>, String> {
        let conn = Connection::open_in_memory().map_err(|e| format!("sessionStore: open: {e}"))?;
        conn.execute_batch(SCHEMA_SQL)
            .map_err(|e| format!("sessionStore: schema: {e}"))?;
        Ok(Arc::new(Self {
            conn: Arc::new(Mutex::new(conn)),
            path: None,
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
        self.conn
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
        let guard = self.conn.lock();
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
            .transaction()
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
        let guard = self.conn.lock();

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
        let guard = self.conn.lock();
        let mut stmt = guard
            .prepare(
                "SELECT session_id, MAX(written_at) AS mtime FROM entries
                 WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
                 GROUP BY session_id
                 ORDER BY mtime DESC",
            )
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
    }

    /// Every `subpath` under a session — the subagent transcripts resume needs.
    /// The main transcript's empty subpath is excluded: it is not a subkey.
    pub fn list_subkeys(
        &self,
        scope: &StoreScope,
        project_key: &str,
        session_id: &str,
    ) -> Result<Vec<String>, String> {
        let guard = self.conn.lock();
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
        let guard = self.conn.lock();
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
                        data: serde_json::from_str(&raw).unwrap_or(Value::Null),
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
            .transaction()
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
        let guard = self.conn.lock();
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
                    data: serde_json::from_str(&raw).unwrap_or(Value::Null),
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
            .transaction()
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
            .transaction()
            .map_err(|e| format!("sessionStore: begin: {e}"))?;

        // The subquery groups by session so a session whose LAST write is
        // recent survives even if its first entries predate the cutoff.
        let removed = tx
            .execute(
                "DELETE FROM entries WHERE (tenant, workspace, project_key, session_id) IN (
                     SELECT tenant, workspace, project_key, session_id FROM entries
                     GROUP BY tenant, workspace, project_key, session_id
                     HAVING MAX(written_at) < ?1
                 )",
                params![cutoff],
            )
            .map_err(|e| format!("sessionStore: prune: {e}"))?;
        tx.execute("DELETE FROM summaries WHERE mtime < ?1", params![cutoff])
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
        let guard = self.conn.lock();
        guard
            .backup(rusqlite::MAIN_DB, dest, None)
            .map_err(|e| format!("sessionStore: backup: {e}"))?;
        restrict_permissions(dest);
        Ok(())
    }

    /// Row counts per table — for the settings diagnostics panel.
    pub fn stats(&self) -> Result<HashMap<String, i64>, String> {
        let guard = self.conn.lock();
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
