//! Plugin lifecycle Tauri commands (Batch 3a).
//!
//! These ten handlers persist the filesystem-side view of every plugin:
//! installed directory, runtime state JSON, and last known status. The TS
//! `PluginManager` calls them via `invoke('plugin_*')` from
//! `lib/plugin/core/manager.ts`, `lifecycle/rollback.ts`, `core/transport.ts`,
//! and `devtools/hot-reload.ts`. Each handler is intentionally small — it
//! doesn't try to re-implement manifest validation (TS owns that) but it
//! does enforce the install directory boundary so callers can't escape it.

use std::fs;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{PluginError, PluginRecord, PluginRuntimeSnapshot, PluginRuntimeState, Result};

/// Subset of the manifest the Rust side persists. Anything richer stays in TS.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifestPayload {
    pub id: String,
    pub version: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPayload {
    /// Optional manifest JSON. When provided, written to
    /// `<install_dir>/<plugin_id>/manifest.json` verbatim.
    #[serde(default)]
    pub manifest_json: Option<String>,
}

fn write_state_file(
    state: &PluginRuntimeState,
    plugin_id: &str,
    value: &serde_json::Value,
) -> Result<()> {
    let dir = state.plugin_dir(plugin_id);
    fs::create_dir_all(&dir)?;
    let path = dir.join("state.json");
    fs::write(&path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

fn read_state_file(state: &PluginRuntimeState, plugin_id: &str) -> Result<serde_json::Value> {
    let path = state.plugin_dir(plugin_id).join("state.json");
    if !path.exists() {
        return Ok(serde_json::Value::Null);
    }
    let bytes = fs::read(&path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

#[tauri::command]
pub async fn plugin_load(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    manifest: PluginManifestPayload,
) -> Result<PluginRuntimeSnapshot> {
    if manifest.id != plugin_id {
        return Err(PluginError::InvalidManifest(format!(
            "manifest.id={} does not match plugin_id={}",
            manifest.id, plugin_id
        )));
    }
    let install_path = state.plugin_dir(&plugin_id);
    fs::create_dir_all(&install_path)?;

    let snapshot = PluginRuntimeSnapshot {
        plugin_id: plugin_id.clone(),
        version: manifest.version.clone(),
        status: "loaded".into(),
        last_error: None,
        loaded_at: Some(Utc::now().to_rfc3339()),
        install_path: install_path.to_string_lossy().into_owned(),
    };
    let runtime_state = read_state_file(&state, &plugin_id).unwrap_or(serde_json::Value::Null);
    state.plugins.write().insert(
        plugin_id,
        PluginRecord {
            snapshot: snapshot.clone(),
            runtime_state,
        },
    );
    Ok(snapshot)
}

fn flip_status(state: &PluginRuntimeState, plugin_id: &str, status: &str) -> Result<()> {
    let mut plugins = state.plugins.write();
    let record = plugins
        .get_mut(plugin_id)
        .ok_or_else(|| PluginError::NotFound(plugin_id.into()))?;
    record.snapshot.status = status.into();
    Ok(())
}

/// Set a plugin's status, creating a minimal record if the backend has never
/// seen it. Unlike `flip_status`, this never returns `NotFound`: the frontend
/// `PluginManager` is the authority on which plugins exist (it discovers
/// browser built-ins and disk-scanned plugins entirely TS-side), and the
/// backend `state.plugins` map is in-memory — empty on every cold start until
/// something calls `plugin_load`/`plugin_install`. Browser built-ins are never
/// loaded through those, so their `syncBackendStatus` sync used to fail with
/// `plugin not found`. Seeding a record keeps the status ledger authoritative
/// without forcing a directory-creating `plugin_load` for bundled plugins.
/// `version` is left empty (TS owns rich metadata); `install_path` is the
/// computed plugin dir but is NOT created on disk.
fn upsert_status(state: &PluginRuntimeState, plugin_id: &str, status: &str) -> Result<()> {
    let mut plugins = state.plugins.write();
    if let Some(record) = plugins.get_mut(plugin_id) {
        record.snapshot.status = status.into();
        return Ok(());
    }
    let runtime_state = read_state_file(state, plugin_id).unwrap_or(serde_json::Value::Null);
    plugins.insert(
        plugin_id.to_string(),
        PluginRecord {
            snapshot: PluginRuntimeSnapshot {
                plugin_id: plugin_id.to_string(),
                version: String::new(),
                status: status.into(),
                last_error: None,
                loaded_at: Some(Utc::now().to_rfc3339()),
                install_path: state.plugin_dir(plugin_id).to_string_lossy().into_owned(),
            },
            runtime_state,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn plugin_enable(state: State<'_, PluginRuntimeState>, plugin_id: String) -> Result<()> {
    flip_status(&state, &plugin_id, "enabled")
}

#[tauri::command]
pub async fn plugin_disable(state: State<'_, PluginRuntimeState>, plugin_id: String) -> Result<()> {
    flip_status(&state, &plugin_id, "disabled")
}

#[tauri::command]
pub async fn plugin_unload(state: State<'_, PluginRuntimeState>, plugin_id: String) -> Result<()> {
    state.plugins.write().remove(&plugin_id);
    Ok(())
}

/// Validate the install manifest before any disk write. Mirrors the always-on
/// gates the TS `registerBackendInstall` tail enforces (manifest present, valid
/// JSON, declared id matches the install id, non-empty version) so that callers
/// reaching this command directly — notably the Companion API remote install
/// path, which bypasses the renderer's `PluginManager` entirely — cannot
/// install a phantom, malformed, or id-mismatched plugin. Signature
/// verification stays TS-side (it is config-gated and off by default); this
/// covers the integrity gates that always run. Returns the validated version.
fn validate_install_manifest(plugin_id: &str, payload: &InstallPayload) -> Result<String> {
    let raw = payload.manifest_json.as_deref().ok_or_else(|| {
        PluginError::InvalidManifest(
            "manifest_json is required to install a plugin (refusing to create a manifest-less plugin)".into(),
        )
    })?;
    let manifest: PluginManifestPayload = serde_json::from_str(raw)
        .map_err(|e| PluginError::InvalidManifest(format!("manifest is not valid JSON: {e}")))?;
    if manifest.id != plugin_id {
        return Err(PluginError::InvalidManifest(format!(
            "manifest.id={} does not match plugin_id={}",
            manifest.id, plugin_id
        )));
    }
    if manifest.version.trim().is_empty() {
        return Err(PluginError::InvalidManifest(
            "manifest.version is empty".into(),
        ));
    }
    Ok(manifest.version)
}

#[tauri::command]
pub async fn plugin_install(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    source: String,
    payload: InstallPayload,
) -> Result<PluginRuntimeSnapshot> {
    if plugin_id.trim().is_empty() {
        return Err(PluginError::InvalidArgument("plugin_id is empty".into()));
    }
    // Gate: validate the manifest BEFORE touching disk so a rejected install
    // leaves no partial plugin directory behind.
    let version = validate_install_manifest(&plugin_id, &payload)?;
    let install_path = state.plugin_dir(&plugin_id);
    fs::create_dir_all(&install_path)?;
    if let Some(manifest_json) = payload.manifest_json.as_ref() {
        let manifest_path = install_path.join("manifest.json");
        fs::write(&manifest_path, manifest_json.as_bytes())?;
    }

    let snapshot = PluginRuntimeSnapshot {
        plugin_id: plugin_id.clone(),
        version,
        status: "installed".into(),
        last_error: None,
        loaded_at: Some(Utc::now().to_rfc3339()),
        install_path: install_path.to_string_lossy().into_owned(),
    };
    state.plugins.write().insert(
        plugin_id,
        PluginRecord {
            snapshot: snapshot.clone(),
            runtime_state: serde_json::Value::Null,
        },
    );
    log::info!(
        "plugin_install: id={} source={}",
        snapshot.plugin_id,
        source
    );
    Ok(snapshot)
}

#[tauri::command]
pub async fn plugin_uninstall(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
) -> Result<()> {
    let install_path = state.plugin_dir(&plugin_id);
    if install_path.exists() {
        fs::remove_dir_all(&install_path)?;
    }
    state.plugins.write().remove(&plugin_id);
    state.permissions.write().remove(&plugin_id);
    Ok(())
}

#[tauri::command]
pub async fn plugin_get_all(
    state: State<'_, PluginRuntimeState>,
) -> Result<Vec<PluginRuntimeSnapshot>> {
    Ok(state
        .plugins
        .read()
        .values()
        .map(|r| r.snapshot.clone())
        .collect())
}

#[tauri::command]
pub async fn plugin_runtime_snapshot(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
) -> Result<PluginRuntimeSnapshot> {
    state
        .plugins
        .read()
        .get(&plugin_id)
        .map(|r| r.snapshot.clone())
        .ok_or_else(|| PluginError::NotFound(plugin_id))
}

#[tauri::command]
pub async fn plugin_set_state(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    state_blob: serde_json::Value,
) -> Result<()> {
    write_state_file(&state, &plugin_id, &state_blob)?;
    if let Some(record) = state.plugins.write().get_mut(&plugin_id) {
        record.runtime_state = state_blob;
    }
    Ok(())
}

/// Set the lifecycle status on a plugin's runtime snapshot. This is the
/// status-ledger counterpart to `plugin_set_state` (which persists opaque
/// runtime data, NOT status). The frontend `PluginManager.syncBackendStatus`
/// drives this on every load/enable/disable/suspend/unload transition so a
/// cold-start `syncRuntimeState` restores the exact status. Uses
/// `upsert_status` so any status string (installed/loaded/enabled/disabled/
/// error) is preserved verbatim — and a plugin the backend hasn't explicitly
/// loaded (browser built-ins, disk-scanned plugins, anything after a cold
/// restart) is seeded rather than rejected with `NotFound`.
#[tauri::command]
pub async fn plugin_set_status(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    status: String,
) -> Result<()> {
    upsert_status(&state, &plugin_id, &status)
}

#[tauri::command]
pub async fn plugin_get_state(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
) -> Result<serde_json::Value> {
    if let Some(record) = state.plugins.read().get(&plugin_id) {
        return Ok(record.runtime_state.clone());
    }
    read_state_file(&state, &plugin_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn make_state(tmp: &TempDir) -> PluginRuntimeState {
        PluginRuntimeState::new(PathBuf::from(tmp.path()))
    }

    #[tokio::test]
    async fn load_then_unload_clears_record() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);

        let snap = plugin_load_inner(
            &state,
            "demo".into(),
            PluginManifestPayload {
                id: "demo".into(),
                version: "1.0.0".into(),
                name: None,
                description: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(snap.status, "loaded");
        assert!(state.plugins.read().contains_key("demo"));

        plugin_unload_inner(&state, "demo".into()).await.unwrap();
        assert!(state.plugins.read().is_empty());
    }

    #[tokio::test]
    async fn enable_disable_flips_status() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        plugin_load_inner(
            &state,
            "demo".into(),
            PluginManifestPayload {
                id: "demo".into(),
                version: "1.0.0".into(),
                name: None,
                description: None,
            },
        )
        .await
        .unwrap();
        plugin_enable_inner(&state, "demo".into()).await.unwrap();
        assert_eq!(
            state.plugins.read().get("demo").unwrap().snapshot.status,
            "enabled"
        );
        plugin_disable_inner(&state, "demo".into()).await.unwrap();
        assert_eq!(
            state.plugins.read().get("demo").unwrap().snapshot.status,
            "disabled"
        );
    }

    #[tokio::test]
    async fn set_status_preserves_arbitrary_status() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        plugin_load_inner(
            &state,
            "demo".into(),
            PluginManifestPayload {
                id: "demo".into(),
                version: "1.0.0".into(),
                name: None,
                description: None,
            },
        )
        .await
        .unwrap();
        // plugin_set_status delegates to upsert_status — non-enable/disable
        // statuses are preserved verbatim (not collapsed), which
        // syncBackendStatus relies on.
        upsert_status(&state, "demo", "installed").unwrap();
        assert_eq!(
            state.plugins.read().get("demo").unwrap().snapshot.status,
            "installed"
        );
        upsert_status(&state, "demo", "error").unwrap();
        assert_eq!(
            state.plugins.read().get("demo").unwrap().snapshot.status,
            "error"
        );
    }

    #[tokio::test]
    async fn flip_status_unknown_plugin_rejected() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        // flip_status stays strict — explicit enable/disable on an unknown
        // plugin is a real error.
        let err = flip_status(&state, "missing", "enabled").unwrap_err();
        assert!(matches!(err, PluginError::NotFound(_)));
    }

    #[tokio::test]
    async fn upsert_status_seeds_unknown_plugin() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        // A browser built-in / disk-scanned plugin the backend never loaded:
        // syncBackendStatus must seed it rather than fail with NotFound.
        upsert_status(&state, "cognia-deep-research", "enabled").unwrap();
        let plugins = state.plugins.read();
        let record = plugins.get("cognia-deep-research").unwrap();
        assert_eq!(record.snapshot.status, "enabled");
        assert_eq!(record.snapshot.plugin_id, "cognia-deep-research");
        // No directory is created on disk for a seeded built-in.
        assert!(!state.plugin_dir("cognia-deep-research").exists());
    }

    #[tokio::test]
    async fn upsert_status_preserves_existing_metadata() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        plugin_load_inner(
            &state,
            "demo".into(),
            PluginManifestPayload {
                id: "demo".into(),
                version: "2.3.4".into(),
                name: None,
                description: None,
            },
        )
        .await
        .unwrap();
        // Upserting an already-loaded plugin only flips status; version and
        // install_path from the real load are not clobbered.
        upsert_status(&state, "demo", "disabled").unwrap();
        let plugins = state.plugins.read();
        let record = plugins.get("demo").unwrap();
        assert_eq!(record.snapshot.status, "disabled");
        assert_eq!(record.snapshot.version, "2.3.4");
    }

    #[tokio::test]
    async fn manifest_id_mismatch_rejected() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let err = plugin_load_inner(
            &state,
            "expected".into(),
            PluginManifestPayload {
                id: "other".into(),
                version: "1.0.0".into(),
                name: None,
                description: None,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PluginError::InvalidManifest(_)));
    }

    #[tokio::test]
    async fn install_writes_manifest_and_uninstall_removes_dir() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let snap = plugin_install_inner(
            &state,
            "demo".into(),
            "local".into(),
            InstallPayload {
                manifest_json: Some(r#"{"id":"demo","version":"2.0.0"}"#.into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(snap.version, "2.0.0");
        let manifest_path = tmp.path().join("demo").join("manifest.json");
        assert!(manifest_path.exists());

        plugin_uninstall_inner(&state, "demo".into()).await.unwrap();
        assert!(!tmp.path().join("demo").exists());
        assert!(state.plugins.read().is_empty());
    }

    #[tokio::test]
    async fn install_without_manifest_rejected() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        // A manifest-less install would create a phantom plugin dir; reject it
        // and leave no directory behind.
        let err = plugin_install_inner(
            &state,
            "demo".into(),
            "local".into(),
            InstallPayload {
                manifest_json: None,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PluginError::InvalidManifest(_)));
        assert!(!tmp.path().join("demo").exists());
        assert!(state.plugins.read().is_empty());
    }

    #[tokio::test]
    async fn install_manifest_id_mismatch_rejected() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let err = plugin_install_inner(
            &state,
            "expected".into(),
            "local".into(),
            InstallPayload {
                manifest_json: Some(r#"{"id":"other","version":"1.0.0"}"#.into()),
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PluginError::InvalidManifest(_)));
        assert!(!tmp.path().join("expected").exists());
    }

    #[tokio::test]
    async fn install_malformed_manifest_rejected() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let err = plugin_install_inner(
            &state,
            "demo".into(),
            "local".into(),
            InstallPayload {
                manifest_json: Some("{not json".into()),
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PluginError::InvalidManifest(_)));
    }

    #[tokio::test]
    async fn install_empty_version_rejected() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let err = plugin_install_inner(
            &state,
            "demo".into(),
            "local".into(),
            InstallPayload {
                manifest_json: Some(r#"{"id":"demo","version":"  "}"#.into()),
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PluginError::InvalidManifest(_)));
    }

    #[tokio::test]
    async fn set_state_persists_and_get_state_reads_back() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        plugin_load_inner(
            &state,
            "demo".into(),
            PluginManifestPayload {
                id: "demo".into(),
                version: "1.0.0".into(),
                name: None,
                description: None,
            },
        )
        .await
        .unwrap();
        let blob = serde_json::json!({ "answer": 42 });
        plugin_set_state_inner(&state, "demo".into(), blob.clone())
            .await
            .unwrap();
        assert!(tmp.path().join("demo").join("state.json").exists());
        let read_back = plugin_get_state_inner(&state, "demo".into()).await.unwrap();
        assert_eq!(read_back, blob);
    }

    // -- async-mirror helpers so tests don't construct a `tauri::State` --
    async fn plugin_load_inner(
        state: &PluginRuntimeState,
        plugin_id: String,
        manifest: PluginManifestPayload,
    ) -> Result<PluginRuntimeSnapshot> {
        if manifest.id != plugin_id {
            return Err(PluginError::InvalidManifest(format!(
                "manifest.id={} does not match plugin_id={}",
                manifest.id, plugin_id
            )));
        }
        let install_path = state.plugin_dir(&plugin_id);
        fs::create_dir_all(&install_path)?;
        let snapshot = PluginRuntimeSnapshot {
            plugin_id: plugin_id.clone(),
            version: manifest.version.clone(),
            status: "loaded".into(),
            last_error: None,
            loaded_at: Some(Utc::now().to_rfc3339()),
            install_path: install_path.to_string_lossy().into_owned(),
        };
        let runtime_state = read_state_file(state, &plugin_id).unwrap_or(serde_json::Value::Null);
        state.plugins.write().insert(
            plugin_id,
            PluginRecord {
                snapshot: snapshot.clone(),
                runtime_state,
            },
        );
        Ok(snapshot)
    }

    async fn plugin_enable_inner(state: &PluginRuntimeState, plugin_id: String) -> Result<()> {
        flip_status(state, &plugin_id, "enabled")
    }
    async fn plugin_disable_inner(state: &PluginRuntimeState, plugin_id: String) -> Result<()> {
        flip_status(state, &plugin_id, "disabled")
    }
    async fn plugin_unload_inner(state: &PluginRuntimeState, plugin_id: String) -> Result<()> {
        state.plugins.write().remove(&plugin_id);
        Ok(())
    }
    async fn plugin_install_inner(
        state: &PluginRuntimeState,
        plugin_id: String,
        _source: String,
        payload: InstallPayload,
    ) -> Result<PluginRuntimeSnapshot> {
        if plugin_id.trim().is_empty() {
            return Err(PluginError::InvalidArgument("plugin_id is empty".into()));
        }
        // Mirror production: validate the manifest before any disk write.
        let version = validate_install_manifest(&plugin_id, &payload)?;
        let install_path = state.plugin_dir(&plugin_id);
        fs::create_dir_all(&install_path)?;
        if let Some(manifest_json) = payload.manifest_json.as_ref() {
            fs::write(install_path.join("manifest.json"), manifest_json.as_bytes())?;
        }
        let snapshot = PluginRuntimeSnapshot {
            plugin_id: plugin_id.clone(),
            version,
            status: "installed".into(),
            last_error: None,
            loaded_at: Some(Utc::now().to_rfc3339()),
            install_path: install_path.to_string_lossy().into_owned(),
        };
        state.plugins.write().insert(
            plugin_id,
            PluginRecord {
                snapshot: snapshot.clone(),
                runtime_state: serde_json::Value::Null,
            },
        );
        Ok(snapshot)
    }
    async fn plugin_uninstall_inner(state: &PluginRuntimeState, plugin_id: String) -> Result<()> {
        let install_path = state.plugin_dir(&plugin_id);
        if install_path.exists() {
            fs::remove_dir_all(&install_path)?;
        }
        state.plugins.write().remove(&plugin_id);
        state.permissions.write().remove(&plugin_id);
        Ok(())
    }
    async fn plugin_set_state_inner(
        state: &PluginRuntimeState,
        plugin_id: String,
        state_blob: serde_json::Value,
    ) -> Result<()> {
        write_state_file(state, &plugin_id, &state_blob)?;
        if let Some(record) = state.plugins.write().get_mut(&plugin_id) {
            record.runtime_state = state_blob;
        }
        Ok(())
    }
    async fn plugin_get_state_inner(
        state: &PluginRuntimeState,
        plugin_id: String,
    ) -> Result<serde_json::Value> {
        if let Some(record) = state.plugins.read().get(&plugin_id) {
            return Ok(record.runtime_state.clone());
        }
        read_state_file(state, &plugin_id)
    }
}
