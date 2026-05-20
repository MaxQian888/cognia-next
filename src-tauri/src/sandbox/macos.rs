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
        command: SandboxCommand,
        policy: SandboxPolicy,
    ) -> Result<SandboxResult, SandboxError> {
        if command.argv.is_empty() {
            return Err(SandboxError::InvalidPolicy {
                reason: "argv must not be empty".into(),
            });
        }
        if !Path::new(SANDBOX_EXEC).exists() {
            return Err(SandboxError::Unavailable {
                reason: format!("{SANDBOX_EXEC} not found (macOS sandbox-exec missing)"),
            });
        }

        let profile = render_profile(&policy)?;

        // Argv: sandbox-exec -p '<profile>' -- <target argv>
        let mut cmd = Command::new(SANDBOX_EXEC);
        cmd.arg("-p").arg(&profile).arg("--");
        for arg in &command.argv {
            cmd.arg(arg);
        }
        cmd.current_dir(&command.cwd)
            .env_clear()
            .envs(&command.env)
            .stdin(if command.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

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

/// Render the `SandboxPolicy` to an SBPL profile string. Pure function so
/// tests can assert on output verbatim.
fn render_profile(policy: &SandboxPolicy) -> Result<String, SandboxError> {
    let mut out = String::new();
    out.push_str("(version 1)\n(deny default)\n");
    // Common base: every sandbox needs to dyld-load the target binary +
    // hit a few read-only system locations.
    out.push_str("(allow process-fork)\n");
    out.push_str("(allow process-exec)\n");
    out.push_str("(allow file-read*\n");
    out.push_str("  (subpath \"/usr/lib\")\n");
    out.push_str("  (subpath \"/usr/bin\")\n");
    out.push_str("  (subpath \"/usr/share\")\n");
    out.push_str("  (subpath \"/System\")\n");
    out.push_str("  (subpath \"/Library/Frameworks\")\n");
    out.push_str("  (subpath \"/private/etc\")\n");
    out.push_str("  (subpath \"/private/var/select\")\n");
    out.push_str(")\n");
    out.push_str("(allow mach-lookup)\n"); // dyld needs this
    out.push_str("(allow sysctl-read)\n");

    match policy {
        SandboxPolicy::Bash {
            writable,
            readable,
            network,
            ..
        } => {
            push_readable(&mut out, readable);
            push_writable(&mut out, writable);
            push_network(&mut out, network);
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
            push_network(&mut out, &NetworkPolicy::Off);
        }
    }

    Ok(out)
}

fn push_readable(out: &mut String, paths: &[std::path::PathBuf]) {
    if paths.is_empty() {
        return;
    }
    out.push_str("(allow file-read*\n");
    for p in paths {
        out.push_str(&format!("  (subpath \"{}\")\n", escape_sbpl(&p.to_string_lossy())));
    }
    out.push_str(")\n");
}

fn push_writable(out: &mut String, paths: &[std::path::PathBuf]) {
    if paths.is_empty() {
        return;
    }
    out.push_str("(allow file-write*\n");
    for p in paths {
        out.push_str(&format!("  (subpath \"{}\")\n", escape_sbpl(&p.to_string_lossy())));
    }
    out.push_str(")\n");
    // Writable paths imply readable.
    out.push_str("(allow file-read*\n");
    for p in paths {
        out.push_str(&format!("  (subpath \"{}\")\n", escape_sbpl(&p.to_string_lossy())));
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
        out.push_str(&format!("  (literal \"{}\")\n", escape_sbpl(&f.to_string_lossy())));
    }
    out.push_str(")\n");
    out.push_str("(allow file-read*\n");
    for f in files {
        out.push_str(&format!("  (literal \"{}\")\n", escape_sbpl(&f.to_string_lossy())));
    }
    out.push_str(")\n");
}

fn push_network(out: &mut String, policy: &NetworkPolicy) {
    match policy {
        NetworkPolicy::Off => {
            // Default-deny already covers network*; explicit deny for
            // documentation only.
            out.push_str("(deny network*)\n");
        }
        NetworkPolicy::On => {
            out.push_str("(allow network*)\n");
        }
        NetworkPolicy::Allowlist { hosts: _ } => {
            // SBPL's remote-host matching is brittle (relies on TCP peer
            // resolution which the kernel rarely has at filter-time).
            // ADR-0028 documents this limitation: on macOS the allowlist
            // degrades to "allow network*" — the renderer's caller-side
            // host check is the real gate. Linux bwrap + Windows Firewall
            // get exact allowlist enforcement.
            out.push_str("(allow network*) ;; allowlist requested; macOS degrades to On\n");
        }
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
        let p = render_profile(&policy).unwrap();
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
        let p = render_profile(&policy).unwrap();
        assert!(p.contains("(allow network*)"));
        assert!(!p.contains("(deny network*)"));
    }

    #[test]
    fn render_edit_uses_literal_not_subpath() {
        let policy = SandboxPolicy::Edit {
            target_files: vec![PathBuf::from("/repo/file.txt")],
            readable: vec![],
        };
        let p = render_profile(&policy).unwrap();
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
        let p = render_profile(&policy).unwrap();
        assert!(p.contains("(literal \"/repo/a.txt\")"));
        assert!(p.contains("(deny network*)"));
    }

    #[test]
    fn escape_sbpl_handles_quotes_and_backslashes() {
        assert_eq!(escape_sbpl("path/with\"quote"), "path/with\\\"quote");
        assert_eq!(escape_sbpl("path\\with\\backslash"), "path\\\\with\\\\backslash");
    }

    #[test]
    fn health_reports_macos_sandbox_exec_backend() {
        let backend = MacOsSandboxBackend::new();
        let h = backend.health();
        assert_eq!(h.backend, "macos-sandbox-exec");
    }
}
