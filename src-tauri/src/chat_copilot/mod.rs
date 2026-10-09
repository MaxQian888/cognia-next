//! The desktop chat copilot's overlay panel (ADR-0194 §8).
//!
//! The copilot reads the chat window in front (`automation::commands::
//! desktop_capture_frontmost_window`) and shows what it made of it here,
//! beside that window. Same window recipe as the Capacity Dock and the fleet
//! island: transparent, frameless, always-on-top, skip-taskbar, created hidden
//! and revealed by the renderer after first paint, and reclassed on macOS to a
//! NON-ACTIVATING NSPanel through the shared pet panel seam, so the chat app
//! stays frontmost while the user reads, copies, or answers the consent
//! prompt in it.
//!
//! Where it differs:
//!
//!   * ANCHORED TO ANOTHER APP'S WINDOW. The renderer relays the captured
//!     window's bounds; `placement.rs` puts the panel beside it, never over
//!     the conversation. Before the window is known (the capture is asking
//!     for consent) it waits at the top-right of the screen under the cursor.
//!   * KEPT OUT OF SCREEN CAPTURE. It shows a read of someone's private
//!     conversation; a screen share or recording must not pick it up. Best
//!     effort: where the OS refuses, the panel still works and the refusal is
//!     logged, because the capture that fed it was already approved.
//!   * COPIES THROUGH THE HOST. The panel never takes focus, and a webview's
//!     `navigator.clipboard` refuses to write from an unfocused document.
//!
//! Placement is computed in desktop units (points on macOS, physical pixels
//! elsewhere; see `desktop_space`) and applied with the selection toolbar's
//! `place_window`, so the panel lands where intended when it moves between a
//! Retina display and a 1x one.
//!
//! Live window operations cannot run under `tauri::test::mock_app()` on this
//! project's toolchains (documented in `pet_window/mod.rs`), so only the pure
//! placement math is unit-tested; runtime behaviour is covered by
//! `tauri-smoke`.

pub mod placement;

use crate::automation::platform::shared::desktop_space::{self, DesktopMonitor};
use crate::selection_toolbar::{desktop_monitors, place_window};
use placement::{Anchor, Target};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_clipboard_manager::ClipboardExt;

pub const CHAT_COPILOT_LABEL: &str = "chat-copilot";

const DEFAULT_WIDTH: f64 = 380.0;
const DEFAULT_HEIGHT: f64 = 240.0;
/// A candidate is a short IM reply; anything past this is not one.
const MAX_COPY_CHARS: usize = 20_000;

/// The chat window the panel belongs beside, as last relayed. `None` while a
/// run is still waiting for its capture.
static ANCHOR: Mutex<Option<Anchor>> = Mutex::new(None);

fn current_anchor() -> Option<Anchor> {
    *ANCHOR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn set_anchor(anchor: Option<Anchor>) {
    *ANCHOR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = anchor;
}

/// The cursor in desktop units, if the platform reports it.
fn cursor<R: Runtime>(app: &AppHandle<R>) -> Option<(f64, f64)> {
    let cursor = app.cursor_position().ok()?;
    let primary_scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map_or(1.0, |monitor| monitor.scale_factor());
    let (x, y) = desktop_space::cursor_point(
        (cursor.x, cursor.y),
        primary_scale,
        desktop_space::DESKTOP_UNITS_ARE_POINTS,
    );
    Some((f64::from(x), f64::from(y)))
}

/// What the panel goes beside right now, and every display, in desktop units.
fn layout<R: Runtime>(app: &AppHandle<R>) -> (Target, Vec<DesktopMonitor>) {
    let target = match current_anchor() {
        Some(anchor) => Target::Window(placement::to_desktop(
            &anchor,
            desktop_space::DESKTOP_UNITS_ARE_POINTS,
        )),
        None => Target::Cursor(cursor(app)),
    };
    (target, desktop_monitors(app))
}

/// The panel's current outer size in desktop units. tao reports it as the
/// logical size times the scale of the display the panel is on now.
fn panel_size<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Option<(f64, f64)> {
    let size = window.outer_size().ok()?;
    let scale = window.scale_factor().ok()?;
    let frame = desktop_space::window_frame(
        (0, 0),
        (size.width, size.height),
        scale,
        desktop_space::DESKTOP_UNITS_ARE_POINTS,
    );
    Some((f64::from(frame.width), f64::from(frame.height)))
}

/// Resize the panel to a size in desktop units. Logical on macOS for the same
/// reason `place_window` positions logically there: tao divides a physical
/// size by the scale of the display the panel is on NOW, not the one it is
/// about to move to.
fn size_window<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    (width, height): (f64, f64),
) -> Result<(), String> {
    let result = if desktop_space::DESKTOP_UNITS_ARE_POINTS {
        window.set_size(tauri::LogicalSize::new(width, height))
    } else {
        window.set_size(tauri::PhysicalSize::new(width, height))
    };
    result.map_err(|error| error.to_string())
}

/// Move the panel beside the anchor (or to the cursor's screen). `panel` is
/// its size in desktop units when the caller just set it: on macOS a resize
/// lands asynchronously, so reading it back could see the old size.
fn reposition<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
    panel: Option<(f64, f64)>,
) -> Result<(), String> {
    let (target, monitors) = layout(app);
    let panel = panel
        .or_else(|| panel_size(window))
        .unwrap_or_else(|| placement::fit(target, (DEFAULT_WIDTH, DEFAULT_HEIGHT), &monitors));
    let (x, y) = placement::position(target, panel, &monitors);
    place_window(window, x.round() as i32, y.round() as i32)
}

fn open_claimed<R: Runtime>(app: &AppHandle<R>, generation: u64) -> Result<(), String> {
    let role = crate::pet_window::OverlayPanelRole::ChatCopilot;
    if !crate::pet_window::overlay_panel_generation_is_current(role, generation) {
        return Ok(());
    }

    if let Some(window) = app.get_webview_window(CHAT_COPILOT_LABEL) {
        let _ = reposition(app, &window, None);
        if let Err(error) =
            crate::pet_window::reveal_overlay_panel(&window, role, false, generation)
        {
            crate::pet_window::cancel_overlay_panel_reveal(role);
            return Err(error);
        }
        return Ok(());
    }

    let window = tauri::WebviewWindowBuilder::new(
        app,
        CHAT_COPILOT_LABEL,
        tauri::WebviewUrl::App("chat-copilot".into()),
    )
    // `transparent(true)` only, never `.background_color(...)`, which forces an
    // opaque layer on Windows. The page paints its own card.
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    // Never take focus on creation: the chat app must stay frontmost, both so
    // the user keeps typing there and so a re-capture reads the same window.
    .focused(false)
    // Created hidden: on Windows a transparent window shown before its first
    // paint renders as a black rectangle, so the renderer signals readiness.
    .visible(false)
    .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
    .build()
    .map_err(|error| {
        crate::pet_window::cancel_overlay_panel_reveal(role);
        error.to_string()
    })?;

    // Strip the app menu bar on Windows/Linux, same as the other overlays.
    let _ = window.remove_menu();

    if let Err(error) =
        crate::recorder_window::capture_exclusion::set_capture_excluded(&window, true)
    {
        log::warn!("chat-copilot: panel stays capturable ({error})");
    }

    if let Err(error) = reposition(app, &window, None) {
        crate::pet_window::cancel_overlay_panel_reveal(role);
        let _ = window.close();
        return Err(error);
    }

    if let Err(error) = crate::pet_window::configure_overlay_panel(&window, role) {
        crate::pet_window::cancel_overlay_panel_reveal(role);
        let _ = crate::pet_window::detach_overlay_panel(&window);
        let _ = window.close();
        return Err(error);
    }
    if !crate::pet_window::overlay_panel_generation_is_current(role, generation) {
        let _ = crate::pet_window::detach_overlay_panel(&window);
        let _ = window.close();
        return Ok(());
    }

    // Safety net for a renderer that never signals first paint: an invisible
    // panel would hold the consent prompt the capture is waiting on.
    {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(8)).await;
            if !crate::pet_window::overlay_panel_generation_is_current(role, generation) {
                return;
            }
            if let Some(window) = handle.get_webview_window(CHAT_COPILOT_LABEL) {
                if !window.is_visible().unwrap_or(true) {
                    log::warn!(
                        "chat-copilot still hidden 8s after open, force-showing (renderer never signaled first paint)"
                    );
                    let _ =
                        crate::pet_window::reveal_overlay_panel(&window, role, false, generation);
                }
            }
        });
    }

    Ok(())
}

/// Open or re-show the panel. Idempotent, and serialized against a concurrent
/// open the same way the dock's is.
fn open_inner<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let role = crate::pet_window::OverlayPanelRole::ChatCopilot;
    let generation = crate::pet_window::begin_overlay_panel_open(role);
    if let Some(_build_guard) = crate::pet_window::try_begin_overlay_panel_build(role) {
        return open_claimed(app, generation);
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        for _ in 0..200 {
            if !crate::pet_window::overlay_panel_generation_is_current(role, generation) {
                return;
            }
            if let Some(_build_guard) = crate::pet_window::try_begin_overlay_panel_build(role) {
                if let Err(error) = open_claimed(&handle, generation) {
                    log::error!("chat-copilot: queued open failed: {error}");
                }
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        log::error!("chat-copilot: timed out waiting for the window lifecycle to become idle");
    });
    Ok(())
}

fn valid_anchor(anchor: Option<Anchor>) -> Result<Option<Anchor>, String> {
    match anchor {
        Some(anchor) if !anchor.is_valid() => Err("invalid chat copilot anchor".into()),
        other => Ok(other),
    }
}

fn copyable(text: &str) -> bool {
    !text.is_empty() && text.chars().count() <= MAX_COPY_CHARS
}

fn require_overlay(window: &tauri::WebviewWindow, command: &str) -> Result<(), String> {
    if window.label() == CHAT_COPILOT_LABEL {
        Ok(())
    } else {
        Err(format!(
            "{command} is only callable from the {CHAT_COPILOT_LABEL} window"
        ))
    }
}

/* ── Commands ──────────────────────────────────────────────────────────── */

/// Open beside `anchor`, or top-right of the cursor's screen when `None`.
#[tauri::command]
pub async fn chat_copilot_open(app: AppHandle, anchor: Option<Anchor>) -> Result<(), String> {
    set_anchor(valid_anchor(anchor)?);
    open_inner(&app)
}

/// Move the open panel beside the captured window.
#[tauri::command]
pub async fn chat_copilot_place(app: AppHandle, anchor: Anchor) -> Result<(), String> {
    set_anchor(valid_anchor(Some(anchor))?);
    match app.get_webview_window(CHAT_COPILOT_LABEL) {
        Some(window) => reposition(&app, &window, None),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn chat_copilot_close(app: AppHandle) -> Result<(), String> {
    crate::pet_window::cancel_overlay_panel_reveal(
        crate::pet_window::OverlayPanelRole::ChatCopilot,
    );
    set_anchor(None);
    if let Some(window) = app.get_webview_window(CHAT_COPILOT_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Renderer-driven first-paint reveal. Same contract as the dock's.
#[tauri::command]
pub async fn chat_copilot_reveal(window: tauri::WebviewWindow) -> Result<(), String> {
    require_overlay(&window, "chat_copilot_reveal")?;
    let role = crate::pet_window::OverlayPanelRole::ChatCopilot;
    let generation = crate::pet_window::current_overlay_panel_generation(role);
    crate::pet_window::reveal_overlay_panel(&window, role, false, generation)
}

/// Fit the panel to the renderer's measured content (logical px) and re-place
/// it, so a taller result never pushes the panel off the bottom of the screen.
#[tauri::command]
pub async fn chat_copilot_resize(
    app: AppHandle,
    window: tauri::WebviewWindow,
    width: f64,
    height: f64,
) -> Result<(), String> {
    require_overlay(&window, "chat_copilot_resize")?;
    if !width.is_finite() || !height.is_finite() {
        return Err("invalid chat copilot size".into());
    }
    let (target, monitors) = layout(&app);
    let panel = placement::fit(target, (width, height), &monitors);
    size_window(&window, panel)?;
    reposition(&app, &window, Some(panel))
}

/// Copy a candidate through the host clipboard (see the module docs).
#[tauri::command]
pub async fn chat_copilot_copy(
    app: AppHandle,
    window: tauri::WebviewWindow,
    text: String,
) -> Result<(), String> {
    require_overlay(&window, "chat_copilot_copy")?;
    if !copyable(&text) {
        return Err("chat copilot copy is empty or oversized".into());
    }
    app.clipboard()
        .write_text(text)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchor() -> Anchor {
        Anchor {
            x: 100.0,
            y: 50.0,
            width: 500.0,
            height: 400.0,
            scale: 2.0,
        }
    }

    #[test]
    fn label_matches_the_renderer() {
        // `lib/pet/window-role.ts:CHAT_COPILOT_WINDOW_LABEL` and the
        // capability file's `windows` entry key off this exact string.
        assert_eq!(CHAT_COPILOT_LABEL, "chat-copilot");
    }

    #[test]
    fn accepts_no_anchor_and_refuses_a_malformed_one() {
        assert_eq!(valid_anchor(None), Ok(None));
        assert_eq!(valid_anchor(Some(anchor())), Ok(Some(anchor())));
        assert!(valid_anchor(Some(Anchor {
            width: -1.0,
            ..anchor()
        }))
        .is_err());
    }

    #[test]
    fn remembers_the_last_anchor_until_cleared() {
        set_anchor(Some(anchor()));
        assert_eq!(current_anchor(), Some(anchor()));
        set_anchor(None);
        assert_eq!(current_anchor(), None);
    }

    #[test]
    fn copies_only_a_reply_sized_text() {
        assert!(copyable("三点可以"));
        assert!(!copyable(""));
        assert!(!copyable(&"x".repeat(MAX_COPY_CHARS + 1)));
    }
}
