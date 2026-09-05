//! Sandboxed Python execution for the Canvas code-execution panel.
//!
//! Spawns the system `python` (or `python3`) interpreter as a child
//! process, pipes the user code through stdin, and collects
//! stdout/stderr with a hard timeout. The process is killed when the
//! timeout elapses to bound resource usage.
//!
//! A run is addressable. `canvas_run_python` takes a `run_id` and registers
//! the child's handle under it, so `canvas_cancel_python` can kill the process.
//! Before that, Stop aborted an `AbortController` the Rust side never saw: the
//! UI detached and the interpreter kept running to its 30s timeout, holding
//! whatever it had opened.
//!
//! ADR-0028 Phase 3 (coverage extension): when the caller passes
//! `sandboxed = true` (driven by the renderer's Canvas sandbox toggle,
//! `AppSettings.canvasCodeSandboxEnabled`), the interpreter is executed
//! through the OS sandbox backend (`bwrap` / `sandbox-exec`) instead of a
//! bare child, the same `current_backend().run()` path the
//! `cognia-sandboxed-tools` plugin uses for `sandbox_bash`. Writes are
//! confined to a scratch tmp dir and the network is denied. On Windows
//! (runner pending) or any unavailable backend the call fails closed
//! (strict mode) rather than silently dropping to an unsandboxed run.

use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::oneshot;

use crate::sandbox::types::{NetworkPolicy, SandboxCommand, SandboxPolicy};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// Live runs, keyed by the id the renderer minted.
///
/// The registry holds a cancel SIGNAL, not the child. `wait_with_output`
/// consumes the child, so parking the handle here would mean taking it back out
/// to wait on it, and a cancel arriving during the wait would find nothing.
/// A signal can be delivered at any point in the run.
///
/// A `std::sync::Mutex` rather than a tokio one because every critical section
/// is a map insert or remove with no `.await` inside it. Holding a lock across
/// an await is the recurring trap in this codebase, and this shape makes it
/// impossible rather than merely avoided.
fn live_runs() -> &'static Mutex<HashMap<String, oneshot::Sender<()>>> {
    static RUNS: OnceLock<Mutex<HashMap<String, oneshot::Sender<()>>>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_run(run_id: &str, cancel: oneshot::Sender<()>) {
    if let Ok(mut runs) = live_runs().lock() {
        runs.insert(run_id.to_string(), cancel);
    }
}

/// Take a run's cancel signal out of the registry, if it is still there.
fn take_run(run_id: &str) -> Option<oneshot::Sender<()>> {
    live_runs()
        .lock()
        .ok()
        .and_then(|mut runs| runs.remove(run_id))
}

/// How a run ended, before its output is collected.
///
/// `Exited` carries the status rather than leaving the caller to ask the child
/// again: `wait()` has already reaped by then, so a second query is answering
/// from a cache that is not part of the contract.
enum RunOutcome {
    Exited(std::process::ExitStatus),
    Cancelled,
    TimedOut,
}

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
    let (command, policy) = build_python_sandbox(
        bin,
        code,
        std::env::temp_dir(),
        Duration::from_millis(limit_ms),
    );
    match crate::sandbox::run_confined(command, policy).await {
        Ok(result) => Ok(PythonExecResult {
            stdout: result.stdout,
            stderr: result.stderr,
            exit_code: result.exit_code,
            duration_ms: result.duration.as_millis() as u64,
        }),
        Err(err) => Err(err.to_string()),
    }
}

/// Kill a run started by [`canvas_run_python`].
///
/// Answers `false` for an id that is not running, which covers both "already
/// finished" and "never existed". The renderer treats those the same: the run
/// is not running now, which is what Stop was asking for.
#[tauri::command]
pub async fn canvas_cancel_python(run_id: String) -> Result<bool, String> {
    // Signalling rather than killing here: the task that spawned the child owns
    // it, kills it and reaps it, so there is exactly one owner of the handle.
    // A send failure means the receiver is already gone, which is the same
    // answer as an unknown id.
    match take_run(&run_id) {
        Some(cancel) => Ok(cancel.send(()).is_ok()),
        None => Ok(false),
    }
}

#[tauri::command]
pub async fn canvas_run_python(
    code: String,
    timeout_ms: Option<u64>,
    sandboxed: Option<bool>,
    run_id: Option<String>,
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
        // Drop closes stdin, the interpreter sees EOF and runs.
    }

    // Drain the pipes on their own tasks. A program that writes more than the
    // pipe buffer blocks until someone reads, so waiting on exit first would
    // hang on exactly the long-running runs cancellation exists for.
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buf).await;
        }
        buf
    });
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buf).await;
        }
        buf
    });

    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    if let Some(id) = run_id.as_deref() {
        register_run(id, cancel_tx);
    }

    // Scoped so the `&mut child` the wait future holds is released before the
    // kill below borrows it again.
    let outcome = {
        let wait = child.wait();
        tokio::pin!(wait);
        tokio::select! {
            status = &mut wait => RunOutcome::Exited(status.map_err(|e| format!("wait: {e}"))?),
            _ = cancel_rx => RunOutcome::Cancelled,
            _ = tokio::time::sleep(limit) => RunOutcome::TimedOut,
        }
    };

    if !matches!(outcome, RunOutcome::Exited(_)) {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
    // Whatever ended the run, the id stops being cancellable. Leaving it would
    // leak a sender per run and let a later Stop answer `true` for a run that
    // is long gone.
    if let Some(id) = run_id.as_deref() {
        let _ = take_run(id);
    }

    let stdout = String::from_utf8_lossy(&stdout_task.await.unwrap_or_default()).to_string();
    let stderr = String::from_utf8_lossy(&stderr_task.await.unwrap_or_default()).to_string();
    let duration_ms = start.elapsed().as_millis() as u64;

    Ok(match outcome {
        // Partial output is kept: half a program's stdout is still what it
        // printed, and it is what the user watched arrive.
        RunOutcome::Exited(status) => PythonExecResult {
            stdout,
            stderr,
            exit_code: status.code().unwrap_or(-1),
            duration_ms,
        },
        RunOutcome::Cancelled => PythonExecResult {
            stdout,
            stderr,
            // 130 is the shell's convention for "terminated by the user".
            exit_code: 130,
            duration_ms,
        },
        RunOutcome::TimedOut => PythonExecResult {
            stdout,
            stderr: if stderr.is_empty() {
                format!("timeout: execution exceeded {limit_ms}ms")
            } else {
                format!("{stderr}\ntimeout: execution exceeded {limit_ms}ms")
            },
            exit_code: 124,
            duration_ms,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn python_available() -> bool {
        Command::new(pick_python_binary())
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false)
    }

    #[tokio::test]
    async fn rejects_empty_input() {
        let res = canvas_run_python("   ".into(), Some(5_000), None, None).await;
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
        let res = canvas_run_python("   ".into(), Some(5_000), Some(true), None).await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn timeout_returns_124() {
        if !python_available().await {
            eprintln!("python not available; skipping");
            return;
        }
        let res = canvas_run_python(
            "import time\ntime.sleep(5)".into(),
            Some(150),
            None,
            None,
        )
        .await
        .expect("python ran");
        assert_eq!(res.exit_code, 124);
    }

    #[tokio::test]
    async fn cancelling_an_unknown_run_is_not_an_error() {
        // "Already finished" and "never existed" are the same answer to the
        // question Stop is asking, so neither is a failure.
        assert!(!canvas_cancel_python("no-such-run".into()).await.unwrap());
    }

    #[tokio::test]
    async fn cancel_kills_the_interpreter_instead_of_detaching_the_ui() {
        if !python_available().await {
            eprintln!("python not available; skipping");
            return;
        }
        let run_id = "cancel-test-1".to_string();
        let handle = tokio::spawn(canvas_run_python(
            "import time\ntime.sleep(30)".into(),
            // A timeout far past the cancel, so a pass cannot come from the
            // deadline expiring instead of the kill landing.
            Some(30_000),
            None,
            Some(run_id.clone()),
        ));

        // Wait for the run to register rather than sleeping a fixed amount.
        for _ in 0..200 {
            if live_runs().lock().map(|r| r.contains_key(&run_id)).unwrap_or(false) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(canvas_cancel_python(run_id.clone()).await.unwrap());

        let result = tokio::time::timeout(Duration::from_secs(10), handle)
            .await
            .expect("the run returned promptly rather than waiting out its timeout")
            .expect("task joined")
            .expect("python ran");
        assert_eq!(result.exit_code, 130);
        assert!(result.duration_ms < 25_000);
        // The id is not cancellable twice.
        assert!(!canvas_cancel_python(run_id).await.unwrap());
    }

    #[tokio::test]
    async fn a_completed_run_stops_being_cancellable() {
        if !python_available().await {
            eprintln!("python not available; skipping");
            return;
        }
        let run_id = "cancel-test-2".to_string();
        let result = canvas_run_python(
            "print('done')".into(),
            Some(10_000),
            None,
            Some(run_id.clone()),
        )
        .await
        .expect("python ran");
        assert_eq!(result.exit_code, 0);
        assert!(result.stdout.contains("done"));
        // Leaving the entry would leak a sender per run and let a later Stop
        // answer `true` for a run that is long gone.
        assert!(!canvas_cancel_python(run_id).await.unwrap());
    }

    #[tokio::test]
    async fn collects_output_larger_than_the_pipe_buffer() {
        if !python_available().await {
            eprintln!("python not available; skipping");
            return;
        }
        // Waiting on exit before draining the pipes deadlocks here, which is
        // exactly the case cancellation exists for.
        let result = canvas_run_python(
            "print('x' * 300000)".into(),
            Some(20_000),
            None,
            Some("big-output".into()),
        )
        .await
        .expect("python ran");
        assert_eq!(result.exit_code, 0);
        assert!(result.stdout.len() >= 300_000);
    }
}
