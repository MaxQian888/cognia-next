// ADR-0028 Phase 8 — sandbox integration tests.
//
// Exercises the REAL per-platform backends (sandbox-exec on macOS, bwrap on
// Linux). Each `#[cfg(target_os = …)]` block runs only on its host platform;
// Windows is skipped because the vendored backend isn't shipping in V1 and
// UAC can't be automated in CI.
//
// Invocation:
//   cargo test --test sandbox_integration         # all backends for host OS
//   cargo test --test sandbox_integration -- --nocapture
//
// CI matrix (per ADR-0028 §"Verification"):
//   ubuntu-latest    -> bwrap path runs
//   macos-14         -> sandbox-exec path runs
//   windows-latest   -> tests no-op (skipped via cfg)

#![allow(unused_imports)]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use app_lib::sandbox::traits::SandboxedExec;
use app_lib::sandbox::types::{NetworkPolicy, SandboxCommand, SandboxPolicy};

#[allow(dead_code)]
fn sample_cmd(argv: Vec<&str>, cwd: &str) -> SandboxCommand {
    SandboxCommand {
        argv: argv.into_iter().map(String::from).collect(),
        cwd: PathBuf::from(cwd),
        env: BTreeMap::new(),
        stdin: None,
        timeout: Duration::from_secs(10),
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use app_lib::sandbox::linux::LinuxSandboxBackend;

    #[tokio::test]
    async fn bwrap_runs_echo_with_writable_cwd() {
        let backend = LinuxSandboxBackend::new(None);
        if !backend.is_available() {
            eprintln!("skipping — system bwrap not present");
            return;
        }
        // /tmp is universally writable; use it as the cwd.
        let cmd = sample_cmd(vec!["bash", "-c", "echo hello-from-sandbox"], "/tmp");
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/tmp")],
            readable: vec![],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
        };
        let result = backend
            .run(cmd, policy)
            .await
            .expect("sandboxed echo should succeed");
        assert_eq!(result.exit_code, 0, "stderr: {}", result.stderr);
        assert!(
            result.stdout.contains("hello-from-sandbox"),
            "stdout: {:?}",
            result.stdout
        );
    }

    #[tokio::test]
    async fn bwrap_denies_network_when_off() {
        let backend = LinuxSandboxBackend::new(None);
        if !backend.is_available() {
            eprintln!("skipping — system bwrap not present");
            return;
        }
        // Try to ping a TCP listener — should fail with no route / connect refused.
        // We avoid DNS by using `curl --resolve` with an IP literal that's
        // routable from the host but not from inside the sandbox.
        let cmd = sample_cmd(
            vec![
                "bash",
                "-c",
                "exec 3<>/dev/tcp/8.8.8.8/53 && echo connected || echo blocked",
            ],
            "/tmp",
        );
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/tmp")],
            readable: vec![],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
        };
        let result = backend
            .run(cmd, policy)
            .await
            .expect("sandboxed network probe should run");
        // With network off, the connection attempt should fail. We accept
        // either "blocked" in stdout or a nonzero exit code (bash errors out
        // when /dev/tcp fails depending on shell version).
        let stdout_blocked = result.stdout.contains("blocked");
        let exit_nonzero = result.exit_code != 0;
        assert!(
            stdout_blocked || exit_nonzero,
            "expected network deny — stdout={:?} stderr={:?} exit={}",
            result.stdout,
            result.stderr,
            result.exit_code,
        );
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use app_lib::sandbox::macos::MacOsSandboxBackend;

    #[tokio::test]
    async fn sandbox_exec_runs_echo() {
        let backend = MacOsSandboxBackend::new();
        if !backend.is_available() {
            eprintln!("skipping — /usr/bin/sandbox-exec missing");
            return;
        }
        let cmd = sample_cmd(vec!["bash", "-c", "echo hello-from-sandbox"], "/tmp");
        let policy = SandboxPolicy::Bash {
            writable: vec![PathBuf::from("/tmp")],
            readable: vec![],
            network: NetworkPolicy::Off,
            max_cpu_seconds: 0,
            max_memory_mb: 0,
        };
        let result = backend
            .run(cmd, policy)
            .await
            .expect("sandboxed echo should succeed");
        assert_eq!(result.exit_code, 0, "stderr: {}", result.stderr);
        assert!(
            result.stdout.contains("hello-from-sandbox"),
            "stdout: {:?}",
            result.stdout
        );
    }
}

#[cfg(target_os = "windows")]
#[test]
fn windows_backend_is_setup_required_until_vendor_ships() {
    // No async runtime here — keep it a plain test that doesn't try to call
    // run(). The Phase 4.2 vendoring follow-up replaces this with a real
    // restricted-token integration test.
    use app_lib::sandbox::windows::WindowsSandboxBackend;
    let backend = WindowsSandboxBackend::new();
    assert!(
        !backend.is_available(),
        "Windows sandbox should report not-yet-available until Phase 4.2 vendoring lands"
    );
}
