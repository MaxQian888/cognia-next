use async_trait::async_trait;
use cognia_deployment::agent_protocol::AgentRelease;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;
use url::Url;

use crate::{ComposeConfig, KubernetesConfig, PlatformConfig};

#[derive(Debug, thiserror::Error)]
pub enum DriverError {
    #[error("platform command failed: {0}")]
    Command(String),
    #[error("readiness verification failed: {0}")]
    Readiness(String),
    #[error("platform configuration is invalid: {0}")]
    Configuration(String),
}

#[async_trait]
pub trait Driver: Send + Sync {
    async fn preflight(&self, target_revision: i64) -> Result<Value, DriverError>;
    async fn activate_release(&self, release: &AgentRelease) -> Result<(), DriverError>;
    async fn strict_smoke(&self, release: &AgentRelease) -> Result<Value, DriverError>;
    async fn backup(&self, backup_id: &str) -> Result<Value, DriverError>;
    async fn restore(
        &self,
        recovery_point_id: &str,
        destination_volume_id: &str,
    ) -> Result<Value, DriverError>;
    async fn rotate_key(&self, key_version: &str) -> Result<Value, DriverError>;
    async fn collect_status(&self, include_runtime_usage: bool) -> Result<Value, DriverError>;
    async fn collect_logs(
        &self,
        after_event_id: Option<i64>,
        limit: u16,
    ) -> Result<Value, DriverError>;
}

pub enum PlatformDriver {
    Compose(ComposeDriver),
    Kubernetes(KubernetesDriver),
}

impl PlatformDriver {
    pub fn from_config(config: PlatformConfig) -> Result<Self, DriverError> {
        match config {
            PlatformConfig::Compose(config) => ComposeDriver::new(config).map(Self::Compose),
            PlatformConfig::Kubernetes(config) => {
                KubernetesDriver::new(config).map(Self::Kubernetes)
            }
        }
    }
}

#[async_trait]
impl Driver for PlatformDriver {
    async fn preflight(&self, target_revision: i64) -> Result<Value, DriverError> {
        match self {
            Self::Compose(driver) => driver.preflight(target_revision).await,
            Self::Kubernetes(driver) => driver.preflight(target_revision).await,
        }
    }

    async fn activate_release(&self, release: &AgentRelease) -> Result<(), DriverError> {
        match self {
            Self::Compose(driver) => driver.activate_release(release).await,
            Self::Kubernetes(driver) => driver.activate_release(release).await,
        }
    }

    async fn strict_smoke(&self, release: &AgentRelease) -> Result<Value, DriverError> {
        match self {
            Self::Compose(driver) => driver.strict_smoke(release).await,
            Self::Kubernetes(driver) => driver.strict_smoke(release).await,
        }
    }

    async fn backup(&self, backup_id: &str) -> Result<Value, DriverError> {
        match self {
            Self::Compose(driver) => driver.backup(backup_id).await,
            Self::Kubernetes(driver) => driver.backup(backup_id).await,
        }
    }

    async fn restore(
        &self,
        recovery_point_id: &str,
        destination_volume_id: &str,
    ) -> Result<Value, DriverError> {
        match self {
            Self::Compose(driver) => {
                driver
                    .restore(recovery_point_id, destination_volume_id)
                    .await
            }
            Self::Kubernetes(driver) => {
                driver
                    .restore(recovery_point_id, destination_volume_id)
                    .await
            }
        }
    }

    async fn rotate_key(&self, key_version: &str) -> Result<Value, DriverError> {
        match self {
            Self::Compose(driver) => driver.rotate_key(key_version).await,
            Self::Kubernetes(driver) => driver.rotate_key(key_version).await,
        }
    }

    async fn collect_status(&self, include_runtime_usage: bool) -> Result<Value, DriverError> {
        match self {
            Self::Compose(driver) => driver.collect_status(include_runtime_usage).await,
            Self::Kubernetes(driver) => driver.collect_status(include_runtime_usage).await,
        }
    }

    async fn collect_logs(
        &self,
        after_event_id: Option<i64>,
        limit: u16,
    ) -> Result<Value, DriverError> {
        match self {
            Self::Compose(driver) => driver.collect_logs(after_event_id, limit).await,
            Self::Kubernetes(driver) => driver.collect_logs(after_event_id, limit).await,
        }
    }
}

pub struct ComposeDriver {
    root: PathBuf,
    docker: PathBuf,
    project_name: String,
    public_url: Url,
    client: reqwest::Client,
}

impl ComposeDriver {
    pub fn new(config: ComposeConfig) -> Result<Self, DriverError> {
        let root = canonical_directory(&config.deployment_root)?;
        Ok(Self {
            root,
            docker: config.docker_binary,
            project_name: config.project_name,
            public_url: config.public_url,
            client: smoke_client()?,
        })
    }

    async fn compose(
        &self,
        args: &[&str],
        release: Option<&AgentRelease>,
    ) -> Result<Value, DriverError> {
        let mut command = Command::new(&self.docker);
        command
            .current_dir(&self.root)
            .arg("compose")
            .arg("--project-name")
            .arg(&self.project_name)
            .arg("-f")
            .arg("compose.yaml")
            .arg("-f")
            .arg("compose.production.yaml")
            .args(args)
            .kill_on_drop(true);
        if let Some(release) = release {
            command
                .env("COGNIA_SERVER_IMAGE", &release.server_image)
                .env("COGNIA_RUNNER_IMAGE", &release.runner_image)
                .env(
                    "COGNIA_WORKSPACE_RUNTIME_IMAGE",
                    &release.workspace_runtime_image,
                )
                .env("COGNIA_CONFIG_REVISION", &release.config_revision);
        }
        command_json(command).await
    }
}

#[async_trait]
impl Driver for ComposeDriver {
    async fn preflight(&self, target_revision: i64) -> Result<Value, DriverError> {
        let mut version_command = Command::new(&self.docker);
        version_command.arg("compose").arg("version");
        let version = command_json(version_command).await?;
        let config = self.compose(&["config", "--quiet"], None).await?;
        Ok(json!({ "targetRevision": target_revision, "docker": version, "config": config }))
    }

    async fn activate_release(&self, release: &AgentRelease) -> Result<(), DriverError> {
        self.compose(
            &[
                "up",
                "-d",
                "--remove-orphans",
                "--wait",
                "--wait-timeout",
                "300",
            ],
            Some(release),
        )
        .await?;
        Ok(())
    }

    async fn strict_smoke(&self, release: &AgentRelease) -> Result<Value, DriverError> {
        http_strict_smoke(&self.client, &self.public_url, release).await
    }

    async fn backup(&self, backup_id: &str) -> Result<Value, DriverError> {
        self.compose(
            &[
                "exec",
                "-T",
                "cognia-server",
                "cognia-server",
                "backup",
                "--id",
                backup_id,
            ],
            None,
        )
        .await
    }

    async fn restore(
        &self,
        recovery_point_id: &str,
        destination_volume_id: &str,
    ) -> Result<Value, DriverError> {
        self.compose(
            &[
                "run",
                "--rm",
                "cognia-server",
                "cognia-server",
                "restore",
                "--recovery-point",
                recovery_point_id,
                "--destination-volume",
                destination_volume_id,
                "--read-only-smoke",
            ],
            None,
        )
        .await
    }

    async fn rotate_key(&self, key_version: &str) -> Result<Value, DriverError> {
        self.compose(
            &[
                "exec",
                "-T",
                "cognia-server",
                "cognia-server",
                "rotate-key",
                "--version",
                key_version,
            ],
            None,
        )
        .await
    }

    async fn collect_status(&self, include_runtime_usage: bool) -> Result<Value, DriverError> {
        let mut args = vec!["ps", "--format", "json"];
        if include_runtime_usage {
            args.push("--all");
        }
        self.compose(&args, None).await
    }

    async fn collect_logs(
        &self,
        _after_event_id: Option<i64>,
        limit: u16,
    ) -> Result<Value, DriverError> {
        let limit = limit.min(1000).to_string();
        self.compose(
            &["logs", "--no-color", "--tail", &limit, "cognia-server"],
            None,
        )
        .await
    }
}

pub struct KubernetesDriver {
    kubectl: PathBuf,
    namespace: String,
    public_url: Url,
    maintenance_image: String,
    client: reqwest::Client,
}

impl KubernetesDriver {
    pub fn new(config: KubernetesConfig) -> Result<Self, DriverError> {
        if !config.maintenance_image.contains("@sha256:") {
            return Err(DriverError::Configuration(
                "maintenance image must be digest-pinned".into(),
            ));
        }
        Ok(Self {
            kubectl: config.kubectl_binary,
            namespace: config.namespace,
            public_url: config.public_url,
            maintenance_image: config.maintenance_image,
            client: smoke_client()?,
        })
    }

    async fn kubectl(&self, args: &[&str]) -> Result<Value, DriverError> {
        let mut command = Command::new(&self.kubectl);
        command
            .arg("--namespace")
            .arg(&self.namespace)
            .args(args)
            .kill_on_drop(true);
        command_json(command).await
    }
}

#[async_trait]
impl Driver for KubernetesDriver {
    async fn preflight(&self, target_revision: i64) -> Result<Value, DriverError> {
        let version = self.kubectl(&["version", "--client", "-o", "json"]).await?;
        let access = self
            .kubectl(&["auth", "can-i", "update", "statefulset/cognia-server"])
            .await?;
        Ok(json!({ "targetRevision": target_revision, "kubectl": version, "access": access }))
    }

    async fn activate_release(&self, release: &AgentRelease) -> Result<(), DriverError> {
        self.kubectl(&[
            "set",
            "image",
            "statefulset/cognia-server",
            &format!("server={}", release.server_image),
            &format!("runner={}", release.runner_image),
        ])
        .await?;
        self.kubectl(&[
            "set",
            "image",
            "deployment/cognia-workspace-runtime",
            &format!("runtime={}", release.workspace_runtime_image),
        ])
        .await?;
        self.kubectl(&[
            "rollout",
            "status",
            "statefulset/cognia-server",
            "--timeout=300s",
        ])
        .await?;
        Ok(())
    }

    async fn strict_smoke(&self, release: &AgentRelease) -> Result<Value, DriverError> {
        http_strict_smoke(&self.client, &self.public_url, release).await
    }

    async fn backup(&self, backup_id: &str) -> Result<Value, DriverError> {
        let job_name = safe_resource_name("backup", backup_id)?;
        self.kubectl(&[
            "create",
            "job",
            &job_name,
            &format!("--image={}", self.maintenance_image),
            "--",
            "cognia-server",
            "backup",
            "--id",
            backup_id,
        ])
        .await
    }

    async fn restore(
        &self,
        recovery_point_id: &str,
        destination_volume_id: &str,
    ) -> Result<Value, DriverError> {
        let job_name = safe_resource_name("restore", recovery_point_id)?;
        self.kubectl(&[
            "create",
            "job",
            &job_name,
            &format!("--image={}", self.maintenance_image),
            "--",
            "cognia-server",
            "restore",
            "--recovery-point",
            recovery_point_id,
            "--destination-volume",
            destination_volume_id,
            "--read-only-smoke",
        ])
        .await
    }

    async fn rotate_key(&self, key_version: &str) -> Result<Value, DriverError> {
        let job_name = safe_resource_name("rotate-key", key_version)?;
        self.kubectl(&[
            "create",
            "job",
            &job_name,
            &format!("--image={}", self.maintenance_image),
            "--",
            "cognia-server",
            "rotate-key",
            "--version",
            key_version,
        ])
        .await
    }

    async fn collect_status(&self, include_runtime_usage: bool) -> Result<Value, DriverError> {
        let resources = if include_runtime_usage {
            "statefulset,pods,pvc,jobs"
        } else {
            "statefulset,pods"
        };
        self.kubectl(&["get", resources, "-o", "json"]).await
    }

    async fn collect_logs(
        &self,
        _after_event_id: Option<i64>,
        limit: u16,
    ) -> Result<Value, DriverError> {
        self.kubectl(&[
            "logs",
            "statefulset/cognia-server",
            "--tail",
            &limit.min(1000).to_string(),
        ])
        .await
    }
}

fn canonical_directory(path: &Path) -> Result<PathBuf, DriverError> {
    let canonical = path
        .canonicalize()
        .map_err(|error| DriverError::Configuration(error.to_string()))?;
    if !canonical.is_dir() {
        return Err(DriverError::Configuration(format!(
            "{} is not a directory",
            canonical.display()
        )));
    }
    Ok(canonical)
}

fn smoke_client() -> Result<reqwest::Client, DriverError> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| DriverError::Configuration(error.to_string()))
}

async fn http_strict_smoke(
    client: &reqwest::Client,
    public_url: &Url,
    release: &AgentRelease,
) -> Result<Value, DriverError> {
    let ready_url = public_url
        .join("/api/v1/readyz")
        .map_err(|error| DriverError::Configuration(error.to_string()))?;
    let response = client
        .get(ready_url)
        .header(
            "x-cognia-expected-config-revision",
            &release.config_revision,
        )
        .send()
        .await
        .map_err(|error| DriverError::Readiness(error.to_string()))?;
    if !response.status().is_success() {
        return Err(DriverError::Readiness(format!(
            "readyz returned {}",
            response.status()
        )));
    }
    response
        .json()
        .await
        .map_err(|error| DriverError::Readiness(error.to_string()))
}

async fn command_json(mut command: Command) -> Result<Value, DriverError> {
    let output = command
        .output()
        .await
        .map_err(|error| DriverError::Command(error.to_string()))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if !output.status.success() {
        return Err(DriverError::Command(format!(
            "exit={:?}; stderr={stderr}",
            output.status.code()
        )));
    }
    Ok(json!({ "stdout": stdout, "stderr": stderr }))
}

fn safe_resource_name(prefix: &str, value: &str) -> Result<String, DriverError> {
    if value.is_empty()
        || value.len() > 48
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(DriverError::Configuration(
            "operation identifier is not a DNS-safe resource name".into(),
        ));
    }
    Ok(format!("{prefix}-{value}"))
}
