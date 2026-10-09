use serde::Serialize;
use tauri::window::Color;
use tauri::{Manager, Webview};

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

/// Extend a save-dialog grant to one atomic-write sibling, never its directory.
/// This command is intentionally absent from the companion filesystem RPC map.
#[tauri::command]
pub fn backup_stream_temporary_path(app: tauri::AppHandle, path: String) -> Result<String, String> {
    use tauri_plugin_fs::FsExt;
    let scope = app.fs_scope();
    let temporary = crate::fs_atomic::scoped_temporary_sibling(
        std::path::Path::new(&path),
        &uuid::Uuid::new_v4().simple().to_string(),
        |target| scope.is_allowed(target),
    )
    .map_err(|error| error.to_string())?;
    scope
        .allow_file(&temporary)
        .map_err(|error| error.to_string())?;
    if !scope.is_allowed(&temporary) {
        return Err("backup temporary path is denied by filesystem scope".into());
    }
    temporary
        .into_os_string()
        .into_string()
        .map_err(|_| "backup path is not valid UTF-8".into())
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
///
/// `scheme` / `follows_system` describe the theme that produced `hex`; the
/// pair is persisted with it so the next launch can paint the hidden window in
/// the right colour before the renderer runs (see [`boot_shell_background`]).
#[tauri::command]
pub fn set_window_background_color(
    webview: Webview,
    hex: String,
    scheme: Option<String>,
    follows_system: Option<bool>,
) -> Result<(), String> {
    let color = parse_hex_color(&hex).map_err(|e| e.to_string())?;
    webview
        .window()
        .set_background_color(Some(color))
        .map_err(|e| e.to_string())?;
    webview
        .set_background_color(Some(color))
        .map_err(|e| e.to_string())?;
    if let Some(dark) = scheme.as_deref().and_then(scheme_is_dark) {
        persist_shell_background(
            webview.app_handle(),
            &SavedShellBackground {
                hex,
                dark,
                follows_system: follows_system.unwrap_or(false),
            },
        );
    }
    Ok(())
}

/// Native background of the main window before the renderer's first paint.
/// `tauri.conf.json` can only hold one static colour, and the boot safety net
/// (`lib.rs`, `BOOT_REVEAL_GRACE`) may show the window before the page paints
/// — always the case on a cold dev start while Next.js compiles `/` — so a
/// fixed dark colour flashed dark before every light-themed launch.
const SHELL_BACKGROUND_FILE: &str = "shell-background.json";
/// Mirrors `lib/appearance/shell-sync.ts` light fallback and the dark
/// `backgroundColor` in `tauri.conf.json`.
pub(crate) const DEFAULT_LIGHT_SHELL_BACKGROUND: &str = "#ffffff";
pub(crate) const DEFAULT_DARK_SHELL_BACKGROUND: &str = "#0a0a0a";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedShellBackground {
    pub hex: String,
    pub dark: bool,
    pub follows_system: bool,
}

fn scheme_is_dark(scheme: &str) -> Option<bool> {
    match scheme {
        "dark" => Some(true),
        "light" => Some(false),
        _ => None,
    }
}

/// The colour to paint the hidden main window with at launch. A saved colour
/// from a theme that follows the system is only reused while the OS is still
/// in the same mode; otherwise (or with nothing saved) the default for the
/// current OS mode applies. An explicit light/dark choice is reused as-is.
pub(crate) fn boot_shell_background(saved: Option<&SavedShellBackground>, os_dark: bool) -> Color {
    let reusable = saved
        .filter(|saved| !saved.follows_system || saved.dark == os_dark)
        .and_then(|saved| parse_hex_color(&saved.hex).ok());
    reusable.unwrap_or_else(|| {
        let fallback = if os_dark {
            DEFAULT_DARK_SHELL_BACKGROUND
        } else {
            DEFAULT_LIGHT_SHELL_BACKGROUND
        };
        parse_hex_color(fallback).expect("default shell backgrounds are valid hex")
    })
}

fn shell_background_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(SHELL_BACKGROUND_FILE))
}

pub(crate) fn read_shell_background<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<SavedShellBackground> {
    let raw = std::fs::read(shell_background_path(app)?).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// Best effort: a failed write only costs the next launch its first-frame
/// colour, never the theme change that triggered it.
fn persist_shell_background<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    value: &SavedShellBackground,
) {
    if read_shell_background(app).as_ref() == Some(value) {
        return;
    }
    let Some(path) = shell_background_path(app) else {
        return;
    };
    let Ok(json) = serde_json::to_vec(value) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(error) = std::fs::write(&path, json) {
        log::warn!(
            "shell background: failed to persist {}: {error}",
            path.display()
        );
    }
}

/// Authoritative list of every custom menu id the desktop chrome dispatches.
/// Kept here (rather than inside the desktop-only `menu` module) so the
/// `menu_action_ids` Tauri command can be registered uniformly across
/// desktop and mobile in `tauri::generate_handler!`.
///
/// Mirrors `lib/desktop/menu-actions.ts:MENU_ACTION_IDS`, except the
/// renderer-only ids Rust serves through predefined items (`quit`, `about`,
/// fullscreen, zoom) and the Rust-only `toggle-devtools`, which `menu.rs`
/// handles inline. `lib/desktop/menu-actions.test.ts` parses this array and
/// fails when the two lists diverge, so add or remove an id on both sides.
pub const MENU_IDS: &[&str] = &[
    // File
    "new-chat",
    "new-workflow",
    "new-agent-team",
    "new-agent",
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
    // Go — one `go-<id>` per navigation-catalog entry plus DMs / Canvas /
    // Settings. The native submenu is built from `menu::GO_MENU_SECTIONS`,
    // whose ids a test pins to exactly this block.
    "go-inbox",
    "go-workflows",
    "go-sites",
    "go-twin",
    "go-agents",
    "go-skills",
    "go-plugins",
    "go-squads",
    "go-scheduler",
    "go-discover",
    "go-issues",
    "go-templates",
    "go-goals",
    "go-pet",
    "go-browser",
    "go-a2ui",
    "go-dms",
    "go-conversations",
    "go-canvas",
    "go-files",
    "go-source-control",
    "go-agent-runs",
    "go-workspace",
    "go-memory",
    "go-servers",
    "go-integrations",
    "go-devices",
    "go-bots",
    "go-eval",
    "go-performance",
    "go-me",
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

    fn saved(hex: &str, dark: bool, follows_system: bool) -> SavedShellBackground {
        SavedShellBackground {
            hex: hex.into(),
            dark,
            follows_system,
        }
    }

    #[test]
    fn boot_shell_background_defaults_to_the_os_mode() {
        let light = boot_shell_background(None, false);
        assert_eq!((light.0, light.1, light.2), (0xff, 0xff, 0xff));
        let dark = boot_shell_background(None, true);
        assert_eq!((dark.0, dark.1, dark.2), (0x0a, 0x0a, 0x0a));
    }

    #[test]
    fn boot_shell_background_reuses_an_explicit_theme_on_any_os_mode() {
        let color = boot_shell_background(Some(&saved("#112233", true, false)), false);
        assert_eq!((color.0, color.1, color.2), (0x11, 0x22, 0x33));
    }

    #[test]
    fn boot_shell_background_drops_a_system_theme_saved_under_the_other_os_mode() {
        let same = boot_shell_background(Some(&saved("#f5f5f4", false, true)), false);
        assert_eq!((same.0, same.1, same.2), (0xf5, 0xf5, 0xf4));
        let flipped = boot_shell_background(Some(&saved("#111111", true, true)), false);
        assert_eq!((flipped.0, flipped.1, flipped.2), (0xff, 0xff, 0xff));
    }

    #[test]
    fn boot_shell_background_ignores_a_corrupt_saved_colour() {
        let color = boot_shell_background(Some(&saved("nope", false, false)), true);
        assert_eq!((color.0, color.1, color.2), (0x0a, 0x0a, 0x0a));
    }

    #[test]
    fn saved_shell_background_round_trips_as_camel_case_json() {
        let value = saved("#ffffff", false, true);
        let json = serde_json::to_string(&value).unwrap();
        assert_eq!(
            json,
            r##"{"hex":"#ffffff","dark":false,"followsSystem":true}"##
        );
        assert_eq!(
            serde_json::from_str::<SavedShellBackground>(&json).unwrap(),
            value
        );
        assert_eq!(scheme_is_dark("dark"), Some(true));
        assert_eq!(scheme_is_dark("light"), Some(false));
        assert_eq!(scheme_is_dark("system"), None);
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
            "go-squads",
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
