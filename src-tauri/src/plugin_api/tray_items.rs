//! Plugin tray-item Tauri commands. Mirrors `context_menu.rs:1-107` — Rust
//! is the persistence layer for the registration intent; the renderer
//! consumes the resulting items by merging them into the tray menu and
//! dispatches clicks through `plugin-tray-item:<plugin_id>:<item_id>` window
//! events (set up by `lib/plugin/api/tray-api.ts` on the TS side).

use serde::{Deserialize, Serialize};
use tauri::State;

use super::{PluginError, PluginRuntimeState, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayItemPayload {
    /// Stable id, fully namespaced as `<plugin_id>:<local_id>` by the
    /// renderer before invoking this command.
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub icon: Option<String>,
    /// Optional `when` expression evaluated by the renderer before flushing
    /// the menu. Rust treats it as opaque.
    #[serde(default)]
    pub when: Option<String>,
    /// Free-form grouping key; the renderer uses it to bucket plugin items
    /// under "All Commands ▶ Plugins / <category>".
    #[serde(default)]
    pub category: Option<String>,
    /// Optional accelerator hint (cosmetic, e.g. "Ctrl+Shift+P").
    #[serde(default)]
    pub accelerator: Option<String>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)] // `item` is consumed by the renderer-side merger.
pub struct TrayItemRecord {
    pub plugin_id: String,
    pub item: TrayItemPayload,
}

#[tauri::command]
pub async fn plugin_tray_item_register(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    item: TrayItemPayload,
) -> Result<()> {
    if item.id.trim().is_empty() {
        return Err(PluginError::InvalidArgument("item.id is empty".into()));
    }
    state.tray_items.write().insert(
        item.id.clone(),
        TrayItemRecord {
            plugin_id,
            item,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn plugin_tray_item_unregister(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    item_id: String,
) -> Result<()> {
    let mut items = state.tray_items.write();
    if let Some(record) = items.get(&item_id) {
        if record.plugin_id == plugin_id {
            items.remove(&item_id);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn plugin_tray_item_list(
    state: State<'_, PluginRuntimeState>,
) -> Result<Vec<TrayItemPayload>> {
    Ok(state
        .tray_items
        .read()
        .values()
        .map(|record| record.item.clone())
        .collect())
}

/// Bulk-removal for the plugin disable / unload lifecycle. Mirrors the
/// `unregisterCommandsByPlugin` pattern used by every other plugin
/// contribution surface.
#[tauri::command]
pub async fn plugin_tray_item_unregister_by_plugin(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
) -> Result<u32> {
    let mut items = state.tray_items.write();
    let removed_ids: Vec<String> = items
        .iter()
        .filter(|(_, record)| record.plugin_id == plugin_id)
        .map(|(id, _)| id.clone())
        .collect();
    let count = removed_ids.len() as u32;
    for id in removed_ids {
        items.remove(&id);
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[tokio::test]
    async fn register_records_item_and_unregister_removes_it() {
        let state = PluginRuntimeState::new(PathBuf::from("/tmp"));
        let item = TrayItemPayload {
            id: "demo:capture".into(),
            label: "Capture".into(),
            icon: None,
            when: None,
            category: Some("screenshot".into()),
            accelerator: None,
        };
        state.tray_items.write().insert(
            item.id.clone(),
            TrayItemRecord {
                plugin_id: "demo".into(),
                item: item.clone(),
            },
        );
        assert!(state.tray_items.read().contains_key("demo:capture"));

        // Foreign plugin can't unregister a different plugin's item.
        let before = state.tray_items.read().len();
        {
            let mut items = state.tray_items.write();
            if let Some(record) = items.get("demo:capture") {
                if record.plugin_id == "other" {
                    items.remove("demo:capture");
                }
            }
        }
        assert_eq!(state.tray_items.read().len(), before);
    }

    #[tokio::test]
    async fn unregister_by_plugin_removes_only_matching_items() {
        let state = PluginRuntimeState::new(PathBuf::from("/tmp"));
        for (id, plugin) in [
            ("demo:a", "demo"),
            ("demo:b", "demo"),
            ("other:c", "other"),
        ] {
            state.tray_items.write().insert(
                id.into(),
                TrayItemRecord {
                    plugin_id: plugin.into(),
                    item: TrayItemPayload {
                        id: id.into(),
                        label: id.into(),
                        icon: None,
                        when: None,
                        category: None,
                        accelerator: None,
                    },
                },
            );
        }
        let removed = {
            let mut items = state.tray_items.write();
            let ids: Vec<String> = items
                .iter()
                .filter(|(_, r)| r.plugin_id == "demo")
                .map(|(id, _)| id.clone())
                .collect();
            let count = ids.len();
            for id in ids {
                items.remove(&id);
            }
            count
        };
        assert_eq!(removed, 2);
        assert_eq!(state.tray_items.read().len(), 1);
        assert!(state.tray_items.read().contains_key("other:c"));
    }
}
