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

fn write_state_file(state: &PluginRuntimeState, plugin_id: &str, value: &serde_json::Value) -> Result<()> {
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
    let install_path = state.plugin_dir(&plugin_id);
    fs::create_dir_all(&install_path)?;
    if let Some(manifest_json) = payload.manifest_json.as_ref() {
        let manifest_path = install_path.join("manifest.json");
        fs::write(&manifest_path, manifest_json.as_bytes())?;
    }
    let version = payload
        .manifest_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|v| v.get("version").and_then(|s| s.as_str().map(|s| s.to_string())))
        .unwrap_or_else(|| "0.0.0".into());

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
    log::info!("plugin_install: id={} source={}", snapshot.plugin_id, source);
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
        assert_eq!(state.plugins.read().get("demo").unwrap().snapshot.status, "enabled");
        plugin_disable_inner(&state, "demo".into()).await.unwrap();
        assert_eq!(state.plugins.read().get("demo").unwrap().snapshot.status, "disabled");
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
        plugin_set_state_inner(&state, "demo".into(), blob.clone()).await.unwrap();
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
        let install_path = state.plugin_dir(&plugin_id);
        fs::create_dir_all(&install_path)?;
        if let Some(manifest_json) = payload.manifest_json.as_ref() {
            fs::write(install_path.join("manifest.json"), manifest_json.as_bytes())?;
        }
        let version = payload
            .manifest_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
            .and_then(|v| v.get("version").and_then(|s| s.as_str().map(|s| s.to_string())))
            .unwrap_or_else(|| "0.0.0".into());
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
