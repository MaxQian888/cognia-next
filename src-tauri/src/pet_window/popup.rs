//! Desktop-pet click popup ("分小窗口") — a dedicated small window for the pet's
//! interaction panel + quick actions, separate from the transparent sprite
//! window (label `"pet"`).
//!
//! Why a separate window: the sprite window used to *grow* to make room for the
//! right-click menu and then shift itself up — that resize/reposition raced the
//! menu's pointer anchor and the wander/throw position writes, so the popup
//! jittered and the menu clipped at the window edge. A dedicated OS window
//! (label `"pet-popup"`) renders the panel at its natural size (never clipped),
//! and the sprite window stops resizing entirely (the races are gone).
//!
//! Stability comes from native blur-to-close: the renderer focuses the popup
//! when it reveals it after first paint (`lib/pet/reveal.ts`), and an
//! `on_window_event` handler hides it on `WindowEvent::Focused(false)`, so
//! clicking anywhere else dismisses it exactly like a system context menu.
//!
//! Placement is owned HERE, not by the renderer. The sprite passes the
//! physical rectangle of the pet's own box (the anchor); this module resolves
//! where the popup goes — centered over the pet, above it, flipped below when
//! there is no room, clamped inside the work area of the monitor the pet is
//! on — and re-resolves it on every resize. A renderer-side placement could
//! only be computed once, from a size estimate, so when the popup then fitted
//! itself to its card it grew from a fixed top-left: a talk composer opening
//! on a popup placed below the pet ran off the bottom of the screen, and a
//! card shorter than the estimate left a gap between the pet and its menu.
//! The pure placement math is unit-tested; the live window ops are
//! smoke-tested via `pnpm tauri dev`.

use std::sync::Mutex;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Runtime, WindowEvent};

use super::{monitor_containing_physical_point, monitor_work_area, set_fixed_logical_size};

/// Window label of the click popup. Kept in sync with `lib/pet/window-role.ts`
/// (`PET_POPUP_WINDOW_LABEL`) so the popup webview resolves the "popup" role and
/// `PetMount` contributes nothing there.
pub(crate) const PET_POPUP_LABEL: &str = "pet-popup";

/// Gap (physical px at 1x, scaled by the monitor) between the popup and the
/// pet it belongs to.
const POPUP_GAP: f64 = 12.0;

/// Physical rectangle of the pet's own box on screen (not the whole sprite
/// window, whose transparent headroom for the speech bubble would push the
/// popup well above the pet's head). Mirrors the TS `PetPopupAnchor`.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetPopupAnchor {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Options the renderer passes when opening / re-showing the popup window.
/// Mirrors the TS wrapper in `lib/tauri/pet-window.ts`. `width`/`height` are
/// the logical size estimate; the popup re-fits itself to its card afterwards
/// through `pet_popup_resize`, which re-places it against the same anchor.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetPopupOpts {
    pub width: f64,
    pub height: f64,
    pub anchor: PetPopupAnchor,
}

/// The anchor of the current popup session, kept so every resize re-places
/// the popup against the pet it was opened for.
static POPUP_ANCHOR: Mutex<Option<PetPopupAnchor>> = Mutex::new(None);

fn store_anchor(anchor: PetPopupAnchor) {
    *POPUP_ANCHOR.lock().unwrap_or_else(|p| p.into_inner()) = Some(anchor);
}

fn current_anchor() -> Option<PetPopupAnchor> {
    *POPUP_ANCHOR.lock().unwrap_or_else(|p| p.into_inner())
}

/// Resolve the popup's physical top-left.
///
/// - Horizontally centered over the anchor, then clamped inside the work area.
/// - Above the anchor by `gap`; flipped below it when the top would cross the
///   work-area top.
/// - Finally clamped vertically so the whole popup stays inside the work area
///   (when neither side fully fits it pins to an edge instead of leaving the
///   screen).
///
/// All values are physical pixels. Pure so every branch is unit-tested.
fn resolve_popup_placement(
    anchor: PetPopupAnchor,
    popup: (f64, f64),
    work_area: (f64, f64, f64, f64),
    gap: f64,
) -> (f64, f64) {
    let (area_x, area_y, area_w, area_h) = work_area;
    let (popup_w, popup_h) = popup;

    let max_x = (area_x + area_w - popup_w).max(area_x);
    let x = (anchor.x + anchor.width / 2.0 - popup_w / 2.0).clamp(area_x, max_x);

    let above = anchor.y - gap - popup_h;
    let below = anchor.y + anchor.height + gap;
    let y = if above >= area_y { above } else { below };
    let max_y = (area_y + area_h - popup_h).max(area_y);
    let y = y.clamp(area_y, max_y);

    (x.round(), y.round())
}

/// Size the popup to `logical` and place it against `anchor` on the monitor
/// that holds the pet, in one step so a size write can never race a position
/// write.
fn place_popup<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
    anchor: PetPopupAnchor,
    logical: (f64, f64),
) -> Result<(), String> {
    let center = (
        anchor.x + anchor.width / 2.0,
        anchor.y + anchor.height / 2.0,
    );
    let monitor = monitor_containing_physical_point(app, center)
        .or_else(|| app.primary_monitor().ok().flatten());
    let (area_x, area_y, area_w, area_h, scale) = match monitor.as_ref() {
        Some(monitor) => monitor_work_area(monitor),
        None => (0.0, 0.0, 1920.0, 1080.0, 1.0),
    };
    let physical = (logical.0 * scale, logical.1 * scale);
    let (x, y) = resolve_popup_placement(
        anchor,
        physical,
        (area_x, area_y, area_w, area_h),
        POPUP_GAP * scale,
    );
    set_fixed_logical_size(window, logical.0, logical.1)?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

/// Hide the popup window (toggle / blur). Cheap to re-show, so we hide rather
/// than destroy. Generic so `mod.rs` (also generic over runtime) can reuse it
/// when the sprite window is hidden or destroyed.
pub(crate) fn close_pet_popup_inner<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    super::macos_panel::cancel_panel_reveal(super::macos_panel::PetPanelRole::Popup);
    if let Some(window) = app.get_webview_window(PET_POPUP_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
        // Tell the renderer the popup is gone so its open/expanded state can't
        // desync from a native hide it didn't initiate.
        let _ = app.emit("pet-popup://hidden", serde_json::Value::Null);
    }
    Ok(())
}

/// Open (or show + reposition + focus, if it already exists) the popup window.
/// On first create it is frameless, transparent, always-on-top, skip-taskbar,
/// non-resizable, and hidden — the renderer reveals + focuses it after its
/// first painted frame (so the blur-to-close handler can fire without the
/// window ever flashing an unpainted opaque rectangle).
fn open_pet_popup_inner<R: Runtime>(app: &AppHandle<R>, opts: PetPopupOpts) -> Result<(), String> {
    store_anchor(opts.anchor);
    if let Some(window) = app.get_webview_window(PET_POPUP_LABEL) {
        place_popup(app, &window, opts.anchor, (opts.width, opts.height))?;
        let generation =
            super::macos_panel::begin_panel_open(super::macos_panel::PetPanelRole::Popup);
        if let Err(error) = super::macos_panel::reveal_pet_panel(
            &window,
            super::macos_panel::PetPanelRole::Popup,
            true,
            generation,
        ) {
            super::macos_panel::cancel_panel_reveal(super::macos_panel::PetPanelRole::Popup);
            return Err(error);
        }
        // The re-shown webview kept its last fitted card size cached, while
        // the window was just reset to the estimate; tell it to fit again.
        let _ = app.emit("pet-popup://shown", serde_json::Value::Null);
        return Ok(());
    }

    let generation = super::macos_panel::begin_panel_open(super::macos_panel::PetPanelRole::Popup);

    let window = tauri::WebviewWindowBuilder::new(
        app,
        PET_POPUP_LABEL,
        tauri::WebviewUrl::App("pet-popup".into()),
    )
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .visible(false)
    .inner_size(opts.width, opts.height)
    .build()
    .map_err(|error| {
        super::macos_panel::cancel_panel_reveal(super::macos_panel::PetPanelRole::Popup);
        error.to_string()
    })?;

    // Same as the sprite window (`mod.rs`): the app-wide menu bar attaches to
    // every new window on Windows/Linux — detach it from this frameless popup
    // before the first reveal so no File/Edit menubar strip ever paints.
    let _ = window.remove_menu();

    // Windows: keep it out of the taskbar and Alt-Tab, but leave it able to
    // take focus — the composer needs the keyboard and blur-to-close needs a
    // window that held focus.
    #[cfg(target_os = "windows")]
    if let Err(error) = crate::window_utils::apply_windows_tool_window(&window) {
        super::macos_panel::cancel_panel_reveal(super::macos_panel::PetPanelRole::Popup);
        let _ = window.close();
        return Err(error);
    }

    if let Err(error) = place_popup(app, &window, opts.anchor, (opts.width, opts.height)) {
        super::macos_panel::cancel_panel_reveal(super::macos_panel::PetPanelRole::Popup);
        let _ = window.close();
        return Err(error);
    }

    // Native blur-to-close: clicking outside the popup (it loses focus) hides
    // it, mirroring a system context menu. A native close (Alt+F4) becomes the
    // same hide unless destroy owns the label. Scoped to this window — no
    // global event handler needed. Re-look-up by label so the closure owns no
    // window handle (avoids a self-referential capture).
    let app_handle = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(false) => {
            let _ = close_pet_popup_inner(&app_handle);
        }
        WindowEvent::CloseRequested { api, .. }
            if !super::macos_panel::panel_is_destroying(
                super::macos_panel::PetPanelRole::Popup,
            ) =>
        {
            api.prevent_close();
            let _ = close_pet_popup_inner(&app_handle);
        }
        _ => {}
    });

    // macOS: reclass to a non-activating NSPanel (all Spaces, over full-screen,
    // no focus theft). `can_become_key_window: true` keeps the talk composer
    // typeable; the `WindowEvent::Focused(false)` blur-to-close above is kept as
    // the cross-platform dismiss path. No-op off macOS.
    //
    // `to_panel`'s raw AppKit calls trap off-main. Wait for the conversion so
    // the command cannot report success with a hidden ordinary NSWindow.
    if let Err(error) =
        super::macos_panel::configure_pet_panel(&window, super::macos_panel::PetPanelRole::Popup)
    {
        super::macos_panel::cancel_panel_reveal(super::macos_panel::PetPanelRole::Popup);
        let _ = super::macos_panel::detach_pet_panel(&window);
        let _ = window.close();
        return Err(error);
    }
    if !super::macos_panel::panel_generation_is_current(
        super::macos_panel::PetPanelRole::Popup,
        generation,
    ) {
        // Destroy may have started before the builder inserted this label, so
        // the stale build is responsible for detaching and closing itself.
        let _ = super::macos_panel::detach_pet_panel(&window);
        let _ = window.close();
        return Ok(());
    }

    // Intentionally do NOT `show()` / `set_focus()` here. Like the sprite
    // window (`mod.rs`), a `transparent(true)` window shown before its WebView
    // commits a first paint renders an opaque rectangle — here the popup's
    // pre-hydration page background — until a recomposite. The window is
    // created `visible(false)`; `PetPopupView` reveals + focuses it after its
    // first painted frame (`lib/pet/reveal.ts`), which also arms the native
    // blur-to-close handler above (it needs the window to have held focus).
    // The re-show branch at the top still shows + focuses directly because an
    // existing window has already painted, so it can never flash.
    Ok(())
}

#[tauri::command]
pub async fn open_pet_popup(app: AppHandle, opts: PetPopupOpts) -> Result<(), String> {
    // A sprite destroy also destroys this label. Wait until its queued close
    // event has removed the old webview before allowing a fresh builder to use
    // the same label.
    let _build_guard = {
        let mut guard = None;
        for _ in 0..200 {
            if let Some(claimed) =
                super::macos_panel::try_begin_panel_build(super::macos_panel::PetPanelRole::Popup)
            {
                guard = Some(claimed);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        guard.ok_or_else(|| "pet popup: timed out waiting for destroy to finish".to_string())?
    };
    open_pet_popup_inner(&app, opts)
}

/// Hide the popup window (renderer Esc / explicit close action).
#[tauri::command]
pub async fn close_pet_popup(app: AppHandle) -> Result<(), String> {
    close_pet_popup_inner(&app)
}

/// Fit the popup to its card (logical pixels) and re-place it against the
/// anchor it was opened for, so growing (the talk composer opening) or
/// shrinking never leaves it off-screen or detached from the pet.
#[tauri::command]
pub async fn pet_popup_resize(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    if !(width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0) {
        return Err(format!("pet popup: invalid size {width}x{height}"));
    }
    let Some(window) = app.get_webview_window(PET_POPUP_LABEL) else {
        return Ok(());
    };
    match current_anchor() {
        Some(anchor) => place_popup(&app, &window, anchor, (width, height)),
        // Unreachable through the renderer (every open stores an anchor);
        // still honor the size rather than refuse it.
        None => set_fixed_logical_size(&window, width, height),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: (f64, f64, f64, f64) = (0.0, 0.0, 1920.0, 1080.0);
    const POPUP: (f64, f64) = (320.0, 400.0);

    fn anchor(x: f64, y: f64) -> PetPopupAnchor {
        PetPopupAnchor {
            x,
            y,
            width: 128.0,
            height: 128.0,
        }
    }

    #[test]
    fn opts_deserializes_camel_case_payload() {
        let opts: PetPopupOpts = serde_json::from_str(
            r#"{"width":288,"height":360,"anchor":{"x":1200,"y":640,"width":128,"height":128}}"#,
        )
        .unwrap();
        assert_eq!(opts.width, 288.0);
        assert_eq!(opts.height, 360.0);
        assert_eq!(opts.anchor, anchor(1200.0, 640.0));
    }

    #[test]
    fn opts_rejects_a_missing_anchor() {
        // Placement is resolved here from the anchor; without one there is
        // nothing to place against, so it is a hard error, not a default.
        let res: Result<PetPopupOpts, _> = serde_json::from_str(r#"{"width":288,"height":360}"#);
        assert!(res.is_err());
    }

    #[test]
    fn places_above_and_centered_over_the_pet() {
        let (x, y) = resolve_popup_placement(anchor(800.0, 600.0), POPUP, AREA, POPUP_GAP);
        assert_eq!(x, 800.0 + 64.0 - 160.0);
        assert_eq!(y, 600.0 - POPUP_GAP - 400.0);
    }

    #[test]
    fn flips_below_when_there_is_no_room_above() {
        let (_, y) = resolve_popup_placement(anchor(800.0, 40.0), POPUP, AREA, POPUP_GAP);
        assert_eq!(y, 40.0 + 128.0 + POPUP_GAP);
    }

    #[test]
    fn clamps_horizontally_at_both_edges() {
        assert_eq!(
            resolve_popup_placement(anchor(1880.0, 600.0), POPUP, AREA, POPUP_GAP).0,
            1920.0 - 320.0
        );
        assert_eq!(
            resolve_popup_placement(anchor(-20.0, 600.0), POPUP, AREA, POPUP_GAP).0,
            0.0
        );
    }

    #[test]
    fn a_grown_popup_below_the_pet_stays_on_screen() {
        // Opened below a pet near the top; the composer then grows the card to
        // 900px. Re-resolving pins it inside the work area instead of letting
        // it run off the bottom (the old fixed-top-left resize did).
        let (_, y) = resolve_popup_placement(anchor(800.0, 40.0), (320.0, 900.0), AREA, POPUP_GAP);
        assert!(y + 900.0 <= 1080.0);
        assert!(y >= 0.0);
    }

    #[test]
    fn a_shrunk_popup_above_the_pet_hugs_it() {
        // The estimate was 460 tall; the card fits in 300. Re-placing keeps
        // the gap to the pet at exactly POPUP_GAP rather than ~160px.
        let (_, y) = resolve_popup_placement(anchor(800.0, 600.0), (320.0, 300.0), AREA, POPUP_GAP);
        assert_eq!(y + 300.0 + POPUP_GAP, 600.0);
    }

    #[test]
    fn respects_a_secondary_monitor_work_area() {
        let area = (1920.0, 0.0, 1280.0, 1024.0);
        let (x, y) = resolve_popup_placement(anchor(2400.0, 700.0), POPUP, area, POPUP_GAP);
        assert!(x >= 1920.0 && x + 320.0 <= 3200.0);
        assert_eq!(y, 700.0 - POPUP_GAP - 400.0);
    }

    #[test]
    fn a_popup_taller_than_the_screen_pins_to_the_top() {
        let (_, y) =
            resolve_popup_placement(anchor(800.0, 600.0), (320.0, 2000.0), AREA, POPUP_GAP);
        assert_eq!(y, 0.0);
    }

    #[test]
    fn label_matches_renderer_contract() {
        // Must stay in lockstep with `lib/pet/window-role.ts` PET_POPUP_WINDOW_LABEL.
        assert_eq!(PET_POPUP_LABEL, "pet-popup");
    }
}
