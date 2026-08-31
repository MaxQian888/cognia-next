// ADR-0028 Phase 4.3 — macOS `sandbox-exec` backend.
//
// `sandbox-exec` ships in macOS at `/usr/bin/sandbox-exec`. Apple deprecated
// the public API in 10.7 but the binary remains functional through macOS 26
// (still used by Chromium / Firefox / `@anthropic-ai/sandbox-runtime`). Plan
// B documented in ADR-0028: migrate to App Sandbox + XPC when Apple sets a
// removal timeline.
//
// We render an SBPL (Sandbox Profile Language) profile per `SandboxPolicy`
// variant and spawn the target command under it. Profile primitives:
//   (deny default)                            — sandbox everything by default
//   (allow file-read* (regex #"..."))         — readable paths
//   (allow file-write* (subpath #"..."))      — writable paths
//   (allow process-fork process-exec)         — required for shell
//   (deny network*) | (allow network*)        — network gate
//   (allow mach-lookup ...)                   — XPC ops the dyld loader needs
//
// We DO NOT shell-interpret `argv[0]`; the spawned process is `argv[0]`
// directly with `argv[1..]` as arguments. For `bash -c "..."` shape calls
// the renderer passes `["bash", "-c", "..."]` and bash itself does the
// shell interpretation inside the sandbox.

#![allow(dead_code)]

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::sandbox::launcher::push_loopback_proxy_network_rule;
use crate::sandbox::traits::SandboxedExec;
use crate::sandbox::types::{
    NetworkPolicy, SandboxCommand, SandboxError, SandboxHealth, SandboxPolicy, SandboxResult,
};

/// Absolute path to the system `sandbox-exec`. Apple ships it as part of
/// the base install; we verify presence in `is_available()`.
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

#[derive(Debug, Clone, Default)]
pub struct MacOsSandboxBackend;

impl MacOsSandboxBackend {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl SandboxedExec for MacOsSandboxBackend {
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
        if !Path::new(SANDBOX_EXEC).exists() {
            return Err(SandboxError::Unavailable {
                reason: format!("{SANDBOX_EXEC} not found (macOS sandbox-exec missing)"),
            });
        }

        // For an allowlist policy the dispatcher started a loopback filtering
        // proxy and stamped its port here; the SBPL pins egress to it.
        let proxy_port = command
            .env
            .get("COGNIA_SANDBOX_PROXY_PORT")
            .and_then(|s| s.parse::<u16>().ok());
        let profile = render_profile(&policy, proxy_port)?;

        // Argv: sandbox-exec -p '<profile>' -- <target argv>
        let mut cmd = Command::new(SANDBOX_EXEC);
        cmd.arg("-p").arg(&profile).arg("--");
        for arg in &command.argv {
            cmd.arg(arg);
        }
        cmd.current_dir(&command.cwd)
            .env_clear()
            .envs(&command.env)
            .kill_on_drop(true)
            .stdin(if command.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Opt-in resource limits (RLIMIT_CPU; RLIMIT_AS is Linux-only).
        // Applied to `sandbox-exec` via pre_exec and inherited by the
        // sandboxed command. No-op unless the policy set a cap.
        crate::sandbox::limits::apply_rlimits(&mut cmd, rlimits_for(&policy));

        // Put the sandboxed process in its OWN session / process group so the
        // timeout watchdog can kill the WHOLE tree, not just `sandbox-exec`.
        // Unlike Linux (bwrap is PID 1 of an unshared PID namespace, so killing
        // it reaps everything), macOS has no PID namespace — a daemonized
        // grandchild (`sleep 99999 & disown`) would survive a kill of the
        // immediate child. `setsid` makes the child a process-group leader
        // (pgid == pid); on timeout we signal the negated pid (the group).
        // SAFETY: post-fork / pre-exec; no allocation or locks.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    // Already a group leader on the rare path — fall back.
                    libc::setpgid(0, 0);
                }
                Ok(())
            });
        }

        let started = Instant::now();
        let mut child = cmd.spawn().map_err(|e| SandboxError::BackendFailed {
            reason: format!("failed to spawn sandbox-exec: {e}"),
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
        // Capture the pid BEFORE `wait_with_output` consumes the child, so the
        // timeout branch can signal the process group.
        let child_pid = child.id();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| SandboxError::BackendFailed {
                reason: "sandbox-exec stdout pipe was unavailable".into(),
            })?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| SandboxError::BackendFailed {
                reason: "sandbox-exec stderr pipe was unavailable".into(),
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
                    // Kill the whole process group (negated pid) so daemonized
                    // grandchildren die too — `kill_on_drop` would only reap
                    // `sandbox-exec` itself.
                    if let Some(pid) = child_pid {
                        unsafe {
                            libc::kill(-(pid as i32), libc::SIGKILL);
                        }
                    }
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

        Ok(SandboxResult {
            exit_code: status.code().unwrap_or(-1),
            stdout,
            stderr,
            duration: started.elapsed(),
            timed_out,
            stdout_truncated,
            stderr_truncated,
        })
    }

    fn is_available(&self) -> bool {
        Path::new(SANDBOX_EXEC).exists()
    }

    async fn first_time_setup(&self) -> Result<(), SandboxError> {
        // No setup needed — sandbox-exec is part of the OS install.
        if self.is_available() {
            Ok(())
        } else {
            Err(SandboxError::Unavailable {
                reason: format!("{SANDBOX_EXEC} missing — macOS install broken?"),
            })
        }
    }

    fn health(&self) -> SandboxHealth {
        let available = self.is_available();
        SandboxHealth {
            available,
            backend: "macos-sandbox-exec".into(),
            version: "system".into(),
            last_error: if available {
                String::new()
            } else {
                format!("{SANDBOX_EXEC} not found")
            },
        }
    }
}

/// Resolve the rlimit caps a policy asks for (only `Bash` carries them).
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

/// Mature SBPL base, ported from the `openai/codex` Seatbelt policy + the
/// `anthropic-experimental/sandbox-runtime` profile. Without these, real
/// toolchains (git, node, compilers) fail inside the sandbox because dyld,
/// the C library, temp-file handling, ttys, and preference lookups all hit
/// paths/services that a bare `(deny default)` blocks.
fn push_base_policy(out: &mut String) {
    out.push_str("(allow process-fork)\n");
    out.push_str("(allow process-exec)\n");
    out.push_str("(allow process-info* (target self))\n");
    out.push_str("(allow signal (target self))\n");
    // Read-only system surface: dyld cache, frameworks, libs, CA bundles,
    // homebrew prefixes, the user-lookup db.
    out.push_str("(allow file-read*\n");
    for p in [
        "/usr/lib",
        "/usr/bin",
        "/usr/share",
        "/usr/local",
        "/opt/homebrew",
        "/opt/local",
        "/System",
        "/Library",
        "/private/etc",
        "/private/var/select",
        "/private/var/db/dyld",
        "/private/var/db/timezone",
        "/dev/null",
        "/dev/zero",
        "/dev/random",
        "/dev/urandom",
        "/dev/dtracehelper",
    ] {
        out.push_str(&format!("  (subpath \"{p}\")\n"));
    }
    out.push_str(")\n");
    // /dev/null is the one device that must also be writable.
    out.push_str("(allow file-write-data (literal \"/dev/null\"))\n");
    // Interactive shells / build tools that allocate a pty.
    out.push_str("(allow pseudo-tty)\n");
    out.push_str("(allow file-read* file-write* file-ioctl (literal \"/dev/ptmx\"))\n");
    out.push_str("(allow file-read* file-write* file-ioctl (regex #\"^/dev/ttys[0-9]+\"))\n");
    out.push_str("(allow file-ioctl (literal \"/dev/tty\"))\n");
    // Service lookups dyld / Security / cfprefs / DNS need.
    out.push_str("(allow mach-lookup)\n");
    out.push_str("(allow sysctl-read)\n");
    out.push_str("(allow user-preference-read)\n");
    // POSIX shared memory + semaphores for OpenMP / threaded runtimes.
    out.push_str("(allow ipc-posix-shm*)\n");
    out.push_str("(allow ipc-posix-sem)\n");
    // The system temp dir ($TMPDIR resolves under /private/var/folders) must
    // be writable for compilers, package managers, and `mktemp` users.
    out.push_str("(allow file-read* file-write* (subpath \"/private/var/folders\"))\n");
    out.push_str("(allow file-read* file-write* (subpath \"/private/tmp\"))\n");
    out.push_str("(allow file-read* file-write* (subpath \"/private/var/tmp\"))\n");
}

/// Render the `SandboxPolicy` to an SBPL profile string. Pure function so
/// tests can assert on output verbatim. `proxy_port` is the loopback port of
/// the filtering proxy for an allowlist policy (the kernel egress is pinned
/// to it); `None` for non-allowlist policies.
fn render_profile(policy: &SandboxPolicy, proxy_port: Option<u16>) -> Result<String, SandboxError> {
    let mut out = String::new();
    out.push_str("(version 1)\n(deny default)\n");
    push_base_policy(&mut out);

    match policy {
        SandboxPolicy::Bash {
            writable,
            readable,
            network,
            ..
        } => {
            push_readable(&mut out, readable);
            push_writable(&mut out, writable);
            // Re-deny credential / VCS-control paths nested under a writable
            // root (SBPL is last-match-wins, so deny after allow). Also block
            // unlink on the protected paths AND their parents so a `mv` can't
            // relocate a denied file out of the way (srt move-bypass guard).
            push_protected_denies(&mut out, writable);
            // Secret stores reachable through a readable root are denied read.
            push_secret_read_denies(&mut out, readable);
            push_network(&mut out, network, proxy_port);
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
            push_readable(&mut out, readable);
            push_target_files(&mut out, target_files);
            // A protected write target is refused upstream; here we only need
            // to hide secret stores reachable through the readable roots.
            push_secret_read_denies(&mut out, readable);
            push_network(&mut out, &NetworkPolicy::Off, None);
        }
    }

    Ok(out)
}

/// Emit deny rules for every protected path under each writable root. ALL
/// protected paths get `(deny file-write*)` + `(deny file-write-unlink)` (so
/// they can't be rewritten, nor removed / renamed out from under the
/// protection). SECRET paths (credential stores) additionally get `(deny
/// file-read*)` — read of an SSH key / cloud credential / `.git-credentials`
/// is itself the exfiltration threat the carve-out exists to stop. SBPL is
/// last-match-wins and these come after the writable allow, so they win
/// regardless of whether the path currently exists.
fn push_protected_denies(out: &mut String, writable: &[std::path::PathBuf]) {
    for root in writable {
        for (protected, _kind, secret) in crate::sandbox::protected::protected_entries_under(root) {
            let p = escape_sbpl(&protected.to_string_lossy());
            out.push_str(&format!("(deny file-write* (subpath \"{p}\"))\n"));
            out.push_str(&format!("(deny file-write* (literal \"{p}\"))\n"));
            out.push_str(&format!("(deny file-write-unlink (literal \"{p}\"))\n"));
            if secret {
                out.push_str(&format!("(deny file-read* (subpath \"{p}\"))\n"));
                out.push_str(&format!("(deny file-read* (literal \"{p}\"))\n"));
            }
        }
    }
}

/// Emit `(deny file-read* …)` for SECRET stores reachable through the READABLE
/// roots — read of a credential file is itself the exfiltration threat, and a
/// readable root (e.g. the user's home) would otherwise expose `~/.ssh`,
/// `~/.aws`, `~/.git-credentials`, … Comes after the readable allow so the deny
/// wins (SBPL last-match). Write-protected control files need no extra rule
/// here: a readable root grants read only.
fn push_secret_read_denies(out: &mut String, readable: &[std::path::PathBuf]) {
    for root in readable {
        for (protected, _kind, secret) in crate::sandbox::protected::protected_entries_under(root) {
            if secret {
                let p = escape_sbpl(&protected.to_string_lossy());
                out.push_str(&format!("(deny file-read* (subpath \"{p}\"))\n"));
                out.push_str(&format!("(deny file-read* (literal \"{p}\"))\n"));
            }
        }
    }
}

fn push_readable(out: &mut String, paths: &[std::path::PathBuf]) {
    if paths.is_empty() {
        return;
    }
    out.push_str("(allow file-read*\n");
    for p in paths {
        out.push_str(&format!(
            "  (subpath \"{}\")\n",
            escape_sbpl(&p.to_string_lossy())
        ));
    }
    out.push_str(")\n");
}

fn push_writable(out: &mut String, paths: &[std::path::PathBuf]) {
    if paths.is_empty() {
        return;
    }
    out.push_str("(allow file-write*\n");
    for p in paths {
        out.push_str(&format!(
            "  (subpath \"{}\")\n",
            escape_sbpl(&p.to_string_lossy())
        ));
    }
    out.push_str(")\n");
    // Writable paths imply readable.
    out.push_str("(allow file-read*\n");
    for p in paths {
        out.push_str(&format!(
            "  (subpath \"{}\")\n",
            escape_sbpl(&p.to_string_lossy())
        ));
    }
    out.push_str(")\n");
}

fn push_target_files(out: &mut String, files: &[std::path::PathBuf]) {
    if files.is_empty() {
        return;
    }
    // `literal` matches exact paths only — Edit/Write/TextEditor must NOT
    // grant subtree write access.
    out.push_str("(allow file-write*\n");
    for f in files {
        out.push_str(&format!(
            "  (literal \"{}\")\n",
            escape_sbpl(&f.to_string_lossy())
        ));
    }
    out.push_str(")\n");
    out.push_str("(allow file-read*\n");
    for f in files {
        out.push_str(&format!(
            "  (literal \"{}\")\n",
            escape_sbpl(&f.to_string_lossy())
        ));
    }
    out.push_str(")\n");
}

fn push_network(out: &mut String, policy: &NetworkPolicy, proxy_port: Option<u16>) {
    match policy {
        NetworkPolicy::Off => {
            // Default-deny already covers network*; explicit deny for
            // documentation only.
            out.push_str("(deny network*)\n");
        }
        NetworkPolicy::On => {
            out.push_str("(allow network*)\n");
        }
        NetworkPolicy::Allowlist { hosts: _ } => match proxy_port {
            Some(port) => {
                // Kernel-enforced allowlist: the only reachable endpoint is the
                // loopback filtering proxy, which applies the host allowlist and
                // performs DNS + egress itself. A command that tries to skip the
                // proxy and connect directly is blocked by the `(deny default)`.
                push_loopback_proxy_network_rule(out, port);
            }
            None => {
                // Allowlist requested but no proxy port was provisioned — fail
                // closed (deny all) rather than silently opening the network.
                out.push_str("(deny network*)\n");
            }
        },
    }
}

fn escape_sbpl(s: &str) -> String {
    // SBPL strings need backslash + quote escaping. Paths on macOS are
    // unlikely to contain either but we handle them safely.
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn render_bash_profile_includes_writable_and_readable() {
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/workspace")],
            readable: vec![PathBuf::from("/usr/local/include")],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
        };
        let p = render_profile(&policy, None).unwrap();
        assert!(p.starts_with("(version 1)\n(deny default)\n"));
        assert!(p.contains("(subpath \"/workspace\")"));
        assert!(p.contains("(subpath \"/usr/local/include\")"));
        assert!(p.contains("(deny network*)"));
    }

    #[test]
    fn render_bash_with_network_on() {
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/tmp")],
            readable: vec![],
            network: NetworkPolicy::On,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
        };
        let p = render_profile(&policy, None).unwrap();
        assert!(p.contains("(allow network*)"));
        assert!(!p.contains("(deny network*)"));
    }

    #[test]
    fn render_edit_uses_literal_not_subpath() {
        let policy = SandboxPolicy::Edit {
            target_files: vec![PathBuf::from("/repo/file.txt")],
            readable: vec![],
        };
        let p = render_profile(&policy, None).unwrap();
        // Edit / Write / TextEditor use `literal` (single-file match), not
        // `subpath` (subtree match). This is the key tightening compared
        // to Bash.
        assert!(p.contains("(literal \"/repo/file.txt\")"));
        assert!(!p.contains("(subpath \"/repo/file.txt\")"));
        // Always net-off for edit/write/text_editor.
        assert!(p.contains("(deny network*)"));
    }

    #[test]
    fn render_text_editor_emits_same_shape_as_edit() {
        let policy = SandboxPolicy::TextEditor {
            target_files: vec![PathBuf::from("/repo/a.txt")],
            readable: vec![],
        };
        let p = render_profile(&policy, None).unwrap();
        assert!(p.contains("(literal \"/repo/a.txt\")"));
        assert!(p.contains("(deny network*)"));
    }

    #[test]
    fn escape_sbpl_handles_quotes_and_backslashes() {
        assert_eq!(escape_sbpl("path/with\"quote"), "path/with\\\"quote");
        assert_eq!(
            escape_sbpl("path\\with\\backslash"),
            "path\\\\with\\\\backslash"
        );
    }

    #[test]
    fn health_reports_macos_sandbox_exec_backend() {
        let backend = MacOsSandboxBackend::new();
        let h = backend.health();
        assert_eq!(h.backend, "macos-sandbox-exec");
    }

    #[test]
    fn base_policy_grants_tty_tmpdir_and_shm_for_real_programs() {
        let p = render_profile(
            &SandboxPolicy::Bash {
                writable: vec![PathBuf::from("/workspace")],
                readable: vec![],
                network: NetworkPolicy::Off,
                max_cpu_seconds: 0,
                max_memory_mb: 0,
            },
            None,
        )
        .unwrap();
        assert!(p.contains("(allow pseudo-tty)"));
        assert!(p.contains("(literal \"/dev/ptmx\")"));
        assert!(p.contains("(subpath \"/private/var/folders\")"));
        assert!(p.contains("(allow ipc-posix-shm*)"));
        assert!(p.contains("(allow user-preference-read)"));
        assert!(p.contains("(allow file-write-data (literal \"/dev/null\"))"));
    }

    #[test]
    fn bash_policy_denies_protected_paths_under_writable_root() {
        let p = render_profile(
            &SandboxPolicy::Bash {
                writable: vec![PathBuf::from("/workspace")],
                readable: vec![],
                network: NetworkPolicy::Off,
                max_cpu_seconds: 0,
                max_memory_mb: 0,
            },
            None,
        )
        .unwrap();
        // .git under the writable root is denied for writes + unlink, but is
        // NOT a secret so it stays readable (a build legitimately reads it).
        assert!(p.contains("(deny file-write* (subpath \"/workspace/.git\"))"));
        assert!(p.contains("(deny file-write-unlink (literal \"/workspace/.git\"))"));
        assert!(!p.contains("(deny file-read* (subpath \"/workspace/.git\"))"));
        // .ssh is a SECRET credential store — denied for read AND write so the
        // key material can't be exfiltrated even when nested in a writable root.
        assert!(p.contains("(deny file-write* (subpath \"/workspace/.ssh\"))"));
        assert!(p.contains("(deny file-read* (subpath \"/workspace/.ssh\"))"));
        // The deny rules come AFTER the writable allow so last-match wins.
        let allow_idx = p.find("(allow file-write*").unwrap();
        let deny_idx = p
            .find("(deny file-write* (subpath \"/workspace/.git\")")
            .unwrap();
        assert!(deny_idx > allow_idx);
    }

    #[test]
    fn secrets_under_a_readable_root_are_read_denied() {
        let p = render_profile(
            &SandboxPolicy::Bash {
                writable: vec![PathBuf::from("/workspace")],
                readable: vec![PathBuf::from("/home/u")],
                network: NetworkPolicy::Off,
                max_cpu_seconds: 0,
                max_memory_mb: 0,
            },
            None,
        )
        .unwrap();
        // The readable root grants read to /home/u, but the secret stores under
        // it are re-denied for read.
        assert!(p.contains("(deny file-read* (subpath \"/home/u/.ssh\"))"));
        assert!(p.contains("(deny file-read* (subpath \"/home/u/.aws\"))"));
        // The readable allow comes before the deny so last-match wins.
        let allow_idx = p.find("(allow file-read*").unwrap();
        let deny_idx = p
            .find("(deny file-read* (subpath \"/home/u/.ssh\")")
            .unwrap();
        assert!(deny_idx > allow_idx);
    }

    #[test]
    fn rlimits_for_reads_bash_caps_only() {
        let bash = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/w")],
            readable: vec![],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 5,
            max_memory_mb: 0,
        };
        assert_eq!(rlimits_for(&bash).cpu_seconds, Some(5));
        let edit = SandboxPolicy::Edit {
            target_files: vec![PathBuf::from("/a")],
            readable: vec![],
        };
        assert!(rlimits_for(&edit).is_empty());
    }

    #[test]
    fn allowlist_pins_egress_to_the_proxy_port_when_provided() {
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/w")],
            readable: vec![],
            network: NetworkPolicy::Allowlist {
                hosts: vec!["api.github.com".into()],
            },
            max_cpu_seconds: 0,
            max_memory_mb: 0,
        };
        let p = render_profile(&policy, Some(54321)).unwrap();
        assert!(p.contains("(allow network-outbound (remote tcp \"localhost:54321\"))"));
        // No blanket network grant — the deny default blocks everything else.
        assert!(!p.contains("(allow network*)"));
    }

    #[test]
    fn allowlist_without_a_proxy_port_fails_closed() {
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/w")],
            readable: vec![],
            network: NetworkPolicy::Allowlist {
                hosts: vec!["api.github.com".into()],
            },
            max_cpu_seconds: 0,
            max_memory_mb: 0,
        };
        let p = render_profile(&policy, None).unwrap();
        assert!(p.contains("(deny network*)"));
        assert!(!p.contains("(allow network*)"));
        assert!(!p.contains("network-outbound"));
    }
}
