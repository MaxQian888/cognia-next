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
//! ## Placement anchor (macOS)
//!
//! The strip anchors to the **full monitor frame**, NOT the work area. On
//! macOS `Monitor::work_area` is `NSScreen.visibleFrame`, which shrinks and
//! grows with menu-bar visibility: a position computed on a normal Space put
//! the island ~25–38 px below the top, so on a fullscreen-app Space (menu bar
//! hidden) it floated with a visible gap and the tucked sliver hung mid-air —
//! and a position computed during fullscreen hid the strip behind the menu
//! bar once back on the desktop. The full frame is Space-independent, so the
//! island hugs the true top edge everywhere; the panel level sits above the
//! menu bar (`pet_window::island_panel_level`) so it draws over it instead of
//! behind it, and the notch / camera housing is handled separately: the
//! window spans the notch strip (so slamming the cursor to the top still
//! lands hover on it) while the renderer pads its card below
//! `NSScreen.safeAreaInsets.top`, pushed to it via the `island_resize` return
//! value and the `fleet://island-geometry` event. On Windows/Linux the work
//! area is the correct taskbar-aware anchor and the inset is always 0.
//!
//! Live window ops can't run under `tauri::test::mock_app()` on this
//! project's toolchains (same constraint documented in `pet_window/mod.rs`),
//! so only the pure placement math is unit-tested; the runtime behavior is
//! covered by `tauri-smoke`.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Runtime};

pub const ISLAND_LABEL: &str = "island";

/// Renderer-facing geometry push. Emitted to the island window whenever a
/// placement path runs against a possibly different monitor (re-show,
/// set-monitor), so the shell can re-pad below the notch without polling.
pub const ISLAND_GEOMETRY_EVENT: &str = "fleet://island-geometry";

/// Cursor-over-island transitions pushed by the native hover monitor. The
/// renderer needs them because the tucked island ignores cursor events at the
/// OS level (see [`island_set_tucked`]) — DOM mouseenter/mouseleave never fire
/// on a click-through window, so Rust polls the global cursor instead and the
/// shell folds these into its `hovering` state (Dock-style slam-to-top reveal).
pub const ISLAND_HOVER_EVENT: &str = "fleet://island-hover";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandHover {
    pub hovering: bool,
}

/// Hover-monitor poll cadence while the island window is visible. Coarse
/// enough to be free, fine enough that a slam-to-top reveal feels immediate.
const HOVER_POLL_MS: u64 = 120;
/// Idle cadence while the island window is hidden.
const HOVER_POLL_HIDDEN_MS: u64 = 500;

/// Single-flight guard for the hover monitor task (mirrors the runtime's
/// `reaper_running` pattern).
static HOVER_MONITOR_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandGeometry {
    /// Top safe-area inset (logical px) of the island's current display —
    /// the notch height on built-in notched displays, 0 everywhere else.
    pub top_inset: f64,
}

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

/// The rectangle the island anchors to plus that display's top safe-area
/// inset. All fields are physical pixels except `scale`.
#[derive(Debug, Clone, Copy, PartialEq)]
struct IslandAnchor {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    scale: f64,
    /// Notch / camera-housing height (physical px); 0 off macOS and on
    /// non-notched displays.
    top_inset: f64,
}

impl IslandAnchor {
    fn fallback() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            w: 1920.0,
            h: 1080.0,
            scale: 1.0,
            top_inset: 0.0,
        }
    }

    fn top_inset_logical(&self) -> f64 {
        self.top_inset / self.scale
    }

    /// Max content size (logical px) the renderer card may occupy: the full
    /// frame minus the notch strip the card is padded below.
    fn content_max_logical(&self) -> (f64, f64) {
        (
            self.w / self.scale,
            self.h / self.scale - self.top_inset_logical(),
        )
    }
}

/// Top-center placement against the anchor rect. `anchor` is `(x, y, w)` and
/// `win_w` the window width, all physical pixels. The window's y always hugs
/// the anchor top — on macOS the notch offset lives INSIDE the window (the
/// renderer pads the card below it) so the transparent strip above the card
/// still catches slam-to-top hover. Pure for unit tests.
fn resolve_island_position(anchor: (f64, f64, f64), win_w: f64) -> (f64, f64) {
    let (anchor_x, anchor_y, anchor_w) = anchor;
    let x = (anchor_x + (anchor_w - win_w) / 2.0).max(anchor_x);
    (x, anchor_y)
}

/// Clamp the renderer-requested logical content size to the monitor's usable
/// logical area so an expanded island can never spill past the screen (which
/// would otherwise clip rows and paint scrollbars). Pure for unit tests.
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

/// `NSScreen.safeAreaInsets.top` (physical px) for the screen backing
/// `monitor`, matched by comparing the Cocoa frame (flipped to top-left
/// global coordinates via the primary screen height — the same conversion
/// `tao` uses) against the monitor's logical rect. NSScreen is
/// main-thread-only; when called from an async command (tokio worker) the
/// query is bridged through `run_on_main_thread` with a fail-open timeout —
/// never a deadlock risk because off-main implies the main loop is free.
#[cfg(target_os = "macos")]
fn monitor_top_safe_inset<R: Runtime>(app: &AppHandle<R>, monitor: &tauri::Monitor) -> f64 {
    use objc2::MainThreadMarker;

    let scale = monitor.scale_factor();
    if scale <= 0.0 {
        return 0.0;
    }
    let logical_x = monitor.position().x as f64 / scale;
    let logical_y = monitor.position().y as f64 / scale;
    let logical_w = monitor.size().width as f64 / scale;
    let logical_h = monitor.size().height as f64 / scale;

    let compute = move || -> f64 {
        let Some(mtm) = MainThreadMarker::new() else {
            return 0.0;
        };
        let screens = objc2_app_kit::NSScreen::screens(mtm);
        let Some(primary) = screens.iter().next() else {
            return 0.0;
        };
        let primary_frame = primary.frame();
        let primary_top = primary_frame.origin.y + primary_frame.size.height;
        for screen in &screens {
            let frame = screen.frame();
            let top_left_y = primary_top - (frame.origin.y + frame.size.height);
            if (frame.origin.x - logical_x).abs() < 1.0
                && (top_left_y - logical_y).abs() < 1.0
                && (frame.size.width - logical_w).abs() < 1.0
                && (frame.size.height - logical_h).abs() < 1.0
            {
                return screen.safeAreaInsets().top.max(0.0) * scale;
            }
        }
        0.0
    };

    if MainThreadMarker::new().is_some() {
        return compute();
    }
    let (tx, rx) = std::sync::mpsc::channel();
    if app
        .run_on_main_thread(move || {
            let _ = tx.send(compute());
        })
        .is_err()
    {
        return 0.0;
    }
    rx.recv_timeout(std::time::Duration::from_millis(500))
        .unwrap_or(0.0)
}

fn island_anchor<R: Runtime>(app: &AppHandle<R>) -> IslandAnchor {
    let Some(monitor) = resolve_target_monitor(app) else {
        return IslandAnchor::fallback();
    };
    #[cfg(target_os = "macos")]
    {
        IslandAnchor {
            x: monitor.position().x as f64,
            y: monitor.position().y as f64,
            w: monitor.size().width as f64,
            h: monitor.size().height as f64,
            scale: monitor.scale_factor(),
            top_inset: monitor_top_safe_inset(app, &monitor),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let rect = monitor.work_area();
        IslandAnchor {
            x: rect.position.x as f64,
            y: rect.position.y as f64,
            w: rect.size.width as f64,
            h: rect.size.height as f64,
            scale: monitor.scale_factor(),
            top_inset: 0.0,
        }
    }
}

/// Whether a global cursor point sits inside a window rect. All physical px.
/// Pure for unit tests.
fn point_in_rect(point: (f64, f64), origin: (f64, f64), size: (f64, f64)) -> bool {
    point.0 >= origin.0
        && point.0 < origin.0 + size.0
        && point.1 >= origin.1
        && point.1 < origin.1 + size.1
}

/// Is the global cursor currently over the island window? `false` on any
/// query failure (treat unknown as "not hovering" so a broken query can only
/// tuck the island, never pin it).
fn cursor_inside_island<R: Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
    let (Ok(cursor), Ok(pos), Ok(size)) = (
        window.cursor_position(),
        window.outer_position(),
        window.outer_size(),
    ) else {
        return false;
    };
    point_in_rect(
        (cursor.x, cursor.y),
        (pos.x as f64, pos.y as f64),
        (size.width as f64, size.height as f64),
    )
}

/// Poll the global cursor against the island window frame and push
/// enter/leave transitions to the renderer (`fleet://island-hover`).
///
/// This is the island's authoritative hover source: while tucked the window
/// ignores cursor events entirely (so it can't shadow clicks on the menu bar /
/// whatever sits under the top-center strip), which also means the DOM never
/// sees mouseenter — without this monitor a tucked island could never slide
/// back out. It also self-heals a stuck DOM `hovering` (a missed mouseleave
/// after an OS-level window resize) because a cursor that is genuinely outside
/// the frame always produces a trailing `hovering: false`.
fn spawn_hover_monitor<R: Runtime>(app: &AppHandle<R>) {
    if HOVER_MONITOR_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut was_inside = false;
        loop {
            let Some(window) = app.get_webview_window(ISLAND_LABEL) else {
                // Window destroyed (app teardown) — let a future open respawn.
                HOVER_MONITOR_RUNNING.store(false, Ordering::SeqCst);
                return;
            };
            if !window.is_visible().unwrap_or(false) {
                was_inside = false;
                tokio::time::sleep(std::time::Duration::from_millis(HOVER_POLL_HIDDEN_MS)).await;
                continue;
            }
            let inside = cursor_inside_island(&window);
            if inside != was_inside {
                was_inside = inside;
                let _ = app.emit_to(
                    ISLAND_LABEL,
                    ISLAND_HOVER_EVENT,
                    IslandHover { hovering: inside },
                );
            }
            tokio::time::sleep(std::time::Duration::from_millis(HOVER_POLL_MS)).await;
        }
    });
}

/// Renderer-driven click-through toggle: a tucked island is a 6-px sliver,
/// but its window still spans the whole pill strip under the notch — without
/// this it silently swallowed every click aimed at the menu bar / fullscreen
/// toolbar behind that strip. Tucked → the window ignores cursor events (the
/// hover monitor above keeps the slam-to-top reveal working); untucked → it
/// is interactive again.
///
/// The AppKit call (`setIgnoresMouseEvents:`) is bridged to the main thread —
/// same trap as the panel reclass in `open_island_window_inner` (this command
/// is async, so it executes on a tokio worker).
#[tauri::command]
pub async fn island_set_tucked(app: AppHandle, tucked: bool) -> Result<(), String> {
    let Some(window) = app.get_webview_window(ISLAND_LABEL) else {
        return Ok(());
    };
    app.run_on_main_thread(move || {
        if let Err(e) = window.set_ignore_cursor_events(tucked) {
            log::warn!("island: set_ignore_cursor_events({tucked}) failed: {e}");
        }
    })
    .map_err(|e| e.to_string())
}

/// Push the current display geometry to a live island renderer so it can
/// re-pad below the notch after a monitor change. Best-effort.
fn emit_island_geometry<R: Runtime>(app: &AppHandle<R>, anchor: &IslandAnchor) {
    let _ = app.emit_to(
        ISLAND_LABEL,
        ISLAND_GEOMETRY_EVENT,
        IslandGeometry {
            top_inset: anchor.top_inset_logical(),
        },
    );
}

/// Recompute the top-center placement from the CURRENT preferred monitor and
/// the window's actual physical size, and apply it. Shared by re-show and the
/// set-monitor command, so every path lands the strip in the same spot; both
/// also notify the renderer (the notch inset may have changed with the
/// monitor, and the renderer answers with a fresh `island_resize`).
fn reposition_island<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    let anchor = island_anchor(app);
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let (x, y) = resolve_island_position((anchor.x, anchor.y, anchor.w), size.width as f64);
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    emit_island_geometry(app, &anchor);
    Ok(())
}

/// Open (or re-show) the island. Shared by the Tauri command and the tray
/// action — idempotent like `open_pet_window_inner`.
pub(crate) fn open_island_window_inner<R: Runtime>(
    app: &AppHandle<R>,
    opts: IslandWindowOpts,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(ISLAND_LABEL) {
        // Recompute the top-center placement before re-showing: the monitor
        // layout / preferred monitor may have changed since the window was
        // created, and `show()` alone would bring the strip back at its stale
        // position.
        let _ = reposition_island(app, &window);
        window.show().map_err(|e| e.to_string())?;
        spawn_hover_monitor(app);
        return Ok(());
    }

    let anchor = island_anchor(app);
    let (x, y) = resolve_island_position((anchor.x, anchor.y, anchor.w), opts.width * anchor.scale);

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
    // The window includes the notch strip; the renderer pads its card below
    // the inset (it learns the value from `island_resize`'s return).
    .inner_size(opts.width, opts.height + anchor.top_inset_logical())
    .build()
    .map_err(|e| e.to_string())?;

    // Strip the app menu bar on Windows/Linux (same fix as the pet overlay).
    let _ = window.remove_menu();

    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;

    // Non-activating NSPanel: float over all Spaces + full-screen apps, never
    // steal focus. `Island` role — key-capable like the popup (the inline
    // reply input must accept typing; `becomes_key_only_if_needed` keeps
    // plain clicks non-key) but at a window level ABOVE the menu bar, since
    // the strip hugs the true top edge of the screen.
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
                crate::pet_window::OverlayPanelRole::Island,
            ) {
                log::warn!("island: applying overlay panel behavior failed: {e}");
            }
        })
        .map_err(|e| e.to_string())?;
    }

    spawn_hover_monitor(app);

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
                    // Reveal WITHOUT stealing focus: the island is a passive
                    // status overlay and must never pull the user's foreground
                    // app (especially one on another display). Plain `show()`
                    // on the non-activating NSPanel reveals it in place;
                    // `bring_window_to_front` would also `set_focus()`, which
                    // activates the window and yanks focus away.
                    let _ = window.show();
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
pub async fn open_island_window(
    app: AppHandle,
    opts: Option<IslandWindowOpts>,
) -> Result<(), String> {
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
/// `width`/`height` are the renderer-measured logical CONTENT size, clamped
/// so the strip never spills off-screen; the window grows by the display's
/// top safe-area inset, which is returned so the renderer pads its card
/// below the notch.
#[tauri::command]
pub async fn island_resize(app: AppHandle, width: f64, height: f64) -> Result<f64, String> {
    let anchor = island_anchor(&app);
    let inset_logical = anchor.top_inset_logical();
    let Some(window) = app.get_webview_window(ISLAND_LABEL) else {
        return Ok(inset_logical);
    };
    let (width, height) = clamp_island_size(width, height, anchor.content_max_logical());
    window
        .set_size(tauri::LogicalSize::new(width, height + inset_logical))
        .map_err(|e| e.to_string())?;

    let (x, y) = resolve_island_position((anchor.x, anchor.y, anchor.w), width * anchor.scale);
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(inset_logical)
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
    fn centers_horizontally_and_hugs_the_anchor_top() {
        // 1x display 1920 wide, 420px strip → x = (1920-420)/2, y = frame top.
        let (x, y) = resolve_island_position((0.0, 0.0, 1920.0), 420.0);
        assert_eq!(x, 750.0);
        assert_eq!(y, 0.0);
    }

    #[test]
    fn respects_anchor_origin_and_retina_scale() {
        // Secondary-monitor offset + 2x Retina (physical window width).
        let (x, y) = resolve_island_position((100.0, 50.0, 3456.0), 420.0 * 2.0);
        assert_eq!(x, 100.0 + (3456.0 - 840.0) / 2.0);
        assert_eq!(y, 50.0);
    }

    #[test]
    fn oversized_strip_pins_to_anchor_left() {
        let (x, _) = resolve_island_position((0.0, 0.0, 400.0), 800.0);
        assert_eq!(x, 0.0);
    }

    #[test]
    fn clamp_keeps_content_inside_the_area() {
        // Fits → untouched.
        assert_eq!(
            clamp_island_size(560.0, 300.0, (1512.0, 950.0)),
            (560.0, 300.0)
        );
        // Overflows → clamped to the logical area.
        assert_eq!(
            clamp_island_size(2000.0, 1200.0, (1512.0, 950.0)),
            (1512.0, 950.0)
        );
        // Degenerate input can't produce a zero/negative window.
        assert_eq!(clamp_island_size(0.0, -5.0, (1512.0, 950.0)), (1.0, 1.0));
    }

    #[test]
    fn anchor_inset_conversions_are_logical() {
        // 2x Retina notch of 74 physical px → 37 logical; content max loses
        // exactly the inset strip.
        let anchor = IslandAnchor {
            x: 0.0,
            y: 0.0,
            w: 3024.0,
            h: 1964.0,
            scale: 2.0,
            top_inset: 74.0,
        };
        assert_eq!(anchor.top_inset_logical(), 37.0);
        assert_eq!(anchor.content_max_logical(), (1512.0, 982.0 - 37.0));
    }

    #[test]
    fn point_in_rect_covers_edges_and_outside() {
        let origin = (100.0, 0.0);
        let size = (420.0, 50.0);
        // Inclusive top-left, exclusive bottom-right (half-open, like frames).
        assert!(point_in_rect((100.0, 0.0), origin, size));
        assert!(point_in_rect((519.9, 49.9), origin, size));
        assert!(!point_in_rect((520.0, 25.0), origin, size));
        assert!(!point_in_rect((99.9, 25.0), origin, size));
        assert!(!point_in_rect((300.0, 50.0), origin, size));
        assert!(!point_in_rect((300.0, -0.1), origin, size));
    }

    #[test]
    fn hover_event_payload_is_camel_case() {
        let json = serde_json::to_string(&IslandHover { hovering: true }).unwrap();
        assert_eq!(json, r#"{"hovering":true}"#);
    }

    #[test]
    fn geometry_event_payload_is_camel_case() {
        let json = serde_json::to_string(&IslandGeometry { top_inset: 37.0 }).unwrap();
        assert_eq!(json, r#"{"topInset":37.0}"#);
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
