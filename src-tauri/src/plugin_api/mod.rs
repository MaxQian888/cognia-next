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
pub mod cli_exec;
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
pub mod python;
pub mod scan;
pub mod shortcut_ops;
pub mod signature;
pub mod tray_items;
pub mod vscode;
pub mod wasm;
pub mod window_ops;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
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
    /// Host-resident network domain allowlist for `network:fetch`. Each entry
    /// is a host suffix (`example.com` matches `api.example.com`). Empty means
    /// "no host restriction" — a plugin holding the `network:fetch` grant may
    /// reach any host. An operator populates this to clamp plugin egress.
    pub network_allowlist: Arc<RwLock<Vec<String>>>,
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
    /// Lazily-opened per-plugin SQLite connections for `ctx.db.*`, keyed by
    /// plugin id. Each plugin gets a single connection to its own
    /// `<plugin_dir>/data/plugin.db`; transactions ride that one connection as
    /// BEGIN/COMMIT/ROLLBACK statements. The inner `Mutex` serialises access so
    /// the connection (which is `!Sync`) can live in shared state.
    pub db_connections: Arc<RwLock<HashMap<String, Arc<Mutex<rusqlite::Connection>>>>>,
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
            network_allowlist: Arc::new(RwLock::new(Vec::new())),
            plugin_install_dir: install_dir,
            fs_watchers: Arc::new(RwLock::new(HashMap::new())),
            shortcuts: Arc::new(RwLock::new(HashMap::new())),
            context_menus: Arc::new(RwLock::new(HashMap::new())),
            tray_items: Arc::new(RwLock::new(HashMap::new())),
            processes: Arc::new(RwLock::new(HashMap::new())),
            db_connections: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub(crate) fn plugin_dir(&self, plugin_id: &str) -> PathBuf {
        self.plugin_install_dir.join(sanitize_plugin_id(plugin_id))
    }

    /// True when the plugin holds a live (non-expired) grant for
    /// `permission`. Checks the in-memory ledger first and falls back to
    /// the on-disk `permissions.json` on cold-start, caching the result —
    /// mirroring `plugin_permission_list`. Used as the defense-in-depth
    /// gate by the `plugin_python_*` execution commands.
    pub fn has_permission(&self, plugin_id: &str, permission: &str) -> bool {
        let cached = self.permissions.read().get(plugin_id).cloned();
        let grants = match cached {
            Some(grants) => grants,
            None => {
                let from_disk =
                    permissions::read_ledger(self, plugin_id).unwrap_or_default();
                if !from_disk.is_empty() {
                    self.permissions
                        .write()
                        .insert(plugin_id.to_string(), from_disk.clone());
                }
                from_disk
            }
        };
        grants
            .iter()
            .any(|g| g.permission == permission && !grant_expired(g))
    }

    /// True when `host` is permitted by the network allowlist. An empty
    /// allowlist imposes no host restriction (the `network:fetch` grant is the
    /// boundary); otherwise `host` must equal, or be a subdomain of, an entry.
    pub fn network_host_allowed(&self, host: &str) -> bool {
        let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
        if host.is_empty() {
            return false;
        }
        let list = self.network_allowlist.read();
        if list.is_empty() {
            return true;
        }
        list.iter().any(|entry| {
            let entry = entry.trim().trim_start_matches('.').to_ascii_lowercase();
            !entry.is_empty() && (host == entry || host.ends_with(&format!(".{entry}")))
        })
    }
}

/// A grant with a parseable past `expires_at` is expired; absent or
/// unparseable timestamps mean "no expiry" (matches the lenient ledger
/// semantics — corrupted dates must not lock users out of revocation).
fn grant_expired(grant: &PermissionGrant) -> bool {
    match grant.expires_at.as_deref() {
        None => false,
        Some(raw) => chrono::DateTime::parse_from_rfc3339(raw)
            .map(|expiry| expiry < chrono::Utc::now())
            .unwrap_or(false),
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
        assert!(state.network_allowlist.read().is_empty());
    }

    #[test]
    fn network_host_allowed_empty_list_allows_any_nonempty_host() {
        let state = PluginRuntimeState::new(PathBuf::from("/tmp"));
        assert!(state.network_host_allowed("example.com"));
        assert!(state.network_host_allowed("anything.test"));
        // An empty host is never allowed (fail-closed).
        assert!(!state.network_host_allowed(""));
    }

    #[test]
    fn network_host_allowed_suffix_matches_subdomains_only() {
        let state = PluginRuntimeState::new(PathBuf::from("/tmp"));
        state.network_allowlist.write().push("example.com".into());
        assert!(state.network_host_allowed("example.com"));
        assert!(state.network_host_allowed("api.example.com"));
        assert!(state.network_host_allowed("API.Example.Com")); // case-insensitive
        assert!(!state.network_host_allowed("evil.com"));
        // Must not match a host that merely ends with the string but isn't a subdomain.
        assert!(!state.network_host_allowed("notexample.com"));
    }

    fn make_grant(plugin_id: &str, permission: &str, expires_at: Option<String>) -> PermissionGrant {
        PermissionGrant {
            plugin_id: plugin_id.into(),
            permission: permission.into(),
            granted_by: "test".into(),
            granted_at: chrono::Utc::now().to_rfc3339(),
            expires_at,
        }
    }

    #[test]
    fn has_permission_false_when_empty() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = PluginRuntimeState::new(tmp.path().to_path_buf());
        assert!(!state.has_permission("demo", "python:execute"));
    }

    #[test]
    fn has_permission_true_after_in_memory_grant() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = PluginRuntimeState::new(tmp.path().to_path_buf());
        state
            .permissions
            .write()
            .insert("demo".into(), vec![make_grant("demo", "python:execute", None)]);
        assert!(state.has_permission("demo", "python:execute"));
        assert!(!state.has_permission("demo", "filesystem:write"));
    }

    #[test]
    fn has_permission_falls_back_to_disk_ledger() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = PluginRuntimeState::new(tmp.path().to_path_buf());
        let grants = vec![make_grant("demo", "python:execute", None)];
        let dir = state.plugin_dir("demo");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("permissions.json"),
            serde_json::to_vec(&grants).unwrap(),
        )
        .unwrap();

        assert!(state.has_permission("demo", "python:execute"));
        // Disk read is cached into the in-memory ledger.
        assert!(state.permissions.read().contains_key("demo"));
    }

    #[test]
    fn has_permission_expired_grant_is_false() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = PluginRuntimeState::new(tmp.path().to_path_buf());
        state.permissions.write().insert(
            "demo".into(),
            vec![make_grant(
                "demo",
                "python:execute",
                Some("2000-01-01T00:00:00Z".into()),
            )],
        );
        assert!(!state.has_permission("demo", "python:execute"));
    }

    #[test]
    fn has_permission_future_expiry_is_true() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = PluginRuntimeState::new(tmp.path().to_path_buf());
        state.permissions.write().insert(
            "demo".into(),
            vec![make_grant(
                "demo",
                "python:execute",
                Some("2999-01-01T00:00:00Z".into()),
            )],
        );
        assert!(state.has_permission("demo", "python:execute"));
    }

    #[test]
    fn has_permission_unparseable_expiry_is_lenient() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = PluginRuntimeState::new(tmp.path().to_path_buf());
        state.permissions.write().insert(
            "demo".into(),
            vec![make_grant("demo", "python:execute", Some("not-a-date".into()))],
        );
        assert!(state.has_permission("demo", "python:execute"));
    }
}
