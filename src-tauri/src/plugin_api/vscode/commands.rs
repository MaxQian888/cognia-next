//! Tauri commands for the VS Code extension host.
//!
//! These are the entry points the renderer-side
//! `lib/plugin/core/vscode-loader.ts` invokes:
//!
//! - `plugin_vscode_install_vsix(vsix_base64)` → InstallResult
//! - `plugin_load_vscode(plugin_id, manifest_json, plugin_path)`
//! - `plugin_activate_vscode(plugin_id, config_json)`
//! - `plugin_deactivate_vscode(plugin_id)`
//! - `plugin_unload_vscode(plugin_id)`
//! - `plugin_invoke_vscode_rpc(plugin_id, method, payload_json)`
//! - `plugin_vscode_send_response(plugin_id, response_json)` —— sends a
//!   renderer-built response frame back to a sidecar-initiated request.
//!
//! All commands run on the Tauri main thread; sidecar interactions are
//! `async` and resolve when the corresponding JSON-RPC frame returns.
//!
//! Parameters use the same flat camelCase-on-the-wire convention the
//! `wasm` plugin commands use: each `plugin_id: String` Rust param maps
//! to a `pluginId` JS-side key automatically (Tauri does the case
//! conversion at the command boundary).
//!
//! `plugin_load_vscode` wires the sidecar's inbound notification/request
//! frames to a Tauri event named `vscode://rpc/<extension_id>` so the
//! renderer's RPC dispatcher can listen and either fire notification
//! handlers or build responses (sent back via `plugin_vscode_send_response`).
//!
//! `dead_code` is silenced module-wide: every command in this file IS
//! registered in `tauri::generate_handler!` (see `src/lib.rs`), but the
//! macro hides its callsites from rustc's dead-code analyser.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

use super::host::{InboundFrame, Sidecar, SpawnRequest};
use super::installer::{install_vsix, InstallError, InstallResult};
use super::VscodeExtensionState;

/// Wall-clock cap on any single sidecar request. 30s matches the VS Code
/// extension activation budget that real extensions assume.
const RPC_TIMEOUT: Duration = Duration::from_secs(30);

/// Monotonic id source for every outbound JSON-RPC frame so renderer-side
/// pending maps never collide.
static RPC_ID_COUNTER: AtomicI64 = AtomicI64::new(100);

fn next_rpc_id() -> i64 {
    RPC_ID_COUNTER.fetch_add(1, Ordering::Relaxed)
}

fn inbound_event_name(extension_id: &str) -> String {
    format!("vscode://rpc/{}", extension_id)
}

#[derive(Debug, Serialize)]
pub struct VscodeCommandError {
    pub code: String,
    pub message: String,
    /// Whether retrying the same call may succeed. Additive on the wire —
    /// aligns this envelope with `crate::command_error::CommandError` so
    /// `lib/tauri/command-error.ts` `parseInvokeError` decodes both.
    pub retryable: bool,
}

impl VscodeCommandError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            retryable: false,
        }
    }
}

impl From<InstallError> for VscodeCommandError {
    fn from(value: InstallError) -> Self {
        VscodeCommandError::new("install_error", value.to_string())
    }
}

#[tauri::command]
pub async fn plugin_vscode_install_vsix(
    vsix_base64: String,
    state: State<'_, VscodeExtensionState>,
) -> Result<InstallResult, VscodeCommandError> {
    let payload = base64::engine::general_purpose::STANDARD
        .decode(&vsix_base64)
        .map_err(|e| VscodeCommandError::new("decode_error", e.to_string()))?;
    let install_root = state.extension_install_dir.clone();
    let result = install_vsix(&payload, &install_root)?;
    Ok(result)
}

#[tauri::command]
pub async fn plugin_load_vscode(
    plugin_id: String,
    manifest_json: String,
    plugin_path: String,
    sidecar_script: Option<String>,
    node_binary: Option<String>,
    app_handle: AppHandle,
    state: State<'_, VscodeExtensionState>,
) -> Result<(), VscodeCommandError> {
    let manifest: serde_json::Value = serde_json::from_str(&manifest_json)
        .map_err(|e| VscodeCommandError::new("bad_manifest", e.to_string()))?;
    let main = manifest
        .get("vscodeMain")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            VscodeCommandError::new(
                "missing_main",
                "manifest.vscodeMain is required to load a VS Code extension",
            )
        })?;
    let request = SpawnRequest {
        extension_id: plugin_id.clone(),
        extension_path: PathBuf::from(&plugin_path)
            .join(main)
            .to_string_lossy()
            .to_string(),
        node_binary,
        sidecar_script,
    };
    let sidecar = Sidecar::spawn(request)
        .await
        .map_err(|e| VscodeCommandError::new("spawn_failed", e.to_string()))?;

    // Wire the sidecar's inbound (notification + request) channel to a
    // Tauri event so the renderer's RPC dispatcher can listen to it.
    let (notify_tx, mut notify_rx) = mpsc::unbounded_channel::<InboundFrame>();
    sidecar.set_notify_sink(notify_tx);
    let app_for_emit = app_handle.clone();
    let event_name = inbound_event_name(&plugin_id);
    tokio::spawn(async move {
        while let Some(frame) = notify_rx.recv().await {
            let _ = app_for_emit.emit(&event_name, frame.raw_frame);
        }
    });

    state.sidecars.write().insert(plugin_id, sidecar);
    Ok(())
}

/// Fixed sidecar key for the system LSP host. MUST equal the renderer's
/// `LSP_TAURI_CHANNEL_ID` (`lib/plugin/lsp/lsp-client-adapter-tauri.ts`) —
/// the editor-side `TauriLspClientAdapter` addresses every `lsp:*` RPC to
/// this key, so a mismatch silently reverts the LSP UI to `not_loaded`.
pub const LSP_HOST_KEY: &str = "cognia.lsp-service";

/// Pure join to the bundled headless host entry, factored out so it is
/// unit-testable without an `AppHandle`.
fn lsp_host_script_path(sidecar_dir: &Path) -> PathBuf {
    sidecar_dir
        .join("vscode-ext-host")
        .join("dist")
        .join("host.js")
}

/// Resolve the absolute path to `sidecar/vscode-ext-host/dist/host.js` in
/// both dev and release builds. Reuses `claude::sidecar::sidecar_dir`, which
/// already handles the resource-dir (release) vs manifest-walk (dev) split.
fn resolve_lsp_host_script(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::claude::sidecar::sidecar_dir(app)?;
    let candidate = lsp_host_script_path(&dir);
    if candidate.exists() {
        return Ok(candidate);
    }
    Err(format!(
        "vscode-ext-host script not found at {}",
        candidate.display()
    ))
}

/// Spawn (once) the headless VS Code extension host that serves the editor's
/// `lsp:*` RPCs, registered under [`LSP_HOST_KEY`]. Idempotent: a no-op while
/// a sidecar already exists for that key. Unlike `plugin_load_vscode` this
/// loads NO extension — `host.ts` builds its `LspService` lazily on the first
/// `lsp:*` frame with no activation handshake, so `extension_path` is unused
/// at boot. Without this, `plugin_invoke_vscode_rpc(LSP_HOST_KEY, …)` returns
/// `not_loaded` and the whole editor LSP data plane stays dormant.
#[tauri::command]
pub async fn ensure_system_lsp_host(
    app_handle: AppHandle,
    state: State<'_, VscodeExtensionState>,
) -> Result<(), VscodeCommandError> {
    // Fast idempotent path — the host outlives route changes for the session.
    if state.sidecars.read().contains_key(LSP_HOST_KEY) {
        return Ok(());
    }

    let script = resolve_lsp_host_script(&app_handle)
        .map_err(|e| VscodeCommandError::new("lsp_host_script_missing", e))?;
    let script_str = script.to_string_lossy().to_string();

    let sidecar = Sidecar::spawn(SpawnRequest {
        extension_id: LSP_HOST_KEY.to_string(),
        // host.ts never reads extension_path/COGNIA_VSCODE_EXTENSION_PATH at
        // boot; pass the script path itself so the arg is non-empty/valid.
        extension_path: script_str.clone(),
        node_binary: None,
        sidecar_script: Some(script_str),
    })
    .await
    .map_err(|e| VscodeCommandError::new("lsp_host_spawn_failed", e.to_string()))?;

    // Wire the sidecar's inbound notification/request frames to the Tauri
    // event the renderer's RPC dispatcher listens on for this channel
    // (`vscode://rpc/cognia.lsp-service`) — mirrors `plugin_load_vscode`.
    let (notify_tx, mut notify_rx) = mpsc::unbounded_channel::<InboundFrame>();
    sidecar.set_notify_sink(notify_tx);
    let app_for_emit = app_handle.clone();
    let event_name = inbound_event_name(LSP_HOST_KEY);
    tokio::spawn(async move {
        while let Some(frame) = notify_rx.recv().await {
            let _ = app_for_emit.emit(&event_name, frame.raw_frame);
        }
    });

    // Re-check under the write lock: another caller may have spawned + inserted
    // while we were `.await`ing the spawn. If so, drop our sidecar (its `Drop`
    // start_kills the orphan child — no `.await` held under the lock).
    let mut sidecars = state.sidecars.write();
    if !sidecars.contains_key(LSP_HOST_KEY) {
        sidecars.insert(LSP_HOST_KEY.to_string(), sidecar);
    }
    Ok(())
}

#[derive(Debug, Serialize, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateResult {
    pub sidecar_pid: u32,
    pub registered_commands: Vec<String>,
    pub registered_webview_views: Vec<String>,
    pub registered_language_providers: Vec<String>,
}

#[tauri::command]
pub async fn plugin_activate_vscode(
    plugin_id: String,
    config_json: String,
    state: State<'_, VscodeExtensionState>,
) -> Result<ActivateResult, VscodeCommandError> {
    // Snapshot what we need so we don't hold the read lock across the
    // await point.
    let (pid, rx, pending_drop) = {
        let sidecars = state.sidecars.read();
        let sidecar = sidecars
            .get(&plugin_id)
            .ok_or_else(|| VscodeCommandError::new("not_loaded", "extension not loaded"))?;
        let id = next_rpc_id();
        let rx = sidecar.register_pending(id);
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "extension:activate",
            "params": {
                "extensionId": plugin_id,
                "globalStorageUri": format!("file://{}", state.extension_dir(&plugin_id).display()),
                "storageUri": format!("file://{}", state.extension_dir(&plugin_id).display()),
                "logUri": format!("file://{}", state.extension_dir(&plugin_id).display()),
                "extensionMode": "production",
                "initialGlobalState": {},
                "initialWorkspaceState": {},
                "config": serde_json::from_str::<serde_json::Value>(&config_json).unwrap_or(serde_json::Value::Null),
            },
        })
        .to_string();
        sidecar
            .send(&frame)
            .map_err(|e| VscodeCommandError::new("send_failed", e.to_string()))?;
        (sidecar.pid, rx, (sidecar.pending.clone(), id))
    };

    let response_text = match tokio::time::timeout(RPC_TIMEOUT, rx).await {
        Ok(Ok(text)) => text,
        Ok(Err(_)) => {
            return Err(VscodeCommandError::new(
                "sidecar_dropped",
                "activate response receiver dropped",
            ));
        }
        Err(_) => {
            pending_drop.0.lock().remove(&pending_drop.1);
            return Err(VscodeCommandError::new(
                "timeout",
                "activate timed out after 30s",
            ));
        }
    };

    let response: serde_json::Value = serde_json::from_str(&response_text)
        .map_err(|e| VscodeCommandError::new("bad_response", e.to_string()))?;
    if let Some(err) = response.get("error") {
        return Err(VscodeCommandError::new("sidecar_error", err.to_string()));
    }
    let result = response
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    Ok(ActivateResult {
        sidecar_pid: pid,
        registered_commands: extract_string_array(&result, "registeredCommands"),
        registered_webview_views: extract_string_array(&result, "registeredWebviewViews"),
        registered_language_providers: extract_string_array(&result, "registeredLanguageProviders"),
    })
}

fn extract_string_array(value: &serde_json::Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn plugin_deactivate_vscode(
    plugin_id: String,
    state: State<'_, VscodeExtensionState>,
) -> Result<(), VscodeCommandError> {
    let sidecars = state.sidecars.read();
    if let Some(sidecar) = sidecars.get(&plugin_id) {
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "id": next_rpc_id(),
            "method": "extension:deactivate",
            "params": { "extensionId": plugin_id },
        })
        .to_string();
        sidecar
            .send(&frame)
            .map_err(|e| VscodeCommandError::new("send_failed", e.to_string()))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn plugin_unload_vscode(
    plugin_id: String,
    state: State<'_, VscodeExtensionState>,
) -> Result<(), VscodeCommandError> {
    // Release the write lock before awaiting — tokio::process::Child is
    // not Send so holding the lock across .kill().await trips Tauri's
    // command-future-must-be-Send constraint.
    let sidecar = {
        let mut sidecars = state.sidecars.write();
        sidecars.remove(&plugin_id)
    };
    if let Some(sidecar) = sidecar {
        sidecar.kill().await;
    }
    state.runtimes.write().remove(&plugin_id);
    Ok(())
}

#[tauri::command]
pub async fn plugin_invoke_vscode_rpc(
    plugin_id: String,
    method: String,
    payload_json: String,
    state: State<'_, VscodeExtensionState>,
) -> Result<String, VscodeCommandError> {
    let (rx, pending_drop) = {
        let sidecars = state.sidecars.read();
        let sidecar = sidecars
            .get(&plugin_id)
            .ok_or_else(|| VscodeCommandError::new("not_loaded", "extension not loaded"))?;
        let id = next_rpc_id();
        let rx = sidecar.register_pending(id);
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": serde_json::from_str::<serde_json::Value>(&payload_json)
                .unwrap_or(serde_json::Value::Null),
        })
        .to_string();
        sidecar
            .send(&frame)
            .map_err(|e| VscodeCommandError::new("send_failed", e.to_string()))?;
        (rx, (sidecar.pending.clone(), id))
    };

    let response_text = match tokio::time::timeout(RPC_TIMEOUT, rx).await {
        Ok(Ok(text)) => text,
        Ok(Err(_)) => {
            return Err(VscodeCommandError::new(
                "sidecar_dropped",
                "rpc response receiver dropped",
            ));
        }
        Err(_) => {
            pending_drop.0.lock().remove(&pending_drop.1);
            return Err(VscodeCommandError::new(
                "timeout",
                "rpc timed out after 30s",
            ));
        }
    };

    let response: serde_json::Value = serde_json::from_str(&response_text)
        .map_err(|e| VscodeCommandError::new("bad_response", e.to_string()))?;
    if let Some(err) = response.get("error") {
        return Err(VscodeCommandError::new("sidecar_error", err.to_string()));
    }
    Ok(response
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null)
        .to_string())
}

#[tauri::command]
pub async fn plugin_vscode_send_response(
    plugin_id: String,
    response_json: String,
    state: State<'_, VscodeExtensionState>,
) -> Result<(), VscodeCommandError> {
    let sidecars = state.sidecars.read();
    let sidecar = sidecars
        .get(&plugin_id)
        .ok_or_else(|| VscodeCommandError::new("not_loaded", "extension not loaded"))?;
    // Sanity-check the frame parses as JSON; the sidecar reads
    // line-delimited JSON so a malformed frame would desync the parser.
    serde_json::from_str::<serde_json::Value>(&response_json)
        .map_err(|e| VscodeCommandError::new("bad_response", e.to_string()))?;
    sidecar
        .send(&response_json)
        .map_err(|e| VscodeCommandError::new("send_failed", e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_helpers_round_trip() {
        let err = VscodeCommandError::new("test", "boom");
        assert_eq!(err.code, "test");
        let from_install: VscodeCommandError = InstallError::MissingField("name").into();
        assert_eq!(from_install.code, "install_error");
    }

    #[test]
    fn extract_string_array_handles_missing_and_typed_input() {
        let payload = serde_json::json!({
            "registeredCommands": ["hello.world", "foo.bar"],
            "registeredWebviewViews": [],
        });
        assert_eq!(
            extract_string_array(&payload, "registeredCommands"),
            vec!["hello.world".to_string(), "foo.bar".to_string()]
        );
        assert!(extract_string_array(&payload, "registeredWebviewViews").is_empty());
        assert!(extract_string_array(&payload, "missing").is_empty());
        let mixed = serde_json::json!({ "x": ["ok", 42, null, "two"] });
        assert_eq!(
            extract_string_array(&mixed, "x"),
            vec!["ok".to_string(), "two".to_string()]
        );
    }

    #[test]
    fn inbound_event_name_is_namespaced_per_extension() {
        assert_eq!(
            inbound_event_name("publisher.ext"),
            "vscode://rpc/publisher.ext".to_string()
        );
    }

    #[test]
    fn lsp_host_key_matches_renderer_channel_id() {
        // Pins the Rust↔TS contract: `LSP_TAURI_CHANNEL_ID` in
        // lib/plugin/lsp/lsp-client-adapter-tauri.ts. A drift here reverts the
        // editor LSP UI to `not_loaded` with no other failure signal.
        assert_eq!(LSP_HOST_KEY, "cognia.lsp-service");
    }

    #[test]
    fn lsp_host_script_path_targets_bundled_host_js() {
        let path = lsp_host_script_path(Path::new("/x/sidecar"));
        assert!(path.ends_with("vscode-ext-host/dist/host.js"), "{path:?}");
    }

    #[test]
    fn lsp_host_inbound_event_name_is_the_system_channel() {
        assert_eq!(
            inbound_event_name(LSP_HOST_KEY),
            "vscode://rpc/cognia.lsp-service".to_string()
        );
    }

    #[test]
    fn fresh_state_has_no_lsp_host_so_ensure_would_spawn() {
        // Documents the idempotent-branch precondition without a live child:
        // a fresh state does not yet hold the system host key.
        let state = VscodeExtensionState::new(PathBuf::from("/tmp"));
        assert!(!state.sidecars.read().contains_key(LSP_HOST_KEY));
    }

    #[test]
    fn next_rpc_id_is_monotonic() {
        let a = next_rpc_id();
        let b = next_rpc_id();
        let c = next_rpc_id();
        assert!(b > a);
        assert!(c > b);
    }

    #[test]
    fn activate_result_serializes_camel_case() {
        let payload = ActivateResult {
            sidecar_pid: 7,
            registered_commands: vec!["x".to_string()],
            registered_webview_views: vec![],
            registered_language_providers: vec![],
        };
        let serialized = serde_json::to_value(&payload).unwrap();
        assert!(serialized.get("sidecarPid").is_some());
        assert!(serialized.get("registeredCommands").is_some());
        assert!(serialized.get("registeredLanguageProviders").is_some());
    }
}
