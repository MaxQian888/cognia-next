use crate::{
    PatchState, ResourceCaptureClass, ResourceChange, ResourceEvent, ResourceEventCounts,
    ResourceEventKind, ResourceTimelineCompleteness, RunState, TaskResourceSummary, TaskRun,
    TaskWorkspace, WorkspaceLifecyclePolicy,
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
        let store = Self {
            connection,
            blob_dir,
            max_blob_bytes,
        };
        store.apply_registry_migration()?;
        Ok(store)
    }

    /// Idempotently create the ADR-0111 Managed Workspace Registry tables.
    ///
    /// Called from `open` so first-boot and every subsequent boot share one
    /// schema path. Tables use `IF NOT EXISTS` so existing installs upgrade
    /// without a version bump — the tables are additive and do not touch the
    /// legacy `task_workspaces` / `task_runs` rows.
    fn apply_registry_migration(&self) -> Result<(), String> {
        self.connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS workspace_registry (
                   workspace_id TEXT PRIMARY KEY,
                   environment_kind TEXT NOT NULL DEFAULT 'managed',
                   owner_type TEXT NOT NULL,
                   owner_ref TEXT,
                   state TEXT NOT NULL,
                   source_root TEXT NOT NULL,
                   git_common_dir TEXT,
                   base_kind TEXT NOT NULL,
                   base_ref TEXT,
                   head TEXT,
                   branch TEXT,
                   isolation_kind TEXT NOT NULL,
                   execution_root TEXT NOT NULL,
                   snapshot_task_id TEXT,
                   size_bytes INTEGER,
                   last_used_at INTEGER NOT NULL,
                   locked_by TEXT,
                   pinned INTEGER NOT NULL DEFAULT 0,
                   created_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_workspace_registry_state
                   ON workspace_registry(state);
                 CREATE INDEX IF NOT EXISTS idx_workspace_registry_owner
                   ON workspace_registry(owner_type, owner_ref);
                 CREATE INDEX IF NOT EXISTS idx_workspace_registry_source
                   ON workspace_registry(source_root);
                 CREATE TABLE IF NOT EXISTS workspace_bundles (
                   bundle_id TEXT PRIMARY KEY,
                   environment_kind TEXT NOT NULL,
                   owner_type TEXT NOT NULL,
                   owner_ref TEXT,
                   state TEXT NOT NULL,
                   last_used_at INTEGER NOT NULL,
                   pinned INTEGER NOT NULL DEFAULT 0,
                   created_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_workspace_bundles_owner
                   ON workspace_bundles(owner_type, owner_ref);
                 CREATE INDEX IF NOT EXISTS idx_workspace_bundles_state
                   ON workspace_bundles(state, last_used_at);
                 CREATE TABLE IF NOT EXISTS workspace_root_leases (
                   bundle_id TEXT NOT NULL,
                   workspace_id TEXT NOT NULL,
                   logical_root_id TEXT NOT NULL,
                   role TEXT NOT NULL,
                   alias_path TEXT NOT NULL,
                   created_at INTEGER NOT NULL,
                   PRIMARY KEY(bundle_id, logical_root_id),
                   FOREIGN KEY(workspace_id) REFERENCES workspace_registry(workspace_id)
                     ON DELETE CASCADE
                 );
                 CREATE INDEX IF NOT EXISTS idx_workspace_root_leases_workspace
                   ON workspace_root_leases(workspace_id);
                 CREATE TABLE IF NOT EXISTS workspace_sensitive_grants (
                   workspace_id TEXT NOT NULL,
                   relative_path TEXT NOT NULL,
                   granted_by_owner_type TEXT NOT NULL,
                   granted_by_owner_ref TEXT,
                   granted_at INTEGER NOT NULL,
                   PRIMARY KEY(workspace_id, relative_path),
                   FOREIGN KEY(workspace_id) REFERENCES workspace_registry(workspace_id)
                     ON DELETE CASCADE
                 );
                 CREATE TABLE IF NOT EXISTS workspace_sensitive_audit (
                   audit_id TEXT PRIMARY KEY,
                   workspace_id TEXT NOT NULL,
                   relative_path TEXT NOT NULL,
                   decision TEXT NOT NULL,
                   requester_owner_type TEXT NOT NULL,
                   requester_owner_ref TEXT,
                   decided_at INTEGER NOT NULL,
                   reason TEXT
                 );
                 CREATE INDEX IF NOT EXISTS idx_workspace_sensitive_audit_ws
                   ON workspace_sensitive_audit(workspace_id, decided_at);
                 CREATE TABLE IF NOT EXISTS workspace_source_bindings (
                   binding_ref TEXT PRIMARY KEY,
                   source_root TEXT NOT NULL,
                   git_common_dir TEXT NOT NULL,
                   repository_fingerprint TEXT NOT NULL,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
                 );
                 CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_source_binding_root
                   ON workspace_source_bindings(source_root);
                 CREATE TABLE IF NOT EXISTS workspace_settings (
                   key TEXT PRIMARY KEY,
                   payload TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS workspace_archives (
                   workspace_id TEXT PRIMARY KEY,
                   payload TEXT NOT NULL,
                   created_at INTEGER NOT NULL,
                   FOREIGN KEY(workspace_id) REFERENCES workspace_registry(workspace_id)
                     ON DELETE CASCADE
                 );",
            )
            .map_err(|error| format!("apply workspace registry migration: {error}"))?;
        let has_environment_kind: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('workspace_registry') WHERE name='environment_kind')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("inspect workspace registry migration: {error}"))?;
        if !has_environment_kind {
            self.connection
                .execute(
                    "ALTER TABLE workspace_registry ADD COLUMN environment_kind TEXT NOT NULL DEFAULT 'managed'",
                    [],
                )
                .map_err(|error| format!("add workspace environment kind: {error}"))?;
        }
        Ok(())
    }

    pub fn get_workspace_lifecycle_policy(
        &self,
    ) -> Result<Option<WorkspaceLifecyclePolicy>, String> {
        let payload = self
            .connection
            .query_row(
                "SELECT payload FROM workspace_settings WHERE key='lifecyclePolicy'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("get workspace lifecycle policy: {error}"))?;
        payload
            .map(|value| {
                serde_json::from_str(&value)
                    .map_err(|error| format!("decode workspace lifecycle policy: {error}"))
            })
            .transpose()
    }

    pub fn put_workspace_lifecycle_policy(
        &self,
        policy: &WorkspaceLifecyclePolicy,
    ) -> Result<(), String> {
        let payload = serde_json::to_string(policy)
            .map_err(|error| format!("encode workspace lifecycle policy: {error}"))?;
        self.connection
            .execute(
                "INSERT INTO workspace_settings(key, payload) VALUES('lifecyclePolicy', ?1)
                 ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",
                [payload],
            )
            .map_err(|error| format!("put workspace lifecycle policy: {error}"))?;
        Ok(())
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

    // -----------------------------------------------------------------
    // ADR-0111 Managed Workspace Registry CRUD
    // -----------------------------------------------------------------

    /// Insert or update one Registry row without replacing its identity.
    ///
    /// `INSERT OR REPLACE` is intentionally forbidden here: SQLite implements
    /// it as DELETE + INSERT, which would cascade-delete leases, grants, and
    /// archive snapshots on every state or pin update.
    pub fn put_workspace(&self, record: &crate::WorkspaceRecord) -> Result<(), String> {
        let (base_kind, base_ref) = record.base.to_storage();
        let base_kind_str = serde_json::to_value(base_kind)
            .and_then(|value| serde_json::from_value::<String>(value))
            .map_err(|error| format!("encode base kind: {error}"))?;
        let owner_type = serialize_enum(&record.owner_type, "owner type")?;
        let environment_kind = serialize_enum(&record.environment_kind, "environment kind")?;
        let state = serialize_enum(&record.state, "workspace state")?;
        let isolation_kind = serialize_enum(&record.isolation_kind, "isolation kind")?;
        self.connection
            .execute(
                "INSERT INTO workspace_registry (
                   workspace_id, environment_kind, owner_type, owner_ref, state, source_root,
                   git_common_dir, base_kind, base_ref, head, branch,
                   isolation_kind, execution_root, snapshot_task_id, size_bytes,
                   last_used_at, locked_by, pinned, created_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
                 ON CONFLICT(workspace_id) DO UPDATE SET
                   environment_kind=excluded.environment_kind,
                   owner_type=excluded.owner_type,
                   owner_ref=excluded.owner_ref,
                   state=excluded.state,
                   source_root=excluded.source_root,
                   git_common_dir=excluded.git_common_dir,
                   base_kind=excluded.base_kind,
                   base_ref=excluded.base_ref,
                   head=excluded.head,
                   branch=excluded.branch,
                   isolation_kind=excluded.isolation_kind,
                   execution_root=excluded.execution_root,
                   snapshot_task_id=excluded.snapshot_task_id,
                   size_bytes=excluded.size_bytes,
                   last_used_at=excluded.last_used_at,
                   locked_by=excluded.locked_by,
                   pinned=excluded.pinned,
                   created_at=excluded.created_at",
                params![
                    record.workspace_id,
                    environment_kind,
                    owner_type,
                    record.owner_ref,
                    state,
                    record.source_root,
                    record.git_common_dir,
                    base_kind_str,
                    base_ref,
                    record.head,
                    record.branch,
                    isolation_kind,
                    record.execution_root,
                    record.snapshot_task_id,
                    record.size_bytes.map(|value| value as i64),
                    record.last_used_at,
                    record.locked_by,
                    record.pinned as i64,
                    record.created_at,
                ],
            )
            .map(|_| ())
            .map_err(|error| format!("put workspace {}: {error}", record.workspace_id))
    }

    /// Read one Registry row.
    pub fn get_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Option<crate::WorkspaceRecord>, String> {
        self.connection
            .query_row(
                "SELECT workspace_id, environment_kind, owner_type, owner_ref, state, source_root,
                        git_common_dir, base_kind, base_ref, head, branch,
                        isolation_kind, execution_root, snapshot_task_id, size_bytes,
                        last_used_at, locked_by, pinned, created_at
                   FROM workspace_registry WHERE workspace_id=?1",
                [workspace_id],
                map_workspace_row,
            )
            .optional()
            .map_err(|error| format!("get workspace {workspace_id}: {error}"))?
            .transpose()
    }

    /// Enumerate every Registry row, ordered by `last_used_at DESC`.
    pub fn list_workspaces(&self) -> Result<Vec<crate::WorkspaceRecord>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT workspace_id, environment_kind, owner_type, owner_ref, state, source_root,
                        git_common_dir, base_kind, base_ref, head, branch,
                        isolation_kind, execution_root, snapshot_task_id, size_bytes,
                        last_used_at, locked_by, pinned, created_at
                   FROM workspace_registry ORDER BY last_used_at DESC",
            )
            .map_err(|error| format!("prepare list_workspaces: {error}"))?;
        let rows = statement
            .query_map([], map_workspace_row)
            .map_err(|error| format!("query list_workspaces: {error}"))?;
        rows.collect::<Result<Result<Vec<_>, String>, _>>()
            .map_err(|error| format!("read list_workspaces: {error}"))?
    }

    /// Delete a Registry row (and cascade its leases + grants).
    ///
    /// Callers MUST first verify ownership and lock reason — the store enforces
    /// only referential integrity, not policy.
    pub fn delete_workspace(&self, workspace_id: &str) -> Result<(), String> {
        self.connection
            .execute(
                "DELETE FROM workspace_registry WHERE workspace_id=?1",
                [workspace_id],
            )
            .map(|_| ())
            .map_err(|error| format!("delete workspace {workspace_id}: {error}"))
    }

    pub fn put_workspace_bundle(&self, bundle: &crate::WorkspaceBundle) -> Result<(), String> {
        let environment_kind = serialize_enum(&bundle.environment_kind, "environment kind")?;
        let owner_type = serialize_enum(&bundle.owner_type, "owner type")?;
        let state = serialize_enum(&bundle.state, "workspace state")?;
        self.connection
            .execute(
                "INSERT OR REPLACE INTO workspace_bundles (
                   bundle_id, environment_kind, owner_type, owner_ref, state,
                   last_used_at, pinned, created_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    bundle.bundle_id,
                    environment_kind,
                    owner_type,
                    bundle.owner_ref,
                    state,
                    bundle.last_used_at,
                    bundle.pinned as i64,
                    bundle.created_at,
                ],
            )
            .map_err(|error| format!("put workspace bundle {}: {error}", bundle.bundle_id))?;
        for lease in &bundle.leases {
            self.put_root_lease(lease, bundle.created_at)?;
        }
        Ok(())
    }

    pub fn get_workspace_bundle(
        &self,
        bundle_id: &str,
    ) -> Result<Option<crate::WorkspaceBundle>, String> {
        let row = self
            .connection
            .query_row(
                "SELECT environment_kind, owner_type, owner_ref, state,
                        last_used_at, pinned, created_at
                   FROM workspace_bundles WHERE bundle_id=?1",
                [bundle_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("get workspace bundle {bundle_id}: {error}"))?;
        let Some((
            environment_kind,
            owner_type,
            owner_ref,
            state,
            last_used_at,
            pinned,
            created_at,
        )) = row
        else {
            return Ok(None);
        };
        Ok(Some(crate::WorkspaceBundle {
            bundle_id: bundle_id.to_string(),
            environment_kind: deserialize_enum(&environment_kind, "environment kind")?,
            owner_type: deserialize_enum(&owner_type, "owner type")?,
            owner_ref,
            state: deserialize_enum(&state, "workspace state")?,
            leases: self.list_bundle_leases(bundle_id)?,
            last_used_at,
            pinned: pinned != 0,
            created_at,
        }))
    }

    pub fn list_workspace_bundles(&self) -> Result<Vec<crate::WorkspaceBundle>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT bundle_id FROM workspace_bundles ORDER BY last_used_at DESC")
            .map_err(|error| format!("prepare list workspace bundles: {error}"))?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("query workspace bundles: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("read workspace bundles: {error}"))?;
        ids.into_iter()
            .map(|id| {
                self.get_workspace_bundle(&id)?
                    .ok_or_else(|| format!("workspace bundle disappeared: {id}"))
            })
            .collect()
    }

    pub fn put_workspace_source_binding(
        &self,
        binding: &crate::WorkspaceSourceBinding,
    ) -> Result<(), String> {
        self.connection
            .execute(
                "INSERT INTO workspace_source_bindings (
                   binding_ref, source_root, git_common_dir, repository_fingerprint,
                   created_at, updated_at
                 ) VALUES (?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(binding_ref) DO UPDATE SET
                   source_root=excluded.source_root,
                   git_common_dir=excluded.git_common_dir,
                   repository_fingerprint=excluded.repository_fingerprint,
                   updated_at=excluded.updated_at",
                params![
                    binding.binding_ref,
                    binding.source_root,
                    binding.git_common_dir,
                    binding.repository_fingerprint,
                    binding.created_at,
                    binding.updated_at,
                ],
            )
            .map(|_| ())
            .map_err(|error| format!("put workspace source binding: {error}"))
    }

    pub fn get_workspace_source_binding(
        &self,
        binding_ref: &str,
    ) -> Result<Option<crate::WorkspaceSourceBinding>, String> {
        self.connection
            .query_row(
                "SELECT binding_ref, source_root, git_common_dir, repository_fingerprint,
                        created_at, updated_at
                   FROM workspace_source_bindings WHERE binding_ref=?1",
                [binding_ref],
                map_workspace_source_binding_row,
            )
            .optional()
            .map_err(|error| format!("get workspace source binding {binding_ref}: {error}"))
    }

    pub fn list_workspace_source_bindings(
        &self,
    ) -> Result<Vec<crate::WorkspaceSourceBinding>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT binding_ref, source_root, git_common_dir, repository_fingerprint,
                        created_at, updated_at
                   FROM workspace_source_bindings ORDER BY binding_ref",
            )
            .map_err(|error| format!("prepare workspace source bindings: {error}"))?;
        let rows = statement
            .query_map([], map_workspace_source_binding_row)
            .map_err(|error| format!("query workspace source bindings: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("read workspace source bindings: {error}"))
    }

    pub fn delete_workspace_source_binding(&self, binding_ref: &str) -> Result<bool, String> {
        self.connection
            .execute(
                "DELETE FROM workspace_source_bindings WHERE binding_ref=?1",
                [binding_ref],
            )
            .map(|changed| changed > 0)
            .map_err(|error| format!("delete workspace source binding {binding_ref}: {error}"))
    }

    /// Persist one root lease for a bundle.
    pub fn put_root_lease(
        &self,
        lease: &crate::WorkspaceRootLease,
        now: i64,
    ) -> Result<(), String> {
        let role = serialize_enum(&lease.role, "root role")?;
        self.connection
            .execute(
                "INSERT OR REPLACE INTO workspace_root_leases (
                   bundle_id, workspace_id, logical_root_id, role, alias_path, created_at
                 ) VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    lease.bundle_id,
                    lease.workspace_id,
                    lease.logical_root_id,
                    role,
                    lease.alias_path,
                    now,
                ],
            )
            .map(|_| ())
            .map_err(|error| {
                format!(
                    "put lease {}/{}: {error}",
                    lease.bundle_id, lease.logical_root_id
                )
            })
    }

    /// List every lease belonging to a bundle, in insertion order.
    pub fn list_bundle_leases(
        &self,
        bundle_id: &str,
    ) -> Result<Vec<crate::WorkspaceRootLease>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT bundle_id, workspace_id, logical_root_id, role, alias_path
                   FROM workspace_root_leases WHERE bundle_id=?1
                   ORDER BY created_at ASC, rowid ASC",
            )
            .map_err(|error| format!("prepare list_bundle_leases: {error}"))?;
        let rows = statement
            .query_map([bundle_id], map_lease_row)
            .map_err(|error| format!("query list_bundle_leases: {error}"))?;
        rows.collect::<Result<Result<Vec<_>, String>, _>>()
            .map_err(|error| format!("read list_bundle_leases: {error}"))?
    }

    /// Delete every lease of a bundle (used when the bundle is rolled back).
    pub fn delete_bundle_leases(&self, bundle_id: &str) -> Result<(), String> {
        self.connection
            .execute(
                "DELETE FROM workspace_root_leases WHERE bundle_id=?1",
                [bundle_id],
            )
            .map(|_| ())
            .map_err(|error| format!("delete leases {bundle_id}: {error}"))
    }

    pub fn delete_workspace_bundle(&self, bundle_id: &str) -> Result<(), String> {
        self.connection
            .execute(
                "DELETE FROM workspace_bundles WHERE bundle_id=?1",
                [bundle_id],
            )
            .map(|_| ())
            .map_err(|error| format!("delete workspace bundle {bundle_id}: {error}"))
    }

    pub fn put_workspace_archive(
        &self,
        workspace_id: &str,
        snapshot: &crate::snapshot::WorkspaceSnapshot,
        now: i64,
    ) -> Result<(), String> {
        let payload = serde_json::to_string(snapshot)
            .map_err(|error| format!("encode workspace archive {workspace_id}: {error}"))?;
        self.connection
            .execute(
                "INSERT INTO workspace_archives(workspace_id, payload, created_at)
                 VALUES(?1, ?2, ?3)
                 ON CONFLICT(workspace_id) DO UPDATE SET
                   payload=excluded.payload,
                   created_at=excluded.created_at",
                params![workspace_id, payload, now],
            )
            .map(|_| ())
            .map_err(|error| format!("put workspace archive {workspace_id}: {error}"))
    }

    pub fn get_workspace_archive(
        &self,
        workspace_id: &str,
    ) -> Result<Option<crate::snapshot::WorkspaceSnapshot>, String> {
        let payload = self
            .connection
            .query_row(
                "SELECT payload FROM workspace_archives WHERE workspace_id=?1",
                [workspace_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("get workspace archive {workspace_id}: {error}"))?;
        payload
            .map(|value| {
                serde_json::from_str(&value)
                    .map_err(|error| format!("decode workspace archive {workspace_id}: {error}"))
            })
            .transpose()
    }

    pub fn delete_workspace_archive(&self, workspace_id: &str) -> Result<(), String> {
        self.connection
            .execute(
                "DELETE FROM workspace_archives WHERE workspace_id=?1",
                [workspace_id],
            )
            .map(|_| ())
            .map_err(|error| format!("delete workspace archive {workspace_id}: {error}"))
    }

    /// Record a sensitive-path grant. Idempotent: replaces any existing
    /// grant on the same (workspace, path).
    pub fn put_sensitive_grant(&self, grant: &crate::SensitiveGrant) -> Result<(), String> {
        let owner_type = serialize_enum(&grant.granted_by_owner_type, "grant owner type")?;
        self.connection
            .execute(
                "INSERT OR REPLACE INTO workspace_sensitive_grants (
                   workspace_id, relative_path, granted_by_owner_type,
                   granted_by_owner_ref, granted_at
                 ) VALUES (?1,?2,?3,?4,?5)",
                params![
                    grant.workspace_id,
                    grant.relative_path,
                    owner_type,
                    grant.granted_by_owner_ref,
                    grant.granted_at,
                ],
            )
            .map(|_| ())
            .map_err(|error| format!("put sensitive grant: {error}"))
    }

    /// List every sensitive-path grant. Loaded once at Registry startup into
    /// the in-memory `SensitiveGrantStore`.
    pub fn list_sensitive_grants(&self) -> Result<Vec<crate::SensitiveGrant>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT workspace_id, relative_path, granted_by_owner_type,
                        granted_by_owner_ref, granted_at
                   FROM workspace_sensitive_grants",
            )
            .map_err(|error| format!("prepare list_sensitive_grants: {error}"))?;
        let rows = statement
            .query_map([], map_grant_row)
            .map_err(|error| format!("query list_sensitive_grants: {error}"))?;
        rows.collect::<Result<Result<Vec<_>, String>, _>>()
            .map_err(|error| format!("read list_sensitive_grants: {error}"))?
    }

    /// Append one row to the sensitive-decision audit log. Never mutated.
    pub fn append_sensitive_audit(&self, entry: &crate::SensitiveAuditEntry) -> Result<(), String> {
        let decision = serialize_enum(&entry.decision, "audit decision")?;
        let requester = serialize_enum(&entry.requester_owner_type, "requester owner type")?;
        self.connection
            .execute(
                "INSERT INTO workspace_sensitive_audit (
                   audit_id, workspace_id, relative_path, decision,
                   requester_owner_type, requester_owner_ref, decided_at, reason
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    entry.audit_id,
                    entry.workspace_id,
                    entry.relative_path,
                    decision,
                    requester,
                    entry.requester_owner_ref,
                    entry.decided_at,
                    entry.reason,
                ],
            )
            .map(|_| ())
            .map_err(|error| format!("append sensitive audit: {error}"))
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

/// Encode an enum as its camelCase string variant. Serde is the source of
/// truth for the mapping so `owner_type` etc. never drift between the wire
/// shape and SQLite rows.
fn serialize_enum<T: serde::Serialize>(value: &T, context: &str) -> Result<String, String> {
    serde_json::to_value(value)
        .and_then(serde_json::from_value::<String>)
        .map_err(|error| format!("encode {context}: {error}"))
}

fn deserialize_enum<T: serde::de::DeserializeOwned>(
    value: &str,
    context: &str,
) -> Result<T, String> {
    serde_json::from_value(serde_json::Value::String(value.to_string()))
        .map_err(|error| format!("decode {context} {value:?}: {error}"))
}

/// Row-mapper for `workspace_registry`. Bubbles rusqlite errors through the
/// `Result` returned by `query_map`.
fn map_workspace_source_binding_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<crate::WorkspaceSourceBinding> {
    Ok(crate::WorkspaceSourceBinding {
        binding_ref: row.get(0)?,
        source_root: row.get(1)?,
        git_common_dir: row.get(2)?,
        repository_fingerprint: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn map_workspace_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<crate::WorkspaceRecord, String>> {
    let workspace_id: String = row.get(0)?;
    let environment_kind_raw: String = row.get(1)?;
    let owner_type_raw: String = row.get(2)?;
    let owner_ref: Option<String> = row.get(3)?;
    let state_raw: String = row.get(4)?;
    let source_root: String = row.get(5)?;
    let git_common_dir: Option<String> = row.get(6)?;
    let base_kind_raw: String = row.get(7)?;
    let base_ref: Option<String> = row.get(8)?;
    let head: Option<String> = row.get(9)?;
    let branch: Option<String> = row.get(10)?;
    let isolation_kind_raw: String = row.get(11)?;
    let execution_root: String = row.get(12)?;
    let snapshot_task_id: Option<String> = row.get(13)?;
    let size_bytes: Option<i64> = row.get(14)?;
    let last_used_at: i64 = row.get(15)?;
    let locked_by: Option<String> = row.get(16)?;
    let pinned: i64 = row.get(17)?;
    let created_at: i64 = row.get(18)?;
    Ok((|| -> Result<crate::WorkspaceRecord, String> {
        let owner_type = deserialize_enum(&owner_type_raw, "owner type")?;
        let state = deserialize_enum(&state_raw, "workspace state")?;
        let isolation_kind = deserialize_enum(&isolation_kind_raw, "isolation kind")?;
        let base_kind = deserialize_enum(&base_kind_raw, "base kind")?;
        let base = crate::WorkspaceBaseSpec::from_storage(base_kind, base_ref.as_deref())?;
        Ok(crate::WorkspaceRecord {
            workspace_id,
            environment_kind: deserialize_enum(&environment_kind_raw, "environment kind")?,
            owner_type,
            owner_ref,
            state,
            source_root,
            git_common_dir,
            base,
            head,
            branch,
            isolation_kind,
            execution_root,
            snapshot_task_id,
            size_bytes: size_bytes.map(|value| value as u64),
            last_used_at,
            locked_by,
            pinned: pinned != 0,
            created_at,
        })
    })())
}

/// Row-mapper for `workspace_root_leases`.
fn map_lease_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<crate::WorkspaceRootLease, String>> {
    let bundle_id: String = row.get(0)?;
    let workspace_id: String = row.get(1)?;
    let logical_root_id: String = row.get(2)?;
    let role_raw: String = row.get(3)?;
    let alias_path: String = row.get(4)?;
    Ok((|| -> Result<crate::WorkspaceRootLease, String> {
        Ok(crate::WorkspaceRootLease {
            bundle_id,
            workspace_id,
            logical_root_id,
            role: deserialize_enum(&role_raw, "root role")?,
            alias_path,
        })
    })())
}

/// Row-mapper for `workspace_sensitive_grants`.
fn map_grant_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<crate::SensitiveGrant, String>> {
    let workspace_id: String = row.get(0)?;
    let relative_path: String = row.get(1)?;
    let owner_type_raw: String = row.get(2)?;
    let owner_ref: Option<String> = row.get(3)?;
    let granted_at: i64 = row.get(4)?;
    Ok((|| -> Result<crate::SensitiveGrant, String> {
        Ok(crate::SensitiveGrant {
            workspace_id,
            relative_path,
            granted_by_owner_type: deserialize_enum(&owner_type_raw, "grant owner type")?,
            granted_by_owner_ref: owner_ref,
            granted_at,
        })
    })())
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
                    workspace_id: None,
                    base: crate::WorkspaceBaseSpec::WorkingState,
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

    // -----------------------------------------------------------------
    // ADR-0111 Registry CRUD round-trips
    // -----------------------------------------------------------------

    fn sample_record(id: &str) -> crate::WorkspaceRecord {
        crate::WorkspaceRecord {
            workspace_id: id.into(),
            environment_kind: crate::WorkspaceEnvironmentKind::Managed,
            owner_type: crate::WorkspaceOwnerType::Session,
            owner_ref: Some("session-1".into()),
            state: crate::WorkspaceState::Provisioning,
            source_root: "/workspace".into(),
            git_common_dir: Some("/workspace/.git".into()),
            base: crate::WorkspaceBaseSpec::LocalHead,
            head: Some("abc123".into()),
            branch: None,
            isolation_kind: IsolationKind::GitWorktree,
            execution_root: format!("/tmp/{id}"),
            snapshot_task_id: None,
            size_bytes: Some(4096),
            last_used_at: 100,
            locked_by: Some("cognia:ws-1".into()),
            pinned: false,
            created_at: 100,
        }
    }

    #[test]
    fn workspace_record_survives_a_put_get_round_trip() {
        let dir = TempDir::new().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
        let record = sample_record("ws-1");
        store.put_workspace(&record).unwrap();
        let loaded = store.get_workspace("ws-1").unwrap().expect("row present");
        assert_eq!(loaded, record);
    }

    #[test]
    fn workspace_bundle_survives_a_put_get_round_trip() {
        let dir = TempDir::new().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
        let bundle = crate::WorkspaceBundle {
            bundle_id: "bundle-1".into(),
            environment_kind: crate::WorkspaceEnvironmentKind::Permanent,
            owner_type: crate::WorkspaceOwnerType::User,
            owner_ref: Some("project-1".into()),
            state: crate::WorkspaceState::Active,
            leases: Vec::new(),
            last_used_at: 200,
            pinned: true,
            created_at: 100,
        };
        store.put_workspace_bundle(&bundle).unwrap();
        assert_eq!(
            store.get_workspace_bundle("bundle-1").unwrap(),
            Some(bundle)
        );
    }

    #[test]
    fn list_workspaces_orders_by_last_used_desc() {
        let dir = TempDir::new().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
        let mut older = sample_record("ws-older");
        older.last_used_at = 50;
        let newer = sample_record("ws-newer");
        store.put_workspace(&older).unwrap();
        store.put_workspace(&newer).unwrap();
        let ordered = store.list_workspaces().unwrap();
        assert_eq!(
            ordered
                .iter()
                .map(|r| r.workspace_id.as_str())
                .collect::<Vec<_>>(),
            ["ws-newer", "ws-older"]
        );
    }

    #[test]
    fn deleting_a_workspace_cascades_to_leases_and_grants() {
        let dir = TempDir::new().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
        let record = sample_record("ws-cascade");
        store.put_workspace(&record).unwrap();
        store
            .put_root_lease(
                &crate::WorkspaceRootLease {
                    bundle_id: "bundle-1".into(),
                    workspace_id: "ws-cascade".into(),
                    logical_root_id: "root-a".into(),
                    role: crate::WorkspaceRootRole::Primary,
                    alias_path: "/tmp/ws-cascade".into(),
                },
                123,
            )
            .unwrap();
        store
            .put_sensitive_grant(&crate::SensitiveGrant {
                workspace_id: "ws-cascade".into(),
                relative_path: "secrets.env".into(),
                granted_by_owner_type: crate::WorkspaceOwnerType::User,
                granted_by_owner_ref: None,
                granted_at: 1,
            })
            .unwrap();
        store.delete_workspace("ws-cascade").unwrap();
        assert!(store.list_bundle_leases("bundle-1").unwrap().is_empty());
        assert!(store.list_sensitive_grants().unwrap().is_empty());
    }

    #[test]
    fn base_spec_pull_request_round_trips_through_storage() {
        let dir = TempDir::new().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
        let mut record = sample_record("ws-pr");
        record.base = crate::WorkspaceBaseSpec::PullRequest {
            provider: "github".into(),
            repo: "acme/app".into(),
            number: 42,
            fetch_ref: Some("refs/pull/42/head".into()),
            head_sha: Some("0123456789abcdef0123456789abcdef01234567".into()),
        };
        store.put_workspace(&record).unwrap();
        let loaded = store.get_workspace("ws-pr").unwrap().unwrap();
        assert_eq!(loaded.base, record.base);
    }

    #[test]
    fn workspace_updates_preserve_leases_and_archives() {
        let dir = TempDir::new().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
        let mut record = sample_record("ws-update");
        store.put_workspace(&record).unwrap();
        store
            .put_root_lease(
                &crate::WorkspaceRootLease {
                    bundle_id: "bundle-update".into(),
                    workspace_id: record.workspace_id.clone(),
                    logical_root_id: "primary".into(),
                    role: crate::WorkspaceRootRole::Primary,
                    alias_path: record.execution_root.clone(),
                },
                1,
            )
            .unwrap();
        let snapshot = crate::snapshot::WorkspaceSnapshot::default();
        store
            .put_workspace_archive(&record.workspace_id, &snapshot, 1)
            .unwrap();

        record.pinned = true;
        record.state = crate::WorkspaceState::Archived;
        store.put_workspace(&record).unwrap();

        assert_eq!(store.list_bundle_leases("bundle-update").unwrap().len(), 1);
        assert_eq!(
            store.get_workspace_archive("ws-update").unwrap(),
            Some(snapshot)
        );
    }

    #[test]
    fn sensitive_audit_rows_are_append_only() {
        let dir = TempDir::new().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
        let record = sample_record("ws-audit");
        store.put_workspace(&record).unwrap();
        for (idx, decision) in [
            crate::SensitiveDecision::Granted,
            crate::SensitiveDecision::ReusedGrant,
            crate::SensitiveDecision::RefusedBackground,
        ]
        .into_iter()
        .enumerate()
        {
            store
                .append_sensitive_audit(&crate::SensitiveAuditEntry {
                    audit_id: format!("audit-{idx}"),
                    workspace_id: "ws-audit".into(),
                    relative_path: "path.txt".into(),
                    decision,
                    requester_owner_type: crate::WorkspaceOwnerType::Session,
                    requester_owner_ref: Some("session-1".into()),
                    decided_at: idx as i64,
                    reason: None,
                })
                .unwrap();
        }
        // Duplicate audit_id must fail — audit is append-only.
        let dup = store.append_sensitive_audit(&crate::SensitiveAuditEntry {
            audit_id: "audit-0".into(),
            workspace_id: "ws-audit".into(),
            relative_path: "path.txt".into(),
            decision: crate::SensitiveDecision::Granted,
            requester_owner_type: crate::WorkspaceOwnerType::User,
            requester_owner_ref: None,
            decided_at: 99,
            reason: None,
        });
        assert!(dup.is_err(), "duplicate audit_id must be rejected");
    }

    #[test]
    fn workspace_lifecycle_policy_round_trips() {
        let dir = TempDir::new().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
        assert_eq!(store.get_workspace_lifecycle_policy().unwrap(), None);
        let policy = crate::WorkspaceLifecyclePolicy {
            active_directory_cap: 7,
            snapshot_retention_days: 14,
            blob_budget_bytes: 512,
        };
        store.put_workspace_lifecycle_policy(&policy).unwrap();
        assert_eq!(
            store.get_workspace_lifecycle_policy().unwrap(),
            Some(policy)
        );
    }
}
