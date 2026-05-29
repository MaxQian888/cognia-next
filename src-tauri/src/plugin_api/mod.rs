//! Plugin API — Rust-side handlers for the `plugin_*` Tauri commands invoked
//! by `lib/plugin/**` on the frontend.
//!
//! Closes the desktop-runtime gap documented in ADR 0016. The TS-side
//! `PluginManager` is the canonical "in-memory + IndexedDB" authority for
//! plugin metadata; this module is the "filesystem-side authority" that
//! persists install dirs, runtime state files, and the permission ledger
//! under `<app_data>/cognia/plugins/<plugin_id>/`.
//!
//! # Module layout
//!
//! - [`error`]       — `PluginError` + `Result<T>`.
//! - [`lifecycle`]   — load / enable / disable / unload / install / uninstall /
//!                     get_all / runtime_snapshot / set_state / get_state.
//! - [`permissions`] — grant / list / revoke.
//! - [`api_bridge`]  — generic `plugin_api_invoke` / `plugin_api_batch_invoke`
//!                     pass-through.
//! - [`commands`]    — re-exports for `tauri::generate_handler!`.
//!
//! # State model
//!
//! `PluginRuntimeState` is registered exactly once via `.manage()` in
//! `lib.rs` before the `.invoke_handler` call. Shared mutable maps use
//! `parking_lot::RwLock<HashMap<…>>` — no `dashmap` dep is needed because
//! the plugin runtime is low-frequency (sub-100 Hz).

pub mod api_bridge;
pub mod backup;
pub mod commands;
pub mod context_menu;
pub mod devtools;
pub mod error;
pub mod fs_watcher;
pub mod github;
pub mod lifecycle;
pub mod marketplace;
pub mod node_permission;
pub mod notification;
pub mod permissions;
pub mod process_ops;
pub mod shortcut_ops;
pub mod signature;
pub mod tray_items;
pub mod vscode;
pub mod wasm;
pub mod window_ops;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

pub use error::{PluginError, Result};

/// Snapshot of one plugin returned by `plugin_runtime_snapshot` and listed by
/// `plugin_get_all`. Kept minimal on purpose — TS owns rich metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginRuntimeSnapshot {
    pub plugin_id: String,
    pub version: String,
    pub status: String,
    pub last_error: Option<String>,
    pub loaded_at: Option<String>,
    pub install_path: String,
}

/// One persisted permission entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionGrant {
    pub plugin_id: String,
    pub permission: String,
    pub granted_by: String,
    pub granted_at: String,
    pub expires_at: Option<String>,
}

/// In-memory record for one plugin.
#[derive(Debug, Clone)]
pub struct PluginRecord {
    pub snapshot: PluginRuntimeSnapshot,
    /// Free-form runtime state blob managed via `plugin_set_state` /
    /// `plugin_get_state`. Mirrored to disk lazily on every set.
    pub runtime_state: serde_json::Value,
}

/// Tauri-managed state for the plugin runtime. Cloning a field's `Arc` is
/// cheap; the lock granularity is per-field so map traversal doesn't block
/// permission grants and vice-versa.
pub struct PluginRuntimeState {
    pub plugins: Arc<RwLock<HashMap<String, PluginRecord>>>,
    pub permissions: Arc<RwLock<HashMap<String, Vec<PermissionGrant>>>>,
    pub plugin_install_dir: PathBuf,
    /// Filesystem watchers keyed by `watch_id`. Holding a watcher in this
    /// map is what keeps it alive — dropping it cancels the watch.
    pub fs_watchers: Arc<RwLock<HashMap<String, notify::RecommendedWatcher>>>,
    /// Registered shortcuts keyed by `<plugin_id>:<shortcut>`.
    pub shortcuts: Arc<RwLock<HashMap<String, shortcut_ops::ShortcutRecord>>>,
    /// Registered context-menu items keyed by `<plugin_id>:<item.id>`.
    pub context_menus: Arc<RwLock<HashMap<String, context_menu::ContextMenuRecord>>>,
    /// Registered tray items keyed by `<plugin_id>:<item.id>`. Mirrors the
    /// context-menu pattern; the renderer merges these into the tray menu
    /// under "All Commands ▶ Plugins".
    pub tray_items: Arc<RwLock<HashMap<String, tray_items::TrayItemRecord>>>,
    /// Tracked spawned process IDs keyed by `process_id`.
    pub processes: Arc<RwLock<HashMap<String, process_ops::ProcessRecord>>>,
}

impl PluginRuntimeState {
    /// Construct a fresh runtime state. `install_dir` is created lazily on
    /// first write — we don't fail construction if the parent doesn't yet
    /// exist (the parent is `<app_data>/cognia` which `dirs::data_dir()` may
    /// also report as `None` on stripped platforms).
    pub fn new(install_dir: PathBuf) -> Self {
        Self {
            plugins: Arc::new(RwLock::new(HashMap::new())),
            permissions: Arc::new(RwLock::new(HashMap::new())),
            plugin_install_dir: install_dir,
            fs_watchers: Arc::new(RwLock::new(HashMap::new())),
            shortcuts: Arc::new(RwLock::new(HashMap::new())),
            context_menus: Arc::new(RwLock::new(HashMap::new())),
            tray_items: Arc::new(RwLock::new(HashMap::new())),
            processes: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub(crate) fn plugin_dir(&self, plugin_id: &str) -> PathBuf {
        self.plugin_install_dir.join(sanitize_plugin_id(plugin_id))
    }
}

/// Allow only `[A-Za-z0-9._-]` in path components. Defense-in-depth against
/// `../`-style traversal in plugin IDs sourced from manifests.
pub(crate) fn sanitize_plugin_id(plugin_id: &str) -> String {
    plugin_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_separators() {
        assert_eq!(sanitize_plugin_id("../etc/passwd"), ".._etc_passwd");
        assert_eq!(sanitize_plugin_id("ok.plugin-id_1"), "ok.plugin-id_1");
        assert_eq!(sanitize_plugin_id("a/b\\c"), "a_b_c");
    }

    #[test]
    fn plugin_dir_uses_sanitized_id() {
        let state = PluginRuntimeState::new(PathBuf::from("/tmp"));
        assert_eq!(state.plugin_dir("../boom").file_name().unwrap(), ".._boom");
    }

    #[test]
    fn state_starts_empty() {
        let state = PluginRuntimeState::new(PathBuf::from("/tmp"));
        assert!(state.plugins.read().is_empty());
        assert!(state.permissions.read().is_empty());
    }
}
