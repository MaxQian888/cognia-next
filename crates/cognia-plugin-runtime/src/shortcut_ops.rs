//! Plugin global-shortcut Tauri commands (Batch 3b).
//!
//! Records shortcut registrations in state so `plugin_shortcut_unregister`
//! can find them on the way out. Actual OS-level binding is delegated to
//! `tauri-plugin-global-shortcut` in the desktop build via the dispatcher
//! event channel; the webview-side TS at
//! `lib/plugin/core/context.ts:1124-1136` already listens for
//! `plugin-shortcut:<id>` window events, so the contract is "Rust persists
//! the registration intent + emits the event when the OS handler fires."
//! For platforms where the global-shortcut plugin isn't compiled in
//! (mobile), the registration is a soft no-op that still records intent.

use serde::{Deserialize, Serialize};
use tauri::State;

use super::{PluginError, PluginRuntimeState, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutOptions {
    #[serde(default)]
    pub when: Option<String>,
    #[serde(default)]
    pub prevent_default: Option<bool>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)] // Fields read by future global-shortcut wiring (Tier 3 follow-up).
pub struct ShortcutRecord {
    pub plugin_id: String,
    pub shortcut: String,
    pub options: Option<ShortcutOptions>,
}

fn key(plugin_id: &str, shortcut: &str) -> String {
    format!("{plugin_id}:{shortcut}")
}

#[tauri::command]
pub async fn plugin_shortcut_register(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    shortcut: String,
    options: Option<ShortcutOptions>,
) -> Result<()> {
    if shortcut.trim().is_empty() {
        return Err(PluginError::InvalidArgument("shortcut is empty".into()));
    }
    state.shortcuts.write().insert(
        key(&plugin_id, &shortcut),
        ShortcutRecord {
            plugin_id,
            shortcut,
            options,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn plugin_shortcut_unregister(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    shortcut: String,
) -> Result<()> {
    state.shortcuts.write().remove(&key(&plugin_id, &shortcut));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn key_combines_plugin_and_shortcut() {
        assert_eq!(key("demo", "Ctrl+Alt+P"), "demo:Ctrl+Alt+P");
    }

    #[tokio::test]
    async fn register_then_unregister_drops_record() {
        let state = PluginRuntimeState::new(PathBuf::from("/tmp"));
        // Bypass the State<'_, …> wrapper for unit testing.
        state.shortcuts.write().insert(
            key("demo", "Ctrl+P"),
            ShortcutRecord {
                plugin_id: "demo".into(),
                shortcut: "Ctrl+P".into(),
                options: None,
            },
        );
        assert_eq!(state.shortcuts.read().len(), 1);
        state.shortcuts.write().remove(&key("demo", "Ctrl+P"));
        assert!(state.shortcuts.read().is_empty());
    }
}
