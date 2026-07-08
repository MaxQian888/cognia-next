//! Control actions on fleet sessions: focus the dispatching terminal (P2),
//! OpenCode HTTP control (P5).
//!
//! macOS focus strategy: activate the terminal application via `osascript`
//! (best-effort, app-name based). Window-level matching via CGWindowList
//! (`pet_window/surfaces.rs`) is intentionally deferred — activating the app
//! restores its frontmost window, which covers the common one-window case.

use super::terminal::TerminalApp;

/// macOS application name for `tell application "…" to activate`. `None`
/// when we don't know a reliable app name (Unknown / non-mac terminals).
pub fn macos_app_name(app: TerminalApp) -> Option<&'static str> {
    match app {
        TerminalApp::Iterm => Some("iTerm"),
        TerminalApp::AppleTerminal => Some("Terminal"),
        TerminalApp::Ghostty => Some("Ghostty"),
        TerminalApp::Vscode => Some("Visual Studio Code"),
        TerminalApp::Warp => Some("Warp"),
        TerminalApp::Kitty => Some("kitty"),
        TerminalApp::Alacritty => Some("Alacritty"),
        TerminalApp::Wezterm => Some("WezTerm"),
        TerminalApp::Cursor => Some("Cursor"),
        // tmux lives inside another terminal; JetBrains spans many product
        // names; Unknown / WindowsTerminal have no macOS app to activate.
        TerminalApp::Tmux
        | TerminalApp::Jetbrains
        | TerminalApp::WindowsTerminal
        | TerminalApp::Unknown => None,
    }
}

/// Bring the terminal app that dispatched a session to the foreground.
#[cfg(target_os = "macos")]
pub fn focus_terminal_app(app: TerminalApp) -> Result<(), String> {
    let name = macos_app_name(app).ok_or_else(|| "no focusable app for this terminal".to_string())?;
    // `activate` un-minimizes and fronts the app's most recent window. The
    // quoted name is a compile-time constant from the table above — no
    // injection surface.
    let script = format!("tell application \"{name}\" to activate");
    let status = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("osascript exited with {status}"))
    }
}

#[cfg(not(target_os = "macos"))]
pub fn focus_terminal_app(_app: TerminalApp) -> Result<(), String> {
    Err("focus-terminal is not supported on this platform yet".to_string())
}

/// Tauri command: focus the terminal behind a session (looked up by agent +
/// session id so the frontend never passes raw app identifiers).
#[tauri::command]
pub async fn fleet_focus_terminal(agent: String, session_id: String) -> Result<(), String> {
    let agent = super::registry::FleetAgent::parse(&agent).ok_or("unknown agent")?;
    let terminal = super::runtime()
        .session_terminal(agent, &session_id)
        .ok_or("session has no known terminal")?;
    // Blocking process spawn — hop off the async runtime like other commands
    // that shell out.
    tauri::async_runtime::spawn_blocking(move || focus_terminal_app(terminal.app))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_app_names_cover_focusable_terminals() {
        assert_eq!(macos_app_name(TerminalApp::Iterm), Some("iTerm"));
        assert_eq!(macos_app_name(TerminalApp::AppleTerminal), Some("Terminal"));
        assert_eq!(macos_app_name(TerminalApp::Ghostty), Some("Ghostty"));
        assert_eq!(macos_app_name(TerminalApp::Vscode), Some("Visual Studio Code"));
        assert_eq!(macos_app_name(TerminalApp::Cursor), Some("Cursor"));
        assert_eq!(macos_app_name(TerminalApp::Unknown), None);
        assert_eq!(macos_app_name(TerminalApp::Tmux), None);
    }
}
