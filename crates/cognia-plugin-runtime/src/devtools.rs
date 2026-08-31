//! Plugin devtools Tauri commands (Batch 3d, gated behind `debug_assertions`).
//!
//! These handlers back the in-app plugin developer experience: a hot-reload
//! file watcher, a small dev-server status surface, and a `plugin_reload`
//! command that emits a `plugin-hot-reload:<pluginId>` event the TS side
//! listens for.
//!
//! ADR 0016 P1-7 (2026-05-17) — `plugin_watch_start` / `plugin_dev_server_watch`
//! now hold a real `notify::RecommendedWatcher` instead of a stub
//! `Vec<PathBuf>`. Filesystem events emit `plugin:file-change` with the same
//! payload shape `lib/plugin/devtools/file-watch.ts` expects.

use std::path::{Path, PathBuf};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use super::{PluginError, PluginRuntimeState, Result};

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

/// Active filesystem watchers. We keep a small handful — one for the
/// top-level `plugin_watch_start` (driven by `file-watch.ts`) and a per-id
/// map for `plugin_dev_server_watch` (driven by `dev-server.ts`).
struct WatcherState {
    /// Holds the single watcher created by `plugin_watch_start`. Dropping it
    /// stops the underlying file-system event stream.
    global: Option<RecommendedWatcher>,
    /// Holds watchers created by `plugin_dev_server_watch`, keyed by
    /// `pluginId` so each plugin can be unwatched independently.
    per_plugin: std::collections::HashMap<String, RecommendedWatcher>,
    /// Mirror of the watched paths so the existing tests + introspection
    /// callers can still see what's being watched.
    paths: Vec<PathBuf>,
}

impl WatcherState {
    fn empty() -> Self {
        Self {
            global: None,
            per_plugin: std::collections::HashMap::new(),
            paths: Vec::new(),
        }
    }
}

static WATCHERS: once_cell::sync::Lazy<Mutex<WatcherState>> =
    once_cell::sync::Lazy::new(|| Mutex::new(WatcherState::empty()));

/// Test-only accessor: number of currently-watched paths. The previous
/// stub-based tests inspected `WATCH_PATHS.read().len()`; mirror that surface
/// here without exposing the watcher state directly.
#[cfg(test)]
fn watched_path_count() -> usize {
    WATCHERS.lock().paths.len()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangePayload {
    /// "create" | "modify" | "delete" | "rename". Matches the type union in
    /// `lib/plugin/devtools/file-watch.ts`.
    #[serde(rename = "type")]
    pub kind: String,
    pub path: String,
    /// Milliseconds since UNIX epoch — the TS handler reads this to skip
    /// stale events queued during reload.
    pub timestamp: u64,
}

impl FileChangePayload {
    fn from_event(event: &notify::Event) -> Vec<Self> {
        let kind = match event.kind {
            notify::EventKind::Create(_) => "create",
            notify::EventKind::Modify(notify::event::ModifyKind::Name(_)) => "rename",
            notify::EventKind::Modify(_) => "modify",
            notify::EventKind::Remove(_) => "delete",
            _ => "modify",
        };
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        event
            .paths
            .iter()
            .map(|p| Self {
                kind: kind.into(),
                path: p.to_string_lossy().into_owned(),
                timestamp,
            })
            .collect()
    }
}

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
    /// Either a single `path` (typical TS call shape) or an array.
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub paths: Option<Vec<String>>,
}

#[tauri::command]
pub async fn plugin_dev_server_watch(app: AppHandle, args: DevServerWatchArgs) -> Result<()> {
    let plugin_id = args.plugin_id.clone().unwrap_or_default();
    let mut paths: Vec<String> = Vec::new();
    if let Some(p) = args.path {
        paths.push(p);
    }
    if let Some(ps) = args.paths {
        paths.extend(ps);
    }
    if paths.is_empty() {
        return Ok(());
    }
    let watcher = start_watcher(&app, paths.clone())?;
    let mut state = WATCHERS.lock();
    if !plugin_id.is_empty() {
        // Replace any previous watcher for this plugin id — re-watching the
        // same plugin replaces its old watcher cleanly.
        state.per_plugin.insert(plugin_id.clone(), watcher);
    } else {
        // No plugin id supplied — fall back to global slot. Caller is
        // responsible for not double-binding.
        state.global = Some(watcher);
    }
    for p in paths {
        let pb = PathBuf::from(p);
        if !state.paths.contains(&pb) {
            state.paths.push(pb);
        }
    }
    log::debug!(
        "plugin_dev_server_watch: plugin={} watches={}",
        plugin_id,
        state.paths.len()
    );
    Ok(())
}

#[tauri::command]
pub async fn plugin_dev_server_unwatch(plugin_id: String) -> Result<()> {
    let mut state = WATCHERS.lock();
    state.per_plugin.remove(&plugin_id);
    log::debug!("plugin_dev_server_unwatch: plugin={}", plugin_id);
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStartArgs {
    pub paths: Vec<String>,
}

#[tauri::command]
pub async fn plugin_watch_start(app: AppHandle, args: WatchStartArgs) -> Result<()> {
    if args.paths.is_empty() {
        return Ok(());
    }
    let watcher = start_watcher(&app, args.paths.clone())?;
    let mut state = WATCHERS.lock();
    state.global = Some(watcher);
    for p in args.paths {
        let pb = PathBuf::from(p);
        if !state.paths.contains(&pb) {
            state.paths.push(pb);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn plugin_watch_stop() -> Result<()> {
    let mut state = WATCHERS.lock();
    // Dropping the watchers stops the underlying file-system event stream.
    state.global = None;
    state.per_plugin.clear();
    state.paths.clear();
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

// ---- helpers ----------------------------------------------------------------

/// Create a `notify::RecommendedWatcher` that emits `plugin:file-change`
/// events on the given Tauri app. Each filesystem event is converted into one
/// or more `FileChangePayload` entries and broadcast to the renderer.
fn start_watcher(app: &AppHandle, paths: Vec<String>) -> Result<RecommendedWatcher> {
    let app_for_watcher = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            for payload in FileChangePayload::from_event(&event) {
                let _ = app_for_watcher.emit("plugin:file-change", payload);
            }
        }
    })
    .map_err(|e| PluginError::Internal(format!("notify init failed: {e}")))?;
    for path in paths {
        watcher
            .watch(Path::new(&path), RecursiveMode::Recursive)
            .map_err(|e| PluginError::Internal(format!("watch start failed for {path}: {e}")))?;
    }
    Ok(watcher)
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

    #[test]
    fn payload_kind_from_create_event() {
        let event = notify::Event {
            kind: notify::EventKind::Create(notify::event::CreateKind::File),
            paths: vec![std::path::PathBuf::from("/tmp/x")],
            attrs: notify::event::EventAttributes::default(),
        };
        let payloads = FileChangePayload::from_event(&event);
        assert_eq!(payloads.len(), 1);
        assert_eq!(payloads[0].kind, "create");
        assert!(payloads[0].path.ends_with("x"));
        assert!(payloads[0].timestamp > 0);
    }

    #[test]
    fn payload_kind_from_modify_event() {
        let event = notify::Event {
            kind: notify::EventKind::Modify(notify::event::ModifyKind::Any),
            paths: vec![std::path::PathBuf::from("/tmp/y")],
            attrs: notify::event::EventAttributes::default(),
        };
        let payloads = FileChangePayload::from_event(&event);
        assert_eq!(payloads[0].kind, "modify");
    }

    #[test]
    fn payload_kind_from_remove_event() {
        let event = notify::Event {
            kind: notify::EventKind::Remove(notify::event::RemoveKind::Any),
            paths: vec![std::path::PathBuf::from("/tmp/z")],
            attrs: notify::event::EventAttributes::default(),
        };
        let payloads = FileChangePayload::from_event(&event);
        assert_eq!(payloads[0].kind, "delete");
    }

    #[test]
    fn payload_kind_from_rename_event_is_rename_not_modify() {
        // notify reports renames as Modify(Name(...)); the TS contract
        // distinguishes "rename" from "modify" so we must map separately.
        let event = notify::Event {
            kind: notify::EventKind::Modify(notify::event::ModifyKind::Name(
                notify::event::RenameMode::To,
            )),
            paths: vec![std::path::PathBuf::from("/tmp/w")],
            attrs: notify::event::EventAttributes::default(),
        };
        let payloads = FileChangePayload::from_event(&event);
        assert_eq!(payloads[0].kind, "rename");
    }

    #[tokio::test]
    async fn watch_stop_clears_global_and_per_plugin_watchers() {
        // Build state directly — we can't construct a real AppHandle in unit
        // tests, but the stop path only touches the WATCHERS mutex.
        {
            let mut state = WATCHERS.lock();
            state.paths.push(PathBuf::from("/tmp/a"));
            state.paths.push(PathBuf::from("/tmp/b"));
            // We can't construct a RecommendedWatcher without notify init,
            // but the state.global / per_plugin only matter for the side
            // effects of dropping — leaving them None is fine for this test.
        }
        assert_eq!(watched_path_count(), 2);
        plugin_watch_stop().await.unwrap();
        assert_eq!(watched_path_count(), 0);
    }
}
