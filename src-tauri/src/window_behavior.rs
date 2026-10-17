// Runtime window-behavior state pushed from the frontend.
//
// Holds the user's "what happens when the main window is closed" choice as a
// tri-state: ask the user, minimize to the system tray, or quit. The frontend
// persists the choice via the store plugin and pushes it into us through
// `set_close_behavior` on change and at boot. The close-requested handler
// installed in `lib.rs` reads it synchronously, so an `AtomicU8` is enough.
//
// It also holds the always-on host mode (ADR-0224 A3). Unlike the close
// behavior, Rust owns that flag's persistence (`host-mode.json` in the app
// config dir): a login launch has to decide to stay hidden and to hold the
// machine awake before any renderer exists to tell it. The renderer reads and
// writes it through `host_mode_get` / `host_mode_set`. It is device-local by
// construction; nothing syncs it.

use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc,
};

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// The argument the OS login entry launches the app with. Registered on the
/// autostart plugin in `lib.rs` and declared in `tauri.conf.json`'s CLI args so
/// the CLI plugin accepts it.
pub const AUTOSTART_ARG: &str = "--autostart";

/// The host mode's file under the app config dir.
pub const HOST_MODE_FILE: &str = "host-mode.json";

/// What to do when the main window's close button is pressed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum CloseBehavior {
    /// Prompt the user with the exit-confirmation dialog.
    #[default]
    Ask,
    /// Hide the window, keeping the app alive in the system tray.
    Tray,
    /// Close the window and quit the app.
    Quit,
}

impl CloseBehavior {
    pub fn as_str(self) -> &'static str {
        match self {
            CloseBehavior::Ask => "ask",
            CloseBehavior::Tray => "tray",
            CloseBehavior::Quit => "quit",
        }
    }

    /// Parse a behavior string. Unknown values fall back to `Ask` so a
    /// corrupted preference can never silently swallow the close button.
    pub fn parse(value: &str) -> Self {
        match value {
            "tray" => CloseBehavior::Tray,
            "quit" => CloseBehavior::Quit,
            _ => CloseBehavior::Ask,
        }
    }

    fn from_u8(value: u8) -> Self {
        match value {
            1 => CloseBehavior::Tray,
            2 => CloseBehavior::Quit,
            _ => CloseBehavior::Ask,
        }
    }

    fn as_u8(self) -> u8 {
        match self {
            CloseBehavior::Ask => 0,
            CloseBehavior::Tray => 1,
            CloseBehavior::Quit => 2,
        }
    }
}

/// Whether this process was started by the OS login entry.
pub fn launched_at_login<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|arg| arg.as_ref() == AUTOSTART_ARG)
}

/// A login launch stays hidden only in host mode. Ordinary "launch at login"
/// still opens the window, as it always has; a host the user is away from has
/// nobody to show it to.
pub fn boot_hidden(launched_at_login: bool, host_mode: bool) -> bool {
    launched_at_login && host_mode
}

/// The close behavior that applies. Host mode always closes to the tray:
/// quitting the host from its close button would silently stop every bot and
/// schedule it runs. The tray's Quit still exits.
pub fn effective_close_behavior(stored: CloseBehavior, host_mode: bool) -> CloseBehavior {
    if host_mode {
        CloseBehavior::Tray
    } else {
        stored
    }
}

/// A renderer that never painted cannot answer the close-confirmation event.
pub fn close_behavior_for_renderer(
    effective: CloseBehavior,
    renderer_revealed: bool,
) -> CloseBehavior {
    if effective == CloseBehavior::Ask && !renderer_revealed {
        CloseBehavior::Quit
    } else {
        effective
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct HostModeFile {
    enabled: bool,
}

/// Read the persisted host mode. A missing or unreadable file is "off": the
/// mode keeps a machine awake and hidden, so it is never assumed on.
pub fn read_host_mode(path: &Path) -> bool {
    std::fs::read(path)
        .ok()
        .and_then(|raw| serde_json::from_slice::<HostModeFile>(&raw).ok())
        .is_some_and(|file| file.enabled)
}

/// Persist the host mode, replacing the file atomically so a crash mid-write
/// cannot leave a corrupt file that reads back as a different answer.
pub fn write_host_mode(path: &Path, enabled: bool) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = serde_json::to_vec(&HostModeFile { enabled }).map_err(std::io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)
}

fn host_mode_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(HOST_MODE_FILE))
}

/// What the renderer learns about the host mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostModeStatus {
    /// The persisted mode.
    pub enabled: bool,
    /// This process was a login launch in host mode and must not reveal the
    /// main window at boot. Fixed for the life of the process.
    pub boot_hidden: bool,
}

#[derive(Clone, Default)]
pub struct WindowBehavior {
    behavior: Arc<AtomicU8>,
    host_mode: Arc<AtomicBool>,
    boot_hidden: Arc<AtomicBool>,
}

impl WindowBehavior {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_close_behavior(&self, behavior: CloseBehavior) {
        self.behavior.store(behavior.as_u8(), Ordering::Relaxed);
    }

    pub fn close_behavior(&self) -> CloseBehavior {
        CloseBehavior::from_u8(self.behavior.load(Ordering::Relaxed))
    }

    /// The close behavior the close-requested handler applies.
    pub fn effective_close_behavior(&self) -> CloseBehavior {
        effective_close_behavior(self.close_behavior(), self.host_mode())
    }

    pub fn set_host_mode(&self, enabled: bool) {
        self.host_mode.store(enabled, Ordering::Relaxed);
    }

    pub fn host_mode(&self) -> bool {
        self.host_mode.load(Ordering::Relaxed)
    }

    pub fn set_boot_hidden(&self, hidden: bool) {
        self.boot_hidden.store(hidden, Ordering::Relaxed);
    }

    pub fn boot_hidden(&self) -> bool {
        self.boot_hidden.load(Ordering::Relaxed)
    }

    pub fn host_mode_status(&self) -> HostModeStatus {
        HostModeStatus {
            enabled: self.host_mode(),
            boot_hidden: self.boot_hidden(),
        }
    }
}

/// Boot step: load the persisted host mode, take its wake hold, and decide
/// whether this launch stays hidden. Runs before `main_window`, so the close
/// handler and the boot reveal see the answer from the first event.
#[cfg(desktop)]
pub(crate) fn init_host_mode(app: &tauri::App) {
    let enabled = host_mode_path(app.handle()).is_some_and(|path| read_host_mode(&path));
    let state = app.state::<WindowBehavior>();
    state.set_host_mode(enabled);
    let hidden = boot_hidden(launched_at_login(std::env::args()), enabled);
    state.set_boot_hidden(hidden);
    if hidden {
        // The renderer skips its reveal; the force-show safety net must too,
        // or the host pops its window up eight seconds after every login.
        app.state::<crate::webview_watchdog::WebviewWatchdog>()
            .acknowledge_boot_reveal();
    }
    if enabled {
        log::info!("host mode: on (boot hidden: {hidden})");
        // Installing the assertion spawns a process on Linux and waits on a
        // thread on Windows; keep it off the setup (main) thread.
        tauri::async_runtime::spawn_blocking(|| crate::power_assertion::set_host_mode_hold(true));
    }
}

/// Bring the hidden main window back when the Dock icon is clicked (macOS).
/// A host launched hidden at login, or closed to the tray, otherwise has only
/// the tray icon as a way back.
pub(crate) fn handle_run_event<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    event: &tauri::RunEvent,
) {
    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::Reopen {
        has_visible_windows: false,
        ..
    } = event
    {
        crate::window_utils::bring_main_window_to_front(app);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

#[tauri::command]
pub fn host_mode_get(state: tauri::State<'_, WindowBehavior>) -> HostModeStatus {
    state.host_mode_status()
}

/// Persist the host mode, apply it to the close handler and take or drop its
/// wake hold. `async` so the platform assertion is installed off the main
/// thread (see `power_assertion::power_screen_holds_set`).
#[tauri::command]
pub async fn host_mode_set(app: tauri::AppHandle, enabled: bool) -> Result<HostModeStatus, String> {
    let path = host_mode_path(&app).ok_or("the app config directory is unavailable")?;
    write_host_mode(&path, enabled)
        .map_err(|error| format!("could not save host mode to {}: {error}", path.display()))?;
    let state = app.state::<WindowBehavior>();
    state.set_host_mode(enabled);
    crate::power_assertion::set_host_mode_hold(enabled);
    log::info!("host mode: {}", if enabled { "on" } else { "off" });
    Ok(state.host_mode_status())
}

#[tauri::command]
pub fn set_close_behavior(state: tauri::State<'_, WindowBehavior>, behavior: String) {
    state.set_close_behavior(CloseBehavior::parse(&behavior));
}

#[tauri::command]
pub fn get_close_behavior(state: tauri::State<'_, WindowBehavior>) -> String {
    state.close_behavior().as_str().to_string()
}

/// Resolve a pending close request after the user answers the exit-confirmation
/// dialog. Window manipulation stays Rust-side to mirror the tray-on-close
/// path and avoid widening the webview's window capabilities.
#[tauri::command]
pub fn resolve_close_request(app: tauri::AppHandle, action: String) {
    match action.as_str() {
        "minimize" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        "quit" => app.exit(0),
        // "cancel" and any unknown action leave the window untouched.
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unrevealed_renderer_never_waits_for_a_close_dialog() {
        for behavior in [CloseBehavior::Ask, CloseBehavior::Quit, CloseBehavior::Tray] {
            assert_eq!(close_behavior_for_renderer(behavior, true), behavior);
            assert_eq!(
                close_behavior_for_renderer(behavior, false),
                if behavior == CloseBehavior::Ask {
                    CloseBehavior::Quit
                } else {
                    behavior
                }
            );
            assert_eq!(
                close_behavior_for_renderer(effective_close_behavior(behavior, true), false),
                CloseBehavior::Tray
            );
        }
    }

    #[test]
    fn parse_maps_known_values() {
        assert_eq!(CloseBehavior::parse("ask"), CloseBehavior::Ask);
        assert_eq!(CloseBehavior::parse("tray"), CloseBehavior::Tray);
        assert_eq!(CloseBehavior::parse("quit"), CloseBehavior::Quit);
    }

    #[test]
    fn parse_falls_back_to_ask_for_unknown() {
        assert_eq!(CloseBehavior::parse(""), CloseBehavior::Ask);
        assert_eq!(CloseBehavior::parse("bogus"), CloseBehavior::Ask);
    }

    #[test]
    fn as_str_round_trips() {
        for b in [CloseBehavior::Ask, CloseBehavior::Tray, CloseBehavior::Quit] {
            assert_eq!(CloseBehavior::parse(b.as_str()), b);
        }
    }

    #[test]
    fn default_behavior_is_ask() {
        let wb = WindowBehavior::new();
        assert_eq!(wb.close_behavior(), CloseBehavior::Ask);
    }

    #[test]
    fn only_the_login_entry_argument_marks_a_login_launch() {
        assert!(launched_at_login([
            "/Applications/Cognia.app",
            "--autostart"
        ]));
        assert!(!launched_at_login(["/Applications/Cognia.app"]));
        assert!(!launched_at_login(["cognia", "/path/--autostart"]));
    }

    #[test]
    fn only_a_login_launch_in_host_mode_stays_hidden() {
        assert!(boot_hidden(true, true));
        // Plain "launch at login" still opens the window.
        assert!(!boot_hidden(true, false));
        // Opening the app by hand always shows it, host mode or not.
        assert!(!boot_hidden(false, true));
        assert!(!boot_hidden(false, false));
    }

    #[test]
    fn host_mode_always_closes_to_the_tray() {
        for stored in [CloseBehavior::Ask, CloseBehavior::Tray, CloseBehavior::Quit] {
            assert_eq!(effective_close_behavior(stored, true), CloseBehavior::Tray);
            assert_eq!(effective_close_behavior(stored, false), stored);
        }
        let wb = WindowBehavior::new();
        wb.set_close_behavior(CloseBehavior::Quit);
        wb.set_host_mode(true);
        assert_eq!(wb.effective_close_behavior(), CloseBehavior::Tray);
        // The stored preference survives for when the mode is turned off.
        assert_eq!(wb.close_behavior(), CloseBehavior::Quit);
        wb.set_host_mode(false);
        assert_eq!(wb.effective_close_behavior(), CloseBehavior::Quit);
    }

    #[test]
    fn host_mode_round_trips_through_its_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(HOST_MODE_FILE);
        assert!(!read_host_mode(&path), "a missing file is off");
        write_host_mode(&path, true).unwrap();
        assert!(read_host_mode(&path));
        write_host_mode(&path, false).unwrap();
        assert!(!read_host_mode(&path));
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn a_corrupt_host_mode_file_reads_as_off() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(HOST_MODE_FILE);
        std::fs::write(&path, b"{not json").unwrap();
        assert!(!read_host_mode(&path));
        std::fs::write(&path, br#"{"enabled":"yes"}"#).unwrap();
        assert!(!read_host_mode(&path));
    }

    #[test]
    fn host_mode_status_serializes_for_the_renderer() {
        let wb = WindowBehavior::new();
        wb.set_host_mode(true);
        wb.set_boot_hidden(true);
        assert_eq!(
            serde_json::to_value(wb.host_mode_status()).unwrap(),
            serde_json::json!({ "enabled": true, "bootHidden": true })
        );
    }

    #[test]
    fn the_host_mode_commands_and_boot_step_are_wired() {
        let lib = include_str!("lib.rs");
        let production = lib.split("#[cfg(test)]").next().unwrap();
        for needle in [
            "window_behavior::host_mode_get,",
            "window_behavior::host_mode_set,",
            "window_behavior::handle_run_event(",
            ".args([window_behavior::AUTOSTART_ARG])",
        ] {
            assert!(production.contains(needle), "lib.rs must contain {needle}");
        }
        let conf = include_str!("../tauri.conf.json");
        assert!(
            conf.contains("\"name\": \"autostart\""),
            "the CLI plugin must accept the login entry's argument"
        );
    }

    #[test]
    fn store_and_load_behavior() {
        let wb = WindowBehavior::new();
        wb.set_close_behavior(CloseBehavior::Tray);
        assert_eq!(wb.close_behavior(), CloseBehavior::Tray);
        wb.set_close_behavior(CloseBehavior::Quit);
        assert_eq!(wb.close_behavior(), CloseBehavior::Quit);
    }
}
