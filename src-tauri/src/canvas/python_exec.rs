//! Sandboxed Python execution for the Canvas code-execution panel.
//!
//! Spawns the system `python` (or `python3`) interpreter as a child
//! process, pipes the user code through stdin, and collects
//! stdout/stderr with a hard timeout. The process is killed when the
//! timeout elapses to bound resource usage.

use serde::Serialize;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

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

#[tauri::command]
pub async fn canvas_run_python(
    code: String,
    timeout_ms: Option<u64>,
) -> Result<PythonExecResult, String> {
    if code.trim().is_empty() {
        return Err("code is empty".to_string());
    }
    let limit_ms = timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
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
        let res = canvas_run_python("   ".into(), Some(5_000)).await;
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
        let res = canvas_run_python("import time\ntime.sleep(5)".into(), Some(150))
            .await
            .expect("python ran");
        assert_eq!(res.exit_code, 124);
    }
}
