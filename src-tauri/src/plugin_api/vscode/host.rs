//! Sidecar process lifecycle.
//!
//! Each extension runs in its own Node sidecar so a crash isolates to one
//! extension. The sidecar binary is bundled by Tauri via
//! `tauri.conf.json:bundle.externalBin`.
//!
//! The renderer drives lifecycle through the Tauri commands in
//! [`super::commands`]. This module just wraps `tauri::api::process::Command`
//! (via `@tauri-apps/plugin-shell`) into a typed handle.
//!
//! `dead_code` is silenced module-wide: the `Sidecar` struct's fields are
//! mutated through methods rather than read directly, and the
//! `SidecarError::AlreadyExited` variant is reserved for the M3 keep-alive
//! reconciliation path. Methods like `send`/`kill` are called from
//! `commands.rs`, which is itself marked dead by the macro-hiding effect
//! described in that module.
#![allow(dead_code)]

use std::process::Stdio;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

#[derive(Debug, thiserror::Error)]
pub enum SidecarError {
    #[error("sidecar spawn failed: {0}")]
    SpawnFailed(String),
    #[error("sidecar pid unavailable")]
    PidUnavailable,
    #[error("sidecar stdout/stdin not piped")]
    StdioNotPiped,
    #[error("sidecar already exited")]
    AlreadyExited,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnRequest {
    pub extension_id: String,
    pub extension_path: String,
    pub node_binary: Option<String>,
    pub sidecar_script: Option<String>,
}

/// Owned reference to one running sidecar. Drop kills the child.
pub struct Sidecar {
    pub extension_id: String,
    pub pid: u32,
    /// Tx for outgoing frames written to the sidecar's stdin.
    pub stdin_tx: mpsc::UnboundedSender<String>,
    /// Rx for incoming frames read from the sidecar's stdout.
    pub stdout_rx: Arc<Mutex<mpsc::UnboundedReceiver<String>>>,
    /// Handle to the spawned process so we can kill it on drop.
    child: Arc<Mutex<Option<Child>>>,
    /// Subscribers receive every stdout frame (used by the renderer-side
    /// RPC layer).
    pub subscribers: Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<String>>>>,
}

impl Sidecar {
    /// Spawn the Node sidecar. `node_binary` defaults to `node` from the
    /// `PATH`; `sidecar_script` defaults to
    /// `<extension_path>/../../dist/host.cjs` (resolved by callers).
    pub async fn spawn(req: SpawnRequest) -> Result<Self, SidecarError> {
        let node = req.node_binary.as_deref().unwrap_or("node");
        let script = req
            .sidecar_script
            .as_deref()
            .ok_or_else(|| SidecarError::SpawnFailed("sidecar_script is required".to_string()))?;
        let mut command = Command::new(node);
        command
            .arg(script)
            .arg("--cognia-extension")
            .arg(&req.extension_id)
            .env("COGNIA_VSCODE_EXTENSION_ID", &req.extension_id)
            .env("COGNIA_VSCODE_EXTENSION_PATH", &req.extension_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command
            .spawn()
            .map_err(|e| SidecarError::SpawnFailed(format!("{e}")))?;
        let pid = child.id().ok_or(SidecarError::PidUnavailable)?;
        let stdin = child.stdin.take().ok_or(SidecarError::StdioNotPiped)?;
        let stdout = child.stdout.take().ok_or(SidecarError::StdioNotPiped)?;

        let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<String>();
        let (stdout_tx, stdout_rx) = mpsc::unbounded_channel::<String>();
        let subscribers: Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<String>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        // Stdin writer task.
        tokio::spawn(async move {
            let mut stdin: ChildStdin = stdin;
            while let Some(frame) = stdin_rx.recv().await {
                let mut payload = frame;
                if !payload.ends_with('\n') {
                    payload.push('\n');
                }
                if stdin.write_all(payload.as_bytes()).await.is_err() {
                    break;
                }
                if stdin.flush().await.is_err() {
                    break;
                }
            }
        });

        // Stdout reader task — broadcasts each line to subscribers + the
        // primary rx.
        let subs_for_reader = subscribers.clone();
        tokio::spawn(async move {
            let stdout: ChildStdout = stdout;
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = stdout_tx.send(line.clone());
                let snapshot: Vec<_> = subs_for_reader.lock().values().cloned().collect();
                for tx in snapshot {
                    let _ = tx.send(line.clone());
                }
            }
        });

        Ok(Self {
            extension_id: req.extension_id,
            pid,
            stdin_tx,
            stdout_rx: Arc::new(Mutex::new(stdout_rx)),
            child: Arc::new(Mutex::new(Some(child))),
            subscribers,
        })
    }

    /// Send a single JSON-RPC frame to the sidecar's stdin.
    pub fn send(&self, frame: &str) -> Result<(), SidecarError> {
        self.stdin_tx
            .send(frame.to_string())
            .map_err(|_| SidecarError::AlreadyExited)
    }

    pub async fn kill(&self) {
        let child_opt = self.child.lock().take();
        if let Some(mut child) = child_opt {
            let _ = child.kill().await;
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        // Best-effort sync kill so dropping a Sidecar handle (e.g. during
        // shutdown) doesn't leak the child.
        if let Some(mut child) = self.child.lock().take() {
            let _ = child.start_kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn spawn_rejects_when_script_is_missing() {
        let result = Sidecar::spawn(SpawnRequest {
            extension_id: "x".to_string(),
            extension_path: "/tmp/x".to_string(),
            node_binary: Some("node".to_string()),
            sidecar_script: None,
        })
        .await;
        assert!(matches!(result, Err(SidecarError::SpawnFailed(_))));
    }
}
