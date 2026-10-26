//! Cold rootfs snapshots. Host ledger authorization precedes these operations;
//! daemon labels only supply compatibility metadata and never authorize access.
use super::*;
use crate::runtime::{
    snapshot_unsupported, SnapshotCapabilities, SnapshotImage, SnapshotRuntimeLease,
};
use cognia_external_agent::container_backend::PERSISTENT_RUNTIME_LABEL;
use std::path::{Path, PathBuf};

fn fault(error: impl Into<String>) -> SandboxSpawnError {
    SandboxSpawnError::fault("snapshot_runtime_failed", error.into())
}

/// Host-owned association, needed so later normal task/agent starts use the
/// fork image and skip initial creation hooks after a Host restart.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(super) struct RuntimeAuthority {
    project_id: String,
    spec_digest: String,
    key: String,
    mount: RunnerMount,
    bundle_digest: String,
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct RestoreBackup {
    #[serde(default)]
    containers: Vec<String>,
    image: Option<String>,
    bundle: Option<String>,
}
#[derive(Default, serde::Serialize, serde::Deserialize)]
pub(super) struct ForkIndex {
    #[serde(default)]
    pub(super) runtimes: BTreeMap<String, RuntimeAuthority>,
    #[serde(skip)]
    path: Option<PathBuf>,
    images: BTreeMap<String, String>,
    #[serde(default)]
    bundles: BTreeMap<String, String>,
    #[serde(default)]
    restore_backups: BTreeMap<String, RestoreBackup>,
}
impl ForkIndex {
    fn store(&mut self, root: &str, image: Option<&str>) -> Result<(), String> {
        let mut images = self.images.clone();
        if let Some(image) = image {
            images.insert(root.into(), image.into());
        } else {
            images.remove(root);
        }
        let mut bundles = self.bundles.clone();
        if image.is_none() {
            bundles.remove(root);
        }
        self.save(&images, &self.runtimes, &bundles)?;
        self.images = images;
        self.bundles = bundles;
        Ok(())
    }
    fn persist(&self) -> Result<(), String> {
        self.save(&self.images, &self.runtimes, &self.bundles)
    }
    fn begin_restore(&mut self, root: &str, containers: Vec<String>) -> Result<(), String> {
        if self.restore_backups.contains_key(root) {
            return Err("snapshot_restore_pending: previous restore requires recovery".into());
        }
        self.restore_backups.insert(
            root.into(),
            RestoreBackup {
                containers,
                image: self.images.get(root).cloned(),
                bundle: self.bundles.get(root).cloned(),
            },
        );
        if let Err(error) = self.persist() {
            self.restore_backups.remove(root);
            return Err(error);
        }
        Ok(())
    }
    fn finish_restore(&mut self, root: &str, rollback: bool) -> Result<(), String> {
        let Some(backup) = self.restore_backups.remove(root) else {
            return Ok(());
        };
        let images = self.images.clone();
        let bundles = self.bundles.clone();
        if rollback {
            match &backup.image {
                Some(image) => {
                    self.images.insert(root.into(), image.clone());
                }
                None => {
                    self.images.remove(root);
                }
            }
            match &backup.bundle {
                Some(bundle) => {
                    self.bundles.insert(root.into(), bundle.clone());
                }
                None => {
                    self.bundles.remove(root);
                }
            }
        }
        if let Err(error) = self.persist() {
            self.images = images;
            self.bundles = bundles;
            self.restore_backups.insert(root.into(), backup);
            return Err(error);
        }
        Ok(())
    }
    fn save(
        &self,
        images: &BTreeMap<String, String>,
        runtimes: &BTreeMap<String, RuntimeAuthority>,
        bundles: &BTreeMap<String, String>,
    ) -> Result<(), String> {
        if let Some(path) = &self.path {
            use std::io::Write;
            let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
            let result = (|| {
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
                file.write_all(
                    &serde_json::to_vec(
                        &serde_json::json!({ "images": images, "runtimes": runtimes, "bundles": bundles, "restore_backups": self.restore_backups }),
                    )
                    .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
                file.sync_all().map_err(|e| e.to_string())?;
                std::fs::rename(&tmp, path).map_err(|e| e.to_string())
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(tmp);
            }
            result?;
        }
        Ok(())
    }
}

impl DockerSandboxBackend {
    pub(super) fn configure_snapshot_forks(&self, dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let path = dir.join("sandbox-snapshot-forks.json");
        let mut index: ForkIndex = match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => ForkIndex::default(),
            Err(error) => return Err(error.to_string()),
            Ok(meta) if !meta.is_file() || meta.len() > 4 * 1024 * 1024 => {
                return Err("Invalid snapshot fork index".into())
            }
            Ok(_) => serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?,
        };
        if index.images.len() > 10000
            || index.runtimes.len() > 10000
            || index
                .images
                .iter()
                .any(|(root, id)| !Path::new(root).is_absolute() || !image_id(id))
        {
            return Err("Invalid snapshot fork identities".into());
        }
        index.path = Some(path);
        *self.snapshot_forks.lock() = index;
        Ok(())
    }
    pub(super) fn remember_snapshot_runtime(
        &self,
        container: &str,
        key: &str,
        environment: &EnvironmentSpec,
        mount: &RunnerMount,
        bundle_digest: &str,
    ) -> Result<(), SandboxSpawnError> {
        let mut index = self.snapshot_forks.lock();
        let mut runtimes = index.runtimes.clone();
        runtimes.insert(
            container.into(),
            RuntimeAuthority {
                project_id: environment.project_id.clone(),
                spec_digest: environment.spec_digest.clone(),
                key: key.into(),
                mount: mount.clone(),
                bundle_digest: bundle_digest.into(),
            },
        );
        index
            .save(&index.images, &runtimes, &index.bundles)
            .map_err(fault)?;
        index.runtimes = runtimes;
        Ok(())
    }
    /// Runtime starts and acquisitions in a workspace share this lock (read);
    /// a cold snapshot or restore needs it exclusively (write) and reports
    /// `snapshot_busy` instead of waiting. Concurrent agents in one workspace
    /// therefore never serialize on each other.
    pub(super) fn snapshot_workspace_lock(
        &self,
        mount: &RunnerMount,
    ) -> Arc<tokio::sync::RwLock<()>> {
        let identity = serde_json::to_vec(mount).expect("workspace mount serializes");
        let key = persistent::sha256_hex(&identity);
        let mut locks = self.snapshot_workspace_locks.lock();
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(tokio::sync::RwLock::new(()));
        locks.insert(key, Arc::downgrade(&lock));
        lock
    }
    pub(super) fn snapshot_fork_image(&self, mount: &RunnerMount) -> Option<String> {
        self.snapshot_forks
            .lock()
            .images
            .iter()
            .find_map(|(root, image)| {
                (self.config.host.resolve_mount(root).ok().as_ref() == Some(mount))
                    .then(|| image.clone())
            })
    }
    pub(super) fn check_snapshot_fork_bundle(
        &self,
        root: &str,
        bundle: &str,
    ) -> Result<(), SandboxSpawnError> {
        if self
            .snapshot_forks
            .lock()
            .bundles
            .get(root)
            .is_some_and(|expected| expected != bundle)
        {
            return Err(SandboxSpawnError::refused(
                "snapshot_bundle_changed",
                "The checkpoint bundle is no longer admitted",
            ));
        }
        Ok(())
    }
    pub(super) fn checkpoint_capabilities(&self) -> SnapshotCapabilities {
        if let Some(remote) = &self.remote {
            // Negotiated: the provider declares, the Host keeps only what it
            // implements for remote runtimes (no filesystem checkpoint/fork).
            let declared = remote.provisioner.snapshot_capabilities();
            SnapshotCapabilities {
                pause_resume: declared.pause_resume,
                memory_resume: declared.memory_resume,
                ..SnapshotCapabilities::default()
            }
        } else {
            SnapshotCapabilities {
                filesystem_checkpoint: true,
                fork_from_checkpoint: true,
                ..SnapshotCapabilities::default()
            }
        }
    }
    pub(super) fn checkpoint_image_name(
        &self,
        snapshot_id: &str,
    ) -> Result<String, SandboxSpawnError> {
        if self.remote.is_some() {
            return Err(snapshot_unsupported());
        }
        let id = uuid::Uuid::parse_str(snapshot_id).map_err(|_| fault("Invalid snapshot UUID"))?;
        Ok(format!(
            "cognia-snapshot-{}:{id}",
            &persistent::sha256_hex(self.config.deployment_id.as_bytes())[..24]
        ))
    }
    pub(super) async fn checkpoint_source(
        &self,
        container: &str,
        project: &str,
        root: &str,
    ) -> Result<crate::runtime::SnapshotRuntimeSource, SandboxSpawnError> {
        if self.remote.is_some() {
            return Err(snapshot_unsupported());
        }
        let authority = self
            .snapshot_forks
            .lock()
            .runtimes
            .get(container)
            .cloned()
            .ok_or_else(|| {
                SandboxSpawnError::refused(
                    "snapshot_runtime_unowned",
                    "Runtime has no Host-owned acquisition receipt",
                )
            })?;
        let mount = self.config.host.resolve_mount(root).map_err(fault)?;
        if authority.project_id != project
            || authority.mount != mount
            || self
                .api
                .runtime_workspace_mount(container)
                .await
                .map_err(fault)?
                .as_ref()
                != Some(&mount)
        {
            return Err(SandboxSpawnError::refused(
                "snapshot_workspace_mismatch",
                "Runtime is not associated with this workspace",
            ));
        }
        let state = self
            .api
            .inspect_runtime(container)
            .await
            .map_err(fault)?
            .ok_or_else(|| fault("Runtime missing"))?;
        let spec = self
            .admission
            .stored_spec(&authority.spec_digest)
            .ok_or_else(|| fault("Runtime spec missing"))?;
        let admitted = self
            .admission
            .recheck(&spec, &self.available_tiers().await?)?;
        if admitted.spec.project_id != project {
            return Err(fault("Runtime project mismatch"));
        }
        Ok(crate::runtime::SnapshotRuntimeSource {
            placement: SandboxPlacement::Container {
                binding: None,
                spec,
                isolation_mandatory: true,
                hosted_tool_host_lease_ids: Vec::new(),
                provider: None,
                workspace: None,
            },
            was_running: state.running,
            bundle_digest: authority.bundle_digest.clone(),
        })
    }
    pub(super) async fn checkpoint_quiesce(
        &self,
        provider: &str,
        container_id: &str,
        project_id: &str,
        workspace_root: &str,
    ) -> Result<SnapshotRuntimeLease, SandboxSpawnError> {
        if self.remote.is_some() {
            return Err(snapshot_unsupported());
        }
        let authority = self
            .snapshot_forks
            .lock()
            .runtimes
            .get(container_id)
            .cloned()
            .ok_or_else(|| {
                SandboxSpawnError::refused(
                    "snapshot_runtime_unowned",
                    "Runtime has no Host-owned acquisition receipt; reacquire it first",
                )
            })?;
        if authority.project_id != project_id
            || self
                .config
                .host
                .resolve_mount(workspace_root)
                .map_err(fault)?
                != authority.mount
        {
            return Err(SandboxSpawnError::refused(
                "snapshot_workspace_mismatch",
                "Runtime is not associated with this workspace",
            ));
        }
        let workspace_guard = Arc::new(
            self.snapshot_workspace_lock(&authority.mount)
                .try_write_owned()
                .map_err(|_| {
                    SandboxSpawnError::refused(
                        "snapshot_busy",
                        "A workspace runtime acquisition or task command is active",
                    )
                })?,
        );
        let siblings: Vec<String> = self
            .snapshot_forks
            .lock()
            .runtimes
            .iter()
            .filter(|(_, receipt)| receipt.mount == authority.mount)
            .map(|(id, _)| id.clone())
            .collect();
        for sibling in siblings {
            if self
                .api
                .inspect_runtime(&sibling)
                .await
                .map_err(fault)?
                .is_some_and(|state| state.running)
            {
                if self
                    .snapshot_forks
                    .lock()
                    .runtimes
                    .get(&sibling)
                    .is_some_and(|receipt| receipt.key.starts_with("ephemeral:"))
                {
                    return Err(SandboxSpawnError::refused(
                        "snapshot_busy",
                        "An ephemeral agent on this workspace is active",
                    ));
                }
                let bytes = persistent::control(
                    &self.api,
                    persistent::exec_spec(&sibling, &["health", "--socket", persistent::SOCKET]),
                )
                .await
                .map_err(fault)?;
                let health: Value =
                    serde_json::from_slice(&bytes).map_err(|error| fault(error.to_string()))?;
                if health["activeSessions"].as_u64() != Some(0)
                    || health["activeConnections"].as_u64() != Some(0)
                {
                    return Err(SandboxSpawnError::refused(
                        "snapshot_busy",
                        "Another runtime on this workspace has an active turn",
                    ));
                }
            }
        }
        let before = self
            .api
            .inspect_runtime(container_id)
            .await
            .map_err(fault)?
            .ok_or_else(|| fault("Snapshot runtime missing"))?;
        let key = before
            .labels
            .get(persistent::RUNTIME_KEY_LABEL)
            .ok_or_else(|| fault("Snapshot requires a retained runtime"))?;
        if *key != authority.key
            || before.labels.get("cognia.spec-digest") != Some(&authority.spec_digest)
        {
            return Err(fault("Runtime receipt mismatch"));
        }
        let guard = Arc::new(
            self.stage_lock(&format!("runtime:{key}"))
                .lock_owned()
                .await,
        );
        let state = self
            .api
            .inspect_runtime(container_id)
            .await
            .map_err(fault)?
            .ok_or_else(|| fault("Snapshot runtime disappeared"))?;
        if state.labels.get(persistent::RUNTIME_KEY_LABEL) != Some(key)
            || state
                .labels
                .get(PERSISTENT_RUNTIME_LABEL)
                .map(String::as_str)
                != Some("1")
        {
            return Err(fault("Runtime identity changed"));
        }
        let expected_mount = self
            .config
            .host
            .resolve_mount(workspace_root)
            .map_err(fault)?;
        if self
            .api
            .runtime_workspace_mount(container_id)
            .await
            .map_err(fault)?
            .as_ref()
            != Some(&expected_mount)
        {
            return Err(SandboxSpawnError::refused(
                "snapshot_workspace_mismatch",
                "Runtime does not mount the authorized workspace",
            ));
        }
        let digest = state
            .labels
            .get("cognia.spec-digest")
            .ok_or_else(|| fault("Runtime spec missing"))?;
        let spec = self
            .admission
            .stored_spec(digest)
            .ok_or_else(|| fault("Runtime spec is no longer admitted"))?;
        let admitted = self
            .admission
            .recheck(&spec, &self.available_tiers().await?)?;
        if admitted.spec.project_id != project_id || admitted.spec.spec_digest != *digest {
            return Err(SandboxSpawnError::refused(
                "snapshot_workspace_mismatch",
                "Runtime spec is not owned by the authorized project",
            ));
        }
        if state.running {
            let bytes = persistent::control(
                &self.api,
                persistent::exec_spec(container_id, &["health", "--socket", persistent::SOCKET]),
            )
            .await
            .map_err(fault)?;
            let health: Value = serde_json::from_slice(&bytes).map_err(|e| fault(e.to_string()))?;
            if health["activeSessions"].as_u64() != Some(0)
                || health["activeConnections"].as_u64() != Some(0)
            {
                return Err(SandboxSpawnError::refused(
                    "snapshot_busy",
                    "An active agent or task turn prevents a cold checkpoint",
                ));
            }
            self.drain_egress(container_id).await?;
            self.api.stop_runtime(container_id).await.map_err(fault)?;
        }
        Ok(SnapshotRuntimeLease {
            provider: provider.into(),
            container_id: container_id.into(),
            project_id: project_id.into(),
            workspace_root: workspace_root.into(),
            placement: SandboxPlacement::Container {
                binding: None,
                spec,
                isolation_mandatory: true,
                hosted_tool_host_lease_ids: Vec::new(),
                provider: None,
                workspace: None,
            },
            running: state.running,
            bundle_digest: authority.bundle_digest.clone(),
            guard: Some(guard),
            workspace_guard: Some(workspace_guard),
            backend: self.own.clone(),
        })
    }
    pub(crate) async fn resume_snapshot_source(
        &self,
        container_id: &str,
    ) -> Result<(), SandboxSpawnError> {
        let authority = self
            .snapshot_forks
            .lock()
            .runtimes
            .get(container_id)
            .cloned()
            .ok_or_else(|| fault("Runtime acquisition receipt missing"))?;
        let body = self
            .admission
            .stored_spec(&authority.spec_digest)
            .ok_or_else(|| fault("Runtime spec missing"))?;
        let placement = SandboxPlacement::Container {
            binding: None,
            spec: body,
            isolation_mandatory: true,
            hosted_tool_host_lease_ids: Vec::new(),
            provider: None,
            workspace: None,
        };
        let root = match authority.mount.source_mount() {
            RunnerMount::Bind { host_dir } => host_dir.clone(),
            RunnerMount::Volume { subpath, .. } => self
                .config
                .host
                .workspaces_dir
                .join(subpath.as_deref().unwrap_or(""))
                .to_string_lossy()
                .into_owned(),
            RunnerMount::ReadOnly { .. } => unreachable!("source_mount unwraps read-only mounts"),
        };
        let prepared = self
            .prepare_local(&placement, &root, OperationLeases::default())
            .await?;
        let libc = self.stage_libc(&prepared).await?;
        let spec =
            self.local_runner_spec("snapshot-resume", &prepared, libc, Vec::new(), Vec::new())?;
        self.api.start_runtime(container_id).await.map_err(fault)?;
        if let Err(error) = self.ensure_egress(container_id, &spec).await {
            self.api.stop_runtime(container_id).await.map_err(fault)?;
            return Err(error);
        }
        Ok(())
    }
    pub(super) async fn checkpoint_commit(
        &self,
        lease: &SnapshotRuntimeLease,
        snapshot_id: &str,
    ) -> Result<SnapshotImage, SandboxSpawnError> {
        if !std::ptr::eq(lease.backend.as_ptr(), self) || lease.guard.is_none() {
            return Err(fault("Snapshot freeze lease belongs to a different driver"));
        }
        let name = self.checkpoint_image_name(snapshot_id)?;
        let (repository, tag) = name
            .rsplit_once(':')
            .ok_or_else(|| fault("Invalid snapshot image name"))?;
        self.api
            .commit_stopped_runtime(&lease.container_id, repository, tag)
            .await
            .map_err(fault)
    }
    pub(super) async fn checkpoint_resume(
        &self,
        mut lease: SnapshotRuntimeLease,
    ) -> Result<(), SandboxSpawnError> {
        if !std::ptr::eq(lease.backend.as_ptr(), self) {
            return Err(fault("Snapshot freeze lease belongs to a different driver"));
        }
        if lease.running {
            self.resume_snapshot_source(&lease.container_id).await?;
        }
        lease.running = false;
        lease.guard.take();
        lease.workspace_guard.take();
        Ok(())
    }
    pub(super) async fn checkpoint_inspect(
        &self,
        id: &str,
    ) -> Result<Option<SnapshotImage>, SandboxSpawnError> {
        if self.remote.is_some() {
            return Err(snapshot_unsupported());
        }
        self.api.inspect_snapshot_image(id).await.map_err(fault)
    }
    pub(super) async fn checkpoint_remove(&self, id: &str) -> Result<(), SandboxSpawnError> {
        if self.remote.is_some() {
            return Err(snapshot_unsupported());
        }
        if !image_id(id) {
            return Err(fault("Snapshot deletion requires an immutable image ID"));
        }
        if {
            let index = self.snapshot_forks.lock();
            index.images.values().any(|value| value == id)
                || index
                    .restore_backups
                    .values()
                    .any(|backup| backup.image.as_deref() == Some(id))
        } {
            return Err(SandboxSpawnError::refused(
                "snapshot_in_use",
                "A fork workspace still references this image",
            ));
        }
        self.api.remove_snapshot_image(id).await.map_err(fault)
    }
    pub(super) async fn checkpoint_runtime_for_workspace(
        &self,
        root: &str,
    ) -> Result<Option<String>, SandboxSpawnError> {
        let mount = self.config.host.resolve_mount(root).map_err(fault)?;
        let mut found = None;
        let retired: BTreeSet<String> = self
            .snapshot_forks
            .lock()
            .restore_backups
            .values()
            .flat_map(|backup| backup.containers.clone())
            .collect();
        for item in self.api.list_owned().await.map_err(fault)? {
            if retired.contains(&item.id) {
                continue;
            }
            if self
                .api
                .runtime_workspace_mount(&item.id)
                .await
                .map_err(fault)?
                .as_ref()
                == Some(&mount)
            {
                if found.is_some() {
                    return Err(fault("Multiple runtimes mount the fork workspace"));
                }
                found = Some(item.id);
            }
        }
        Ok(found)
    }
    pub(super) async fn checkpoint_retire_restore_target(
        &self,
        project: &str,
        root: &str,
    ) -> Result<(), SandboxSpawnError> {
        let mount = self.config.host.resolve_mount(root).map_err(fault)?;
        let _workspace = self
            .snapshot_workspace_lock(&mount)
            .try_write_owned()
            .map_err(|_| {
                SandboxSpawnError::refused("snapshot_busy", "Workspace runtime is active")
            })?;
        let targets: Vec<_> = self
            .snapshot_forks
            .lock()
            .runtimes
            .iter()
            .filter(|(_, receipt)| receipt.mount == mount)
            .map(|(id, receipt)| (id.clone(), receipt.clone()))
            .collect();
        // Validate every target before stopping any of them.
        for (id, receipt) in &targets {
            if receipt.project_id != project {
                return Err(fault("Workspace has a runtime from another project"));
            }
            if self
                .api
                .inspect_runtime(id)
                .await
                .map_err(fault)?
                .is_some_and(|state| state.running)
            {
                if receipt.key.starts_with("ephemeral:") {
                    return Err(SandboxSpawnError::refused(
                        "snapshot_busy",
                        "An ephemeral agent is active",
                    ));
                }
                let bytes = persistent::control(
                    &self.api,
                    persistent::exec_spec(id, &["health", "--socket", persistent::SOCKET]),
                )
                .await
                .map_err(fault)?;
                let health: Value =
                    serde_json::from_slice(&bytes).map_err(|e| fault(e.to_string()))?;
                if health["activeSessions"].as_u64() != Some(0)
                    || health["activeConnections"].as_u64() != Some(0)
                {
                    return Err(SandboxSpawnError::refused(
                        "snapshot_busy",
                        "Restore target has an active turn",
                    ));
                }
            }
        }
        self.snapshot_forks
            .lock()
            .begin_restore(root, targets.iter().map(|(id, _)| id.clone()).collect())
            .map_err(fault)?;
        for (id, receipt) in targets {
            let _runtime = self
                .stage_lock(&format!("runtime:{}", receipt.key))
                .lock_owned()
                .await;
            self.drain_egress(&id).await?;
            self.api.stop_runtime(&id).await.map_err(fault)?;
        }
        self.snapshot_forks.lock().store(root, None).map_err(fault)
    }
    pub(super) fn checkpoint_pending_restore_targets(&self) -> Vec<String> {
        self.snapshot_forks
            .lock()
            .restore_backups
            .keys()
            .cloned()
            .collect()
    }
    pub(super) async fn checkpoint_complete_restore_target(
        &self,
        root: &str,
    ) -> Result<(), SandboxSpawnError> {
        let containers = self
            .snapshot_forks
            .lock()
            .restore_backups
            .get(root)
            .map(|backup| backup.containers.clone())
            .unwrap_or_default();
        for id in containers {
            if self
                .api
                .inspect_runtime(&id)
                .await
                .map_err(fault)?
                .is_some_and(|state| state.running)
            {
                return Err(SandboxSpawnError::refused(
                    "snapshot_busy",
                    "Retired restore runtime became active",
                ));
            }
            self.api.remove(&id).await.map_err(fault)?;
        }
        self.snapshot_forks
            .lock()
            .finish_restore(root, false)
            .map_err(fault)
    }
    pub(super) async fn checkpoint_rollback_restore_target(
        &self,
        root: &str,
    ) -> Result<(), SandboxSpawnError> {
        if !self
            .snapshot_forks
            .lock()
            .restore_backups
            .contains_key(root)
        {
            return Ok(());
        }
        self.checkpoint_discard_fork(root).await?;
        self.snapshot_forks
            .lock()
            .finish_restore(root, true)
            .map_err(fault)
    }
    pub(super) async fn checkpoint_discard_fork(
        &self,
        root: &str,
    ) -> Result<(), SandboxSpawnError> {
        if !self.snapshot_forks.lock().images.contains_key(root) {
            return Ok(());
        }
        if let Some(id) = self.checkpoint_runtime_for_workspace(root).await? {
            let authority = self
                .snapshot_forks
                .lock()
                .runtimes
                .get(&id)
                .cloned()
                .ok_or_else(|| fault("Fork runtime receipt missing"))?;
            let _guard = self
                .stage_lock(&format!("runtime:{}", authority.key))
                .lock_owned()
                .await;
            if self
                .api
                .inspect_runtime(&id)
                .await
                .map_err(fault)?
                .is_some_and(|state| state.running)
            {
                let bytes = persistent::control(
                    &self.api,
                    persistent::exec_spec(&id, &["health", "--socket", persistent::SOCKET]),
                )
                .await
                .map_err(fault)?;
                let health: Value =
                    serde_json::from_slice(&bytes).map_err(|error| fault(error.to_string()))?;
                if health["activeSessions"].as_u64() != Some(0)
                    || health["activeConnections"].as_u64() != Some(0)
                {
                    return Err(SandboxSpawnError::refused(
                        "snapshot_busy",
                        "Fork acquired an active session during compensation",
                    ));
                }
                self.drain_egress(&id).await?;
                self.api.stop_runtime(&id).await.map_err(fault)?;
            }
            self.api.remove(&id).await.map_err(fault)?;
        }
        self.snapshot_forks.lock().store(root, None).map_err(fault)
    }
    pub(super) async fn checkpoint_release_fork(
        &self,
        root: &str,
    ) -> Result<(), SandboxSpawnError> {
        if let Some(id) = self.checkpoint_runtime_for_workspace(root).await? {
            let state = self
                .api
                .inspect_runtime(&id)
                .await
                .map_err(fault)?
                .ok_or_else(|| fault("Runtime disappeared"))?;
            if state.running {
                return Err(SandboxSpawnError::refused(
                    "snapshot_busy",
                    "Fork runtime is still running",
                ));
            }
            self.drain_egress(&id).await?;
            self.api.remove(&id).await.map_err(fault)?;
        }
        self.snapshot_forks.lock().store(root, None).map_err(fault)
    }
    pub(super) async fn checkpoint_verify_bundle(
        &self,
        placement: &SandboxPlacement,
        expected: &str,
    ) -> Result<(), SandboxSpawnError> {
        if self.remote.is_some() {
            return Err(snapshot_unsupported());
        }
        let admitted = self
            .admission
            .admit(placement.spec(), &self.available_tiers().await?)?;
        if admitted.admission.bundle.digest != expected {
            return Err(SandboxSpawnError::refused(
                "snapshot_bundle_changed",
                "The checkpoint bundle is no longer admitted",
            ));
        }
        Ok(())
    }
    pub(super) async fn checkpoint_fork(
        &self,
        image: &str,
        placement: SandboxPlacement,
        workspace_root: &str,
        bundle_digest: &str,
    ) -> Result<String, SandboxSpawnError> {
        if self.remote.is_some() {
            return Err(snapshot_unsupported());
        }
        if !image_id(image)
            || self
                .api
                .inspect_snapshot_image(image)
                .await
                .map_err(fault)?
                .is_none()
        {
            return Err(fault("Snapshot image missing"));
        }
        let SandboxPlacement::Container {
            hosted_tool_host_lease_ids,
            workspace,
            ..
        } = &placement;
        if !hosted_tool_host_lease_ids.is_empty() || workspace.is_some() {
            return Err(fault(
                "Snapshot forks cannot copy grants or remote workspace credentials",
            ));
        }
        let lock = self.stage_lock(&format!("snapshot-fork:{workspace_root}"));
        let _guard = lock.lock().await;
        if self
            .snapshot_forks
            .lock()
            .images
            .contains_key(workspace_root)
        {
            return Err(fault("Workspace already has a fork image"));
        }
        let prepared = self
            .prepare_local(&placement, workspace_root, OperationLeases::default())
            .await?;
        if prepared.bundle.digest != bundle_digest {
            return Err(SandboxSpawnError::refused(
                "snapshot_bundle_changed",
                "The checkpoint bundle is no longer admitted",
            ));
        }
        let libc = self.stage_libc(&prepared).await?;
        self.snapshot_forks
            .lock()
            .bundles
            .insert(workspace_root.into(), bundle_digest.into());
        self.snapshot_forks
            .lock()
            .store(workspace_root, Some(image))
            .map_err(fault)?;
        let result = async {
            let mut spec =
                self.local_runner_spec("snapshot-fork", &prepared, libc, Vec::new(), Vec::new())?;
            self.configure_workspace_ports(&mut spec, workspace_root)
                .await?;
            let acquired = self
                .acquire_runtime(
                    spec,
                    None,
                    &prepared.admitted.spec,
                    persistent::RuntimePurpose::Agent,
                )
                .await?;
            Ok(acquired.container_id.clone())
        }
        .await;
        if result.is_err() {
            // A create may have succeeded before readiness failed. Remove its
            // own newly mounted container before allowing the Host to discard
            // the new execution root. A cleanup failure retains the index.
            if let Some(id) = self
                .checkpoint_runtime_for_workspace(workspace_root)
                .await?
            {
                self.drain_egress(&id).await?;
                self.api.stop_runtime(&id).await.map_err(fault)?;
                self.api.remove(&id).await.map_err(fault)?;
            }
            self.snapshot_forks
                .lock()
                .store(workspace_root, None)
                .map_err(fault)?;
        }
        result
    }
}
fn image_id(id: &str) -> bool {
    id.strip_prefix("sha256:")
        .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docker::tests::{admitted, command, report, spawn_config, spec, Harness};
    use crate::runtime::SandboxRuntimeControl;

    fn env_bundle() -> String {
        format!("sha256:{}", "2".repeat(64))
    }
    async fn retained(egress: EgressTier) -> (Harness, EnvironmentSpec, String) {
        let mut env = spec(egress, None);
        env.lifecycle = SandboxLifecycleKind::Persistent;
        let h = Harness::new(
            admitted(env.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        h.spawn(spawn_config("snapshot-source", "kiro-cli", &[], &env))
            .await
            .unwrap();
        let id = h.backend.get_info("snapshot-source").await.unwrap()["containerId"]
            .as_str()
            .unwrap()
            .to_string();
        h.backend.kill_all().await.unwrap();
        (h, env, id)
    }
    fn root(h: &Harness) -> String {
        match h
            .api
            .specs
            .lock()
            .iter()
            .find(|s| s.cmd.first().map(String::as_str) == Some("serve"))
            .unwrap()
            .mount
            .clone()
            .unwrap()
        {
            RunnerMount::Bind { host_dir } => host_dir,
            _ => panic!("fixture bind"),
        }
    }
    #[tokio::test]
    async fn snapshot_busy_refuses_before_stop_or_commit_and_checks_actual_mount() {
        let (h, env, id) = retained(EgressTier::Off).await;
        h.api.busy_runtimes.lock().insert(id.clone());
        let error = h
            .backend
            .quiesce_snapshot("local", &id, &env.project_id, &root(&h))
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, "snapshot_busy");
        assert!(!h.api.stopped_runtimes.lock().contains(&id));
        assert!(h.api.snapshot_commits.lock().is_empty());
        let error = h
            .backend
            .quiesce_snapshot("local", &id, &env.project_id, "/someone/elses/workspace")
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, "snapshot_workspace_mismatch");
    }
    #[tokio::test]
    async fn snapshot_workspace_fence_covers_task_shell_acquisition_and_sibling_sessions() {
        let (h, env, id) = retained(EgressTier::Off).await;
        let root = root(&h);
        let mut spec = h
            .api
            .specs
            .lock()
            .iter()
            .find(|spec| spec.cmd.first().map(String::as_str) == Some("serve"))
            .unwrap()
            .clone();
        spec.cmd = vec!["init-agent".into(), "--".into(), "kiro-cli".into()];
        let sibling = h
            .backend
            .acquire_runtime(spec, None, &env, persistent::RuntimePurpose::TaskShell)
            .await
            .unwrap();
        let sibling_id = sibling.container_id.clone();
        assert_ne!(sibling_id, id);
        let error = h
            .backend
            .quiesce_snapshot("local", &id, &env.project_id, &root)
            .await
            .err()
            .unwrap();
        assert_eq!(
            error.code, "snapshot_busy",
            "task acquisition owns the workspace fence"
        );
        drop(sibling);
        h.api.busy_runtimes.lock().insert(sibling_id.clone());
        let error = h
            .backend
            .quiesce_snapshot("local", &id, &env.project_id, &root)
            .await
            .err()
            .unwrap();
        assert_eq!(
            error.code, "snapshot_busy",
            "a different runtime key cannot evade busy detection"
        );
        h.api.busy_runtimes.lock().remove(&sibling_id);
        h.backend
            .checkpoint_retire_restore_target(&env.project_id, &root)
            .await
            .unwrap();
        assert!(h.api.stopped_runtimes.lock().contains(&id));
        assert!(h.api.stopped_runtimes.lock().contains(&sibling_id));
        assert!(!h.api.removes.lock().contains(&id));
        h.backend
            .checkpoint_complete_restore_target(&root)
            .await
            .unwrap();
        assert!(h.api.removes.lock().contains(&id));
        assert!(h.api.removes.lock().contains(&sibling_id));
    }

    #[tokio::test]
    async fn snapshot_workspace_fence_also_refuses_ephemeral_siblings() {
        let (h, env, id) = retained(EgressTier::Off).await;
        let root = root(&h);
        // Receipt represents an independently admitted ephemeral agent using
        // the same mount. It has no sandboxd health endpoint to query.
        let ephemeral = "ephemeral-other";
        h.api
            .labels_by_container
            .lock()
            .insert(ephemeral.into(), BTreeMap::new());
        let mount = h.backend.config.host.resolve_mount(&root).unwrap();
        h.backend
            .remember_snapshot_runtime(ephemeral, "ephemeral:other", &env, &mount, &env_bundle())
            .unwrap();
        let error = h
            .backend
            .quiesce_snapshot("local", &id, &env.project_id, &root)
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, "snapshot_busy");
        assert!(!h.api.stopped_runtimes.lock().contains(&id));
    }

    #[tokio::test]
    async fn snapshot_commit_is_stopped_named_by_deployment_and_resumes_source() {
        let (h, env, id) = retained(EgressTier::Off).await;
        let lease = h
            .backend
            .quiesce_snapshot("local", &id, &env.project_id, &root(&h))
            .await
            .unwrap();
        assert!(h.api.stopped_runtimes.lock().contains(&id));
        let uuid = uuid::Uuid::new_v4().to_string();
        let image = h
            .backend
            .commit_snapshot_image(&lease, &uuid)
            .await
            .unwrap();
        assert_eq!(image.size_bytes, 1024);
        let expected = h.backend.snapshot_image_name("local", &uuid).unwrap();
        assert_eq!(
            h.api.snapshot_commits.lock()[0],
            (id.clone(), expected.split(':').next().unwrap().into(), uuid)
        );
        h.backend.resume_snapshot_runtime(lease).await.unwrap();
        assert!(!h.api.stopped_runtimes.lock().contains(&id));
        h.backend
            .remove_snapshot_image("local", &image.id)
            .await
            .unwrap();
        assert!(h.api.snapshot_images.lock().is_empty());
    }
    #[tokio::test]
    async fn snapshot_commit_failure_keeps_resume_possible() {
        let (h, env, id) = retained(EgressTier::Off).await;
        let lease = h
            .backend
            .quiesce_snapshot("local", &id, &env.project_id, &root(&h))
            .await
            .unwrap();
        *h.api.fail_snapshot_commit.lock() = Some("disk full".into());
        assert!(h
            .backend
            .commit_snapshot_image(&lease, &uuid::Uuid::new_v4().to_string())
            .await
            .is_err());
        h.backend.resume_snapshot_runtime(lease).await.unwrap();
        assert!(!h.api.stopped_runtimes.lock().contains(&id));
    }
    #[tokio::test]
    async fn snapshot_fork_uses_new_mount_no_credentials_and_only_post_start() {
        let (h, env, id) = retained(EgressTier::Off).await;
        let lease = h
            .backend
            .quiesce_snapshot("local", &id, &env.project_id, &root(&h))
            .await
            .unwrap();
        let image = h
            .backend
            .commit_snapshot_image(&lease, &uuid::Uuid::new_v4().to_string())
            .await
            .unwrap();
        let placement = lease.placement.clone();
        h.backend.resume_snapshot_runtime(lease).await.unwrap();
        let fork = h
            .backend
            .fork_snapshot_runtime(
                "local",
                &image.id,
                placement.clone(),
                "/srv/workspaces/fork",
                &env_bundle(),
            )
            .await
            .unwrap();
        assert_ne!(fork, id);
        let specs = h.api.specs.lock();
        let created = specs
            .iter()
            .rev()
            .find(|s| s.cmd.first().map(String::as_str) == Some("serve"))
            .unwrap();
        assert_eq!(created.image, image.id);
        assert_eq!(
            created.mount,
            Some(RunnerMount::Bind {
                host_dir: "/srv/workspaces/fork".into()
            })
        );
        assert!(created.env.iter().all(|env| !env.contains("TOKEN=")));
        let runtime = crate::docker::tests::decode_agent_environment(&created.env);
        assert_eq!(runtime.lifecycle_phases, vec![LifecyclePhase::PostStart]);
        drop(specs);
        assert_eq!(
            h.backend
                .remove_snapshot_image("local", &image.id)
                .await
                .unwrap_err()
                .code,
            "snapshot_in_use"
        );
        let mut forged = placement;
        let SandboxPlacement::Container {
            hosted_tool_host_lease_ids,
            ..
        } = &mut forged;
        hosted_tool_host_lease_ids.push("copied-grant".into());
        assert!(h
            .backend
            .fork_snapshot_runtime(
                "local",
                &image.id,
                forged,
                "/srv/workspaces/forged",
                &env_bundle()
            )
            .await
            .is_err());
        h.api.stop_runtime(&fork).await.unwrap();
        h.backend
            .release_snapshot_fork("local", "/srv/workspaces/fork")
            .await
            .unwrap();
        h.backend
            .remove_snapshot_image("local", &image.id)
            .await
            .unwrap();
    }
    #[test]
    fn remote_snapshot_capabilities_are_the_provider_declaration_narrowed_by_the_host() {
        let env = spec(EgressTier::Off, None);
        let h = Harness::new(
            admitted(env, IsolationTier::Container),
            report(Vec::new(), Vec::new()),
            0,
        );
        let remote = |fake: Arc<crate::remote::fake::FakeRemote>| {
            DockerSandboxBackend::new_remote(
                "cloud".into(),
                fake,
                crate::remote::RemoteLimits {
                    max_concurrent: 1,
                    max_lifetime: Duration::from_secs(60),
                    idle_timeout: Duration::from_secs(30),
                },
                h.admission.clone(),
                crate::docker::tests::config(),
            )
        };
        // A provider that declares nothing (a Kubernetes pod cannot resume).
        let kubernetes = crate::remote::fake::FakeRemote::new("kubernetes");
        assert_eq!(
            remote(kubernetes).snapshot_capabilities("cloud"),
            SnapshotCapabilities::default()
        );
        // Over-claiming cannot widen what the Host implements for remotes.
        let claims = crate::remote::fake::FakeRemote::new("custom");
        *claims.snapshot.lock() = SnapshotCapabilities {
            filesystem_checkpoint: true,
            fork_from_checkpoint: true,
            pause_resume: true,
            memory_resume: false,
        };
        assert_eq!(
            remote(claims).snapshot_capabilities("cloud"),
            SnapshotCapabilities {
                pause_resume: true,
                ..SnapshotCapabilities::default()
            }
        );
    }
    #[tokio::test]
    async fn snapshot_e2b_refuses_fork_without_claiming_checkpoint_support() {
        let env = spec(EgressTier::Off, None);
        let h = Harness::new(
            admitted(env.clone(), IsolationTier::Container),
            report(Vec::new(), Vec::new()),
            0,
        );
        let fake = crate::remote::fake::FakeRemote::new("e2b");
        let remote = DockerSandboxBackend::new_remote(
            "cloud".into(),
            fake.clone(),
            crate::remote::RemoteLimits {
                max_concurrent: 2,
                max_lifetime: Duration::from_secs(60),
                idle_timeout: Duration::from_secs(30),
            },
            h.admission.clone(),
            crate::docker::tests::config(),
        );
        let caps = remote.snapshot_capabilities("cloud");
        assert!(!caps.filesystem_checkpoint && !caps.fork_from_checkpoint);
        assert!(caps.pause_resume && caps.memory_resume);
        let placement = spawn_config("fork", "kiro-cli", &[], &env).sandbox.unwrap();
        assert_eq!(
            remote
                .fork_snapshot_runtime("cloud", "sha256:abc", placement, "/fork", &env_bundle())
                .await
                .unwrap_err()
                .code,
            "snapshot_fork_unsupported"
        );
        assert!(fake.provisions.lock().is_empty());
    }

    #[tokio::test]
    async fn snapshot_fork_allowlist_gets_fresh_bridge_generation() {
        let (h, env, id) = retained(EgressTier::Allowlist).await;
        let lease = h
            .backend
            .quiesce_snapshot("local", &id, &env.project_id, &root(&h))
            .await
            .unwrap();
        let image = h
            .backend
            .commit_snapshot_image(&lease, &uuid::Uuid::new_v4().to_string())
            .await
            .unwrap();
        let placement = lease.placement.clone();
        h.backend.resume_snapshot_runtime(lease).await.unwrap();
        let fork = h
            .backend
            .fork_snapshot_runtime(
                "local",
                &image.id,
                placement,
                "/srv/workspaces/allowlist-fork",
                &env_bundle(),
            )
            .await
            .unwrap();
        let bridges: Vec<_> = h
            .api
            .runtime_execs
            .lock()
            .iter()
            .filter(|exec| exec.command.get(1).map(String::as_str) == Some("bridge-egress"))
            .map(|exec| {
                (
                    exec.container_id.clone(),
                    exec.command
                        .windows(2)
                        .find(|pair| pair[0] == "--generation")
                        .unwrap()[1]
                        .clone(),
                )
            })
            .collect();
        let source = bridges
            .iter()
            .find(|(container, _)| container == &id)
            .unwrap();
        let target = bridges
            .iter()
            .find(|(container, _)| container == &fork)
            .unwrap();
        assert_ne!(source.1, target.1);
        h.backend.drain_egress(&id).await.unwrap();
        h.backend.drain_egress(&fork).await.unwrap();
    }

    #[test]
    fn snapshot_restore_backup_recovers_prior_image_and_bundle_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fork-index.json");
        let old = format!("sha256:{}", "a".repeat(64));
        let new = format!("sha256:{}", "b".repeat(64));
        let mut index = ForkIndex {
            path: Some(path.clone()),
            ..ForkIndex::default()
        };
        index.bundles.insert("/root".into(), "old-bundle".into());
        index.store("/root", Some(&old)).unwrap();
        index
            .begin_restore("/root", vec!["old-container".into()])
            .unwrap();
        index.store("/root", None).unwrap();
        index.bundles.insert("/root".into(), "new-bundle".into());
        index.store("/root", Some(&new)).unwrap();
        let mut recovered: ForkIndex =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        recovered.path = Some(path.clone());
        assert_eq!(
            recovered.restore_backups["/root"].containers,
            vec!["old-container"]
        );
        recovered.finish_restore("/root", true).unwrap();
        let persisted: ForkIndex = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(persisted.images["/root"], old);
        assert_eq!(persisted.bundles["/root"], "old-bundle");
        assert!(persisted.restore_backups.is_empty());
    }

    #[test]
    fn snapshot_fork_index_is_durable_and_does_not_accept_invalid_ids() {
        let dir = tempfile::tempdir().unwrap();
        let image = format!("sha256:{}", "a".repeat(64));
        let path = dir.path().join("sandbox-snapshot-forks.json");
        let mut index = ForkIndex {
            path: Some(path.clone()),
            ..ForkIndex::default()
        };
        index.store("/workspace/fork", Some(&image)).unwrap();
        let data: ForkIndex = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(data.images["/workspace/fork"], image);
        assert!(!image_id("ubuntu:latest"));
    }
}
