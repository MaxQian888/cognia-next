// Runtime window-behavior state pushed from the frontend.
//
// Holds the user's "what happens when the main window is closed" choice as a
// tri-state: ask the user, minimize to the system tray, or quit. The frontend
// persists the choice via the store plugin and pushes it into us through
// `set_close_behavior` on change and at boot. The close-requested handler
// installed in `lib.rs` reads it synchronously, so an `AtomicU8` is enough.

use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc,
};

use tauri::Manager;

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

#[derive(Clone, Default)]
pub struct WindowBehavior {
    behavior: Arc<AtomicU8>,
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
    fn store_and_load_behavior() {
        let wb = WindowBehavior::new();
        wb.set_close_behavior(CloseBehavior::Tray);
        assert_eq!(wb.close_behavior(), CloseBehavior::Tray);
        wb.set_close_behavior(CloseBehavior::Quit);
        assert_eq!(wb.close_behavior(), CloseBehavior::Quit);
    }
}
