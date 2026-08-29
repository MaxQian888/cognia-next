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
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

use super::host::{InboundFrame, Sidecar, SpawnRequest};
use super::installer::{install_vsix, InstallError, InstallResult};
use super::VscodeExtensionState;
use crate::PluginRuntimeState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VscodeLoadResult {
    pub generation: String,
}

/// Wall-clock cap on any single sidecar request. 30s matches the VS Code
/// extension activation budget that real extensions assume.
const RPC_TIMEOUT: Duration = Duration::from_secs(30);

/// Monotonic id source for every outbound JSON-RPC frame so renderer-side
/// pending maps never collide.
static RPC_ID_COUNTER: AtomicI64 = AtomicI64::new(100);

fn next_rpc_id() -> i64 {
    RPC_ID_COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// Convert the host-owned permission ledger into the exact Node module names
/// intercepted by `sidecar/vscode-ext-host/src/require-hook.ts`.
///
/// Imports such as `fs` expose both reads and writes, so every permission in a
/// row is required. This intentionally fails closed for partial grants.
fn granted_node_modules(runtime: &PluginRuntimeState, plugin_id: &str) -> Vec<&'static str> {
    const GROUPS: &[(&[&str], &[&str])] = &[
        (
            &["filesystem:read", "filesystem:write"],
            &["fs", "fs/promises", "node:fs", "node:fs/promises"],
        ),
        (
            &["process:spawn", "shell:execute"],
            &["child_process", "node:child_process"],
        ),
        (
            &["process:spawn"],
            &["worker_threads", "node:worker_threads"],
        ),
        (
            &["network:fetch"],
            &["http", "https", "node:http", "node:https"],
        ),
        (
            &["network:websocket", "network:fetch"],
            &["net", "node:net", "tls", "node:tls", "ws"],
        ),
    ];
    GROUPS
        .iter()
        .filter(|(permissions, _)| {
            permissions
                .iter()
                .all(|permission| runtime.has_permission(plugin_id, permission))
        })
        .flat_map(|(_, modules)| modules.iter().copied())
        .collect()
}

async fn request_sidecar(
    sidecar: &Sidecar,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, VscodeCommandError> {
    let id = next_rpc_id();
    let rx = sidecar.register_pending(id);
    let frame = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
    .to_string();
    if let Err(error) = sidecar.send(&frame) {
        sidecar.drop_pending(id);
        return Err(VscodeCommandError::new("send_failed", error.to_string()));
    }

    let response_text = match tokio::time::timeout(RPC_TIMEOUT, rx).await {
        Ok(Ok(text)) => text,
        Ok(Err(_)) => {
            return Err(VscodeCommandError::new(
                "sidecar_dropped",
                format!("{method} response receiver dropped"),
            ));
        }
        Err(_) => {
            sidecar.drop_pending(id);
            return Err(VscodeCommandError::new(
                "timeout",
                format!("{method} timed out after 30s"),
            ));
        }
    };

    let response: serde_json::Value = serde_json::from_str(&response_text)
        .map_err(|error| VscodeCommandError::new("bad_response", error.to_string()))?;
    if let Some(error) = response.get("error") {
        return Err(VscodeCommandError::new("sidecar_error", error.to_string()));
    }
    Ok(response
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

/// Tauri event names accept only `[a-zA-Z0-9-/:_]` — `emit`/`listen` both
/// reject anything else. Extension ids are `publisher.name`, so the dot (and
/// any other stray char) maps to `_`. MUST stay in sync with
/// `vscodeRpcEventName` in lib/plugin/vscode-shim/rpc-dispatcher.ts, which
/// listens on the same channel.
fn inbound_event_name(extension_id: &str) -> String {
    let sanitized: String = extension_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("vscode://rpc/{sanitized}")
}

#[derive(Debug, Serialize)]
pub struct VscodeCommandError {
    pub code: String,
    pub message: String,
    /// Whether retrying the same call may succeed. Additive on the wire —
    /// aligns this envelope with `cognia_core::command_error::CommandError` so
    /// `lib/tauri/command-error.ts` `parseInvokeError` decodes both.
    pub retryable: bool,
}

impl VscodeCommandError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
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

fn stale_generation(plugin_id: &str, generation: &str) -> VscodeCommandError {
    VscodeCommandError::new(
        "stale_generation",
        format!("stale VS Code runtime generation for {plugin_id}: {generation}"),
    )
}

fn current_generation(
    state: &VscodeExtensionState,
    plugin_id: &str,
) -> Result<String, VscodeCommandError> {
    state
        .sidecars
        .read()
        .get(plugin_id)
        .map(|sidecar| sidecar.generation.clone())
        .ok_or_else(|| VscodeCommandError::new("not_loaded", "extension not loaded"))
}

fn sidecar_for_generation(
    state: &VscodeExtensionState,
    plugin_id: &str,
    generation: &str,
) -> Result<Arc<Sidecar>, VscodeCommandError> {
    let sidecar = state
        .sidecars
        .read()
        .get(plugin_id)
        .cloned()
        .ok_or_else(|| VscodeCommandError::new("not_loaded", "extension not loaded"))?;
    if sidecar.generation != generation {
        return Err(stale_generation(plugin_id, generation));
    }
    Ok(sidecar)
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

/// Install a `.vsix` already staged on disk by `plugin_vscode_download_vsix`.
///
/// This exists to skip the base64 IPC round-trip the marketplace path would
/// otherwise pay twice over: base64 inflates the payload by 33% and forces a
/// full JS string to exist alongside the Rust `Vec` — on an 80 MB extension
/// that is the difference between installing and OOMing the webview.
///
/// The bytes still went through the renderer (that's where permission
/// inference has to run); this only avoids re-encoding them to hand back.
#[tauri::command]
pub async fn plugin_vscode_install_vsix_from_path(
    temp_path: String,
    state: State<'_, VscodeExtensionState>,
) -> Result<InstallResult, VscodeCommandError> {
    install_staged_vsix(&state.extension_install_dir, Path::new(&temp_path))
}

/// Body of [`plugin_vscode_install_vsix_from_path`], minus Tauri state.
///
/// Ordering here is load-bearing: containment is proved *before* the file is
/// touched or deleted. `path` comes from the renderer, and a cleanup step that
/// ran before the check would turn this command into an arbitrary-file-delete
/// primitive.
fn install_staged_vsix(
    install_root: &Path,
    path: &Path,
) -> Result<InstallResult, VscodeCommandError> {
    ensure_staged(install_root, path)?;

    // From here the file is ours: it is single-use either way, so a failed
    // install must not leave an 80 MB orphan in app data.
    let outcome = std::fs::read(path)
        .map_err(|e| VscodeCommandError::new("read_error", e.to_string()))
        .and_then(|payload| {
            install_vsix(&payload, &install_root.to_path_buf()).map_err(Into::into)
        });
    let _ = std::fs::remove_file(path);
    outcome
}

/// Assert `path` is a file this crate itself staged — a direct child of the
/// download dir.
///
/// Both sides are canonicalized so a symlink planted in the staging dir cannot
/// point the read somewhere else. Confining the command this way means it can
/// only ever install bytes that `plugin_vscode_download_vsix` fetched and
/// checksum-verified.
fn ensure_staged(install_root: &Path, path: &Path) -> Result<(), VscodeCommandError> {
    let escaped = |detail: &str| VscodeCommandError::new("path_not_staged", detail.to_string());

    let staging = super::openvsx_download::downloads_dir(install_root)
        .canonicalize()
        .map_err(|e| escaped(&format!("no staged downloads directory: {e}")))?;
    let resolved = path
        .canonicalize()
        .map_err(|e| escaped(&format!("{}: {e}", path.display())))?;

    if resolved.parent() != Some(staging.as_path()) {
        return Err(escaped(&format!(
            "{} is not a staged download",
            path.display()
        )));
    }
    if !resolved.is_file() {
        return Err(escaped(&format!("{} is not a file", path.display())));
    }
    Ok(())
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
    runtime: State<'_, PluginRuntimeState>,
) -> Result<VscodeLoadResult, VscodeCommandError> {
    let script = match sidecar_script {
        Some(path) => PathBuf::from(path),
        None => resolve_lsp_host_script(&app_handle)
            .map_err(|error| VscodeCommandError::new("host_script_missing", error))?,
    };
    let node_binary = host_node_binary(node_binary)?;
    let app_for_events = app_handle.clone();
    state.configure_host(
        script,
        node_binary,
        Arc::new(move |event_name, raw_frame| {
            let _ = app_for_events.emit(&event_name, raw_frame);
        }),
    );
    plugin_load_vscode_for_state(
        state.inner(),
        runtime.inner(),
        plugin_id,
        manifest_json,
        plugin_path,
    )
    .await
}

fn host_node_binary(requested: Option<String>) -> Result<Option<String>, VscodeCommandError> {
    if requested.is_some() {
        log::warn!("plugin_load_vscode ignored a renderer-supplied Node.js override");
    }
    Ok(Some(
        cognia_core::node_runtime::node_executable()
            .map_err(|error| {
                VscodeCommandError::new("node_runtime_unavailable", error.to_string())
            })?
            .to_string_lossy()
            .into_owned(),
    ))
}

pub async fn plugin_load_vscode_for_state(
    state: &VscodeExtensionState,
    runtime: &PluginRuntimeState,
    plugin_id: String,
    manifest_json: String,
    plugin_path: String,
) -> Result<VscodeLoadResult, VscodeCommandError> {
    if let Some(sidecar) = state.sidecars.read().get(&plugin_id) {
        return Ok(VscodeLoadResult {
            generation: sidecar.generation.clone(),
        });
    }
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
    let bundle_format = manifest
        .pointer("/vscodeExtension/bundleFormat")
        .and_then(|value| value.as_str())
        .unwrap_or("cjs")
        .to_string();
    if !matches!(bundle_format.as_str(), "cjs" | "esm" | "mixed") {
        return Err(VscodeCommandError::new(
            "bad_bundle_format",
            format!("unsupported vscodeExtension.bundleFormat: {bundle_format}"),
        ));
    }
    let expected_root = runtime.plugin_dir(&plugin_id);
    let claimed_root = PathBuf::from(plugin_path);
    let main = main.to_string();
    let main_for_validation = main.clone();
    let extension_root = tokio::task::spawn_blocking(move || {
        let plugin_root =
            crate::contained_path::validate_claimed_plugin_root(&expected_root, &claimed_root)?;
        crate::contained_path::validate_symlink_free_tree(&plugin_root)?;
        crate::contained_path::resolve_existing_plugin_file(&plugin_root, &main_for_validation)?;
        Ok::<PathBuf, String>(plugin_root)
    })
    .await
    .map_err(|error| VscodeCommandError::new("unsafe_main", error.to_string()))?
    .map_err(|error| VscodeCommandError::new("unsafe_main", error))?;
    let sidecar_script = state.sidecar_script.read().clone().ok_or_else(|| {
        VscodeCommandError::new(
            "host_script_missing",
            "VS Code host script is not configured",
        )
    })?;
    if !sidecar_script.is_file() {
        return Err(VscodeCommandError::new(
            "host_script_missing",
            format!(
                "VS Code host script not found at {}",
                sidecar_script.display()
            ),
        ));
    }
    let event_sink = state.event_sink.read().as_ref().cloned().ok_or_else(|| {
        VscodeCommandError::new("event_sink_missing", "VS Code event sink is not configured")
    })?;
    let generation = uuid::Uuid::now_v7().to_string();
    let request = SpawnRequest {
        extension_id: plugin_id.clone(),
        extension_path: extension_root.to_string_lossy().to_string(),
        generation: generation.clone(),
        node_binary: state.node_binary.read().clone(),
        sidecar_script: Some(sidecar_script.to_string_lossy().to_string()),
    };
    let sidecar = Sidecar::spawn(request)
        .await
        .map_err(|e| VscodeCommandError::new("spawn_failed", e.to_string()))?;
    let granted_modules = granted_node_modules(runtime, &plugin_id);

    // Wire sidecar requests/notifications to the host-neutral event bus before
    // sending the load request. The initial `sidecar:ready` notification may
    // race this installation, but it is informational; every extension RPC is
    // emitted after `extension:load` begins.
    let (notify_tx, mut notify_rx) = mpsc::unbounded_channel::<InboundFrame>();
    sidecar.set_notify_sink(notify_tx);
    let event_name = inbound_event_name(&plugin_id);
    let event_generation = generation.clone();
    tokio::spawn(async move {
        while let Some(frame) = notify_rx.recv().await {
            let payload = serde_json::json!({
                "generation": event_generation,
                "rawFrame": frame.raw_frame,
            })
            .to_string();
            event_sink(event_name.clone(), payload);
        }
    });

    if let Err(error) = request_sidecar(
        &sidecar,
        "extension:load",
        serde_json::json!({
            "extensionId": plugin_id,
            "extensionPath": extension_root,
            "main": main,
            "bundleFormat": bundle_format,
            "grantedModules": granted_modules,
        }),
    )
    .await
    {
        sidecar.kill().await;
        return Err(error);
    }

    let sidecar = Arc::new(sidecar);
    let (published_generation, inserted) = {
        let mut sidecars = state.sidecars.write();
        if let Some(existing) = sidecars.get(&plugin_id) {
            (existing.generation.clone(), false)
        } else {
            sidecars.insert(plugin_id, Arc::clone(&sidecar));
            (generation, true)
        }
    };
    if !inserted {
        sidecar.kill().await;
    }
    Ok(VscodeLoadResult {
        generation: published_generation,
    })
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

/// ADR-0067 Tier-B inversion: the sidecar-directory resolver lives app-side
/// in `claude::sidecar` (it owns the resource-dir vs manifest-walk split).
/// The app shell registers it at startup, before any `plugin_load_vscode` /
/// LSP-host spawn can run.
static SIDECAR_DIR_RESOLVER: std::sync::OnceLock<fn(&AppHandle) -> Result<PathBuf, String>> =
    std::sync::OnceLock::new();

/// Register the app-side sidecar-directory resolver. First registration wins;
/// later calls are no-ops.
pub fn set_sidecar_dir_resolver(resolver: fn(&AppHandle) -> Result<PathBuf, String>) {
    let _ = SIDECAR_DIR_RESOLVER.set(resolver);
}

/// Resolve the absolute path to `sidecar/vscode-ext-host/dist/host.js` in
/// both dev and release builds. Delegates to the registered app-side
/// resolver (`claude::sidecar::sidecar_dir`), which already handles the
/// resource-dir (release) vs manifest-walk (dev) split.
fn resolve_lsp_host_script(app: &AppHandle) -> Result<PathBuf, String> {
    let resolver = SIDECAR_DIR_RESOLVER
        .get()
        .ok_or_else(|| "sidecar dir resolver not registered".to_string())?;
    let dir = resolver(app)?;
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
    let script = resolve_lsp_host_script(&app_handle)
        .map_err(|e| VscodeCommandError::new("lsp_host_script_missing", e))?;
    let app_for_events = app_handle.clone();
    state.configure_host(
        script,
        None,
        Arc::new(move |event_name, raw_frame| {
            let _ = app_for_events.emit(&event_name, raw_frame);
        }),
    );
    ensure_system_lsp_host_for_state(state.inner()).await
}

/// Host-neutral system-LSP bootstrap shared by Tauri and `cognia-server`.
/// The owning shell configures the sidecar script and event sink on
/// [`VscodeExtensionState`] before calling this function.
pub async fn ensure_system_lsp_host_for_state(
    state: &VscodeExtensionState,
) -> Result<(), VscodeCommandError> {
    // Fast idempotent path — the host outlives route changes for the session.
    if state.sidecars.read().contains_key(LSP_HOST_KEY) {
        return Ok(());
    }
    let script = state.sidecar_script.read().clone().ok_or_else(|| {
        VscodeCommandError::new(
            "lsp_host_script_missing",
            "VS Code/LSP host script is not configured",
        )
    })?;
    if !script.is_file() {
        return Err(VscodeCommandError::new(
            "lsp_host_script_missing",
            format!("VS Code/LSP host script not found at {}", script.display()),
        ));
    }
    let event_sink = state.event_sink.read().as_ref().cloned().ok_or_else(|| {
        VscodeCommandError::new(
            "event_sink_missing",
            "VS Code/LSP event sink is not configured",
        )
    })?;
    let script_str = script.to_string_lossy().to_string();
    let node_binary = state.node_binary.read().clone();

    let sidecar = Sidecar::spawn(SpawnRequest {
        extension_id: LSP_HOST_KEY.to_string(),
        // host.ts never reads extension_path/COGNIA_VSCODE_EXTENSION_PATH at
        // boot; pass the script path itself so the arg is non-empty/valid.
        extension_path: script_str.clone(),
        generation: "system".to_string(),
        node_binary,
        sidecar_script: Some(script_str),
    })
    .await
    .map_err(|e| VscodeCommandError::new("lsp_host_spawn_failed", e.to_string()))?;

    // Wire the sidecar's inbound notification/request frames to the Tauri
    // event the renderer's RPC dispatcher listens on for this channel
    // (`vscode://rpc/cognia.lsp-service`) — mirrors `plugin_load_vscode`.
    let (notify_tx, mut notify_rx) = mpsc::unbounded_channel::<InboundFrame>();
    sidecar.set_notify_sink(notify_tx);
    let event_name = inbound_event_name(LSP_HOST_KEY);
    tokio::spawn(async move {
        while let Some(frame) = notify_rx.recv().await {
            let payload = serde_json::json!({
                "generation": "system",
                "rawFrame": frame.raw_frame,
            })
            .to_string();
            event_sink(event_name.clone(), payload);
        }
    });

    // Re-check under the write lock: another caller may have spawned + inserted
    // while we were `.await`ing the spawn. If so, drop our sidecar (its `Drop`
    // start_kills the orphan child — no `.await` held under the lock).
    let mut sidecars = state.sidecars.write();
    if !sidecars.contains_key(LSP_HOST_KEY) {
        sidecars.insert(LSP_HOST_KEY.to_string(), Arc::new(sidecar));
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
    generation: String,
    config_json: String,
    state: State<'_, VscodeExtensionState>,
) -> Result<ActivateResult, VscodeCommandError> {
    plugin_activate_vscode_generation_for_state(state.inner(), plugin_id, generation, config_json)
        .await
}

pub async fn plugin_activate_vscode_for_state(
    state: &VscodeExtensionState,
    plugin_id: String,
    config_json: String,
) -> Result<ActivateResult, VscodeCommandError> {
    let generation = current_generation(state, &plugin_id)?;
    plugin_activate_vscode_generation_for_state(state, plugin_id, generation, config_json).await
}

pub async fn plugin_activate_vscode_generation_for_state(
    state: &VscodeExtensionState,
    plugin_id: String,
    generation: String,
    config_json: String,
) -> Result<ActivateResult, VscodeCommandError> {
    let sidecar = sidecar_for_generation(state, &plugin_id, &generation)?;
    let pid = sidecar.pid;
    let result = request_sidecar(
        sidecar.as_ref(),
        "extension:activate",
        serde_json::json!({
            "extensionId": plugin_id,
            "extensionPath": sidecar.extension_path,
            "globalStorageUri": format!("file://{}", state.extension_dir(&plugin_id).display()),
            "storageUri": format!("file://{}", state.extension_dir(&plugin_id).display()),
            "logUri": format!("file://{}", state.extension_dir(&plugin_id).display()),
            "extensionMode": "production",
            "initialGlobalState": {},
            "initialWorkspaceState": {},
            "config": serde_json::from_str::<serde_json::Value>(&config_json).unwrap_or(serde_json::Value::Null),
        }),
    )
    .await?;
    let activated = ActivateResult {
        sidecar_pid: pid,
        registered_commands: extract_string_array(&result, "registeredCommands"),
        registered_webview_views: extract_string_array(&result, "registeredWebviewViews"),
        registered_language_providers: extract_string_array(&result, "registeredLanguageProviders"),
    };
    state.runtimes.write().insert(
        plugin_id.clone(),
        super::ExtensionRuntime {
            extension_id: plugin_id,
            generation,
            sidecar_pid: pid,
            last_activated_at: Some(chrono::Utc::now().timestamp_millis()),
            last_error: None,
            registered_commands: activated.registered_commands.clone(),
            registered_webview_views: activated.registered_webview_views.clone(),
            registered_language_providers: activated.registered_language_providers.clone(),
        },
    );
    Ok(activated)
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
    generation: String,
    state: State<'_, VscodeExtensionState>,
) -> Result<(), VscodeCommandError> {
    plugin_deactivate_vscode_generation_for_state(state.inner(), plugin_id, generation).await
}

pub async fn plugin_deactivate_vscode_for_state(
    state: &VscodeExtensionState,
    plugin_id: String,
) -> Result<(), VscodeCommandError> {
    let generation = current_generation(state, &plugin_id)?;
    plugin_deactivate_vscode_generation_for_state(state, plugin_id, generation).await
}

pub async fn plugin_deactivate_vscode_generation_for_state(
    state: &VscodeExtensionState,
    plugin_id: String,
    generation: String,
) -> Result<(), VscodeCommandError> {
    let sidecar = sidecar_for_generation(state, &plugin_id, &generation)?;
    request_sidecar(
        sidecar.as_ref(),
        "extension:deactivate",
        serde_json::json!({ "extensionId": plugin_id }),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn plugin_unload_vscode(
    plugin_id: String,
    generation: String,
    state: State<'_, VscodeExtensionState>,
) -> Result<(), VscodeCommandError> {
    plugin_unload_vscode_generation_for_state(state.inner(), plugin_id, generation).await
}

pub async fn plugin_unload_vscode_for_state(
    state: &VscodeExtensionState,
    plugin_id: String,
) -> Result<(), VscodeCommandError> {
    let generation = current_generation(state, &plugin_id)?;
    plugin_unload_vscode_generation_for_state(state, plugin_id, generation).await
}

pub fn plugin_vscode_list_for_state(state: &VscodeExtensionState) -> Vec<String> {
    state.sidecars.read().keys().cloned().collect()
}

pub async fn plugin_unload_vscode_generation_for_state(
    state: &VscodeExtensionState,
    plugin_id: String,
    generation: String,
) -> Result<(), VscodeCommandError> {
    // Release the write lock before awaiting — tokio::process::Child is
    // not Send so holding the lock across .kill().await trips Tauri's
    // command-future-must-be-Send constraint.
    let sidecar = {
        let mut sidecars = state.sidecars.write();
        match sidecars.get(&plugin_id) {
            Some(sidecar) if sidecar.generation == generation => sidecars.remove(&plugin_id),
            Some(_) => return Err(stale_generation(&plugin_id, &generation)),
            None => return Ok(()),
        }
    };
    if let Some(sidecar) = sidecar {
        let result = request_sidecar(
            sidecar.as_ref(),
            "extension:unload",
            serde_json::json!({ "extensionId": plugin_id }),
        )
        .await;
        sidecar.kill().await;
        state.runtimes.write().remove(&plugin_id);
        return result.map(|_| ());
    }
    state.runtimes.write().remove(&plugin_id);
    Ok(())
}

#[tauri::command]
pub async fn plugin_invoke_vscode_rpc(
    plugin_id: String,
    generation: Option<String>,
    method: String,
    payload_json: String,
    state: State<'_, VscodeExtensionState>,
) -> Result<String, VscodeCommandError> {
    if plugin_id == LSP_HOST_KEY && generation.is_none() {
        return plugin_invoke_vscode_rpc_for_state(state.inner(), plugin_id, method, payload_json)
            .await;
    }
    plugin_invoke_vscode_rpc_generation_for_state(
        state.inner(),
        plugin_id,
        generation.ok_or_else(|| {
            VscodeCommandError::new("generation_required", "runtime generation is required")
        })?,
        method,
        payload_json,
    )
    .await
}

pub async fn plugin_invoke_vscode_rpc_for_state(
    state: &VscodeExtensionState,
    plugin_id: String,
    method: String,
    payload_json: String,
) -> Result<String, VscodeCommandError> {
    let generation = current_generation(state, &plugin_id)?;
    plugin_invoke_vscode_rpc_generation_for_state(
        state,
        plugin_id,
        generation,
        method,
        payload_json,
    )
    .await
}

pub async fn plugin_invoke_vscode_rpc_generation_for_state(
    state: &VscodeExtensionState,
    plugin_id: String,
    generation: String,
    method: String,
    payload_json: String,
) -> Result<String, VscodeCommandError> {
    let sidecar = sidecar_for_generation(state, &plugin_id, &generation)?;
    request_sidecar(
        sidecar.as_ref(),
        &method,
        serde_json::from_str::<serde_json::Value>(&payload_json).unwrap_or(serde_json::Value::Null),
    )
    .await
    .map(|result| result.to_string())
}

#[tauri::command]
pub async fn plugin_vscode_send_response(
    plugin_id: String,
    generation: String,
    response_json: String,
    state: State<'_, VscodeExtensionState>,
) -> Result<(), VscodeCommandError> {
    plugin_vscode_send_response_generation_for_state(
        state.inner(),
        plugin_id,
        generation,
        response_json,
    )
}

pub fn plugin_vscode_send_response_for_state(
    state: &VscodeExtensionState,
    plugin_id: String,
    response_json: String,
) -> Result<(), VscodeCommandError> {
    let generation = current_generation(state, &plugin_id)?;
    plugin_vscode_send_response_generation_for_state(state, plugin_id, generation, response_json)
}

pub fn plugin_vscode_send_response_generation_for_state(
    state: &VscodeExtensionState,
    plugin_id: String,
    generation: String,
    response_json: String,
) -> Result<(), VscodeCommandError> {
    let sidecar = sidecar_for_generation(state, &plugin_id, &generation)?;
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
    fn renderer_cannot_override_the_host_node_runtime() {
        assert_eq!(
            host_node_binary(Some("untrusted-node".into())).expect("host runtime"),
            Some("node".into())
        );
    }

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
        // Tauri event names accept only [a-zA-Z0-9-/:_]; extension ids are
        // `publisher.name`, so the dot must be sanitized or emit() errors.
        assert_eq!(
            inbound_event_name("publisher.ext"),
            "vscode://rpc/publisher_ext".to_string()
        );
    }

    #[test]
    fn inbound_event_name_is_always_tauri_valid() {
        let name = inbound_event_name("weird id!@#.ext");
        assert!(
            name.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_')),
            "{name:?}"
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
        // Pins the Rust↔TS contract with `vscodeRpcEventName` in
        // lib/plugin/vscode-shim/rpc-dispatcher.ts.
        assert_eq!(
            inbound_event_name(LSP_HOST_KEY),
            "vscode://rpc/cognia_lsp-service".to_string()
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
    fn node_module_grants_require_every_permission_in_each_group() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = PluginRuntimeState::new(temp.path().join("plugins"));
        runtime.activate_account("acct_test").unwrap();
        let plugin_id = "cognia.permission-test";

        runtime.permissions.write().insert(
            plugin_id.to_string(),
            vec![crate::PermissionGrant {
                plugin_id: plugin_id.to_string(),
                permission: "filesystem:read".to_string(),
                granted_by: "user".to_string(),
                granted_at: chrono::Utc::now().to_rfc3339(),
                expires_at: None,
            }],
        );
        assert!(!granted_node_modules(&runtime, plugin_id).contains(&"fs"));

        runtime
            .permissions
            .write()
            .get_mut(plugin_id)
            .unwrap()
            .extend([
                crate::PermissionGrant {
                    plugin_id: plugin_id.to_string(),
                    permission: "filesystem:write".to_string(),
                    granted_by: "user".to_string(),
                    granted_at: chrono::Utc::now().to_rfc3339(),
                    expires_at: None,
                },
                crate::PermissionGrant {
                    plugin_id: plugin_id.to_string(),
                    permission: "network:fetch".to_string(),
                    granted_by: "user".to_string(),
                    granted_at: chrono::Utc::now().to_rfc3339(),
                    expires_at: None,
                },
            ]);

        let modules = granted_node_modules(&runtime, plugin_id);
        assert!(modules.contains(&"fs"));
        assert!(modules.contains(&"node:fs/promises"));
        assert!(modules.contains(&"https"));
        assert!(!modules.contains(&"ws"));
    }

    #[tokio::test]
    async fn host_neutral_lifecycle_uses_one_process_registry_and_load_handshake() {
        let temp = tempfile::tempdir().unwrap();
        let plugin_root = temp.path().join("plugins");
        let runtime = PluginRuntimeState::new(plugin_root.clone());
        let plugin_id = "cognia.test-headless";
        let install_dir = runtime.plugin_dir(plugin_id);
        std::fs::create_dir_all(install_dir.join("out")).unwrap();
        std::fs::write(
            install_dir.join("out/extension.js"),
            "module.exports = { activate() {}, deactivate() {} };",
        )
        .unwrap();

        let host_script = temp.path().join("fake-vscode-host.cjs");
        std::fs::write(
            &host_script,
            r#"
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
for (const event of ["sidecar:ready"]) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: event, params: {} }) + "\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  let result = { ok: true };
  if (request.method === "extension:activate") {
    result = {
      registeredCommands: ["headless.hello"],
      registeredWebviewViews: [],
      registeredLanguageProviders: [],
    };
  } else if (request.method === "test:echo") {
    result = request.params;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
"#,
        )
        .unwrap();

        let state = VscodeExtensionState::new(temp.path().join("vscode-data"));
        let events = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let events_for_sink = Arc::clone(&events);
        state.configure_host(
            host_script,
            None,
            Arc::new(move |event, frame| events_for_sink.lock().push((event, frame))),
        );
        let manifest = serde_json::json!({
            "id": plugin_id,
            "vscodeMain": "out/extension.js",
            "vscodeExtension": { "bundleFormat": "cjs" },
        })
        .to_string();

        let loaded = plugin_load_vscode_for_state(
            &state,
            &runtime,
            plugin_id.to_string(),
            manifest,
            install_dir.to_string_lossy().to_string(),
        )
        .await
        .unwrap();
        assert!(state.sidecars.read().contains_key(plugin_id));

        let stale = plugin_invoke_vscode_rpc_generation_for_state(
            &state,
            plugin_id.to_string(),
            "stale-generation".to_string(),
            "test:echo".to_string(),
            r#"{"value":0}"#.to_string(),
        )
        .await
        .unwrap_err();
        assert_eq!(stale.code, "stale_generation");

        let activated = plugin_activate_vscode_generation_for_state(
            &state,
            plugin_id.to_string(),
            loaded.generation.clone(),
            "{}".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(activated.registered_commands, ["headless.hello"]);
        assert_eq!(
            plugin_invoke_vscode_rpc_generation_for_state(
                &state,
                plugin_id.to_string(),
                loaded.generation.clone(),
                "test:echo".to_string(),
                r#"{"value":7}"#.to_string(),
            )
            .await
            .unwrap(),
            r#"{"value":7}"#
        );

        plugin_deactivate_vscode_generation_for_state(
            &state,
            plugin_id.to_string(),
            loaded.generation.clone(),
        )
        .await
        .unwrap();
        plugin_unload_vscode_generation_for_state(&state, plugin_id.to_string(), loaded.generation)
            .await
            .unwrap();
        assert!(state.sidecars.read().is_empty());
        assert!(state.runtimes.read().is_empty());
    }

    /// Minimal valid `.vsix` for the staged-install path.
    fn make_test_vsix() -> Vec<u8> {
        use std::io::Write as _;
        let mut buf = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let options = zip::write::FileOptions::<()>::default();
            zip.start_file("extension/package.json", options).unwrap();
            zip.write_all(br#"{ "publisher": "cognia", "name": "hello", "version": "1.0.0" }"#)
                .unwrap();
            zip.start_file("extension/out/extension.js", options)
                .unwrap();
            zip.write_all(b"module.exports = {}").unwrap();
            zip.finish().unwrap();
        }
        buf
    }

    /// Stage `bytes` the way `plugin_vscode_download_vsix` would.
    fn stage(install_root: &Path, bytes: &[u8]) -> PathBuf {
        let dir = super::super::openvsx_download::downloads_dir(install_root);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("staged.vsix");
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn installs_from_a_staged_path_and_removes_the_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let staged = stage(&root, &make_test_vsix());

        let result = install_staged_vsix(&root, &staged).unwrap();

        assert_eq!(result.extension_id, "cognia.hello");
        assert!(result.install_path.join("out/extension.js").exists());
        assert!(
            !staged.exists(),
            "the staged .vsix must not survive a successful install"
        );
    }

    #[test]
    fn failed_install_still_removes_the_staged_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let staged = stage(&root, b"not a zip");

        let err = install_staged_vsix(&root, &staged).unwrap_err();

        assert_eq!(err.code, "install_error");
        assert!(
            !staged.exists(),
            "a failed install must not leave the temp file behind"
        );
    }

    /// The path is renderer-supplied, so the command must only ever read back
    /// what this crate itself downloaded and checksum-verified.
    #[test]
    fn refuses_a_path_outside_the_download_staging_dir() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vscode-extensions");
        std::fs::create_dir_all(super::super::openvsx_download::downloads_dir(&root)).unwrap();

        let elsewhere = dir.path().join("attacker.vsix");
        std::fs::write(&elsewhere, make_test_vsix()).unwrap();

        let err = install_staged_vsix(&root, &elsewhere).unwrap_err();

        assert_eq!(err.code, "path_not_staged");
        assert!(
            elsewhere.exists(),
            "a rejected path must never be deleted — the check runs before cleanup"
        );
    }

    /// A traversing path resolves outside the staging dir and must be refused
    /// on containment, not on string shape.
    #[test]
    fn refuses_a_traversing_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vscode-extensions");
        let staging = super::super::openvsx_download::downloads_dir(&root);
        std::fs::create_dir_all(&staging).unwrap();

        let outside = dir.path().join("secret.vsix");
        std::fs::write(&outside, make_test_vsix()).unwrap();
        let traversing = staging.join("..").join("secret.vsix");

        let err = install_staged_vsix(&root, &traversing).unwrap_err();

        assert_eq!(err.code, "path_not_staged");
        assert!(outside.exists());
    }

    /// A nested path under the staging dir is not a direct child, and the
    /// downloader never produces one.
    #[test]
    fn refuses_a_nested_path_under_the_staging_dir() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let nested = super::super::openvsx_download::downloads_dir(&root).join("sub");
        std::fs::create_dir_all(&nested).unwrap();
        let path = nested.join("x.vsix");
        std::fs::write(&path, make_test_vsix()).unwrap();

        let err = install_staged_vsix(&root, &path).unwrap_err();

        assert_eq!(err.code, "path_not_staged");
    }

    #[test]
    fn refuses_a_missing_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(super::super::openvsx_download::downloads_dir(&root)).unwrap();

        let err = install_staged_vsix(&root, &root.join(".downloads/gone.vsix")).unwrap_err();

        assert_eq!(err.code, "path_not_staged");
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
