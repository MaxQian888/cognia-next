//! Control actions on fleet sessions: focus the dispatching terminal (P2).
//! (Session control for OpenCode rides the plugin command queue in
//! `fleet/opencode.rs` — there is no HTTP control surface in this module.)
//!
//! macOS focus strategy: activate the terminal application via `osascript`
//! (best-effort, app-name based). Window-level matching via CGWindowList
//! (`pet_window/surfaces.rs`) is intentionally deferred — activating the app
//! restores its frontmost window, which covers the common one-window case.
//!
//! Windows focus strategy: activate the first process of the terminal's known
//! image name that owns a main window, via PowerShell `AppActivate`
//! (best-effort, mirrors the macOS app-level granularity).
//!
//! Linux focus strategy: raise the first window whose WM_CLASS matches the
//! terminal's known class, via `wmctrl -x -a`, falling back to `xdotool`
//! when wmctrl is absent (both are X11 tools; on pure Wayland neither can
//! drive foreign windows and the action fails with a descriptive error —
//! best-effort, same contract as the other platforms).

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
    let name =
        macos_app_name(app).ok_or_else(|| "no focusable app for this terminal".to_string())?;
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

/// Windows process image name (no `.exe`) for `Get-Process -Name`. `None`
/// when the terminal has no Windows build / no reliable image name.
pub fn windows_process_name(app: TerminalApp) -> Option<&'static str> {
    match app {
        TerminalApp::WindowsTerminal => Some("WindowsTerminal"),
        TerminalApp::Vscode => Some("Code"),
        TerminalApp::Cursor => Some("Cursor"),
        TerminalApp::Alacritty => Some("alacritty"),
        TerminalApp::Wezterm => Some("wezterm-gui"),
        // Warp ships a Windows build; Get-Process -Name matches the image
        // name case-insensitively without the .exe suffix.
        TerminalApp::Warp => Some("warp"),
        // iTerm / Apple Terminal / Ghostty / kitty have no Windows build;
        // tmux nests in another terminal; JetBrains image names vary per
        // product.
        TerminalApp::Iterm
        | TerminalApp::AppleTerminal
        | TerminalApp::Ghostty
        | TerminalApp::Kitty
        | TerminalApp::Tmux
        | TerminalApp::Jetbrains
        | TerminalApp::Unknown => None,
    }
}

/// Linux WM_CLASS (the `-x` matching key for `wmctrl` / `xdotool --class`)
/// for terminals that ship a Linux build. `None` when the terminal has no
/// Linux build or no stable window class.
pub fn linux_wm_class(app: TerminalApp) -> Option<&'static str> {
    match app {
        TerminalApp::Kitty => Some("kitty"),
        TerminalApp::Alacritty => Some("Alacritty"),
        TerminalApp::Wezterm => Some("org.wezfurlong.wezterm"),
        TerminalApp::Ghostty => Some("com.mitchellh.ghostty"),
        TerminalApp::Vscode => Some("Code"),
        TerminalApp::Cursor => Some("Cursor"),
        TerminalApp::Warp => Some("dev.warp.Warp"),
        // iTerm / Apple Terminal are mac-only; Windows Terminal is
        // Windows-only; tmux nests in another terminal; JetBrains classes
        // vary per product.
        TerminalApp::Iterm
        | TerminalApp::AppleTerminal
        | TerminalApp::WindowsTerminal
        | TerminalApp::Tmux
        | TerminalApp::Jetbrains
        | TerminalApp::Unknown => None,
    }
}

/// Whether the CURRENT platform knows how to bring this terminal to the
/// foreground. Drives the session's `focus_terminal` capability so the island
/// never renders a focus affordance that would silently fail (e.g. a kitty
/// session observed on Windows).
pub fn can_focus(app: TerminalApp) -> bool {
    if cfg!(target_os = "macos") {
        macos_app_name(app).is_some()
    } else if cfg!(target_os = "windows") {
        windows_process_name(app).is_some()
    } else if cfg!(target_os = "linux") {
        linux_wm_class(app).is_some()
    } else {
        false
    }
}

#[cfg(target_os = "windows")]
pub fn focus_terminal_app(app: TerminalApp) -> Result<(), String> {
    let name = windows_process_name(app)
        .ok_or_else(|| "no focusable app for this terminal".to_string())?;
    // AppActivate brings the process's main window to the foreground. The name
    // is a compile-time constant from the table above — no injection surface.
    let script = format!(
        "$p = Get-Process -Name '{name}' -ErrorAction SilentlyContinue | \
         Where-Object {{ $_.MainWindowHandle -ne 0 }} | Select-Object -First 1; \
         if (-not $p) {{ exit 3 }}; \
         if (-not ((New-Object -ComObject WScript.Shell).AppActivate($p.Id))) {{ exit 2 }}"
    );
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("focus via AppActivate failed (exit {status})"))
    }
}

#[cfg(target_os = "linux")]
pub fn focus_terminal_app(app: TerminalApp) -> Result<(), String> {
    let class =
        linux_wm_class(app).ok_or_else(|| "no focusable app for this terminal".to_string())?;
    // `wmctrl -x -a` matches WM_CLASS and raises + focuses the first hit.
    // The class is a compile-time constant from the table above — no
    // injection surface. A missing binary (io error) falls through to
    // xdotool; a non-zero exit (no matching window) is a real miss.
    match std::process::Command::new("wmctrl")
        .args(["-x", "-a", class])
        .status()
    {
        Ok(status) if status.success() => return Ok(()),
        Ok(status) => return Err(format!("wmctrl exited with {status}")),
        Err(_) => {} // wmctrl not installed — try xdotool.
    }
    let status = std::process::Command::new("xdotool")
        .args(["search", "--limit", "1", "--class", class, "windowactivate"])
        .status()
        .map_err(|e| format!("neither wmctrl nor xdotool is available: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("xdotool exited with {status}"))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
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
        assert_eq!(
            macos_app_name(TerminalApp::Vscode),
            Some("Visual Studio Code")
        );
        assert_eq!(macos_app_name(TerminalApp::Cursor), Some("Cursor"));
        assert_eq!(macos_app_name(TerminalApp::Unknown), None);
        assert_eq!(macos_app_name(TerminalApp::Tmux), None);
    }

    #[test]
    fn windows_process_names_cover_focusable_terminals() {
        assert_eq!(
            windows_process_name(TerminalApp::WindowsTerminal),
            Some("WindowsTerminal")
        );
        assert_eq!(windows_process_name(TerminalApp::Vscode), Some("Code"));
        assert_eq!(windows_process_name(TerminalApp::Cursor), Some("Cursor"));
        assert_eq!(
            windows_process_name(TerminalApp::Wezterm),
            Some("wezterm-gui")
        );
        assert_eq!(windows_process_name(TerminalApp::Warp), Some("warp"));
        assert_eq!(windows_process_name(TerminalApp::AppleTerminal), None);
        assert_eq!(windows_process_name(TerminalApp::Unknown), None);
    }

    #[test]
    fn linux_wm_classes_cover_focusable_terminals() {
        assert_eq!(linux_wm_class(TerminalApp::Kitty), Some("kitty"));
        assert_eq!(linux_wm_class(TerminalApp::Alacritty), Some("Alacritty"));
        assert_eq!(
            linux_wm_class(TerminalApp::Wezterm),
            Some("org.wezfurlong.wezterm")
        );
        assert_eq!(
            linux_wm_class(TerminalApp::Ghostty),
            Some("com.mitchellh.ghostty")
        );
        assert_eq!(linux_wm_class(TerminalApp::Vscode), Some("Code"));
        assert_eq!(linux_wm_class(TerminalApp::Warp), Some("dev.warp.Warp"));
        assert_eq!(linux_wm_class(TerminalApp::Iterm), None);
        assert_eq!(linux_wm_class(TerminalApp::WindowsTerminal), None);
        assert_eq!(linux_wm_class(TerminalApp::Unknown), None);
    }

    #[test]
    fn can_focus_follows_the_current_platform_table() {
        // The capability must mirror exactly the table the focus action will
        // consult, so a rendered focus affordance can never silently no-op.
        let expected = |app: TerminalApp| {
            if cfg!(target_os = "macos") {
                macos_app_name(app).is_some()
            } else if cfg!(target_os = "windows") {
                windows_process_name(app).is_some()
            } else if cfg!(target_os = "linux") {
                linux_wm_class(app).is_some()
            } else {
                false
            }
        };
        for app in [
            TerminalApp::Iterm,
            TerminalApp::AppleTerminal,
            TerminalApp::Ghostty,
            TerminalApp::Vscode,
            TerminalApp::Warp,
            TerminalApp::Kitty,
            TerminalApp::Alacritty,
            TerminalApp::Wezterm,
            TerminalApp::Tmux,
            TerminalApp::WindowsTerminal,
            TerminalApp::Jetbrains,
            TerminalApp::Cursor,
            TerminalApp::Unknown,
        ] {
            assert_eq!(can_focus(app), expected(app), "mismatch for {app:?}");
        }
        // Unknown and tmux are never focusable on any platform.
        assert!(!can_focus(TerminalApp::Unknown));
        assert!(!can_focus(TerminalApp::Tmux));
    }
}
