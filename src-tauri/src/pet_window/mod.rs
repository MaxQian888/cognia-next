//! Desktop pet ("桌宠") overlay window lifecycle.
//!
//! The pet lives in a dedicated webview window labelled `"pet"`: transparent,
//! frameless, always-on-top, skip-taskbar. It loads the `/pet-overlay` route
//! and survives the main window's close-to-tray (it is a sibling window, not a
//! child). The renderer drives it through the commands below, and so does the
//! tray: its pet toggle runs the renderer's `pet.toggle-window` command, which
//! knows the saved geometry and switches the pet on (ADR-0058 D9). The only
//! native tray path into this module is `set_pet_click_through_inner`, the
//! recovery for a window stuck ignoring the cursor. The open/close helpers are
//! private on purpose, so no Rust caller can grow a second opener that skips
//! the renderer's saved size and position.
//!
//! Position is owned by PetSettings (the renderer), NOT by
//! `tauri-plugin-window-state` — `lib.rs` denylists `"pet"` so the plugin
//! never fights the saved overlay coordinates.
//!
//! Every coordinate crossing the IPC boundary — window position, work area,
//! cursor, perch surfaces, the saved spot — is in desktop units
//! (`desktop_space`: points on macOS, physical pixels elsewhere), and windows
//! are moved with the selection toolbar's `place_window`. tao's "physical"
//! numbers are not one space on macOS (each display's points times its OWN
//! scale, a window's frame times the window's current scale, the cursor times
//! the primary display's scale), so a pet dragged, thrown or reopened across a
//! Retina laptop and a 1x external display jumped to the wrong spot or the
//! wrong screen.
//!
//! Live window manipulation can't be unit-tested here: it needs a
//! `tauri::test::mock_app()` runtime which fails on this project's Windows
//! toolchain (see `plugin_api/window_ops.rs:46` for the same convention).
//! Only the pure position math and the DTO serde shape are unit-tested; the
//! window ops are smoke-tested via `pnpm tauri dev`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Runtime, Webview};

use crate::automation::platform::shared::desktop_space::{self, DesktopMonitor};
use crate::automation::types::Rect as DesktopRect;
use crate::selection_toolbar::{desktop_monitors, place_window};

mod macos_panel;
mod popup;
mod surfaces;
pub use popup::*;
pub use surfaces::*;
// Explicit (not glob) so the crate-internal window enumeration the fleet island
// borrows for full-screen detection can't be dropped by a future refactor of
// the glob above without a compile error. See `fleet/island_space.rs`.
pub(crate) use surfaces::enumerate_scaled_candidates;

// Shared overlay seam: the fleet island window reuses the exact NSPanel
// reclassing the pet windows pioneered (non-activating, all-Spaces,
// floating level). Alias rather than move — pet call sites stay untouched.
pub(crate) use macos_panel::{
    begin_panel_open as begin_overlay_panel_open,
    cancel_panel_reveal as cancel_overlay_panel_reveal,
    // The AWAITED conversion. `apply_overlay_panel_behavior` only enqueues, and
    // `run_on_appkit_thread`'s docblock spells out why a caller has to wait:
    // a reveal can otherwise overtake the conversion and briefly show an
    // ordinary — activating — NSWindow.
    configure_pet_panel as configure_overlay_panel,
    current_panel_generation as current_overlay_panel_generation,
    detach_pet_panel as detach_overlay_panel,
    panel_generation_is_current as overlay_panel_generation_is_current,
    reveal_pet_panel as reveal_overlay_panel,
    set_panel_key as set_overlay_panel_key,
    try_begin_panel_build as try_begin_overlay_panel_build,
    PetPanelRole as OverlayPanelRole,
};
// Tests outside this module that drive the per-role panel statics (the fleet
// island's) must serialize on the same lock as `macos_panel`'s own tests.
#[cfg(test)]
pub(crate) use macos_panel::lock_panel_state_for_test as lock_overlay_panel_state_for_test;

/// Margin (in desktop units) kept between the overlay and the work-area edges
/// when falling back to the bottom-right corner.
const EDGE_MARGIN: f64 = 24.0;

/// How long an open waits for a concurrent build / re-show / destroy of the
/// same label before giving up (200 x 10 ms).
const LIFECYCLE_WAIT_STEPS: u32 = 200;

/// Whether the current sprite webview has revealed itself after its first
/// painted frame (or been force-revealed by the safety net).
///
/// A re-open that lands while a freshly built window is still waiting for its
/// first paint must not reveal it: on Windows a `transparent(true)` window
/// shown before its WebView commits a frame composites as an opaque black
/// rectangle. Reset on every new build and on destroy.
static SPRITE_FIRST_PAINT_DONE: AtomicBool = AtomicBool::new(false);

/// tao "physical" rectangle `(x, y, width, height)`.
type PhysicalRect = (f64, f64, f64, f64);

/// Index of the first rectangle containing `point` (half-open on the far
/// edges, so two monitors that touch never both claim the seam). Pure so the
/// monitor pick is unit-tested without a display.
fn index_of_rect_containing(point: (f64, f64), rects: &[PhysicalRect]) -> Option<usize> {
    rects.iter().position(|&(x, y, w, h)| {
        point.0 >= x && point.0 < x + w && point.1 >= y && point.1 < y + h
    })
}

/// Convert a saved position persisted before saved positions were desktop
/// units (`PetPositionSpace::Legacy`) into desktop units.
///
/// Those were tao "physical" pixels: on macOS the spot's points times the
/// scale of the display the pet stood on. The display is found the way the
/// pre-desktop-units open found it — the first tao rect containing `probe`
/// (the window's approximate centre) — and its scale divided back out; with
/// none containing it, `fallback_scale` (the primary display's). Elsewhere
/// tao's physical pixels already are desktop units.
fn legacy_position_to_desktop(
    saved: (f64, f64),
    probe: (f64, f64),
    tao_monitors: &[(PhysicalRect, f64)],
    fallback_scale: f64,
    units_are_points: bool,
) -> (f64, f64) {
    if !units_are_points {
        return saved;
    }
    let rects: Vec<PhysicalRect> = tao_monitors.iter().map(|(rect, _)| *rect).collect();
    let scale = index_of_rect_containing(probe, &rects)
        .map_or(fallback_scale, |index| tao_monitors[index].1);
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    (saved.0 / scale, saved.1 / scale)
}

/// The pet window's outer frame in desktop units.
fn window_frame<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<DesktopRect, String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    Ok(desktop_space::window_frame(
        (position.x, position.y),
        (size.width, size.height),
        scale,
        desktop_space::DESKTOP_UNITS_ARE_POINTS,
    ))
}

/// Work area `(x, y, width, height)` in desktop units plus desktop units per
/// logical px, of the display holding `rect`'s centre (or the nearest one);
/// the primary display when `rect` is `None`. A sane default when no display
/// is reported at all (headless, shutdown).
fn work_area_for(
    rect: Option<DesktopRect>,
    monitors: &[DesktopMonitor],
) -> ((f64, f64, f64, f64), f64) {
    let monitor = match rect {
        Some(rect) => desktop_space::monitor_for(rect, monitors),
        None => monitors.first(),
    };
    monitor.map_or(((0.0, 0.0, 1920.0, 1080.0), 1.0), |monitor| {
        let work = monitor.work;
        (
            (
                f64::from(work.x),
                f64::from(work.y),
                f64::from(work.width),
                f64::from(work.height),
            ),
            monitor.content_scale,
        )
    })
}

fn rounded(point: (f64, f64)) -> (i32, i32) {
    (point.0.round() as i32, point.1.round() as i32)
}

/// Resize a non-resizable overlay to a logical size.
///
/// Both pet windows are built `resizable(false)`, which on Windows and Linux
/// pins min == max and clamps a programmatic resize; resizing is re-enabled
/// across the write there (`lib/pet/reveal.ts` does the same for its nudge).
/// macOS honors `setContentSize` regardless, and toggling the style mask
/// there would rewrite the non-activating NSPanel's mask, so it is skipped.
pub(crate) fn set_fixed_logical_size<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let toggle = cfg!(not(target_os = "macos"));
    if toggle {
        window.set_resizable(true).map_err(|e| e.to_string())?;
    }
    let result = window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string());
    if toggle {
        let _ = window.set_resizable(false);
    }
    result
}

/// New top-left that keeps a window's bottom-center fixed across a resize, so
/// the pet's feet stay where they stood when its size changes. Physical px.
fn resize_anchored_bottom_center(
    position: (f64, f64),
    old_size: (f64, f64),
    new_size: (f64, f64),
) -> (f64, f64) {
    (
        position.0 + (old_size.0 - new_size.0) / 2.0,
        position.1 + old_size.1 - new_size.1,
    )
}

/// Identity of the monitor a window sits on, for change detection.
type MonitorKey = (i32, i32, u32, u32, u64);

fn monitor_key(monitor: &tauri::Monitor) -> MonitorKey {
    let p = monitor.position();
    let s = monitor.size();
    (
        p.x,
        p.y,
        s.width,
        s.height,
        monitor.scale_factor().to_bits(),
    )
}

/// The coordinate space of a saved pet position. Mirrors the TS
/// `PetPositionSpace` (`PetDesktopOverlaySettings.position.space`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PetPositionSpace {
    /// Saved before positions were desktop units, as tao "physical" pixels.
    /// What an unmarked position means; `legacy_position_to_desktop` converts
    /// it on open, and the next settle re-saves it marked `Desktop`.
    #[default]
    Legacy,
    /// Desktop units (`desktop_space`).
    Desktop,
}

/// Options the renderer passes when opening / re-showing the pet window.
/// Mirrors the TS wrapper in `lib/tauri/pet-window.ts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetWindowOpts {
    pub width: f64,
    pub height: f64,
    /// Saved top-left X, if the user has dragged before.
    #[serde(default)]
    pub x: Option<f64>,
    /// Saved top-left Y, if the user has dragged before.
    #[serde(default)]
    pub y: Option<f64>,
    /// The space `x` / `y` are in.
    #[serde(default)]
    pub position_space: PetPositionSpace,
    /// When true the window ignores cursor events (click-through mode).
    #[serde(default)]
    pub click_through: bool,
}

/// Resolve the initial top-left position of the overlay.
///
/// `work_area` is `(x, y, width, height)` of the primary monitor's usable area
/// (taskbar excluded). `win` is `(width, height)` of the overlay. A saved
/// position is clamped so the window stays fully visible inside the work area;
/// when no position is saved (or it can't fit), we fall back to the
/// bottom-right corner minus `EDGE_MARGIN`.
///
/// Pure so it can be unit-tested without a live window.
fn resolve_initial_position(
    saved: Option<(f64, f64)>,
    work_area: (f64, f64, f64, f64),
    win: (f64, f64),
) -> (f64, f64) {
    let (area_x, area_y, area_w, area_h) = work_area;
    let (win_w, win_h) = win;

    // Maximum top-left that still keeps the window fully on-screen. Clamp the
    // lower bound to the area origin so an oversized window pins to top-left
    // rather than producing a negative max.
    let max_x = (area_x + area_w - win_w).max(area_x);
    let max_y = (area_y + area_h - win_h).max(area_y);

    match saved {
        Some((x, y)) => (x.clamp(area_x, max_x), y.clamp(area_y, max_y)),
        None => {
            // Bottom-right corner with a margin, never past the work-area top-left.
            let x = (area_x + area_w - win_w - EDGE_MARGIN).max(area_x);
            let y = (area_y + area_h - win_h - EDGE_MARGIN).max(area_y);
            (x, y)
        }
    }
}

/// Scale a logical overlay size into desktop units. The window's `inner_size`
/// stays logical, but the placement math runs in desktop units (monitor
/// geometry and persisted drag coords), so the size used for clamping must be
/// too: times the display's scale where desktop units are pixels, unchanged
/// where they are points. Pure so the scaled case is unit-tested without a
/// live window.
fn desktop_overlay_size(logical: (f64, f64), content_scale: f64) -> (f64, f64) {
    (logical.0 * content_scale, logical.1 * content_scale)
}

/// The sprite's top-left in desktop units: `saved` clamped into the work area
/// of the display holding the window, or the primary display's bottom-right
/// corner when nothing is saved. The display is picked by the window's centre
/// at its logical size (exact where desktop units are points; within one
/// display's scale of it elsewhere), so a pet dragged to a secondary monitor
/// reopens there.
///
/// Uses the work area — NOT the full display bounds — so the corner fallback
/// and the clamp never tuck the pet under the taskbar or dock.
fn resolve_sprite_position(
    saved: Option<(f64, f64)>,
    logical: (f64, f64),
    monitors: &[DesktopMonitor],
) -> (i32, i32) {
    let probe = saved.map(|(x, y)| DesktopRect {
        x: x.round() as i32,
        y: y.round() as i32,
        width: logical.0.round() as i32,
        height: logical.1.round() as i32,
    });
    let (area, scale) = work_area_for(probe, monitors);
    rounded(resolve_initial_position(
        saved,
        area,
        desktop_overlay_size(logical, scale),
    ))
}

/// Payload of the `pet://state-changed` event — lets the renderer's settings
/// store track native window mutations it did not itself initiate (the tray's
/// click-through recovery, blur-hide, an open or close started from another
/// window), instead of silently desyncing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetStateChanged {
    pub open: bool,
    pub click_through: bool,
}

/// Broadcast a native pet-window state change to every webview.
fn emit_pet_state<R: Runtime>(app: &AppHandle<R>, open: bool, click_through: bool) {
    let _ = app.emit(
        "pet://state-changed",
        PetStateChanged {
            open,
            click_through,
        },
    );
}

/// Apply click-through, tolerating failure on Linux: Wayland has no
/// cursor-passthrough API, and a failed toggle must degrade to a solid
/// (interactive) overlay instead of aborting the whole open and stranding a
/// hidden half-configured window.
fn apply_click_through<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    ignore: bool,
) -> Result<(), String> {
    if let Err(e) = window.set_ignore_cursor_events(ignore) {
        if cfg!(target_os = "linux") {
            log::warn!(
                "pet: set_ignore_cursor_events failed (compositor likely unsupported); continuing without click-through: {e}"
            );
        } else {
            return Err(e.to_string());
        }
    }
    Ok(())
}

/// Core "open or re-show" logic behind the `open_pet_window` command (the tray
/// reaches it through the renderer's `pet.toggle-window` command, which knows
/// the saved geometry). Idempotent: if the window already exists it is
/// ordered in front without activating Cognia, and its click-through state is
/// re-applied.
fn open_pet_window_claimed<R: Runtime>(
    app: &AppHandle<R>,
    opts: PetWindowOpts,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("pet") {
        set_fixed_logical_size(&window, opts.width, opts.height)?;
        // Re-validate the position before revealing: monitors may have been
        // unplugged / rearranged / DPI-changed while the window sat hidden
        // (the window-state plugin is denylisted for "pet", so nothing else
        // ever rescues stale coordinates). Clamp against the work area of
        // whichever monitor now contains the window's center.
        if let Ok(frame) = window_frame(&window) {
            let saved = (f64::from(frame.x), f64::from(frame.y));
            let (x, y) = resolve_sprite_position(
                Some(saved),
                (opts.width, opts.height),
                &desktop_monitors(app),
            );
            if (x, y) != (frame.x, frame.y) {
                let _ = place_window(&window, x, y);
            }
        }
        apply_click_through(&window, opts.click_through)?;
        let generation = macos_panel::begin_panel_open(macos_panel::PetPanelRole::Sprite);
        if !SPRITE_FIRST_PAINT_DONE.load(Ordering::SeqCst) {
            // Still waiting for its first frame (a second open raced the
            // build: the boot reconcile, a double-pressed hotkey). The
            // renderer's own reveal will show it once it has painted; the
            // fresh open intent above is what lets that reveal through.
            emit_pet_state(app, true, opts.click_through);
            return Ok(());
        }
        if let Err(error) = macos_panel::reveal_pet_panel(
            &window,
            macos_panel::PetPanelRole::Sprite,
            false,
            generation,
        ) {
            macos_panel::cancel_panel_reveal(macos_panel::PetPanelRole::Sprite);
            return Err(error);
        }
        if !macos_panel::panel_generation_is_current(macos_panel::PetPanelRole::Sprite, generation)
        {
            return Ok(());
        }
        // The renderer paused its animation loops on `pet://suspend`; wake it.
        let _ = app.emit("pet://resume", serde_json::Value::Null);
        emit_pet_state(app, true, opts.click_through);
        return Ok(());
    }

    let generation = macos_panel::begin_panel_open(macos_panel::PetPanelRole::Sprite);

    // The monitor work area and any persisted drag position are desktop
    // units, but `inner_size` (and `opts.width/height`) are LOGICAL. Resolve
    // placement entirely in desktop units — converting the logical overlay size
    // by the display's scale — then apply it with `place_window`, never the
    // builder's `.position()` (logical everywhere, so on a Windows display at
    // 150% it would land at 1/1.5 of the target).
    let saved = opts.x.zip(opts.y).map(|saved| match opts.position_space {
        PetPositionSpace::Desktop => saved,
        PetPositionSpace::Legacy => legacy_position(app, saved, (opts.width, opts.height)),
    });
    let (x, y) = resolve_sprite_position(saved, (opts.width, opts.height), &desktop_monitors(app));

    let window =
        tauri::WebviewWindowBuilder::new(app, "pet", tauri::WebviewUrl::App("pet-overlay".into()))
            // Transparency comes ONLY from `transparent(true)` (Windows: DWM +
            // WebView2 composition; macOS: needs the `macos-private-api` feature,
            // enabled via `macOSPrivateApi`). Never call `.background_color(...)`
            // here: on Windows the window layer IGNORES the alpha channel (Tauri
            // v2 `WindowConfig.backgroundColor` docs), so any color — even one
            // with alpha 0 — forces an OPAQUE window and defeats transparency.
            // The page paints itself transparent via `data-pet-overlay` CSS.
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            // The sprite never takes focus: not when it is created, not when
            // it is revealed (tao shows a never-focused window with
            // SW_SHOWNOACTIVATE), and — via `WS_EX_NOACTIVATE` below — not when
            // it is clicked or dragged, so petting it never pulls the keyboard
            // away from whatever the user is typing in.
            .focused(false)
            .visible(false)
            .inner_size(opts.width, opts.height)
            .build()
            .map_err(|error| {
                macos_panel::cancel_panel_reveal(macos_panel::PetPanelRole::Sprite);
                error.to_string()
            })?;
    SPRITE_FIRST_PAINT_DONE.store(false, Ordering::SeqCst);

    // Configure the freshly built (still hidden) window. Any failure here
    // closes the window before propagating: a half-configured hidden window
    // must never survive, or the next `open` call blindly re-shows it with a
    // wrong position / click-through / panel state.
    let configure = || -> Result<(), String> {
        // The app-wide menu bar (`menu.rs` `app.set_menu`) attaches to every newly
        // created window on Windows/Linux — including this frameless transparent
        // overlay, where it painted a File/Edit menubar strip while the pet was
        // focused or dragged. Detach it from this window only, before the first
        // reveal. No-op on macOS (the menu there is app-global, never per-window).
        let _ = window.remove_menu();

        place_window(&window, x, y)?;

        // Apply click-through before the first paint (Linux-tolerant).
        apply_click_through(&window, opts.click_through)?;

        // Windows: non-activating + tool window (no taskbar button, no
        // Alt-Tab entry). `skip_taskbar` alone only deletes the taskbar tab.
        #[cfg(target_os = "windows")]
        crate::window_utils::apply_windows_no_activate(&window)?;

        // macOS: reclass to a non-activating NSPanel so the pet floats over every
        // Space + full-screen apps and never steals the foreground app's focus.
        // No-op on Windows/Linux (the builder flags already suffice there). Runs
        // while the window is still hidden — converting a hidden window is fine.
        //
        // MUST run on the main thread: `to_panel` issues raw AppKit calls
        // (`-[NSPanel setFloatingPanel:]`) that trap (EXC_BREAKPOINT) off-main.
        // The helper waits for that AppKit task, so this open cannot report
        // success while the hidden window is still an ordinary NSWindow.
        macos_panel::configure_pet_panel(&window, macos_panel::PetPanelRole::Sprite)?;
        Ok(())
    };
    if let Err(e) = configure() {
        macos_panel::cancel_panel_reveal(macos_panel::PetPanelRole::Sprite);
        let _ = macos_panel::detach_pet_panel(&window);
        let _ = window.close();
        return Err(e);
    }
    if !macos_panel::panel_generation_is_current(macos_panel::PetPanelRole::Sprite, generation) {
        // A close/destroy landed while the hidden webview was being built.
        // Destroy owns the intent, but it may have observed no Tauri label yet;
        // the stale builder must therefore clean up the window it just inserted.
        let _ = macos_panel::detach_pet_panel(&window);
        let _ = window.close();
        return Ok(());
    }

    // Native window events:
    //  - DPI changes, and a move that lands the window on another monitor
    //    (a drag, a throw, a wander, a display unplugged), nudge the renderer
    //    to re-read its work area immediately. The wander loop otherwise only
    //    re-reads on a landing, so a pet dragged to a second screen kept
    //    walking against the first screen's bounds.
    //  - A native close (Alt+F4 on Windows, a window manager's close on
    //    Linux) becomes the same hide the renderer's toggle performs. Letting
    //    it through destroyed the webview behind every owner's back: no
    //    `pet://state-changed`, a stranded popup, and a saved "open" intent
    //    that the next launch re-opened. Destroy raises its flag before it
    //    closes, so its own close still goes through.
    {
        let app_handle = app.clone();
        let last_monitor: Arc<Mutex<Option<MonitorKey>>> = Arc::new(Mutex::new(
            window
                .current_monitor()
                .ok()
                .flatten()
                .as_ref()
                .map(monitor_key),
        ));
        window.on_window_event(move |event| match event {
            tauri::WindowEvent::ScaleFactorChanged { .. } => {
                let _ = app_handle.emit("pet://work-area-changed", serde_json::Value::Null);
            }
            tauri::WindowEvent::Moved(_) => {
                let Some(window) = app_handle.get_webview_window("pet") else {
                    return;
                };
                let key = window
                    .current_monitor()
                    .ok()
                    .flatten()
                    .as_ref()
                    .map(monitor_key);
                let changed = {
                    let mut last = last_monitor.lock().unwrap_or_else(|p| p.into_inner());
                    let changed = *last != key;
                    *last = key;
                    changed
                };
                if changed {
                    let _ = app_handle.emit("pet://work-area-changed", serde_json::Value::Null);
                }
            }
            tauri::WindowEvent::CloseRequested { api, .. }
                if !macos_panel::panel_is_destroying(macos_panel::PetPanelRole::Sprite) =>
            {
                api.prevent_close();
                if let Err(error) = close_pet_window_inner(&app_handle) {
                    log::warn!("pet: native close could not hide the window: {error}");
                }
            }
            _ => {}
        });
    }

    // Intentionally do NOT `show()` here. On Windows a `transparent(true)` window
    // shown before its WebView has committed a first paint renders an opaque
    // (black) rectangle until something forces a recomposite — the "invisible
    // until I click it" bug. The window is created `visible(false)`; the pet
    // overlay renderer reveals it after its first painted frame (see
    // `PetOverlayView`), exactly like the main window's `WindowShowInitializer`.
    // The re-show branch above reveals through the native panel owner because an
    // existing window has already painted, so it can never flash.

    // Safety net (mirrors the main window's net in `lib.rs`). The frontend
    // reveal (`lib/pet/reveal.ts`) is best-effort and error-swallowing — if it
    // throws (JS crash, hung hydrate), the pet would stay invisible forever with
    // no way back except a manual re-toggle. Force it visible after a grace
    // period so a reveal failure can never strand an alive-but-invisible pet.
    // Guarded twice: the generation token cancels the net when a close (or a
    // newer open) intervened during the grace period — `!is_visible` alone
    // can't distinguish "reveal never ran" from "user just hid it" — and the
    // reveal uses `orderFrontRegardless` (never `set_focus`) so a late
    // force-show can't yank focus from whatever the user is typing in.
    {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(8)).await;
            if !macos_panel::panel_generation_is_current(
                macos_panel::PetPanelRole::Sprite,
                generation,
            ) {
                return;
            }
            if let Some(window) = handle.get_webview_window("pet") {
                if !window.is_visible().unwrap_or(true) {
                    log::warn!(
                        "pet window still hidden 8s after open; force-showing (renderer never signaled first paint)"
                    );
                    if macos_panel::reveal_pet_panel(
                        &window,
                        macos_panel::PetPanelRole::Sprite,
                        false,
                        generation,
                    )
                    .is_ok()
                    {
                        SPRITE_FIRST_PAINT_DONE.store(true, Ordering::SeqCst);
                    }
                }
            }
        });
    }

    emit_pet_state(app, true, opts.click_through);
    Ok(())
}

/// Claim the sprite lifecycle and open. When a builder, re-show or
/// asynchronous destroy currently owns the label, wait for it to become idle
/// (never two same-label builders) and report a timeout as an error.
///
/// The wait is awaited, not spawned: a queued open used to return `Ok` at
/// once, so the renderer persisted `desktopPet.enabled` for a window that
/// might never appear, and the next launch retried it forever.
async fn open_pet_window_inner<R: Runtime>(
    app: &AppHandle<R>,
    opts: PetWindowOpts,
) -> Result<(), String> {
    for _ in 0..LIFECYCLE_WAIT_STEPS {
        if let Some(_build_guard) =
            macos_panel::try_begin_panel_build(macos_panel::PetPanelRole::Sprite)
        {
            return open_pet_window_claimed(app, opts);
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    Err("pet: timed out waiting for the window lifecycle to become idle".to_string())
}

/// Core "hide for toggle" logic behind the `close_pet_window` command.
/// Resets click-through to false first so a hidden window can never strand the
/// pointer; reopening is cheap so we hide rather than destroy.
fn close_pet_window_inner<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    // Invalidate any pending force-show safety net from a recent open — a
    // close inside the grace period must win over the net.
    macos_panel::cancel_panel_reveal(macos_panel::PetPanelRole::Sprite);
    if let Some(window) = app.get_webview_window("pet") {
        apply_click_through(&window, false)?;
        window.hide().map_err(|e| e.to_string())?;
    }
    // Never strand the click popup over the desktop once the sprite is hidden.
    let _ = popup::close_pet_popup_inner(app);
    // A hidden webview keeps burning CPU on its animation timers (Live2D
    // ticker / rAF walk loop) — tell the renderer to pause them.
    let _ = app.emit("pet://suspend", serde_json::Value::Null);
    emit_pet_state(app, false, false);
    Ok(())
}

/// True when the pet window exists and its latest lifecycle is an open.
///
/// Deliberately not `is_visible`: a freshly built window stays hidden until
/// its renderer paints, and answering "closed" during that window made every
/// second caller (the boot reconcile, a double-pressed hotkey) re-open — and
/// prematurely reveal — a window that was already on its way.
fn is_pet_window_open_inner<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window("pet").is_some()
        && !macos_panel::panel_is_destroying(macos_panel::PetPanelRole::Sprite)
        && macos_panel::panel_open_intent_is_set(macos_panel::PetPanelRole::Sprite)
}

/// Open the desktop pet window, or order it in front if it already exists.
#[tauri::command]
pub async fn open_pet_window(app: AppHandle, opts: PetWindowOpts) -> Result<(), String> {
    open_pet_window_inner(&app, opts).await
}

/// Resolve a caller-supplied target label to one of the two pet-panel roles.
/// Keeping this allowlist native prevents a renderer from raising arbitrary
/// application windows through the reveal command.
fn pet_panel_role_for_label(label: &str) -> Result<macos_panel::PetPanelRole, String> {
    match label {
        "pet" => Ok(macos_panel::PetPanelRole::Sprite),
        popup::PET_POPUP_LABEL => Ok(macos_panel::PetPanelRole::Popup),
        label => Err(format!("window '{label}' is not a pet overlay")),
    }
}

#[tauri::command]
pub async fn reveal_pet_window(
    app: AppHandle,
    _caller: Webview,
    target_label: String,
    focus: bool,
) -> Result<(), String> {
    let role = pet_panel_role_for_label(&target_label)?;
    let window = app
        .get_webview_window(&target_label)
        .ok_or_else(|| format!("pet overlay window '{target_label}' no longer exists"))?;
    let generation = macos_panel::current_panel_generation(role);
    // Every platform reveals through here (the generation check is what lets
    // a close that landed between the open and the renderer's first frame win
    // over the reveal), so this is also where the first paint is recorded.
    macos_panel::reveal_pet_panel(&window, role, focus, generation)?;
    if role == macos_panel::PetPanelRole::Sprite
        && macos_panel::panel_generation_is_current(role, generation)
    {
        SPRITE_FIRST_PAINT_DONE.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// Hide the desktop pet window (toggle semantics — reopen is cheap).
#[tauri::command]
pub async fn close_pet_window(app: AppHandle) -> Result<(), String> {
    close_pet_window_inner(&app)
}

async fn wait_for_window_removed<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    role: macos_panel::PetPanelRole,
) -> Result<(), String> {
    for _ in 0..200 {
        // Check the guarded build count first. While destroy owns the role no
        // new builder can start, so once this reaches zero the following label
        // lookup cannot miss a not-yet-inserted pre-destroy builder.
        if !macos_panel::panel_has_in_flight_builds(role) && app.get_webview_window(label).is_none()
        {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    Err(format!(
        "pet: timed out waiting for window '{label}' to be destroyed"
    ))
}

/// Fully destroy both native pet surfaces and wait until Tauri has removed
/// their labels. `WebviewWindow::close()` only queues a close event; returning
/// before removal lets an immediate reopen retrieve a window that is already
/// doomed to close.
async fn destroy_pet_window_inner<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    macos_panel::begin_panel_destroy(macos_panel::PetPanelRole::Sprite);
    macos_panel::begin_panel_destroy(macos_panel::PetPanelRole::Popup);

    let popup_result = (|| -> Result<(), String> {
        // Tear the click popup down with the sprite so disabling the pet leaves
        // no orphan window behind.
        if let Some(window) = app.get_webview_window(popup::PET_POPUP_LABEL) {
            macos_panel::detach_pet_panel(&window)?;
            window.close().map_err(|e| e.to_string())?;
        }
        Ok(())
    })();

    let sprite_result = (|| -> Result<(), String> {
        if let Some(window) = app.get_webview_window("pet") {
            // Reset click-through first so a future window can never inherit a
            // pointer-trapping state through a recreated label.
            let _ = window.set_ignore_cursor_events(false);
            macos_panel::detach_pet_panel(&window)?;
            window.close().map_err(|e| e.to_string())?;
        }
        Ok(())
    })();

    let popup_result = match popup_result {
        Ok(()) => {
            wait_for_window_removed(
                app,
                popup::PET_POPUP_LABEL,
                macos_panel::PetPanelRole::Popup,
            )
            .await
        }
        Err(error) => Err(error),
    };
    let sprite_result = match sprite_result {
        Ok(()) => wait_for_window_removed(app, "pet", macos_panel::PetPanelRole::Sprite).await,
        Err(error) => Err(error),
    };

    // Only a successful wait proves both invariants: no Tauri label remains
    // and every builder that started before destroy has finished its stale
    // cleanup. On failure keep the gate raised rather than reuse a doomed label.
    if popup_result.is_ok() {
        let _ = macos_panel::finish_panel_destroy(macos_panel::PetPanelRole::Popup);
    }
    if sprite_result.is_ok() {
        let _ = macos_panel::finish_panel_destroy(macos_panel::PetPanelRole::Sprite);
    }
    SPRITE_FIRST_PAINT_DONE.store(false, Ordering::SeqCst);
    emit_pet_state(app, false, false);
    popup_result.and(sprite_result)
}

/// Fully destroy the pet window — used by the settings "disable" path so the
/// overlay is gone (not merely hidden) until re-enabled.
#[tauri::command]
pub async fn destroy_pet_window(app: AppHandle) -> Result<(), String> {
    destroy_pet_window_inner(&app).await
}

/// Core click-through toggle shared by the command and the tray recovery
/// action, so both paths broadcast the same `pet://state-changed` event.
pub(crate) fn set_pet_click_through_inner<R: Runtime>(
    app: &AppHandle<R>,
    ignore: bool,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("pet") {
        apply_click_through(&window, ignore)?;
        let open = window.is_visible().unwrap_or(false);
        emit_pet_state(app, open, ignore);
    }
    Ok(())
}

/// Toggle click-through (cursor event ignoring) on the pet window.
#[tauri::command]
pub async fn pet_window_set_ignore_cursor_events(
    app: AppHandle,
    ignore: bool,
) -> Result<(), String> {
    set_pet_click_through_inner(&app, ignore)
}

/// Move the pet window to a top-left in desktop units (drag, throw, wander).
#[tauri::command]
pub async fn pet_window_set_position(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    if !(x.is_finite() && y.is_finite()) {
        return Err(format!("pet: invalid window position {x},{y}"));
    }
    if let Some(window) = app.get_webview_window("pet") {
        let (x, y) = rounded((x, y));
        place_window(&window, x, y)?;
    }
    Ok(())
}

/// Resize the pet window to a new logical size, keeping its bottom-center
/// where it stood (the pet's feet stay put) and the whole window inside the
/// work area of the monitor it is on.
///
/// This is how a size change reaches an open overlay. The only other resize
/// path is the re-show branch of `open_pet_window`, which also reveals the
/// window and restarts its animation loops, so the Settings size slider used
/// to do nothing until the pet was hidden and shown again. Never reveals.
#[tauri::command]
pub async fn pet_window_set_size(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    if !(width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0) {
        return Err(format!("pet: invalid window size {width}x{height}"));
    }
    let Some(window) = app.get_webview_window("pet") else {
        return Ok(());
    };
    let frame = window_frame(&window)?;
    let (area, scale) = work_area_for(Some(frame), &desktop_monitors(&app));
    let (x, y) = resize_position(frame, (width, height), area, scale);
    set_fixed_logical_size(&window, width, height)?;
    place_window(&window, x, y)
}

/// The top-left (desktop units) after resizing the window in `frame` (desktop
/// units) to `logical`: bottom-center kept, then clamped into `area`. Pure.
fn resize_position(
    frame: DesktopRect,
    logical: (f64, f64),
    area: (f64, f64, f64, f64),
    content_scale: f64,
) -> (i32, i32) {
    let new_size = desktop_overlay_size(logical, content_scale);
    let anchored = resize_anchored_bottom_center(
        (f64::from(frame.x), f64::from(frame.y)),
        (f64::from(frame.width), f64::from(frame.height)),
        new_size,
    );
    rounded(resolve_initial_position(Some(anchored), area, new_size))
}

/// A legacy saved position (see `legacy_position_to_desktop`) in desktop units.
fn legacy_position<R: Runtime>(
    app: &AppHandle<R>,
    saved: (f64, f64),
    logical: (f64, f64),
) -> (f64, f64) {
    let tao_monitors: Vec<(PhysicalRect, f64)> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            (
                (
                    f64::from(position.x),
                    f64::from(position.y),
                    f64::from(size.width),
                    f64::from(size.height),
                ),
                monitor.scale_factor(),
            )
        })
        .collect();
    let fallback_scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map_or(1.0, |monitor| monitor.scale_factor());
    legacy_position_to_desktop(
        saved,
        (saved.0 + logical.0 / 2.0, saved.1 + logical.1 / 2.0),
        &tao_monitors,
        fallback_scale,
        desktop_space::DESKTOP_UNITS_ARE_POINTS,
    )
}

/// Named position DTO — a bare Rust tuple would serialize as a JSON array,
/// which the TS wrapper (typed `{ x, y }`) silently read as `undefined`s and
/// broke overlay dragging. Keep this a struct.
#[derive(Debug, Clone, Serialize)]
pub struct PetWindowPosition {
    pub x: i32,
    pub y: i32,
}

/// Global cursor position, in desktop units, used only by the local pet
/// WebView for gaze. The command returns coordinates and performs no
/// persistence, telemetry, or I/O.
fn pet_cursor_position(
    cursor: (f64, f64),
    primary_scale: f64,
    units_are_points: bool,
) -> PetWindowPosition {
    let (x, y) = desktop_space::cursor_point(cursor, primary_scale, units_are_points);
    PetWindowPosition { x, y }
}

#[tauri::command]
pub async fn pet_window_get_cursor_position(app: AppHandle) -> Result<PetWindowPosition, String> {
    let pos = app.cursor_position().map_err(|e| e.to_string())?;
    let primary_scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map_or(1.0, |monitor| monitor.scale_factor());
    Ok(pet_cursor_position(
        (pos.x, pos.y),
        primary_scale,
        desktop_space::DESKTOP_UNITS_ARE_POINTS,
    ))
}

/// Read the pet window's current top-left in desktop units. `None` when the
/// window is absent (so the renderer can fall back to its persisted
/// coordinates).
#[tauri::command]
pub async fn pet_window_get_position(app: AppHandle) -> Result<Option<PetWindowPosition>, String> {
    match app.get_webview_window("pet") {
        Some(window) => {
            let frame = window_frame(&window)?;
            Ok(Some(PetWindowPosition {
                x: frame.x,
                y: frame.y,
            }))
        }
        None => Ok(None),
    }
}

/// True when the pet window exists and is visible.
#[tauri::command]
pub async fn is_pet_window_open(app: AppHandle) -> bool {
    is_pet_window_open_inner(&app)
}

/// Work area of one monitor in desktop units (taskbar excluded), plus desktop
/// units per logical px there so the renderer can convert logical window
/// sizes and CSS-pixel pointer deltas. Mirrors the TS `PetWorkArea` in
/// `lib/tauri/pet-window.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetWorkArea {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Desktop units per logical (CSS) px: 1 where desktop units are points
    /// (macOS), the display's scale factor elsewhere.
    pub scale_factor: f64,
}

/// The work area of the display holding `frame` (the pet window, desktop
/// units), else the primary display; `None` with no display (headless). Pure
/// so the multi-display pick is unit-tested without a window.
fn work_area_dto(frame: Option<DesktopRect>, monitors: &[DesktopMonitor]) -> Option<PetWorkArea> {
    let monitor = match frame {
        Some(frame) => desktop_space::monitor_for(frame, monitors),
        None => monitors.first(),
    }?;
    Some(PetWorkArea {
        x: f64::from(monitor.work.x),
        y: f64::from(monitor.work.y),
        width: f64::from(monitor.work.width),
        height: f64::from(monitor.work.height),
        scale_factor: monitor.content_scale,
    })
}

/// Work area of the monitor the pet window currently sits on (falls back to
/// the primary monitor, then `None` when neither resolves — headless). The
/// wander loop keeps the pet inside this rectangle.
#[tauri::command]
pub async fn pet_window_get_work_area(app: AppHandle) -> Result<Option<PetWorkArea>, String> {
    let frame = app
        .get_webview_window("pet")
        .and_then(|window| window_frame(&window).ok());
    Ok(work_area_dto(frame, &desktop_monitors(&app)))
}

/// Surface the main window (used by the overlay's "show main window" menu
/// item). Reuses the shared bring-to-front helper.
#[tauri::command]
pub async fn show_main_window(app: AppHandle) -> Result<(), String> {
    crate::window_utils::bring_main_window_to_front(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK_AREA: (f64, f64, f64, f64) = (0.0, 0.0, 1920.0, 1080.0);
    const WIN: (f64, f64) = (280.0, 320.0);

    fn drect(x: i32, y: i32, width: i32, height: i32) -> DesktopRect {
        DesktopRect {
            x,
            y,
            width,
            height,
        }
    }

    /// A 1512×982pt Retina laptop (scale 2, primary) and a 2560×1440pt 1x
    /// display to its right, as tao reports them on macOS.
    fn mac_pair() -> Vec<DesktopMonitor> {
        vec![
            DesktopMonitor::from_tao(drect(0, 0, 3024, 1964), drect(0, 50, 3024, 1914), 2.0, true),
            DesktopMonitor::from_tao(
                drect(1512, 0, 2560, 1440),
                drect(1512, 25, 2560, 1415),
                1.0,
                true,
            ),
        ]
    }

    /// The same pair in tao's numbers, for the legacy-position conversion.
    fn mac_pair_tao() -> Vec<(PhysicalRect, f64)> {
        vec![
            ((0.0, 0.0, 3024.0, 1964.0), 2.0),
            ((1512.0, 0.0, 2560.0, 1440.0), 1.0),
        ]
    }

    /// A 150% laptop (primary) and a 1x display to its right, as tao reports
    /// them on Windows: already physical pixels.
    fn windows_pair() -> Vec<DesktopMonitor> {
        vec![
            DesktopMonitor::from_tao(drect(0, 0, 2880, 1800), drect(0, 0, 2880, 1728), 1.5, false),
            DesktopMonitor::from_tao(
                drect(2880, 0, 1920, 1080),
                drect(2880, 0, 1920, 1040),
                1.0,
                false,
            ),
        ]
    }

    #[test]
    fn desktop_overlay_size_scales_logical_by_content_scale() {
        // Points (macOS, any display) and 1x pixels: the logical size.
        assert_eq!(desktop_overlay_size((280.0, 320.0), 1.0), (280.0, 320.0));
        // A 2x pixel display: the placement math must see the doubled size, or
        // the bottom-right fallback under-reserves and the window lands
        // partly off-screen.
        assert_eq!(desktop_overlay_size((280.0, 320.0), 2.0), (560.0, 640.0));
    }

    #[test]
    fn retina_unsaved_fallback_stays_on_screen() {
        // Regression: a 280x320 overlay with nothing saved lands fully on the
        // primary Retina display's bottom-right corner, in points — not at
        // twice the spot (off-screen), and above the dock's work-area edge.
        let (x, y) = resolve_sprite_position(None, WIN, &mac_pair());
        assert_eq!(x, 1512 - 280 - EDGE_MARGIN as i32);
        assert_eq!(y, 25 + 957 - 320 - EDGE_MARGIN as i32);
    }

    #[test]
    fn a_pet_saved_on_the_1x_external_display_reopens_there() {
        // In tao's numbers this spot is also inside the Retina laptop's
        // (0, 0, 3024, 1964) rect, which is where the old lookup clamped it.
        assert_eq!(
            resolve_sprite_position(Some((2400.0, 700.0)), (224.0, 288.0), &mac_pair()),
            (2400, 700)
        );
        // Past the external display's bottom edge: clamped into ITS work area.
        assert_eq!(
            resolve_sprite_position(Some((2400.0, 1400.0)), (224.0, 288.0), &mac_pair()),
            (2400, 25 + 1415 - 288)
        );
    }

    #[test]
    fn a_pet_saved_on_the_retina_laptop_reopens_at_its_points() {
        assert_eq!(
            resolve_sprite_position(Some((600.0, 500.0)), (224.0, 288.0), &mac_pair()),
            (600, 500)
        );
        // Low on the laptop: clamped to the work area above the dock, in
        // points (the work area ends at 982pt, not tao's 1964).
        assert_eq!(
            resolve_sprite_position(Some((600.0, 900.0)), (224.0, 288.0), &mac_pair()),
            (600, 25 + 957 - 288)
        );
    }

    #[test]
    fn pixel_platforms_reserve_the_scaled_window_on_its_display() {
        // Nothing saved: the 150% primary's corner, the window 1.5x its
        // logical size.
        assert_eq!(
            resolve_sprite_position(None, WIN, &windows_pair()),
            (
                2880 - 420 - EDGE_MARGIN as i32,
                1728 - 480 - EDGE_MARGIN as i32
            )
        );
        // Saved on the 1x display: unscaled there.
        assert_eq!(
            resolve_sprite_position(Some((4700.0, 900.0)), WIN, &windows_pair()),
            (4800 - 280, 1040 - 320)
        );
    }

    #[test]
    fn no_reported_display_falls_back_to_a_plain_1080p_area() {
        assert_eq!(
            resolve_sprite_position(None, WIN, &[]),
            (
                1920 - 280 - EDGE_MARGIN as i32,
                1080 - 320 - EDGE_MARGIN as i32
            )
        );
    }

    #[test]
    fn a_legacy_saved_position_is_divided_by_its_display_s_scale() {
        // A pet saved at (600, 500)pt on the Retina laptop was stored as
        // tao's (1200, 1000).
        assert_eq!(
            legacy_position_to_desktop(
                (1200.0, 1000.0),
                (1312.0, 1144.0),
                &mac_pair_tao(),
                2.0,
                true
            ),
            (600.0, 500.0)
        );
        // Below the external display's tao rect and outside the laptop's: the
        // primary display's scale.
        assert_eq!(
            legacy_position_to_desktop(
                (3200.0, 2000.0),
                (3312.0, 2144.0),
                &mac_pair_tao(),
                2.0,
                true
            ),
            (1600.0, 1000.0)
        );
        // A broken scale is treated as one.
        assert_eq!(
            legacy_position_to_desktop((100.0, 100.0), (150.0, 150.0), &[], 0.0, true),
            (100.0, 100.0)
        );
        // Pixel platforms: tao's physical pixels already are desktop units.
        assert_eq!(
            legacy_position_to_desktop(
                (1200.0, 1000.0),
                (1312.0, 1144.0),
                &mac_pair_tao(),
                2.0,
                false
            ),
            (1200.0, 1000.0)
        );
    }

    #[test]
    fn fallback_to_bottom_right_when_unsaved() {
        let (x, y) = resolve_initial_position(None, WORK_AREA, WIN);
        assert_eq!(x, 1920.0 - 280.0 - EDGE_MARGIN);
        assert_eq!(y, 1080.0 - 320.0 - EDGE_MARGIN);
    }

    #[test]
    fn saved_position_inside_area_passes_through() {
        let (x, y) = resolve_initial_position(Some((500.0, 400.0)), WORK_AREA, WIN);
        assert_eq!((x, y), (500.0, 400.0));
    }

    #[test]
    fn clamps_from_right_edge() {
        // Saved X pushes the window past the right edge.
        let (x, _) = resolve_initial_position(Some((1900.0, 400.0)), WORK_AREA, WIN);
        assert_eq!(x, 1920.0 - 280.0);
    }

    #[test]
    fn clamps_from_bottom_edge() {
        let (_, y) = resolve_initial_position(Some((500.0, 1050.0)), WORK_AREA, WIN);
        assert_eq!(y, 1080.0 - 320.0);
    }

    #[test]
    fn clamps_from_left_edge() {
        let (x, _) = resolve_initial_position(Some((-100.0, 400.0)), WORK_AREA, WIN);
        assert_eq!(x, 0.0);
    }

    #[test]
    fn clamps_from_top_edge() {
        let (_, y) = resolve_initial_position(Some((500.0, -50.0)), WORK_AREA, WIN);
        assert_eq!(y, 0.0);
    }

    #[test]
    fn respects_work_area_origin_offset() {
        // Multi-monitor / taskbar offset: work area does not start at 0,0.
        let area = (100.0, 50.0, 1000.0, 800.0);
        let (x, y) = resolve_initial_position(None, area, WIN);
        assert_eq!(x, 100.0 + 1000.0 - 280.0 - EDGE_MARGIN);
        assert_eq!(y, 50.0 + 800.0 - 320.0 - EDGE_MARGIN);
    }

    #[test]
    fn fully_offscreen_saved_falls_back_to_clamped_corner() {
        // A saved position far off the right/bottom is clamped to the
        // bottom-right corner (window fully visible), not the margin fallback.
        let (x, y) = resolve_initial_position(Some((9999.0, 9999.0)), WORK_AREA, WIN);
        assert_eq!(x, 1920.0 - 280.0);
        assert_eq!(y, 1080.0 - 320.0);
    }

    #[test]
    fn oversized_window_pins_to_area_origin() {
        // Window larger than the work area: max becomes the origin, so it
        // pins top-left instead of producing a negative coordinate.
        let area = (0.0, 0.0, 200.0, 200.0);
        let (x, y) = resolve_initial_position(Some((50.0, 50.0)), area, WIN);
        assert_eq!((x, y), (0.0, 0.0));
    }

    #[test]
    fn rect_lookup_uses_physical_bounds_and_half_open_seams() {
        // The legacy-position lookup over tao rects. A 2x Retina laptop
        // (3456x2234 physical) with a 1x external display to its right.
        let rects = [(0.0, 0.0, 3456.0, 2234.0), (3456.0, 0.0, 1920.0, 1080.0)];
        assert_eq!(index_of_rect_containing((100.0, 100.0), &rects), Some(0));
        assert_eq!(index_of_rect_containing((3500.0, 200.0), &rects), Some(1));
        // The shared seam belongs to the right-hand monitor only.
        assert_eq!(index_of_rect_containing((3456.0, 10.0), &rects), Some(1));
        // Below the shorter external display: no monitor.
        assert_eq!(index_of_rect_containing((4000.0, 1500.0), &rects), None);
        assert_eq!(index_of_rect_containing((-1.0, 0.0), &rects), None);
    }

    #[test]
    fn resize_keeps_the_bottom_center_fixed() {
        // Growing 224x288 -> 288x352 keeps the feet on the same spot.
        let (x, y) = resize_anchored_bottom_center((1000.0, 700.0), (224.0, 288.0), (288.0, 352.0));
        assert_eq!((x, y), (968.0, 636.0));
        assert_eq!(x + 288.0 / 2.0, 1000.0 + 224.0 / 2.0);
        assert_eq!(y + 352.0, 700.0 + 288.0);
        // Shrinking moves the top-left the other way.
        let (x, y) = resize_anchored_bottom_center((968.0, 636.0), (288.0, 352.0), (224.0, 288.0));
        assert_eq!((x, y), (1000.0, 700.0));
    }

    #[test]
    fn resize_near_the_edge_is_clamped_back_into_the_work_area() {
        // A pet resting on the bottom-right corner grows: the anchored spot
        // would push it past both edges, the clamp pulls it fully back in.
        let anchored = resize_anchored_bottom_center(
            (1920.0 - 224.0, 1080.0 - 288.0),
            (224.0, 288.0),
            (448.0, 576.0),
        );
        let (x, y) = resolve_initial_position(Some(anchored), WORK_AREA, (448.0, 576.0));
        assert!(x + 448.0 <= 1920.0);
        assert_eq!(y + 576.0, 1080.0);
    }

    #[test]
    fn resizing_on_the_1x_external_display_keeps_the_feet_in_points() {
        // A 224x288pt pet standing at (2400, 700)pt on the external display
        // grows to 288x352: feet stay put, nothing is doubled.
        let frame = drect(2400, 700, 224, 288);
        let (area, scale) = work_area_for(Some(frame), &mac_pair());
        assert_eq!(scale, 1.0);
        assert_eq!(
            resize_position(frame, (288.0, 352.0), area, scale),
            (2368, 636)
        );
    }

    #[test]
    fn resizing_on_a_scaled_pixel_display_grows_by_its_scale() {
        // 150%: 224x288 logical is 336x432 physical; growing to 288x352
        // logical (432x528) keeps the bottom-center.
        let frame = drect(1000, 700, 336, 432);
        let (area, scale) = work_area_for(Some(frame), &windows_pair());
        assert_eq!(scale, 1.5);
        assert_eq!(
            resize_position(frame, (288.0, 352.0), area, scale),
            (952, 604)
        );
    }

    #[test]
    fn position_serializes_as_named_object_not_tuple() {
        // Regression: a tuple here became a JSON array and broke the `{x, y}`
        // contract of the TS wrapper (drag read undefined coordinates).
        let json = serde_json::to_value(PetWindowPosition { x: 120, y: -45 }).unwrap();
        assert_eq!(json["x"], 120);
        assert_eq!(json["y"], -45);
        assert!(json.as_object().is_some());
    }

    #[test]
    fn cursor_position_rounds_native_coordinates_into_the_wire_dto() {
        let position = pet_cursor_position((120.6, -45.4), 1.0, false);
        assert_eq!(position.x, 121);
        assert_eq!(position.y, -45);
        // macOS: tao's cursor is points times the PRIMARY display's scale, even
        // over the 1x external display; the DTO carries the points.
        let position = pet_cursor_position((6000.0, 1400.0), 2.0, true);
        assert_eq!((position.x, position.y), (3000, 700));
    }

    #[test]
    fn work_area_dto_maps_raw_monitor_numbers() {
        let monitors = [DesktopMonitor::from_tao(
            drect(-1920, 0, 1920, 1080),
            drect(-1920, 50, 1920, 1040),
            1.5,
            false,
        )];
        let dto = work_area_dto(None, &monitors).unwrap();
        assert_eq!(dto.x, -1920.0);
        assert_eq!(dto.y, 50.0);
        assert_eq!(dto.width, 1920.0);
        assert_eq!(dto.height, 1040.0);
        assert_eq!(dto.scale_factor, 1.5);
        assert!(work_area_dto(None, &[]).is_none());
    }

    #[test]
    fn work_area_follows_the_pet_across_a_retina_and_a_1x_display() {
        let monitors = mac_pair();
        // On the external display: its work area, and CSS px are points.
        let dto = work_area_dto(Some(drect(2400, 700, 224, 288)), &monitors).unwrap();
        assert_eq!(
            (dto.x, dto.y, dto.width, dto.height, dto.scale_factor),
            (1512.0, 25.0, 2560.0, 1415.0, 1.0)
        );
        // On the Retina laptop: tao's (0, 50, 3024, 1914) in points, and
        // still one point per CSS px.
        let dto = work_area_dto(Some(drect(600, 500, 224, 288)), &monitors).unwrap();
        assert_eq!(
            (dto.x, dto.y, dto.width, dto.height, dto.scale_factor),
            (0.0, 25.0, 1512.0, 957.0, 1.0)
        );
        // No pet window: the primary display.
        assert_eq!(work_area_dto(None, &monitors).unwrap().width, 1512.0);
    }

    #[test]
    fn work_area_serializes_camel_case() {
        let monitors = [DesktopMonitor::from_tao(
            drect(0, 0, 2560, 1440),
            drect(0, 0, 2560, 1400),
            1.25,
            false,
        )];
        let dto = work_area_dto(None, &monitors).unwrap();
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["x"], 0.0);
        assert_eq!(json["width"], 2560.0);
        assert_eq!(json["height"], 1400.0);
        assert_eq!(json["scaleFactor"], 1.25);
        assert!(json.get("scale_factor").is_none());
    }

    #[test]
    fn opts_deserializes_full_payload() {
        let opts: PetWindowOpts = serde_json::from_str(
            r#"{"width":300,"height":340,"x":120,"y":80,"clickThrough":true}"#,
        )
        .unwrap();
        assert_eq!(opts.width, 300.0);
        assert_eq!(opts.height, 340.0);
        assert_eq!(opts.x, Some(120.0));
        assert_eq!(opts.y, Some(80.0));
        assert!(opts.click_through);
        // An unmarked position is a pre-desktop-units one.
        assert_eq!(opts.position_space, PetPositionSpace::Legacy);
        let opts: PetWindowOpts = serde_json::from_str(
            r#"{"width":300,"height":340,"x":120,"y":80,"positionSpace":"desktop"}"#,
        )
        .unwrap();
        assert_eq!(opts.position_space, PetPositionSpace::Desktop);
        assert!(serde_json::from_str::<PetWindowOpts>(
            r#"{"width":300,"height":340,"positionSpace":"pixels"}"#
        )
        .is_err());
    }

    #[test]
    fn opts_deserializes_with_missing_optionals() {
        // x / y / clickThrough all default when absent.
        let opts: PetWindowOpts = serde_json::from_str(r#"{"width":280,"height":320}"#).unwrap();
        assert_eq!(opts.x, None);
        assert_eq!(opts.y, None);
        assert!(!opts.click_through);
    }

    #[test]
    fn reveal_command_accepts_only_the_two_pet_window_labels() {
        assert_eq!(
            pet_panel_role_for_label("pet").unwrap(),
            macos_panel::PetPanelRole::Sprite
        );
        assert_eq!(
            pet_panel_role_for_label(popup::PET_POPUP_LABEL).unwrap(),
            macos_panel::PetPanelRole::Popup
        );
        assert!(pet_panel_role_for_label("main")
            .unwrap_err()
            .contains("not a pet overlay"));
    }

    #[test]
    fn pet_overlay_capability_uses_the_dedicated_reveal_permission() {
        let capability = include_str!("../../capabilities/pet.json");
        let permission = include_str!("../../permissions/pet-app-commands.toml");
        assert!(capability.contains("\"allow-pet-app-commands\""));
        assert!(permission.contains("\"reveal_pet_window\""));
        assert!(!permission.contains("\"destroy_pet_window\""));
    }
}
