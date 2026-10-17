// ADR-0028 Phase 4.4 — Linux `bwrap` (bubblewrap) backend.
//
// `bwrap` is the de-facto Linux sandbox primitive (used by Flatpak, the
// Anthropic sandbox-runtime, srt, etc.). It's a single binary, no daemon,
// no kernel module — just a setuid (or unprivileged-userns) wrapper around
// Linux namespaces (`CLONE_NEWUSER`/`PID`/`NET`/`MNT`/`IPC`/`UTS`) plus
// optional seccomp.
//
// Resolution order for the binary:
//   1. Bundled at `<resource_dir>/bwrap/bwrap` (Tauri ships a static build
//      for distros that don't have one — `bubblewrap` is in every major
//      package manager, but bundling sidesteps user-FOR-distro variance).
//   2. System `bwrap` on PATH (`which bwrap` fallback).
//
// The backend is `cfg(target_os = "linux")` only — built modules on Windows
// / macOS use `UninstalledSandboxBackend` via the `current_backend()`
// dispatch in `mod.rs`.

#![allow(dead_code)]

use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::traits::SandboxedExec;
use crate::types::{
    NetworkPolicy, SandboxCommand, SandboxError, SandboxHealth, SandboxPolicy, SandboxResult,
};

/// Resolved `bwrap` binary path. Captured at construction so health probes
/// don't re-walk PATH on every poll.
#[derive(Debug, Clone)]
pub struct LinuxSandboxBackend {
    bwrap: Option<PathBuf>,
    bundled: bool,
}

impl LinuxSandboxBackend {
    /// Construct from explicit bundled binary path (Tauri resource_dir
    /// joined with `bwrap/bwrap`). Falls back to system PATH if bundled
    /// path doesn't exist.
    pub fn new(bundled_path: Option<PathBuf>) -> Self {
        if let Some(p) = bundled_path.as_ref() {
            if p.exists() && is_executable(p) {
                return Self {
                    bwrap: Some(p.clone()),
                    bundled: true,
                };
            }
        }
        if let Some(system) = which_bwrap() {
            Self {
                bwrap: Some(system),
                bundled: false,
            }
        } else {
            Self {
                bwrap: None,
                bundled: false,
            }
        }
    }
}

fn which_bwrap() -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_env) {
        let candidate = dir.join("bwrap");
        if candidate.exists() && is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match p.metadata() {
            Ok(m) => m.permissions().mode() & 0o111 != 0,
            Err(_) => false,
        }
    }
    #[cfg(not(unix))]
    {
        p.exists()
    }
}

#[async_trait]
impl SandboxedExec for LinuxSandboxBackend {
    async fn run(
        &self,
        mut command: SandboxCommand,
        policy: SandboxPolicy,
    ) -> Result<SandboxResult, SandboxError> {
        if command.argv.is_empty() {
            return Err(SandboxError::InvalidPolicy {
                reason: "argv must not be empty".into(),
            });
        }
        crate::validate_network(&policy)?;
        command.cwd = crate::paths::safe_canonicalize(&command.cwd).map_err(|e| {
            SandboxError::InvalidPolicy {
                reason: e.to_string(),
            }
        })?;
        let policy = crate::canonicalize_policy(policy)?;
        crate::reject_forbidden_paths(&command.cwd, &policy, &crate::forbidden_deny_roots())?;
        crate::launcher::reject_linux_bridge_collisions(&command, &policy)?;
        crate::env::filter_env(&mut command.env);
        // These are never trusted as proof of a bridge or used by its helper.
        command.env.remove("COGNIA_SANDBOX_PROXY_PORT");
        reject_forbidden_readable_roots(&policy)?;
        let bwrap = self
            .bwrap
            .clone()
            .ok_or_else(|| SandboxError::SetupRequired {
                reason: "bwrap binary not found".into(),
            })?;
        // The worker owns cleanup even if the caller drops this future. Closing
        // the channel cancels setup, input, output, or wait through one path.
        let (cancel, cancelled) = tokio::sync::oneshot::channel::<()>();
        let worker = tokio::spawn(run_owned(bwrap, command, policy, cancelled));
        let result = worker.await.map_err(|e| SandboxError::BackendFailed {
            reason: format!("sandbox lifecycle worker failed: {e}"),
        })?;
        drop(cancel);
        result
    }

    async fn probe_network_allowlist(&self) -> crate::types::NetworkAllowlistProbe {
        use crate::types::{NetworkAllowlistProbe, NetworkAllowlistState};
        let result = self
            .run(
                SandboxCommand {
                    argv: vec!["/bin/true".into()],
                    cwd: PathBuf::from("/tmp"),
                    env: Default::default(),
                    stdin: None,
                    timeout: Duration::from_secs(10),
                },
                SandboxPolicy::Bash {
                    writable: vec![],
                    readable: vec![],
                    network: NetworkPolicy::Allowlist {
                        hosts: vec!["example.invalid".into()],
                    },
                    max_cpu_seconds: 0,
                    max_memory_mb: 0,
                    max_processes: 0,
                },
            )
            .await;
        match result {
            Ok(r)
                if r.exit_code == 0
                    && !r.timed_out
                    && r.network.mechanism.as_deref() == Some("netns_unix_proxy") =>
            {
                NetworkAllowlistProbe {
                    state: NetworkAllowlistState::Available,
                    detail:
                        "network namespace and Unix proxy handshake completed; no external DNS used"
                            .into(),
                }
            }
            Ok(r) => NetworkAllowlistProbe {
                state: NetworkAllowlistState::Unavailable,
                detail: format!(
                    "allowlist probe exited {} (timeout={})",
                    r.exit_code, r.timed_out
                ),
            },
            Err(e) => NetworkAllowlistProbe {
                state: NetworkAllowlistState::Unavailable,
                detail: e.to_string(),
            },
        }
    }

    fn is_available(&self) -> bool {
        self.bwrap.is_some()
    }

    async fn first_time_setup(&self) -> Result<(), SandboxError> {
        if self.bwrap.is_some() {
            Ok(())
        } else {
            Err(SandboxError::SetupRequired {
                reason: "install `bubblewrap` from your distro package manager, \
                    or reinstall cognia with the bundled bwrap resource"
                    .into(),
            })
        }
    }

    fn health(&self) -> SandboxHealth {
        let available = self.is_available();
        let version = if available && self.bundled {
            "bundled".to_string()
        } else if available {
            "system".to_string()
        } else {
            String::new()
        };
        SandboxHealth {
            windows_capabilities: None,
            available,
            backend: "linux-bwrap".into(),
            version,
            last_error: if available {
                String::new()
            } else {
                "bwrap binary not found".into()
            },
        }
    }
}

/// Resources stay owned by the lifecycle worker until kill/reap and asynchronous
/// proxy shutdown have completed. The private directory is deliberately last.
#[derive(Default)]
struct RunResources {
    child: Option<tokio::process::Child>,
    proxy: Option<crate::net_proxy::FilteringProxy>,
    control: Option<tokio::net::UnixListener>,
    private_dir: Option<tempfile::TempDir>,
    handshake_completed: bool,
    namespace_init: Option<OwnedFd>,
    lifecycle: Option<tokio::net::UnixStream>,
    stdout: Option<crate::output::CappedOutput<tokio::process::ChildStdout>>,
    stderr: Option<crate::output::CappedOutput<tokio::process::ChildStderr>>,
}

impl RunResources {
    async fn cleanup(&mut self) -> Result<(), SandboxError> {
        let mut failure = None;
        // Killing PID 1 destroys the entire namespace, including setsid and
        // double-fork descendants. A pidfd cannot accidentally signal a reused PID.
        if let Some(init) = self.namespace_init.take() {
            if let Err(error) = kill_namespace(&init) {
                failure = Some(format!("namespace teardown failed: {error}"));
            }
        }
        self.lifecycle.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            match timeout(Duration::from_secs(2), child.wait()).await {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => failure = Some(format!("sandbox reap failed: {e}")),
                Err(_) => failure = Some("sandbox reap timed out after namespace teardown".into()),
            }
        }
        // Output pipes are not a lifetime authority. Drain only for a bounded
        // interval even if some unexpected holder prevents EOF.
        let drain_stdout = async {
            if let Some(output) = self.stdout.as_mut() {
                output.drain_for(Duration::from_millis(200)).await;
            }
        };
        let drain_stderr = async {
            if let Some(output) = self.stderr.as_mut() {
                output.drain_for(Duration::from_millis(200)).await;
            }
        };
        tokio::join!(drain_stdout, drain_stderr);
        if let Some(mut proxy) = self.proxy.take() {
            match timeout(Duration::from_secs(2), proxy.shutdown()).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => failure = Some(format!("proxy shutdown failed: {e}")),
                Err(_) => failure = Some("proxy shutdown timed out".into()),
            }
        }
        self.control.take();
        if let Some(dir) = self.private_dir.take() {
            if let Err(e) = dir.close() {
                failure = Some(format!("bridge directory cleanup failed: {e}"));
            }
        }
        match failure {
            Some(reason) => Err(SandboxError::BackendFailed { reason }),
            None => Ok(()),
        }
    }
}

/// Pin the actual namespace init, including bwrap's init on versions without
/// --as-pid-1. Authenticate the connecting helper before trusting Ready.
fn pin_namespace_init(peer: &tokio::net::UnixStream, bwrap_pid: i32) -> std::io::Result<OwnedFd> {
    let credentials = peer.peer_cred()?; // SO_PEERCRED, never protocol input.
    if credentials.uid() != unsafe { libc::geteuid() } {
        return Err(std::io::Error::other("bridge peer UID mismatch"));
    }
    let pid = credentials
        .pid()
        .ok_or_else(|| std::io::Error::other("bridge peer has no process credentials"))?;
    verify_run_peer(pid, bwrap_pid)?;
    let init = pin_namespace_init_pid(pid)?;
    // Recheck ancestry after pinning, before returning any authority to send Go.
    verify_run_peer(pid, bwrap_pid)?;
    Ok(init)
}

fn verify_run_peer(pid: i32, bwrap_pid: i32) -> std::io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    // Keep the namespace alive while comparing inodes (no inode reuse).
    let peer_namespace = std::fs::File::open(format!("/proc/{pid}/ns/pid"))?;
    let root_namespace = std::fs::File::open(format!("/proc/{bwrap_pid}/ns/pid"))?;
    let identity = |file: &std::fs::File| -> std::io::Result<_> {
        let metadata = file.metadata()?;
        Ok((metadata.dev(), metadata.ino()))
    };
    verify_run_lineage(
        pid,
        bwrap_pid,
        identity(&peer_namespace)?,
        identity(&root_namespace)?,
        |current| {
            let status = std::fs::read_to_string(format!("/proc/{current}/status"))?;
            let parent = status
                .lines()
                .find_map(|line| line.strip_prefix("PPid:"))
                .and_then(|value| value.trim().parse::<i32>().ok())
                .ok_or_else(|| std::io::Error::other("bridge parent PID unavailable"))?;
            let metadata = std::fs::metadata(format!("/proc/{current}/ns/pid"))?;
            Ok((parent, (metadata.dev(), metadata.ino())))
        },
    )
}

fn verify_run_lineage(
    mut pid: i32,
    bwrap_pid: i32,
    peer_namespace: (u64, u64),
    root_namespace: (u64, u64),
    mut process: impl FnMut(i32) -> std::io::Result<(i32, (u64, u64))>,
) -> std::io::Result<()> {
    if pid == bwrap_pid || peer_namespace == root_namespace {
        return Err(std::io::Error::other(
            "bridge did not enter this run's PID namespace",
        ));
    }
    let mut reached_outer_namespace = false;
    // bwrap can retain an outer waiter and an inner PID 1 reaper. Walk only
    // this child's ancestry, checking that the first descendant namespace it
    // created is exactly the peer's namespace, not a further nested one.
    // pid_for_children on the outer waiter is insufficient: clone(CLONE_NEWPID)
    // need not change the waiter's own namespace-for-children link.
    for _ in 0..4096 {
        if pid == bwrap_pid {
            return Ok(());
        }
        if pid <= 1 {
            break;
        }
        let (parent, namespace) = process(pid)?;
        if namespace == root_namespace {
            reached_outer_namespace = true;
        } else if namespace != peer_namespace || reached_outer_namespace {
            return Err(std::io::Error::other(
                "bridge descendant PID namespace mismatch",
            ));
        }
        pid = parent;
    }
    Err(std::io::Error::other(
        "bridge peer is not a descendant of this run's bwrap",
    ))
}

fn pin_namespace_init_pid(mut pid: i32) -> std::io::Result<OwnedFd> {
    use std::os::unix::fs::MetadataExt;
    let namespace = std::fs::File::open(format!("/proc/{pid}/ns/pid"))?;
    let identity = namespace.metadata()?;
    let host = std::fs::metadata("/proc/self/ns/pid")?;
    if (identity.dev(), identity.ino()) == (host.dev(), host.ino()) {
        return Err(std::io::Error::other(
            "bridge did not enter a PID namespace",
        ));
    }
    loop {
        let current = std::fs::metadata(format!("/proc/{pid}/ns/pid"))?;
        if (identity.dev(), identity.ino()) != (current.dev(), current.ino()) {
            return Err(std::io::Error::other(
                "namespace init not found in bridge ancestry",
            ));
        }
        let status = std::fs::read_to_string(format!("/proc/{pid}/status"))?;
        let field = |name: &str| status.lines().find_map(|line| line.strip_prefix(name));
        if field("NSpid:").and_then(|pids| pids.split_whitespace().last()) == Some("1") {
            let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
            if fd < 0 {
                return Err(std::io::Error::last_os_error());
            }
            let fd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
            // Revalidate after opening: pinning the namespace above prevents
            // its inode from being reused during this identity check.
            let current = std::fs::metadata(format!("/proc/{pid}/ns/pid"))?;
            if (identity.dev(), identity.ino()) != (current.dev(), current.ino()) {
                return Err(std::io::Error::other("bridge namespace identity changed"));
            }
            return Ok(fd);
        }
        pid = field("PPid:")
            .and_then(|value| value.trim().parse().ok())
            .filter(|parent| *parent > 0)
            .ok_or_else(|| std::io::Error::other("bridge parent PID unavailable"))?;
    }
}

fn kill_namespace(init: &OwnedFd) -> std::io::Result<()> {
    if unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            init.as_raw_fd(),
            libc::SIGKILL,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    } < 0
    {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error);
        }
    }
    Ok(())
}

fn requested_network(policy: &SandboxPolicy) -> NetworkPolicy {
    match policy {
        SandboxPolicy::Bash { network, .. } => network.clone(),
        _ => NetworkPolicy::Off,
    }
}

async fn run_owned(
    bwrap: PathBuf,
    command: SandboxCommand,
    policy: SandboxPolicy,
    mut cancelled: tokio::sync::oneshot::Receiver<()>,
) -> Result<SandboxResult, SandboxError> {
    let started = Instant::now();
    let duration = command.timeout;
    let requested = requested_network(&policy);
    let mut resources = RunResources::default();
    let result = {
        let operation = execute_owned(&bwrap, command, &policy, &mut resources);
        tokio::pin!(operation);
        let deadline = async {
            if duration.is_zero() {
                std::future::pending::<()>().await;
            } else {
                tokio::time::sleep(duration).await;
            }
        };
        tokio::select! {
            biased;
            _ = &mut cancelled => Err(SandboxError::BackendFailed { reason: "sandbox caller cancelled".into() }),
            _ = deadline => Ok(SandboxResult {
                exit_code: -1, stdout: String::new(), stderr: String::new(),
                duration: started.elapsed(), timed_out: true, stdout_truncated: false,
                stderr_truncated: false, network: Default::default(),
            }),
            result = &mut operation => result,
        }
    };
    resources.cleanup().await?;
    result.and_then(|mut r| {
        r.duration = started.elapsed();
        if let Some(output) = resources.stdout.take() {
            (r.stdout, r.stdout_truncated) = output.finish();
        }
        if let Some(output) = resources.stderr.take() {
            (r.stderr, r.stderr_truncated) = output.finish();
        }
        let allowlist = matches!(requested, NetworkPolicy::Allowlist { .. });
        r.network = crate::types::NetworkReport {
            requested: Some(requested.clone()),
            effective: if !allowlist || resources.handshake_completed {
                Some(requested)
            } else {
                None
            },
            mechanism: if allowlist {
                resources
                    .handshake_completed
                    .then(|| "netns_unix_proxy".into())
            } else {
                Some(
                    if matches!(requested_network(&policy), NetworkPolicy::Off) {
                        "netns"
                    } else {
                        "shared_network"
                    }
                    .into(),
                )
            },
        };
        if let Some(reason) = namespace_setup_denial(r.exit_code, &r.stdout, &r.stderr) {
            return Err(SandboxError::SetupRequired { reason });
        }
        Ok(r)
    })
}

/// Resolve only the running installation's helper, never PATH, a command env
/// override, or user argv. Test executables live in target/<profile>/deps.
fn trusted_bridge_helper() -> Result<PathBuf, SandboxError> {
    let exe = std::env::current_exe().map_err(setup_error)?;
    let parent = exe
        .parent()
        .ok_or_else(|| setup_error("current executable has no parent"))?;
    let candidate = if exe
        .file_name()
        .is_some_and(|n| n == "cognia-external-agent-launcher")
    {
        exe.clone()
    } else {
        let dir = if parent.file_name().is_some_and(|n| n == "deps") {
            parent.parent().unwrap_or(parent)
        } else {
            parent
        };
        dir.join("cognia-external-agent-launcher")
    };
    let helper = candidate.canonicalize().map_err(|e| {
        setup_error(format!(
            "Linux allowlist helper {} unavailable: {e}",
            candidate.display()
        ))
    })?;
    use std::os::unix::fs::MetadataExt;
    let metadata = helper.metadata().map_err(setup_error)?;
    if !helper.is_absolute()
        || !metadata.is_file()
        || !is_executable(&helper)
        || metadata.mode() & 0o022 != 0
        || (metadata.uid() != 0 && metadata.uid() != unsafe { libc::geteuid() })
    {
        return Err(setup_error(
            "Linux allowlist helper must be an owner-controlled absolute executable",
        ));
    }
    Ok(helper)
}

fn setup_error(error: impl std::fmt::Display) -> SandboxError {
    SandboxError::SetupRequired {
        reason: error.to_string(),
    }
}

/// A bounded executable probe using the same child guard/cleanup as the run.
async fn probe_program(
    resources: &mut RunResources,
    path: &Path,
    flag: &str,
) -> Result<String, SandboxError> {
    resources.child = Some(
        Command::new(path)
            .arg(flag)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(setup_error)?,
    );
    let child = resources.child.as_mut().expect("probe child");
    let stdout = child.stdout.take().expect("piped stdout");
    let (status, (output, truncated)) = timeout(Duration::from_secs(3), async {
        tokio::join!(child.wait(), crate::output::read_capped(stdout))
    })
    .await
    .map_err(|_| setup_error("bridge capability probe timed out"))?;
    let status = status.map_err(setup_error)?;
    resources.child.take();
    if !status.success() || truncated {
        return Err(setup_error("bridge capability probe failed"));
    }
    Ok(output)
}

async fn prepare_allowlist_run(
    resources: &mut RunResources,
    bwrap: &Path,
    hosts: &[String],
) -> Result<crate::launcher::LinuxBridgeLaunchSpec, SandboxError> {
    use std::os::unix::fs::PermissionsExt;
    let helper = trusted_bridge_helper()?;
    let version = probe_program(resources, &helper, "--linux-netns-bridge-version").await?;
    if version.trim() != crate::net_bridge::PROTOCOL_VERSION.to_string() {
        return Err(setup_error(
            "Linux allowlist helper protocol version mismatch",
        ));
    }
    let help = probe_program(resources, bwrap, "--help").await?;
    let dir = tempfile::Builder::new()
        .prefix("cognia-egress-")
        .tempdir()
        .map_err(setup_error)?;
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))
        .map_err(setup_error)?;
    let proxy_socket = dir.path().join("proxy.sock");
    let control_socket = dir.path().join("control.sock");
    resources.private_dir = Some(dir);
    resources.proxy = Some(
        crate::net_proxy::FilteringProxy::start_unix(
            &proxy_socket,
            crate::net_proxy::ProxyPolicy::from(hosts.to_vec()),
        )
        .await
        .map_err(setup_error)?,
    );
    std::fs::set_permissions(&proxy_socket, std::fs::Permissions::from_mode(0o600))
        .map_err(setup_error)?;
    resources.control = Some(tokio::net::UnixListener::bind(&control_socket).map_err(setup_error)?);
    std::fs::set_permissions(&control_socket, std::fs::Permissions::from_mode(0o600))
        .map_err(setup_error)?;
    Ok(crate::launcher::LinuxBridgeLaunchSpec {
        helper,
        proxy_socket,
        control_socket,
        as_pid_1: help.contains("--as-pid-1"),
    })
}

async fn execute_owned(
    bwrap: &Path,
    command: SandboxCommand,
    policy: &SandboxPolicy,
    resources: &mut RunResources,
) -> Result<SandboxResult, SandboxError> {
    let bridge = if let NetworkPolicy::Allowlist { hosts } = requested_network(policy) {
        Some(prepare_allowlist_run(resources, bwrap, &hosts).await?)
    } else {
        None
    };
    ensure_write_targets_exist(policy)?;
    let filter = if bridge.is_some() {
        crate::seccomp::build_allowlist_supervisor_filter()
    } else {
        crate::seccomp::build_filter()
    }
    .map_err(setup_error)?;
    let seccomp = crate::seccomp::park_program(&filter).map_err(setup_error)?;
    let args = render_bwrap_args(
        policy,
        &command,
        Some(crate::seccomp::SECCOMP_FD),
        bridge.as_ref(),
    )?;
    let mut cmd = Command::new(bwrap);
    cmd.args(args)
        .env_clear()
        .envs(&command.env)
        .kill_on_drop(true)
        .stdin(if bridge.is_none() && command.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::limits::apply_rlimits(&mut cmd, rlimits_for(policy));
    crate::seccomp::attach_program_fd(&mut cmd, seccomp.as_raw_fd());
    resources.child = Some(cmd.spawn().map_err(setup_error)?);
    drop(seccomp);
    // Create the target pipe only AFTER bwrap has spawned. Its parent and
    // optional PID 1 reaper inherit /dev/null and cannot retain a pipe end.
    let mut bridge_stdin = None;
    if let Some(control) = resources.control.as_ref() {
        let target_stdin = if command.stdin.is_some() {
            let (writer, reader) = tokio::net::unix::pipe::pipe().map_err(setup_error)?;
            bridge_stdin = Some(writer);
            reader.into_blocking_fd().map_err(setup_error)?
        } else {
            std::fs::File::open("/dev/null")
                .map_err(setup_error)?
                .into()
        };
        let init = &mut resources.namespace_init;
        let bwrap_pid = resources
            .child
            .as_ref()
            .and_then(|child| child.id())
            .ok_or_else(|| setup_error("bwrap exited before bridge handshake"))?
            as i32;
        resources.lifecycle = Some(
            crate::net_bridge::host_handshake(control, target_stdin, |peer| {
                *init = Some(pin_namespace_init(peer, bwrap_pid)?);
                Ok(())
            })
            .await
            .map_err(setup_error)?,
        );
        resources.handshake_completed = true;
    }
    let child = resources.child.as_mut().expect("sandbox child");
    resources.stdout = Some(crate::output::CappedOutput::new(
        child.stdout.take().expect("piped stdout"),
    ));
    resources.stderr = Some(crate::output::CappedOutput::new(
        child.stderr.take().expect("piped stderr"),
    ));
    let stdin = child.stdin.take();
    let input = async move {
        if let Some(payload) = command.stdin {
            let result = if let Some(mut writer) = bridge_stdin {
                crate::net_bridge::write_stdin(&mut writer, &payload, Duration::from_secs(5)).await
            } else if let Some(mut writer) = stdin {
                writer.write_all(&payload).await
            } else {
                return Err(SandboxError::BackendFailed {
                    reason: "sandbox stdin writer unavailable".into(),
                });
            };
            result.map_err(|error| SandboxError::BackendFailed {
                reason: format!("sandbox stdin write failed: {error}"),
            })?;
        }
        Ok::<_, SandboxError>(())
    };
    let wait = async { child.wait().await.map_err(setup_error) };
    let capture = async {
        tokio::join!(
            resources.stdout.as_mut().expect("stdout capture").drain(),
            resources.stderr.as_mut().expect("stderr capture").drain()
        );
        std::future::pending::<()>().await;
    };
    let completion = async {
        tokio::pin!(input, wait);
        tokio::select! {
            biased;
            result = &mut input => { result?; wait.await }
            status = &mut wait => {
                status?;
                Err(SandboxError::BackendFailed { reason: "sandbox exited before stdin delivery completed".into() })
            }
        }
    };
    let status = tokio::select! {
        result = completion => result?,
        _ = capture => unreachable!("capture remains pending after EOF"),
    };
    use std::os::unix::process::ExitStatusExt;
    let exit_code = status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(0));
    Ok(SandboxResult {
        exit_code,
        stdout: String::new(),
        stderr: String::new(),
        duration: Duration::ZERO,
        timed_out: false,
        stdout_truncated: false,
        stderr_truncated: false,
        network: Default::default(),
    })
}

/// Resolve the rlimit caps a policy asks for. Only `Bash` carries CPU /
/// memory / process caps; file-edit policies leave the wall-clock watchdog
/// as the sole control.
///
/// `max_processes` becomes `RLIMIT_NPROC`, which is correct HERE but not on
/// macOS: the backend unshares a user namespace (`--unshare-user`), and on
/// kernels with per-user-namespace process accounting (≥4.11) the counter is
/// scoped to the sandbox's own namespace — a fork bomb exhausts the sandbox
/// cap, not the login uid's.
fn rlimits_for(policy: &SandboxPolicy) -> crate::limits::ResolvedLimits {
    match policy {
        SandboxPolicy::Bash {
            max_cpu_seconds,
            max_memory_mb,
            max_processes,
            ..
        } => crate::limits::resolve_rlimits(*max_cpu_seconds, *max_memory_mb, *max_processes),
        _ => crate::limits::ResolvedLimits::default(),
    }
}

/// Defense-in-depth: refuse a readable root that would mount host runtime /
/// control-plane state into the sandbox before bwrap ever runs. The
/// dispatcher's `run_confined` enforces the same floor; a direct backend
/// call (no dispatcher) must not get a weaker bind set. Both the raw and the
/// symlink-resolved spelling of each candidate are checked.
fn reject_forbidden_readable_roots(policy: &SandboxPolicy) -> Result<(), SandboxError> {
    let readable: &[PathBuf] = match policy {
        SandboxPolicy::Bash { readable, .. }
        | SandboxPolicy::Edit { readable, .. }
        | SandboxPolicy::Write { readable, .. }
        | SandboxPolicy::TextEditor { readable, .. } => readable,
    };
    let deny = crate::protected::forbidden_readable_roots();
    for p in readable {
        let resolved = crate::paths::safe_canonicalize(p).unwrap_or_else(|_| p.clone());
        if crate::protected::is_forbidden_readable(&resolved, &deny)
            || crate::protected::is_forbidden_readable(p, &deny)
        {
            return Err(SandboxError::InvalidPolicy {
                reason: format!(
                    "'{}' reaches host runtime / control state and cannot be a sandbox readable root",
                    p.display()
                ),
            });
        }
    }
    Ok(())
}

/// Create any `Edit` / `Write` / `TextEditor` target that does not exist yet.
///
/// bwrap binds by path and errors with `Can't find source path` when a bind
/// SOURCE is missing, so without this a write aimed at a brand-new file failed
/// before the sandbox was even built. macOS has no equivalent problem, its
/// seatbelt rule is a `literal` path match that covers creating the file, so
/// the same tool call used to succeed on one platform and refuse on the other.
///
/// The file is created empty and exclusively (`create_new`), which also
/// refuses to follow a symlink planted at the target. Nothing widens: the file
/// created is exactly the one the policy already declares writable, and every
/// target has already passed the dispatcher's forbidden-path and
/// protected-path floors.
fn ensure_write_targets_exist(policy: &SandboxPolicy) -> Result<(), SandboxError> {
    let targets = match policy {
        SandboxPolicy::Edit { target_files, .. }
        | SandboxPolicy::Write { target_files, .. }
        | SandboxPolicy::TextEditor { target_files, .. } => target_files,
        SandboxPolicy::Bash { .. } => return Ok(()),
    };
    for target in targets {
        if target.exists() {
            continue;
        }
        let parent = target.parent().ok_or_else(|| SandboxError::InvalidPolicy {
            reason: format!("write target has no parent directory: {}", target.display()),
        })?;
        if !parent.is_dir() {
            return Err(SandboxError::InvalidPolicy {
                reason: format!(
                    "write target's directory does not exist: {}",
                    parent.display()
                ),
            });
        }
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(|e| SandboxError::InvalidPolicy {
                reason: format!("failed to create write target {}: {e}", target.display()),
            })?;
    }
    Ok(())
}

/// bwrap's own messages for "the kernel would not give this process a user
/// namespace". Matched on the stderr of a run that produced no stdout.
const NAMESPACE_DENIALS: &[&str] = &[
    "No permissions to create new namespace",
    "setting up uid map",
    "Creating new namespace failed",
    "Failed to make / slave",
    "loopback: Failed RTM_NEWADDR",
];

/// Recognise a failed sandbox SETUP, as opposed to a command that ran and
/// failed.
///
/// The distinction matters because the two are indistinguishable from the
/// outside: both are a non-zero exit with something on stderr, so a caller
/// reads "the sandbox could never work on this host" as "your command failed"
/// and retries forever. Ubuntu 24.04 reaches this out of the box, its
/// `kernel.apparmor_restrict_unprivileged_userns=1` moves any unconfined
/// process that creates a user namespace into a profile that denies every
/// capability, and its bubblewrap package ships no AppArmor profile of its own.
fn namespace_setup_denial(exit_code: i32, stdout: &str, stderr: &str) -> Option<String> {
    // A command that produced output ran. Only a setup failure is silent.
    if exit_code == 0 || !stdout.is_empty() {
        return None;
    }
    // Every bwrap diagnostic carries this prefix, so a child that happened to
    // print one of the phrases below is not mistaken for a setup failure.
    if !stderr.starts_with("bwrap: ") {
        return None;
    }
    if !NAMESPACE_DENIALS
        .iter()
        .any(|needle| stderr.contains(needle))
    {
        return None;
    }
    Some(format!(
        "the kernel refused this process a user namespace, so bwrap could not build the \
         sandbox and the command was NOT run ({}). On Ubuntu 24.04 and later this is the \
         default: give bwrap an AppArmor profile that permits `userns create`, or set \
         `kernel.apparmor_restrict_unprivileged_userns=0`. On other distributions check \
         `kernel.unprivileged_userns_clone` and `user.max_user_namespaces`.",
        stderr.trim()
    ))
}

/// Mount something EMPTY and read-only over `dest`, hiding any existing
/// content and preventing creation. A directory entry gets a fresh empty
/// tmpfs, remounted read-only; a file entry gets `/dev/null`. Either way the
/// mount is read-only, so writes fail and the (now-empty) target reveals
/// nothing, whether or not the path existed on the host.
///
/// The directory case used to bind a host directory the backend created under
/// `std::env::temp_dir()`, which is the shared `/tmp` on Linux. Any local
/// account can create entries there, so whoever won the race to create
/// `/tmp/cognia-sandbox-empty` chose what every "hide this credential store"
/// mount actually served: their own files, or, through a symlink to the real
/// home directory, the very secrets the mount exists to hide. A tmpfs needs no
/// host path at all, so the squat has nothing to aim at.
fn push_hidden_entry(args: &mut Vec<String>, kind: crate::protected::ProtKind, dest: &str) {
    match kind {
        crate::protected::ProtKind::Dir => {
            args.push("--tmpfs".into());
            args.push(dest.to_string());
            args.push("--remount-ro".into());
            args.push(dest.to_string());
        }
        crate::protected::ProtKind::File => {
            args.push("--ro-bind".into());
            args.push("/dev/null".into());
            args.push(dest.to_string());
        }
    }
}

/// Append the protected-path re-binds (last-wins) for a policy's writable +
/// readable roots:
///   * Under a WRITABLE root — SECRET stores are bound over with an empty
///     read-only source (no read, no write, no create, exist or not), while
///     WRITE-PROTECTED control files are re-bound read-only ONLY WHEN THEY
///     EXIST (rewrite of an existing repo's hooks / rc is denied, but a fresh
///     `git init` / new rc file still works — creating one isn't the threat).
///   * Under a READABLE-only root — SECRET stores that EXIST are still hidden
///     (read is the exfiltration threat); write-protected files are already
///     read-only there, and so is an absent secret store, which the sandboxed
///     process cannot create through a read-only mount.
fn push_protected_binds(args: &mut Vec<String>, writable: &[PathBuf], readable: &[PathBuf]) {
    for root in writable {
        for (protected, kind, secret) in crate::protected::protected_entries_under(root) {
            let dest = protected.to_string_lossy().into_owned();
            if secret {
                push_hidden_entry(args, kind, &dest);
            } else if protected.exists() {
                args.push("--ro-bind".into());
                args.push(dest.clone());
                args.push(dest);
            }
        }
    }
    for root in readable {
        for (protected, kind, secret) in crate::protected::protected_entries_under(root) {
            // Only entries that actually exist. A readable root is mounted
            // read-only, and bwrap has to mkdir a mount point before it can
            // cover it, so covering an ABSENT entry fails the whole call with
            // `Can't mkdir ...: Read-only file system`. One missing `.gnupg`
            // under one readable root was enough to make every sandboxed
            // command on that root fail. Nothing is lost: an entry that does
            // not exist cannot be read, and the read-only mount means the
            // sandboxed process cannot create it either.
            if secret && protected.exists() {
                let dest = protected.to_string_lossy().into_owned();
                push_hidden_entry(args, kind, &dest);
            }
        }
    }
}

/// Render `bwrap` argv for the given policy + command. Pure: no I/O beyond
/// `Path::exists` probes (so unit tests are deterministic on any host). The
/// returned vec is the args BEFORE `--` (the target argv comes after).
/// `seccomp_fd` is the descriptor the compiled syscall filter was parked on,
/// or `None` when the filter could not be built and the run proceeds on
/// namespace isolation alone.
fn render_bwrap_args(
    policy: &SandboxPolicy,
    command: &SandboxCommand,
    seccomp_fd: Option<std::os::fd::RawFd>,
    bridge: Option<&crate::launcher::LinuxBridgeLaunchSpec>,
) -> Result<Vec<String>, SandboxError> {
    // Isolation baseline. Order matters: namespace flags first.
    let mut args: Vec<String> = vec![
        "--unshare-user".into(),
        "--unshare-pid".into(),
        "--unshare-ipc".into(),
        "--unshare-uts".into(),
        "--die-with-parent".into(),
        // Detach the controlling terminal. Without it the sandboxed process keeps
        // the caller's session and can push characters back into the terminal that
        // launched the app with `TIOCSTI`. Nothing here is interactive (stdio are
        // always pipes), so there is no session to lose.
        "--new-session".into(),
    ];
    // Hand the compiled syscall filter to bwrap, which installs it on the
    // sandboxed process right before exec. See `sandbox::seccomp` for why it
    // must not be installed on bwrap itself.
    if let Some(fd) = seccomp_fd {
        args.push("--seccomp".into());
        args.push(fd.to_string());
    }

    // System paths a typical program needs to dynamic-link and run. Broadened
    // beyond the bare loader set so real toolchains (compilers, git, node,
    // package managers living under /bin · /sbin · /opt) work; `/etc` is bound
    // read-only for CA bundles, nsswitch, and ld config. Each is existence-
    // gated because bwrap errors on a missing bind source.
    let ro_system = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/etc"];
    for p in ro_system.iter() {
        if Path::new(p).exists() {
            args.push("--ro-bind".into());
            args.push((*p).into());
            args.push((*p).into());
        }
    }
    // /proc, /dev, /tmp via virtual mounts.
    args.push("--proc".into());
    args.push("/proc".into());
    args.push("--dev".into());
    args.push("/dev".into());
    args.push("--tmpfs".into());
    args.push("/tmp".into());

    // cwd needs to exist inside the sandbox.
    let cwd_str = command.cwd.to_string_lossy().into_owned();
    if !cwd_str.is_empty() {
        args.push("--chdir".into());
        args.push(cwd_str);
    }

    // Per-policy bindings.
    match policy {
        SandboxPolicy::Bash {
            writable,
            readable,
            network,
            ..
        } => {
            for p in readable {
                args.push("--ro-bind".into());
                args.push(p.to_string_lossy().into_owned());
                args.push(p.to_string_lossy().into_owned());
            }
            for p in writable {
                args.push("--bind".into());
                args.push(p.to_string_lossy().into_owned());
                args.push(p.to_string_lossy().into_owned());
            }
            // Re-deny credential / VCS-control / app-data paths under the
            // writable + readable roots (last bwrap bind wins). See
            // `push_protected_binds`.
            push_protected_binds(&mut args, writable, readable);
            let _ = network;
        }
        SandboxPolicy::Edit {
            target_files,
            readable,
        }
        | SandboxPolicy::Write {
            target_files,
            readable,
        }
        | SandboxPolicy::TextEditor {
            target_files,
            readable,
        } => {
            for p in readable {
                args.push("--ro-bind".into());
                args.push(p.to_string_lossy().into_owned());
                args.push(p.to_string_lossy().into_owned());
            }
            // Edit / Write / TextEditor bind only the exact files (not the
            // parent dir) as writable — matches the macOS `literal` model. A
            // target aimed at a protected path is already refused upstream by
            // the dispatcher (`is_protected_anywhere`).
            for f in target_files {
                args.push("--bind".into());
                args.push(f.to_string_lossy().into_owned());
                args.push(f.to_string_lossy().into_owned());
            }
            // Hide secret stores reachable through the readable roots (read is
            // the exfiltration threat) — bind last so it wins.
            push_protected_binds(&mut args, &[], readable);
            // Always net-off for edit / write / text_editor.
        }
    }

    args.extend(crate::launcher::render_linux_network_launch(
        &requested_network(policy),
        bridge,
        &command.argv,
    )?);
    Ok(args)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn run_lineage_requires_owned_ancestry_and_exact_descendant_namespace() {
        let host = (4, 100);
        let sandbox = (4, 200);
        let nested = (4, 300);
        let check = |peer, nodes: &[(i32, i32, (u64, u64))]| {
            verify_run_lineage(40, 10, peer, host, |pid| {
                nodes
                    .iter()
                    .find(|node| node.0 == pid)
                    .map(|node| (node.1, node.2))
                    .ok_or_else(|| std::io::Error::other("process vanished"))
            })
        };
        // --as-pid-1 and older bwrap with an inner reaper/outer waiter.
        assert!(check(sandbox, &[(40, 10, sandbox)]).is_ok());
        assert!(check(
            sandbox,
            &[(40, 30, sandbox), (30, 20, sandbox), (20, 10, host)]
        )
        .is_ok());
        // A foreign namespace alone is not authority; its lineage must end at
        // the particular bwrap child, not at the host or a sibling run.
        assert!(check(sandbox, &[(40, 20, sandbox), (20, 1, host)]).is_err());
        assert!(check(nested, &[(40, 30, nested), (30, 10, sandbox)]).is_err());
        assert!(check(host, &[(40, 10, host)]).is_err());
        assert!(check(sandbox, &[(40, 30, sandbox)]).is_err());
        assert!(check(sandbox, &[(40, 40, sandbox)]).is_err());
        assert!(check(sandbox, &[(40, 30, host), (30, 10, sandbox)]).is_err());
    }

    #[test]
    fn namespace_guard_refuses_the_hosts_own_namespace() {
        let error = pin_namespace_init_pid(std::process::id() as i32).unwrap_err();
        assert!(error.to_string().contains("did not enter a PID namespace"));
    }

    #[tokio::test]
    async fn direct_backend_rejects_empty_allowlist_and_reserved_or_protected_paths() {
        let backend = LinuxSandboxBackend {
            bwrap: None,
            bundled: false,
        };
        let mut command = cmd();
        command.cwd = PathBuf::from("/tmp");
        command
            .env
            .insert("COGNIA_SANDBOX_PROXY_PORT".into(), "1234".into());
        let mut policy = SandboxPolicy::Bash {
            writable: vec![],
            readable: vec![],
            network: NetworkPolicy::Allowlist { hosts: vec![] },
            max_cpu_seconds: 0,
            max_memory_mb: 0,
            max_processes: 0,
        };
        assert!(matches!(
            backend.run(command.clone(), policy.clone()).await,
            Err(SandboxError::InvalidPolicy { .. })
        ));
        if let SandboxPolicy::Bash {
            network, writable, ..
        } = &mut policy
        {
            *network = NetworkPolicy::Allowlist {
                hosts: vec!["example.com".into()],
            };
            writable.push(PathBuf::from("/run/cognia-egress"));
        }
        assert!(matches!(
            backend.run(command.clone(), policy).await,
            Err(SandboxError::InvalidPolicy { .. })
        ));
        let protected = SandboxPolicy::Edit {
            target_files: vec![PathBuf::from("/tmp/work/.ssh/id_rsa")],
            readable: vec![],
        };
        assert!(matches!(
            backend.run(command, protected).await,
            Err(SandboxError::InvalidPolicy { .. })
        ));
    }

    #[test]
    fn bridge_mounts_and_command_follow_all_user_binds() {
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/workspace")],
            readable: vec![],
            network: NetworkPolicy::Allowlist {
                hosts: vec!["example.com".into()],
            },
            max_cpu_seconds: 0,
            max_memory_mb: 0,
            max_processes: 0,
        };
        assert!(matches!(
            render_bwrap_args(&policy, &cmd(), None, None),
            Err(SandboxError::SetupRequired { .. })
        ));
        let bridge = crate::launcher::LinuxBridgeLaunchSpec {
            helper: "/trusted/helper".into(),
            proxy_socket: "/private/proxy.sock".into(),
            control_socket: "/private/control.sock".into(),
            as_pid_1: true,
        };
        let args = render_bwrap_args(
            &policy,
            &cmd(),
            Some(crate::seccomp::SECCOMP_FD),
            Some(&bridge),
        )
        .unwrap();
        let user_bind = args
            .windows(3)
            .position(|w| w == ["--bind", "/workspace", "/workspace"])
            .unwrap();
        let bridge_bind = args
            .windows(3)
            .position(|w| {
                w == [
                    "--ro-bind",
                    "/private/proxy.sock",
                    "/run/cognia-egress/proxy.sock",
                ]
            })
            .unwrap();
        assert!(bridge_bind > user_bind);
        assert!(!args.contains(&"--share-net".into()));
        assert!(args
            .windows(2)
            .any(|w| w == ["--tmpfs", "/run/cognia-egress"]));
        assert!(args
            .windows(2)
            .any(|w| w == ["--remount-ro", "/run/cognia-egress"]));
        assert_eq!(args.last().unwrap(), "ls");
    }

    #[tokio::test]
    async fn timeout_returns_truthful_result_when_bwrap_is_available() {
        let backend = LinuxSandboxBackend::new(None);
        if !backend.is_available() {
            return;
        }
        let result = backend
            .run(
                SandboxCommand {
                    argv: vec!["/usr/bin/tail".into(), "-f".into(), "/dev/null".into()],
                    cwd: PathBuf::from("/tmp"),
                    env: BTreeMap::new(),
                    stdin: None,
                    timeout: Duration::from_secs(1),
                },
                SandboxPolicy::Bash {
                    writable: vec![PathBuf::from("/tmp")],
                    readable: vec![],
                    network: NetworkPolicy::Off,
                    max_cpu_seconds: 0,
                    max_memory_mb: 0,
                    max_processes: 0,
                },
            )
            .await
            .expect("timeout is a result, not a backend error");

        assert!(result.timed_out);
        assert_eq!(result.exit_code, -1);
        assert!(result.stdout.is_empty());
        assert!(!result.stdout_truncated);
    }

    fn cmd() -> SandboxCommand {
        SandboxCommand {
            argv: vec!["ls".into()],
            cwd: PathBuf::from("/workspace"),
            env: BTreeMap::new(),
            stdin: None,
            timeout: Duration::from_secs(5),
        }
    }

    /// Find `--ro-bind <src> <dest>` triples and return the matching `src`.
    fn ro_bind_src_for(args: &[String], dest: &str) -> Option<String> {
        args.windows(3)
            .find(|w| w[0] == "--ro-bind" && w[2] == dest)
            .map(|w| w[1].clone())
    }

    /// True when `dest` gets a fresh empty tmpfs that is then remounted
    /// read-only, which is how a secret DIRECTORY is hidden.
    fn hidden_by_readonly_tmpfs(args: &[String], dest: &str) -> bool {
        let tmpfs = args.windows(2).any(|w| w[0] == "--tmpfs" && w[1] == dest);
        let remounted = args
            .windows(2)
            .any(|w| w[0] == "--remount-ro" && w[1] == dest);
        tmpfs && remounted
    }

    #[test]
    fn secret_protected_path_is_hidden_without_a_host_directory() {
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/workspace")],
            readable: vec![],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
            max_processes: 0,
        };
        let args = render_bwrap_args(&policy, &cmd(), None, None).unwrap();
        // `.ssh` (secret dir) is shadowed by an empty read-only tmpfs, so it is
        // neither readable nor writable nor creatable, whether or not it
        // exists. It must NOT be a bind from a host path: the host path this
        // used to bind lived in the shared `/tmp`, where any local account
        // could replace it and choose what the sandbox saw here instead.
        assert!(hidden_by_readonly_tmpfs(&args, "/workspace/.ssh"));
        assert_eq!(ro_bind_src_for(&args, "/workspace/.ssh"), None);
        // `.git-credentials` (secret file) is shadowed by /dev/null.
        assert_eq!(
            ro_bind_src_for(&args, "/workspace/.git-credentials").as_deref(),
            Some("/dev/null")
        );
    }

    #[test]
    fn absent_write_protected_path_is_left_creatable_but_absent_secret_is_blocked() {
        let root = "/definitely/not/here/clean-root";
        let policy = SandboxPolicy::Bash {
            // A path that does not exist on the test host — neither `.git` nor
            // `.ssh` under it exists either.
            writable: vec![PathBuf::from(root)],
            readable: vec![],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
            max_processes: 0,
        };
        let args = render_bwrap_args(&policy, &cmd(), None, None).unwrap();
        // `.git` is write-protected and absent → NOT bound, so `git init` still
        // works (the threat is rewriting an EXISTING repo, handled when present).
        assert_eq!(ro_bind_src_for(&args, &format!("{root}/.git")), None);
        // `.ssh` is a SECRET store → covered even when absent, so the command
        // can't create `~/.ssh/authorized_keys` in a clean root.
        assert!(hidden_by_readonly_tmpfs(&args, &format!("{root}/.ssh")));
    }

    #[test]
    fn secrets_under_a_readable_root_are_hidden() {
        let home = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(home.path().join(".ssh")).expect("mkdir .ssh");
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/workspace")],
            readable: vec![home.path().to_path_buf()],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
            max_processes: 0,
        };
        let args = render_bwrap_args(&policy, &cmd(), None, None).unwrap();
        // `.ssh` reachable through the readable root is shadowed so it can't
        // be read.
        let ssh = home.path().join(".ssh");
        assert!(hidden_by_readonly_tmpfs(&args, &ssh.to_string_lossy()));
    }

    #[test]
    fn absent_secrets_under_a_readable_root_are_left_alone() {
        let home = tempfile::tempdir().expect("tempdir");
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/workspace")],
            readable: vec![home.path().to_path_buf()],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
            max_processes: 0,
        };
        let args = render_bwrap_args(&policy, &cmd(), None, None).unwrap();
        // A readable root is mounted read-only, and bwrap mkdirs a mount point
        // before covering it. Covering an entry that is not there fails the
        // whole call with `Can't mkdir ...: Read-only file system`, so one
        // missing `.gnupg` under one readable root used to break every command
        // that named it. Nothing is exposed by skipping it: it does not exist,
        // and the read-only mount stops the sandbox creating it.
        let gnupg = home.path().join(".gnupg");
        assert!(!hidden_by_readonly_tmpfs(&args, &gnupg.to_string_lossy()));
        assert_eq!(ro_bind_src_for(&args, &gnupg.to_string_lossy()), None);
    }

    #[test]
    fn absent_secrets_under_a_writable_root_are_still_covered() {
        let root = tempfile::tempdir().expect("tempdir");
        let policy = SandboxPolicy::Bash {
            writable: vec![root.path().to_path_buf()],
            readable: vec![],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
            max_processes: 0,
        };
        let args = render_bwrap_args(&policy, &cmd(), None, None).unwrap();
        // A writable root IS creatable, so an absent secret store must still be
        // covered or the sandboxed process could write `~/.ssh/authorized_keys`
        // into a clean root.
        let ssh = root.path().join(".ssh");
        assert!(hidden_by_readonly_tmpfs(&args, &ssh.to_string_lossy()));
    }

    #[test]
    fn bwrap_args_include_isolation_baseline() {
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/workspace")],
            readable: vec![],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
            max_processes: 0,
        };
        let args = render_bwrap_args(&policy, &cmd(), None, None).unwrap();
        assert!(args.iter().any(|s| s == "--unshare-pid"));
        assert!(args.iter().any(|s| s == "--unshare-net"));
        assert!(args.iter().any(|s| s == "--die-with-parent"));
        // Detached from the caller's terminal, so the sandboxed process cannot
        // push input back into it.
        assert!(args.iter().any(|s| s == "--new-session"));
        // chdir into cwd.
        let i = args
            .iter()
            .position(|s| s == "--chdir")
            .expect("chdir present");
        assert_eq!(args[i + 1], "/workspace");
    }

    #[test]
    fn bwrap_args_bind_writable_read_write() {
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/workspace")],
            readable: vec![PathBuf::from("/usr/local/include")],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
            max_processes: 0,
        };
        let args = render_bwrap_args(&policy, &cmd(), None, None).unwrap();
        let bind_idx = args
            .iter()
            .position(|s| s == "--bind")
            .expect("bind present");
        assert_eq!(args[bind_idx + 1], "/workspace");
        let ro_idx = args
            .iter()
            .enumerate()
            .find(|(_, s)| s.as_str() == "--ro-bind")
            .map(|(i, _)| i)
            .expect("ro-bind present");
        // Some entries are system-system; advance to find /usr/local/include.
        let contains_target = args.windows(3).any(|w| {
            w[0] == "--ro-bind" && w[1] == "/usr/local/include" && w[2] == "/usr/local/include"
        });
        assert!(
            contains_target,
            "ro-bind /usr/local/include not found ; first ro-bind at {ro_idx}"
        );
    }

    #[test]
    fn bwrap_args_use_share_net_when_on() {
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/tmp")],
            readable: vec![],
            network: NetworkPolicy::On,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
            max_processes: 0,
        };
        let args = render_bwrap_args(&policy, &cmd(), None, None).unwrap();
        assert!(args.iter().any(|s| s == "--share-net"));
        assert!(!args.iter().any(|s| s == "--unshare-net"));
    }

    #[test]
    fn edit_policy_binds_files_only_not_subtrees() {
        let policy = SandboxPolicy::Edit {
            target_files: vec![PathBuf::from("/repo/a.txt")],
            readable: vec![],
        };
        let args = render_bwrap_args(&policy, &cmd(), None, None).unwrap();
        // The exact file is writable via --bind.
        let contains_file = args
            .windows(3)
            .any(|w| w[0] == "--bind" && w[1] == "/repo/a.txt" && w[2] == "/repo/a.txt");
        assert!(contains_file);
        // Net always off for edit.
        assert!(args.iter().any(|s| s == "--unshare-net"));
    }

    #[test]
    fn seccomp_filter_is_handed_to_bwrap_not_applied_to_it() {
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/workspace")],
            readable: vec![],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
            max_processes: 0,
        };
        // With a parked program, bwrap is told which descriptor to read it
        // from. Applying the same filter to bwrap itself denies the `mount`,
        // `unshare` and `pivot_root` calls bwrap needs to build the sandbox,
        // which is how every Linux sandbox call came back as
        // `bwrap: Failed to make / slave: Operation not permitted`.
        let args =
            render_bwrap_args(&policy, &cmd(), Some(crate::seccomp::SECCOMP_FD), None).unwrap();
        let idx = args
            .iter()
            .position(|s| s == "--seccomp")
            .expect("--seccomp present when a program is parked");
        assert_eq!(args[idx + 1], crate::seccomp::SECCOMP_FD.to_string());

        // Without one the run proceeds on namespace isolation alone, and bwrap
        // must not be handed a descriptor that holds nothing.
        let none = render_bwrap_args(&policy, &cmd(), None, None).unwrap();
        assert!(!none.iter().any(|s| s == "--seccomp"));
    }

    #[test]
    fn absent_write_target_is_created_before_the_binds() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("brand-new.txt");
        let policy = SandboxPolicy::Write {
            target_files: vec![target.clone()],
            readable: vec![],
        };
        // bwrap refuses a missing bind source, so an uncreated target would
        // fail the whole call with `Can't find source path` before the sandbox
        // existed. macOS allows creating it, so leaving this out made the same
        // tool call platform-dependent.
        ensure_write_targets_exist(&policy).expect("target is created");
        assert!(target.is_file());
        assert_eq!(std::fs::read(&target).expect("readable"), Vec::<u8>::new());

        // Idempotent, and it never truncates an existing file.
        std::fs::write(&target, b"kept").expect("write");
        ensure_write_targets_exist(&policy).expect("existing target is left alone");
        assert_eq!(std::fs::read(&target).expect("readable"), b"kept");
    }

    #[test]
    fn write_target_in_a_missing_directory_is_refused_not_created() {
        let dir = tempfile::tempdir().expect("tempdir");
        let policy = SandboxPolicy::Write {
            target_files: vec![dir.path().join("no-such-dir").join("f.txt")],
            readable: vec![],
        };
        // Creating the parent chain would let a write target conjure
        // directories outside anything the policy declared.
        let err = ensure_write_targets_exist(&policy).expect_err("refused");
        assert!(matches!(err, SandboxError::InvalidPolicy { .. }), "{err:?}");
    }

    #[test]
    fn bash_policy_creates_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let policy = SandboxPolicy::Bash {
            writable: vec![dir.path().to_path_buf()],
            readable: vec![],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
            max_processes: 0,
        };
        ensure_write_targets_exist(&policy).expect("no targets to create");
        assert!(std::fs::read_dir(dir.path())
            .expect("readable")
            .next()
            .is_none());
    }

    #[test]
    fn namespace_denial_is_a_setup_failure_not_a_command_failure() {
        // Ubuntu 24.04 out of the box. The command never ran, so reporting an
        // exit code invites the caller to retry against a host that will never
        // run it.
        let reason =
            namespace_setup_denial(1, "", "bwrap: setting up uid map: Permission denied\n")
                .expect("recognised as a setup failure");
        assert!(
            reason.contains("apparmor_restrict_unprivileged_userns"),
            "{reason}"
        );
        assert!(reason.contains("NOT run"), "{reason}");
    }

    #[test]
    fn a_command_that_ran_is_never_reported_as_a_setup_failure() {
        // Exit 0 is a success whatever is on stderr.
        assert!(namespace_setup_denial(0, "", "bwrap: setting up uid map: nope").is_none());
        // Output means the sandbox was built and the command ran.
        assert!(namespace_setup_denial(1, "partial", "bwrap: setting up uid map: nope").is_none());
        // A child echoing the phrase is not bwrap: the prefix gates it.
        assert!(namespace_setup_denial(1, "", "setting up uid map: Permission denied").is_none());
        // A genuine command failure passes through untouched.
        assert!(namespace_setup_denial(2, "", "bwrap: some other complaint").is_none());
    }

    #[test]
    fn health_reports_linux_bwrap_backend_string() {
        let backend = LinuxSandboxBackend::new(None);
        let h = backend.health();
        assert_eq!(h.backend, "linux-bwrap");
        // is_available depends on the host; just verify the contract holds.
        if h.available {
            assert!(!h.version.is_empty());
        } else {
            assert!(!h.last_error.is_empty());
        }
    }

    #[test]
    fn rlimits_for_passes_the_process_cap_through() {
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/workspace")],
            readable: vec![],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
            max_processes: 512,
        };
        // Inside the unshared user namespace this lands as RLIMIT_NPROC on
        // the sandbox's own ucount — see `limits::apply_rlimits`.
        assert_eq!(rlimits_for(&policy).processes, Some(512));
    }

    #[test]
    fn bwrap_args_never_bind_the_docker_socket() {
        // The socket is a host control plane. bwrap only exposes paths that
        // are explicitly bound, so the assertion is that nothing under the
        // runtime dirs is ever a bind source — the audit's `readable:
        // ["/var/run"]` path is refused before render, and a policy that
        // passed no readable roots must produce no socket-bearing args.
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/workspace")],
            readable: vec![],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
            max_processes: 0,
        };
        let args = render_bwrap_args(&policy, &cmd(), None, None).unwrap();
        assert!(
            !args.iter().any(|a| a.contains("docker.sock")),
            "docker socket must never appear in bwrap argv: {args:?}"
        );
        for w in args.windows(3) {
            if w[0] == "--bind" || w[0] == "--ro-bind" {
                assert!(
                    !w[1].starts_with("/var") && !w[1].starts_with("/run"),
                    "host runtime dir bound into the sandbox: {w:?}"
                );
            }
        }
    }

    #[test]
    fn backend_rejects_a_readable_root_under_var_run() {
        // Defense-in-depth: a caller that reaches the backend directly
        // (bypassing `run_confined`) gets the same refusal.
        for bad in ["/var/run", "/var", "/proc", "/run", "/"] {
            let policy = SandboxPolicy::Bash {
                writable: vec![PathBuf::from("/workspace")],
                readable: vec![PathBuf::from(bad)],
                network: NetworkPolicy::Off,
                max_cpu_seconds: 0,
                max_memory_mb: 0,
                max_processes: 0,
            };
            assert!(
                matches!(
                    reject_forbidden_readable_roots(&policy),
                    Err(SandboxError::InvalidPolicy { .. })
                ),
                "{bad} must be refused"
            );
        }
        let ok = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/workspace")],
            readable: vec![PathBuf::from("/usr/local/include")],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
            max_processes: 0,
        };
        assert!(reject_forbidden_readable_roots(&ok).is_ok());
    }

    /// Runtime proof on Linux: inside the bwrap sandbox the docker socket is
    /// simply absent — nothing under `/var/run` is bound, and the PID/mount
    /// namespaces start from a clean slate. Self-skips on hosts without a
    /// usable bwrap + user namespaces (same convention as the timeout test
    /// above).
    #[tokio::test]
    async fn docker_socket_is_unreachable_inside_the_sandbox() {
        let backend = LinuxSandboxBackend::new(None);
        if !backend.is_available() {
            return;
        }
        let result = backend
            .run(
                SandboxCommand {
                    argv: vec![
                        "/bin/sh".into(),
                        "-c".into(),
                        "test -e /var/run/docker.sock && exit 11; \
                         ls /var/run >/dev/null 2>&1 && exit 12; \
                         exit 0"
                            .into(),
                    ],
                    cwd: PathBuf::from("/tmp"),
                    env: BTreeMap::new(),
                    stdin: None,
                    timeout: Duration::from_secs(10),
                },
                SandboxPolicy::Bash {
                    writable: vec![PathBuf::from("/tmp")],
                    readable: vec![],
                    network: NetworkPolicy::Off,
                    max_cpu_seconds: 0,
                    max_memory_mb: 0,
                    max_processes: 0,
                },
            )
            .await
            .expect("the run itself must succeed — a refusal means bwrap could not start");
        assert_eq!(result.exit_code, 0, "{}", result.stderr);
    }

    /// Runtime proof the kernel reports the policy's process cap inside the
    /// sandbox. Read procfs because `ulimit -u` is unsupported by dash (/bin/sh).
    #[tokio::test]
    async fn process_cap_is_visible_as_nproc_inside_the_sandbox() {
        let backend = LinuxSandboxBackend::new(None);
        if !backend.is_available() {
            return;
        }
        let result = backend
            .run(
                SandboxCommand {
                    argv: vec![
                        "/bin/sh".into(),
                        "-c".into(),
                        "while read -r name kind soft hard rest; do \
                         case \"$name $kind\" in 'Max processes') printf '%s\\n' \"$soft\";; esac; \
                         done < /proc/self/limits"
                            .into(),
                    ],
                    cwd: PathBuf::from("/tmp"),
                    env: BTreeMap::new(),
                    stdin: None,
                    timeout: Duration::from_secs(10),
                },
                SandboxPolicy::Bash {
                    writable: vec![PathBuf::from("/tmp")],
                    readable: vec![],
                    network: NetworkPolicy::Off,
                    max_cpu_seconds: 0,
                    max_memory_mb: 0,
                    max_processes: 64,
                },
            )
            .await
            .expect("the run itself must succeed");
        assert_eq!(result.exit_code, 0, "{}", result.stderr);
        assert_eq!(result.stdout.trim(), "64", "RLIMIT_NPROC was not applied");
    }
}
