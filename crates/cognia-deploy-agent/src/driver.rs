use async_trait::async_trait;
use cognia_deployment::agent_protocol::AgentRelease;
use cognia_deployment::{DeploymentTarget, DeploymentTopology, SecretConfig, TlsConfig};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use url::Url;

use crate::{ComposeConfig, ExternalSnapshotAdapterConfig, KubernetesConfig, PlatformConfig};

const SNAPSHOT_ADAPTER_PROTOCOL: &str = "deploy.cognia.dev/snapshot-adapter/v1alpha1";

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
    async fn activate_release(
        &self,
        release: &AgentRelease,
        target: &DeploymentTarget,
    ) -> Result<(), DriverError>;
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

    async fn activate_release(
        &self,
        release: &AgentRelease,
        target: &DeploymentTarget,
    ) -> Result<(), DriverError> {
        match self {
            Self::Compose(driver) => driver.activate_release(release, target).await,
            Self::Kubernetes(driver) => driver.activate_release(release, target).await,
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

struct ExternalSnapshotAdapter {
    binary: PathBuf,
    adapter_ref: String,
}

impl ExternalSnapshotAdapter {
    fn new(config: ExternalSnapshotAdapterConfig) -> Result<Self, DriverError> {
        let binary = config.binary.canonicalize().map_err(|error| {
            DriverError::Configuration(format!("resolve snapshot adapter binary: {error}"))
        })?;
        if !binary.is_file() || config.adapter_ref.trim().is_empty() {
            return Err(DriverError::Configuration(
                "snapshot adapter requires a regular binary and non-empty adapter reference".into(),
            ));
        }
        Ok(Self {
            binary,
            adapter_ref: config.adapter_ref,
        })
    }

    async fn execute(&self, request: Value) -> Result<Value, DriverError> {
        let mut command = Command::new(&self.binary);
        command
            .arg("--protocol")
            .arg(SNAPSHOT_ADAPTER_PROTOCOL)
            .stdin(Stdio::piped())
            .kill_on_drop(true);
        let output = command_json_input(
            command,
            serde_json::to_vec(&request)
                .map_err(|error| DriverError::Configuration(error.to_string()))?,
        )
        .await?;
        parse_stdout_json(output)
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExternalSnapshotRecoveryPoint {
    id: String,
    kind: String,
    manifest_sha256: String,
    size_bytes: i64,
    verified: bool,
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExternalSnapshotCreateResult {
    recovery_point: ExternalSnapshotRecoveryPoint,
}

impl ExternalSnapshotCreateResult {
    fn validate(&self, expected_id: &str) -> Result<(), DriverError> {
        let point = &self.recovery_point;
        if point.id != expected_id
            || point.kind != "snapshot"
            || !point.verified
            || point.size_bytes < 0
            || point.manifest_sha256.len() != 64
            || !point
                .manifest_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(DriverError::Command(
                "snapshot adapter returned an invalid or unverified recovery point".into(),
            ));
        }
        Ok(())
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExternalSnapshotRestoreResult {
    volume_name: String,
    verified: bool,
    verification: Value,
}

pub struct ComposeDriver {
    root: PathBuf,
    runtime_override_file: PathBuf,
    docker: PathBuf,
    project_name: String,
    snapshot_adapter: Option<ExternalSnapshotAdapter>,
    public_url: Url,
    client: reqwest::Client,
}

impl ComposeDriver {
    pub fn new(config: ComposeConfig) -> Result<Self, DriverError> {
        let root = canonical_directory(&config.deployment_root)?;
        initialize_runtime_override(&config.runtime_override_file)?;
        let snapshot_adapter = config
            .snapshot_adapter
            .map(ExternalSnapshotAdapter::new)
            .transpose()?;
        Ok(Self {
            root,
            runtime_override_file: config.runtime_override_file,
            docker: config.docker_binary,
            project_name: config.project_name,
            snapshot_adapter,
            public_url: config.public_url,
            client: smoke_client()?,
        })
    }

    async fn compose(
        &self,
        args: &[&str],
        release: Option<(&AgentRelease, &DeploymentTarget)>,
    ) -> Result<Value, DriverError> {
        let mut command = Command::new(&self.docker);
        command
            .current_dir(&self.root)
            .arg("compose")
            .arg("--profile")
            .arg("server")
            .arg("--project-name")
            .arg(&self.project_name)
            .arg("-f")
            .arg("docker-compose.yml")
            .arg("-f")
            .arg("compose.production.yaml")
            .arg("-f")
            .arg(&self.runtime_override_file)
            .kill_on_drop(true);
        if let Some((release, target)) = release {
            self.validate_target(target)?;
            if matches!(
                target.spec.tls,
                TlsConfig::AcmeHttp01 | TlsConfig::Existing { .. }
            ) {
                command.arg("--profile").arg("tls");
            }
            let public_host = target.spec.public_url.host_str().ok_or_else(|| {
                DriverError::Configuration("public URL does not contain a host".into())
            })?;
            command
                .env("COGNIA_SERVER_IMAGE", &release.server_image)
                .env("COGNIA_RUNNER_IMAGE", &release.runner_image)
                .env(
                    "COGNIA_WORKSPACE_RUNTIME_IMAGE",
                    &release.workspace_runtime_image,
                )
                .env("COGNIA_CONFIG_REVISION", &release.config_revision)
                .env("COGNIA_PUBLIC_URL", target.spec.public_url.as_str())
                .env("COGNIA_DOMAIN", public_host)
                .env("COGNIA_LOGTO_ISSUER", target.spec.identity.issuer.as_str())
                .env("COGNIA_LOGTO_AUDIENCE", &target.spec.identity.audience)
                .env(
                    "COGNIA_LOGTO_REQUIRED_SCOPES",
                    [
                        target.spec.identity.scopes.read.as_str(),
                        target.spec.identity.scopes.operate.as_str(),
                        target.spec.identity.scopes.admin.as_str(),
                    ]
                    .join(" "),
                )
                .env(
                    "COGNIA_S3_ENDPOINT",
                    target.spec.object_store.endpoint.as_str(),
                )
                .env("COGNIA_S3_REGION", &target.spec.object_store.region)
                .env("COGNIA_S3_BUCKET", &target.spec.object_store.bucket)
                .env(
                    "COGNIA_S3_PATH_STYLE",
                    target.spec.object_store.path_style.to_string(),
                );
        }
        command.args(args);
        command_json(command).await
    }

    fn validate_target(&self, target: &DeploymentTarget) -> Result<(), DriverError> {
        if target.metadata.id.is_empty() || target.spec.topology != DeploymentTopology::Compose {
            return Err(DriverError::Configuration(
                "agent received a non-Compose deployment target".into(),
            ));
        }
        let platform = target.spec.compose.as_ref().ok_or_else(|| {
            DriverError::Configuration("Compose platform settings are missing".into())
        })?;
        let deployment_root = canonical_directory(Path::new(&platform.deployment_root))?;
        if deployment_root != self.root
            || platform.project_name != self.project_name
            || target.spec.public_url != self.public_url
        {
            return Err(DriverError::Configuration(
                "DeploymentTarget does not match the enrolled Compose allowlist".into(),
            ));
        }
        if !matches!(target.spec.secrets, SecretConfig::File { .. }) {
            return Err(DriverError::Configuration(
                "Compose currently requires the file SecretProvider".into(),
            ));
        }
        if matches!(target.spec.tls, TlsConfig::AcmeDns01 { .. }) {
            return Err(DriverError::Configuration(
                "Compose ACME DNS-01 requires a separately allowlisted Caddy DNS build".into(),
            ));
        }
        let configured_adapter = self
            .snapshot_adapter
            .as_ref()
            .map(|adapter| adapter.adapter_ref.as_str());
        if target.snapshot_adapter_ref() != configured_adapter {
            return Err(DriverError::Configuration(
                "snapshot adapter does not match the enrolled Compose allowlist".into(),
            ));
        }
        Ok(())
    }

    async fn create_external_snapshot(
        &self,
        backup_id: &str,
        result: &mut Value,
    ) -> Result<(), DriverError> {
        let Some(adapter) = &self.snapshot_adapter else {
            return Ok(());
        };
        let snapshot_id = safe_resource_name("snapshot", backup_id)?;
        let response = adapter
            .execute(json!({
                "apiVersion": SNAPSHOT_ADAPTER_PROTOCOL,
                "action": "create",
                "adapterRef": adapter.adapter_ref,
                "backupId": backup_id,
                "snapshotId": snapshot_id,
                "projectName": self.project_name
            }))
            .await?;
        let report: ExternalSnapshotCreateResult =
            serde_json::from_value(response).map_err(|error| {
                DriverError::Command(format!("invalid snapshot adapter result: {error}"))
            })?;
        report.validate(&snapshot_id)?;
        result
            .get_mut("recoveryPoints")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| DriverError::Command("backup result omitted recoveryPoints".into()))?
            .push(
                serde_json::to_value(report.recovery_point)
                    .map_err(|error| DriverError::Command(error.to_string()))?,
            );
        Ok(())
    }

    async fn restore_external_snapshot(
        &self,
        recovery_point_id: &str,
        volume_name: &str,
    ) -> Result<Value, DriverError> {
        let adapter = self.snapshot_adapter.as_ref().ok_or_else(|| {
            DriverError::Configuration(
                "snapshot recovery point requires a configured external snapshot adapter".into(),
            )
        })?;
        let response = adapter
            .execute(json!({
                "apiVersion": SNAPSHOT_ADAPTER_PROTOCOL,
                "action": "restore",
                "adapterRef": adapter.adapter_ref,
                "snapshotId": recovery_point_id,
                "destinationVolumeName": volume_name,
                "projectName": self.project_name
            }))
            .await?;
        let report: ExternalSnapshotRestoreResult =
            serde_json::from_value(response).map_err(|error| {
                DriverError::Command(format!("invalid snapshot adapter result: {error}"))
            })?;
        if report.volume_name != volume_name || !report.verified {
            return Err(DriverError::Command(
                "snapshot adapter did not verify the requested destination volume".into(),
            ));
        }
        Ok(report.verification)
    }
}

#[async_trait]
impl Driver for ComposeDriver {
    async fn preflight(&self, target_revision: i64) -> Result<Value, DriverError> {
        let mut version_command = Command::new(&self.docker);
        version_command.arg("compose").arg("version");
        let version = command_json(version_command).await?;
        let config = self.compose(&["config", "--quiet"], None).await?;
        Ok(json!({
            "targetRevision": target_revision,
            "docker": version,
            "config": config,
            "snapshotAdapter": self.snapshot_adapter.as_ref().map(|adapter| &adapter.adapter_ref)
        }))
    }

    async fn activate_release(
        &self,
        release: &AgentRelease,
        target: &DeploymentTarget,
    ) -> Result<(), DriverError> {
        self.compose(
            &[
                "up",
                "-d",
                "--remove-orphans",
                "--wait",
                "--wait-timeout",
                "300",
            ],
            Some((release, target)),
        )
        .await?;
        Ok(())
    }

    async fn strict_smoke(&self, release: &AgentRelease) -> Result<Value, DriverError> {
        http_strict_smoke(&self.client, &self.public_url, release).await
    }

    async fn backup(&self, backup_id: &str) -> Result<Value, DriverError> {
        let request = serde_json::to_string(&json!({ "backupId": backup_id }))
            .map_err(|error| DriverError::Configuration(error.to_string()))?;
        let output = self
            .compose(
                &[
                    "exec",
                    "-T",
                    "cognia-server",
                    "curl",
                    "--silent",
                    "--show-error",
                    "--fail",
                    "--insecure",
                    "--request",
                    "POST",
                    "--header",
                    "content-type: application/json",
                    "--data",
                    &request,
                    "https://127.0.0.1:27890/api/v1/maintenance/backups",
                ],
                None,
            )
            .await?;
        let mut result = parse_stdout_json(output)?;
        self.create_external_snapshot(backup_id, &mut result)
            .await?;
        Ok(result)
    }

    async fn restore(
        &self,
        recovery_point_id: &str,
        destination_volume_id: &str,
    ) -> Result<Value, DriverError> {
        let volume_name = safe_resource_name("cognia-restore", destination_volume_id)?;
        let verification = if recovery_point_id.starts_with("snapshot-") {
            self.restore_external_snapshot(recovery_point_id, &volume_name)
                .await?
        } else {
            let mut create_volume = Command::new(&self.docker);
            create_volume
                .arg("volume")
                .arg("create")
                .arg("--label")
                .arg(format!("dev.cognia.project={}", self.project_name))
                .arg(&volume_name)
                .kill_on_drop(true);
            command_json(create_volume).await?;
            let volume_mount = format!("{volume_name}:/restore");
            let output = self
                .compose(
                    &[
                        "run",
                        "--rm",
                        "--no-deps",
                        "--volume",
                        &volume_mount,
                        "cognia-server",
                        "cognia-server",
                        "restore",
                        "--recovery-point",
                        recovery_point_id,
                        "--destination-volume",
                        "/restore",
                        "--read-only-smoke",
                    ],
                    None,
                )
                .await?;
            parse_stdout_json(output)?
        };
        self.switch_data_volume(&volume_name).await?;
        Ok(json!({
            "verification": verification,
            "destinationVolumeId": volume_name,
            "trafficSwitched": true
        }))
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

impl ComposeDriver {
    async fn switch_data_volume(&self, volume_name: &str) -> Result<(), DriverError> {
        let previous = tokio::fs::read(&self.runtime_override_file)
            .await
            .map_err(|error| DriverError::Configuration(error.to_string()))?;
        self.compose(&["stop", "--timeout", "300", "cognia-server"], None)
            .await?;
        if let Err(error) = write_runtime_override(&self.runtime_override_file, volume_name).await {
            let _ = self
                .compose(&["up", "-d", "--no-deps", "cognia-server"], None)
                .await;
            return Err(error);
        }
        let activation = async {
            self.compose(
                &[
                    "up",
                    "-d",
                    "--no-deps",
                    "--wait",
                    "--wait-timeout",
                    "300",
                    "cognia-server",
                ],
                None,
            )
            .await?;
            http_ready_smoke(&self.client, &self.public_url).await?;
            Ok::<(), DriverError>(())
        }
        .await;
        if let Err(primary) = activation {
            restore_runtime_override(&self.runtime_override_file, &previous).await?;
            let rollback = self
                .compose(
                    &[
                        "up",
                        "-d",
                        "--no-deps",
                        "--wait",
                        "--wait-timeout",
                        "300",
                        "cognia-server",
                    ],
                    None,
                )
                .await;
            return match rollback {
                Ok(_) => Err(DriverError::Readiness(format!(
                    "restored volume failed readiness and the previous volume was reactivated: {primary}"
                ))),
                Err(rollback) => Err(DriverError::Readiness(format!(
                    "restored volume failed readiness: {primary}; reactivating the previous volume failed: {rollback}"
                ))),
            };
        }
        Ok(())
    }
}

pub struct KubernetesDriver {
    kubectl: PathBuf,
    namespace: String,
    public_url: Url,
    maintenance_image: String,
    data_pvc_name: String,
    snapshot_class_name: String,
    restore_storage_class_name: String,
    restore_storage_size: String,
    client: reqwest::Client,
}

impl KubernetesDriver {
    pub fn new(config: KubernetesConfig) -> Result<Self, DriverError> {
        if !config.maintenance_image.contains("@sha256:") {
            return Err(DriverError::Configuration(
                "maintenance image must be digest-pinned".into(),
            ));
        }
        for (name, value) in [
            ("data PVC", config.data_pvc_name.as_str()),
            ("snapshot class", config.snapshot_class_name.as_str()),
            (
                "restore storage class",
                config.restore_storage_class_name.as_str(),
            ),
        ] {
            validate_dns_name(name, value)?;
        }
        validate_storage_size(&config.restore_storage_size)?;
        Ok(Self {
            kubectl: config.kubectl_binary,
            namespace: config.namespace,
            public_url: config.public_url,
            maintenance_image: config.maintenance_image,
            data_pvc_name: config.data_pvc_name,
            snapshot_class_name: config.snapshot_class_name,
            restore_storage_class_name: config.restore_storage_class_name,
            restore_storage_size: config.restore_storage_size,
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

    async fn kubectl_input(&self, args: &[&str], input: &Value) -> Result<Value, DriverError> {
        let mut command = Command::new(&self.kubectl);
        command
            .arg("--namespace")
            .arg(&self.namespace)
            .args(args)
            .stdin(Stdio::piped())
            .kill_on_drop(true);
        command_json_input(
            command,
            serde_json::to_vec(input).map_err(|error| {
                DriverError::Configuration(format!("serialize Kubernetes resource: {error}"))
            })?,
        )
        .await
    }

    async fn apply_target(
        &self,
        target: &DeploymentTarget,
        release: &AgentRelease,
    ) -> Result<(), DriverError> {
        if target.metadata.id.is_empty() || target.spec.topology != DeploymentTopology::Kubernetes {
            return Err(DriverError::Configuration(
                "agent received a non-Kubernetes deployment target".into(),
            ));
        }
        let platform = target.spec.kubernetes.as_ref().ok_or_else(|| {
            DriverError::Configuration("Kubernetes platform settings are missing".into())
        })?;
        if platform.namespace != self.namespace
            || platform.storage_class_name != self.restore_storage_class_name
            || target.snapshot_class_name() != Some(self.snapshot_class_name.as_str())
            || target.spec.public_url != self.public_url
        {
            return Err(DriverError::Configuration(
                "DeploymentTarget does not match the enrolled Kubernetes allowlist".into(),
            ));
        }
        if !matches!(target.spec.secrets, SecretConfig::Kubernetes { .. }) {
            return Err(DriverError::Configuration(
                "Kubernetes currently requires the kubernetes SecretProvider".into(),
            ));
        }
        let tls_secret = match &target.spec.tls {
            TlsConfig::Ingress { secret_ref } | TlsConfig::Existing { secret_ref } => secret_ref,
            _ => {
                return Err(DriverError::Configuration(
                    "Kubernetes ACME targets require an external ingress certificate controller"
                        .into(),
                ))
            }
        };
        let scopes = [
            target.spec.identity.scopes.read.as_str(),
            target.spec.identity.scopes.operate.as_str(),
            target.spec.identity.scopes.admin.as_str(),
        ]
        .join(" ");
        let config_patch = json!({
            "data": {
                "publicUrl": target.spec.public_url.as_str(),
                "logtoIssuer": target.spec.identity.issuer.as_str(),
                "logtoAudience": target.spec.identity.audience,
                "logtoRequiredScopes": scopes,
                "runnerImage": release.runner_image,
                "workspaceRuntimeImage": release.workspace_runtime_image,
                "configRevision": release.config_revision,
                "objectStoreEndpoint": target.spec.object_store.endpoint.as_str(),
                "objectStoreRegion": target.spec.object_store.region,
                "objectStoreBucket": target.spec.object_store.bucket,
                "objectStorePathStyle": target.spec.object_store.path_style.to_string(),
                "backupKeyVersion": release.config_revision,
                "backupPrefix": target.metadata.id
            }
        });
        let config_patch = serde_json::to_string(&config_patch)
            .map_err(|error| DriverError::Configuration(error.to_string()))?;
        self.kubectl(&[
            "patch",
            "configmap/cognia-config",
            "--type=merge",
            "-p",
            &config_patch,
        ])
        .await?;

        let host = target.spec.public_url.host_str().ok_or_else(|| {
            DriverError::Configuration("public URL does not contain a host".into())
        })?;
        let ingress_patch = serde_json::to_string(&json!([
            { "op": "replace", "path": "/spec/ingressClassName", "value": platform.ingress_class_name },
            { "op": "replace", "path": "/spec/rules/0/host", "value": host },
            { "op": "replace", "path": "/spec/tls/0/hosts/0", "value": host },
            { "op": "replace", "path": "/spec/tls/0/secretName", "value": tls_secret }
        ]))
        .map_err(|error| DriverError::Configuration(error.to_string()))?;
        self.kubectl(&[
            "patch",
            "ingress/cognia-server",
            "--type=json",
            "-p",
            &ingress_patch,
        ])
        .await?;
        if let Some(runtime_class) = &platform.runtime_class_name {
            validate_dns_name("runtime class", runtime_class)?;
            let runtime_patch = serde_json::to_string(&json!([
                { "op": "add", "path": "/spec/template/spec/runtimeClassName", "value": runtime_class }
            ]))
            .map_err(|error| DriverError::Configuration(error.to_string()))?;
            self.kubectl(&[
                "patch",
                "statefulset/cognia-server",
                "--type=json",
                "-p",
                &runtime_patch,
            ])
            .await?;
        }
        Ok(())
    }

    async fn run_maintenance_job(&self, manifest: Value) -> Result<Value, DriverError> {
        let name = manifest
            .pointer("/metadata/name")
            .and_then(Value::as_str)
            .ok_or_else(|| DriverError::Configuration("maintenance Job has no name".into()))?
            .to_owned();
        self.kubectl_input(&["create", "-f", "-"], &manifest)
            .await?;
        let wait = self
            .kubectl(&[
                "wait",
                "--for=condition=complete",
                &format!("job/{name}"),
                "--timeout=300s",
            ])
            .await;
        let logs = self.kubectl(&["logs", &format!("job/{name}")]).await;
        let _ = self
            .kubectl(&["delete", "job", &name, "--wait=false"])
            .await;
        if let Err(error) = wait {
            return Err(DriverError::Command(format!(
                "maintenance Job {name} failed: {error}; logs={}",
                logs.ok()
                    .and_then(|value| value.get("stdout").cloned())
                    .unwrap_or(Value::Null)
            )));
        }
        parse_stdout_json(logs?)
    }

    async fn switch_data_volume(&self, pvc_name: &str) -> Result<(), DriverError> {
        let current = self
            .kubectl(&[
                "get",
                "statefulset/cognia-server",
                "-o",
                "jsonpath={.spec.template.spec.containers[0].volumeMounts[?(@.mountPath=='/data')].name}",
            ])
            .await?
            .get("stdout")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| DriverError::Configuration("server data volume mount not found".into()))?
            .to_owned();
        let volume_name = safe_resource_name("data", pvc_name)?;
        self.kubectl(&["scale", "statefulset/cognia-server", "--replicas=0"])
            .await?;
        let _ = self
            .kubectl(&[
                "wait",
                "--for=delete",
                "pod",
                "-l",
                "app=cognia-server",
                "--timeout=300s",
            ])
            .await;
        let patch = json!([
            {
                "op": "test",
                "path": "/spec/template/spec/containers/0/volumeMounts/0/mountPath",
                "value": "/data"
            },
            {
                "op": "replace",
                "path": "/spec/template/spec/containers/0/volumeMounts/0/name",
                "value": volume_name
            },
            {
                "op": "add",
                "path": "/spec/template/spec/volumes/-",
                "value": {
                    "name": volume_name,
                    "persistentVolumeClaim": { "claimName": pvc_name }
                }
            }
        ]);
        let patch_text = serde_json::to_string(&patch)
            .map_err(|error| DriverError::Configuration(error.to_string()))?;
        let switched = self
            .kubectl(&[
                "patch",
                "statefulset/cognia-server",
                "--type=json",
                "-p",
                &patch_text,
            ])
            .await;
        if let Err(error) = switched {
            let _ = self
                .kubectl(&["scale", "statefulset/cognia-server", "--replicas=1"])
                .await;
            return Err(error);
        }
        let activation = async {
            self.kubectl(&["scale", "statefulset/cognia-server", "--replicas=1"])
                .await?;
            self.kubectl(&[
                "rollout",
                "status",
                "statefulset/cognia-server",
                "--timeout=300s",
            ])
            .await?;
            http_ready_smoke(&self.client, &self.public_url).await?;
            Ok::<(), DriverError>(())
        }
        .await;
        if let Err(primary) = activation {
            let _ = self
                .kubectl(&["scale", "statefulset/cognia-server", "--replicas=0"])
                .await;
            let rollback = json!([
                {
                    "op": "replace",
                    "path": "/spec/template/spec/containers/0/volumeMounts/0/name",
                    "value": current
                }
            ]);
            let rollback_text = serde_json::to_string(&rollback)
                .map_err(|error| DriverError::Configuration(error.to_string()))?;
            let _ = self
                .kubectl(&[
                    "patch",
                    "statefulset/cognia-server",
                    "--type=json",
                    "-p",
                    &rollback_text,
                ])
                .await;
            let _ = self
                .kubectl(&["scale", "statefulset/cognia-server", "--replicas=1"])
                .await;
            return Err(DriverError::Readiness(format!(
                "restored volume failed readiness and traffic was rolled back: {primary}"
            )));
        }
        Ok(())
    }
}

#[async_trait]
impl Driver for KubernetesDriver {
    async fn preflight(&self, target_revision: i64) -> Result<Value, DriverError> {
        let version = self.kubectl(&["version", "--client", "-o", "json"]).await?;
        let access = self
            .kubectl(&["auth", "can-i", "update", "statefulset/cognia-server"])
            .await?;
        let snapshot_api = self
            .kubectl(&[
                "api-resources",
                "--api-group=snapshot.storage.k8s.io",
                "-o",
                "name",
            ])
            .await?;
        let snapshot_access = self
            .kubectl(&["auth", "can-i", "create", "volumesnapshots"])
            .await?;
        Ok(json!({
            "targetRevision": target_revision,
            "kubectl": version,
            "access": access,
            "snapshotApi": snapshot_api,
            "snapshotAccess": snapshot_access,
            "snapshotClassName": self.snapshot_class_name
        }))
    }

    async fn activate_release(
        &self,
        release: &AgentRelease,
        target: &DeploymentTarget,
    ) -> Result<(), DriverError> {
        self.apply_target(target, release).await?;
        for command in kubernetes_release_commands(release) {
            let args = command.iter().map(String::as_str).collect::<Vec<_>>();
            self.kubectl(&args).await?;
        }
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
        let request = serde_json::to_string(&json!({ "backupId": backup_id }))
            .map_err(|error| DriverError::Configuration(error.to_string()))?;
        let output = self
            .kubectl(&[
                "exec",
                "statefulset/cognia-server",
                "--",
                "curl",
                "--silent",
                "--show-error",
                "--fail",
                "--insecure",
                "--request",
                "POST",
                "--header",
                "content-type: application/json",
                "--data",
                &request,
                "https://127.0.0.1:27890/api/v1/maintenance/backups",
            ])
            .await?;
        let mut result = parse_stdout_json(output)?;
        let snapshot_name = safe_resource_name("snapshot", backup_id)?;
        let snapshot = volume_snapshot_manifest(
            &snapshot_name,
            &self.snapshot_class_name,
            &self.data_pvc_name,
        );
        self.kubectl_input(&["create", "-f", "-"], &snapshot)
            .await?;
        self.kubectl(&[
            "wait",
            "--for=jsonpath={.status.readyToUse}=true",
            &format!("volumesnapshot/{snapshot_name}"),
            "--timeout=300s",
        ])
        .await?;
        append_snapshot_recovery_point(&mut result, &snapshot_name)?;
        Ok(result)
    }

    async fn restore(
        &self,
        recovery_point_id: &str,
        destination_volume_id: &str,
    ) -> Result<Value, DriverError> {
        let job_name = safe_resource_name("restore", recovery_point_id)?;
        validate_dns_name("destination PVC", destination_volume_id)?;
        let snapshot_source = recovery_point_id
            .starts_with("snapshot-")
            .then_some(recovery_point_id);
        self.kubectl_input(
            &["create", "-f", "-"],
            &restore_pvc_manifest(
                destination_volume_id,
                &self.restore_storage_class_name,
                &self.restore_storage_size,
                snapshot_source,
            ),
        )
        .await?;
        let command = if snapshot_source.is_some() {
            vec![
                "cognia-server".to_string(),
                "verify-restore".to_string(),
                "--data-dir".to_string(),
                "/restore".to_string(),
            ]
        } else {
            vec![
                "cognia-server".to_string(),
                "restore".to_string(),
                "--recovery-point".to_string(),
                recovery_point_id.to_string(),
                "--destination-volume".to_string(),
                "/restore".to_string(),
                "--read-only-smoke".to_string(),
            ]
        };
        let result = self
            .run_maintenance_job(maintenance_job_manifest(
                &job_name,
                &self.maintenance_image,
                destination_volume_id,
                command,
            ))
            .await?;
        self.switch_data_volume(destination_volume_id).await?;
        Ok(json!({
            "verification": result,
            "destinationVolumeId": destination_volume_id,
            "trafficSwitched": true
        }))
    }

    async fn rotate_key(&self, key_version: &str) -> Result<Value, DriverError> {
        self.kubectl(&[
            "exec",
            "statefulset/cognia-server",
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

fn initialize_runtime_override(path: &Path) -> Result<(), DriverError> {
    if !path.is_absolute() {
        return Err(DriverError::Configuration(
            "Compose runtime override path must be absolute".into(),
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        DriverError::Configuration("Compose runtime override path has no parent".into())
    })?;
    fs::create_dir_all(parent).map_err(|error| DriverError::Configuration(error.to_string()))?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => Err(
            DriverError::Configuration("Compose runtime override must be a regular file".into()),
        ),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::write(path, b"{\"services\":{}}\n")
                .map_err(|error| DriverError::Configuration(error.to_string()))
        }
        Err(error) => Err(DriverError::Configuration(error.to_string())),
    }
}

fn compose_runtime_override(volume_name: &str) -> Result<Value, DriverError> {
    validate_dns_name("Compose data volume", volume_name)?;
    let mut value = json!({
        "services": {
            "cognia-server": {
                "volumes": [format!("{volume_name}:/data")]
            },
            "caddy": {
                "volumes": [format!("{volume_name}:/cognia-data:ro")]
            }
        }
    });
    value["volumes"] = Value::Object(serde_json::Map::from_iter([(
        volume_name.to_owned(),
        json!({ "external": true, "name": volume_name }),
    )]));
    Ok(value)
}

async fn write_runtime_override(path: &Path, volume_name: &str) -> Result<(), DriverError> {
    let bytes = serde_json::to_vec_pretty(&compose_runtime_override(volume_name)?)
        .map_err(|error| DriverError::Configuration(error.to_string()))?;
    atomic_write(path, &bytes).await
}

async fn restore_runtime_override(path: &Path, bytes: &[u8]) -> Result<(), DriverError> {
    serde_json::from_slice::<Value>(bytes).map_err(|error| {
        DriverError::Configuration(format!(
            "previous Compose runtime override is invalid: {error}"
        ))
    })?;
    atomic_write(path, bytes).await
}

async fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), DriverError> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            DriverError::Configuration("runtime override file name is invalid".into())
        })?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| DriverError::Configuration(error.to_string()))?
        .as_nanos();
    let temporary = path.with_file_name(format!(".{file_name}.{nonce}.tmp"));
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .await
        .map_err(|error| DriverError::Configuration(error.to_string()))?;
    if let Err(error) = file.write_all(bytes).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(DriverError::Configuration(error.to_string()));
    }
    if let Err(error) = file.sync_all().await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(DriverError::Configuration(error.to_string()));
    }
    drop(file);
    tokio::fs::rename(&temporary, path)
        .await
        .map_err(|error| DriverError::Configuration(error.to_string()))
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

async fn http_ready_smoke(
    client: &reqwest::Client,
    public_url: &Url,
) -> Result<Value, DriverError> {
    let ready_url = public_url
        .join("/api/v1/readyz")
        .map_err(|error| DriverError::Configuration(error.to_string()))?;
    let response = client
        .get(ready_url)
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

async fn command_json_input(mut command: Command, input: Vec<u8>) -> Result<Value, DriverError> {
    let mut child = command
        .spawn()
        .map_err(|error| DriverError::Command(error.to_string()))?;
    child
        .stdin
        .take()
        .ok_or_else(|| DriverError::Command("platform command stdin is unavailable".into()))?
        .write_all(&input)
        .await
        .map_err(|error| DriverError::Command(format!("write platform command stdin: {error}")))?;
    let output = child
        .wait_with_output()
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

fn parse_stdout_json(output: Value) -> Result<Value, DriverError> {
    let stdout = output
        .get("stdout")
        .and_then(Value::as_str)
        .ok_or_else(|| DriverError::Command("platform command omitted stdout".into()))?;
    serde_json::from_str(stdout)
        .map_err(|error| DriverError::Command(format!("command stdout was not JSON: {error}")))
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

fn validate_dns_name(label: &str, value: &str) -> Result<(), DriverError> {
    let valid = !value.is_empty()
        && value.len() <= 253
        && value.split('.').all(|segment| {
            !segment.is_empty()
                && segment.len() <= 63
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
                && !segment.starts_with('-')
                && !segment.ends_with('-')
        });
    if !valid {
        return Err(DriverError::Configuration(format!(
            "{label} must be a DNS-safe Kubernetes name"
        )));
    }
    Ok(())
}

fn validate_storage_size(value: &str) -> Result<(), DriverError> {
    let unit_start = value
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(value.len());
    let (quantity, unit) = value.split_at(unit_start);
    if quantity.is_empty()
        || quantity == "0"
        || !matches!(unit, "Mi" | "Gi" | "Ti")
        || quantity.parse::<u64>().is_err()
    {
        return Err(DriverError::Configuration(
            "restore storage size must be a positive Mi, Gi, or Ti quantity".into(),
        ));
    }
    Ok(())
}

fn volume_snapshot_manifest(name: &str, class_name: &str, pvc_name: &str) -> Value {
    json!({
        "apiVersion": "snapshot.storage.k8s.io/v1",
        "kind": "VolumeSnapshot",
        "metadata": { "name": name },
        "spec": {
            "volumeSnapshotClassName": class_name,
            "source": { "persistentVolumeClaimName": pvc_name }
        }
    })
}

fn restore_pvc_manifest(
    name: &str,
    storage_class_name: &str,
    storage_size: &str,
    snapshot_source: Option<&str>,
) -> Value {
    let mut spec = json!({
        "accessModes": ["ReadWriteOnce"],
        "storageClassName": storage_class_name,
        "resources": { "requests": { "storage": storage_size } }
    });
    if let Some(snapshot) = snapshot_source {
        spec["dataSource"] = json!({
            "apiGroup": "snapshot.storage.k8s.io",
            "kind": "VolumeSnapshot",
            "name": snapshot
        });
    }
    json!({
        "apiVersion": "v1",
        "kind": "PersistentVolumeClaim",
        "metadata": { "name": name },
        "spec": spec
    })
}

fn maintenance_job_manifest(
    name: &str,
    image: &str,
    destination_pvc: &str,
    command: Vec<String>,
) -> Value {
    let config_env = |name: &str, key: &str| {
        json!({
            "name": name,
            "valueFrom": {
                "configMapKeyRef": { "name": "cognia-config", "key": key, "optional": true }
            }
        })
    };
    json!({
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": { "name": name },
        "spec": {
            "backoffLimit": 0,
            "ttlSecondsAfterFinished": 600,
            "template": {
                "metadata": { "labels": { "app": "cognia-maintenance" } },
                "spec": {
                    "restartPolicy": "Never",
                    "automountServiceAccountToken": false,
                    "securityContext": {
                        "runAsNonRoot": true,
                        "runAsUser": 10001,
                        "runAsGroup": 10001,
                        "fsGroup": 10001,
                        "seccompProfile": { "type": "RuntimeDefault" }
                    },
                    "containers": [{
                        "name": "maintenance",
                        "image": image,
                        "command": command,
                        "securityContext": {
                            "allowPrivilegeEscalation": false,
                            "readOnlyRootFilesystem": true,
                            "capabilities": { "drop": ["ALL"] }
                        },
                        "resources": {
                            "requests": { "cpu": "100m", "memory": "256Mi" },
                            "limits": { "cpu": "1", "memory": "1Gi" }
                        },
                        "env": [
                            { "name": "COGNIA_DATA_DIR", "value": "/source" },
                            { "name": "COGNIA_BACKUP_KEY_DIR", "value": "/run/cognia-backup-keys" },
                            { "name": "COGNIA_S3_ACCESS_KEY_FILE", "value": "/run/cognia-backup-secrets/s3-access-key" },
                            { "name": "COGNIA_S3_SECRET_KEY_FILE", "value": "/run/cognia-backup-secrets/s3-secret-key" },
                            config_env("COGNIA_BACKUP_KEY_VERSION", "backupKeyVersion"),
                            config_env("COGNIA_S3_ENDPOINT", "objectStoreEndpoint"),
                            config_env("COGNIA_S3_REGION", "objectStoreRegion"),
                            config_env("COGNIA_S3_BUCKET", "objectStoreBucket"),
                            config_env("COGNIA_S3_PATH_STYLE", "objectStorePathStyle"),
                            config_env("COGNIA_BACKUP_PREFIX", "backupPrefix")
                        ],
                        "volumeMounts": [
                            { "name": "source", "mountPath": "/source" },
                            { "name": "destination", "mountPath": "/restore" },
                            { "name": "backup-secrets", "mountPath": "/run/cognia-backup-secrets", "readOnly": true },
                            { "name": "backup-keys", "mountPath": "/run/cognia-backup-keys", "readOnly": true },
                            { "name": "tmp", "mountPath": "/tmp" }
                        ]
                    }],
                    "volumes": [
                        { "name": "source", "emptyDir": { "sizeLimit": "64Mi" } },
                        { "name": "destination", "persistentVolumeClaim": { "claimName": destination_pvc } },
                        { "name": "backup-secrets", "secret": { "secretName": "cognia-backup-secrets", "optional": true } },
                        { "name": "backup-keys", "secret": { "secretName": "cognia-backup-keys", "optional": true } },
                        { "name": "tmp", "emptyDir": { "sizeLimit": "1Gi" } }
                    ]
                }
            }
        }
    })
}

fn append_snapshot_recovery_point(
    result: &mut Value,
    snapshot_name: &str,
) -> Result<(), DriverError> {
    let points = result
        .get_mut("recoveryPoints")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| DriverError::Command("backup result omitted recoveryPoints".into()))?;
    let source = points
        .first()
        .cloned()
        .ok_or_else(|| DriverError::Command("backup result contained no recovery point".into()))?;
    let mut snapshot = source;
    snapshot["id"] = Value::String(snapshot_name.to_owned());
    snapshot["kind"] = Value::String("snapshot".into());
    snapshot["sizeBytes"] = Value::from(0);
    points.push(snapshot);
    Ok(())
}

fn kubernetes_release_commands(release: &AgentRelease) -> [Vec<String>; 2] {
    [
        vec![
            "set".into(),
            "image".into(),
            "statefulset/cognia-server".into(),
            format!("cognia-server={}", release.server_image),
        ],
        vec![
            "set".into(),
            "env".into(),
            "statefulset/cognia-server".into(),
            format!("COGNIA_RUNNER_IMAGE={}", release.runner_image),
            format!(
                "COGNIA_WORKSPACE_RUNTIME_IMAGE={}",
                release.workspace_runtime_image
            ),
            format!("COGNIA_CONFIG_REVISION={}", release.config_revision),
        ],
    ]
}

#[cfg(test)]
mod tests {
    use super::{
        append_snapshot_recovery_point, compose_runtime_override, initialize_runtime_override,
        kubernetes_release_commands, maintenance_job_manifest, parse_stdout_json,
        restore_pvc_manifest, restore_runtime_override, safe_resource_name, validate_dns_name,
        validate_storage_size, volume_snapshot_manifest, write_runtime_override,
        ExternalSnapshotCreateResult, ExternalSnapshotRestoreResult, KubernetesDriver,
    };
    use crate::KubernetesConfig;
    use cognia_deployment::agent_protocol::AgentRelease;
    use std::path::PathBuf;
    use url::Url;

    #[test]
    fn kubernetes_release_updates_server_and_dynamic_runtime_configuration() {
        let release = AgentRelease {
            server_image: format!("registry/server@sha256:{}", "a".repeat(64)),
            runner_image: format!("registry/runner@sha256:{}", "b".repeat(64)),
            workspace_runtime_image: format!("registry/runtime@sha256:{}", "c".repeat(64)),
            config_revision: "revision-7".into(),
        };

        let commands = kubernetes_release_commands(&release);

        assert_eq!(
            commands[0],
            vec![
                "set",
                "image",
                "statefulset/cognia-server",
                &format!("cognia-server={}", release.server_image),
            ]
        );
        assert_eq!(
            commands[1][0..3],
            ["set", "env", "statefulset/cognia-server"]
        );
        assert!(commands[1]
            .iter()
            .any(|value| value == &format!("COGNIA_RUNNER_IMAGE={}", release.runner_image)));
        assert!(commands[1].iter().any(|value| value
            == &format!(
                "COGNIA_WORKSPACE_RUNTIME_IMAGE={}",
                release.workspace_runtime_image
            )));
        assert!(commands
            .iter()
            .flatten()
            .all(|value| value != "deployment/cognia-workspace-runtime"));
    }

    #[test]
    fn maintenance_stdout_must_be_a_typed_json_result() {
        assert_eq!(
            parse_stdout_json(serde_json::json!({ "stdout": "{\"verified\":true}" })).unwrap(),
            serde_json::json!({ "verified": true })
        );
        assert!(parse_stdout_json(serde_json::json!({ "stdout": "backup complete" })).is_err());
    }

    #[tokio::test]
    async fn compose_runtime_override_atomically_preserves_and_switches_named_volumes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("compose-runtime.json");
        initialize_runtime_override(&path).unwrap();
        let initial = std::fs::read(&path).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&initial).unwrap(),
            serde_json::json!({ "services": {} })
        );

        write_runtime_override(&path, "cognia-restore-operation-1")
            .await
            .unwrap();
        let switched: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            switched["services"]["cognia-server"]["volumes"],
            serde_json::json!(["cognia-restore-operation-1:/data"])
        );
        assert_eq!(
            switched["services"]["caddy"]["volumes"],
            serde_json::json!(["cognia-restore-operation-1:/cognia-data:ro"])
        );
        assert_eq!(
            switched["volumes"]["cognia-restore-operation-1"],
            serde_json::json!({
                "external": true,
                "name": "cognia-restore-operation-1"
            })
        );

        restore_runtime_override(&path, &initial).await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), initial);
        assert!(compose_runtime_override("../../live").is_err());
    }

    #[test]
    fn external_snapshot_adapter_results_are_typed_verified_and_target_bound() {
        let create: ExternalSnapshotCreateResult = serde_json::from_value(serde_json::json!({
            "recoveryPoint": {
                "id": "snapshot-backup-1",
                "kind": "snapshot",
                "manifestSha256": "a".repeat(64),
                "sizeBytes": 4096,
                "verified": true,
                "createdAt": "2026-08-01T10:00:00Z"
            }
        }))
        .unwrap();
        assert!(create.validate("snapshot-backup-1").is_ok());
        assert!(create.validate("snapshot-other").is_err());

        let injected = serde_json::json!({
            "volumeName": "cognia-restore-operation-1",
            "verified": true,
            "verification": { "hashes": true },
            "argv": ["sh", "-c", "unsafe"]
        });
        assert!(serde_json::from_value::<ExternalSnapshotRestoreResult>(injected).is_err());
    }

    #[test]
    fn kubernetes_snapshot_and_restore_resources_are_namespace_scoped_and_single_writer_safe() {
        let snapshot =
            volume_snapshot_manifest("snapshot-backup-1", "fast-snapshots", "cognia-data");
        assert_eq!(snapshot["kind"], "VolumeSnapshot");
        assert_eq!(
            snapshot["spec"]["volumeSnapshotClassName"],
            "fast-snapshots"
        );
        assert_eq!(
            snapshot["spec"]["source"]["persistentVolumeClaimName"],
            "cognia-data"
        );
        assert!(snapshot["metadata"].get("namespace").is_none());

        let pvc = restore_pvc_manifest(
            "restore-operation-1",
            "encrypted-block",
            "100Gi",
            Some("snapshot-backup-1"),
        );
        assert_eq!(pvc["kind"], "PersistentVolumeClaim");
        assert_eq!(
            pvc["spec"]["accessModes"],
            serde_json::json!(["ReadWriteOnce"])
        );
        assert_eq!(pvc["spec"]["storageClassName"], "encrypted-block");
        assert_eq!(
            pvc["spec"]["dataSource"],
            serde_json::json!({
                "apiGroup": "snapshot.storage.k8s.io",
                "kind": "VolumeSnapshot",
                "name": "snapshot-backup-1"
            })
        );
    }

    #[test]
    fn maintenance_job_is_non_privileged_and_mounts_only_the_new_restore_volume() {
        let job = maintenance_job_manifest(
            "restore-backup-1",
            &format!("registry/maintenance@sha256:{}", "a".repeat(64)),
            "restore-operation-1",
            vec![
                "cognia-server".into(),
                "verify-restore".into(),
                "--data-dir".into(),
                "/restore".into(),
            ],
        );
        let pod = &job["spec"]["template"]["spec"];
        assert_eq!(pod["automountServiceAccountToken"], false);
        assert_eq!(pod["securityContext"]["runAsNonRoot"], true);
        assert_eq!(
            pod["containers"][0]["securityContext"]["capabilities"]["drop"],
            serde_json::json!(["ALL"])
        );
        assert_eq!(
            pod["volumes"][1]["persistentVolumeClaim"]["claimName"],
            "restore-operation-1"
        );
        assert!(pod["volumes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|volume| volume["persistentVolumeClaim"]["claimName"] != "cognia-data"));
    }

    #[test]
    fn recovery_point_results_preserve_object_backup_and_append_csi_snapshot() {
        let mut result = serde_json::json!({
            "recoveryPoints": [{
                "id": "backup-1",
                "kind": "object-store",
                "manifestSha256": "abc",
                "sizeBytes": 42,
                "verified": true,
                "createdAt": "2026-08-01T10:00:00Z"
            }]
        });
        append_snapshot_recovery_point(&mut result, "snapshot-backup-1").unwrap();
        let points = result["recoveryPoints"].as_array().unwrap();
        assert_eq!(points.len(), 2);
        assert_eq!(points[0]["kind"], "object-store");
        assert_eq!(points[1]["id"], "snapshot-backup-1");
        assert_eq!(points[1]["kind"], "snapshot");
        assert_eq!(points[1]["sizeBytes"], 0);
        assert_eq!(points[1]["manifestSha256"], "abc");
    }

    #[test]
    fn kubernetes_restore_configuration_rejects_mutable_images_and_unsafe_resources() {
        let config = |image: &str| KubernetesConfig {
            kubectl_binary: PathBuf::from("kubectl"),
            namespace: "cognia-production".into(),
            public_url: Url::parse("https://server.example.com").unwrap(),
            maintenance_image: image.into(),
            data_pvc_name: "cognia-data".into(),
            snapshot_class_name: "cognia-snapshots".into(),
            restore_storage_class_name: "encrypted-block".into(),
            restore_storage_size: "100Gi".into(),
        };
        assert!(KubernetesDriver::new(config("registry/maintenance:latest")).is_err());
        assert!(KubernetesDriver::new(config(&format!(
            "registry/maintenance@sha256:{}",
            "a".repeat(64)
        )))
        .is_ok());
        assert!(safe_resource_name("restore", "../live-data").is_err());
        assert!(validate_dns_name("PVC", "-live-data").is_err());
        assert!(validate_storage_size("0Gi").is_err());
        assert!(validate_storage_size("100GB").is_err());
        assert!(validate_storage_size("100Gi").is_ok());
    }
}
