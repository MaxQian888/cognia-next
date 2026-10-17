//! Recovery tests use the real workspace ledger and scripted Docker image API.
use super::*;
use cognia_external_agent::container_backend::{test_support::FakeContainerApi, SandboxDockerApi};
use cognia_sandbox_pool::runtime::{RuntimePort, SnapshotCapabilities, SnapshotImage};
use cognia_task_workspace::ServiceConfig;
use std::collections::BTreeSet;

struct RecoveryRuntime {
    api: Arc<FakeContainerApi>,
    live: parking_lot::Mutex<BTreeSet<String>>,
}

#[async_trait::async_trait]
impl SandboxRuntimeControl for RecoveryRuntime {
    async fn pending_snapshot_restore_targets(
        &self,
        _: &str,
    ) -> Result<Vec<String>, SandboxSpawnError> {
        Ok(Vec::new())
    }

    fn snapshot_capabilities(&self, _: &str) -> SnapshotCapabilities {
        SnapshotCapabilities {
            filesystem_checkpoint: true,
            fork_from_checkpoint: true,
            ..Default::default()
        }
    }

    async fn inspect_snapshot_image(
        &self,
        _: &str,
        id: &str,
    ) -> Result<Option<SnapshotImage>, SandboxSpawnError> {
        self.api
            .inspect_snapshot_image(id)
            .await
            .map_err(|error| SandboxSpawnError::fault("snapshot_inspect_failed", error))
    }

    async fn remove_snapshot_image(&self, _: &str, id: &str) -> Result<(), SandboxSpawnError> {
        self.api
            .remove_snapshot_image(id)
            .await
            .map_err(|error| SandboxSpawnError::fault("snapshot_remove_failed", error))
    }

    async fn snapshot_runtime_exists(&self, _: &str, id: &str) -> Result<bool, SandboxSpawnError> {
        Ok(self.live.lock().contains(id))
    }

    async fn list_ports(&self, _: &str) -> Result<Vec<RuntimePort>, SandboxSpawnError> {
        Ok(Vec::new())
    }

    async fn port_allowed(&self, _: &str, _: &str, _: u16) -> Result<bool, SandboxSpawnError> {
        Ok(false)
    }

    async fn open_port(
        &self,
        _: &str,
        _: &str,
        _: u16,
    ) -> Result<tokio::io::DuplexStream, SandboxSpawnError> {
        Err(SandboxSpawnError::refused(
            "test_no_ports",
            "No ports in recovery fixture",
        ))
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    workspaces: Arc<TaskWorkspaceService>,
    runtime: Arc<RecoveryRuntime>,
    source: String,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("workspace");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("ignored-output"), "preserve these bytes").unwrap();
        let workspaces = Arc::new(
            TaskWorkspaceService::open(ServiceConfig::new(dir.path().join("data"))).unwrap(),
        );
        Self {
            source: source.to_str().unwrap().into(),
            _dir: dir,
            workspaces,
            runtime: Arc::new(RecoveryRuntime {
                api: FakeContainerApi::new(),
                live: parking_lot::Mutex::new(BTreeSet::new()),
            }),
        }
    }

    fn service(&self, deployment: &str) -> SnapshotService {
        SnapshotService {
            workspaces: self.workspaces.clone(),
            runtime: self.runtime.clone(),
            deployment: deployment.into(),
            gate: tokio::sync::RwLock::new(()),
            claims: Claims::default(),
            initialized: OnceCell::new(),
            previews: RwLock::new(None),
        }
    }

    fn snapshot(&self, deployment: &str, phase: SnapshotOperationPhase) -> SandboxSnapshotRecord {
        let id = uuid::Uuid::new_v4().to_string();
        let name = format!("cognia-snapshot-{deployment}:{id}");
        self.workspaces
            .begin_sandbox_snapshot(&BeginSandboxSnapshot {
                snapshot_id: id.clone(),
                deployment_id: deployment.into(),
                project_id: "project".into(),
                task_id: format!("task-{id}"),
                workspace_root: self.source.clone(),
                runtime: serde_json::json!({"provider":"local","imageName":name}),
                exclusions: Vec::new(),
            })
            .unwrap();
        if phase != SnapshotOperationPhase::Preparing {
            self.workspaces
                .capture_sandbox_snapshot_checkpoint(deployment, &id)
                .unwrap();
        }
        if matches!(
            phase,
            SnapshotOperationPhase::ImageCommitted | SnapshotOperationPhase::Ready
        ) {
            let image = self.add_image(&name);
            self.workspaces
                .record_sandbox_snapshot_image(deployment, &id, &image.id, image.size_bytes)
                .unwrap();
        }
        if phase == SnapshotOperationPhase::Ready {
            self.workspaces
                .complete_sandbox_snapshot(deployment, &id)
                .unwrap();
        }
        self.workspaces
            .get_sandbox_snapshot(deployment, &id)
            .unwrap()
            .unwrap()
    }

    fn add_image(&self, name: &str) -> SnapshotImage {
        let image = SnapshotImage {
            id: format!("sha256:{:0>64}", uuid::Uuid::new_v4().simple()),
            size_bytes: 100,
        };
        let mut images = self.runtime.api.snapshot_images.lock();
        images.insert(name.into(), image.clone());
        images.insert(image.id.clone(), image.clone());
        image
    }
}

#[tokio::test]
async fn startup_compensates_every_interrupted_creation_phase() {
    for phase in [
        SnapshotOperationPhase::Preparing,
        SnapshotOperationPhase::WorkspaceCaptured,
        SnapshotOperationPhase::ImageCommitted,
    ] {
        let fixture = Fixture::new();
        let snapshot = fixture.snapshot("ours", phase);
        let service = fixture.service("ours");
        service.initialize().await.unwrap();
        assert!(fixture
            .workspaces
            .get_sandbox_snapshot("ours", &snapshot.snapshot_id)
            .unwrap()
            .is_none());
        assert!(fixture.runtime.api.snapshot_images.lock().is_empty());
        service.initialize().await.unwrap();
    }
}

#[tokio::test]
async fn startup_recovers_image_committed_before_its_id_reached_the_journal() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot("ours", SnapshotOperationPhase::WorkspaceCaptured);
    let image = fixture.add_image(snapshot.runtime["imageName"].as_str().unwrap());
    fixture.service("ours").initialize().await.unwrap();
    assert_eq!(*fixture.runtime.api.snapshot_removes.lock(), vec![image.id]);
    assert!(fixture
        .workspaces
        .get_sandbox_snapshot("ours", &snapshot.snapshot_id)
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn failed_image_removal_retains_checkpoint_and_retries_at_startup() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot("ours", SnapshotOperationPhase::ImageCommitted);
    *fixture.runtime.api.fail_snapshot_remove.lock() = Some("daemon unavailable".into());
    let service = fixture.service("ours");
    assert!(service
        .initialize()
        .await
        .unwrap_err()
        .contains("daemon unavailable"));
    let retained = service.get(&snapshot.snapshot_id).unwrap();
    assert_eq!(retained.phase, SnapshotOperationPhase::Tombstoned);
    assert!(retained.checkpoint_id.is_some());
    assert!(!fixture.runtime.api.snapshot_images.lock().is_empty());
    *fixture.runtime.api.fail_snapshot_remove.lock() = None;
    service.initialize().await.unwrap();
    assert!(fixture
        .workspaces
        .get_sandbox_snapshot("ours", &snapshot.snapshot_id)
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn reaper_never_deletes_another_deployments_ready_image() {
    let fixture = Fixture::new();
    let foreign = fixture.snapshot("foreign", SnapshotOperationPhase::Ready);
    let ours = fixture.snapshot("ours", SnapshotOperationPhase::ImageCommitted);
    fixture.service("ours").initialize().await.unwrap();
    assert_eq!(
        *fixture.runtime.api.snapshot_removes.lock(),
        vec![ours.image_id.unwrap()]
    );
    assert!(fixture
        .workspaces
        .get_sandbox_snapshot("foreign", &foreign.snapshot_id)
        .unwrap()
        .is_some());
    assert!(fixture
        .runtime
        .api
        .snapshot_images
        .lock()
        .contains_key(foreign.image_id.as_ref().unwrap()));
}

#[tokio::test]
async fn tombstone_keeps_live_runtime_references_then_reaps_after_runtime_disappears() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot("ours", SnapshotOperationPhase::Ready);
    fixture.runtime.live.lock().insert("runtime".into());
    fixture
        .workspaces
        .add_sandbox_snapshot_reference("ours", &snapshot.snapshot_id, "runtime", "runtime")
        .unwrap();
    let service = fixture.service("ours");
    let deleted = service.delete(&snapshot.snapshot_id).await.unwrap();
    assert_eq!(deleted.phase, SnapshotOperationPhase::Tombstoned);
    assert!(fixture.runtime.api.snapshot_removes.lock().is_empty());
    assert!(service
        .get(&snapshot.snapshot_id)
        .unwrap()
        .checkpoint_id
        .is_some());
    fixture.runtime.live.lock().clear();
    service.maintenance().await.unwrap();
    assert_eq!(
        *fixture.runtime.api.snapshot_removes.lock(),
        vec![snapshot.image_id.unwrap()]
    );
}

struct RefusingPreviews;

#[async_trait::async_trait]
impl SnapshotPreviewRevoker for RefusingPreviews {
    async fn revoke_snapshot(&self, _: &str, _: &str) -> Result<(), String> {
        Err("preview revocation failed".into())
    }
}

#[tokio::test]
async fn failed_preview_revocation_prevents_image_and_checkpoint_deletion() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot("ours", SnapshotOperationPhase::Ready);
    let service = fixture.service("ours");
    service.set_preview_revoker(Arc::new(RefusingPreviews));
    assert!(service
        .delete(&snapshot.snapshot_id)
        .await
        .unwrap_err()
        .contains("preview revocation failed"));
    assert!(fixture.runtime.api.snapshot_removes.lock().is_empty());
    assert!(service
        .get(&snapshot.snapshot_id)
        .unwrap()
        .checkpoint_id
        .is_some());
}

#[tokio::test]
async fn pin_and_manual_delete_are_independent() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot("ours", SnapshotOperationPhase::Ready);
    let service = fixture.service("ours");
    assert!(
        service
            .pin(&snapshot.snapshot_id, true)
            .await
            .unwrap()
            .pinned
    );
    service.maintenance().await.unwrap();
    assert!(fixture.runtime.api.snapshot_removes.lock().is_empty());
    service.delete(&snapshot.snapshot_id).await.unwrap();
    assert_eq!(
        *fixture.runtime.api.snapshot_removes.lock(),
        vec![snapshot.image_id.unwrap()]
    );
}

#[test]
fn snapshot_records_match_the_generated_host_response_contract() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot("ours", SnapshotOperationPhase::Ready);
    let value = serde_json::to_value(&snapshot).unwrap();
    let contract = crate::command_manifest::headless_contract().unwrap();
    for command in [
        "sandbox_snapshot_create",
        "sandbox_snapshot_get",
        "sandbox_snapshot_pin",
        "sandbox_snapshot_delete",
    ] {
        contract.validate_output(command, &value).unwrap();
        let mut invalid = value.clone();
        invalid["phase"] = serde_json::json!("unknown");
        assert!(contract.validate_output(command, &invalid).is_err());
    }
    contract
        .validate_output("sandbox_snapshot_list", &serde_json::json!({"items": [value]}))
        .unwrap();
}

#[test]
fn claims_share_or_exclude_per_key_and_release_on_drop() {
    let claims = Claims::default();
    let reader = claims.take(&[(snapshot_key("s"), false)]).unwrap();
    let second_reader = claims.take(&[(snapshot_key("s"), false)]).unwrap();
    assert!(claims
        .take(&[(snapshot_key("s"), true)])
        .err()
        .expect("a writer conflicts with readers")
        .starts_with("snapshot_busy"));
    drop(reader);
    assert!(claims.take(&[(snapshot_key("s"), true)]).is_err());
    drop(second_reader);
    let writer = claims.take(&[(snapshot_key("s"), true)]).unwrap();
    assert!(claims.take(&[(snapshot_key("s"), false)]).is_err());
    // A failed multi-key claim takes nothing, so it cannot strand a key.
    assert!(claims
        .take(&[(workspace_key("w"), true), (snapshot_key("s"), false)])
        .is_err());
    assert!(claims.take(&[(workspace_key("w"), true)]).is_ok());
    drop(writer);
    assert!(claims.take(&[(snapshot_key("s"), false)]).is_ok());
}

#[tokio::test]
async fn a_busy_workspace_refuses_at_once_and_never_blocks_another_workspace() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service("deployment"));
    service.initialize().await.unwrap();
    // Workspace A is mid-snapshot (the claim a long capture would hold).
    let held = service
        .claims
        .take(&[(workspace_key("workspace-a"), true)])
        .unwrap();
    let request = |workspace: &str| CreateSandboxSnapshot {
        project_id: "project".into(),
        workspace_id: workspace.into(),
        provider: "local".into(),
        container_id: "container".into(),
        exclusions: Vec::new(),
    };
    let same = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        service.create(request("workspace-a")),
    )
    .await
    .expect("a same-workspace conflict must not wait");
    assert!(same.unwrap_err().starts_with("snapshot_busy"));
    // Workspace B proceeds past the claim while A is still held; it fails
    // later for its own reason (it is not registered), never as busy.
    let other = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        service.create(request("workspace-b")),
    )
    .await
    .expect("another workspace must not wait for workspace A");
    assert!(!other.unwrap_err().starts_with("snapshot_busy"));
    drop(held);
}
