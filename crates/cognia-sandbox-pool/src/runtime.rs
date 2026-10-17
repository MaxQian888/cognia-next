//! Authorized workspace port access over Docker exec. No daemon port is
//! published, and only ports from a currently admitted spec can be opened.

use async_trait::async_trait;
use cognia_external_agent::sandbox_routing_backend::{SandboxPlacement, SandboxSpawnError};
use serde::Serialize;

pub use cognia_external_agent::container_backend::SnapshotImage;

/// The four operations have separate provider contracts; cold Docker snapshots
/// never claim process or memory resumption.
#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    PartialEq,
    Eq,
    serde::Serialize,
    serde::Deserialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotCapabilities {
    pub filesystem_checkpoint: bool,
    pub fork_from_checkpoint: bool,
    pub pause_resume: bool,
    pub memory_resume: bool,
}

pub fn snapshot_unsupported() -> SandboxSpawnError {
    SandboxSpawnError::refused(
        "snapshot_fork_unsupported",
        "Provider filesystem checkpoint/fork API has not been verified",
    )
}

#[derive(Clone, Debug)]
pub struct SnapshotRuntimeSource {
    pub bundle_digest: String,
    pub placement: SandboxPlacement,
    pub was_running: bool,
}

/// Host-only freeze lease. Its runtime identity lock spans checkpoint capture,
/// image commit and restoration of the previous running state.
pub struct SnapshotRuntimeLease {
    pub bundle_digest: String,
    pub provider: String,
    pub container_id: String,
    pub project_id: String,
    pub workspace_root: String,
    pub placement: SandboxPlacement,
    pub(crate) running: bool,
    pub(crate) guard: Option<std::sync::Arc<tokio::sync::OwnedMutexGuard<()>>>,
    pub(crate) workspace_guard: Option<std::sync::Arc<tokio::sync::OwnedRwLockWriteGuard<()>>>,
    pub(crate) backend: std::sync::Weak<crate::docker::DockerSandboxBackend>,
}

impl SnapshotRuntimeLease {
    pub fn was_running(&self) -> bool {
        self.running
    }
}

impl Drop for SnapshotRuntimeLease {
    fn drop(&mut self) {
        // Cancellation cannot leave a formerly-running source frozen forever.
        // The guard remains held until restart settles.
        if self.running {
            if let (Some(backend), Some(guard), Ok(handle)) = (
                self.backend.upgrade(),
                self.guard.take(),
                tokio::runtime::Handle::try_current(),
            ) {
                let id = self.container_id.clone();
                let workspace_guard = self.workspace_guard.take();
                handle.spawn(async move {
                    let _guard = guard;
                    let _workspace_guard = workspace_guard;
                    if let Err(error) = backend.resume_snapshot_source(&id).await {
                        log::error!("snapshot source restart failed for {id}: {error:?}");
                    }
                });
            }
        }
    }
}

/// Internal sidecar-created listener. This type is never a renderer RPC input.
#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolHostService {
    pub agent_id: String,
    pub owner_session_id: String,
    pub origin_device_id: Option<String>,
    pub lease_id: String,
    pub generation: u64,
    pub port: u16,
    /// Host-owned live authorization, never deserialized from IPC.
    #[serde(skip)]
    pub authorization: Option<std::sync::Arc<dyn Fn() -> bool + Send + Sync>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolHostBridge {
    pub bridge_id: String,
    pub port: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePort {
    pub container_id: String,
    pub project_id: String,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub path: String,
}

/// One tool command of a Host task run in its runtime environment
/// (ADR-0224 A8): a built-in turn's `sandbox_bash`, `edit` or `write` on an
/// always-on Host, where nothing may run on the Host itself.
#[derive(Clone, Debug)]
pub struct TaskShellRequest {
    /// The task's runtime environment, as `prepare_run_environment` placed it.
    pub placement: SandboxPlacement,
    /// Who the command runs for (`session:<id>`); scopes its exec session.
    pub owner: String,
    /// The task workspace on the Host, canonical: what the runtime mounts.
    pub workspace_root: String,
    /// The same workspace as the task's tools name it. Inside the runtime
    /// this path leads to the mount, so the paths a tool passes are unchanged.
    pub workspace_path: String,
    /// Where the command starts: `workspace_path` or a directory under it.
    pub cwd: String,
    pub argv: Vec<String>,
    pub env: std::collections::BTreeMap<String, String>,
    pub stdin: Option<String>,
    /// How long the command may run once started; preparing its runtime is
    /// not charged to it.
    pub timeout_ms: u64,
}

/// What one task shell command did. Output beyond
/// [`TASK_SHELL_OUTPUT_LIMIT`] bytes per stream is dropped and flagged;
/// invalid UTF-8 is replaced, since the tools that read it exchange text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskShellResult {
    /// `None` when the command was killed on timeout without an exit status.
    pub exit_code: Option<i64>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub timed_out: bool,
    /// How long the command ran, not counting preparing its runtime.
    pub duration_ms: u64,
    /// The provider that ran it; a release names it.
    pub provider: String,
    /// The retained runtime the command ran in; a release names it.
    pub container_id: String,
    /// The isolation tier the runtime was admitted at (`container`, `gvisor`).
    pub tier: String,
}

/// What a task shell release removed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskShellRelease {
    /// The runtimes removed; one a session still uses is kept and not listed.
    pub removed: Vec<String>,
}

/// Bytes kept per output stream of one task shell command.
pub const TASK_SHELL_OUTPUT_LIMIT: usize = 1024 * 1024;

fn task_shell_unsupported() -> SandboxSpawnError {
    SandboxSpawnError::refused(
        "sandbox_task_shell_unsupported",
        "This sandbox provider cannot run task shell commands",
    )
}

#[async_trait]
pub trait SandboxRuntimeControl: Send + Sync {
    /// Preview admission requires both the Host workspace receipt and an actual
    /// running incarnation identity. Providers without this contract fail closed.
    async fn preview_runtime_generation(
        &self,
        _provider: &str,
        _container: &str,
        _project: &str,
        _root: &str,
    ) -> Result<String, SandboxSpawnError> {
        Err(SandboxSpawnError::refused(
            "preview_provider_unsupported",
            "Provider has no preview incarnation contract",
        ))
    }

    fn snapshot_capabilities(&self, _provider: &str) -> SnapshotCapabilities {
        SnapshotCapabilities::default()
    }
    fn snapshot_image_name(
        &self,
        _provider: &str,
        _snapshot_id: &str,
    ) -> Result<String, SandboxSpawnError> {
        Err(snapshot_unsupported())
    }
    async fn inspect_snapshot_source(
        &self,
        _provider: &str,
        _container: &str,
        _project: &str,
        _root: &str,
    ) -> Result<SnapshotRuntimeSource, SandboxSpawnError> {
        Err(snapshot_unsupported())
    }
    async fn quiesce_snapshot(
        &self,
        _provider: &str,
        _container_id: &str,
        _project_id: &str,
        _workspace_root: &str,
    ) -> Result<SnapshotRuntimeLease, SandboxSpawnError> {
        Err(snapshot_unsupported())
    }
    async fn commit_snapshot_image(
        &self,
        _lease: &SnapshotRuntimeLease,
        _snapshot_id: &str,
    ) -> Result<SnapshotImage, SandboxSpawnError> {
        Err(snapshot_unsupported())
    }
    async fn resume_snapshot_runtime(
        &self,
        _lease: SnapshotRuntimeLease,
    ) -> Result<(), SandboxSpawnError> {
        Err(snapshot_unsupported())
    }
    async fn inspect_snapshot_image(
        &self,
        _provider: &str,
        _id: &str,
    ) -> Result<Option<SnapshotImage>, SandboxSpawnError> {
        Err(snapshot_unsupported())
    }
    async fn remove_snapshot_image(
        &self,
        _provider: &str,
        _id: &str,
    ) -> Result<(), SandboxSpawnError> {
        Err(snapshot_unsupported())
    }
    async fn snapshot_runtime_for_workspace(
        &self,
        _provider: &str,
        _root: &str,
    ) -> Result<Option<String>, SandboxSpawnError> {
        Err(snapshot_unsupported())
    }
    async fn pending_snapshot_restore_targets(
        &self,
        _provider: &str,
    ) -> Result<Vec<String>, SandboxSpawnError> {
        Err(snapshot_unsupported())
    }
    async fn complete_snapshot_restore_target(
        &self,
        _provider: &str,
        _root: &str,
    ) -> Result<(), SandboxSpawnError> {
        Err(snapshot_unsupported())
    }
    async fn rollback_snapshot_restore_target(
        &self,
        _provider: &str,
        _root: &str,
    ) -> Result<(), SandboxSpawnError> {
        Err(snapshot_unsupported())
    }
    async fn retire_snapshot_restore_target(
        &self,
        _provider: &str,
        _project: &str,
        _root: &str,
    ) -> Result<(), SandboxSpawnError> {
        Err(snapshot_unsupported())
    }
    async fn discard_snapshot_fork(
        &self,
        _provider: &str,
        _root: &str,
    ) -> Result<(), SandboxSpawnError> {
        Err(snapshot_unsupported())
    }
    async fn release_snapshot_fork(
        &self,
        _provider: &str,
        _root: &str,
    ) -> Result<(), SandboxSpawnError> {
        Err(snapshot_unsupported())
    }
    async fn recover_snapshot_source(
        &self,
        _provider: &str,
        _id: &str,
        _was_running: bool,
    ) -> Result<(), SandboxSpawnError> {
        Err(snapshot_unsupported())
    }
    async fn snapshot_runtime_exists(
        &self,
        _provider: &str,
        _id: &str,
    ) -> Result<bool, SandboxSpawnError> {
        Err(snapshot_unsupported())
    }
    async fn verify_snapshot_bundle(
        &self,
        _provider: &str,
        _placement: &SandboxPlacement,
        _expected: &str,
    ) -> Result<(), SandboxSpawnError> {
        Err(snapshot_unsupported())
    }
    async fn fork_snapshot_runtime(
        &self,
        _provider: &str,
        _image_id: &str,
        _placement: SandboxPlacement,
        _workspace_root: &str,
        _bundle_digest: &str,
    ) -> Result<String, SandboxSpawnError> {
        Err(snapshot_unsupported())
    }

    /// Run one task tool command in the task's runtime environment.
    async fn exec_task_shell(
        &self,
        _request: TaskShellRequest,
    ) -> Result<TaskShellResult, SandboxSpawnError> {
        Err(task_shell_unsupported())
    }
    /// The task is done with these runtimes: remove each one no session uses.
    /// Returns the ids actually removed.
    async fn release_task_shell(
        &self,
        _provider: &str,
        _container_ids: &[String],
    ) -> Result<Vec<String>, SandboxSpawnError> {
        Err(task_shell_unsupported())
    }
    fn agent_origin_allowed(&self, _agent_id: &str, _device_id: &str) -> Option<bool> {
        None
    }
    async fn register_tool_host(
        &self,
        _service: ToolHostService,
    ) -> Result<String, SandboxSpawnError> {
        Err(SandboxSpawnError::refused(
            "sandbox_service_unsupported",
            "This runtime does not support hosted services",
        ))
    }
    async fn open_tool_host(
        &self,
        _service: ToolHostService,
    ) -> Result<ToolHostBridge, SandboxSpawnError> {
        Err(SandboxSpawnError::refused(
            "sandbox_service_unsupported",
            "This runtime does not support hosted services",
        ))
    }
    fn renew_tool_host(&self, _bridge_id: &str) -> bool {
        false
    }
    fn close_tool_host(&self, _bridge_id: &str) {}
    async fn list_ports(&self, project_id: &str) -> Result<Vec<RuntimePort>, SandboxSpawnError>;
    async fn port_allowed(
        &self,
        project_id: &str,
        container_id: &str,
        port: u16,
    ) -> Result<bool, SandboxSpawnError>;
    /// The returned stream must close if its spec/port authority is revoked;
    /// callers add their own device authorization without duplicating checks.
    async fn open_port(
        &self,
        project_id: &str,
        container_id: &str,
        port: u16,
    ) -> Result<tokio::io::DuplexStream, SandboxSpawnError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_identity_rejects_arbitrary_targets_and_deserialized_authority() {
        let request = serde_json::json!({"agentId":"agent", "ownerSessionId":"chat", "originDeviceId":null, "leaseId":"renderer-tool-host-fixture", "generation":1, "port":12345});
        assert!(serde_json::from_value::<ToolHostService>(request.clone())
            .unwrap()
            .authorization
            .is_none());
        for key in ["url", "host", "authorization"] {
            let mut forged = request.clone();
            forged[key] = serde_json::json!("127.0.0.1:22");
            assert!(serde_json::from_value::<ToolHostService>(forged).is_err());
        }
    }

    #[test]
    fn port_wire_omits_absent_label() {
        let port = RuntimePort {
            container_id: "runtime".into(),
            project_id: "project".into(),
            port: 3000,
            label: None,
            path: "/api/environment/ports/project/runtime/3000/".into(),
        };
        let json = serde_json::to_value(port).unwrap();
        assert_eq!(json["containerId"], "runtime");
        assert!(json.get("label").is_none());
    }

    #[test]
    fn task_shell_results_are_camel_case_and_keep_a_missing_status_explicit() {
        let result = TaskShellResult {
            exit_code: None,
            stdout: "out".into(),
            stderr: String::new(),
            stdout_truncated: true,
            stderr_truncated: false,
            timed_out: true,
            duration_ms: 1000,
            provider: "local".into(),
            container_id: "c1".into(),
            tier: "container".into(),
        };
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            serde_json::json!({
                "exitCode": null,
                "stdout": "out",
                "stderr": "",
                "stdoutTruncated": true,
                "stderrTruncated": false,
                "timedOut": true,
                "durationMs": 1000,
                "provider": "local",
                "containerId": "c1",
                "tier": "container",
            })
        );
    }

    #[tokio::test]
    async fn a_runtime_without_task_shells_refuses_them() {
        struct Bare;
        #[async_trait]
        impl SandboxRuntimeControl for Bare {
            async fn list_ports(&self, _: &str) -> Result<Vec<RuntimePort>, SandboxSpawnError> {
                Ok(Vec::new())
            }
            async fn port_allowed(
                &self,
                _: &str,
                _: &str,
                _: u16,
            ) -> Result<bool, SandboxSpawnError> {
                Ok(false)
            }
            async fn open_port(
                &self,
                _: &str,
                _: &str,
                _: u16,
            ) -> Result<tokio::io::DuplexStream, SandboxSpawnError> {
                Err(SandboxSpawnError::refused("x", "x"))
            }
        }
        let error = Bare
            .release_task_shell("local", &["c".into()])
            .await
            .unwrap_err();
        assert_eq!(error.code, "sandbox_task_shell_unsupported");
    }
}
