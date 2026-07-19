//! Sidecar process lifecycle and JSON-RPC frame router.
//!
//! Each extension runs in its own Node sidecar so a crash isolates to one
//! extension. The sidecar binary is bundled by Tauri via
//! `tauri.conf.json:bundle.externalBin`.
//!
//! The renderer drives lifecycle through the Tauri commands in
//! [`super::commands`]. This module wraps `tokio::process::Command` into a
//! typed handle and classifies every stdout line:
//!
//! - **Response** (`{ id, result|error }`): completes a pending oneshot
//!   registered by `register_pending`.
//! - **Request** (`{ id, method, params }`) / **Notification**
//!   (`{ method, params }`): forwarded to the renderer via `notify_tx`
//!   so the renderer's RPC dispatcher (`lib/plugin/vscode-shim/rpc-dispatcher.ts`)
//!   can handle it.
//!
//! `dead_code` is silenced module-wide: the `Sidecar` struct's fields are
//! mutated through methods rather than read directly, and the
//! `SidecarError::AlreadyExited` variant is reserved for the keep-alive
//! reconciliation path. Methods like `send`/`kill` are called from
//! `commands.rs`, which is itself marked dead by the macro-hiding effect
//! described in that module.
#![allow(dead_code)]

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot};

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

/// A frame coming from the sidecar that is NOT a response to a pending
/// renderer-initiated request. The renderer's RPC dispatcher consumes
/// these and either fires a notification handler (no id) or builds a
/// response back through `plugin_vscode_send_response` (has id).
#[derive(Debug, Clone)]
pub struct InboundFrame {
    pub extension_id: String,
    pub raw_frame: String,
}

/// Owned reference to one running sidecar. Drop kills the child.
pub struct Sidecar {
    pub extension_id: String,
    pub extension_path: String,
    pub pid: u32,
    /// Tx for outgoing frames written to the sidecar's stdin.
    pub stdin_tx: mpsc::UnboundedSender<String>,
    /// Pending oneshot map: `id -> sender`. When a response frame with
    /// matching `id` lands on stdout, the value is popped and fired.
    pub pending: Arc<Mutex<HashMap<i64, oneshot::Sender<String>>>>,
    /// Inbound frame sink for sidecar-initiated requests/notifications.
    /// `commands::plugin_load_vscode` wires this to a Tauri event emitter.
    pub notify_tx: Arc<Mutex<Option<mpsc::UnboundedSender<InboundFrame>>>>,
    /// Handle to the spawned process so we can kill it on drop.
    child: Arc<Mutex<Option<Child>>>,
}

impl Sidecar {
    /// Spawn the Node sidecar. `node_binary` defaults to `node` from the
    /// `PATH`; `sidecar_script` must be supplied by the caller (the
    /// production binary path is resolved by Tauri's sidecar bundling).
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
        let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<String>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let notify_tx: Arc<Mutex<Option<mpsc::UnboundedSender<InboundFrame>>>> =
            Arc::new(Mutex::new(None));

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

        // Stdout reader task — classify each line:
        //   * Has `id` and (`result` xor `error`) but no `method` → response
        //     → fire the matching pending oneshot.
        //   * Has `method` (with or without `id`) → forward to notify_tx so
        //     the renderer can handle/reply.
        //   * Anything else → discarded with a debug log (banner lines etc).
        let pending_for_reader = pending.clone();
        let notify_for_reader = notify_tx.clone();
        let extension_id_for_reader = req.extension_id.clone();
        tokio::spawn(async move {
            let stdout: ChildStdout = stdout;
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let parsed: serde_json::Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let has_method = parsed.get("method").is_some();
                let id_value = parsed.get("id").and_then(|v| v.as_i64());
                let has_result_or_error =
                    parsed.get("result").is_some() || parsed.get("error").is_some();

                if !has_method && has_result_or_error {
                    if let Some(id) = id_value {
                        if let Some(sender) = pending_for_reader.lock().remove(&id) {
                            let _ = sender.send(line.clone());
                        }
                    }
                    continue;
                }

                if has_method {
                    let guard = notify_for_reader.lock();
                    if let Some(tx) = guard.as_ref() {
                        let _ = tx.send(InboundFrame {
                            extension_id: extension_id_for_reader.clone(),
                            raw_frame: line.clone(),
                        });
                    }
                }
            }

            // Stream ended → reject every pending future so callers don't
            // wait forever for a dead sidecar.
            let drained: Vec<i64> = pending_for_reader.lock().keys().copied().collect();
            for id in drained {
                if let Some(sender) = pending_for_reader.lock().remove(&id) {
                    let _ = sender.send(
                        serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": { "code": -32099, "message": "sidecar terminated" },
                        })
                        .to_string(),
                    );
                }
            }
        });

        Ok(Self {
            extension_id: req.extension_id,
            extension_path: req.extension_path,
            pid,
            stdin_tx,
            pending,
            notify_tx,
            child: Arc::new(Mutex::new(Some(child))),
        })
    }

    /// Send a single JSON-RPC frame to the sidecar's stdin.
    pub fn send(&self, frame: &str) -> Result<(), SidecarError> {
        self.stdin_tx
            .send(frame.to_string())
            .map_err(|_| SidecarError::AlreadyExited)
    }

    /// Register a pending receiver for an outbound request id. The future
    /// completes when a matching response lands on stdout. Caller is
    /// responsible for picking unique ids.
    pub fn register_pending(&self, id: i64) -> oneshot::Receiver<String> {
        let (tx, rx) = oneshot::channel::<String>();
        self.pending.lock().insert(id, tx);
        rx
    }

    /// Drop a pending registration (e.g. on timeout) so the map doesn't
    /// grow unbounded.
    pub fn drop_pending(&self, id: i64) {
        self.pending.lock().remove(&id);
    }

    /// Wire the sidecar's inbound (notify/request) frames to a renderer-
    /// facing channel. The previous sender is replaced; only one consumer
    /// at a time.
    pub fn set_notify_sink(&self, tx: mpsc::UnboundedSender<InboundFrame>) {
        *self.notify_tx.lock() = Some(tx);
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

    #[test]
    fn classify_inbound_frame_shape() {
        // Response: has id + result, no method
        let response: serde_json::Value =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":7,"result":"ok"}"#).unwrap();
        assert!(response.get("method").is_none());
        assert_eq!(response.get("id").and_then(|v| v.as_i64()), Some(7));
        assert!(response.get("result").is_some());

        // Notification: has method, no id
        let notification: serde_json::Value = serde_json::from_str(
            r#"{"jsonrpc":"2.0","method":"languages:setDiagnostics","params":{}}"#,
        )
        .unwrap();
        assert!(notification.get("method").is_some());
        assert!(notification.get("id").is_none());

        // Request: has method AND id
        let request: serde_json::Value = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":11,"method":"lm:selectChatModels","params":{}}"#,
        )
        .unwrap();
        assert!(request.get("method").is_some());
        assert_eq!(request.get("id").and_then(|v| v.as_i64()), Some(11));
    }
}
