use serde::Serialize;
use tauri::window::Color;
use tauri::Webview;

#[derive(Debug, thiserror::Error, Serialize)]
pub enum AppError {
    #[error("name cannot be empty")]
    EmptyName,
    #[error("invalid hex color: {0}")]
    InvalidHex(String),
}

#[tauri::command]
pub fn greet(name: &str) -> Result<String, AppError> {
    if name.trim().is_empty() {
        return Err(AppError::EmptyName);
    }
    Ok(format!("Hello, {name}! Welcome to Tauri 2."))
}

/// Parse a `#RRGGBB` or `#RRGGBBAA` (or unprefixed) hex string into a
/// `tauri::window::Color` tuple. Used by `set_window_background_color`; kept
/// pub(crate) so the unit tests in this module can drive it directly without
/// instantiating a Webview.
pub(crate) fn parse_hex_color(hex: &str) -> Result<Color, AppError> {
    let cleaned = hex.trim().trim_start_matches('#');
    if cleaned.len() != 6 && cleaned.len() != 8 {
        return Err(AppError::InvalidHex(hex.to_string()));
    }
    let r = u8::from_str_radix(&cleaned[0..2], 16)
        .map_err(|_| AppError::InvalidHex(hex.to_string()))?;
    let g = u8::from_str_radix(&cleaned[2..4], 16)
        .map_err(|_| AppError::InvalidHex(hex.to_string()))?;
    let b = u8::from_str_radix(&cleaned[4..6], 16)
        .map_err(|_| AppError::InvalidHex(hex.to_string()))?;
    let a = if cleaned.len() == 8 {
        u8::from_str_radix(&cleaned[6..8], 16).map_err(|_| AppError::InvalidHex(hex.to_string()))?
    } else {
        255
    };
    Ok(Color(r, g, b, a))
}

/// Drive the desktop window background color from the renderer side so a
/// theme switch repaints the custom titlebar / chrome area without a full
/// reload. Tauri doesn't expose a runtime `setTitleBarStyle`, so on
/// Windows with `decorations=false` the window background is what the
/// titlebar surface inherits.
///
/// Accept the infallible `Webview` command extractor rather than
/// `WebviewWindow`. The main window can own embedded browser/code-server child
/// webviews, at which point Tauri intentionally stops classifying it as a
/// `WebviewWindow` even though the invoking app webview and parent window are
/// both valid targets.
#[tauri::command]
pub fn set_window_background_color(webview: Webview, hex: String) -> Result<(), String> {
    let color = parse_hex_color(&hex).map_err(|e| e.to_string())?;
    webview
        .window()
        .set_background_color(Some(color))
        .map_err(|e| e.to_string())?;
    webview
        .set_background_color(Some(color))
        .map_err(|e| e.to_string())?;
    Ok(())
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
    "toggle-right-sidebar",
    "toggle-guild-rail",
    "toggle-status-bar",
    "toggle-terminal",
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
    "go-sites",
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

    #[test]
    fn parse_hex_color_accepts_six_digit_hex() {
        let color = parse_hex_color("#ff8800").unwrap();
        assert_eq!(color.0, 0xff);
        assert_eq!(color.1, 0x88);
        assert_eq!(color.2, 0x00);
        assert_eq!(color.3, 0xff);
    }

    #[test]
    fn parse_hex_color_accepts_eight_digit_hex_with_alpha() {
        let color = parse_hex_color("#11223344").unwrap();
        assert_eq!(color.0, 0x11);
        assert_eq!(color.1, 0x22);
        assert_eq!(color.2, 0x33);
        assert_eq!(color.3, 0x44);
    }

    #[test]
    fn parse_hex_color_accepts_unprefixed() {
        let color = parse_hex_color("0a0a0a").unwrap();
        assert_eq!(color.0, 0x0a);
        assert_eq!(color.1, 0x0a);
        assert_eq!(color.2, 0x0a);
        assert_eq!(color.3, 0xff);
    }

    #[test]
    fn parse_hex_color_rejects_short_form() {
        assert!(matches!(
            parse_hex_color("#abc"),
            Err(AppError::InvalidHex(_))
        ));
    }

    #[test]
    fn parse_hex_color_rejects_garbage_chars() {
        assert!(matches!(
            parse_hex_color("#zzzzzz"),
            Err(AppError::InvalidHex(_))
        ));
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
            "toggle-right-sidebar",
            "toggle-terminal",
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
