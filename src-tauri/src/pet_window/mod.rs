//! Desktop pet ("桌宠") overlay window lifecycle.
//!
//! The pet lives in a dedicated webview window labelled `"pet"`: transparent,
//! frameless, always-on-top, skip-taskbar. It loads the `/pet-overlay` route
//! and survives the main window's close-to-tray (it is a sibling window, not a
//! child). The renderer drives it through the commands below; the tray
//! native-action handler reaches the same open/close behaviour via the
//! `pub(crate)` helpers so a tray click and a settings toggle share one path.
//!
//! Position is owned by PetSettings (the renderer), NOT by
//! `tauri-plugin-window-state` — `lib.rs` denylists `"pet"` so the plugin
//! never fights the saved overlay coordinates.
//!
//! Live window manipulation can't be unit-tested here: it needs a
//! `tauri::test::mock_app()` runtime which fails on this project's Windows
//! toolchain (see `plugin_api/window_ops.rs:46` for the same convention).
//! Only the pure position math and the DTO serde shape are unit-tested; the
//! window ops are smoke-tested via `pnpm tauri dev`.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, Runtime};

mod popup;
mod surfaces;
pub use popup::*;
pub use surfaces::*;

/// Default overlay size used when the tray opens the pet with no renderer
/// supplied options (the renderer always sends its persisted size).
const DEFAULT_PET_WIDTH: f64 = 280.0;
const DEFAULT_PET_HEIGHT: f64 = 320.0;

/// Margin (in physical pixels) kept between the overlay and the work-area
/// edges when falling back to the bottom-right corner.
const EDGE_MARGIN: f64 = 24.0;

/// Options the renderer passes when opening / re-showing the pet window.
/// Mirrors the TS wrapper in `lib/tauri/pet-window.ts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetWindowOpts {
    pub width: f64,
    pub height: f64,
    /// Saved top-left X in physical pixels, if the user has dragged before.
    #[serde(default)]
    pub x: Option<f64>,
    /// Saved top-left Y in physical pixels, if the user has dragged before.
    #[serde(default)]
    pub y: Option<f64>,
    /// When true the window ignores cursor events (click-through mode).
    #[serde(default)]
    pub click_through: bool,
}

impl Default for PetWindowOpts {
    fn default() -> Self {
        Self {
            width: DEFAULT_PET_WIDTH,
            height: DEFAULT_PET_HEIGHT,
            x: None,
            y: None,
            click_through: false,
        }
    }
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

/// Scale a logical overlay size up to physical pixels. The window's
/// `inner_size` stays logical, but the bottom-right placement math runs in
/// physical pixels (monitor geometry + persisted drag coords are physical), so
/// the size used for clamping must be physical too. Pure so the Retina-scale
/// case is unit-tested without a live window.
fn physical_overlay_size(logical: (f64, f64), scale: f64) -> (f64, f64) {
    (logical.0 * scale, logical.1 * scale)
}

/// Primary-monitor work area in physical pixels plus its scale factor, or a
/// sane fallback when the monitor can't be resolved (headless / during
/// shutdown). The scale factor is needed because the renderer-supplied overlay
/// size is logical while the monitor geometry — and the persisted drag
/// position — are physical; mixing the two placed the window at `scale`× the
/// intended spot on Retina (it landed fully off-screen on macOS).
fn primary_work_area<R: Runtime>(app: &AppHandle<R>) -> (f64, f64, f64, f64, f64) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let pos = monitor.position();
        let size = monitor.size();
        (
            pos.x as f64,
            pos.y as f64,
            size.width as f64,
            size.height as f64,
            monitor.scale_factor(),
        )
    } else {
        // Conservative default desktop size; keeps the fallback corner sane.
        (0.0, 0.0, 1920.0, 1080.0, 1.0)
    }
}

/// Core "open or re-show" logic shared by the `open_pet_window` command and
/// the tray native action. Idempotent: if the window already exists it is
/// shown, focused, and its click-through state re-applied.
pub(crate) fn open_pet_window_inner<R: Runtime>(
    app: &AppHandle<R>,
    opts: PetWindowOpts,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("pet") {
        window.show().map_err(|e| e.to_string())?;
        let _ = window.set_focus();
        window
            .set_ignore_cursor_events(opts.click_through)
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let (area_x, area_y, area_w, area_h, scale) = primary_work_area(app);
    // The monitor work area and any persisted drag position are PHYSICAL pixels,
    // but `inner_size` (and `opts.width/height`) are LOGICAL. Resolve placement
    // entirely in physical pixels — converting the logical overlay size up by
    // `scale` — then apply it via `set_position(Physical…)`. Using the builder's
    // logical `.position()` with physical inputs put the window at `scale`× the
    // target on Retina, which on macOS is fully off-screen (looks like "no
    // window opened").
    let (x, y) = resolve_initial_position(
        opts.x.zip(opts.y),
        (area_x, area_y, area_w, area_h),
        physical_overlay_size((opts.width, opts.height), scale),
    );

    let window =
        tauri::WebviewWindowBuilder::new(app, "pet", tauri::WebviewUrl::App("pet-overlay".into()))
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .visible(false)
            .inner_size(opts.width, opts.height)
            .build()
            .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;

    // Apply click-through before the first paint, then reveal — reduces the
    // transparent-webview first-paint flicker on Windows.
    window
        .set_ignore_cursor_events(opts.click_through)
        .map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;

    Ok(())
}

/// Core "hide for toggle" logic shared by the command and the tray action.
/// Resets click-through to false first so a hidden window can never strand the
/// pointer; reopening is cheap so we hide rather than destroy.
pub(crate) fn close_pet_window_inner<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("pet") {
        window
            .set_ignore_cursor_events(false)
            .map_err(|e| e.to_string())?;
        window.hide().map_err(|e| e.to_string())?;
    }
    // Never strand the click popup over the desktop once the sprite is hidden.
    let _ = popup::close_pet_popup_inner(app);
    Ok(())
}

/// True when the pet window exists AND is currently visible.
pub(crate) fn is_pet_window_open_inner<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window("pet")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

/// Open the desktop pet window, or show + focus it if it already exists.
#[tauri::command]
pub async fn open_pet_window(app: AppHandle, opts: PetWindowOpts) -> Result<(), String> {
    open_pet_window_inner(&app, opts)
}

/// Hide the desktop pet window (toggle semantics — reopen is cheap).
#[tauri::command]
pub async fn close_pet_window(app: AppHandle) -> Result<(), String> {
    close_pet_window_inner(&app)
}

/// Fully destroy the pet window — used by the settings "disable" path so the
/// overlay is gone (not merely hidden) until re-enabled.
#[tauri::command]
pub async fn destroy_pet_window(app: AppHandle) -> Result<(), String> {
    // Tear the click popup down with the sprite so disabling the pet leaves no
    // orphan window behind.
    if let Some(popup) = app.get_webview_window(popup::PET_POPUP_LABEL) {
        let _ = popup.close();
    }
    if let Some(window) = app.get_webview_window("pet") {
        // Reset click-through first so a future window can never inherit a
        // pointer-trapping state through a recreated label.
        let _ = window.set_ignore_cursor_events(false);
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Toggle click-through (cursor event ignoring) on the pet window.
#[tauri::command]
pub async fn pet_window_set_ignore_cursor_events(
    app: AppHandle,
    ignore: bool,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("pet") {
        window
            .set_ignore_cursor_events(ignore)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Move the pet window to an absolute physical position (drag persistence).
#[tauri::command]
pub async fn pet_window_set_position(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("pet") {
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Named position DTO — a bare Rust tuple would serialize as a JSON array,
/// which the TS wrapper (typed `{ x, y }`) silently read as `undefined`s and
/// broke overlay dragging. Keep this a struct.
#[derive(Debug, Clone, Serialize)]
pub struct PetWindowPosition {
    pub x: i32,
    pub y: i32,
}

/// Read the pet window's current outer position. `None` when the window is
/// absent (so the renderer can fall back to its persisted coordinates).
#[tauri::command]
pub async fn pet_window_get_position(app: AppHandle) -> Result<Option<PetWindowPosition>, String> {
    match app.get_webview_window("pet") {
        Some(window) => {
            let pos = window.outer_position().map_err(|e| e.to_string())?;
            Ok(Some(PetWindowPosition { x: pos.x, y: pos.y }))
        }
        None => Ok(None),
    }
}

/// True when the pet window exists and is visible.
#[tauri::command]
pub async fn is_pet_window_open(app: AppHandle) -> bool {
    is_pet_window_open_inner(&app)
}

/// Work area of one monitor in physical pixels (taskbar excluded), plus its
/// scale factor so the renderer can convert logical window sizes. Mirrors the
/// TS `PetWorkArea` in `lib/tauri/pet-window.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetWorkArea {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
}

/// Pure DTO assembly from raw monitor numbers (unit-tested without a window).
fn work_area_dto(pos: (i32, i32), size: (u32, u32), scale_factor: f64) -> PetWorkArea {
    PetWorkArea {
        x: pos.0 as f64,
        y: pos.1 as f64,
        width: size.0 as f64,
        height: size.1 as f64,
        scale_factor,
    }
}

/// Work area of the monitor the pet window currently sits on (falls back to
/// the primary monitor, then `None` when neither resolves — headless). The
/// wander loop keeps the pet inside this rectangle.
#[tauri::command]
pub async fn pet_window_get_work_area(app: AppHandle) -> Result<Option<PetWorkArea>, String> {
    let monitor = app
        .get_webview_window("pet")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    Ok(monitor.map(|m| {
        let rect = m.work_area();
        work_area_dto(
            (rect.position.x, rect.position.y),
            (rect.size.width, rect.size.height),
            m.scale_factor(),
        )
    }))
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

    #[test]
    fn physical_overlay_size_scales_logical_by_factor() {
        // 1x display: logical == physical.
        assert_eq!(physical_overlay_size((280.0, 320.0), 1.0), (280.0, 320.0));
        // 2x Retina: the placement math must see the doubled physical size, or
        // the bottom-right fallback under-reserves and the window lands
        // off-screen (the macOS "no window opened" bug).
        assert_eq!(physical_overlay_size((280.0, 320.0), 2.0), (560.0, 640.0));
    }

    #[test]
    fn retina_unsaved_fallback_stays_on_screen() {
        // Regression: a 280x320 logical overlay on a 3456x2234 physical Retina
        // (2x) display must reserve the *physical* 560x640, landing the window
        // fully on-screen at the bottom-right corner — not at scale x the spot
        // (which is off-screen). Mirrors the live-verified fix.
        let area = (0.0, 0.0, 3456.0, 2234.0);
        let win_phys = physical_overlay_size((280.0, 320.0), 2.0);
        let (x, y) = resolve_initial_position(None, area, win_phys);
        assert_eq!(x, 3456.0 - 560.0 - EDGE_MARGIN);
        assert_eq!(y, 2234.0 - 640.0 - EDGE_MARGIN);
        // Window fully within the monitor bounds.
        assert!(x + win_phys.0 <= 3456.0);
        assert!(y + win_phys.1 <= 2234.0);
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
    fn position_serializes_as_named_object_not_tuple() {
        // Regression: a tuple here became a JSON array and broke the `{x, y}`
        // contract of the TS wrapper (drag read undefined coordinates).
        let json = serde_json::to_value(PetWindowPosition { x: 120, y: -45 }).unwrap();
        assert_eq!(json["x"], 120);
        assert_eq!(json["y"], -45);
        assert!(json.as_object().is_some());
    }

    #[test]
    fn work_area_dto_maps_raw_monitor_numbers() {
        let dto = work_area_dto((-1920, 50), (1920, 1040), 1.5);
        assert_eq!(dto.x, -1920.0);
        assert_eq!(dto.y, 50.0);
        assert_eq!(dto.width, 1920.0);
        assert_eq!(dto.height, 1040.0);
        assert_eq!(dto.scale_factor, 1.5);
    }

    #[test]
    fn work_area_serializes_camel_case() {
        let dto = work_area_dto((0, 0), (2560, 1400), 1.25);
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
    fn opts_default_matches_constants() {
        let opts = PetWindowOpts::default();
        assert_eq!(opts.width, DEFAULT_PET_WIDTH);
        assert_eq!(opts.height, DEFAULT_PET_HEIGHT);
        assert_eq!(opts.x, None);
        assert_eq!(opts.y, None);
        assert!(!opts.click_through);
    }
}
