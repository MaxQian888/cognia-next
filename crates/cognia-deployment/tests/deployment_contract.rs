use cognia_deployment::{
    DeploymentTarget, OperationKind, OperationState, ProductionCertificationIssue,
};

fn valid_yaml() -> String {
    format!(
        r#"
apiVersion: deploy.cognia.dev/v1alpha1
kind: DeploymentTarget
metadata:
  id: staging
  label: Staging
spec:
  topology: kubernetes
  publicUrl: https://server.example.com
  controller:
    url: https://ops.example.com
    credentialRef: ops-controller/staging
  identity:
    provider: oidc
    issuer: https://auth.example.com/oidc
    audience: https://server.example.com/api
    tenantClaim: organization_id
    scopes:
      read: servers:read
      operate: servers:operate
      admin: servers:admin
  objectStore:
    provider: s3-compatible
    endpoint: https://s3.example.com
    region: auto
    bucket: cognia-backups
    pathStyle: false
    credentialRef: backups/staging
  snapshots:
    provider: kubernetes-csi
    className: cognia-snapshots
  tls:
    provider: ingress
    secretRef: cognia-server-tls
  secrets:
    provider: kubernetes
    rootRef: cognia/staging
  images:
    server: ghcr.io/owner/cognia-server@sha256:{server}
    runner: ghcr.io/owner/cognia-runner@sha256:{runner}
    workspaceRuntime: ghcr.io/owner/cognia-workspace-runtime@sha256:{runtime}
"#,
        server = "a".repeat(64),
        runner = "b".repeat(64),
        runtime = "c".repeat(64),
    )
}

#[test]
fn parses_cloud_neutral_target_and_rejects_unknown_fields() {
    let target: DeploymentTarget = serde_yaml::from_str(&valid_yaml()).unwrap();
    assert_eq!(target.metadata.id, "staging");
    assert!(target.production_certification_issues().is_empty());

    let invalid = valid_yaml().replace(
        "  topology: kubernetes",
        "  topology: kubernetes\n  cloudProvider: aws",
    );
    let error = serde_yaml::from_str::<DeploymentTarget>(&invalid).unwrap_err();
    assert!(error.to_string().contains("cloudProvider"));
}

#[test]
fn production_certification_requires_digest_and_snapshot_provider() {
    let yaml = valid_yaml()
        .replace(
            &format!("ghcr.io/owner/cognia-server@sha256:{}", "a".repeat(64)),
            "ghcr.io/owner/cognia-server:latest",
        )
        .replace(
            "  snapshots:\n    provider: kubernetes-csi\n    className: cognia-snapshots",
            "  snapshots:\n    provider: none",
        );
    let target: DeploymentTarget = serde_yaml::from_str(&yaml).unwrap();
    assert_eq!(
        target.production_certification_issues(),
        vec![
            ProductionCertificationIssue::MutableImage { image: "server" },
            ProductionCertificationIssue::SnapshotProviderMissing,
        ]
    );
}

#[test]
fn operation_state_machine_rejects_skipped_and_terminal_transitions() {
    assert!(OperationState::Queued.can_transition_to(OperationState::Validating));
    assert!(!OperationState::Queued.can_transition_to(OperationState::Executing));
    assert!(OperationState::Executing.can_transition_to(OperationState::Verifying));
    assert!(OperationState::Executing.can_transition_to(OperationState::RolledBack));
    assert!(!OperationState::Succeeded.can_transition_to(OperationState::Failed));

    assert!(OperationKind::Restore.requires_admin_lease());
    assert!(OperationKind::Rollback.requires_admin_lease());
    assert!(!OperationKind::Backup.requires_admin_lease());
}
