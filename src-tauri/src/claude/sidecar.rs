use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

use crate::api_key::ApiKeyState;
use crate::hooks;

/// Tauri event channel name. The frontend subscribes via
/// `listen("claude://message", ...)`.
pub const SIDECAR_EVENT: &str = "claude://message";

/// Dedicated event channel for A2UI dispatches (createSurface,
/// updateComponents, dataModelUpdate, deleteSurface). Kept separate from
/// `SIDECAR_EVENT` so the a2ui store can subscribe without sifting through
/// every sidecar message.
pub const A2UI_EVENT: &str = "a2ui://dispatch";

/// Shared, mutable state. Cloned cheaply via `Arc`.
#[derive(Clone, Default)]
pub struct SidecarState {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    ready: bool,
}

impl SidecarState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Send one JSON-line command to the running sidecar.
    pub async fn write_command(&self, msg: &Value) -> Result<(), String> {
        let line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        let mut guard = self.inner.lock().await;
        let stdin = guard
            .stdin
            .as_mut()
            .ok_or_else(|| "sidecar not running".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn is_ready(&self) -> bool {
        self.inner.lock().await.ready
    }
}

/// Resolve the absolute path to the bundled `sidecar/` directory in both
/// dev and release builds. Used by:
///   - `resolve_sidecar_script` to locate `claude-host.mjs`
///   - `a2ui_bridge::commands::a2ui_bridge_runtime_paths` so external-agent
///     MCP configs can spawn `node ${sidecarDir}/a2ui-mcp.mjs` with an
///     absolute argv.
pub fn sidecar_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // Release: bundled resources directory.
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("sidecar");
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    // Dev: walk up from the Cargo manifest dir to the repo root.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidate = manifest
        .parent()
        .map(|p| p.join("sidecar"))
        .ok_or_else(|| "could not locate project root".to_string())?;
    if candidate.exists() {
        return Ok(candidate);
    }
    Err(format!(
        "sidecar directory not found at {}",
        candidate.display()
    ))
}

/// Resolve the absolute path to `sidecar/claude-host.mjs`, in both dev and
/// release builds.
fn resolve_sidecar_script(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = sidecar_dir(app)?;
    let candidate = dir.join("claude-host.mjs");
    if candidate.exists() {
        return Ok(candidate);
    }
    Err(format!(
        "sidecar script not found at {}",
        candidate.display()
    ))
}

/// Spawn the Node sidecar and start pumping its stdout into Tauri events.
///
/// Safe to call multiple times — subsequent calls become no-ops while the
/// child is alive.
pub async fn spawn(app: AppHandle, state: SidecarState) -> Result<(), String> {
    {
        let guard = state.inner.lock().await;
        if guard.child.is_some() {
            return Ok(());
        }
    }

    let script = resolve_sidecar_script(&app)?;
    let cwd = script
        .parent()
        .ok_or_else(|| "sidecar script has no parent dir".to_string())?
        .to_path_buf();

    // On Windows, `node` is typically `node.exe` and discoverable via PATH.
    let mut cmd = Command::new("node");
    cmd.arg(&script)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Inject the user-supplied Anthropic API key, if any. The sidecar reads
    // `process.env.ANTHROPIC_API_KEY` and forwards it to the SDK.
    if let Some(api_key_state) = app.try_state::<ApiKeyState>() {
        if let Some(key) = api_key_state.get().await {
            cmd.env("ANTHROPIC_API_KEY", key);
        }
    }

    // On Windows, prevent a console window from popping up when the parent app
    // has no console (e.g. a release build). tokio::process::Command exposes
    // `creation_flags` directly on Windows, so no extra import is needed.
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar (is Node >= 20 on PATH?): {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "child has no stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "child has no stderr".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "child has no stdin".to_string())?;

    {
        let mut guard = state.inner.lock().await;
        guard.child = Some(child);
        guard.stdin = Some(stdin);
        guard.ready = false;
    }

    // Pipe stdout: each line is one JSON event we forward to the frontend.
    {
        let app = app.clone();
        let state = state.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            loop {
                match reader.next_line().await {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Value>(trimmed) {
                            Ok(value) => {
                                // Track the sidecar's "ready" announcement so we can short-circuit
                                // status checks before it has fully booted.
                                if value.get("type").and_then(|t| t.as_str()) == Some("ready") {
                                    state.inner.lock().await.ready = true;
                                }
                                // PreToolUse hook: when the sidecar emits a permission_request
                                // we may need to short-circuit it with an automatic deny.
                                // Spawn the hook eval as a task so the reader keeps draining
                                // — concurrent permission_request events are evaluated in
                                // parallel.
                                if value.get("type").and_then(|t| t.as_str())
                                    == Some("permission_request")
                                {
                                    let app = app.clone();
                                    let state = state.clone();
                                    tokio::spawn(async move {
                                        handle_permission_request(app, state, value).await;
                                    });
                                    continue;
                                }
                                // A2UI bridge dispatches go on a dedicated channel so the
                                // a2ui store can listen without filtering every sidecar event.
                                if value.get("type").and_then(|t| t.as_str())
                                    == Some("a2ui_dispatch")
                                {
                                    if let Err(e) = app.emit(A2UI_EVENT, &value) {
                                        log::error!("failed to emit a2ui dispatch: {e}");
                                    }
                                    continue;
                                }
                                if let Err(e) = app.emit(SIDECAR_EVENT, &value) {
                                    log::error!("failed to emit sidecar event: {e}");
                                }
                            }
                            Err(e) => {
                                log::warn!("sidecar emitted non-JSON line: {e}: {trimmed}");
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        log::error!("sidecar stdout read error: {e}");
                        break;
                    }
                }
            }
            // The sidecar exited. Clear state so the next command tries to respawn.
            let mut guard = state.inner.lock().await;
            guard.child = None;
            guard.stdin = None;
            guard.ready = false;
            log::warn!("sidecar process ended");
            let _ = app.emit(
                SIDECAR_EVENT,
                serde_json::json!({ "type": "sidecar_exited" }),
            );
        });
    }

    // Forward stderr to the parent log so users can debug install issues.
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            log::warn!("[sidecar.stderr] {line}");
        }
    });

    Ok(())
}

/// Run PreToolUse hooks against a `permission_request` event from the
/// sidecar. If any hook blocks, write a `permission_response` (deny) back to
/// the sidecar without involving the frontend. Otherwise forward the event
/// onward as usual so the user / approval store handles it.
async fn handle_permission_request(app: AppHandle, state: SidecarState, value: Value) {
    let session_id = value
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_default();
    let request_id = value
        .get("requestId")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_default();
    let tool_name = value
        .get("toolName")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_default();
    let input = value.get("input").cloned().unwrap_or(Value::Null);

    // Hook config: read fresh per request so the user can edit settings without
    // restarting the sidecar. Read is cheap (one or two small JSON files).
    let cwd: Option<String> = None; // user-scope only; project hooks land with workspace trust.
    let settings = hooks::load_effective_settings(cwd.as_deref());
    let decision =
        hooks::run_pre_tool_use(&settings, &session_id, cwd.as_deref(), &tool_name, &input).await;

    for w in &decision.warnings {
        log::warn!("PreToolUse[{tool_name}]: {w}");
    }

    if let Some(reason) = decision.block {
        let payload = json!({
          "type": "permission_response",
          "sessionId": session_id,
          "requestId": request_id,
          "decision": "deny",
          "message": format!("hook denied: {reason}"),
        });
        if let Err(e) = state.write_command(&payload).await {
            log::error!("failed to write hook deny: {e}");
        }
        // Emit a compact log to the frontend so the user sees that a tool was
        // blocked silently — they would otherwise see no UI at all.
        let _ = app.emit(
            SIDECAR_EVENT,
            &json!({
              "type": "log",
              "level": "info",
              "message": format!("PreToolUse hook denied {tool_name}: {reason}"),
            }),
        );
        return;
    }

    // No block — forward to the frontend so the normal approval flow can run.
    if let Err(e) = app.emit(SIDECAR_EVENT, &value) {
        log::error!("failed to emit permission_request: {e}");
    }
}

/// Stop the running sidecar (drop stdin, kill the child). The next
/// `claude_send` will respawn it. Safe to call when no sidecar is running.
pub async fn kill_sidecar(state: SidecarState) {
    let mut guard = state.inner.lock().await;
    // Closing stdin first lets the sidecar exit cleanly (its stdin EOF handler
    // tears down active sessions). If that doesn't work, kill_on_drop handles
    // the rest when we drop the Child below.
    guard.stdin.take();
    if let Some(mut child) = guard.child.take() {
        if let Err(e) = child.start_kill() {
            log::warn!("kill sidecar failed: {e}");
        }
        // Don't wait — the stdout reader task will observe EOF and clean up.
    }
    guard.ready = false;
}
