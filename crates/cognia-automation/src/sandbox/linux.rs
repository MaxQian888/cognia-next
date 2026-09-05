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

use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::sandbox::traits::SandboxedExec;
use crate::sandbox::types::{
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
        // Defense-in-depth: scrub code-injection env vars at the exec boundary
        // too, so a direct backend call (not just `run_confined`) is safe.
        crate::sandbox::env::filter_env(&mut command.env);
        let Some(bwrap) = self.bwrap.as_ref() else {
            return Err(SandboxError::Unavailable {
                reason: "bwrap binary not found (no bundled + not on PATH)".into(),
            });
        };

        // bwrap binds by path and refuses a missing bind SOURCE, so a write
        // target that does not exist yet has to be created before the mounts
        // are built.
        ensure_write_targets_exist(&policy)?;

        // Defence-in-depth syscall filter, parked on a descriptor for bwrap to
        // install on the sandboxed process. `seccomp_program` owns that
        // descriptor and must outlive the spawn below.
        let seccomp_program = match crate::sandbox::seccomp::build_filter() {
            Ok(bpf) => match crate::sandbox::seccomp::park_program(&bpf) {
                Ok(file) => Some(file),
                Err(e) => {
                    eprintln!(
                        "sandbox: seccomp program could not be parked, proceeding \
                         namespace-only: {e}"
                    );
                    None
                }
            },
            Err(e) => {
                eprintln!("sandbox: seccomp unavailable, proceeding namespace-only: {e}");
                None
            }
        };
        let bwrap_args = render_bwrap_args(
            &policy,
            &command,
            seccomp_program
                .as_ref()
                .map(|_| crate::sandbox::seccomp::SECCOMP_FD),
        );

        let mut cmd = Command::new(bwrap);
        for a in &bwrap_args {
            cmd.arg(a);
        }
        cmd.arg("--");
        for a in &command.argv {
            cmd.arg(a);
        }

        cmd.env_clear()
            .envs(&command.env)
            .kill_on_drop(true)
            .stdin(if command.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Resource limits (opt-in) + seccomp defense-in-depth. Both are
        // applied to the `bwrap` process via `pre_exec` and inherited into the
        // sandboxed command. seccomp is best-effort — namespaces remain the
        // boundary if filter construction fails on an exotic arch.
        crate::sandbox::limits::apply_rlimits(&mut cmd, rlimits_for(&policy));
        if let Some(program) = seccomp_program.as_ref() {
            crate::sandbox::seccomp::attach_program_fd(&mut cmd, program.as_raw_fd());
        }

        let started = Instant::now();
        let mut child = cmd.spawn().map_err(|e| SandboxError::BackendFailed {
            reason: format!("failed to spawn bwrap: {e}"),
        })?;

        if let Some(payload) = command.stdin {
            if let Some(mut stdin) = child.stdin.take() {
                stdin
                    .write_all(&payload)
                    .await
                    .map_err(|e| SandboxError::BackendFailed {
                        reason: format!("failed to write stdin: {e}"),
                    })?;
                drop(stdin);
            }
        }

        let timeout_secs = command.timeout.as_secs();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| SandboxError::BackendFailed {
                reason: "bwrap stdout pipe was unavailable".into(),
            })?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| SandboxError::BackendFailed {
                reason: "bwrap stderr pipe was unavailable".into(),
            })?;
        let stdout_task = tokio::spawn(crate::sandbox::output::read_capped(stdout));
        let stderr_task = tokio::spawn(crate::sandbox::output::read_capped(stderr));
        let wait_future = child.wait();
        let timed_out;
        let status = if timeout_secs == 0 {
            timed_out = false;
            match wait_future.await {
                Ok(out) => out,
                Err(e) => {
                    stdout_task.abort();
                    stderr_task.abort();
                    let _ = stdout_task.await;
                    let _ = stderr_task.await;
                    return Err(SandboxError::BackendFailed {
                        reason: format!("wait failed: {e}"),
                    });
                }
            }
        } else {
            match timeout(Duration::from_secs(timeout_secs), wait_future).await {
                Ok(Ok(out)) => {
                    timed_out = false;
                    out
                }
                Ok(Err(e)) => {
                    stdout_task.abort();
                    stderr_task.abort();
                    let _ = stdout_task.await;
                    let _ = stderr_task.await;
                    return Err(SandboxError::BackendFailed {
                        reason: format!("wait failed: {e}"),
                    });
                }
                Err(_) => {
                    let _ = child.start_kill();
                    timed_out = true;
                    match child.wait().await {
                        Ok(out) => out,
                        Err(e) => {
                            stdout_task.abort();
                            stderr_task.abort();
                            let _ = stdout_task.await;
                            let _ = stderr_task.await;
                            return Err(SandboxError::BackendFailed {
                                reason: format!("wait after timeout failed: {e}"),
                            });
                        }
                    }
                }
            }
        };
        let (stdout, stdout_truncated) =
            stdout_task.await.map_err(|e| SandboxError::BackendFailed {
                reason: format!("stdout capture task failed: {e}"),
            })?;
        let (stderr, stderr_truncated) =
            stderr_task.await.map_err(|e| SandboxError::BackendFailed {
                reason: format!("stderr capture task failed: {e}"),
            })?;

        // bwrap failing to build the namespace is not a failed command, it is
        // a host that cannot sandbox. Report it as such instead of handing back
        // an exit code the caller will read as "your command failed".
        let exit_code = status.code().unwrap_or(-1);
        if let Some(reason) = namespace_setup_denial(exit_code, &stdout, &stderr) {
            return Err(SandboxError::SetupRequired { reason });
        }

        Ok(SandboxResult {
            exit_code,
            stdout,
            stderr,
            duration: started.elapsed(),
            timed_out,
            stdout_truncated,
            stderr_truncated,
        })
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

/// Resolve the rlimit caps a policy asks for. Only `Bash` carries CPU / memory
/// caps; file-edit policies leave the wall-clock watchdog as the sole control.
fn rlimits_for(policy: &SandboxPolicy) -> crate::sandbox::limits::ResolvedLimits {
    match policy {
        SandboxPolicy::Bash {
            max_cpu_seconds,
            max_memory_mb,
            ..
        } => crate::sandbox::limits::resolve_rlimits(*max_cpu_seconds, *max_memory_mb),
        _ => crate::sandbox::limits::ResolvedLimits::default(),
    }
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
fn push_hidden_entry(
    args: &mut Vec<String>,
    kind: crate::sandbox::protected::ProtKind,
    dest: &str,
) {
    match kind {
        crate::sandbox::protected::ProtKind::Dir => {
            args.push("--tmpfs".into());
            args.push(dest.to_string());
            args.push("--remount-ro".into());
            args.push(dest.to_string());
        }
        crate::sandbox::protected::ProtKind::File => {
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
        for (protected, kind, secret) in crate::sandbox::protected::protected_entries_under(root) {
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
        for (protected, kind, secret) in crate::sandbox::protected::protected_entries_under(root) {
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
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();

    // Isolation baseline. Order matters: namespace flags first.
    args.push("--unshare-user".into());
    args.push("--unshare-pid".into());
    args.push("--unshare-ipc".into());
    args.push("--unshare-uts".into());
    args.push("--die-with-parent".into());
    // Detach the controlling terminal. Without it the sandboxed process keeps
    // the caller's session and can push characters back into the terminal that
    // launched the app with `TIOCSTI`. Nothing here is interactive (stdio are
    // always pipes), so there is no session to lose.
    args.push("--new-session".into());
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
            push_network_flags(&mut args, network);
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
            push_network_flags(&mut args, &NetworkPolicy::Off);
        }
    }

    args
}

fn push_network_flags(args: &mut Vec<String>, policy: &NetworkPolicy) {
    match policy {
        NetworkPolicy::Off => {
            args.push("--unshare-net".into());
        }
        NetworkPolicy::On => {
            args.push("--share-net".into());
        }
        NetworkPolicy::Allowlist { hosts: _ } => {
            // Proxy-routed allowlist: the command shares the host network so it
            // can reach the loopback filtering proxy (ADR-0028 Phase 3) that the
            // dispatcher started and injected as HTTP(S)_PROXY / ALL_PROXY. The
            // proxy enforces the host allowlist. NOTE: this is enforced for
            // proxy-respecting clients only — true kernel enforcement (an
            // unshared netns + a unix-socket bridge so direct egress is
            // impossible) is the documented Linux follow-up. macOS already gets
            // kernel enforcement via the SBPL localhost-port pin.
            args.push("--share-net".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

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
        };
        let args = render_bwrap_args(&policy, &cmd(), None);
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
        };
        let args = render_bwrap_args(&policy, &cmd(), None);
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
        };
        let args = render_bwrap_args(&policy, &cmd(), None);
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
        };
        let args = render_bwrap_args(&policy, &cmd(), None);
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
        };
        let args = render_bwrap_args(&policy, &cmd(), None);
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
        };
        let args = render_bwrap_args(&policy, &cmd(), None);
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
        };
        let args = render_bwrap_args(&policy, &cmd(), None);
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
        };
        let args = render_bwrap_args(&policy, &cmd(), None);
        assert!(args.iter().any(|s| s == "--share-net"));
        assert!(!args.iter().any(|s| s == "--unshare-net"));
    }

    #[test]
    fn edit_policy_binds_files_only_not_subtrees() {
        let policy = SandboxPolicy::Edit {
            target_files: vec![PathBuf::from("/repo/a.txt")],
            readable: vec![],
        };
        let args = render_bwrap_args(&policy, &cmd(), None);
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
        };
        // With a parked program, bwrap is told which descriptor to read it
        // from. Applying the same filter to bwrap itself denies the `mount`,
        // `unshare` and `pivot_root` calls bwrap needs to build the sandbox,
        // which is how every Linux sandbox call came back as
        // `bwrap: Failed to make / slave: Operation not permitted`.
        let args = render_bwrap_args(&policy, &cmd(), Some(crate::sandbox::seccomp::SECCOMP_FD));
        let idx = args
            .iter()
            .position(|s| s == "--seccomp")
            .expect("--seccomp present when a program is parked");
        assert_eq!(
            args[idx + 1],
            crate::sandbox::seccomp::SECCOMP_FD.to_string()
        );

        // Without one the run proceeds on namespace isolation alone, and bwrap
        // must not be handed a descriptor that holds nothing.
        let none = render_bwrap_args(&policy, &cmd(), None);
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
        };
        ensure_write_targets_exist(&policy).expect("no targets to create");
        assert_eq!(
            std::fs::read_dir(dir.path())
                .expect("readable")
                .next()
                .is_none(),
            true
        );
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
}
