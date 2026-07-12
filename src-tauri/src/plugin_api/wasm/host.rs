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
/// artifact (shared across activations); the live `Store` + `Instance` for an
/// active plugin live separately in [`WasmPluginState::activated`].
pub struct LoadedPlugin {
    pub manifest: WasmManifestSlice,
    pub plugin_path: PathBuf,
    pub component: Component,
    pub plugin_api_version: String,
}

/// The live, post-`init` instance for an activated plugin: the `Store` (holding
/// all guest memory + host state that `init` set up) and its instantiated
/// `bindings`. Retained across calls so guest state persists and re-entry skips
/// re-instantiation. `HostState` is `Send`, so this can be shared across command
/// threads behind an async `Mutex` (which also serialises same-plugin calls —
/// wasmtime needs `&mut Store`, so concurrent calls into one instance are
/// unsound). `call_timeout_ms` mirrors the store's per-call epoch budget so the
/// deadline can be reset before each reused call.
pub struct ActivatedPlugin {
    pub store: wasmtime::Store<HostState>,
    pub bindings: since_v0_1::CogniaPlugin,
    pub call_timeout_ms: u64,
}

#[derive(Default)]
pub struct WasmPluginState {
    pub loaded: Arc<RwLock<HashMap<String, LoadedPlugin>>>,
    /// Typed pre-instantiation handle per plugin, built once in `load()` and
    /// reused on every call. The `Linker` (WASI + cognia host imports) and the
    /// linker→component type-resolution are baked in here, so `plugin_wasm_call`
    /// only allocates a fresh, permission-scoped `Store<HostState>` and
    /// instantiates against it. Kept as a sibling map (not a `LoadedPlugin`
    /// field) so the synthetic empty-component test fixtures — which cannot
    /// build a real `CogniaPluginPre` — stay valid.
    pub pres: Arc<RwLock<HashMap<String, Arc<since_v0_1::CogniaPluginPre<HostState>>>>>,
    /// Live instances by plugin id (present only while activated). Each is
    /// wrapped in an async `Mutex` so calls into the same instance serialise.
    pub activated: Arc<RwLock<HashMap<String, Arc<tokio::sync::Mutex<ActivatedPlugin>>>>>,
}

/// The cognia API surface for WASM plugins. `load` stashes a typed
/// pre-instantiation handle (`CogniaPluginPre`) per plugin in
/// `WasmPluginState::pres`, so each call only builds a fresh permission-scoped
/// `Store` and instantiates against the cached handle — the linker and
/// import resolution are not rebuilt per call. `activate` additionally stashes
/// the live post-`init` [`ActivatedPlugin`] (Store + Instance) in
/// [`WasmPluginState::activated`] so re-entry from TS reuses the initialised
/// instance instead of rebuilding it.
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
        let bytes = std::fs::read(&wasm_path).map_err(|e| format!("read {wasm_path:?}: {e}"))?;
        // The embedded `cognia:api-version` custom section is the trusted
        // source of the ABI version. A binary that omits it is malformed
        // (ADR-0013): we do NOT fall back to the manifest-declared version,
        // which is attacker-controlled JSON.
        let plugin_api_version =
            parse_plugin_api_version(&bytes).map_err(|e| format!("scan api-version: {e}"))?;
        if !api_version_compatible(&plugin_api_version, HOST_API_VERSION) {
            return Err(format!(
                "WASM api-version {plugin_api_version} incompatible with host {HOST_API_VERSION}"
            ));
        }
        let component = Component::from_binary(engine(), &bytes)
            .map_err(|e| format!("compile component: {e}"))?;
        // Build the typed pre-instantiation handle once, here at load time,
        // so per-call work is just a fresh Store + instantiate. This also
        // surfaces a structurally-invalid component (missing world exports /
        // bad imports) at load rather than on first call.
        let plugin_pre = Self::build_plugin_pre(&plugin_api_version, &component)?;
        let id = manifest.id.clone();
        let entry = LoadedPlugin {
            manifest,
            plugin_path,
            component,
            plugin_api_version: plugin_api_version.clone(),
        };
        state.loaded.write().insert(id.clone(), entry);
        state.pres.write().insert(id, Arc::new(plugin_pre));
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

    /// Build the typed pre-instantiation handle for a compiled component.
    /// Reuses `version_linker` so the WASI + cognia host imports are
    /// registered exactly once; the returned handle is cloned (via `Arc`) per
    /// call and instantiated against a fresh, permission-scoped `Store`.
    pub fn build_plugin_pre(
        plugin_api_version: &str,
        component: &Component,
    ) -> Result<since_v0_1::CogniaPluginPre<HostState>, String> {
        let linker = Self::version_linker(plugin_api_version)?;
        let instance_pre = linker
            .instantiate_pre(component)
            .map_err(|e| format!("pre-instantiate linker: {e}"))?;
        since_v0_1::CogniaPluginPre::new(instance_pre)
            .map_err(|e| format!("typed pre-instantiation: {e}"))
    }

    /// Build a fresh `Store<HostState>` for an activation. The capability
    /// set is sourced from the per-plugin permission ledger (passed in by
    /// the caller after consulting the on-disk grant file). `shell_allowlist`
    /// is the plugin's declared `shellCommands`, mirrored from
    /// `PluginRuntimeState`, and gates `process.exec` deny-by-default.
    pub fn build_activation_store(
        manifest: &WasmManifestSlice,
        plugin_data_dir: &Path,
        granted_permissions: &[String],
        shell_allowlist: &[String],
    ) -> Result<wasmtime::Store<HostState>, String> {
        let mut caps = CapabilitySet::default();
        for p in granted_permissions {
            caps.add(p.clone());
        }
        let memory_mb = manifest
            .wasm
            .memory_limit_mb
            .unwrap_or(DEFAULT_MEMORY_LIMIT_MB);
        let timeout_ms = manifest
            .wasm
            .call_timeout_ms
            .unwrap_or(DEFAULT_CALL_TIMEOUT_MS);
        let extra: Vec<PathBuf> = manifest
            .wasm
            .fs
            .as_ref()
            .map(|fs| fs.preopens.iter().map(PathBuf::from).collect())
            .unwrap_or_default();
        let mut store = build_store(
            manifest.id.clone(),
            plugin_data_dir,
            &extra,
            caps,
            memory_mb,
            timeout_ms,
        )
        .map_err(|e| format!("build store: {e}"))?;
        // Ensure the plugin id is reflected in the freshly built state.
        store.data_mut().plugin_id = manifest.id.clone();
        // Mirror the declared shell-command allowlist so `process.exec` can
        // enforce it deny-by-default.
        store.data_mut().shell_allowlist = shell_allowlist.to_vec();
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
        state.pres.write().remove(plugin_id);
        // Drop any live instance first so its Store (guest memory) is freed.
        state.activated.write().remove(plugin_id);
        state.loaded.write().remove(plugin_id).is_some()
    }

    /// Drop the live instance for a plugin (if activated). Returns whether an
    /// instance was present. The compiled component stays loaded.
    pub fn deactivate(state: &WasmPluginState, plugin_id: &str) -> bool {
        state.activated.write().remove(plugin_id).is_some()
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
    fn load_rejects_binary_missing_api_version_section() {
        // A structurally-valid component preamble with no `cognia:api-version`
        // custom section must be rejected at load — `load` no longer trusts the
        // manifest-declared version as a fallback (ADR-0013).
        const EMPTY_COMPONENT: &[u8] = &[0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00];
        let state = WasmPluginState::default();
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("main.wasm"), EMPTY_COMPONENT).unwrap();
        let err =
            WasmPluginHost::load(&state, manifest_v01(), tmp.path().to_path_buf()).unwrap_err();
        assert!(err.contains("scan api-version"), "unexpected error: {err}");
        assert!(
            err.contains(super::super::API_VERSION_SECTION),
            "unexpected error: {err}"
        );
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
            // Smallest valid component artifact: the binary preamble of an
            // empty `(component)` — magic `\0asm` + component-model version
            // (0x0d 0x00) + layer (0x01 0x00). Passing WAT *text* here only
            // works when wasmtime is built with the optional `wat` feature,
            // which this crate disables (`default-features = false`), so we
            // feed the compiled bytes directly.
            const EMPTY_COMPONENT: &[u8] = &[0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00];
            let component = Component::new(engine(), EMPTY_COMPONENT).unwrap();
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

    #[test]
    fn deactivate_returns_false_when_not_activated() {
        let state = WasmPluginState::default();
        assert!(!WasmPluginHost::deactivate(&state, "ghost"));
    }

    #[test]
    fn unload_clears_the_activated_map() {
        // unload drops from both the loaded and the activated maps. With nothing
        // registered it returns false and leaves the activated map empty (the
        // live-instance drop path is exercised end-to-end via the example
        // plugin in the plugin E2E suite).
        let state = WasmPluginState::default();
        assert!(!WasmPluginHost::unload(&state, "ghost"));
        assert!(state.activated.read().is_empty());
    }

    #[tokio::test]
    async fn build_activation_store_mirrors_shell_allowlist() {
        // The smallest valid component (empty `(component)` preamble) lets us
        // build a store without a real .wasm; we only assert on HostState.
        const EMPTY_COMPONENT: &[u8] = &[0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00];
        let component = Component::new(engine(), EMPTY_COMPONENT).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let plugin = LoadedPlugin {
            manifest: manifest_v01(),
            plugin_path: tmp.path().to_path_buf(),
            component,
            plugin_api_version: "0.1.0".into(),
        };
        let data_dir = tmp.path().join("data");
        let store = WasmPluginHost::build_activation_store(
            &plugin.manifest,
            &data_dir,
            &["process:spawn".to_string()],
            &["git".to_string(), "node".to_string()],
        )
        .expect("store builds");
        assert_eq!(
            store.data().shell_allowlist,
            vec!["git".to_string(), "node".to_string()]
        );
        assert!(store.data().capabilities.allows("process:spawn"));
    }

    #[test]
    fn build_plugin_pre_rejects_component_without_world_exports() {
        // The empty-component preamble compiles but exposes none of the
        // `cognia-plugin` world exports (`init`/`on-event`/…), so typed
        // pre-instantiation must fail — proving the pre is built and validated
        // at load time (and documenting why the snapshot fixtures can't cache one).
        const EMPTY_COMPONENT: &[u8] = &[0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00];
        let component = Component::new(engine(), EMPTY_COMPONENT).unwrap();
        assert!(WasmPluginHost::build_plugin_pre("0.1.0", &component).is_err());
    }

    #[test]
    fn build_plugin_pre_rejects_unsupported_version() {
        const EMPTY_COMPONENT: &[u8] = &[0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00];
        let component = Component::new(engine(), EMPTY_COMPONENT).unwrap();
        // Routes through `version_linker`, which only registers v0.1.x.
        assert!(WasmPluginHost::build_plugin_pre("0.2.0", &component).is_err());
        assert!(WasmPluginHost::build_plugin_pre("garbage", &component).is_err());
    }
}
