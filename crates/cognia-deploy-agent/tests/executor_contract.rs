use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use cognia_deploy_agent::{AgentExecutor, Driver, DriverError, ExecutionState, StateStore};
use cognia_deployment::agent_protocol::{
    AgentOperation, AgentRelease, ReleaseParameters, RollbackParameters, SignedOperation,
    AGENT_PROTOCOL_VERSION,
};
use cognia_deployment::DeploymentTarget;
use ed25519_dalek::{Signer, SigningKey};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Default)]
struct FakeDriver {
    calls: Mutex<Vec<String>>,
    fail_release: Mutex<Option<String>>,
    fail_rollback: Mutex<bool>,
}

#[async_trait]
impl Driver for FakeDriver {
    async fn preflight(&self, _target_revision: i64) -> Result<Value, DriverError> {
        self.calls.lock().push("preflight".into());
        Ok(json!({ "ok": true }))
    }

    async fn activate_release(
        &self,
        release: &AgentRelease,
        _target: &DeploymentTarget,
    ) -> Result<(), DriverError> {
        self.calls
            .lock()
            .push(format!("activate:{}", release.config_revision));
        if self.fail_rollback.lock().to_owned() && release.config_revision == "revision-1" {
            return Err(DriverError::Command("rollback failed".into()));
        }
        Ok(())
    }

    async fn strict_smoke(&self, release: &AgentRelease) -> Result<Value, DriverError> {
        self.calls
            .lock()
            .push(format!("smoke:{}", release.config_revision));
        if self.fail_release.lock().as_deref() == Some(release.config_revision.as_str()) {
            return Err(DriverError::Readiness("strict smoke failed".into()));
        }
        Ok(json!({ "ready": true }))
    }

    async fn backup(&self, _backup_id: &str) -> Result<Value, DriverError> {
        Ok(json!({}))
    }

    async fn restore(
        &self,
        _recovery_point_id: &str,
        _destination_volume_id: &str,
    ) -> Result<Value, DriverError> {
        Ok(json!({}))
    }

    async fn rotate_key(&self, _key_version: &str) -> Result<Value, DriverError> {
        Ok(json!({}))
    }

    async fn collect_status(&self, _include_runtime_usage: bool) -> Result<Value, DriverError> {
        Ok(json!({}))
    }

    async fn collect_logs(
        &self,
        _after_event_id: Option<i64>,
        _limit: u16,
    ) -> Result<Value, DriverError> {
        Ok(json!({}))
    }
}

fn release(revision: &str, byte: char) -> AgentRelease {
    AgentRelease {
        server_image: format!("server@sha256:{}", byte.to_string().repeat(64)),
        runner_image: format!("runner@sha256:{}", byte.to_string().repeat(64)),
        workspace_runtime_image: format!("runtime@sha256:{}", byte.to_string().repeat(64)),
        agent_bundle_image: None,
        retained_agent_bundle_images: Vec::new(),
        config_revision: revision.into(),
    }
}

fn bundle(byte: char) -> String {
    format!("bundle@sha256:{}", byte.to_string().repeat(64))
}

fn target() -> DeploymentTarget {
    serde_json::from_value(json!({
        "apiVersion": "deploy.cognia.dev/v1alpha1",
        "kind": "DeploymentTarget",
        "metadata": { "id": "staging", "label": "Staging" },
        "spec": {
            "topology": "compose",
            "publicUrl": "https://server.example.com",
            "compose": { "projectName": "cognia", "deploymentRoot": "/opt/cognia" },
            "controller": { "url": "https://ops.example.com", "credentialRef": "ops/staging" },
            "identity": {
                "provider": "oidc", "issuer": "https://auth.example.com/oidc",
                "audience": "https://server.example.com/api", "tenantClaim": "organization_id",
                "scopes": { "read": "servers:read", "operate": "servers:operate", "admin": "servers:admin" }
            },
            "objectStore": {
                "provider": "s3-compatible", "endpoint": "https://s3.example.com",
                "region": "auto", "bucket": "backups", "pathStyle": false,
                "credentialRef": "backups/staging"
            },
            "snapshots": { "provider": "external-command", "adapterRef": "zfs-cognia" },
            "tls": { "provider": "existing", "secretRef": "cognia-tls" },
            "secrets": { "provider": "file", "rootRef": "cognia/staging" },
            "images": {
                "server": format!("server@sha256:{}", "a".repeat(64)),
                "runner": format!("runner@sha256:{}", "b".repeat(64)),
                "workspaceRuntime": format!("runtime@sha256:{}", "c".repeat(64))
            }
        }
    }))
    .unwrap()
}

fn signed_upgrade(
    signing_key: &SigningKey,
    release: AgentRelease,
    operation_id: &str,
    now: i64,
) -> SignedOperation {
    let mut operation = SignedOperation {
        api_version: AGENT_PROTOCOL_VERSION.into(),
        operation_id: operation_id.into(),
        target_id: "staging".into(),
        issued_at: now - 1,
        expires_at: now + 60,
        key_id: "controller-1".into(),
        payload: AgentOperation::Upgrade(ReleaseParameters {
            target_revision: 2,
            target: target(),
            release,
        }),
        signature: String::new(),
    };
    operation.signature = BASE64.encode(
        signing_key
            .sign(&operation.signing_bytes().unwrap())
            .to_bytes(),
    );
    operation
}

fn signed_rollback(signing_key: &SigningKey, operation_id: &str, now: i64) -> SignedOperation {
    let mut operation = SignedOperation {
        api_version: AGENT_PROTOCOL_VERSION.into(),
        operation_id: operation_id.into(),
        target_id: "staging".into(),
        issued_at: now - 1,
        expires_at: now + 60,
        key_id: "controller-1".into(),
        payload: AgentOperation::Rollback(RollbackParameters::default()),
        signature: String::new(),
    };
    operation.signature = BASE64.encode(
        signing_key
            .sign(&operation.signing_bytes().unwrap())
            .to_bytes(),
    );
    operation
}

#[tokio::test]
async fn smoke_failure_rolls_back_from_persisted_previous_release() {
    let temp = tempfile::tempdir().unwrap();
    let store = StateStore::new(temp.path().join("state.json"));
    store
        .save(&ExecutionState {
            current_release: Some(release("revision-1", 'a')),
            previous_release: None,
            current_target: Some(target()),
            previous_target: None,
            completed_operations: Vec::new(),
        })
        .await
        .unwrap();
    let signing_key = SigningKey::from_bytes(&[9_u8; 32]);
    let driver = Arc::new(FakeDriver::default());
    *driver.fail_release.lock() = Some("revision-2".into());
    let executor = AgentExecutor::new(
        "staging".into(),
        signing_key.verifying_key(),
        store,
        driver.clone(),
    );

    let outcome = executor
        .execute(
            signed_upgrade(
                &signing_key,
                release("revision-2", 'b'),
                "upgrade-1",
                1_700_000_000,
            ),
            1_700_000_000,
        )
        .await;
    assert_eq!(outcome.state, cognia_deployment::OperationState::RolledBack);
    assert_eq!(
        executor
            .state()
            .await
            .current_release
            .unwrap()
            .config_revision,
        "revision-1"
    );
    assert_eq!(
        driver.calls.lock().as_slice(),
        [
            "activate:revision-2",
            "smoke:revision-2",
            "activate:revision-1",
            "smoke:revision-1"
        ]
    );
}

#[tokio::test]
async fn contradictory_bundle_lists_never_reach_the_platform_driver() {
    let temp = tempfile::tempdir().unwrap();
    let signing_key = SigningKey::from_bytes(&[9_u8; 32]);
    let driver = Arc::new(FakeDriver::default());
    let executor = AgentExecutor::new(
        "staging".into(),
        signing_key.verifying_key(),
        StateStore::new(temp.path().join("state.json")),
        driver.clone(),
    );
    let cases = [
        (
            "retained-without-current",
            AgentRelease {
                retained_agent_bundle_images: vec![bundle('e')],
                ..release("revision-2", 'b')
            },
            "invalid_release_bundles",
        ),
        (
            "current-retained-twice",
            AgentRelease {
                agent_bundle_image: Some(bundle('d')),
                retained_agent_bundle_images: vec![bundle('d')],
                ..release("revision-2", 'b')
            },
            "invalid_release_bundles",
        ),
        (
            "tag-only-bundle",
            AgentRelease {
                agent_bundle_image: Some("bundle:latest".into()),
                ..release("revision-2", 'b')
            },
            "mutable_release_image",
        ),
    ];
    for (operation_id, release, code) in cases {
        let outcome = executor
            .execute(
                signed_upgrade(&signing_key, release, operation_id, 1_700_000_000),
                1_700_000_000,
            )
            .await;
        assert_eq!(outcome.state, cognia_deployment::OperationState::Failed);
        assert_eq!(outcome.error_code.as_deref(), Some(code), "{operation_id}");
    }
    assert!(driver.calls.lock().is_empty());
}

#[tokio::test]
async fn persisted_state_without_bundles_keeps_its_shape() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.json");
    let store = StateStore::new(path.clone());
    store
        .save(&ExecutionState {
            current_release: Some(release("revision-1", 'a')),
            previous_release: None,
            current_target: Some(target()),
            previous_target: None,
            completed_operations: Vec::new(),
        })
        .await
        .unwrap();
    let written = std::fs::read_to_string(&path).unwrap();
    assert!(!written.contains("agentBundle"), "{written}");
    assert!(!written.contains("retainedAgentBundleImages"), "{written}");

    let with_bundles = AgentRelease {
        agent_bundle_image: Some(bundle('d')),
        retained_agent_bundle_images: vec![bundle('e')],
        ..release("revision-2", 'b')
    };
    let signing_key = SigningKey::from_bytes(&[9_u8; 32]);
    let executor = AgentExecutor::new(
        "staging".into(),
        signing_key.verifying_key(),
        store,
        Arc::new(FakeDriver::default()),
    );
    let outcome = executor
        .execute(
            signed_upgrade(
                &signing_key,
                with_bundles.clone(),
                "upgrade-1",
                1_700_000_000,
            ),
            1_700_000_000,
        )
        .await;
    assert_eq!(outcome.state, cognia_deployment::OperationState::Succeeded);
    let state = executor.state().await;
    assert_eq!(state.current_release, Some(with_bundles));
    assert_eq!(
        state.previous_release.unwrap().agent_bundle_image,
        None,
        "the bundle-less release is kept for rollback as it was"
    );
}

#[tokio::test]
async fn invalid_signature_never_reaches_the_platform_driver() {
    let temp = tempfile::tempdir().unwrap();
    let signing_key = SigningKey::from_bytes(&[9_u8; 32]);
    let driver = Arc::new(FakeDriver::default());
    let executor = AgentExecutor::new(
        "staging".into(),
        signing_key.verifying_key(),
        StateStore::new(temp.path().join("state.json")),
        driver.clone(),
    );
    let mut operation = signed_upgrade(
        &signing_key,
        release("revision-2", 'b'),
        "upgrade-1",
        1_700_000_000,
    );
    operation.target_id = "production".into();

    let outcome = executor.execute(operation, 1_700_000_000).await;
    assert_eq!(outcome.state, cognia_deployment::OperationState::Failed);
    assert!(driver.calls.lock().is_empty());
}

#[tokio::test]
async fn manual_rollback_activates_the_persisted_previous_release_and_swaps_history() {
    let temp = tempfile::tempdir().unwrap();
    let store = StateStore::new(temp.path().join("state.json"));
    store
        .save(&ExecutionState {
            current_release: Some(release("revision-2", 'b')),
            previous_release: Some(release("revision-1", 'a')),
            current_target: Some(target()),
            previous_target: Some(target()),
            completed_operations: Vec::new(),
        })
        .await
        .unwrap();
    let signing_key = SigningKey::from_bytes(&[9_u8; 32]);
    let driver = Arc::new(FakeDriver::default());
    let executor = AgentExecutor::new(
        "staging".into(),
        signing_key.verifying_key(),
        store,
        driver.clone(),
    );

    let outcome = executor
        .execute(
            signed_rollback(&signing_key, "rollback-1", 1_700_000_000),
            1_700_000_000,
        )
        .await;

    assert_eq!(outcome.state, cognia_deployment::OperationState::Succeeded);
    let state = executor.state().await;
    assert_eq!(state.current_release.unwrap().config_revision, "revision-1");
    assert_eq!(
        state.previous_release.unwrap().config_revision,
        "revision-2"
    );
    assert_eq!(
        driver.calls.lock().as_slice(),
        ["activate:revision-1", "smoke:revision-1"]
    );
}

#[tokio::test]
async fn manual_rollback_without_history_fails_without_touching_the_platform() {
    let temp = tempfile::tempdir().unwrap();
    let signing_key = SigningKey::from_bytes(&[9_u8; 32]);
    let driver = Arc::new(FakeDriver::default());
    let executor = AgentExecutor::new(
        "staging".into(),
        signing_key.verifying_key(),
        StateStore::new(temp.path().join("state.json")),
        driver.clone(),
    );

    let outcome = executor
        .execute(
            signed_rollback(&signing_key, "rollback-1", 1_700_000_000),
            1_700_000_000,
        )
        .await;

    assert_eq!(outcome.state, cognia_deployment::OperationState::Failed);
    assert_eq!(
        outcome.error_code.as_deref(),
        Some("previous_release_unavailable")
    );
    assert!(driver.calls.lock().is_empty());
}

#[tokio::test]
async fn failed_manual_rollback_reactivates_the_current_release() {
    let temp = tempfile::tempdir().unwrap();
    let store = StateStore::new(temp.path().join("state.json"));
    store
        .save(&ExecutionState {
            current_release: Some(release("revision-2", 'b')),
            previous_release: Some(release("revision-1", 'a')),
            current_target: Some(target()),
            previous_target: Some(target()),
            completed_operations: Vec::new(),
        })
        .await
        .unwrap();
    let signing_key = SigningKey::from_bytes(&[9_u8; 32]);
    let driver = Arc::new(FakeDriver::default());
    *driver.fail_release.lock() = Some("revision-1".into());
    let executor = AgentExecutor::new(
        "staging".into(),
        signing_key.verifying_key(),
        store,
        driver.clone(),
    );

    let outcome = executor
        .execute(
            signed_rollback(&signing_key, "rollback-1", 1_700_000_000),
            1_700_000_000,
        )
        .await;

    assert_eq!(
        outcome.state,
        cognia_deployment::OperationState::RollbackFailed
    );
    assert_eq!(
        outcome.error_code.as_deref(),
        Some("manual_rollback_failed")
    );
    assert_eq!(
        executor
            .state()
            .await
            .current_release
            .unwrap()
            .config_revision,
        "revision-2"
    );
    assert_eq!(
        driver.calls.lock().as_slice(),
        [
            "activate:revision-1",
            "smoke:revision-1",
            "activate:revision-2",
            "smoke:revision-2"
        ]
    );
}
