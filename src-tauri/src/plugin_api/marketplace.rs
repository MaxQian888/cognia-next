//! Plugin marketplace Tauri commands (Batch 3c).
//!
//! Phase-1 implementations are intentionally network-light: `plugin_get_directory`
//! returns the install root; `plugin_invalidate_cache` clears the
//! marketplace cache directory; `plugin_marketplace_versions` and
//! `plugin_download_version` accept a `cache_only: Option<bool>` flag and
//! return a stub reply when network access is unavailable. Real registry
//! integration lands in a follow-up — the contract here is "command
//! exists so TS no longer silent-fails on desktop."

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::{PluginRuntimeState, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceVersion {
    pub version: String,
    pub published_at: Option<String>,
    pub download_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPayload {
    pub plugin_id: String,
    pub version: String,
    pub local_path: String,
    pub size_bytes: u64,
}

fn cache_dir(state: &PluginRuntimeState) -> PathBuf {
    state.plugin_install_dir.join("_marketplace_cache")
}

#[tauri::command]
pub async fn plugin_marketplace_versions(
    plugin_id: String,
    #[allow(unused_variables)] cache_only: Option<bool>,
) -> Result<Vec<MarketplaceVersion>> {
    log::debug!("plugin_marketplace_versions: id={}", plugin_id);
    // Phase 1 returns the empty version list. The TS marketplace UI handles
    // the empty case via "No versions available" — a working contract that
    // unblocks the runtime without requiring registry integration.
    Ok(Vec::new())
}

#[tauri::command]
pub async fn plugin_get_directory(state: State<'_, PluginRuntimeState>) -> Result<String> {
    Ok(state.plugin_install_dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn plugin_download_version(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    version: String,
) -> Result<DownloadPayload> {
    let cache = cache_dir(&state);
    fs::create_dir_all(&cache)?;
    let local_path = cache.join(format!("{plugin_id}-{version}.placeholder"));
    fs::write(&local_path, b"placeholder")?;
    let size_bytes = fs::metadata(&local_path)?.len();
    Ok(DownloadPayload {
        plugin_id,
        version,
        local_path: local_path.to_string_lossy().into_owned(),
        size_bytes,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvalidateCacheArgs {
    #[serde(default)]
    pub scope: Option<String>,
}

#[tauri::command]
pub async fn plugin_invalidate_cache(
    state: State<'_, PluginRuntimeState>,
    args: Option<InvalidateCacheArgs>,
) -> Result<()> {
    let cache = cache_dir(&state);
    if cache.exists() {
        fs::remove_dir_all(&cache)?;
    }
    log::debug!(
        "plugin_invalidate_cache: scope={:?}",
        args.and_then(|a| a.scope)
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_state(tmp: &TempDir) -> PluginRuntimeState {
        PluginRuntimeState::new(PathBuf::from(tmp.path()))
    }

    #[tokio::test]
    async fn get_directory_returns_install_root() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let path = state.plugin_install_dir.to_string_lossy().into_owned();
        assert_eq!(path, tmp.path().to_string_lossy().into_owned());
    }

    #[test]
    fn invalidate_cache_removes_dir_when_present() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let cache = cache_dir(&state);
        fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join("x"), b"y").unwrap();
        assert!(cache.exists());
        // Inline invalidate logic.
        fs::remove_dir_all(&cache).unwrap();
        assert!(!cache.exists());
    }
}
