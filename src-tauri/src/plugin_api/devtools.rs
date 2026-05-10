//! Plugin devtools Tauri commands (Batch 3d, gated behind `debug_assertions`).
//!
//! These handlers back the in-app plugin developer experience: a hot-reload
//! file watcher, a small dev-server status surface, and a `plugin_reload`
//! command that emits a `plugin-hot-reload:<pluginId>` event the TS side
//! listens for. Real WebSocket dev-server transport (axum + tungstenite)
//! is a follow-up — this batch installs the command surface so the TS
//! devtools stop silent-failing and can report a working "stopped" /
//! "running (stub)" status.

use std::path::PathBuf;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use super::{PluginRuntimeState, Result};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevServerStatus {
    pub running: bool,
    pub host: String,
    pub port: u16,
}

/// In-process status holder. Kept inside this module so the broader
/// `PluginRuntimeState` doesn't gain a devtools-specific field.
static DEV_SERVER_STATUS: once_cell::sync::Lazy<RwLock<DevServerStatus>> =
    once_cell::sync::Lazy::new(|| RwLock::new(DevServerStatus::default()));

static WATCH_PATHS: once_cell::sync::Lazy<RwLock<Vec<PathBuf>>> =
    once_cell::sync::Lazy::new(|| RwLock::new(Vec::new()));

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevServerConfig {
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevServerStartResult {
    pub host: String,
    pub port: u16,
}

#[tauri::command]
pub async fn plugin_dev_server_start(config: DevServerConfig) -> Result<DevServerStartResult> {
    let host = config.host.unwrap_or_else(|| "127.0.0.1".into());
    let port = config.port.unwrap_or(0);
    let mut status = DEV_SERVER_STATUS.write();
    status.running = true;
    status.host = host.clone();
    status.port = port;
    Ok(DevServerStartResult { host, port })
}

#[tauri::command]
pub async fn plugin_dev_server_stop() -> Result<()> {
    *DEV_SERVER_STATUS.write() = DevServerStatus::default();
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevServerWatchArgs {
    #[serde(default)]
    pub plugin_id: Option<String>,
    #[serde(default)]
    pub paths: Option<Vec<String>>,
}

#[tauri::command]
pub async fn plugin_dev_server_watch(args: DevServerWatchArgs) -> Result<()> {
    if let Some(paths) = args.paths {
        let mut watches = WATCH_PATHS.write();
        for path in paths {
            let p = PathBuf::from(path);
            if !watches.contains(&p) {
                watches.push(p);
            }
        }
    }
    log::debug!(
        "plugin_dev_server_watch: plugin={:?} watches={}",
        args.plugin_id,
        WATCH_PATHS.read().len()
    );
    Ok(())
}

#[tauri::command]
pub async fn plugin_dev_server_unwatch(plugin_id: String) -> Result<()> {
    log::debug!("plugin_dev_server_unwatch: plugin={}", plugin_id);
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStartArgs {
    pub paths: Vec<String>,
}

#[tauri::command]
pub async fn plugin_watch_start(args: WatchStartArgs) -> Result<()> {
    let mut watches = WATCH_PATHS.write();
    for path in args.paths {
        let p = PathBuf::from(path);
        if !watches.contains(&p) {
            watches.push(p);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn plugin_watch_stop() -> Result<()> {
    WATCH_PATHS.write().clear();
    Ok(())
}

#[tauri::command]
pub async fn plugin_reload(app: AppHandle, plugin_id: String) -> Result<()> {
    let event = format!("plugin-hot-reload:{plugin_id}");
    app.emit(&event, ())
        .map_err(|e| super::PluginError::Internal(format!("emit reload event: {e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn plugin_list_dev_plugins(state: State<'_, PluginRuntimeState>) -> Result<Vec<String>> {
    Ok(state.plugins.read().keys().cloned().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dev_server_start_then_stop_resets_status() {
        plugin_dev_server_start(DevServerConfig {
            host: Some("127.0.0.1".into()),
            port: Some(7777),
        })
        .await
        .unwrap();
        assert!(DEV_SERVER_STATUS.read().running);
        assert_eq!(DEV_SERVER_STATUS.read().port, 7777);
        plugin_dev_server_stop().await.unwrap();
        assert!(!DEV_SERVER_STATUS.read().running);
    }

    #[tokio::test]
    async fn watch_start_then_stop_clears_paths() {
        plugin_watch_start(WatchStartArgs {
            paths: vec!["/tmp/a".into(), "/tmp/b".into()],
        })
        .await
        .unwrap();
        assert_eq!(WATCH_PATHS.read().len(), 2);
        plugin_watch_stop().await.unwrap();
        assert!(WATCH_PATHS.read().is_empty());
    }

    #[tokio::test]
    async fn watch_start_dedupes_duplicates() {
        plugin_watch_stop().await.unwrap();
        plugin_watch_start(WatchStartArgs {
            paths: vec!["/tmp/c".into(), "/tmp/c".into()],
        })
        .await
        .unwrap();
        assert_eq!(WATCH_PATHS.read().len(), 1);
        plugin_watch_stop().await.unwrap();
    }
}
