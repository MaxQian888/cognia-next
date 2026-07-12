//! Deterministic web-clone snapshot command for the visual-workflow node
//! (`io.webClone`) and any other renderer caller that needs a one-shot page
//! snapshot without going through an agent turn.
//!
//! The heavy engine is vendored under `sidecar/webclone` and runs as an
//! isolated child process (`webclone/dist/runner.js`) — see
//! `sidecar/webclone/VENDOR.md`. This command locates that runner (dev + bundled
//! release, via [`crate::claude::sidecar::sidecar_dir`]), spawns `node` on it
//! with the job fed on stdin, and returns the runner's single JSON envelope.
//!
//! Mirrors the deterministic native-work pattern of the headless-terminal
//! workflow commands (`terminal_headless_*`): the renderer executor calls this
//! via `invoke("web_clone_snapshot", …)`.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::claude::sidecar::sidecar_dir;

const DEFAULT_TIMEOUT_MS: u64 = 180_000;
const MAX_TIMEOUT_MS: u64 = 600_000;

/// A snapshot/convert job. `options` is the full engine `SnapshotOptions`
/// object, already assembled + validated on the TypeScript side.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebCloneJob {
    /// `"snapshot"` (fetch a URL) or `"convert"` (codegen on a local output).
    pub mode: String,
    #[serde(default)]
    pub url: Option<String>,
    pub options: Value,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// The command result — wraps the runner's envelope so it serializes as a JSON
/// object (never a bare tuple/array).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebCloneOutcome {
    /// The runner's `{ ok: true, result } | { ok: false, error }` envelope.
    pub envelope: Value,
}

/// Resolve the absolute path to the vendored engine runner, dev + release.
fn resolve_runner(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = sidecar_dir(app)?;
    let runner = dir.join("webclone").join("dist").join("runner.js");
    if runner.exists() {
        Ok(runner)
    } else {
        Err(format!(
            "web-clone runner not found at {} (run `pnpm sidecar:webclone:build`)",
            runner.display()
        ))
    }
}

/// Extract the runner's single JSON envelope from its captured stdio. The
/// runner routes progress chatter to stderr and prints exactly one envelope
/// line to stdout; we take the last non-empty stdout line. Pure — unit-tested.
fn parse_envelope_line(stdout: &str, stderr: &str) -> Result<Value, String> {
    let line = stdout
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .ok_or_else(|| {
            let tail: String = stderr.chars().rev().take(500).collect::<Vec<_>>().into_iter().rev().collect();
            format!(
                "web-clone runner produced no output. {}",
                if tail.is_empty() { "(no stderr)" } else { tail.trim() }
            )
        })?;
    serde_json::from_str(line.trim())
        .map_err(|e| format!("web-clone runner returned unparseable output: {e}"))
}

/// Run a one-shot web-clone snapshot/convert job. Returns the runner envelope.
#[tauri::command]
pub async fn web_clone_snapshot(app: AppHandle, job: WebCloneJob) -> Result<WebCloneOutcome, String> {
    let runner = resolve_runner(&app)?;
    let job_json = serde_json::to_string(&serde_json::json!({
        "mode": job.mode,
        "url": job.url,
        "options": job.options,
    }))
    .map_err(|e| format!("failed to serialize web-clone job: {e}"))?;
    let timeout = Duration::from_millis(job.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS));

    let mut cmd = Command::new("node");
    cmd.arg(&runner)
        .arg("-") // read the job JSON from stdin
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // Kill the child if this future is dropped (e.g. on timeout below) so a
        // runaway snapshot can never outlive the request.
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn node for web-clone runner: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(job_json.as_bytes())
            .await
            .map_err(|e| format!("failed to write web-clone job to runner stdin: {e}"))?;
        // Drop closes stdin → EOF, so the runner's readFileSync(0) returns.
    }

    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(res) => res.map_err(|e| format!("web-clone runner failed: {e}"))?,
        Err(_) => {
            return Err(format!(
                "web-clone runner timed out after {}ms",
                timeout.as_millis()
            ))
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let envelope = parse_envelope_line(&stdout, &stderr)?;
    Ok(WebCloneOutcome { envelope })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_envelope_line_takes_last_nonempty_stdout_line() {
        let stdout = "\n{\"ok\":true,\"result\":{\"output\":\"/w/o\"}}\n";
        let v = parse_envelope_line(stdout, "chatter").unwrap();
        assert_eq!(v["ok"], serde_json::json!(true));
        assert_eq!(v["result"]["output"], serde_json::json!("/w/o"));
    }

    #[test]
    fn parse_envelope_line_ignores_leading_progress_lines() {
        // Any accidental stdout chatter before the envelope is tolerated: we
        // take the LAST non-empty line.
        let stdout = "Fetching...\nDownloading...\n{\"ok\":false,\"error\":{\"message\":\"boom\"}}\n";
        let v = parse_envelope_line(stdout, "").unwrap();
        assert_eq!(v["ok"], serde_json::json!(false));
        assert_eq!(v["error"]["message"], serde_json::json!("boom"));
    }

    #[test]
    fn parse_envelope_line_errors_with_stderr_tail_when_empty() {
        let err = parse_envelope_line("   \n", "fatal: something broke").unwrap_err();
        assert!(err.contains("produced no output"), "{err}");
        assert!(err.contains("something broke"), "{err}");
    }

    #[test]
    fn parse_envelope_line_errors_on_unparseable() {
        let err = parse_envelope_line("not json at all\n", "").unwrap_err();
        assert!(err.contains("unparseable output"), "{err}");
    }
}
