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

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value as JsonValue;

use super::types::{InFlightRunRow, PersistRunStateInput, RunStatus};

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
}

pub type Result<T> = std::result::Result<T, MirrorError>;

pub struct RunMirror {
    conn: Mutex<Connection>,
}

impl RunMirror {
    pub fn open(path: PathBuf) -> Result<Self> {
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
            "#,
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Open an in-memory database. Used by tests so they don't touch disk.
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
            "#,
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Upsert (insert-or-update) a mirror row from a persist call. The first
    /// persist for a run id MUST include a snapshot; subsequent persists may
    /// omit it (the existing snapshot is preserved).
    pub fn persist(&self, input: &PersistRunStateInput) -> Result<()> {
        let status = RunStatus::from_str(&input.status)
            .ok_or_else(|| MirrorError::InvalidStatus(input.status.clone()))?;
        let now = current_millis();
        let conn = self.conn.lock();

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
        let conn = self.conn.lock();
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
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM workflow_run_mirror WHERE run_id = ?1",
            params![run_id],
        )?;
        Ok(())
    }

    /// Total mirror row count — used by tests and the diagnostics tab.
    #[allow(dead_code)]
    pub fn count(&self) -> Result<usize> {
        let conn = self.conn.lock();
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM workflow_run_mirror", [], |row| row.get(0))?;
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
}
