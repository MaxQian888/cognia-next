//! The "island" overlay window — a Dynamic-Island-style status strip pinned
//! top-center of the primary display (under the macOS notch).
//!
//! Same window recipe as the desktop pet (`pet_window/mod.rs`): transparent,
//! frameless, always-on-top, skip-taskbar, created hidden and revealed by the
//! renderer after first paint (Windows black-rectangle bug), reclassed to a
//! non-activating NSPanel on macOS via the shared pet panel seam so it floats
//! over every Space and never steals focus. The label `"island"` is
//! denylisted from `tauri-plugin-window-state` in `lib.rs` (position is
//! always recomputed, never persisted).
//!
//! Live window ops can't run under `tauri::test::mock_app()` on this
//! project's toolchains (same constraint documented in `pet_window/mod.rs`),
//! so only the pure placement math is unit-tested; the runtime behavior is
//! covered by `tauri-smoke`.

use serde::Deserialize;
use tauri::{AppHandle, Manager, PhysicalPosition, Runtime};

pub const ISLAND_LABEL: &str = "island";

/// Collapsed pill footprint (logical px) used when the renderer passes no
/// explicit size. The renderer resizes via `island_resize` on expand/collapse.
const DEFAULT_ISLAND_WIDTH: f64 = 420.0;
const DEFAULT_ISLAND_HEIGHT: f64 = 44.0;

/// Gap between the work-area top edge and the island.
const TOP_MARGIN: f64 = 8.0;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandWindowOpts {
    #[serde(default = "default_width")]
    pub width: f64,
    #[serde(default = "default_height")]
    pub height: f64,
}

fn default_width() -> f64 {
    DEFAULT_ISLAND_WIDTH
}
fn default_height() -> f64 {
    DEFAULT_ISLAND_HEIGHT
}

impl Default for IslandWindowOpts {
    fn default() -> Self {
        Self {
            width: DEFAULT_ISLAND_WIDTH,
            height: DEFAULT_ISLAND_HEIGHT,
        }
    }
}

/// Top-center placement inside the work area. `work_area` and `win` are both
/// physical pixels (caller scales the logical size — same Retina rule as
/// `pet_window::physical_overlay_size`). Pure for unit tests.
fn resolve_island_position(
    work_area: (f64, f64, f64, f64),
    win: (f64, f64),
    scale: f64,
) -> (f64, f64) {
    let (area_x, area_y, area_w, _area_h) = work_area;
    let (win_w, _win_h) = win;
    let x = (area_x + (area_w - win_w) / 2.0).max(area_x);
    let y = area_y + TOP_MARGIN * scale;
    (x, y)
}

fn primary_work_area<R: Runtime>(app: &AppHandle<R>) -> (f64, f64, f64, f64, f64) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let rect = monitor.work_area();
        (
            rect.position.x as f64,
            rect.position.y as f64,
            rect.size.width as f64,
            rect.size.height as f64,
            monitor.scale_factor(),
        )
    } else {
        (0.0, 0.0, 1920.0, 1080.0, 1.0)
    }
}

/// Open (or re-show) the island. Shared by the Tauri command and the tray
/// action — idempotent like `open_pet_window_inner`.
pub(crate) fn open_island_window_inner<R: Runtime>(
    app: &AppHandle<R>,
    opts: IslandWindowOpts,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(ISLAND_LABEL) {
        window.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let (area_x, area_y, area_w, area_h, scale) = primary_work_area(app);
    let (x, y) = resolve_island_position(
        (area_x, area_y, area_w, area_h),
        (opts.width * scale, opts.height * scale),
        scale,
    );

    let window = tauri::WebviewWindowBuilder::new(
        app,
        ISLAND_LABEL,
        tauri::WebviewUrl::App("island".into()),
    )
    // Same transparency rules as the pet window: `transparent(true)` only,
    // never `.background_color(...)` (forces an opaque layer on Windows).
    // The page paints itself transparent via `data-island-overlay` CSS.
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

    // Strip the app menu bar on Windows/Linux (same fix as the pet overlay).
    let _ = window.remove_menu();

    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;

    // Non-activating NSPanel: float over all Spaces + full-screen apps, never
    // steal focus. `Popup` role — the island has clickable Approve/Deny
    // buttons and `becomes_key_only_if_needed` keeps plain clicks non-key.
    crate::pet_window::apply_overlay_panel_behavior(
        &window,
        crate::pet_window::OverlayPanelRole::Popup,
    )?;

    // Reveal is renderer-driven after first paint; force-show safety net
    // mirrors the pet window's (a hung hydrate must not strand an invisible
    // island forever).
    {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(8)).await;
            if let Some(window) = handle.get_webview_window(ISLAND_LABEL) {
                if !window.is_visible().unwrap_or(true) {
                    log::warn!(
                        "island window still hidden 8s after open; force-showing (renderer never signaled first paint)"
                    );
                    crate::window_utils::bring_window_to_front(&window);
                }
            }
        });
    }

    Ok(())
}

pub(crate) fn close_island_window_inner<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(ISLAND_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn is_island_window_open_inner<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window(ISLAND_LABEL)
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

#[tauri::command]
pub async fn open_island_window(app: AppHandle, opts: Option<IslandWindowOpts>) -> Result<(), String> {
    open_island_window_inner(&app, opts.unwrap_or_default())
}

#[tauri::command]
pub async fn close_island_window(app: AppHandle) -> Result<(), String> {
    close_island_window_inner(&app)
}

#[tauri::command]
pub async fn is_island_window_open(app: AppHandle) -> bool {
    is_island_window_open_inner(&app)
}

/// Resize on expand/collapse, keeping the strip centered under the notch.
/// `width`/`height` are logical px (renderer-measured content size).
#[tauri::command]
pub async fn island_resize(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let Some(window) = app.get_webview_window(ISLAND_LABEL) else {
        return Ok(());
    };
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;

    let (area_x, area_y, area_w, area_h, scale) = primary_work_area(&app);
    let (x, y) = resolve_island_position(
        (area_x, area_y, area_w, area_h),
        (width * scale, height * scale),
        scale,
    );
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centers_horizontally_with_top_margin() {
        // 1x display 1920 wide, 420px strip → x = (1920-420)/2.
        let (x, y) = resolve_island_position((0.0, 0.0, 1920.0, 1080.0), (420.0, 44.0), 1.0);
        assert_eq!(x, 750.0);
        assert_eq!(y, TOP_MARGIN);
    }

    #[test]
    fn respects_work_area_origin_and_retina_scale() {
        // Secondary-monitor offset + 2x Retina: margins scale physically.
        let (x, y) = resolve_island_position(
            (100.0, 50.0, 3456.0, 2234.0),
            (420.0 * 2.0, 44.0 * 2.0),
            2.0,
        );
        assert_eq!(x, 100.0 + (3456.0 - 840.0) / 2.0);
        assert_eq!(y, 50.0 + TOP_MARGIN * 2.0);
    }

    #[test]
    fn oversized_strip_pins_to_area_left() {
        let (x, _) = resolve_island_position((0.0, 0.0, 400.0, 300.0), (800.0, 44.0), 1.0);
        assert_eq!(x, 0.0);
    }

    #[test]
    fn opts_default_and_deserialize() {
        let opts = IslandWindowOpts::default();
        assert_eq!(opts.width, DEFAULT_ISLAND_WIDTH);
        assert_eq!(opts.height, DEFAULT_ISLAND_HEIGHT);
        let parsed: IslandWindowOpts = serde_json::from_str(r#"{"width":500}"#).unwrap();
        assert_eq!(parsed.width, 500.0);
        assert_eq!(parsed.height, DEFAULT_ISLAND_HEIGHT);
    }
}
