//! Cloud-neutral deployment contracts shared by the controller and deploy agent.

use serde::{Deserialize, Serialize};
use url::Url;

pub mod agent_protocol;

const IMMUTABLE_DIGEST_LEN: usize = 64;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeploymentTarget {
    #[serde(rename = "apiVersion")]
    pub api_version: DeploymentApiVersion,
    pub kind: DeploymentKind,
    pub metadata: DeploymentMetadata,
    pub spec: DeploymentSpec,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub enum DeploymentApiVersion {
    #[serde(rename = "deploy.cognia.dev/v1alpha1")]
    V1Alpha1,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub enum DeploymentKind {
    DeploymentTarget,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeploymentMetadata {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeploymentSpec {
    pub topology: DeploymentTopology,
    pub public_url: Url,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compose: Option<ComposePlatformConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kubernetes: Option<KubernetesPlatformConfig>,
    pub controller: ControllerConfig,
    pub identity: IdentityConfig,
    pub object_store: ObjectStoreConfig,
    pub snapshots: SnapshotConfig,
    pub tls: TlsConfig,
    pub secrets: SecretConfig,
    pub images: ImageConfig,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawDeploymentSpec {
    topology: DeploymentTopology,
    public_url: Url,
    compose: Option<ComposePlatformConfig>,
    kubernetes: Option<KubernetesPlatformConfig>,
    controller: ControllerConfig,
    identity: IdentityConfig,
    object_store: ObjectStoreConfig,
    snapshots: SnapshotConfig,
    tls: TlsConfig,
    secrets: SecretConfig,
    images: ImageConfig,
}

impl<'de> Deserialize<'de> for DeploymentSpec {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = RawDeploymentSpec::deserialize(deserializer)?;
        match (
            raw.topology,
            raw.compose.is_some(),
            raw.kubernetes.is_some(),
        ) {
            (DeploymentTopology::Compose, true, false)
            | (DeploymentTopology::Kubernetes, false, true) => {}
            (DeploymentTopology::Compose, false, _) => {
                return Err(serde::de::Error::custom(
                    "compose configuration is required for compose topology",
                ));
            }
            (DeploymentTopology::Kubernetes, _, false) => {
                return Err(serde::de::Error::custom(
                    "kubernetes configuration is required for kubernetes topology",
                ));
            }
            (DeploymentTopology::Compose, true, true) => {
                return Err(serde::de::Error::custom(
                    "kubernetes configuration is not allowed for compose topology",
                ));
            }
            (DeploymentTopology::Kubernetes, true, true) => {
                return Err(serde::de::Error::custom(
                    "compose configuration is not allowed for kubernetes topology",
                ));
            }
        }
        Ok(Self {
            topology: raw.topology,
            public_url: raw.public_url,
            compose: raw.compose,
            kubernetes: raw.kubernetes,
            controller: raw.controller,
            identity: raw.identity,
            object_store: raw.object_store,
            snapshots: raw.snapshots,
            tls: raw.tls,
            secrets: raw.secrets,
            images: raw.images,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComposePlatformConfig {
    pub project_name: String,
    pub deployment_root: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KubernetesPlatformConfig {
    pub namespace: String,
    pub ingress_class_name: String,
    pub storage_class_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_class_name: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeploymentTopology {
    Compose,
    Kubernetes,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControllerConfig {
    pub url: Url,
    pub credential_ref: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityConfig {
    pub provider: OidcProvider,
    pub issuer: Url,
    pub audience: String,
    pub tenant_claim: String,
    pub scopes: IdentityScopes,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub enum OidcProvider {
    #[serde(rename = "oidc")]
    Oidc,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IdentityScopes {
    pub read: String,
    pub operate: String,
    pub admin: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectStoreConfig {
    pub provider: S3Provider,
    pub endpoint: Url,
    pub region: String,
    pub bucket: String,
    pub path_style: bool,
    pub credential_ref: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub enum S3Provider {
    #[serde(rename = "s3-compatible")]
    S3Compatible,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "provider", rename_all = "kebab-case", deny_unknown_fields)]
pub enum SnapshotConfig {
    KubernetesCsi {
        #[serde(rename = "className")]
        class_name: String,
    },
    ExternalCommand {
        #[serde(rename = "adapterRef")]
        adapter_ref: String,
    },
    None,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "provider", rename_all = "kebab-case", deny_unknown_fields)]
pub enum TlsConfig {
    Ingress {
        #[serde(rename = "secretRef")]
        secret_ref: String,
    },
    AcmeHttp01,
    AcmeDns01 {
        #[serde(rename = "credentialRef")]
        credential_ref: String,
    },
    Existing {
        #[serde(rename = "secretRef")]
        secret_ref: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "provider", rename_all = "kebab-case", deny_unknown_fields)]
pub enum SecretConfig {
    File {
        #[serde(rename = "rootRef")]
        root_ref: String,
    },
    Kubernetes {
        #[serde(rename = "rootRef")]
        root_ref: String,
    },
    Vault {
        #[serde(rename = "rootRef")]
        root_ref: String,
    },
    AwsSecretsManager {
        #[serde(rename = "rootRef")]
        root_ref: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageConfig {
    pub server: String,
    pub runner: String,
    pub workspace_runtime: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProductionCertificationIssue {
    MutableImage { image: &'static str },
    SnapshotProviderMissing,
}

impl DeploymentTarget {
    pub fn production_certification_issues(&self) -> Vec<ProductionCertificationIssue> {
        let mut issues = Vec::new();
        for (name, image) in [
            ("server", self.spec.images.server.as_str()),
            ("runner", self.spec.images.runner.as_str()),
            (
                "workspaceRuntime",
                self.spec.images.workspace_runtime.as_str(),
            ),
        ] {
            if !is_digest_image(image) {
                issues.push(ProductionCertificationIssue::MutableImage { image: name });
            }
        }
        if matches!(self.spec.snapshots, SnapshotConfig::None) {
            issues.push(ProductionCertificationIssue::SnapshotProviderMissing);
        }
        issues
    }

    pub fn snapshot_class_name(&self) -> Option<&str> {
        match &self.spec.snapshots {
            SnapshotConfig::KubernetesCsi { class_name } => Some(class_name),
            _ => None,
        }
    }

    pub fn snapshot_adapter_ref(&self) -> Option<&str> {
        match &self.spec.snapshots {
            SnapshotConfig::ExternalCommand { adapter_ref } => Some(adapter_ref),
            _ => None,
        }
    }
}

fn is_digest_image(image: &str) -> bool {
    let Some((_, digest)) = image.rsplit_once("@sha256:") else {
        return false;
    };
    digest.len() == IMMUTABLE_DIGEST_LEN && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperationKind {
    Preflight,
    Deploy,
    Upgrade,
    Rollback,
    Backup,
    Restore,
    RotateKey,
    CollectStatus,
    CollectLogs,
}

impl OperationKind {
    pub fn requires_admin_lease(self) -> bool {
        matches!(self, Self::Rollback | Self::Restore | Self::RotateKey)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationState {
    Queued,
    Validating,
    Preparing,
    Executing,
    Verifying,
    Succeeded,
    Failed,
    RolledBack,
    RollbackFailed,
    Cancelled,
}

impl OperationState {
    pub fn can_transition_to(self, next: Self) -> bool {
        use OperationState as S;
        matches!(
            (self, next),
            (S::Queued, S::Validating | S::Failed | S::Cancelled)
                | (S::Validating, S::Preparing | S::Failed | S::Cancelled)
                | (S::Preparing, S::Executing | S::Failed | S::Cancelled)
                | (
                    S::Executing,
                    S::Verifying | S::Failed | S::RolledBack | S::RollbackFailed
                )
                | (
                    S::Verifying,
                    S::Succeeded | S::Failed | S::RolledBack | S::RollbackFailed
                )
        )
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded
                | Self::Failed
                | Self::RolledBack
                | Self::RollbackFailed
                | Self::Cancelled
        )
    }
}
