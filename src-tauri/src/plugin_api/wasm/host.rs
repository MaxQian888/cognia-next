//! The TS-facing façade for the WASM plugin runtime.
//!
//! `WasmPluginHost` owns the per-plugin `Component`s and, on activation,
//! their `Store<HostState>` + `Instance`. The Tauri commands in
//! `commands.rs` are thin wrappers — they validate inputs, look up state,
//! and delegate to methods on this struct.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use wasmtime::component::{Component, Linker};

use super::engine::{api_version_compatible, engine, parse_plugin_api_version};
use super::store::{
    build_store, CapabilitySet, HostState, DEFAULT_CALL_TIMEOUT_MS, DEFAULT_MEMORY_LIMIT_MB,
};
use super::wit::since_v0_1;
use super::HOST_API_VERSION;

/// Subset of the TS manifest the host needs at instantiate time. We
/// deserialize lazily out of the JSON the loader sends over IPC.
#[derive(Debug, Clone, Deserialize)]
pub struct WasmManifestSlice {
    pub id: String,
    pub version: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(rename = "wasmMain")]
    pub wasm_main: String,
    pub wasm: WasmBlock,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WasmBlock {
    #[serde(rename = "apiVersion")]
    pub api_version: String,
    #[serde(rename = "memoryLimitMb", default)]
    pub memory_limit_mb: Option<u32>,
    #[serde(rename = "callTimeoutMs", default)]
    pub call_timeout_ms: Option<u64>,
    #[serde(default)]
    pub fs: Option<WasmFsBlock>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WasmFsBlock {
    #[serde(default)]
    pub preopens: Vec<String>,
}

/// In-memory record per loaded plugin. The `Component` is the compiled
/// artifact (shared across activations); the `Store` is created fresh on
/// each `activate` and dropped on `deactivate`.
pub struct LoadedPlugin {
    pub manifest: WasmManifestSlice,
    pub plugin_path: PathBuf,
    pub component: Component,
    pub plugin_api_version: String,
}

#[derive(Default)]
pub struct WasmPluginState {
    pub loaded: Arc<RwLock<HashMap<String, LoadedPlugin>>>,
}

/// The cognia API surface for WASM plugins. Today this is a thin registry;
/// once bindgen lands `activate` will also stash the live `Instance`
/// alongside the `Store` so re-entry from TS is constant-time.
pub struct WasmPluginHost;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateOutcome {
    pub exports: Vec<String>,
    pub plugin_api_version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmPluginSnapshot {
    pub plugin_id: String,
    pub version: String,
    pub plugin_api_version: String,
    pub plugin_path: String,
    pub permissions: Vec<String>,
}

impl WasmPluginHost {
    /// Compile and register a plugin. Idempotent: calling twice with the
    /// same id re-compiles (so file edits land without a separate unload).
    pub fn load(
        state: &WasmPluginState,
        manifest: WasmManifestSlice,
        plugin_path: PathBuf,
    ) -> Result<String, String> {
        let wasm_path = plugin_path.join(&manifest.wasm_main);
        if !wasm_path.exists() {
            return Err(format!("wasmMain not found: {wasm_path:?}"));
        }
        let bytes = std::fs::read(&wasm_path)
            .map_err(|e| format!("read {wasm_path:?}: {e}"))?;
        let plugin_api_version = parse_plugin_api_version(&bytes)
            .map_err(|e| format!("scan api-version: {e}"))?
            .unwrap_or_else(|| manifest.wasm.api_version.clone());
        if !api_version_compatible(&plugin_api_version, HOST_API_VERSION) {
            return Err(format!(
                "WASM api-version {plugin_api_version} incompatible with host {HOST_API_VERSION}"
            ));
        }
        let component = Component::from_binary(engine(), &bytes)
            .map_err(|e| format!("compile component: {e}"))?;
        let id = manifest.id.clone();
        let entry = LoadedPlugin {
            manifest,
            plugin_path,
            component,
            plugin_api_version: plugin_api_version.clone(),
        };
        state.loaded.write().insert(id.clone(), entry);
        Ok(plugin_api_version)
    }

    /// Construct the version-matched linker for a loaded plugin.
    pub fn version_linker(plugin_api_version: &str) -> Result<Linker<HostState>, String> {
        match major_minor(plugin_api_version) {
            Some((0, 1)) => since_v0_1::build_linker().map_err(|e| e.to_string()),
            Some((m, n)) => Err(format!("no linker registered for v{m}.{n}.x")),
            None => Err(format!("invalid api-version `{plugin_api_version}`")),
        }
    }

    /// Build a fresh `Store<HostState>` for an activation. The capability
    /// set is sourced from the per-plugin permission ledger (passed in by
    /// the caller after consulting the on-disk grant file).
    pub fn build_activation_store(
        plugin: &LoadedPlugin,
        plugin_data_dir: &Path,
        granted_permissions: &[String],
    ) -> Result<wasmtime::Store<HostState>, String> {
        let mut caps = CapabilitySet::default();
        for p in granted_permissions {
            caps.add(p.clone());
        }
        let memory_mb = plugin
            .manifest
            .wasm
            .memory_limit_mb
            .unwrap_or(DEFAULT_MEMORY_LIMIT_MB);
        let timeout_ms = plugin
            .manifest
            .wasm
            .call_timeout_ms
            .unwrap_or(DEFAULT_CALL_TIMEOUT_MS);
        let extra: Vec<PathBuf> = plugin
            .manifest
            .wasm
            .fs
            .as_ref()
            .map(|fs| fs.preopens.iter().map(PathBuf::from).collect())
            .unwrap_or_default();
        let mut store = build_store(
            plugin.manifest.id.clone(),
            plugin_data_dir,
            &extra,
            caps,
            memory_mb,
            timeout_ms,
        )
        .map_err(|e| format!("build store: {e}"))?;
        // Ensure the plugin id is reflected in the freshly built state.
        store.data_mut().plugin_id = plugin.manifest.id.clone();
        Ok(store)
    }

    pub fn snapshot(state: &WasmPluginState) -> Vec<WasmPluginSnapshot> {
        let map = state.loaded.read();
        let mut out: Vec<_> = map
            .values()
            .map(|p| WasmPluginSnapshot {
                plugin_id: p.manifest.id.clone(),
                version: p.manifest.version.clone(),
                plugin_api_version: p.plugin_api_version.clone(),
                plugin_path: p.plugin_path.to_string_lossy().into_owned(),
                permissions: p.manifest.permissions.clone(),
            })
            .collect();
        out.sort_by(|a, b| a.plugin_id.cmp(&b.plugin_id));
        out
    }

    pub fn unload(state: &WasmPluginState, plugin_id: &str) -> bool {
        state.loaded.write().remove(plugin_id).is_some()
    }
}

fn major_minor(v: &str) -> Option<(u32, u32)> {
    let mut parts = v.trim().splitn(3, '.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.parse().ok()?;
    Some((major, minor))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_v01() -> WasmManifestSlice {
        WasmManifestSlice {
            id: "demo".into(),
            version: "0.0.1".into(),
            permissions: vec!["notification".into()],
            wasm_main: "main.wasm".into(),
            wasm: WasmBlock {
                api_version: "0.1.0".into(),
                memory_limit_mb: Some(32),
                call_timeout_ms: Some(15_000),
                fs: None,
            },
        }
    }

    #[test]
    fn major_minor_parses() {
        assert_eq!(major_minor("0.1.0"), Some((0, 1)));
        assert_eq!(major_minor("1.2.3"), Some((1, 2)));
        assert_eq!(major_minor("nope"), None);
    }

    #[test]
    fn version_linker_routes_v0_1() {
        let linker = WasmPluginHost::version_linker("0.1.0").expect("v0.1 supported");
        let _ = linker;
        assert!(WasmPluginHost::version_linker("0.2.0").is_err());
        assert!(WasmPluginHost::version_linker("garbage").is_err());
    }

    #[test]
    fn load_rejects_missing_wasm_file() {
        let state = WasmPluginState::default();
        let m = manifest_v01();
        let tmp = tempfile::tempdir().unwrap();
        let err = WasmPluginHost::load(&state, m, tmp.path().to_path_buf()).unwrap_err();
        assert!(err.contains("wasmMain not found"));
    }

    #[test]
    fn snapshot_is_sorted_by_id() {
        let state = WasmPluginState::default();
        // Inject two synthetic entries directly so we don't need a real .wasm.
        {
            let mut map = state.loaded.write();
            let tmp = std::env::temp_dir();
            let component = Component::new(
                engine(),
                r#"(component)"#,
            )
            .unwrap();
            map.insert(
                "z-plugin".into(),
                LoadedPlugin {
                    manifest: WasmManifestSlice {
                        id: "z-plugin".into(),
                        version: "0.0.1".into(),
                        permissions: vec![],
                        wasm_main: "_.wasm".into(),
                        wasm: WasmBlock {
                            api_version: "0.1.0".into(),
                            memory_limit_mb: None,
                            call_timeout_ms: None,
                            fs: None,
                        },
                    },
                    plugin_path: tmp.clone(),
                    component: component.clone(),
                    plugin_api_version: "0.1.0".into(),
                },
            );
            map.insert(
                "a-plugin".into(),
                LoadedPlugin {
                    manifest: WasmManifestSlice {
                        id: "a-plugin".into(),
                        version: "0.0.1".into(),
                        permissions: vec![],
                        wasm_main: "_.wasm".into(),
                        wasm: WasmBlock {
                            api_version: "0.1.0".into(),
                            memory_limit_mb: None,
                            call_timeout_ms: None,
                            fs: None,
                        },
                    },
                    plugin_path: tmp,
                    component,
                    plugin_api_version: "0.1.0".into(),
                },
            );
        }
        let snap = WasmPluginHost::snapshot(&state);
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[0].plugin_id, "a-plugin");
        assert_eq!(snap[1].plugin_id, "z-plugin");
    }

    #[test]
    fn unload_returns_false_when_unknown() {
        let state = WasmPluginState::default();
        assert!(!WasmPluginHost::unload(&state, "ghost"));
    }
}
