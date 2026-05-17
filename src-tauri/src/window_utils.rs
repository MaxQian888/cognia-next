// Small Rust helpers shared by the system tray, global-shortcut handler, and
// menu bar. Centralised here so the show / unminimize / set_focus triad
// stays consistent — previously it was duplicated four times across
// `tray.rs` and `lib.rs`.

use tauri::{Manager, Runtime, WebviewWindow};

/// Surface the window: make it visible, undo any minimise, and pull focus.
/// Each step is best-effort — Tauri returns `Err` only when the underlying
/// platform call fails (e.g. window already destroyed), and in every call
/// site we simply want to "do whatever is needed to show it now".
pub fn bring_window_to_front<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Look up the main window by handle and surface it. Returns `true` when the
/// window existed and the calls were attempted, `false` when the main window
/// could not be resolved (during shutdown, headless build, etc.).
pub fn bring_main_window_to_front<R: Runtime, M: Manager<R>>(handle: &M) -> bool {
    if let Some(window) = handle.get_webview_window("main") {
        bring_window_to_front(&window);
        true
    } else {
        false
    }
}

// `bring_window_to_front` / `bring_main_window_to_front` are thin wrappers
// over `WebviewWindow::{show,unminimize,set_focus}` and `Manager::
// get_webview_window`. They have no branches beyond the `Option` unwrap,
// and a meaningful runtime assertion would require `tauri::test::mock_app()`
// (which depends on the `test` feature this project does not enable — see
// `plugin_api/window_ops.rs:46` for the same convention). Type-system
// signature drift is caught by every call site in `tray::mod` and
// `lib.rs`'s global-shortcut handler, so a duplicate compile-test would
// add no coverage.
