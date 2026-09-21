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
///
/// Every field is optional: an absent field keeps the hardened default from
/// `ContainerPolicy::default`, and an explicit value overrides it verbatim
/// (an empty list clears the default's entries; `0` lifts a numeric bound).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxPolicyArgs {
    pub network_mode: Option<String>,
    pub cpus: Option<String>,
    pub memory_mb: Option<u64>,
    /// `0` lifts the process cap entirely.
    pub pids_limit: Option<u64>,
    /// Replaces the default `["ALL"]` wholesale.
    pub cap_drop: Option<Vec<String>>,
    /// Replaces the default supervisor re-grants wholesale.
    pub cap_add: Option<Vec<String>>,
    pub no_new_privileges: Option<bool>,
    pub read_only_rootfs: Option<bool>,
    /// Replaces the default tmpfs set wholesale.
    pub tmpfs_mounts: Option<Vec<String>>,
    /// Replaces the default anonymous-volume set wholesale.
    pub writable_dirs: Option<Vec<String>>,
    /// The user `docker exec` commands run as. An empty string lifts the
    /// bound, leaving the image's default user.
    pub exec_user: Option<String>,
    /// `--user` for the container entrypoint. The cua-xfce supervisord must
    /// boot as root, so this stays unset unless a different image needs it.
    pub entrypoint_user: Option<String>,
    /// Host interface for the computer-server port. An empty string keeps
    /// the loopback default; anything else is the caller's responsibility.
    pub publish_addr: Option<String>,
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
        let mut policy = ContainerPolicy {
            network_mode: args.network_mode,
            cpus: args.cpus,
            memory_mb: args.memory_mb,
            workspace_mount,
            ..ContainerPolicy::default()
        };
        if let Some(limit) = args.pids_limit {
            policy.pids_limit = (limit > 0).then_some(limit);
        }
        if let Some(caps) = args.cap_drop {
            policy.cap_drop = caps;
        }
        if let Some(caps) = args.cap_add {
            policy.cap_add = caps;
        }
        if let Some(flag) = args.no_new_privileges {
            policy.no_new_privileges = flag;
        }
        if let Some(flag) = args.read_only_rootfs {
            policy.read_only_rootfs = flag;
        }
        if let Some(mounts) = args.tmpfs_mounts {
            policy.tmpfs_mounts = mounts;
        }
        if let Some(dirs) = args.writable_dirs {
            policy.writable_dirs = dirs;
        }
        if let Some(user) = args.exec_user {
            policy.exec_user = (!user.is_empty()).then_some(user);
        }
        if let Some(user) = args.entrypoint_user {
            policy.entrypoint_user = (!user.is_empty()).then_some(user);
        }
        if let Some(addr) = args.publish_addr {
            if !addr.is_empty() {
                policy.publish_addr = addr;
            }
        }
        policy
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
    /// Zero or negative means processes are uncapped.
    pub pids_limit: i64,
    /// Whether the container's root filesystem is read-only.
    pub read_only_rootfs: bool,
    /// The exec-user bound recorded on the container at create time, or null
    /// on containers that predate the label.
    pub exec_user: Option<String>,
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
            pids_limit: value.pids_limit,
            read_only_rootfs: value.read_only_rootfs,
            exec_user: value.exec_user,
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
    fn absent_hardening_fields_keep_the_hardened_defaults() {
        // The audit regression guard on the IPC surface: a caller that passes
        // only the legacy fields still gets the hardened profile, because
        // every new field defaults rather than opting out.
        let policy: ContainerPolicy = Some(SandboxPolicyArgs {
            network_mode: Some("none".into()),
            ..SandboxPolicyArgs::default()
        })
        .into();
        assert_eq!(policy.pids_limit, Some(lifecycle::DEFAULT_PIDS_LIMIT));
        assert_eq!(policy.cap_drop, vec!["ALL".to_string()]);
        assert!(policy.no_new_privileges);
        assert!(policy.read_only_rootfs);
        assert!(!policy.tmpfs_mounts.is_empty());
        assert_eq!(policy.writable_dirs, vec!["/home/cua".to_string()]);
        assert_eq!(
            policy.exec_user.as_deref(),
            Some(lifecycle::DEFAULT_EXEC_USER)
        );
        assert_eq!(policy.publish_addr, "127.0.0.1");
    }

    #[test]
    fn explicit_overrides_replace_defaults_verbatim() {
        let policy: ContainerPolicy = Some(SandboxPolicyArgs {
            pids_limit: Some(0), // 0 lifts the cap entirely
            cap_drop: Some(vec![]),
            cap_add: Some(vec!["NET_BIND_SERVICE".into()]),
            no_new_privileges: Some(false),
            read_only_rootfs: Some(false),
            tmpfs_mounts: Some(vec!["/scratch".into()]),
            writable_dirs: Some(vec![]),
            exec_user: Some(String::new()), // empty lifts the exec-user bound
            entrypoint_user: Some("operator".into()),
            publish_addr: Some("0.0.0.0".into()),
            ..SandboxPolicyArgs::default()
        })
        .into();
        assert_eq!(policy.pids_limit, None);
        assert!(policy.cap_drop.is_empty());
        assert_eq!(policy.cap_add, vec!["NET_BIND_SERVICE".to_string()]);
        assert!(!policy.no_new_privileges);
        assert!(!policy.read_only_rootfs);
        assert_eq!(policy.tmpfs_mounts, vec!["/scratch".to_string()]);
        assert!(policy.writable_dirs.is_empty());
        assert_eq!(policy.exec_user, None);
        assert_eq!(policy.entrypoint_user.as_deref(), Some("operator"));
        assert_eq!(policy.publish_addr, "0.0.0.0");
    }

    #[test]
    fn policy_args_map_onto_container_policy() {
        let policy: ContainerPolicy = Some(SandboxPolicyArgs {
            network_mode: Some("none".into()),
            cpus: Some("2".into()),
            memory_mb: Some(4096),
            workspace_host_path: Some("/host/ws".into()),
            workspace_container_path: Some("/workspace".into()),
            ..SandboxPolicyArgs::default()
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
