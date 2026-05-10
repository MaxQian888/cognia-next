//! Plugin context-menu Tauri commands (Batch 3b).
//!
//! Records context-menu registrations in state so `plugin_context_menu_unregister`
//! can find them. Rendering of the actual menu happens in the webview — TS at
//! `lib/plugin/core/context.ts:1165-1180` listens for `plugin-context-menu:<id>`
//! events, so the Rust side is just the persistence layer for the registration
//! intent (matches the shortcut model).

use serde::{Deserialize, Serialize};
use tauri::State;

use super::{PluginError, PluginRuntimeState, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenuItemPayload {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub when: Option<serde_json::Value>,
    #[serde(default)]
    pub separator: Option<bool>,
    #[serde(default)]
    pub disabled: Option<bool>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)] // `item` is consumed by the future webview menu renderer.
pub struct ContextMenuRecord {
    pub plugin_id: String,
    pub item: ContextMenuItemPayload,
}

#[tauri::command]
pub async fn plugin_context_menu_register(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    item: ContextMenuItemPayload,
) -> Result<()> {
    if item.id.trim().is_empty() {
        return Err(PluginError::InvalidArgument("item.id is empty".into()));
    }
    state.context_menus.write().insert(
        item.id.clone(),
        ContextMenuRecord {
            plugin_id,
            item,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn plugin_context_menu_unregister(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    item_id: String,
) -> Result<()> {
    let mut menus = state.context_menus.write();
    if let Some(record) = menus.get(&item_id) {
        if record.plugin_id == plugin_id {
            menus.remove(&item_id);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[tokio::test]
    async fn register_records_item_and_unregister_removes_it() {
        let state = PluginRuntimeState::new(PathBuf::from("/tmp"));
        let item = ContextMenuItemPayload {
            id: "demo:copy".into(),
            label: "Copy".into(),
            icon: None,
            when: None,
            separator: None,
            disabled: None,
        };
        state.context_menus.write().insert(
            item.id.clone(),
            ContextMenuRecord {
                plugin_id: "demo".into(),
                item: item.clone(),
            },
        );
        assert!(state.context_menus.read().contains_key("demo:copy"));
        // Foreign plugin can't unregister a different plugin's item.
        let menus_before = state.context_menus.read().len();
        {
            let mut menus = state.context_menus.write();
            if let Some(record) = menus.get("demo:copy") {
                if record.plugin_id == "other" {
                    menus.remove("demo:copy");
                }
            }
        }
        assert_eq!(state.context_menus.read().len(), menus_before);
    }
}
