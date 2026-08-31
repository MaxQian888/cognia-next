//! The skill recorder's always-on-top controller strip.
//!
//! While a recording runs the Sheet is closed, so this is the only surface the
//! user has: elapsed time, step count, scope, pause/resume, undo, finish. Three
//! properties make it trustworthy rather than merely present:
//!
//! - **Excluded from capture.** Established at build time and re-asserted after
//!   the NSPanel conversion and on every reveal. Fail-closed — a controller that
//!   appears in its own frames poisons the whole bundle.
//! - **Non-focus-stealing until clicked.** A non-activating NSPanel on macOS,
//!   `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` on Windows. Recording is observation;
//!   the controller must never steal focus from what is being recorded.
//! - **Collapsible, not dismissible.** Enforced by the ACL, not by UI
//!   discipline: `capabilities/recorder-controller.json` grants no
//!   `core:window:allow-close` and no `allow-hide`, so even a bug in the webview
//!   cannot leave a recording running with no way to stop it.
//!
//! Its own module rather than a second role inside `selection_toolbar.rs`: the
//! panel generation / open-intent / lifecycle statics are keyed by role, so
//! sharing one would let a toolbar dismissal cancel an in-flight controller
//! reveal.

pub mod adapters;
pub mod capture_exclusion;

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

pub const RECORDER_CONTROLLER_LABEL: &str = "recorder-controller";

/// Expanded strip: timer, scope, counter, and the four controls.
pub const CONTROLLER_W: f64 = 420.0;
pub const CONTROLLER_H: f64 = 56.0;
/// Collapsed pill: elapsed time and a resume affordance only.
pub const CONTROLLER_COLLAPSED_W: f64 = 120.0;
pub const CONTROLLER_COLLAPSED_H: f64 = 40.0;

/// Event the controller webview listens on for collapse-state changes.
pub const CONTROLLER_EVENT: &str = "recorder:controller";

fn ensure_window<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(RECORDER_CONTROLLER_LABEL) {
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        RECORDER_CONTROLLER_LABEL,
        WebviewUrl::App(RECORDER_CONTROLLER_LABEL.into()),
    )
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .visible(false)
    // Frame-zero exclusion: closes the window between `build()` and the first
    // explicit `set_capture_excluded` below, during which a capture could
    // otherwise catch it.
    .content_protected(true)
    .inner_size(CONTROLLER_W, CONTROLLER_H)
    .build()
    .map_err(|error| error.to_string())?;
    let _ = window.remove_menu();

    // Awaited and fail-closed, mirroring `selection_toolbar::ensure_window`:
    // `run_on_main_thread` only enqueues, so a failed conversion would otherwise
    // leave an ordinary — activating — NSWindow on screen for the session.
    #[cfg(target_os = "macos")]
    if let Err(error) = crate::pet_window::configure_overlay_panel(
        &window,
        crate::pet_window::OverlayPanelRole::RecorderController,
    ) {
        let _ = window.close();
        return Err(format!("recorder controller NSPanel setup failed: {error}"));
    }
    #[cfg(target_os = "windows")]
    crate::window_utils::apply_windows_no_activate(&window)?;

    // Re-assert after the panel reclass: `apply_pet_panel_behavior` replaces the
    // window's class, and re-establishing exclusion afterwards is cheaper than
    // reasoning about whether `sharingType` survived.
    if let Err(error) = capture_exclusion::set_capture_excluded(&window, true) {
        let _ = window.close();
        return Err(error);
    }

    Ok(window)
}

/// Create (if needed) and reveal the controller.
pub fn show<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let window = ensure_window(app)?;
    // Re-assert on every reveal — the window is hidden and shown across collapse
    // cycles, and this is the cheap place to guarantee the invariant holds.
    capture_exclusion::set_capture_excluded(&window, true)?;

    // On macOS this must go through the panel rather than `WebviewWindow::show`:
    // the generation check inside `reveal_overlay_panel` is what lets a teardown
    // that lands while a reveal is queued actually cancel it. `focus: false` —
    // appearing must never take the keyboard away from whatever is being
    // recorded; the strip becomes key only when the user clicks it.
    #[cfg(target_os = "macos")]
    {
        let role = crate::pet_window::OverlayPanelRole::RecorderController;
        let generation = crate::pet_window::current_overlay_panel_generation(role);
        crate::pet_window::reveal_overlay_panel(&window, role, false, generation)?;
    }
    #[cfg(not(target_os = "macos"))]
    window.show().map_err(|error| error.to_string())?;
    Ok(())
}

/// Tear the controller down. Called only from `record_stop` /
/// `record_interrupt` — never from the webview.
pub fn destroy<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(RECORDER_CONTROLLER_LABEL) {
        #[cfg(target_os = "macos")]
        let _ = crate::pet_window::detach_overlay_panel(&window);
        let _ = window.close();
    }
}

/// Switch between the expanded strip and the collapsed pill.
///
/// Deliberately not a hide: while a recording runs there must always be
/// something on screen that can stop it.
#[tauri::command]
pub async fn recorder_controller_set_collapsed(
    app: AppHandle,
    collapsed: bool,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window(RECORDER_CONTROLLER_LABEL) else {
        return Err("the recorder controller is not open".into());
    };
    let (w, h) = if collapsed {
        (CONTROLLER_COLLAPSED_W, CONTROLLER_COLLAPSED_H)
    } else {
        (CONTROLLER_W, CONTROLLER_H)
    };
    window
        .set_size(tauri::LogicalSize::new(w, h))
        .map_err(|error| error.to_string())?;
    let _ = tauri::Emitter::emit(&app, CONTROLLER_EVENT, collapsed);
    Ok(())
}

/// Begin an OS-level drag. Works on the non-activating panel and does not
/// activate the app, which is what lets the user reposition the strip without
/// stealing focus from whatever they are recording.
#[tauri::command]
pub async fn recorder_controller_begin_drag(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(RECORDER_CONTROLLER_LABEL) else {
        return Err("the recorder controller is not open".into());
    };
    window.start_dragging().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parse the capability/permission files as data. AppKit and window creation
    /// are untestable under `mock_app()`, but the ACL that makes "not
    /// dismissible" true is just JSON and TOML — so it can be pinned here rather
    /// than trusted to review.
    const CAPABILITY: &str = include_str!("../../capabilities/recorder-controller.json");
    const PERMISSION: &str =
        include_str!("../../permissions/recorder-controller-app-commands.toml");

    #[test]
    fn controller_size_is_420_by_56() {
        assert_eq!((CONTROLLER_W, CONTROLLER_H), (420.0, 56.0));
    }

    #[test]
    fn collapsed_size_is_smaller_in_both_axes() {
        const { assert!(CONTROLLER_COLLAPSED_W < CONTROLLER_W) };
        const { assert!(CONTROLLER_COLLAPSED_H < CONTROLLER_H) };
    }

    #[test]
    fn capability_targets_only_the_controller_window() {
        let value: serde_json::Value = serde_json::from_str(CAPABILITY).unwrap();
        let windows = value["windows"].as_array().expect("windows list");
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0], RECORDER_CONTROLLER_LABEL);
    }

    #[test]
    fn capability_grants_no_close_or_hide() {
        // This is what makes "collapsible, not dismissible" an invariant rather
        // than a UI convention.
        assert!(
            !CAPABILITY.contains("core:window:allow-close"),
            "the controller must not be closable from the webview"
        );
        assert!(
            !CAPABILITY.contains("core:window:allow-hide"),
            "the controller must not be hidable from the webview"
        );
        assert!(!CAPABILITY.contains("core:window:allow-destroy"));
    }

    #[test]
    fn capability_grants_what_the_strip_actually_needs() {
        for permission in [
            "core:window:allow-set-size",
            "core:window:allow-start-dragging",
            "allow-recorder-controller-app-commands",
        ] {
            assert!(CAPABILITY.contains(permission), "missing {permission}");
        }
    }

    #[test]
    fn permission_toml_excludes_record_start() {
        // Only the main window may *begin* a recording. The controller drives a
        // session that already exists.
        assert!(
            !PERMISSION.contains("\"record_start\""),
            "the controller must not be able to start a recording"
        );
    }

    #[test]
    fn permission_toml_excludes_the_bundle_read_surface() {
        // Frames and journals are for the review UI in the main window; the
        // controller has no reason to read them, so it cannot.
        for command in [
            "record_read_asset",
            "record_load_bundle",
            "record_list_recoverable",
            "record_delete_bundle",
        ] {
            assert!(
                !PERMISSION.contains(&format!("\"{command}\"")),
                "the controller must not be granted {command}"
            );
        }
    }

    #[test]
    fn permission_toml_grants_the_session_controls() {
        for command in [
            "record_status",
            "record_pause",
            "record_resume",
            "record_undo_last",
            "record_stop",
            "record_interrupt",
            "recorder_controller_set_collapsed",
            "recorder_controller_begin_drag",
        ] {
            assert!(
                PERMISSION.contains(&format!("\"{command}\"")),
                "the controller needs {command}"
            );
        }
    }

    #[test]
    fn controller_event_name_is_stable() {
        assert_eq!(CONTROLLER_EVENT, "recorder:controller");
    }
}
