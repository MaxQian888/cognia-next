// ADR-0028 — `SandboxedExec` trait. The single abstraction every backend
// implements: take a `SandboxCommand` + `SandboxPolicy`, produce a
// `SandboxResult` or `SandboxError`.
//
// `run` / `is_available` / `first_time_setup` go live in Phase 4.2+ (real
// per-platform backend invocations) and Phase 4.5 (dispatcher consumes the
// trait via the `sandbox_exec` Tauri command). `health` is already live
// today via `sandbox_health_probe` in `mod.rs`.
#![allow(dead_code)]
//
// Lives in its own file so backends (`mock`, `uninstalled`, future
// `windows` / `macos` / `linux`) can `use crate::sandbox::traits::*` without
// pulling in the dispatcher / Tauri command surface that lives in `mod.rs`.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;

use crate::sandbox::types::{
    NetworkPolicy, ProbeReport, SandboxCommand, SandboxError, SandboxHealth, SandboxPolicy,
    SandboxResult,
};

/// Monotonic per-process counter so concurrent probes never collide on their
/// temp paths (no `rand`/`Instant`-based naming needed).
static PROBE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Build a `SandboxCommand` that runs `script` through the platform shell with
/// `cwd` as the working directory and a short timeout. Used only by the
/// confinement probe.
fn probe_command(cwd: &Path, script: &str) -> SandboxCommand {
    let argv = if cfg!(target_os = "windows") {
        vec!["cmd".into(), "/c".into(), script.to_string()]
    } else {
        vec!["sh".into(), "-c".into(), script.to_string()]
    };
    SandboxCommand {
        argv,
        cwd: cwd.to_path_buf(),
        env: BTreeMap::new(),
        stdin: None,
        timeout: Duration::from_secs(10),
    }
}

#[async_trait]
pub trait SandboxedExec: Send + Sync {
    /// Run `command` under `policy`. Backends MUST enforce the policy at
    /// the OS layer (restricted tokens / ACLs / SBPL / bwrap flags); the
    /// dispatcher does NOT pre-check.
    async fn run(
        &self,
        command: SandboxCommand,
        policy: SandboxPolicy,
    ) -> Result<SandboxResult, SandboxError>;

    /// Cheap availability check. False when first-time setup is needed
    /// (Windows synthetic-user creation, bwrap binary missing, etc.).
    /// Renderer polls this for the Settings → Sandbox status badge; the
    /// strict-mode policy then refuses tool calls when this is false.
    fn is_available(&self) -> bool;

    /// One-time setup. Windows triggers UAC to create the synthetic user
    /// + Firewall rules. macOS / Linux are no-ops (the binaries are
    /// bundled at install time). The mock backend uses this as a test
    /// hook.
    async fn first_time_setup(&self) -> Result<(), SandboxError>;

    /// Diagnostic snapshot for the renderer's Settings → Sandbox tab.
    fn health(&self) -> SandboxHealth;

    /// ACTIVE confinement probe. Unlike `health`/`is_available` (which only
    /// check that the backend binary exists), this actually runs commands in
    /// the sandbox and verifies confinement is enforced. Two sub-probes:
    ///
    /// 1. **positive** — a trivial command (`exit 0`) must run to completion.
    ///    A present-but-broken backend (rejected SBPL profile, corrupt runner)
    ///    fails here because `run` returns `Err`.
    /// 2. **negative** — a write to a normally-writable path that is OUTSIDE
    ///    the policy's writable set must be blocked. This distinguishes real
    ///    confinement from a no-op: if the file is created on the host, the
    ///    sandbox did not actually confine, even when sub-probe 1 "succeeded".
    ///
    /// The default impl works for every real backend via `self.run`. Failures
    /// are returned as data (`confined: false` + `detail`), not `Err`, so the
    /// renderer can render a precise reason.
    async fn probe_confinement(&self) -> ProbeReport {
        let backend = self.health().backend;
        if !self.is_available() {
            return ProbeReport {
                backend,
                confined: false,
                detail: "backend unavailable — sandbox binary not installed".into(),
            };
        }

        // Unique writable probe dir (the ONLY path in the writable set).
        let seq = PROBE_SEQ.fetch_add(1, Ordering::Relaxed);
        let base =
            std::fs::canonicalize(std::env::temp_dir()).unwrap_or_else(|_| std::env::temp_dir());
        let tag = format!("cognia-sandbox-probe-{}-{}", std::process::id(), seq);
        let writable_dir = base.join(&tag);
        let _ = std::fs::create_dir_all(&writable_dir);
        let writable_dir = std::fs::canonicalize(&writable_dir).unwrap_or(writable_dir);

        // The negative-probe target must be normally writable yet OUTSIDE the
        // policy's writable set — AND outside the system temp roots, which the
        // macOS seatbelt profile always permits (macos.rs allows
        // /private/var/folders + /tmp). The user's home directory satisfies
        // both: writable unconfined, denied under confinement.
        let forbidden = dirs::home_dir().map(|h| h.join(format!(".{tag}-denied.tmp")));
        if let Some(f) = forbidden.as_ref() {
            let _ = std::fs::remove_file(f);
        }

        let policy = SandboxPolicy::Bash {
            writable: vec![writable_dir.clone()],
            readable: vec![],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 5,
            max_memory_mb: 256,
        };

        // Sub-probe 1: trivial command must run under confinement.
        let positive = self
            .run(probe_command(&writable_dir, "exit 0"), policy.clone())
            .await;
        match positive {
            Ok(r) if r.exit_code == 0 && !r.timed_out => {}
            Ok(r) => {
                let _ = std::fs::remove_dir_all(&writable_dir);
                return ProbeReport {
                    backend,
                    confined: false,
                    detail: format!(
                        "a trivial confined command returned exit {}{}",
                        r.exit_code,
                        if r.timed_out { " (timed out)" } else { "" }
                    ),
                };
            }
            Err(e) => {
                let _ = std::fs::remove_dir_all(&writable_dir);
                return ProbeReport {
                    backend,
                    confined: false,
                    detail: format!("sandbox failed to run a trivial command: {e}"),
                };
            }
        }

        // Sub-probe 2: a write outside the writable set must be blocked. Skip
        // only if we couldn't resolve a home dir to target (very rare); in that
        // case the positive probe alone stands.
        let Some(forbidden) = forbidden else {
            let _ = std::fs::remove_dir_all(&writable_dir);
            return ProbeReport {
                backend,
                confined: true,
                detail: "ok (write-denial probe skipped — no home directory)".into(),
            };
        };
        let target = forbidden.to_string_lossy().replace('"', "");
        let neg = self
            .run(
                probe_command(&writable_dir, &format!("echo probe > \"{target}\"")),
                policy,
            )
            .await;
        let blocked_by_exit = match neg {
            Ok(r) => r.exit_code != 0,
            // The backend refusing to even run the write counts as blocked.
            Err(_) => true,
        };
        // Authoritative check: did the file actually appear on the host?
        let leaked = forbidden.exists();
        let _ = std::fs::remove_file(&forbidden);
        let _ = std::fs::remove_dir_all(&writable_dir);

        if leaked || !blocked_by_exit {
            return ProbeReport {
                backend,
                confined: false,
                detail: "a write outside the sandbox's writable set was NOT blocked \
                         — confinement is not being enforced"
                    .into(),
            };
        }

        ProbeReport {
            backend,
            confined: true,
            detail: "ok".into(),
        }
    }
}
