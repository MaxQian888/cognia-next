//! ADR-0067 Tier C facade — the OpenCode history reader moved to
//! [`cognia_agent_state::session_import`]; only the Tauri command shell stays
//! here, matching the `recovery` / `proxy_config` / `keyring_secrets` pattern.
//!
//! Keeping the shell app-side is what lets `cognia-agent-state` stay tauri-free
//! for `bin/cognia-server.rs` and for the ACP session registry that Batch 4
//! will path-dep onto it.

use cognia_agent_state::session_import::{SessionHistoryFsOperation, SessionHistoryFsResult};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::Manager as _;

/// Native-owned history locations, mirroring the registered desktop adapters.
/// No broad vendor config root is granted; OpenCode uses its SQLite reader and
/// Aider is picker-only. Keep this separate from the writable workspace scope.
fn history_read_roots(
    home: Option<&Path>,
    roots: &crate::agents::paths::VendorRoots,
) -> Vec<PathBuf> {
    let base = |value: &str, fallback: &str| {
        if value.is_empty() {
            home.map(|home| home.join(fallback))
        } else {
            Some(PathBuf::from(value))
        }
    };
    let mut result = Vec::new();
    for (root, children) in [
        (
            base(&roots.claude_config_dir, ".claude"),
            &["projects", "teams", "tasks"][..],
        ),
        (base(&roots.codex_home, ".codex"), &["sessions"][..]),
        (base(&roots.gemini_dir, ".gemini"), &["tmp"][..]),
        (base(&roots.continue_dir, ".continue"), &["sessions"][..]),
        (
            base(&roots.cursor_dir, ".cursor"),
            &["chats", "subagents"][..],
        ),
    ] {
        if let Some(root) = root {
            result.extend(children.iter().map(|child| root.join(child)));
        }
    }
    if !roots.pi_session_dir.is_empty() {
        result.push(PathBuf::from(&roots.pi_session_dir));
    } else if let Some(root) = base(&roots.pi_agent_dir, ".pi/agent") {
        result.push(root.join("sessions"));
    }
    if let Some(home) = home {
        for relative in [
            ".cline/sessions",
            ".cline/data",
            ".copilot/session-state",
            ".qwen/sessions",
            ".qwen/tmp",
            ".qwen/projects",
            "Library/Application Support/Cursor/User/workspaceStorage",
            ".config/Cursor/User/workspaceStorage",
            "AppData/Roaming/Cursor/User/workspaceStorage",
            "Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev",
            ".config/Code/User/globalStorage/saoudrizwan.claude-dev",
            "AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev",
        ] {
            result.push(home.join(relative));
        }
    }
    result.retain(|root| root.is_absolute());
    result.sort();
    result.dedup();
    result
}

fn history_ui_allowed(label: &str, url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
    if label != "main" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let packaged = url.port().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")));
    let development = dev_url.is_some_and(|dev| {
        matches!(url.scheme(), "http" | "https")
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
            && url.origin() == dev.origin()
    });
    packaged || development
}

/// Scoped read-only history I/O. Deliberately local UI only: no companion RPC
/// registration and no plugin-fs global scope (which would also widen writes).
#[tauri::command]
pub async fn session_import_fs(
    webview: tauri::Webview,
    operation: SessionHistoryFsOperation,
    path: String,
) -> Result<SessionHistoryFsResult, String> {
    let url = webview.url().map_err(|error| error.to_string())?;
    let dev_url = if cfg!(debug_assertions) {
        webview.app_handle().config().build.dev_url.as_ref()
    } else {
        None
    };
    if !history_ui_allowed(webview.label(), &url, dev_url) {
        return Err("session history reads are restricted to the local main app view".into());
    }
    let roots = history_read_roots(
        dirs::home_dir().as_deref(),
        &crate::agents::paths::vendor_roots(),
    );
    tauri::async_runtime::spawn_blocking(move || {
        cognia_agent_state::session_import::session_history_fs(operation, Path::new(&path), &roots)
    })
    .await
    .map_err(|error| format!("history filesystem task failed: {error}"))?
}

/// Read every OpenCode session from the local SQLite store. A missing install
/// returns []; existing corrupt, unreadable or unsupported stores return errors.
#[tauri::command]
pub fn opencode_sessions_read(home: String) -> Result<Vec<Value>, String> {
    cognia_agent_state::session_import::read_opencode_sessions(home)
}

/// Read-only SQLite projection for Cursor, Cline, and Copilot CLI histories.
#[tauri::command]
pub fn external_agent_sessions_read(source: String, home: String) -> Result<Vec<Value>, String> {
    let actual_home =
        dirs::home_dir().ok_or_else(|| "user home directory unavailable".to_string())?;
    if std::path::Path::new(&home) != actual_home {
        return Err("external session store root must match the current user home".into());
    }
    cognia_agent_state::session_import::read_external_agent_sessions(source, home)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_roots_match_history_only_and_honor_relocation_without_globs() {
        use crate::agents::paths::{vendor_roots_from, RootEnv};
        let home = Path::new("/home/user");
        let roots = vendor_roots_from(
            RootEnv {
                claude_config_dir: Some("/relocated/claude[*?]".into()),
                codex_home: Some("/relocated/codex".into()),
                pi_coding_agent_session_dir: Some("/relocated/pi-history".into()),
                ..Default::default()
            },
            Some(home.into()),
            None,
            None,
            false,
        );
        let allowed = history_read_roots(Some(home), &roots);
        for path in [
            "/relocated/claude[*?]/projects",
            "/relocated/claude[*?]/teams",
            "/relocated/claude[*?]/tasks",
            "/relocated/codex/sessions",
            "/relocated/pi-history",
            "/home/user/.qwen/projects",
            "/home/user/.copilot/session-state",
            "/home/user/.gemini/tmp",
            "/home/user/.continue/sessions",
        ] {
            assert!(allowed.contains(&PathBuf::from(path)), "missing {path}");
        }
        for path in [
            "/home/user",
            "/relocated/claude[*?]/credentials.json",
            "/relocated/codex/auth.json",
            "/home/user/.ssh/id_rsa",
            "/home/user/.pi/agent/auth.json",
            "/home/user/.qwen/settings.json",
            "/home/user/.cline/auth.json",
        ] {
            assert!(
                !allowed.iter().any(|root| Path::new(path).starts_with(root)),
                "overbroad root for {path}"
            );
        }
        assert!(!allowed.contains(&home.join(".claude/projects")));
    }

    #[test]
    fn history_roots_do_not_invent_relative_roots_without_home() {
        use crate::agents::paths::{vendor_roots_from, RootEnv};
        let roots = vendor_roots_from(RootEnv::default(), None, None, None, false);
        assert!(history_read_roots(None, &roots).is_empty());
        let roots = vendor_roots_from(
            RootEnv {
                pi_coding_agent_session_dir: Some("/custom/sessions".into()),
                ..Default::default()
            },
            None,
            None,
            None,
            false,
        );
        assert_eq!(
            history_read_roots(None, &roots),
            [PathBuf::from("/custom/sessions")]
        );
    }

    #[test]
    fn history_ui_gate_excludes_remote_and_embedded_views() {
        let dev: tauri::Url = "http://localhost:3000".parse().unwrap();
        for url in [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
        ] {
            assert!(history_ui_allowed("main", &url.parse().unwrap(), None));
            assert!(!history_ui_allowed(
                "browser-tab",
                &url.parse().unwrap(),
                None
            ));
        }
        assert!(history_ui_allowed("main", &dev, Some(&dev)));
        assert!(!history_ui_allowed("main", &dev, None));
        for url in [
            "https://example.com/",
            "http://localhost:3001/",
            "https://tauri.localhost.evil.com/",
            "file:///private/data",
        ] {
            assert!(!history_ui_allowed(
                "main",
                &url.parse().unwrap(),
                Some(&dev)
            ));
        }
    }

    /// The command shell is the only thing left in this module, so the thing
    /// worth pinning is that it still forwards to the extracted reader
    /// (ADR-0067 Tier C) and preserves its never-error-on-missing-install
    /// contract.
    #[test]
    fn command_forwards_to_the_extracted_reader_and_tolerates_a_missing_install() {
        let out = opencode_sessions_read("/nonexistent-home-xyz".to_string())
            .expect("a missing OpenCode install must not be an error");
        assert!(out.is_empty());
    }

    #[test]
    fn external_store_command_rejects_renderer_supplied_roots() {
        let error = external_agent_sessions_read("cursor".into(), "/nonexistent-home-xyz".into())
            .unwrap_err();
        assert!(error.contains("current user home"));
    }
}
