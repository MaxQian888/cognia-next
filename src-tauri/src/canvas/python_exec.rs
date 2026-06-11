//! Sandboxed Python execution for the Canvas code-execution panel.
//!
//! Spawns the system `python` (or `python3`) interpreter as a child
//! process, pipes the user code through stdin, and collects
//! stdout/stderr with a hard timeout. The process is killed when the
//! timeout elapses to bound resource usage.
//!
//! ADR-0028 Phase 3 (coverage extension): when the caller passes
//! `sandboxed = true` (driven by the renderer's global sandbox toggle,
//! `AppSettings.sandboxDefaultEnabled`), the interpreter is executed
//! through the OS sandbox backend (`bwrap` / `sandbox-exec`) instead of a
//! bare child — the same `current_backend().run()` path the
//! `cognia-sandboxed-tools` plugin uses for `sandbox_bash`. Writes are
//! confined to a scratch tmp dir and the network is denied. On Windows
//! (runner pending) or any unavailable backend the call fails closed
//! (strict mode) rather than silently dropping to an unsandboxed run.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::sandbox::types::{NetworkPolicy, SandboxCommand, SandboxPolicy};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;

#[derive(Debug, Serialize, Clone)]
pub struct PythonExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub duration_ms: u64,
}

fn pick_python_binary() -> &'static str {
    if cfg!(target_os = "windows") {
        // On Windows the default install adds `python.exe`; `python3` is
        // typically only present when the launcher is missing.
        "python"
    } else {
        // macOS ships `python3` only; many Linux distros do too.
        "python3"
    }
}

/// Build the `(SandboxCommand, SandboxPolicy)` pair for a sandboxed Python
/// run. Pure (no I/O) so it is host-unit-testable on every platform even
/// though the actual backend exec only runs on macOS / Linux today.
///
/// The interpreter reads the user code from stdin (`python -`); writes are
/// confined to `scratch` (the OS temp dir, which the Linux backend further
/// overlays with a private tmpfs); the network is denied.
fn build_python_sandbox(
    bin: &str,
    code: &str,
    scratch: PathBuf,
    timeout: Duration,
) -> (SandboxCommand, SandboxPolicy) {
    let command = SandboxCommand {
        argv: vec![bin.to_string(), "-".to_string()],
        cwd: scratch.clone(),
        env: BTreeMap::new(),
        stdin: Some(code.as_bytes().to_vec()),
        timeout,
    };
    let policy = SandboxPolicy::Bash {
        writable: vec![scratch],
        readable: vec![],
        network: NetworkPolicy::Off,
        max_cpu_seconds: 0,
        max_memory_mb: 0,
    };
    (command, policy)
}

/// Execute Python through the OS sandbox backend. Fails closed when the
/// backend is unavailable (Windows runner pending / `bwrap` missing) — the
/// renderer surfaces the error verbatim rather than running unsandboxed.
async fn run_python_sandboxed(
    bin: &str,
    code: &str,
    limit_ms: u64,
) -> Result<PythonExecResult, String> {
    let start = Instant::now();
    let (command, policy) =
        build_python_sandbox(bin, code, std::env::temp_dir(), Duration::from_millis(limit_ms));
    match crate::sandbox::current_backend().run(command, policy).await {
        Ok(result) => Ok(PythonExecResult {
            stdout: result.stdout,
            stderr: result.stderr,
            exit_code: result.exit_code,
            duration_ms: result.duration.as_millis() as u64,
        }),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
pub async fn canvas_run_python(
    code: String,
    timeout_ms: Option<u64>,
    sandboxed: Option<bool>,
) -> Result<PythonExecResult, String> {
    if code.trim().is_empty() {
        return Err("code is empty".to_string());
    }
    let limit_ms = timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);

    // ADR-0028 Phase 3 — route through the OS sandbox when the renderer's
    // global sandbox toggle is on. Strict mode: a sandboxed request never
    // falls back to the bare interpreter.
    if sandboxed.unwrap_or(false) {
        let bin = pick_python_binary();
        return run_python_sandboxed(bin, &code, limit_ms).await;
    }

    let limit = Duration::from_millis(limit_ms);
    let start = Instant::now();

    let bin = pick_python_binary();
    let mut child = Command::new(bin)
        .arg("-")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to spawn {bin}: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(code.as_bytes())
            .await
            .map_err(|e| format!("write stdin: {e}"))?;
        // Drop closes stdin → interpreter sees EOF and runs.
    }

    let wait = child.wait_with_output();
    let result = match tokio::time::timeout(limit, wait).await {
        Ok(Ok(out)) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let exit_code = out.status.code().unwrap_or(-1);
            Ok(PythonExecResult {
                stdout,
                stderr,
                exit_code,
                duration_ms: start.elapsed().as_millis() as u64,
            })
        }
        Ok(Err(e)) => Err(format!("wait: {e}")),
        Err(_) => Ok(PythonExecResult {
            stdout: String::new(),
            stderr: format!("timeout: execution exceeded {limit_ms}ms"),
            exit_code: 124,
            duration_ms: limit_ms,
        }),
    };

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_empty_input() {
        let res = canvas_run_python("   ".into(), Some(5_000), None).await;
        assert!(res.is_err());
    }

    #[test]
    fn build_python_sandbox_pipes_code_via_stdin_and_denies_network() {
        let (cmd, policy) = build_python_sandbox(
            "python3",
            "print('hi')",
            PathBuf::from("/scratch"),
            Duration::from_secs(30),
        );
        assert_eq!(cmd.argv, vec!["python3".to_string(), "-".to_string()]);
        assert_eq!(cmd.cwd, PathBuf::from("/scratch"));
        assert_eq!(cmd.stdin.as_deref(), Some(b"print('hi')".as_slice()));
        match policy {
            SandboxPolicy::Bash {
                writable, network, ..
            } => {
                assert_eq!(writable, vec![PathBuf::from("/scratch")]);
                assert_eq!(network, NetworkPolicy::Off);
            }
            _ => panic!("expected Bash policy"),
        }
    }

    #[tokio::test]
    async fn sandboxed_request_rejects_empty_input_too() {
        let res = canvas_run_python("   ".into(), Some(5_000), Some(true)).await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn timeout_returns_124() {
        // `python` should always be available on dev machines for this test;
        // we skip when it is not.
        let probe = Command::new(pick_python_binary())
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await;
        if probe.is_err() || !probe.unwrap().success() {
            eprintln!("python not available; skipping");
            return;
        }
        let res = canvas_run_python("import time\ntime.sleep(5)".into(), Some(150), None)
            .await
            .expect("python ran");
        assert_eq!(res.exit_code, 124);
    }
}
