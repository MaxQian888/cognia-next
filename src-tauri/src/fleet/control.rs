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
//! Linux focus strategy: resolve a per-session backend (`decide_linux_backend`)
//! from the session type + available tools, then raise the window matching the
//! terminal's known class. X11 uses `wmctrl -x -a` (falling back to `xdotool`);
//! Sway/wlroots Wayland uses `swaymsg [app_id=…] focus`; KDE Plasma Wayland uses
//! `kdotool`. GNOME Wayland forbids external window activation, so it resolves to
//! NO backend — and `can_focus` returns false there, so the island never renders
//! a dead focus affordance.
//!
//! tmux is intentionally never focusable on any platform: it nests inside an
//! outer terminal the classifier does not currently capture, so a focus action
//! would raise nothing. A real tmux focus would need the outer terminal plus a
//! `tmux select-pane -t <session_ref>` compound; deferred rather than shipping a
//! half-focus that no-ops.

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

/// Which mechanism the current Linux session uses to raise a foreign window.
/// Resolved once from the session type + available tools; `None` means the
/// compositor won't let us (notably GNOME Wayland), which keeps `can_focus`
/// false so no dead focus affordance is rendered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // constructed only on Linux; the type is shared for testing.
enum LinuxFocusBackend {
    /// X11: `wmctrl` (preferred) or `xdotool` — both drive foreign windows.
    X11,
    /// wlroots/Sway Wayland: `swaymsg [app_id=…] focus`.
    Sway,
    /// KDE Plasma Wayland: `kdotool` (an xdotool-alike for KWin).
    Kde,
}

/// Pure backend decision from session facts, separated from the env/PATH probe
/// so it can be unit-tested on any host. GNOME Wayland (and any Wayland session
/// with no Sway/KDE tool) resolves to `None`: the compositor forbids external
/// window activation, so advertising focus there would be a dead button.
#[allow(dead_code)] // used by the Linux probe + the cross-platform tests.
fn decide_linux_backend(
    wayland: bool,
    has_swaysock: bool,
    has_kde_session: bool,
    has_wmctrl: bool,
    has_xdotool: bool,
    has_swaymsg: bool,
    has_kdotool: bool,
) -> Option<LinuxFocusBackend> {
    if !wayland {
        return (has_wmctrl || has_xdotool).then_some(LinuxFocusBackend::X11);
    }
    if has_swaysock && has_swaymsg {
        return Some(LinuxFocusBackend::Sway);
    }
    if has_kde_session && has_kdotool {
        return Some(LinuxFocusBackend::Kde);
    }
    None
}

/// Sway/wlroots focus criteria for a WM `app_id`. Pure (testable everywhere).
#[allow(dead_code)]
fn sway_focus_criteria(app_id: &str) -> String {
    format!("[app_id=\"{app_id}\"] focus")
}

/// Whether the given tool resolves on `PATH` (presence, not exit code).
#[cfg(target_os = "linux")]
fn tool_exists(name: &str) -> bool {
    use std::process::Stdio;
    std::process::Command::new(name)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
}

/// The resolved Linux focus backend, memoized (an env + PATH probe, not per
/// event — `can_focus` runs in the registry fold).
#[cfg(target_os = "linux")]
fn linux_focus_backend() -> Option<LinuxFocusBackend> {
    use once_cell::sync::Lazy;
    static BACKEND: Lazy<Option<LinuxFocusBackend>> = Lazy::new(|| {
        let session_type = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
        let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some() || session_type == "wayland";
        decide_linux_backend(
            wayland,
            std::env::var_os("SWAYSOCK").is_some(),
            std::env::var_os("KDE_FULL_SESSION").is_some(),
            tool_exists("wmctrl"),
            tool_exists("xdotool"),
            tool_exists("swaymsg"),
            tool_exists("kdotool"),
        )
    });
    *BACKEND
}

/// Whether the CURRENT platform knows how to bring this terminal to the
/// foreground. Drives the session's `focus_terminal` capability so the island
/// never renders a focus affordance that would silently fail (e.g. a kitty
/// session observed on Windows, or any terminal on GNOME Wayland).
pub fn can_focus(app: TerminalApp) -> bool {
    #[cfg(target_os = "macos")]
    {
        macos_app_name(app).is_some()
    }
    #[cfg(target_os = "windows")]
    {
        windows_process_name(app).is_some()
    }
    #[cfg(target_os = "linux")]
    {
        // A window class we recognize AND a compositor we can actually drive.
        linux_wm_class(app).is_some() && linux_focus_backend().is_some()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = app;
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
    // The class is a compile-time constant from the table above — no injection
    // surface on any of the backends below.
    match linux_focus_backend() {
        Some(LinuxFocusBackend::X11) => focus_x11(class),
        Some(LinuxFocusBackend::Sway) => focus_sway(class),
        Some(LinuxFocusBackend::Kde) => focus_kde(class),
        None => Err(
            "no window-focus backend for this session (GNOME Wayland forbids external \
             window activation)"
                .to_string(),
        ),
    }
}

/// X11: `wmctrl -x -a` (raise + focus by WM_CLASS), falling back to `xdotool`.
#[cfg(target_os = "linux")]
fn focus_x11(class: &str) -> Result<(), String> {
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

/// Sway/wlroots: focus the window whose Wayland `app_id` matches the class.
#[cfg(target_os = "linux")]
fn focus_sway(class: &str) -> Result<(), String> {
    let status = std::process::Command::new("swaymsg")
        .arg(sway_focus_criteria(class))
        .status()
        .map_err(|e| format!("swaymsg unavailable: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("swaymsg exited with {status}"))
    }
}

/// KDE Plasma Wayland: `kdotool` mirrors xdotool's search+activate on KWin.
#[cfg(target_os = "linux")]
fn focus_kde(class: &str) -> Result<(), String> {
    let status = std::process::Command::new("kdotool")
        .args(["search", "--class", class, "windowactivate"])
        .status()
        .map_err(|e| format!("kdotool unavailable: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("kdotool exited with {status}"))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub fn focus_terminal_app(_app: TerminalApp) -> Result<(), String> {
    Err("focus-terminal is not supported on this platform yet".to_string())
}

/// Resolve a session's terminal (by agent + session id) and bring it to the
/// foreground. Shared by the `fleet_focus_terminal` Tauri command and the
/// companion RPC arm so the two transports can never drift.
pub async fn focus_session_terminal(agent: &str, session_id: &str) -> Result<(), String> {
    let agent = super::registry::FleetAgent::parse(agent).ok_or("unknown agent")?;
    let terminal = super::runtime()
        .session_terminal(agent, session_id)
        .ok_or("session has no known terminal")?;
    // Blocking process spawn — hop off the async runtime like other commands
    // that shell out.
    tauri::async_runtime::spawn_blocking(move || focus_terminal_app(terminal.app))
        .await
        .map_err(|e| e.to_string())?
}

/// Tauri command: focus the terminal behind a session (looked up by agent +
/// session id so the frontend never passes raw app identifiers).
#[tauri::command]
pub async fn fleet_focus_terminal(agent: String, session_id: String) -> Result<(), String> {
    focus_session_terminal(&agent, &session_id).await
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
        let expected = |app: TerminalApp| -> bool {
            #[cfg(target_os = "macos")]
            {
                macos_app_name(app).is_some()
            }
            #[cfg(target_os = "windows")]
            {
                windows_process_name(app).is_some()
            }
            #[cfg(target_os = "linux")]
            {
                linux_wm_class(app).is_some() && linux_focus_backend().is_some()
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
            {
                let _ = app;
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

    #[test]
    fn decides_x11_backend_when_not_wayland_with_a_tool() {
        assert_eq!(
            decide_linux_backend(false, false, false, true, false, false, false),
            Some(LinuxFocusBackend::X11)
        );
        assert_eq!(
            decide_linux_backend(false, false, false, false, true, false, false),
            Some(LinuxFocusBackend::X11)
        );
        // X11 session but neither wmctrl nor xdotool installed → no backend.
        assert_eq!(
            decide_linux_backend(false, false, false, false, false, false, false),
            None
        );
    }

    #[test]
    fn decides_sway_then_kde_on_wayland() {
        assert_eq!(
            decide_linux_backend(true, true, false, false, false, true, false),
            Some(LinuxFocusBackend::Sway)
        );
        assert_eq!(
            decide_linux_backend(true, false, true, false, false, false, true),
            Some(LinuxFocusBackend::Kde)
        );
        // Sway socket present but swaymsg missing → falls through, not Sway.
        assert_ne!(
            decide_linux_backend(true, true, false, false, false, false, false),
            Some(LinuxFocusBackend::Sway)
        );
    }

    #[test]
    fn gnome_wayland_resolves_to_no_backend() {
        // Wayland with no Sway socket and no KDE session → None, so `can_focus`
        // stays false and the island shows no dead focus button.
        assert_eq!(
            decide_linux_backend(true, false, false, true, true, true, true),
            None
        );
    }

    #[test]
    fn sway_criteria_wraps_the_app_id() {
        assert_eq!(sway_focus_criteria("kitty"), "[app_id=\"kitty\"] focus");
    }

    #[tokio::test]
    async fn focus_session_terminal_rejects_an_unknown_agent() {
        let err = focus_session_terminal("not-an-agent", "s1")
            .await
            .unwrap_err();
        assert!(err.contains("unknown agent"));
    }
}
