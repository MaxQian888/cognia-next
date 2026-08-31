//! SQLite-backed run-state mirror.
//!
//! The Dexie-side event log in the webview is the canonical record of what
//! every step did. This file persists ONLY a thin shadow of the run
//! envelope (one row per run with status + last-completed-step + frozen
//! snapshot) so that:
//!
//!   1. A webview crash + reload doesn't lose the in-flight run; the TS
//!      orchestrator re-hydrates from `Self::list_in_flight()` on boot.
//!   2. The Rust trigger daemon can answer "is this workflow already
//!      running?" without needing access to Dexie.
//!
//! Two design rules:
//!
//! - **Append-on-first-persist + update-thereafter** — the row is keyed by
//!   `run_id` and rewritten in place. We never insert a second row for the
//!   same run.
//! - **Snapshot is mandatory on first persist** — once stored we never need
//!   it from TS again. Subsequent persists carry just status + last_step_id.

use std::fs;
use std::path::{Path, PathBuf};

use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value as JsonValue;

use super::types::{
    InFlightRunRow, PersistRunStateInput, RunStatus, WorkflowWaitEventRow,
    WorkflowWaitpointDecisionInput, WorkflowWaitpointRow,
};

#[derive(Debug, thiserror::Error)]
pub enum MirrorError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("serde_json: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("invalid status '{0}'")]
    InvalidStatus(String),
    #[error("missing snapshot — call persist with snapshot on first write for run '{0}'")]
    MissingSnapshot(String),
    #[error("invalid waitpoint terminal status '{0}'")]
    InvalidWaitpointStatus(String),
}

pub type Result<T> = std::result::Result<T, MirrorError>;

pub struct RunMirror {
    /// On-disk path; `None` for an in-memory (test) connection that is filled
    /// eagerly because it can't be reopened from a path.
    path: Option<PathBuf>,
    conn: OnceCell<Mutex<Connection>>,
}

impl RunMirror {
    /// Register the mirror DB path. The SQLite connection (file open + schema
    /// creation) is opened **lazily on first use**, not here, so it stays off
    /// the synchronous Tauri startup path — nothing at boot reads the mirror.
    /// The cron daemon's first tick and the TS orchestrator's run-state calls
    /// are the first touches, both off the main thread.
    pub fn open(path: PathBuf) -> Result<Self> {
        Ok(Self {
            path: Some(path),
            conn: OnceCell::new(),
        })
    }

    /// Open an in-memory database. Used by tests so they don't touch disk.
    /// In-memory connections can't be reopened from a path, so the cell is
    /// filled eagerly here.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            r#"
            CREATE TABLE workflow_run_mirror (
                run_id          TEXT PRIMARY KEY,
                workflow_id     TEXT NOT NULL,
                status          TEXT NOT NULL,
                last_step_id    TEXT,
                snapshot_json   TEXT NOT NULL,
                started_at      INTEGER NOT NULL,
                updated_at      INTEGER NOT NULL
            );
            CREATE TABLE workflow_waitpoint (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
                run_id TEXT NOT NULL, workflow_id TEXT NOT NULL, step_id TEXT NOT NULL,
                event_key TEXT NOT NULL, correlation_id TEXT, title TEXT, message TEXT,
                created_at INTEGER NOT NULL, not_before INTEGER NOT NULL, expires_at INTEGER,
                resolution_json TEXT, notification_sent_at INTEGER,
                resolution_notification_sent_at INTEGER, updated_at INTEGER NOT NULL
            );
            CREATE TABLE workflow_wait_event (
                id TEXT PRIMARY KEY, event_key TEXT NOT NULL, correlation_id TEXT,
                source TEXT NOT NULL, data_json TEXT, emitted_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL, consumed_by_waitpoint_id TEXT, consumed_at INTEGER
            );
            "#,
        )?;
        let cell = OnceCell::new();
        let _ = cell.set(Mutex::new(conn));
        Ok(Self {
            path: None,
            conn: cell,
        })
    }

    /// Lazily open (and schema-init) the file-backed connection on first use.
    /// On open error the cell stays empty so a later call can retry.
    fn conn(&self) -> Result<&Mutex<Connection>> {
        self.conn.get_or_try_init(|| {
            let path = self
                .path
                .clone()
                .ok_or_else(|| MirrorError::Io(std::io::Error::other("run mirror path unset")))?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            let conn = Connection::open(path)?;
            conn.execute_batch(
                r#"
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = NORMAL;

                CREATE TABLE IF NOT EXISTS workflow_run_mirror (
                    run_id          TEXT PRIMARY KEY,
                    workflow_id     TEXT NOT NULL,
                    status          TEXT NOT NULL,
                    last_step_id    TEXT,
                    snapshot_json   TEXT NOT NULL,
                    started_at      INTEGER NOT NULL,
                    updated_at      INTEGER NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_run_mirror_status
                    ON workflow_run_mirror(status);
                CREATE INDEX IF NOT EXISTS idx_run_mirror_workflow
                    ON workflow_run_mirror(workflow_id);

                CREATE TABLE IF NOT EXISTS workflow_waitpoint (
                    id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
                    run_id TEXT NOT NULL, workflow_id TEXT NOT NULL, step_id TEXT NOT NULL,
                    event_key TEXT NOT NULL, correlation_id TEXT, title TEXT, message TEXT,
                    created_at INTEGER NOT NULL, not_before INTEGER NOT NULL, expires_at INTEGER,
                    resolution_json TEXT, notification_sent_at INTEGER,
                    resolution_notification_sent_at INTEGER, updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_workflow_waitpoint_pending
                    ON workflow_waitpoint(kind, status, created_at);
                CREATE INDEX IF NOT EXISTS idx_workflow_waitpoint_event
                    ON workflow_waitpoint(event_key, status, not_before);

                CREATE TABLE IF NOT EXISTS workflow_wait_event (
                    id TEXT PRIMARY KEY, event_key TEXT NOT NULL, correlation_id TEXT,
                    source TEXT NOT NULL, data_json TEXT, emitted_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL, consumed_by_waitpoint_id TEXT, consumed_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_workflow_wait_event_key
                    ON workflow_wait_event(event_key, emitted_at);
                CREATE INDEX IF NOT EXISTS idx_workflow_wait_event_expiry
                    ON workflow_wait_event(expires_at);
                "#,
            )?;
            Ok(Mutex::new(conn))
        })
    }

    /// Upsert (insert-or-update) a mirror row from a persist call. The first
    /// persist for a run id MUST include a snapshot; subsequent persists may
    /// omit it (the existing snapshot is preserved).
    pub fn persist(&self, input: &PersistRunStateInput) -> Result<()> {
        let status = RunStatus::parse(&input.status)
            .ok_or_else(|| MirrorError::InvalidStatus(input.status.clone()))?;
        let now = current_millis();
        let conn = self.conn()?.lock();

        let existing_snapshot: Option<String> = conn
            .query_row(
                "SELECT snapshot_json FROM workflow_run_mirror WHERE run_id = ?1",
                params![input.run_id],
                |row| row.get(0),
            )
            .optional()?;

        let snapshot_json = if let Some(value) = input.snapshot.as_ref() {
            serde_json::to_string(value)?
        } else if let Some(prior) = existing_snapshot {
            prior
        } else {
            return Err(MirrorError::MissingSnapshot(input.run_id.clone()));
        };

        let started_at: i64 = conn
            .query_row(
                "SELECT started_at FROM workflow_run_mirror WHERE run_id = ?1",
                params![input.run_id],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(now);

        conn.execute(
            r#"
            INSERT INTO workflow_run_mirror
                (run_id, workflow_id, status, last_step_id, snapshot_json, started_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(run_id) DO UPDATE SET
                status        = excluded.status,
                last_step_id  = excluded.last_step_id,
                snapshot_json = excluded.snapshot_json,
                updated_at    = excluded.updated_at
            "#,
            params![
                input.run_id,
                input.workflow_id,
                status.as_str(),
                input.last_step_id,
                snapshot_json,
                started_at,
                now,
            ],
        )?;
        Ok(())
    }

    /// List every run whose status is still in flight. The TS boot path
    /// re-emits each as a `workflow:resume` event so the orchestrator picks
    /// up where the crashed run left off.
    pub fn list_in_flight(&self) -> Result<Vec<InFlightRunRow>> {
        let conn = self.conn()?.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT run_id, workflow_id, last_step_id, snapshot_json, started_at, status
            FROM workflow_run_mirror
            WHERE status IN ('pending', 'running', 'waiting', 'paused')
            ORDER BY started_at ASC
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            let snapshot_json: String = row.get(3)?;
            Ok(MirrorRowRaw {
                run_id: row.get(0)?,
                workflow_id: row.get(1)?,
                last_step_id: row.get(2)?,
                snapshot_json,
                started_at: row.get(4)?,
                status: row.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for raw in rows {
            let raw = raw?;
            let snapshot: JsonValue = serde_json::from_str(&raw.snapshot_json)?;
            out.push(InFlightRunRow {
                run_id: raw.run_id,
                workflow_id: raw.workflow_id,
                last_step_id: raw.last_step_id,
                snapshot,
                started_at: raw.started_at,
            });
        }
        Ok(out)
    }

    /// Drop a mirror row — called when TS marks a run as completed. We could
    /// alternatively keep the row for audit, but the durable Dexie history is
    /// the source of truth so the mirror exists only for crash recovery.
    pub fn ack_completed(&self, run_id: &str) -> Result<()> {
        let conn = self.conn()?.lock();
        conn.execute(
            "DELETE FROM workflow_run_mirror WHERE run_id = ?1",
            params![run_id],
        )?;
        Ok(())
    }

    /// Insert a durable checkpoint once and return the originally stored row.
    /// Retrying creation after a renderer restart must not extend its deadline.
    pub fn create_waitpoint(
        &self,
        waitpoint: &WorkflowWaitpointRow,
    ) -> Result<WorkflowWaitpointRow> {
        let resolution_json = waitpoint
            .resolution
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let conn = self.conn()?.lock();
        conn.execute(
            r#"
            INSERT OR IGNORE INTO workflow_waitpoint
                (id, kind, status, run_id, workflow_id, step_id, event_key,
                 correlation_id, title, message, created_at, not_before, expires_at,
                 resolution_json, notification_sent_at,
                 resolution_notification_sent_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                    ?13, ?14, ?15, ?16, ?17)
            "#,
            params![
                waitpoint.id,
                waitpoint.kind,
                waitpoint.status,
                waitpoint.run_id,
                waitpoint.workflow_id,
                waitpoint.step_id,
                waitpoint.key,
                waitpoint.correlation_id,
                waitpoint.title,
                waitpoint.message,
                waitpoint.created_at,
                waitpoint.not_before,
                waitpoint.expires_at,
                resolution_json,
                waitpoint.notification_sent_at,
                waitpoint.resolution_notification_sent_at,
                waitpoint.updated_at,
            ],
        )?;
        query_waitpoint(&conn, &waitpoint.id)?
            .ok_or_else(|| MirrorError::Sqlite(rusqlite::Error::QueryReturnedNoRows))
    }

    pub fn get_waitpoint(&self, waitpoint_id: &str) -> Result<Option<WorkflowWaitpointRow>> {
        let conn = self.conn()?.lock();
        query_waitpoint(&conn, waitpoint_id)
    }

    pub fn list_pending_waitpoints(&self) -> Result<Vec<WorkflowWaitpointRow>> {
        let conn = self.conn()?.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, kind, status, run_id, workflow_id, step_id, event_key,
                   correlation_id, title, message, created_at, not_before, expires_at,
                   resolution_json, notification_sent_at,
                   resolution_notification_sent_at, updated_at
            FROM workflow_waitpoint
            WHERE status = 'pending'
            ORDER BY created_at ASC, id ASC
            "#,
        )?;
        let rows = stmt.query_map([], read_waitpoint_raw)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?.into_waitpoint()?);
        }
        Ok(out)
    }

    /// Resolve a checkpoint with first-writer-wins compare-and-set semantics.
    pub fn decide_waitpoint(&self, input: &WorkflowWaitpointDecisionInput) -> Result<bool> {
        if !matches!(
            input.status.as_str(),
            "resolved" | "rejected" | "timed_out" | "cancelled"
        ) {
            return Err(MirrorError::InvalidWaitpointStatus(input.status.clone()));
        }
        let resolution_json = serde_json::to_string(&input.resolution)?;
        let conn = self.conn()?.lock();
        let changed = conn.execute(
            r#"
            UPDATE workflow_waitpoint
            SET status = ?2, resolution_json = ?3, updated_at = ?4
            WHERE id = ?1 AND status = 'pending'
            "#,
            params![input.id, input.status, resolution_json, input.updated_at],
        )?;
        Ok(changed == 1)
    }

    pub fn persist_wait_event(&self, event: &WorkflowWaitEventRow) -> Result<()> {
        let data_json = event.data.as_ref().map(serde_json::to_string).transpose()?;
        let conn = self.conn()?.lock();
        conn.execute(
            r#"
            INSERT OR IGNORE INTO workflow_wait_event
                (id, event_key, correlation_id, source, data_json, emitted_at,
                 expires_at, consumed_by_waitpoint_id, consumed_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                event.id,
                event.key,
                event.correlation_id,
                event.source,
                data_json,
                event.emitted_at,
                event.expires_at,
                event.consumed_by_waitpoint_id,
                event.consumed_at,
            ],
        )?;
        Ok(())
    }

    pub fn prune_wait_events(&self, now: i64) -> Result<usize> {
        let conn = self.conn()?.lock();
        Ok(conn.execute(
            "DELETE FROM workflow_wait_event WHERE expires_at <= ?1",
            params![now],
        )?)
    }

    #[cfg(test)]
    fn count_wait_events(&self) -> Result<usize> {
        let conn = self.conn()?.lock();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM workflow_wait_event", [], |row| {
            row.get(0)
        })?;
        Ok(count.max(0) as usize)
    }

    /// Total mirror row count — used by tests and the diagnostics tab.
    #[allow(dead_code)]
    pub fn count(&self) -> Result<usize> {
        let conn = self.conn()?.lock();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM workflow_run_mirror", [], |row| {
            row.get(0)
        })?;
        Ok(count.max(0) as usize)
    }
}

struct MirrorRowRaw {
    run_id: String,
    workflow_id: String,
    last_step_id: Option<String>,
    snapshot_json: String,
    started_at: i64,
    #[allow(dead_code)]
    status: String,
}

struct WaitpointRowRaw {
    id: String,
    kind: String,
    status: String,
    run_id: String,
    workflow_id: String,
    step_id: String,
    key: String,
    correlation_id: Option<String>,
    title: Option<String>,
    message: Option<String>,
    created_at: i64,
    not_before: i64,
    expires_at: Option<i64>,
    resolution_json: Option<String>,
    notification_sent_at: Option<i64>,
    resolution_notification_sent_at: Option<i64>,
    updated_at: i64,
}

impl WaitpointRowRaw {
    fn into_waitpoint(self) -> Result<WorkflowWaitpointRow> {
        Ok(WorkflowWaitpointRow {
            id: self.id,
            kind: self.kind,
            status: self.status,
            run_id: self.run_id,
            workflow_id: self.workflow_id,
            step_id: self.step_id,
            key: self.key,
            correlation_id: self.correlation_id,
            title: self.title,
            message: self.message,
            created_at: self.created_at,
            not_before: self.not_before,
            expires_at: self.expires_at,
            resolution: self
                .resolution_json
                .map(|value| serde_json::from_str(&value))
                .transpose()?,
            notification_sent_at: self.notification_sent_at,
            resolution_notification_sent_at: self.resolution_notification_sent_at,
            updated_at: self.updated_at,
        })
    }
}

fn read_waitpoint_raw(row: &rusqlite::Row<'_>) -> rusqlite::Result<WaitpointRowRaw> {
    Ok(WaitpointRowRaw {
        id: row.get(0)?,
        kind: row.get(1)?,
        status: row.get(2)?,
        run_id: row.get(3)?,
        workflow_id: row.get(4)?,
        step_id: row.get(5)?,
        key: row.get(6)?,
        correlation_id: row.get(7)?,
        title: row.get(8)?,
        message: row.get(9)?,
        created_at: row.get(10)?,
        not_before: row.get(11)?,
        expires_at: row.get(12)?,
        resolution_json: row.get(13)?,
        notification_sent_at: row.get(14)?,
        resolution_notification_sent_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

fn query_waitpoint(conn: &Connection, waitpoint_id: &str) -> Result<Option<WorkflowWaitpointRow>> {
    let raw = conn
        .query_row(
            r#"
            SELECT id, kind, status, run_id, workflow_id, step_id, event_key,
                   correlation_id, title, message, created_at, not_before, expires_at,
                   resolution_json, notification_sent_at,
                   resolution_notification_sent_at, updated_at
            FROM workflow_waitpoint
            WHERE id = ?1
            "#,
            params![waitpoint_id],
            read_waitpoint_raw,
        )
        .optional()?;
    raw.map(WaitpointRowRaw::into_waitpoint).transpose()
}

fn current_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Resolve the on-disk path of the mirror DB. Lives next to the rest of
/// cognia's Tauri data so it shows up alongside `vectors.sqlite`.
pub fn default_mirror_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("cognia").join("workflow-runs.sqlite")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot() -> JsonValue {
        json!({
            "id": "wf_x",
            "schemaVersion": 1,
            "name": "test",
            "nodes": [],
            "edges": [],
        })
    }

    #[test]
    fn file_backed_open_is_lazy() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("workflow-runs.sqlite");
        let mirror = RunMirror::open(path.clone()).expect("register path");
        // `open` must NOT touch disk — the eager open used to run on the
        // synchronous Tauri startup path.
        assert!(!path.exists(), "mirror db created before first use");
        // First read opens + schema-inits the file.
        assert_eq!(mirror.list_in_flight().expect("list").len(), 0);
        assert!(path.exists(), "mirror db not created on first use");
    }

    #[test]
    fn first_persist_requires_a_snapshot() {
        let mirror = RunMirror::open_in_memory().unwrap();
        let input = PersistRunStateInput {
            run_id: "run_a".into(),
            workflow_id: "wf_x".into(),
            status: "running".into(),
            last_step_id: None,
            snapshot: None,
        };
        let err = mirror.persist(&input).unwrap_err();
        assert!(matches!(err, MirrorError::MissingSnapshot(_)));
    }

    #[test]
    fn first_persist_with_snapshot_succeeds_and_subsequent_persists_can_omit_it() {
        let mirror = RunMirror::open_in_memory().unwrap();
        mirror
            .persist(&PersistRunStateInput {
                run_id: "run_a".into(),
                workflow_id: "wf_x".into(),
                status: "running".into(),
                last_step_id: None,
                snapshot: Some(snapshot()),
            })
            .unwrap();
        // Second persist updates the row without a snapshot.
        mirror
            .persist(&PersistRunStateInput {
                run_id: "run_a".into(),
                workflow_id: "wf_x".into(),
                status: "running".into(),
                last_step_id: Some("n_a".into()),
                snapshot: None,
            })
            .unwrap();
        let in_flight = mirror.list_in_flight().unwrap();
        assert_eq!(in_flight.len(), 1);
        assert_eq!(in_flight[0].last_step_id.as_deref(), Some("n_a"));
        assert_eq!(in_flight[0].snapshot["name"], "test");
    }

    #[test]
    fn list_in_flight_only_returns_non_terminal_runs() {
        let mirror = RunMirror::open_in_memory().unwrap();
        for (run_id, status) in [
            ("run_a", "running"),
            ("run_b", "succeeded"),
            ("run_c", "failed"),
            ("run_d", "waiting"),
        ] {
            mirror
                .persist(&PersistRunStateInput {
                    run_id: run_id.into(),
                    workflow_id: "wf_x".into(),
                    status: status.into(),
                    last_step_id: None,
                    snapshot: Some(snapshot()),
                })
                .unwrap();
        }
        let ids: Vec<_> = mirror
            .list_in_flight()
            .unwrap()
            .into_iter()
            .map(|r| r.run_id)
            .collect();
        assert!(ids.contains(&"run_a".to_string()));
        assert!(ids.contains(&"run_d".to_string()));
        assert!(!ids.contains(&"run_b".to_string()));
        assert!(!ids.contains(&"run_c".to_string()));
    }

    #[test]
    fn ack_completed_removes_the_row() {
        let mirror = RunMirror::open_in_memory().unwrap();
        mirror
            .persist(&PersistRunStateInput {
                run_id: "run_a".into(),
                workflow_id: "wf_x".into(),
                status: "running".into(),
                last_step_id: None,
                snapshot: Some(snapshot()),
            })
            .unwrap();
        assert_eq!(mirror.count().unwrap(), 1);
        mirror.ack_completed("run_a").unwrap();
        assert_eq!(mirror.count().unwrap(), 0);
    }

    #[test]
    fn invalid_status_returns_an_error() {
        let mirror = RunMirror::open_in_memory().unwrap();
        let err = mirror
            .persist(&PersistRunStateInput {
                run_id: "run_a".into(),
                workflow_id: "wf_x".into(),
                status: "nonsense".into(),
                last_step_id: None,
                snapshot: Some(snapshot()),
            })
            .unwrap_err();
        assert!(matches!(err, MirrorError::InvalidStatus(_)));
    }

    #[test]
    fn started_at_is_preserved_across_persists() {
        let mirror = RunMirror::open_in_memory().unwrap();
        mirror
            .persist(&PersistRunStateInput {
                run_id: "run_a".into(),
                workflow_id: "wf_x".into(),
                status: "running".into(),
                last_step_id: None,
                snapshot: Some(snapshot()),
            })
            .unwrap();
        let first = mirror.list_in_flight().unwrap()[0].started_at;
        std::thread::sleep(std::time::Duration::from_millis(5));
        mirror
            .persist(&PersistRunStateInput {
                run_id: "run_a".into(),
                workflow_id: "wf_x".into(),
                status: "running".into(),
                last_step_id: Some("n".into()),
                snapshot: None,
            })
            .unwrap();
        let second = mirror.list_in_flight().unwrap()[0].started_at;
        assert_eq!(first, second);
    }

    fn waitpoint() -> WorkflowWaitpointRow {
        WorkflowWaitpointRow {
            id: "wait_1".into(),
            kind: "approval".into(),
            status: "pending".into(),
            run_id: "run_a".into(),
            workflow_id: "wf_x".into(),
            step_id: "approve".into(),
            key: "approval:wait_1".into(),
            correlation_id: None,
            title: Some("Approve".into()),
            message: None,
            created_at: 100,
            not_before: 100,
            expires_at: Some(500),
            resolution: None,
            notification_sent_at: None,
            resolution_notification_sent_at: None,
            updated_at: 100,
        }
    }

    #[test]
    fn waitpoint_create_is_idempotent_and_preserves_original_deadline() {
        let mirror = RunMirror::open_in_memory().unwrap();
        let first = mirror.create_waitpoint(&waitpoint()).unwrap();
        let mut duplicate = waitpoint();
        duplicate.expires_at = Some(900);
        duplicate.updated_at = 200;

        let second = mirror.create_waitpoint(&duplicate).unwrap();

        assert_eq!(first, second);
        assert_eq!(second.expires_at, Some(500));
        assert_eq!(mirror.list_pending_waitpoints().unwrap(), vec![first]);
    }

    #[test]
    fn waitpoint_decision_is_compare_and_set() {
        let mirror = RunMirror::open_in_memory().unwrap();
        mirror.create_waitpoint(&waitpoint()).unwrap();

        let approved = mirror
            .decide_waitpoint(&WorkflowWaitpointDecisionInput {
                id: "wait_1".into(),
                status: "resolved".into(),
                resolution: json!({"decision": "approve", "decidedAt": 200}),
                updated_at: 200,
            })
            .unwrap();
        let rejected = mirror
            .decide_waitpoint(&WorkflowWaitpointDecisionInput {
                id: "wait_1".into(),
                status: "rejected".into(),
                resolution: json!({"decision": "reject", "decidedAt": 300}),
                updated_at: 300,
            })
            .unwrap();

        assert!(approved);
        assert!(!rejected);
        let stored = mirror.get_waitpoint("wait_1").unwrap().unwrap();
        assert_eq!(stored.status, "resolved");
        assert_eq!(stored.resolution.unwrap()["decision"], "approve");
    }

    #[test]
    fn wait_events_are_durable_and_pruned_after_expiry() {
        let mirror = RunMirror::open_in_memory().unwrap();
        mirror
            .persist_wait_event(&WorkflowWaitEventRow {
                id: "event_1".into(),
                key: "invoice.paid".into(),
                correlation_id: Some("invoice_1".into()),
                source: "connector".into(),
                data: Some(json!({"amount": 12})),
                emitted_at: 100,
                expires_at: 200,
                consumed_by_waitpoint_id: None,
                consumed_at: None,
            })
            .unwrap();

        assert_eq!(mirror.count_wait_events().unwrap(), 1);
        assert_eq!(mirror.prune_wait_events(199).unwrap(), 0);
        assert_eq!(mirror.prune_wait_events(200).unwrap(), 1);
        assert_eq!(mirror.count_wait_events().unwrap(), 0);
    }
}
