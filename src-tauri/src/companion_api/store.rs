//! Phase D — AppStore trait and SQLite implementation.
//!
//! # Why this exists
//!
//! In the Tauri-shipped desktop today, the canonical store of sessions /
//! messages / paired devices lives in the WebView's Dexie database. The
//! companion HTTP server talks to it via three "bridges"
//! (`sync_bridge`, `desktop_messages_bridge`, `desktop_writes_bridge`) that
//! emit Tauri events the WebView listens for, then collects responses.
//!
//! The headless `cognia-server` binary (ADR-0014) doesn't have a WebView —
//! it IS the canonical store. `AppStore` is the abstraction that lets the
//! same RPC handlers run against either backend:
//!
//! - In Tauri mode (today): bridges continue to work as-is. `AppStore` is
//!   unused on the hot path.
//! - In headless mode (this milestone): a `SqliteAppStore` instance is the
//!   canonical store; RPC handlers call it directly without round-tripping
//!   to a WebView.
//!
//! Phase D ships the trait + SQLite impl + a wiring example through the
//! headless binary entry. Rewriting every existing RPC handler to use
//! `AppStore` instead of the bridge is intentionally deferred — that's an
//! incremental refactor that doesn't need to land all at once.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    pub rows: Vec<SessionRow>,
    pub total: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub rows: Vec<MessageRow>,
    pub total: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u32>,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid input: {0}")]
    InvalidInput(String),
}

// ---------------------------------------------------------------------------
// AppStore trait
// ---------------------------------------------------------------------------

/// The abstraction RPC handlers should consume in headless mode.
///
/// Async by contract because real implementations talk to a database;
/// the SQLite impl in this file uses `tokio::task::spawn_blocking` to keep
/// the runtime non-blocking.
#[async_trait]
pub trait AppStore: Send + Sync {
    async fn list_sessions(
        &self,
        limit: u32,
        offset: u32,
        before: Option<i64>,
    ) -> Result<SessionPage, StoreError>;

    async fn get_messages_by_session(
        &self,
        session_id: &str,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<MessagePage, StoreError>;

    /// Newest-first bounded scan used by transcript timeline projection.
    async fn get_messages_by_session_reverse(
        &self,
        session_id: &str,
        limit: u32,
        offset: u32,
    ) -> Result<MessagePage, StoreError>;

    /// One implicit user turn, bounded by the next user row.
    async fn get_implicit_turn_messages(
        &self,
        session_id: &str,
        anchor_message_id: &str,
        limit: u32,
        offset: u32,
    ) -> Result<MessagePage, StoreError>;

    async fn transcript_revision(&self, session_id: &str) -> Result<u64, StoreError>;

    async fn create_message(
        &self,
        session_id: &str,
        content: &str,
        role: &str,
    ) -> Result<MessageRow, StoreError>;

    async fn update_message_content(
        &self,
        message_id: &str,
        content: &str,
    ) -> Result<(), StoreError>;

    async fn delete_message(&self, message_id: &str) -> Result<(), StoreError>;

    /// Used by the headless server's pair flow to seed a session when the
    /// phone first connects (no chat history exists yet on a fresh deploy).
    async fn upsert_session(
        &self,
        id: &str,
        title: &str,
        kind: &str,
    ) -> Result<SessionRow, StoreError>;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

pub mod sqlite {
    use std::path::Path;
    use std::sync::Arc;

    use async_trait::async_trait;
    use parking_lot::Mutex;
    use rusqlite::{params, Connection, OptionalExtension};
    use uuid::Uuid;

    use super::*;

    /// Single-connection SQLite-backed AppStore. Single-tenant means we
    /// don't need a pool; the Mutex serializes access.
    pub struct SqliteAppStore {
        conn: Arc<Mutex<Connection>>,
    }

    impl SqliteAppStore {
        pub fn open<P: AsRef<Path>>(path: P) -> Result<Arc<Self>, StoreError> {
            let conn = Connection::open(path)?;
            initialize_schema(&conn)?;
            Ok(Arc::new(Self {
                conn: Arc::new(Mutex::new(conn)),
            }))
        }

        /// In-memory store — used in tests.
        pub fn in_memory() -> Result<Arc<Self>, StoreError> {
            let conn = Connection::open_in_memory()?;
            initialize_schema(&conn)?;
            Ok(Arc::new(Self {
                conn: Arc::new(Mutex::new(conn)),
            }))
        }
    }

    const SCHEMA_SQL: &str = "
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            kind TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            transcript_revision INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_updated_at
            ON sessions(updated_at DESC);

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session_created
            ON messages(session_id, created_at ASC);
    ";

    fn initialize_schema(conn: &Connection) -> Result<(), StoreError> {
        conn.execute_batch(SCHEMA_SQL)?;
        let mut columns = conn.prepare("PRAGMA table_info(sessions)")?;
        let has_revision = columns
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|name| name == "transcript_revision");
        if !has_revision {
            conn.execute(
                "ALTER TABLE sessions ADD COLUMN transcript_revision INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        Ok(())
    }

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    }

    #[async_trait]
    impl AppStore for SqliteAppStore {
        async fn list_sessions(
            &self,
            limit: u32,
            offset: u32,
            before: Option<i64>,
        ) -> Result<SessionPage, StoreError> {
            let conn = Arc::clone(&self.conn);
            tokio::task::spawn_blocking(move || {
                let c = conn.lock();

                let total: u32 = match before {
                    Some(b) => c.query_row(
                        "SELECT COUNT(*) FROM sessions WHERE updated_at < ?1",
                        params![b],
                        |row| row.get::<_, i64>(0).map(|n| n as u32),
                    )?,
                    None => c.query_row("SELECT COUNT(*) FROM sessions", [], |row| {
                        row.get::<_, i64>(0).map(|n| n as u32)
                    })?,
                };

                let sql = match before {
                    Some(_) => {
                        "SELECT id, title, kind, created_at, updated_at
                         FROM sessions WHERE updated_at < ?1
                         ORDER BY updated_at DESC LIMIT ?2 OFFSET ?3"
                    }
                    None => {
                        "SELECT id, title, kind, created_at, updated_at
                         FROM sessions
                         ORDER BY updated_at DESC LIMIT ?1 OFFSET ?2"
                    }
                };

                let rows: Vec<SessionRow> = match before {
                    Some(b) => {
                        let mut stmt = c.prepare(sql)?;
                        let iter = stmt
                            .query_map(params![b, limit as i64, offset as i64], row_to_session)?;
                        iter.collect::<Result<Vec<_>, _>>()?
                    }
                    None => {
                        let mut stmt = c.prepare(sql)?;
                        let iter =
                            stmt.query_map(params![limit as i64, offset as i64], row_to_session)?;
                        iter.collect::<Result<Vec<_>, _>>()?
                    }
                };

                let consumed = offset + (rows.len() as u32);
                let next_offset = if consumed < total {
                    Some(consumed)
                } else {
                    None
                };
                Ok(SessionPage {
                    rows,
                    total,
                    next_offset,
                })
            })
            .await
            .map_err(|e| StoreError::InvalidInput(format!("join: {e}")))?
        }

        async fn get_messages_by_session(
            &self,
            session_id: &str,
            limit: Option<u32>,
            offset: Option<u32>,
        ) -> Result<MessagePage, StoreError> {
            let conn = Arc::clone(&self.conn);
            let session_id = session_id.to_string();
            tokio::task::spawn_blocking(move || {
                let c = conn.lock();
                let total: u32 = c.query_row(
                    "SELECT COUNT(*) FROM messages WHERE session_id = ?1",
                    params![session_id],
                    |row| row.get::<_, i64>(0).map(|n| n as u32),
                )?;
                let limit = limit.unwrap_or(total.max(1));
                let offset = offset.unwrap_or(0);
                let mut stmt = c.prepare(
                    "SELECT id, session_id, role, content, created_at
                     FROM messages WHERE session_id = ?1
                     ORDER BY created_at ASC LIMIT ?2 OFFSET ?3",
                )?;
                let iter = stmt.query_map(
                    params![session_id, limit as i64, offset as i64],
                    row_to_message,
                )?;
                let rows: Vec<MessageRow> = iter.collect::<Result<Vec<_>, _>>()?;
                let consumed = offset + (rows.len() as u32);
                let next_offset = if consumed < total {
                    Some(consumed)
                } else {
                    None
                };
                Ok(MessagePage {
                    rows,
                    total,
                    next_offset,
                })
            })
            .await
            .map_err(|e| StoreError::InvalidInput(format!("join: {e}")))?
        }

        async fn get_messages_by_session_reverse(
            &self,
            session_id: &str,
            limit: u32,
            offset: u32,
        ) -> Result<MessagePage, StoreError> {
            let conn = Arc::clone(&self.conn);
            let session_id = session_id.to_string();
            tokio::task::spawn_blocking(move || {
                let c = conn.lock();
                let total: u32 = c.query_row(
                    "SELECT COUNT(*) FROM messages WHERE session_id = ?1",
                    params![session_id],
                    |row| row.get::<_, i64>(0).map(|n| n as u32),
                )?;
                let mut stmt = c.prepare(
                    "SELECT id, session_id, role, content, created_at
                     FROM messages WHERE session_id = ?1
                     ORDER BY created_at DESC, rowid DESC LIMIT ?2 OFFSET ?3",
                )?;
                let rows = stmt
                    .query_map(
                        params![session_id, limit as i64, offset as i64],
                        row_to_message,
                    )?
                    .collect::<Result<Vec<_>, _>>()?;
                let consumed = offset + rows.len() as u32;
                Ok(MessagePage {
                    rows,
                    total,
                    next_offset: (consumed < total).then_some(consumed),
                })
            })
            .await
            .map_err(|e| StoreError::InvalidInput(format!("join: {e}")))?
        }

        async fn get_implicit_turn_messages(
            &self,
            session_id: &str,
            anchor_message_id: &str,
            limit: u32,
            offset: u32,
        ) -> Result<MessagePage, StoreError> {
            let conn = Arc::clone(&self.conn);
            let session_id = session_id.to_string();
            let anchor_message_id = anchor_message_id.to_string();
            tokio::task::spawn_blocking(move || {
                let c = conn.lock();
                let anchor_rowid: i64 = c
                    .query_row(
                        "SELECT rowid FROM messages WHERE id = ?1 AND session_id = ?2",
                        params![anchor_message_id, session_id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .ok_or_else(|| StoreError::NotFound(anchor_message_id.clone()))?;
                let next_user_rowid: Option<i64> = c.query_row(
                    "SELECT MIN(rowid) FROM messages
                     WHERE session_id = ?1 AND role = 'user' AND rowid > ?2",
                    params![session_id, anchor_rowid],
                    |row| row.get(0),
                )?;
                let total: u32 = c.query_row(
                    "SELECT COUNT(*) FROM messages
                     WHERE session_id = ?1 AND rowid >= ?2
                       AND (?3 IS NULL OR rowid < ?3)",
                    params![session_id, anchor_rowid, next_user_rowid],
                    |row| row.get::<_, i64>(0).map(|n| n as u32),
                )?;
                let mut stmt = c.prepare(
                    "SELECT id, session_id, role, content, created_at
                     FROM messages
                     WHERE session_id = ?1 AND rowid >= ?2
                       AND (?3 IS NULL OR rowid < ?3)
                     ORDER BY rowid ASC LIMIT ?4 OFFSET ?5",
                )?;
                let rows = stmt
                    .query_map(
                        params![
                            session_id,
                            anchor_rowid,
                            next_user_rowid,
                            limit as i64,
                            offset as i64
                        ],
                        row_to_message,
                    )?
                    .collect::<Result<Vec<_>, _>>()?;
                let consumed = offset + rows.len() as u32;
                Ok(MessagePage {
                    rows,
                    total,
                    next_offset: (consumed < total).then_some(consumed),
                })
            })
            .await
            .map_err(|e| StoreError::InvalidInput(format!("join: {e}")))?
        }

        async fn transcript_revision(&self, session_id: &str) -> Result<u64, StoreError> {
            let conn = Arc::clone(&self.conn);
            let session_id = session_id.to_string();
            tokio::task::spawn_blocking(move || {
                let c = conn.lock();
                c.query_row(
                    "SELECT transcript_revision FROM sessions WHERE id = ?1",
                    params![session_id],
                    |row| row.get::<_, i64>(0).map(|value| value.max(0) as u64),
                )
                .optional()?
                .ok_or(StoreError::NotFound(session_id))
            })
            .await
            .map_err(|e| StoreError::InvalidInput(format!("join: {e}")))?
        }

        async fn create_message(
            &self,
            session_id: &str,
            content: &str,
            role: &str,
        ) -> Result<MessageRow, StoreError> {
            let conn = Arc::clone(&self.conn);
            let session_id = session_id.to_string();
            let content = content.to_string();
            let role = role.to_string();
            tokio::task::spawn_blocking(move || {
                let c = conn.lock();
                let id = Uuid::new_v4().to_string();
                let now = now_ms();
                c.execute(
                    "INSERT INTO messages (id, session_id, role, content, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![id, session_id, role, content, now],
                )?;
                c.execute(
                    "UPDATE sessions
                     SET updated_at = CASE WHEN updated_at >= ?1 THEN updated_at + 1 ELSE ?1 END,
                         transcript_revision = transcript_revision + 1
                     WHERE id = ?2",
                    params![now, session_id],
                )?;
                Ok(MessageRow {
                    id,
                    session_id,
                    role,
                    content,
                    created_at: now,
                })
            })
            .await
            .map_err(|e| StoreError::InvalidInput(format!("join: {e}")))?
        }

        async fn update_message_content(
            &self,
            message_id: &str,
            content: &str,
        ) -> Result<(), StoreError> {
            let conn = Arc::clone(&self.conn);
            let message_id = message_id.to_string();
            let content = content.to_string();
            tokio::task::spawn_blocking(move || {
                let c = conn.lock();
                let session_id: Option<String> = c
                    .query_row(
                        "SELECT session_id FROM messages WHERE id = ?1",
                        params![message_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                let rows = c.execute(
                    "UPDATE messages SET content = ?1 WHERE id = ?2",
                    params![content, message_id],
                )?;
                if rows == 0 {
                    Err(StoreError::NotFound(message_id))
                } else {
                    if let Some(session_id) = session_id {
                        let now = now_ms();
                        c.execute(
                            "UPDATE sessions
                             SET updated_at = CASE WHEN updated_at >= ?1 THEN updated_at + 1 ELSE ?1 END,
                                 transcript_revision = transcript_revision + 1
                             WHERE id = ?2",
                            params![now, session_id],
                        )?;
                    }
                    Ok(())
                }
            })
            .await
            .map_err(|e| StoreError::InvalidInput(format!("join: {e}")))?
        }

        async fn delete_message(&self, message_id: &str) -> Result<(), StoreError> {
            let conn = Arc::clone(&self.conn);
            let message_id = message_id.to_string();
            tokio::task::spawn_blocking(move || {
                let c = conn.lock();
                let session_id: Option<String> = c
                    .query_row(
                        "SELECT session_id FROM messages WHERE id = ?1",
                        params![message_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                c.execute("DELETE FROM messages WHERE id = ?1", params![message_id])?;
                if let Some(session_id) = session_id {
                    let now = now_ms();
                    c.execute(
                        "UPDATE sessions
                         SET updated_at = CASE WHEN updated_at >= ?1 THEN updated_at + 1 ELSE ?1 END,
                             transcript_revision = transcript_revision + 1
                         WHERE id = ?2",
                        params![now, session_id],
                    )?;
                }
                Ok(())
            })
            .await
            .map_err(|e| StoreError::InvalidInput(format!("join: {e}")))?
        }

        async fn upsert_session(
            &self,
            id: &str,
            title: &str,
            kind: &str,
        ) -> Result<SessionRow, StoreError> {
            let conn = Arc::clone(&self.conn);
            let id = id.to_string();
            let title = title.to_string();
            let kind = kind.to_string();
            tokio::task::spawn_blocking(move || {
                let c = conn.lock();
                let now = now_ms();
                // Try INSERT, fall back to UPDATE on conflict.
                let inserted = c.execute(
                    "INSERT OR IGNORE INTO sessions (id, title, kind, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?4)",
                    params![id, title, kind, now],
                )?;
                let (created_at, updated_at) = if inserted == 0 {
                    c.execute(
                        "UPDATE sessions SET title = ?1, kind = ?2, updated_at = ?3
                         WHERE id = ?4",
                        params![title, kind, now, id],
                    )?;
                    c.query_row(
                        "SELECT created_at, updated_at FROM sessions WHERE id = ?1",
                        params![id],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                    )?
                } else {
                    (now, now)
                };
                Ok(SessionRow {
                    id,
                    title,
                    kind,
                    created_at,
                    updated_at,
                })
            })
            .await
            .map_err(|e| StoreError::InvalidInput(format!("join: {e}")))?
        }
    }

    fn row_to_session(row: &rusqlite::Row<'_>) -> Result<SessionRow, rusqlite::Error> {
        Ok(SessionRow {
            id: row.get(0)?,
            title: row.get(1)?,
            kind: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    }

    fn row_to_message(row: &rusqlite::Row<'_>) -> Result<MessageRow, rusqlite::Error> {
        Ok(MessageRow {
            id: row.get(0)?,
            session_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            created_at: row.get(4)?,
        })
    }

    #[cfg(test)]
    mod tests {
        use super::super::AppStore;
        use super::StoreError;
        use super::{initialize_schema, SqliteAppStore};
        use rusqlite::Connection;

        #[tokio::test]
        async fn roundtrip_session_and_messages() {
            let store = SqliteAppStore::in_memory().expect("open");
            let session = store
                .upsert_session("sess-1", "Hello", "direct")
                .await
                .expect("upsert");
            assert_eq!(session.id, "sess-1");

            let msg = store
                .create_message("sess-1", "first", "user")
                .await
                .expect("create");

            let page = store
                .get_messages_by_session("sess-1", None, None)
                .await
                .expect("get");
            assert_eq!(page.rows.len(), 1);
            assert_eq!(page.rows[0].id, msg.id);
            assert_eq!(page.rows[0].content, "first");

            store
                .update_message_content(&msg.id, "edited")
                .await
                .expect("update");
            let page = store
                .get_messages_by_session("sess-1", None, None)
                .await
                .expect("get-after");
            assert_eq!(page.rows[0].content, "edited");

            store.delete_message(&msg.id).await.expect("delete");
            let page = store
                .get_messages_by_session("sess-1", None, None)
                .await
                .expect("get-after-del");
            assert!(page.rows.is_empty());
        }

        #[tokio::test]
        async fn list_sessions_orders_by_updated_at_desc() {
            let store = SqliteAppStore::in_memory().expect("open");
            store.upsert_session("a", "alpha", "direct").await.unwrap();
            // SQLite may use the same `now_ms()` for both upserts when the
            // test runs in <1ms. Force a difference by writing a message,
            // which bumps updated_at on the parent session.
            tokio::time::sleep(tokio::time::Duration::from_millis(2)).await;
            store.upsert_session("b", "beta", "direct").await.unwrap();

            let page = store.list_sessions(10, 0, None).await.expect("list");
            assert_eq!(page.total, 2);
            assert_eq!(page.rows.len(), 2);
            assert_eq!(page.rows[0].id, "b", "newest session first");
        }

        #[tokio::test]
        async fn list_sessions_paginates() {
            let store = SqliteAppStore::in_memory().expect("open");
            for i in 0..5 {
                store
                    .upsert_session(&format!("s{i}"), &format!("t{i}"), "direct")
                    .await
                    .unwrap();
                tokio::time::sleep(tokio::time::Duration::from_millis(2)).await;
            }
            let page1 = store.list_sessions(2, 0, None).await.unwrap();
            assert_eq!(page1.rows.len(), 2);
            assert_eq!(page1.next_offset, Some(2));
            let page2 = store.list_sessions(2, 2, None).await.unwrap();
            assert_eq!(page2.rows.len(), 2);
            assert_eq!(page2.next_offset, Some(4));
            let page3 = store.list_sessions(2, 4, None).await.unwrap();
            assert_eq!(page3.rows.len(), 1);
            assert!(page3.next_offset.is_none());
        }

        #[tokio::test]
        async fn update_message_missing_returns_not_found() {
            let store = SqliteAppStore::in_memory().expect("open");
            let err = store
                .update_message_content("nope", "x")
                .await
                .expect_err("missing");
            assert!(matches!(err, StoreError::NotFound(_)));
        }

        #[tokio::test]
        async fn transcript_reads_are_reverse_bounded_and_turn_scoped() {
            let store = SqliteAppStore::in_memory().expect("open");
            store
                .upsert_session("s1", "Transcript", "direct")
                .await
                .unwrap();
            let first = store.create_message("s1", "one", "user").await.unwrap();
            store
                .create_message("s1", "answer one", "assistant")
                .await
                .unwrap();
            store.create_message("s1", "two", "user").await.unwrap();
            store
                .create_message("s1", "answer two", "assistant")
                .await
                .unwrap();

            let newest = store
                .get_messages_by_session_reverse("s1", 2, 0)
                .await
                .unwrap();
            assert_eq!(
                newest
                    .rows
                    .iter()
                    .map(|row| row.content.as_str())
                    .collect::<Vec<_>>(),
                ["answer two", "two"]
            );
            let first_turn = store
                .get_implicit_turn_messages("s1", &first.id, 10, 0)
                .await
                .unwrap();
            assert_eq!(
                first_turn
                    .rows
                    .iter()
                    .map(|row| row.content.as_str())
                    .collect::<Vec<_>>(),
                ["one", "answer one"]
            );
        }

        #[tokio::test]
        async fn transcript_revision_changes_for_message_mutations() {
            let store = SqliteAppStore::in_memory().expect("open");
            store
                .upsert_session("s1", "Transcript", "direct")
                .await
                .unwrap();
            assert_eq!(store.transcript_revision("s1").await.unwrap(), 0);

            let message = store.create_message("s1", "one", "user").await.unwrap();
            assert_eq!(store.transcript_revision("s1").await.unwrap(), 1);
            store
                .update_message_content(&message.id, "edited")
                .await
                .unwrap();
            assert_eq!(store.transcript_revision("s1").await.unwrap(), 2);
            store.delete_message(&message.id).await.unwrap();
            assert_eq!(store.transcript_revision("s1").await.unwrap(), 3);
        }

        #[test]
        fn schema_upgrade_adds_transcript_revision_without_rebuilding_messages() {
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(
                "CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );",
            )
            .unwrap();

            initialize_schema(&conn).unwrap();

            let column_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('sessions')
                     WHERE name = 'transcript_revision'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(column_count, 1);
        }
    }
}
