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

// ---------------------------------------------------------------------------
// Interrupt (cancel the current turn)
// ---------------------------------------------------------------------------
//
// Sending a signal to a process this app did not start is the most dangerous
// thing the fleet does, so the contract is deliberately narrow:
//
//   * ONE `SIGINT`, never a second and never `SIGTERM`. In every agent CLI a
//     single Ctrl-C cancels the in-flight turn and a second one exits — so one
//     signal is exactly "interrupt", and escalation is the user's job in their
//     own terminal, not a button in an overlay.
//   * The pid must still be alive AND still look like the agent we recorded.
//     The pid comes from the hook's ppid, so it is the agent process itself;
//     the identity re-check exists because pids get recycled, and a recycled
//     pid means signalling an unrelated process.
//   * Nothing is claimed about the result. We get no acknowledgement back, so
//     the command reports "sent", and the UI says so too — the session's own
//     next event is the only real evidence.

/// Executable names that a given agent's process may legitimately have. Used
/// only as a pid-recycling guard: the pid already came from that agent's hook,
/// so this is re-confirmation, not identification.
pub fn expected_process_names(agent: super::registry::FleetAgent) -> &'static [&'static str] {
    use super::registry::FleetAgent;
    match agent {
        FleetAgent::ClaudeCode => &["claude"],
        FleetAgent::Codex => &["codex"],
        // Declared non-interruptible (one server hosts every session), listed
        // for completeness so a future reverse-channel abort has a home.
        FleetAgent::Opencode => &["opencode"],
    }
}

/// Does an observed process look like one of `expected`?
///
/// Matches the executable stem of the process name or of `argv[0]`, so both a
/// bare `claude` and a `/usr/local/bin/claude.exe` style path resolve. Pure.
pub fn process_identity_matches(name: &str, argv0: Option<&str>, expected: &[&str]) -> bool {
    fn stem(raw: &str) -> String {
        let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
        let base = base.strip_suffix(".exe").unwrap_or(base);
        base.to_ascii_lowercase()
    }
    let candidates = [Some(name), argv0];
    candidates
        .iter()
        .flatten()
        .filter(|c| !c.is_empty())
        .any(|c| expected.iter().any(|e| stem(c) == e.to_ascii_lowercase()))
}

/// Whether this platform can deliver a turn-cancelling interrupt at all.
///
/// Unix: `SIGINT` to the agent's pid is exactly what Ctrl-C in its terminal
/// does. Windows: `GenerateConsoleCtrlEvent` only reaches processes sharing our
/// console, which an externally-launched agent never does — rather than ship a
/// button that silently no-ops, the capability stays off there.
pub fn can_interrupt() -> bool {
    cfg!(unix)
}

/// Verified outcome of the pre-signal checks. Split from the signal itself so
/// the decision is unit-testable without a live process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InterruptRefusal {
    Unsupported,
    NotRunning,
    IdentityMismatch,
}

impl InterruptRefusal {
    /// Stable, machine-readable reason the frontend maps to a message.
    pub fn code(self) -> &'static str {
        match self {
            Self::Unsupported => "interrupt_unsupported",
            Self::NotRunning => "interrupt_not_running",
            Self::IdentityMismatch => "interrupt_identity_mismatch",
        }
    }
}

/// Decide whether a signal may be sent, given already-gathered facts. Pure.
pub fn check_interrupt(
    supported: bool,
    observed: Option<(&str, Option<&str>)>,
    expected: &[&str],
) -> Result<(), InterruptRefusal> {
    if !supported {
        return Err(InterruptRefusal::Unsupported);
    }
    let Some((name, argv0)) = observed else {
        return Err(InterruptRefusal::NotRunning);
    };
    if !process_identity_matches(name, argv0, expected) {
        return Err(InterruptRefusal::IdentityMismatch);
    }
    Ok(())
}

/// Look up the live process behind `pid`, returning its name and `argv[0]`.
fn observe_process(pid: u32) -> Option<(String, Option<String>)> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut system = System::new();
    let target = Pid::from_u32(pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[target]),
        true,
        ProcessRefreshKind::nothing().with_cmd(sysinfo::UpdateKind::Always),
    );
    let process = system.process(target)?;
    Some((
        process.name().to_string_lossy().to_string(),
        process
            .cmd()
            .first()
            .map(|a| a.to_string_lossy().to_string()),
    ))
}

/// Deliver a single `SIGINT` to `pid`.
#[cfg(unix)]
fn send_interrupt(pid: u32) -> Result<(), String> {
    // SAFETY: `kill` with a valid signal number is safe to call; the pid was
    // just verified alive and identity-checked by the caller. A racing exit
    // between the check and here surfaces as ESRCH, which we report rather
    // than retry — retrying a signal at a pid that just died is precisely how
    // a recycled pid gets hit.
    let rc = unsafe { libc::kill(pid as libc::pid_t, libc::SIGINT) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

#[cfg(not(unix))]
fn send_interrupt(_pid: u32) -> Result<(), String> {
    Err(InterruptRefusal::Unsupported.code().to_string())
}

/// Interrupt a session's current turn. Shared by the Tauri command and the
/// companion RPC arm so the two transports can never drift.
pub async fn interrupt_session(agent: &str, session_id: &str) -> Result<(), String> {
    let agent = super::registry::FleetAgent::parse(agent).ok_or("unknown agent")?;
    if agent == super::registry::FleetAgent::Opencode {
        let runtime = super::runtime();
        if !runtime
            .session_capabilities(agent, session_id)
            .is_some_and(|capabilities| capabilities.interrupt)
        {
            return Err(InterruptRefusal::Unsupported.code().to_string());
        }
        runtime.queue_opencode_interrupt(session_id.to_string())?;
        return Ok(());
    }
    let pid = super::runtime()
        .session_agent_pid(agent, session_id)
        .ok_or(InterruptRefusal::NotRunning.code())?;
    let expected = expected_process_names(agent);
    // `sysinfo` refresh + `kill` are blocking; hop off the async runtime like
    // the other commands in this module that touch the OS.
    tauri::async_runtime::spawn_blocking(move || {
        let observed = observe_process(pid);
        let observed_ref = observed
            .as_ref()
            .map(|(name, argv0)| (name.as_str(), argv0.as_deref()));
        check_interrupt(can_interrupt(), observed_ref, expected)
            .map_err(|r| r.code().to_string())?;
        send_interrupt(pid)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Tauri command: interrupt a session's current turn (agent + session id, so
/// the frontend never passes a raw pid).
#[tauri::command]
pub async fn fleet_interrupt_session(agent: String, session_id: String) -> Result<(), String> {
    interrupt_session(&agent, &session_id).await
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

    #[test]
    fn process_identity_matches_the_agent_binary() {
        // Both real agents ship as native binaries whose `comm` is the agent
        // name (verified against live `ps` output), so the common case is exact.
        assert!(process_identity_matches("claude", None, &["claude"]));
        assert!(process_identity_matches("codex", None, &["codex"]));
        // A path or an .exe suffix still resolves to the same stem.
        assert!(process_identity_matches(
            "/Users/x/.local/bin/claude",
            None,
            &["claude"]
        ));
        assert!(process_identity_matches(
            "C:\\bin\\codex.exe",
            None,
            &["codex"]
        ));
        assert!(process_identity_matches("CLAUDE", None, &["claude"]));
        // A wrapper whose process name is the interpreter is recognized via argv[0].
        assert!(process_identity_matches(
            "node",
            Some("/usr/local/bin/claude"),
            &["claude"]
        ));
    }

    #[test]
    fn process_identity_rejects_a_recycled_pid() {
        // The whole point: the pid died and the OS handed it to something else.
        assert!(!process_identity_matches("Finder", None, &["claude"]));
        assert!(!process_identity_matches("", None, &["claude"]));
        assert!(!process_identity_matches("", Some(""), &["claude"]));
        // Substring collisions must NOT pass — `codex-helper` is a different
        // program (the ChatGPT desktop app ships several such helpers).
        assert!(!process_identity_matches("codex-helper", None, &["codex"]));
        assert!(!process_identity_matches("mycodex", None, &["codex"]));
        // Right shape, wrong agent.
        assert!(!process_identity_matches("codex", None, &["claude"]));
    }

    #[test]
    fn check_interrupt_refuses_before_signalling() {
        let expected = &["claude"];
        // Happy path.
        assert_eq!(
            check_interrupt(true, Some(("claude", None)), expected),
            Ok(())
        );
        // Platform can't deliver a turn-cancelling interrupt.
        assert_eq!(
            check_interrupt(false, Some(("claude", None)), expected),
            Err(InterruptRefusal::Unsupported)
        );
        // Nothing at that pid any more.
        assert_eq!(
            check_interrupt(true, None, expected),
            Err(InterruptRefusal::NotRunning)
        );
        // Something at that pid, but not our agent — the misfire we must never make.
        assert_eq!(
            check_interrupt(true, Some(("Finder", None)), expected),
            Err(InterruptRefusal::IdentityMismatch)
        );
        // The platform gate is checked FIRST, so an unsupported platform never
        // even consults a process it has no business signalling.
        assert_eq!(
            check_interrupt(false, None, expected),
            Err(InterruptRefusal::Unsupported)
        );
    }

    #[test]
    fn refusal_codes_are_stable_for_the_frontend() {
        assert_eq!(
            InterruptRefusal::Unsupported.code(),
            "interrupt_unsupported"
        );
        assert_eq!(InterruptRefusal::NotRunning.code(), "interrupt_not_running");
        assert_eq!(
            InterruptRefusal::IdentityMismatch.code(),
            "interrupt_identity_mismatch"
        );
    }

    #[test]
    fn expected_names_cover_every_agent() {
        use crate::fleet::registry::FleetAgent;
        assert_eq!(expected_process_names(FleetAgent::ClaudeCode), &["claude"]);
        assert_eq!(expected_process_names(FleetAgent::Codex), &["codex"]);
        assert_eq!(expected_process_names(FleetAgent::Opencode), &["opencode"]);
    }

    #[test]
    fn process_interrupt_is_a_unix_only_capability() {
        // Windows console control events cannot reach a process that does not
        // share our console, so the capability (and the button) stay off there.
        assert_eq!(can_interrupt(), cfg!(unix));
    }

    #[tokio::test]
    async fn interrupt_session_rejects_an_unknown_agent() {
        let err = interrupt_session("not-an-agent", "s1").await.unwrap_err();
        assert!(err.contains("unknown agent"));
    }

    #[tokio::test]
    async fn focus_session_terminal_rejects_an_unknown_agent() {
        let err = focus_session_terminal("not-an-agent", "s1")
            .await
            .unwrap_err();
        assert!(err.contains("unknown agent"));
    }
}
