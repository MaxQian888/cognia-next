use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use cognia_deployment::agent_protocol::{
    AgentOperation, AgentRelease, ReleaseParameters, SignedOperation, AGENT_PROTOCOL_VERSION,
};
use cognia_deployment::DeploymentTarget;
use ed25519_dalek::{Signer, SigningKey};

fn target() -> DeploymentTarget {
    serde_json::from_value(serde_json::json!({
        "apiVersion": "deploy.cognia.dev/v1alpha1", "kind": "DeploymentTarget",
        "metadata": { "id": "staging", "label": "Staging" },
        "spec": {
            "topology": "compose", "publicUrl": "https://server.example.com",
            "compose": { "projectName": "cognia", "deploymentRoot": "/opt/cognia" },
            "controller": { "url": "https://ops.example.com", "credentialRef": "ops/staging" },
            "identity": { "provider": "oidc", "issuer": "https://auth.example.com/oidc",
                "audience": "https://server.example.com/api", "tenantClaim": "organization_id",
                "scopes": { "read": "servers:read", "operate": "servers:operate", "admin": "servers:admin" } },
            "objectStore": { "provider": "s3-compatible", "endpoint": "https://s3.example.com",
                "region": "auto", "bucket": "backups", "pathStyle": false,
                "credentialRef": "backups/staging" },
            "snapshots": { "provider": "external-command", "adapterRef": "zfs-cognia" },
            "tls": { "provider": "existing", "secretRef": "cognia-tls" },
            "secrets": { "provider": "file", "rootRef": "cognia/staging" },
            "images": { "server": format!("server@sha256:{}", "a".repeat(64)),
                "runner": format!("runner@sha256:{}", "b".repeat(64)),
                "workspaceRuntime": format!("runtime@sha256:{}", "c".repeat(64)) }
        }
    }))
    .unwrap()
}

fn signed_operation(target_id: &str, now: i64) -> (SignedOperation, ed25519_dalek::VerifyingKey) {
    let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
    let mut operation = SignedOperation {
        api_version: AGENT_PROTOCOL_VERSION.into(),
        operation_id: "operation-1".into(),
        target_id: target_id.into(),
        issued_at: now - 1,
        expires_at: now + 60,
        key_id: "controller-key-1".into(),
        payload: AgentOperation::Upgrade(ReleaseParameters {
            target_revision: 7,
            target: target(),
            release: AgentRelease {
                server_image: format!("ghcr.io/cognia/server@sha256:{}", "a".repeat(64)),
                runner_image: format!("ghcr.io/cognia/runner@sha256:{}", "b".repeat(64)),
                workspace_runtime_image: format!(
                    "ghcr.io/cognia/runtime@sha256:{}",
                    "c".repeat(64)
                ),
                config_revision: "revision-7".into(),
            },
        }),
        signature: String::new(),
    };
    operation.signature = BASE64.encode(
        signing_key
            .sign(&operation.signing_bytes().unwrap())
            .to_bytes(),
    );
    (operation, signing_key.verifying_key())
}

#[test]
fn verifies_a_signed_allowlisted_operation() {
    let now = 1_700_000_000;
    let (operation, key) = signed_operation("staging", now);
    operation
        .verify("staging", now, &key)
        .expect("valid signature");
    assert!(matches!(operation.payload, AgentOperation::Upgrade(_)));
}

#[test]
fn rejects_tampering_wrong_target_and_expiration() {
    let now = 1_700_000_000;
    let (mut operation, key) = signed_operation("staging", now);
    operation.operation_id = "tampered".into();
    assert!(operation.verify("staging", now, &key).is_err());

    let (operation, key) = signed_operation("staging", now);
    assert!(operation.verify("production", now, &key).is_err());
    assert!(operation.verify("staging", now + 61, &key).is_err());
}

#[test]
fn rejects_unknown_payload_fields_and_mutable_release_images() {
    let raw = serde_json::json!({
        "kind": "backup",
        "parameters": { "backupId": "backup-1", "argv": ["sh", "-c", "unsafe"] }
    });
    assert!(serde_json::from_value::<AgentOperation>(raw).is_err());

    let client_selected_rollback = serde_json::json!({
        "kind": "rollback",
        "parameters": { "releaseDigest": "client-controlled" }
    });
    assert!(serde_json::from_value::<AgentOperation>(client_selected_rollback).is_err());

    let mutable = AgentRelease {
        server_image: "ghcr.io/cognia/server:latest".into(),
        runner_image: format!("runner@sha256:{}", "b".repeat(64)),
        workspace_runtime_image: format!("runtime@sha256:{}", "c".repeat(64)),
        config_revision: "revision-1".into(),
    };
    assert!(!mutable.has_immutable_images());
}
