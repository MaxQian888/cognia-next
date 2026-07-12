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

        // An empty read-only directory we bind over secret / non-existent
        // protected paths so the sandboxed command can neither read them nor
        // CREATE them. Shared + idempotent; bwrap mounts it read-only.
        let empty_dir = std::env::temp_dir().join("cognia-sandbox-empty");
        let _ = std::fs::create_dir_all(&empty_dir);
        let bwrap_args = render_bwrap_args(&policy, &command, &empty_dir);

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
        match crate::sandbox::seccomp::build_filter() {
            Ok(bpf) => crate::sandbox::seccomp::attach(&mut cmd, bpf),
            Err(e) => {
                eprintln!("sandbox: seccomp unavailable, proceeding namespace-only: {e}");
            }
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
        let wait_future = child.wait_with_output();
        let timed_out;
        let output = if timeout_secs == 0 {
            timed_out = false;
            wait_future.await.map_err(|e| SandboxError::BackendFailed {
                reason: format!("wait failed: {e}"),
            })?
        } else {
            match timeout(Duration::from_secs(timeout_secs), wait_future).await {
                Ok(Ok(out)) => {
                    timed_out = false;
                    out
                }
                Ok(Err(e)) => {
                    return Err(SandboxError::BackendFailed {
                        reason: format!("wait failed: {e}"),
                    });
                }
                Err(_) => {
                    return Err(SandboxError::Timeout {
                        seconds: timeout_secs,
                    });
                }
            }
        };

        Ok(SandboxResult {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            duration: started.elapsed(),
            timed_out,
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

/// Bind an EMPTY read-only source over `dest`, hiding any existing content and
/// preventing creation. A directory entry is shadowed by `empty_dir`; a file
/// entry by `/dev/null`. Either way the mount is read-only, so writes fail and
/// the (now-empty) target reveals nothing.
fn push_empty_bind(
    args: &mut Vec<String>,
    kind: crate::sandbox::protected::ProtKind,
    empty_dir: &Path,
    dest: &str,
) {
    args.push("--ro-bind".into());
    match kind {
        crate::sandbox::protected::ProtKind::Dir => {
            args.push(empty_dir.to_string_lossy().into_owned())
        }
        crate::sandbox::protected::ProtKind::File => args.push("/dev/null".into()),
    }
    args.push(dest.to_string());
}

/// Append the protected-path re-binds (last-wins) for a policy's writable +
/// readable roots:
///   * Under a WRITABLE root — SECRET stores are bound over with an empty
///     read-only source (no read, no write, no create, exist or not), while
///     WRITE-PROTECTED control files are re-bound read-only ONLY WHEN THEY
///     EXIST (rewrite of an existing repo's hooks / rc is denied, but a fresh
///     `git init` / new rc file still works — creating one isn't the threat).
///   * Under a READABLE-only root — SECRET stores are still hidden (read is the
///     exfiltration threat); write-protected files are already read-only there.
fn push_protected_binds(
    args: &mut Vec<String>,
    writable: &[PathBuf],
    readable: &[PathBuf],
    empty_dir: &Path,
) {
    for root in writable {
        for (protected, kind, secret) in crate::sandbox::protected::protected_entries_under(root) {
            let dest = protected.to_string_lossy().into_owned();
            if secret {
                push_empty_bind(args, kind, empty_dir, &dest);
            } else if protected.exists() {
                args.push("--ro-bind".into());
                args.push(dest.clone());
                args.push(dest);
            }
        }
    }
    for root in readable {
        for (protected, kind, secret) in crate::sandbox::protected::protected_entries_under(root) {
            if secret {
                let dest = protected.to_string_lossy().into_owned();
                push_empty_bind(args, kind, empty_dir, &dest);
            }
        }
    }
}

/// Render `bwrap` argv for the given policy + command. Pure: no I/O beyond
/// `Path::exists` probes (so unit tests are deterministic on any host). The
/// returned vec is the args BEFORE `--` (the target argv comes after).
/// `empty_dir` is an empty read-only directory bound over secret / absent
/// protected paths.
fn render_bwrap_args(
    policy: &SandboxPolicy,
    command: &SandboxCommand,
    empty_dir: &Path,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();

    // Isolation baseline. Order matters: namespace flags first.
    args.push("--unshare-user".into());
    args.push("--unshare-pid".into());
    args.push("--unshare-ipc".into());
    args.push("--unshare-uts".into());
    args.push("--die-with-parent".into());

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
            push_protected_binds(&mut args, writable, readable, empty_dir);
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
            push_protected_binds(&mut args, &[], readable, empty_dir);
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

    fn cmd() -> SandboxCommand {
        SandboxCommand {
            argv: vec!["ls".into()],
            cwd: PathBuf::from("/workspace"),
            env: BTreeMap::new(),
            stdin: None,
            timeout: Duration::from_secs(5),
        }
    }

    fn empty() -> PathBuf {
        PathBuf::from("/run/cognia-empty")
    }

    /// Find `--ro-bind <src> <dest>` triples and return the matching `src`.
    fn ro_bind_src_for(args: &[String], dest: &str) -> Option<String> {
        args.windows(3)
            .find(|w| w[0] == "--ro-bind" && w[2] == dest)
            .map(|w| w[1].clone())
    }

    #[test]
    fn secret_protected_path_is_bound_over_with_empty_source() {
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/workspace")],
            readable: vec![],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
        };
        let args = render_bwrap_args(&policy, &cmd(), &empty());
        // `.ssh` (secret dir) is shadowed by the empty dir — neither readable
        // nor writable nor creatable, regardless of whether it exists.
        assert_eq!(
            ro_bind_src_for(&args, "/workspace/.ssh").as_deref(),
            Some("/run/cognia-empty")
        );
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
        let args = render_bwrap_args(&policy, &cmd(), &empty());
        // `.git` is write-protected and absent → NOT bound, so `git init` still
        // works (the threat is rewriting an EXISTING repo, handled when present).
        assert_eq!(ro_bind_src_for(&args, &format!("{root}/.git")), None);
        // `.ssh` is a SECRET store → bound over even when absent, so the command
        // can't create `~/.ssh/authorized_keys` in a clean root.
        assert_eq!(
            ro_bind_src_for(&args, &format!("{root}/.ssh")).as_deref(),
            Some("/run/cognia-empty")
        );
    }

    #[test]
    fn secrets_under_a_readable_root_are_hidden() {
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/workspace")],
            readable: vec![PathBuf::from("/home/u")],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
        };
        let args = render_bwrap_args(&policy, &cmd(), &empty());
        // `/home/u/.ssh` reachable through the readable root is shadowed by the
        // empty dir so it can't be read.
        assert_eq!(
            ro_bind_src_for(&args, "/home/u/.ssh").as_deref(),
            Some("/run/cognia-empty")
        );
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
        let args = render_bwrap_args(&policy, &cmd(), &empty());
        assert!(args.iter().any(|s| s == "--unshare-pid"));
        assert!(args.iter().any(|s| s == "--unshare-net"));
        assert!(args.iter().any(|s| s == "--die-with-parent"));
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
        let args = render_bwrap_args(&policy, &cmd(), &empty());
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
        let args = render_bwrap_args(&policy, &cmd(), &empty());
        assert!(args.iter().any(|s| s == "--share-net"));
        assert!(!args.iter().any(|s| s == "--unshare-net"));
    }

    #[test]
    fn edit_policy_binds_files_only_not_subtrees() {
        let policy = SandboxPolicy::Edit {
            target_files: vec![PathBuf::from("/repo/a.txt")],
            readable: vec![],
        };
        let args = render_bwrap_args(&policy, &cmd(), &empty());
        // The exact file is writable via --bind.
        let contains_file = args
            .windows(3)
            .any(|w| w[0] == "--bind" && w[1] == "/repo/a.txt" && w[2] == "/repo/a.txt");
        assert!(contains_file);
        // Net always off for edit.
        assert!(args.iter().any(|s| s == "--unshare-net"));
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
