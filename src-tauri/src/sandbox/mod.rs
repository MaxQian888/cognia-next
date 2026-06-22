// ADR-0028 — sandbox module entry. Hosts the `SandboxedExec` trait
// (`traits.rs`), the data types (`types.rs`), the per-tool policy resolver
// (`policy.rs`), the production backends, the test mock (`mock.rs`), and
// the dispatcher + Tauri command surface below.
//
// `current_backend()` returns the per-platform real backend in `cfg`
// arms (bwrap on Linux, sandbox-exec/SBPL on macOS); a platform without a
// real backend routes to `UninstalledSandboxBackend`.
//
// BOTH `sandbox_exec` AND `sandbox_health_probe` are registered in
// `lib.rs::invoke_handler`. `sandbox_exec` is consumed by the
// `cognia-sandboxed-tools` plugin and by Computer Use's `bash`/`text_editor`
// routing (which run through `current_backend()` when a sandbox tier is
// active, fail-closed when no backend is available);
// `sandbox_health_probe` is the read-only diagnostic backing the
// Settings → Sandbox status badge.

pub mod env;
pub mod launcher;
pub mod limits;
#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
pub mod mock;
pub mod net_proxy;
pub mod paths;
pub mod policy;
pub mod protected;
#[cfg(target_os = "linux")]
pub mod seccomp;
pub mod traits;
pub mod types;
pub mod uninstalled;
#[cfg(target_os = "windows")]
pub mod windows;

use std::sync::Arc;

use crate::sandbox::traits::SandboxedExec;
use crate::sandbox::types::SandboxHealth;
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
use crate::sandbox::uninstalled::UninstalledSandboxBackend;

/// Backend selection. Single source of truth for the per-platform routing
/// table. macOS routes through sandbox-exec, Linux through bwrap, and Windows
/// through the bundled restricted-token + low-integrity + Job Object runner.
/// Missing platform binaries still surface SetupRequired honestly instead of
/// silently running unsandboxed.
pub fn current_backend() -> Arc<dyn SandboxedExec> {
    #[cfg(target_os = "windows")]
    {
        Arc::new(windows::WindowsSandboxBackend::new())
    }
    #[cfg(target_os = "macos")]
    {
        Arc::new(macos::MacOsSandboxBackend::new())
    }
    #[cfg(target_os = "linux")]
    {
        // No bundled bwrap yet — the resolver falls back to system PATH.
        // Phase 8 (verification) wires the resource_dir lookup.
        Arc::new(linux::LinuxSandboxBackend::new(None))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Arc::new(UninstalledSandboxBackend::new())
    }
}

/// Tauri-exposed read-only diagnostic. The Settings → Sandbox tab
/// (Phase 7) polls this to drive the status badge ("Active" / "Setup
/// required" / "Unavailable") and the "Retry setup" button visibility.
///
/// Cheap — no I/O, no keyring, no spawn. Safe to poll on a 5s interval.
#[tauri::command]
pub async fn sandbox_health_probe() -> Result<SandboxHealth, String> {
    Ok(current_backend().health())
}

/// Canonicalize every path a policy carries (writable / readable /
/// target_files). Rejects control characters, relative paths, and `..`
/// traversal, and resolves symlinks on the existing prefix so the
/// protected-path deny list and the bind set reason about the path the
/// kernel will actually resolve. Returns `InvalidPolicy` on the first bad
/// path so the refusal happens before any spawn (ADR-0028 hardening).
fn canonicalize_policy(
    policy: crate::sandbox::types::SandboxPolicy,
) -> Result<crate::sandbox::types::SandboxPolicy, crate::sandbox::types::SandboxError> {
    use crate::sandbox::paths::safe_canonicalize_all;
    use crate::sandbox::types::{SandboxError, SandboxPolicy};

    let map_err = |e: crate::sandbox::paths::PathError| SandboxError::InvalidPolicy {
        reason: e.to_string(),
    };
    Ok(match policy {
        SandboxPolicy::Bash {
            writable,
            readable,
            network,
            max_cpu_seconds,
            max_memory_mb,
        } => SandboxPolicy::Bash {
            writable: safe_canonicalize_all(&writable).map_err(map_err)?,
            readable: safe_canonicalize_all(&readable).map_err(map_err)?,
            network,
            max_cpu_seconds,
            max_memory_mb,
        },
        SandboxPolicy::Edit {
            target_files,
            readable,
        } => SandboxPolicy::Edit {
            target_files: safe_canonicalize_all(&target_files).map_err(map_err)?,
            readable: safe_canonicalize_all(&readable).map_err(map_err)?,
        },
        SandboxPolicy::Write {
            target_files,
            readable,
        } => SandboxPolicy::Write {
            target_files: safe_canonicalize_all(&target_files).map_err(map_err)?,
            readable: safe_canonicalize_all(&readable).map_err(map_err)?,
        },
        SandboxPolicy::TextEditor {
            target_files,
            readable,
        } => SandboxPolicy::TextEditor {
            target_files: safe_canonicalize_all(&target_files).map_err(map_err)?,
            readable: safe_canonicalize_all(&readable).map_err(map_err)?,
        },
    })
}

/// On Linux a `Bash` network allowlist is NOT kernel-enforced — the backend
/// shares the host network and only the proxy env constrains egress, which a
/// sandboxed command can simply ignore (raw socket, dropped proxy var). Per
/// ADR-0028 strict mode we fail CLOSED: downgrade the allowlist to "no
/// network" rather than run with an unenforced (effectively open) one. macOS
/// pins egress to the proxy port at the kernel, so it keeps the allowlist.
fn downgrade_unenforceable_network(
    policy: crate::sandbox::types::SandboxPolicy,
) -> crate::sandbox::types::SandboxPolicy {
    #[cfg(target_os = "linux")]
    {
        use crate::sandbox::types::{NetworkPolicy, SandboxPolicy};
        if let SandboxPolicy::Bash {
            network: NetworkPolicy::Allowlist { .. },
            writable,
            readable,
            max_cpu_seconds,
            max_memory_mb,
        } = policy
        {
            eprintln!(
                "sandbox: network allowlist is not kernel-enforced on Linux — downgrading to \
                 no-network (fail-closed). Use network=off, or run on macOS for an enforced \
                 allowlist."
            );
            return SandboxPolicy::Bash {
                network: NetworkPolicy::Off,
                writable,
                readable,
                max_cpu_seconds,
                max_memory_mb,
            };
        }
        policy
    }
    #[cfg(not(target_os = "linux"))]
    {
        policy
    }
}

/// The directories a sandbox writable root / write target may never be or sit
/// under: OS system dirs plus cognia's own app-data dir (OAuth credential
/// configs, keyring markers, native vector store). This is the always-on floor
/// — independent of, and beneath, the configurable per-session writable-root
/// ceiling that the `cognia-sandboxed-tools` plugin clamps to. The OS temp dir
/// and the user's home are deliberately allowed (Python scratch uses temp;
/// Computer Use's confine defaults to home).
fn forbidden_deny_roots() -> Vec<std::path::PathBuf> {
    let mut roots = crate::sandbox::protected::system_forbidden_roots();
    if let Some(d) = dirs::data_dir() {
        roots.push(d.join("cognia"));
    }
    roots
}

/// Reject — before any spawn — a cwd / writable / write-target path that aims
/// at a forbidden system or app-internal location. A model that asks for
/// `writable: ["/etc"]` or the keyring directory is refused with
/// `InvalidPolicy` rather than confined to a dangerous root. Readable paths are
/// NOT checked here: the backends already need read access to `/usr` · `/etc`
/// (CA bundles, loaders) for real toolchains to run.
fn reject_forbidden_paths(
    cwd: &std::path::Path,
    policy: &crate::sandbox::types::SandboxPolicy,
    deny_roots: &[std::path::PathBuf],
) -> Result<(), crate::sandbox::types::SandboxError> {
    use crate::sandbox::protected::is_forbidden_writable;
    use crate::sandbox::types::{SandboxError, SandboxPolicy};

    let check = |p: &std::path::Path| -> Result<(), SandboxError> {
        if is_forbidden_writable(p, deny_roots) {
            Err(SandboxError::InvalidPolicy {
                reason: format!(
                    "'{}' is a protected system / app location and cannot be a sandbox write target",
                    p.display()
                ),
            })
        } else {
            Ok(())
        }
    };

    check(cwd)?;
    match policy {
        SandboxPolicy::Bash { writable, .. } => {
            for p in writable {
                check(p)?;
            }
        }
        SandboxPolicy::Edit { target_files, .. }
        | SandboxPolicy::Write { target_files, .. }
        | SandboxPolicy::TextEditor { target_files, .. } => {
            for f in target_files {
                check(f)?;
                // File tools have no writable root for the backends' per-root
                // re-deny to key on, so reject a target that aims into any
                // credential / VCS-control segment (`.ssh`, `.git`, …) here.
                if crate::sandbox::protected::is_protected_anywhere(f) {
                    return Err(SandboxError::InvalidPolicy {
                        reason: format!(
                            "'{}' targets a protected credential / control path",
                            f.display()
                        ),
                    });
                }
            }
        }
    }
    Ok(())
}

/// Start the host-side filtering proxy for a (kernel-enforceable) allowlist
/// policy and inject the proxy env into `command`. Returns the guard (held
/// for the lifetime of the run, then dropped to abort the proxy) or `None`
/// when the policy needs no proxy. Fails closed: an allowlist that can't bind
/// its proxy is a `BackendFailed` error, never an open-network run.
async fn maybe_start_proxy(
    command: &mut crate::sandbox::types::SandboxCommand,
    policy: &crate::sandbox::types::SandboxPolicy,
) -> Result<Option<crate::sandbox::net_proxy::FilteringProxy>, crate::sandbox::types::SandboxError>
{
    use crate::sandbox::types::{NetworkPolicy, SandboxError, SandboxPolicy};

    let SandboxPolicy::Bash {
        network: NetworkPolicy::Allowlist { hosts },
        ..
    } = policy
    else {
        return Ok(None);
    };
    if hosts.is_empty() {
        return Ok(None);
    }
    match crate::sandbox::net_proxy::FilteringProxy::start(hosts.clone()).await {
        Ok(proxy) => {
            let url = format!("http://127.0.0.1:{}", proxy.port());
            for key in [
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "http_proxy",
                "https_proxy",
                "ALL_PROXY",
                "all_proxy",
            ] {
                command.env.insert(key.to_string(), url.clone());
            }
            command.env.insert("NO_PROXY".to_string(), String::new());
            command.env.insert("no_proxy".to_string(), String::new());
            // macOS reads this to pin the SBPL egress rule to the proxy port.
            command.env.insert(
                "COGNIA_SANDBOX_PROXY_PORT".to_string(),
                proxy.port().to_string(),
            );
            Ok(Some(proxy))
        }
        Err(e) => Err(SandboxError::BackendFailed {
            reason: format!("sandbox network proxy failed to start: {e}"),
        }),
    }
}

/// The single confined-execution path every Rust caller routes through —
/// `sandbox_exec` (chat tool calls) AND `canvas_run_python`. Enforces, in
/// order: (1) a backend-availability gate (fail-closed → `SetupRequired`,
/// so an unavailable backend can never run unsandboxed even if a future
/// backend forgets to re-check); (2) path canonicalization + validation;
/// (3) dangerous-env scrubbing; (4) the Linux allowlist fail-closed
/// downgrade; (5) the kernel-enforced filtering proxy. Only then does it
/// hand off to the per-platform backend.
pub async fn run_confined(
    mut command: crate::sandbox::types::SandboxCommand,
    policy: crate::sandbox::types::SandboxPolicy,
) -> Result<crate::sandbox::types::SandboxResult, crate::sandbox::types::SandboxError> {
    use crate::sandbox::types::SandboxError;

    // 1. Availability gate — the dispatcher-level invariant. Fail closed.
    let backend = current_backend();
    if !backend.is_available() {
        let health = backend.health();
        return Err(SandboxError::SetupRequired {
            reason: if health.last_error.is_empty() {
                format!("sandbox backend '{}' is not available", health.backend)
            } else {
                health.last_error
            },
        });
    }

    // 2. Canonicalize + validate every path the policy and cwd carry.
    command.cwd = crate::sandbox::paths::safe_canonicalize(&command.cwd).map_err(|e| {
        SandboxError::InvalidPolicy {
            reason: format!("cwd: {e}"),
        }
    })?;
    let policy = canonicalize_policy(policy)?;

    // 2b. Floor: refuse forbidden writable roots (system dirs + the app's own
    // data / keyring dir) regardless of what the caller asked for. Runs after
    // canonicalization so symlink / `..` evasions are already resolved.
    reject_forbidden_paths(&command.cwd, &policy, &forbidden_deny_roots())?;

    // 3. Drop code-injection environment variables (LD_PRELOAD, NODE_OPTIONS…).
    crate::sandbox::env::filter_env(&mut command.env);

    // 4. Fail closed on networks the platform can't actually enforce.
    let policy = downgrade_unenforceable_network(policy);

    // 5. Proxy for an enforceable allowlist (held until the run returns).
    let _proxy_guard = maybe_start_proxy(&mut command, &policy).await?;

    backend.run(command, policy).await
}

/// Tauri-exposed execution dispatcher consumed by the
/// `cognia-sandboxed-tools` plugin (Phase 4.5). The renderer-side plugin
/// tool's `execute()` forwards every call here.
///
/// Flow: derive a `SandboxPolicy` from `(tool, request)` via
/// `policy::policy_for`, then dispatch through `run_confined`. Each call is
/// also recorded in the shared `AuditRing` with `Surface::Sandbox`
/// (ADR-0028 Phase 14) so the Diagnostics tab can surface allow/deny/error
/// counts alongside the desktop-automation surfaces.
///
/// Errors come back as `String` (Tauri can't serialize the rich
/// `SandboxError` enum directly without a custom impl); the plugin uses
/// `error.message` verbatim as the ToolResult error so the model sees the
/// same stderr-style failure a native shell command would emit.
#[tauri::command]
pub async fn sandbox_exec(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::automation::commands::AutomationState>,
    tool: String,
    command: crate::sandbox::types::SandboxCommand,
    request: crate::sandbox::policy::PolicyRequest,
) -> Result<crate::sandbox::types::SandboxResult, String> {
    use crate::automation::audit::{AuditEntry, Decision as AuditDecision};
    use crate::automation::permission::Surface;
    use std::time::Instant;
    use tauri::Emitter;

    let started = Instant::now();
    let stripped = tool.strip_prefix("sandbox_").unwrap_or(&tool).to_string();
    let cwd_label = command.cwd.to_string_lossy().into_owned();
    let policy = match crate::sandbox::policy::policy_for(&stripped, request) {
        Ok(p) => p,
        Err(err) => {
            let msg = err.to_string();
            let entry = state.audit.record(AuditEntry {
                id: String::new(),
                ts: chrono::Utc::now().timestamp_millis(),
                surface: Surface::Sandbox,
                plugin_id: None,
                command: tool.clone(),
                process_name: None,
                window_title: Some(cwd_label.clone()),
                decision: AuditDecision::Deny,
                reason: Some("invalid_policy".into()),
                duration_ms: started.elapsed().as_millis() as u64,
                error: Some(msg.clone()),
            });
            let _ = app.emit("automation:event", &entry);
            return Err(msg);
        }
    };

    let outcome = run_confined(command, policy).await;
    let entry = match &outcome {
        Ok(result) => AuditEntry {
            id: String::new(),
            ts: chrono::Utc::now().timestamp_millis(),
            surface: Surface::Sandbox,
            plugin_id: None,
            command: tool.clone(),
            process_name: None,
            window_title: Some(cwd_label),
            decision: AuditDecision::Allow,
            reason: None,
            duration_ms: result.duration.as_millis() as u64,
            error: if result.exit_code == 0 {
                None
            } else {
                Some(format!("exit_code={}", result.exit_code))
            },
        },
        Err(err) => AuditEntry {
            id: String::new(),
            ts: chrono::Utc::now().timestamp_millis(),
            surface: Surface::Sandbox,
            plugin_id: None,
            command: tool.clone(),
            process_name: None,
            window_title: Some(cwd_label),
            decision: AuditDecision::Deny,
            reason: Some("backend_error".into()),
            duration_ms: started.elapsed().as_millis() as u64,
            error: Some(err.to_string()),
        },
    };
    let recorded = state.audit.record(entry);
    let _ = app.emit("automation:event", &recorded);
    outcome.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn current_backend_uses_per_platform_dispatch() {
        let backend = current_backend();
        let health = backend.health();
        #[cfg(target_os = "windows")]
        {
            // The Windows backend is the in-house "cognia-sandbox" runner
            // (see `windows.rs`). It is unavailable in a clean unit-test
            // environment because the bundled runner binary is not next to
            // the test executable.
            assert_eq!(health.backend, "windows-cognia-sandbox");
            assert!(!backend.is_available());
        }
        #[cfg(target_os = "macos")]
        {
            assert_eq!(health.backend, "macos-sandbox-exec");
        }
        #[cfg(target_os = "linux")]
        {
            assert_eq!(health.backend, "linux-bwrap");
        }
        // Silence on unsupported OS.
        let _ = health;
    }

    #[tokio::test]
    async fn sandbox_health_probe_reports_a_known_backend_id() {
        let health = sandbox_health_probe().await.unwrap();
        let ok = matches!(
            health.backend.as_str(),
            "windows-cognia-sandbox" | "macos-sandbox-exec" | "linux-bwrap" | "mock"
        ) || health.backend.starts_with("uninstalled-");
        assert!(ok, "unexpected backend id: {}", health.backend);
    }

    use crate::sandbox::types::{NetworkPolicy, SandboxCommand, SandboxError, SandboxPolicy};
    use std::path::PathBuf;
    use std::time::Duration;

    fn bash_policy(network: NetworkPolicy, writable: Vec<PathBuf>) -> SandboxPolicy {
        SandboxPolicy::Bash {
            writable,
            readable: vec![],
            network,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
        }
    }

    #[test]
    fn canonicalize_policy_rejects_relative_writable() {
        let policy = bash_policy(NetworkPolicy::Off, vec![PathBuf::from("relative/dir")]);
        assert!(matches!(
            canonicalize_policy(policy),
            Err(SandboxError::InvalidPolicy { .. })
        ));
    }

    #[test]
    fn canonicalize_policy_rejects_parent_traversal_in_target() {
        let policy = SandboxPolicy::Edit {
            target_files: vec![PathBuf::from("/work/../etc/passwd")],
            readable: vec![],
        };
        assert!(matches!(
            canonicalize_policy(policy),
            Err(SandboxError::InvalidPolicy { .. })
        ));
    }

    #[test]
    fn canonicalize_policy_accepts_valid_absolute_paths() {
        let dir = tempfile::tempdir().unwrap();
        let policy = bash_policy(NetworkPolicy::Off, vec![dir.path().to_path_buf()]);
        assert!(canonicalize_policy(policy).is_ok());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_downgrades_allowlist_to_no_network() {
        let policy = bash_policy(
            NetworkPolicy::Allowlist {
                hosts: vec!["api.github.com".into()],
            },
            vec![PathBuf::from("/w")],
        );
        let SandboxPolicy::Bash { network, .. } = downgrade_unenforceable_network(policy) else {
            panic!("expected Bash");
        };
        assert_eq!(network, NetworkPolicy::Off);
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn non_linux_preserves_allowlist() {
        let policy = bash_policy(
            NetworkPolicy::Allowlist {
                hosts: vec!["api.github.com".into()],
            },
            vec![PathBuf::from("/w")],
        );
        let SandboxPolicy::Bash { network, .. } = downgrade_unenforceable_network(policy) else {
            panic!("expected Bash");
        };
        assert!(matches!(network, NetworkPolicy::Allowlist { .. }));
    }

    #[test]
    fn reject_forbidden_paths_blocks_system_writable_root() {
        let deny = vec![PathBuf::from("/etc"), PathBuf::from("/usr")];
        let policy = bash_policy(NetworkPolicy::Off, vec![PathBuf::from("/etc/cron.d")]);
        let err = reject_forbidden_paths(&std::env::temp_dir(), &policy, &deny).unwrap_err();
        assert!(matches!(err, SandboxError::InvalidPolicy { .. }));
    }

    #[test]
    fn reject_forbidden_paths_allows_temp_and_workspace() {
        let deny = vec![PathBuf::from("/etc"), PathBuf::from("/usr")];
        let policy = bash_policy(NetworkPolicy::Off, vec![std::env::temp_dir()]);
        assert!(reject_forbidden_paths(&std::env::temp_dir(), &policy, &deny).is_ok());
    }

    #[test]
    fn reject_forbidden_paths_blocks_forbidden_edit_target() {
        let deny = vec![PathBuf::from("/etc")];
        let policy = SandboxPolicy::Edit {
            target_files: vec![PathBuf::from("/etc/passwd")],
            readable: vec![],
        };
        let err = reject_forbidden_paths(&std::env::temp_dir(), &policy, &deny).unwrap_err();
        assert!(matches!(err, SandboxError::InvalidPolicy { .. }));
    }

    #[test]
    fn reject_forbidden_paths_blocks_protected_credential_target() {
        // A write target inside `.ssh` is refused even when it is not under a
        // forbidden system root (the per-root re-deny can't see file tools).
        let deny: Vec<PathBuf> = vec![];
        let home_ssh = std::env::temp_dir()
            .join("home")
            .join(".ssh")
            .join("authorized_keys");
        let policy = SandboxPolicy::Write {
            target_files: vec![home_ssh],
            readable: vec![],
        };
        let err = reject_forbidden_paths(&std::env::temp_dir(), &policy, &deny).unwrap_err();
        assert!(matches!(err, SandboxError::InvalidPolicy { .. }));
    }

    #[tokio::test]
    async fn maybe_start_proxy_is_none_for_non_allowlist() {
        let mut cmd = SandboxCommand {
            argv: vec!["echo".into()],
            cwd: std::env::temp_dir(),
            env: Default::default(),
            stdin: None,
            timeout: Duration::from_secs(5),
        };
        let policy = bash_policy(NetworkPolicy::Off, vec![std::env::temp_dir()]);
        let guard = maybe_start_proxy(&mut cmd, &policy).await.unwrap();
        assert!(guard.is_none());
        assert!(!cmd.env.contains_key("HTTP_PROXY"));
    }

    #[tokio::test]
    async fn maybe_start_proxy_injects_env_for_allowlist() {
        let mut cmd = SandboxCommand {
            argv: vec!["echo".into()],
            cwd: std::env::temp_dir(),
            env: Default::default(),
            stdin: None,
            timeout: Duration::from_secs(5),
        };
        let policy = bash_policy(
            NetworkPolicy::Allowlist {
                hosts: vec!["api.github.com".into()],
            },
            vec![std::env::temp_dir()],
        );
        let guard = maybe_start_proxy(&mut cmd, &policy).await.unwrap();
        assert!(guard.is_some());
        assert!(cmd
            .env
            .get("HTTP_PROXY")
            .is_some_and(|v| v.starts_with("http://127.0.0.1:")));
        assert!(cmd.env.contains_key("COGNIA_SANDBOX_PROXY_PORT"));
    }

    #[tokio::test]
    async fn run_confined_fails_closed_when_backend_unavailable() {
        // On a host WITHOUT a real backend (e.g. CI without bwrap, or the
        // Windows dev box before the runner ships), an unavailable backend must
        // refuse rather than run unsandboxed. Skip where a backend is present.
        if current_backend().is_available() {
            return;
        }
        let cmd = SandboxCommand {
            argv: vec!["echo".into(), "hi".into()],
            cwd: std::env::temp_dir(),
            env: Default::default(),
            stdin: None,
            timeout: Duration::from_secs(5),
        };
        let policy = bash_policy(NetworkPolicy::Off, vec![std::env::temp_dir()]);
        let err = run_confined(cmd, policy).await.unwrap_err();
        assert!(matches!(
            err,
            SandboxError::SetupRequired { .. } | SandboxError::Unavailable { .. }
        ));
    }
}
