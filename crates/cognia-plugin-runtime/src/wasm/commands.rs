//! Tauri command surface for the WASM plugin host. Mirrors the TS-side
//! IPC client in `lib/plugin/core/wasm-loader.ts`.
//!
//! - `plugin_wasm_load`        — compile + register a `type === "wasm"` plugin
//! - `plugin_wasm_activate`    — instantiate + call `init`, then retain the instance
//! - `plugin_wasm_deactivate`  — drop the retained live instance
//! - `plugin_wasm_call`        — invoke a guest export on the retained instance
//! - `plugin_wasm_unload`      — remove the compiled component (+ instance)
//! - `plugin_wasm_list`        — enumerate loaded plugins (debug UI)
//!
//! `activate` stashes the live post-`init` `Store` + `Instance` in
//! `WasmPluginState::activated`; `call` reuses it (behind a per-plugin async
//! `Mutex`) so guest state set up in `init` persists and re-entry skips
//! re-instantiation. A call for a plugin that was never activated falls back to
//! a fresh throw-away store (no retained state) so ad-hoc exports still work.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use super::super::PluginRuntimeState;
use super::host::{
    ActivateOutcome, ActivatedPlugin, WasmManifestSlice, WasmPluginHost, WasmPluginSnapshot,
};
use super::store::{deadline_from_timeout_ms, HostState};
use super::wit::since_v0_1;
use super::WasmPluginState;

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
    let plugin_api_version = WasmPluginHost::load(&state, manifest, PathBuf::from(plugin_path))?;
    Ok(WasmLoadResult { plugin_api_version })
}

fn granted_permissions(runtime: &PluginRuntimeState, plugin_id: &str) -> Vec<String> {
    runtime
        .permissions
        .read()
        .get(plugin_id)
        .map(|grants| grants.iter().map(|g| g.permission.clone()).collect())
        .unwrap_or_default()
}

/// The plugin's declared `shellCommands` allowlist, mirrored into the runtime
/// by `plugin_set_shell_allowlist` on enable. Reused verbatim by the WASM
/// `process.exec` gate so it matches the TS-plugin `shell:execute` gate.
fn granted_shell_commands(runtime: &PluginRuntimeState, plugin_id: &str) -> Vec<String> {
    runtime
        .shell_allowlist
        .read()
        .get(plugin_id)
        .cloned()
        .unwrap_or_default()
}

#[tauri::command]
pub async fn plugin_wasm_activate(
    state: State<'_, WasmPluginState>,
    runtime: State<'_, PluginRuntimeState>,
    plugin_id: String,
    config_json: String,
) -> Result<ActivateOutcome, String> {
    // Snapshot what we need out of the loaded-plugin maps without holding
    // their locks across the `.await` below. The typed pre-instantiation
    // handle (built once at load) carries the linker + import resolution, so
    // per call we only build a fresh permission-scoped Store and instantiate.
    let (manifest, plugin_api_version, plugin_pre) = {
        let map = state.loaded.read();
        let entry = map
            .get(&plugin_id)
            .ok_or_else(|| format!("plugin not loaded: {plugin_id}"))?;
        let plugin_pre = state
            .pres
            .read()
            .get(&plugin_id)
            .cloned()
            .ok_or_else(|| format!("plugin not instantiable (no pre): {plugin_id}"))?;
        (
            entry.manifest.clone(),
            entry.plugin_api_version.clone(),
            plugin_pre,
        )
    };

    let perms = granted_permissions(&runtime, &plugin_id);
    let shell_allow = granted_shell_commands(&runtime, &plugin_id);
    let data_dir = runtime.plugin_dir(&plugin_id).join("data");
    let mut store =
        WasmPluginHost::build_activation_store(&manifest, &data_dir, &perms, &shell_allow)?;

    let bindings = plugin_pre
        .instantiate_async(&mut store)
        .await
        .map_err(|e| format!("instantiate component: {e}"))?;

    // Call init(config bytes) and bubble guest errors back to TS.
    let config_bytes = config_json.into_bytes();
    bindings
        .call_init(&mut store, &config_bytes)
        .await
        .map_err(|e| format!("guest init host error: {e}"))?
        .map_err(|e| format!("guest init returned error: {e}"))?;

    // Retain the live post-init instance so subsequent calls reuse it (state set
    // up in `init` persists) instead of re-instantiating a fresh, un-init'd
    // store. Replaces any prior activation for this id (re-activate = reset).
    let call_timeout_ms = store.data().call_timeout_ms;
    state.activated.write().insert(
        plugin_id.clone(),
        Arc::new(tokio::sync::Mutex::new(ActivatedPlugin {
            store,
            bindings,
            call_timeout_ms,
        })),
    );

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
    // Drop the live instance (frees the Store / guest memory); the compiled
    // component stays loaded so a later activate is cheap. Returns whether the
    // plugin is still loaded (mirrors the prior contract).
    WasmPluginHost::deactivate(&state, &plugin_id);
    Ok(state.loaded.read().contains_key(&plugin_id))
}

/// Classified dispatch failure. A `Trap` is a host-side wasmtime fault (trap or
/// epoch-deadline timeout) that leaves the `Store`'s guest memory in an
/// indeterminate, half-executed state — the retained instance must be evicted
/// before any reuse. A `Guest` error is a normal `Result::Err` the guest
/// returned: the `Store` is still consistent and the instance is safe to keep.
enum DispatchError {
    Trap(String),
    Guest(String),
}

impl DispatchError {
    fn into_message(self) -> String {
        match self {
            DispatchError::Trap(m) | DispatchError::Guest(m) => m,
        }
    }

    /// Whether this failure left the retained `Store` in an unusable state and
    /// the activated instance must be evicted before the next call.
    fn poisons_store(&self) -> bool {
        matches!(self, DispatchError::Trap(_))
    }
}

/// Dispatch one export against a live instance. Shared by the retained-instance
/// path and the un-activated fallback so the export match lives in one place.
async fn dispatch_export(
    bindings: &since_v0_1::CogniaPlugin,
    store: &mut wasmtime::Store<HostState>,
    export_name: &str,
    payload_bytes: &[u8],
) -> Result<Vec<u8>, DispatchError> {
    match export_name {
        "init" => {
            // `init` is routable through plugin_wasm_call for ad-hoc re-init;
            // its unit return maps to empty output.
            bindings
                .call_init(store, payload_bytes)
                .await
                .map_err(|e| DispatchError::Trap(format!("guest init: {e}")))?
                .map_err(|e| DispatchError::Guest(format!("guest init err: {e}")))?;
            Ok(Vec::new())
        }
        "on-event" => bindings
            .call_on_event(store, "event", payload_bytes)
            .await
            .map_err(|e| DispatchError::Trap(format!("guest on-event: {e}")))?
            .map_err(|e| DispatchError::Guest(format!("guest on-event err: {e}"))),
        "tool-execute" => bindings
            .call_tool_execute(store, &extract_kind(payload_bytes), payload_bytes)
            .await
            .map_err(|e| DispatchError::Trap(format!("guest tool-execute: {e}")))?
            .map_err(|e| DispatchError::Guest(format!("guest tool-execute err: {e}"))),
        "workflow-node-execute" => bindings
            .call_workflow_node_execute(store, &extract_kind(payload_bytes), payload_bytes)
            .await
            .map_err(|e| DispatchError::Trap(format!("guest workflow-node-execute: {e}")))?
            .map_err(|e| DispatchError::Guest(format!("guest workflow-node-execute err: {e}"))),
        // A bad export name never ran guest code — treat as a plain (non-poisoning) error.
        other => Err(DispatchError::Guest(format!("unknown export: {other}"))),
    }
}

/// UTF-8 JSON back to TS if possible, else an escape-encoded length marker so a
/// non-text guest payload still surfaces a diagnostic. The TS wrapper attempts
/// JSON.parse and falls back to the raw string.
fn encode_output(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap_or_else(|e| {
        let raw = e.into_bytes();
        format!("\"<binary {} bytes>\"", raw.len())
    })
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
    let payload_bytes = payload_json.into_bytes();

    // Fast path: reuse the retained post-init instance. Clone the Arc so the
    // registry RwLock isn't held across the await; the per-plugin async Mutex
    // then serialises calls into this instance (wasmtime needs &mut Store).
    let retained = state.activated.read().get(&plugin_id).cloned();
    if let Some(activated) = retained {
        let result = {
            let mut guard = activated.lock().await;
            let ap = &mut *guard;
            // The retained store's epoch countdown was consumed by prior calls;
            // reset it so THIS call gets a full timeout window.
            let deadline = deadline_from_timeout_ms(ap.call_timeout_ms);
            ap.store.set_epoch_deadline(deadline);
            dispatch_export(&ap.bindings, &mut ap.store, &export_name, &payload_bytes).await
            // `guard` (and its &mut into the Store) drops here.
        };
        return match result {
            Ok(bytes) => Ok(encode_output(bytes)),
            Err(err) => {
                if err.poisons_store() {
                    // The Store is poisoned by the trap/timeout — evict the
                    // retained instance so the next call rebuilds a fresh one
                    // instead of reusing indeterminate guest memory. A stateful
                    // guest must be re-activated to restore its state (the
                    // poisoned state was unusable anyway).
                    state.activated.write().remove(&plugin_id);
                }
                Err(err.into_message())
            }
        };
    }

    // Fallback: the plugin was never activated (no retained state). Build a
    // throw-away store + instance for this one call from the cached pre. This
    // does NOT run `init`, so a stateful guest should be activated first; kept
    // for ad-hoc exports.
    let (manifest, plugin_pre) = {
        let map = state.loaded.read();
        let entry = map
            .get(&plugin_id)
            .ok_or_else(|| format!("plugin not loaded: {plugin_id}"))?;
        let plugin_pre = state
            .pres
            .read()
            .get(&plugin_id)
            .cloned()
            .ok_or_else(|| format!("plugin not instantiable (no pre): {plugin_id}"))?;
        (entry.manifest.clone(), plugin_pre)
    };

    let perms = granted_permissions(&runtime, &plugin_id);
    let shell_allow = granted_shell_commands(&runtime, &plugin_id);
    let data_dir = runtime.plugin_dir(&plugin_id).join("data");
    let mut store =
        WasmPluginHost::build_activation_store(&manifest, &data_dir, &perms, &shell_allow)?;

    let bindings = plugin_pre
        .instantiate_async(&mut store)
        .await
        .map_err(|e| format!("instantiate component: {e}"))?;

    // Throw-away store — a trap here poisons nothing retained, so both error
    // classes collapse to a plain message.
    let bytes = dispatch_export(&bindings, &mut store, &export_name, &payload_bytes)
        .await
        .map_err(DispatchError::into_message)?;
    Ok(encode_output(bytes))
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

    #[test]
    fn dispatch_error_only_trap_poisons_the_store() {
        // A host trap/timeout leaves the Store poisoned → the retained instance
        // must be evicted. A guest-returned error keeps the Store consistent.
        assert!(DispatchError::Trap("trapped".into()).poisons_store());
        assert!(!DispatchError::Guest("boom".into()).poisons_store());
        assert_eq!(DispatchError::Trap("t".into()).into_message(), "t");
        assert_eq!(DispatchError::Guest("g".into()).into_message(), "g");
    }
}
