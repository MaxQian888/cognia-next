//! cua desktop sandbox, a remote Computer-Use and workspace execution target
//! (ADR-0020 remote-target addendum). Orchestrates a local Docker container
//! and drives its `computer-server` over a WebSocket, slotting in behind the
//! existing automation gate as a `Remote` `CallTarget`.
//!
//! Every command here is `target: "client"` with `transports: ["internal"]` in
//! `protocol/companion-commands.json`. Docker orchestration is local to the
//! machine running the renderer, so these never follow an active remote host.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub mod lifecycle;
pub mod protocol;
pub mod registry;
pub mod remote_client;

pub use registry::CuaSandboxRegistry;

use lifecycle::{ContainerPolicy, WorkspaceMount};

/// Default ceiling for one `docker exec`, when the caller names none.
const DEFAULT_EXEC_TIMEOUT_MS: u64 = 120_000;
/// Default cap for a single container file read.
const DEFAULT_READ_MAX_BYTES: usize = 2 * 1024 * 1024;

/// Container-level isolation the caller wants frozen in at create time.
///
/// Docker fixes all of this when the container is made. `docker exec` cannot
/// change a running container's network mode or its cpu/memory ceiling, which
/// is why the renderer records what was actually applied and refuses any later
/// request that asks for something stricter.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxPolicyArgs {
    pub network_mode: Option<String>,
    pub cpus: Option<String>,
    pub memory_mb: Option<u64>,
    /// Both halves are required together for a bind mount to be applied.
    pub workspace_host_path: Option<String>,
    pub workspace_container_path: Option<String>,
}

impl From<Option<SandboxPolicyArgs>> for ContainerPolicy {
    fn from(args: Option<SandboxPolicyArgs>) -> Self {
        let Some(args) = args else {
            return ContainerPolicy::default();
        };
        let workspace_mount = match (args.workspace_host_path, args.workspace_container_path) {
            (Some(host_path), Some(container_path))
                if !host_path.is_empty() && !container_path.is_empty() =>
            {
                Some(WorkspaceMount {
                    host_path,
                    container_path,
                })
            }
            // A half-specified mount is dropped rather than guessed. Inventing
            // the missing half would bind a directory the caller never named.
            _ => None,
        };
        ContainerPolicy {
            network_mode: args.network_mode,
            cpus: args.cpus,
            memory_mb: args.memory_mb,
            workspace_mount,
        }
    }
}

/// Named fields, not a tuple: a tuple return serializes as a JSON array and
/// the renderer would have to index it positionally.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxPlacementDto {
    pub container_id: String,
    /// Zero while the container is not running, because Docker publishes no
    /// host port until then.
    pub port: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxStateDto {
    pub container_id: String,
    /// Docker's `.State.Status`: created, running, paused, restarting,
    /// removing, exited, or dead.
    pub status: String,
    pub running: bool,
    pub paused: bool,
    pub network_mode: String,
    /// Zero means the cpu allowance is uncapped.
    pub nano_cpus: i64,
    /// Bytes. Zero means memory is uncapped.
    pub memory_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxExecDto {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub timed_out: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

impl From<registry::SandboxPlacement> for SandboxPlacementDto {
    fn from(value: registry::SandboxPlacement) -> Self {
        Self {
            container_id: value.container_id,
            port: value.port,
        }
    }
}

impl From<lifecycle::ContainerState> for SandboxStateDto {
    fn from(value: lifecycle::ContainerState) -> Self {
        Self {
            container_id: value.id,
            status: value.status,
            running: value.running,
            paused: value.paused,
            network_mode: value.network_mode,
            nano_cpus: value.nano_cpus,
            memory_bytes: value.memory_bytes,
        }
    }
}

impl From<lifecycle::ExecOutcome> for SandboxExecDto {
    fn from(value: lifecycle::ExecOutcome) -> Self {
        Self {
            exit_code: value.exit_code,
            stdout: value.stdout,
            stderr: value.stderr,
            duration_ms: value.duration_ms,
            timed_out: value.timed_out,
            stdout_truncated: value.stdout_truncated,
            stderr_truncated: value.stderr_truncated,
        }
    }
}

/// Provision the container for `connection_id` without starting it.
#[tauri::command]
pub async fn cua_sandbox_create(
    reg: tauri::State<'_, CuaSandboxRegistry>,
    connection_id: String,
    image: String,
    policy: Option<SandboxPolicyArgs>,
) -> std::result::Result<SandboxPlacementDto, String> {
    reg.create(&connection_id, &image, policy.into())
        .await
        .map(Into::into)
        .map_err(|e| e.to_string())
}

/// Bring the container for `connection_id` to running and return its mapped
/// host port. Adopts an existing container instead of creating a second one.
#[tauri::command]
pub async fn cua_sandbox_start(
    reg: tauri::State<'_, CuaSandboxRegistry>,
    connection_id: String,
    image: String,
    policy: Option<SandboxPolicyArgs>,
) -> std::result::Result<SandboxPlacementDto, String> {
    reg.start(&connection_id, &image, policy.into())
        .await
        .map(Into::into)
        .map_err(|e| e.to_string())
}

/// Suspend with `docker pause`, keeping memory resident so the desktop session
/// survives. This is not `docker stop`.
#[tauri::command]
pub async fn cua_sandbox_suspend(
    reg: tauri::State<'_, CuaSandboxRegistry>,
    connection_id: String,
) -> std::result::Result<(), String> {
    reg.suspend(&connection_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cua_sandbox_resume(
    reg: tauri::State<'_, CuaSandboxRegistry>,
    connection_id: String,
) -> std::result::Result<SandboxPlacementDto, String> {
    reg.resume(&connection_id)
        .await
        .map(Into::into)
        .map_err(|e| e.to_string())
}

/// Stop the container for `connection_id`. It keeps existing, along with
/// everything written inside it.
#[tauri::command]
pub async fn cua_sandbox_stop(
    reg: tauri::State<'_, CuaSandboxRegistry>,
    connection_id: String,
) -> std::result::Result<(), String> {
    reg.stop(&connection_id).await.map_err(|e| e.to_string())
}

/// Destroy the container and everything in it that is not on a bind mount.
#[tauri::command]
pub async fn cua_sandbox_delete(
    reg: tauri::State<'_, CuaSandboxRegistry>,
    connection_id: String,
) -> std::result::Result<(), String> {
    reg.delete(&connection_id).await.map_err(|e| e.to_string())
}

/// Docker's own view of the container, or `null` when it does not exist.
#[tauri::command]
pub async fn cua_sandbox_inspect(
    reg: tauri::State<'_, CuaSandboxRegistry>,
    connection_id: String,
) -> std::result::Result<Option<SandboxStateDto>, String> {
    reg.inspect(&connection_id)
        .await
        .map(|state| state.map(Into::into))
        .map_err(|e| e.to_string())
}

/// Whether the container for `connection_id` answers `docker exec`.
#[tauri::command]
pub async fn cua_sandbox_health(
    reg: tauri::State<'_, CuaSandboxRegistry>,
    connection_id: String,
) -> std::result::Result<bool, String> {
    Ok(reg.health(&connection_id).await)
}

/// Run one command inside the machine.
///
/// `argv` is passed to `docker exec` as separate arguments and is never joined
/// into a shell string.
#[tauri::command]
pub async fn cua_sandbox_exec(
    reg: tauri::State<'_, CuaSandboxRegistry>,
    connection_id: String,
    argv: Vec<String>,
    cwd: Option<String>,
    env: Option<BTreeMap<String, String>>,
    stdin: Option<String>,
    timeout_ms: Option<u64>,
) -> std::result::Result<SandboxExecDto, String> {
    let env = env.unwrap_or_default();
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_EXEC_TIMEOUT_MS));
    reg.exec(
        &connection_id,
        &argv,
        cwd.as_deref(),
        &env,
        stdin.as_deref(),
        timeout,
    )
    .await
    .map(Into::into)
    .map_err(|e| e.to_string())
}

/// Read one file from inside the machine.
#[tauri::command]
pub async fn cua_sandbox_read_file(
    reg: tauri::State<'_, CuaSandboxRegistry>,
    connection_id: String,
    path: String,
    max_bytes: Option<u64>,
) -> std::result::Result<String, String> {
    let max = max_bytes
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_READ_MAX_BYTES);
    reg.read_file(&connection_id, &path, max)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_policy_args_mean_docker_defaults() {
        let policy: ContainerPolicy = None.into();
        assert_eq!(policy, ContainerPolicy::default());
    }

    #[test]
    fn policy_args_map_onto_container_policy() {
        let policy: ContainerPolicy = Some(SandboxPolicyArgs {
            network_mode: Some("none".into()),
            cpus: Some("2".into()),
            memory_mb: Some(4096),
            workspace_host_path: Some("/host/ws".into()),
            workspace_container_path: Some("/workspace".into()),
        })
        .into();
        assert_eq!(policy.network_mode.as_deref(), Some("none"));
        assert_eq!(policy.cpus.as_deref(), Some("2"));
        assert_eq!(policy.memory_mb, Some(4096));
        assert_eq!(
            policy.workspace_mount,
            Some(WorkspaceMount {
                host_path: "/host/ws".into(),
                container_path: "/workspace".into(),
            })
        );
    }

    #[test]
    fn a_half_specified_mount_is_dropped_not_guessed() {
        let policy: ContainerPolicy = Some(SandboxPolicyArgs {
            workspace_host_path: Some("/host/ws".into()),
            ..SandboxPolicyArgs::default()
        })
        .into();
        assert_eq!(policy.workspace_mount, None);

        let policy: ContainerPolicy = Some(SandboxPolicyArgs {
            workspace_container_path: Some("/workspace".into()),
            ..SandboxPolicyArgs::default()
        })
        .into();
        assert_eq!(policy.workspace_mount, None);
    }
}
