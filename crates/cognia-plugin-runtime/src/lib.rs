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
mod archive_limits;
pub mod backup;
pub mod cli_exec;
pub mod commands;
mod contained_path;
pub mod context_menu;
mod contract;
pub mod devtools;
pub mod error;
pub mod fs_watcher;
pub mod github;
pub mod lifecycle;
pub mod marketplace;
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

/// Least-privilege network rule mirrored from `manifest.networkAccess.rules`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkAccessRule {
    pub domain: String,
    pub methods: Vec<String>,
    pub paths: Vec<String>,
}

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

pub enum NodePluginProcessState {
    Launching {
        generation: uuid::Uuid,
    },
    Running {
        generation: uuid::Uuid,
        child: Arc<tokio::sync::Mutex<tokio::process::Child>>,
    },
}

/// Tauri-managed state for the plugin runtime. Cloning a field's `Arc` is
/// cheap; the lock granularity is per-field so map traversal doesn't block
/// permission grants and vice-versa.
pub struct PluginRuntimeState {
    pub plugins: Arc<RwLock<HashMap<String, PluginRecord>>>,
    pub permissions: Arc<RwLock<HashMap<String, Vec<PermissionGrant>>>>,
    /// Per-plugin network egress allowlist for `network:fetch`/`download`/
    /// `upload`, declared in `manifest.networkAccess.allowedDomains`. A plugin
    /// with no entry is denied; `["*"]` is the explicit unrestricted-host
    /// declaration and `["none"]`/empty denies all network.
    pub network_allowlist: Arc<RwLock<HashMap<String, Vec<String>>>>,
    /// Optional method/path rules. No map entry preserves legacy domain-only
    /// behavior; a present empty list denies every request.
    pub network_rules: Arc<RwLock<HashMap<String, Vec<NetworkAccessRule>>>>,
    pub plugin_install_dir: PathBuf,
    /// Host-owned metadata stored outside every individual plugin directory.
    /// Plugin filesystem grants are never allowed to overlap this tree.
    pub plugin_state_dir: PathBuf,
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
    /// Verified bundled Node plugin launch state keyed by plugin id. The renderer only
    /// receives an opaque lifecycle proxy and never imports Node APIs.
    pub node_plugin_processes: Arc<Mutex<HashMap<String, NodePluginProcessState>>>,
    /// Lazily-opened per-plugin SQLite connections for `ctx.db.*`, keyed by
    /// plugin id. Each plugin gets a single connection to its own
    /// `<plugin_dir>/data/plugin.db`; transactions ride that one connection as
    /// BEGIN/COMMIT/ROLLBACK statements. The inner `Mutex` serialises access so
    /// the connection (which is `!Sync`) can live in shared state.
    pub db_connections: Arc<RwLock<HashMap<String, Arc<Mutex<rusqlite::Connection>>>>>,
    /// Per-plugin allowlist of shell commands (program names) the plugin
    /// declared in its manifest `shellCommands`. DENY-by-default: a plugin with
    /// no entry — or an empty list — may execute NO command. This is the
    /// declarative half of the shell capability gate (the user-consent +
    /// `shell:execute` permission is the other half).
    pub shell_allowlist: Arc<RwLock<HashMap<String, Vec<String>>>>,
}

/// True when `program` matches an entry in `allowlist` by file stem.
/// DENY-by-default: an empty allowlist or empty program name yields `false`.
/// Matches on the file stem so a declared `git` tolerates `git` / `git.exe` /
/// an absolute path ending in `git`, but never an undeclared command. Shared
/// by the TS-plugin shell gate (`PluginRuntimeState::shell_command_allowed`)
/// and the WASM `process.exec` gate (`wasm::capabilities::process`) so both
/// enforce identical semantics from a single source of truth.
pub(crate) fn program_in_allowlist(allowlist: &[String], program: &str) -> bool {
    let stem = |s: &str| {
        std::path::Path::new(s.trim())
            .file_stem()
            .and_then(|x| x.to_str())
            .unwrap_or(s)
            .to_ascii_lowercase()
    };
    let prog = stem(program);
    if prog.is_empty() {
        return false;
    }
    allowlist
        .iter()
        .any(|c| !c.trim().is_empty() && stem(c) == prog)
}

impl PluginRuntimeState {
    /// Construct a fresh runtime state. `install_dir` is created lazily on
    /// first write — we don't fail construction if the parent doesn't yet
    /// exist (the parent is `<app_data>/cognia` which `dirs::data_dir()` may
    /// also report as `None` on stripped platforms).
    pub fn new(install_dir: PathBuf) -> Self {
        let plugin_state_dir = install_dir.join(".host-state");
        let state = Self {
            plugins: Arc::new(RwLock::new(HashMap::new())),
            permissions: Arc::new(RwLock::new(HashMap::new())),
            network_allowlist: Arc::new(RwLock::new(HashMap::new())),
            network_rules: Arc::new(RwLock::new(HashMap::new())),
            plugin_install_dir: install_dir,
            plugin_state_dir,
            fs_watchers: Arc::new(RwLock::new(HashMap::new())),
            shortcuts: Arc::new(RwLock::new(HashMap::new())),
            context_menus: Arc::new(RwLock::new(HashMap::new())),
            tray_items: Arc::new(RwLock::new(HashMap::new())),
            processes: Arc::new(RwLock::new(HashMap::new())),
            node_plugin_processes: Arc::new(Mutex::new(HashMap::new())),
            db_connections: Arc::new(RwLock::new(HashMap::new())),
            shell_allowlist: Arc::new(RwLock::new(HashMap::new())),
        };
        let recovery = marketplace::recover_update_transactions_for_state(&state);
        if recovery.recovered_transactions > 0 || recovery.discarded_transactions > 0 {
            log::info!(
                "recovered {} and discarded {} interrupted plugin update transactions",
                recovery.recovered_transactions,
                recovery.discarded_transactions
            );
        }
        for failure in recovery.failures {
            log::error!("{failure}");
        }
        state
    }

    /// Replace a plugin's declared shell-command allowlist (from its manifest
    /// `shellCommands`). Called by `plugin_set_shell_allowlist` at load.
    pub fn set_shell_allowlist(&self, plugin_id: &str, commands: Vec<String>) {
        self.shell_allowlist
            .write()
            .insert(plugin_id.to_string(), commands);
    }

    /// True when `program` is in the plugin's declared shell-command allowlist.
    /// DENY-by-default. Matches on the command's file stem so a plugin that
    /// declares `git` tolerates `git` / `git.exe` / an absolute path ending in
    /// `git`, but never a command the manifest never declared.
    pub fn shell_command_allowed(&self, plugin_id: &str, program: &str) -> bool {
        self.shell_allowlist
            .read()
            .get(plugin_id)
            .is_some_and(|cmds| program_in_allowlist(cmds, program))
    }

    /// Install directory for one plugin. `pub` (not `pub(crate)`) because the
    /// app-side cli_bridge install/uninstall handlers resolve target dirs
    /// through it (ADR-0067 extraction widened this from crate-private).
    pub fn plugin_dir(&self, plugin_id: &str) -> PathBuf {
        self.plugin_install_dir.join(sanitize_plugin_id(plugin_id))
    }

    pub(crate) fn plugin_host_state_dir(&self, plugin_id: &str) -> PathBuf {
        self.plugin_state_dir.join(sanitize_plugin_id(plugin_id))
    }

    /// True when the plugin holds a live (non-expired) grant for
    /// `permission`. Checks the in-memory ledger first and falls back to
    /// the host-owned permission ledger on cold-start, caching the result —
    /// mirroring `plugin_permission_list`. Used as the defense-in-depth
    /// gate by the `plugin_python_*` execution commands.
    pub fn has_permission(&self, plugin_id: &str, permission: &str) -> bool {
        let cached = self.permissions.read().get(plugin_id).cloned();
        let grants = match cached {
            Some(grants) => grants,
            None => {
                let from_disk = permissions::read_ledger(self, plugin_id).unwrap_or_default();
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

    /// Replace a plugin's declared network egress allowlist (from its manifest
    /// `networkAccess.allowedDomains`). Called by `plugin_set_network_allowlist`
    /// at load.
    pub fn set_network_allowlist(&self, plugin_id: &str, domains: Vec<String>) {
        self.network_allowlist
            .write()
            .insert(plugin_id.to_string(), domains);
    }

    /// Replace a plugin's HTTP method/path rules from its manifest.
    pub fn set_network_rules(&self, plugin_id: &str, rules: Vec<NetworkAccessRule>) {
        let mut policies = self.network_rules.write();
        if rules.is_empty() {
            policies.remove(plugin_id);
        } else {
            policies.insert(plugin_id.to_string(), rules);
        }
    }

    /// True when `host` is permitted for `plugin_id`. A plugin that DECLARED no
    /// allowlist (no map entry) is DENIED by default (fail-closed) — a
    /// `network:fetch` grant with no `networkAccess.allowedDomains` no longer
    /// implies unrestricted egress. A plugin that declared an allowlist is
    /// clamped: `["*"]` allows any host; `["none"]` or an empty list denies
    /// all; otherwise `host` must equal, or be a subdomain of, an entry. An
    /// empty host is always denied (fail-closed).
    pub fn network_host_allowed(&self, plugin_id: &str, host: &str) -> bool {
        let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
        if host.is_empty() {
            return false;
        }
        let map = self.network_allowlist.read();
        let Some(list) = map.get(plugin_id) else {
            return false; // no declaration → deny (fail-closed)
        };
        if list.iter().any(|e| e.trim() == "*") {
            return true;
        }
        list.iter().any(|entry| {
            let entry = entry.trim().trim_start_matches('.').to_ascii_lowercase();
            !entry.is_empty()
                && entry != "none"
                && (host == entry || host.ends_with(&format!(".{entry}")))
        })
    }

    /// Enforce the domain allowlist and, when declared, HTTP method/path rules.
    pub fn network_request_allowed(
        &self,
        plugin_id: &str,
        host: &str,
        method: &str,
        path: &str,
    ) -> bool {
        if !self.network_host_allowed(plugin_id, host) {
            return false;
        }
        let rules = self.network_rules.read();
        let Some(rules) = rules.get(plugin_id) else {
            return true;
        };
        let method = method.trim().to_ascii_uppercase();
        rules.iter().any(|rule| {
            host_matches_rule(host, &rule.domain)
                && rule
                    .methods
                    .iter()
                    .any(|candidate| candidate.trim().to_ascii_uppercase() == method)
                && rule
                    .paths
                    .iter()
                    .any(|pattern| wildcard_path_matches(path, pattern))
        })
    }
}

fn host_matches_rule(host: &str, domain: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let domain = domain.trim().trim_start_matches('.').to_ascii_lowercase();
    !host.is_empty()
        && (domain == "*"
            || (!domain.is_empty()
                && domain != "none"
                && (host == domain || host.ends_with(&format!(".{domain}")))))
}

fn wildcard_path_matches(path: &str, pattern: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    let mut cursor = 0usize;
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        let Some(offset) = path[cursor..].find(part) else {
            return false;
        };
        if index == 0 && !pattern.starts_with('*') && offset != 0 {
            return false;
        }
        cursor += offset + part.len();
    }
    pattern.ends_with('*') || cursor == path.len()
}

/// A missing expiry is live. Past or malformed timestamps fail closed; grant
/// revocation does not depend on this predicate, so corrupted ledgers never
/// need to be treated as authorized.
fn grant_expired(grant: &PermissionGrant) -> bool {
    match grant.expires_at.as_deref() {
        None => false,
        Some(raw) => chrono::DateTime::parse_from_rfc3339(raw)
            .map(|expiry| expiry < chrono::Utc::now())
            .unwrap_or(true),
    }
}

/// Allow only `[A-Za-z0-9._-]` in path components. Defense-in-depth against
/// `../`-style traversal in plugin IDs sourced from manifests.
///
/// NOTE: this rewrites rather than rejects, and it deliberately preserves `.`
/// — so it does **not** stop `""` / `"."` from composing into `"."` or `".."`.
/// Callers that build a filesystem path out of untrusted manifest fields must
/// use [`sanitize_plugin_id_strict`] instead.
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

pub(crate) fn validate_plugin_id_path_component(plugin_id: &str) -> Result<String> {
    if plugin_id.is_empty() {
        return Err(PluginError::InvalidArgument(
            "plugin id must be non-empty".into(),
        ));
    }
    if plugin_id.len() > 128 {
        return Err(PluginError::InvalidArgument(
            "plugin id must be at most 128 bytes".into(),
        ));
    }
    let bytes = plugin_id.as_bytes();
    let boundary_is_valid = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    if !boundary_is_valid(bytes[0])
        || !boundary_is_valid(bytes[bytes.len() - 1])
        || !bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
    {
        return Err(PluginError::InvalidArgument(
            "plugin id must match ^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$".into(),
        ));
    }
    Ok(plugin_id.to_string())
}

/// Maximum length of a single id component (`publisher` or `name`).
const MAX_ID_COMPONENT_LEN: usize = 64;

/// Rejection reason from [`sanitize_plugin_id_strict`].
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PluginIdError {
    #[error("`{component}` must not be empty")]
    Empty { component: &'static str },
    #[error("`{component}` value {value:?} is longer than 64 characters")]
    TooLong {
        component: &'static str,
        value: String,
    },
}

/// Safe counterpart of [`sanitize_plugin_id`] for a **single** id component
/// (`publisher` or `name`), for use wherever an untrusted manifest field
/// becomes a filesystem path.
///
/// This is the Rust twin of `safeIdComponent` in
/// `lib/plugin/vscode-shim/extension-id.ts`. Both derive the id from the same
/// untrusted `package.json` fields, and the id is both a Dexie key and a
/// directory name — if the rules drift, the row and the directory stop
/// describing the same extension. Keep them in lockstep.
///
/// Why this exists: [`sanitize_plugin_id`] rewrites hostile characters to `_`
/// but **keeps `.`**, and callers only checked that `publisher` / `name` were
/// JSON *strings* — `""` passes that. So `publisher: ""`, `name: "."` composed
/// into the id `".."`, and `install_root.join("..")` resolved outside the
/// extension root ahead of a recursive delete.
///
/// The change from [`sanitize_plugin_id`] is deliberately narrow: escape `.`
/// along with everything else outside `[A-Za-z0-9_-]`, and reject an empty
/// component. Emptiness must be an error rather than an escape, because
/// escaping `""` yields `""` and `""` + `""` composes into `"."`. With those
/// two rules the composition is safe *by construction* — no component can hold
/// `.`, `/`, or `\`, and none can be empty, so `format!("{publisher}.{name}")`
/// can never be `"."`, `".."`, or more than one path component.
pub(crate) fn sanitize_plugin_id_strict(
    component: &'static str,
    value: &str,
) -> std::result::Result<String, PluginIdError> {
    if value.is_empty() {
        return Err(PluginIdError::Empty { component });
    }
    if value.len() > MAX_ID_COMPONENT_LEN {
        return Err(PluginIdError::TooLong {
            component,
            value: value.to_string(),
        });
    }
    Ok(value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect())
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
    fn plugin_id_path_component_rejects_root_aliases_and_rewrites() {
        for value in [
            "",
            ".",
            "..",
            ".host-state",
            "_marketplace_cache",
            "_backups",
            "../escape",
            "a/b",
            "a\\b",
            "space id",
            "Uppercase",
            "trailing-",
        ] {
            assert!(
                validate_plugin_id_path_component(value).is_err(),
                "{value:?}"
            );
        }
        assert_eq!(
            validate_plugin_id_path_component("publisher.demo-plugin_1").unwrap(),
            "publisher.demo-plugin_1"
        );
    }

    #[test]
    fn strict_accepts_real_publisher_and_name_shapes() {
        for value in [
            "ms-python",
            "python",
            "rust-lang",
            "rust_analyzer",
            "a",
            "vscode9",
        ] {
            assert_eq!(
                sanitize_plugin_id_strict("name", value).unwrap(),
                value,
                "{value} should be accepted"
            );
        }
    }

    #[test]
    fn strict_rejects_empty_publisher_or_name() {
        assert_eq!(
            sanitize_plugin_id_strict("publisher", ""),
            Err(PluginIdError::Empty {
                component: "publisher"
            })
        );
    }

    #[test]
    fn strict_escapes_dots_instead_of_preserving_them() {
        // The one behavioural change from `sanitize_plugin_id`, and the whole
        // reason the escape exists: these are the inputs that used to survive
        // untouched and compose into `.` / `..`.
        assert_eq!(sanitize_plugin_id_strict("name", ".").unwrap(), "-");
        assert_eq!(sanitize_plugin_id_strict("name", "..").unwrap(), "--");
        assert_eq!(sanitize_plugin_id_strict("name", "a.b").unwrap(), "a-b");
    }

    #[test]
    fn strict_escapes_path_separators() {
        assert_eq!(
            sanitize_plugin_id_strict("name", "../etc/passwd").unwrap(),
            "---etc-passwd"
        );
        assert_eq!(sanitize_plugin_id_strict("name", "a\\b").unwrap(), "a-b");
    }

    #[test]
    fn strict_rejects_overlong_component() {
        let long = "a".repeat(65);
        assert!(sanitize_plugin_id_strict("name", &long).is_err());
        assert!(sanitize_plugin_id_strict("name", &"a".repeat(64)).is_ok());
    }

    /// The property the whole fix rests on: whatever a hostile manifest says,
    /// a component that survives can never make the composed id traverse.
    #[test]
    fn strict_composition_can_never_yield_a_relative_path_component() {
        let hostile = [
            "",
            ".",
            "..",
            "...",
            "a.b",
            "../../etc",
            "/abs",
            "a/b",
            "a\\b",
            ".hidden",
        ];
        for publisher in hostile {
            for name in hostile {
                let (Ok(p), Ok(n)) = (
                    sanitize_plugin_id_strict("publisher", publisher),
                    sanitize_plugin_id_strict("name", name),
                ) else {
                    continue; // rejected outright — also safe
                };
                let id = format!("{p}.{n}");
                assert_ne!(id, ".", "{publisher:?} + {name:?}");
                assert_ne!(id, "..", "{publisher:?} + {name:?}");
                assert!(!id.contains('/') && !id.contains('\\'));
                let path = std::path::Path::new(&id);
                assert_eq!(path.components().count(), 1, "{id:?} must be one component");
                assert!(
                    !matches!(
                        path.components().next(),
                        Some(std::path::Component::ParentDir)
                            | Some(std::path::Component::CurDir)
                            | Some(std::path::Component::RootDir)
                    ),
                    "{id:?} must not be a traversing component"
                );
            }
        }
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
        assert!(state.network_rules.read().is_empty());
    }

    #[test]
    fn network_host_allowed_undeclared_plugin_is_denied() {
        let state = PluginRuntimeState::new(PathBuf::from("/tmp"));
        // A plugin that declared no allowlist cannot reach any host — a
        // `network:fetch` grant alone no longer implies unrestricted egress
        // (fail-closed by default).
        assert!(!state.network_host_allowed("demo", "example.com"));
        assert!(!state.network_host_allowed("demo", "anything.test"));
        // An empty host is never allowed either.
        assert!(!state.network_host_allowed("demo", ""));
    }

    #[test]
    fn network_host_allowed_suffix_matches_subdomains_only() {
        let state = PluginRuntimeState::new(PathBuf::from("/tmp"));
        state.set_network_allowlist("demo", vec!["example.com".into()]);
        assert!(state.network_host_allowed("demo", "example.com"));
        assert!(state.network_host_allowed("demo", "api.example.com"));
        assert!(state.network_host_allowed("demo", "API.Example.Com")); // case-insensitive
        assert!(!state.network_host_allowed("demo", "evil.com"));
        // Must not match a host that merely ends with the string but isn't a subdomain.
        assert!(!state.network_host_allowed("demo", "notexample.com"));
        // The allowlist is per-plugin: another plugin with no declaration is
        // denied by default, not "unaffected".
        assert!(!state.network_host_allowed("other", "evil.com"));
    }

    #[test]
    fn network_host_allowed_wildcard_and_none_sentinels() {
        let state = PluginRuntimeState::new(PathBuf::from("/tmp"));
        state.set_network_allowlist("allowall", vec!["*".into()]);
        assert!(state.network_host_allowed("allowall", "anything.test"));
        state.set_network_allowlist("denyall", vec!["none".into()]);
        assert!(!state.network_host_allowed("denyall", "example.com"));
        // A declared-but-empty list denies all too.
        state.set_network_allowlist("empty", vec![]);
        assert!(!state.network_host_allowed("empty", "example.com"));
    }

    #[test]
    fn network_request_rules_enforce_method_path_and_domain() {
        let state = PluginRuntimeState::new(PathBuf::from("/tmp"));
        state.set_network_allowlist("demo", vec!["observability.example.com".into()]);
        state.set_network_rules(
            "demo",
            vec![NetworkAccessRule {
                domain: "observability.example.com".into(),
                methods: vec!["GET".into()],
                paths: vec!["/api/logs/*".into(), "/api/metrics".into()],
            }],
        );

        assert!(state.network_request_allowed(
            "demo",
            "observability.example.com",
            "GET",
            "/api/logs/recent"
        ));
        assert!(!state.network_request_allowed(
            "demo",
            "observability.example.com",
            "DELETE",
            "/api/logs/recent"
        ));
        assert!(!state.network_request_allowed(
            "demo",
            "observability.example.com",
            "GET",
            "/api/admin"
        ));
        assert!(!state.network_request_allowed("demo", "evil.example", "GET", "/api/logs/recent"));
    }

    #[test]
    fn absent_network_rules_preserve_legacy_domain_only_policy() {
        let state = PluginRuntimeState::new(PathBuf::from("/tmp"));
        state.set_network_allowlist("legacy", vec!["api.example.com".into()]);
        assert!(state.network_request_allowed("legacy", "api.example.com", "POST", "/any/path"));
    }

    fn make_grant(
        plugin_id: &str,
        permission: &str,
        expires_at: Option<String>,
    ) -> PermissionGrant {
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
        state.permissions.write().insert(
            "demo".into(),
            vec![make_grant("demo", "python:execute", None)],
        );
        assert!(state.has_permission("demo", "python:execute"));
        assert!(!state.has_permission("demo", "filesystem:write"));
    }

    #[test]
    fn has_permission_falls_back_to_disk_ledger() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = PluginRuntimeState::new(tmp.path().to_path_buf());
        let grants = vec![make_grant("demo", "python:execute", None)];
        let dir = state.plugin_host_state_dir("demo");
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
    fn has_permission_unparseable_expiry_fails_closed() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = PluginRuntimeState::new(tmp.path().to_path_buf());
        state.permissions.write().insert(
            "demo".into(),
            vec![make_grant(
                "demo",
                "python:execute",
                Some("not-a-date".into()),
            )],
        );
        assert!(!state.has_permission("demo", "python:execute"));
    }
}
