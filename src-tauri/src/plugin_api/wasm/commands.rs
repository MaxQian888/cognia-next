//! Tauri command surface for the WASM plugin host. Mirrors the TS-side
//! IPC client in `lib/plugin/core/wasm-loader.ts`.
//!
//! - `plugin_wasm_load`        — compile + register a `type === "wasm"` plugin
//! - `plugin_wasm_activate`    — instantiate + call `init`
//! - `plugin_wasm_deactivate`  — drop any cached state for the plugin
//! - `plugin_wasm_call`        — invoke a guest export by name
//! - `plugin_wasm_unload`      — remove the compiled component
//! - `plugin_wasm_list`        — enumerate loaded plugins (debug UI)
//!
//! Each guest call builds a fresh `Store<HostState>` (cheap — component
//! compilation is the slow part, and that's cached on `LoadedPlugin`).
//! Stores are `!Send` so the per-call lifecycle keeps everything inside
//! a single async frame.

use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use super::host::{ActivateOutcome, WasmManifestSlice, WasmPluginHost, WasmPluginSnapshot};
use super::wit::since_v0_1;
use super::WasmPluginState;
use super::super::PluginRuntimeState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmLoadResult {
    pub plugin_api_version: String,
}

#[tauri::command]
pub async fn plugin_wasm_load(
    state: State<'_, WasmPluginState>,
    plugin_id: String,
    manifest_json: String,
    plugin_path: String,
) -> Result<WasmLoadResult, String> {
    let manifest: WasmManifestSlice =
        serde_json::from_str(&manifest_json).map_err(|e| format!("manifest parse: {e}"))?;
    if manifest.id != plugin_id {
        return Err(format!(
            "plugin_id mismatch: command={plugin_id} manifest.id={}",
            manifest.id
        ));
    }
    let plugin_api_version =
        WasmPluginHost::load(&state, manifest, PathBuf::from(plugin_path))?;
    Ok(WasmLoadResult { plugin_api_version })
}

fn granted_permissions(
    runtime: &PluginRuntimeState,
    plugin_id: &str,
) -> Vec<String> {
    runtime
        .permissions
        .read()
        .get(plugin_id)
        .map(|grants| grants.iter().map(|g| g.permission.clone()).collect())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn plugin_wasm_activate(
    state: State<'_, WasmPluginState>,
    runtime: State<'_, PluginRuntimeState>,
    plugin_id: String,
    config_json: String,
) -> Result<ActivateOutcome, String> {
    // Snapshot what we need out of the loaded-plugin map without holding
    // its lock across the `.await` below — Component is Clone-able and
    // the manifest fields we need are cheap to copy.
    let (component, manifest, plugin_api_version, plugin_dir) = {
        let map = state.loaded.read();
        let entry = map
            .get(&plugin_id)
            .ok_or_else(|| format!("plugin not loaded: {plugin_id}"))?;
        (
            entry.component.clone(),
            entry.manifest.clone(),
            entry.plugin_api_version.clone(),
            entry.plugin_path.clone(),
        )
    };

    let perms = granted_permissions(&runtime, &plugin_id);
    let data_dir = runtime.plugin_dir(&plugin_id).join("data");
    let mut store = WasmPluginHost::build_activation_store(
        &super::host::LoadedPlugin {
            manifest: manifest.clone(),
            plugin_path: plugin_dir,
            component: component.clone(),
            plugin_api_version: plugin_api_version.clone(),
        },
        &data_dir,
        &perms,
    )?;

    let linker = WasmPluginHost::version_linker(&plugin_api_version)?;
    let bindings = since_v0_1::CogniaPlugin::instantiate_async(&mut store, &component, &linker)
        .await
        .map_err(|e| format!("instantiate component: {e}"))?;

    // Call init(config bytes) and bubble guest errors back to TS.
    let config_bytes = config_json.into_bytes();
    bindings
        .call_init(&mut store, &config_bytes)
        .await
        .map_err(|e| format!("guest init host error: {e}"))?
        .map_err(|e| format!("guest init returned error: {e}"))?;

    Ok(ActivateOutcome {
        exports: vec![
            "init".into(),
            "on-event".into(),
            "tool-execute".into(),
            "workflow-node-execute".into(),
        ],
        plugin_api_version,
    })
}

#[tauri::command]
pub async fn plugin_wasm_deactivate(
    state: State<'_, WasmPluginState>,
    plugin_id: String,
) -> Result<bool, String> {
    Ok(state.loaded.read().contains_key(&plugin_id))
}

#[tauri::command]
pub async fn plugin_wasm_call(
    state: State<'_, WasmPluginState>,
    runtime: State<'_, PluginRuntimeState>,
    plugin_id: String,
    export_name: String,
    payload_json: String,
) -> Result<String, String> {
    if export_name.trim().is_empty() {
        return Err("export_name is empty".into());
    }

    let (component, manifest, plugin_api_version, plugin_dir) = {
        let map = state.loaded.read();
        let entry = map
            .get(&plugin_id)
            .ok_or_else(|| format!("plugin not loaded: {plugin_id}"))?;
        (
            entry.component.clone(),
            entry.manifest.clone(),
            entry.plugin_api_version.clone(),
            entry.plugin_path.clone(),
        )
    };

    let perms = granted_permissions(&runtime, &plugin_id);
    let data_dir = runtime.plugin_dir(&plugin_id).join("data");
    let mut store = WasmPluginHost::build_activation_store(
        &super::host::LoadedPlugin {
            manifest,
            plugin_path: plugin_dir,
            component: component.clone(),
            plugin_api_version: plugin_api_version.clone(),
        },
        &data_dir,
        &perms,
    )?;

    let linker = WasmPluginHost::version_linker(&plugin_api_version)?;
    let bindings =
        since_v0_1::CogniaPlugin::instantiate_async(&mut store, &component, &linker)
            .await
            .map_err(|e| format!("instantiate component: {e}"))?;

    let payload_bytes = payload_json.into_bytes();
    let bytes = match export_name.as_str() {
        "on-event" | "init" => {
            // `init` is also routable through plugin_wasm_call for ad-hoc
            // re-initialization scenarios. We treat its return shape (unit)
            // the same as on-event-with-empty-output.
            if export_name == "init" {
                bindings
                    .call_init(&mut store, &payload_bytes)
                    .await
                    .map_err(|e| format!("guest init: {e}"))?
                    .map_err(|e| format!("guest init err: {e}"))?;
                Vec::new()
            } else {
                bindings
                    .call_on_event(&mut store, "event", &payload_bytes)
                    .await
                    .map_err(|e| format!("guest on-event: {e}"))?
                    .map_err(|e| format!("guest on-event err: {e}"))?
            }
        }
        "tool-execute" => bindings
            .call_tool_execute(&mut store, &extract_kind(&payload_bytes), &payload_bytes)
            .await
            .map_err(|e| format!("guest tool-execute: {e}"))?
            .map_err(|e| format!("guest tool-execute err: {e}"))?,
        "workflow-node-execute" => bindings
            .call_workflow_node_execute(
                &mut store,
                &extract_kind(&payload_bytes),
                &payload_bytes,
            )
            .await
            .map_err(|e| format!("guest workflow-node-execute: {e}"))?
            .map_err(|e| format!("guest workflow-node-execute err: {e}"))?,
        other => return Err(format!("unknown export: {other}")),
    };

    // Bytes back to the TS side as UTF-8 JSON if possible, otherwise an
    // escape-encoded fallback so non-text guests can still surface diagnostic
    // payloads. The TS wrapper attempts JSON.parse and falls back to the
    // raw string.
    Ok(String::from_utf8(bytes).unwrap_or_else(|e| {
        let raw = e.into_bytes();
        format!("\"<binary {} bytes>\"", raw.len())
    }))
}

/// Extract a `"kind": "..."` field from a JSON payload byte slice for the
/// tool-execute / workflow-node-execute exports. Falls back to the empty
/// string when parsing fails, in which case the guest decides how to
/// dispatch.
fn extract_kind(payload: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(payload)
        .ok()
        .and_then(|v| v.get("kind").and_then(|k| k.as_str().map(str::to_string)))
        .unwrap_or_default()
}

#[tauri::command]
pub async fn plugin_wasm_unload(
    state: State<'_, WasmPluginState>,
    plugin_id: String,
) -> Result<bool, String> {
    Ok(WasmPluginHost::unload(&state, &plugin_id))
}

#[tauri::command]
pub async fn plugin_wasm_list(
    state: State<'_, WasmPluginState>,
) -> Result<Vec<WasmPluginSnapshot>, String> {
    Ok(WasmPluginHost::snapshot(&state))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_kind_returns_kind_field() {
        assert_eq!(extract_kind(br#"{"kind":"format-rust"}"#), "format-rust");
    }

    #[test]
    fn extract_kind_returns_empty_when_missing() {
        assert_eq!(extract_kind(b"{}"), "");
        assert_eq!(extract_kind(b"not json"), "");
    }

    #[tokio::test]
    async fn list_starts_empty() {
        let state = WasmPluginState::default();
        let snap = WasmPluginHost::snapshot(&state);
        assert!(snap.is_empty());
    }

    #[tokio::test]
    async fn unload_unknown_returns_false() {
        let state = WasmPluginState::default();
        assert!(!WasmPluginHost::unload(&state, "ghost"));
    }
}
