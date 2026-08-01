use cognia_deployment::DeploymentTopology;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use url::Url;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentConfig {
    pub api_version: String,
    pub agent_id: String,
    pub target_id: String,
    pub controller_url: Url,
    pub controller_signing_key: String,
    pub controller_signing_key_id: String,
    pub certificate_expires_at: i64,
    pub state_file: PathBuf,
    pub tls: TlsClientConfig,
    pub platform: PlatformConfig,
}

impl AgentConfig {
    pub async fn load(path: &Path) -> anyhow::Result<Self> {
        let bytes = tokio::fs::read(path).await?;
        let config: Self = serde_yaml::from_slice(&bytes)?;
        if config.api_version != "deploy.cognia.dev/agent-config/v1alpha1" {
            anyhow::bail!("unsupported agent config version `{}`", config.api_version);
        }
        Ok(config)
    }

    pub fn topology(&self) -> DeploymentTopology {
        match &self.platform {
            PlatformConfig::Compose(_) => DeploymentTopology::Compose,
            PlatformConfig::Kubernetes(_) => DeploymentTopology::Kubernetes,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TlsClientConfig {
    pub certificate_file: PathBuf,
    pub private_key_file: PathBuf,
    pub ca_file: Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "topology", rename_all = "kebab-case")]
pub enum PlatformConfig {
    Compose(ComposeConfig),
    Kubernetes(KubernetesConfig),
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComposeConfig {
    pub deployment_root: PathBuf,
    pub runtime_override_file: PathBuf,
    #[serde(default)]
    pub snapshot_adapter: Option<ExternalSnapshotAdapterConfig>,
    pub public_url: Url,
    pub docker_binary: PathBuf,
    pub project_name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSnapshotAdapterConfig {
    pub binary: PathBuf,
    pub adapter_ref: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KubernetesConfig {
    pub kubectl_binary: PathBuf,
    pub namespace: String,
    pub public_url: Url,
    pub maintenance_image: String,
    pub data_pvc_name: String,
    pub snapshot_class_name: String,
    pub restore_storage_class_name: String,
    pub restore_storage_size: String,
}
