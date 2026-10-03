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
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, watch};

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
    pub generation: String,
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
    pub generation: String,
    pub pid: u32,
    /// Tx for outgoing frames written to the sidecar's stdin.
    pub stdin_tx: mpsc::UnboundedSender<String>,
    /// Pending oneshot map: `id -> sender`. When a response frame with
    /// matching `id` lands on stdout, the value is popped and fired.
    pub pending: Arc<Mutex<HashMap<i64, oneshot::Sender<String>>>>,
    /// Inbound frame sink for sidecar-initiated requests/notifications.
    /// `commands::plugin_load_vscode` wires this to a Tauri event emitter.
    pub notify_tx: Arc<Mutex<Option<mpsc::UnboundedSender<InboundFrame>>>>,
    /// The extension's persisted `globalState` / `workspaceState`, set at
    /// activation. `memento:write` notifications are applied here and never
    /// reach the renderer.
    pub mementos: Arc<Mutex<Option<super::memento::ExtensionMementos>>>,
    /// Asks the waiter task (which owns the child) to kill it.
    kill_tx: Mutex<Option<oneshot::Sender<()>>>,
    /// How the process ended, once it has.
    exit_rx: watch::Receiver<Option<SidecarExit>>,
}

/// How a sidecar process ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarExit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    /// Killed by the host (unload, replacement), not a crash.
    pub intentional: bool,
}

/// Longest stderr line forwarded to the renderer; the rest is cut.
pub const MAX_STDERR_LINE: usize = 4096;

/// A JSON-RPC notification the host itself originates on the renderer channel.
fn host_notification(method: &str, params: serde_json::Value) -> String {
    serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string()
}

fn forward(
    notify: &Arc<Mutex<Option<mpsc::UnboundedSender<InboundFrame>>>>,
    extension_id: &str,
    raw_frame: String,
) {
    if let Some(tx) = notify.lock().as_ref() {
        let _ = tx.send(InboundFrame {
            extension_id: extension_id.to_string(),
            raw_frame,
        });
    }
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    None
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
        let stderr = child.stderr.take().ok_or(SidecarError::StdioNotPiped)?;
        let mementos: Arc<Mutex<Option<super::memento::ExtensionMementos>>> =
            Arc::new(Mutex::new(None));

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
        let mementos_for_reader = mementos.clone();
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

                if parsed.get("method").and_then(|value| value.as_str()) == Some("memento:write")
                    && id_value.is_none()
                {
                    // Persisted here, never forwarded: the renderer has no
                    // part in an extension's own state.
                    let params = parsed.get("params").cloned().unwrap_or_default();
                    let mut guard = mementos_for_reader.lock();
                    match guard.as_mut() {
                        Some(mementos) => {
                            if let Err(error) = mementos.apply_write(&params) {
                                log::warn!(
                                    "VS Code extension {extension_id_for_reader} memento write refused: {error}"
                                );
                            }
                        }
                        None => log::warn!(
                            "VS Code extension {extension_id_for_reader} wrote a memento before activation"
                        ),
                    }
                    continue;
                }

                if has_method {
                    forward(&notify_for_reader, &extension_id_for_reader, line.clone());
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

        // Stderr reader: drained so a chatty extension cannot fill the pipe and
        // stall, logged, and forwarded line by line (bounded) for the
        // plugin's log stream.
        let notify_for_stderr = notify_tx.clone();
        let extension_id_for_stderr = req.extension_id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(mut line)) = lines.next_line().await {
                if line.len() > MAX_STDERR_LINE {
                    let mut cut = MAX_STDERR_LINE;
                    while !line.is_char_boundary(cut) {
                        cut -= 1;
                    }
                    line.truncate(cut);
                    line.push('…');
                }
                log::debug!("[vscode-ext {extension_id_for_stderr}] {line}");
                forward(
                    &notify_for_stderr,
                    &extension_id_for_stderr,
                    host_notification("host:stderr", serde_json::json!({ "line": line })),
                );
            }
        });

        // Waiter: owns the child, kills it on request, and reports how it
        // ended, so a crash is visible instead of a silent dead entry.
        let (kill_tx, kill_rx) = oneshot::channel::<()>();
        let (exit_tx, exit_rx) = watch::channel::<Option<SidecarExit>>(None);
        let notify_for_waiter = notify_tx.clone();
        let extension_id_for_waiter = req.extension_id.clone();
        tokio::spawn(async move {
            let (status, intentional) = tokio::select! {
                status = child.wait() => (status, false),
                _ = kill_rx => {
                    let _ = child.start_kill();
                    (child.wait().await, true)
                }
            };
            let exit = SidecarExit {
                code: status.as_ref().ok().and_then(|status| status.code()),
                signal: status.as_ref().ok().and_then(exit_signal),
                intentional,
            };
            if !intentional {
                log::warn!(
                    "VS Code extension host for {extension_id_for_waiter} exited: code {:?}, signal {:?}",
                    exit.code,
                    exit.signal
                );
            }
            forward(
                &notify_for_waiter,
                &extension_id_for_waiter,
                host_notification(
                    "host:exited",
                    serde_json::to_value(&exit).unwrap_or_default(),
                ),
            );
            let _ = exit_tx.send(Some(exit));
        });

        Ok(Self {
            extension_id: req.extension_id,
            extension_path: req.extension_path,
            generation: req.generation,
            pid,
            stdin_tx,
            pending,
            notify_tx,
            mementos,
            kill_tx: Mutex::new(Some(kill_tx)),
            exit_rx,
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

    /// Kill the process and wait (briefly) for it to be gone.
    pub async fn kill(&self) {
        if let Some(kill) = self.kill_tx.lock().take() {
            let _ = kill.send(());
        }
        let mut exit = self.exit_rx.clone();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            exit.wait_for(|exit| exit.is_some()),
        )
        .await;
    }

    /// How the process ended, or `None` while it runs.
    pub fn exit(&self) -> Option<SidecarExit> {
        self.exit_rx.borrow().clone()
    }

    /// Resolves when the process ends, however it ends.
    pub async fn exited(&self) -> SidecarExit {
        let mut exit = self.exit_rx.clone();
        let ended = exit
            .wait_for(|exit| exit.is_some())
            .await
            .ok()
            .and_then(|exit| exit.clone());
        ended.unwrap_or(SidecarExit {
            code: None,
            signal: None,
            intentional: false,
        })
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        // Dropping the handle (e.g. during shutdown) kills the child: the
        // waiter does it on this signal, and `kill_on_drop` covers a waiter
        // that is itself gone with its runtime.
        if let Some(kill) = self.kill_tx.lock().take() {
            let _ = kill.send(());
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
            generation: "test-generation".to_string(),
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
