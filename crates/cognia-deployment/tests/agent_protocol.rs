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
                agent_bundle_image: None,
                retained_agent_bundle_images: Vec::new(),
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
        agent_bundle_image: None,
        retained_agent_bundle_images: Vec::new(),
        config_revision: "revision-1".into(),
    };
    assert!(!mutable.has_immutable_images());
}

fn bundle(byte: char, tag: &str) -> String {
    format!(
        "ghcr.io/cognia/cognia-agent-bundle{tag}@sha256:{}",
        byte.to_string().repeat(64)
    )
}

fn release_with_bundles(current: Option<String>, retained: Vec<String>) -> AgentRelease {
    AgentRelease {
        server_image: format!("server@sha256:{}", "a".repeat(64)),
        runner_image: format!("runner@sha256:{}", "b".repeat(64)),
        workspace_runtime_image: format!("runtime@sha256:{}", "c".repeat(64)),
        agent_bundle_image: current,
        retained_agent_bundle_images: retained,
        config_revision: "revision-1".into(),
    }
}

#[test]
fn a_release_without_a_bundle_signs_exactly_the_three_image_payload() {
    let now = 1_700_000_000;
    let (operation, key) = signed_operation("staging", now);
    let bytes = String::from_utf8(operation.signing_bytes().unwrap()).unwrap();
    assert!(!bytes.contains("agentBundleImage"), "{bytes}");
    assert!(!bytes.contains("retainedAgentBundleImages"), "{bytes}");
    assert!(!bytes.contains("agentBundle"), "{bytes}");

    // A payload written before the fields existed still parses and verifies.
    let wire = serde_json::to_value(&operation).unwrap();
    let parsed: SignedOperation = serde_json::from_value(wire).unwrap();
    parsed
        .verify("staging", now, &key)
        .expect("valid signature");
}

#[test]
fn bundle_fields_round_trip_and_are_covered_by_the_signature() {
    let release = release_with_bundles(Some(bundle('d', ":v2")), vec![bundle('e', ":v1")]);
    let json = serde_json::to_value(&release).unwrap();
    assert_eq!(json["agentBundleImage"], bundle('d', ":v2"));
    assert_eq!(
        json["retainedAgentBundleImages"],
        serde_json::json!([bundle('e', ":v1")])
    );
    assert_eq!(
        serde_json::from_value::<AgentRelease>(json).unwrap(),
        release
    );

    let now = 1_700_000_000;
    let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
    let (mut operation, key) = signed_operation("staging", now);
    let AgentOperation::Upgrade(parameters) = &mut operation.payload else {
        panic!("upgrade payload")
    };
    parameters.release = release;
    operation.signature = BASE64.encode(
        signing_key
            .sign(&operation.signing_bytes().unwrap())
            .to_bytes(),
    );
    operation
        .verify("staging", now, &key)
        .expect("valid signature");

    let AgentOperation::Upgrade(parameters) = &mut operation.payload else {
        panic!("upgrade payload")
    };
    parameters.release.retained_agent_bundle_images.clear();
    assert!(
        operation.verify("staging", now, &key).is_err(),
        "dropping a retained bundle breaks the signature"
    );
}

#[test]
fn every_bundle_in_a_release_must_be_digest_pinned() {
    assert!(
        release_with_bundles(Some(bundle('d', "")), vec![bundle('e', ":v1")])
            .has_immutable_images()
    );
    assert!(!release_with_bundles(
        Some("ghcr.io/cognia/cognia-agent-bundle:latest".into()),
        Vec::new()
    )
    .has_immutable_images());
    assert!(!release_with_bundles(
        Some(bundle('d', "")),
        vec!["ghcr.io/cognia/cognia-agent-bundle:v1".into()]
    )
    .has_immutable_images());
}

#[test]
fn retained_bundles_need_a_current_bundle_a_limit_and_distinct_digests() {
    assert_eq!(
        release_with_bundles(None, Vec::new()).agent_bundle_problem(),
        None
    );
    assert_eq!(
        release_with_bundles(
            Some(bundle('d', "")),
            vec![bundle('e', ""), bundle('f', "")]
        )
        .agent_bundle_problem(),
        None
    );
    assert!(release_with_bundles(None, vec![bundle('e', "")])
        .agent_bundle_problem()
        .is_some());
    assert!(release_with_bundles(
        Some(bundle('d', "")),
        vec![bundle('e', ""), bundle('f', ""), bundle('0', "")]
    )
    .agent_bundle_problem()
    .is_some());
    // The same digest under another tag is the same bundle.
    assert!(
        release_with_bundles(Some(bundle('d', ":v2")), vec![bundle('d', "")])
            .agent_bundle_problem()
            .is_some()
    );
    assert!(release_with_bundles(
        Some(bundle('d', "")),
        vec![bundle('e', ":v1"), bundle('E', "")]
    )
    .agent_bundle_problem()
    .is_some());
}

#[test]
fn image_digest_normalises_case_and_refuses_tags() {
    assert_eq!(
        cognia_deployment::image_digest(&format!("repo:v1@sha256:{}", "AB".repeat(32))),
        Some(format!("sha256:{}", "ab".repeat(32)))
    );
    assert_eq!(cognia_deployment::image_digest("repo:v1"), None);
    assert_eq!(
        cognia_deployment::image_digest(&format!("repo@sha256:{}", "g".repeat(64))),
        None
    );
    assert_eq!(
        cognia_deployment::image_digest(&format!("repo@sha256:{}", "a".repeat(63))),
        None
    );
}
