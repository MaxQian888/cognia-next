//! Cold filesystem snapshot orchestration shared by desktop and headless Hosts.
//! The workspace ledger is authoritative; Docker labels never grant ownership.
use std::sync::Arc;

use cognia_external_agent::sandbox_routing_backend::{SandboxPlacement, SandboxSpawnError};
use cognia_sandbox_pool::{boot::PoolServices, runtime::SandboxRuntimeControl};
use cognia_task_workspace::{
    BeginSandboxSnapshot, ForkedCheckpointWorkspace, SandboxSnapshotRecord, SnapshotOperationPhase,
    TaskWorkspaceService, WorkspaceState,
};
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, OnceCell};

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSandboxSnapshot {
    pub project_id: String,
    pub workspace_id: String,
    pub provider: String,
    pub container_id: String,
    #[serde(default)]
    pub exclusions: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForkSandboxSnapshot {
    pub snapshot_id: String,
    pub task_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreSandboxSnapshot {
    pub snapshot_id: String,
    pub task_id: String,
    pub session_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct ForkedSandboxSnapshot {
    pub workspace: ForkedCheckpointWorkspace,
    pub provider: String,
    pub container_id: String,
    pub restored_in_place: bool,
}

/// Preview implementations register this hook before serving grants. A failed
/// revocation retains the tombstone and artifacts for the next maintenance pass.
#[async_trait::async_trait]
pub trait SnapshotPreviewRevoker: Send + Sync {
    async fn revoke_snapshot(&self, deployment_id: &str, snapshot_id: &str) -> Result<(), String>;
}

pub struct SnapshotService {
    workspaces: Arc<TaskWorkspaceService>,
    runtime: Arc<dyn SandboxRuntimeControl>,
    deployment: String,
    operation: Mutex<()>,
    initialized: OnceCell<()>,
    previews: RwLock<Option<Arc<dyn SnapshotPreviewRevoker>>>,
}

static SERVICE: Lazy<RwLock<Option<Arc<SnapshotService>>>> = Lazy::new(|| RwLock::new(None));

pub fn installed() -> Result<Arc<SnapshotService>, String> {
    SERVICE
        .read()
        .clone()
        .ok_or_else(|| "sandbox_pool_disabled: snapshot runtime is not installed".into())
}

pub fn install(workspaces: Arc<TaskWorkspaceService>, pool: PoolServices) -> Result<(), String> {
    let Some(runtime) = pool.runtime else {
        return Ok(());
    };
    let handle = tokio::runtime::Handle::try_current()
        .map_err(|error| format!("snapshot runtime requires an async executor: {error}"))?;
    let service = Arc::new(SnapshotService {
        workspaces,
        runtime,
        deployment: pool.status.deployment_id().into(),
        operation: Mutex::new(()),
        initialized: OnceCell::new(),
        previews: RwLock::new(None),
    });
    *SERVICE.write() = Some(service.clone());
    handle.spawn(async move {
        loop {
            if let Err(error) = service.maintenance().await {
                log::warn!("sandbox snapshot maintenance failed: {error}");
            }
            tokio::time::sleep(std::time::Duration::from_secs(24 * 60 * 60)).await;
        }
    });
    Ok(())
}

fn runtime_error(error: SandboxSpawnError) -> String {
    format!("{}: {}", error.code, error.message)
}

fn stored_provider(snapshot: &SandboxSnapshotRecord) -> Result<&str, String> {
    snapshot
        .runtime
        .get("provider")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "snapshot_record_invalid: missing provider".into())
}

impl SnapshotService {
    pub fn set_preview_revoker(&self, revoker: Arc<dyn SnapshotPreviewRevoker>) {
        *self.previews.write() = Some(revoker);
    }

    /// Commands and startup share one initialization barrier: no snapshot is
    /// visible until interrupted writes have been compensated successfully.
    pub async fn initialize(&self) -> Result<(), String> {
        self.initialized
            .get_or_try_init(|| async {
                let _guard = self.operation.lock().await;
                self.recover().await
            })
            .await
            .map(|_| ())
    }

    pub fn get(&self, snapshot_id: &str) -> Result<SandboxSnapshotRecord, String> {
        self.workspaces
            .get_sandbox_snapshot(&self.deployment, snapshot_id)?
            .ok_or_else(|| "snapshot_not_found: snapshot is not owned by this deployment".into())
    }

    pub fn list(&self, project_id: &str) -> Result<Vec<SandboxSnapshotRecord>, String> {
        Ok(self
            .workspaces
            .list_sandbox_snapshots(&self.deployment)?
            .into_iter()
            .filter(|record| record.project_id == project_id)
            .collect())
    }

    pub async fn pin(
        &self,
        snapshot_id: &str,
        pinned: bool,
    ) -> Result<SandboxSnapshotRecord, String> {
        self.initialize().await?;
        let _guard = self.operation.lock().await;
        self.workspaces
            .pin_sandbox_snapshot(&self.deployment, snapshot_id, pinned)
    }

    pub async fn create(
        &self,
        request: CreateSandboxSnapshot,
    ) -> Result<SandboxSnapshotRecord, String> {
        self.initialize().await?;
        let _guard = self.operation.lock().await;
        if !self
            .runtime
            .snapshot_capabilities(&request.provider)
            .filesystem_checkpoint
        {
            return Err("snapshot_fork_unsupported: provider filesystem checkpoint API has not been verified".into());
        }
        let workspace = self
            .workspaces
            .get_managed_workspace(&request.workspace_id)?
            .ok_or_else(|| "snapshot_workspace_missing: workspace is not registered".to_string())?;
        if workspace.project_id.as_deref() != Some(&request.project_id) {
            return Err("snapshot_workspace_mismatch: workspace belongs to another project".into());
        }
        if workspace.state != WorkspaceState::Active {
            return Err("snapshot_busy: workspace must be idle and active".into());
        }
        let source = self
            .runtime
            .inspect_snapshot_source(
                &request.provider,
                &request.container_id,
                &request.project_id,
                &workspace.execution_root,
            )
            .await
            .map_err(runtime_error)?;
        let snapshot_id = uuid::Uuid::new_v4().to_string();
        let image_name = self
            .runtime
            .snapshot_image_name(&request.provider, &snapshot_id)
            .map_err(runtime_error)?;
        let input = BeginSandboxSnapshot {
            snapshot_id: snapshot_id.clone(),
            deployment_id: self.deployment.clone(),
            project_id: request.project_id,
            task_id: workspace.snapshot_task_id.unwrap_or(workspace.workspace_id),
            workspace_root: workspace.execution_root,
            runtime: serde_json::json!({"provider": request.provider, "containerId": request.container_id,
                "placement": source.placement, "imageName": image_name, "wasRunning": source.was_running, "bundleDigest": source.bundle_digest}),
            exclusions: request.exclusions,
        };
        self.workspaces.begin_sandbox_snapshot(&input)?;
        let lease = match self
            .runtime
            .quiesce_snapshot(
                &request.provider,
                &request.container_id,
                &input.project_id,
                &input.workspace_root,
            )
            .await
            .map_err(runtime_error)
        {
            Ok(lease) => lease,
            Err(error) => {
                self.compensate(&self.get(&snapshot_id)?)
                    .await
                    .map_err(|cleanup| format!("{error}; compensation failed: {cleanup}"))?;
                return Err(error);
            }
        };
        let captured = async {
            self.workspaces
                .capture_sandbox_snapshot_checkpoint(&self.deployment, &snapshot_id)?;
            let image = self
                .runtime
                .commit_snapshot_image(&lease, &snapshot_id)
                .await
                .map_err(runtime_error)?;
            self.workspaces.record_sandbox_snapshot_image(
                &self.deployment,
                &snapshot_id,
                &image.id,
                image.size_bytes,
            )?;
            Ok::<(), String>(())
        }
        .await;
        let resumed = self
            .runtime
            .resume_snapshot_runtime(lease)
            .await
            .map_err(runtime_error);
        let outcome = (|| {
            if resumed.is_ok() {
                self.workspaces
                    .mark_sandbox_snapshot_source_resumed(&self.deployment, &snapshot_id)?;
            }
            captured?;
            resumed?;
            self.workspaces
                .complete_sandbox_snapshot(&self.deployment, &snapshot_id)
        })();
        match outcome {
            Ok(record) => Ok(record),
            Err(error) => {
                self.compensate(&self.get(&snapshot_id)?)
                    .await
                    .map_err(|cleanup| format!("{error}; compensation failed: {cleanup}"))?;
                Err(error)
            }
        }
    }

    async fn compensate(&self, snapshot: &SandboxSnapshotRecord) -> Result<(), String> {
        self.workspaces
            .tombstone_sandbox_snapshot(&self.deployment, &snapshot.snapshot_id)?;
        if snapshot
            .runtime
            .get("wasRunning")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        {
            let container_id = snapshot
                .runtime
                .get("containerId")
                .and_then(serde_json::Value::as_str)
                .ok_or("snapshot_record_invalid: missing source runtime")?;
            self.runtime
                .recover_snapshot_source(stored_provider(snapshot)?, container_id, true)
                .await
                .map_err(runtime_error)?;
            self.workspaces
                .mark_sandbox_snapshot_source_resumed(&self.deployment, &snapshot.snapshot_id)?;
        }
        let revoker = self.previews.read().clone();
        if let Some(revoker) = revoker {
            revoker
                .revoke_snapshot(&self.deployment, &snapshot.snapshot_id)
                .await?;
        }
        for (kind, owner) in self
            .workspaces
            .list_sandbox_snapshot_references(&self.deployment, &snapshot.snapshot_id)?
        {
            let obsolete = match kind.as_str() {
                "runtime" => !self
                    .runtime
                    .snapshot_runtime_exists(stored_provider(snapshot)?, &owner)
                    .await
                    .map_err(runtime_error)?,
                "fork" => match self.workspaces.get_managed_workspace(&owner)? {
                    Some(workspace) if workspace.state == WorkspaceState::Removed => {
                        self.runtime
                            .release_snapshot_fork(
                                stored_provider(snapshot)?,
                                &workspace.execution_root,
                            )
                            .await
                            .map_err(runtime_error)?;
                        true
                    }
                    None => true,
                    _ => false,
                },
                _ => false,
            };
            if obsolete {
                self.workspaces.remove_sandbox_snapshot_reference(
                    &self.deployment,
                    &snapshot.snapshot_id,
                    &kind,
                    &owner,
                )?;
            }
        }
        if self
            .workspaces
            .sandbox_snapshot_has_references(&self.deployment, &snapshot.snapshot_id)?
        {
            return Ok(());
        }
        let provider = stored_provider(snapshot)?;
        let image = snapshot
            .image_id
            .as_deref()
            .or_else(|| {
                snapshot
                    .runtime
                    .get("imageName")
                    .and_then(serde_json::Value::as_str)
            })
            .ok_or_else(|| "snapshot_record_invalid: missing image identity".to_string())?;
        if let Some(image) = self
            .runtime
            .inspect_snapshot_image(provider, image)
            .await
            .map_err(runtime_error)?
        {
            if self.workspaces.sandbox_snapshot_image_has_other_owners(
                &self.deployment,
                &snapshot.snapshot_id,
                &image.id,
            )? {
                return Err("snapshot_busy: image is retained by another snapshot owner".into());
            }
            // No force: Docker refuses even stopped-container references.
            self.runtime
                .remove_snapshot_image(provider, &image.id)
                .await
                .map_err(runtime_error)?;
        }
        self.workspaces
            .release_sandbox_snapshot(&self.deployment, &snapshot.snapshot_id)
    }

    async fn recover(&self) -> Result<(), String> {
        for pending in self
            .workspaces
            .pending_sandbox_snapshot_workspaces(&self.deployment)?
        {
            let snapshot = self.get(&pending.snapshot_id)?;
            let provider = stored_provider(&snapshot)?;
            let container_id = self
                .runtime
                .snapshot_runtime_for_workspace(provider, &pending.execution_root)
                .await
                .map_err(runtime_error)?;
            self.runtime
                .discard_snapshot_fork(provider, &pending.execution_root)
                .await
                .map_err(runtime_error)?;
            if let Some(container_id) = container_id {
                self.workspaces.remove_sandbox_snapshot_reference(
                    &self.deployment,
                    &snapshot.snapshot_id,
                    "runtime",
                    &container_id,
                )?;
            }
            if pending.restoring {
                self.workspaces.rollback_sandbox_snapshot_restore(
                    &self.deployment,
                    &snapshot.snapshot_id,
                    &pending.workspace_id,
                )?;
                self.runtime
                    .rollback_snapshot_restore_target(provider, &pending.execution_root)
                    .await
                    .map_err(runtime_error)?;
            } else {
                self.workspaces.discard_sandbox_snapshot_fork(
                    &self.deployment,
                    &snapshot.snapshot_id,
                    &pending.workspace_id,
                )?;
            }
        }
        self.workspaces
            .recover_sandbox_snapshot_workspace_operations(&self.deployment)?;
        if self
            .runtime
            .snapshot_capabilities("local")
            .filesystem_checkpoint
        {
            let workspaces = self.workspaces.list_managed_workspaces()?;
            for root in self
                .runtime
                .pending_snapshot_restore_targets("local")
                .await
                .map_err(runtime_error)?
            {
                let workspace = workspaces.iter().find(|workspace| workspace.execution_root == root)
                    .ok_or("snapshot_restore_recovery_failed: pending runtime restore has no workspace owner")?;
                match workspace.state {
                    WorkspaceState::Archived | WorkspaceState::Restorable => self
                        .runtime
                        .rollback_snapshot_restore_target("local", &root)
                        .await
                        .map_err(runtime_error)?,
                    WorkspaceState::Active | WorkspaceState::Removed => self
                        .runtime
                        .complete_snapshot_restore_target("local", &root)
                        .await
                        .map_err(runtime_error)?,
                    _ => {
                        return Err(
                            "snapshot_busy: restore recovery requires a settled workspace".into(),
                        )
                    }
                }
            }
        }

        // Host operation UUIDs cannot still be executing under this process-wide
        // operation lock. Successful materialization already owns a durable fork
        // reference, including a crash before the container ID was journaled.
        for record in self.workspaces.list_sandbox_snapshots(&self.deployment)? {
            for (kind, owner) in self
                .workspaces
                .list_sandbox_snapshot_references(&self.deployment, &record.snapshot_id)?
            {
                if kind == "inFlight" && uuid::Uuid::parse_str(&owner).is_ok() {
                    self.workspaces.remove_sandbox_snapshot_reference(
                        &self.deployment,
                        &record.snapshot_id,
                        &kind,
                        &owner,
                    )?;
                }
            }
        }
        for record in self
            .workspaces
            .pending_sandbox_snapshot_operations(&self.deployment)?
        {
            self.compensate(&record).await?;
        }
        Ok(())
    }

    pub async fn delete(&self, snapshot_id: &str) -> Result<SandboxSnapshotRecord, String> {
        self.initialize().await?;
        let _guard = self.operation.lock().await;
        let tombstone = self
            .workspaces
            .tombstone_sandbox_snapshot(&self.deployment, snapshot_id)?;
        self.compensate(&tombstone).await?;
        Ok(tombstone)
    }

    pub async fn maintenance(&self) -> Result<(), String> {
        self.initialize().await?;
        let _guard = self.operation.lock().await;
        self.recover().await?;
        let now = chrono::Utc::now().timestamp_millis();
        for record in self.workspaces.list_sandbox_snapshots(&self.deployment)? {
            if record.phase == SnapshotOperationPhase::Tombstoned
                || (!record.pinned && record.expires_at <= now)
            {
                self.compensate(&record).await?;
            }
        }
        Ok(())
    }

    async fn compensate_fork(
        &self,
        snapshot: &SandboxSnapshotRecord,
        workspace: &ForkedCheckpointWorkspace,
        restored_in_place: bool,
        container_id: Option<&str>,
    ) -> Result<(), String> {
        // Removing the container precedes deleting a root it may still mount.
        // A newly attached session refuses this cleanup and preserves both refs.
        self.runtime
            .discard_snapshot_fork(stored_provider(snapshot)?, &workspace.execution_root)
            .await
            .map_err(runtime_error)?;
        if let Some(container_id) = container_id {
            self.workspaces.remove_sandbox_snapshot_reference(
                &self.deployment,
                &snapshot.snapshot_id,
                "runtime",
                container_id,
            )?;
        }
        if restored_in_place {
            self.workspaces.rollback_sandbox_snapshot_restore(
                &self.deployment,
                &snapshot.snapshot_id,
                &workspace.workspace_id,
            )?;
            self.runtime
                .rollback_snapshot_restore_target(
                    stored_provider(snapshot)?,
                    &workspace.execution_root,
                )
                .await
                .map_err(runtime_error)
        } else {
            self.workspaces.discard_sandbox_snapshot_fork(
                &self.deployment,
                &snapshot.snapshot_id,
                &workspace.workspace_id,
            )
        }
    }

    pub async fn fork(
        &self,
        request: ForkSandboxSnapshot,
    ) -> Result<ForkedSandboxSnapshot, String> {
        self.restore(RestoreSandboxSnapshot {
            snapshot_id: request.snapshot_id,
            task_id: request.task_id,
            session_id: request.session_id,
            workspace_id: None,
        })
        .await
    }

    pub async fn restore(
        &self,
        request: RestoreSandboxSnapshot,
    ) -> Result<ForkedSandboxSnapshot, String> {
        self.initialize().await?;
        let _guard = self.operation.lock().await;
        let snapshot = self.get(&request.snapshot_id)?;
        if snapshot.phase != SnapshotOperationPhase::Ready {
            return Err("snapshot_not_ready: snapshot must be ready to fork or restore".into());
        }
        let provider = stored_provider(&snapshot)?.to_string();
        if !self
            .runtime
            .snapshot_capabilities(&provider)
            .fork_from_checkpoint
        {
            return Err(
                "snapshot_fork_unsupported: provider fork API has not been verified".into(),
            );
        }
        let image_id = snapshot
            .image_id
            .as_deref()
            .ok_or("snapshot_record_invalid: missing image")?;
        let mut placement: SandboxPlacement = serde_json::from_value(
            snapshot
                .runtime
                .get("placement")
                .cloned()
                .ok_or("snapshot_record_invalid: missing placement")?,
        )
        .map_err(|error| error.to_string())?;
        let bundle_digest = snapshot
            .runtime
            .get("bundleDigest")
            .and_then(serde_json::Value::as_str)
            .ok_or("snapshot_record_invalid: missing injected bundle digest")?;
        self.runtime
            .verify_snapshot_bundle(&provider, &placement, bundle_digest)
            .await
            .map_err(runtime_error)?;
        // Saved specs describe desired execution. Sessions, mounts and hosted
        // service capabilities must be freshly established for the new runtime.
        let SandboxPlacement::Container {
            hosted_tool_host_lease_ids,
            workspace,
            ..
        } = &mut placement;
        hosted_tool_host_lease_ids.clear();
        *workspace = None;
        let target = match request.workspace_id.as_deref() {
            Some(id) => self.workspaces.get_managed_workspace(id)?,
            None => None,
        };
        if target
            .as_ref()
            .is_some_and(|target| target.project_id.as_deref() != Some(&snapshot.project_id))
        {
            return Err(
                "snapshot_workspace_mismatch: restore target belongs to another project".into(),
            );
        }
        let restored_in_place = target.as_ref().is_some_and(|target| {
            matches!(
                target.state,
                WorkspaceState::Archived | WorkspaceState::Restorable
            )
        });
        let owner = uuid::Uuid::new_v4().to_string();
        self.workspaces.add_sandbox_snapshot_reference(
            &self.deployment,
            &snapshot.snapshot_id,
            "inFlight",
            &owner,
        )?;
        let outcome = async {
            let workspace = if restored_in_place {
                let target = target.as_ref().expect("validated target");
                let reservation = self.workspaces.reserve_sandbox_snapshot_restore_target(
                    &self.deployment,
                    &snapshot.snapshot_id,
                    &target.workspace_id,
                )?;
                let prepared = async {
                    self.runtime
                        .retire_snapshot_restore_target(
                            &provider,
                            &snapshot.project_id,
                            &target.execution_root,
                        )
                        .await
                        .map_err(runtime_error)?;
                    self.workspaces.restore_reserved_sandbox_snapshot_workspace(
                        &self.deployment,
                        &snapshot.snapshot_id,
                        &target.workspace_id,
                        &reservation,
                    )
                }
                .await;
                match prepared {
                    Ok(workspace) => workspace,
                    Err(error) => {
                        self.runtime
                            .rollback_snapshot_restore_target(&provider, &target.execution_root)
                            .await
                            .map_err(runtime_error)
                            .map_err(|cleanup| {
                                format!("{error}; restore target rollback failed: {cleanup}")
                            })?;
                        self.workspaces
                            .cancel_sandbox_snapshot_restore_target(
                                &self.deployment,
                                &snapshot.snapshot_id,
                                &target.workspace_id,
                                &reservation,
                            )
                            .map_err(|cleanup| {
                                format!(
                                    "{error}; restore reservation cancellation failed: {cleanup}"
                                )
                            })?;
                        return Err(error);
                    }
                }
            } else {
                self.workspaces.fork_sandbox_snapshot_workspace(
                    &self.deployment,
                    &snapshot.snapshot_id,
                    &request.task_id,
                    &request.session_id,
                )?
            };
            let container_id = match self
                .runtime
                .fork_snapshot_runtime(
                    &provider,
                    image_id,
                    placement,
                    &workspace.execution_root,
                    bundle_digest,
                )
                .await
                .map_err(runtime_error)
            {
                Ok(id) => id,
                Err(error) => {
                    self.compensate_fork(&snapshot, &workspace, restored_in_place, None)
                        .await
                        .map_err(|cleanup| {
                            format!("{error}; fork compensation failed: {cleanup}")
                        })?;
                    return Err(error);
                }
            };
            let persisted = (|| {
                self.workspaces.add_sandbox_snapshot_reference(
                    &self.deployment,
                    &snapshot.snapshot_id,
                    "runtime",
                    &container_id,
                )?;
                if restored_in_place {
                    self.workspaces.complete_sandbox_snapshot_restore(
                        &self.deployment,
                        &snapshot.snapshot_id,
                        &workspace.workspace_id,
                    )?;
                } else {
                    self.workspaces.complete_sandbox_snapshot_fork(
                        &self.deployment,
                        &snapshot.snapshot_id,
                        &workspace.workspace_id,
                    )?;
                }
                Ok::<(), String>(())
            })();
            if let Err(error) = persisted {
                self.compensate_fork(
                    &snapshot,
                    &workspace,
                    restored_in_place,
                    Some(&container_id),
                )
                .await
                .map_err(|cleanup| format!("{error}; fork compensation failed: {cleanup}"))?;
                return Err(error);
            }
            if restored_in_place {
                // The ledger is committed first. Recovery sees Active without a
                // pendingRuntime marker and completes this driver journal too.
                self.runtime
                    .complete_snapshot_restore_target(&provider, &workspace.execution_root)
                    .await
                    .map_err(runtime_error)?;
            }
            Ok(ForkedSandboxSnapshot {
                workspace,
                provider,
                container_id,
                restored_in_place,
            })
        }
        .await;
        self.workspaces.remove_sandbox_snapshot_reference(
            &self.deployment,
            &snapshot.snapshot_id,
            "inFlight",
            &owner,
        )?;
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_requests_reject_caller_owned_paths_and_image_identity() {
        let mut value = serde_json::json!({"projectId":"p", "workspaceId":"w", "provider":"local", "containerId":"c"});
        let parsed: CreateSandboxSnapshot = serde_json::from_value(value.clone()).unwrap();
        assert!(parsed.exclusions.is_empty());
        for field in ["workspaceRoot", "imageId", "deploymentId", "placement"] {
            value[field] = serde_json::json!("forged");
            assert!(serde_json::from_value::<CreateSandboxSnapshot>(value.clone()).is_err());
            value.as_object_mut().unwrap().remove(field);
        }
    }
    #[test]
    fn restore_without_target_preserves_new_task_identity() {
        let parsed: RestoreSandboxSnapshot = serde_json::from_value(serde_json::json!({
            "snapshotId":"s", "taskId":"new-task", "sessionId":"new-session"
        }))
        .unwrap();
        assert!(parsed.workspace_id.is_none());
        assert_eq!(parsed.task_id, "new-task");
    }
}

#[cfg(test)]
#[path = "sandbox_snapshots_tests.rs"]
mod lifecycle_tests;
