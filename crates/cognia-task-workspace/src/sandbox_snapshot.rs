//! Durable cold sandbox checkpoint ledger. Docker operations are performed by
//! the host between journal transitions; this module never trusts image labels.
use crate::{
    snapshot::{capture_checkpoint, materialize_checkpoint, CheckpointManifest},
    TaskWorkspace, TaskWorkspaceService, TaskWorkspaceState, WorkspacePortLease,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

pub const DEFAULT_SANDBOX_SNAPSHOT_BUDGET_BYTES: u64 = 1 << 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SnapshotOperationPhase {
    Preparing,
    WorkspaceCaptured,
    ImageCommitted,
    Ready,
    Tombstoned,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BeginSandboxSnapshot {
    pub snapshot_id: String,
    pub deployment_id: String,
    pub project_id: String,
    pub task_id: String,
    pub workspace_root: String,
    pub runtime: serde_json::Value,
    #[serde(default)]
    pub exclusions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct SandboxSnapshotRecord {
    pub snapshot_id: String,
    pub deployment_id: String,
    pub project_id: String,
    pub task_id: String,
    pub workspace_root: String,
    pub runtime: serde_json::Value,
    pub exclusions: Vec<String>,
    pub checkpoint_id: Option<String>,
    pub image_id: Option<String>,
    pub image_bytes: u64,
    pub phase: SnapshotOperationPhase,
    pub created_at: i64,
    pub expires_at: i64,
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct WorkspaceCheckpoint {
    pub checkpoint_id: String,
    pub snapshot_id: String,
    pub deployment_id: String,
    pub commit: String,
    pub pin_ref: String,
    pub manifest: CheckpointManifest,
    pub total_bytes: u64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct ForkedCheckpointWorkspace {
    pub task: TaskWorkspace,
    pub workspace_id: String,
    pub execution_root: String,
    pub port_lease: WorkspacePortLease,
}

#[derive(Debug, Clone)]
pub struct PendingSandboxSnapshotWorkspace {
    pub snapshot_id: String,
    pub workspace_id: String,
    pub execution_root: String,
    pub restoring: bool,
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), String> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS workspace_checkpoints (
        checkpoint_id TEXT PRIMARY KEY, deployment_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL UNIQUE, total_bytes INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sandbox_snapshots (
        snapshot_id TEXT PRIMARY KEY, deployment_id TEXT NOT NULL, workspace_root TEXT NOT NULL,
        phase TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS sandbox_snapshots_deployment ON sandbox_snapshots(deployment_id,phase);
        CREATE TABLE IF NOT EXISTS snapshot_artifact_refs (
        snapshot_id TEXT NOT NULL REFERENCES sandbox_snapshots(snapshot_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('runtime','fork','inFlight')), owner TEXT NOT NULL, payload TEXT,
        PRIMARY KEY(snapshot_id,kind,owner));
        CREATE TABLE IF NOT EXISTS snapshot_operations (
        snapshot_id TEXT PRIMARY KEY REFERENCES sandbox_snapshots(snapshot_id) ON DELETE CASCADE,
        deployment_id TEXT NOT NULL, phase TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS sandbox_snapshots_cold_reservation
        ON sandbox_snapshots(workspace_root) WHERE phase IN ('preparing','workspaceCaptured','imageCommitted');")
        .map_err(|e| format!("initialize sandbox snapshot ledger: {e}"))?;
    let has_payload = connection
        .prepare("PRAGMA table_info(snapshot_artifact_refs)")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
        .iter()
        .any(|name| name == "payload");
    if !has_payload {
        connection
            .execute(
                "ALTER TABLE snapshot_artifact_refs ADD COLUMN payload TEXT",
                [],
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn phase_name(phase: SnapshotOperationPhase) -> &'static str {
    match phase {
        SnapshotOperationPhase::Preparing => "preparing",
        SnapshotOperationPhase::WorkspaceCaptured => "workspaceCaptured",
        SnapshotOperationPhase::ImageCommitted => "imageCommitted",
        SnapshotOperationPhase::Ready => "ready",
        SnapshotOperationPhase::Tombstoned => "tombstoned",
    }
}
fn read_record(
    connection: &Connection,
    deployment: &str,
    id: &str,
) -> Result<Option<SandboxSnapshotRecord>, String> {
    let payload: Option<String> = connection
        .query_row(
            "SELECT payload FROM sandbox_snapshots WHERE deployment_id=?1 AND snapshot_id=?2",
            params![deployment, id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    payload
        .map(|p| serde_json::from_str(&p).map_err(|e| e.to_string()))
        .transpose()
}
fn require_record(
    connection: &Connection,
    deployment: &str,
    id: &str,
) -> Result<SandboxSnapshotRecord, String> {
    read_record(connection, deployment, id)?.ok_or_else(|| "snapshot_not_found".into())
}
fn write_record(connection: &Connection, record: &SandboxSnapshotRecord) -> Result<(), String> {
    connection.execute("UPDATE sandbox_snapshots SET phase=?1,payload=?2 WHERE snapshot_id=?3 AND deployment_id=?4",
        params![phase_name(record.phase),serde_json::to_string(record).map_err(|e| e.to_string())?,record.snapshot_id,record.deployment_id]).map_err(|e| e.to_string())?;
    connection
        .execute(
            "UPDATE snapshot_operations SET phase=?1,updated_at=?2 WHERE snapshot_id=?3",
            params![phase_name(record.phase), now_ms(), record.snapshot_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Checked while holding the same store lock as task acquisition.
pub(crate) fn reject_snapshot_reservation(
    connection: &Connection,
    root: &Path,
    task_id: &str,
) -> Result<(), String> {
    let mut statement=connection.prepare("SELECT workspace_root,json_extract(payload,'$.taskId') FROM sandbox_snapshots WHERE phase IN ('preparing','workspaceCaptured','imageCommitted')").map_err(|e|e.to_string())?;
    let rows = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (reserved_root, reserved_task) = row.map_err(|e| e.to_string())?;
        let reserved_root = Path::new(&reserved_root);
        if reserved_task == task_id
            || root.starts_with(reserved_root)
            || reserved_root.starts_with(root)
        {
            return Err("snapshot_busy: workspace has a cold snapshot operation".into());
        }
    }
    let mut pending=connection.prepare("SELECT COALESCE(json_extract(r.payload,'$.executionRoot'),w.execution_root) FROM snapshot_artifact_refs r LEFT JOIN workspace_registry w ON w.workspace_id=r.owner WHERE r.kind IN ('fork','inFlight') AND json_extract(r.payload,'$.pendingRuntime')=1 AND COALESCE(json_extract(r.payload,'$.executionRoot'),w.execution_root) IS NOT NULL").map_err(|e|e.to_string())?;
    for pending_root in pending
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
    {
        let pending_root =
            canonical_lock_root(Path::new(&pending_root.map_err(|e| e.to_string())?))?;
        let root = canonical_lock_root(root)?;
        if root.starts_with(&pending_root) || pending_root.starts_with(&root) {
            return Err("snapshot_busy: workspace runtime creation is pending".into());
        }
    }
    Ok(())
}

fn paths_overlap(candidate: &Path, root: &Path) -> bool {
    candidate
        .canonicalize()
        .ok()
        .is_some_and(|candidate| candidate.starts_with(root) || root.starts_with(candidate))
}

/// An in-flight reference is a restore when its journal says so. Restore
/// reservations always carry the archived workspace backup and a reservation
/// token; fork reservations never do.
fn is_restore_reservation(payload: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(payload).is_ok_and(|value| {
        match value.get("operation").and_then(serde_json::Value::as_str) {
            Some(operation) => operation == "restore",
            None => value.get("reservationToken").is_some() && value.get("workspace").is_some(),
        }
    })
}

pub(crate) fn canonical_lock_root(root: &Path) -> Result<PathBuf, String> {
    let absolute = if root.is_absolute() {
        root.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(root)
    };
    let mut ancestor = absolute.as_path();
    let mut suffix = Vec::new();
    loop {
        match ancestor.canonicalize() {
            Ok(mut canonical) => {
                for component in suffix.iter().rev() {
                    canonical.push(component);
                }
                return Ok(canonical);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                suffix.push(
                    ancestor
                        .file_name()
                        .ok_or("workspace root has no existing ancestor")?
                        .to_os_string(),
                );
                ancestor = ancestor
                    .parent()
                    .ok_or("workspace root has no existing ancestor")?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

impl TaskWorkspaceService {
    /// The same deployment-wide accounting used to admit snapshot writes.
    /// Tombstoned artifacts remain charged until cleanup releases them.
    pub fn sandbox_snapshot_usage_bytes(&self, deployment: &str) -> Result<u64, String> {
        deployment_bytes(&self.store.lock().connection, deployment)
    }

    /// Normal acquisitions share a canonical workspace fence. Snapshot reservation
    /// takes it exclusively without waiting, then the durable journal owns the fence.
    pub(crate) fn lock_cold_workspace_acquisition(
        &self,
        root: &Path,
        exclusive: bool,
    ) -> Result<fs::File, String> {
        let root = canonical_lock_root(root)?;
        let file = self.open_snapshot_lock("roots", root.as_os_str().as_encoded_bytes())?;
        if exclusive {
            // A child another thread is forking holds a copy of this descriptor
            // until its exec, so a just-released shared fence can read as held
            // for that instant (see `integration_lock::FORK_RELEASE_GRACE`).
            // A real acquisition holds it far longer than this grace.
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(250);
            loop {
                match file.try_lock() {
                    Ok(()) => break,
                    Err(fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(error) => {
                        return Err(format!(
                            "snapshot_busy: workspace acquisition is active: {error}"
                        ))
                    }
                }
            }
        } else {
            file.lock_shared().map_err(|e| e.to_string())?;
        }
        Ok(file)
    }

    fn open_snapshot_lock(&self, namespace: &str, identity: &[u8]) -> Result<fs::File, String> {
        let directory = self.checkpoint_dir.join("locks").join(namespace);
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join(hex::encode(Sha256::digest(identity))))
            .map_err(|e| e.to_string())
    }

    /// Only operations on this snapshot serialize; ledger readers and all other
    /// workspaces remain available while Git/blob/filesystem work is running.
    fn lock_snapshot_operation(&self, deployment: &str, id: &str) -> Result<fs::File, String> {
        let file =
            self.open_snapshot_lock("operations", format!("{deployment}\0{id}").as_bytes())?;
        file.lock().map_err(|e| e.to_string())?;
        Ok(file)
    }
    pub fn begin_sandbox_snapshot(
        &self,
        input: &BeginSandboxSnapshot,
    ) -> Result<SandboxSnapshotRecord, String> {
        uuid::Uuid::parse_str(&input.snapshot_id).map_err(|_| "snapshot_id must be a UUID")?;
        if input.deployment_id.is_empty() || input.project_id.is_empty() || input.task_id.is_empty()
        {
            return Err("snapshot identity cannot be empty".into());
        }
        let root = Path::new(&input.workspace_root)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !root.is_dir() {
            return Err("snapshot workspace must be a directory".into());
        }
        let _acquisition = self.lock_cold_workspace_acquisition(&root, true)?;
        let store = self.store.lock();
        let tx = rusqlite::Transaction::new_unchecked(
            &store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(|e| e.to_string())?;
        for task in store.list_tasks()? {
            for run in store.list_runs(&task.task_id)? {
                if matches!(
                    run.state,
                    crate::RunState::Running | crate::RunState::Settling
                ) && (task.task_id == input.task_id
                    || paths_overlap(Path::new(&run.execution_root), &root)
                    || paths_overlap(Path::new(&task.workspace_root), &root))
                {
                    return Err("snapshot_busy: an agent/task turn is active".into());
                }
            }
        }
        reject_snapshot_reservation(&tx, &root, &input.task_id)?;
        for workspace in store.list_workspaces()? {
            if Path::new(&workspace.execution_root)
                .canonicalize()
                .ok()
                .as_ref()
                == Some(&root)
                && workspace.locked_by.as_deref().is_some_and(|reason| {
                    crate::parse_lock_reason(reason) != Some(workspace.workspace_id.as_str())
                })
            {
                return Err("snapshot_busy: workspace has an active lease".into());
            }
        }
        let now = now_ms();
        let record = SandboxSnapshotRecord {
            snapshot_id: input.snapshot_id.clone(),
            deployment_id: input.deployment_id.clone(),
            project_id: input.project_id.clone(),
            task_id: input.task_id.clone(),
            workspace_root: root.to_string_lossy().into_owned(),
            runtime: input.runtime.clone(),
            exclusions: input.exclusions.clone(),
            checkpoint_id: None,
            image_id: None,
            image_bytes: 0,
            phase: SnapshotOperationPhase::Preparing,
            created_at: now,
            expires_at: now.saturating_add(30 * 24 * 60 * 60 * 1000),
            pinned: false,
        };
        tx.execute("INSERT INTO sandbox_snapshots(snapshot_id,deployment_id,workspace_root,phase,payload) VALUES(?1,?2,?3,'preparing',?4)",params![record.snapshot_id,record.deployment_id,record.workspace_root,serde_json::to_string(&record).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        tx.execute("INSERT INTO snapshot_operations(snapshot_id,deployment_id,phase,updated_at) VALUES(?1,?2,'preparing',?3)",params![record.snapshot_id,record.deployment_id,now]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(record)
    }

    pub fn get_sandbox_snapshot(
        &self,
        deployment: &str,
        id: &str,
    ) -> Result<Option<SandboxSnapshotRecord>, String> {
        read_record(&self.store.lock().connection, deployment, id)
    }
    pub fn list_sandbox_snapshots(
        &self,
        deployment: &str,
    ) -> Result<Vec<SandboxSnapshotRecord>, String> {
        let store = self.store.lock();
        let mut statement = store
            .connection
            .prepare(
                "SELECT payload FROM sandbox_snapshots WHERE deployment_id=?1 ORDER BY rowid DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([deployment], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .map(|r| {
                serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
            })
            .collect();
        rows
    }
    pub fn pending_sandbox_snapshot_operations(
        &self,
        deployment: &str,
    ) -> Result<Vec<SandboxSnapshotRecord>, String> {
        Ok(self
            .list_sandbox_snapshots(deployment)?
            .into_iter()
            .filter(|r| r.phase != SnapshotOperationPhase::Ready)
            .collect())
    }

    pub fn capture_sandbox_snapshot_checkpoint(
        &self,
        deployment: &str,
        id: &str,
    ) -> Result<WorkspaceCheckpoint, String> {
        self.capture_sandbox_snapshot_checkpoint_with_hook(deployment, id, || {})
    }

    fn capture_sandbox_snapshot_checkpoint_with_hook(
        &self,
        deployment: &str,
        id: &str,
        before_publish: impl FnOnce(),
    ) -> Result<WorkspaceCheckpoint, String> {
        let _operation = self.lock_snapshot_operation(deployment, id)?;
        let (record, available) = {
            let store = self.store.lock();
            let record = require_record(&store.connection, deployment, id)?;
            if record.phase != SnapshotOperationPhase::Preparing {
                return Err("invalid snapshot transition: expected preparing".into());
            }
            let budget = store
                .get_workspace_lifecycle_policy()?
                .unwrap_or_default()
                .sandbox_snapshot_budget_bytes;
            let used = deployment_bytes(&store.connection, deployment)?;
            let available = budget.checked_sub(used).ok_or("snapshot_budget_exceeded")?;
            (record, available)
        };
        let directory = self.checkpoint_path(deployment, id);
        fs::create_dir_all(directory.join("blobs")).map_err(|e| e.to_string())?;
        let capture = (|| {
            let (manifest, blobs) = capture_checkpoint(
                Path::new(&record.workspace_root),
                &record.exclusions,
                available,
            )?;
            let pin_ref = format!("refs/cognia/checkpoints/{id}");
            let commit = pin_independent_commit(
                Path::new(&record.workspace_root),
                &directory.join("git"),
                &pin_ref,
            )?;
            let total_bytes = manifest
                .bytes
                .checked_add(directory_size(&directory.join("git"))?)
                .ok_or("snapshot_budget_exceeded")?;
            if total_bytes > available {
                return Err(
                    "snapshot_budget_exceeded: checkpoint plus Git history exceeds budget".into(),
                );
            }
            for (hash, bytes) in blobs {
                fs::write(directory.join("blobs").join(hash), bytes).map_err(|e| e.to_string())?;
            }
            let checkpoint = WorkspaceCheckpoint {
                checkpoint_id: id.into(),
                snapshot_id: id.into(),
                deployment_id: deployment.into(),
                commit,
                pin_ref,
                manifest,
                total_bytes,
                created_at: now_ms(),
            };
            // The directory and pin are durable before publishing the checkpoint.
            sync_tree(&directory)?;
            before_publish();
            let store = self.store.lock();
            let tx = rusqlite::Transaction::new_unchecked(
                &store.connection,
                rusqlite::TransactionBehavior::Immediate,
            )
            .map_err(|e| e.to_string())?;
            let mut current = require_record(&tx, deployment, id)?;
            if current.phase != SnapshotOperationPhase::Preparing || current.checkpoint_id.is_some()
            {
                return Err("snapshot checkpoint reservation changed during capture".into());
            }
            let budget = store
                .get_workspace_lifecycle_policy()?
                .unwrap_or_default()
                .sandbox_snapshot_budget_bytes;
            if deployment_bytes(&tx, deployment)?
                .checked_add(total_bytes)
                .is_none_or(|total| total > budget)
            {
                return Err(
                    "snapshot_budget_exceeded: concurrent checkpoint publication exceeds budget"
                        .into(),
                );
            }
            tx.execute("INSERT INTO workspace_checkpoints(checkpoint_id,deployment_id,snapshot_id,total_bytes,payload) VALUES(?1,?2,?3,?4,?5)",params![checkpoint.checkpoint_id,deployment,id,total_bytes,serde_json::to_string(&checkpoint).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
            current.checkpoint_id = Some(id.into());
            current.phase = SnapshotOperationPhase::WorkspaceCaptured;
            write_record(&tx, &current)?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(checkpoint)
        })();
        if let Err(error) = &capture {
            if let Err(cleanup) = fs::remove_dir_all(&directory) {
                return Err(format!(
                    "{}; checkpoint compensation failed: {cleanup}",
                    error
                ));
            }
        }
        capture
    }

    pub fn record_sandbox_snapshot_image(
        &self,
        deployment: &str,
        id: &str,
        image_id: &str,
        image_bytes: u64,
    ) -> Result<SandboxSnapshotRecord, String> {
        let _operation = self.lock_snapshot_operation(deployment, id)?;
        if !image_id.starts_with("sha256:") {
            return Err("snapshot image must be addressed by immutable image ID".into());
        }
        let store = self.store.lock();
        let tx = rusqlite::Transaction::new_unchecked(
            &store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(|e| e.to_string())?;
        let mut record = require_record(&store.connection, deployment, id)?;
        if record.phase != SnapshotOperationPhase::WorkspaceCaptured {
            return Err("invalid snapshot transition: expected workspaceCaptured".into());
        }
        // Record the committed image even when it exceeds the budget: recovery
        // must know what to remove after a crash between commit and compensation.
        record.image_id = Some(image_id.into());
        record.image_bytes = image_bytes;
        record.phase = SnapshotOperationPhase::ImageCommitted;
        write_record(&tx, &record)?;
        tx.commit().map_err(|e| e.to_string())?;
        let budget = store
            .get_workspace_lifecycle_policy()?
            .unwrap_or_default()
            .sandbox_snapshot_budget_bytes;
        if deployment_bytes(&store.connection, deployment)? > budget {
            return Err("snapshot_budget_exceeded: committed image plus checkpoints exceeds deployment budget".into());
        }
        Ok(record)
    }
    pub fn complete_sandbox_snapshot(
        &self,
        deployment: &str,
        id: &str,
    ) -> Result<SandboxSnapshotRecord, String> {
        let _operation = self.lock_snapshot_operation(deployment, id)?;
        let store = self.store.lock();
        let tx = rusqlite::Transaction::new_unchecked(
            &store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(|e| e.to_string())?;
        let mut record = require_record(&store.connection, deployment, id)?;
        if record.phase != SnapshotOperationPhase::ImageCommitted
            || record.image_id.is_none()
            || record.checkpoint_id.is_none()
        {
            return Err("invalid snapshot transition: expected imageCommitted".into());
        }
        if deployment_bytes(&store.connection, deployment)?
            > store
                .get_workspace_lifecycle_policy()?
                .unwrap_or_default()
                .sandbox_snapshot_budget_bytes
        {
            return Err("snapshot_budget_exceeded".into());
        }
        record.phase = SnapshotOperationPhase::Ready;
        write_record(&tx, &record)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(record)
    }
    /// Persist resumption before publishing ready so later retention cleanup
    /// cannot restart a source container that the user has since stopped.
    pub fn mark_sandbox_snapshot_source_resumed(
        &self,
        deployment: &str,
        id: &str,
    ) -> Result<(), String> {
        let store = self.store.lock();
        let tx = rusqlite::Transaction::new_unchecked(
            &store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(|e| e.to_string())?;
        let mut record = require_record(&store.connection, deployment, id)?;
        let runtime = record
            .runtime
            .as_object_mut()
            .ok_or("snapshot runtime metadata must be an object")?;
        runtime.insert("wasRunning".into(), serde_json::Value::Bool(false));
        runtime.insert("sourceResumed".into(), serde_json::Value::Bool(true));
        write_record(&tx, &record)?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn pin_sandbox_snapshot(
        &self,
        deployment: &str,
        id: &str,
        pinned: bool,
    ) -> Result<SandboxSnapshotRecord, String> {
        let store = self.store.lock();
        let tx = rusqlite::Transaction::new_unchecked(
            &store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(|e| e.to_string())?;
        let mut record = require_record(&store.connection, deployment, id)?;
        if record.phase != SnapshotOperationPhase::Ready {
            return Err("snapshot_not_ready".into());
        }
        record.pinned = pinned;
        write_record(&tx, &record)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(record)
    }
    pub fn tombstone_sandbox_snapshot(
        &self,
        deployment: &str,
        id: &str,
    ) -> Result<SandboxSnapshotRecord, String> {
        let store = self.store.lock();
        let tx = rusqlite::Transaction::new_unchecked(
            &store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(|e| e.to_string())?;
        let mut record = require_record(&store.connection, deployment, id)?;
        record.phase = SnapshotOperationPhase::Tombstoned;
        write_record(&tx, &record)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(record)
    }
    /// Called only after the host has revoked previews and removed the image.
    /// A tombstone remains durable if releasing filesystem artifacts fails.
    pub fn release_sandbox_snapshot(&self, deployment: &str, id: &str) -> Result<(), String> {
        let _operation = self.lock_snapshot_operation(deployment, id)?;
        let store = self.store.lock();
        let record = require_record(&store.connection, deployment, id)?;
        if record.phase != SnapshotOperationPhase::Tombstoned {
            return Err("snapshot must be tombstoned before release".into());
        }
        if has_references(&store.connection, id)? {
            return Err("snapshot_busy: snapshot artifacts are referenced".into());
        }
        drop(store);
        let path = self.checkpoint_path(deployment, id);
        match fs::remove_dir_all(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("release checkpoint pins/blobs: {e}")),
        }
        let store = self.store.lock();
        let tx = rusqlite::Transaction::new_unchecked(
            &store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(|e| e.to_string())?;
        if require_record(&tx, deployment, id)?.phase != SnapshotOperationPhase::Tombstoned
            || has_references(&tx, id)?
        {
            return Err("snapshot release reservation changed".into());
        }
        tx.execute(
            "DELETE FROM workspace_checkpoints WHERE snapshot_id=?1 AND deployment_id=?2",
            params![id, deployment],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM sandbox_snapshots WHERE snapshot_id=?1 AND deployment_id=?2",
            params![id, deployment],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn add_sandbox_snapshot_reference(
        &self,
        deployment: &str,
        id: &str,
        kind: &str,
        owner: &str,
    ) -> Result<(), String> {
        let store = self.store.lock();
        let tx = rusqlite::Transaction::new_unchecked(
            &store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(|e| e.to_string())?;
        let record = require_record(&store.connection, deployment, id)?;
        if record.phase != SnapshotOperationPhase::Ready {
            return Err("snapshot_not_ready".into());
        }
        if owner.is_empty() {
            return Err("snapshot reference owner is required".into());
        }
        store.connection.execute("INSERT OR IGNORE INTO snapshot_artifact_refs(snapshot_id,kind,owner) VALUES(?1,?2,?3)",params![id,kind,owner]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn remove_sandbox_snapshot_reference(
        &self,
        deployment: &str,
        id: &str,
        kind: &str,
        owner: &str,
    ) -> Result<(), String> {
        let store = self.store.lock();
        require_record(&store.connection, deployment, id)?;
        store
            .connection
            .execute(
                "DELETE FROM snapshot_artifact_refs WHERE snapshot_id=?1 AND kind=?2 AND owner=?3",
                params![id, kind, owner],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn sandbox_snapshot_has_references(
        &self,
        deployment: &str,
        id: &str,
    ) -> Result<bool, String> {
        let store = self.store.lock();
        require_record(&store.connection, deployment, id)?;
        has_references(&store.connection, id)
    }
    /// Image IDs can be shared even though snapshot tags are unique. The
    /// ledger, including foreign deployments, owns the deletion authority.
    pub fn sandbox_snapshot_image_has_other_owners(
        &self,
        deployment: &str,
        id: &str,
        image_id: &str,
    ) -> Result<bool, String> {
        let store = self.store.lock();
        require_record(&store.connection, deployment, id)?;
        store.connection.query_row("SELECT EXISTS(SELECT 1 FROM sandbox_snapshots s WHERE json_extract(s.payload,'$.imageId')=?1 AND NOT(s.snapshot_id=?2 AND s.deployment_id=?3) AND (s.deployment_id<>?3 OR s.phase<>'tombstoned' OR EXISTS(SELECT 1 FROM snapshot_artifact_refs r WHERE r.snapshot_id=s.snapshot_id)))",params![image_id,id,deployment],|r|r.get(0)).map_err(|e|e.to_string())
    }
    pub fn list_sandbox_snapshot_references(
        &self,
        deployment: &str,
        id: &str,
    ) -> Result<Vec<(String, String)>, String> {
        let store = self.store.lock();
        require_record(&store.connection, deployment, id)?;
        let mut statement=store.connection.prepare("SELECT kind,owner FROM snapshot_artifact_refs WHERE snapshot_id=?1 ORDER BY kind,owner").map_err(|e|e.to_string())?;
        let rows = statement
            .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .map(|r| r.map_err(|e| e.to_string()))
            .collect();
        rows
    }
    pub fn get_workspace_checkpoint(
        &self,
        deployment: &str,
        id: &str,
    ) -> Result<WorkspaceCheckpoint, String> {
        let store = self.store.lock();
        read_checkpoint(&store.connection, deployment, id)
    }
    fn checkpoint_path(&self, deployment: &str, id: &str) -> PathBuf {
        // Both components are digested; even a corrupt database cannot escape
        // the checkpoint storage directory during materialization or reaping.
        self.checkpoint_dir
            .join(hex::encode(Sha256::digest(deployment.as_bytes())))
            .join(hex::encode(Sha256::digest(id.as_bytes())))
    }

    pub fn fork_sandbox_snapshot_workspace(
        &self,
        deployment: &str,
        id: &str,
        new_task_id: &str,
        new_session_id: &str,
    ) -> Result<ForkedCheckpointWorkspace, String> {
        let _operation = self.lock_snapshot_operation(deployment, id)?;
        self.enforce_managed_workspace_capacity(1)?;
        if new_task_id.is_empty() || new_session_id.is_empty() {
            return Err("fork task and session identities are required".into());
        }
        let workspace_id = format!("snapshot-fork-{}", uuid::Uuid::new_v4());
        let root = self.execution_dir.join(&workspace_id);
        let pending_root = canonical_lock_root(&root)?;
        let reservation = serde_json::json!({
            "operation": "fork",
            "pendingRuntime": true,
            "executionRoot": pending_root.to_string_lossy(),
        });
        let (record, checkpoint) = {
            let store = self.store.lock();
            let tx = rusqlite::Transaction::new_unchecked(
                &store.connection,
                rusqlite::TransactionBehavior::Immediate,
            )
            .map_err(|e| e.to_string())?;
            let record = require_record(&store.connection, deployment, id)?;
            if record.phase != SnapshotOperationPhase::Ready {
                return Err("snapshot_not_ready".into());
            }
            if store.get_task(new_task_id)?.is_some() {
                return Err("fork task identity is already in use".into());
            }
            let checkpoint = read_checkpoint(&store.connection, deployment, id)?;
            store.connection.execute("INSERT INTO snapshot_artifact_refs(snapshot_id,kind,owner,payload) VALUES(?1,'inFlight',?2,?3)",params![id,workspace_id,serde_json::to_string(&reservation).map_err(|e| e.to_string())?]).map_err(|e|e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            (record, checkpoint)
        };
        let result = (|| {
            self.materialize_cold_checkpoint(deployment, id, &root, &checkpoint)?;
            let now = now_ms();
            let task = TaskWorkspace {
                task_id: new_task_id.into(),
                session_id: new_session_id.into(),
                workspace_root: root.to_string_lossy().into(),
                state: TaskWorkspaceState::Ready,
                revision: 0,
                created_at: now,
                expires_at: record.expires_at,
                pinned: false,
            };
            let workspace = crate::WorkspaceRecord {
                port_lease: None,
                workspace_id: workspace_id.clone(),
                environment_kind: crate::WorkspaceEnvironmentKind::Managed,
                project_id: Some(record.project_id.clone()),
                owner_type: crate::WorkspaceOwnerType::Session,
                owner_ref: Some(new_session_id.into()),
                state: crate::WorkspaceState::Active,
                source_root: root.to_string_lossy().into(),
                git_common_dir: Some(root.join(".git").to_string_lossy().into()),
                base: crate::WorkspaceBaseSpec::default(),
                head: Some(checkpoint.commit.clone()),
                branch: None,
                isolation_kind: crate::IsolationKind::Shadow,
                execution_root: root.to_string_lossy().into(),
                snapshot_task_id: Some(new_task_id.into()),
                size_bytes: Some(checkpoint.total_bytes),
                last_used_at: now,
                locked_by: Some(crate::compose_lock_reason(&workspace_id)),
                pinned: false,
                created_at: now,
            };
            let canonical_root = crate::ports::registry_root(&root).map_err(|e| e.to_string())?;
            let lease = {
                let store = self.store.lock();
                let tx = rusqlite::Transaction::new_unchecked(
                    &store.connection,
                    rusqlite::TransactionBehavior::Immediate,
                )
                .map_err(|e| e.to_string())?;
                if require_record(&tx, deployment, id)?.phase != SnapshotOperationPhase::Ready {
                    return Err("snapshot_not_ready".into());
                }
                let reserved: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM snapshot_artifact_refs WHERE snapshot_id=?1 AND owner=?2 AND kind='inFlight' AND json_extract(payload,'$.pendingRuntime')=1)", params![id, workspace_id], |row| row.get(0)).map_err(|e| e.to_string())?;
                if !reserved {
                    return Err("snapshot fork reservation changed".into());
                }
                // Recheck because filesystem materialization releases the store lock.
                if store.get_task(new_task_id)?.is_some() {
                    return Err("fork task identity is already in use".into());
                }
                store.put_task(&task)?;
                store.put_workspace(&workspace)?;
                let lease = crate::ports::ensure_in_transaction(
                    &tx,
                    crate::HOST_LOOPBACK_NAMESPACE,
                    crate::ports::LeaseSubject {
                        kind: crate::PortSubjectKind::Registry,
                        key: &workspace_id,
                        root: &canonical_root,
                        registry_id: Some(&workspace_id),
                    },
                    store.get_workspace_lifecycle_policy()?.unwrap_or_default(),
                    now,
                )
                .map_err(|e| e.to_string())?;
                tx.execute("UPDATE snapshot_artifact_refs SET kind='fork' WHERE snapshot_id=?1 AND kind='inFlight' AND owner=?2",params![id,workspace_id]).map_err(|e|e.to_string())?;
                tx.commit().map_err(|e| e.to_string())?;
                lease
            };
            Ok(ForkedCheckpointWorkspace {
                task,
                workspace_id: workspace_id.clone(),
                execution_root: root.to_string_lossy().into(),
                port_lease: lease,
            })
        })();
        if let Err(error) = &result {
            if let Err(cleanup) =
                self.discard_sandbox_snapshot_fork_inner(deployment, id, &workspace_id)
            {
                return Err(format!(
                    "{}; fork compensation failed: {cleanup}",
                    error
                ));
            }
        }
        result
    }

    /// Compensate only a fork created by this snapshot; foreign workspaces and
    /// active turns are refused. No source path or source grant is touched.
    pub fn discard_sandbox_snapshot_fork(
        &self,
        deployment: &str,
        id: &str,
        workspace_id: &str,
    ) -> Result<(), String> {
        let _operation = self.lock_snapshot_operation(deployment, id)?;
        self.discard_sandbox_snapshot_fork_inner(deployment, id, workspace_id)
    }

    fn discard_sandbox_snapshot_fork_inner(
        &self,
        deployment: &str,
        id: &str,
        workspace_id: &str,
    ) -> Result<(), String> {
        let root = self.execution_dir.join(workspace_id);
        let acquisition = self.lock_cold_workspace_acquisition(&root, true)?;
        let store = self.store.lock();
        require_record(&store.connection, deployment, id)?;
        let owns:bool=store.connection.query_row("SELECT EXISTS(SELECT 1 FROM snapshot_artifact_refs WHERE snapshot_id=?1 AND owner=?2 AND kind IN ('fork','inFlight'))",params![id,workspace_id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !owns {
            return Err("snapshot fork ownership mismatch".into());
        }
        if !workspace_id.starts_with("snapshot-fork-") || workspace_id.contains(['/', '\\']) {
            return Err("invalid snapshot fork identity".into());
        }
        let root = self.execution_dir.join(workspace_id);
        let workspace = store.get_workspace(workspace_id)?;
        if let Some(workspace) = &workspace {
            if workspace.locked_by.as_deref().is_some_and(|reason| {
                crate::parse_lock_reason(reason) != Some(workspace.workspace_id.as_str())
            }) {
                return Err("snapshot_busy: fork workspace is in use".into());
            }
            if let Some(task) = workspace.snapshot_task_id.as_deref() {
                if store.list_runs(task)?.iter().any(|r| {
                    matches!(
                        r.state,
                        crate::RunState::Running | crate::RunState::Settling
                    )
                }) {
                    return Err("snapshot_busy: fork task is active".into());
                }
            }
        }
        store.connection.execute("UPDATE snapshot_artifact_refs SET payload=json_set(COALESCE(payload,'{}'),'$.pendingRuntime',json('true'),'$.cleanupPending',json('true')) WHERE snapshot_id=?1 AND owner=?2 AND kind IN ('fork','inFlight')", params![id,workspace_id]).map_err(|e| e.to_string())?;
        drop(store);
        drop(acquisition);
        remove_execution_tree(&root)?;
        let store = self.store.lock();
        let tx = rusqlite::Transaction::new_unchecked(
            &store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(|e| e.to_string())?;
        if store.get_workspace(workspace_id)? != workspace {
            return Err("snapshot fork changed during compensation".into());
        }
        let reserved: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM snapshot_artifact_refs WHERE snapshot_id=?1 AND owner=?2 AND json_extract(payload,'$.cleanupPending')=1)", params![id,workspace_id], |row| row.get(0)).map_err(|e| e.to_string())?;
        if !reserved {
            return Err("snapshot fork cleanup reservation changed".into());
        }
        // This generated root has no aliases. Delete the newly allocated block
        // in the same transaction that removes its generated registry record.
        tx.execute(
            "DELETE FROM workspace_port_leases WHERE registry_workspace_id=?1",
            [workspace_id],
        )
        .map_err(|e| e.to_string())?;
        if let Some(workspace) = workspace {
            tx.execute(
                "DELETE FROM workspace_registry WHERE workspace_id=?1",
                [workspace_id],
            )
            .map_err(|e| e.to_string())?;
            if let Some(task) = workspace.snapshot_task_id {
                store.delete_task(&task)?;
            }
        }
        tx.execute("DELETE FROM snapshot_artifact_refs WHERE snapshot_id=?1 AND owner=?2 AND kind IN ('fork','inFlight')",params![id,workspace_id]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn reserve_sandbox_snapshot_restore_target(
        &self,
        deployment: &str,
        id: &str,
        workspace_id: &str,
    ) -> Result<String, String> {
        let _operation = self.lock_snapshot_operation(deployment, id)?;
        let expected = self
            .store
            .lock()
            .get_workspace(workspace_id)?
            .ok_or("workspace_not_found")?;
        let _acquisition =
            self.lock_cold_workspace_acquisition(Path::new(&expected.execution_root), true)?;
        let root_exists = Path::new(&expected.execution_root).exists();
        let token = uuid::Uuid::new_v4().to_string();
        {
            let store = self.store.lock();
            let tx = rusqlite::Transaction::new_unchecked(
                &store.connection,
                rusqlite::TransactionBehavior::Immediate,
            )
            .map_err(|e| e.to_string())?;
            let snapshot = require_record(&store.connection, deployment, id)?;
            if snapshot.phase != SnapshotOperationPhase::Ready {
                return Err("snapshot_not_ready".into());
            }
            let workspace = store
                .get_workspace(workspace_id)?
                .ok_or("workspace_not_found")?;
            if workspace != expected {
                return Err("snapshot restore target changed".into());
            }
            if !matches!(
                workspace.state,
                crate::WorkspaceState::Archived | crate::WorkspaceState::Restorable
            ) {
                return Err(
                    "snapshot_restore_requires_fork: workspace is not archived/restorable".into(),
                );
            }
            if workspace.project_id.as_deref() != Some(snapshot.project_id.as_str()) {
                return Err("snapshot workspace project mismatch".into());
            }
            if workspace.locked_by.as_deref().is_some_and(|reason| {
                crate::parse_lock_reason(reason) != Some(workspace.workspace_id.as_str())
            }) {
                return Err("snapshot_busy: workspace is leased".into());
            }
            if root_exists {
                return Err(
                    "snapshot_restore_requires_fork: archived execution directory still exists"
                        .into(),
                );
            }
            read_checkpoint(&store.connection, deployment, id)?;
            reject_snapshot_reservation(
                &store.connection,
                Path::new(&workspace.execution_root),
                workspace_id,
            )?;
            let prior_reference:bool=store.connection.query_row("SELECT EXISTS(SELECT 1 FROM snapshot_artifact_refs WHERE snapshot_id=?1 AND kind='fork' AND owner=?2)",params![id,workspace_id],|r|r.get(0)).map_err(|e|e.to_string())?;
            let backup = serde_json::json!({"operation":"restore","workspace":workspace,"priorReference":prior_reference,"pendingRuntime":true,"reservationToken":token,"materializationStarted":false});
            store.connection.execute("INSERT INTO snapshot_artifact_refs(snapshot_id,kind,owner,payload) VALUES(?1,'inFlight',?2,?3)",params![id,workspace_id,serde_json::to_string(&backup).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
        }
        Ok(token)
    }

    pub fn restore_sandbox_snapshot_workspace(
        &self,
        deployment: &str,
        id: &str,
        workspace_id: &str,
    ) -> Result<ForkedCheckpointWorkspace, String> {
        let token = self.reserve_sandbox_snapshot_restore_target(deployment, id, workspace_id)?;
        self.restore_reserved_sandbox_snapshot_workspace(deployment, id, workspace_id, &token)
    }

    pub fn cancel_sandbox_snapshot_restore_target(
        &self,
        deployment: &str,
        id: &str,
        workspace_id: &str,
        token: &str,
    ) -> Result<(), String> {
        let _operation = self.lock_snapshot_operation(deployment, id)?;
        let store = self.store.lock();
        require_record(&store.connection, deployment, id)?;
        let removed=store.connection.execute("DELETE FROM snapshot_artifact_refs WHERE snapshot_id=?1 AND kind='inFlight' AND owner=?2 AND json_extract(payload,'$.reservationToken')=?3 AND json_extract(payload,'$.materializationStarted')=0",params![id,workspace_id,token]).map_err(|e|e.to_string())?;
        if removed != 1 {
            let pending:bool=store.connection.query_row("SELECT EXISTS(SELECT 1 FROM snapshot_artifact_refs WHERE snapshot_id=?1 AND owner=?2 AND (kind='inFlight' OR json_extract(payload,'$.pendingRuntime')=1))",params![id,workspace_id],|r|r.get(0)).map_err(|e|e.to_string())?;
            if pending {
                return Err(
                    "snapshot restore reservation mismatch or already materializing".into(),
                );
            }
        }
        Ok(())
    }

    pub fn restore_reserved_sandbox_snapshot_workspace(
        &self,
        deployment: &str,
        id: &str,
        workspace_id: &str,
        token: &str,
    ) -> Result<ForkedCheckpointWorkspace, String> {
        let _operation = self.lock_snapshot_operation(deployment, id)?;
        let expected = self
            .store
            .lock()
            .get_workspace(workspace_id)?
            .ok_or("workspace_not_found")?;
        let root_exists = Path::new(&expected.execution_root).exists();
        let (snapshot, checkpoint, mut workspace) = {
            let store = self.store.lock();
            let tx = rusqlite::Transaction::new_unchecked(
                &store.connection,
                rusqlite::TransactionBehavior::Immediate,
            )
            .map_err(|e| e.to_string())?;
            let snapshot = require_record(&store.connection, deployment, id)?;
            if snapshot.phase != SnapshotOperationPhase::Ready {
                return Err("snapshot_not_ready".into());
            }
            let workspace = store
                .get_workspace(workspace_id)?
                .ok_or("workspace_not_found")?;
            if !matches!(
                workspace.state,
                crate::WorkspaceState::Archived | crate::WorkspaceState::Restorable
            ) || workspace != expected
                || root_exists
            {
                return Err("snapshot restore target changed after reservation".into());
            }
            let updated=store.connection.execute("UPDATE snapshot_artifact_refs SET payload=json_set(payload,'$.materializationStarted',json('true')) WHERE snapshot_id=?1 AND kind='inFlight' AND owner=?2 AND json_extract(payload,'$.reservationToken')=?3 AND json_extract(payload,'$.materializationStarted')=0",params![id,workspace_id,token]).map_err(|e|e.to_string())?;
            if updated != 1 {
                return Err("snapshot restore reservation mismatch".into());
            }
            let checkpoint = read_checkpoint(&store.connection, deployment, id)?;
            tx.commit().map_err(|e| e.to_string())?;
            (snapshot, checkpoint, workspace)
        };
        let original_workspace = workspace.clone();
        let root = PathBuf::from(&workspace.execution_root);
        let result: Result<ForkedCheckpointWorkspace, String> = (|| {
            self.materialize_cold_checkpoint(deployment, id, &root, &checkpoint)?;
            let now = now_ms();
            let task = TaskWorkspace {
                task_id: format!("snapshot-restore-{}", uuid::Uuid::new_v4()),
                session_id: workspace
                    .owner_ref
                    .clone()
                    .unwrap_or_else(|| format!("snapshot-restore-{}", uuid::Uuid::new_v4())),
                workspace_root: workspace.execution_root.clone(),
                state: TaskWorkspaceState::Ready,
                revision: 0,
                created_at: now,
                expires_at: snapshot.expires_at,
                pinned: false,
            };
            workspace.state = crate::WorkspaceState::Active;
            workspace.last_used_at = now;
            workspace.head = Some(checkpoint.commit.clone());
            workspace.branch = None;
            workspace.snapshot_task_id = Some(task.task_id.clone());
            workspace.isolation_kind = crate::IsolationKind::Shadow;
            workspace.source_root = workspace.execution_root.clone();
            workspace.git_common_dir = Some(root.join(".git").to_string_lossy().into());
            let canonical_root = crate::ports::registry_root(&root).map_err(|e| e.to_string())?;
            let lease = {
                let store = self.store.lock();
                let tx = rusqlite::Transaction::new_unchecked(
                    &store.connection,
                    rusqlite::TransactionBehavior::Immediate,
                )
                .map_err(|e| e.to_string())?;
                if require_record(&tx, deployment, id)?.phase != SnapshotOperationPhase::Ready
                    || store.get_workspace(workspace_id)?.as_ref() != Some(&original_workspace)
                {
                    return Err("snapshot restore target changed during materialization".into());
                }
                let reserved: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM snapshot_artifact_refs WHERE snapshot_id=?1 AND owner=?2 AND kind='inFlight' AND json_extract(payload,'$.reservationToken')=?3 AND json_extract(payload,'$.materializationStarted')=1)", params![id,workspace_id,token], |row| row.get(0)).map_err(|e| e.to_string())?;
                if !reserved {
                    return Err("snapshot restore reservation changed".into());
                }
                store.put_task(&task)?;
                store.put_workspace(&workspace)?;
                let lease = crate::ports::ensure_in_transaction(
                    &tx,
                    crate::HOST_LOOPBACK_NAMESPACE,
                    crate::ports::LeaseSubject {
                        kind: crate::PortSubjectKind::Registry,
                        key: workspace_id,
                        root: &canonical_root,
                        registry_id: Some(workspace_id),
                    },
                    store.get_workspace_lifecycle_policy()?.unwrap_or_default(),
                    now,
                )
                .map_err(|e| e.to_string())?;
                tx.execute("DELETE FROM snapshot_artifact_refs WHERE snapshot_id=?1 AND owner=?2 AND kind='fork'",params![id,workspace_id]).map_err(|e|e.to_string())?;
                tx.execute("UPDATE snapshot_artifact_refs SET kind='fork' WHERE snapshot_id=?1 AND owner=?2 AND kind='inFlight'",params![id,workspace_id]).map_err(|e|e.to_string())?;
                tx.commit().map_err(|e| e.to_string())?;
                lease
            };
            Ok(ForkedCheckpointWorkspace {
                task,
                workspace_id: workspace_id.into(),
                execution_root: workspace.execution_root.clone(),
                port_lease: lease,
            })
        })();
        if let Err(error) = &result {
            if let Err(cleanup) =
                self.compensate_archived_checkpoint_restore(deployment, id, workspace_id)
            {
                return Err(format!("{error}; restore compensation failed: {cleanup}"));
            }
        }
        result
    }

    fn compensate_archived_checkpoint_restore(
        &self,
        deployment: &str,
        id: &str,
        workspace_id: &str,
    ) -> Result<(), String> {
        let store = self.store.lock();
        require_record(&store.connection, deployment, id)?;
        let record = store
            .get_workspace(workspace_id)?
            .ok_or("workspace_not_found")?;
        if !matches!(
            record.state,
            crate::WorkspaceState::Archived | crate::WorkspaceState::Restorable
        ) {
            return Err("restore compensation requires an archived workspace".into());
        }
        let owns:bool=store.connection.query_row("SELECT EXISTS(SELECT 1 FROM snapshot_artifact_refs WHERE snapshot_id=?1 AND kind='inFlight' AND owner=?2)",params![id,workspace_id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !owns {
            return Err("restore compensation ownership mismatch".into());
        }
        let payload:Option<String>=store.connection.query_row("SELECT payload FROM snapshot_artifact_refs WHERE snapshot_id=?1 AND kind='inFlight' AND owner=?2",params![id,workspace_id],|r|r.get(0)).map_err(|e|e.to_string())?;
        let started = payload
            .as_ref()
            .map(|payload| {
                serde_json::from_str::<serde_json::Value>(payload)
                    .map(|value| value["materializationStarted"].as_bool().unwrap_or(true))
                    .map_err(|e| e.to_string())
            })
            .transpose()?
            .unwrap_or(true);
        drop(store);
        if started {
            remove_execution_tree(Path::new(&record.execution_root))?;
        }
        let store = self.store.lock();
        let tx = rusqlite::Transaction::new_unchecked(
            &store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(|e| e.to_string())?;
        if store.get_workspace(workspace_id)?.as_ref() != Some(&record) {
            return Err("snapshot restore target changed during compensation".into());
        }
        let current: Option<String> = tx.query_row("SELECT payload FROM snapshot_artifact_refs WHERE snapshot_id=?1 AND kind='inFlight' AND owner=?2", params![id,workspace_id], |row| row.get(0)).map_err(|e| e.to_string())?;
        if current != payload {
            return Err("snapshot restore reservation changed during compensation".into());
        }
        store.connection.execute("DELETE FROM snapshot_artifact_refs WHERE snapshot_id=?1 AND kind='inFlight' AND owner=?2",params![id,workspace_id]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// Roll back a completed filesystem restore when creating its container
    /// fails. The original archive remains authoritative until completion.
    pub fn rollback_sandbox_snapshot_restore(
        &self,
        deployment: &str,
        id: &str,
        workspace_id: &str,
    ) -> Result<(), String> {
        let _operation = self.lock_snapshot_operation(deployment, id)?;
        let store = self.store.lock();
        require_record(&store.connection, deployment, id)?;
        let payload:Option<String>=store.connection.query_row("SELECT payload FROM snapshot_artifact_refs WHERE snapshot_id=?1 AND kind='fork' AND owner=?2",params![id,workspace_id],|r|r.get(0)).map_err(|e|e.to_string())?;
        let backup: serde_json::Value = serde_json::from_str(
            payload
                .as_deref()
                .ok_or("snapshot restore has no rollback journal")?,
        )
        .map_err(|e| e.to_string())?;
        let original: crate::WorkspaceRecord =
            serde_json::from_value(backup["workspace"].clone()).map_err(|e| e.to_string())?;
        let current = store
            .get_workspace(workspace_id)?
            .ok_or("workspace_not_found")?;
        if original.workspace_id != workspace_id
            || current.execution_root != original.execution_root
        {
            return Err("snapshot restore rollback identity mismatch".into());
        }
        if !matches!(
            original.state,
            crate::WorkspaceState::Archived | crate::WorkspaceState::Restorable
        ) {
            return Err("snapshot restore rollback base is not archived".into());
        }
        if let Some(task_id) = current.snapshot_task_id.as_deref() {
            if store.list_runs(task_id)?.iter().any(|run| {
                matches!(
                    run.state,
                    crate::RunState::Running | crate::RunState::Settling
                )
            }) {
                return Err("snapshot_busy: restored workspace has an active task".into());
            }
        }
        drop(store);
        remove_execution_tree(Path::new(&current.execution_root))?;
        let store = self.store.lock();
        let tx = rusqlite::Transaction::new_unchecked(
            &store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(|e| e.to_string())?;
        if store.get_workspace(workspace_id)?.as_ref() != Some(&current) {
            return Err("snapshot restore target changed during rollback".into());
        }
        let current_payload: Option<String> = tx.query_row("SELECT payload FROM snapshot_artifact_refs WHERE snapshot_id=?1 AND kind='fork' AND owner=?2", params![id,workspace_id], |row| row.get(0)).map_err(|e| e.to_string())?;
        if current_payload != payload {
            return Err("snapshot restore rollback journal changed".into());
        }
        if original.port_lease.is_none() {
            crate::ports::release_subject_in_transaction(
                &tx,
                None,
                crate::PortSubjectKind::Registry,
                workspace_id,
            )
            .map_err(|e| e.to_string())?;
        }
        store.put_workspace(&original)?;
        if current.snapshot_task_id != original.snapshot_task_id {
            if let Some(task_id) = current.snapshot_task_id {
                store.delete_task(&task_id)?;
            }
        }
        if backup["priorReference"].as_bool().unwrap_or(false) {
            tx.execute("UPDATE snapshot_artifact_refs SET payload=NULL WHERE snapshot_id=?1 AND kind='fork' AND owner=?2",params![id,workspace_id]).map_err(|e|e.to_string())?;
        } else {
            tx.execute("DELETE FROM snapshot_artifact_refs WHERE snapshot_id=?1 AND kind='fork' AND owner=?2",params![id,workspace_id]).map_err(|e|e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn complete_sandbox_snapshot_restore(
        &self,
        deployment: &str,
        id: &str,
        workspace_id: &str,
    ) -> Result<(), String> {
        let _operation = self.lock_snapshot_operation(deployment, id)?;
        let store = self.store.lock();
        require_record(&store.connection, deployment, id)?;
        let tx = rusqlite::Transaction::new_unchecked(
            &store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(|e| e.to_string())?;
        let updated=tx.execute("UPDATE snapshot_artifact_refs SET payload=NULL WHERE snapshot_id=?1 AND kind='fork' AND owner=?2",params![id,workspace_id]).map_err(|e|e.to_string())?;
        if updated != 1 {
            return Err("snapshot restore reference is missing".into());
        }
        // The target now runs this image. Any older snapshot reference owned
        // by the same registry workspace is superseded only at this boundary.
        tx.execute(
            "DELETE FROM snapshot_artifact_refs WHERE snapshot_id<>?1 AND kind='fork' AND owner=?2",
            params![id, workspace_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn complete_sandbox_snapshot_fork(
        &self,
        deployment: &str,
        id: &str,
        workspace_id: &str,
    ) -> Result<(), String> {
        let _operation = self.lock_snapshot_operation(deployment, id)?;
        let store = self.store.lock();
        require_record(&store.connection, deployment, id)?;
        let updated=store.connection.execute("UPDATE snapshot_artifact_refs SET payload=NULL WHERE snapshot_id=?1 AND kind='fork' AND owner=?2 AND json_extract(payload,'$.workspace') IS NULL",params![id,workspace_id]).map_err(|e|e.to_string())?;
        if updated != 1 {
            return Err("pending snapshot fork reference is missing".into());
        }
        Ok(())
    }

    pub fn pending_sandbox_snapshot_workspaces(
        &self,
        deployment: &str,
    ) -> Result<Vec<PendingSandboxSnapshotWorkspace>, String> {
        let store = self.store.lock();
        let mut statement=store.connection.prepare("SELECT r.snapshot_id,r.owner,w.execution_root,json_extract(r.payload,'$.workspace') IS NOT NULL FROM snapshot_artifact_refs r JOIN sandbox_snapshots s ON s.snapshot_id=r.snapshot_id JOIN workspace_registry w ON w.workspace_id=r.owner WHERE s.deployment_id=?1 AND r.kind='fork' AND json_extract(r.payload,'$.pendingRuntime')=1").map_err(|e|e.to_string())?;
        let rows = statement
            .query_map([deployment], |r| {
                Ok(PendingSandboxSnapshotWorkspace {
                    snapshot_id: r.get(0)?,
                    workspace_id: r.get(1)?,
                    execution_root: r.get(2)?,
                    restoring: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .map(|r| r.map_err(|e| e.to_string()))
            .collect();
        rows
    }

    /// Recover interrupted filesystem forks/restores before the host reaps
    /// images. Completed forks retain their reference until workspace deletion.
    pub fn recover_sandbox_snapshot_workspace_operations(
        &self,
        deployment: &str,
    ) -> Result<Vec<String>, String> {
        let mut recovered = Vec::new();
        for record in self.list_sandbox_snapshots(deployment)? {
            let _operation = self.lock_snapshot_operation(deployment, &record.snapshot_id)?;
            for (kind, owner) in
                self.list_sandbox_snapshot_references(deployment, &record.snapshot_id)?
            {
                if kind != "inFlight" {
                    continue;
                }
                let (registered, restore) = {
                    let store = self.store.lock();
                    let payload: Option<String> = store
                        .connection
                        .query_row(
                            "SELECT payload FROM snapshot_artifact_refs WHERE snapshot_id=?1 AND kind='inFlight' AND owner=?2",
                            params![record.snapshot_id, owner],
                            |row| row.get(0),
                        )
                        .map_err(|e| e.to_string())?;
                    (
                        store.get_workspace(&owner)?.is_some(),
                        payload.as_deref().is_some_and(is_restore_reservation),
                    )
                };
                // The journal, not the owner's name, says what was in flight: an
                // archived fork (`snapshot-fork-*`) can itself be restored in place,
                // and undoing that restore must never discard the fork.
                if !restore {
                    self.discard_sandbox_snapshot_fork_inner(
                        deployment,
                        &record.snapshot_id,
                        &owner,
                    )?;
                    recovered.push(owner);
                } else if registered {
                    self.compensate_archived_checkpoint_restore(
                        deployment,
                        &record.snapshot_id,
                        &owner,
                    )?;
                    recovered.push(owner);
                }
            }
        }
        Ok(recovered)
    }

    fn materialize_cold_checkpoint(
        &self,
        deployment: &str,
        id: &str,
        root: &Path,
        checkpoint: &WorkspaceCheckpoint,
    ) -> Result<(), String> {
        fs::create_dir(root).map_err(|e| format!("create checkpoint execution root: {e}"))?;
        let directory = self.checkpoint_path(deployment, id);
        let mut blobs = HashMap::new();
        for entry in checkpoint.manifest.files.entries.values() {
            if !blobs.contains_key(&entry.hash) {
                let bytes = fs::read(directory.join("blobs").join(&entry.hash))
                    .map_err(|e| e.to_string())?;
                if hex::encode(Sha256::digest(&bytes)) != entry.hash {
                    return Err("checkpoint blob digest mismatch".into());
                }
                blobs.insert(entry.hash.clone(), bytes);
            }
        }
        git2::Repository::init(root).map_err(|e| e.to_string())?;
        let pinned = git(
            &directory.join("git"),
            &["rev-parse", "--verify", &checkpoint.pin_ref],
        )?;
        if pinned != checkpoint.commit {
            return Err("checkpoint Git pin does not match recorded commit".into());
        }
        git(
            root,
            &[
                "-c",
                "protocol.file.allow=always",
                "fetch",
                "--no-tags",
                directory
                    .join("git")
                    .to_str()
                    .ok_or("non-UTF8 checkpoint path")?,
                &checkpoint.pin_ref,
            ],
        )?;
        git(root, &["update-ref", "HEAD", &checkpoint.commit])?;
        // Populate only the index. The complete overlay is authoritative for
        // deleted tracked files too, and no absent file gets resurrected.
        git(root, &["read-tree", &checkpoint.commit])?;
        materialize_checkpoint(root, &checkpoint.manifest, &blobs)
    }
}

fn deployment_bytes(connection: &Connection, deployment: &str) -> Result<u64, String> {
    connection.query_row("SELECT COALESCE((SELECT SUM(total_bytes) FROM workspace_checkpoints WHERE deployment_id=?1),0)+COALESCE((SELECT SUM(json_extract(payload,'$.imageBytes')) FROM sandbox_snapshots WHERE deployment_id=?1),0)",[deployment],|r|r.get(0)).map_err(|e|e.to_string())
}
fn has_references(connection: &Connection, id: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM snapshot_artifact_refs WHERE snapshot_id=?1)",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())
}
fn read_checkpoint(
    connection: &Connection,
    deployment: &str,
    id: &str,
) -> Result<WorkspaceCheckpoint, String> {
    let payload: String = connection
        .query_row(
            "SELECT payload FROM workspace_checkpoints WHERE deployment_id=?1 AND snapshot_id=?2",
            params![deployment, id],
            |r| r.get(0),
        )
        .map_err(|e| format!("read checkpoint: {e}"))?;
    serde_json::from_str(&payload).map_err(|e| e.to_string())
}
fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "checkpoint git {}: {}",
            args.first().unwrap_or(&""),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().into())
}
fn pin_independent_commit(source: &Path, target: &Path, pin: &str) -> Result<String, String> {
    let repository = git2::Repository::init_bare(target).map_err(|e| e.to_string())?;
    let commit = match git(source, &["rev-parse", "--verify", "HEAD^{commit}"]) {
        Ok(commit) => {
            git(
                target,
                &[
                    "-c",
                    "protocol.file.allow=always",
                    "fetch",
                    "--no-tags",
                    source.to_str().ok_or("non-UTF8 source root")?,
                    &commit,
                ],
            )?;
            commit
        }
        Err(error) => {
            // A repository with unreadable HEAD must not silently turn into
            // an empty history. Non-Git scratch directories get an empty base.
            if source.join(".git").exists() {
                return Err(error);
            }
            let tree = repository
                .treebuilder(None)
                .and_then(|t| t.write())
                .map_err(|e| e.to_string())?;
            let tree = repository.find_tree(tree).map_err(|e| e.to_string())?;
            let signature = git2::Signature::now("Cognia checkpoint", "checkpoint@localhost")
                .map_err(|e| e.to_string())?;
            repository
                .commit(
                    None,
                    &signature,
                    &signature,
                    "Cold workspace checkpoint base",
                    &tree,
                    &[],
                )
                .map_err(|e| e.to_string())?
                .to_string()
        }
    };
    repository
        .reference(
            pin,
            git2::Oid::from_str(&commit).map_err(|e| e.to_string())?,
            false,
            "retain cold checkpoint",
        )
        .map_err(|e| format!("pin checkpoint commit: {e}"))?;
    Ok(commit)
}
fn directory_size(path: &Path) -> Result<u64, String> {
    let mut bytes = 0u64;
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        bytes = bytes
            .checked_add(if metadata.is_dir() {
                directory_size(&entry.path())?
            } else {
                metadata.len()
            })
            .ok_or("snapshot_budget_exceeded")?;
    }
    Ok(bytes)
}
fn remove_execution_tree(path: &Path) -> Result<(), String> {
    match path.symlink_metadata() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
        Ok(metadata) if !metadata.is_dir() => {
            return Err("snapshot execution root is no longer a directory".into())
        }
        _ => {}
    }
    #[cfg(unix)]
    fn make_writable(path: &Path) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;
        let metadata = path.symlink_metadata().map_err(|e| e.to_string())?;
        if metadata.is_dir() {
            fs::set_permissions(
                path,
                fs::Permissions::from_mode(metadata.permissions().mode() | 0o700),
            )
            .map_err(|e| e.to_string())?;
            for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
                make_writable(&entry.map_err(|e| e.to_string())?.path())?;
            }
        }
        Ok(())
    }
    #[cfg(unix)]
    make_writable(path)?;
    fs::remove_dir_all(path).map_err(|e| e.to_string())
}
fn sync_tree(path: &Path) -> Result<(), String> {
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            sync_tree(&entry.path())?;
        } else {
            fs::File::open(entry.path())
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
        }
    }
    fs::File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, TempDir, TaskWorkspaceService, BeginSandboxSnapshot) {
        let data = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("source.txt"), "content").unwrap();
        let service =
            TaskWorkspaceService::open(crate::ServiceConfig::new(data.path().into())).unwrap();
        let request = BeginSandboxSnapshot {
            snapshot_id: uuid::Uuid::new_v4().to_string(),
            deployment_id: "deployment-a".into(),
            project_id: "project".into(),
            task_id: "task".into(),
            workspace_root: root.path().to_string_lossy().into(),
            runtime: serde_json::json!({"containerId":"source-container"}),
            exclusions: vec![],
        };
        (data, root, service, request)
    }
    fn ready(
        service: &TaskWorkspaceService,
        request: &BeginSandboxSnapshot,
    ) -> WorkspaceCheckpoint {
        service.begin_sandbox_snapshot(request).unwrap();
        let checkpoint = service
            .capture_sandbox_snapshot_checkpoint(&request.deployment_id, &request.snapshot_id)
            .unwrap();
        service
            .record_sandbox_snapshot_image(
                &request.deployment_id,
                &request.snapshot_id,
                &format!("sha256:{}", "a".repeat(64)),
                64,
            )
            .unwrap();
        service
            .complete_sandbox_snapshot(&request.deployment_id, &request.snapshot_id)
            .unwrap();
        checkpoint
    }

    fn replayable_acquisition(service: &TaskWorkspaceService, root: &Path) -> crate::BeginTaskRun {
        let root = root.canonicalize().unwrap().to_string_lossy().into_owned();
        let input: crate::BeginTaskRun = serde_json::from_value(serde_json::json!({
            "taskId":"replay-task", "sessionId":"replay-session", "runId":"replay-run",
            "parentRunId":null, "agentId":"agent", "agentKind":"test", "workspaceRoot":root
        }))
        .unwrap();
        let task = TaskWorkspace {
            task_id: input.task_id.clone(),
            session_id: input.session_id.clone(),
            workspace_root: root.clone(),
            state: TaskWorkspaceState::Active,
            revision: 0,
            created_at: 0,
            expires_at: i64::MAX,
            pinned: false,
        };
        let run: crate::TaskRun = serde_json::from_value(serde_json::json!({
            "runId":input.run_id, "taskId":input.task_id, "parentRunId":null,
            "agentId":input.agent_id, "agentKind":input.agent_kind, "executionRoot":root,
            "isolationKind":"shadow", "isolationRef":null, "baselineRevision":0,
            "state":"running", "createdAt":0, "settledAt":null
        }))
        .unwrap();
        let store = service.store.lock();
        store.put_task(&task).unwrap();
        store
            .put_run(&run, &crate::snapshot::WorkspaceSnapshot::default())
            .unwrap();
        input
    }

    #[test]
    fn sandbox_snapshot_usage_includes_checkpoints_and_retained_tombstones_per_deployment() {
        let (_data, _root, service, request) = fixture();
        assert_eq!(
            service
                .sandbox_snapshot_usage_bytes(&request.deployment_id)
                .unwrap(),
            0
        );
        let checkpoint = ready(&service, &request);
        let expected = checkpoint.total_bytes + 64;
        assert!(checkpoint.total_bytes > 0);
        assert_eq!(
            service
                .sandbox_snapshot_usage_bytes(&request.deployment_id)
                .unwrap(),
            expected
        );
        assert_eq!(
            service
                .sandbox_snapshot_usage_bytes("other-deployment")
                .unwrap(),
            0
        );
        service
            .tombstone_sandbox_snapshot(&request.deployment_id, &request.snapshot_id)
            .unwrap();
        assert_eq!(
            service
                .sandbox_snapshot_usage_bytes(&request.deployment_id)
                .unwrap(),
            expected
        );
        service
            .release_sandbox_snapshot(&request.deployment_id, &request.snapshot_id)
            .unwrap();
        assert_eq!(
            service
                .sandbox_snapshot_usage_bytes(&request.deployment_id)
                .unwrap(),
            0
        );
    }

    #[test]
    fn sandbox_snapshot_capture_io_does_not_block_ledger_or_other_acquisitions() {
        let (_data, _root, service, request) = fixture();
        let unrelated = TempDir::new().unwrap();
        let acquire = replayable_acquisition(&service, unrelated.path());
        service.begin_sandbox_snapshot(&request).unwrap();
        let service = &service;
        let request = &request;
        std::thread::scope(|scope| {
            let (entered_tx, entered_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let capture = scope.spawn(move || {
                service.capture_sandbox_snapshot_checkpoint_with_hook(
                    &request.deployment_id,
                    &request.snapshot_id,
                    || {
                        entered_tx.send(()).unwrap();
                        release_rx
                            .recv_timeout(std::time::Duration::from_secs(10))
                            .unwrap();
                    },
                )
            });
            let entered = entered_rx.recv_timeout(std::time::Duration::from_secs(5));
            let (done_tx, done_rx) = std::sync::mpsc::channel();
            let observer = scope.spawn(move || {
                let record =
                    service.get_sandbox_snapshot(&request.deployment_id, &request.snapshot_id);
                let run = service.begin_run(acquire);
                done_tx.send((record, run)).unwrap();
            });
            let observed = done_rx.recv_timeout(std::time::Duration::from_secs(2));
            let _ = release_tx.send(());
            let captured = capture.join().unwrap();
            observer.join().unwrap();
            entered.unwrap();
            let (record, run) = observed
                .expect("capture I/O must not hold the ledger or unrelated acquisition fence");
            assert_eq!(
                record.unwrap().unwrap().phase,
                SnapshotOperationPhase::Preparing
            );
            assert_eq!(run.unwrap().run_id, "replay-run");
            captured.unwrap();
        });
    }

    #[test]
    fn sandbox_snapshot_same_root_acquisitions_share_fence_across_services() {
        let (data, root, service, _request) = fixture();
        let acquire = replayable_acquisition(&service, root.path());
        let other =
            TaskWorkspaceService::open(crate::ServiceConfig::new(data.path().into())).unwrap();
        let first = service
            .lock_cold_workspace_acquisition(root.path(), false)
            .unwrap();
        std::thread::scope(|scope| {
            let (done_tx, done_rx) = std::sync::mpsc::channel();
            let worker = scope.spawn(move || {
                done_tx.send(other.begin_run(acquire)).unwrap();
            });
            let acquired = done_rx.recv_timeout(std::time::Duration::from_secs(2));
            drop(first);
            worker.join().unwrap();
            assert_eq!(
                acquired
                    .expect("same-root normal acquisitions must overlap")
                    .unwrap()
                    .run_id,
                "replay-run"
            );
        });
    }

    #[test]
    fn sandbox_snapshot_active_acquisition_refuses_cold_reservation_without_waiting() {
        let (data, root, service, request) = fixture();
        let other =
            TaskWorkspaceService::open(crate::ServiceConfig::new(data.path().into())).unwrap();
        let acquisition = service
            .lock_cold_workspace_acquisition(root.path(), false)
            .unwrap();
        let service = &service;
        let request = &request;
        std::thread::scope(|scope| {
            let (done_tx, done_rx) = std::sync::mpsc::channel();
            let worker = scope.spawn(move || {
                done_tx
                    .send(other.begin_sandbox_snapshot(&request))
                    .unwrap();
            });
            let refused = done_rx.recv_timeout(std::time::Duration::from_secs(2));
            drop(acquisition);
            worker.join().unwrap();
            assert!(refused
                .expect("cold reservation must not wait for active acquisition")
                .unwrap_err()
                .starts_with("snapshot_busy"));
        });
        service.begin_sandbox_snapshot(&request).unwrap();
    }

    #[test]
    fn sandbox_snapshot_missing_root_and_materialized_root_share_lock_identity() {
        let (_data, root, service, _request) = fixture();
        let target = root.path().join("missing").join("workspace");
        let guard = service
            .lock_cold_workspace_acquisition(&target, false)
            .unwrap();
        fs::create_dir_all(&target).unwrap();
        assert!(service
            .lock_cold_workspace_acquisition(&target, true)
            .unwrap_err()
            .starts_with("snapshot_busy"));
        drop(guard);
        service
            .lock_cold_workspace_acquisition(&target, true)
            .unwrap();
    }

    #[test]
    fn sandbox_snapshot_concurrent_publication_rechecks_deployment_budget() {
        let (data, root, service, request) = fixture();
        let second_root = TempDir::new().unwrap();
        fs::write(root.path().join("large"), vec![1_u8; 128 * 1024]).unwrap();
        fs::write(second_root.path().join("large"), vec![2_u8; 128 * 1024]).unwrap();
        let other =
            TaskWorkspaceService::open(crate::ServiceConfig::new(data.path().into())).unwrap();
        service
            .set_workspace_lifecycle_policy(crate::WorkspaceLifecyclePolicy {
                sandbox_snapshot_budget_bytes: 220 * 1024,
                ..Default::default()
            })
            .unwrap();
        let second = BeginSandboxSnapshot {
            snapshot_id: uuid::Uuid::new_v4().to_string(),
            task_id: "second-task".into(),
            workspace_root: second_root.path().to_string_lossy().into(),
            ..request.clone()
        };
        service.begin_sandbox_snapshot(&request).unwrap();
        other.begin_sandbox_snapshot(&second).unwrap();
        let service = &service;
        let request = &request;
        let second = &second;
        std::thread::scope(|scope| {
            let (entered_tx, entered_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let first = scope.spawn(move || {
                service.capture_sandbox_snapshot_checkpoint_with_hook(
                    &request.deployment_id,
                    &request.snapshot_id,
                    || {
                        entered_tx.send(()).unwrap();
                        release_rx
                            .recv_timeout(std::time::Duration::from_secs(10))
                            .unwrap();
                    },
                )
            });
            let entered = entered_rx.recv_timeout(std::time::Duration::from_secs(5));
            let (done_tx, done_rx) = std::sync::mpsc::channel();
            let second_worker = scope.spawn(move || {
                done_tx
                    .send(other.capture_sandbox_snapshot_checkpoint(
                        &second.deployment_id,
                        &second.snapshot_id,
                    ))
                    .unwrap();
            });
            let published = done_rx.recv_timeout(std::time::Duration::from_secs(5));
            let _ = release_tx.send(());
            let rejected = first.join().unwrap();
            second_worker.join().unwrap();
            entered.unwrap();
            published
                .expect("another snapshot must publish while first capture is suspended")
                .unwrap();
            assert!(rejected.unwrap_err().contains("snapshot_budget_exceeded"));
        });
        assert!(!service
            .checkpoint_path(&request.deployment_id, &request.snapshot_id)
            .exists());
        assert!(service
            .get_workspace_checkpoint(&second.deployment_id, &second.snapshot_id)
            .is_ok());
    }

    #[test]
    fn sandbox_snapshot_pending_fork_root_blocks_acquisition_before_registry_exists() {
        let (_data, _source, service, request) = fixture();
        ready(&service, &request);
        let workspace_id = format!("snapshot-fork-{}", uuid::Uuid::new_v4());
        let root = service.execution_dir.join(&workspace_id);
        // Persist the reservation before materialization makes the root visible.
        // A lexical alias exercises the same identity before and after creation.
        let aliased_root = root.parent().unwrap().join(".").join(&workspace_id);
        let payload = serde_json::json!({"pendingRuntime":true,"executionRoot":aliased_root});
        {
            let store = service.store.lock();
            assert!(store.get_workspace(&workspace_id).unwrap().is_none());
            store.connection.execute(
                "INSERT INTO snapshot_artifact_refs(snapshot_id,kind,owner,payload) VALUES(?1,'inFlight',?2,?3)",
                params![request.snapshot_id,workspace_id,serde_json::to_string(&payload).unwrap()],
            ).unwrap();
            assert!(
                reject_snapshot_reservation(&store.connection, &root, "racing-task")
                    .unwrap_err()
                    .starts_with("snapshot_busy")
            );
        }
        fs::create_dir(&root).unwrap();
        fs::write(root.join("partial.txt"), "materialization in progress").unwrap();
        let input: crate::BeginTaskRun = serde_json::from_value(serde_json::json!({
            "taskId":"racing-task", "sessionId":"racing-session", "runId":"racing-run",
            "parentRunId":null, "agentId":"agent", "agentKind":"test", "workspaceRoot":root,
        }))
        .unwrap();
        assert!(service
            .begin_run(input)
            .unwrap_err()
            .starts_with("snapshot_busy"));
        assert!(service
            .store
            .lock()
            .get_workspace(&workspace_id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn sandbox_snapshot_journal_persists_each_phase_and_compensation_is_scoped() {
        for stop in 0..4 {
            let (data, _root, service, request) = fixture();
            service.begin_sandbox_snapshot(&request).unwrap();
            if stop >= 1 {
                service
                    .capture_sandbox_snapshot_checkpoint(
                        &request.deployment_id,
                        &request.snapshot_id,
                    )
                    .unwrap();
            }
            if stop >= 2 {
                service
                    .record_sandbox_snapshot_image(
                        &request.deployment_id,
                        &request.snapshot_id,
                        "sha256:abc",
                        64,
                    )
                    .unwrap();
            }
            if stop >= 3 {
                service
                    .complete_sandbox_snapshot(&request.deployment_id, &request.snapshot_id)
                    .unwrap();
            }
            drop(service);
            let reopened =
                TaskWorkspaceService::open(crate::ServiceConfig::new(data.path().into())).unwrap();
            let row = reopened
                .get_sandbox_snapshot(&request.deployment_id, &request.snapshot_id)
                .unwrap()
                .unwrap();
            assert_eq!(
                row.phase,
                [
                    SnapshotOperationPhase::Preparing,
                    SnapshotOperationPhase::WorkspaceCaptured,
                    SnapshotOperationPhase::ImageCommitted,
                    SnapshotOperationPhase::Ready
                ][stop]
            );
            assert_eq!(
                reopened
                    .pending_sandbox_snapshot_operations(&request.deployment_id)
                    .unwrap()
                    .len(),
                usize::from(stop < 3)
            );
            assert!(reopened
                .get_sandbox_snapshot("deployment-b", &request.snapshot_id)
                .unwrap()
                .is_none());
            assert!(reopened
                .tombstone_sandbox_snapshot("deployment-b", &request.snapshot_id)
                .is_err());
            reopened
                .tombstone_sandbox_snapshot(&request.deployment_id, &request.snapshot_id)
                .unwrap();
            reopened
                .release_sandbox_snapshot(&request.deployment_id, &request.snapshot_id)
                .unwrap();
            assert!(!reopened
                .checkpoint_path(&request.deployment_id, &request.snapshot_id)
                .exists());
            assert!(reopened
                .get_sandbox_snapshot(&request.deployment_id, &request.snapshot_id)
                .unwrap()
                .is_none());
        }
    }

    #[test]
    fn sandbox_snapshot_pin_and_reference_fence_tombstone_release() {
        let (_data, _root, service, request) = fixture();
        ready(&service, &request);
        let row = service
            .pin_sandbox_snapshot(&request.deployment_id, &request.snapshot_id, true)
            .unwrap();
        assert!(row.pinned);
        assert_eq!(row.expires_at - row.created_at, 30 * 24 * 60 * 60 * 1000);
        service
            .add_sandbox_snapshot_reference(
                &request.deployment_id,
                &request.snapshot_id,
                "runtime",
                "container",
            )
            .unwrap();
        service
            .tombstone_sandbox_snapshot(&request.deployment_id, &request.snapshot_id)
            .unwrap();
        assert!(service
            .add_sandbox_snapshot_reference(
                &request.deployment_id,
                &request.snapshot_id,
                "fork",
                "new"
            )
            .is_err());
        assert!(service
            .release_sandbox_snapshot(&request.deployment_id, &request.snapshot_id)
            .unwrap_err()
            .contains("snapshot_busy"));
        service
            .remove_sandbox_snapshot_reference(
                &request.deployment_id,
                &request.snapshot_id,
                "runtime",
                "container",
            )
            .unwrap();
        service
            .release_sandbox_snapshot(&request.deployment_id, &request.snapshot_id)
            .unwrap();
    }

    #[test]
    fn sandbox_snapshot_image_ownership_includes_foreign_deployments_and_resume_is_durable() {
        let (data, _root, service, mut request) = fixture();
        request.runtime = serde_json::json!({"wasRunning":true});
        ready(&service, &request);
        service
            .mark_sandbox_snapshot_source_resumed(&request.deployment_id, &request.snapshot_id)
            .unwrap();
        let mut other = request.clone();
        other.deployment_id = "foreign-deployment".into();
        other.snapshot_id = uuid::Uuid::new_v4().to_string();
        ready(&service, &other);
        assert!(service
            .sandbox_snapshot_image_has_other_owners(
                &request.deployment_id,
                &request.snapshot_id,
                &format!("sha256:{}", "a".repeat(64))
            )
            .unwrap());
        drop(service);
        let reopened =
            TaskWorkspaceService::open(crate::ServiceConfig::new(data.path().into())).unwrap();
        let row = reopened
            .get_sandbox_snapshot(&request.deployment_id, &request.snapshot_id)
            .unwrap()
            .unwrap();
        assert_eq!(row.runtime["wasRunning"], false);
        assert_eq!(row.runtime["sourceResumed"], true);
    }

    #[test]
    fn sandbox_snapshot_shared_image_tombstones_do_not_deadlock_reaping() {
        let (_data, _root, service, request) = fixture();
        ready(&service, &request);
        let mut second = request.clone();
        second.snapshot_id = uuid::Uuid::new_v4().to_string();
        ready(&service, &second);
        let image = format!("sha256:{}", "a".repeat(64));
        service
            .tombstone_sandbox_snapshot(&request.deployment_id, &request.snapshot_id)
            .unwrap();
        assert!(service
            .sandbox_snapshot_image_has_other_owners(
                &request.deployment_id,
                &request.snapshot_id,
                &image
            )
            .unwrap());
        service
            .add_sandbox_snapshot_reference(
                &request.deployment_id,
                &second.snapshot_id,
                "runtime",
                "retained",
            )
            .unwrap();
        service
            .tombstone_sandbox_snapshot(&request.deployment_id, &second.snapshot_id)
            .unwrap();
        assert!(service
            .sandbox_snapshot_image_has_other_owners(
                &request.deployment_id,
                &request.snapshot_id,
                &image
            )
            .unwrap());
        service
            .remove_sandbox_snapshot_reference(
                &request.deployment_id,
                &second.snapshot_id,
                "runtime",
                "retained",
            )
            .unwrap();
        assert!(!service
            .sandbox_snapshot_image_has_other_owners(
                &request.deployment_id,
                &request.snapshot_id,
                &image
            )
            .unwrap());
    }

    #[test]
    fn sandbox_snapshot_budget_fails_without_truncation_and_retains_committed_image_for_recovery() {
        let (_data, _root, service, request) = fixture();
        service
            .set_workspace_lifecycle_policy(crate::WorkspaceLifecyclePolicy {
                sandbox_snapshot_budget_bytes: 1,
                ..Default::default()
            })
            .unwrap();
        service.begin_sandbox_snapshot(&request).unwrap();
        assert!(service
            .capture_sandbox_snapshot_checkpoint(&request.deployment_id, &request.snapshot_id)
            .unwrap_err()
            .contains("snapshot_budget_exceeded"));
        assert!(!service
            .checkpoint_path(&request.deployment_id, &request.snapshot_id)
            .exists());
        assert_eq!(
            service
                .get_sandbox_snapshot(&request.deployment_id, &request.snapshot_id)
                .unwrap()
                .unwrap()
                .phase,
            SnapshotOperationPhase::Preparing
        );
        service
            .set_workspace_lifecycle_policy(crate::WorkspaceLifecyclePolicy::default())
            .unwrap();
        service
            .capture_sandbox_snapshot_checkpoint(&request.deployment_id, &request.snapshot_id)
            .unwrap();
        assert!(service
            .record_sandbox_snapshot_image(
                &request.deployment_id,
                &request.snapshot_id,
                "sha256:overflow",
                1 << 30
            )
            .unwrap_err()
            .contains("snapshot_budget_exceeded"));
        let row = service
            .get_sandbox_snapshot(&request.deployment_id, &request.snapshot_id)
            .unwrap()
            .unwrap();
        assert_eq!(row.phase, SnapshotOperationPhase::ImageCommitted);
        assert_eq!(row.image_id.as_deref(), Some("sha256:overflow"));
        assert!(service
            .complete_sandbox_snapshot(&request.deployment_id, &request.snapshot_id)
            .is_err());
    }

    #[test]
    fn sandbox_snapshot_busy_refuses_active_turn_and_blocks_new_acquisition() {
        let (_data, root, service, request) = fixture();
        let task = TaskWorkspace {
            task_id: "another-task".into(),
            session_id: "session".into(),
            workspace_root: request.workspace_root.clone(),
            state: TaskWorkspaceState::Active,
            revision: 0,
            created_at: 0,
            expires_at: 0,
            pinned: false,
        };
        let run:crate::TaskRun=serde_json::from_value(serde_json::json!({"runId":"run","taskId":task.task_id,"parentRunId":null,"agentId":"agent","agentKind":"test","executionRoot":request.workspace_root,"isolationKind":"shadow","isolationRef":null,"baselineRevision":0,"state":"running","createdAt":0,"settledAt":null})).unwrap();
        {
            let store = service.store.lock();
            store.put_task(&task).unwrap();
            store
                .put_run(&run, &crate::snapshot::WorkspaceSnapshot::default())
                .unwrap();
        }
        assert!(service
            .begin_sandbox_snapshot(&request)
            .unwrap_err()
            .contains("snapshot_busy"));
        {
            let store = service.store.lock();
            let mut stopped = run;
            stopped.state = crate::RunState::Ready;
            store
                .put_run(&stopped, &crate::snapshot::WorkspaceSnapshot::default())
                .unwrap();
        }
        service.begin_sandbox_snapshot(&request).unwrap();
        assert!(reject_snapshot_reservation(
            &service.store.lock().connection,
            &root.path().canonicalize().unwrap(),
            "new-task"
        )
        .unwrap_err()
        .contains("snapshot_busy"));
    }

    #[test]
    fn sandbox_snapshot_reservation_protects_expired_source_task_from_pruning() {
        let (_data, _root, service, request) = fixture();
        let task = TaskWorkspace {
            task_id: request.task_id.clone(),
            session_id: "source-session".into(),
            workspace_root: request.workspace_root.clone(),
            state: TaskWorkspaceState::Ready,
            revision: 0,
            created_at: 0,
            expires_at: 0,
            pinned: false,
        };
        service.store.lock().put_task(&task).unwrap();
        service.begin_sandbox_snapshot(&request).unwrap();
        assert!(service.prune().unwrap().removed_task_ids.is_empty());
        assert!(service.get_task(&task.task_id).unwrap().is_some());
        service
            .tombstone_sandbox_snapshot(&request.deployment_id, &request.snapshot_id)
            .unwrap();
        service
            .release_sandbox_snapshot(&request.deployment_id, &request.snapshot_id)
            .unwrap();
        assert!(service
            .prune()
            .unwrap()
            .removed_task_ids
            .contains(&task.task_id));
    }

    #[test]
    fn sandbox_snapshot_independent_pin_survives_source_removal_and_restores_exact_overlay() {
        let (_data, root, service, mut request) = fixture();
        git(root.path(), &["init", "--quiet"]).unwrap();
        git(root.path(), &["add", "source.txt"]).unwrap();
        git(
            root.path(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@localhost",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "base",
            ],
        )
        .unwrap();
        fs::remove_file(root.path().join("source.txt")).unwrap();
        fs::create_dir(root.path().join("empty")).unwrap();
        fs::create_dir(root.path().join("node_modules")).unwrap();
        fs::write(root.path().join("node_modules/generated"), "ignored output").unwrap();
        fs::write(root.path().join("excluded"), "do not restore").unwrap();
        request.exclusions = vec!["excluded".into()];
        let checkpoint = ready(&service, &request);
        assert_eq!(checkpoint.manifest.exclusions, vec!["excluded"]);
        assert_eq!(checkpoint.manifest.reconstructed_metadata, vec![".git"]);
        let pinned = git(
            &service
                .checkpoint_path(&request.deployment_id, &request.snapshot_id)
                .join("git"),
            &["rev-parse", &checkpoint.pin_ref],
        )
        .unwrap();
        assert_eq!(pinned, checkpoint.commit);
        drop(root);
        let destination = service.execution_dir.join("roundtrip");
        service
            .materialize_cold_checkpoint(
                &request.deployment_id,
                &request.snapshot_id,
                &destination,
                &checkpoint,
            )
            .unwrap();
        assert!(!destination.join("source.txt").exists());
        assert!(!destination.join("excluded").exists());
        assert!(destination.join("empty").is_dir());
        assert_eq!(
            fs::read_to_string(destination.join("node_modules/generated")).unwrap(),
            "ignored output"
        );
        assert_eq!(
            git(&destination, &["rev-parse", "HEAD"]).unwrap(),
            checkpoint.commit
        );
        assert!(!destination.join(".git/objects/info/alternates").exists());
        assert!(git(&destination, &["remote"]).unwrap().is_empty());
    }

    #[test]
    fn sandbox_snapshot_recovery_removes_interrupted_fork_artifacts() {
        let (_data, _root, service, request) = fixture();
        ready(&service, &request);
        let owner = format!("snapshot-fork-{}", uuid::Uuid::new_v4());
        service
            .add_sandbox_snapshot_reference(
                &request.deployment_id,
                &request.snapshot_id,
                "inFlight",
                &owner,
            )
            .unwrap();
        fs::create_dir(service.execution_dir.join(&owner)).unwrap();
        fs::write(
            service.execution_dir.join(&owner).join("partial"),
            "partial",
        )
        .unwrap();
        assert_eq!(
            service
                .recover_sandbox_snapshot_workspace_operations(&request.deployment_id)
                .unwrap(),
            vec![owner.clone()]
        );
        assert!(!service.execution_dir.join(&owner).exists());
        assert!(!service
            .sandbox_snapshot_has_references(&request.deployment_id, &request.snapshot_id)
            .unwrap());
    }

    #[test]
    fn sandbox_snapshot_fork_port_exhaustion_compensates_task_root_and_reference() {
        let (_data, _root, service, request) = fixture();
        ready(&service, &request);
        service
            .set_workspace_lifecycle_policy(crate::WorkspaceLifecyclePolicy {
                port_range_start: 41000,
                port_range_end: 41000,
                port_block_size: 1,
                ..Default::default()
            })
            .unwrap();
        service.store.lock().connection.execute("INSERT INTO workspace_port_leases(lease_id,namespace_key,subject_kind,subject_key,canonical_root,base_port,port_count,created_at,updated_at) VALUES('occupied',?1,'desktop-session','existing','/existing',41000,1,0,0)",[crate::HOST_LOOPBACK_NAMESPACE]).unwrap();
        assert!(service
            .fork_sandbox_snapshot_workspace(
                &request.deployment_id,
                &request.snapshot_id,
                "failed-fork",
                "new-session"
            )
            .is_err());
        assert!(service.get_task("failed-fork").unwrap().is_none());
        assert!(service
            .list_sandbox_snapshot_references(&request.deployment_id, &request.snapshot_id)
            .unwrap()
            .is_empty());
        assert!(!fs::read_dir(&service.execution_dir)
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("snapshot-fork-")));
    }

    #[test]
    fn sandbox_snapshot_recovery_undoes_an_archived_fork_restore_instead_of_discarding_it() {
        let (_data, source, service, request) = fixture();
        ready(&service, &request);
        // An earlier fork, since archived, is restored in place; the Host
        // crashes after the restore reservation. Recovery must roll the
        // restore back, never treat the `snapshot-fork-*` owner as a new fork.
        let workspace_id = format!("snapshot-fork-{}", uuid::Uuid::new_v4());
        let root = service
            .execution_dir
            .canonicalize()
            .unwrap()
            .join(&workspace_id);
        let original = crate::WorkspaceRecord {
            workspace_id: workspace_id.clone(),
            port_lease: None,
            environment_kind: crate::WorkspaceEnvironmentKind::Managed,
            project_id: Some(request.project_id.clone()),
            owner_type: crate::WorkspaceOwnerType::Session,
            owner_ref: Some("old-session".into()),
            state: crate::WorkspaceState::Archived,
            source_root: source.path().to_string_lossy().into(),
            git_common_dir: None,
            base: crate::WorkspaceBaseSpec::default(),
            head: None,
            branch: None,
            isolation_kind: crate::IsolationKind::Shadow,
            execution_root: root.to_string_lossy().into(),
            snapshot_task_id: None,
            size_bytes: None,
            last_used_at: 1,
            locked_by: Some(crate::compose_lock_reason(&workspace_id)),
            pinned: false,
            created_at: 1,
        };
        {
            let store = service.store.lock();
            store.put_workspace(&original).unwrap();
            store.connection.execute("INSERT INTO workspace_port_leases(lease_id,namespace_key,subject_kind,subject_key,canonical_root,registry_workspace_id,base_port,port_count,created_at,updated_at) VALUES('retained-fork',?1,'registry',?2,?3,?2,41000,10,0,0)",params![crate::HOST_LOOPBACK_NAMESPACE,workspace_id,root.to_string_lossy()]).unwrap();
        }
        service
            .reserve_sandbox_snapshot_restore_target(
                &request.deployment_id,
                &request.snapshot_id,
                &workspace_id,
            )
            .unwrap();
        let recovered = service
            .recover_sandbox_snapshot_workspace_operations(&request.deployment_id)
            .unwrap();
        assert_eq!(recovered, vec![workspace_id.clone()]);
        let store = service.store.lock();
        let kept = store.get_workspace(&workspace_id).unwrap().expect("fork stays registered");
        assert_eq!(kept.state, crate::WorkspaceState::Archived);
        let leases: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM workspace_port_leases WHERE lease_id='retained-fork'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(leases, 1, "the archived fork keeps its port lease");
        let in_flight: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM snapshot_artifact_refs WHERE owner=?1 AND kind='inFlight'",
                params![workspace_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(in_flight, 0);
    }

    #[test]
    fn sandbox_snapshot_pending_restore_fences_turns_and_rolls_back_original_archive() {
        let (_data, source, service, request) = fixture();
        ready(&service, &request);
        let root = service
            .execution_dir
            .canonicalize()
            .unwrap()
            .join("archived-target");
        let original = crate::WorkspaceRecord {
            workspace_id: "archived-target".into(),
            port_lease: None,
            environment_kind: crate::WorkspaceEnvironmentKind::Managed,
            project_id: Some(request.project_id.clone()),
            owner_type: crate::WorkspaceOwnerType::Session,
            owner_ref: Some("old-session".into()),
            state: crate::WorkspaceState::Archived,
            source_root: source.path().to_string_lossy().into(),
            git_common_dir: None,
            base: crate::WorkspaceBaseSpec::default(),
            head: None,
            branch: None,
            isolation_kind: crate::IsolationKind::Shadow,
            execution_root: root.to_string_lossy().into(),
            snapshot_task_id: None,
            size_bytes: None,
            last_used_at: 1,
            locked_by: Some(crate::compose_lock_reason("archived-target")),
            pinned: false,
            created_at: 1,
        };
        {
            let store = service.store.lock();
            store.put_workspace(&original).unwrap();
            // An archived workspace already owns its lease; no socket probe is
            // needed when restoration retains the same physical-root block.
            store.connection.execute("INSERT INTO workspace_port_leases(lease_id,namespace_key,subject_kind,subject_key,canonical_root,registry_workspace_id,base_port,port_count,created_at,updated_at) VALUES('retained',?1,'registry','archived-target',?2,'archived-target',41000,10,0,0)",params![crate::HOST_LOOPBACK_NAMESPACE,root.to_string_lossy()]).unwrap();
        }
        let token = service
            .reserve_sandbox_snapshot_restore_target(
                &request.deployment_id,
                &request.snapshot_id,
                "archived-target",
            )
            .unwrap();
        assert!(service
            .restore_managed_workspace("archived-target")
            .unwrap_err()
            .contains("snapshot_busy"));
        assert!(service
            .delete_managed_workspace("archived-target")
            .unwrap_err()
            .contains("snapshot_busy"));
        assert!(service
            .cancel_sandbox_snapshot_restore_target(
                &request.deployment_id,
                &request.snapshot_id,
                "archived-target",
                "wrong-token"
            )
            .is_err());
        service
            .cancel_sandbox_snapshot_restore_target(
                &request.deployment_id,
                &request.snapshot_id,
                "archived-target",
                &token,
            )
            .unwrap();
        service
            .cancel_sandbox_snapshot_restore_target(
                &request.deployment_id,
                &request.snapshot_id,
                "archived-target",
                &token,
            )
            .unwrap();
        let restored = service
            .restore_sandbox_snapshot_workspace(
                &request.deployment_id,
                &request.snapshot_id,
                "archived-target",
            )
            .unwrap();
        assert_eq!(restored.port_lease.lease_id, "retained");
        let pending = service
            .pending_sandbox_snapshot_workspaces(&request.deployment_id)
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert!(pending[0].restoring);
        assert!(
            reject_snapshot_reservation(&service.store.lock().connection, &root, "new-turn")
                .unwrap_err()
                .contains("snapshot_busy")
        );
        service
            .rollback_sandbox_snapshot_restore(
                &request.deployment_id,
                &request.snapshot_id,
                "archived-target",
            )
            .unwrap();
        assert!(!root.exists());
        assert!(service.get_task(&restored.task.task_id).unwrap().is_none());
        let archived = service
            .get_managed_workspace("archived-target")
            .unwrap()
            .unwrap();
        assert_eq!(archived.state, crate::WorkspaceState::Archived);
        assert_eq!(archived.source_root, original.source_root);
        assert_eq!(archived.port_lease.unwrap().lease_id, "retained");
        assert!(service
            .pending_sandbox_snapshot_workspaces(&request.deployment_id)
            .unwrap()
            .is_empty());
        let restored = service
            .restore_sandbox_snapshot_workspace(
                &request.deployment_id,
                &request.snapshot_id,
                "archived-target",
            )
            .unwrap();
        service
            .complete_sandbox_snapshot_restore(
                &request.deployment_id,
                &request.snapshot_id,
                "archived-target",
            )
            .unwrap();
        assert!(service
            .pending_sandbox_snapshot_workspaces(&request.deployment_id)
            .unwrap()
            .is_empty());
        reject_snapshot_reservation(
            &service.store.lock().connection,
            Path::new(&restored.execution_root),
            "new-turn",
        )
        .unwrap();
    }

    #[test]
    fn sandbox_snapshot_fork_allocates_new_port_block() {
        let (_data, root, service, request) = fixture();
        ready(&service, &request);
        let source = service
            .ensure_subject_port_lease(
                crate::HOST_LOOPBACK_NAMESPACE,
                crate::PortSubjectKind::DesktopSession,
                "source-session",
                root.path(),
            )
            .unwrap();
        let fork = service
            .fork_sandbox_snapshot_workspace(
                &request.deployment_id,
                &request.snapshot_id,
                "fork-task",
                "new-session",
            )
            .unwrap();
        assert_ne!(source.lease_id, fork.port_lease.lease_id);
        assert_ne!(source.base_port, fork.port_lease.base_port);
        assert_ne!(fork.task.session_id, "source-session");
        assert_ne!(fork.execution_root, request.workspace_root);
        assert!(service
            .restore_sandbox_snapshot_workspace(
                &request.deployment_id,
                &request.snapshot_id,
                &fork.workspace_id
            )
            .unwrap_err()
            .contains("snapshot_restore_requires_fork"));
        service
            .discard_sandbox_snapshot_fork(
                &request.deployment_id,
                &request.snapshot_id,
                &fork.workspace_id,
            )
            .unwrap();
        assert!(!Path::new(&fork.execution_root).exists());
    }
}
