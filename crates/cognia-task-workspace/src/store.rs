use crate::{
    PatchState, ResourceCaptureClass, ResourceChange, ResourceEvent, ResourceEventCounts,
    ResourceEventKind, ResourceTimelineCompleteness, RunState, TaskResourceSummary, TaskRun,
    TaskWorkspace, WorkspaceLifecyclePolicy,
};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;

pub struct WorkspaceStore {
    pub(crate) connection: Connection,
    blob_dir: PathBuf,
    max_blob_bytes: u64,
    /// The last compressed blob decoded for a ranged read, so reading one a
    /// slice at a time decodes it once. Only blobs up to
    /// [`DECODED_BLOB_CACHE_MAX_BYTES`] are kept.
    decoded: Option<(String, Arc<Vec<u8>>)>,
}

/// Largest decoded blob a ranged read keeps between slices. A larger one is
/// decoded again for every slice, streaming, so memory stays bounded.
pub const DECODED_BLOB_CACHE_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// One slice of a captured blob, from [`WorkspaceStore::read_blob_range`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobSlice {
    pub bytes: Vec<u8>,
    /// The whole blob's size.
    pub size: u64,
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
            decoded: None,
        };
        store.apply_registry_migration()?;
        store.apply_changeset_migration()?;
        store.apply_provenance_migration()?;
        Ok(store)
    }

    fn apply_changeset_migration(&self) -> Result<(), String> {
        self.connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS agent_changesets (
               changeset_id TEXT PRIMARY KEY,
               repo_common_dir TEXT NOT NULL,
               target_ref TEXT NOT NULL,
               owner_ref TEXT,
               session_id TEXT,
               state TEXT NOT NULL,
               version INTEGER NOT NULL,
               updated_at INTEGER NOT NULL,
               payload TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_agent_changesets_repo
               ON agent_changesets(repo_common_dir, target_ref, state);
             CREATE INDEX IF NOT EXISTS idx_agent_changesets_owner
               ON agent_changesets(owner_ref, session_id);
             CREATE INDEX IF NOT EXISTS idx_agent_changesets_retention
               ON agent_changesets(state, updated_at);
             CREATE TABLE IF NOT EXISTS integration_runs (
               integration_id TEXT PRIMARY KEY,
               repo_common_dir TEXT NOT NULL,
               target_ref TEXT NOT NULL,
               state TEXT NOT NULL,
               updated_at INTEGER NOT NULL,
               provisioning TEXT,
               payload TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_integration_runs_repo
               ON integration_runs(repo_common_dir, updated_at);
             CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_runs_active_target
               ON integration_runs(repo_common_dir, target_ref)
               WHERE state IN ('preparing', 'prepared', 'publishing');
             CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_runs_active_worktree
               ON integration_runs(repo_common_dir)
               WHERE state IN ('preparing', 'prepared', 'publishing');",
            )
            .map_err(|error| format!("apply changeset migration: {error}"))
    }

    pub fn insert_changeset(
        &self,
        record: &crate::AgentChangeset,
    ) -> Result<(), crate::ChangesetError> {
        let payload = serde_json::to_string(record)
            .map_err(|error| crate::ChangesetError::Store(error.to_string()))?;
        let state = serialize_enum(&record.state, "changeset state")
            .map_err(crate::ChangesetError::Store)?;
        self.connection.execute(
            "INSERT INTO agent_changesets(changeset_id,repo_common_dir,target_ref,owner_ref,session_id,state,version,updated_at,payload)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![record.changeset_id, record.repo_common_dir, record.target_ref, record.owner_ref,
                record.session_id, state, record.version, record.updated_at, payload],
        ).map_err(|error| crate::ChangesetError::Store(format!("insert changeset: {error}")))?;
        Ok(())
    }

    pub fn get_changeset(&self, id: &str) -> Result<Option<crate::AgentChangeset>, String> {
        json_optional(
            self.connection
                .query_row(
                    "SELECT payload FROM agent_changesets WHERE changeset_id=?1",
                    [id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| format!("get changeset: {error}"))?,
        )
    }

    pub fn list_changesets(
        &self,
        filter: &crate::ChangesetFilter,
    ) -> Result<Vec<crate::AgentChangeset>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT payload FROM agent_changesets WHERE (?1 IS NULL OR repo_common_dir=?1)
             AND (?2 IS NULL OR owner_ref=?2) AND (?3 IS NULL OR session_id=?3) ORDER BY rowid",
            )
            .map_err(|error| format!("prepare changesets: {error}"))?;
        let rows = statement
            .query_map(
                params![filter.repo_common_dir, filter.owner_ref, filter.session_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| format!("list changesets: {error}"))?;
        let mut records = Vec::new();
        for row in rows {
            let payload = row.map_err(|error| error.to_string())?;
            let record: crate::AgentChangeset =
                serde_json::from_str(&payload).map_err(|error| error.to_string())?;
            if filter
                .states
                .as_ref()
                .is_none_or(|states| states.contains(&record.state))
            {
                records.push(record);
            }
        }
        Ok(records)
    }

    pub fn update_changeset(
        &self,
        record: &crate::AgentChangeset,
        expected_version: u64,
    ) -> Result<(), crate::ChangesetError> {
        write_changeset(&self.connection, record, expected_version)
    }

    pub fn latest_workspace_run(
        &self,
        workspace_id: &str,
    ) -> Result<Option<(TaskRun, Option<String>)>, String> {
        let row: Option<(String, Option<String>)> = self
            .connection
            .query_row(
                "SELECT r.payload, t.session_id FROM task_runs r
             LEFT JOIN task_workspaces t ON t.task_id=r.task_id
             WHERE json_extract(r.payload, '$.workspaceId')=?1
             ORDER BY json_extract(r.payload, '$.createdAt') DESC, r.rowid DESC LIMIT 1",
                [workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("get changeset task run: {error}"))?;
        row.map(|(payload, session)| {
            serde_json::from_str(&payload)
                .map(|run| (run, session))
                .map_err(|error| error.to_string())
        })
        .transpose()
    }

    pub fn earliest_workspace_run(&self, workspace_id: &str) -> Result<Option<TaskRun>, String> {
        json_optional(
            self.connection
                .query_row(
                    "SELECT payload FROM task_runs
                     WHERE json_extract(payload, '$.workspaceId')=?1
                     ORDER BY json_extract(payload, '$.createdAt') ASC, rowid ASC LIMIT 1",
                    [workspace_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| format!("get original workspace run: {error}"))?,
        )
    }
    pub fn get_integration(&self, id: &str) -> Result<Option<crate::IntegrationRun>, String> {
        json_optional(
            self.connection
                .query_row(
                    "SELECT payload FROM integration_runs WHERE integration_id=?1",
                    [id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| format!("get integration: {error}"))?,
        )
    }

    pub fn list_integrations(&self) -> Result<Vec<crate::IntegrationRun>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT payload FROM integration_runs ORDER BY rowid")
            .map_err(|error| format!("prepare integrations: {error}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("list integrations: {error}"))?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())
        })
        .collect()
    }

    pub fn integration_provisioning(
        &self,
        id: &str,
    ) -> Result<Option<crate::WorkspaceProvisioning>, String> {
        let payload: Option<String> = self
            .connection
            .query_row(
                "SELECT provisioning FROM integration_runs WHERE integration_id=?1",
                [id],
                |row| row.get(0),
            )
            .map_err(|error| format!("get integration provisioning: {error}"))?;
        json_optional(payload)
    }

    /// Keep a new process from reserving the shared checkout between the
    /// ownership check and a reset/removal after a run becomes terminal.
    pub fn with_integration_worktree<T>(
        &mut self,
        repo: &str,
        owner_id: Option<&str>,
        idle_before: Option<i64>,
        action: impl FnOnce() -> Result<T, crate::IntegrationError>,
    ) -> Result<Option<T>, crate::IntegrationError> {
        use crate::IntegrationError;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| IntegrationError::Store(error.to_string()))?;
        let protected: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM integration_runs WHERE repo_common_dir=?1 AND
             ((state IN ('preparing','prepared','publishing') AND (?2 IS NULL OR integration_id<>?2))
              OR (?3 IS NOT NULL AND updated_at>=?3)))",
            params![repo, owner_id, idle_before], |row| row.get(0),
        ).map_err(|error| IntegrationError::Store(error.to_string()))?;
        if protected {
            return Ok(None);
        }
        let result = action()?;
        transaction
            .commit()
            .map_err(|error| IntegrationError::Store(error.to_string()))?;
        Ok(Some(result))
    }

    /// Reserve the shared worktree and advance its changesets in the same
    /// transaction. The payload comparison prevents a second service handle
    /// from overwriting a newer run even when both read the same state.
    pub fn save_integration(
        &mut self,
        run: &crate::IntegrationRun,
        previous: Option<&crate::IntegrationRun>,
        changesets: &[(crate::AgentChangeset, u64)],
        provisioning: Option<&crate::WorkspaceProvisioning>,
    ) -> Result<(), crate::IntegrationError> {
        use crate::IntegrationError;
        let payload = serde_json::to_string(run)
            .map_err(|error| IntegrationError::Store(error.to_string()))?;
        let state =
            serialize_enum(&run.state, "integration state").map_err(IntegrationError::Store)?;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| IntegrationError::Store(format!("begin integration: {error}")))?;
        if matches!(
            run.state,
            crate::IntegrationState::Preparing
                | crate::IntegrationState::Prepared
                | crate::IntegrationState::Publishing
        ) {
            let active: Option<String> = transaction
                .query_row(
                    "SELECT integration_id FROM integration_runs WHERE repo_common_dir=?1
                 AND integration_id<>?2 AND state IN ('preparing','prepared','publishing') LIMIT 1",
                    params![run.repo_common_dir, run.integration_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| IntegrationError::Store(error.to_string()))?;
            if let Some(integration_id) = active {
                return Err(IntegrationError::Busy { integration_id });
            }
        }
        if let Some(previous) = previous {
            // Compare typed payloads so additive serde defaults do not make
            // rows written by an older service look like concurrent updates.
            let expected: Option<String> = transaction
                .query_row(
                    "SELECT payload FROM integration_runs WHERE integration_id=?1",
                    params![run.integration_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| IntegrationError::Store(error.to_string()))?;
            let current = expected
                .as_deref()
                .map(serde_json::from_str::<crate::IntegrationRun>)
                .transpose()
                .map_err(|error| IntegrationError::Store(error.to_string()))?;
            if current.as_ref() != Some(previous) {
                return Err(IntegrationError::Conflict {
                    integration_id: run.integration_id.clone(),
                });
            }
            let changed = transaction
                .execute(
                    "UPDATE integration_runs SET state=?2,updated_at=?3,payload=?4
                 WHERE integration_id=?1 AND payload=?5",
                    params![run.integration_id, state, run.updated_at, payload, expected],
                )
                .map_err(|error| IntegrationError::Store(format!("update integration: {error}")))?;
            if changed != 1 {
                return Err(IntegrationError::Conflict {
                    integration_id: run.integration_id.clone(),
                });
            }
        } else {
            let provisioning = provisioning
                .map(serde_json::to_string)
                .transpose()
                .map_err(|error| IntegrationError::Store(error.to_string()))?;
            transaction.execute(
                "INSERT INTO integration_runs(integration_id,repo_common_dir,target_ref,state,updated_at,provisioning,payload)
                 VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![run.integration_id, run.repo_common_dir, run.target_ref, state, run.updated_at, provisioning, payload],
            ).map_err(|error| IntegrationError::Store(format!("insert integration: {error}")))?;
        }
        for (changeset, expected_version) in changesets {
            write_changeset(&transaction, changeset, *expected_version)?;
        }
        transaction
            .commit()
            .map_err(|error| IntegrationError::Store(format!("commit integration: {error}")))
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
                   project_id TEXT,
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
                 CREATE TABLE IF NOT EXISTS workspace_bundle_turns (
                   bundle_turn_id TEXT PRIMARY KEY,
                   bundle_id TEXT NOT NULL,
                   payload TEXT NOT NULL,
                   created_at INTEGER NOT NULL,
                   FOREIGN KEY(bundle_id) REFERENCES workspace_bundles(bundle_id)
                     ON DELETE CASCADE
                 );
                 CREATE INDEX IF NOT EXISTS idx_workspace_bundle_turns_bundle
                   ON workspace_bundle_turns(bundle_id, created_at);
                 CREATE TABLE IF NOT EXISTS workspace_bundle_handoffs (
                   bundle_turn_id TEXT PRIMARY KEY,
                   payload TEXT NOT NULL,
                   created_at INTEGER NOT NULL,
                   FOREIGN KEY(bundle_turn_id) REFERENCES workspace_bundle_turns(bundle_turn_id)
                     ON DELETE CASCADE
                 );
                 CREATE TABLE IF NOT EXISTS workspace_bundle_handoff_undos (
                   bundle_turn_id TEXT PRIMARY KEY,
                   payload TEXT NOT NULL,
                   created_at INTEGER NOT NULL,
                   FOREIGN KEY(bundle_turn_id) REFERENCES workspace_bundle_turns(bundle_turn_id)
                     ON DELETE CASCADE
                 );
                 CREATE TABLE IF NOT EXISTS workspace_maintenance_events (
                   event_id TEXT PRIMARY KEY,
                   occurred_at INTEGER NOT NULL,
                   payload TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_workspace_maintenance_events_time
                   ON workspace_maintenance_events(occurred_at DESC);
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
                 );
                 CREATE TABLE IF NOT EXISTS workspace_capture_baselines (
                   workspace_id TEXT PRIMARY KEY,
                   snapshot TEXT NOT NULL,
                   policy TEXT NOT NULL,
                   acquisition_commit TEXT,
                   FOREIGN KEY(workspace_id) REFERENCES workspace_registry(workspace_id)
                     ON DELETE CASCADE
                 );",
            )
            .map_err(|error| format!("apply workspace registry migration: {error}"))?;
        let has_acquisition_commit: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('workspace_capture_baselines') WHERE name='acquisition_commit')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("inspect workspace acquisition commit: {error}"))?;
        if !has_acquisition_commit {
            self.connection
                .execute(
                    "ALTER TABLE workspace_capture_baselines ADD COLUMN acquisition_commit TEXT",
                    [],
                )
                .map_err(|error| format!("add workspace acquisition commit: {error}"))?;
        }
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
        // Nullable with no default: an existing row's owning workspace is not
        // knowable here (the Project table lives in the frontend), so it stays
        // NULL until a reconcile pass matches its `source_root` to a project.
        let has_project_id: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('workspace_registry') WHERE name='project_id')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("inspect workspace project column: {error}"))?;
        if !has_project_id {
            self.connection
                .execute(
                    "ALTER TABLE workspace_registry ADD COLUMN project_id TEXT",
                    [],
                )
                .map_err(|error| format!("add workspace project id: {error}"))?;
        }
        // Indexed here rather than in the batch above: on an existing install
        // `CREATE TABLE IF NOT EXISTS` is a no-op, so an index declared there
        // would run against a column the ALTER has not added yet and fail the
        // whole migration. By this point the column exists either way.
        self.connection
            .execute(
                "CREATE INDEX IF NOT EXISTS idx_workspace_registry_project ON workspace_registry(project_id)",
                [],
            )
            .map_err(|error| format!("index workspace project id: {error}"))?;
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

    /// `length` bytes of a blob from `offset`, without holding all of it
    /// where that can be avoided: an uncompressed blob is read in place, a
    /// compressed one is decoded once and kept for the next slice (up to
    /// [`DECODED_BLOB_CACHE_MAX_BYTES`]) or decoded streaming past `offset`.
    /// Reading at or past the end is an empty slice. The first slice marks the
    /// blob used, as a whole read does, so GC keeps what is being read.
    pub fn read_blob_range(
        &mut self,
        hash: &str,
        offset: u64,
        length: u64,
        now: i64,
    ) -> Result<BlobSlice, String> {
        self.read_blob_range_cached_up_to(hash, offset, length, now, DECODED_BLOB_CACHE_MAX_BYTES)
    }

    fn read_blob_range_cached_up_to(
        &mut self,
        hash: &str,
        offset: u64,
        length: u64,
        now: i64,
        cache_max: u64,
    ) -> Result<BlobSlice, String> {
        let row: Option<(String, bool, u64)> = self
            .connection
            .query_row(
                "SELECT rel_path,compressed,size FROM task_blobs WHERE hash=?1",
                [hash],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("query blob {hash}: {error}"))?;
        let (rel_path, compressed, size) = row.ok_or_else(|| format!("missing blob {hash}"))?;
        let take = length.min(size.saturating_sub(offset));
        if offset == 0 {
            self.connection
                .execute(
                    "UPDATE task_blobs SET last_accessed=?2 WHERE hash=?1",
                    params![hash, now],
                )
                .map_err(|error| format!("touch blob {hash}: {error}"))?;
        }
        if take == 0 {
            return Ok(BlobSlice {
                bytes: Vec::new(),
                size,
            });
        }
        let path = self.blob_dir.join(rel_path);
        let bytes = if !compressed {
            use std::io::{Seek, SeekFrom};
            let mut file =
                fs::File::open(&path).map_err(|error| format!("open blob {hash}: {error}"))?;
            file.seek(SeekFrom::Start(offset))
                .map_err(|error| format!("seek blob {hash}: {error}"))?;
            let mut bytes = vec![0u8; take as usize];
            file.read_exact(&mut bytes)
                .map_err(|error| format!("read blob {hash}: {error}"))?;
            bytes
        } else if size <= cache_max {
            let decoded = match &self.decoded {
                Some((cached, bytes)) if cached == hash => Arc::clone(bytes),
                _ => {
                    let file = fs::File::open(&path)
                        .map_err(|error| format!("open blob {hash}: {error}"))?;
                    let mut decoded = Vec::with_capacity(size as usize);
                    GzDecoder::new(file)
                        .read_to_end(&mut decoded)
                        .map_err(|error| format!("decompress blob {hash}: {error}"))?;
                    let decoded = Arc::new(decoded);
                    self.decoded = Some((hash.to_string(), Arc::clone(&decoded)));
                    decoded
                }
            };
            let start = (offset as usize).min(decoded.len());
            let end = start.saturating_add(take as usize).min(decoded.len());
            decoded[start..end].to_vec()
        } else {
            let file =
                fs::File::open(&path).map_err(|error| format!("open blob {hash}: {error}"))?;
            let mut decoder = GzDecoder::new(file);
            std::io::copy(&mut (&mut decoder).take(offset), &mut std::io::sink())
                .map_err(|error| format!("decompress blob {hash}: {error}"))?;
            let mut bytes = Vec::with_capacity(take as usize);
            decoder
                .take(take)
                .read_to_end(&mut bytes)
                .map_err(|error| format!("decompress blob {hash}: {error}"))?;
            bytes
        };
        if bytes.len() as u64 != take {
            return Err(format!(
                "blob {hash} is shorter than its recorded size {size}"
            ));
        }
        Ok(BlobSlice { bytes, size })
    }

    /// The ledger's record of one run's change to one path.
    pub fn get_run_resource(
        &self,
        run_id: &str,
        path: &str,
    ) -> Result<Option<ResourceChange>, String> {
        let payload: Option<String> = self
            .connection
            .query_row(
                "SELECT payload FROM task_resources WHERE run_id=?1 AND path=?2",
                [run_id, path],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("query run resource: {error}"))?;
        payload
            .map(|payload| serde_json::from_str(&payload).map_err(|error| error.to_string()))
            .transpose()
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

    /// Every ledger row with its conversation and run, for the resource index
    /// (ADR-0223 §8). Rows of a run whose task has gone are gone with it. A
    /// run's payload is parsed once and shared by all of its rows, and each
    /// row carries what became of its change in the run's patch set.
    pub fn list_resource_index_rows(
        &self,
    ) -> Result<Vec<crate::resource_index::ResourceIndexRow>, String> {
        let mut runs = HashMap::new();
        {
            let mut statement = self
                .connection
                .prepare(
                    "SELECT run_id, payload FROM task_runs
                     WHERE run_id IN (SELECT DISTINCT run_id FROM task_resources)",
                )
                .map_err(|error| format!("prepare resource index runs: {error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| format!("query resource index runs: {error}"))?;
            for row in rows {
                let (run_id, payload) = row.map_err(|error| error.to_string())?;
                let run: TaskRun =
                    serde_json::from_str(&payload).map_err(|error| error.to_string())?;
                runs.insert(run_id, Arc::new(run));
            }
        }
        let mut outcomes = HashMap::new();
        {
            let mut statement = self
                .connection
                .prepare(
                    "SELECT run_id, payload FROM task_patch_sets
                     WHERE run_id IN (SELECT DISTINCT run_id FROM task_resources)",
                )
                .map_err(|error| format!("prepare resource index patches: {error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| format!("query resource index patches: {error}"))?;
            for row in rows {
                let (run_id, payload) = row.map_err(|error| error.to_string())?;
                let outcome: crate::resource_index::PatchOutcome =
                    serde_json::from_str(&payload).map_err(|error| error.to_string())?;
                outcomes.insert(run_id, outcome);
            }
        }
        let mut statement = self
            .connection
            .prepare(
                "SELECT w.session_id, w.workspace_root, r.run_id, r.payload
                 FROM task_resources r
                 JOIN task_workspaces w ON w.task_id = r.task_id",
            )
            .map_err(|error| format!("prepare resource index: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| format!("query resource index: {error}"))?;
        let mut index_rows = Vec::new();
        for row in rows {
            let (session_id, workspace_root, run_id, change) =
                row.map_err(|error| error.to_string())?;
            // A row whose run record is missing has nothing to order it by.
            let Some(run) = runs.get(&run_id) else {
                continue;
            };
            let change: ResourceChange =
                serde_json::from_str(&change).map_err(|error| error.to_string())?;
            let adoption = crate::resource_index::PatchOutcome::adoption_of(
                outcomes.get(&run_id),
                &change.path,
            );
            index_rows.push(crate::resource_index::ResourceIndexRow {
                session_id,
                workspace_root,
                run: Arc::clone(run),
                change,
                adoption,
            });
        }
        Ok(index_rows)
    }

    /// Changes to the database since it was opened: this connection's own
    /// writes, and `data_version`, which moves when another connection to the
    /// same file commits. Equal fingerprints mean nothing a reader could see
    /// has changed, so a result derived from the tables may be reused.
    pub fn change_fingerprint(&self) -> Result<(u64, i64), String> {
        let data_version = self
            .connection
            .query_row("PRAGMA data_version", [], |row| row.get::<_, i64>(0))
            .map_err(|error| format!("read data_version: {error}"))?;
        Ok((self.connection.total_changes(), data_version))
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
        // Releasing task/undo roots also makes their historical versions eligible.
        self.provenance().compact_provenance(crate::provenance::CompactionLimits::default())
            .map_err(|error| format!("compact provenance before blob prune: {error}"))?;
        self.prune_unreferenced_blobs_after_scan(|| {})
    }

    fn prune_unreferenced_blobs_after_scan(&mut self, after_scan: impl FnOnce()) -> Result<(u64, u64), String> {
        // Pin writers and reference scanning must share one write lock through deletion.
        let transaction = self.connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| format!("begin blob prune: {error}"))?;
        let mut referenced = HashSet::new();
        {
            let mut pins = transaction.prepare("SELECT hash FROM provenance_blob_pins")
                .map_err(|error| format!("prepare provenance pins: {error}"))?;
            for hash in pins.query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| format!("query provenance pins: {error}"))? {
                referenced.insert(hash.map_err(|error| error.to_string())?);
            }
        }
        for table_column in [
            "task_runs:payload",
            "task_runs:baseline",
            "task_resources:payload",
            "task_patch_sets:payload",
            "workspace_archives:payload",
            "workspace_capture_baselines:snapshot",
        ] {
            let (table, column) = table_column.split_once(':').expect("static table column");
            let sql = format!("SELECT {column} FROM {table}");
            let mut statement = transaction
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

        let mut statement = transaction
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

        after_scan();
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
            .and_then(serde_json::from_value::<String>)
            .map_err(|error| format!("encode base kind: {error}"))?;
        let owner_type = serialize_enum(&record.owner_type, "owner type")?;
        let environment_kind = serialize_enum(&record.environment_kind, "environment kind")?;
        let state = serialize_enum(&record.state, "workspace state")?;
        let isolation_kind = serialize_enum(&record.isolation_kind, "isolation kind")?;
        self.connection
            .execute(
                "INSERT INTO workspace_registry (
                   workspace_id, environment_kind, project_id, owner_type, owner_ref, state,
                   source_root, git_common_dir, base_kind, base_ref, head, branch,
                   isolation_kind, execution_root, snapshot_task_id, size_bytes,
                   last_used_at, locked_by, pinned, created_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)
                 ON CONFLICT(workspace_id) DO UPDATE SET
                   environment_kind=excluded.environment_kind,
                   project_id=excluded.project_id,
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
                    record.project_id,
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
                "SELECT workspace_id, environment_kind, project_id, owner_type, owner_ref, state,
                        source_root, git_common_dir, base_kind, base_ref, head, branch,
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

    /// Set (or clear) the owning Workspace for one row.
    pub fn set_workspace_project(
        &self,
        workspace_id: &str,
        project_id: Option<&str>,
    ) -> Result<(), String> {
        self.connection
            .execute(
                "UPDATE workspace_registry SET project_id=?2 WHERE workspace_id=?1",
                params![workspace_id, project_id],
            )
            .map_err(|error| format!("set workspace project {workspace_id}: {error}"))?;
        Ok(())
    }

    /// Registry rows owned by one Workspace, ordered by `last_used_at DESC`.
    pub fn list_workspaces_for_project(
        &self,
        project_id: &str,
    ) -> Result<Vec<crate::WorkspaceRecord>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT workspace_id, environment_kind, project_id, owner_type, owner_ref, state,
                        source_root, git_common_dir, base_kind, base_ref, head, branch,
                        isolation_kind, execution_root, snapshot_task_id, size_bytes,
                        last_used_at, locked_by, pinned, created_at
                   FROM workspace_registry WHERE project_id=?1 ORDER BY last_used_at DESC",
            )
            .map_err(|error| format!("prepare list_workspaces_for_project: {error}"))?;
        let rows = statement
            .query_map([project_id], map_workspace_row)
            .map_err(|error| format!("query list_workspaces_for_project: {error}"))?;
        rows.collect::<Result<Result<Vec<_>, String>, _>>()
            .map_err(|error| format!("read list_workspaces_for_project: {error}"))?
    }

    /// Enumerate every Registry row, ordered by `last_used_at DESC`.
    pub fn list_workspaces(&self) -> Result<Vec<crate::WorkspaceRecord>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT workspace_id, environment_kind, project_id, owner_type, owner_ref, state,
                        source_root, git_common_dir, base_kind, base_ref, head, branch,
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
                "INSERT INTO workspace_bundles (
                   bundle_id, environment_kind, owner_type, owner_ref, state,
                   last_used_at, pinned, created_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
                 ON CONFLICT(bundle_id) DO UPDATE SET
                   environment_kind=excluded.environment_kind,
                   owner_type=excluded.owner_type,
                   owner_ref=excluded.owner_ref,
                   state=excluded.state,
                   last_used_at=excluded.last_used_at,
                   pinned=excluded.pinned",
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

    pub fn put_workspace_bundle_turn(
        &self,
        turn: &crate::WorkspaceBundleTurnLease,
    ) -> Result<(), String> {
        let payload = serde_json::to_string(turn)
            .map_err(|error| format!("encode workspace bundle turn: {error}"))?;
        self.connection
            .execute(
                "INSERT INTO workspace_bundle_turns(bundle_turn_id,bundle_id,payload,created_at)
                 VALUES(?1,?2,?3,?4)
                 ON CONFLICT(bundle_turn_id) DO UPDATE SET payload=excluded.payload",
                params![
                    turn.bundle_turn_id,
                    turn.bundle_id,
                    payload,
                    turn.created_at
                ],
            )
            .map(|_| ())
            .map_err(|error| format!("put workspace bundle turn {}: {error}", turn.bundle_turn_id))
    }

    pub fn get_workspace_bundle_turn(
        &self,
        bundle_turn_id: &str,
    ) -> Result<Option<crate::WorkspaceBundleTurnLease>, String> {
        let payload = self
            .connection
            .query_row(
                "SELECT payload FROM workspace_bundle_turns WHERE bundle_turn_id=?1",
                [bundle_turn_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("get workspace bundle turn {bundle_turn_id}: {error}"))?;
        payload
            .map(|payload| {
                serde_json::from_str(&payload)
                    .map_err(|error| format!("decode workspace bundle turn: {error}"))
            })
            .transpose()
    }

    pub fn list_workspace_bundle_turns(
        &self,
    ) -> Result<Vec<crate::WorkspaceBundleTurnLease>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT payload FROM workspace_bundle_turns ORDER BY created_at")
            .map_err(|error| format!("prepare workspace bundle turns: {error}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("query workspace bundle turns: {error}"))?;
        rows.map(|row| {
            let payload = row.map_err(|error| error.to_string())?;
            serde_json::from_str(&payload)
                .map_err(|error| format!("decode workspace bundle turn: {error}"))
        })
        .collect()
    }

    pub fn put_bundle_handoff_outcome(
        &self,
        outcome: &crate::BundleHandoffOutcome,
    ) -> Result<(), String> {
        let payload = serde_json::to_string(outcome)
            .map_err(|error| format!("encode bundle handoff outcome: {error}"))?;
        self.connection
            .execute(
                "INSERT INTO workspace_bundle_handoffs(bundle_turn_id,payload,created_at)
                 VALUES(?1,?2,CAST(strftime('%s','now') AS INTEGER)*1000)
                 ON CONFLICT(bundle_turn_id) DO UPDATE SET payload=excluded.payload",
                params![outcome.bundle_turn_id, payload],
            )
            .map(|_| ())
            .map_err(|error| format!("put bundle handoff outcome: {error}"))
    }

    pub fn get_bundle_handoff_outcome(
        &self,
        bundle_turn_id: &str,
    ) -> Result<Option<crate::BundleHandoffOutcome>, String> {
        let payload = self
            .connection
            .query_row(
                "SELECT payload FROM workspace_bundle_handoffs WHERE bundle_turn_id=?1",
                [bundle_turn_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("get bundle handoff outcome: {error}"))?;
        payload
            .map(|payload| {
                serde_json::from_str(&payload)
                    .map_err(|error| format!("decode bundle handoff outcome: {error}"))
            })
            .transpose()
    }

    pub fn put_bundle_handoff_undo_outcome(
        &self,
        outcome: &crate::BundleHandoffUndoOutcome,
    ) -> Result<(), String> {
        let payload = serde_json::to_string(outcome)
            .map_err(|error| format!("encode bundle handoff undo outcome: {error}"))?;
        self.connection
            .execute(
                "INSERT INTO workspace_bundle_handoff_undos(bundle_turn_id,payload,created_at)
                 VALUES(?1,?2,CAST(strftime('%s','now') AS INTEGER)*1000)
                 ON CONFLICT(bundle_turn_id) DO UPDATE SET payload=excluded.payload",
                params![outcome.bundle_turn_id, payload],
            )
            .map(|_| ())
            .map_err(|error| format!("put bundle handoff undo outcome: {error}"))
    }

    pub fn get_bundle_handoff_undo_outcome(
        &self,
        bundle_turn_id: &str,
    ) -> Result<Option<crate::BundleHandoffUndoOutcome>, String> {
        let payload = self
            .connection
            .query_row(
                "SELECT payload FROM workspace_bundle_handoff_undos WHERE bundle_turn_id=?1",
                [bundle_turn_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("get bundle handoff undo outcome: {error}"))?;
        payload
            .map(|payload| {
                serde_json::from_str(&payload)
                    .map_err(|error| format!("decode bundle handoff undo outcome: {error}"))
            })
            .transpose()
    }

    pub fn append_workspace_maintenance_events(
        &mut self,
        events: &[crate::WorkspaceMaintenanceEvent],
    ) -> Result<(), String> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| format!("begin workspace maintenance events: {error}"))?;
        for event in events {
            let payload = serde_json::to_string(event)
                .map_err(|error| format!("encode workspace maintenance event: {error}"))?;
            transaction
                .execute(
                    "INSERT OR REPLACE INTO workspace_maintenance_events(event_id,occurred_at,payload)
                     VALUES(?1,?2,?3)",
                    params![event.event_id, event.occurred_at, payload],
                )
                .map_err(|error| format!("append workspace maintenance event: {error}"))?;
        }
        transaction
            .commit()
            .map_err(|error| format!("commit workspace maintenance events: {error}"))
    }

    pub fn list_workspace_maintenance_events(
        &self,
        limit: u32,
    ) -> Result<Vec<crate::WorkspaceMaintenanceEvent>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT payload FROM workspace_maintenance_events
                 ORDER BY occurred_at DESC, rowid DESC LIMIT ?1",
            )
            .map_err(|error| format!("prepare workspace maintenance events: {error}"))?;
        let rows = statement
            .query_map([i64::from(limit)], |row| row.get::<_, String>(0))
            .map_err(|error| format!("query workspace maintenance events: {error}"))?;
        rows.map(|row| {
            let payload = row.map_err(|error| error.to_string())?;
            serde_json::from_str(&payload)
                .map_err(|error| format!("decode workspace maintenance event: {error}"))
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

    /// Preserve the acquisition snapshot independently of later run baselines
    /// and archive snapshots. Reusing a workspace never changes this origin.
    pub fn put_workspace_capture_baseline(
        &self,
        workspace_id: &str,
        snapshot: &crate::snapshot::WorkspaceSnapshot,
        policy: &crate::ResourceTrackingPolicy,
        acquisition_commit: Option<&str>,
    ) -> Result<(), String> {
        let snapshot = serde_json::to_string(snapshot).map_err(|error| {
            format!("encode workspace capture baseline {workspace_id}: {error}")
        })?;
        let policy = serde_json::to_string(policy)
            .map_err(|error| format!("encode workspace capture policy {workspace_id}: {error}"))?;
        self.connection
            .execute(
                "INSERT INTO workspace_capture_baselines(workspace_id, snapshot, policy, acquisition_commit)
                 VALUES(?1, ?2, ?3, ?4) ON CONFLICT(workspace_id) DO NOTHING",
                params![workspace_id, snapshot, policy, acquisition_commit],
            )
            .map(|_| ())
            .map_err(|error| format!("put workspace capture baseline {workspace_id}: {error}"))
    }

    pub fn get_workspace_capture_baseline(
        &self,
        workspace_id: &str,
    ) -> Result<
        Option<(
            crate::snapshot::WorkspaceSnapshot,
            crate::ResourceTrackingPolicy,
            Option<String>,
        )>,
        String,
    > {
        let row: Option<(String, String, Option<String>)> = self
            .connection
            .query_row(
                "SELECT snapshot, policy, acquisition_commit FROM workspace_capture_baselines WHERE workspace_id=?1",
                [workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("get workspace capture baseline {workspace_id}: {error}"))?;
        row.map(|(snapshot, policy, acquisition_commit)| {
            Ok((
                serde_json::from_str(&snapshot).map_err(|error| {
                    format!("decode workspace capture baseline {workspace_id}: {error}")
                })?,
                serde_json::from_str(&policy).map_err(|error| {
                    format!("decode workspace capture policy {workspace_id}: {error}")
                })?,
                acquisition_commit,
            ))
        })
        .transpose()
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

fn write_changeset(
    connection: &Connection,
    record: &crate::AgentChangeset,
    expected_version: u64,
) -> Result<(), crate::ChangesetError> {
    use crate::ChangesetError;
    if expected_version.checked_add(1) != Some(record.version) {
        return Err(ChangesetError::Conflict {
            changeset_id: record.changeset_id.clone(),
        });
    }
    let payload =
        serde_json::to_string(record).map_err(|error| ChangesetError::Store(error.to_string()))?;
    let state = serialize_enum(&record.state, "changeset state").map_err(ChangesetError::Store)?;
    let changed = connection.execute(
        "UPDATE agent_changesets SET repo_common_dir=?2,target_ref=?3,owner_ref=?4,session_id=?5,
         state=?6,version=?7,updated_at=?8,payload=?9 WHERE changeset_id=?1 AND version=?10",
        params![record.changeset_id,record.repo_common_dir,record.target_ref,record.owner_ref,
            record.session_id,state,record.version,record.updated_at,payload,expected_version],
    ).map_err(|error| ChangesetError::Store(format!("update changeset: {error}")))?;
    if changed != 1 {
        return Err(ChangesetError::Conflict {
            changeset_id: record.changeset_id.clone(),
        });
    }
    Ok(())
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
    let project_id: Option<String> = row.get(2)?;
    let owner_type_raw: String = row.get(3)?;
    let owner_ref: Option<String> = row.get(4)?;
    let state_raw: String = row.get(5)?;
    let source_root: String = row.get(6)?;
    let git_common_dir: Option<String> = row.get(7)?;
    let base_kind_raw: String = row.get(8)?;
    let base_ref: Option<String> = row.get(9)?;
    let head: Option<String> = row.get(10)?;
    let branch: Option<String> = row.get(11)?;
    let isolation_kind_raw: String = row.get(12)?;
    let execution_root: String = row.get(13)?;
    let snapshot_task_id: Option<String> = row.get(14)?;
    let size_bytes: Option<i64> = row.get(15)?;
    let last_used_at: i64 = row.get(16)?;
    let locked_by: Option<String> = row.get(17)?;
    let pinned: i64 = row.get(18)?;
    let created_at: i64 = row.get(19)?;
    Ok((|| -> Result<crate::WorkspaceRecord, String> {
        let owner_type = deserialize_enum(&owner_type_raw, "owner type")?;
        let state = deserialize_enum(&state_raw, "workspace state")?;
        let isolation_kind = deserialize_enum(&isolation_kind_raw, "isolation kind")?;
        let base_kind = deserialize_enum(&base_kind_raw, "base kind")?;
        let base = crate::WorkspaceBaseSpec::from_storage(base_kind, base_ref.as_deref())?;
        Ok(crate::WorkspaceRecord {
            workspace_id,
            project_id,
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

    fn sample_changeset(id: &str) -> crate::AgentChangeset {
        crate::AgentChangeset {
            changeset_id: id.into(),
            run_id: Some("run-1".into()),
            task_id: Some("task-1".into()),
            session_id: Some("session-1".into()),
            agent_id: Some("agent-1".into()),
            agent_kind: Some("test".into()),
            owner_ref: Some("session-1".into()),
            workspace_id: "workspace-1".into(),
            execution_root: "/exec/workspace-1".into(),
            repo_common_dir: "/repo/.git".into(),
            source_root: "/repo".into(),
            target_ref: "refs/heads/main".into(),
            base_sha: "a".repeat(40),
            head_sha: "b".repeat(40),
            change_ref: format!("refs/cognia/changesets/{id}"),
            title: format!("Change {id}"),
            files: vec![crate::ChangesetFile {
                path: "src/renamed.rs".into(),
                old_path: Some("src/original.rs".into()),
                status: crate::ChangesetFileStatus::Renamed,
                insertions: Some(3),
                deletions: Some(1),
                binary: false,
                sensitive: false,
                excluded: false,
            }],
            depends_on: vec!["earlier-changeset".into()],
            state: crate::ChangesetState::Ready,
            review: None,
            checks: vec![crate::ChangesetCheck {
                head_sha: "b".repeat(40),
                profile_id: "unit".into(),
                outcome: crate::ChangesetCheckOutcome::Passed,
                tier: Some("sandbox".into()),
                report_digest: Some("report-digest".into()),
                log_tail: Some("all checks passed".into()),
                ran_at: 100,
            }],
            required_checks: vec!["unit".into()],
            approval: None,
            integration_id: None,
            merged_sha: None,
            version: 1,
            created_at: 100,
            updated_at: 100,
        }
    }

    fn sample_integration(id: &str) -> crate::IntegrationRun {
        crate::IntegrationRun {
            integration_id: id.into(),
            repo_common_dir: "/repo/.git".into(),
            target_ref: "refs/heads/main".into(),
            strategy: crate::IntegrationStrategy::Merge,
            on_conflict: crate::IntegrationConflictPolicy::Skip,
            expected_old_sha: "a".repeat(40),
            candidate_sha: None,
            result_sha: None,
            state: crate::IntegrationState::Planned,
            items: vec![crate::IntegrationItem {
                changeset_id: "changeset-1".into(),
                head_sha: "b".repeat(40),
                outcome: crate::IntegrationItemOutcome::Pending,
                conflict_files: Vec::new(),
                commit_sha: None,
            }],
            worktree_path: Some("/data/integration/repo-key".into()),
            attempt: 1,
            op_log: Vec::new(),
            checks: Vec::new(),
            required_checks: Vec::new(),
            requested_checks: Vec::new(),
            error: None,
            created_at: 100,
            updated_at: 100,
        }
    }

    #[test]
    fn provenance_gc_serializes_new_pins_across_connections() {
        let dir = tempfile::tempdir().unwrap();
        let mut gc = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        let mut writer = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        writer.connection.busy_timeout(std::time::Duration::ZERO).unwrap();
        gc.put_blob("race", b"bytes", 1).unwrap();
        let root = writer.provenance().register_root("principal", "host", "/race", "working-tree", None).unwrap();
        let intent = crate::provenance::MutationIntent {
            root_id: root.root_id, operation_key: "race-op".into(), kind: "apply".into(),
            manifest: serde_json::json!({}), selection: serde_json::json!([]), blob_refs: vec!["race".into()], created_at: 1,
        };
        let removed = gc.prune_unreferenced_blobs_after_scan(|| {
            let error = writer.provenance().prepare_mutation(&intent).unwrap_err();
            assert!(matches!(error, crate::provenance::ProvenanceError::Database(rusqlite::Error::SqliteFailure(ref error, _)) if error.code == rusqlite::ErrorCode::DatabaseBusy));
        }).unwrap();
        assert_eq!(removed.0, 1);
        // Once GC releases the lock, a pin cannot be published for the deleted blob.
        assert!(writer.provenance().prepare_mutation(&intent).is_err());
        assert!(writer.provenance().mutation("race-op").unwrap().is_none());
        writer.put_blob("race", b"bytes", 2).unwrap();
        writer.provenance().prepare_mutation(&intent).unwrap();
        assert_eq!(gc.prune_unreferenced_blobs().unwrap().0, 0);
        assert_eq!(gc.get_blob("race", 3).unwrap(), b"bytes");
    }

    #[test]
    fn changeset_and_integration_migration_preserves_existing_data_across_reopen() {
        let dir = TempDir::new().unwrap();
        let task = TaskWorkspace {
            task_id: "task-1".into(),
            session_id: "session-1".into(),
            workspace_root: "/repo".into(),
            state: TaskWorkspaceState::Active,
            revision: 7,
            created_at: 1,
            expires_at: 1_000,
            pinned: true,
        };
        {
            let legacy = Connection::open(dir.path().join("task-workspaces.sqlite")).unwrap();
            legacy
                .execute_batch(
                    "CREATE TABLE task_workspaces (
                       task_id TEXT PRIMARY KEY,
                       session_id TEXT NOT NULL,
                       workspace_root TEXT NOT NULL,
                       payload TEXT NOT NULL
                     );",
                )
                .unwrap();
            legacy
                .execute(
                    "INSERT INTO task_workspaces VALUES (?1, ?2, ?3, ?4)",
                    params![
                        task.task_id,
                        task.session_id,
                        task.workspace_root,
                        serde_json::to_string(&task).unwrap()
                    ],
                )
                .unwrap();
        }
        let changeset = sample_changeset("changeset-1");
        let integration = sample_integration("integration-1");
        let provisioning = crate::WorkspaceProvisioning {
            sparse_paths: vec!["src".into()],
            include: vec!["local-settings.json".into()],
            ..crate::WorkspaceProvisioning::default()
        };
        {
            let mut store = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
            assert_eq!(store.get_task(&task.task_id).unwrap(), Some(task.clone()));
            store.insert_changeset(&changeset).unwrap();
            store
                .save_integration(&integration, None, &[], Some(&provisioning))
                .unwrap();
        }
        for _ in 0..2 {
            let store = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
            assert_eq!(store.get_task(&task.task_id).unwrap(), Some(task.clone()));
            assert_eq!(
                store.get_changeset(&changeset.changeset_id).unwrap(),
                Some(changeset.clone())
            );
            assert_eq!(
                store
                    .list_changesets(&crate::ChangesetFilter::default())
                    .unwrap(),
                vec![changeset.clone()]
            );
            assert_eq!(
                store.list_integrations().unwrap(),
                vec![integration.clone()]
            );
            assert_eq!(
                store
                    .integration_provisioning(&integration.integration_id)
                    .unwrap(),
                Some(provisioning.clone())
            );
        }
    }

    #[test]
    fn changeset_cas_preserves_the_newer_review_when_another_handle_is_stale() {
        let dir = TempDir::new().unwrap();
        let first = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
        let original = sample_changeset("changeset-1");
        first.insert_changeset(&original).unwrap();
        let second = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
        let mut stale = second
            .get_changeset(&original.changeset_id)
            .unwrap()
            .unwrap();
        let mut reviewed = original.clone();
        reviewed.state = crate::ChangesetState::Approved;
        reviewed.version += 1;
        reviewed.updated_at += 1;
        reviewed.review = Some(crate::ChangesetReview {
            head_sha: reviewed.head_sha.clone(),
            verdict: crate::ChangesetReviewVerdict::Approve,
            reviewer: crate::ChangesetReviewer::User,
            risk_tier: crate::ChangesetRiskTier::Low,
            reasons: vec!["Verified the rename and tests".into()],
            findings: Vec::new(),
            requires_human_approval: false,
            recorded_at: reviewed.updated_at,
        });
        first.update_changeset(&reviewed, original.version).unwrap();

        stale.version += 1;
        stale.title = "Stale editor changed the title".into();
        stale.state = crate::ChangesetState::Draft;
        let error = second
            .update_changeset(&stale, original.version)
            .unwrap_err();
        assert!(matches!(
            error,
            crate::ChangesetError::Conflict { changeset_id } if changeset_id == original.changeset_id
        ));
        assert_eq!(
            second.get_changeset(&original.changeset_id).unwrap(),
            Some(reviewed.clone())
        );
        assert_eq!(
            first
                .list_changesets(&crate::ChangesetFilter {
                    repo_common_dir: Some(reviewed.repo_common_dir.clone()),
                    owner_ref: reviewed.owner_ref.clone(),
                    session_id: reviewed.session_id.clone(),
                    states: Some(vec![crate::ChangesetState::Approved]),
                })
                .unwrap(),
            vec![reviewed]
        );
    }

    #[test]
    fn integration_reservation_serializes_targets_that_share_the_repository_worktree() {
        for state in [
            crate::IntegrationState::Preparing,
            crate::IntegrationState::Prepared,
            crate::IntegrationState::Publishing,
        ] {
            let dir = TempDir::new().unwrap();
            let mut first = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
            let mut active = sample_integration("active");
            active.state = state;
            first.save_integration(&active, None, &[], None).unwrap();
            let mut second = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
            for (id, target) in [
                ("same-target", "refs/heads/main"),
                ("other-target", "refs/heads/release"),
            ] {
                let mut contender = sample_integration(id);
                contender.target_ref = target.into();
                contender.state = crate::IntegrationState::Preparing;
                let error = second
                    .save_integration(&contender, None, &[], None)
                    .unwrap_err();
                assert!(matches!(
                    error,
                    crate::IntegrationError::Busy { integration_id } if integration_id == "active"
                ));
                assert!(second.get_integration(id).unwrap().is_none());
            }
            let mut other_repo = sample_integration("other-repository");
            other_repo.repo_common_dir = "/other-repo/.git".into();
            other_repo.state = crate::IntegrationState::Preparing;
            second
                .save_integration(&other_repo, None, &[], None)
                .unwrap();

            let mut published = active.clone();
            published.state = crate::IntegrationState::Published;
            published.updated_at += 1;
            first
                .save_integration(&published, Some(&active), &[], None)
                .unwrap();
            let mut next = sample_integration("next");
            next.state = crate::IntegrationState::Preparing;
            second.save_integration(&next, None, &[], None).unwrap();
            assert_eq!(second.get_integration("next").unwrap(), Some(next));
        }
    }

    #[test]
    fn integration_changeset_updates_roll_back_together_on_a_stale_version() {
        let dir = TempDir::new().unwrap();
        let mut store = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
        let first = sample_changeset("changeset-1");
        let second = sample_changeset("changeset-2");
        store.insert_changeset(&first).unwrap();
        store.insert_changeset(&second).unwrap();
        let original = sample_integration("integration-1");
        store.save_integration(&original, None, &[], None).unwrap();
        let mut newer_second = second.clone();
        newer_second.version += 1;
        newer_second.title = "Newer review must survive".into();
        store
            .update_changeset(&newer_second, second.version)
            .unwrap();
        let mut first_update = first.clone();
        first_update.version += 1;
        first_update.state = crate::ChangesetState::Integrating;
        let mut stale_second_update = second.clone();
        stale_second_update.version += 1;
        stale_second_update.state = crate::ChangesetState::Integrating;
        let updates = [
            (first_update, first.version),
            (stale_second_update, second.version),
        ];

        for insert in [false, true] {
            let mut preparing = original.clone();
            preparing.state = crate::IntegrationState::Preparing;
            preparing.updated_at += 1;
            if insert {
                preparing.integration_id = "new-integration".into();
            }
            let error = store
                .save_integration(&preparing, (!insert).then_some(&original), &updates, None)
                .unwrap_err();
            assert!(matches!(
                error,
                crate::IntegrationError::Changeset(crate::ChangesetError::Conflict { changeset_id })
                    if changeset_id == second.changeset_id
            ));
            assert_eq!(
                store.get_changeset(&first.changeset_id).unwrap(),
                Some(first.clone())
            );
            assert_eq!(
                store.get_changeset(&second.changeset_id).unwrap(),
                Some(newer_second.clone())
            );
            assert_eq!(store.list_integrations().unwrap(), vec![original.clone()]);
        }
    }

    #[test]
    fn integration_payload_cas_refuses_a_lost_race_without_overwriting_the_candidate() {
        let dir = TempDir::new().unwrap();
        let mut first = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
        let original = sample_integration("integration-1");
        first.save_integration(&original, None, &[], None).unwrap();
        let mut second = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
        let stale = second
            .get_integration(&original.integration_id)
            .unwrap()
            .unwrap();
        let mut prepared = original.clone();
        prepared.state = crate::IntegrationState::Prepared;
        prepared.candidate_sha = Some("c".repeat(40));
        prepared.items[0].outcome = crate::IntegrationItemOutcome::Merged;
        prepared.items[0].commit_sha = prepared.candidate_sha.clone();
        prepared.updated_at += 1;
        first
            .save_integration(&prepared, Some(&original), &[], None)
            .unwrap();
        let mut competing = stale.clone();
        competing.state = crate::IntegrationState::Failed;
        competing.error = Some(crate::IntegrationFailure {
            code: "stale-worker".into(),
            message: "An older worker attempted to replace the result".into(),
        });
        let error = second
            .save_integration(&competing, Some(&stale), &[], None)
            .unwrap_err();
        assert!(matches!(
            error,
            crate::IntegrationError::Conflict { integration_id }
                if integration_id == original.integration_id
        ));
        assert_eq!(
            second.get_integration(&original.integration_id).unwrap(),
            Some(prepared)
        );
    }

    #[test]
    fn resource_index_rows_carry_their_conversation_and_run() {
        let dir = TempDir::new().unwrap();
        let mut store = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
        store
            .put_task(&TaskWorkspace {
                task_id: "task-1".into(),
                session_id: "session-1".into(),
                workspace_root: "/repo".into(),
                state: TaskWorkspaceState::Active,
                revision: 0,
                created_at: 1,
                expires_at: 2,
                pinned: false,
            })
            .unwrap();
        let run = TaskRun {
            run_id: "run-1".into(),
            task_id: "task-1".into(),
            parent_run_id: None,
            agent_id: "agent-1".into(),
            agent_kind: "test".into(),
            execution_root: "/exec/run-1".into(),
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
            state: RunState::Ready,
            created_at: 1,
            settled_at: Some(5),
        };
        store.put_run(&run, &serde_json::json!({})).unwrap();
        let change = ResourceChange {
            run_id: "run-1".into(),
            path: "notes.md".into(),
            old_path: None,
            kind: crate::ChangeKind::Created,
            origin: ContributionOrigin::Agent,
            agent_id: Some("agent-1".into()),
            media_type: "text/markdown".into(),
            size: 3,
            hash: Some("h".into()),
            before_hash: None,
            insertions: None,
            deletions: None,
            binary: false,
            resource_kind: ResourceKind::File,
            before_mode: None,
            after_mode: None,
            sensitive: false,
            revision: 1,
            capture_class: ResourceCaptureClass::Source,
            content_captured: true,
        };
        store
            .replace_resources("task-1", "run-1", 1, std::slice::from_ref(&change))
            .unwrap();
        let rows = store.list_resource_index_rows().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "session-1");
        assert_eq!(rows[0].workspace_root, "/repo");
        assert_eq!(*rows[0].run, run);
        assert_eq!(rows[0].change, change);
        // No patch set yet: the change waits in the run's root.
        assert_eq!(rows[0].adoption, crate::ChangeAdoption::Pending);
        // The run's patch set says what became of it.
        let mut patch = crate::PatchSet {
            patch_id: "patch:run-1".into(),
            task_id: "task-1".into(),
            run_id: "run-1".into(),
            state: crate::PatchState::Applied,
            base_revision: 0,
            applied_revision: Some(2),
            files: Vec::new(),
            applied_files: Vec::new(),
            applied_selection: Vec::new(),
            applied_selection_known: true,
            reversible: true,
            created_at: 1,
        };
        store.put_patch_set(&patch).unwrap();
        let rows = store.list_resource_index_rows().unwrap();
        assert_eq!(rows[0].adoption, crate::ChangeAdoption::Applied);
        patch.state = crate::PatchState::Reverted;
        store.put_patch_set(&patch).unwrap();
        let rows = store.list_resource_index_rows().unwrap();
        assert_eq!(rows[0].adoption, crate::ChangeAdoption::Discarded);
        // A task's rows go with it.
        store.delete_task("task-1").unwrap();
        assert!(store.list_resource_index_rows().unwrap().is_empty());
    }

    #[test]
    fn a_blob_is_read_a_range_at_a_time_however_it_is_stored() {
        let dir = TempDir::new().unwrap();
        let mut store = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
        // Compresses: stored gzipped. Random-looking bytes do not: stored as is.
        let text: Vec<u8> = b"agent wrote this line\n".repeat(200);
        let mut state = 0x9E37_79B9_7F4A_7C15_u64;
        let noise: Vec<u8> = (0..4096)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 24) as u8
            })
            .collect();
        store.put_blob("text", &text, 1).unwrap();
        store.put_blob("noise", &noise, 1).unwrap();
        let compressed = |hash: &str| -> bool {
            store
                .connection
                .query_row(
                    "SELECT compressed FROM task_blobs WHERE hash=?1",
                    [hash],
                    |row| row.get(0),
                )
                .unwrap()
        };
        assert!(compressed("text"));
        assert!(!compressed("noise"));

        for (hash, bytes) in [("text", &text), ("noise", &noise)] {
            let mut read = Vec::new();
            let mut offset = 0;
            loop {
                let slice = store.read_blob_range(hash, offset, 1000, 2).unwrap();
                assert_eq!(slice.size, bytes.len() as u64);
                if slice.bytes.is_empty() {
                    break;
                }
                offset += slice.bytes.len() as u64;
                read.extend(slice.bytes);
            }
            assert_eq!(&read, bytes, "{hash}");
        }
        // The compressed one was decoded once and kept.
        assert_eq!(
            store.decoded.as_ref().map(|(hash, _)| hash.as_str()),
            Some("text")
        );
        // Over the cache cap, each slice decodes streaming and nothing is kept.
        store.decoded = None;
        let slice = store
            .read_blob_range_cached_up_to("text", 100, 50, 3, 10)
            .unwrap();
        assert_eq!(slice.bytes, text[100..150]);
        assert!(store.decoded.is_none());
        // Past the end: empty, not an error. Unknown blob: an error.
        assert!(store
            .read_blob_range("text", 1 << 20, 10, 4)
            .unwrap()
            .bytes
            .is_empty());
        assert!(store.read_blob_range("absent", 0, 10, 4).is_err());
        // The first slice marks the blob used; later slices write nothing.
        let accessed: i64 = store
            .connection
            .query_row(
                "SELECT last_accessed FROM task_blobs WHERE hash='text'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(accessed, 2);
    }

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
            project_id: None,
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
    fn workspace_project_survives_a_round_trip_and_scopes_the_listing() {
        let dir = TempDir::new().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();

        let mut owned = sample_record("ws-owned");
        owned.project_id = Some("project-a".into());
        store.put_workspace(&owned).unwrap();

        let mut other = sample_record("ws-other");
        other.project_id = Some("project-b".into());
        store.put_workspace(&other).unwrap();

        // Unowned rows exist by design: a worktree found on disk has no
        // project until a reconcile pass matches it.
        store.put_workspace(&sample_record("ws-unowned")).unwrap();

        assert_eq!(
            store.get_workspace("ws-owned").unwrap().unwrap().project_id,
            Some("project-a".into())
        );
        assert_eq!(
            store
                .get_workspace("ws-unowned")
                .unwrap()
                .unwrap()
                .project_id,
            None
        );

        let listed = store.list_workspaces_for_project("project-a").unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|r| r.workspace_id.as_str())
                .collect::<Vec<_>>(),
            ["ws-owned"]
        );
        assert_eq!(store.list_workspaces().unwrap().len(), 3);
    }

    #[test]
    fn setting_and_clearing_the_project_leaves_the_rest_of_the_row_alone() {
        let dir = TempDir::new().unwrap();
        let store = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
        let record = sample_record("ws-1");
        store.put_workspace(&record).unwrap();

        store
            .set_workspace_project("ws-1", Some("project-a"))
            .unwrap();
        let stamped = store.get_workspace("ws-1").unwrap().unwrap();
        assert_eq!(stamped.project_id, Some("project-a".into()));
        assert_eq!(
            crate::WorkspaceRecord {
                project_id: None,
                ..stamped.clone()
            },
            record
        );

        store.set_workspace_project("ws-1", None).unwrap();
        assert_eq!(
            store.get_workspace("ws-1").unwrap().unwrap().project_id,
            None
        );
        assert!(store
            .list_workspaces_for_project("project-a")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_registry_predating_the_project_column_gains_it_on_open() {
        // The migration is what keeps an existing install readable; without it
        // every row read fails on a missing column rather than reporting an
        // unowned workspace.
        let dir = TempDir::new().unwrap();
        {
            let store = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
            store.put_workspace(&sample_record("ws-legacy")).unwrap();
            // Drop the index first — SQLite refuses to drop a column an index
            // still references.
            store
                .connection
                .execute("DROP INDEX idx_workspace_registry_project", [])
                .unwrap();
            store
                .connection
                .execute("ALTER TABLE workspace_registry DROP COLUMN project_id", [])
                .unwrap();
        }
        let reopened = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
        let loaded = reopened
            .get_workspace("ws-legacy")
            .unwrap()
            .expect("row present");
        assert_eq!(loaded.project_id, None);
        assert_eq!(loaded.execution_root, "/tmp/ws-legacy");
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

    #[test]
    fn changeset_capture_baseline_is_original_survives_reopen_and_retains_blobs() {
        let data = TempDir::new().unwrap();
        let source = TempDir::new().unwrap();
        fs::write(
            source.path().join("original.txt"),
            "original acquisition bytes",
        )
        .unwrap();
        let policy = ResourceTrackingPolicy {
            generated_output_roots: vec!["generated".into()],
            auto_detect: false,
            self_contained: false,
        };
        let (snapshot, blobs) =
            crate::snapshot::capture_with_policy(source.path(), &policy).unwrap();
        let acquisition_commit = "1".repeat(40);
        {
            let mut store = WorkspaceStore::open(data.path(), 1024 * 1024).unwrap();
            store.put_workspace(&sample_record("ws-baseline")).unwrap();
            assert_eq!(
                store.get_workspace_capture_baseline("ws-baseline").unwrap(),
                None
            );
            for (hash, bytes) in &blobs {
                store.put_blob(hash, bytes, 1).unwrap();
            }
            store
                .put_workspace_capture_baseline(
                    "ws-baseline",
                    &snapshot,
                    &policy,
                    Some(&acquisition_commit),
                )
                .unwrap();
            store
                .put_workspace_capture_baseline(
                    "ws-baseline",
                    &crate::snapshot::WorkspaceSnapshot::default(),
                    &ResourceTrackingPolicy::default(),
                    None,
                )
                .unwrap();
            assert_eq!(
                store.get_workspace_capture_baseline("ws-baseline").unwrap(),
                Some((
                    snapshot.clone(),
                    policy.clone(),
                    Some(acquisition_commit.clone())
                ))
            );
            assert!(store
                .get_workspace_archive("ws-baseline")
                .unwrap()
                .is_none());
            assert!(store
                .get_workspace("ws-baseline")
                .unwrap()
                .unwrap()
                .snapshot_task_id
                .is_none());
            store.put_blob(&"f".repeat(64), b"unreferenced", 1).unwrap();
        }
        let mut reopened = WorkspaceStore::open(data.path(), 1024 * 1024).unwrap();
        assert_eq!(
            reopened
                .get_workspace_capture_baseline("ws-baseline")
                .unwrap(),
            Some((snapshot.clone(), policy, Some(acquisition_commit)))
        );
        assert_eq!(reopened.prune_unreferenced_blobs().unwrap().0, 1);
        for (hash, bytes) in &blobs {
            assert_eq!(reopened.get_blob(hash, 2).unwrap(), *bytes);
        }
        reopened.delete_workspace("ws-baseline").unwrap();
        assert!(reopened
            .get_workspace_capture_baseline("ws-baseline")
            .unwrap()
            .is_none());
        assert_eq!(
            reopened.prune_unreferenced_blobs().unwrap().0,
            blobs.len() as u64
        );
    }

    #[test]
    fn changeset_capture_baseline_migrates_without_guessing_an_acquisition_commit() {
        let data = TempDir::new().unwrap();
        let snapshot = crate::snapshot::WorkspaceSnapshot::default();
        let policy = ResourceTrackingPolicy::default();
        {
            let store = WorkspaceStore::open(data.path(), 1024 * 1024).unwrap();
            store
                .put_workspace(&sample_record("ws-legacy-baseline"))
                .unwrap();
            store
                .put_workspace_capture_baseline("ws-legacy-baseline", &snapshot, &policy, None)
                .unwrap();
            store
                .connection
                .execute(
                    "ALTER TABLE workspace_capture_baselines DROP COLUMN acquisition_commit",
                    [],
                )
                .unwrap();
        }
        let reopened = WorkspaceStore::open(data.path(), 1024 * 1024).unwrap();
        assert_eq!(
            reopened
                .get_workspace_capture_baseline("ws-legacy-baseline")
                .unwrap(),
            Some((snapshot, policy, None))
        );
    }

    #[test]
    fn integration_additive_check_fields_keep_legacy_rows_updatable() {
        let dir = TempDir::new().unwrap();
        let mut store = WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap();
        let original = sample_integration("legacy-checks");
        store.save_integration(&original, None, &[], None).unwrap();
        let mut payload = serde_json::to_value(&original).unwrap();
        payload.as_object_mut().unwrap().remove("requiredChecks");
        payload.as_object_mut().unwrap().remove("requestedChecks");
        store
            .connection
            .execute(
                "UPDATE integration_runs SET payload=?1 WHERE integration_id=?2",
                params![payload.to_string(), original.integration_id],
            )
            .unwrap();
        let previous = store
            .get_integration(&original.integration_id)
            .unwrap()
            .unwrap();
        assert!(previous.required_checks.is_empty() && previous.requested_checks.is_empty());
        let mut updated = previous.clone();
        updated.state = crate::IntegrationState::Aborted;
        store
            .save_integration(&updated, Some(&previous), &[], None)
            .unwrap();
        assert_eq!(
            store.get_integration(&original.integration_id).unwrap(),
            Some(updated.clone())
        );
        assert!(matches!(
            store.save_integration(&original, Some(&previous), &[], None),
            Err(crate::IntegrationError::Conflict { .. })
        ));
    }
}
