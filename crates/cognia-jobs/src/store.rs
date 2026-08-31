//! SQLite journal for background jobs — the source of truth.
//!
//! Deliberately Rust-side rather than Dexie: the renderer, a remote mobile
//! client, and the headless `cognia-server` binary all read the same rows
//! through the same RPC. A Dexie-backed journal would be invisible to the
//! latter two, which is exactly the gap that made scheduled-task linkage
//! impossible before.
//!
//! Pragmas and row-mapping idioms mirror
//! `cognia-scheduling/src/scheduler/metadata_store.rs`.

use std::fs;
use std::path::PathBuf;

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::types::{
    JobError, JobOwner, JobRecord, JobStatus, MonitorRecord, MonitorStatus, Result,
};

fn map_sql_err(err: rusqlite::Error) -> JobError {
    JobError::Store(format!("jobs sqlite error: {err}"))
}

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    cwd TEXT NOT NULL,
    owner_kind TEXT NOT NULL,
    owner_id TEXT,
    status TEXT NOT NULL,
    exit_code INTEGER,
    pid INTEGER,
    started_at_ms INTEGER NOT NULL,
    ended_at_ms INTEGER,
    total_output_bytes INTEGER NOT NULL DEFAULT 0,
    dropped_output_bytes INTEGER NOT NULL DEFAULT 0,
    label TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_kind, owner_id);
-- Drives LRU eviction of log files: oldest finished job goes first.
CREATE INDEX IF NOT EXISTS idx_jobs_ended_at ON jobs(ended_at_ms);

-- Monitors: "wake me when X happens". Persisted for the same reason jobs are —
-- an async watch has to survive a restart, be visible to a remote client, and
-- work on a headless host.
CREATE TABLE IF NOT EXISTS monitors (
    id TEXT PRIMARY KEY,
    condition_json TEXT NOT NULL,
    owner_kind TEXT NOT NULL,
    owner_id TEXT,
    status TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    settled_at_ms INTEGER,
    expires_at_ms INTEGER,
    detail TEXT,
    label TEXT
);

CREATE INDEX IF NOT EXISTS idx_monitors_status ON monitors(status);
CREATE INDEX IF NOT EXISTS idx_monitors_owner ON monitors(owner_kind, owner_id);
"#;

pub struct JobStore {
    conn: Mutex<Connection>,
}

impl JobStore {
    pub fn new(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path).map_err(map_sql_err)?;
        conn.execute_batch(SCHEMA).map_err(map_sql_err)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Test seam — an isolated database with no file backing.
    pub fn new_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().map_err(map_sql_err)?;
        conn.execute_batch(SCHEMA).map_err(map_sql_err)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn insert(&self, rec: &JobRecord) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO jobs (
                id, command, cwd, owner_kind, owner_id, status, exit_code, pid,
                started_at_ms, ended_at_ms, total_output_bytes,
                dropped_output_bytes, label
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            "#,
            params![
                rec.id,
                rec.command,
                rec.cwd,
                rec.owner.kind_str(),
                rec.owner.owner_id(),
                rec.status.as_str(),
                rec.exit_code,
                rec.pid,
                rec.started_at_ms,
                rec.ended_at_ms,
                rec.total_output_bytes as i64,
                rec.dropped_output_bytes as i64,
                rec.label,
            ],
        )
        .map_err(map_sql_err)?;
        Ok(())
    }

    /// Record a terminal transition. Idempotent: re-settling an already-terminal
    /// row is a no-op, so a racing waiter and an explicit kill cannot overwrite
    /// each other's verdict.
    pub fn settle(
        &self,
        id: &str,
        status: JobStatus,
        exit_code: Option<i32>,
        ended_at_ms: i64,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"
            UPDATE jobs
               SET status = ?2, exit_code = ?3, ended_at_ms = ?4, pid = NULL
             WHERE id = ?1 AND status = 'running'
            "#,
            params![id, status.as_str(), exit_code, ended_at_ms],
        )
        .map_err(map_sql_err)?;
        Ok(())
    }

    pub fn update_output_counters(&self, id: &str, total: u64, dropped: u64) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE jobs SET total_output_bytes = ?2, dropped_output_bytes = ?3 WHERE id = ?1",
            params![id, total as i64, dropped as i64],
        )
        .map_err(map_sql_err)?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Option<JobRecord>> {
        let conn = self.conn.lock();
        conn.query_row("SELECT * FROM jobs WHERE id = ?1", params![id], row_to_job)
            .optional()
            .map_err(map_sql_err)
    }

    /// Every job, newest first.
    pub fn list_all(&self) -> Result<Vec<JobRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT * FROM jobs ORDER BY started_at_ms DESC")
            .map_err(map_sql_err)?;
        let rows = stmt
            .query_map([], row_to_job)
            .map_err(map_sql_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(map_sql_err)?;
        Ok(rows)
    }

    /// Jobs belonging to one owner, newest first.
    pub fn list_by_owner(&self, owner: &JobOwner) -> Result<Vec<JobRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                r#"
                SELECT * FROM jobs
                 WHERE owner_kind = ?1 AND (owner_id IS ?2)
                 ORDER BY started_at_ms DESC
                "#,
            )
            .map_err(map_sql_err)?;
        let rows = stmt
            .query_map(params![owner.kind_str(), owner.owner_id()], row_to_job)
            .map_err(map_sql_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(map_sql_err)?;
        Ok(rows)
    }

    pub fn list_running(&self) -> Result<Vec<JobRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT * FROM jobs WHERE status = 'running' ORDER BY started_at_ms ASC")
            .map_err(map_sql_err)?;
        let rows = stmt
            .query_map([], row_to_job)
            .map_err(map_sql_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(map_sql_err)?;
        Ok(rows)
    }

    /// Count of currently-running jobs, optionally scoped to one owner. Used
    /// for the per-session and global concurrency caps.
    pub fn count_running(&self, owner: Option<&JobOwner>) -> Result<usize> {
        let conn = self.conn.lock();
        let count: i64 = match owner {
            Some(o) => conn
                .query_row(
                    r#"
                    SELECT COUNT(*) FROM jobs
                     WHERE status = 'running' AND owner_kind = ?1 AND (owner_id IS ?2)
                    "#,
                    params![o.kind_str(), o.owner_id()],
                    |r| r.get(0),
                )
                .map_err(map_sql_err)?,
            None => conn
                .query_row(
                    "SELECT COUNT(*) FROM jobs WHERE status = 'running'",
                    [],
                    |r| r.get(0),
                )
                .map_err(map_sql_err)?,
        };
        Ok(count as usize)
    }

    /// Terminal jobs ordered oldest-finished-first — the LRU eviction order for
    /// reclaiming the global log budget.
    pub fn list_terminal_oldest_first(&self) -> Result<Vec<JobRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                r#"
                SELECT * FROM jobs
                 WHERE status != 'running'
                 ORDER BY COALESCE(ended_at_ms, started_at_ms) ASC
                "#,
            )
            .map_err(map_sql_err)?;
        let rows = stmt
            .query_map([], row_to_job)
            .map_err(map_sql_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(map_sql_err)?;
        Ok(rows)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM jobs WHERE id = ?1", params![id])
            .map_err(map_sql_err)?;
        Ok(())
    }

    /// Boot reconcile: every row still marked `running` belongs to a process
    /// this supervisor no longer owns (the app died), so flip it to
    /// `interrupted`. Returns the affected ids.
    ///
    /// Mirrors the renderer's `interruptBackgroundTasksOnBoot()` discipline —
    /// a `running` row with nobody watching it is a lie.
    pub fn interrupt_orphans_on_boot(&self, now_ms: i64) -> Result<Vec<String>> {
        let ids: Vec<String> = self.list_running()?.into_iter().map(|r| r.id).collect();
        if ids.is_empty() {
            return Ok(ids);
        }
        let conn = self.conn.lock();
        conn.execute(
            r#"
            UPDATE jobs
               SET status = 'interrupted', ended_at_ms = COALESCE(ended_at_ms, ?1), pid = NULL
             WHERE status = 'running'
            "#,
            params![now_ms],
        )
        .map_err(map_sql_err)?;
        Ok(ids)
    }
}

// ---------------------------------------------------------------------------
// Monitors
// ---------------------------------------------------------------------------

impl JobStore {
    pub fn insert_monitor(&self, rec: &MonitorRecord) -> Result<()> {
        let condition_json =
            serde_json::to_string(&rec.condition).map_err(|e| JobError::Store(e.to_string()))?;
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO monitors (
                id, condition_json, owner_kind, owner_id, status,
                created_at_ms, settled_at_ms, expires_at_ms, detail, label
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            "#,
            params![
                rec.id,
                condition_json,
                rec.owner.kind_str(),
                rec.owner.owner_id(),
                rec.status.as_str(),
                rec.created_at_ms,
                rec.settled_at_ms,
                rec.expires_at_ms,
                rec.detail,
                rec.label,
            ],
        )
        .map_err(map_sql_err)?;
        Ok(())
    }

    /// Record a monitor's terminal outcome. Idempotent on the same principle as
    /// [`JobStore::settle`]: the first verdict wins, so a racing cancel and a
    /// fire cannot overwrite each other.
    pub fn settle_monitor(
        &self,
        id: &str,
        status: MonitorStatus,
        detail: Option<&str>,
        settled_at_ms: i64,
    ) -> Result<bool> {
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                r#"
                UPDATE monitors
                   SET status = ?2, detail = ?3, settled_at_ms = ?4
                 WHERE id = ?1 AND status = 'waiting'
                "#,
                params![id, status.as_str(), detail, settled_at_ms],
            )
            .map_err(map_sql_err)?;
        Ok(changed > 0)
    }

    pub fn get_monitor(&self, id: &str) -> Result<Option<MonitorRecord>> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT * FROM monitors WHERE id = ?1",
            params![id],
            row_to_monitor,
        )
        .optional()
        .map_err(map_sql_err)
    }

    pub fn list_monitors(&self, owner: Option<&JobOwner>) -> Result<Vec<MonitorRecord>> {
        let conn = self.conn.lock();
        let mut stmt = match owner {
            Some(_) => conn
                .prepare(
                    r#"
                    SELECT * FROM monitors
                     WHERE owner_kind = ?1 AND (owner_id IS ?2)
                     ORDER BY created_at_ms DESC
                    "#,
                )
                .map_err(map_sql_err)?,
            None => conn
                .prepare("SELECT * FROM monitors ORDER BY created_at_ms DESC")
                .map_err(map_sql_err)?,
        };
        let rows = match owner {
            Some(o) => stmt
                .query_map(params![o.kind_str(), o.owner_id()], row_to_monitor)
                .map_err(map_sql_err)?
                .collect::<rusqlite::Result<Vec<_>>>(),
            None => stmt
                .query_map([], row_to_monitor)
                .map_err(map_sql_err)?
                .collect::<rusqlite::Result<Vec<_>>>(),
        }
        .map_err(map_sql_err)?;
        Ok(rows)
    }

    pub fn count_waiting_monitors(&self) -> Result<usize> {
        let conn = self.conn.lock();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM monitors WHERE status = 'waiting'",
                [],
                |r| r.get(0),
            )
            .map_err(map_sql_err)?;
        Ok(n as usize)
    }
}

fn row_to_monitor(row: &Row<'_>) -> rusqlite::Result<MonitorRecord> {
    let owner_kind: String = row.get("owner_kind")?;
    let owner_id: Option<String> = row.get("owner_id")?;
    let owner = match owner_kind.as_str() {
        "session" => JobOwner::Session {
            session_id: owner_id.unwrap_or_default(),
        },
        "scheduledTask" => JobOwner::ScheduledTask {
            task_id: owner_id.unwrap_or_default(),
        },
        _ => JobOwner::App,
    };
    let condition_json: String = row.get("condition_json")?;
    let condition = serde_json::from_str(&condition_json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let status_raw: String = row.get("status")?;
    Ok(MonitorRecord {
        id: row.get("id")?,
        condition,
        owner,
        status: MonitorStatus::parse(&status_raw).unwrap_or(MonitorStatus::Expired),
        created_at_ms: row.get("created_at_ms")?,
        settled_at_ms: row.get("settled_at_ms")?,
        expires_at_ms: row.get("expires_at_ms")?,
        detail: row.get("detail")?,
        label: row.get("label")?,
    })
}

fn row_to_job(row: &Row<'_>) -> rusqlite::Result<JobRecord> {
    let owner_kind: String = row.get("owner_kind")?;
    let owner_id: Option<String> = row.get("owner_id")?;
    let owner = match owner_kind.as_str() {
        "session" => JobOwner::Session {
            session_id: owner_id.unwrap_or_default(),
        },
        "scheduledTask" => JobOwner::ScheduledTask {
            task_id: owner_id.unwrap_or_default(),
        },
        _ => JobOwner::App,
    };
    let status_raw: String = row.get("status")?;
    let total: i64 = row.get("total_output_bytes")?;
    let dropped: i64 = row.get("dropped_output_bytes")?;
    Ok(JobRecord {
        id: row.get("id")?,
        command: row.get("command")?,
        cwd: row.get("cwd")?,
        owner,
        status: JobStatus::parse(&status_raw).unwrap_or(JobStatus::Interrupted),
        exit_code: row.get("exit_code")?,
        pid: row.get::<_, Option<i64>>("pid")?.map(|p| p as u32),
        started_at_ms: row.get("started_at_ms")?,
        ended_at_ms: row.get("ended_at_ms")?,
        total_output_bytes: total.max(0) as u64,
        dropped_output_bytes: dropped.max(0) as u64,
        label: row.get("label")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(id: &str, owner: JobOwner, status: JobStatus, started: i64) -> JobRecord {
        JobRecord {
            id: id.into(),
            command: format!("cmd-{id}"),
            cwd: "/tmp".into(),
            owner,
            status,
            exit_code: None,
            pid: Some(4242),
            started_at_ms: started,
            ended_at_ms: if status.is_terminal() {
                Some(started + 100)
            } else {
                None
            },
            total_output_bytes: 0,
            dropped_output_bytes: 0,
            label: None,
        }
    }

    fn session(id: &str) -> JobOwner {
        JobOwner::Session {
            session_id: id.into(),
        }
    }

    #[test]
    fn insert_and_get_round_trip_every_field() {
        let store = JobStore::new_in_memory().unwrap();
        let mut r = rec("j1", session("s1"), JobStatus::Running, 1_000);
        r.label = Some("dev server".into());
        r.total_output_bytes = 77;
        r.dropped_output_bytes = 3;
        store.insert(&r).unwrap();

        let got = store.get("j1").unwrap().expect("row should exist");
        assert_eq!(got.id, "j1");
        assert_eq!(got.command, "cmd-j1");
        assert_eq!(got.owner, session("s1"));
        assert_eq!(got.status, JobStatus::Running);
        assert_eq!(got.pid, Some(4242));
        assert_eq!(got.label.as_deref(), Some("dev server"));
        assert_eq!(got.total_output_bytes, 77);
        assert_eq!(got.dropped_output_bytes, 3);
    }

    #[test]
    fn get_returns_none_for_an_unknown_id() {
        let store = JobStore::new_in_memory().unwrap();
        assert!(store.get("nope").unwrap().is_none());
    }

    #[test]
    fn settle_records_the_exit_and_clears_the_pid() {
        let store = JobStore::new_in_memory().unwrap();
        store
            .insert(&rec("j1", session("s1"), JobStatus::Running, 1_000))
            .unwrap();
        store
            .settle("j1", JobStatus::Exited, Some(0), 2_000)
            .unwrap();

        let got = store.get("j1").unwrap().unwrap();
        assert_eq!(got.status, JobStatus::Exited);
        assert_eq!(got.exit_code, Some(0));
        assert_eq!(got.ended_at_ms, Some(2_000));
        assert_eq!(got.pid, None, "a settled job holds no pid");
    }

    #[test]
    fn settle_is_idempotent_so_a_race_cannot_rewrite_the_verdict() {
        // An explicit kill and the process waiter can both fire; whoever lands
        // first wins, and the loser must not overwrite the recorded outcome.
        let store = JobStore::new_in_memory().unwrap();
        store
            .insert(&rec("j1", session("s1"), JobStatus::Running, 1_000))
            .unwrap();
        store.settle("j1", JobStatus::Killed, None, 2_000).unwrap();
        store
            .settle("j1", JobStatus::Exited, Some(0), 3_000)
            .unwrap();

        let got = store.get("j1").unwrap().unwrap();
        assert_eq!(got.status, JobStatus::Killed);
        assert_eq!(got.ended_at_ms, Some(2_000));
    }

    #[test]
    fn list_by_owner_scopes_to_one_session() {
        let store = JobStore::new_in_memory().unwrap();
        store
            .insert(&rec("a", session("s1"), JobStatus::Running, 1))
            .unwrap();
        store
            .insert(&rec("b", session("s2"), JobStatus::Running, 2))
            .unwrap();
        store
            .insert(&rec("c", JobOwner::App, JobStatus::Running, 3))
            .unwrap();

        let s1 = store.list_by_owner(&session("s1")).unwrap();
        assert_eq!(s1.len(), 1);
        assert_eq!(s1[0].id, "a");

        let app = store.list_by_owner(&JobOwner::App).unwrap();
        assert_eq!(app.len(), 1);
        assert_eq!(app[0].id, "c");
    }

    #[test]
    fn count_running_supports_the_per_owner_and_global_caps() {
        let store = JobStore::new_in_memory().unwrap();
        store
            .insert(&rec("a", session("s1"), JobStatus::Running, 1))
            .unwrap();
        store
            .insert(&rec("b", session("s1"), JobStatus::Running, 2))
            .unwrap();
        store
            .insert(&rec("c", session("s2"), JobStatus::Running, 3))
            .unwrap();
        store
            .insert(&rec("d", session("s1"), JobStatus::Exited, 4))
            .unwrap();

        assert_eq!(store.count_running(Some(&session("s1"))).unwrap(), 2);
        assert_eq!(store.count_running(Some(&session("s2"))).unwrap(), 1);
        assert_eq!(store.count_running(None).unwrap(), 3);
    }

    #[test]
    fn boot_reconcile_flips_orphaned_running_rows_to_interrupted() {
        let store = JobStore::new_in_memory().unwrap();
        store
            .insert(&rec("a", session("s1"), JobStatus::Running, 1))
            .unwrap();
        store
            .insert(&rec("b", session("s1"), JobStatus::Exited, 2))
            .unwrap();

        let ids = store.interrupt_orphans_on_boot(9_000).unwrap();
        assert_eq!(ids, vec!["a".to_string()]);

        let a = store.get("a").unwrap().unwrap();
        assert_eq!(a.status, JobStatus::Interrupted);
        assert_eq!(a.ended_at_ms, Some(9_000));
        assert_eq!(a.pid, None);

        // An already-terminal row is untouched.
        let b = store.get("b").unwrap().unwrap();
        assert_eq!(b.status, JobStatus::Exited);
        assert_eq!(b.ended_at_ms, Some(102));
    }

    #[test]
    fn boot_reconcile_on_a_clean_shutdown_is_a_no_op() {
        let store = JobStore::new_in_memory().unwrap();
        store
            .insert(&rec("b", session("s1"), JobStatus::Exited, 2))
            .unwrap();
        assert!(store.interrupt_orphans_on_boot(9_000).unwrap().is_empty());
    }

    #[test]
    fn terminal_jobs_come_back_oldest_finished_first_for_lru_eviction() {
        let store = JobStore::new_in_memory().unwrap();
        store
            .insert(&rec("new", session("s"), JobStatus::Exited, 5_000))
            .unwrap();
        store
            .insert(&rec("old", session("s"), JobStatus::Exited, 1_000))
            .unwrap();
        store
            .insert(&rec("live", session("s"), JobStatus::Running, 3_000))
            .unwrap();

        let ids: Vec<_> = store
            .list_terminal_oldest_first()
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, vec!["old".to_string(), "new".to_string()]);
    }

    #[test]
    fn output_counters_update_in_place() {
        let store = JobStore::new_in_memory().unwrap();
        store
            .insert(&rec("j", session("s"), JobStatus::Running, 1))
            .unwrap();
        store.update_output_counters("j", 4_096, 128).unwrap();
        let got = store.get("j").unwrap().unwrap();
        assert_eq!(got.total_output_bytes, 4_096);
        assert_eq!(got.dropped_output_bytes, 128);
    }

    #[test]
    fn delete_removes_the_row() {
        let store = JobStore::new_in_memory().unwrap();
        store
            .insert(&rec("j", session("s"), JobStatus::Exited, 1))
            .unwrap();
        store.delete("j").unwrap();
        assert!(store.get("j").unwrap().is_none());
    }

    #[test]
    fn app_owned_rows_survive_the_null_owner_id_round_trip() {
        // `owner_id IS NULL` needs `IS`, not `=`, in the lookup — a plain `=`
        // silently matches nothing and app-owned jobs would vanish from lists.
        let store = JobStore::new_in_memory().unwrap();
        store
            .insert(&rec("app-job", JobOwner::App, JobStatus::Running, 1))
            .unwrap();
        assert_eq!(store.list_by_owner(&JobOwner::App).unwrap().len(), 1);
        assert_eq!(store.count_running(Some(&JobOwner::App)).unwrap(), 1);
    }
}
