//! Tauri commands for the VS Code extension host.
//!
//! These are the entry points the renderer-side
//! `lib/plugin/core/vscode-loader.ts` invokes:
//!
//! - `plugin_vscode_install_vsix(vsix_bytes_base64)` → InstallResult
//! - `plugin_load_vscode(plugin_id, manifest_json, plugin_path)`
//! - `plugin_activate_vscode(plugin_id, config_json)`
//! - `plugin_deactivate_vscode(plugin_id)`
//! - `plugin_unload_vscode(plugin_id)`
//! - `plugin_invoke_vscode_rpc(plugin_id, method, payload_json)`
//!
//! All commands run on the Tauri main thread; sidecar interactions are
//! `async` and resolve when the corresponding JSON-RPC frame returns.
//!
//! `dead_code` is silenced module-wide: every command in this file IS
//! registered in `tauri::generate_handler!` (see `src/lib.rs`), but the
//! macro hides its callsites from rustc's dead-code analyser. Arg structs
//! also appear "never constructed" because Tauri deserialises them
//! reflectively from the renderer's JSON payload — no Rust callsite ever
//! literally builds one.
#![allow(dead_code)]

use std::path::PathBuf;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::host::{Sidecar, SpawnRequest};
use super::installer::{install_vsix, InstallError, InstallResult};
use super::VscodeExtensionState;

#[derive(Debug, Serialize)]
pub struct VscodeCommandError {
    pub code: String,
    pub message: String,
}

impl VscodeCommandError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl From<InstallError> for VscodeCommandError {
    fn from(value: InstallError) -> Self {
        VscodeCommandError::new("install_error", value.to_string())
    }
}

#[derive(Debug, Deserialize)]
pub struct InstallArgs {
    pub vsix_base64: String,
}

#[tauri::command]
pub async fn plugin_vscode_install_vsix(
    args: InstallArgs,
    state: State<'_, VscodeExtensionState>,
) -> Result<InstallResult, VscodeCommandError> {
    let payload = base64::engine::general_purpose::STANDARD
        .decode(&args.vsix_base64)
        .map_err(|e| VscodeCommandError::new("decode_error", e.to_string()))?;
    let install_root = state.extension_install_dir.clone();
    let result = install_vsix(&payload, &install_root)?;
    Ok(result)
}

#[derive(Debug, Deserialize)]
pub struct LoadArgs {
    pub plugin_id: String,
    pub manifest_json: String,
    pub plugin_path: String,
    pub sidecar_script: Option<String>,
    pub node_binary: Option<String>,
}

#[tauri::command]
pub async fn plugin_load_vscode(
    args: LoadArgs,
    state: State<'_, VscodeExtensionState>,
) -> Result<(), VscodeCommandError> {
    let manifest: serde_json::Value = serde_json::from_str(&args.manifest_json)
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
        extension_id: args.plugin_id.clone(),
        extension_path: PathBuf::from(&args.plugin_path)
            .join(main)
            .to_string_lossy()
            .to_string(),
        node_binary: args.node_binary,
        sidecar_script: args.sidecar_script,
    };
    let sidecar = Sidecar::spawn(request)
        .await
        .map_err(|e| VscodeCommandError::new("spawn_failed", e.to_string()))?;
    state
        .sidecars
        .write()
        .insert(args.plugin_id.clone(), sidecar);
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct ActivateArgs {
    pub plugin_id: String,
    pub config_json: String,
}

#[derive(Debug, Serialize)]
pub struct ActivateResult {
    pub sidecar_pid: u32,
    pub registered_commands: Vec<String>,
    pub registered_webview_views: Vec<String>,
    pub registered_language_providers: Vec<String>,
}

#[tauri::command]
pub async fn plugin_activate_vscode(
    args: ActivateArgs,
    state: State<'_, VscodeExtensionState>,
) -> Result<ActivateResult, VscodeCommandError> {
    let sidecars = state.sidecars.read();
    let sidecar = sidecars
        .get(&args.plugin_id)
        .ok_or_else(|| VscodeCommandError::new("not_loaded", "extension not loaded"))?;
    // Build the JSON-RPC request frame.
    let frame = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "extension:activate",
        "params": {
            "extensionId": args.plugin_id,
            "globalStorageUri": format!("file://{}", state.extension_dir(&args.plugin_id).display()),
            "storageUri": format!("file://{}", state.extension_dir(&args.plugin_id).display()),
            "logUri": format!("file://{}", state.extension_dir(&args.plugin_id).display()),
            "extensionMode": "production",
            "initialGlobalState": {},
            "initialWorkspaceState": {},
            "config": serde_json::from_str::<serde_json::Value>(&args.config_json).unwrap_or(serde_json::Value::Null),
        },
    })
    .to_string();
    sidecar
        .send(&frame)
        .map_err(|e| VscodeCommandError::new("send_failed", e.to_string()))?;
    Ok(ActivateResult {
        sidecar_pid: sidecar.pid,
        registered_commands: vec![],
        registered_webview_views: vec![],
        registered_language_providers: vec![],
    })
}

#[derive(Debug, Deserialize)]
pub struct PluginIdArgs {
    pub plugin_id: String,
}

#[tauri::command]
pub async fn plugin_deactivate_vscode(
    args: PluginIdArgs,
    state: State<'_, VscodeExtensionState>,
) -> Result<(), VscodeCommandError> {
    let sidecars = state.sidecars.read();
    if let Some(sidecar) = sidecars.get(&args.plugin_id) {
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "extension:deactivate",
            "params": { "extensionId": args.plugin_id },
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
    args: PluginIdArgs,
    state: State<'_, VscodeExtensionState>,
) -> Result<(), VscodeCommandError> {
    // Release the write lock before awaiting — tokio::process::Child is
    // not Send so holding the lock across .kill().await trips Tauri's
    // command-future-must-be-Send constraint.
    let sidecar = {
        let mut sidecars = state.sidecars.write();
        sidecars.remove(&args.plugin_id)
    };
    if let Some(sidecar) = sidecar {
        sidecar.kill().await;
    }
    state.runtimes.write().remove(&args.plugin_id);
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct InvokeRpcArgs {
    pub plugin_id: String,
    pub method: String,
    pub payload_json: String,
}

#[tauri::command]
pub async fn plugin_invoke_vscode_rpc(
    args: InvokeRpcArgs,
    state: State<'_, VscodeExtensionState>,
) -> Result<String, VscodeCommandError> {
    let sidecars = state.sidecars.read();
    let sidecar = sidecars
        .get(&args.plugin_id)
        .ok_or_else(|| VscodeCommandError::new("not_loaded", "extension not loaded"))?;
    let frame = serde_json::json!({
        "jsonrpc": "2.0",
        "id": chrono::Utc::now().timestamp_millis(),
        "method": args.method,
        "params": serde_json::from_str::<serde_json::Value>(&args.payload_json)
            .unwrap_or(serde_json::Value::Null),
    })
    .to_string();
    sidecar
        .send(&frame)
        .map_err(|e| VscodeCommandError::new("send_failed", e.to_string()))?;
    Ok("null".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_args_deserializes() {
        let parsed: InstallArgs = serde_json::from_str(r#"{"vsix_base64":"abc"}"#).unwrap();
        assert_eq!(parsed.vsix_base64, "abc");
    }

    #[test]
    fn load_args_deserializes_with_optional_fields() {
        let parsed: LoadArgs = serde_json::from_str(
            r#"{"plugin_id":"x.y","manifest_json":"{}","plugin_path":"/tmp"}"#,
        )
        .unwrap();
        assert_eq!(parsed.plugin_id, "x.y");
        assert!(parsed.sidecar_script.is_none());
    }

    #[test]
    fn error_helpers_round_trip() {
        let err = VscodeCommandError::new("test", "boom");
        assert_eq!(err.code, "test");
        let from_install: VscodeCommandError = InstallError::MissingField("name").into();
        assert_eq!(from_install.code, "install_error");
    }
}
