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

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, Runtime};

pub const ISLAND_LABEL: &str = "island";

/// Persisted island preferences (`<cognia-home>/island-window.json`). Written
/// by `island_set_monitor`, read on every placement so the tray-toggle path
/// (which never goes through the renderer) honors the choice too.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct IslandConfig {
    /// Preferred monitor name (`Monitor::name`). `None` → primary monitor.
    pub monitor: Option<String>,
}

fn island_config_path() -> Option<std::path::PathBuf> {
    crate::agents::paths::cognia_home().map(|home| home.join("island-window.json"))
}

fn load_island_config() -> IslandConfig {
    island_config_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_island_config(cfg: &IslandConfig) -> Result<(), String> {
    let path = island_config_path().ok_or_else(|| "cannot resolve cognia home".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// Collapsed pill footprint (logical px) used when the renderer passes no
/// explicit size. The renderer resizes via `island_resize` on expand/collapse.
const DEFAULT_ISLAND_WIDTH: f64 = 420.0;
const DEFAULT_ISLAND_HEIGHT: f64 = 44.0;

/// Gap between the work-area top edge and the island. Zero: the strip hugs
/// the top edge so the renderer's Dock-style auto-tuck (a translateY inside
/// the window) reads as "hidden into the top of the screen" — any margin here
/// would leave the tucked sliver floating with a visible gap above it.
const TOP_MARGIN: f64 = 0.0;

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

/// Clamp the renderer-requested logical size to the monitor's logical work
/// area so an expanded island can never spill past the screen (which would
/// otherwise clip rows and paint scrollbars). Pure for unit tests.
fn clamp_island_size(width: f64, height: f64, area_logical: (f64, f64)) -> (f64, f64) {
    let (area_w, area_h) = area_logical;
    (width.min(area_w).max(1.0), height.min(area_h).max(1.0))
}

/// The monitor the island should live on: the persisted preference when that
/// monitor is still connected, else the primary.
fn resolve_target_monitor<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::Monitor> {
    if let Some(name) = load_island_config().monitor {
        if let Ok(monitors) = app.available_monitors() {
            if let Some(m) = monitors
                .into_iter()
                .find(|m| m.name().map(|n| n.as_str()) == Some(name.as_str()))
            {
                return Some(m);
            }
        }
    }
    app.primary_monitor().ok().flatten()
}

fn island_work_area<R: Runtime>(app: &AppHandle<R>) -> (f64, f64, f64, f64, f64) {
    if let Some(monitor) = resolve_target_monitor(app) {
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

/// Recompute the top-center placement from the CURRENT preferred monitor and
/// the window's actual physical size, and apply it. Shared by re-show, the
/// renderer resize and the set-monitor command, so every path lands the strip
/// in the same spot.
fn reposition_island<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    let (area_x, area_y, area_w, area_h, scale) = island_work_area(app);
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let (x, y) = resolve_island_position(
        (area_x, area_y, area_w, area_h),
        (size.width as f64, size.height as f64),
        scale,
    );
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

/// Open (or re-show) the island. Shared by the Tauri command and the tray
/// action — idempotent like `open_pet_window_inner`.
pub(crate) fn open_island_window_inner<R: Runtime>(
    app: &AppHandle<R>,
    opts: IslandWindowOpts,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(ISLAND_LABEL) {
        // Recompute the top-center placement before re-showing: the monitor
        // layout / work area / preferred monitor may have changed since the
        // window was created, and `show()` alone would bring the strip back
        // at its stale position.
        let _ = reposition_island(app, &window);
        window.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let (area_x, area_y, area_w, area_h, scale) = island_work_area(app);
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
    //
    // MUST run on the main thread: `to_panel` reclasses the NSWindow with raw
    // AppKit calls (`-[NSPanel setFloatingPanel:]`), and AppKit traps
    // (EXC_BREAKPOINT) when they run off-main. This command is `async`, so it
    // executes on a tokio worker — calling the reclass inline here crashed the
    // whole app the moment the island was opened from the renderer (the tray
    // path never crashed because tray handlers already run on main).
    // Fire-and-forget is safe: the window is created hidden and only revealed
    // by the renderer after first paint, well after this closure has run.
    {
        let win = window.clone();
        app.run_on_main_thread(move || {
            if let Err(e) = crate::pet_window::apply_overlay_panel_behavior(
                &win,
                crate::pet_window::OverlayPanelRole::Popup,
            ) {
                log::warn!("island: applying overlay panel behavior failed: {e}");
            }
        })
        .map_err(|e| e.to_string())?;
    }

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
/// `width`/`height` are logical px (renderer-measured content size), clamped
/// to the monitor's work area so the strip never spills off-screen.
#[tauri::command]
pub async fn island_resize(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let Some(window) = app.get_webview_window(ISLAND_LABEL) else {
        return Ok(());
    };
    let (area_x, area_y, area_w, area_h, scale) = island_work_area(&app);
    let (width, height) = clamp_island_size(width, height, (area_w / scale, area_h / scale));
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;

    let (x, y) = resolve_island_position(
        (area_x, area_y, area_w, area_h),
        (width * scale, height * scale),
        scale,
    );
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

/// One entry per connected monitor, for the settings display picker.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandMonitorInfo {
    /// OS monitor name (`Monitor::name`) — the persisted identifier. `None`
    /// when the OS reports no name; such monitors can't be persisted and the
    /// frontend shows them by index only.
    pub name: Option<String>,
    /// Stable-ish ordinal for display ("Display 2") when `name` is `None`.
    pub index: usize,
    pub is_primary: bool,
    /// Whether the persisted preference points at this monitor.
    pub selected: bool,
    /// Logical size, for the picker's "2560×1440" hint.
    pub width: u32,
    pub height: u32,
}

/// List connected monitors for the island display picker.
#[tauri::command]
pub async fn island_list_monitors(app: AppHandle) -> Result<Vec<IslandMonitorInfo>, String> {
    let preferred = load_island_config().monitor;
    let primary_pos = app
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .map(|m| *m.position());
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    Ok(monitors
        .into_iter()
        .enumerate()
        .map(|(index, m)| {
            let name = m.name().cloned();
            let scale = m.scale_factor();
            IslandMonitorInfo {
                selected: name.is_some() && name == preferred,
                is_primary: primary_pos.as_ref() == Some(m.position()),
                index,
                width: (m.size().width as f64 / scale).round() as u32,
                height: (m.size().height as f64 / scale).round() as u32,
                name,
            }
        })
        .collect())
}

/// Persist the preferred monitor (`None` → follow the primary) and move a
/// live island there immediately.
#[tauri::command]
pub async fn island_set_monitor(app: AppHandle, monitor: Option<String>) -> Result<(), String> {
    let mut cfg = load_island_config();
    cfg.monitor = monitor;
    save_island_config(&cfg)?;
    if let Some(window) = app.get_webview_window(ISLAND_LABEL) {
        reposition_island(&app, &window)?;
    }
    Ok(())
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
    fn clamp_keeps_content_inside_the_work_area() {
        // Fits → untouched.
        assert_eq!(clamp_island_size(560.0, 300.0, (1512.0, 950.0)), (560.0, 300.0));
        // Overflows → clamped to the logical work area.
        assert_eq!(clamp_island_size(2000.0, 1200.0, (1512.0, 950.0)), (1512.0, 950.0));
        // Degenerate input can't produce a zero/negative window.
        assert_eq!(clamp_island_size(0.0, -5.0, (1512.0, 950.0)), (1.0, 1.0));
    }

    #[test]
    fn island_config_serde_roundtrip_and_defaults() {
        // Missing / unknown fields tolerate old and future config files.
        let empty: IslandConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, IslandConfig::default());
        assert!(empty.monitor.is_none());

        let cfg = IslandConfig {
            monitor: Some("DELL U2723QE".into()),
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: IslandConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cfg);
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
