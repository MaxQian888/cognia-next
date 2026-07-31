use crate::{
    PatchState, ResourceCaptureClass, ResourceChange, ResourceEvent, ResourceEventCounts,
    ResourceEventKind, ResourceTimelineCompleteness, RunState, TaskResourceSummary, TaskRun,
    TaskWorkspace,
};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub struct WorkspaceStore {
    connection: Connection,
    blob_dir: PathBuf,
    max_blob_bytes: u64,
}

impl WorkspaceStore {
    pub fn open(data_dir: &Path, max_blob_bytes: u64) -> Result<Self, String> {
        fs::create_dir_all(data_dir)
            .map_err(|error| format!("create data dir {}: {error}", data_dir.display()))?;
        let blob_dir = data_dir.join("blobs");
        fs::create_dir_all(&blob_dir)
            .map_err(|error| format!("create blob dir {}: {error}", blob_dir.display()))?;
        let connection = Connection::open(data_dir.join("task-workspaces.sqlite"))
            .map_err(|error| format!("open task workspace database: {error}"))?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA foreign_keys=ON;
                 CREATE TABLE IF NOT EXISTS task_workspaces (
                   task_id TEXT PRIMARY KEY,
                   session_id TEXT NOT NULL,
                   workspace_root TEXT NOT NULL,
                   payload TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS task_runs (
                   run_id TEXT PRIMARY KEY,
                   task_id TEXT NOT NULL,
                   payload TEXT NOT NULL,
                   baseline TEXT NOT NULL,
                   FOREIGN KEY(task_id) REFERENCES task_workspaces(task_id) ON DELETE CASCADE
                 );
                 CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id);
                 CREATE TABLE IF NOT EXISTS task_resources (
                   task_id TEXT NOT NULL,
                   run_id TEXT NOT NULL,
                   revision INTEGER NOT NULL,
                   path TEXT NOT NULL,
                   payload TEXT NOT NULL,
                   PRIMARY KEY(task_id, run_id, path),
                   FOREIGN KEY(task_id) REFERENCES task_workspaces(task_id) ON DELETE CASCADE
                 );
                 CREATE INDEX IF NOT EXISTS idx_task_resources_task ON task_resources(task_id, revision);
                 CREATE TABLE IF NOT EXISTS task_resource_events (
                   event_id TEXT PRIMARY KEY,
                   task_id TEXT NOT NULL,
                   run_id TEXT NOT NULL,
                   seq INTEGER NOT NULL,
                   payload TEXT NOT NULL,
                   UNIQUE(run_id, seq),
                   FOREIGN KEY(task_id) REFERENCES task_workspaces(task_id) ON DELETE CASCADE,
                   FOREIGN KEY(run_id) REFERENCES task_runs(run_id) ON DELETE CASCADE
                 );
                 CREATE INDEX IF NOT EXISTS idx_task_resource_events_run
                   ON task_resource_events(run_id, seq);
                 CREATE INDEX IF NOT EXISTS idx_task_resource_events_task
                   ON task_resource_events(task_id, run_id, seq);
                 CREATE TABLE IF NOT EXISTS task_patch_sets (
                   run_id TEXT PRIMARY KEY,
                   task_id TEXT NOT NULL,
                   payload TEXT NOT NULL,
                   FOREIGN KEY(task_id) REFERENCES task_workspaces(task_id) ON DELETE CASCADE
                 );
                 CREATE INDEX IF NOT EXISTS idx_task_patch_sets_task ON task_patch_sets(task_id);
                 CREATE TABLE IF NOT EXISTS task_blobs (
                   hash TEXT PRIMARY KEY,
                   size INTEGER NOT NULL,
                   stored_size INTEGER NOT NULL,
                   compressed INTEGER NOT NULL,
                   rel_path TEXT NOT NULL,
                   created_at INTEGER NOT NULL,
                   last_accessed INTEGER NOT NULL
                 );",
            )
            .map_err(|error| format!("initialize task workspace database: {error}"))?;
        Ok(Self {
            connection,
            blob_dir,
            max_blob_bytes,
        })
    }

    pub fn put_blob(&mut self, hash: &str, bytes: &[u8], now: i64) -> Result<(), String> {
        if self
            .connection
            .query_row("SELECT 1 FROM task_blobs WHERE hash=?1", [hash], |_| Ok(()))
            .optional()
            .map_err(|error| format!("query blob: {error}"))?
            .is_some()
        {
            return Ok(());
        }
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder
            .write_all(bytes)
            .map_err(|error| format!("compress blob {hash}: {error}"))?;
        let compressed = encoder
            .finish()
            .map_err(|error| format!("finish blob {hash}: {error}"))?;
        let (payload, is_compressed, extension) = if compressed.len() < bytes.len() {
            (compressed.as_slice(), true, "gz")
        } else {
            (bytes, false, "blob")
        };
        let used: u64 = self
            .connection
            .query_row(
                "SELECT COALESCE(SUM(stored_size), 0) FROM task_blobs",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("sum blobs: {error}"))?;
        if used.saturating_add(payload.len() as u64) > self.max_blob_bytes {
            return Err(format!(
                "task workspace ledger capacity exceeded: {} > {} bytes",
                used.saturating_add(payload.len() as u64),
                self.max_blob_bytes
            ));
        }
        let rel_path = format!("{}.{}", hash, extension);
        let final_path = self.blob_dir.join(&rel_path);
        let temp_path = self.blob_dir.join(format!(".{hash}.tmp"));
        fs::write(&temp_path, payload).map_err(|error| format!("write blob {hash}: {error}"))?;
        fs::rename(&temp_path, &final_path)
            .map_err(|error| format!("publish blob {hash}: {error}"))?;
        self.connection
            .execute(
                "INSERT INTO task_blobs(hash,size,stored_size,compressed,rel_path,created_at,last_accessed)
                 VALUES(?1,?2,?3,?4,?5,?6,?6)",
                params![
                    hash,
                    bytes.len() as u64,
                    payload.len() as u64,
                    is_compressed,
                    rel_path,
                    now
                ],
            )
            .map_err(|error| format!("insert blob {hash}: {error}"))?;
        Ok(())
    }

    pub fn get_blob(&mut self, hash: &str, now: i64) -> Result<Vec<u8>, String> {
        let row: Option<(String, bool)> = self
            .connection
            .query_row(
                "SELECT rel_path,compressed FROM task_blobs WHERE hash=?1",
                [hash],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("query blob {hash}: {error}"))?;
        let (rel_path, compressed) = row.ok_or_else(|| format!("missing blob {hash}"))?;
        let payload = fs::read(self.blob_dir.join(rel_path))
            .map_err(|error| format!("read blob {hash}: {error}"))?;
        let bytes = if compressed {
            let mut decoder = GzDecoder::new(payload.as_slice());
            let mut decoded = Vec::new();
            decoder
                .read_to_end(&mut decoded)
                .map_err(|error| format!("decompress blob {hash}: {error}"))?;
            decoded
        } else {
            payload
        };
        self.connection
            .execute(
                "UPDATE task_blobs SET last_accessed=?2 WHERE hash=?1",
                params![hash, now],
            )
            .map_err(|error| format!("touch blob {hash}: {error}"))?;
        Ok(bytes)
    }

    pub fn put_task(&self, task: &TaskWorkspace) -> Result<(), String> {
        let payload = serde_json::to_string(task).map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "INSERT INTO task_workspaces(task_id,session_id,workspace_root,payload)
                 VALUES(?1,?2,?3,?4)
                 ON CONFLICT(task_id) DO UPDATE SET session_id=excluded.session_id,
                 workspace_root=excluded.workspace_root,payload=excluded.payload",
                params![task.task_id, task.session_id, task.workspace_root, payload],
            )
            .map_err(|error| format!("put task: {error}"))?;
        Ok(())
    }

    pub fn get_task(&self, task_id: &str) -> Result<Option<TaskWorkspace>, String> {
        json_optional(
            self.connection
                .query_row(
                    "SELECT payload FROM task_workspaces WHERE task_id=?1",
                    [task_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| format!("get task: {error}"))?,
        )
    }

    pub fn list_tasks(&self) -> Result<Vec<TaskWorkspace>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT payload FROM task_workspaces ORDER BY rowid")
            .map_err(|error| format!("prepare tasks: {error}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("query tasks: {error}"))?;
        rows.map(|row| {
            let payload = row.map_err(|error| error.to_string())?;
            serde_json::from_str(&payload).map_err(|error| error.to_string())
        })
        .collect()
    }

    pub fn task_is_prunable(&self, task_id: &str) -> Result<bool, String> {
        let runs = self.list_runs(task_id)?;
        if runs
            .iter()
            .any(|run| matches!(run.state, RunState::Running | RunState::Settling))
        {
            return Ok(false);
        }
        let mut statement = self
            .connection
            .prepare("SELECT payload FROM task_patch_sets WHERE task_id=?1")
            .map_err(|error| format!("prepare task patch sets: {error}"))?;
        let rows = statement
            .query_map([task_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("query task patch sets: {error}"))?;
        for row in rows {
            let payload = row.map_err(|error| error.to_string())?;
            let patch: crate::PatchSet =
                serde_json::from_str(&payload).map_err(|error| error.to_string())?;
            if matches!(patch.state, PatchState::Ready | PatchState::Conflict) {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub fn delete_task(&self, task_id: &str) -> Result<(), String> {
        self.connection
            .execute("DELETE FROM task_workspaces WHERE task_id=?1", [task_id])
            .map_err(|error| format!("delete task {task_id}: {error}"))?;
        Ok(())
    }

    pub fn put_run<T: serde::Serialize>(&self, run: &TaskRun, baseline: &T) -> Result<(), String> {
        let payload = serde_json::to_string(run).map_err(|error| error.to_string())?;
        let baseline = serde_json::to_string(baseline).map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "INSERT INTO task_runs(run_id,task_id,payload,baseline) VALUES(?1,?2,?3,?4)
                 ON CONFLICT(run_id) DO UPDATE SET payload=excluded.payload,baseline=excluded.baseline",
                params![run.run_id, run.task_id, payload, baseline],
            )
            .map_err(|error| format!("put run: {error}"))?;
        Ok(())
    }

    pub fn get_run<T: serde::de::DeserializeOwned>(
        &self,
        run_id: &str,
    ) -> Result<Option<(TaskRun, T)>, String> {
        let row: Option<(String, String)> = self
            .connection
            .query_row(
                "SELECT payload,baseline FROM task_runs WHERE run_id=?1",
                [run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("get run: {error}"))?;
        row.map(|(payload, baseline)| {
            Ok((
                serde_json::from_str(&payload).map_err(|error| error.to_string())?,
                serde_json::from_str(&baseline).map_err(|error| error.to_string())?,
            ))
        })
        .transpose()
    }

    pub fn list_runs(&self, task_id: &str) -> Result<Vec<TaskRun>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT payload FROM task_runs WHERE task_id=?1 ORDER BY rowid")
            .map_err(|error| format!("prepare runs: {error}"))?;
        let rows = statement
            .query_map([task_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("query runs: {error}"))?;
        rows.map(|row| {
            let payload = row.map_err(|error| error.to_string())?;
            serde_json::from_str(&payload).map_err(|error| error.to_string())
        })
        .collect()
    }

    pub fn replace_resources(
        &mut self,
        task_id: &str,
        run_id: &str,
        revision: u64,
        changes: &[ResourceChange],
    ) -> Result<(), String> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| format!("begin resources transaction: {error}"))?;
        transaction
            .execute("DELETE FROM task_resources WHERE run_id=?1", [run_id])
            .map_err(|error| format!("delete resources: {error}"))?;
        for change in changes {
            let payload = serde_json::to_string(change).map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "INSERT INTO task_resources(task_id,run_id,revision,path,payload)
                     VALUES(?1,?2,?3,?4,?5)",
                    params![task_id, run_id, revision, change.path, payload],
                )
                .map_err(|error| format!("insert resource: {error}"))?;
        }
        transaction
            .commit()
            .map_err(|error| format!("commit resources: {error}"))
    }

    pub fn list_resources(&self, task_id: &str) -> Result<Vec<ResourceChange>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT payload FROM task_resources WHERE task_id=?1 ORDER BY revision,path")
            .map_err(|error| format!("prepare resources: {error}"))?;
        let rows = statement
            .query_map([task_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("query resources: {error}"))?;
        rows.map(|row| {
            let payload = row.map_err(|error| error.to_string())?;
            serde_json::from_str(&payload).map_err(|error| error.to_string())
        })
        .collect()
    }

    pub fn list_run_resources(&self, run_id: &str) -> Result<Vec<ResourceChange>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT payload FROM task_resources WHERE run_id=?1 ORDER BY path")
            .map_err(|error| format!("prepare run resources: {error}"))?;
        let rows = statement
            .query_map([run_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("query run resources: {error}"))?;
        rows.map(|row| {
            let payload = row.map_err(|error| error.to_string())?;
            serde_json::from_str(&payload).map_err(|error| error.to_string())
        })
        .collect()
    }

    pub fn append_resource_events(&mut self, events: &mut [ResourceEvent]) -> Result<(), String> {
        if events.is_empty() {
            return Ok(());
        }
        let run_id = events[0].run_id.clone();
        if events.iter().any(|event| event.run_id != run_id) {
            return Err("resource event batch spans multiple runs".into());
        }
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| format!("begin resource events transaction: {error}"))?;
        let mut seq: u64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM task_resource_events WHERE run_id=?1",
                [&run_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("query resource event sequence: {error}"))?;
        for event in events {
            seq = seq.saturating_add(1);
            event.seq = seq;
            let payload = serde_json::to_string(event).map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "INSERT INTO task_resource_events(event_id,task_id,run_id,seq,payload)
                     VALUES(?1,?2,?3,?4,?5)",
                    params![
                        event.event_id,
                        event.task_id,
                        event.run_id,
                        event.seq,
                        payload
                    ],
                )
                .map_err(|error| format!("insert resource event: {error}"))?;
        }
        transaction
            .commit()
            .map_err(|error| format!("commit resource events: {error}"))
    }

    pub fn list_resource_events(
        &self,
        run_id: &str,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<Vec<ResourceEvent>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT payload FROM task_resource_events
                 WHERE run_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3",
            )
            .map_err(|error| format!("prepare resource events: {error}"))?;
        let rows = statement
            .query_map(
                params![run_id, cursor.unwrap_or(0), limit.clamp(1, 1000)],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| format!("query resource events: {error}"))?;
        rows.map(|row| {
            let payload = row.map_err(|error| error.to_string())?;
            serde_json::from_str(&payload).map_err(|error| error.to_string())
        })
        .collect()
    }

    pub fn list_all_resource_events(&self, run_id: &str) -> Result<Vec<ResourceEvent>, String> {
        let mut events = Vec::new();
        let mut cursor = None;
        loop {
            let page = self.list_resource_events(run_id, cursor, 1000)?;
            if page.is_empty() {
                break;
            }
            cursor = page.last().map(|event| event.seq);
            events.extend(page);
        }
        Ok(events)
    }

    pub fn reconcile_resource_events(&mut self, run_id: &str) -> Result<(), String> {
        let mut events = self.list_all_resource_events(run_id)?;
        if events.is_empty() {
            return Ok(());
        }
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| format!("begin resource event reconciliation: {error}"))?;
        for event in &mut events {
            event.provisional = false;
            event.reconciled = true;
            let payload = serde_json::to_string(event).map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "UPDATE task_resource_events SET payload=?2 WHERE event_id=?1",
                    params![event.event_id, payload],
                )
                .map_err(|error| format!("reconcile resource event: {error}"))?;
        }
        transaction
            .commit()
            .map_err(|error| format!("commit resource event reconciliation: {error}"))
    }

    pub fn resource_summary(&self, run_id: &str) -> Result<TaskResourceSummary, String> {
        let events = self.list_all_resource_events(run_id)?;
        let mut counts = ResourceEventCounts::default();
        let mut overflow_count = 0_u64;
        for event in &events {
            let is_change = match event.kind {
                ResourceEventKind::Created => {
                    counts.created += 1;
                    true
                }
                ResourceEventKind::Modified => {
                    counts.modified += 1;
                    true
                }
                ResourceEventKind::Deleted => {
                    counts.deleted += 1;
                    true
                }
                ResourceEventKind::Renamed => {
                    counts.renamed += 1;
                    true
                }
                ResourceEventKind::Any | ResourceEventKind::Gap | ResourceEventKind::Resync => {
                    false
                }
            };
            if is_change {
                match event.capture_class {
                    ResourceCaptureClass::Source => counts.source += 1,
                    ResourceCaptureClass::Generated => counts.generated += 1,
                }
            }
            overflow_count += u64::from(event.overflow);
        }
        let completeness = if overflow_count == 0 {
            ResourceTimelineCompleteness::Complete
        } else if events
            .iter()
            .any(|event| event.resync_required && !event.reconciled)
        {
            ResourceTimelineCompleteness::ResyncRequired
        } else {
            ResourceTimelineCompleteness::Reconciled
        };
        Ok(TaskResourceSummary {
            run_id: run_id.to_string(),
            counts,
            event_count: events.len() as u64,
            overflow_count,
            completeness,
        })
    }

    pub fn put_patch_set(&self, patch: &crate::PatchSet) -> Result<(), String> {
        let payload = serde_json::to_string(patch).map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "INSERT INTO task_patch_sets(run_id,task_id,payload) VALUES(?1,?2,?3)
                 ON CONFLICT(run_id) DO UPDATE SET task_id=excluded.task_id,payload=excluded.payload",
                params![patch.run_id, patch.task_id, payload],
            )
            .map_err(|error| format!("put patch set: {error}"))?;
        Ok(())
    }

    pub fn get_patch_set(&self, run_id: &str) -> Result<Option<crate::PatchSet>, String> {
        json_optional(
            self.connection
                .query_row(
                    "SELECT payload FROM task_patch_sets WHERE run_id=?1",
                    [run_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| format!("get patch set: {error}"))?,
        )
    }

    pub fn prune_unreferenced_blobs(&mut self) -> Result<(u64, u64), String> {
        let mut referenced = HashSet::new();
        for table_column in [
            "task_runs:payload",
            "task_runs:baseline",
            "task_resources:payload",
            "task_patch_sets:payload",
        ] {
            let (table, column) = table_column.split_once(':').expect("static table column");
            let sql = format!("SELECT {column} FROM {table}");
            let mut statement = self
                .connection
                .prepare(&sql)
                .map_err(|error| format!("prepare blob reference scan: {error}"))?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| format!("query blob references: {error}"))?;
            for row in rows {
                let payload = row.map_err(|error| error.to_string())?;
                let value: serde_json::Value =
                    serde_json::from_str(&payload).map_err(|error| error.to_string())?;
                collect_hashes(&value, &mut referenced);
            }
        }

        let mut statement = self
            .connection
            .prepare("SELECT hash,rel_path,stored_size FROM task_blobs")
            .map_err(|error| format!("prepare blobs for prune: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u64>(2)?,
                ))
            })
            .map_err(|error| format!("query blobs for prune: {error}"))?;
        let stale = rows
            .filter_map(|row| match row {
                Ok(value) if !referenced.contains(&value.0) => Some(Ok(value)),
                Ok(_) => None,
                Err(error) => Some(Err(error.to_string())),
            })
            .collect::<Result<Vec<_>, String>>()?;
        drop(statement);

        let mut tombstones = Vec::with_capacity(stale.len());
        for (hash, rel_path, _) in &stale {
            let source = self.blob_dir.join(rel_path);
            let tombstone = self
                .blob_dir
                .join(format!(".prune-{}-{hash}", Uuid::now_v7()));
            if let Err(error) = fs::rename(&source, &tombstone) {
                restore_tombstones(&tombstones);
                return Err(format!("stage blob {hash} for prune: {error}"));
            }
            tombstones.push((source, tombstone));
        }

        let transaction = match self.connection.transaction() {
            Ok(transaction) => transaction,
            Err(error) => {
                restore_tombstones(&tombstones);
                return Err(format!("begin blob prune: {error}"));
            }
        };
        let mut reclaimed = 0_u64;
        for (hash, _, stored_size) in &stale {
            if let Err(error) = transaction.execute("DELETE FROM task_blobs WHERE hash=?1", [hash])
            {
                drop(transaction);
                restore_tombstones(&tombstones);
                return Err(format!("delete blob {hash}: {error}"));
            }
            reclaimed = reclaimed.saturating_add(*stored_size);
        }
        if let Err(error) = transaction.commit() {
            restore_tombstones(&tombstones);
            return Err(format!("commit blob prune: {error}"));
        }
        for (_, tombstone) in tombstones {
            let _ = fs::remove_file(tombstone);
        }
        Ok((stale.len() as u64, reclaimed))
    }
}

fn restore_tombstones(tombstones: &[(PathBuf, PathBuf)]) {
    for (source, tombstone) in tombstones.iter().rev() {
        let _ = fs::rename(tombstone, source);
    }
}

fn collect_hashes(value: &serde_json::Value, hashes: &mut HashSet<String>) {
    match value {
        serde_json::Value::String(value)
            if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) =>
        {
            hashes.insert(value.to_ascii_lowercase());
        }
        serde_json::Value::Array(values) => {
            for value in values {
                collect_hashes(value, hashes);
            }
        }
        serde_json::Value::Object(values) => {
            for value in values.values() {
                collect_hashes(value, hashes);
            }
        }
        _ => {}
    }
}

fn json_optional<T: serde::de::DeserializeOwned>(
    payload: Option<String>,
) -> Result<Option<T>, String> {
    payload
        .map(|payload| serde_json::from_str(&payload).map_err(|error| error.to_string()))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ContributionOrigin, IsolationKind, ResourceEventEvidence, ResourceKind,
        ResourceTrackingPolicy, TaskWorkspaceState,
    };
    use tempfile::TempDir;

    #[test]
    fn resource_events_are_sequenced_paged_and_reconciled() {
        let dir = TempDir::new().unwrap();
        let mut store = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
        store
            .put_task(&TaskWorkspace {
                task_id: "task-1".into(),
                session_id: "session-1".into(),
                workspace_root: "/workspace".into(),
                state: TaskWorkspaceState::Active,
                revision: 0,
                created_at: 1,
                expires_at: 2,
                pinned: false,
            })
            .unwrap();
        store
            .put_run(
                &TaskRun {
                    run_id: "run-1".into(),
                    task_id: "task-1".into(),
                    parent_run_id: None,
                    agent_id: "agent-1".into(),
                    agent_kind: "test".into(),
                    execution_root: "/workspace".into(),
                    isolation_kind: IsolationKind::Shadow,
                    isolation_ref: None,
                    workspace_key: None,
                    execution_run_id: None,
                    trace_id: None,
                    turn_id: None,
                    attempt_id: None,
                    provider_attempt_id: None,
                    surface: None,
                    tracking_policy: ResourceTrackingPolicy::default(),
                    baseline_revision: 0,
                    state: RunState::Running,
                    created_at: 1,
                    settled_at: None,
                },
                &serde_json::json!({}),
            )
            .unwrap();
        let event = |event_id: &str, kind: ResourceEventKind, overflow: bool| ResourceEvent {
            event_id: event_id.into(),
            task_id: "task-1".into(),
            run_id: "run-1".into(),
            seq: 0,
            observed_at: 1,
            kind,
            path: (!overflow).then(|| "src/a.ts".into()),
            old_path: None,
            capture_class: ResourceCaptureClass::Source,
            origin: ContributionOrigin::Agent,
            agent_id: Some("agent-1".into()),
            evidence: ResourceEventEvidence::Watcher,
            tool_call_id: None,
            media_type: Some("text/typescript".into()),
            size: Some(1),
            resource_kind: Some(ResourceKind::File),
            sensitive: false,
            provisional: true,
            overflow,
            resync_required: overflow,
            reconciled: false,
        };
        let mut events = vec![
            event("event-1", ResourceEventKind::Created, false),
            event("event-2", ResourceEventKind::Gap, true),
        ];
        store.append_resource_events(&mut events).unwrap();
        assert_eq!(
            events.iter().map(|event| event.seq).collect::<Vec<_>>(),
            [1, 2]
        );
        assert_eq!(
            store.list_resource_events("run-1", None, 1).unwrap().len(),
            1
        );
        assert_eq!(
            store.resource_summary("run-1").unwrap().completeness,
            ResourceTimelineCompleteness::ResyncRequired
        );
        store.reconcile_resource_events("run-1").unwrap();
        assert_eq!(
            store.resource_summary("run-1").unwrap().completeness,
            ResourceTimelineCompleteness::Reconciled
        );
    }
}
