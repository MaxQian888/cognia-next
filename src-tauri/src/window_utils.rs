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

/// The extended style an overlay window must end up with.
///
/// `WS_EX_NOACTIVATE` stops the window taking focus when clicked or shown;
/// `WS_EX_TOOLWINDOW` keeps it out of the taskbar and Alt-Tab. Split out from
/// the FFI so the bit arithmetic — the part that can be wrong without any OS
/// involvement — is assertable on every platform, not only on Windows.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn no_activate_ex_style(current: i32) -> i32 {
    // Values are fixed by the Win32 headers; naming them here rather than
    // importing keeps this compiled (and tested) on macOS and Linux too.
    const WS_EX_TOOLWINDOW_BITS: i32 = 0x0000_0080;
    const WS_EX_NOACTIVATE_BITS: i32 = 0x0800_0000;
    current | WS_EX_NOACTIVATE_BITS | WS_EX_TOOLWINDOW_BITS
}

/// Make an overlay window non-activating on Windows.
///
/// Both the selection toolbar and the skill-recorder controller need exactly
/// this — an overlay that stole focus from the app being observed would change
/// the thing it is observing.
///
/// Fail-closed. `GetWindowLongW` / `SetWindowLongW` both report failure by
/// returning 0, which is also a legitimate result, so the documented idiom is to
/// clear the thread's last error first and consult it when the return value is
/// 0. Swallowing a failure here would leave a focus-stealing overlay on screen
/// while every caller's `?` says the window is safe.
#[cfg(target_os = "windows")]
pub fn apply_windows_no_activate<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    use windows::Win32::Foundation::{GetLastError, SetLastError, WIN32_ERROR};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, GWL_EXSTYLE,
    };
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;

    // SAFETY: `hwnd` is a live handle owned by this process; these are ordinary
    // window-style reads/writes and the error slot is per-thread.
    let current = unsafe {
        SetLastError(WIN32_ERROR(0));
        GetWindowLongW(hwnd, GWL_EXSTYLE)
    };
    if current == 0 {
        let code = unsafe { GetLastError() };
        if code.0 != 0 {
            return Err(format!(
                "could not read the overlay window's extended style (win32 error {})",
                code.0
            ));
        }
    }

    let next = no_activate_ex_style(current);
    // SAFETY: same handle; `next` is a valid extended-style bitmask.
    let previous = unsafe {
        SetLastError(WIN32_ERROR(0));
        SetWindowLongW(hwnd, GWL_EXSTYLE, next)
    };
    if previous == 0 {
        let code = unsafe { GetLastError() };
        if code.0 != 0 {
            return Err(format!(
                "could not make the overlay window non-activating (win32 error {})",
                code.0
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::no_activate_ex_style;

    /// The two bits the overlay contract depends on, as the Win32 headers
    /// define them. Pinned so a typo in the constants cannot ship a toolbar
    /// that quietly steals focus.
    #[test]
    fn sets_both_no_activate_and_tool_window() {
        assert_eq!(no_activate_ex_style(0), 0x0800_0080);
    }

    #[test]
    fn preserves_styles_the_window_already_had() {
        // WS_EX_LAYERED (0x0008_0000) is set by the transparent overlay build;
        // dropping it would make the window opaque.
        let layered = 0x0008_0000;
        assert_eq!(no_activate_ex_style(layered) & layered, layered);
    }

    #[test]
    fn is_idempotent() {
        let once = no_activate_ex_style(0x0008_0000);
        assert_eq!(no_activate_ex_style(once), once);
    }
}
