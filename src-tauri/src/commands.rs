use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
pub enum AppError {
    #[error("name cannot be empty")]
    EmptyName,
}

#[tauri::command]
pub fn greet(name: &str) -> Result<String, AppError> {
    if name.trim().is_empty() {
        return Err(AppError::EmptyName);
    }
    Ok(format!("Hello, {name}! Welcome to Tauri 2."))
}

/// Authoritative list of every custom menu id the desktop chrome dispatches.
/// Kept here (rather than inside the desktop-only `menu` module) so the
/// `menu_action_ids` Tauri command can be registered uniformly across
/// desktop and mobile in `tauri::generate_handler!`.
///
/// Mirrors `lib/desktop/menu-actions.ts:MENU_ACTION_IDS`. When you add or
/// remove an id here, update the renderer side and its tests too. The
/// renderer uses `menu_action_ids` at boot to fail-fast if the two lists
/// diverge.
pub const MENU_IDS: &[&str] = &[
    // File
    "new-chat",
    "new-workflow",
    "new-agent-team",
    "new-character",
    "open-workspace",
    "open-settings",
    "open-logs",
    // Edit — predefined items (no custom ids)
    // View
    "command-palette",
    "toggle-sidebar",
    "toggle-guild-rail",
    "toggle-status-bar",
    "reload",
    "toggle-devtools",
    "toggle-reduce-motion",
    "theme-light",
    "theme-dark",
    "theme-system",
    "language-en",
    "language-zh-cn",
    // Go
    "go-inbox",
    "go-workflows",
    "go-twin",
    "go-skills",
    "go-plugins",
    "go-agent-teams",
    "go-scheduler",
    "go-discover",
    "go-a2ui",
    "go-dms",
    "go-canvas",
    "go-logs",
    "go-settings",
    // Tools
    "automation-kill-switch",
    "manage-connectors",
    "manage-mcp-server",
    "plugin-devtools",
    "sidecar-restart",
    "clear-cache",
    // Help
    "keyboard-shortcuts",
    "documentation",
];

/// Return the canonical list of custom menu ids. Used by the renderer to
/// verify its `MENU_ACTION_IDS` matches the Rust side at boot. Available on
/// every platform — on mobile the menu is never installed, but the list is
/// still useful for diagnostics.
#[tauri::command]
pub fn menu_action_ids() -> Vec<&'static str> {
    MENU_IDS.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greet_with_name() {
        assert_eq!(greet("World").unwrap(), "Hello, World! Welcome to Tauri 2.");
    }

    #[test]
    fn greet_empty_errors() {
        assert!(matches!(greet("").unwrap_err(), AppError::EmptyName));
    }

    #[test]
    fn greet_whitespace_errors() {
        assert!(matches!(greet("   ").unwrap_err(), AppError::EmptyName));
    }

    /// Every documented id is unique and uses only kebab-case + lowercase
    /// letters / digits. Catches accidental duplicates or accidental
    /// underscores that would make the `menu://<id>` event names diverge
    /// from the renderer's expectations.
    #[test]
    fn menu_ids_are_kebab_case_and_unique() {
        let mut seen = std::collections::HashSet::new();
        for id in MENU_IDS {
            assert!(seen.insert(*id), "duplicate menu id: {id}");
            assert!(
                id.chars()
                    .all(|c| c == '-' || c.is_ascii_lowercase() || c.is_ascii_digit()),
                "non kebab-case id: {id}"
            );
            assert!(!id.is_empty(), "empty menu id");
        }
    }

    /// Sanity: the renderer-side `MENU_ACTION_IDS` list in
    /// `lib/desktop/menu-actions.ts` includes a few well-known ids.
    /// Hard-coding the canary set in the test rather than re-parsing the
    /// TS keeps cargo test self-contained, but spot-checks the contract.
    #[test]
    fn menu_ids_include_canonical_set() {
        let required: &[&str] = &[
            "new-chat",
            "open-workspace",
            "open-settings",
            "open-logs",
            "command-palette",
            "toggle-sidebar",
            "go-inbox",
            "go-twin",
            "go-settings",
            "automation-kill-switch",
            "manage-mcp-server",
            "sidecar-restart",
            "clear-cache",
            "keyboard-shortcuts",
            "documentation",
        ];
        for id in required {
            assert!(MENU_IDS.contains(id), "MENU_IDS is missing: {id}");
        }
    }

    #[test]
    fn menu_action_ids_command_returns_same_list() {
        let ids = menu_action_ids();
        assert_eq!(ids.len(), MENU_IDS.len());
        for id in MENU_IDS {
            assert!(ids.contains(id), "menu_action_ids missing: {id}");
        }
    }
}
