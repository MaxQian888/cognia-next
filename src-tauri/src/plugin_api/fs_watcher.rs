//! Filesystem watcher Tauri commands (Batch 3b).
//!
//! TS-side at `lib/plugin/core/context.ts:869-889` calls
//! `invoke('plugin_fs_watch', { pluginId, path, watchId })` and listens for
//! `plugin-fs-watch:<watchId>` events on `window`. We wire the `notify`
//! crate to emit those exact event names so the existing TS contract works
//! unchanged.

use std::path::Path;

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::{PluginError, PluginRuntimeState, Result};

#[derive(Debug, Clone, Serialize)]
pub struct FsWatchPayload {
    pub kind: String,
    pub path: String,
}

impl FsWatchPayload {
    fn from_event(event: &notify::Event) -> Vec<Self> {
        let kind = match event.kind {
            notify::EventKind::Create(_) => "create",
            notify::EventKind::Modify(_) => "modify",
            notify::EventKind::Remove(_) => "delete",
            _ => "any",
        };
        event
            .paths
            .iter()
            .map(|p| Self {
                kind: kind.into(),
                path: p.to_string_lossy().into_owned(),
            })
            .collect()
    }
}

#[tauri::command]
pub async fn plugin_fs_watch(
    state: State<'_, PluginRuntimeState>,
    app: AppHandle,
    plugin_id: String,
    path: String,
    watch_id: String,
) -> Result<()> {
    if watch_id.trim().is_empty() {
        return Err(PluginError::InvalidArgument("watch_id is empty".into()));
    }
    let event_name = format!("plugin-fs-watch:{}", watch_id);
    let app_for_watcher = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            for payload in FsWatchPayload::from_event(&event) {
                let _ = app_for_watcher.emit(&event_name, payload);
            }
        }
    })
    .map_err(|e| PluginError::Internal(format!("notify init failed: {e}")))?;
    watcher
        .watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| PluginError::Internal(format!("watch start failed: {e}")))?;
    state.fs_watchers.write().insert(watch_id.clone(), watcher);
    log::debug!("plugin_fs_watch: plugin={} watch={} path={}", plugin_id, watch_id, path);
    Ok(())
}

#[tauri::command]
pub async fn plugin_fs_unwatch(
    state: State<'_, PluginRuntimeState>,
    watch_id: String,
) -> Result<()> {
    state.fs_watchers.write().remove(&watch_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_kind_from_create_event() {
        let event = notify::Event {
            kind: notify::EventKind::Create(notify::event::CreateKind::File),
            paths: vec![std::path::PathBuf::from("/tmp/x")],
            attrs: notify::event::EventAttributes::default(),
        };
        let payloads = FsWatchPayload::from_event(&event);
        assert_eq!(payloads.len(), 1);
        assert_eq!(payloads[0].kind, "create");
        assert!(payloads[0].path.ends_with("x"));
    }

    #[test]
    fn payload_kind_from_modify_event() {
        let event = notify::Event {
            kind: notify::EventKind::Modify(notify::event::ModifyKind::Any),
            paths: vec![std::path::PathBuf::from("/tmp/y")],
            attrs: notify::event::EventAttributes::default(),
        };
        let payloads = FsWatchPayload::from_event(&event);
        assert_eq!(payloads[0].kind, "modify");
    }

    #[test]
    fn payload_kind_from_remove_event() {
        let event = notify::Event {
            kind: notify::EventKind::Remove(notify::event::RemoveKind::Any),
            paths: vec![std::path::PathBuf::from("/tmp/z")],
            attrs: notify::event::EventAttributes::default(),
        };
        let payloads = FsWatchPayload::from_event(&event);
        assert_eq!(payloads[0].kind, "delete");
    }
}
